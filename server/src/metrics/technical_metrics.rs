//! Technical metrics and system performance KPIs

use crate::metrics::{MetricRegistry, MetricValue};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TechnicalMetrics {
    pub system_metrics: SystemMetrics,
    pub database_metrics: DatabaseMetrics,
    pub api_metrics: ApiMetrics,
    pub cache_metrics: Option<CacheMetrics>,
    pub job_metrics: Option<JobMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetrics {
    pub cpu_usage_percent: Option<f64>,
    pub process_rss_mb: Option<u64>,
    pub process_rss_percent_of_host_memory: Option<f64>,
    pub disk_usage_mb: Option<u64>,
    pub disk_usage_percent: Option<f64>,
    pub network_bytes_sent: Option<u64>,
    pub network_bytes_received: Option<u64>,
    pub uptime_seconds: Option<u64>,
    pub load_average: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseMetrics {
    pub active_connections: u32,
    pub idle_connections: u32,
    pub total_connections: u32,
    pub max_connections: u32,
    pub connection_utilization_percent: Option<f64>,
    pub query_duration_avg_ms: Option<f64>,
    pub slow_queries_count: Option<u64>,
    pub database_size_mb: u64,
    pub wal_size_mb: u64,
    pub cache_hit_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMetrics {
    pub requests_per_second: Option<f64>,
    pub average_response_time_ms: Option<f64>,
    pub p95_response_time_ms: Option<f64>,
    pub p99_response_time_ms: Option<f64>,
    pub error_rate_percent: Option<f64>,
    pub status_codes: HashMap<String, u64>,
    pub endpoints_by_latency: HashMap<String, f64>,
    pub active_connections: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheMetrics {
    pub hit_rate_percent: Option<f64>,
    pub miss_rate_percent: Option<f64>,
    pub total_operations: u64,
    pub memory_usage_mb: u64,
    pub evicted_keys: u64,
    pub expired_keys: u64,
    pub connected_clients: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobMetrics {
    pub jobs_enqueued: u64,
    pub jobs_dequeued: u64,
    pub jobs_completed: u64,
    pub jobs_failed: u64,
    pub average_processing_time_seconds: Option<f64>,
    pub pending_jobs: u64,
    pub processing_jobs: u64,
    pub dead_letter_jobs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TechnicalKpi {
    SystemLoadAverage { load: f64 },
    DatabaseConnectionUtilization { percent: f64 },
    ApiResponseTime { endpoint: String, p95_ms: f64 },
    ErrorRate { percent: f64 },
    CacheHitRate { percent: f64 },
    JobProcessingRate { jobs_per_second: f64 },
    MemoryUtilization { percent: f64 },
    DiskUtilization { percent: f64 },
}

impl TechnicalMetrics {
    pub async fn collect(
        pool: &PgPool,
        cache: Option<&crate::cache::CacheService>,
        registry: &MetricRegistry,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // Collect system metrics
        let system_metrics = Self::collect_system_metrics();

        // Collect database metrics
        let database_metrics = Self::collect_database_metrics(pool).await?;

        // Collect API metrics (from registry or external source)
        let api_metrics = Self::collect_api_metrics(registry, pool).await?;

        // Collect cache metrics if available
        let cache_metrics = match cache {
            Some(cache_service) => Self::collect_cache_metrics(cache_service).await,
            None => None,
        };

        let job_metrics = Self::collect_job_metrics(cache).await;

        Ok(TechnicalMetrics {
            system_metrics,
            database_metrics,
            api_metrics,
            cache_metrics,
            job_metrics,
        })
    }

    pub fn record_to_registry(&self, registry: &mut MetricRegistry) {
        Self::record_metrics_to_registry(
            &self.system_metrics,
            &self.database_metrics,
            &self.api_metrics,
            self.cache_metrics.as_ref(),
            self.job_metrics.as_ref(),
            registry,
        );
    }

    fn collect_system_metrics() -> SystemMetrics {
        // The server deliberately avoids synthetic host values. Platform-specific host
        // telemetry is reported only where the runtime exposes it without a new dependency.
        let cpu_usage_percent = None;

        // Process resident memory is not the same as host-wide memory usage.
        let process_rss_mb = Self::get_process_rss_mb();
        let host_total_memory_mb = Self::get_host_total_memory_mb();
        let process_rss_percent_of_host_memory = process_rss_mb
            .zip(host_total_memory_mb)
            .and_then(|(used, total)| Self::safe_percent(used, total));

        // Disk and network counters are unavailable without a platform telemetry source.
        let disk_usage_mb = None;
        let disk_usage_percent = None;

        let network_bytes_sent = None;
        let network_bytes_received = None;

        // Uptime
        let uptime_seconds = Self::get_system_uptime();

        // Load average (Unix systems)
        let load_average = Self::get_load_average();

        SystemMetrics {
            cpu_usage_percent,
            process_rss_mb,
            process_rss_percent_of_host_memory,
            disk_usage_mb,
            disk_usage_percent,
            network_bytes_sent,
            network_bytes_received,
            uptime_seconds,
            load_average,
        }
    }

    async fn collect_database_metrics(pool: &PgPool) -> Result<DatabaseMetrics, sqlx::Error> {
        // Connection metrics
        let idle_connections = pool.num_idle() as u32;
        let total_connections = pool.size();
        let active_connections = total_connections.saturating_sub(idle_connections);
        let max_connections = pool.options().get_max_connections();
        let connection_utilization_percent =
            Self::safe_percent(active_connections as u64, max_connections as u64);

        // Query performance metrics
        let query_duration_avg_ms = sqlx::query_scalar::<_, Option<f64>>(
            r#"
            SELECT COALESCE(AVG(mean_exec_time), 0)
            FROM pg_stat_statements
            WHERE calls > 0
            "#,
        )
        .fetch_one(pool)
        .await
        .ok()
        .flatten()
        .filter(|value| value.is_finite());

        // Slow queries (queries taking longer than 1 second)
        let slow_queries_count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*)
            FROM pg_stat_statements
            WHERE mean_exec_time > 1000
            "#,
        )
        .fetch_one(pool)
        .await
        .ok()
        .and_then(|value| u64::try_from(value).ok());

        // Database size
        let database_size_mb: Option<i64> =
            sqlx::query_scalar("SELECT pg_database_size(current_database()) / 1024 / 1024")
                .fetch_optional(pool)
                .await?;

        // WAL size
        let wal_size_mb: Option<i64> = sqlx::query_scalar(
            "SELECT (pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') / 1024 / 1024)::bigint",
        )
        .fetch_optional(pool)
        .await?;

        // Cache hit ratio
        let cache_hit_ratio: f64 = sqlx::query_scalar(
            r#"
            SELECT
                CASE
                    WHEN (blks_hit + blks_read) = 0 THEN 0
                    ELSE (blks_hit::float / (blks_hit + blks_read)::float) * 100
                END
            FROM pg_stat_database
            WHERE datname = current_database()
            "#,
        )
        .fetch_one(pool)
        .await?;

        Ok(DatabaseMetrics {
            active_connections,
            idle_connections,
            total_connections,
            max_connections,
            connection_utilization_percent,
            query_duration_avg_ms,
            slow_queries_count,
            database_size_mb: database_size_mb.unwrap_or(0) as u64,
            wal_size_mb: wal_size_mb.unwrap_or(0) as u64,
            cache_hit_ratio,
        })
    }

    async fn collect_api_metrics(
        registry: &MetricRegistry,
        pool: &PgPool,
    ) -> Result<ApiMetrics, Box<dyn std::error::Error + Send + Sync>> {
        let duration_values = registry
            .get_metric("api_request_duration_ms")
            .into_iter()
            .flat_map(|values| values.iter())
            .filter(|value| value.value.is_finite())
            .collect::<Vec<_>>();
        let request_values = registry
            .get_metric("api_requests_total")
            .into_iter()
            .flat_map(|values| values.iter())
            .filter(|value| value.value.is_finite() && !value.value.is_sign_negative())
            .collect::<Vec<_>>();
        let error_values = registry
            .get_metric("api_errors_total")
            .into_iter()
            .flat_map(|values| values.iter())
            .filter(|value| value.value.is_finite() && !value.value.is_sign_negative())
            .collect::<Vec<_>>();
        let requests_per_second = Self::observed_requests_per_second(&request_values);
        let mut sorted_durations = duration_values
            .iter()
            .map(|value| value.value)
            .collect::<Vec<_>>();
        sorted_durations.sort_by(|a, b| a.total_cmp(b));
        let percentile = |percent: f64| {
            sorted_durations
                .get(
                    (((sorted_durations.len().saturating_sub(1)) as f64 * percent).round())
                        as usize,
                )
                .copied()
        };
        let mut status_codes = HashMap::new();
        let mut endpoint_durations: HashMap<String, Vec<f64>> = HashMap::new();
        let latest_request_values = Self::latest_counter_series_values(&request_values);
        for value in &latest_request_values {
            if let Some(status) = value.tags.get("status") {
                let count = Self::counter_value_as_u64(value.value);
                let status_total = status_codes.entry(status.clone()).or_insert(0_u64);
                *status_total = status_total.saturating_add(count);
            }
        }
        for value in duration_values {
            let path = value
                .tags
                .get("path")
                .cloned()
                .unwrap_or_else(|| "unknown".to_string());
            endpoint_durations
                .entry(path)
                .or_default()
                .push(value.value);
        }
        let endpoints_by_latency = endpoint_durations
            .into_iter()
            .map(|(path, mut values)| {
                values.sort_by(|a, b| a.total_cmp(b));
                let index = ((values.len().saturating_sub(1) as f64) * 0.95).round() as usize;
                (path, values.get(index).copied().unwrap_or(0.0))
            })
            .collect();
        let request_count = latest_request_values
            .iter()
            .map(|value| value.value)
            .sum::<f64>();
        let error_count = Self::latest_counter_series_values(&error_values)
            .iter()
            .map(|value| value.value)
            .sum::<f64>();
        let average_response_time_ms = if sorted_durations.is_empty() {
            None
        } else {
            Some(sorted_durations.iter().sum::<f64>() / sorted_durations.len() as f64)
        };
        let active_connections = pool.size().saturating_sub(pool.num_idle() as u32);

        Ok(ApiMetrics {
            requests_per_second,
            average_response_time_ms,
            p95_response_time_ms: percentile(0.95),
            p99_response_time_ms: percentile(0.99),
            error_rate_percent: if request_count > 0.0 {
                Some(error_count / request_count * 100.0)
            } else {
                None
            },
            status_codes,
            endpoints_by_latency,
            active_connections,
        })
    }

    fn observed_requests_per_second(values: &[&MetricValue]) -> Option<f64> {
        if values.len() < 2 {
            return None;
        }
        let first = values.iter().map(|value| value.timestamp).min()?;
        let last = values.iter().map(|value| value.timestamp).max()?;
        let elapsed_nanoseconds = (last - first).num_nanoseconds()?;
        if elapsed_nanoseconds <= 0 {
            return None;
        }
        let elapsed_seconds = elapsed_nanoseconds as f64 / 1_000_000_000.0;
        let rate = values.len().saturating_sub(1) as f64 / elapsed_seconds;
        rate.is_finite().then_some(rate)
    }

    fn latest_counter_series_values<'a>(values: &[&'a MetricValue]) -> Vec<&'a MetricValue> {
        let mut latest = std::collections::BTreeMap::<Vec<(String, String)>, &MetricValue>::new();
        for value in values {
            let mut tags = value
                .tags
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>();
            tags.sort_unstable();
            match latest.get(&tags) {
                Some(existing) if existing.timestamp > value.timestamp => {}
                _ => {
                    latest.insert(tags, value);
                }
            }
        }
        latest.into_values().collect()
    }

    fn counter_value_as_u64(value: f64) -> u64 {
        value.floor().clamp(0.0, u64::MAX as f64) as u64
    }

    async fn collect_cache_metrics(cache: &crate::cache::CacheService) -> Option<CacheMetrics> {
        let info = match tokio::time::timeout(Duration::from_secs(1), cache.redis().info()).await {
            Ok(Ok(info)) => info,
            Ok(Err(error)) => {
                tracing::warn!(%error, "Redis INFO telemetry unavailable");
                return None;
            }
            Err(_) => {
                tracing::warn!("Redis INFO telemetry timed out");
                return None;
            }
        };
        let metrics = Self::parse_redis_info(&info);
        if metrics.is_none() {
            tracing::warn!("Redis INFO telemetry was incomplete or malformed");
        }
        metrics
    }

    fn parse_redis_info(info: &str) -> Option<CacheMetrics> {
        let value = |key: &str| -> Option<u64> {
            info.lines().find_map(|line| {
                let (candidate, raw) = line.trim_end_matches('\r').split_once(':')?;
                (candidate == key)
                    .then(|| raw.trim().parse::<u64>().ok())
                    .flatten()
            })
        };
        let hits = value("keyspace_hits")?;
        let misses = value("keyspace_misses")?;
        let total_operations = value("total_commands_processed")?;
        let used_memory = value("used_memory")?;
        let evicted_keys = value("evicted_keys")?;
        let expired_keys = value("expired_keys")?;
        let connected_clients = u32::try_from(value("connected_clients")?).ok()?;
        let cache_lookups = hits.checked_add(misses)?;
        let hit_rate_percent = (cache_lookups > 0)
            .then(|| Self::safe_percent(hits, cache_lookups))
            .flatten();
        let miss_rate_percent = (cache_lookups > 0)
            .then(|| Self::safe_percent(misses, cache_lookups))
            .flatten();

        Some(CacheMetrics {
            hit_rate_percent,
            miss_rate_percent,
            total_operations,
            memory_usage_mb: used_memory / (1024 * 1024),
            evicted_keys,
            expired_keys,
            connected_clients,
        })
    }

    async fn collect_job_metrics(cache: Option<&crate::cache::CacheService>) -> Option<JobMetrics> {
        if !matches!(
            std::env::var("RIVERSIDE_JOB_QUEUE_ENABLED")
                .ok()
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        ) {
            return None;
        }
        let Some(_cache) = cache else {
            return None;
        };
        match crate::jobs::JobQueue::from_env() {
            Ok(queue) => {
                match tokio::time::timeout(Duration::from_secs(1), queue.get_stats()).await {
                    Ok(Ok(stats)) => Some(JobMetrics {
                        jobs_enqueued: stats.enqueued.max(0) as u64,
                        jobs_dequeued: stats.dequeued.max(0) as u64,
                        jobs_completed: stats.completed.max(0) as u64,
                        jobs_failed: stats.failed.max(0) as u64,
                        // QueueStats does not currently expose observed processing duration.
                        // Absence is truthful; a synthetic zero would not be.
                        average_processing_time_seconds: None,
                        pending_jobs: stats.pending.max(0) as u64,
                        processing_jobs: stats.processing.max(0) as u64,
                        dead_letter_jobs: stats.dead_letter.max(0) as u64,
                    }),
                    Ok(Err(error)) => {
                        tracing::warn!(%error, "job queue telemetry unavailable");
                        None
                    }
                    Err(_) => {
                        tracing::warn!("job queue telemetry timed out");
                        None
                    }
                }
            }
            Err(error) => {
                tracing::warn!(%error, "job queue telemetry unavailable");
                None
            }
        }
    }

    fn record_metrics_to_registry(
        system: &SystemMetrics,
        database: &DatabaseMetrics,
        api: &ApiMetrics,
        cache: Option<&CacheMetrics>,
        jobs: Option<&JobMetrics>,
        registry: &mut MetricRegistry,
    ) {
        // System metrics
        if let Some(value) = system.cpu_usage_percent {
            registry.record_gauge("system_cpu_usage_percent", value, HashMap::new());
        }
        if let Some(value) = system.process_rss_mb {
            registry.record_gauge("process_memory_rss_mb", value as f64, HashMap::new());
        }
        if let Some(value) = system.process_rss_percent_of_host_memory {
            registry.record_gauge("process_memory_rss_percent_of_host", value, HashMap::new());
        }
        if let Some(value) = system.disk_usage_mb {
            registry.record_gauge("system_disk_usage_mb", value as f64, HashMap::new());
        }
        if let Some(value) = system.disk_usage_percent {
            registry.record_gauge("system_disk_usage_percent", value, HashMap::new());
        }
        if let Some(value) = system.network_bytes_sent {
            registry.record_gauge("system_network_bytes_sent", value as f64, HashMap::new());
        }
        if let Some(value) = system.network_bytes_received {
            registry.record_gauge(
                "system_network_bytes_received",
                value as f64,
                HashMap::new(),
            );
        }
        if let Some(value) = system.uptime_seconds {
            registry.record_gauge("system_uptime_seconds", value as f64, HashMap::new());
        }

        if let Some(load_avg) = system.load_average {
            registry.record_gauge("system_load_average", load_avg, HashMap::new());
        }

        // Database metrics
        registry.record_gauge(
            "database_active_connections",
            database.active_connections as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "database_idle_connections",
            database.idle_connections as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "database_total_connections",
            database.total_connections as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "database_max_connections",
            database.max_connections as f64,
            HashMap::new(),
        );
        if let Some(value) = database.connection_utilization_percent {
            registry.record_gauge(
                "database_connection_utilization_percent",
                value,
                HashMap::new(),
            );
        }
        if let Some(value) = database.query_duration_avg_ms {
            registry.record_gauge("database_query_duration_avg_ms", value, HashMap::new());
        }
        if let Some(value) = database.slow_queries_count {
            registry.record_gauge("database_slow_queries_count", value as f64, HashMap::new());
        }
        registry.record_gauge(
            "database_size_mb",
            database.database_size_mb as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "database_wal_size_mb",
            database.wal_size_mb as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "database_cache_hit_ratio",
            database.cache_hit_ratio,
            HashMap::new(),
        );

        // API metrics
        if let Some(value) = api.requests_per_second {
            registry.record_gauge("api_requests_per_second", value, HashMap::new());
        }
        if let Some(value) = api.average_response_time_ms {
            registry.record_gauge("api_average_response_time_ms", value, HashMap::new());
        }
        if let Some(value) = api.p95_response_time_ms {
            registry.record_gauge("api_p95_response_time_ms", value, HashMap::new());
        }
        if let Some(value) = api.p99_response_time_ms {
            registry.record_gauge("api_p99_response_time_ms", value, HashMap::new());
        }
        if let Some(value) = api.error_rate_percent {
            registry.record_gauge("api_error_rate_percent", value, HashMap::new());
        }
        registry.record_gauge(
            "api_active_connections",
            api.active_connections as f64,
            HashMap::new(),
        );

        // Optional integrations are omitted when unavailable instead of emitting synthetic zeroes.
        if let Some(cache) = cache {
            if let Some(value) = cache.hit_rate_percent {
                registry.record_gauge("cache_hit_rate_percent", value, HashMap::new());
            }
            if let Some(value) = cache.miss_rate_percent {
                registry.record_gauge("cache_miss_rate_percent", value, HashMap::new());
            }
            registry.record_gauge(
                "cache_total_operations",
                cache.total_operations as f64,
                HashMap::new(),
            );
            registry.record_gauge(
                "cache_memory_usage_mb",
                cache.memory_usage_mb as f64,
                HashMap::new(),
            );
            registry.record_gauge(
                "cache_evicted_keys",
                cache.evicted_keys as f64,
                HashMap::new(),
            );
            registry.record_gauge(
                "cache_expired_keys",
                cache.expired_keys as f64,
                HashMap::new(),
            );
            registry.record_gauge(
                "cache_connected_clients",
                cache.connected_clients as f64,
                HashMap::new(),
            );
        }

        if let Some(jobs) = jobs {
            registry.record_gauge("jobs_enqueued", jobs.jobs_enqueued as f64, HashMap::new());
            registry.record_gauge("jobs_dequeued", jobs.jobs_dequeued as f64, HashMap::new());
            registry.record_gauge("jobs_completed", jobs.jobs_completed as f64, HashMap::new());
            registry.record_gauge("jobs_failed", jobs.jobs_failed as f64, HashMap::new());
            if let Some(value) = jobs.average_processing_time_seconds {
                registry.record_gauge(
                    "jobs_average_processing_time_seconds",
                    value,
                    HashMap::new(),
                );
            }
            registry.record_gauge("jobs_pending", jobs.pending_jobs as f64, HashMap::new());
            registry.record_gauge(
                "jobs_processing",
                jobs.processing_jobs as f64,
                HashMap::new(),
            );
            registry.record_gauge(
                "jobs_dead_letter",
                jobs.dead_letter_jobs as f64,
                HashMap::new(),
            );
        }
    }

    fn safe_percent(used: u64, total: u64) -> Option<f64> {
        if total == 0 {
            return None;
        }
        let value = used as f64 / total as f64 * 100.0;
        value.is_finite().then_some(value)
    }

    // Helper methods use host-provided procfs values where available. Unsupported platforms
    // return None instead of presenting made-up capacity numbers.
    fn get_process_rss_mb() -> Option<u64> {
        #[cfg(target_os = "linux")]
        {
            return std::fs::read_to_string("/proc/self/status")
                .ok()?
                .lines()
                .find_map(|line| {
                    line.strip_prefix("VmRSS:")
                        .and_then(|value| value.split_whitespace().next())
                        .and_then(|value| value.parse::<u64>().ok())
                })
                .map(|kb| kb / 1024);
        }
        #[cfg(not(target_os = "linux"))]
        None
    }

    fn get_host_total_memory_mb() -> Option<u64> {
        #[cfg(target_os = "linux")]
        {
            return std::fs::read_to_string("/proc/meminfo")
                .ok()
                .and_then(|contents| {
                    contents.lines().find_map(|line| {
                        line.strip_prefix("MemTotal:")
                            .and_then(|value| value.split_whitespace().next())
                            .and_then(|value| value.parse::<u64>().ok())
                    })
                })
                .map(|kb| kb / 1024)
                .filter(|value| *value > 0);
        }
        #[cfg(not(target_os = "linux"))]
        None
    }

    fn get_system_uptime() -> Option<u64> {
        #[cfg(target_os = "linux")]
        {
            return std::fs::read_to_string("/proc/uptime")
                .ok()?
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value as u64);
        }
        #[cfg(not(target_os = "linux"))]
        None
    }

    fn get_load_average() -> Option<f64> {
        #[cfg(target_os = "linux")]
        {
            return std::fs::read_to_string("/proc/loadavg")
                .ok()?
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite());
        }
        #[cfg(not(target_os = "linux"))]
        None
    }
}

