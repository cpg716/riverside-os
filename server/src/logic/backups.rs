#![allow(clippy::items_after_test_module)]

use anyhow::{Context, Result};
use chrono::{Local, Utc};
use opendal::{
    services::{Dropbox, Gdrive, Onedrive, S3},
    Operator,
};
use ring::aead::{self, Aad, LessSafeKey, UnboundKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgConnectOptions, PgPool, Row};
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex as StdMutex, OnceLock};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tracing::{error, info};
use uuid::Uuid;

const BACKUP_DIR_ENV: &str = "RIVERSIDE_BACKUP_DIR";
const BACKUP_DATABASE_URL_ENV: &str = "RIVERSIDE_BACKUP_DATABASE_URL";
const BACKUP_ENCRYPTION_KEY_ENV: &str = "RIVERSIDE_BACKUP_ENCRYPTION_KEY";
const PG_DUMP_PATH_ENV: &str = "RIVERSIDE_PG_DUMP_PATH";
const PG_RESTORE_PATH_ENV: &str = "RIVERSIDE_PG_RESTORE_PATH";
const BACKUP_DOCKER_FALLBACK_ENV: &str = "RIVERSIDE_BACKUP_ALLOW_DOCKER_FALLBACK";
const ENCRYPTED_BACKUP_EXTENSION: &str = ".dump.enc";
const LEGACY_ENCRYPTED_BACKUP_MAGIC: &[u8] = b"ROSBAK1";
const CHUNKED_ENCRYPTED_BACKUP_MAGIC: &[u8] = b"ROSBAK2";
const CHUNKED_ENCRYPTION_CHUNK_SIZE: usize = 1024 * 1024;
const CLOUD_UPLOAD_BUFFER_SIZE: usize = 1024 * 1024;
const CHUNKED_ENCRYPTION_HEADER_LEN: usize = CHUNKED_ENCRYPTED_BACKUP_MAGIC.len() + 4 + 8 + 8;
const AEAD_TAG_LEN: usize = 16;
const POSTGRES_CUSTOM_ARCHIVE_MAGIC: &[u8] = b"PGDMP";
const BACKUP_ENCRYPTION_KEY_MIN_LEN: usize = 32;
const PG_RESTORE_SAFETY_ARGS: &[&str] = &[
    "--clean",
    "--if-exists",
    "--no-owner",
    "--single-transaction",
];
static BACKUP_OPERATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const POST_RESTORE_SCHEMA_REPAIR_SQL: &[&str] = &[
    r#"ALTER TABLE public.store_settings
        ADD COLUMN IF NOT EXISTS environment_mode text"#,
    r#"UPDATE public.store_settings
        SET environment_mode = 'development'
        WHERE environment_mode IS NULL"#,
    r#"ALTER TABLE public.store_settings
        ALTER COLUMN environment_mode SET DEFAULT 'development'"#,
    r#"ALTER TABLE public.store_settings
        ALTER COLUMN environment_mode SET NOT NULL"#,
    r#"DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'environment_mode_check'
                  AND conrelid = 'public.store_settings'::regclass
            ) THEN
                ALTER TABLE public.store_settings
                    ADD CONSTRAINT environment_mode_check
                    CHECK (environment_mode IN ('development', 'production', 'e2e'));
            END IF;
        END$$"#,
    r#"ALTER TABLE public.store_settings
        ADD COLUMN IF NOT EXISTS active_card_provider text NOT NULL DEFAULT 'helcim'"#,
    r#"UPDATE public.store_settings
        SET active_card_provider = 'helcim'
        WHERE active_card_provider IS NULL
           OR active_card_provider <> 'helcim'"#,
    r#"ALTER TABLE public.store_settings
        DROP CONSTRAINT IF EXISTS store_settings_active_card_provider_chk"#,
    r#"ALTER TABLE public.store_settings
        ADD CONSTRAINT store_settings_active_card_provider_chk
        CHECK (active_card_provider = 'helcim')"#,
    r#"ALTER TABLE public.products
        ADD COLUMN IF NOT EXISTS tax_category_override public.tax_category DEFAULT NULL"#,
    r#"ALTER TABLE public.payment_transactions
        ADD COLUMN IF NOT EXISTS payment_provider varchar(50),
        ADD COLUMN IF NOT EXISTS provider_payment_id varchar(255),
        ADD COLUMN IF NOT EXISTS provider_status varchar(100),
        ADD COLUMN IF NOT EXISTS provider_terminal_id varchar(255),
        ADD COLUMN IF NOT EXISTS provider_transaction_id varchar(255),
        ADD COLUMN IF NOT EXISTS provider_auth_code varchar(100),
        ADD COLUMN IF NOT EXISTS provider_card_type varchar(50)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider_payment_id
        ON public.payment_transactions (payment_provider, provider_payment_id)
        WHERE provider_payment_id IS NOT NULL"#,
    r#"CREATE TABLE IF NOT EXISTS public.customer_relationship_periods (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
        child_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
        linked_at timestamptz NOT NULL DEFAULT now(),
        unlinked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customer_relationship_periods_distinct_profiles
            CHECK (parent_customer_id <> child_customer_id),
        CONSTRAINT customer_relationship_periods_valid_range
            CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
    )"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_relationship_open_parent
        ON public.customer_relationship_periods (parent_customer_id)
        WHERE unlinked_at IS NULL"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_relationship_open_child
        ON public.customer_relationship_periods (child_customer_id)
        WHERE unlinked_at IS NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_customer_relationship_parent_range
        ON public.customer_relationship_periods (parent_customer_id, linked_at DESC, unlinked_at)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_customer_relationship_child_range
        ON public.customer_relationship_periods (child_customer_id, linked_at DESC, unlinked_at)"#,
    r#"CREATE TABLE IF NOT EXISTS public.payment_provider_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        amount_cents bigint NOT NULL,
        currency text NOT NULL DEFAULT 'usd',
        register_session_id uuid REFERENCES public.register_sessions(id) ON DELETE SET NULL,
        staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
        device_id text,
        terminal_id text,
        selected_terminal_key text,
        terminal_route_source text,
        terminal_override_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
        terminal_override_reason text,
        idempotency_key text NOT NULL,
        provider_payment_id text,
        provider_transaction_id text,
        error_code text,
        error_message text,
        raw_audit_reference text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        provider_client_secret text,
        CONSTRAINT payment_provider_attempts_provider_chk
            CHECK (btrim(provider) <> ''),
        CONSTRAINT payment_provider_attempts_status_chk
            CHECK (status IN ('pending', 'approved', 'captured', 'canceled', 'failed', 'expired')),
        CONSTRAINT payment_provider_attempts_amount_cents_chk
            CHECK (amount_cents >= 0),
        CONSTRAINT payment_provider_attempts_currency_chk
            CHECK (currency ~ '^[a-z]{3}$'),
        CONSTRAINT payment_provider_attempts_idempotency_key_chk
            CHECK (btrim(idempotency_key) <> '')
    )"#,
    r#"ALTER TABLE public.payment_provider_attempts
        ADD COLUMN IF NOT EXISTS provider_client_secret text,
        ADD COLUMN IF NOT EXISTS selected_terminal_key text,
        ADD COLUMN IF NOT EXISTS terminal_route_source text,
        ADD COLUMN IF NOT EXISTS terminal_override_staff_id uuid,
        ADD COLUMN IF NOT EXISTS terminal_override_reason text"#,
    r#"DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'payment_provider_attempts_selected_terminal_key_chk'
                  AND conrelid = 'public.payment_provider_attempts'::regclass
            ) THEN
                ALTER TABLE public.payment_provider_attempts
                    ADD CONSTRAINT payment_provider_attempts_selected_terminal_key_chk
                    CHECK (
                        selected_terminal_key IS NULL
                        OR selected_terminal_key IN ('terminal_1', 'terminal_2')
                    );
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'payment_provider_attempts_terminal_route_source_chk'
                  AND conrelid = 'public.payment_provider_attempts'::regclass
            ) THEN
                ALTER TABLE public.payment_provider_attempts
                    ADD CONSTRAINT payment_provider_attempts_terminal_route_source_chk
                    CHECK (
                        terminal_route_source IS NULL
                        OR terminal_route_source IN ('default', 'required_choice', 'override')
                    );
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'payment_provider_attempts_terminal_override_staff_id_fkey'
                  AND conrelid = 'public.payment_provider_attempts'::regclass
            ) THEN
                ALTER TABLE public.payment_provider_attempts
                    ADD CONSTRAINT payment_provider_attempts_terminal_override_staff_id_fkey
                    FOREIGN KEY (terminal_override_staff_id)
                    REFERENCES public.staff(id)
                    ON DELETE SET NULL;
            END IF;
        END$$"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_attempts_provider_idempotency
        ON public.payment_provider_attempts (provider, idempotency_key)"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_attempts_active_device
        ON public.payment_provider_attempts (provider, COALESCE(terminal_id, device_id))
        WHERE status = 'pending'
          AND COALESCE(terminal_id, device_id) IS NOT NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_provider_status_created
        ON public.payment_provider_attempts (provider, status, created_at DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_register_created
        ON public.payment_provider_attempts (register_session_id, created_at DESC)
        WHERE register_session_id IS NOT NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_staff_created
        ON public.payment_provider_attempts (staff_id, created_at DESC)
        WHERE staff_id IS NOT NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_terminal_created
        ON public.payment_provider_attempts (provider, terminal_id, created_at DESC)
        WHERE terminal_id IS NOT NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_device_created
        ON public.payment_provider_attempts (provider, device_id, created_at DESC)
        WHERE device_id IS NOT NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_provider_payment
        ON public.payment_provider_attempts (provider, provider_payment_id)
        WHERE provider_payment_id IS NOT NULL"#,
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupSettings {
    pub auto_cleanup_days: u32,
    pub schedule_cron: String,
    pub cloud_storage_enabled: bool,
    pub cloud_bucket_name: String,
    pub cloud_region: String,
    pub cloud_endpoint: String,
    #[serde(default = "default_cloud_provider")]
    pub cloud_provider: String,
    #[serde(default)]
    pub cloud_root: String,
    #[serde(default)]
    pub replication_targets: Vec<String>,
    #[serde(default)]
    pub encryption_enabled: bool,
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
            cloud_provider: default_cloud_provider(),
            cloud_root: "".to_string(),
            replication_targets: Vec::new(),
            encryption_enabled: false,
        }
    }
}

