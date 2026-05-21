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
use sqlx::{PgPool, Row};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use tracing::{error, info, warn};
use uuid::Uuid;

const BACKUP_DIR_ENV: &str = "RIVERSIDE_BACKUP_DIR";
const BACKUP_ENCRYPTION_KEY_ENV: &str = "RIVERSIDE_BACKUP_ENCRYPTION_KEY";
const ENCRYPTED_BACKUP_EXTENSION: &str = ".dump.enc";
const ENCRYPTED_BACKUP_MAGIC: &[u8] = b"ROSBAK1";
const BACKUP_ENCRYPTION_KEY_MIN_LEN: usize = 32;
const RESTORE_SCHEMA_PRE_CLEAN_SQL: &str = r#"
DROP SCHEMA IF EXISTS reporting CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO public;
"#;
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
    r#"INSERT INTO public.ros_schema_migrations (version)
        VALUES
            ('167_product_tax_category_override.sql'),
            ('173_add_environment_mode_guard.sql'),
            ('179_customer_relationship_periods.sql'),
            ('182_payment_provider_metadata.sql'),
            ('183_payment_provider_attempts.sql'),
            ('184_active_card_payment_provider.sql'),
            ('188_payment_provider_attempt_client_secret.sql')
        ON CONFLICT (version) DO NOTHING"#,
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
        if trimmed.is_empty()
            || trimmed.contains('/')
            || trimmed.contains('\\')
            || trimmed.contains("..")
            || !is_backup_archive_name(trimmed)
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
        self.create_backup_with_settings(&BackupSettings::default())
            .await
    }

    pub async fn create_backup_with_settings(&self, settings: &BackupSettings) -> Result<String> {
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
                        let filename = self.finalize_backup_archive(filename, settings)?;
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

        let filename = self.finalize_backup_archive(filename, settings)?;
        info!("Database backup completed successfully: {}", filename);
        Ok(filename)
    }

    fn finalize_backup_archive(
        &self,
        filename: String,
        settings: &BackupSettings,
    ) -> Result<String> {
        if !settings.encryption_enabled {
            return Ok(filename);
        }
        let plaintext_path = self.backup_dir.join(&filename);
        let encrypted_filename = format!("{filename}.enc");
        let encrypted_path = self.backup_dir.join(&encrypted_filename);
        encrypt_backup_file(&plaintext_path, &encrypted_path)?;
        fs::remove_file(&plaintext_path).with_context(|| {
            format!(
                "Encrypted backup was created but plaintext cleanup failed: {}",
                plaintext_path.to_string_lossy()
            )
        })?;
        Ok(encrypted_filename)
    }

    /// Restore a database from a backup using pg_restore.
    /// WARNING: This is destructive.
    pub async fn restore_backup(&self, filename: &str) -> Result<()> {
        let input_path = self.listed_backup_path(filename)?;
        if !input_path.exists() {
            return Err(anyhow::anyhow!("Backup file not found"));
        }
        let mut decrypted_temp: Option<RestoreTemp> = None;
        let restore_path = if is_encrypted_backup_name(filename) {
            let tmp = self
                .backup_dir
                .join(format!("{filename}.restore-{}.tmp", Uuid::new_v4()));
            decrypt_backup_file(&input_path, &tmp)?;
            decrypted_temp = Some(RestoreTemp { path: tmp.clone() });
            tmp
        } else {
            input_path.clone()
        };

        info!("Starting database restore from {:?}", restore_path);

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
            .arg(&restore_path);

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
            let dump_data = fs::read(&restore_path)?;

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
                self.apply_post_restore_schema_repairs().await?;
                self.validate_schema_after_restore().await?;
                drop(decrypted_temp);
                return Ok(());
            } else {
                let d_err = String::from_utf8_lossy(&d_out.stderr);
                error!(stderr = %d_err, "Docker fallback pg_restore also failed");

                info!("Attempting destructive schema pre-clean restore via Docker fallback");
                let preclean = Command::new("docker")
                    .arg("exec")
                    .arg("riverside-os-db")
                    .arg("psql")
                    .arg("-U")
                    .arg("postgres")
                    .arg("-d")
                    .arg("riverside_os")
                    .arg("-v")
                    .arg("ON_ERROR_STOP=1")
                    .arg("-c")
                    .arg(RESTORE_SCHEMA_PRE_CLEAN_SQL)
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .output()
                    .await
                    .context("Failed to execute Docker schema pre-clean")?;

                if !preclean.status.success() {
                    let p_err = String::from_utf8_lossy(&preclean.stderr);
                    error!(stderr = %p_err, "Docker schema pre-clean failed");
                    return Err(anyhow::anyhow!(
                        "pg_restore failed and schema pre-clean failed. Restore error: {}",
                        d_err.trim()
                    ));
                }

                let mut replay_cmd = Command::new("docker");
                replay_cmd
                    .arg("exec")
                    .arg("-i")
                    .arg("riverside-os-db")
                    .arg("pg_restore")
                    .arg("-U")
                    .arg("postgres")
                    .arg("-d")
                    .arg("riverside_os")
                    .arg("--no-owner");

                replay_cmd
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped());

                let mut replay = replay_cmd
                    .spawn()
                    .context("Failed to spawn Docker schema pre-clean pg_restore")?;
                if let Some(mut stdin) = replay.stdin.take() {
                    stdin.write_all(&dump_data).await?;
                    stdin.flush().await?;
                }
                let replay_out = replay.wait_with_output().await?;
                if replay_out.status.success() {
                    info!("Database restoration successful via Docker schema pre-clean fallback");
                    self.apply_post_restore_schema_repairs().await?;
                    self.validate_schema_after_restore().await?;
                    drop(decrypted_temp);
                    return Ok(());
                }

                let replay_err = String::from_utf8_lossy(&replay_out.stderr);
                error!(stderr = %replay_err, "Docker schema pre-clean pg_restore failed");
                return Err(anyhow::anyhow!(
                    "pg_restore failed after schema pre-clean fallback: {}",
                    replay_err.trim()
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
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .context("Could not resolve repository root for post-restore schema validation")?;
        let validation_script = repo_root
            .join("scripts")
            .join("validate_schema_contract.sh");

        if !validation_script.exists() {
            return Err(anyhow::anyhow!(
                "restore completed but schema validation script was not found"
            ));
        }

        let out = Command::new("bash")
            .arg(&validation_script)
            .current_dir(&repo_root)
            .env("DATABASE_URL", &self.database_url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("Failed to execute post-restore schema validation")?;
        if out.status.success() {
            info!("Post-restore schema contract validation passed");
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&out.stderr);
        error!(stderr = %stderr, "Post-restore schema validation failed");
        Err(anyhow::anyhow!(
            "restore completed but schema validation failed: {}",
            stderr.trim()
        ))
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
            if path.is_file() && is_backup_archive_path(&path) {
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
        if !settings.cloud_storage_enabled {
            return Ok(());
        }
        let op = cloud_operator(settings)?;
        let file_path = self.listed_backup_path(filename)?;
        let contents = tokio::fs::read(&file_path).await?;

        info!(
            provider = %settings.cloud_provider,
            "Cloud Sync: Uploading {}",
            filename
        );

        op.write(filename, contents).await?;

        info!(
            "Cloud Sync: Successfully uploaded {} to cloud storage",
            filename
        );

        Ok(())
    }

    pub async fn replicate_to_targets(
        &self,
        filename: &str,
        settings: &BackupSettings,
    ) -> Result<usize> {
        let source = self.listed_backup_path(filename)?;
        let source_hash = sha256_file(&source)?;
        let source_size = fs::metadata(&source)?.len();
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
            if !target_dir.is_dir() {
                return Err(anyhow::anyhow!(
                    "Backup replication target is not a directory: {target}"
                ));
            }

            let final_path = target_dir.join(filename);
            let temp_path = target_dir.join(format!("{filename}.tmp"));
            if temp_path.exists() {
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

            let copied_size = fs::metadata(&temp_path)?.len();
            if copied_size != source_size || sha256_file(&temp_path)? != source_hash {
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
            Ok(Operator::new(builder)?.finish())
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
            Ok(Operator::new(builder)?.finish())
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
            Ok(Operator::new(builder)?.finish())
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
            Ok(Operator::new(builder)?.finish())
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

fn sha256_file(path: &PathBuf) -> Result<String> {
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

fn is_encrypted_backup_name(filename: &str) -> bool {
    filename.ends_with(ENCRYPTED_BACKUP_EXTENSION)
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

fn encrypt_backup_file(source: &PathBuf, destination: &PathBuf) -> Result<()> {
    let key = backup_encryption_key()?;
    let nonce_uuid = Uuid::new_v4();
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&nonce_uuid.as_bytes()[..12]);
    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);
    let mut body = fs::read(source)?;
    key.seal_in_place_append_tag(nonce, Aad::from(ENCRYPTED_BACKUP_MAGIC), &mut body)
        .map_err(|_| anyhow::anyhow!("failed to encrypt backup archive"))?;

    let temp_path = destination.with_extension("tmp");
    let mut packed =
        Vec::with_capacity(ENCRYPTED_BACKUP_MAGIC.len() + nonce_bytes.len() + body.len());
    packed.extend_from_slice(ENCRYPTED_BACKUP_MAGIC);
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&body);
    fs::write(&temp_path, packed)?;
    fs::rename(&temp_path, destination)?;
    Ok(())
}

fn decrypt_backup_file(source: &PathBuf, destination: &PathBuf) -> Result<()> {
    let key = backup_encryption_key()?;
    let packed = fs::read(source)?;
    let header_len = ENCRYPTED_BACKUP_MAGIC.len() + 12;
    if packed.len() <= header_len || !packed.starts_with(ENCRYPTED_BACKUP_MAGIC) {
        return Err(anyhow::anyhow!(
            "encrypted backup archive has an invalid header"
        ));
    }
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&packed[ENCRYPTED_BACKUP_MAGIC.len()..header_len]);
    let mut body = packed[header_len..].to_vec();
    let plaintext = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(ENCRYPTED_BACKUP_MAGIC),
            &mut body,
        )
        .map_err(|_| anyhow::anyhow!("failed to decrypt backup archive"))?;

    let temp_path = destination.with_extension("tmp");
    fs::write(&temp_path, plaintext)?;
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
    fn restore_schema_pre_clean_drops_app_schemas_before_replay() {
        assert!(RESTORE_SCHEMA_PRE_CLEAN_SQL.contains("DROP SCHEMA IF EXISTS public CASCADE"));
        assert!(RESTORE_SCHEMA_PRE_CLEAN_SQL.contains("CREATE SCHEMA public"));
    }

    #[test]
    fn post_restore_schema_validation_script_exists_in_repo() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .expect("repo root");
        assert!(repo_root
            .join("scripts/validate_schema_contract.sh")
            .exists());
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
        let settings: BackupSettings = serde_json::from_value(raw).expect("settings");
        assert!(settings.replication_targets.is_empty());
        assert!(!settings.encryption_enabled);
        assert_eq!(settings.cloud_provider, "s3");
        assert!(settings.cloud_root.is_empty());
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
        fs::write(&source, b"riverside encrypted backup").expect("source");

        encrypt_backup_file(&source, &encrypted).expect("encrypt");
        assert_ne!(
            fs::read(&encrypted).expect("encrypted"),
            b"riverside encrypted backup"
        );

        decrypt_backup_file(&encrypted, &restored).expect("decrypt");
        assert_eq!(
            fs::read(&restored).expect("restored"),
            b"riverside encrypted backup"
        );
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

        Some((status, health_status, last_archive_at, last_archive_file, archive_count_today, archive_size_mb, error_message, seconds_since_last_archive))
    } else {
        None
    };

    match row {
        Some((status, health_status, last_archive_at, last_archive_file, archive_count_today, archive_size_mb, error_message, seconds_since_last_archive)) => {
            Ok(WalArchiveHealth {
                status,
                health_status,
                last_archive_at,
                last_archive_file,
                archive_count_today: archive_count_today.unwrap_or(0),
                archive_size_mb: archive_size_mb.unwrap_or(0),
                error_message,
                seconds_since_last_archive: seconds_since_last_archive.unwrap_or(0),
            })
        },
        None => Ok(WalArchiveHealth::default()),
    }
}

/// Record WAL archive failure for alerting
pub async fn record_wal_archive_failure(pool: &PgPool, error_message: &str) -> Result<(), sqlx::Error> {
    // Try to record failure, but handle case where tables don't exist yet
    if let Err(e) = sqlx::query(
        r#"
        UPDATE wal_archive_status
        SET
            status = 'failed',
            error_message = $1,
            updated_at = now()
        WHERE id = (SELECT id FROM wal_archive_status LIMIT 1)
        "#
    )
    .bind(error_message)
    .execute(pool)
    .await {
        if e.to_string().contains("does not exist") {
            tracing::warn!("WAL archive tables not yet created - cannot record failure: {}", error_message);
            // Still send alert even if we can't record to database
        } else {
            return Err(e);
        }
    }

    // Send alert to admins
    if let Err(e) = crate::logic::notifications::broadcast_system_alert(
        pool,
        &format!("WAL archiving failed: {}", error_message)
    ).await {
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