#[cfg(test)]
mod tests {
    use super::TechnicalMetrics;
    use crate::metrics::{MetricType, MetricValue};
    use chrono::{Duration, Utc};
    use std::collections::HashMap;

    #[test]
    fn percentages_never_divide_by_zero() {
        assert_eq!(TechnicalMetrics::safe_percent(1, 0), None);
        assert_eq!(TechnicalMetrics::safe_percent(25, 100), Some(25.0));
    }

    #[test]
    fn reported_system_values_are_finite() {
        let metrics = TechnicalMetrics::collect_system_metrics();
        for value in [
            metrics.cpu_usage_percent,
            metrics.process_rss_percent_of_host_memory,
            metrics.disk_usage_percent,
            metrics.load_average,
        ]
        .into_iter()
        .flatten()
        {
            assert!(value.is_finite());
        }
    }

    #[test]
    fn request_rate_requires_a_real_observation_window() {
        let timestamp = Utc::now();
        let first = MetricValue {
            value: 1.0,
            timestamp,
            tags: HashMap::new(),
            metric_type: MetricType::Counter,
        };
        let same_instant = MetricValue {
            value: 2.0,
            timestamp,
            tags: HashMap::new(),
            metric_type: MetricType::Counter,
        };
        assert_eq!(
            TechnicalMetrics::observed_requests_per_second(&[&first, &same_instant]),
            None
        );

        let one_second_later = MetricValue {
            value: 2.0,
            timestamp: timestamp + Duration::seconds(1),
            tags: HashMap::new(),
            metric_type: MetricType::Counter,
        };
        assert_eq!(
            TechnicalMetrics::observed_requests_per_second(&[&first, &one_second_later]),
            Some(1.0)
        );
    }