impl BackupSettings {
    pub fn try_from_json(value: serde_json::Value) -> Result<Self, String> {
        let settings: Self = serde_json::from_value(value)
            .map_err(|error| format!("Stored backup settings are invalid: {error}"))?;
        if parse_daily_backup_schedule(&settings.schedule_cron).is_none() {
            return Err(
                "Stored backup schedule must use daily minute/hour format: minute hour * * *"
                    .to_string(),
            );
        }
        Ok(settings)
    }
}

pub fn parse_daily_backup_schedule(schedule: &str) -> Option<(u32, u32)> {
    let mut parts = schedule.split_whitespace();
    let minute = parts.next()?.parse::<u32>().ok()?;
    let hour = parts.next()?.parse::<u32>().ok()?;
    if parts.next()? != "*" || parts.next()? != "*" || parts.next()? != "*" {
        return None;
    }
    if parts.next().is_some() || minute > 59 || hour > 23 {
        return None;
    }
    Some((hour, minute))
}

pub fn daily_backup_schedule_matches_time(schedule: &str, time_hh_mm: &str) -> bool {
    let Some((hour, minute)) = parse_daily_backup_schedule(schedule) else {
        return false;
    };
    time_hh_mm == format!("{hour:02}:{minute:02}")
}

fn default_cloud_provider() -> String {
    "s3".to_string()
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

fn select_backup_database_url(
    runtime_database_url: &str,
    configured_backup_database_url: Option<&str>,
) -> String {
    configured_backup_database_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(runtime_database_url)
        .to_string()
}

fn backup_database_url(runtime_database_url: &str) -> String {
    let configured = std::env::var(BACKUP_DATABASE_URL_ENV).ok();
    select_backup_database_url(runtime_database_url, configured.as_deref())
}

pub fn backup_database_url_configured() -> bool {
    std::env::var(BACKUP_DATABASE_URL_ENV)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
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
            if path.is_file() && is_backup_archive_path(&path) {
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
        if !is_safe_backup_catalog_name(trimmed) {
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
        self.create_backup_with_settings(&BackupSettings::default())
            .await
    }

    pub async fn create_backup_with_settings(&self, settings: &BackupSettings) -> Result<String> {
        let _operation_guard = BACKUP_OPERATION_LOCK.lock().await;
        let filename = new_backup_filename();
        let output_path = self
            .backup_dir
            .join(format!(".{filename}.partial-{}", Uuid::new_v4().simple()));
        let _partial_file = PendingBackupFile::new(output_path.clone());

        info!(filename = %filename, "Starting database backup to a non-catalog partial file");

        // We use the full connection string directly with pg_dump -d
        // -F c: Custom-format archive suitable for input into pg_restore.
        //
        // Never use `.stderr(piped())` with `.status()` — nothing reads the pipe, the read end
        // can close, and pg_dump gets SIGPIPE while writing warnings/progress to stderr.
        let pg_dump = pg_dump_command_path();
        let operation_database_url = backup_database_url(&self.database_url);
        let mut cmd = Command::new(&pg_dump);
        cmd.arg("-d")
            .arg(&operation_database_url)
            .arg("-F")
            .arg("c")
            .arg("-f")
            .arg(&output_path);

        let out = match cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
        {
            Ok(out) => out,
            Err(err) => {
                error!(error = %err, pg_dump = %pg_dump, "Failed to execute PostgreSQL pg_dump");
                if docker_backup_fallback_allowed()
                    && self.write_backup_with_docker(&output_path).await?
                {
                    let filename = self
                        .verify_and_finalize_backup_archive(&output_path, filename, settings)
                        .await?;
                    info!("Backup successful via Docker fallback: {}", filename);
                    return Ok(filename);
                }
                return Err(err).with_context(|| {
                    format!(
                        "Failed to execute pg_dump. Install PostgreSQL client tools or set {PG_DUMP_PATH_ENV} to the full pg_dump path."
                    )
                });
            }
        };

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);

            // Check for version mismatch error
            if err.contains("server version mismatch") {
                info!("pg_dump version mismatch detected; attempting fallback via Docker...");
                if docker_backup_fallback_allowed()
                    && self.write_backup_with_docker(&output_path).await?
                {
                    let filename = self
                        .verify_and_finalize_backup_archive(&output_path, filename, settings)
                        .await?;
                    info!("Backup successful via Docker fallback: {}", filename);
                    return Ok(filename);
                }
            }

            error!(stderr = %err, status = %out.status, "pg_dump failed");
            let detail = err.trim();
            if detail.is_empty() {
                return Err(anyhow::anyhow!("pg_dump failed ({})", out.status));
            }
            return Err(anyhow::anyhow!("pg_dump failed: {detail}"));
        }

        let filename = self
            .verify_and_finalize_backup_archive(&output_path, filename, settings)
            .await?;
        info!("Database backup completed successfully: {}", filename);
        Ok(filename)
    }

    async fn verify_and_finalize_backup_archive(
        &self,
        partial_path: &Path,
        filename: String,
        settings: &BackupSettings,
    ) -> Result<String> {
        self.verify_plain_backup_archive(partial_path).await?;
        self.finalize_backup_archive(partial_path, filename, settings)
            .await
    }

    async fn verify_plain_backup_archive(&self, path: &Path) -> Result<()> {
        let metadata = fs::metadata(path)
            .with_context(|| format!("Backup verification could not read {}", path.display()))?;
        if metadata.len() <= POSTGRES_CUSTOM_ARCHIVE_MAGIC.len() as u64 {
            return Err(anyhow::anyhow!(
                "Backup verification failed: archive is empty or incomplete"
            ));
        }

        let mut file = fs::File::open(path)?;
        let mut magic = [0u8; POSTGRES_CUSTOM_ARCHIVE_MAGIC.len()];
        file.read_exact(&mut magic)?;
        if magic != POSTGRES_CUSTOM_ARCHIVE_MAGIC {
            return Err(anyhow::anyhow!(
                "Backup verification failed: archive is not a PostgreSQL custom-format dump"
            ));
        }

        let pg_restore = pg_restore_command_path();
        match Command::new(&pg_restore)
            .arg("--list")
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
        {
            Ok(output) if output.status.success() => Ok(()),
            Ok(output) => {
                if docker_backup_fallback_allowed() && self.verify_backup_with_docker(path).await? {
                    return Ok(());
                }
                let detail = String::from_utf8_lossy(&output.stderr);
                Err(anyhow::anyhow!(
                    "Backup verification failed: {}",
                    detail.trim()
                ))
            }
            Err(error) => {
                if docker_backup_fallback_allowed() && self.verify_backup_with_docker(path).await? {
                    return Ok(());
                }
                Err(error).with_context(|| {
                    format!(
                        "Failed to execute pg_restore for backup verification. Install PostgreSQL client tools or set {PG_RESTORE_PATH_ENV} to the full pg_restore path."
                    )
                })
            }
        }
    }

    async fn verify_backup_with_docker(&self, path: &Path) -> Result<bool> {
        let mut command = Command::new("docker");
        command
            .arg("exec")
            .arg("-i")
            .arg("riverside-os-db")
            .arg("pg_restore")
            .arg("--list")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                tracing::warn!(error = %error, "Failed to start Docker backup verification");
                return Ok(false);
            }
        };
        let mut dump_file = tokio::fs::File::open(path).await?;
        let mut stdin = child
            .stdin
            .take()
            .context("Docker backup verification stdin was unavailable")?;
        let stream_task = tokio::spawn(async move {
            let copied = tokio::io::copy(&mut dump_file, &mut stdin).await?;
            use tokio::io::AsyncWriteExt;
            stdin.shutdown().await?;
            Ok::<u64, std::io::Error>(copied)
        });
        let output = child.wait_with_output().await?;
        if output.status.success() {
            stream_task
                .await
                .context("Docker backup verification stream task failed")??;
            return Ok(true);
        }
        let _ = stream_task.await;
        tracing::warn!(
            stderr = %String::from_utf8_lossy(&output.stderr),
            "Docker backup verification failed"
        );
        Ok(false)
    }

    async fn write_backup_with_docker(&self, output_path: &Path) -> Result<bool> {
        let database_name = docker_backup_database_name(&self.database_url)?;
        let mut command = Command::new("docker");
        command
            .arg("exec")
            .arg("riverside-os-db")
            .arg("pg_dump")
            .arg("-U")
            .arg("postgres")
            .arg("-F")
            .arg("c")
            .arg("--dbname")
            .arg(&database_name)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                error!(%error, "Failed to initiate Docker pg_dump fallback");
                return Ok(false);
            }
        };
        let mut stdout = child
            .stdout
            .take()
            .context("Docker pg_dump stdout was unavailable")?;
        let output_file = tokio::fs::File::create(output_path).await?;
        let stream_task = tokio::spawn(async move {
            let mut output_file = output_file;
            let copied = tokio::io::copy(&mut stdout, &mut output_file).await?;
            output_file.sync_all().await?;
            Ok::<u64, std::io::Error>(copied)
        });
        let output = child.wait_with_output().await?;
        if output.status.success() {
            stream_task
                .await
                .context("Docker pg_dump stream task failed")??;
            return Ok(true);
        }
        let _ = stream_task.await;
        error!(
            stderr = %String::from_utf8_lossy(&output.stderr),
            "Docker fallback pg_dump failed"
        );
        Ok(false)
    }

    async fn finalize_backup_archive(
        &self,
        partial_path: &Path,
        filename: String,
        settings: &BackupSettings,
    ) -> Result<String> {
        if !settings.encryption_enabled {
            tokio::fs::rename(partial_path, self.backup_dir.join(&filename))
                .await
                .with_context(|| {
                    format!("Failed to atomically finalize verified backup {filename}")
                })?;
            return Ok(filename);
        }
        let encrypted_filename = format!("{filename}.enc");
        let encrypted_path = self.backup_dir.join(&encrypted_filename);
        let encrypted_partial_path = self.backup_dir.join(format!(
            ".{encrypted_filename}.partial-{}",
            Uuid::new_v4().simple()
        ));
        let _encrypted_partial_file = PendingBackupFile::new(encrypted_partial_path.clone());
        let encryption_source = partial_path.to_path_buf();
        let encryption_destination = encrypted_partial_path.clone();
        tokio::task::spawn_blocking(move || {
            encrypt_backup_file(&encryption_source, &encryption_destination)
        })
        .await
        .context("Backup encryption task failed")??;
        tokio::fs::rename(&encrypted_partial_path, &encrypted_path)
            .await
            .with_context(|| {
                format!("Failed to atomically finalize encrypted backup {encrypted_filename}")
            })?;
        tokio::fs::remove_file(partial_path)
            .await
            .with_context(|| {
                format!(
                    "Encrypted backup was created but plaintext cleanup failed: {}",
                    partial_path.to_string_lossy()
                )
            })?;
        Ok(encrypted_filename)
    }

    /// Restore a database from a backup using pg_restore.
    /// WARNING: This is destructive.
    pub async fn restore_backup(&self, filename: &str) -> Result<()> {
        let _operation_guard = BACKUP_OPERATION_LOCK.lock().await;
        let input_path = self.listed_backup_path(filename)?;
        if !input_path.exists() {
            return Err(anyhow::anyhow!("Backup file not found"));
        }
        let mut decrypted_temp: Option<RestoreTemp> = None;
        let restore_path = if is_encrypted_backup_name(filename) {
            let tmp = self
                .backup_dir
                .join(format!("{filename}.restore-{}.tmp", Uuid::new_v4()));
            let encrypted_path = input_path.clone();
            let decrypted_path = tmp.clone();
            tokio::task::spawn_blocking(move || {
                decrypt_backup_file(&encrypted_path, &decrypted_path)
            })
            .await
            .context("Backup decryption task failed")??;
            decrypted_temp = Some(RestoreTemp { path: tmp.clone() });
            tmp
        } else {
            input_path.clone()
        };
        self.verify_plain_backup_archive(&restore_path).await?;

        info!("Starting database restore from {:?}", restore_path);

        // -c: Clean (drop) database objects before recreating them.
        // -d: Connect to database.
        // --if-exists: Use IF EXISTS when dropping objects.
        // --no-owner: Skip restoration of object ownership.
        let pg_restore = pg_restore_command_path();
        let operation_database_url = backup_database_url(&self.database_url);
        let mut cmd = Command::new(&pg_restore);
        cmd.arg("-d")
            .arg(&operation_database_url)
            .args(PG_RESTORE_SAFETY_ARGS)
            .arg(&restore_path);

        let host_restore_error = match cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
        {
            Ok(out) if out.status.success() => None,
            Ok(out) => {
                let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
                error!(stderr = %detail, status = %out.status, "Host pg_restore failed");
                Some(if detail.is_empty() {
                    format!("pg_restore failed ({})", out.status)
                } else {
                    format!("pg_restore failed: {detail}")
                })
            }
            Err(error) => {
                error!(error = %error, pg_restore = %pg_restore, "Failed to execute PostgreSQL pg_restore");
                Some(format!(
                    "Failed to execute pg_restore. Install PostgreSQL client tools or set {PG_RESTORE_PATH_ENV} to the full pg_restore path: {error}"
                ))
            }
        };

        if let Some(host_restore_error) = host_restore_error {
            if !docker_backup_fallback_allowed() {
                return Err(anyhow::anyhow!(host_restore_error));
            }
            let database_name = docker_backup_database_name(&self.database_url)?;
            info!("Attempting explicitly enabled Docker pg_restore fallback");

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
                .arg(&database_name)
                .args(PG_RESTORE_SAFETY_ARGS);

            d_cmd
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true);

            let mut child = d_cmd
                .spawn()
                .context("Failed to spawn docker exec for pg_restore")?;

            let mut dump_file = tokio::fs::File::open(&restore_path).await?;
            let mut stdin = child
                .stdin
                .take()
                .context("Docker pg_restore stdin was unavailable")?;
            let stream_task = tokio::spawn(async move {
                let copied = tokio::io::copy(&mut dump_file, &mut stdin).await?;
                use tokio::io::AsyncWriteExt;
                stdin.shutdown().await?;
                Ok::<u64, std::io::Error>(copied)
            });

            let d_out = child.wait_with_output().await?;

            if d_out.status.success() {
                stream_task
                    .await
                    .context("Docker pg_restore stream task failed")??;
                info!("Database restoration successful via Docker fallback");
                self.apply_post_restore_schema_repairs().await?;
                self.validate_schema_after_restore().await?;
                drop(decrypted_temp);
                return Ok(());
            } else {
                let _ = stream_task.await;
                let d_err = String::from_utf8_lossy(&d_out.stderr);
                error!(stderr = %d_err, "Docker fallback pg_restore also failed");
                return Err(anyhow::anyhow!(
                    "Docker pg_restore failed; the single transaction was rolled back: {}",
                    d_err.trim()
                ));
            }
        }

        info!("Database restoration completed successfully");
        self.apply_post_restore_schema_repairs().await?;
        self.validate_schema_after_restore().await?;
        drop(decrypted_temp);
        Ok(())
    }

    async fn apply_post_restore_schema_repairs(&self) -> Result<()> {
        let pool = PgPool::connect(&self.database_url)
            .await
            .context("Failed to connect for post-restore schema repair")?;

        for sql in POST_RESTORE_SCHEMA_REPAIR_SQL {
            sqlx::query(sql)
                .execute(&pool)
                .await
                .context("Failed to apply post-restore schema repair")?;
        }

        info!("Post-restore schema compatibility repair completed");
        Ok(())
    }

    async fn validate_schema_after_restore(&self) -> Result<()> {
        let pool = PgPool::connect(&self.database_url)
            .await
            .context("Failed to connect for post-restore schema validation")?;
        crate::schema_bootstrap::ensure_core_schema(&pool)
            .await
            .context("Restore completed but the in-binary schema contract validation failed")?;
        info!("Post-restore in-binary schema contract validation passed");
        Ok(())
    }

    /// Delete a backup file while invalidating evidence for that exact artifact in the same
    /// serialized operation. Readiness also checks the file directly, so a process interruption
    /// between the filesystem removal and database commit still fails closed.
    pub async fn delete_backup_and_invalidate_evidence(
        &self,
        pool: &PgPool,
        filename: &str,
    ) -> Result<()> {
        let _operation_guard = BACKUP_OPERATION_LOCK.lock().await;
        let path = self.listed_backup_path(filename)?;
        let mut transaction = pool.begin().await?;
        sqlx::query(
            r#"
            UPDATE store_backup_health
            SET last_local_verified_at = NULL,
                last_local_verified_filename = NULL,
                last_local_verification_method = NULL,
                last_local_verified_size_bytes = NULL,
                last_local_verified_sha256 = NULL,
                updated_at = NOW()
            WHERE id = 1
              AND last_local_verified_filename = $1
            "#,
        )
        .bind(filename)
        .execute(&mut *transaction)
        .await?;
        tokio::fs::remove_file(&path).await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Open a cataloged backup file for bounded-memory HTTP streaming.
    pub async fn open_backup_file(&self, filename: &str) -> Result<(tokio::fs::File, u64)> {
        let path = self.listed_backup_path(filename)?;
        let file = tokio::fs::File::open(&path).await?;
        let size_bytes = file.metadata().await?.len();
        Ok((file, size_bytes))
    }

    /// Auto-cleanup local backups older than max_days.
    /// Uses tokio::fs for optimized non-blocking filesystem operations.
    pub async fn perform_auto_cleanup(&self, pool: &PgPool, max_days: u32) -> Result<u32> {
        if max_days == 0 {
            return Ok(0);
        }

        let _operation_guard = BACKUP_OPERATION_LOCK.lock().await;
        let mut deleted_count = 0;
        let mut entries = tokio::fs::read_dir(&self.backup_dir).await?;
        let now = Utc::now();
        let max_age = chrono::Duration::days(max_days as i64);

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() && is_backup_archive_path(&path) {
                let metadata = entry.metadata().await?;
                let modified: chrono::DateTime<Utc> = metadata.modified()?.into();

                if now.signed_duration_since(modified) > max_age {
                    let filename = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .context("Backup cleanup encountered a non-UTF-8 filename")?
                        .to_string();
                    info!(
                        "Auto-cleanup: Deleting old backup {:?}",
                        path.file_name().unwrap_or_default()
                    );
                    let mut transaction = pool.begin().await?;
                    sqlx::query(
                        r#"
                        UPDATE store_backup_health
                        SET last_local_verified_at = NULL,
                            last_local_verified_filename = NULL,
                            last_local_verification_method = NULL,
                            last_local_verified_size_bytes = NULL,
                            last_local_verified_sha256 = NULL,
                            updated_at = NOW()
                        WHERE id = 1
                          AND last_local_verified_filename = $1
                        "#,
                    )
                    .bind(&filename)
                    .execute(&mut *transaction)
                    .await?;
                    tokio::fs::remove_file(&path).await?;
                    transaction.commit().await?;
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
        if !settings.cloud_storage_enabled {
            return Ok(());
        }
        let op = cloud_operator(settings)?;
        let file_path = self.listed_backup_path(filename)?;
        let mut source = tokio::fs::File::open(&file_path).await?;

        info!(
            provider = %settings.cloud_provider,
            "Cloud Sync: Uploading {}",
            filename
        );

        let mut writer = op.writer(filename).await?;
        let mut buffer = vec![0u8; CLOUD_UPLOAD_BUFFER_SIZE];
        let mut uploaded_size = 0u64;
        let mut uploaded_hasher = Sha256::new();
        loop {
            let read = match source.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    let _ = writer.abort().await;
                    return Err(error).context("Failed to read local backup during cloud upload");
                }
            };
            if read == 0 {
                break;
            }
            uploaded_size = uploaded_size
                .checked_add(read as u64)
                .context("Cloud backup size overflowed during upload")?;
            uploaded_hasher.update(&buffer[..read]);
            if let Err(error) = writer.write(buffer[..read].to_vec()).await {
                let _ = writer.abort().await;
                return Err(error).context("Cloud backup upload failed");
            }
        }
        if let Err(error) = writer.close().await {
            let _ = writer.abort().await;
            return Err(error).context("Cloud backup upload could not be finalized");
        }

        let uploaded_sha256 = format!("{:x}", uploaded_hasher.finalize());
        if let Err(verification_error) =
            verify_cloud_backup(&op, filename, uploaded_size, &uploaded_sha256).await
        {
            if let Err(cleanup_error) = op.delete(filename).await {
                error!(
                    backup = filename,
                    error = %cleanup_error,
                    "Cloud backup verification failed and the invalid object could not be removed"
                );
            }
            return Err(verification_error).context("Cloud backup read-back verification failed");
        }

        info!(
            size_bytes = uploaded_size,
            sha256 = %uploaded_sha256,
            "Cloud Sync: Uploaded and read-back verified {}",
            filename,
        );

        Ok(())
    }

    pub async fn replicate_to_targets(
        &self,
        filename: &str,
        settings: &BackupSettings,
    ) -> Result<usize> {
        let source = self.listed_backup_path(filename)?;
        let (source_size, source_hash) = file_size_and_sha256(source.clone()).await?;
        let mut copied = 0usize;

        for target in settings
            .replication_targets
            .iter()
            .map(|target| target.trim())
            .filter(|target| !target.is_empty())
        {
            let target_dir = PathBuf::from(target);
            tokio::fs::create_dir_all(&target_dir)
                .await
                .with_context(|| format!("Backup replication target is not writable: {target}"))?;
            if !tokio::fs::metadata(&target_dir).await?.is_dir() {
                return Err(anyhow::anyhow!(
                    "Backup replication target is not a directory: {target}"
                ));
            }

            let final_path = target_dir.join(filename);
            let temp_path = target_dir.join(format!("{filename}.tmp"));
            if tokio::fs::try_exists(&temp_path).await? {
                tokio::fs::remove_file(&temp_path).await?;
            }
            tokio::fs::copy(&source, &temp_path)
                .await
                .with_context(|| format!("Failed to copy backup into {target}"))?;

            let file = tokio::fs::OpenOptions::new()
                .read(true)
                .open(&temp_path)
                .await?;
            file.sync_all().await?;
            drop(file);

            let copied_identity = file_size_and_sha256(temp_path.clone()).await;
            let (copied_size, copied_hash) = match copied_identity {
                Ok(identity) => identity,
                Err(error) => {
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    return Err(error).with_context(|| {
                        format!("Failed to verify replicated backup in {target}")
                    });
                }
            };
            if copied_size != source_size || copied_hash != source_hash {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(anyhow::anyhow!(
                    "Backup replication verification failed for {target}"
                ));
            }

            tokio::fs::rename(&temp_path, &final_path).await?;
            copied += 1;
        }

        Ok(copied)
    }
}

