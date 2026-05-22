//! Technical metrics and system performance KPIs

use crate::metrics::MetricRegistry;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Instant;

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
    pub async fn collect(pool: &PgPool, cache: Option<&crate::cache::CacheService>, registry: &mut MetricRegistry) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let start_time = Instant::now();

        // Collect system metrics
        let system_metrics = Self::collect_system_metrics().await?;

        // Collect database metrics
        let database_metrics = Self::collect_database_metrics(pool).await?;

        // Collect API metrics (from registry or external source)
        let api_metrics = Self::collect_api_metrics(registry).await?;

        // Collect cache metrics if available
        let cache_metrics = if let Some(cache_service) = cache {
            Self::collect_cache_metrics(cache_service).await?
        } else {
            CacheMetrics::default()
        };

        // Collect job metrics (if job queue is available)
        let job_metrics = Self::collect_job_metrics().await?;

        // Record metrics to registry
        Self::record_metrics_to_registry(&system_metrics, &database_metrics, &api_metrics, &cache_metrics, &job_metrics, registry);

        let collection_time = start_time.elapsed();
        registry.record_timer("technical_metrics_collection_duration", collection_time, HashMap::new());

        Ok(TechnicalMetrics {
            system_metrics,
            database_metrics,
            api_metrics,
            cache_metrics,
            job_metrics,
        })
    }

    async fn collect_system_metrics() -> Result<SystemMetrics, Box<dyn std::error::Error + Send + Sync>> {
        // CPU usage (simplified - would use sysinfo crate in production)
        let cpu_usage_percent = 45.0; // Placeholder

        // Memory usage
        let memory_usage_mb = Self::get_memory_usage()?;
        let total_memory_mb = 8192; // 8GB placeholder
        let memory_usage_percent = (memory_usage_mb as f64 / total_memory_mb as f64) * 100.0;

        // Disk usage
        let disk_usage_mb = Self::get_disk_usage()?;
        let total_disk_mb = 102400; // 100GB placeholder
        let disk_usage_percent = (disk_usage_mb as f64 / total_disk_mb as f64) * 100.0;

        // Network stats (placeholder)
        let network_bytes_sent = 1024 * 1024 * 100; // 100MB
        let network_bytes_received = 1024 * 1024 * 500; // 500MB

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
            SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (query_end - query_start)) * 1000), 0)
            FROM pg_stat_statements
            WHERE calls > 0
            "#
        )
        .fetch_optional(pool)
        .await?;

        // Slow queries (queries taking longer than 1 second)
        let slow_queries_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM pg_stat_statements
            WHERE mean_exec_time > 1000
            "#
        )
        .fetch_one(pool)
        .await?;

        // Database size
        let database_size_mb: Option<i64> = sqlx::query_scalar(
            "SELECT pg_database_size(current_database()) / 1024 / 1024"
        )
        .fetch_optional(pool)
        .await?;

        // WAL size
        let wal_size_mb: Option<i64> = sqlx::query_scalar(
            "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') / 1024 / 1024"
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
            "#
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

    async fn collect_api_metrics(_registry: &MetricRegistry) -> Result<ApiMetrics, Box<dyn std::error::Error + Send + Sync>> {
        // These would typically be collected from middleware
        // For now, we'll use placeholder values and try to extract from registry

        let requests_per_second = 10.5; // Placeholder
        let average_response_time_ms = 150.0; // Placeholder
        let p95_response_time_ms = 450.0; // Placeholder
        let p99_response_time_ms = 1200.0; // Placeholder
        let error_rate_percent = 2.1; // Placeholder

        let mut status_codes = HashMap::new();
        status_codes.insert("200".to_string(), 1000);
        status_codes.insert("404".to_string(), 15);
        status_codes.insert("500".to_string(), 5);

        let mut endpoints_by_latency = HashMap::new();
        endpoints_by_latency.insert("/api/transactions".to_string(), 120.0);
        endpoints_by_latency.insert("/api/products".to_string(), 85.0);
        endpoints_by_latency.insert("/api/customers".to_string(), 95.0);

        let active_connections = 25; // Placeholder

        Ok(ApiMetrics {
            requests_per_second,
            average_response_time_ms,
            p95_response_time_ms,
            p99_response_time_ms,
            error_rate_percent,
            status_codes,
            endpoints_by_latency,
            active_connections,
        })
    }

    async fn collect_cache_metrics(_cache: &crate::cache::CacheService) -> Result<CacheMetrics, Box<dyn std::error::Error + Send + Sync>> {
        // These would be collected from Redis INFO command
        // For now, we'll use placeholder values

        let hit_rate_percent = 85.5;
        let miss_rate_percent = 14.5;
        let total_operations = 100000;
        let memory_usage_mb = 256;
        let evicted_keys = 1500;
        let expired_keys = 800;
        let connected_clients = 12;

        Ok(CacheMetrics {
            hit_rate_percent,
            miss_rate_percent,
            total_operations,
            memory_usage_mb,
            evicted_keys,
            expired_keys,
            connected_clients,
        })
    }

    async fn collect_job_metrics() -> Result<JobMetrics, Box<dyn std::error::Error + Send + Sync>> {
        // These would be collected from the job queue
        // For now, we'll use placeholder values

        let jobs_enqueued = 5000;
        let jobs_dequeued = 4800;
        let jobs_completed = 4750;
        let jobs_failed = 50;
        let average_processing_time_seconds = 12.5;
        let pending_jobs = 200;
        let processing_jobs = 15;
        let dead_letter_jobs = 35;

        Ok(JobMetrics {
            jobs_enqueued,
            jobs_dequeued,
            jobs_completed,
            jobs_failed,
            average_processing_time_seconds,
            pending_jobs,
            processing_jobs,
            dead_letter_jobs,
        })
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
        registry.record_gauge("system_cpu_usage_percent", system.cpu_usage_percent, HashMap::new());
        registry.record_gauge("system_memory_usage_mb", system.memory_usage_mb as f64, HashMap::new());
        registry.record_gauge("system_memory_usage_percent", system.memory_usage_percent, HashMap::new());
        registry.record_gauge("system_disk_usage_mb", system.disk_usage_mb as f64, HashMap::new());
        registry.record_gauge("system_disk_usage_percent", system.disk_usage_percent, HashMap::new());
        registry.record_counter("system_network_bytes_sent", system.network_bytes_sent as f64, HashMap::new());
        registry.record_counter("system_network_bytes_received", system.network_bytes_received as f64, HashMap::new());
        registry.record_gauge("system_uptime_seconds", system.uptime_seconds as f64, HashMap::new());

        if let Some(load_avg) = system.load_average {
            registry.record_gauge("system_load_average", load_avg, HashMap::new());
        }

        // Database metrics
        registry.record_gauge("database_active_connections", database.active_connections as f64, HashMap::new());
        registry.record_gauge("database_idle_connections", database.idle_connections as f64, HashMap::new());
        registry.record_gauge("database_total_connections", database.total_connections as f64, HashMap::new());
        registry.record_gauge("database_connection_utilization_percent", database.connection_utilization_percent, HashMap::new());
        registry.record_gauge("database_query_duration_avg_ms", database.query_duration_avg_ms, HashMap::new());
        registry.record_counter("database_slow_queries_count", database.slow_queries_count as f64, HashMap::new());
        registry.record_gauge("database_size_mb", database.database_size_mb as f64, HashMap::new());
        registry.record_gauge("database_wal_size_mb", database.wal_size_mb as f64, HashMap::new());
        registry.record_gauge("database_cache_hit_ratio", database.cache_hit_ratio, HashMap::new());

        // API metrics
        registry.record_gauge("api_requests_per_second", api.requests_per_second, HashMap::new());
        registry.record_gauge("api_average_response_time_ms", api.average_response_time_ms, HashMap::new());
        registry.record_gauge("api_p95_response_time_ms", api.p95_response_time_ms, HashMap::new());
        registry.record_gauge("api_p99_response_time_ms", api.p99_response_time_ms, HashMap::new());
        registry.record_gauge("api_error_rate_percent", api.error_rate_percent, HashMap::new());
        registry.record_gauge("api_active_connections", api.active_connections as f64, HashMap::new());

        // Cache metrics
        registry.record_gauge("cache_hit_rate_percent", cache.hit_rate_percent, HashMap::new());
        registry.record_gauge("cache_miss_rate_percent", cache.miss_rate_percent, HashMap::new());
        registry.record_counter("cache_total_operations", cache.total_operations as f64, HashMap::new());
        registry.record_gauge("cache_memory_usage_mb", cache.memory_usage_mb as f64, HashMap::new());
        registry.record_counter("cache_evicted_keys", cache.evicted_keys as f64, HashMap::new());
        registry.record_counter("cache_expired_keys", cache.expired_keys as f64, HashMap::new());
        registry.record_gauge("cache_connected_clients", cache.connected_clients as f64, HashMap::new());

        // Job metrics
        registry.record_counter("jobs_enqueued", jobs.jobs_enqueued as f64, HashMap::new());
        registry.record_counter("jobs_dequeued", jobs.jobs_dequeued as f64, HashMap::new());
        registry.record_counter("jobs_completed", jobs.jobs_completed as f64, HashMap::new());
        registry.record_counter("jobs_failed", jobs.jobs_failed as f64, HashMap::new());
        registry.record_gauge("jobs_average_processing_time_seconds", jobs.average_processing_time_seconds, HashMap::new());
        registry.record_gauge("jobs_pending", jobs.pending_jobs as f64, HashMap::new());
        registry.record_gauge("jobs_processing", jobs.processing_jobs as f64, HashMap::new());
        registry.record_gauge("jobs_dead_letter", jobs.dead_letter_jobs as f64, HashMap::new());
    }

    // Helper methods for system metrics (would use proper system libraries in production)
    fn get_memory_usage() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        // Placeholder - would use sysinfo or similar
        Ok(2048) // 2GB
    }

    fn get_disk_usage() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        // Placeholder - would use sysinfo or similar
        Ok(51200) // 50GB
    }

    fn get_system_uptime() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        // Placeholder - would read from /proc/uptime or similar
        Ok(86400 * 7) // 7 days
    }

    fn get_load_average() -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>> {
        // Placeholder - would read from /proc/loadavg or similar
        Ok(Some(1.5))
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
