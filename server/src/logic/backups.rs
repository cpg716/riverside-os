use anyhow::{Context, Result};
use chrono::{Local, Utc};
use opendal::{services::S3, Operator};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;
use tracing::{error, info};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupSettings {
    pub auto_cleanup_days: u32,
    pub schedule_cron: String,
    pub cloud_storage_enabled: bool,
    pub cloud_bucket_name: String,
    pub cloud_region: String,
    pub cloud_endpoint: String,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            auto_cleanup_days: 30,
            schedule_cron: "0 2 * * *".to_string(),
            cloud_storage_enabled: false,
            cloud_bucket_name: "".to_string(),
            cloud_region: "us-east-1".to_string(),
            cloud_endpoint: "".to_string(),
        }
    }
}

pub struct BackupManager {
    backup_dir: PathBuf,
    database_url: String,
}

#[derive(Serialize)]
pub struct BackupFile {
    pub filename: String,
    pub size_bytes: u64,
    pub created_at: String,
}

impl BackupManager {
    pub fn new(database_url: String) -> Self {
        let backup_dir = PathBuf::from("backups");
        if !backup_dir.exists() {
            let _ = fs::create_dir_all(&backup_dir);
        }
        Self {
            backup_dir,
            database_url,
        }
    }

    /// List all available backup files in the backups/ directory.
    pub fn list_backups(&self) -> Result<Vec<BackupFile>> {
        let mut backups = Vec::new();
        let entries = fs::read_dir(&self.backup_dir)?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("dump") {
                let metadata = entry.metadata()?;
                let created = metadata.created().unwrap_or_else(|_| {
                    metadata.modified().unwrap_or(std::time::SystemTime::now())
                });
                let datetime: chrono::DateTime<Local> = created.into();

                backups.push(BackupFile {
                    filename: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    size_bytes: metadata.len(),
                    created_at: datetime.format("%Y-%m-%d %H:%M:%S").to_string(),
                });
            }
        }

        // Sort by created_at descending (newest first)
        backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(backups)
    }

    /// Perform a backup using pg_dump.
    pub async fn create_backup(&self) -> Result<String> {
        let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
        let filename = format!("backup_{timestamp}.dump");
        let output_path = self.backup_dir.join(&filename);

        info!("Starting database backup to {:?}", output_path);

        // We use the full connection string directly with pg_dump -d
        // -F c: Custom-format archive suitable for input into pg_restore.
        //
        // Never use `.stderr(piped())` with `.status()` — nothing reads the pipe, the read end
        // can close, and pg_dump gets SIGPIPE while writing warnings/progress to stderr.
        let out = Command::new("pg_dump")
            .arg("-d")
            .arg(&self.database_url)
            .arg("-F")
            .arg("c") // custom format (compressed)
            .arg("-f")
            .arg(&output_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("Failed to execute pg_dump")?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            error!(stderr = %err, status = %out.status, "pg_dump failed");
            let detail = err.trim();
            if detail.is_empty() {
                return Err(anyhow::anyhow!("pg_dump failed ({})", out.status));
            }
            return Err(anyhow::anyhow!("pg_dump failed: {detail}"));
        }

        info!("Database backup completed successfully: {}", filename);
        Ok(filename)
    }

    /// Restore a database from a backup using pg_restore.
    /// WARNING: This is destructive.
    pub async fn restore_backup(&self, filename: &str) -> Result<()> {
        let input_path = self.backup_dir.join(filename);
        if !input_path.exists() {
            return Err(anyhow::anyhow!("Backup file not found"));
        }

        info!("Starting database restore from {:?}", input_path);

        // -c: Clean (drop) database objects before recreating them.
        // -d: Connect to database.
        // --if-exists: Use IF EXISTS when dropping objects.
        // --no-owner: Skip restoration of object ownership.
        let out = Command::new("pg_restore")
            .arg("-d")
            .arg(&self.database_url)
            .arg("--clean")
            .arg("--if-exists")
            .arg("--no-owner")
            .arg(&input_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("Failed to execute pg_restore")?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            error!(stderr = %err, status = %out.status, "pg_restore failed");
            let detail = err.trim();
            if detail.is_empty() {
                return Err(anyhow::anyhow!("pg_restore failed ({})", out.status));
            }
            return Err(anyhow::anyhow!("pg_restore failed: {detail}"));
        }

        info!("Database restoration completed successfully");
        Ok(())
    }

    /// Delete a backup file.
    pub fn delete_backup(&self, filename: &str) -> Result<()> {
        let path = self.backup_dir.join(filename);
        if path.exists() {
            fs::remove_file(path)?;
            Ok(())
        } else {
            Err(anyhow::anyhow!("File not found"))
        }
    }

    /// Auto-cleanup local backups older than max_days.
    /// Uses tokio::fs for optimized non-blocking filesystem operations.
    pub async fn perform_auto_cleanup(&self, max_days: u32) -> Result<u32> {
        if max_days == 0 {
            return Ok(0);
        }

        let mut deleted_count = 0;
        let mut entries = tokio::fs::read_dir(&self.backup_dir).await?;
        let now = Utc::now();
        let max_age = chrono::Duration::days(max_days as i64);

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("dump") {
                let metadata = entry.metadata().await?;
                let modified: chrono::DateTime<Utc> = metadata.modified()?.into();

                if now.signed_duration_since(modified) > max_age {
                    info!(
                        "Auto-cleanup: Deleting old backup {:?}",
                        path.file_name().unwrap_or_default()
                    );
                    tokio::fs::remove_file(path).await?;
                    deleted_count += 1;
                }
            }
        }

        if deleted_count > 0 {
            info!(
                "Auto-cleanup completed: Deleted {} backups older than {} days",
                deleted_count, max_days
            );
        }

        Ok(deleted_count)
    }

    /// Sync a local backup file to the configured S3-compatible bucket.
    /// Uses OpenDAL for a robust, multi-provider cloud abstraction.
    /// Credentials must be provided via environment variables:
    /// - BACKUP_S3_ACCESS_KEY
    /// - BACKUP_S3_SECRET_KEY
    pub async fn sync_to_cloud(&self, filename: &str, settings: &BackupSettings) -> Result<()> {
        if !settings.cloud_storage_enabled || settings.cloud_bucket_name.is_empty() {
            return Ok(());
        }

        let access_key = std::env::var("BACKUP_S3_ACCESS_KEY")
            .context("BACKUP_S3_ACCESS_KEY must be set for cloud integration")?;
        let secret_key = std::env::var("BACKUP_S3_SECRET_KEY")
            .context("BACKUP_S3_SECRET_KEY must be set for cloud integration")?;

        let mut builder = S3::default();
        builder = builder.bucket(&settings.cloud_bucket_name);
        builder = builder.region(&settings.cloud_region);
        builder = builder.access_key_id(&access_key);
        builder = builder.secret_access_key(&secret_key);

        if !settings.cloud_endpoint.is_empty() {
            builder = builder.endpoint(&settings.cloud_endpoint);
        }

        let op = Operator::new(builder)?.finish();
        let file_path = self.backup_dir.join(filename);
        let contents = tokio::fs::read(&file_path).await?;

        info!(
            "Cloud Sync: Uploading {} to bucket {}",
            filename, settings.cloud_bucket_name
        );

        op.write(filename, contents).await?;

        info!(
            "Cloud Sync: Successfully uploaded {} to cloud storage",
            filename
        );

        Ok(())
    }
}

