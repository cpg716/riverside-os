//! Job definitions and types

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: Uuid,
    pub job_type: JobType,
    pub priority: JobPriority,
    pub payload: serde_json::Value,
    pub status: JobStatus,
    pub attempts: u32,
    pub max_attempts: u32,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub failed_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
    pub metadata: HashMap<String, String>,
}

impl Job {
    pub fn new(job_type: JobType, payload: serde_json::Value) -> Self {
        Self {
            id: Uuid::new_v4(),
            job_type,
            priority: JobPriority::Normal,
            payload,
            status: JobStatus::Pending,
            attempts: 0,
            max_attempts: 3,
            created_at: Utc::now(),
            started_at: None,
            completed_at: None,
            failed_at: None,
            error_message: None,
            metadata: HashMap::new(),
        }
    }

    pub fn with_priority(mut self, priority: JobPriority) -> Self {
        self.priority = priority;
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

    pub fn is_finished(&self) -> bool {
        matches!(self.status, JobStatus::Completed | JobStatus::Failed)
    }

    pub fn should_retry(&self) -> bool {
        self.status == JobStatus::Failed && self.attempts < self.max_attempts
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

impl std::fmt::Display for JobType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobType::SendEmail => write!(f, "send_email"),
            JobType::SendBulkEmail => write!(f, "send_bulk_email"),
            JobType::GenerateReport => write!(f, "generate_report"),
            JobType::ExportData => write!(f, "export_data"),
            JobType::SyncQBO => write!(f, "sync_qbo"),
            JobType::SyncMeilisearch => write!(f, "sync_meilisearch"),
            JobType::SyncCounterpoint => write!(f, "sync_counterpoint"),
            JobType::CleanupOldSessions => write!(f, "cleanup_old_sessions"),
            JobType::BackupDatabase => write!(f, "backup_database"),
            JobType::ArchiveNotifications => write!(f, "archive_notifications"),
            JobType::SendPushNotification => write!(f, "send_push_notification"),
            JobType::SendSMS => write!(f, "send_sms"),
            JobType::UpdateMetrics => write!(f, "update_metrics"),
            JobType::ProcessAnalytics => write!(f, "process_analytics"),
            JobType::Custom(name) => write!(f, "{}", name),
        }
    }
}

impl From<String> for JobType {
    fn from(s: String) -> Self {
        match s.as_str() {
            "send_email" => JobType::SendEmail,
            "send_bulk_email" => JobType::SendBulkEmail,
            "generate_report" => JobType::GenerateReport,
            "export_data" => JobType::ExportData,
            "sync_qbo" => JobType::SyncQBO,
            "sync_meilisearch" => JobType::SyncMeilisearch,
            "sync_counterpoint" => JobType::SyncCounterpoint,
            "cleanup_old_sessions" => JobType::CleanupOldSessions,
            "backup_database" => JobType::BackupDatabase,
            "archive_notifications" => JobType::ArchiveNotifications,
            "send_push_notification" => JobType::SendPushNotification,
            "send_sms" => JobType::SendSMS,
            "update_metrics" => JobType::UpdateMetrics,
            "process_analytics" => JobType::ProcessAnalytics,
            _ => JobType::Custom(s),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum JobPriority {
    Low = 1,
    Normal = 2,
    High = 3,
    Critical = 4,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobStatus {
    Pending,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

// Job payload types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailJobPayload {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    pub html_body: Option<String>,
    pub attachments: Vec<EmailAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailAttachment {
    pub filename: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportJobPayload {
    pub report_type: String,
    pub parameters: HashMap<String, serde_json::Value>,
    pub format: ReportFormat,
    pub recipients: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ReportFormat {
    PDF,
    Excel,
    CSV,
    JSON,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncJobPayload {
    pub sync_type: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<Uuid>,
    pub force_full_sync: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationJobPayload {
    pub user_id: Option<Uuid>,
    pub staff_id: Option<Uuid>,
    pub title: String,
    pub message: String,
    pub channels: Vec<NotificationChannel>,
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NotificationChannel {
    InApp,
    Email,
    SMS,
    Push,
}
