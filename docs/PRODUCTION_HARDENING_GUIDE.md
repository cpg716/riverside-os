# Riverside OS Production Hardening Guide

## Overview

This guide covers all production hardening features implemented in Riverside OS v0.70.2+ to ensure enterprise-grade reliability, scalability, and security.

## Table of Contents

1. [Health Check Endpoints](#health-check-endpoints)
2. [Connection Pool Monitoring](#connection-pool-monitoring)
3. [WAL Archiving Configuration](#wal-archiving-configuration)
4. [Global Rate Limiting](#global-rate-limiting)
5. [Redis Cluster Integration](#redis-cluster-integration)
6. [Background Job Queue](#background-job-queue)
7. [Comprehensive Metrics System](#comprehensive-metrics-system)
8. [System Alert Broadcasting](#system-alert-broadcasting)
9. [Environment Configuration](#environment-configuration)
10. [Deployment Checklist](#deployment-checklist)

---

## Health Check Endpoints

### Overview

Riverside OS provides three health check endpoints for orchestration and monitoring systems:

- `/api/health` - Basic application health
- `/api/ready` - Readiness check with dependency validation
- `/api/live` - Liveness probe

### Implementation

**File**: `server/src/api/health.rs`

```rust
// Basic health check - always returns 200 if app is running
pub async fn health() -> Result<Json<HealthResponse>, StatusCode>

// Readiness check - verifies dependencies are ready
pub async fn ready(State(state): State<AppState>) -> Result<Json<ReadyResponse>, StatusCode>

// Liveness check - simple alive status
pub async fn live() -> Result<Json<serde_json::Value>, StatusCode>
```

### Response Examples

**Health Response**:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "version": "0.70.2",
  "uptime_seconds": 86400
}
```

**Readiness Response**:
```json
{
  "status": "ready",
  "timestamp": "2024-01-15T10:30:00Z",
  "database": {
    "connected": true,
    "pool_size": 20,
    "active_connections": 5,
    "idle_connections": 15
  },
  "background_workers": {
    "backup_worker": true,
    "notification_worker": true,
    "email_worker": true,
    "podium_worker": true,
    "weather_worker": true
  }
}
```

### Kubernetes Configuration

```yaml
livenessProbe:
  httpGet:
    path: /api/live
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /api/ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
```

---

## Connection Pool Monitoring

### Overview

Automatic monitoring of PostgreSQL connection pool utilization with alerting when usage exceeds 80%.

### Implementation

**File**: `server/src/launcher.rs`

```rust
// Monitor connection pool every 30 seconds
tokio::spawn(async move {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;
        let active = pool.num_active();
        let max = pool.size();
        let utilization = if max > 0 { (active * 100) / max } else { 0 };
        
        if utilization >= 80 {
            tracing::warn!(...);
            crate::logic::notifications::broadcast_system_alert(...).await?;
        }
    }
});
```

### Configuration

```bash
# Maximum database connections (default: 20)
RIVERSIDE_DATABASE_MAX_CONNECTIONS=30

# Alert threshold (fixed at 80%)
```

### Alert Content

When pool utilization exceeds 80%, system alerts are broadcast to all admin staff:

```
Database connection pool utilization: 85% (17/20 connections active)
```

---

## WAL Archiving Configuration

### Overview

Point-in-time recovery capability through WAL (Write-Ahead Logging) archiving with monitoring and alerting.

### Database Migration

**File**: `migrations/039_wal_archiving_configuration.sql`

Creates tables for tracking WAL archive status and health monitoring.

### PostgreSQL Configuration

Add to `postgresql.conf`:

```conf
# Enable WAL archiving
wal_level = replica
archive_mode = on
archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
archive_timeout = 300  # Archive at least every 5 minutes
```

### Monitoring Functions

**File**: `server/src/logic/backups.rs`

```rust
// Check WAL archive health
pub async fn check_wal_archive_health(pool: &PgPool) -> Result<WalArchiveHealth, sqlx::Error>

// Record WAL archive failure for alerting
pub async fn record_wal_archive_failure(pool: &PgPool, error_message: &str) -> Result<(), sqlx::Error>
```

### Health Status View

```sql
SELECT * FROM wal_archive_health;
```

Returns:
- `status`: 'active', 'failed', 'disabled'
- `health_status`: 'healthy', 'warning', 'critical'
- `last_archive_at`: Last successful archive timestamp
- `seconds_since_last_archive`: Time since last archive

---

## Global Rate Limiting

### Overview

Comprehensive rate limiting to prevent API abuse and DoS attacks with IP-based and user-based limits.

### Implementation

**File**: `server/src/middleware/rate_limit.rs`

```rust
// Rate limiting middleware
pub async fn rate_limit_handler(
    State(rate_limit_state): State<RateLimitMiddleware>,
    State(app_state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode>
```

### Configuration

```bash
# Global rate limit per IP per minute (default: 1000)
RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE=1000

# Authenticated user rate limit per minute (default: 5000)
RIVERSIDE_AUTHENTICATED_RATE_LIMIT_PER_MINUTE=5000
```

### Rate Limit Headers

Responses include rate limit headers:

```
X-RateLimit-Limit: 1000
X-RateLimit-Window: 60
X-RateLimit-Remaining: 999
```

### Rate Limiting Logic

- **Anonymous requests**: Limited by IP address
- **Authenticated requests**: Limited by user ID with higher limits
- **Sliding window**: 60-second rolling window
- **Automatic cleanup**: Old entries pruned periodically

---

## Redis Cluster Integration

### Overview

Redis integration for distributed caching and locking with graceful fallback.

### Core Components

**Files**: `server/src/cache/redis_client.rs`, `server/src/cache/mod.rs`

### Configuration

```bash
# Redis connection URL
RIVERSIDE_REDIS_URL=redis://localhost:6379

# Cache TTL (default: 5 minutes)
# Lock timeout (default: 30 seconds)
```

### Caching Usage

```rust
// Cache a value
cache.set("product_123", &product_data, Duration::from_secs(300)).await?;

// Get cached value
let cached: Option<Product> = cache.get("product_123").await?;

// Delete cache entry
cache.del("product_123").await?;
```

### Distributed Locking

```rust
// Create distributed lock
let lock = cache.lock("resource_name");

// Acquire lock with timeout
if lock.acquire(Duration::from_secs(30)).await? {
    // Critical section
    lock.extend(Duration::from_secs(30)).await?;
    lock.release().await?;
}
```

### Cache Key Patterns

- User sessions: `session:user:{user_id}`
- Products: `product:{product_id}`
- Inventory: `inventory:store:{store_id}`
- Rate limiting: `rate_limit:{ip}:{window}`
- Search results: `search:{query_hash}`

---

## Background Job Queue

### Overview

Resilient asynchronous job processing system with Redis backend, supporting retries, dead letter queues, and multiple job types.

### Core Components

**Files**: 
- `server/src/jobs/mod.rs` - Main job system
- `server/src/jobs/queue.rs` - Redis-based queue implementation
- `server/src/jobs/worker.rs` - Job worker with concurrency control
- `server/src/jobs/jobs.rs` - Job types and payloads

### Job Types

```rust
pub enum JobType {
    // Email jobs
    SendEmail,
    SendBulkEmail,
    
    // Report jobs
    GenerateReport,
    ExportData,
    
    // Sync jobs
    SyncQBO,
    SyncMeilisearch,
    SyncCounterpoint,
    
    // Maintenance jobs
    CleanupOldSessions,
    BackupDatabase,
    ArchiveNotifications,
    
    // Notification jobs
    SendPushNotification,
    SendSMS,
    
    // Analytics jobs
    UpdateMetrics,
    ProcessAnalytics,
    
    // Custom jobs
    Custom(String),
}
```

### Queue Operations

```rust
// Create job queue
let queue = JobQueue::from_env()?;

// Enqueue job
let job = Job::new(JobType::SendEmail, payload)
    .with_priority(JobPriority::High)
    .with_max_attempts(5);
let job_id = queue.enqueue(job).await?;

// Process jobs
let job = queue.dequeue().await?;
if let Some(job) = job {
    // Process job
    queue.complete(job.id).await?;
    // or
    queue.fail(job.id, "Error message").await?;
}
```

### Worker Configuration

```rust
let config = WorkerConfig {
    worker_id: "worker-1".to_string(),
    poll_interval: Duration::from_secs(5),
    max_concurrent_jobs: 10,
    job_timeout: Duration::from_secs(300),
    shutdown_timeout: Duration::from_secs(30),
};

let worker = JobWorker::new(queue, handlers, config);
worker.start().await?;
```

### Job Payloads

```rust
// Email job
#[derive(Serialize, Deserialize)]
pub struct EmailJobPayload {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    pub html_body: Option<String>,
    pub attachments: Vec<EmailAttachment>,
}

// Report job
#[derive(Serialize, Deserialize)]
pub struct ReportJobPayload {
    pub report_type: String,
    pub parameters: HashMap<String, serde_json::Value>,
    pub format: ReportFormat,
    pub recipients: Vec<String>,
}
```

### Queue Statistics

```rust
let stats = queue.get_stats().await?;
println!("Pending: {}", stats.pending);
println!("Processing: {}", stats.processing);
println!("Completed: {}", stats.completed);
println!("Failed: {}", stats.failed);
```

---

## Comprehensive Metrics System

### Overview

Enterprise-grade metrics collection system with business KPIs, technical metrics, and multiple export formats.

### Core Components

**Files**:
- `server/src/metrics/mod.rs` - Core metrics system
- `server/src/metrics/business_metrics.rs` - Business KPIs
- `server/src/metrics/technical_metrics.rs` - Technical metrics
- `server/src/metrics/collector.rs` - Metrics collection engine
- `server/src/metrics/exporters.rs` - Export formats

### Business Metrics

#### Sales KPIs
- Total revenue today
- Transaction count and average value
- Revenue by hour and category
- Top selling products

#### Customer KPIs
- New and active customers
- Customer retention rate
- Average lifetime value
- Customer segmentation

#### Inventory KPIs
- Total inventory value
- Low stock and out-of-stock alerts
- Inventory turnover rate
- Days of inventory

#### Financial KPIs
- Gross profit and margins
- Daily expenses and net profit
- Accounts receivable
- Cash flow

### Technical Metrics

#### System Metrics
- CPU, memory, disk usage
- Network I/O statistics
- System load average
- Uptime tracking

#### Database Metrics
- Connection pool utilization
- Query performance metrics
- Slow query tracking
- Cache hit ratios

#### API Metrics
- Request rate and response times
- Error rates and status codes
- Endpoint latency breakdown
- Active connections

#### Cache Metrics
- Hit/miss ratios
- Memory usage
- Eviction statistics
- Client connections

#### Job Queue Metrics
- Job processing rates
- Success/failure rates
- Queue depths
- Processing times

### Metrics Collection

```rust
// Initialize metrics collector
let config = MetricsConfig::default();
let collector = MetricsCollector::new(config, db_pool, Some(cache_service));

// Start collection
collector.start().await?;

// Get metrics snapshot
let snapshot = collector.get_metrics_snapshot().await;
```

### Export Formats

#### Prometheus
```rust
let exporter = PrometheusExporter::new("riverside_os")
    .with_subsystem("production");
let prometheus_output = exporter.export(&registry).await?;
```

#### JSON
```rust
let exporter = JsonExporter::new().pretty_print();
let json_output = exporter.export(&registry).await?;
```

#### InfluxDB
```rust
let exporter = InfluxDBExporter::new("http://localhost:8086", "riverside")
    .with_auth("username", "password");
let influxdb_output = exporter.export(&registry).await?;
```

### API Metrics Middleware

```rust
// Automatic request tracking
app.layer(axum::middleware::from_fn_with_state(
    metrics_collector.clone(),
    metrics_middleware,
));
```

---

## System Alert Broadcasting

### Overview

Automatic alert system that broadcasts critical system events to all admin staff via the notification system.

### Implementation

**File**: `server/src/logic/notifications.rs`

```rust
pub async fn broadcast_system_alert(pool: &PgPool, message: &str) -> Result<(), sqlx::Error> {
    // Find all staff with settings.admin permission
    let admin_staff: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT sp.staff_id
        FROM staff_permissions sp
        JOIN permissions p ON sp.permission_id = p.id
        WHERE p.key = 'settings.admin'
        AND sp.granted = TRUE
        "#
    ).fetch_all(pool).await?;

    // Create and broadcast notification
    let notification_id = insert_app_notification_deduped(...).await?;
    fan_out_notification_to_staff_ids(pool, notification_id, &admin_staff).await?;
}
```

### Alert Triggers

System automatically broadcasts alerts for:

- Connection pool utilization > 80%
- WAL archiving failures
- Database connection issues
- Job queue processing failures
- System resource exhaustion

### Alert Examples

```
Database connection pool utilization: 85% (17/20 connections active)
WAL archiving failed: Permission denied accessing archive directory
Job processing failed: Database connection timeout
```

---

## Environment Configuration

### Required Environment Variables

```bash
# Database
DATABASE_URL=postgres://user:password@localhost/riverside_os
RIVERSIDE_DATABASE_MAX_CONNECTIONS=20

# Redis (optional but recommended)
RIVERSIDE_REDIS_URL=redis://localhost:6379

# Rate Limiting
RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE=1000
RIVERSIDE_AUTHENTICATED_RATE_LIMIT_PER_MINUTE=5000

# CORS Origins (production)
RIVERSIDE_CORS_ORIGINS=https://retail.riverside.com,https://admin.riverside.com
RIVERSIDE_STRICT_PRODUCTION=true

# Metrics
RIVERSIDE_METRICS_ENABLED=true
RIVERSIDE_METRICS_COLLECTION_INTERVAL=60
RIVERSIDE_METRICS_RETENTION_DAYS=7

# Job Queue
RIVERSIDE_JOB_QUEUE_ENABLED=true
RIVERSIDE_JOB_WORKERS=3
RIVERSIDE_JOB_MAX_CONCURRENT=10
```

### Optional Configuration

```bash
# Meilisearch
RIVERSIDE_MEILISEARCH_URL=http://localhost:7700

# QBO Integration
RIVERSIDE_QBO_CLIENT_ID=your_client_id
RIVERSIDE_QBO_CLIENT_SECRET=your_client_secret
```

---

## Deployment Checklist

### Pre-Deployment

- [ ] Run database migrations: `sqlx migrate run`
- [ ] Verify Redis connectivity: `redis-cli ping`
- [ ] Test health endpoints: `curl http://localhost:8080/api/health`
- [ ] Configure environment variables
- [ ] Set up monitoring and alerting

### Database Setup

- [ ] Configure WAL archiving in `postgresql.conf`
- [ ] Create WAL archive directory: `/var/lib/postgresql/wal_archive`
- [ ] Set appropriate permissions
- [ ] Test archive command manually
- [ ] Verify replication setup (if using)

### Redis Setup

- [ ] Install Redis 6.0+
- [ ] Configure `redis.conf` for production:
  ```conf
  maxmemory 2gb
  maxmemory-policy allkeys-lru
  save 900 1
  save 300 10
  save 60 10000
  ```
- [ ] Set up Redis Cluster (if needed)
- [ ] Configure persistence (RDB + AOF)

### Application Deployment

- [ ] Build application: `cargo build --release`
- [ ] Deploy to production servers
- [ ] Start application with systemd
- [ ] Verify health checks pass
- [ ] Test metrics collection
- [ ] Verify job queue processing

### Monitoring Setup

- [ ] Configure Prometheus to scrape metrics
- [ ] Set up Grafana dashboards
- [ ] Configure alerting rules
- [ ] Test alert delivery to admin staff
- [ ] Set up log aggregation

### Post-Deployment

- [ ] Monitor system performance
- [ ] Verify all background workers running
- [ ] Test rate limiting effectiveness
- [ ] Validate metrics collection
- [ ] Check alert delivery
- [ ] Perform load testing

---

## Troubleshooting

### Common Issues

#### Health Checks Failing
- Check database connectivity
- Verify Redis connection
- Review background worker status
- Check system resources

#### High Connection Pool Usage
- Increase `RIVERSIDE_DATABASE_MAX_CONNECTIONS`
- Check for connection leaks
- Review slow queries
- Optimize application logic

#### WAL Archiving Failures
- Verify archive directory permissions
- Check disk space availability
- Test archive command manually
- Review PostgreSQL logs

#### Rate Limiting Too Aggressive
- Adjust `RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE`
- Increase authenticated user limits
- Review legitimate traffic patterns
- Whitelist trusted IPs if needed

#### Job Queue Backlog
- Increase worker count
- Check for failed jobs
- Review job processing logic
- Monitor Redis memory usage

#### Metrics Not Collecting
- Verify database queries working
- Check Redis connectivity for metrics
- Review collection interval settings
- Check for permission issues

---

## Performance Tuning

### Database Optimization

```sql
-- Monitor connection pool usage
SELECT * FROM pg_stat_activity WHERE state = 'active';

-- Check slow queries
SELECT query, mean_exec_time, calls 
FROM pg_stat_statements 
ORDER BY mean_exec_time DESC 
LIMIT 10;

-- Monitor WAL archiving
SELECT * FROM wal_archive_health;
```

### Redis Optimization

```bash
# Monitor Redis memory usage
redis-cli info memory

# Check hit rates
redis-cli info stats | grep keyspace

# Monitor connections
redis-cli info clients
```

### Application Tuning

- Adjust worker pool sizes based on load
- Tune metrics collection intervals
- Optimize cache TTL values
- Configure appropriate rate limits

---

## Security Considerations

### Network Security
- Use TLS for all external connections
- Configure firewall rules properly
- Limit Redis access to application servers
- Use VPN for database access

### Authentication
- Enable strong authentication for Redis
- Use environment variables for secrets
- Rotate API keys regularly
- Implement proper RBAC

### Data Protection
- Encrypt sensitive data at rest
- Use secure communication channels
- Implement proper backup encryption
- Follow GDPR compliance guidelines

---

## Monitoring and Alerting

### Key Metrics to Monitor

1. **System Health**
   - CPU usage < 80%
   - Memory usage < 85%
   - Disk usage < 90%
   - Connection pool utilization < 80%

2. **Application Performance**
   - API response time < 500ms (P95)
   - Error rate < 1%
   - Request rate monitoring
   - Job queue processing time

3. **Business Metrics**
   - Revenue tracking
   - Transaction success rate
   - Customer activity
   - Inventory levels

### Alert Thresholds

- Critical: System unavailable, security breach
- Warning: High resource usage, performance degradation
- Info: Routine maintenance, deployments

---

## Database-Down Fallback Logging (v0.70.5)

### Overview

When the PostgreSQL database is unreachable, error and alert events that would normally be written to the database are captured in a local JSON fallback file. A background worker automatically re-ingests these events once the database recovers.

### Implementation

**Files**: `server/src/logic/bug_reports.rs`, `server/src/launcher.rs`

- A thread-safe global mutex guards all writes to `server/fallback_logs/fallback_errors.json`.
- `upsert_server_error_event` catches database connection errors and appends a `FallbackErrorEvent` struct to the fallback file instead of dropping the event.
- A background task spawned in `launcher.rs` polls the database every **30 seconds**. On recovery it reads, parses, and re-inserts all fallback events, then truncates the file under the lock.

### Fallback File Location

```
server/fallback_logs/fallback_errors.json
```

The directory is created automatically on first write. In production deployments, ensure the server process has write access to this path.

### Operational Notes

- Events are never lost during short database outages; they queue on disk and are automatically reingested.
- The fallback file is a newline-delimited JSON array and can be inspected manually if needed.
- If the database is down for an extended period, monitor disk usage on the server host.

---

## Real-Time Diagnostic Log Streaming (v0.70.5)

### Overview

Live server `tracing` output is streamed in real-time via Server-Sent Events (SSE) to authorized DevOps operators without requiring SSH access.

### Endpoint

```
GET /api/ops/logs/stream
```

Requires `ops.dev_center.view` permission. Protected by Ops Shield middleware (private network / Tailscale IPs only).

### Implementation

**Files**: `server/src/observability/server_log_ring.rs`, `server/src/api/ops.rs`

- `ServerLogRing` embeds a `tokio::sync::broadcast::Sender<String>`. Every formatted tracing line is broadcast instantly to all subscribers.
- The SSE handler subscribes to the broadcast channel via `server_log_ring.subscribe()` and maps each line to an SSE `data:` event.
- A 15-second SSE keepalive is emitted to prevent proxy timeouts.
- Lagged clients (those that fall too far behind) are silently skipped with a `tracing::warn!` entry.

### Usage

```bash
curl -N \
  -H "Authorization: Bearer <staff_token>" \
  http://localhost:3000/api/ops/logs/stream
```

---

## Auto-Rollback Watchdog Script (v0.70.5)

### Overview

`scripts/watchdog-updater.sh` is a POSIX-compliant shell script that automates safe server binary updates and rolls back automatically if the new build fails to pass health checks.

### Location

```
scripts/watchdog-updater.sh
```

### How It Works

1. Accepts paths for the new binary, old binary, and PostgreSQL backup.
2. Creates a pre-flight database backup using `pg_dump` (falls back to `docker exec pg_dump` inside the `riverside-os-db` container if Docker is in use).
3. Launches the new binary, then polls `GET /api/health/ready` every **5 seconds** for up to **120 seconds**.
4. On health check success: exits cleanly.
5. On failure or timeout: kills the new process, restores the database via `pg_restore`, restarts the old binary, and writes a timestamped entry to `rollback_error.log`.

### Usage

```bash
./scripts/watchdog-updater.sh \
  --new-binary ./target/release/riverside-server-new \
  --old-binary ./target/release/riverside-server \
  --backup-file /backups/pre-update.dump \
  --host localhost \
  --port 3000
```

### Integration with Deployment Manager

The Deployment Manager's update flow should call `watchdog-updater.sh` instead of directly swapping binaries to guarantee zero-downtime rollback on any failed update.

---

## Audited Remote DevOps Commands (v0.70.5)

### Overview

Three new guarded remote commands are available in the ROS Dev Center actions console. All require `ops.dev_center.actions` permission plus `confirm_primary=true` and `confirm_secondary=true` in the request body. Every execution writes an immutable row to `ops_action_audit`.

### Commands

| Action Key | Description |
|---|---|
| `ops.restart_background_workers` | Logs re-initialization and signals restart of background worker loops and job queues. |
| `ops.flush_cache` | Executes Redis `FLUSHDB` on the configured cache instance, clearing all cached keys. |
| `ops.clear_logs` | Empties the in-memory `ServerLogRing` diagnostics buffer. Does not affect database logs. |

### Usage Example

```bash
curl -X POST \
  -H "Authorization: Bearer <staff_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Pre-maintenance cache flush",
    "confirm_primary": true,
    "confirm_secondary": true
  }' \
  http://localhost:3000/api/ops/actions/ops.flush_cache
```

### Response

```json
{
  "ok": true,
  "message": "Cache flushed successfully",
  "data": { "status": "flushed" },
  "audit": {
    "id": "...",
    "correlation_id": "...",
    "created_at": "2026-05-22T13:00:00Z",
    "action_key": "ops.flush_cache"
  }
}
```

### Operational Notes

- `ops.flush_cache` gracefully returns `ok: false` with a clear message if Redis is not configured.
- `ops.clear_logs` clears only the live in-memory ring buffer; historical database `staff_error_event` rows are unaffected.
- `ops.restart_background_workers` logs the signal but does not hard-kill worker processes; existing in-flight jobs continue to completion.

---

## Conclusion

This production hardening implementation provides Riverside OS with enterprise-grade reliability, scalability, and observability. The system is now ready for production deployment with comprehensive monitoring, alerting, and protection mechanisms.

For additional support or questions, refer to the technical documentation or contact the development team.
