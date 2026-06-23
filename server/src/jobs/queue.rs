//! Job queue implementation using Redis for distributed processing

use crate::cache::CacheService;
use crate::jobs::{Job, JobStatus};
use chrono::Utc;
use redis::RedisError;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct JobQueueConfig {
    pub redis_url: String,
    pub queue_name: String,
    pub processing_timeout: Duration,
    pub visibility_timeout: Duration,
    pub max_retries: u32,
    pub dead_letter_queue: String,
}

impl Default for JobQueueConfig {
    fn default() -> Self {
        Self {
            redis_url: std::env::var("RIVERSIDE_REDIS_URL")
                .unwrap_or_else(|_| "redis://localhost:6379".to_string()),
            queue_name: "riverside_jobs".to_string(),
            processing_timeout: Duration::from_secs(300), // 5 minutes
            visibility_timeout: Duration::from_secs(120), // 2 minutes
            max_retries: 3,
            dead_letter_queue: "riverside_jobs_dead".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct JobQueue {
    cache: CacheService,
    config: JobQueueConfig,
}

impl JobQueue {
    pub fn new(config: JobQueueConfig) -> Result<Self, RedisError> {
        let cache = CacheService::new(crate::cache::CacheConfig {
            redis_url: config.redis_url.clone(),
            default_ttl: Duration::from_secs(3600),
            lock_timeout: Duration::from_secs(30),
            max_retries: 3,
        })?;
        Ok(Self { cache, config })
    }

    pub fn from_env() -> Result<Self, RedisError> {
        Self::new(JobQueueConfig::default())
    }

    /// Enqueue a job for processing
    pub async fn enqueue(&self, job: Job) -> Result<Uuid, RedisError> {
        let job_id = job.id;
        let queue_key = self.queue_key();
        let job_key = self.job_key(job_id);

        // Store job data
        self.cache
            .set(&job_key, &job, Some(Duration::from_secs(86400)))
            .await?;

        // Add to queue (using Redis list)
        let mut conn = self.cache.redis().get_connection().await?;
        let _: () = redis::cmd("LPUSH")
            .arg(&queue_key)
            .arg(job_id.to_string())
            .query_async(&mut conn)
            .await?;

        // Update queue stats
        self.increment_queue_stats("enqueued").await?;

        tracing::info!(job_id = %job_id, job_type = %job.job_type, "Job enqueued");

        Ok(job_id)
    }

    /// Dequeue a job for processing (with visibility timeout)
    pub async fn dequeue(&self) -> Result<Option<Job>, RedisError> {
        let queue_key = self.queue_key();
        let processing_key = self.processing_key();

        // Use BRPOPLPUSH to atomically move job to processing queue
        let mut conn = self.cache.redis().get_connection().await?;
        let job_id_result: Option<String> = redis::cmd("BRPOPLPUSH")
            .arg(&queue_key)
            .arg(&processing_key)
            .arg(self.config.visibility_timeout.as_secs())
            .query_async(&mut conn)
            .await?;

        let job_id = match job_id_result {
            Some(id) => Uuid::parse_str(&id)
                .map_err(|_| RedisError::from((redis::ErrorKind::TypeError, "Invalid UUID", id)))?,
            None => return Ok(None),
        };

        // Get job data
        let job_key = self.job_key(job_id);
        let job: Option<Job> = self.cache.get(&job_key).await?;

        match job {
            Some(mut job) => {
                job.status = JobStatus::Processing;
                job.started_at = Some(Utc::now());

                // Update job status
                self.cache
                    .set(&job_key, &job, Some(Duration::from_secs(86400)))
                    .await?;

                // Update queue stats
                self.increment_queue_stats("dequeued").await?;

                tracing::info!(job_id = %job_id, job_type = %job.job_type, "Job dequeued");

                Ok(Some(job))
            }
            None => {
                // Job data missing, remove from processing queue
                let _: () = redis::cmd("LREM")
                    .arg(&processing_key)
                    .arg(1)
                    .arg(job_id.to_string())
                    .query_async(&mut conn)
                    .await?;

                tracing::warn!(job_id = %job_id, "Job data missing, removing from processing queue");

                Ok(None)
            }
        }
    }

    /// Mark a job as completed
    pub async fn complete(&self, job_id: Uuid) -> Result<(), RedisError> {
        let job_key = self.job_key(job_id);
        let processing_key = self.processing_key();

        // Get and update job
        let mut job: Option<Job> = self.cache.get(&job_key).await?;

        if let Some(ref mut job) = job {
            job.status = JobStatus::Completed;
            job.completed_at = Some(Utc::now());

            // Update job data
            self.cache
                .set(&job_key, job, Some(Duration::from_secs(86400)))
                .await?;
        }

        // Remove from processing queue
        let mut conn = self.cache.redis().get_connection().await?;
        let _: () = redis::cmd("LREM")
            .arg(&processing_key)
            .arg(1)
            .arg(job_id.to_string())
            .query_async(&mut conn)
            .await?;

        // Update queue stats
        self.increment_queue_stats("completed").await?;

        tracing::info!(job_id = %job_id, "Job completed");

        Ok(())
    }

    /// Mark a job as failed (with retry logic)
    pub async fn fail(&self, job_id: Uuid, error: &str) -> Result<(), RedisError> {
        let job_key = self.job_key(job_id);
        let processing_key = self.processing_key();
        let dead_letter_key = self.dead_letter_key();

        // Get and update job
        let mut job: Option<Job> = self.cache.get(&job_key).await?;

        if let Some(ref mut job) = job {
            job.status = JobStatus::Failed;
            job.error_message = Some(error.to_string());
            job.attempts += 1;
            job.failed_at = Some(Utc::now());

            // Update job data
            self.cache
                .set(&job_key, job, Some(Duration::from_secs(86400)))
                .await?;
        }

        // Remove from processing queue
        let mut conn = self.cache.redis().get_connection().await?;
        let _: () = redis::cmd("LREM")
            .arg(&processing_key)
            .arg(1)
            .arg(job_id.to_string())
            .query_async(&mut conn)
            .await?;

        // Check if should retry or send to dead letter queue
        if let Some(ref job) = job {
            if job.attempts < self.config.max_retries {
                // Requeue for retry
                let _: () = redis::cmd("LPUSH")
                    .arg(self.queue_key())
                    .arg(job_id.to_string())
                    .query_async(&mut conn)
                    .await?;

                tracing::warn!(job_id = %job_id, attempt = job.attempts, error = error, "Job failed, requeuing");
            } else {
                // Send to dead letter queue
                let _: () = redis::cmd("LPUSH")
                    .arg(&dead_letter_key)
                    .arg(job_id.to_string())
                    .query_async(&mut conn)
                    .await?;

                tracing::error!(job_id = %job_id, attempts = job.attempts, error = error, "Job failed permanently, sent to dead letter queue");
            }
        }

        // Update queue stats
        self.increment_queue_stats("failed").await?;

        Ok(())
    }

    /// Get queue statistics
    pub async fn get_stats(&self) -> Result<QueueStats, RedisError> {
        let mut conn = self.cache.redis().get_connection().await?;

        let pending: i64 = redis::cmd("LLEN")
            .arg(self.queue_key())
            .query_async(&mut conn)
            .await?;

        let processing: i64 = redis::cmd("LLEN")
            .arg(self.processing_key())
            .query_async(&mut conn)
            .await?;

        let dead_letter: i64 = redis::cmd("LLEN")
            .arg(self.dead_letter_key())
            .query_async(&mut conn)
            .await?;

        let enqueued: i64 = self
            .cache
            .redis()
            .get(&self.stats_key("enqueued"))
            .await?
            .unwrap_or(0);
        let dequeued: i64 = self
            .cache
            .redis()
            .get(&self.stats_key("dequeued"))
            .await?
            .unwrap_or(0);
        let completed: i64 = self
            .cache
            .redis()
            .get(&self.stats_key("completed"))
            .await?
            .unwrap_or(0);
        let failed: i64 = self
            .cache
            .redis()
            .get(&self.stats_key("failed"))
            .await?
            .unwrap_or(0);

        Ok(QueueStats {
            pending,
            processing,
            dead_letter,
            enqueued,
            dequeued,
            completed,
            failed,
        })
    }

    // Helper methods
    fn queue_key(&self) -> String {
        format!("queue:{}", self.config.queue_name)
    }

    fn processing_key(&self) -> String {
        format!("queue:{}:processing", self.config.queue_name)
    }

    fn dead_letter_key(&self) -> String {
        format!("queue:{}:dead", self.config.dead_letter_queue)
    }

    fn job_key(&self, job_id: Uuid) -> String {
        format!("job:{job_id}")
    }

    fn stats_key(&self, stat: &str) -> String {
        format!("stats:{}:{}", self.config.queue_name, stat)
    }

    async fn increment_queue_stats(&self, stat: &str) -> Result<(), RedisError> {
        self.cache.redis().incr(&self.stats_key(stat)).await?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueStats {
    pub pending: i64,
    pub processing: i64,
    pub dead_letter: i64,
    pub enqueued: i64,
    pub dequeued: i64,
    pub completed: i64,
    pub failed: i64,
}
