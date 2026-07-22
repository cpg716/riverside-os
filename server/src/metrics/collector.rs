//! Metrics collector that aggregates and manages metrics collection

use crate::cache::CacheService;
use crate::metrics::{BusinessMetrics, MetricRegistry, MetricsConfig, TechnicalMetrics};
use sqlx::PgPool;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::RwLock;
use tracing::{error, info, warn};

#[derive(Debug, Clone)]
pub struct MetricsCollector {
    registry: Arc<RwLock<MetricRegistry>>,
    config: MetricsConfig,
    db_pool: PgPool,
    cache: Option<CacheService>,
    is_running: Arc<RwLock<bool>>,
    dropped_request_samples: Arc<AtomicU64>,
}

impl MetricsCollector {
    pub fn new(config: MetricsConfig, db_pool: PgPool, cache: Option<CacheService>) -> Self {
        Self {
            registry: Arc::new(RwLock::new(MetricRegistry::new(config.clone()))),
            config,
            db_pool,
            cache,
            is_running: Arc::new(RwLock::new(false)),
            dropped_request_samples: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Start the metrics collection loop
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        {
            let mut running = self.is_running.write().await;
            if *running {
                return Err("Metrics collector is already running".into());
            }
            *running = true;
        }

        info!(
            "Starting metrics collection with interval: {:?}",
            self.config.collection_interval
        );

        let registry = self.registry.clone();
        let config = self.config.clone();
        let db_pool = self.db_pool.clone();
        let cache = self.cache.clone();
        let is_running = self.is_running.clone();
        let dropped_request_samples = self.dropped_request_samples.clone();
        let collection_interval = config.collection_interval;

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(collection_interval);

            while *is_running.read().await {
                interval.tick().await;
                let start_time = std::time::Instant::now();

                // No database, Redis, or queue work is performed while the registry is locked.
                if config.enable_business_metrics {
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(15),
                        BusinessMetrics::collect(&db_pool),
                    )
                    .await
                    {
                        Ok(Ok(metrics)) => {
                            let mut registry_guard = registry.write().await;
                            metrics.record_to_registry(&mut registry_guard);
                            info!("Business metrics collected successfully");
                        }
                        Ok(Err(e)) => {
                            error!("Failed to collect business metrics: {}", e);
                        }
                        Err(_) => warn!("Business metrics collection timed out"),
                    }
                }

                if config.enable_technical_metrics {
                    let registry_snapshot = registry.read().await.clone();
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(15),
                        TechnicalMetrics::collect(&db_pool, cache.as_ref(), &registry_snapshot),
                    )
                    .await
                    {
                        Ok(Ok(metrics)) => {
                            let mut registry_guard = registry.write().await;
                            metrics.record_to_registry(&mut registry_guard);
                            info!("Technical metrics collected successfully");
                        }
                        Ok(Err(e)) => {
                            error!("Failed to collect technical metrics: {}", e);
                        }
                        Err(_) => warn!("Technical metrics collection timed out"),
                    }
                }

                {
                    let mut registry_guard = registry.write().await;
                    let dropped = dropped_request_samples.swap(0, Ordering::Relaxed);
                    if dropped > 0 {
                        registry_guard.record_counter(
                            "metrics_request_samples_dropped",
                            dropped as f64,
                            std::collections::HashMap::new(),
                        );
                    }
                    registry_guard.record_timer(
                        "metrics_collection_duration",
                        start_time.elapsed(),
                        std::collections::HashMap::new(),
                    );
                    registry_guard.cleanup_old_metrics(config.retention_period);
                }

                crate::api::health::WorkerHealth::mark_heartbeat("metrics").await;

                let collection_duration = start_time.elapsed();
                if collection_duration > collection_interval {
                    warn!(
                        duration_ms = collection_duration.as_millis(),
                        interval_ms = collection_interval.as_millis(),
                        "Metrics collection took longer than collection interval"
                    );
                }
            }