async fn verify_cloud_backup(
    operator: &Operator,
    filename: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<()> {
    let metadata = operator
        .stat(filename)
        .await
        .with_context(|| format!("Cloud backup metadata is unavailable for {filename}"))?;
    if metadata.content_length() != expected_size {
        return Err(anyhow::anyhow!(
            "Cloud backup size mismatch for {filename}: expected {expected_size} bytes, found {}",
            metadata.content_length()
        ));
    }

    let reader = operator
        .reader(filename)
        .await
        .with_context(|| format!("Cloud backup cannot be opened for verification: {filename}"))?;
    let mut offset = 0u64;
    let mut hasher = Sha256::new();
    while offset < expected_size {
        let end = offset
            .saturating_add(CLOUD_UPLOAD_BUFFER_SIZE as u64)
            .min(expected_size);
        let chunk = reader
            .read(offset..end)
            .await
            .with_context(|| format!("Cloud backup read-back failed for {filename}"))?;
        let bytes = chunk.to_bytes();
        let expected_chunk_size = (end - offset) as usize;
        if bytes.len() != expected_chunk_size {
            return Err(anyhow::anyhow!(
                "Cloud backup read-back was incomplete for {filename}: expected {expected_chunk_size} bytes at offset {offset}, found {}",
                bytes.len()
            ));
        }
        hasher.update(&bytes);
        offset = end;
    }

    let observed_sha256 = format!("{:x}", hasher.finalize());
    if observed_sha256 != expected_sha256 {
        return Err(anyhow::anyhow!(
            "Cloud backup SHA-256 mismatch for {filename}"
        ));
    }

    Ok(())
}

fn required_env(key: &str) -> Result<String> {
    std::env::var(key)
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{key} must be set for cloud backup integration"))
}

fn optional_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn configured_postgres_tool_path(env_key: &str) -> Option<String> {
    std::env::var(env_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn executable_on_path(tool_name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{tool_name}.exe"), tool_name.to_string()]
    } else {
        vec![tool_name.to_string()]
    };
    std::env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

fn common_postgres_tool_path(tool_name: &str) -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        format!("{tool_name}.exe")
    } else {
        tool_name.to_string()
    };
    let mut candidates = Vec::new();

    if cfg!(windows) {
        for root_key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(root_key) {
                for version in ["18", "17", "16", "15", "14", "13", "12"] {
                    candidates.push(
                        PathBuf::from(&root)
                            .join("PostgreSQL")
                            .join(version)
                            .join("bin")
                            .join(&executable),
                    );
                }
            }
        }
    } else {
        candidates.extend([
            PathBuf::from("/opt/homebrew/opt/libpq/bin").join(&executable),
            PathBuf::from("/usr/local/opt/libpq/bin").join(&executable),
            PathBuf::from("/Applications/Postgres.app/Contents/Versions/latest/bin")
                .join(&executable),
            PathBuf::from("/Library/PostgreSQL/16/bin").join(&executable),
            PathBuf::from("/usr/bin").join(&executable),
            PathBuf::from("/usr/local/bin").join(&executable),
        ]);
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn postgres_tool_command_path(tool_name: &str, env_key: &str) -> String {
    configured_postgres_tool_path(env_key)
        .or_else(|| {
            executable_on_path(tool_name)
                .or_else(|| common_postgres_tool_path(tool_name))
                .map(|path| path.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| tool_name.to_string())
}

fn command_path_is_available(command: &str) -> bool {
    let path = Path::new(command);
    if path.is_absolute() || path.components().count() > 1 {
        path.is_file()
    } else {
        executable_on_path(command).is_some()
    }
}

fn parse_postgres_tool_major(version_output: &str) -> Option<u32> {
    version_output
        .split_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        })
        .and_then(|version| version.split('.').next())
        .and_then(|major| major.parse::<u32>().ok())
}

fn postgres_tool_major(command: &str) -> Option<u32> {
    if !command_path_is_available(command) {
        return None;
    }
    let output = std::process::Command::new(command)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_postgres_tool_major(&String::from_utf8_lossy(&output.stdout))
}

fn postgres_tool_versions_compatible(
    pg_dump_major: u32,
    pg_restore_major: u32,
    server_major: Option<u32>,
) -> bool {
    pg_dump_major == pg_restore_major
        && server_major.is_none_or(|server_major| pg_dump_major >= server_major)
}

fn detected_postgres_tool_versions() -> Option<(u32, u32)> {
    static DETECTED_TOOL_VERSIONS: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    if let Some(versions) = DETECTED_TOOL_VERSIONS.get() {
        return Some(*versions);
    }
    let versions = (
        postgres_tool_major(&pg_dump_command_path())?,
        postgres_tool_major(&pg_restore_command_path())?,
    );
    let _ = DETECTED_TOOL_VERSIONS.set(versions);
    Some(versions)
}

fn pg_dump_command_path() -> String {
    postgres_tool_command_path("pg_dump", PG_DUMP_PATH_ENV)
}

fn pg_restore_command_path() -> String {
    postgres_tool_command_path("pg_restore", PG_RESTORE_PATH_ENV)
}

pub fn backup_tooling_compatible_with_server(server_major: Option<u32>) -> bool {
    let Some((pg_dump_major, pg_restore_major)) = detected_postgres_tool_versions() else {
        return false;
    };
    postgres_tool_versions_compatible(pg_dump_major, pg_restore_major, server_major)
}

pub fn backup_tooling_available() -> bool {
    backup_tooling_compatible_with_server(None)
}

fn docker_backup_database_name(database_url: &str) -> Result<String> {
    let parsed_url = url::Url::parse(database_url).map_err(|_| {
        anyhow::anyhow!("Docker backup fallback requires a valid PostgreSQL database URL")
    })?;
    if !matches!(parsed_url.scheme(), "postgres" | "postgresql") {
        return Err(anyhow::anyhow!(
            "Docker backup fallback requires a valid PostgreSQL database URL"
        ));
    }

    let has_explicit_database = !parsed_url.path().trim_start_matches('/').is_empty()
        || parsed_url
            .query_pairs()
            .any(|(key, value)| key == "dbname" && !value.is_empty());
    if !has_explicit_database {
        return Err(anyhow::anyhow!(
            "Docker backup fallback requires DATABASE_URL to include an explicit database name"
        ));
    }

    let options = database_url.parse::<PgConnectOptions>().map_err(|_| {
        anyhow::anyhow!("Docker backup fallback requires a valid PostgreSQL database URL")
    })?;
    options
        .get_database()
        .filter(|database| !database.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Docker backup fallback requires DATABASE_URL to include an explicit database name"
            )
        })
}

