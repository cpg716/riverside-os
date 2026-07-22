//! Metrics exporters for different formats and destinations

use crate::metrics::{ExportFormat, MetricRegistry, MetricType, MetricValue};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[async_trait]
pub trait MetricsExporter: Send + Sync {
    async fn export(
        &self,
        registry: &MetricRegistry,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;
    fn format(&self) -> ExportFormat;
}

#[derive(Debug, Clone)]
pub struct PrometheusExporter {
    namespace: String,
    subsystem: Option<String>,
}

impl PrometheusExporter {
    pub fn new(namespace: &str) -> Self {
        Self {
            namespace: namespace.to_string(),
            subsystem: None,
        }
    }

    pub fn with_subsystem(mut self, subsystem: &str) -> Self {
        self.subsystem = Some(subsystem.to_string());
        self
    }

    fn format_metric_name(&self, name: &str) -> String {
        let namespace = Self::sanitize_identifier(&self.namespace, true);
        let name = Self::sanitize_identifier(name, true);
        match &self.subsystem {
            Some(subsystem) => format!(
                "{}_{}_{}",
                namespace,
                Self::sanitize_identifier(subsystem, true),
                name
            ),
            None => format!("{namespace}_{name}"),
        }
    }

    fn sanitize_identifier(value: &str, allow_colon: bool) -> String {
        let mut sanitized = String::with_capacity(value.len().max(1));
        for (index, character) in value.chars().enumerate() {
            let valid = character == '_'
                || character.is_ascii_alphabetic()
                || (allow_colon && character == ':')
                || (index > 0 && character.is_ascii_digit());
            sanitized.push(if valid { character } else { '_' });
        }
        if sanitized.is_empty() {
            sanitized.push('_');
        }
        sanitized
    }

    fn canonical_tags(tags: &HashMap<String, String>) -> Vec<(String, String)> {
        let mut tags = tags
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        tags.sort_unstable();
        tags
    }

    fn escape_label_value(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('\n', "\\n")
            .replace('\r', "\\n")
            .replace('"', "\\\"")
    }

    fn format_tags(&self, tags: &[(String, String)], extra: Option<(&str, String)>) -> String {
        if tags.is_empty() {
            if let Some((key, value)) = extra {
                return format!(
                    "{{{}=\"{}\"}}",
                    Self::sanitize_identifier(key, false),
                    Self::escape_label_value(&value)
                );
            }
            return String::new();
        }

        let mut formatted_tags: Vec<String> = tags
            .iter()
            .filter(|(key, _)| extra.as_ref().is_none_or(|(extra_key, _)| key != extra_key))
            .map(|(key, value)| {
                format!(
                    "{}=\"{}\"",
                    Self::sanitize_identifier(key, false),
                    Self::escape_label_value(value)
                )
            })
            .collect();
        if let Some((key, value)) = extra {
            formatted_tags.push(format!(
                "{}=\"{}\"",
                Self::sanitize_identifier(key, false),
                Self::escape_label_value(&value)
            ));
        }

        format!("{{{}}}", formatted_tags.join(","))
    }

    fn histogram_buckets(metric_name: &str, metric_type: MetricType) -> &'static [f64] {
        const SECONDS: &[f64] = &[
            0.005,
            0.01,
            0.025,
            0.05,
            0.1,
            0.25,
            0.5,
            1.0,
            2.5,
            5.0,
            10.0,
            f64::INFINITY,
        ];
        const MILLISECONDS: &[f64] = &[
            5.0,
            10.0,
            25.0,
            50.0,
            100.0,
            250.0,
            500.0,
            1_000.0,
            2_500.0,
            5_000.0,
            10_000.0,
            f64::INFINITY,
        ];

        if metric_type == MetricType::Histogram && metric_name.ends_with("_ms") {
            MILLISECONDS
        } else {
            SECONDS
        }
    }

    fn latest_value<'a>(values: &[&'a MetricValue]) -> Option<&'a MetricValue> {
        values.iter().copied().max_by_key(|value| value.timestamp)
    }
}

