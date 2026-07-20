//! Technical metrics and system performance KPIs

use crate::metrics::MetricRegistry;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TechnicalMetrics {
    pub system_metrics: SystemMetrics,
    pub database_metrics: DatabaseMetrics,
    pub api_metrics: ApiMetrics,
    pub cache_metrics: CacheMetrics,
    pub job_metrics: JobMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetrics {
    pub cpu_usage_percent: f64,
    pub memory_usage_mb: u64,
    pub memory_usage_percent: f64,
    pub disk_usage_mb: u64,
    pub disk_usage_percent: f64,
    pub network_bytes_sent: u64,
    pub network_bytes_received: u64,
    pub uptime_seconds: u64,
    pub load_average: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseMetrics {
    pub active_connections: u32,
    pub idle_connections: u32,
    pub total_connections: u32,
    pub connection_utilization_percent: f64,
    pub query_duration_avg_ms: f64,
    pub slow_queries_count: u64,
    pub database_size_mb: u64,
    pub wal_size_mb: u64,
    pub cache_hit_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMetrics {
    pub requests_per_second: f64,
    pub average_response_time_ms: f64,
    pub p95_response_time_ms: f64,
    pub p99_response_time_ms: f64,
    pub error_rate_percent: f64,
    pub status_codes: HashMap<String, u64>,
    pub endpoints_by_latency: HashMap<String, f64>,
    pub active_connections: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheMetrics {
    pub hit_rate_percent: f64,
    pub miss_rate_percent: f64,
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
    pub average_processing_time_seconds: f64,
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
        registry: &mut MetricRegistry,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let start_time = Instant::now();

        // Collect system metrics
        let system_metrics = Self::collect_system_metrics().await?;

        // Collect database metrics
        let database_metrics = Self::collect_database_metrics(pool).await?;

        // Collect API metrics (from registry or external source)
        let api_metrics = Self::collect_api_metrics(registry, pool).await?;

        // Collect cache metrics if available
        let cache_metrics = if let Some(cache_service) = cache {
            Self::collect_cache_metrics(cache_service).await
        } else {
            CacheMetrics::default()
        };

        let job_metrics = Self::collect_job_metrics(cache).await;

        // Record metrics to registry
        Self::record_metrics_to_registry(
            &system_metrics,
            &database_metrics,
            &api_metrics,
            &cache_metrics,
            &job_metrics,
            registry,
        );

        let collection_time = start_time.elapsed();
        registry.record_timer(
            "technical_metrics_collection_duration",
            collection_time,
            HashMap::new(),
        );

        Ok(TechnicalMetrics {
            system_metrics,
            database_metrics,
            api_metrics,
            cache_metrics,
            job_metrics,
        })
    }

    async fn collect_system_metrics(
    ) -> Result<SystemMetrics, Box<dyn std::error::Error + Send + Sync>> {
        // The server deliberately avoids synthetic host values. Platform-specific host
        // telemetry is reported only where the runtime exposes it without a new dependency.
        let cpu_usage_percent = 0.0;

        // Memory usage
        let memory_usage_mb = Self::get_memory_usage()?;
        let total_memory_mb = Self::get_total_memory_mb();
        let memory_usage_percent = (memory_usage_mb as f64 / total_memory_mb as f64) * 100.0;

        // Disk usage
        let disk_usage_mb = Self::get_disk_usage()?;
        let total_disk_mb = 0;
        let disk_usage_percent = (disk_usage_mb as f64 / total_disk_mb as f64) * 100.0;

        let network_bytes_sent = 0;
        let network_bytes_received = 0;

        // Uptime
        let uptime_seconds = Self::get_system_uptime()?;

        // Load average (Unix systems)
        let load_average = Self::get_load_average()?;

        Ok(SystemMetrics {
            cpu_usage_percent,
            memory_usage_mb,
            memory_usage_percent,
            disk_usage_mb,
            disk_usage_percent,
            network_bytes_sent,
            network_bytes_received,
            uptime_seconds,
            load_average,
        })
    }

    async fn collect_database_metrics(pool: &PgPool) -> Result<DatabaseMetrics, sqlx::Error> {
        // Connection metrics
        let idle_connections = pool.num_idle() as u32;
        let total_connections = pool.size();
        let active_connections = total_connections - idle_connections;
        let connection_utilization_percent = if total_connections > 0 {
            (active_connections as f64 / total_connections as f64) * 100.0
        } else {
            0.0
        };

        // Query performance metrics
        let query_duration_avg_ms: Option<f64> = sqlx::query_scalar(
            r#"
            SELECT COALESCE(AVG(mean_exec_time), 0)
            FROM pg_stat_statements
            WHERE calls > 0
            "#,
        )
        .fetch_optional(pool)
        .await
        .unwrap_or(Some(0.0));

        // Slow queries (queries taking longer than 1 second)
        let slow_queries_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM pg_stat_statements
            WHERE mean_exec_time > 1000
            "#,
        )
        .fetch_one(pool)
        .await
        .unwrap_or(0);

        // Database size
        let database_size_mb: Option<i64> =
            sqlx::query_scalar("SELECT pg_database_size(current_database()) / 1024 / 1024")
                .fetch_optional(pool)
                .await?;

        // WAL size
        let wal_size_mb: Option<i64> =
            sqlx::query_scalar("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') / 1024 / 1024")
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
            connection_utilization_percent,
            query_duration_avg_ms: query_duration_avg_ms.unwrap_or(0.0),
            slow_queries_count: slow_queries_count as u64,
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
            .collect::<Vec<_>>();
        let error_count = registry
            .get_metric("api_errors_total")
            .map(|values| values.len() as u64)
            .unwrap_or(0);
        let window_seconds = duration_values
            .first()
            .zip(duration_values.last())
            .map(|(first, last)| {
                (last.timestamp - first.timestamp).num_milliseconds().max(1) as f64 / 1000.0
            })
            .unwrap_or(1.0);
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
                .unwrap_or(0.0)
        };
        let mut status_codes = HashMap::new();
        let mut endpoint_durations: HashMap<String, Vec<f64>> = HashMap::new();
        for value in &request_values {
            if let Some(status) = value.tags.get("status") {
                *status_codes.entry(status.clone()).or_insert(0) += 1;
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
        let request_count = request_values.len() as f64;
        let average_response_time_ms = if sorted_durations.is_empty() {
            0.0
        } else {
            sorted_durations.iter().sum::<f64>() / sorted_durations.len() as f64
        };
        let active_connections = pool.size().saturating_sub(pool.num_idle() as u32);

        Ok(ApiMetrics {
            requests_per_second: request_count / window_seconds,
            average_response_time_ms,
            p95_response_time_ms: percentile(0.95),
            p99_response_time_ms: percentile(0.99),
            error_rate_percent: if request_count > 0.0 {
                error_count as f64 / request_count * 100.0
            } else {
                0.0
            },
            status_codes,
            endpoints_by_latency,
            active_connections,
        })
    }

    async fn collect_cache_metrics(cache: &crate::cache::CacheService) -> CacheMetrics {
        let info = match tokio::time::timeout(Duration::from_secs(1), cache.redis().info()).await {
            Ok(Ok(info)) => info,
            Ok(Err(error)) => {
                tracing::warn!(%error, "Redis INFO telemetry unavailable");
                return CacheMetrics::default();
            }
            Err(_) => {
                tracing::warn!("Redis INFO telemetry timed out");
                return CacheMetrics::default();
            }
        };
        let value = |key: &str| -> u64 {
            info.lines()
                .find_map(|line| line.strip_prefix(&format!("{key}:")))
                .and_then(|raw| raw.trim().parse::<u64>().ok())
                .unwrap_or(0)
        };
        let hits = value("keyspace_hits");
        let misses = value("keyspace_misses");
        let total_operations = value("total_commands_processed");
        let hit_rate_percent = if hits + misses > 0 {
            hits as f64 / (hits + misses) as f64 * 100.0
        } else {
            0.0
        };
        let miss_rate_percent = if hits + misses > 0 {
            misses as f64 / (hits + misses) as f64 * 100.0
        } else {
            0.0
        };
        let memory_usage_mb = value("used_memory") / (1024 * 1024);
        let evicted_keys = value("evicted_keys");
        let expired_keys = value("expired_keys");
        let connected_clients = value("connected_clients") as u32;

        CacheMetrics {
            hit_rate_percent,
            miss_rate_percent,
            total_operations,
            memory_usage_mb,
            evicted_keys,
            expired_keys,
            connected_clients,
        }
    }

    async fn collect_job_metrics(cache: Option<&crate::cache::CacheService>) -> JobMetrics {
        if !matches!(
            std::env::var("RIVERSIDE_JOB_QUEUE_ENABLED")
                .ok()
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        ) {
            return JobMetrics::default();
        }
        let Some(_cache) = cache else {
            return JobMetrics::default();
        };
        match crate::jobs::JobQueue::from_env() {
            Ok(queue) => {
                match tokio::time::timeout(Duration::from_secs(1), queue.get_stats()).await {
                    Ok(Ok(stats)) => JobMetrics {
                        jobs_enqueued: stats.enqueued.max(0) as u64,
                        jobs_dequeued: stats.dequeued.max(0) as u64,
                        jobs_completed: stats.completed.max(0) as u64,
                        jobs_failed: stats.failed.max(0) as u64,
                        average_processing_time_seconds: 0.0,
                        pending_jobs: stats.pending.max(0) as u64,
                        processing_jobs: stats.processing.max(0) as u64,
                        dead_letter_jobs: stats.dead_letter.max(0) as u64,
                    },
                    Ok(Err(error)) => {
                        tracing::warn!(%error, "job queue telemetry unavailable");
                        JobMetrics::default()
                    }
                    Err(_) => {
                        tracing::warn!("job queue telemetry timed out");
                        JobMetrics::default()
                    }
                }
            }
            Err(error) => {
                tracing::warn!(%error, "job queue telemetry unavailable");
                JobMetrics::default()
            }
        }
    }

    fn record_metrics_to_registry(
        system: &SystemMetrics,
        database: &DatabaseMetrics,
        api: &ApiMetrics,
        cache: &CacheMetrics,
        jobs: &JobMetrics,
        registry: &mut MetricRegistry,
    ) {
        // System metrics
        registry.record_gauge(
            "system_cpu_usage_percent",
            system.cpu_usage_percent,
            HashMap::new(),
        );
        registry.record_gauge(
            "system_memory_usage_mb",
            system.memory_usage_mb as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "system_memory_usage_percent",
            system.memory_usage_percent,
            HashMap::new(),
        );
        registry.record_gauge(
            "system_disk_usage_mb",
            system.disk_usage_mb as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "system_disk_usage_percent",
            system.disk_usage_percent,
            HashMap::new(),
        );
        registry.record_counter(
            "system_network_bytes_sent",
            system.network_bytes_sent as f64,
            HashMap::new(),
        );
        registry.record_counter(
            "system_network_bytes_received",
            system.network_bytes_received as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "system_uptime_seconds",
            system.uptime_seconds as f64,
            HashMap::new(),
        );

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
            "database_connection_utilization_percent",
            database.connection_utilization_percent,
            HashMap::new(),
        );
        registry.record_gauge(
            "database_query_duration_avg_ms",
            database.query_duration_avg_ms,
            HashMap::new(),
        );
        registry.record_counter(
            "database_slow_queries_count",
            database.slow_queries_count as f64,
            HashMap::new(),
        );
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
        registry.record_gauge(
            "api_requests_per_second",
            api.requests_per_second,
            HashMap::new(),
        );
        registry.record_gauge(
            "api_average_response_time_ms",
            api.average_response_time_ms,
            HashMap::new(),
        );
        registry.record_gauge(
            "api_p95_response_time_ms",
            api.p95_response_time_ms,
            HashMap::new(),
        );
        registry.record_gauge(
            "api_p99_response_time_ms",
            api.p99_response_time_ms,
            HashMap::new(),
        );
        registry.record_gauge(
            "api_error_rate_percent",
            api.error_rate_percent,
            HashMap::new(),
        );
        registry.record_gauge(
            "api_active_connections",
            api.active_connections as f64,
            HashMap::new(),
        );

        // Cache metrics
        registry.record_gauge(
            "cache_hit_rate_percent",
            cache.hit_rate_percent,
            HashMap::new(),
        );
        registry.record_gauge(
            "cache_miss_rate_percent",
            cache.miss_rate_percent,
            HashMap::new(),
        );
        registry.record_counter(
            "cache_total_operations",
            cache.total_operations as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "cache_memory_usage_mb",
            cache.memory_usage_mb as f64,
            HashMap::new(),
        );
        registry.record_counter(
            "cache_evicted_keys",
            cache.evicted_keys as f64,
            HashMap::new(),
        );
        registry.record_counter(
            "cache_expired_keys",
            cache.expired_keys as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "cache_connected_clients",
            cache.connected_clients as f64,
            HashMap::new(),
        );

        // Job metrics
        registry.record_counter("jobs_enqueued", jobs.jobs_enqueued as f64, HashMap::new());
        registry.record_counter("jobs_dequeued", jobs.jobs_dequeued as f64, HashMap::new());
        registry.record_counter("jobs_completed", jobs.jobs_completed as f64, HashMap::new());
        registry.record_counter("jobs_failed", jobs.jobs_failed as f64, HashMap::new());
        registry.record_gauge(
            "jobs_average_processing_time_seconds",
            jobs.average_processing_time_seconds,
            HashMap::new(),
        );
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

    // Helper methods use host-provided procfs values where available. Unsupported platforms
    // return zero/None rather than presenting made-up capacity numbers.
    fn get_memory_usage() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "linux")]
        {
            let pages = std::fs::read_to_string("/proc/self/statm")?
                .split_whitespace()
                .nth(1)
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            return Ok(pages.saturating_mul(4096) / (1024 * 1024));
        }
        #[cfg(not(target_os = "linux"))]
        Ok(0)
    }

    fn get_total_memory_mb() -> u64 {
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
                .unwrap_or(0);
        }
        #[cfg(not(target_os = "linux"))]
        0
    }

    fn get_disk_usage() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        Ok(0)
    }

    fn get_system_uptime() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "linux")]
        {
            return Ok(std::fs::read_to_string("/proc/uptime")?
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .unwrap_or(0.0) as u64);
        }
        #[cfg(not(target_os = "linux"))]
        Ok(0)
    }

    fn get_load_average() -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "linux")]
        {
            return Ok(std::fs::read_to_string("/proc/loadavg")?
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<f64>().ok()));
        }
        #[cfg(not(target_os = "linux"))]
        Ok(None)
    }
}

impl Default for CacheMetrics {
    fn default() -> Self {
        Self {
            hit_rate_percent: 0.0,
            miss_rate_percent: 0.0,
            total_operations: 0,
            memory_usage_mb: 0,
            evicted_keys: 0,
            expired_keys: 0,
            connected_clients: 0,
        }
    }
}

impl Default for JobMetrics {
    fn default() -> Self {
        Self {
            jobs_enqueued: 0,
            jobs_dequeued: 0,
            jobs_completed: 0,
            jobs_failed: 0,
            average_processing_time_seconds: 0.0,
            pending_jobs: 0,
            processing_jobs: 0,
            dead_letter_jobs: 0,
        }
    }
}