fn docker_backup_fallback_allowed() -> bool {
    let strict_production = std::env::var("RIVERSIDE_STRICT_PRODUCTION")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if strict_production {
        return false;
    }
    std::env::var(BACKUP_DOCKER_FALLBACK_ENV)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn cloud_operator(settings: &BackupSettings) -> Result<Operator> {
    match settings.cloud_provider.trim().to_ascii_lowercase().as_str() {
        "" | "s3" | "s3_compatible" => {
            if settings.cloud_bucket_name.trim().is_empty() {
                return Err(anyhow::anyhow!(
                    "Cloud backup is enabled but the bucket name is blank"
                ));
            }
            let access_key = required_env("BACKUP_S3_ACCESS_KEY")?;
            let secret_key = required_env("BACKUP_S3_SECRET_KEY")?;
            let mut builder = S3::default();
            builder = builder.bucket(settings.cloud_bucket_name.trim());
            builder = builder.region(settings.cloud_region.trim());
            builder = builder.access_key_id(&access_key);
            builder = builder.secret_access_key(&secret_key);
            if !settings.cloud_endpoint.trim().is_empty() {
                builder = builder.endpoint(settings.cloud_endpoint.trim());
            }
            Ok(Operator::new(builder)?)
        }
        "dropbox" => {
            let mut builder = Dropbox::default().root(settings.cloud_root.trim());
            if let Some(access_token) = optional_env("BACKUP_CLOUD_ACCESS_TOKEN") {
                builder = builder.access_token(&access_token);
            }
            if let Some(refresh_token) = optional_env("BACKUP_CLOUD_REFRESH_TOKEN") {
                builder = builder.refresh_token(&refresh_token);
                builder = builder.client_id(&required_env("BACKUP_CLOUD_CLIENT_ID")?);
                builder = builder.client_secret(&required_env("BACKUP_CLOUD_CLIENT_SECRET")?);
            }
            require_cloud_oauth_material("Dropbox")?;
            Ok(Operator::new(builder)?)
        }
        "google_drive" | "gdrive" => {
            let mut builder = Gdrive::default().root(settings.cloud_root.trim());
            if let Some(access_token) = optional_env("BACKUP_CLOUD_ACCESS_TOKEN") {
                builder = builder.access_token(&access_token);
            }
            if let Some(refresh_token) = optional_env("BACKUP_CLOUD_REFRESH_TOKEN") {
                builder = builder.refresh_token(&refresh_token);
                builder = builder.client_id(&required_env("BACKUP_CLOUD_CLIENT_ID")?);
                builder = builder.client_secret(&required_env("BACKUP_CLOUD_CLIENT_SECRET")?);
            }
            require_cloud_oauth_material("Google Drive")?;
            Ok(Operator::new(builder)?)
        }
        "onedrive" | "one_drive" => {
            let mut builder = Onedrive::default().root(settings.cloud_root.trim());
            if let Some(access_token) = optional_env("BACKUP_CLOUD_ACCESS_TOKEN") {
                builder = builder.access_token(&access_token);
            }
            if let Some(refresh_token) = optional_env("BACKUP_CLOUD_REFRESH_TOKEN") {
                builder = builder.refresh_token(&refresh_token);
                builder = builder.client_id(&required_env("BACKUP_CLOUD_CLIENT_ID")?);
                if let Some(client_secret) = optional_env("BACKUP_CLOUD_CLIENT_SECRET") {
                    builder = builder.client_secret(&client_secret);
                }
            }
            require_cloud_oauth_material("OneDrive")?;
            Ok(Operator::new(builder)?)
        }
        other => Err(anyhow::anyhow!(
            "Unsupported cloud backup provider: {other}"
        )),
    }
}

fn require_cloud_oauth_material(provider: &str) -> Result<()> {
    if optional_env("BACKUP_CLOUD_ACCESS_TOKEN").is_some() {
        return Ok(());
    }
    if optional_env("BACKUP_CLOUD_REFRESH_TOKEN").is_some()
        && optional_env("BACKUP_CLOUD_CLIENT_ID").is_some()
    {
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "{provider} backup requires BACKUP_CLOUD_ACCESS_TOKEN or BACKUP_CLOUD_REFRESH_TOKEN plus BACKUP_CLOUD_CLIENT_ID"
    ))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 64];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn file_size_and_sha256(path: PathBuf) -> Result<(u64, String)> {
    tokio::task::spawn_blocking(move || {
        let size = fs::metadata(&path)?.len();
        let sha256 = sha256_file(&path)?;
        Ok((size, sha256))
    })
    .await
    .context("Backup artifact identity task failed")?
}