            info!("Metrics collection stopped");
        });

        Ok(())
    }

    /// Stop the metrics collection loop
    pub async fn stop(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        info!("Stopping metrics collection");

        {
            let mut running = self.is_running.write().await;
            *running = false;
        }

        Ok(())
    }

    /// Check if collector is running
    pub async fn is_running(&self) -> bool {
        *self.is_running.read().await
    }

    /// Get a snapshot of current metrics
    pub async fn get_metrics_snapshot(&self) -> serde_json::Value {
        let registry = self.registry.read().await;
        let metrics = registry.get_all_metrics();

        serde_json::to_value(metrics).unwrap_or(serde_json::json!({}))
    }

    /// Get specific metric snapshot
    pub async fn get_metric_snapshot(
        &self,
        name: &str,
        aggregation: Option<crate::metrics::AggregationType>,
    ) -> Option<crate::metrics::MetricSnapshot> {
        let registry = self.registry.read().await;
        registry.get_snapshot(name, aggregation)
    }

    /// Record a custom metric
    pub async fn record_custom_metric(
        &self,
        name: &str,
        value: f64,
        tags: std::collections::HashMap<String, String>,
        metric_type: crate::metrics::MetricType,
    ) {
        if !value.is_finite()
            || (matches!(&metric_type, crate::metrics::MetricType::Timer)
                && value.is_sign_negative())
        {
            warn!(metric = name, "Discarded invalid custom metric sample");
            return;
        }
        let mut registry = self.registry.write().await;
        match metric_type {
            crate::metrics::MetricType::Counter => registry.record_counter(name, value, tags),
            crate::metrics::MetricType::Gauge => registry.record_gauge(name, value, tags),
            crate::metrics::MetricType::Histogram => registry.record_histogram(name, value, tags),
            crate::metrics::MetricType::Timer => {
                registry.record_timer(name, std::time::Duration::from_secs_f64(value), tags)
            }
        }
    }

    /// Get registry for direct access (for middleware, etc.)
    pub async fn get_registry(&self) -> Arc<RwLock<MetricRegistry>> {
        self.registry.clone()
    }

    /// Record an API request (method, path, status, duration). Used by metrics middleware.
    pub fn try_record_request(&self, method: &str, path: &str, status_code: u16, duration_ms: f64) {
        let mut tags = std::collections::HashMap::new();
        tags.insert("method".to_string(), method.to_string());
        tags.insert("path".to_string(), path.to_string());
        tags.insert("status".to_string(), status_code.to_string());

        let Ok(mut registry) = self.registry.try_write() else {
            self.dropped_request_samples.fetch_add(1, Ordering::Relaxed);
            return;
        };

        registry.record_counter("api_requests_total", 1.0, tags.clone());
        registry.record_histogram("api_request_duration_ms", duration_ms, tags);

        if status_code >= 400 {
            let mut error_tags = std::collections::HashMap::new();
            error_tags.insert("method".to_string(), method.to_string());
            error_tags.insert("status".to_string(), status_code.to_string());
            registry.record_counter("api_errors_total", 1.0, error_tags);
        }
    }
}

#[derive(Debug, Clone)]
pub struct MetricsMiddleware {
    collector: Arc<MetricsCollector>,
}

impl MetricsMiddleware {
    pub fn new(collector: Arc<MetricsCollector>) -> Self {
        Self { collector }
    }

    /// Record database query metrics
    pub async fn record_database_query(&self, query_type: &str, duration_ms: f64, success: bool) {
        let mut tags = std::collections::HashMap::new();
        tags.insert("query_type".to_string(), query_type.to_string());
        tags.insert("success".to_string(), success.to_string());

        self.collector
            .record_custom_metric(
                "database_query_duration_ms",
                duration_ms,
                tags.clone(),
                crate::metrics::MetricType::Histogram,
            )
            .await;

        self.collector
            .record_custom_metric(
                "database_queries_total",
                1.0,
                tags,
                crate::metrics::MetricType::Counter,
            )
            .await;
    }

    /// Record cache operation metrics
    pub async fn record_cache_operation(
        &self,
        operation: &str,
        _key: &str,
        hit: bool,
        duration_ms: f64,
    ) {
        let mut tags = std::collections::HashMap::new();
        tags.insert("operation".to_string(), operation.to_string());
        tags.insert("hit".to_string(), hit.to_string());

        self.collector
            .record_custom_metric(
                "cache_operation_duration_ms",
                duration_ms,
                tags.clone(),
                crate::metrics::MetricType::Histogram,
            )
            .await;

        self.collector
            .record_custom_metric(
                "cache_operations_total",
                1.0,
                tags,
                crate::metrics::MetricType::Counter,
            )
            .await;
    }

    /// Record API request metrics
    pub async fn record_request(
        &self,
        method: &str,
        path: &str,
        status_code: u16,
        duration_ms: f64,
    ) {
        self.collector
            .try_record_request(method, path, status_code, duration_ms);
    }
}

// Axum middleware for automatic metrics collection
pub async fn metrics_middleware(
    axum::extract::State(state): axum::extract::State<crate::api::AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let start_time = std::time::Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_string();

    let response = next.run(request).await;

    let status_code = response.status().as_u16();
    let duration_ms = start_time.elapsed().as_secs_f64() * 1000.0;

    // Record metrics if collector is available
    if let Some(metrics_collector) = &state.metrics_collector {
        metrics_collector.try_record_request(&method, &path, status_code, duration_ms);
    }

    response
}
