//! Background job queue system for resilient async processing

pub mod fal_download;
pub mod job_types;
pub mod qbo_sync;
pub mod queue;
pub mod worker;

pub use job_types::{Job, JobPriority, JobStatus, JobType};
pub use queue::{JobQueue, JobQueueConfig};
pub use worker::{JobWorker, WorkerConfig};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobContext {
    pub job_id: Uuid,
    pub job_type: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub payload: serde_json::Value,
    pub metadata: HashMap<String, String>,
}

impl JobContext {
    pub fn new(job_id: Uuid, job_type: String, payload: serde_json::Value) -> Self {
        Self {
            job_id,
            job_type,
            attempt: 1,
            max_attempts: 3,
            payload,
            metadata: HashMap::new(),
        }
    }

    pub fn with_attempt(mut self, attempt: u32) -> Self {
        self.attempt = attempt;
        self
    }

    pub fn with_max_attempts(mut self, max_attempts: u32) -> Self {
        self.max_attempts = max_attempts;
        self
    }

    pub fn with_metadata(mut self, key: String, value: String) -> Self {
        self.metadata.insert(key, value);
        self
    }
}

#[async_trait::async_trait]
pub trait JobHandler: Send + Sync {
    async fn handle(&self, ctx: JobContext)
        -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    fn job_type(&self) -> &'static str;
    fn max_attempts(&self) -> u32 {
        3
    }
}

pub type HandlerRegistry = HashMap<String, std::sync::Arc<dyn JobHandler>>;

/// Returns whether the Redis-backed worker should start.
///
/// An explicit false value keeps operators able to disable background
/// processing during maintenance. Otherwise, a configured Redis URL enables
/// the worker by default so production cannot silently omit the queue flag.
pub fn enabled_from_env() -> bool {
    match std::env::var("RIVERSIDE_JOB_QUEUE_ENABLED")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("0" | "false" | "no" | "off") => false,
        Some("1" | "true" | "yes" | "on") => true,
        _ => std::env::var("RIVERSIDE_REDIS_URL")
            .ok()
            .is_some_and(|value| !value.trim().is_empty()),
    }
}

pub fn create_registry() -> HandlerRegistry {
    HashMap::new()
}

pub fn register_handler(registry: &mut HandlerRegistry, handler: std::sync::Arc<dyn JobHandler>) {
    registry.insert(handler.job_type().to_string(), handler);
}