fn is_encrypted_backup_name(filename: &str) -> bool {
    filename.ends_with(ENCRYPTED_BACKUP_EXTENSION)
}

fn new_backup_filename() -> String {
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    format!("backup_{timestamp}_{}.dump", Uuid::new_v4().simple())
}

fn is_backup_archive_name(filename: &str) -> bool {
    filename.ends_with(".dump") || is_encrypted_backup_name(filename)
}

fn is_backup_archive_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(is_backup_archive_name)
        .unwrap_or(false)
}

fn is_safe_backup_catalog_name(filename: &str) -> bool {
    !filename.is_empty()
        && !filename.contains("..")
        && filename.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
        && is_backup_archive_name(filename)
}

fn backup_encryption_key() -> Result<LessSafeKey> {
    let raw = std::env::var(BACKUP_ENCRYPTION_KEY_ENV).with_context(|| {
        format!("{BACKUP_ENCRYPTION_KEY_ENV} must be set when backup encryption is enabled")
    })?;
    let trimmed = raw.trim();
    if trimmed.len() < BACKUP_ENCRYPTION_KEY_MIN_LEN {
        return Err(anyhow::anyhow!(
            "{BACKUP_ENCRYPTION_KEY_ENV} must be at least {BACKUP_ENCRYPTION_KEY_MIN_LEN} characters"
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    let material = hasher.finalize();
    let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, material.as_slice())
        .map_err(|_| anyhow::anyhow!("failed to initialize backup encryption key"))?;
    Ok(LessSafeKey::new(unbound))
}

fn chunk_nonce(prefix: [u8; 8], chunk_index: u32) -> aead::Nonce {
    let mut nonce = [0u8; 12];
    nonce[..8].copy_from_slice(&prefix);
    nonce[8..].copy_from_slice(&chunk_index.to_be_bytes());
    aead::Nonce::assume_unique_for_key(nonce)
}

fn chunk_aad(header: &[u8; CHUNKED_ENCRYPTION_HEADER_LEN], chunk_index: u32) -> Vec<u8> {
    let mut aad = Vec::with_capacity(CHUNKED_ENCRYPTION_HEADER_LEN + 4);
    aad.extend_from_slice(header);
    aad.extend_from_slice(&chunk_index.to_be_bytes());
    aad
}

fn chunk_count(plaintext_size: u64, chunk_size: usize) -> u64 {
    if plaintext_size == 0 {
        0
    } else {
        ((plaintext_size - 1) / chunk_size as u64) + 1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackupArchiveFormat {
    PlainPostgres,
    LegacyEncryptedV1,
    ChunkedEncryptedV2,
}

fn detect_backup_archive_format(path: &Path) -> Result<BackupArchiveFormat> {
    let mut file = fs::File::open(path)?;
    let mut prefix = [0u8; CHUNKED_ENCRYPTED_BACKUP_MAGIC.len()];
    let read = file.read(&mut prefix)?;
    if read >= POSTGRES_CUSTOM_ARCHIVE_MAGIC.len()
        && &prefix[..POSTGRES_CUSTOM_ARCHIVE_MAGIC.len()] == POSTGRES_CUSTOM_ARCHIVE_MAGIC
    {
        return Ok(BackupArchiveFormat::PlainPostgres);
    }
    if read == LEGACY_ENCRYPTED_BACKUP_MAGIC.len()
        && prefix.as_slice() == LEGACY_ENCRYPTED_BACKUP_MAGIC
    {
        return Ok(BackupArchiveFormat::LegacyEncryptedV1);
    }
    if read == CHUNKED_ENCRYPTED_BACKUP_MAGIC.len()
        && prefix.as_slice() == CHUNKED_ENCRYPTED_BACKUP_MAGIC
    {
        return Ok(BackupArchiveFormat::ChunkedEncryptedV2);
    }
    Err(anyhow::anyhow!(
        "backup archive has an unsupported or invalid header"
    ))
}

fn read_chunked_header(
    reader: &mut BufReader<fs::File>,
) -> Result<([u8; CHUNKED_ENCRYPTION_HEADER_LEN], usize, u64, [u8; 8])> {
    let mut header = [0u8; CHUNKED_ENCRYPTION_HEADER_LEN];
    reader.read_exact(&mut header)?;
    if !header.starts_with(CHUNKED_ENCRYPTED_BACKUP_MAGIC) {
        return Err(anyhow::anyhow!(
            "encrypted backup archive has an invalid ROSBAK2 header"
        ));
    }

    let mut chunk_size_bytes = [0u8; 4];
    chunk_size_bytes.copy_from_slice(
        &header[CHUNKED_ENCRYPTED_BACKUP_MAGIC.len()..CHUNKED_ENCRYPTED_BACKUP_MAGIC.len() + 4],
    );
    let chunk_size = u32::from_be_bytes(chunk_size_bytes) as usize;
    if !(64 * 1024..=16 * 1024 * 1024).contains(&chunk_size) {
        return Err(anyhow::anyhow!(
            "encrypted backup archive has an invalid chunk size"
        ));
    }

    let size_start = CHUNKED_ENCRYPTED_BACKUP_MAGIC.len() + 4;
    let mut plaintext_size_bytes = [0u8; 8];
    plaintext_size_bytes.copy_from_slice(&header[size_start..size_start + 8]);
    let plaintext_size = u64::from_be_bytes(plaintext_size_bytes);

    let mut nonce_prefix = [0u8; 8];
    nonce_prefix.copy_from_slice(&header[size_start + 8..size_start + 16]);
    Ok((header, chunk_size, plaintext_size, nonce_prefix))
}

fn expected_chunked_archive_size(plaintext_size: u64, chunk_size: usize) -> Result<u64> {
    let chunks = chunk_count(plaintext_size, chunk_size);
    u32::try_from(chunks).context("encrypted backup archive exceeds the ROSBAK2 chunk limit")?;
    let tag_bytes = chunks
        .checked_mul(AEAD_TAG_LEN as u64)
        .context("encrypted backup archive chunk count overflowed")?;
    (CHUNKED_ENCRYPTION_HEADER_LEN as u64)
        .checked_add(plaintext_size)
        .and_then(|size| size.checked_add(tag_bytes))
        .context("encrypted backup archive size overflowed")
}

fn validate_chunked_encrypted_archive(path: &Path) -> Result<()> {
    let file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let mut reader = BufReader::new(file);
    let (header, chunk_size, plaintext_size, nonce_prefix) = read_chunked_header(&mut reader)?;
    if plaintext_size <= POSTGRES_CUSTOM_ARCHIVE_MAGIC.len() as u64 {
        return Err(anyhow::anyhow!(
            "encrypted backup archive is empty or incomplete"
        ));
    }
    if metadata.len() != expected_chunked_archive_size(plaintext_size, chunk_size)? {
        return Err(anyhow::anyhow!(
            "encrypted backup archive length does not match its authenticated header"
        ));
    }

    // Authenticating one bounded chunk proves the current recovery key matches. The stored
    // SHA-256 identity below proves the rest of the archive is unchanged from creation.
    let first_plaintext_len = usize::try_from(plaintext_size.min(chunk_size as u64))
        .context("encrypted backup first chunk is too large")?;
    let mut first_chunk = vec![0u8; first_plaintext_len + AEAD_TAG_LEN];
    reader.read_exact(&mut first_chunk)?;
    let key = backup_encryption_key()?;
    let aad = chunk_aad(&header, 0);
    let plaintext = key
        .open_in_place(
            chunk_nonce(nonce_prefix, 0),
            Aad::from(aad.as_slice()),
            &mut first_chunk,
        )
        .map_err(|_| {
            anyhow::anyhow!(
                "encrypted backup archive could not be opened with the configured recovery key"
            )
        })?;
    if !plaintext.starts_with(POSTGRES_CUSTOM_ARCHIVE_MAGIC) {
        return Err(anyhow::anyhow!(
            "decrypted backup archive is not a PostgreSQL custom-format dump"
        ));
    }
    Ok(())
}

fn validate_verified_backup_format(path: &Path) -> Result<&'static str> {
    match detect_backup_archive_format(path)? {
        BackupArchiveFormat::PlainPostgres => Ok("pg_restore_catalog+sha256"),
        BackupArchiveFormat::ChunkedEncryptedV2 => {
            validate_chunked_encrypted_archive(path)?;
            Ok("pg_restore_catalog+chunked_aead_v2+sha256")
        }
        BackupArchiveFormat::LegacyEncryptedV1 => Err(anyhow::anyhow!(
            "legacy ROSBAK1 archives remain restorable but cannot establish bounded readiness proof; create a new backup"
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackupArtifactCacheKey {
    path: PathBuf,
    size_bytes: u64,
    modified_at: Option<std::time::SystemTime>,
    expected_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum BackupArtifactCacheState {
    Verifying(BackupArtifactCacheKey),
    Verified(BackupArtifactCacheKey),
}

fn backup_artifact_cache() -> &'static StdMutex<Option<BackupArtifactCacheState>> {
    static CACHE: OnceLock<StdMutex<Option<BackupArtifactCacheState>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(None))
}

fn catalog_artifact_path(filename: &str) -> Result<PathBuf> {
    let filename = filename.trim();
    if !is_safe_backup_catalog_name(filename) {
        return Err(anyhow::anyhow!(
            "Backup file is not in the local backup catalog"
        ));
    }
    let (backup_dir, _) = configured_backup_dir();
    let path = backup_dir.join(filename);
    if !path.is_file() {
        return Err(anyhow::anyhow!(
            "Verified backup artifact is missing from the local catalog"
        ));
    }
    Ok(path)
}

fn artifact_cache_key(
    path: &Path,
    expected_size: i64,
    expected_sha256: &str,
) -> Result<BackupArtifactCacheKey> {
    if expected_size <= 0
        || expected_sha256.len() != 64
        || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(anyhow::anyhow!(
            "Verified backup evidence has no complete artifact identity"
        ));
    }
    let metadata = fs::metadata(path)?;
    if metadata.len() != expected_size as u64 {
        return Err(anyhow::anyhow!(
            "Verified backup artifact size no longer matches its evidence"
        ));
    }
    Ok(BackupArtifactCacheKey {
        path: path.to_path_buf(),
        size_bytes: metadata.len(),
        modified_at: metadata.modified().ok(),
        expected_sha256: expected_sha256.to_ascii_lowercase(),
    })
}

/// Confirms that readiness evidence still identifies the exact usable local archive. Hashing is
/// cached only while the path, byte length, and modification time remain unchanged; existence and
/// metadata are re-read on every readiness probe so deletion is visible immediately.
pub fn verify_local_backup_artifact_evidence(
    filename: &str,
    expected_size: i64,
    expected_sha256: &str,
) -> Result<()> {
    let path = catalog_artifact_path(filename)?;
    let cache_key = artifact_cache_key(&path, expected_size, expected_sha256)?;
    {
        let mut cache = backup_artifact_cache()
            .lock()
            .map_err(|_| anyhow::anyhow!("backup artifact verification cache is unavailable"))?;
        match cache.as_ref() {
            Some(BackupArtifactCacheState::Verified(existing)) if existing == &cache_key => {
                return Ok(())
            }
            Some(BackupArtifactCacheState::Verifying(existing)) if existing == &cache_key => {
                return Err(anyhow::anyhow!(
                    "backup artifact verification is still in progress"
                ))
            }
            _ => *cache = Some(BackupArtifactCacheState::Verifying(cache_key.clone())),
        }
    }

    let verification = (|| {
        validate_verified_backup_format(&path)?;
        let actual_sha256 = sha256_file(&path)?;
        if actual_sha256 != cache_key.expected_sha256 {
            return Err(anyhow::anyhow!(
                "Verified backup artifact SHA-256 no longer matches its evidence"
            ));
        }
        Ok(())
    })();

    let mut cache = backup_artifact_cache()
        .lock()
        .map_err(|_| anyhow::anyhow!("backup artifact verification cache is unavailable"))?;
    *cache = if verification.is_ok() {
        Some(BackupArtifactCacheState::Verified(cache_key))
    } else {
        None
    };
    verification
}

fn verified_backup_artifact_identity(filename: &str) -> Result<(i64, String, &'static str)> {
    let path = catalog_artifact_path(filename)?;
    let metadata = fs::metadata(&path)?;
    let size_bytes =
        i64::try_from(metadata.len()).context("Verified backup artifact is too large to record")?;
    let verification_method = validate_verified_backup_format(&path)?;
    let sha256 = sha256_file(&path)?;
    let cache_key = artifact_cache_key(&path, size_bytes, &sha256)?;
    let mut cache = backup_artifact_cache()
        .lock()
        .map_err(|_| anyhow::anyhow!("backup artifact verification cache is unavailable"))?;
    *cache = Some(BackupArtifactCacheState::Verified(cache_key));
    Ok((size_bytes, sha256, verification_method))
}

fn encrypt_backup_file(source: &PathBuf, destination: &PathBuf) -> Result<()> {
    let key = backup_encryption_key()?;
    let plaintext_size = fs::metadata(source)?.len();
    expected_chunked_archive_size(plaintext_size, CHUNKED_ENCRYPTION_CHUNK_SIZE)?;
    let nonce_uuid = Uuid::new_v4();
    let mut nonce_prefix = [0u8; 8];
    nonce_prefix.copy_from_slice(&nonce_uuid.as_bytes()[..8]);
    let mut header = [0u8; CHUNKED_ENCRYPTION_HEADER_LEN];
    header[..CHUNKED_ENCRYPTED_BACKUP_MAGIC.len()].copy_from_slice(CHUNKED_ENCRYPTED_BACKUP_MAGIC);
    let chunk_size_start = CHUNKED_ENCRYPTED_BACKUP_MAGIC.len();
    header[chunk_size_start..chunk_size_start + 4]
        .copy_from_slice(&(CHUNKED_ENCRYPTION_CHUNK_SIZE as u32).to_be_bytes());
    header[chunk_size_start + 4..chunk_size_start + 12]
        .copy_from_slice(&plaintext_size.to_be_bytes());
    header[chunk_size_start + 12..chunk_size_start + 20].copy_from_slice(&nonce_prefix);

    let mut reader = BufReader::new(fs::File::open(source)?);
    let temp_path = destination.with_extension(format!("encrypting-{}.tmp", Uuid::new_v4()));
    let _pending_temp = PendingBackupFile::new(temp_path.clone());
    let mut writer = BufWriter::new(fs::File::create(&temp_path)?);
    writer.write_all(&header)?;
    let mut remaining = plaintext_size;
    let mut chunk_index = 0u32;
    while remaining > 0 {
        let plaintext_len = usize::try_from(remaining.min(CHUNKED_ENCRYPTION_CHUNK_SIZE as u64))
            .context("backup encryption chunk is too large")?;
        let mut chunk = vec![0u8; plaintext_len];
        reader.read_exact(&mut chunk)?;
        let aad = chunk_aad(&header, chunk_index);
        key.seal_in_place_append_tag(
            chunk_nonce(nonce_prefix, chunk_index),
            Aad::from(aad.as_slice()),
            &mut chunk,
        )
        .map_err(|_| anyhow::anyhow!("failed to encrypt backup archive chunk"))?;
        writer.write_all(&chunk)?;
        remaining -= plaintext_len as u64;
        chunk_index = chunk_index
            .checked_add(1)
            .context("backup encryption chunk counter overflowed")?;
    }
    let mut unexpected = [0u8; 1];
    if reader.read(&mut unexpected)? != 0 {
        return Err(anyhow::anyhow!(
            "backup source changed size during encryption"
        ));
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    drop(writer);
    fs::rename(&temp_path, destination)?;
    Ok(())
}

fn decrypt_backup_file(source: &PathBuf, destination: &PathBuf) -> Result<()> {
    match detect_backup_archive_format(source)? {
        BackupArchiveFormat::ChunkedEncryptedV2 => decrypt_chunked_backup_file(source, destination),
        BackupArchiveFormat::LegacyEncryptedV1 => decrypt_legacy_backup_file(source, destination),
        BackupArchiveFormat::PlainPostgres => {
            Err(anyhow::anyhow!("backup archive is not encrypted"))
        }
    }
}

fn decrypt_chunked_backup_file(source: &Path, destination: &Path) -> Result<()> {
    let key = backup_encryption_key()?;
    let file = fs::File::open(source)?;
    let metadata = file.metadata()?;
    let mut reader = BufReader::new(file);
    let (header, chunk_size, plaintext_size, nonce_prefix) = read_chunked_header(&mut reader)?;
    if metadata.len() != expected_chunked_archive_size(plaintext_size, chunk_size)? {
        return Err(anyhow::anyhow!(
            "encrypted backup archive length does not match its authenticated header"
        ));
    }

    let temp_path = destination.with_extension(format!("decrypting-{}.tmp", Uuid::new_v4()));
    let _pending_temp = PendingBackupFile::new(temp_path.clone());
    let mut writer = BufWriter::new(fs::File::create(&temp_path)?);
    let mut remaining = plaintext_size;
    let mut chunk_index = 0u32;
    while remaining > 0 {
        let plaintext_len = usize::try_from(remaining.min(chunk_size as u64))
            .context("backup decryption chunk is too large")?;
        let mut chunk = vec![0u8; plaintext_len + AEAD_TAG_LEN];
        reader.read_exact(&mut chunk)?;
        let aad = chunk_aad(&header, chunk_index);
        let plaintext = key
            .open_in_place(
                chunk_nonce(nonce_prefix, chunk_index),
                Aad::from(aad.as_slice()),
                &mut chunk,
            )
            .map_err(|_| {
                anyhow::anyhow!("failed to authenticate encrypted backup archive chunk")
            })?;
        writer.write_all(plaintext)?;
        remaining -= plaintext_len as u64;
        chunk_index = chunk_index
            .checked_add(1)
            .context("backup decryption chunk counter overflowed")?;
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    drop(writer);
    fs::rename(&temp_path, destination)?;
    Ok(())
}

/// ROSBAK1 used one AEAD tag for the complete archive, so exact backward compatibility requires
/// a one-shot open. All newly created archives use bounded-memory ROSBAK2 chunks.
fn decrypt_legacy_backup_file(source: &Path, destination: &Path) -> Result<()> {
    let key = backup_encryption_key()?;
    let mut packed = fs::read(source)?;
    let header_len = LEGACY_ENCRYPTED_BACKUP_MAGIC.len() + 12;
    if packed.len() <= header_len || !packed.starts_with(LEGACY_ENCRYPTED_BACKUP_MAGIC) {
        return Err(anyhow::anyhow!(
            "encrypted backup archive has an invalid header"
        ));
    }
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&packed[LEGACY_ENCRYPTED_BACKUP_MAGIC.len()..header_len]);
    let plaintext = key
        .open_within(
            aead::Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(LEGACY_ENCRYPTED_BACKUP_MAGIC),
            &mut packed,
            header_len..,
        )
        .map_err(|_| anyhow::anyhow!("failed to decrypt backup archive"))?;

    let temp_path = destination.with_extension(format!("decrypting-{}.tmp", Uuid::new_v4()));
    let _pending_temp = PendingBackupFile::new(temp_path.clone());
    let mut writer = BufWriter::new(fs::File::create(&temp_path)?);
    writer.write_all(plaintext)?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    drop(writer);
    fs::rename(&temp_path, destination)?;
    Ok(())
}

struct RestoreTemp {
    path: PathBuf,
}

impl Drop for RestoreTemp {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path) {
            tracing::warn!(error = %error, path = %self.path.to_string_lossy(), "failed to remove decrypted restore temp file");
        }
    }
}

struct PendingBackupFile {
    path: PathBuf,
}

impl PendingBackupFile {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for PendingBackupFile {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    error = %error,
                    path = %self.path.to_string_lossy(),
                    "Failed to remove non-catalog backup partial file"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn docker_backup_uses_explicit_e2e_database_name() {
        assert_eq!(
            docker_backup_database_name(
                "postgresql://postgres:password@localhost:5433/riverside_os_e2e"
            )
            .expect("database name"),
            "riverside_os_e2e"
        );
    }

    #[test]
    fn docker_backup_rejects_invalid_database_url() {
        let error = docker_backup_database_name("not a database url")
            .expect_err("invalid database URL must fail");
        assert!(error.to_string().contains("valid PostgreSQL database URL"));
    }

    #[test]
    fn docker_backup_rejects_database_url_without_database_name() {
        let error = docker_backup_database_name("postgresql://postgres:password@localhost:5433")
            .expect_err("missing database name must fail");
        assert!(error.to_string().contains("explicit database name"));
    }

    #[test]
    fn explicit_postgres_tool_path_must_resolve_to_a_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tool = tmp.path().join("pg_dump-test");
        File::create(&tool).expect("tool file");

        assert!(command_path_is_available(&tool.to_string_lossy()));
        assert!(!command_path_is_available(
            &tmp.path().join("missing-tool").to_string_lossy()
        ));
    }

    #[test]
    fn postgres_tool_versions_must_execute_match_and_support_the_server() {
        assert_eq!(
            parse_postgres_tool_major("pg_dump (PostgreSQL) 16.4"),
            Some(16)
        );
        assert_eq!(
            parse_postgres_tool_major("pg_restore (PostgreSQL) 17beta2"),
            None
        );
        assert!(postgres_tool_versions_compatible(17, 17, Some(16)));
        assert!(!postgres_tool_versions_compatible(16, 15, Some(16)));
        assert!(!postgres_tool_versions_compatible(16, 16, Some(17)));
    }

    #[test]
    fn backup_failure_detail_clipping_preserves_utf8() {
        let detail = "é".repeat(BACKUP_FAILURE_DETAIL_MAX);
        let clipped = clip_backup_detail(&detail);

        assert!(clipped.ends_with('…'));
        assert!(clipped.is_char_boundary(clipped.len()));
    }

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

    #[test]
    fn listed_backup_path_accepts_cataloged_encrypted_dump() {
        let tmp = tempfile::tempdir().expect("tempdir");
        File::create(tmp.path().join("backup_20260425_120000.dump.enc")).expect("backup file");
        let manager = BackupManager {
            backup_dir: tmp.path().to_path_buf(),
            database_url: "postgres://example".to_string(),
        };

        let path = manager
            .listed_backup_path("backup_20260425_120000.dump.enc")
            .expect("listed path");
        assert_eq!(path, tmp.path().join("backup_20260425_120000.dump.enc"));
    }

    #[test]
    fn backup_filenames_remain_unique_within_the_same_second() {
        let first = new_backup_filename();
        let second = new_backup_filename();

        assert_ne!(first, second);
        assert!(is_backup_archive_name(&first));
        assert!(is_backup_archive_name(&second));
    }

    #[test]
    fn partial_backup_files_are_hidden_from_catalog_and_removed_on_drop() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let partial_path = tmp.path().join(".backup_20260722_120000.dump.partial-test");
        File::create(&partial_path).expect("partial file");
        assert!(!is_backup_archive_path(&partial_path));

        drop(PendingBackupFile::new(partial_path.clone()));
        assert!(!partial_path.exists());
    }

    #[tokio::test]
    async fn verified_partial_backup_is_atomically_published_to_catalog() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let manager = BackupManager {
            backup_dir: tmp.path().to_path_buf(),
            database_url: "postgres://example".to_string(),
        };
        let partial_path = tmp.path().join(".verified.dump.partial-test");
        fs::write(&partial_path, b"verified archive bytes").expect("partial file");
        assert!(manager.list_backups().expect("catalog").is_empty());

        let filename = "backup_20260722_120000_unique.dump".to_string();
        let finalized = manager
            .finalize_backup_archive(&partial_path, filename.clone(), &BackupSettings::default())
            .await
            .expect("finalize");

        assert_eq!(finalized, filename);
        assert!(!partial_path.exists());
        assert_eq!(manager.list_backups().expect("catalog").len(), 1);
    }

    #[test]
    fn restore_archive_replay_is_single_transaction() {
        assert!(PG_RESTORE_SAFETY_ARGS.contains(&"--clean"));
        assert!(PG_RESTORE_SAFETY_ARGS.contains(&"--if-exists"));
        assert!(PG_RESTORE_SAFETY_ARGS.contains(&"--single-transaction"));
    }

    #[test]
    fn post_restore_repairs_never_fabricate_migration_ledger_rows() {
        assert!(POST_RESTORE_SCHEMA_REPAIR_SQL
            .iter()
            .all(|sql| !sql.contains("ros_schema_migrations")));
    }

    #[test]
    fn configured_backup_database_url_overrides_runtime_database_url() {
        assert_eq!(
            select_backup_database_url(
                "postgres://app@localhost/riverside",
                Some(" postgres://backup@localhost/riverside "),
            ),
            "postgres://backup@localhost/riverside"
        );
        assert_eq!(
            select_backup_database_url("postgres://app@localhost/riverside", Some("  ")),
            "postgres://app@localhost/riverside"
        );
    }

    #[test]
    fn backup_settings_default_old_json_has_no_replication_targets() {
        let raw = serde_json::json!({
            "auto_cleanup_days": 30,
            "schedule_cron": "0 2 * * *",
            "cloud_storage_enabled": false,
            "cloud_bucket_name": "",
            "cloud_region": "us-east-1",
            "cloud_endpoint": ""
        });
        let settings = BackupSettings::try_from_json(raw).expect("settings");
        assert!(settings.replication_targets.is_empty());
        assert!(!settings.encryption_enabled);
        assert_eq!(settings.cloud_provider, "s3");
        assert!(settings.cloud_root.is_empty());
    }

    #[test]
    fn malformed_backup_settings_never_fall_back_to_unencrypted_defaults() {
        let malformed = serde_json::json!({
            "auto_cleanup_days": 30,
            "schedule_cron": "not a daily schedule",
            "cloud_storage_enabled": false,
            "cloud_bucket_name": "",
            "cloud_region": "us-east-1",
            "cloud_endpoint": "",
            "encryption_enabled": true
        });
        assert!(BackupSettings::try_from_json(malformed).is_err());

        let missing_required_fields = serde_json::json!({ "encryption_enabled": true });
        assert!(BackupSettings::try_from_json(missing_required_fields).is_err());
    }

    #[test]
    fn daily_backup_schedule_accepts_only_minute_hour_daily_shape() {
        assert_eq!(parse_daily_backup_schedule("15 3 * * *"), Some((3, 15)));
        assert!(daily_backup_schedule_matches_time("15 3 * * *", "03:15"));
        assert!(!daily_backup_schedule_matches_time("15 3 * * *", "03:16"));
        assert_eq!(parse_daily_backup_schedule("0 * * * *"), None);
        assert_eq!(parse_daily_backup_schedule("61 3 * * *"), None);
        assert_eq!(parse_daily_backup_schedule("15 24 * * *"), None);
    }

    #[tokio::test]
    async fn cloud_sync_requires_bucket_when_enabled() {
        let tmp = tempfile::tempdir().expect("tempdir");
        File::create(tmp.path().join("backup_20260425_120000.dump")).expect("backup file");
        let manager = BackupManager {
            backup_dir: tmp.path().to_path_buf(),
            database_url: "postgres://example".to_string(),
        };
        let settings = BackupSettings {
            cloud_storage_enabled: true,
            ..BackupSettings::default()
        };

        let err = manager
            .sync_to_cloud("backup_20260425_120000.dump", &settings)
            .await
            .expect_err("blank bucket should fail");
        assert!(err.to_string().contains("bucket name is blank"));
    }

    #[tokio::test]
    async fn cloud_read_back_requires_exact_size_and_sha256() {
        let operator =
            Operator::new(opendal::services::Memory::default()).expect("memory cloud operator");
        let filename = "backup_20260425_120000.dump";
        let contents = b"verified Riverside backup";
        operator
            .write(filename, contents.to_vec())
            .await
            .expect("write cloud fixture");
        let expected_sha256 = format!("{:x}", Sha256::digest(contents));

        verify_cloud_backup(&operator, filename, contents.len() as u64, &expected_sha256)
            .await
            .expect("matching cloud object");

        let size_error = verify_cloud_backup(
            &operator,
            filename,
            contents.len() as u64 + 1,
            &expected_sha256,
        )
        .await
        .expect_err("size mismatch");
        assert!(size_error.to_string().contains("size mismatch"));

        let hash_error =
            verify_cloud_backup(&operator, filename, contents.len() as u64, &"0".repeat(64))
                .await
                .expect_err("hash mismatch");
        assert!(hash_error.to_string().contains("SHA-256 mismatch"));
    }

    #[tokio::test]
    async fn replicate_to_targets_copies_and_verifies_dump() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let replica = tempfile::tempdir().expect("replica");
        fs::write(
            tmp.path().join("backup_20260425_120000.dump"),
            b"riverside backup",
        )
        .expect("backup file");
        let manager = BackupManager {
            backup_dir: tmp.path().to_path_buf(),
            database_url: "postgres://example".to_string(),
        };
        let settings = BackupSettings {
            replication_targets: vec![replica.path().to_string_lossy().into_owned()],
            ..BackupSettings::default()
        };

        let copied = manager
            .replicate_to_targets("backup_20260425_120000.dump", &settings)
            .await
            .expect("replication");

        assert_eq!(copied, 1);
        assert_eq!(
            fs::read(replica.path().join("backup_20260425_120000.dump")).expect("copy"),
            b"riverside backup"
        );
    }

    #[test]
    fn encrypted_backup_round_trip_restores_plaintext() {
        std::env::set_var(
            BACKUP_ENCRYPTION_KEY_ENV,
            "test-backup-encryption-key-material-32-plus",
        );
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("backup_20260425_120000.dump");
        let encrypted = tmp.path().join("backup_20260425_120000.dump.enc");
        let restored = tmp.path().join("restored.dump");
        let mut source_bytes = POSTGRES_CUSTOM_ARCHIVE_MAGIC.to_vec();
        source_bytes.resize(CHUNKED_ENCRYPTION_CHUNK_SIZE * 2 + 137, 0x5a);
        fs::write(&source, &source_bytes).expect("source");

        encrypt_backup_file(&source, &encrypted).expect("encrypt");
        let encrypted_bytes = fs::read(&encrypted).expect("encrypted");
        assert!(encrypted_bytes.starts_with(CHUNKED_ENCRYPTED_BACKUP_MAGIC));
        assert_ne!(encrypted_bytes, source_bytes);

        decrypt_backup_file(&encrypted, &restored).expect("decrypt");
        assert_eq!(fs::read(&restored).expect("restored"), source_bytes);
    }

    #[test]
    fn chunked_encrypted_backup_rejects_tampering_without_publishing_plaintext() {
        std::env::set_var(
            BACKUP_ENCRYPTION_KEY_ENV,
            "test-backup-encryption-key-material-32-plus",
        );
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("source.dump");
        let encrypted = tmp.path().join("source.dump.enc");
        let restored = tmp.path().join("restored.dump");
        let mut source_bytes = POSTGRES_CUSTOM_ARCHIVE_MAGIC.to_vec();
        source_bytes.resize(CHUNKED_ENCRYPTION_CHUNK_SIZE + 31, 0x33);
        fs::write(&source, source_bytes).expect("source");
        encrypt_backup_file(&source, &encrypted).expect("encrypt");

        let mut encrypted_bytes = fs::read(&encrypted).expect("encrypted");
        let last = encrypted_bytes.last_mut().expect("encrypted byte");
        *last ^= 0x01;
        fs::write(&encrypted, encrypted_bytes).expect("tampered archive");

        assert!(decrypt_backup_file(&encrypted, &restored).is_err());
        assert!(!restored.exists());
    }

    #[test]
    fn legacy_rosbak1_archive_remains_readable() {
        std::env::set_var(
            BACKUP_ENCRYPTION_KEY_ENV,
            "test-backup-encryption-key-material-32-plus",
        );
        let tmp = tempfile::tempdir().expect("tempdir");
        let encrypted = tmp.path().join("legacy.dump.enc");
        let restored = tmp.path().join("restored.dump");
        let plaintext = b"PGDMP legacy encrypted backup";
        let key = backup_encryption_key().expect("key");
        let nonce_uuid = Uuid::new_v4();
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes.copy_from_slice(&nonce_uuid.as_bytes()[..12]);
        let mut body = plaintext.to_vec();
        key.seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(LEGACY_ENCRYPTED_BACKUP_MAGIC),
            &mut body,
        )
        .expect("legacy encrypt");
        let mut packed = LEGACY_ENCRYPTED_BACKUP_MAGIC.to_vec();
        packed.extend_from_slice(&nonce_bytes);
        packed.extend_from_slice(&body);
        fs::write(&encrypted, packed).expect("legacy archive");

        decrypt_backup_file(&encrypted, &restored).expect("legacy decrypt");
        assert_eq!(fs::read(restored).expect("restored"), plaintext);
    }

    #[test]
    fn chunked_format_rejects_counter_overflow() {
        let too_many_chunks = (u32::MAX as u64 + 1) * CHUNKED_ENCRYPTION_CHUNK_SIZE as u64;
        assert!(
            expected_chunked_archive_size(too_many_chunks, CHUNKED_ENCRYPTION_CHUNK_SIZE,).is_err()
        );
    }
}

