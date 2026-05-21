//! Job worker implementation for processing background jobs

use crate::jobs::{Job, JobContext, HandlerRegistry, JobHandler};
use crate::jobs::queue::JobQueue;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use tracing::{error, info, warn};

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub worker_id: String,
    pub poll_interval: Duration,
    pub max_concurrent_jobs: usize,
    pub job_timeout: Duration,
    pub shutdown_timeout: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            worker_id: format!("worker-{}", uuid::Uuid::new_v4()),
            poll_interval: Duration::from_secs(5),
            max_concurrent_jobs: 10,
            job_timeout: Duration::from_secs(300), // 5 minutes
            shutdown_timeout: Duration::from_secs(30),
        }
    }
}

pub struct JobWorker {
    queue: JobQueue,
    handlers: HandlerRegistry,
    config: WorkerConfig,
    running: Arc<tokio::sync::RwLock<bool>>,
    job_semaphore: Arc<tokio::sync::Semaphore>,
}

impl JobWorker {
    pub fn new(queue: JobQueue, handlers: HandlerRegistry, config: WorkerConfig) -> Self {
        let max_concurrent_jobs = config.max_concurrent_jobs;
        Self {
            queue,
            handlers,
            config,
            running: Arc::new(tokio::sync::RwLock::new(false)),
            job_semaphore: Arc::new(tokio::sync::Semaphore::new(max_concurrent_jobs)),
        }
    }

    /// Start the worker
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        {
            let mut running = self.running.write().await;
            if *running {
                return Err("Worker is already running".into());
            }
            *running = true;
        }

        info!(worker_id = %self.config.worker_id, "Starting job worker");

        let worker_id = self.config.worker_id.clone();
        let running = self.running.clone();
        let queue = self.queue.clone();
        let handlers = self.handlers.clone();
        let poll_interval = self.config.poll_interval;
        let job_timeout = self.config.job_timeout;
        let job_semaphore = self.job_semaphore.clone();

        tokio::spawn(async move {
            while *running.read().await {
                // Try to dequeue a job first
                match queue.dequeue().await {
                    Ok(Some(job)) => {
                        // Now try to acquire semaphore for this job
                        let semaphore_clone = job_semaphore.clone();
                        let permit = match semaphore_clone.acquire().await {
                            Ok(permit) => permit,
                            Err(_) => {
                                warn!("Semaphore closed, stopping worker");
                                break;
                            }
                        };

                        let job_id = job.id;
                        let worker_id = worker_id.clone();
                        let queue = queue.clone();
                        let handlers = handlers.clone();
                        let _running = running.clone();

                        // Spawn job processing
                        tokio::spawn(async move {
                            let _permit = permit; // Hold permit until job completes

                            if let Err(e) = Self::process_job(
                                &queue,
                                &handlers,
                                job,
                                job_timeout,
                                &worker_id,
                            ).await {
                                error!(worker_id = %worker_id, job_id = %job_id, error = %e, "Job processing failed");
                            }
                        });
                    }
                    Ok(None) => {
                        // No jobs available, wait before next poll
                        drop(permit);
                        tokio::time::sleep(poll_interval).await;
                    }
                    Err(e) => {
                        error!(worker_id = %worker_id, error = %e, "Failed to dequeue job");
                        drop(permit);
                        tokio::time::sleep(Duration::from_secs(10)).await;
                    }
                }
            }

            info!(worker_id = %worker_id, "Job worker stopped");
        });

        Ok(())
    }

    /// Stop the worker gracefully
    pub async fn stop(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        info!(worker_id = %self.config.worker_id, "Stopping job worker");

        // Set running flag to false
        {
            let mut running = self.running.write().await;
            *running = false;
        }

        // Wait for all running jobs to complete or timeout
        let semaphore_acquisition = timeout(
            self.config.shutdown_timeout,
            self.job_semaphore.acquire_many(self.config.max_concurrent_jobs as u32)
        ).await;

        match semaphore_acquisition {
            Ok(Ok(_)) => {
                info!(worker_id = %self.config.worker_id, "All jobs completed, worker stopped");
            }
            Ok(Err(e)) => {
                warn!(worker_id = %self.config.worker_id, error = %e, "Error acquiring semaphore permits");
            }
            Err(_) => {
                warn!(worker_id = %self.config.worker_id, "Shutdown timeout, some jobs may still be running");
            }
        }

        Ok(())
    }

    /// Check if worker is running
    pub async fn is_running(&self) -> bool {
        *self.running.read().await
    }

    /// Get worker statistics
    pub async fn get_stats(&self) -> Result<crate::jobs::queue::QueueStats, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.queue.get_stats().await?)
    }

    /// Process a single job
    async fn process_job(
        queue: &JobQueue,
        handlers: &HandlerRegistry,
        job: Job,
        job_timeout: Duration,
        worker_id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let job_id = job.id;
        let job_type = job.job_type.clone();

        info!(worker_id = %worker_id, job_id = %job_id, job_type = %job_type, "Processing job");

        // Create job context
        let ctx = JobContext::new(job_id, job_type.to_string(), job.payload.clone())
            .with_attempt(job.attempts + 1)
            .with_max_attempts(job.max_attempts);

        // Find handler for this job type
        let handler = match handlers.get(&job_type.to_string()) {
            Some(handler) => handler.clone(),
            None => {
                let error = format!("No handler found for job type: {}", job_type);
                error!(worker_id = %worker_id, job_id = %job_id, error = %error);
                queue.fail(job_id, &error).await?;
                return Err(error.into());
            }
        };

        // Execute job with timeout
        let result = timeout(job_timeout, handler.handle(ctx)).await;

        match result {
            Ok(Ok(())) => {
                // Job completed successfully
                info!(worker_id = %worker_id, job_id = %job_id, "Job completed successfully");
                queue.complete(job_id).await?;
            }
            Ok(Err(e)) => {
                // Job failed
                let error_msg = e.to_string();
                error!(worker_id = %worker_id, job_id = %job_id, error = %error_msg, "Job failed");
                queue.fail(job_id, &error_msg).await?;
            }
            Err(_) => {
                // Job timed out
                let error_msg = format!("Job timed out after {:?}", job_timeout);
                error!(worker_id = %worker_id, job_id = %job_id, error = %error_msg);
                queue.fail(job_id, &error_msg).await?;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{Job, JobType};
    use async_trait::async_trait;

    struct TestHandler {
        name: &'static str,
    }

    #[async_trait]
    impl JobHandler for TestHandler {
        async fn handle(&self, ctx: JobContext) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            info!("Handling job: {}", ctx.job_type);
            Ok(())
        }

        fn job_type(&self) -> &'static str {
            self.name
        }
    }

    #[tokio::test]
    async fn test_worker_lifecycle() {
        // This test would require a Redis instance
        // For now, we'll just test the worker creation
        let queue = JobQueue::from_env().unwrap();
        let mut handlers = crate::jobs::create_registry();
        crate::jobs::register_handler(&mut handlers, std::sync::Arc::new(TestHandler { name: "test" }));

        let config = WorkerConfig {
            worker_id: "test-worker".to_string(),
            poll_interval: Duration::from_millis(100),
            max_concurrent_jobs: 1,
            job_timeout: Duration::from_secs(1),
            shutdown_timeout: Duration::from_secs(1),
        };

        let worker = JobWorker::new(queue, handlers, config);

        assert!(!worker.is_running().await);

        // Note: In a real test, you'd start the worker and verify behavior
        // But for now, we'll just test the initial state
    }
}
