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

const BACKUP_DIR_ENV: &str = "RIVERSIDE_BACKUP_DIR";

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

#[derive(Debug, Serialize, Clone)]
pub struct BackupDirectoryInfo {
    pub path: String,
    pub configured: bool,
    pub strict_required: bool,
}

fn configured_backup_dir() -> (PathBuf, bool) {
    std::env::var(BACKUP_DIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| (PathBuf::from(value), true))
        .unwrap_or_else(|| (PathBuf::from("backups"), false))
}

pub fn backup_directory_info(strict_production: bool) -> BackupDirectoryInfo {
    let (path, configured) = configured_backup_dir();
    BackupDirectoryInfo {
        path: path.to_string_lossy().into_owned(),
        configured,
        strict_required: strict_production,
    }
}

pub fn validate_backup_dir_for_startup(strict_production: bool) -> Result<()> {
    let (path, configured) = configured_backup_dir();
    if strict_production && !configured {
        return Err(anyhow::anyhow!(
            "Strict production requires {BACKUP_DIR_ENV} to point at a durable backup directory"
        ));
    }
    if strict_production && !path.is_absolute() {
        return Err(anyhow::anyhow!(
            "Strict production requires {BACKUP_DIR_ENV} to be an absolute path"
        ));
    }

    fs::create_dir_all(&path)?;
    if !path.is_dir() {
        return Err(anyhow::anyhow!(
            "{BACKUP_DIR_ENV} does not point at a directory"
        ));
    }

    Ok(())
}

impl BackupManager {
    pub fn new(database_url: String) -> Self {
        let (backup_dir, _) = configured_backup_dir();
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

    fn listed_backup_path(&self, filename: &str) -> Result<PathBuf> {
        let trimmed = filename.trim();
        if trimmed.is_empty()
            || trimmed.contains('/')
            || trimmed.contains('\\')
            || trimmed.contains("..")
            || !trimmed.ends_with(".dump")
        {
            return Err(anyhow::anyhow!(
                "Backup file is not in the local backup catalog"
            ));
        }

        let exists = self
            .list_backups()?
            .into_iter()
            .any(|backup| backup.filename == trimmed);
        if !exists {
            return Err(anyhow::anyhow!(
                "Backup file is not in the local backup catalog"
            ));
        }

        Ok(self.backup_dir.join(trimmed))
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
        let mut cmd = Command::new("pg_dump");
        cmd.arg("-d")
            .arg(&self.database_url)
            .arg("-F")
            .arg("c")
            .arg("-f")
            .arg(&output_path);

        let out = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("Failed to execute pg_dump")?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);

            // Check for version mismatch error
            if err.contains("server version mismatch") {
                info!("pg_dump version mismatch detected; attempting fallback via Docker...");

                // Fallback attempt: use docker exec to run pg_dump inside the container
                // We assume the standard container name 'riverside-os-db' from the manifests.
                // Note: We use shell redirection-like behavior by capturing stdout if -f inside docker is tricky.
                // But simpler is to try: docker exec riverside-os-db pg_dump -U postgres -F c riverside_os
                let docker_out = Command::new("docker")
                    .arg("exec")
                    .arg("riverside-os-db")
                    .arg("pg_dump")
                    .arg("-U")
                    .arg("postgres")
                    .arg("-F")
                    .arg("c")
                    .arg("riverside_os")
                    .output()
                    .await;

                match docker_out {
                    Ok(d_out) if d_out.status.success() => {
                        fs::write(&output_path, d_out.stdout)?;
                        info!("Backup successful via Docker fallback: {}", filename);
                        return Ok(filename);
                    }
                    Ok(d_out) => {
                        let d_err = String::from_utf8_lossy(&d_out.stderr);
                        error!(stderr = %d_err, "Docker fallback pg_dump failed");
                    }
                    Err(e) => {
                        error!(error = %e, "Failed to initiate Docker fallback");
                    }
                }
            }

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
        let input_path = self.listed_backup_path(filename)?;
        if !input_path.exists() {
            return Err(anyhow::anyhow!("Backup file not found"));
        }

        info!("Starting database restore from {:?}", input_path);

        // -c: Clean (drop) database objects before recreating them.
        // -d: Connect to database.
        // --if-exists: Use IF EXISTS when dropping objects.
        // --no-owner: Skip restoration of object ownership.
        let mut cmd = Command::new("pg_restore");
        cmd.arg("-d")
            .arg(&self.database_url)
            .arg("--clean")
            .arg("--if-exists")
            .arg("--no-owner")
            .arg(&input_path);

        let out = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("Failed to execute pg_restore")?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            error!(stderr = %err, status = %out.status, "Host pg_restore failed - attempting universal Docker fallback...");

            // Read the local file into memory or stream it.
            // For a 5MB-20MB dump, reading to memory is safe for this context.
            let dump_data = fs::read(&input_path)?;

            // Fallback attempt: docker exec -i riverside-os-db pg_restore -U postgres -d riverside_os ...
            let mut d_cmd = Command::new("docker");
            d_cmd
                .arg("exec")
                .arg("-i") // Interactive / use stdin
                .arg("riverside-os-db")
                .arg("pg_restore")
                .arg("-U")
                .arg("postgres")
                .arg("-d")
                .arg("riverside_os")
                .arg("--clean")
                .arg("--if-exists")
                .arg("--no-owner");

            d_cmd
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());

            let mut child = d_cmd
                .spawn()
                .context("Failed to spawn docker exec for pg_restore")?;

            use tokio::io::AsyncWriteExt;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(&dump_data).await?;
                stdin.flush().await?;
            }

            let d_out = child.wait_with_output().await?;

            if d_out.status.success() {
                info!("Database restoration successful via Docker fallback");
                return Ok(());
            } else {
                let d_err = String::from_utf8_lossy(&d_out.stderr);
                error!(stderr = %d_err, "Docker fallback pg_restore also failed");
                return Err(anyhow::anyhow!(
                    "pg_restore failed (host and docker fallback). Host error: {}",
                    err.trim()
                ));
            }
        }

        info!("Database restoration completed successfully");
        Ok(())
    }

    /// Delete a backup file.
    pub fn delete_backup(&self, filename: &str) -> Result<()> {
        let path = self.listed_backup_path(filename)?;
        if path.exists() {
            fs::remove_file(path)?;
            Ok(())
        } else {
            Err(anyhow::anyhow!("File not found"))
        }
    }

    /// Read a cataloged backup file for download.
    pub async fn read_backup_file(&self, filename: &str) -> Result<Vec<u8>> {
        let path = self.listed_backup_path(filename)?;
        tokio::fs::read(&path).await.map_err(Into::into)
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
        let file_path = self.listed_backup_path(filename)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn listed_backup_path_rejects_path_traversal() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let manager = BackupManager {
            backup_dir: tmp.path().to_path_buf(),
            database_url: "postgres://example".to_string(),
        };

        assert!(manager.listed_backup_path("../backup.dump").is_err());
        assert!(manager.listed_backup_path("nested/backup.dump").is_err());
        assert!(manager.listed_backup_path("backup.sql").is_err());
    }

    #[test]
    fn listed_backup_path_accepts_cataloged_dump() {
        let tmp = tempfile::tempdir().expect("tempdir");
        File::create(tmp.path().join("backup_20260425_120000.dump")).expect("backup file");
        let manager = BackupManager {
            backup_dir: tmp.path().to_path_buf(),
            database_url: "postgres://example".to_string(),
        };

        let path = manager
            .listed_backup_path("backup_20260425_120000.dump")
            .expect("listed path");
        assert_eq!(path, tmp.path().join("backup_20260425_120000.dump"));
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
