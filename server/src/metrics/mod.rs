//! Comprehensive metrics collection system for business and technical KPIs

pub mod business_metrics;
pub mod collector;
pub mod exporters;
pub mod technical_metrics;

pub use business_metrics::{BusinessKpi, BusinessMetrics};
pub use collector::MetricsCollector;
pub use exporters::{JsonExporter, MetricsExporter, PrometheusExporter};
pub use technical_metrics::{TechnicalKpi, TechnicalMetrics};

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricValue {
    pub value: f64,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub tags: HashMap<String, String>,
    pub metric_type: MetricType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetricType {
    Counter,
    Gauge,
    Histogram,
    Timer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricSnapshot {
    pub name: String,
    pub values: Vec<MetricValue>,
    pub aggregated: Option<f64>,
    pub aggregation_type: Option<AggregationType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AggregationType {
    Sum,
    Average,
    Min,
    Max,
    Percentile(f64),
}

#[derive(Debug, Clone)]
pub struct MetricRegistry {
    metrics: HashMap<String, Vec<MetricValue>>,
    counter_totals: HashMap<MetricSeriesKey, f64>,
    config: MetricsConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MetricSeriesKey {
    name: String,
    tags: Vec<(String, String)>,
}

impl MetricSeriesKey {
    fn new(name: &str, tags: &HashMap<String, String>) -> Self {
        let mut tags = tags
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        tags.sort_unstable();
        Self {
            name: name.to_string(),
            tags,
        }
    }
}

impl MetricRegistry {
    pub fn new(config: MetricsConfig) -> Self {
        Self {
            metrics: HashMap::new(),
            counter_totals: HashMap::new(),
            config,
        }
    }

    pub fn record_counter(&mut self, name: &str, value: f64, tags: HashMap<String, String>) {
        if !value.is_finite() || value.is_sign_negative() {
            tracing::warn!(metric = name, "Discarded invalid counter increment");
            return;
        }
        if !self.accepts_metric_type(name, MetricType::Counter) {
            return;
        }

        let key = MetricSeriesKey::new(name, &tags);
        let total = self.counter_totals.entry(key).or_insert(0.0);
        let updated = *total + value;
        if !updated.is_finite() {
            tracing::warn!(metric = name, "Discarded counter increment that overflowed");
            return;
        }
        *total = updated;
        self.record_metric(name, updated, tags, MetricType::Counter);
    }

    pub fn record_gauge(&mut self, name: &str, value: f64, tags: HashMap<String, String>) {
        self.record_metric(name, value, tags, MetricType::Gauge);
    }

    pub fn record_histogram(&mut self, name: &str, value: f64, tags: HashMap<String, String>) {
        self.record_metric(name, value, tags, MetricType::Histogram);
    }

    pub fn record_timer(&mut self, name: &str, duration: Duration, tags: HashMap<String, String>) {
        self.record_metric(name, duration.as_secs_f64(), tags, MetricType::Timer);
    }

    fn record_metric(
        &mut self,
        name: &str,
        value: f64,
        tags: HashMap<String, String>,
        metric_type: MetricType,
    ) {
        if !value.is_finite() {
            tracing::warn!(metric = name, "Discarded non-finite metric sample");
            return;
        }
        if !self.accepts_metric_type(name, metric_type) {
            return;
        }

        let metric = MetricValue {
            value,
            timestamp: chrono::Utc::now(),
            tags,
            metric_type,
        };

        let values = self.metrics.entry(name.to_string()).or_default();
        values.push(metric);

        // Cleanup old values based on retention policy
        if values.len() > self.config.max_values_per_metric {
            values.drain(0..values.len() - self.config.max_values_per_metric);
        }
    }

    pub fn get_metric(&self, name: &str) -> Option<&Vec<MetricValue>> {
        self.metrics.get(name)
    }

    pub fn get_all_metrics(&self) -> &HashMap<String, Vec<MetricValue>> {
        &self.metrics
    }

    pub fn get_snapshot(
        &self,
        name: &str,
        aggregation: Option<AggregationType>,
    ) -> Option<MetricSnapshot> {
        let values = self.metrics.get(name)?;

        let aggregated = match aggregation {
            Some(AggregationType::Sum) if values.is_empty() => None,
            Some(AggregationType::Sum) => Some(values.iter().map(|v| v.value).sum()),
            Some(AggregationType::Average) => {
                if values.is_empty() {
                    None
                } else {
                    let sum: f64 = values.iter().map(|v| v.value).sum();
                    Some(sum / values.len() as f64)
                }
            }
            Some(AggregationType::Min) if values.is_empty() => None,
            Some(AggregationType::Min) => {
                Some(values.iter().map(|v| v.value).fold(f64::INFINITY, f64::min))
            }
            Some(AggregationType::Max) if values.is_empty() => None,
            Some(AggregationType::Max) => Some(
                values
                    .iter()
                    .map(|v| v.value)
                    .fold(f64::NEG_INFINITY, f64::max),
            ),
            Some(AggregationType::Percentile(p)) => {
                let mut sorted_values: Vec<f64> = values
                    .iter()
                    .map(|v| v.value)
                    .filter(|v| v.is_finite())
                    .collect();
                if sorted_values.is_empty() {
                    None
                } else {
                    sorted_values.sort_by(|a, b| a.total_cmp(b));
                    let percentile = p.clamp(0.0, 100.0);
                    let index = (((percentile / 100.0) * (sorted_values.len() - 1) as f64).round())
                        as usize;
                    sorted_values.get(index).copied()
                }
            }
            None => None,
        };

        Some(MetricSnapshot {
            name: name.to_string(),
            values: values.clone(),
            aggregated,
            aggregation_type: aggregation,
        })
    }

    pub fn cleanup_old_metrics(&mut self, older_than: Duration) {
        let cutoff = chrono::Utc::now() - chrono::Duration::from_std(older_than).unwrap();

        for values in self.metrics.values_mut() {
            values.retain(|v| v.timestamp > cutoff);
        }

        let active_counter_series = self
            .metrics
            .iter()
            .flat_map(|(name, values)| {
                values
                    .iter()
                    .filter(|value| value.metric_type == MetricType::Counter)
                    .map(|value| MetricSeriesKey::new(name, &value.tags))
            })
            .collect::<HashSet<_>>();
        self.counter_totals
            .retain(|series, _| active_counter_series.contains(series));
    }

    fn accepts_metric_type(&self, name: &str, metric_type: MetricType) -> bool {
        let Some(existing) = self.metrics.get(name).and_then(|values| values.last()) else {
            return true;
        };
        if existing.metric_type == metric_type {
            true
        } else {
            tracing::warn!(
                metric = name,
                existing_type = ?existing.metric_type,
                attempted_type = ?metric_type,
                "Discarded metric sample with conflicting type"
            );
            false
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsConfig {
    pub collection_interval: Duration,
    pub retention_period: Duration,
    pub max_values_per_metric: usize,
    pub enable_business_metrics: bool,
    pub enable_technical_metrics: bool,
    pub export_formats: Vec<ExportFormat>,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            collection_interval: Duration::from_secs(60), // 1 minute
            retention_period: Duration::from_secs(86400 * 7), // 7 days
            max_values_per_metric: 10000,
            enable_business_metrics: true,
            enable_technical_metrics: true,
            export_formats: vec![ExportFormat::Prometheus, ExportFormat::Json],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ExportFormat {
    Prometheus,
    Json,
    InfluxDB,
    Graphite,
}

#[cfg(test)]
mod tests {
    use super::{AggregationType, MetricRegistry, MetricsConfig};
    use std::collections::HashMap;

    #[test]
    fn percentile_ignores_non_finite_values_and_clamps_bounds() {
        let mut registry = MetricRegistry::new(MetricsConfig::default());

        registry.record_histogram("checkout_latency", 0.25, HashMap::new());
        registry.record_histogram("checkout_latency", f64::NAN, HashMap::new());
        registry.record_histogram("checkout_latency", 1.5, HashMap::new());

        let snapshot = registry
            .get_snapshot("checkout_latency", Some(AggregationType::Percentile(100.0)))
            .expect("snapshot should exist");

        assert_eq!(snapshot.aggregated, Some(1.5));
        assert_eq!(snapshot.values.len(), 2);
    }

    #[test]
    fn counters_are_cumulative_per_tag_series() {
        let mut config = MetricsConfig::default();
        config.max_values_per_metric = 1;
        let mut registry = MetricRegistry::new(config);
        let mut tags = HashMap::new();
        tags.insert("route".to_string(), "/api/register".to_string());

        registry.record_counter("requests_total", 1.0, tags.clone());
        registry.record_counter("requests_total", 2.0, tags);

        let values = registry
            .get_metric("requests_total")
            .expect("counter should be retained");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].value, 3.0);
    }

    #[test]
    fn counters_reject_negative_increments_and_type_changes() {
        let mut registry = MetricRegistry::new(MetricsConfig::default());

        registry.record_counter("requests_total", -1.0, HashMap::new());
        assert!(registry.get_metric("requests_total").is_none());

        registry.record_gauge("queue_depth", 2.0, HashMap::new());
        registry.record_counter("queue_depth", 1.0, HashMap::new());
        let values = registry
            .get_metric("queue_depth")
            .expect("gauge should be retained");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].value, 2.0);
    }
}