    #[test]
    fn redis_info_must_be_complete_and_numeric() {
        let valid = concat!(
            "keyspace_hits:75\r\n",
            "keyspace_misses:25\r\n",
            "total_commands_processed:250\r\n",
            "used_memory:2097152\r\n",
            "evicted_keys:3\r\n",
            "expired_keys:9\r\n",
            "connected_clients:4\r\n",
        );
        let metrics =
            TechnicalMetrics::parse_redis_info(valid).expect("complete Redis INFO should parse");
        assert_eq!(metrics.hit_rate_percent, Some(75.0));
        assert_eq!(metrics.miss_rate_percent, Some(25.0));
        assert_eq!(metrics.memory_usage_mb, 2);
        assert_eq!(metrics.connected_clients, 4);

        assert!(TechnicalMetrics::parse_redis_info("keyspace_hits:75\n").is_none());
        assert!(TechnicalMetrics::parse_redis_info(
            &valid.replace("connected_clients:4", "connected_clients:not-a-number")
        )
        .is_none());
    }

    #[test]
    fn zero_cache_lookups_do_not_claim_a_zero_percent_rate() {
        let info = concat!(
            "keyspace_hits:0\n",
            "keyspace_misses:0\n",
            "total_commands_processed:0\n",
            "used_memory:0\n",
            "evicted_keys:0\n",
            "expired_keys:0\n",
            "connected_clients:0\n",
        );
        let metrics = TechnicalMetrics::parse_redis_info(info)
            .expect("zero-valued but complete Redis INFO should parse");
        assert_eq!(metrics.hit_rate_percent, None);
        assert_eq!(metrics.miss_rate_percent, None);
    }
}