const BACKUP_FAILURE_DETAIL_MAX: usize = 500;

fn clip_backup_detail(s: &str) -> String {
    let t = s.trim();
    if t.len() <= BACKUP_FAILURE_DETAIL_MAX {
        t.to_string()
    } else {
        format!("{}…", &t[..BACKUP_FAILURE_DETAIL_MAX.saturating_sub(1)])
    }
}

/// Singleton `store_backup_health` row — used for admin notifications (local/cloud failure, overdue).
pub async fn record_local_backup_success(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO store_backup_health (id, last_local_success_at, updated_at)
        VALUES (1, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
            last_local_success_at = EXCLUDED.last_local_success_at,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_local_backup_failure(pool: &PgPool, detail: &str) -> Result<(), sqlx::Error> {
    let d = clip_backup_detail(detail);
    sqlx::query(
        r#"
        INSERT INTO store_backup_health (id, last_local_failure_at, last_local_failure_detail, updated_at)
        VALUES (1, NOW(), $1, NOW())
        ON CONFLICT (id) DO UPDATE SET
            last_local_failure_at = EXCLUDED.last_local_failure_at,
            last_local_failure_detail = EXCLUDED.last_local_failure_detail,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(&d)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_cloud_backup_success(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO store_backup_health (id, last_cloud_success_at, last_cloud_failure_detail, updated_at)
        VALUES (1, NOW(), NULL, NOW())
        ON CONFLICT (id) DO UPDATE SET
            last_cloud_success_at = EXCLUDED.last_cloud_success_at,
            last_cloud_failure_detail = NULL,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_cloud_backup_failure(pool: &PgPool, detail: &str) -> Result<(), sqlx::Error> {
    let d = clip_backup_detail(detail);
    sqlx::query(
        r#"
        INSERT INTO store_backup_health (id, last_cloud_failure_at, last_cloud_failure_detail, updated_at)
        VALUES (1, NOW(), $1, NOW())
        ON CONFLICT (id) DO UPDATE SET
            last_cloud_failure_at = EXCLUDED.last_cloud_failure_at,
            last_cloud_failure_detail = EXCLUDED.last_cloud_failure_detail,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(&d)
    .execute(pool)
    .await?;
    Ok(())
}