#[async_trait]
impl MetricsExporter for PrometheusExporter {
    async fn export(
        &self,
        registry: &MetricRegistry,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut output = String::new();
        let metrics = registry.get_all_metrics();
        let mut metric_names = metrics.keys().collect::<Vec<_>>();
        metric_names.sort_unstable();

        for metric_name in metric_names {
            let values = &metrics[metric_name];
            if values.is_empty() {
                continue;
            }

            let metric_type = values[0].metric_type;
            let full_name = self.format_metric_name(metric_name);
            let type_name = match metric_type {
                MetricType::Counter => "counter",
                MetricType::Gauge => "gauge",
                MetricType::Histogram | MetricType::Timer => "histogram",
            };
            output.push_str(&format!("# TYPE {full_name} {type_name}\n"));

            let mut series = BTreeMap::<Vec<(String, String)>, Vec<&MetricValue>>::new();
            for value in values
                .iter()
                .filter(|value| value.metric_type == metric_type && value.value.is_finite())
            {
                series
                    .entry(Self::canonical_tags(&value.tags))
                    .or_default()
                    .push(value);
            }

            for (tags, series_values) in series {
                match metric_type {
                    MetricType::Counter | MetricType::Gauge => {
                        if let Some(latest) = Self::latest_value(&series_values) {
                            output.push_str(&format!(
                                "{}{} {}\n",
                                full_name,
                                self.format_tags(&tags, None),
                                latest.value
                            ));
                        }
                    }
                    MetricType::Histogram | MetricType::Timer => {
                        let samples = series_values
                            .iter()
                            .map(|value| value.value)
                            .collect::<Vec<_>>();
                        for bucket in Self::histogram_buckets(metric_name, metric_type) {
                            let count = samples.iter().filter(|value| **value <= *bucket).count();
                            let upper_bound = if bucket.is_infinite() {
                                "+Inf".to_string()
                            } else {
                                bucket.to_string()
                            };
                            output.push_str(&format!(
                                "{}_bucket{} {}\n",
                                full_name,
                                self.format_tags(&tags, Some(("le", upper_bound))),
                                count
                            ));
                        }
                        output.push_str(&format!(
                            "{}_sum{} {}\n",
                            full_name,
                            self.format_tags(&tags, None),
                            samples.iter().sum::<f64>()
                        ));
                        output.push_str(&format!(
                            "{}_count{} {}\n",
                            full_name,
                            self.format_tags(&tags, None),
                            samples.len()
                        ));
                    }
                }
            }
            output.push('\n');
        }

        Ok(output)
    }

    fn format(&self) -> ExportFormat {
        ExportFormat::Prometheus
    }
}

#[derive(Debug, Clone)]
pub struct JsonExporter {
    pretty_print: bool,
}

impl Default for JsonExporter {
    fn default() -> Self {
        Self::new()
    }
}

impl JsonExporter {
    pub fn new() -> Self {
        Self {
            pretty_print: false,
        }
    }

    pub fn pretty_print(mut self) -> Self {
        self.pretty_print = true;
        self
    }
}

#[async_trait]
impl MetricsExporter for JsonExporter {
    async fn export(
        &self,
        registry: &MetricRegistry,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let metrics = registry.get_all_metrics();
        let mut output = HashMap::new();

        for (metric_name, values) in metrics {
            let metric_data: Vec<serde_json::Value> = values
                .iter()
                .map(|v| {
                    serde_json::json!({
                        "value": v.value,
                        "timestamp": v.timestamp,
                        "tags": v.tags,
                        "type": match v.metric_type {
                            crate::metrics::MetricType::Counter => "counter",
                            crate::metrics::MetricType::Gauge => "gauge",
                            crate::metrics::MetricType::Histogram => "histogram",
                            crate::metrics::MetricType::Timer => "timer",
                        }
                    })
                })
                .collect();

            output.insert(metric_name.clone(), metric_data);
        }

        if self.pretty_print {
            Ok(serde_json::to_string_pretty(&output)?)
        } else {
            Ok(serde_json::to_string(&output)?)
        }
    }

    fn format(&self) -> ExportFormat {
        ExportFormat::Json
    }
}

#[derive(Debug, Clone)]
pub struct InfluxDBExporter {
    _url: String,
    _database: String,
    username: Option<String>,
    password: Option<String>,
}

impl InfluxDBExporter {
    pub fn new(url: &str, database: &str) -> Self {
        Self {
            _url: url.to_string(),
            _database: database.to_string(),
            username: None,
            password: None,
        }
    }

    pub fn with_auth(mut self, username: &str, password: &str) -> Self {
        self.username = Some(username.to_string());
        self.password = Some(password.to_string());
        self
    }