const BACKUP_FAILURE_DETAIL_MAX: usize = 500;

fn clip_backup_detail(s: &str) -> String {
    let t = s.trim();
    if t.len() <= BACKUP_FAILURE_DETAIL_MAX {
        t.to_string()
    } else {
        let mut end = BACKUP_FAILURE_DETAIL_MAX.saturating_sub(1).min(t.len());
        while !t.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        format!("{}…", &t[..end])
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

/// Records success only for an archive returned by `create_backup_with_settings`, which has
/// already passed the PostgreSQL custom-format header and `pg_restore --list` checks.
pub async fn record_local_backup_verified_success(pool: &PgPool, filename: &str) -> Result<()> {
    let _operation_guard = BACKUP_OPERATION_LOCK.lock().await;
    let filename = filename.trim();
    let identity_filename = filename.to_string();
    let (size_bytes, sha256, verification_method) =
        tokio::task::spawn_blocking(move || verified_backup_artifact_identity(&identity_filename))
            .await
            .context("Verified backup artifact identity task failed")??;
    sqlx::query(
        r#"
        INSERT INTO store_backup_health (
            id,
            last_local_success_at,
            last_local_verified_at,
            last_local_verified_filename,
            last_local_verification_method,
            last_local_verified_size_bytes,
            last_local_verified_sha256,
            updated_at
        )
        VALUES (1, NOW(), NOW(), $1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE SET
            last_local_success_at = EXCLUDED.last_local_success_at,
            last_local_verified_at = EXCLUDED.last_local_verified_at,
            last_local_verified_filename = EXCLUDED.last_local_verified_filename,
            last_local_verification_method = EXCLUDED.last_local_verification_method,
            last_local_verified_size_bytes = EXCLUDED.last_local_verified_size_bytes,
            last_local_verified_sha256 = EXCLUDED.last_local_verified_sha256,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(filename)
    .bind(verification_method)
    .bind(size_bytes)
    .bind(sha256)
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

    let alert_key = format!("ops_alert:backup_failure:{}", Utc::now().format("%Y-%m-%d"));
    if let Err(error) = crate::logic::notifications::broadcast_system_alert_with_key(
        pool,
        &format!("Database backup failed: {d}"),
        &alert_key,
    )
    .await
    {
        tracing::error!(error = %error, "Failed to broadcast database backup failure alert");
    }
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

/// Check WAL archive health and return status for monitoring
pub async fn check_wal_archive_health(pool: &PgPool) -> Result<WalArchiveHealth, sqlx::Error> {
    // Use raw query to avoid compile-time validation of missing tables
    let row = match sqlx::query(
        r#"
        SELECT
            status,
            last_archive_at,
            last_archive_file,
            archive_count_today,
            archive_size_mb,
            error_message,
            CASE
                WHEN status = 'active' AND last_archive_at > now() - interval '10 minutes' THEN 'healthy'
                WHEN status = 'active' AND last_archive_at > now() - interval '30 minutes' THEN 'warning'
                WHEN status = 'failed' THEN 'critical'
                ELSE 'unknown'
            END as health_status,
            EXTRACT(epoch FROM (now() - last_archive_at))::bigint as seconds_since_last_archive
        FROM wal_archive_health
        LIMIT 1
        "#
    )
    .fetch_optional(pool)
    .await {
        Ok(row) => row,
        Err(e) => {
            // If the WAL archive tables don't exist yet, return default status
            if e.to_string().contains("does not exist") {
                tracing::warn!("WAL archive tables not yet created - migration pending");
                return Ok(WalArchiveHealth::default());
            }
            return Err(e);
        }
    };

    let row = if let Some(row) = row {
        // Manually map the row to our struct
        let status: String = row.get("status");
        let health_status: String = row.get("health_status");
        let last_archive_at: Option<chrono::DateTime<chrono::Utc>> = row.get("last_archive_at");
        let last_archive_file: Option<String> = row.get("last_archive_file");
        let archive_count_today: Option<i64> = row.get("archive_count_today");
        let archive_size_mb: Option<i64> = row.get("archive_size_mb");
        let error_message: Option<String> = row.get("error_message");
        let seconds_since_last_archive: Option<i64> = row.get("seconds_since_last_archive");

        Some((
            status,
            health_status,
            last_archive_at,
            last_archive_file,
            archive_count_today,
            archive_size_mb,
            error_message,
            seconds_since_last_archive,
        ))
    } else {
        None
    };

    match row {
        Some((
            status,
            health_status,
            last_archive_at,
            last_archive_file,
            archive_count_today,
            archive_size_mb,
            error_message,
            seconds_since_last_archive,
        )) => Ok(WalArchiveHealth {
            status,
            health_status,
            last_archive_at,
            last_archive_file,
            archive_count_today: archive_count_today.unwrap_or(0),
            archive_size_mb: archive_size_mb.unwrap_or(0),
            error_message,
            seconds_since_last_archive: seconds_since_last_archive.unwrap_or(0),
        }),
        None => Ok(WalArchiveHealth::default()),
    }
}

/// Record WAL archive failure for alerting
pub async fn record_wal_archive_failure(
    pool: &PgPool,
    error_message: &str,
) -> Result<(), sqlx::Error> {
    // Try to record failure, but handle case where tables don't exist yet
    if let Err(e) = sqlx::query(
        r#"
        UPDATE wal_archive_status
        SET
            status = 'failed',
            error_message = $1,
            updated_at = now()
        WHERE id = (SELECT id FROM wal_archive_status LIMIT 1)
        "#,
    )
    .bind(error_message)
    .execute(pool)
    .await
    {
        if e.to_string().contains("does not exist") {
            tracing::warn!(
                "WAL archive tables not yet created - cannot record failure: {}",
                error_message
            );
            // Still send alert even if we can't record to database
        } else {
            return Err(e);
        }
    }

    // Send alert to admins
    if let Err(e) = crate::logic::notifications::broadcast_system_alert(
        pool,
        &format!("WAL archiving failed: {error_message}"),
    )
    .await
    {
        tracing::error!(error = %e, "Failed to send WAL archive failure alert");
    }

    Ok(())
}

#[derive(Debug, Default)]
pub struct WalArchiveHealth {
    pub status: String,
    pub health_status: String,
    pub last_archive_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_archive_file: Option<String>,
    pub archive_count_today: i64,
    pub archive_size_mb: i64,
    pub error_message: Option<String>,
    pub seconds_since_last_archive: i64,
}
