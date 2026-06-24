//! Metrics exporters for different formats and destinations

use crate::metrics::{ExportFormat, MetricRegistry};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
        match &self.subsystem {
            Some(subsystem) => format!("{}_{}_{}", self.namespace, subsystem, name),
            None => format!("{}_{}", self.namespace, name),
        }
    }

    fn sanitize_metric_name(&self, name: &str) -> String {
        name.replace(['.', '-', ' '], "_")
    }

    fn format_tags(&self, tags: &HashMap<String, String>) -> String {
        if tags.is_empty() {
            return String::new();
        }

        let formatted_tags: Vec<String> = tags
            .iter()
            .map(|(key, value)| format!("{}=\"{}\"", self.sanitize_metric_name(key), value))
            .collect();

        format!("{{{}}}", formatted_tags.join(","))
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

        for (metric_name, values) in metrics {
            if values.is_empty() {
                continue;
            }

            let sanitized_name = self.sanitize_metric_name(metric_name);
            let full_name = self.format_metric_name(&sanitized_name);

            // Get the latest value for gauges and counters
            if let Some(latest_value) = values.last() {
                let metric_type = match latest_value.metric_type {
                    crate::metrics::MetricType::Counter => "counter",
                    crate::metrics::MetricType::Gauge => "gauge",
                    crate::metrics::MetricType::Histogram => "histogram",
                    crate::metrics::MetricType::Timer => "histogram",
                };

                output.push_str(&format!("# TYPE {full_name} {metric_type}\n"));

                // For histograms, we need to export buckets
                if matches!(
                    latest_value.metric_type,
                    crate::metrics::MetricType::Histogram | crate::metrics::MetricType::Timer
                ) {
                    let mut sorted_values: Vec<f64> = values
                        .iter()
                        .map(|v| v.value)
                        .filter(|v| v.is_finite())
                        .collect();
                    sorted_values.sort_by(|a, b| a.total_cmp(b));

                    if sorted_values.is_empty() {
                        continue;
                    }

                    // Define standard buckets
                    let buckets = vec![
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

                    for bucket in &buckets {
                        let count = sorted_values.iter().filter(|&&v| v <= *bucket).count() as f64;
                        let _bucket_str = if bucket.is_infinite() {
                            "+Inf".to_string()
                        } else {
                            bucket.to_string()
                        };
                        output.push_str(&format!(
                            "{}_bucket{} {}\n",
                            full_name,
                            self.format_tags(&latest_value.tags),
                            count
                        ));
                    }

                    // Export sum and count
                    let sum: f64 = sorted_values.iter().sum();
                    let count = sorted_values.len() as f64;

                    output.push_str(&format!(
                        "{}_sum{} {}\n",
                        full_name,
                        self.format_tags(&latest_value.tags),
                        sum
                    ));
                    output.push_str(&format!(
                        "{}_count{} {}\n",
                        full_name,
                        self.format_tags(&latest_value.tags),
                        count
                    ));
                } else {
                    // For counters and gauges, export the latest value
                    output.push_str(&format!(
                        "{}{} {}\n",
                        full_name,
                        self.format_tags(&latest_value.tags),
                        latest_value.value
                    ));
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
}