    fn format_line_protocol(
        &self,
        measurement: &str,
        tags: &HashMap<String, String>,
        value: f64,
        timestamp: i64,
    ) -> String {
        let tag_string = if tags.is_empty() {
            String::new()
        } else {
            let formatted_tags: Vec<String> = tags
                .iter()
                .map(|(key, val)| {
                    format!(
                        "{}={}",
                        key.replace([' ', ','], "\\ "),
                        val.replace([' ', ','], "\\ ")
                    )
                })
                .collect();
            format!(",{}", formatted_tags.join(","))
        };

        format!(
            "{}{} value={} {}",
            measurement.replace([' ', ','], "\\ "),
            tag_string,
            value,
            timestamp * 1_000_000_000 // Convert to nanoseconds
        )
    }
}

#[async_trait]
impl MetricsExporter for InfluxDBExporter {
    async fn export(
        &self,
        registry: &MetricRegistry,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut lines = Vec::new();
        let metrics = registry.get_all_metrics();

        for (metric_name, values) in metrics {
            for value in values {
                let line = self.format_line_protocol(
                    &metric_name.replace(['.', '-'], "_"),
                    &value.tags,
                    value.value,
                    value.timestamp.timestamp(),
                );
                lines.push(line);
            }
        }

        Ok(lines.join("\n"))
    }

    fn format(&self) -> ExportFormat {
        ExportFormat::InfluxDB
    }
}

#[derive(Debug, Clone)]
pub struct GraphiteExporter {
    prefix: String,
}

impl GraphiteExporter {
    pub fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.to_string(),
        }
    }

    fn format_metric_path(&self, name: &str, tags: &HashMap<String, String>) -> String {
        let sanitized_name = name.replace(['.', '-', ' '], "_");

        if tags.is_empty() {
            format!("{}.{}", self.prefix, sanitized_name)
        } else {
            let tag_string = tags
                .iter()
                .map(|(key, value)| format!("{key}.{value}"))
                .collect::<Vec<_>>()
                .join(".");
            format!("{}.{}.{}", self.prefix, tag_string, sanitized_name)
        }
    }
}

#[async_trait]
impl MetricsExporter for GraphiteExporter {
    async fn export(
        &self,
        registry: &MetricRegistry,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut lines = Vec::new();
        let metrics = registry.get_all_metrics();

        for (metric_name, values) in metrics {
            for value in values {
                let path = self.format_metric_path(metric_name, &value.tags);
                let timestamp = value.timestamp.timestamp();
                lines.push(format!("{} {} {}", path, value.value, timestamp));
            }
        }

        Ok(lines.join("\n"))
    }

