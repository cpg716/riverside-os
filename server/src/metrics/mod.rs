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
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricValue {
    pub value: f64,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub tags: HashMap<String, String>,
    pub metric_type: MetricType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    config: MetricsConfig,
}

impl MetricRegistry {
    pub fn new(config: MetricsConfig) -> Self {
        Self {
            metrics: HashMap::new(),
            config,
        }
    }

    pub fn record_counter(&mut self, name: &str, value: f64, tags: HashMap<String, String>) {
        self.record_metric(name, value, tags, MetricType::Counter);
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
            Some(AggregationType::Sum) => Some(values.iter().map(|v| v.value).sum()),
            Some(AggregationType::Average) => {
                let sum: f64 = values.iter().map(|v| v.value).sum();
                Some(sum / values.len() as f64)
            }
            Some(AggregationType::Min) => {
                Some(values.iter().map(|v| v.value).fold(f64::INFINITY, f64::min))
            }
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
    }
}
