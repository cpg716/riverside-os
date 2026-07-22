# Background Job Queue Guide

## Overview

Riverside OS includes a resilient background job processing system built on Redis, supporting distributed processing, automatic retries, dead letter queues, and comprehensive monitoring.

## Table of Contents

1. [Architecture](#architecture)
2. [Job Types](#job-types)
3. [Queue Operations](#queue-operations)
4. [Worker Configuration](#worker-configuration)
5. [Job Handlers](#job-handlers)
6. [Error Handling and Retries](#error-handling-and-retries)
7. [Monitoring and Metrics](#monitoring-and-metrics)
8. [Production Deployment](#production-deployment)

---

## Architecture

### Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Application   │───▶│   Job Queue     │───▶│     Workers     │
│                 │    │   (Redis)       │    │                 │
│ Job Enqueue     │    │                 │    │ Job Process     │
│ Job Status      │    │ ┌─────────────┐ │    │ Retry Logic     │
│                 │    │ │   Queue     │ │    │ Dead Letter     │
└─────────────────┘    │ │ Processing   │ │    │                 │
                       │ │ Dead Letter │ │    └─────────────────┘
                       │ └─────────────┘ │
                       └─────────────────┘
```

### Key Features

- **Redis-based Queue**: Distributed, persistent, scalable
- **Visibility Timeout**: Prevents duplicate processing
- **Dead Letter Queue**: Failed jobs isolated for analysis
- **Automatic Retries**: Configurable retry logic with exponential backoff
- **Job Priorities**: Critical, High, Normal, Low priority levels
- **Worker Pool**: Configurable concurrent job processing
- **Graceful Shutdown**: Safe worker termination

An idle worker's blocking Redis dequeue returns at least every 20 seconds. Each successful poll
refreshes the readiness heartbeat; failed or disconnected polls do not. This keeps healthy idle
workers ready while allowing `/api/ready` to detect a stalled queue worker within 60 seconds.
Workers reserve a handler slot before moving a job into Redis's processing list, so saturation
cannot age an unstarted job into stale recovery or create duplicate execution.

---

## Job Types

### Built-in Job Types

```rust
pub enum JobType {
    // Email communications
    SendEmail,
    SendBulkEmail,
    
    // Report generation
    GenerateReport,
    ExportData,
    
    // Data synchronization
    SyncQBO,
    SyncMeilisearch,
    SyncCounterpoint,
    
    // System maintenance
    CleanupOldSessions,
    BackupDatabase,
    ArchiveNotifications,
    
    // Notifications
    SendPushNotification,
    SendSMS,
    
    // Analytics processing
    UpdateMetrics,
    ProcessAnalytics,
    
    // Custom jobs
    Custom(String),
}
```

### Job Payloads

#### Email Job
```rust
#[derive(Serialize, Deserialize)]
pub struct EmailJobPayload {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    pub html_body: Option<String>,
    pub attachments: Vec<EmailAttachment>,
}

#[derive(Serialize, Deserialize)]
pub struct EmailAttachment {
    pub filename: String,
    pub content_type: String,
    pub data: Vec<u8>,
}
```

#### Report Job
```rust
#[derive(Serialize, Deserialize)]
pub struct ReportJobPayload {
    pub report_type: String,
    pub parameters: HashMap<String, serde_json::Value>,
    pub format: ReportFormat, // PDF, Excel, CSV, JSON
    pub recipients: Vec<String>,
}
```

#### Sync Job
```rust
#[derive(Serialize, Deserialize)]
pub struct SyncJobPayload {
    pub sync_type: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<Uuid>,
    pub force_full_sync: bool,
}
```

#### Notification Job
```rust
#[derive(Serialize, Deserialize)]
pub struct NotificationJobPayload {
    pub user_id: Option<Uuid>,
    pub staff_id: Option<Uuid>,
    pub title: String,
    pub message: String,
    pub channels: Vec<NotificationChannel>, // InApp, Email, SMS, Push
    pub data: Option<serde_json::Value>,
}
```

---

## Queue Operations

### Job Creation and Enqueue

```rust
use crate::jobs::{Job, JobType, JobPriority};

// Create basic job
let job = Job::new(JobType::SendEmail, email_payload);

// With priority and custom settings
let job = Job::new(JobType::GenerateReport, report_payload)
    .with_priority(JobPriority::High)
    .with_max_attempts(5)
    .with_metadata("department".to_string(), "finance".to_string());

// Enqueue job
let job_id = queue.enqueue(job).await?;
println!("Job enqueued: {}", job_id);
```

### Job Processing

```rust
// Dequeue job for processing
let job = queue.dequeue().await?;

if let Some(mut job) = job {
    println!("Processing job: {} ({})", job.id, job.job_type);
    
    match process_job(&job).await {
        Ok(()) => {
            // Mark as completed
            queue.complete(job.id).await?;
            println!("Job completed successfully");
        }
        Err(e) => {
            // Mark as failed (will retry if attempts < max_attempts)
            queue.fail(job.id, &e.to_string()).await?;
            println!("Job failed: {}", e);
        }
    }
}
```

### Job Status Monitoring

```rust
// Get queue statistics
let stats = queue.get_stats().await?;

println!("Queue Statistics:");
println!("  Pending: {}", stats.pending);
println!("  Processing: {}", stats.processing);
println!("  Completed: {}", stats.completed);
println!("  Failed: {}", stats.failed);
println!("  Dead Letter: {}", stats.dead_letter);
```

### Job Management

```rust
// Check specific job status
let job_key = format!("job:{}", job_id);
let job: Option<Job> = cache.get(&job_key).await?;

if let Some(job) = job {
    match job.status {
        JobStatus::Pending => println!("Job is waiting to be processed"),
        JobStatus::Processing => println!("Job is currently being processed"),
        JobStatus::Completed => println!("Job completed successfully"),
        JobStatus::Failed => println!("Job failed: {:?}", job.error_message),
        JobStatus::Cancelled => println!("Job was cancelled"),
    }
}
```

---

## Worker Configuration

### Basic Worker Setup

```rust
use crate::jobs::{JobQueue, JobWorker, WorkerConfig, create_registry, register_handler};

// Create job queue
let queue = JobQueue::from_env()?;

// Create handler registry
let mut handlers = create_registry();
register_handler(&mut handlers, std::sync::Arc::new(EmailHandler::new()));
register_handler(&mut handlers, std::sync::Arc::new(ReportHandler::new()));

// Configure worker
let config = WorkerConfig {
    worker_id: "worker-1".to_string(),
    poll_interval: Duration::from_secs(5),
    max_concurrent_jobs: 10,
    job_timeout: Duration::from_secs(300),
    shutdown_timeout: Duration::from_secs(30),
};

// Create and start worker
let worker = JobWorker::new(queue, handlers, config);
worker.start().await?;
```

### Worker Pool Configuration

```rust
// Multiple workers for scaling
let mut workers = Vec::new();

for i in 1..=3 {
    let config = WorkerConfig {
        worker_id: format!("worker-{}", i),
        poll_interval: Duration::from_secs(5),
        max_concurrent_jobs: 10,
        job_timeout: Duration::from_secs(300),
        shutdown_timeout: Duration::from_secs(30),
    };
    
    let queue = JobQueue::from_env()?;
    let worker = JobWorker::new(queue, handlers.clone(), config);
    workers.push(worker);
}

// Start all workers
for worker in &workers {
    worker.start().await?;
}
```

### Graceful Shutdown

```rust
// Stop worker gracefully
worker.stop().await?;

// Wait for all jobs to complete or timeout
tokio::time::sleep(Duration::from_secs(30)).await;

println!("Worker stopped gracefully");
```

---

## Job Handlers

### Creating Custom Handlers

```rust
use async_trait::async_trait;
use crate::jobs::{JobHandler, JobContext};

pub struct EmailHandler {
    smtp_client: SmtpClient,
}

impl EmailHandler {
    pub fn new() -> Self {
        Self {
            smtp_client: SmtpClient::new(),
        }
    }
}

#[async_trait]
impl JobHandler for EmailHandler {
    async fn handle(&self, ctx: JobContext) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Parse email payload
        let payload: EmailJobPayload = serde_json::from_value(ctx.payload)?;
        
        // Send email
        for recipient in payload.to {
            self.smtp_client.send_email(
                &recipient,
                &payload.subject,
                &payload.body,
                payload.html_body.as_deref(),
                &payload.attachments,
            ).await?;
        }
        
        tracing::info!(
            job_id = %ctx.job_id,
            recipients = payload.to.len(),
            "Email sent successfully"
        );
        
        Ok(())
    }
    
    fn job_type(&self) -> &'static str {
        "send_email"
    }
    
    fn max_attempts(&self) -> u32 {
        5 // Retry up to 5 times for email jobs
    }
}
```

### Report Generation Handler

```rust
pub struct ReportHandler {
    db_pool: PgPool,
}

#[async_trait]
impl JobHandler for ReportHandler {
    async fn handle(&self, ctx: JobContext) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload: ReportJobPayload = serde_json::from_value(ctx.payload)?;
        
        // Generate report based on type
        let report_data = match payload.report_type.as_str() {
            "sales_summary" => self.generate_sales_report(&payload.parameters).await?,
            "inventory_status" => self.generate_inventory_report(&payload.parameters).await?,
            "customer_analytics" => self.generate_customer_report(&payload.parameters).await?,
            _ => return Err(format!("Unknown report type: {}", payload.report_type).into()),
        };
        
        // Export in requested format
        let file_content = match payload.format {
            ReportFormat::PDF => self.export_to_pdf(&report_data).await?,
            ReportFormat::Excel => self.export_to_excel(&report_data).await?,
            ReportFormat::CSV => self.export_to_csv(&report_data).await?,
            ReportFormat::JSON => serde_json::to_vec(&report_data)?,
        };
        
        // Send report to recipients
        for recipient in payload.recipients {
            self.email_report(&recipient, &file_content, &payload.format).await?;
        }
        
        tracing::info!(
            job_id = %ctx.job_id,
            report_type = %payload.report_type,
            format = ?payload.format,
            "Report generated and sent"
        );
        
        Ok(())
    }
    
    fn job_type(&self) -> &'static str {
        "generate_report"
    }
}
```

### Sync Handler

```rust
pub struct SyncHandler {
    qbo_client: QboClient,
    meilisearch_client: MeilisearchClient,
}

#[async_trait]
impl JobHandler for SyncHandler {
    async fn handle(&self, ctx: JobContext) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload: SyncJobPayload = serde_json::from_value(ctx.payload)?;
        
        match payload.sync_type.as_str() {
            "qbo" => {
                if let Some(entity_id) = payload.entity_id {
                    self.sync_single_qbo_entity(&payload.entity_type.unwrap(), entity_id).await?;
                } else {
                    self.sync_all_qbo_entities(&payload.entity_type).await?;
                }
            },
            "meilisearch" => {
                self.sync_meilisearch_index(&payload.entity_type, payload.entity_id).await?;
            },
            "counterpoint" => {
                self.sync_counterpoint_data(&payload).await?;
            },
            _ => return Err(format!("Unknown sync type: {}", payload.sync_type).into()),
        }
        
        tracing::info!(
            job_id = %ctx.job_id,
            sync_type = %payload.sync_type,
            "Sync completed successfully"
        );
        
        Ok(())
    }
    
    fn job_type(&self) -> &'static str {
        "sync_data"
    }
}
```

---

## Error Handling and Retries

### Automatic Retry Logic

```rust
// Jobs automatically retry on failure
pub struct Job {
    pub attempts: u32,
    pub max_attempts: u32,
    pub error_message: Option<String>,
    // ... other fields
}

impl Job {
    pub fn should_retry(&self) -> bool {
        self.status == JobStatus::Failed && self.attempts < self.max_attempts
    }
}
```

### Custom Error Handling

```rust
#[async_trait]
impl JobHandler for CustomHandler {
    async fn handle(&self, ctx: JobContext) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match self.process_job(&ctx).await {
            Ok(result) => {
                tracing::info!(job_id = %ctx.job_id, "Job completed successfully");
                Ok(())
            }
            Err(e) => {
                // Determine if error is retryable
                let is_retryable = self.is_retryable_error(&e);
                
                if !is_retryable {
                    tracing::error!(
                        job_id = %ctx.job_id,
                        error = %e,
                        "Non-retryable error, job will fail permanently"
                    );
                }
                
                Err(e)
            }
        }
    }
    
    fn is_retryable_error(&self, error: &dyn std::error::Error) -> bool {
        // Network errors, timeouts are retryable
        // Validation errors, not found are not retryable
        let error_string = error.to_string().to_lowercase();
        
        !error_string.contains("not found") &&
        !error_string.contains("invalid") &&
        !error_string.contains("unauthorized")
    }
}
```

### Dead Letter Queue Management

```rust
// Monitor dead letter queue
async fn monitor_dead_letter_queue(queue: &JobQueue) -> Result<(), Error> {
    let stats = queue.get_stats().await?;
    
    if stats.dead_letter > 0 {
        tracing::warn!(
            dead_letter_count = stats.dead_letter,
            "Jobs in dead letter queue require attention"
        );
        
        // Get dead letter jobs for analysis
        let dead_jobs = queue.get_dead_letter_jobs(10).await?;
        
        for job in dead_jobs {
            tracing::error!(
                job_id = %job.id,
                job_type = %job.job_type,
                attempts = job.attempts,
                error = ?job.error_message,
                "Job permanently failed"
            );
            
            // Send alert to administrators
            send_dead_letter_alert(&job).await?;
        }
    }
    
    Ok(())
}
```

---

## Monitoring and Metrics

### Queue Metrics

```rust
// Built-in queue metrics
pub struct QueueStats {
    pub pending: i64,           // Jobs waiting to be processed
    pub processing: i64,        // Jobs currently being processed
    pub dead_letter: i64,       // Jobs that failed permanently
    pub enqueued: i64,          // Total jobs ever enqueued
    pub dequeued: i64,          // Total jobs ever dequeued
    pub completed: i64,         // Total jobs completed successfully
    pub failed: i64,            // Total jobs that failed (including retries)
}
```

### Custom Metrics

```rust
// Track job processing times
pub async fn track_job_metrics(
    metrics_collector: &MetricsCollector,
    job_type: &str,
    duration: Duration,
    success: bool
) {
    let mut tags = HashMap::new();
    tags.insert("job_type".to_string(), job_type.to_string());
    tags.insert("success".to_string(), success.to_string());
    
    metrics_collector.record_custom_metric(
        "job_processing_duration_seconds",
        duration.as_secs_f64(),
        tags.clone(),
        MetricType::Histogram,
    ).await;
    
    metrics_collector.record_custom_metric(
        "jobs_processed_total",
        1.0,
        tags,
        MetricType::Counter,
    ).await;
}
```

### Health Checks

```rust
pub async fn check_job_queue_health(queue: &JobQueue) -> Result<HealthStatus, Error> {
    let stats = queue.get_stats().await?;
    
    // Check for queue backlog
    if stats.pending > 1000 {
        return Ok(HealthStatus::Warning("High queue backlog".to_string()));
    }
    
    // Check for too many failed jobs
    if stats.failed > 100 {
        return Ok(HealthStatus::Critical("High failure rate".to_string()));
    }
    
    // Check dead letter queue
    if stats.dead_letter > 10 {
        return Ok(HealthStatus::Warning("Jobs in dead letter queue".to_string()));
    }
    
    Ok(HealthStatus::Healthy)
}
```

---

## Production Deployment

### Environment Configuration

```bash
# Job Queue Configuration
# A configured Redis URL enables the worker by default.
# Keep this explicit in production; set false only during maintenance.
RIVERSIDE_JOB_QUEUE_ENABLED=true
RIVERSIDE_JOB_WORKERS=3
RIVERSIDE_JOB_MAX_CONCURRENT=10
RIVERSIDE_JOB_POLL_INTERVAL=5
RIVERSIDE_JOB_TIMEOUT=300

# Redis Configuration (for job queue)
RIVERSIDE_REDIS_URL=redis://<production-redis-host>:6379
RIVERSIDE_REDIS_QUEUE_NAME=riverside_jobs
RIVERSIDE_REVIS_VISIBILITY_TIMEOUT=120
```

### Docker Compose

```yaml
version: '3.8'
services:
  app:
    build: .
    environment:
      - RIVERSIDE_JOB_QUEUE_ENABLED=true
      - RIVERSIDE_JOB_WORKERS=3
      - RIVERSIDE_REDIS_URL=redis://redis:6379
    depends_on:
      - redis
      - postgres
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    restart: unless-stopped

  worker:
    build: .
    command: ./riverside-server worker
    environment:
      - RIVERSIDE_JOB_WORKERS=5
      - RIVERSIDE_REDIS_URL=redis://redis:6379
    depends_on:
      - redis
      - postgres
    restart: unless-stopped
    deploy:
      replicas: 2

volumes:
  redis-data:
```

### Kubernetes Deployment

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: maintenance-jobs
spec:
  schedule: "0 2 * * *"  # Run at 2 AM daily
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: maintenance-worker
            image: riverside-os:latest
            command: ["./riverside-server", "enqueue-maintenance"]
            env:
            - name: RIVERSIDE_REDIS_URL
              value: "redis://redis-service:6379"
          restartPolicy: OnFailure
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: job-workers
spec:
  replicas: 3
  selector:
    matchLabels:
      app: job-worker
  template:
    metadata:
      labels:
        app: job-worker
    spec:
      containers:
      - name: worker
        image: riverside-os:latest
        command: ["./riverside-server", "worker"]
        env:
        - name: RIVERSIDE_JOB_WORKERS
          value: "5"
        - name: RIVERSIDE_REDIS_URL
          value: "redis://redis-service:6379"
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          exec:
            command:
            - ./riverside-server
            - health-check
          initialDelaySeconds: 30
          periodSeconds: 10
```

### Monitoring Setup

```yaml
# Prometheus configuration for job queue metrics
scrape_configs:
  - job_name: 'riverside-jobs'
    static_configs:
      - targets: ['app:8080']
    metrics_path: '/api/metrics'
    scrape_interval: 15s
```

### Alerting Rules

```yaml
# Prometheus alerting rules
groups:
- name: job-queue
  rules:
  - alert: HighQueueBacklog
    expr: riverside_jobs_pending > 1000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High job queue backlog"
      description: "Job queue has {{ $value }} pending jobs"
      
  - alert: HighJobFailureRate
    expr: rate(riverside_jobs_failed_total[5m]) > 0.1
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "High job failure rate"
      description: "Job failure rate is {{ $value | humanizePercentage }}"
      
  - alert: DeadLetterQueueGrowth
    expr: increase(riverside_jobs_dead_letter[1h]) > 10
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Dead letter queue growing"
      description: "{{ $value }} jobs moved to dead letter queue in last hour"
```

---

## Best Practices

### Job Design

1. **Idempotency**: Design jobs to be safe to run multiple times
2. **Atomic Operations**: Use database transactions for data modifications
3. **Error Handling**: Distinguish between retryable and non-retryable errors
4. **Timeout Management**: Set appropriate timeouts for different job types
5. **Resource Limits**: Monitor and limit resource usage per job

### Performance Optimization

1. **Batch Processing**: Process multiple items in a single job when possible
2. **Parallel Workers**: Scale workers based on queue depth and system resources
3. **Connection Pooling**: Reuse database and external service connections
4. **Memory Management**: Avoid loading large datasets into memory
5. **Monitoring**: Track queue depth, processing times, and error rates

### Security Considerations

1. **Input Validation**: Validate all job payloads
2. **Access Control**: Restrict job types based on user permissions
3. **Audit Logging**: Log all job operations for security review
4. **Secrets Management**: Use secure methods for storing API keys and credentials
5. **Network Security**: Use TLS for external service communications

---

## Troubleshooting

### Common Issues

#### Jobs Not Processing
```bash
# Check worker status
curl http://localhost:8080/api/health

# Check queue depth
redis-cli LLEN queue:riverside_jobs

# Check worker logs
docker logs riverside-worker
```

#### High Failure Rate
```bash
# Check failed jobs
redis-cli LRANGE queue:riverside_jobs_dead 0 -1

# Review error messages
curl http://localhost:8080/api/metrics | grep jobs_failed

# Check database connectivity
psql $DATABASE_URL -c "SELECT 1;"
```

#### Memory Issues
```bash
# Check Redis memory usage
redis-cli info memory

# Monitor worker memory
docker stats riverside-worker

# Check for memory leaks in job processing
```

#### Performance Issues
```bash
# Check job processing times
curl http://localhost:8080/api/metrics | grep job_processing_duration

# Analyze slow queries
psql $DATABASE_URL -c "SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# Check network latency to external services
ping external-service.com
```

---

## Conclusion

The background job queue system provides Riverside OS with enterprise-grade asynchronous processing capabilities. Follow these guidelines to ensure reliable, scalable, and maintainable job processing in production environments.

For additional support or questions, refer to the API documentation or contact the development team.