    fn format(&self) -> ExportFormat {
        ExportFormat::Graphite
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportConfig {
    pub enabled_formats: Vec<ExportFormat>,
    pub prometheus: Option<PrometheusConfig>,
    pub influxdb: Option<InfluxDBConfig>,
    pub graphite: Option<GraphiteConfig>,
    pub export_interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrometheusConfig {
    pub namespace: String,
    pub subsystem: Option<String>,
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfluxDBConfig {
    pub url: String,
    pub database: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphiteConfig {
    pub prefix: String,
    pub host: String,
    pub port: u16,
}

impl Default for ExportConfig {
    fn default() -> Self {
        Self {
            enabled_formats: vec![ExportFormat::Json],
            prometheus: None,
            influxdb: None,
            graphite: None,
            export_interval_seconds: 60,
        }
    }
}

pub fn create_exporter(
    format: &ExportFormat,
    config: &ExportConfig,
) -> Result<Box<dyn MetricsExporter>, Box<dyn std::error::Error + Send + Sync>> {
    match format {
        ExportFormat::Prometheus => {
            let prometheus_config = config
                .prometheus
                .as_ref()
                .ok_or("Prometheus config required")?;
            let mut exporter = PrometheusExporter::new(&prometheus_config.namespace);
            if let Some(subsystem) = &prometheus_config.subsystem {
                exporter = exporter.with_subsystem(subsystem);
            }
            Ok(Box::new(exporter))
        }
        ExportFormat::Json => Ok(Box::new(JsonExporter::new())),
        ExportFormat::InfluxDB => {
            let influxdb_config = config.influxdb.as_ref().ok_or("InfluxDB config required")?;
            let mut exporter =
                InfluxDBExporter::new(&influxdb_config.url, &influxdb_config.database);
            if let (Some(username), Some(password)) =
                (&influxdb_config.username, &influxdb_config.password)
            {
                exporter = exporter.with_auth(username, password);
            }
            Ok(Box::new(exporter))
        }
        ExportFormat::Graphite => {
            let graphite_config = config.graphite.as_ref().ok_or("Graphite config required")?;
            Ok(Box::new(GraphiteExporter::new(&graphite_config.prefix)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MetricsExporter, PrometheusExporter};
    use crate::metrics::{MetricRegistry, MetricsConfig};
    use std::collections::HashMap;

    #[tokio::test]
    async fn prometheus_histograms_ignore_non_finite_samples() {
        let mut registry = MetricRegistry::new(MetricsConfig::default());

        registry.record_histogram("checkout_latency", 0.25, HashMap::new());
        registry.record_histogram("checkout_latency", f64::NAN, HashMap::new());

        let output = PrometheusExporter::new("ros")
            .export(&registry)
            .await
            .expect("prometheus export should succeed");

        assert!(output.contains("ros_checkout_latency_count 1"));
        assert!(!output.contains("NaN"));
    }

    #[tokio::test]
    async fn prometheus_preserves_tagged_counter_series_and_cumulative_values() {
        let mut registry = MetricRegistry::new(MetricsConfig::default());
        let mut register_tags = HashMap::new();
        register_tags.insert("method".to_string(), "POST".to_string());
        register_tags.insert("path".to_string(), "/api/register".to_string());
        let mut search_tags = HashMap::new();
        search_tags.insert("method".to_string(), "GET".to_string());
        search_tags.insert("path".to_string(), "/api/search".to_string());

        registry.record_counter("api_requests_total", 1.0, register_tags.clone());
        registry.record_counter("api_requests_total", 1.0, search_tags);
        registry.record_counter("api_requests_total", 2.0, register_tags);

        let output = PrometheusExporter::new("ros")
            .export(&registry)
            .await
            .expect("prometheus export should succeed");

        assert_eq!(
            output
                .matches("# TYPE ros_api_requests_total counter")
                .count(),
            1
        );
        assert!(output.contains("ros_api_requests_total{method=\"POST\",path=\"/api/register\"} 3"));
        assert!(output.contains("ros_api_requests_total{method=\"GET\",path=\"/api/search\"} 1"));
    }

    #[tokio::test]
    async fn prometheus_histograms_have_per_series_le_buckets() {
        let mut registry = MetricRegistry::new(MetricsConfig::default());
        let mut register_tags = HashMap::new();
        register_tags.insert("path".to_string(), "/api/register".to_string());
        let mut search_tags = HashMap::new();
        search_tags.insert("path".to_string(), "/api/search".to_string());

        registry.record_histogram("api_request_duration_ms", 10.0, register_tags.clone());
        registry.record_histogram("api_request_duration_ms", 200.0, register_tags);
        registry.record_histogram("api_request_duration_ms", 5.0, search_tags);

        let output = PrometheusExporter::new("ros")
            .export(&registry)
            .await
            .expect("prometheus export should succeed");

        assert!(output
            .contains("ros_api_request_duration_ms_bucket{path=\"/api/register\",le=\"10\"} 1"));
        assert!(output
            .contains("ros_api_request_duration_ms_bucket{path=\"/api/register\",le=\"+Inf\"} 2"));
        assert!(output
            .contains("ros_api_request_duration_ms_bucket{path=\"/api/search\",le=\"+Inf\"} 1"));
        assert!(output.contains("ros_api_request_duration_ms_count{path=\"/api/register\"} 2"));
    }

    #[tokio::test]
    async fn prometheus_escapes_label_values_and_sanitizes_names() {
        let mut registry = MetricRegistry::new(MetricsConfig::default());
        let mut tags = HashMap::new();
        tags.insert(
            "route-name".to_string(),
            "line\n\"quoted\"\\tail".to_string(),
        );
        registry.record_gauge("1.bad metric", 2.0, tags);

        let output = PrometheusExporter::new("river-side")
            .export(&registry)
            .await
            .expect("prometheus export should succeed");

        assert!(output.contains("# TYPE river_side___bad_metric gauge"));
        assert!(output.contains("route_name=\"line\\n\\\"quoted\\\"\\\\tail\""));
    }
}
