//! Application settings API.
//!
//! Persists receipt configuration in `store_settings.receipt_config` (JSONB).

use crate::logic::backups::{BackupFile, BackupManager, BackupSettings};
use crate::logic::insights_config::StoreInsightsConfig;
use crate::logic::integration_credentials;
use crate::logic::remote_access::RemoteAccessManager;
use crate::logic::rosie_intelligence::{get_token_metrics, RosieTokenMetrics};
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use thiserror::Error;

use crate::api::AppState;
use crate::auth::permissions::SETTINGS_ADMIN;
use crate::auth::pins::log_staff_access;
use crate::logic::email::{self, StoreEmailConfig};
use crate::logic::nuorder::{NuorderClient, NuorderCredentials};
use crate::logic::nuorder_sync;
use crate::logic::podium::{
    build_podium_oauth_authorize_url_for_base, exchange_podium_oauth_authorization_code,
    podium_effective_rest_api_base, podium_oauth_app_credential_status, podium_oauth_client_id,
    validate_podium_oauth_redirect_uri, validate_podium_oauth_state, PodiumEnvCredentials,
    PodiumOAuthAppCredentials, PodiumSmsSettingsResponse, StorePodiumSmsConfig,
};
use crate::logic::podium_reviews::{self, StoreReviewPolicy};
use crate::logic::podium_webhook::{
    allow_unsigned_podium_webhook, podium_inbound_inbox_enabled, podium_webhook_secret_from_env,
};
use crate::logic::shippo::{
    shippo_api_token_from_env, shippo_webhook_secret_from_env, DefaultParcel, ShippoAddressFields,
    StoreShippoConfig,
};
use crate::logic::weather::{apply_weather_runtime_settings, StoreWeatherSettings};
use crate::middleware;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Backup error: {0}")]
    Backup(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    InvalidPayload(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

fn map_credential_settings_error(
    error: integration_credentials::IntegrationCredentialError,
) -> SettingsError {
    match error {
        integration_credentials::IntegrationCredentialError::Database(error) => {
            SettingsError::Database(error)
        }
        integration_credentials::IntegrationCredentialError::InvalidPayload(message) => {
            SettingsError::InvalidPayload(message)
        }
    }
}

fn map_set_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> SettingsError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => SettingsError::Unauthorized(msg),
        StatusCode::FORBIDDEN => SettingsError::Forbidden(msg),
        _ => SettingsError::InvalidPayload(msg),
    }
}

async fn require_settings_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), SettingsError> {
    middleware::require_staff_with_permission(state, headers, SETTINGS_ADMIN)
        .await
        .map(|_| ())
        .map_err(map_set_perm)
}

impl IntoResponse for SettingsError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            SettingsError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            SettingsError::Backup(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
            SettingsError::Conflict(m) => (StatusCode::CONFLICT, m),
            SettingsError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            SettingsError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            SettingsError::Database(e) => {
                tracing::error!(error = e.to_string(), "Database error in settings");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
struct RestoreBackupRequest {
    confirmation_filename: String,
}

#[derive(Debug, Serialize)]
struct BackupSettingsResponse {
    #[serde(flatten)]
    settings: BackupSettings,
    backup_dir: String,
    backup_dir_configured: bool,
    backup_dir_explicit_required: bool,
}

fn env_truthy(key: &str) -> bool {
    std::env::var(key)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn validate_restore_confirmation(
    filename: &str,
    confirmation_filename: Option<&str>,
) -> Result<(), SettingsError> {
    let Some(confirmation_filename) = confirmation_filename else {
        return Err(SettingsError::InvalidPayload(
            "Restore requires confirmation_filename matching the selected backup.".to_string(),
        ));
    };
    if confirmation_filename.trim() != filename {
        return Err(SettingsError::InvalidPayload(
            "Restore confirmation must exactly match the selected backup filename.".to_string(),
        ));
    }
    Ok(())
}

fn validate_restore_environment(
    strict_production: bool,
    allow_production_restore: bool,
) -> Result<(), SettingsError> {
    if strict_production && !allow_production_restore {
        return Err(SettingsError::Conflict(
            "Production restore is locked. Restore into a non-production drill database, or set RIVERSIDE_ALLOW_PRODUCTION_RESTORE=true for an approved emergency window."
                .to_string(),
        ));
    }
    Ok(())
}

fn validate_restore_register_blocker(open_register_count: i64) -> Result<(), SettingsError> {
    if open_register_count > 0 {
        return Err(SettingsError::Conflict(format!(
            "Restore blocked: {open_register_count} register session(s) are open or reconciling. Close all registers before restoring."
        )));
    }
    Ok(())
}

fn validate_restore_catalog_membership(exists_in_catalog: bool) -> Result<(), SettingsError> {
    if !exists_in_catalog {
        return Err(SettingsError::InvalidPayload(
            "Backup file is not in the local backup catalog".to_string(),
        ));
    }
    Ok(())
}

pub struct MeilisearchStatusResponseBasic {
    pub configured: bool,
}

fn backup_settings_response(settings: BackupSettings) -> BackupSettingsResponse {
    let dir =
        crate::logic::backups::backup_directory_info(env_truthy("RIVERSIDE_STRICT_PRODUCTION"));
    BackupSettingsResponse {
        settings,
        backup_dir: dir.path,
        backup_dir_configured: dir.configured,
        backup_dir_explicit_required: dir.strict_required,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReceiptConfig {
    #[serde(default = "default_store_name")]
    pub store_name: String,
    #[serde(default = "default_true")]
    pub show_address: bool,
    #[serde(default = "default_true")]
    pub show_phone: bool,
    #[serde(default)]
    pub show_email: bool,
    #[serde(default = "default_true")]
    pub show_loyalty_earned: bool,
    #[serde(default = "default_true")]
    pub show_loyalty_balance: bool,
    #[serde(default)]
    pub show_barcode: bool,
    #[serde(default = "default_true")]
    pub show_logo: bool,
    #[serde(default)]
    pub store_address: String,
    #[serde(default)]
    pub store_phone: String,
    #[serde(default)]
    pub store_email: String,
    #[serde(default)]
    pub header_lines: Vec<String>,
    #[serde(default = "default_footer")]
    pub footer_lines: Vec<String>,
    /// IANA timezone for displaying timestamps on receipts and bag tags.
    /// Defaults to "America/New_York" (Eastern).
    #[serde(default = "default_timezone")]
    pub timezone: String,
    /// GrapesJS Studio **document** project JSON for **Settings → Receipt Builder** (optional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_studio_project_json: Option<Value>,
    /// Last exported HTML from Studio (used for server-side merge + POS HTML print path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_studio_exported_html: Option<String>,
    /// `escpos` = standard Epson TM receipt path. Studio HTML modes remain optional.
    #[serde(default = "default_receipt_thermal_mode")]
    pub receipt_thermal_mode: String,
    /// ReceiptLine markdown template for Epson receipts. When empty, ROS builds a standard
    /// template from the structured receipt settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiptline_template: Option<String>,
}

fn default_store_name() -> String {
    "Riverside OS".to_string()
}
fn default_true() -> bool {
    true
}
fn default_timezone() -> String {
    "America/New_York".to_string()
}
fn default_footer() -> Vec<String> {
    vec![
        "Thank you for shopping with us!".to_string(),
        "Visit us again soon.".to_string(),
    ]
}

fn default_receipt_thermal_mode() -> String {
    "escpos".to_string()
}

fn default_rosie_speech_rate() -> f32 {
    1.0
}

fn default_rosie_voice() -> String {
    "adam".to_string()
}

fn default_rosie_microphone_mode() -> RosieMicrophoneMode {
    RosieMicrophoneMode::PushToTalk
}

impl Default for ReceiptConfig {
    fn default() -> Self {
        Self {
            store_name: default_store_name(),
            show_address: true,
            show_phone: true,
            show_email: false,
            show_loyalty_earned: true,
            show_loyalty_balance: true,
            show_barcode: false,
            show_logo: true,
            store_address: String::new(),
            store_phone: String::new(),
            store_email: String::new(),
            header_lines: Vec::new(),
            footer_lines: default_footer(),
            timezone: default_timezone(),
            receipt_studio_project_json: None,
            receipt_studio_exported_html: None,
            receipt_thermal_mode: default_receipt_thermal_mode(),
            receiptline_template: None,
        }
    }
}

impl ReceiptConfig {
    pub fn normalize_runtime(mut self) -> Self {
        if self.receipt_thermal_mode.trim() != "escpos" {
            self.receipt_thermal_mode = default_receipt_thermal_mode();
        }
        self
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RosieVerbosity {
    #[default]
    Concise,
    Detailed,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RosieMicrophoneMode {
    PushToTalk,
    Toggle,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RosieConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true", alias = "direct_mode_enabled")]
    pub local_first: bool,
    #[serde(default, alias = "verbosity")]
    pub response_style: RosieVerbosity,
    #[serde(default = "default_true")]
    pub show_citations: bool,
    #[serde(default = "default_true", alias = "voice_output_enabled")]
    pub voice_enabled: bool,
    #[serde(default, alias = "speak_replies")]
    pub speak_responses: bool,
    #[serde(default = "default_rosie_voice")]
    pub selected_voice: String,
    #[serde(default = "default_rosie_speech_rate")]
    pub speech_rate: f32,
    #[serde(default = "default_true", alias = "voice_input_enabled")]
    pub microphone_enabled: bool,
    #[serde(default = "default_rosie_microphone_mode")]
    pub microphone_mode: RosieMicrophoneMode,
}

impl Default for RosieConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            local_first: true,
            response_style: RosieVerbosity::Concise,
            show_citations: true,
            voice_enabled: true,
            speak_responses: false,
            selected_voice: default_rosie_voice(),
            speech_rate: default_rosie_speech_rate(),
            microphone_enabled: true,
            microphone_mode: default_rosie_microphone_mode(),
        }
    }
}

async fn get_receipt_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ReceiptConfig>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;

    let cfg: ReceiptConfig = serde_json::from_value::<ReceiptConfig>(raw)
        .unwrap_or_default()
        .normalize_runtime();
    Ok(Json(cfg))
}

async fn patch_receipt_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<ReceiptConfig>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    // Merge body into existing config.
    let existing_raw: Value =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut existing: Value = existing_raw;
    if let (Value::Object(existing_map), Value::Object(new_map)) = (&mut existing, body) {
        for (k, v) in new_map {
            existing_map.insert(k, v);
        }
    }

    // Validate the merged payload against the ReceiptConfig schema before persisting.
    let normalized: ReceiptConfig = serde_json::from_value::<ReceiptConfig>(existing)
        .map_err(|e| {
            SettingsError::InvalidPayload(format!("invalid receipt settings payload: {e}"))
        })?
        .normalize_runtime();
    let normalized_value = serde_json::to_value(&normalized)
        .map_err(|e| SettingsError::InvalidPayload(format!("serialize failed: {e}")))?;

    sqlx::query("UPDATE store_settings SET receipt_config = $1 WHERE id = 1")
        .bind(&normalized_value)
        .execute(&state.db)
        .await?;

    Ok(Json(normalized))
}

async fn get_receipt_preview_html(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;

    let gift = params
        .get("gift")
        .map(|v| {
            let t = v.trim().to_ascii_lowercase();
            matches!(t.as_str(), "1" | "true" | "yes")
        })
        .unwrap_or(false);

    let cfg: ReceiptConfig = serde_json::from_value::<ReceiptConfig>(raw)
        .unwrap_or_default()
        .normalize_runtime();
    let tpl = cfg
        .receipt_studio_exported_html
        .as_deref()
        .unwrap_or("")
        .to_string();
    let order = crate::logic::receipt_studio_html::sample_receipt_order_for_preview();
    let body = if tpl.trim().is_empty() {
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Receipt preview</title></head><body><p>No exported HTML yet. Use <strong>Receipt Builder</strong> and save — the editor syncs HTML for merge preview.</p></body></html>".to_string()
    } else {
        crate::logic::receipt_studio_html::merge_receipt_studio_html(&tpl, &order, &cfg, gift)
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(body.into())
        .map_err(|e| SettingsError::InvalidPayload(e.to_string()))
}

async fn get_rosie_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RosieConfig>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT rosie_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;

    let cfg: RosieConfig = serde_json::from_value(raw).unwrap_or_default();
    Ok(Json(cfg))
}

async fn patch_rosie_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<RosieConfig>, SettingsError> {
    require_settings_admin(&state, &headers).await?;

    let existing_raw: Value =
        sqlx::query_scalar("SELECT rosie_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut existing: Value = existing_raw;
    if let (Value::Object(existing_map), Value::Object(new_map)) = (&mut existing, body) {
        for (k, v) in new_map {
            existing_map.insert(k, v);
        }
    }

    let normalized: RosieConfig = serde_json::from_value(existing).map_err(|e| {
        SettingsError::InvalidPayload(format!("invalid ROSIE settings payload: {e}"))
    })?;
    let normalized_value = serde_json::to_value(&normalized)
        .map_err(|e| SettingsError::InvalidPayload(format!("serialize failed: {e}")))?;

    sqlx::query("UPDATE store_settings SET rosie_config = $1 WHERE id = 1")
        .bind(&normalized_value)
        .execute(&state.db)
        .await?;

    Ok(Json(normalized))
}

async fn get_rosie_token_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RosieTokenMetrics>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let metrics = get_token_metrics(&state.db).await?;
    Ok(Json(metrics))
}

async fn get_backups(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<BackupFile>>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = BackupManager::new(state.database_url);
    let list = manager
        .list_backups()
        .map_err(|e| SettingsError::Backup(e.to_string()))?;
    Ok(Json(list))
}

async fn create_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = BackupManager::new(state.database_url.clone());
    let settings_raw: Value =
        sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
            .fetch_optional(&state.db)
            .await?
            .unwrap_or_else(|| json!({}));
    let settings: BackupSettings = serde_json::from_value(settings_raw).unwrap_or_default();
    let filename = match manager.create_backup_with_settings(&settings).await {
        Ok(f) => f,
        Err(e) => {
            let msg = e.to_string();
            if let Err(err) =
                crate::logic::backups::record_local_backup_failure(&state.db, &msg).await
            {
                tracing::error!(error = err.to_string(), "record_local_backup_failure");
            }
            return Err(SettingsError::Backup(msg));
        }
    };
    if let Err(e) = crate::logic::backups::record_local_backup_success(&state.db).await {
        tracing::error!(error = e.to_string(), "record_local_backup_success");
    }

    let offsite_enabled = settings.cloud_storage_enabled
        || settings
            .replication_targets
            .iter()
            .any(|target| !target.trim().is_empty());
    if offsite_enabled {
        let cloud_result = manager.sync_to_cloud(&filename, &settings).await;
        let replica_result = manager.replicate_to_targets(&filename, &settings).await;
        match (cloud_result, replica_result) {
            (Ok(_), Ok(_)) => {
                if let Err(e) = crate::logic::backups::record_cloud_backup_success(&state.db).await
                {
                    tracing::error!(error = e.to_string(), "record_cloud_backup_success");
                }
            }
            (cloud, replica) => {
                let detail = format!(
                    "Off-site backup failed. Cloud: {}; Replication: {}",
                    cloud
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "ok".to_string()),
                    replica
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "ok".to_string())
                );
                if let Err(e) =
                    crate::logic::backups::record_cloud_backup_failure(&state.db, &detail).await
                {
                    tracing::error!(error = e.to_string(), "record_cloud_backup_failure");
                }
                return Err(SettingsError::Backup(format!(
                    "Local backup created as {filename}, but off-site copy failed: {detail}"
                )));
            }
        }
    }
    Ok(Json(json!({ "filename": filename })))
}

async fn restore_backup(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    headers: HeaderMap,
    body: Option<Json<RestoreBackupRequest>>,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let confirmation_filename = body
        .as_ref()
        .map(|Json(body)| body.confirmation_filename.as_str());
    validate_restore_confirmation(&filename, confirmation_filename)?;

    validate_restore_environment(
        env_truthy("RIVERSIDE_STRICT_PRODUCTION"),
        env_truthy("RIVERSIDE_ALLOW_PRODUCTION_RESTORE"),
    )?;

    let open_register_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM register_sessions
        WHERE is_open = true OR lifecycle_status = 'reconciling'
        "#,
    )
    .fetch_one(&state.db)
    .await?;
    validate_restore_register_blocker(open_register_count)?;

    let manager = BackupManager::new(state.database_url.clone());
    let exists_in_catalog = manager
        .list_backups()
        .map_err(|e| SettingsError::Backup(e.to_string()))?
        .into_iter()
        .any(|backup| backup.filename == filename);
    validate_restore_catalog_membership(exists_in_catalog)?;

    let pre_restore_filename = match manager.create_backup().await {
        Ok(f) => f,
        Err(e) => {
            let msg = format!("Pre-restore backup failed: {e}");
            if let Err(err) =
                crate::logic::backups::record_local_backup_failure(&state.db, &msg).await
            {
                tracing::error!(error = err.to_string(), "record_local_backup_failure");
            }
            return Err(SettingsError::Backup(msg));
        }
    };
    if let Err(e) = crate::logic::backups::record_local_backup_success(&state.db).await {
        tracing::error!(error = e.to_string(), "record_local_backup_success");
    }

    manager
        .restore_backup(&filename)
        .await
        .map_err(|e| SettingsError::Backup(e.to_string()))?;
    Ok(Json(json!({
        "status": "restored",
        "pre_restore_backup": pre_restore_filename
    })))
}

async fn delete_backup(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = BackupManager::new(state.database_url);
    manager
        .delete_backup(&filename)
        .map_err(|e| SettingsError::Backup(e.to_string()))?;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn get_backup_download(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = BackupManager::new(state.database_url.clone());
    let content = manager
        .read_backup_file(&filename)
        .await
        .map_err(|e| SettingsError::Backup(e.to_string()))?;

    Ok((
        axum::http::header::HeaderMap::new(),
        [(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )],
        content,
    ))
}

#[derive(Serialize)]
pub struct DbStats {
    pub database_size: String,
    pub table_count: i64,
}

async fn get_db_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DbStats>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let size: String =
        sqlx::query_scalar("SELECT pg_size_pretty(pg_database_size(current_database()))")
            .fetch_one(&state.db)
            .await?;

    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(DbStats {
        database_size: size,
        table_count: count,
    }))
}

async fn get_nuorder_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let logs: Vec<Value> = sqlx::query(
        "SELECT id, sync_type, status, started_at, finished_at, created_count, updated_count, error_message FROM nuorder_sync_logs ORDER BY started_at DESC LIMIT 20"
    )
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .map(|r| {
        let id: Uuid = r.get(0);
        json!({
            "id": id,
            "sync_type": r.get::<'_, String, _>(1),
            "status": r.get::<'_, String, _>(2),
            "started_at": r.get::<'_, chrono::DateTime<chrono::Utc>, _>(3),
            "finished_at": r.try_get::<'_, chrono::DateTime<chrono::Utc>, _>(4).ok(),
            "created_count": r.get::<'_, i32, _>(5),
            "updated_count": r.get::<'_, i32, _>(6),
            "error_message": r.get::<'_, Option<String>, _>(7),
        })
    })
    .collect();

    let credential_status = integration_credentials_status(&state, "nuorder").await?;
    let credentials_configured = [
        "consumer_key",
        "consumer_secret",
        "user_token",
        "user_secret",
    ]
    .iter()
    .all(|key| {
        credential_status
            .configured
            .get(*key)
            .copied()
            .unwrap_or(false)
    });

    Ok(Json(json!({
        "config": {},
        "credentials_configured": credentials_configured,
        "credential_status": credential_status,
        "recent_logs": logs
    })))
}

async fn patch_nuorder_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, SettingsError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_set_perm)?;
    let mut values = Vec::new();
    for key in [
        "consumer_key",
        "consumer_secret",
        "user_token",
        "user_secret",
    ] {
        if let Some(value) = body.get(key).and_then(Value::as_str) {
            let cleaned = clean_integration_credential_value(key, value.to_string())?;
            if let Some(cleaned) = cleaned {
                values.push((key, cleaned));
            }
        }
    }
    if values.is_empty() {
        return Err(SettingsError::InvalidPayload(
            "Enter at least one NuORDER credential to save.".to_string(),
        ));
    }
    integration_credentials::save_integration_credentials(
        &state.db,
        "nuorder",
        values,
        Some(staff.id),
    )
    .await
    .map_err(map_credential_settings_error)?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn nuorder_client_from_credentials(
    pool: &sqlx::PgPool,
) -> Result<NuorderClient, SettingsError> {
    let values = integration_credentials::load_integration_credentials(
        pool,
        "nuorder",
        &[
            "consumer_key",
            "consumer_secret",
            "user_token",
            "user_secret",
        ],
    )
    .await
    .map_err(map_credential_settings_error)?;

    let consumer_key = values.get("consumer_key").cloned().unwrap_or_default();
    let consumer_secret = values.get("consumer_secret").cloned().unwrap_or_default();
    let user_token = values.get("user_token").cloned().unwrap_or_default();
    let user_secret = values.get("user_secret").cloned().unwrap_or_default();

    if consumer_key.is_empty()
        || consumer_secret.is_empty()
        || user_token.is_empty()
        || user_secret.is_empty()
    {
        return Err(SettingsError::InvalidPayload(
            "Missing NuORDER credentials".into(),
        ));
    }

    Ok(NuorderClient::new(NuorderCredentials {
        consumer_key,
        consumer_secret,
        user_token,
        user_secret,
    }))
}

async fn trigger_nuorder_catalog_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    let staff = middleware::require_staff_with_permission(
        &state,
        &headers,
        crate::auth::permissions::NUORDER_SYNC,
    )
    .await
    .map_err(map_set_perm)?;
    let client = nuorder_client_from_credentials(&state.db).await?;

    match nuorder_sync::sync_catalog(&state.db, &client, Some(staff.id)).await {
        Ok(stats) => Ok(Json(
            json!({ "message": format!("Created: {}, Updated: {}, Variants: {}", stats.created, stats.updated, stats.variants) }),
        )),
        Err(e) => Err(SettingsError::InvalidPayload(e.to_string())),
    }
}

async fn trigger_nuorder_orders_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    middleware::require_staff_with_permission(
        &state,
        &headers,
        crate::auth::permissions::NUORDER_SYNC,
    )
    .await
    .map_err(map_set_perm)?;
    let client = nuorder_client_from_credentials(&state.db).await?;

    match nuorder_sync::sync_approved_orders(&state.db, &client).await {
        Ok(count) => Ok(Json(
            json!({ "message": format!("Imported {} orders", count) }),
        )),
        Err(e) => Err(SettingsError::InvalidPayload(e.to_string())),
    }
}

async fn trigger_nuorder_inventory_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    middleware::require_staff_with_permission(
        &state,
        &headers,
        crate::auth::permissions::NUORDER_SYNC,
    )
    .await
    .map_err(map_set_perm)?;
    let client = nuorder_client_from_credentials(&state.db).await?;

    match nuorder_sync::sync_inventory_ats(&state.db, &client).await {
        Ok(count) => Ok(Json(
            json!({ "message": format!("Synced {} items", count) }),
        )),
        Err(e) => Err(SettingsError::InvalidPayload(e.to_string())),
    }
}

async fn get_nuorder_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    middleware::require_staff_with_permission(
        &state,
        &headers,
        crate::auth::permissions::NUORDER_SYNC,
    )
    .await
    .map_err(map_set_perm)?;

    let client = nuorder_client_from_credentials(&state.db).await?;
    let health = client.health_check().await;
    Ok(Json(json!({
        "configured": true,
        "reachable": health.reachable,
        "latency_ms": health.latency_ms,
        "message": health.message,
    })))
}

pub fn build_nuorder_router() -> Router<AppState> {
    Router::new()
        .route(
            "/config",
            get(get_nuorder_config).patch(patch_nuorder_config),
        )
        .route("/health", get(get_nuorder_health))
        .route("/sync/catalog", post(trigger_nuorder_catalog_sync))
        .route("/sync/orders", post(trigger_nuorder_orders_sync))
        .route("/sync/inventory", post(trigger_nuorder_inventory_sync))
}

async fn optimize_db(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    sqlx::query("VACUUM ANALYZE").execute(&state.db).await?;

    Ok(Json(json!({ "status": "optimized" })))
}

#[derive(Debug, Serialize)]
struct IntegrationCredentialsStatusResponse {
    integration_key: String,
    supported_keys: Vec<String>,
    configured: HashMap<String, bool>,
}

#[derive(Debug, Deserialize)]
struct PatchIntegrationCredentialsBody {
    credentials: HashMap<String, String>,
}

fn clean_integration_credential_value(
    credential_key: &str,
    value: String,
) -> Result<Option<String>, SettingsError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 4096 {
        return Err(SettingsError::InvalidPayload(format!(
            "{credential_key} is too long."
        )));
    }
    if matches!(
        credential_key,
        "api_base_url" | "oauth_token_url" | "base_url" | "url"
    ) {
        let parsed = reqwest::Url::parse(trimmed).map_err(|_| {
            SettingsError::InvalidPayload(format!("{credential_key} must be a valid URL."))
        })?;
        if !matches!(parsed.scheme(), "https" | "http") {
            return Err(SettingsError::InvalidPayload(format!(
                "{credential_key} must use http or https."
            )));
        }
        return Ok(Some(trimmed.trim_end_matches('/').to_string()));
    }
    Ok(Some(trimmed.to_string()))
}

async fn integration_credentials_status(
    state: &AppState,
    integration_key: &str,
) -> Result<IntegrationCredentialsStatusResponse, SettingsError> {
    let supported_keys = integration_credentials::credential_keys_for_integration(integration_key);
    if supported_keys.is_empty() {
        return Err(SettingsError::InvalidPayload(
            "Unsupported integration credential group.".to_string(),
        ));
    }
    let configured = integration_credentials::configured_integration_credentials(
        &state.db,
        integration_key,
        &supported_keys,
    )
    .await?;
    Ok(IntegrationCredentialsStatusResponse {
        integration_key: integration_key.to_string(),
        supported_keys: supported_keys.iter().map(|key| key.to_string()).collect(),
        configured: supported_keys
            .into_iter()
            .map(|key| (key.to_string(), configured.contains(key)))
            .collect(),
    })
}

async fn get_integration_credentials_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(integration_key): Path<String>,
) -> Result<Json<IntegrationCredentialsStatusResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    Ok(Json(
        integration_credentials_status(&state, integration_key.trim()).await?,
    ))
}

async fn patch_integration_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(integration_key): Path<String>,
    Json(body): Json<PatchIntegrationCredentialsBody>,
) -> Result<Json<IntegrationCredentialsStatusResponse>, SettingsError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_set_perm)?;
    let integration_key = integration_key.trim().to_ascii_lowercase();
    let supported_keys = integration_credentials::credential_keys_for_integration(&integration_key);
    if supported_keys.is_empty() {
        return Err(SettingsError::InvalidPayload(
            "Unsupported integration credential group.".to_string(),
        ));
    }

    let mut values = Vec::new();
    for (credential_key, value) in body.credentials {
        let credential_key = credential_key.trim().to_ascii_lowercase();
        if !integration_credentials::is_supported_integration_credential(
            &integration_key,
            &credential_key,
        ) {
            return Err(SettingsError::InvalidPayload(format!(
                "{credential_key} is not supported for {integration_key}."
            )));
        }
        if let Some(cleaned) = clean_integration_credential_value(&credential_key, value)? {
            values.push((credential_key, cleaned));
        }
    }

    if values.is_empty() {
        return Err(SettingsError::InvalidPayload(
            "Enter at least one credential value to save.".to_string(),
        ));
    }

    let save_values = values
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect();
    integration_credentials::save_integration_credentials(
        &state.db,
        &integration_key,
        save_values,
        Some(staff.id),
    )
    .await
    .map_err(map_credential_settings_error)?;
    integration_credentials::apply_integration_credentials_to_env(&state.db, &integration_key)
        .await
        .map_err(map_credential_settings_error)?;

    Ok(Json(
        integration_credentials_status(&state, &integration_key).await?,
    ))
}

async fn delete_integration_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((integration_key, credential_key)): Path<(String, String)>,
) -> Result<Json<IntegrationCredentialsStatusResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let integration_key = integration_key.trim().to_ascii_lowercase();
    let credential_key = credential_key.trim().to_ascii_lowercase();
    integration_credentials::clear_integration_credential(
        &state.db,
        &integration_key,
        &credential_key,
    )
    .await
    .map_err(map_credential_settings_error)?;
    Ok(Json(
        integration_credentials_status(&state, &integration_key).await?,
    ))
}

async fn get_backup_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<BackupSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;

    let cfg: BackupSettings = serde_json::from_value(raw).unwrap_or_default();
    Ok(Json(backup_settings_response(cfg)))
}

#[derive(Debug, Serialize)]
pub struct WeatherSettingsResponse {
    pub enabled: bool,
    pub location: String,
    pub unit_group: String,
    pub timezone: String,
    pub api_key_configured: bool,
    /// Hint for operators (no secret material).
    pub provider: &'static str,
}

fn weather_settings_public(s: &StoreWeatherSettings) -> WeatherSettingsResponse {
    WeatherSettingsResponse {
        enabled: s.enabled,
        location: s.location.clone(),
        unit_group: s.unit_group.clone(),
        timezone: s.timezone.clone(),
        api_key_configured: !s.api_key.trim().is_empty(),
        provider: "visual_crossing_timeline",
    }
}

async fn get_weather_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<WeatherSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT weather_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;
    let cfg: StoreWeatherSettings = serde_json::from_value(raw).unwrap_or_default();
    let effective = apply_weather_runtime_settings(&state.db, cfg).await;
    Ok(Json(weather_settings_public(&effective)))
}

async fn patch_weather_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<WeatherSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let existing_raw: Value =
        sqlx::query_scalar("SELECT weather_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut current: StoreWeatherSettings =
        serde_json::from_value(existing_raw).unwrap_or_default();

    if let Some(v) = body.get("enabled").and_then(|x| x.as_bool()) {
        current.enabled = v;
    }
    if let Some(s) = body.get("location").and_then(|x| x.as_str()) {
        current.location = s.to_string();
    }
    if let Some(s) = body.get("unit_group").and_then(|x| x.as_str()) {
        let g = s.to_lowercase();
        if g == "us" || g == "metric" {
            current.unit_group = g;
        }
    }
    if let Some(s) = body.get("timezone").and_then(|x| x.as_str()) {
        current.timezone = s.to_string();
    }
    if let Some(v) = body.get("api_key") {
        if v.is_null() {
            current.api_key.clear();
        } else if let Some(s) = v.as_str() {
            if !s.is_empty() {
                current.api_key = s.to_string();
            }
        }
    }

    let updated = serde_json::to_value(&current)
        .map_err(|e| SettingsError::InvalidPayload(format!("weather_config serialization: {e}")))?;

    sqlx::query("UPDATE store_settings SET weather_config = $1 WHERE id = 1")
        .bind(&updated)
        .execute(&state.db)
        .await?;

    let effective = apply_weather_runtime_settings(&state.db, current).await;
    Ok(Json(weather_settings_public(&effective)))
}

#[derive(Debug, Serialize)]
pub struct ShippoSettingsResponse {
    pub enabled: bool,
    pub live_rates_enabled: bool,
    pub from_address: ShippoAddressFields,
    pub default_parcel: DefaultParcel,
    pub api_token_configured: bool,
    pub webhook_secret_configured: bool,
}

#[derive(Debug, Serialize)]
pub struct EdgeAccessStatusResponse {
    pub public_base_url: Option<String>,
    pub public_host: Option<String>,
    pub public_https_configured: bool,
    pub cloudflared_installed: bool,
    pub cloudflared_launch_agent_configured: bool,
    pub cloudflare_tunnel_hint_configured: bool,
    pub helcim_webhook_secret_configured: bool,
    pub podium_webhook_secret_configured: bool,
    pub shippo_webhook_secret_configured: bool,
    pub strict_production: bool,
    pub helcim_webhook_url: Option<String>,
    pub podium_webhook_url: Option<String>,
    pub shippo_webhook_url: Option<String>,
    pub helcim_provider_delivery: ProviderDeliveryProof,
    pub podium_provider_delivery: ProviderDeliveryProof,
    pub status: String,
    pub warning_codes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ProviderDeliveryProof {
    pub provider: String,
    pub status: String,
    pub recent_delivery_count: i64,
    pub last_received_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_failure_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_failure_detail: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct EdgeAccessProbeResponse {
    pub status: String,
    pub probe_url: Option<String>,
    pub http_status: Option<u16>,
    pub response_ms: Option<u64>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
    pub message: String,
    pub error: Option<String>,
}

fn nonempty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn command_available(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            dir.join(format!("{name}.exe")).is_file()
        }
        #[cfg(not(windows))]
        {
            false
        }
    })
}

fn public_url_with_path(public_base_url: Option<&str>, path: &str) -> Option<String> {
    public_base_url.map(|base| format!("{}{}", base.trim_end_matches('/'), path))
}

fn provider_delivery_proof(
    provider: &str,
    recent_delivery_count: i64,
    last_received_at: Option<chrono::DateTime<chrono::Utc>>,
    last_failure_at: Option<chrono::DateTime<chrono::Utc>>,
    last_failure_detail: Option<String>,
) -> ProviderDeliveryProof {
    let (status, message) = if recent_delivery_count > 0 {
        (
            "verified_recent",
            "A real provider delivery reached Riverside in the last 7 days.",
        )
    } else if last_received_at.is_some() {
        (
            "seen_before",
            "A real provider delivery has reached Riverside before. Send a provider dashboard test event to confirm the current setup.",
        )
    } else if last_failure_at.is_some() {
        (
            "failure_only",
            "Provider webhook attempts are reaching Riverside but being rejected. Check the signing secret and provider webhook settings.",
        )
    } else {
        (
            "no_delivery",
            "No provider delivery has been recorded yet. Send a provider dashboard test event, then refresh this panel.",
        )
    };

    ProviderDeliveryProof {
        provider: provider.to_string(),
        status: status.to_string(),
        recent_delivery_count,
        last_received_at,
        last_failure_at,
        last_failure_detail,
        message: message.to_string(),
    }
}

async fn load_helcim_provider_delivery(
    state: &AppState,
) -> Result<ProviderDeliveryProof, SettingsError> {
    #[derive(sqlx::FromRow)]
    struct Row {
        recent_delivery_count: i64,
        last_received_at: Option<chrono::DateTime<chrono::Utc>>,
        last_failure_at: Option<chrono::DateTime<chrono::Utc>>,
        last_failure_detail: Option<String>,
    }

    let row: Row = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) FILTER (
                WHERE signature_valid = true
                  AND received_at >= now() - interval '7 days'
            )::bigint AS recent_delivery_count,
            MAX(received_at) FILTER (WHERE signature_valid = true) AS last_received_at,
            (
                SELECT received_at
                FROM helcim_event_log
                WHERE provider = 'helcim'
                  AND processing_status = 'failed'
                ORDER BY received_at DESC
                LIMIT 1
            ) AS last_failure_at,
            (
                SELECT error_message
                FROM helcim_event_log
                WHERE provider = 'helcim'
                  AND processing_status = 'failed'
                  AND error_message IS NOT NULL
                ORDER BY received_at DESC
                LIMIT 1
            ) AS last_failure_detail
        FROM helcim_event_log
        WHERE provider = 'helcim'
        "#,
    )
    .fetch_one(&state.db)
    .await?;

    Ok(provider_delivery_proof(
        "helcim",
        row.recent_delivery_count,
        row.last_received_at,
        row.last_failure_at,
        row.last_failure_detail,
    ))
}

async fn load_podium_provider_delivery(
    state: &AppState,
) -> Result<ProviderDeliveryProof, SettingsError> {
    #[derive(sqlx::FromRow)]
    struct Row {
        recent_delivery_count: i64,
        last_received_at: Option<chrono::DateTime<chrono::Utc>>,
        last_failure_at: Option<chrono::DateTime<chrono::Utc>>,
        last_failure_detail: Option<String>,
    }

    let row: Row = sqlx::query_as(
        r#"
        SELECT
            (
                SELECT COUNT(*)
                FROM podium_webhook_delivery
                WHERE received_at >= now() - interval '7 days'
            )::bigint AS recent_delivery_count,
            (SELECT MAX(received_at) FROM podium_webhook_delivery) AS last_received_at,
            (
                SELECT created_at
                FROM podium_webhook_failure
                ORDER BY created_at DESC
                LIMIT 1
            ) AS last_failure_at,
            (
                SELECT reason
                FROM podium_webhook_failure
                ORDER BY created_at DESC
                LIMIT 1
            ) AS last_failure_detail
        "#,
    )
    .fetch_one(&state.db)
    .await?;

    Ok(provider_delivery_proof(
        "podium",
        row.recent_delivery_count,
        row.last_received_at,
        row.last_failure_at,
        row.last_failure_detail,
    ))
}

async fn get_edge_access_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<EdgeAccessStatusResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;

    let public_base_url = nonempty_env("RIVERSIDE_PUBLIC_BASE_URL");
    let public_host = public_base_url.as_deref().and_then(|value| {
        url::Url::parse(value)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_string))
    });
    let public_https_configured = public_base_url
        .as_deref()
        .and_then(|value| url::Url::parse(value).ok())
        .map(|parsed| parsed.scheme() == "https")
        .unwrap_or(false);
    let cloudflared_installed = command_available("cloudflared");
    let cloudflared_launch_agent_configured = std::env::var("HOME")
        .ok()
        .map(|home| {
            std::path::Path::new(&home)
                .join("Library/LaunchAgents/com.cloudflare.riverside-helcim.plist")
                .is_file()
        })
        .unwrap_or(false)
        || std::path::Path::new("/Library/LaunchAgents/com.cloudflare.riverside-helcim.plist")
            .is_file();
    let cloudflare_tunnel_hint_configured = nonempty_env("RIVERSIDE_CLOUDFLARE_TUNNEL_HOSTNAME")
        .is_some()
        || public_host
            .as_deref()
            .map(|host| host.contains("riversidemens.com"))
            .unwrap_or(false);
    let helcim_webhook_secret_configured = nonempty_env("HELCIM_WEBHOOK_SECRET").is_some();
    let podium_webhook_secret_configured = podium_webhook_secret_from_env().is_some();
    let shippo_webhook_secret_configured = shippo_webhook_secret_from_env().is_some();
    let strict_production = env_truthy("RIVERSIDE_STRICT_PRODUCTION");
    let helcim_provider_delivery = load_helcim_provider_delivery(&state).await?;
    let podium_provider_delivery = load_podium_provider_delivery(&state).await?;

    let mut warning_codes = Vec::new();
    if public_base_url.is_none() {
        warning_codes.push("public_base_url_missing".to_string());
    } else if !public_https_configured {
        warning_codes.push("public_base_url_not_https".to_string());
    }
    if cloudflare_tunnel_hint_configured && !cloudflared_installed {
        warning_codes.push("cloudflared_not_installed".to_string());
    }
    if cloudflare_tunnel_hint_configured && !cloudflared_launch_agent_configured {
        warning_codes.push("cloudflared_service_not_detected".to_string());
    }
    if !helcim_webhook_secret_configured {
        warning_codes.push("helcim_webhook_secret_missing".to_string());
    }
    if !podium_webhook_secret_configured {
        warning_codes.push("podium_webhook_secret_missing".to_string());
    }
    if strict_production && !public_https_configured {
        warning_codes.push("strict_production_without_public_https".to_string());
    }

    let status = if public_https_configured
        && helcim_webhook_secret_configured
        && podium_webhook_secret_configured
        && (!cloudflare_tunnel_hint_configured
            || (cloudflared_installed && cloudflared_launch_agent_configured))
    {
        "ready"
    } else if public_base_url.is_some() {
        "attention"
    } else {
        "local_only"
    }
    .to_string();

    Ok(Json(EdgeAccessStatusResponse {
        public_host,
        public_https_configured,
        cloudflared_installed,
        cloudflared_launch_agent_configured,
        cloudflare_tunnel_hint_configured,
        helcim_webhook_secret_configured,
        podium_webhook_secret_configured,
        shippo_webhook_secret_configured,
        strict_production,
        helcim_webhook_url: public_url_with_path(
            public_base_url.as_deref(),
            "/api/webhooks/helcim",
        ),
        podium_webhook_url: public_url_with_path(
            public_base_url.as_deref(),
            "/api/webhooks/podium",
        ),
        shippo_webhook_url: public_url_with_path(
            public_base_url.as_deref(),
            "/api/webhooks/shippo",
        ),
        helcim_provider_delivery,
        podium_provider_delivery,
        public_base_url,
        status,
        warning_codes,
    }))
}

async fn post_edge_access_probe(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<EdgeAccessProbeResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;

    let checked_at = chrono::Utc::now();
    let Some(public_base_url) = nonempty_env("RIVERSIDE_PUBLIC_BASE_URL") else {
        return Ok(Json(EdgeAccessProbeResponse {
            status: "not_configured".to_string(),
            probe_url: None,
            http_status: None,
            response_ms: None,
            checked_at,
            message: "Set RIVERSIDE_PUBLIC_BASE_URL before running the live callback check."
                .to_string(),
            error: None,
        }));
    };

    let Ok(parsed_base_url) = url::Url::parse(&public_base_url) else {
        return Ok(Json(EdgeAccessProbeResponse {
            status: "failed".to_string(),
            probe_url: None,
            http_status: None,
            response_ms: None,
            checked_at,
            message: "The configured public base URL is not a valid URL.".to_string(),
            error: Some("invalid_public_base_url".to_string()),
        }));
    };

    if parsed_base_url.scheme() != "https" {
        return Ok(Json(EdgeAccessProbeResponse {
            status: "failed".to_string(),
            probe_url: None,
            http_status: None,
            response_ms: None,
            checked_at,
            message: "The live callback check requires an HTTPS public base URL.".to_string(),
            error: Some("public_base_url_not_https".to_string()),
        }));
    }

    let nonce = Uuid::new_v4().to_string();
    let probe_url = format!(
        "{}/api/webhooks/edge-probe?nonce={nonce}",
        public_base_url.trim_end_matches('/')
    );
    let started = Instant::now();
    let request = state
        .http_client
        .get(&probe_url)
        .header("cache-control", "no-store")
        .header("x-riverside-edge-probe", &nonce);

    let response_result = tokio::time::timeout(Duration::from_secs(8), request.send()).await;
    let response = match response_result {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return Ok(Json(EdgeAccessProbeResponse {
                status: "failed".to_string(),
                probe_url: Some(probe_url),
                http_status: None,
                response_ms: Some(started.elapsed().as_millis() as u64),
                checked_at,
                message: "The public callback URL did not return a ROS edge probe response."
                    .to_string(),
                error: Some(error.to_string()),
            }));
        }
        Err(_) => {
            return Ok(Json(EdgeAccessProbeResponse {
                status: "failed".to_string(),
                probe_url: Some(probe_url),
                http_status: None,
                response_ms: Some(started.elapsed().as_millis() as u64),
                checked_at,
                message: "The public callback URL timed out before reaching ROS.".to_string(),
                error: Some("probe_timeout".to_string()),
            }));
        }
    };

    let http_status = response.status();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let body = response.text().await.unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&body).ok();
    let probe_ok = http_status.is_success()
        && parsed
            .as_ref()
            .and_then(|value| value.get("component"))
            .and_then(Value::as_str)
            == Some("riverside-edge-probe")
        && parsed
            .as_ref()
            .and_then(|value| value.get("nonce"))
            .and_then(Value::as_str)
            == Some(nonce.as_str());

    if probe_ok {
        Ok(Json(EdgeAccessProbeResponse {
            status: "passed".to_string(),
            probe_url: Some(probe_url),
            http_status: Some(http_status.as_u16()),
            response_ms: Some(elapsed_ms),
            checked_at,
            message: "The configured public HTTPS callback path reached this Riverside OS server."
                .to_string(),
            error: None,
        }))
    } else {
        Ok(Json(EdgeAccessProbeResponse {
            status: "failed".to_string(),
            probe_url: Some(probe_url),
            http_status: Some(http_status.as_u16()),
            response_ms: Some(elapsed_ms),
            checked_at,
            message: "The public callback URL responded, but it was not this ROS edge probe."
                .to_string(),
            error: Some("unexpected_probe_response".to_string()),
        }))
    }
}

fn shippo_settings_response(cfg: &StoreShippoConfig) -> ShippoSettingsResponse {
    ShippoSettingsResponse {
        enabled: cfg.enabled,
        live_rates_enabled: cfg.live_rates_enabled,
        from_address: cfg.from_address.clone(),
        default_parcel: cfg.default_parcel.clone(),
        api_token_configured: shippo_api_token_from_env().is_some(),
        webhook_secret_configured: shippo_webhook_secret_from_env().is_some(),
    }
}

async fn get_shippo_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ShippoSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT shippo_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;
    let cfg = StoreShippoConfig::load_from_json(raw);
    Ok(Json(shippo_settings_response(&cfg)))
}

async fn patch_shippo_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<ShippoSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let existing_raw: Value =
        sqlx::query_scalar("SELECT shippo_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut current: StoreShippoConfig = StoreShippoConfig::load_from_json(existing_raw);

    if let Some(v) = body.get("enabled").and_then(|x| x.as_bool()) {
        current.enabled = v;
    }
    if let Some(v) = body.get("live_rates_enabled").and_then(|x| x.as_bool()) {
        current.live_rates_enabled = v;
    }
    if let Some(fa) = body.get("from_address") {
        if let Ok(addr) = serde_json::from_value::<ShippoAddressFields>(fa.clone()) {
            current.from_address = addr;
        }
    }
    if let Some(p) = body.get("default_parcel") {
        if let Ok(parcel) = serde_json::from_value::<DefaultParcel>(p.clone()) {
            current.default_parcel = parcel;
        }
    }

    let updated = serde_json::to_value(&current)
        .map_err(|e| SettingsError::InvalidPayload(format!("shippo_config serialization: {e}")))?;

    sqlx::query("UPDATE store_settings SET shippo_config = $1 WHERE id = 1")
        .bind(&updated)
        .execute(&state.db)
        .await?;

    Ok(Json(shippo_settings_response(&current)))
}

async fn test_shippo_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::logic::shippo::ShippoConnectionTestResult>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT shippo_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;
    let cfg = StoreShippoConfig::load_from_json(raw);
    let result =
        crate::logic::shippo::test_shippo_connection(&state.http_client, &cfg.from_address)
            .await
            .map_err(|e| SettingsError::InvalidPayload(e.to_string()))?;
    Ok(Json(result))
}

/// Max UTF-8 bytes for `store_settings.staff_sop_markdown` (≈128 KiB).
const MAX_STAFF_SOP_MARKDOWN_BYTES: usize = 131_072;

/// Max UTF-8 bytes for pasted Podium widget snippet in `podium_sms_config`.
const MAX_PODIUM_WIDGET_SNIPPET_BYTES: usize = 131_072;

#[derive(Debug, Serialize)]
pub struct StaffSopResponse {
    pub markdown: String,
}

#[derive(Debug, Deserialize)]
pub struct PutStaffSopBody {
    pub markdown: String,
}

async fn get_staff_sop(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StaffSopResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let md: String =
        sqlx::query_scalar("SELECT staff_sop_markdown FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    Ok(Json(StaffSopResponse { markdown: md }))
}

async fn put_staff_sop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PutStaffSopBody>,
) -> Result<Json<StaffSopResponse>, SettingsError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_set_perm)?;
    if body.markdown.len() > MAX_STAFF_SOP_MARKDOWN_BYTES {
        return Err(SettingsError::InvalidPayload(format!(
            "markdown exceeds {MAX_STAFF_SOP_MARKDOWN_BYTES} bytes"
        )));
    }

    sqlx::query("UPDATE store_settings SET staff_sop_markdown = $1 WHERE id = 1")
        .bind(&body.markdown)
        .execute(&state.db)
        .await?;

    let _ = log_staff_access(
        &state.db,
        staff.id,
        "staff_sop_update",
        json!({ "byte_len": body.markdown.len() }),
    )
    .await;

    Ok(Json(StaffSopResponse {
        markdown: body.markdown,
    }))
}

async fn podium_sms_settings_response(
    pool: &sqlx::PgPool,
    cfg: StorePodiumSmsConfig,
) -> PodiumSmsSettingsResponse {
    let templates_effective = cfg.templates.merged_defaults();
    PodiumSmsSettingsResponse {
        sms_send_enabled: cfg.sms_send_enabled,
        location_uid: cfg.location_uid,
        widget_embed_enabled: cfg.widget_embed_enabled,
        widget_snippet_html: cfg.widget_snippet_html,
        templates: cfg.templates,
        templates_effective,
        credentials_configured: PodiumEnvCredentials::load(pool).await.is_some(),
        oauth_authorize_url: "https://api.podium.com/oauth/authorize",
        oauth_token_url_hint: "https://api.podium.com/oauth/token — set RIVERSIDE_PODIUM_OAUTH_TOKEN_URL if Podium instructs a different token host (some samples use accounts.podium.com).",
    }
}

async fn get_podium_sms_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PodiumSmsSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value =
        sqlx::query_scalar("SELECT podium_sms_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let cfg = StorePodiumSmsConfig::load_from_json(raw);
    Ok(Json(podium_sms_settings_response(&state.db, cfg).await))
}

#[derive(Debug, Deserialize, Default)]
struct PatchPodiumSmsTemplatesBody {
    ready_for_pickup: Option<String>,
    alteration_ready: Option<String>,
    unknown_sender_welcome: Option<String>,
    loyalty_reward_redeemed: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct PatchPodiumSmsBody {
    sms_send_enabled: Option<bool>,
    location_uid: Option<String>,
    widget_embed_enabled: Option<bool>,
    widget_snippet_html: Option<String>,
    templates: Option<PatchPodiumSmsTemplatesBody>,
}

async fn patch_podium_sms_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchPodiumSmsBody>,
) -> Result<Json<PodiumSmsSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let existing_raw: Value =
        sqlx::query_scalar("SELECT podium_sms_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut current = StorePodiumSmsConfig::load_from_json(existing_raw);

    if let Some(v) = body.sms_send_enabled {
        current.sms_send_enabled = v;
    }
    current.email_send_enabled = false;
    if let Some(s) = body.location_uid {
        current.location_uid = s;
    }
    if let Some(v) = body.widget_embed_enabled {
        current.widget_embed_enabled = v;
    }
    if let Some(s) = body.widget_snippet_html {
        if s.len() > MAX_PODIUM_WIDGET_SNIPPET_BYTES {
            return Err(SettingsError::InvalidPayload(format!(
                "widget_snippet_html exceeds {MAX_PODIUM_WIDGET_SNIPPET_BYTES} bytes"
            )));
        }
        current.widget_snippet_html = s;
    }
    if let Some(t) = body.templates {
        if let Some(s) = t.ready_for_pickup {
            current.templates.ready_for_pickup = s;
        }
        if let Some(s) = t.alteration_ready {
            current.templates.alteration_ready = s;
        }
        if let Some(s) = t.unknown_sender_welcome {
            current.templates.unknown_sender_welcome = s;
        }
        if let Some(s) = t.loyalty_reward_redeemed {
            current.templates.loyalty_reward_redeemed = s;
        }
    }
    let updated = serde_json::to_value(&current).map_err(|e| {
        SettingsError::InvalidPayload(format!("podium_sms_config serialization: {e}"))
    })?;

    sqlx::query("UPDATE store_settings SET podium_sms_config = $1 WHERE id = 1")
        .bind(&updated)
        .execute(&state.db)
        .await?;

    Ok(Json(podium_sms_settings_response(&state.db, current).await))
}

#[derive(Debug, Deserialize, Default)]
struct PatchEmailSettingsBody {
    enabled: Option<bool>,
    from_email: Option<String>,
    from_name: Option<String>,
    reply_to_email: Option<String>,
    imap_host: Option<String>,
    imap_port: Option<u16>,
    imap_tls: Option<bool>,
    imap_folder: Option<String>,
    smtp_host: Option<String>,
    smtp_port: Option<u16>,
    smtp_tls: Option<String>,
    sync_enabled: Option<bool>,
    sync_limit: Option<i64>,
}

async fn get_email_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<email::EmailSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    email::email_settings_response(&state.db)
        .await
        .map(Json)
        .map_err(|error| match error {
            email::EmailError::Db(error) => SettingsError::Database(error),
            other => SettingsError::InvalidPayload(other.to_string()),
        })
}

fn clean_email_text(value: String, label: &str, max_len: usize) -> Result<String, SettingsError> {
    let trimmed = value.trim();
    if trimmed.len() > max_len {
        return Err(SettingsError::InvalidPayload(format!(
            "{label} exceeds {max_len} characters"
        )));
    }
    Ok(trimmed.to_string())
}

async fn patch_email_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchEmailSettingsBody>,
) -> Result<Json<email::EmailSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let mut cfg: StoreEmailConfig = email::load_store_email_config(&state.db).await?;
    if let Some(v) = body.enabled {
        cfg.enabled = v;
    }
    if let Some(v) = body.from_email {
        cfg.from_email = clean_email_text(v, "from_email", 320)?;
    }
    if let Some(v) = body.from_name {
        cfg.from_name = clean_email_text(v, "from_name", 160)?;
    }
    if let Some(v) = body.reply_to_email {
        cfg.reply_to_email = clean_email_text(v, "reply_to_email", 320)?;
    }
    if let Some(v) = body.imap_host {
        cfg.imap_host = clean_email_text(v, "imap_host", 255)?;
    }
    if let Some(v) = body.imap_port {
        cfg.imap_port = v;
    }
    if let Some(v) = body.imap_tls {
        cfg.imap_tls = v;
    }
    if let Some(v) = body.imap_folder {
        cfg.imap_folder = clean_email_text(v, "imap_folder", 120)?;
    }
    if let Some(v) = body.smtp_host {
        cfg.smtp_host = clean_email_text(v, "smtp_host", 255)?;
    }
    if let Some(v) = body.smtp_port {
        cfg.smtp_port = v;
    }
    if let Some(v) = body.smtp_tls {
        let mode = clean_email_text(v, "smtp_tls", 20)?;
        if !matches!(mode.as_str(), "ssl_tls" | "starttls") {
            return Err(SettingsError::InvalidPayload(
                "smtp_tls must be ssl_tls or starttls".to_string(),
            ));
        }
        cfg.smtp_tls = mode;
    }
    if let Some(v) = body.sync_enabled {
        cfg.sync_enabled = v;
    }
    if let Some(v) = body.sync_limit {
        cfg.sync_limit = v.clamp(1, 250);
    }
    email::save_store_email_config(&state.db, &cfg).await?;
    email::email_settings_response(&state.db)
        .await
        .map(Json)
        .map_err(|error| match error {
            email::EmailError::Db(error) => SettingsError::Database(error),
            other => SettingsError::InvalidPayload(other.to_string()),
        })
}

#[derive(Debug, Serialize)]
struct PodiumSmsReadinessResponse {
    credentials_configured: bool,
    webhook_secret_configured: bool,
    allow_unsigned_webhook: bool,
    inbound_inbox_preview_enabled: bool,
    /// Effective REST API base (env `RIVERSIDE_PODIUM_API_BASE` or default).
    api_base: String,
    sms_send_enabled: bool,
    location_uid_configured: bool,
    widget_embed_enabled: bool,
}

async fn get_podium_sms_readiness(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PodiumSmsReadinessResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value =
        sqlx::query_scalar("SELECT podium_sms_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let cfg = StorePodiumSmsConfig::load_from_json(raw);
    Ok(Json(PodiumSmsReadinessResponse {
        credentials_configured: PodiumEnvCredentials::load(&state.db).await.is_some(),
        webhook_secret_configured: podium_webhook_secret_from_env().is_some(),
        allow_unsigned_webhook: allow_unsigned_podium_webhook(),
        inbound_inbox_preview_enabled: podium_inbound_inbox_enabled(),
        api_base: podium_effective_rest_api_base(&state.db).await,
        sms_send_enabled: cfg.sms_send_enabled,
        location_uid_configured: !cfg.location_uid.trim().is_empty(),
        widget_embed_enabled: cfg.widget_embed_enabled,
    }))
}

#[derive(Debug, Deserialize)]
struct PodiumOauthAuthorizeUrlQuery {
    redirect_uri: String,
    state: String,
    scope: Option<String>,
}

#[derive(Debug, Serialize)]
struct PodiumOauthAuthorizeUrlResponse {
    authorize_url: String,
}

async fn get_podium_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;

    let health = crate::logic::podium::health_check(&state.http_client).await;
    Ok(Json(json!({
        "configured": health.configured,
        "reachable": health.reachable,
        "latency_ms": health.latency_ms,
        "message": health.message,
    })))
}

async fn get_podium_oauth_authorize_url(
    headers: HeaderMap,
    State(state): State<AppState>,
    Query(q): Query<PodiumOauthAuthorizeUrlQuery>,
) -> Result<Json<PodiumOauthAuthorizeUrlResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    if !validate_podium_oauth_redirect_uri(&q.redirect_uri) {
        return Err(SettingsError::InvalidPayload(
            "redirect_uri must be https with path /callback, or http://localhost|127.0.0.1 with path /callback"
                .to_string(),
        ));
    }
    if !validate_podium_oauth_state(&q.state) {
        return Err(SettingsError::InvalidPayload(
            "state must be non-empty, at most 200 chars, [A-Za-z0-9_-]".to_string(),
        ));
    }
    let status = podium_oauth_app_credential_status(&state.db).await;
    if !status.client_id_configured {
        return Err(SettingsError::InvalidPayload(
            "Podium client ID is not configured".to_string(),
        ));
    }
    if !status.client_secret_configured {
        return Err(SettingsError::InvalidPayload(
            "Podium client secret is not configured. Save it before authorizing so Riverside can finish the Podium callback.".to_string(),
        ));
    }
    let Some(client_id) = podium_oauth_client_id(&state.db).await else {
        return Err(SettingsError::InvalidPayload(
            "Podium client ID is not configured".to_string(),
        ));
    };
    let scope = q.scope.as_deref();
    let api_base = podium_effective_rest_api_base(&state.db).await;
    let url = build_podium_oauth_authorize_url_for_base(
        api_base.as_str(),
        client_id.as_str(),
        q.redirect_uri.trim(),
        q.state.trim(),
        scope,
    );
    Ok(Json(PodiumOauthAuthorizeUrlResponse { authorize_url: url }))
}

#[derive(Debug, Deserialize)]
struct PodiumOauthExchangeBody {
    code: String,
    redirect_uri: String,
}

async fn post_podium_oauth_exchange(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<PodiumOauthExchangeBody>,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let Some(app) = PodiumOAuthAppCredentials::load(&state.db).await else {
        return Err(SettingsError::InvalidPayload(
            "Podium client ID and client secret must be configured".to_string(),
        ));
    };
    if !validate_podium_oauth_redirect_uri(&body.redirect_uri) {
        return Err(SettingsError::InvalidPayload(
            "redirect_uri must be https with path /callback, or http://localhost|127.0.0.1 with path /callback"
                .to_string(),
        ));
    }
    let code = body.code.trim();
    if code.is_empty() {
        return Err(SettingsError::InvalidPayload(
            "authorization code is empty".to_string(),
        ));
    }

    let out = exchange_podium_oauth_authorization_code(
        &state.http_client,
        &app,
        code,
        body.redirect_uri.trim(),
    )
    .await
    .map_err(|e| {
        tracing::warn!(
            error = e.to_string(),
            "Podium OAuth authorization_code exchange failed"
        );
        SettingsError::InvalidPayload(format!("Podium token exchange failed: {e}"))
    })?;

    Ok(Json(json!({
        "refresh_token": out.refresh_token,
        "expires_in": out.expires_in,
    })))
}

#[derive(Debug, sqlx::FromRow)]
struct MeilisearchSyncDbRow {
    pub index_name: String,
    pub last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_attempt_at: chrono::DateTime<chrono::Utc>,
    pub is_success: bool,
    pub row_count: i64,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeilisearchTaskSummary {
    pub uid: u32,
    pub status: String,
    pub index_uid: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MeilisearchSyncRow {
    pub index_name: String,
    pub last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_attempt_at: Option<chrono::DateTime<chrono::Utc>>,
    pub is_success: bool,
    pub row_count: i64,
    pub error_message: Option<String>,
    pub document_count: Option<usize>,
    pub latest_task: Option<MeilisearchTaskSummary>,
    pub latest_failed_task: Option<MeilisearchTaskSummary>,
}

#[derive(Debug, Serialize)]
pub struct MeilisearchStatusResponse {
    pub configured: bool,
    pub connection_ok: bool,
    pub connection_error: Option<String>,
    pub indices: Vec<MeilisearchSyncRow>,
    pub is_indexing: bool,
}

fn meili_connection_error_message(e: &meilisearch_sdk::errors::Error) -> String {
    let detail = e.to_string();
    if detail.contains("invalid_api_key") {
        "Meilisearch rejected the saved API key. Save the current Meilisearch API key and refresh."
            .to_string()
    } else {
        format!("Meilisearch connection check failed: {detail}")
    }
}

fn meili_task_summary(task: &meilisearch_sdk::tasks::Task) -> MeilisearchTaskSummary {
    match task {
        meilisearch_sdk::tasks::Task::Enqueued { content } => MeilisearchTaskSummary {
            uid: content.uid,
            status: "enqueued".to_string(),
            index_uid: content.index_uid.clone(),
            error: None,
        },
        meilisearch_sdk::tasks::Task::Processing { content } => MeilisearchTaskSummary {
            uid: content.uid,
            status: "processing".to_string(),
            index_uid: content.index_uid.clone(),
            error: None,
        },
        meilisearch_sdk::tasks::Task::Succeeded { content } => MeilisearchTaskSummary {
            uid: content.uid,
            status: "succeeded".to_string(),
            index_uid: content.index_uid.clone(),
            error: None,
        },
        meilisearch_sdk::tasks::Task::Failed { content } => MeilisearchTaskSummary {
            uid: content.task.uid,
            status: "failed".to_string(),
            index_uid: content.task.index_uid.clone(),
            error: Some(content.error.to_string()),
        },
    }
}

async fn meili_document_counts_from_env() -> HashMap<String, usize> {
    let Some(url) = std::env::var("RIVERSIDE_MEILISEARCH_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
    else {
        return HashMap::new();
    };
    let key = std::env::var("RIVERSIDE_MEILISEARCH_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let http = reqwest::Client::new();
    let mut req = http.get(format!("{url}/stats"));
    if let Some(key) = key {
        req = req.bearer_auth(key);
    }

    let Ok(resp) = req.send().await else {
        return HashMap::new();
    };
    let Ok(body) = resp.json::<Value>().await else {
        return HashMap::new();
    };
    let Some(indexes) = body.get("indexes").and_then(Value::as_object) else {
        return HashMap::new();
    };

    indexes
        .iter()
        .filter_map(|(uid, stats)| {
            let count = stats.get("numberOfDocuments")?.as_u64()?;
            Some((uid.clone(), count as usize))
        })
        .collect()
}

async fn get_meilisearch_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeilisearchStatusResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let tracked_indices = vec![
        "ros_reindex_run".to_string(),
        crate::logic::meilisearch_client::INDEX_VARIANTS.to_string(),
        crate::logic::meilisearch_client::INDEX_STORE_PRODUCTS.to_string(),
        crate::logic::meilisearch_client::INDEX_CUSTOMERS.to_string(),
        crate::logic::meilisearch_client::INDEX_WEDDING_PARTIES.to_string(),
        crate::logic::meilisearch_client::INDEX_ORDERS.to_string(),
        crate::logic::meilisearch_client::INDEX_TRANSACTIONS.to_string(),
        crate::logic::meilisearch_client::INDEX_HELP.to_string(),
        crate::logic::meilisearch_client::INDEX_STAFF.to_string(),
        crate::logic::meilisearch_client::INDEX_VENDORS.to_string(),
        crate::logic::meilisearch_client::INDEX_CATEGORIES.to_string(),
        crate::logic::meilisearch_client::INDEX_APPOINTMENTS.to_string(),
        crate::logic::meilisearch_client::INDEX_TASKS.to_string(),
        crate::logic::meilisearch_client::INDEX_ALTERATIONS.to_string(),
    ];
    let sync_rows = sqlx::query_as::<_, MeilisearchSyncDbRow>(
        r#"
        SELECT index_name, last_success_at, last_attempt_at, is_success, row_count, error_message
        FROM meilisearch_sync_status
        WHERE index_name = ANY($1)
        ORDER BY index_name
        "#,
    )
    .bind(&tracked_indices)
    .fetch_all(&state.db)
    .await?;

    let sync_by_index: HashMap<String, MeilisearchSyncDbRow> = sync_rows
        .into_iter()
        .map(|row| (row.index_name.clone(), row))
        .collect();

    let mut doc_counts: HashMap<String, usize> = HashMap::new();
    let mut latest_by_index: HashMap<String, MeilisearchTaskSummary> = HashMap::new();
    let mut latest_failed_by_index: HashMap<String, MeilisearchTaskSummary> = HashMap::new();
    let mut connection_error: Option<String> = None;

    let meilisearch_client = state
        .meilisearch
        .clone()
        .or_else(crate::logic::meilisearch_client::meilisearch_from_env);

    let is_indexing = if let Some(client) = &meilisearch_client {
        match client.get_tasks().await {
            Ok(tasks) => {
                doc_counts = meili_document_counts_from_env().await;
                let is_indexing = tasks.results.iter().any(|t| {
                    matches!(
                        t,
                        meilisearch_sdk::tasks::Task::Enqueued { .. }
                            | meilisearch_sdk::tasks::Task::Processing { .. }
                    )
                });
                for task in tasks.results {
                    let summary = meili_task_summary(&task);
                    if let Some(index_uid) = summary.index_uid.clone() {
                        latest_by_index
                            .entry(index_uid.clone())
                            .or_insert_with(|| summary.clone());
                        if summary.status == "failed" {
                            latest_failed_by_index.entry(index_uid).or_insert(summary);
                        }
                    }
                }
                is_indexing
            }
            Err(e) => {
                connection_error = Some(meili_connection_error_message(&e));
                false
            }
        }
    } else {
        false
    };

    let indices = tracked_indices
        .into_iter()
        .map(|index_name| {
            let sync = sync_by_index.get(&index_name);
            MeilisearchSyncRow {
                index_name: index_name.clone(),
                last_success_at: sync.and_then(|row| row.last_success_at),
                last_attempt_at: sync.map(|row| row.last_attempt_at),
                is_success: sync.map(|row| row.is_success).unwrap_or(false),
                row_count: sync.map(|row| row.row_count).unwrap_or(0),
                error_message: sync.and_then(|row| row.error_message.clone()),
                document_count: doc_counts.get(&index_name).copied(),
                latest_task: latest_by_index.get(&index_name).cloned(),
                latest_failed_task: latest_failed_by_index.get(&index_name).cloned(),
            }
        })
        .collect();

    Ok(Json(MeilisearchStatusResponse {
        configured: meilisearch_client.is_some(),
        connection_ok: meilisearch_client.is_some() && connection_error.is_none(),
        connection_error,
        indices,
        is_indexing,
    }))
}

async fn post_meilisearch_reindex(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_set_perm)?;
    let Some(c) = state
        .meilisearch
        .clone()
        .or_else(crate::logic::meilisearch_client::meilisearch_from_env)
    else {
        return Err(SettingsError::InvalidPayload(
            "Meilisearch is not configured. Save the search host first.".to_string(),
        ));
    };
    if let Err(e) = c.get_tasks().await {
        return Err(SettingsError::InvalidPayload(
            meili_connection_error_message(&e),
        ));
    }
    crate::logic::meilisearch_sync::reindex_all_meilisearch(&c, &state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = e.to_string(), "Meilisearch reindex failed");
            SettingsError::InvalidPayload(format!("Meilisearch reindex failed: {e}"))
        })?;
    let _ = log_staff_access(
        &state.db,
        staff.id,
        "meilisearch_reindex",
        json!({ "status": "completed" }),
    )
    .await;
    Ok(Json(json!({ "status": "ok" })))
}

#[derive(Debug, Serialize)]
struct InsightsSettingsResponse {
    config: StoreInsightsConfig,
    jwt_secret_configured: bool,
}

fn metabase_jwt_secret_configured() -> bool {
    match std::env::var("RIVERSIDE_METABASE_JWT_SECRET") {
        Ok(s) => {
            let t = s.trim();
            !t.is_empty() && t.len() >= 16
        }
        Err(_) => false,
    }
}

async fn get_insights_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<InsightsSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT insights_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;
    let config = StoreInsightsConfig::from_json_value(raw);
    Ok(Json(InsightsSettingsResponse {
        config,
        jwt_secret_configured: metabase_jwt_secret_configured(),
    }))
}

async fn patch_insights_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<InsightsSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT insights_config FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;
    let mut config = StoreInsightsConfig::from_json_value(raw);
    config
        .apply_patch(&body)
        .map_err(SettingsError::InvalidPayload)?;
    let updated = config.to_json_value();
    sqlx::query("UPDATE store_settings SET insights_config = $1 WHERE id = 1")
        .bind(&updated)
        .execute(&state.db)
        .await?;
    Ok(Json(InsightsSettingsResponse {
        config,
        jwt_secret_configured: metabase_jwt_secret_configured(),
    }))
}

async fn patch_backup_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<BackupSettingsResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let existing_raw: Value =
        sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut existing: Value = existing_raw;
    if let (Value::Object(existing_map), Value::Object(new_map)) = (&mut existing, body) {
        for (k, v) in new_map {
            existing_map.insert(k, v);
        }
    }

    sqlx::query("UPDATE store_settings SET backup_settings = $1 WHERE id = 1")
        .bind(&existing)
        .execute(&state.db)
        .await?;

    let cfg: BackupSettings = serde_json::from_value(existing).unwrap_or_default();
    Ok(Json(backup_settings_response(cfg)))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/receipt/preview-html", get(get_receipt_preview_html))
        .route(
            "/receipt",
            get(get_receipt_config).patch(patch_receipt_config),
        )
        .route("/rosie", get(get_rosie_config).patch(patch_rosie_config))
        .route("/rosie/token-metrics", get(get_rosie_token_metrics))
        .route("/backups", get(get_backups))
        .route("/backups/create", post(create_backup))
        .route("/backups/restore/{filename}", post(restore_backup))
        .route("/backups/{filename}", delete(delete_backup))
        .route("/backups/download/{filename}", get(get_backup_download))
        .route(
            "/backup/config",
            get(get_backup_settings).patch(patch_backup_settings),
        )
        .route("/database/stats", get(get_db_stats))
        .route("/database/optimize", post(optimize_db))
        .route(
            "/integration-credentials/{integration_key}",
            get(get_integration_credentials_status).patch(patch_integration_credentials),
        )
        .route(
            "/integration-credentials/{integration_key}/{credential_key}",
            delete(delete_integration_credential),
        )
        .route(
            "/weather",
            get(get_weather_settings).patch(patch_weather_settings),
        )
        .route(
            "/shippo",
            get(get_shippo_settings).patch(patch_shippo_settings),
        )
        .route("/shippo/test-connection", post(test_shippo_connection))
        .route(
            "/podium-sms",
            get(get_podium_sms_settings).patch(patch_podium_sms_settings),
        )
        .route(
            "/email",
            get(get_email_settings).patch(patch_email_settings),
        )
        .route("/podium-sms/readiness", get(get_podium_sms_readiness))
        .route("/podium-health", get(get_podium_health))
        .route(
            "/podium-oauth/authorize-url",
            get(get_podium_oauth_authorize_url),
        )
        .route("/podium-oauth/exchange", post(post_podium_oauth_exchange))
        .route("/staff-sop", get(get_staff_sop).put(put_staff_sop))
        .route("/meilisearch/status", get(get_meilisearch_status))
        .route("/meilisearch/reindex", post(post_meilisearch_reindex))
        .route(
            "/insights",
            get(get_insights_settings).patch(patch_insights_settings),
        )
        .route(
            "/review-policy",
            get(get_review_policy).patch(patch_review_policy),
        )
        .route("/remote-access/status", get(get_remote_access_status))
        .route("/edge-access/status", get(get_edge_access_status))
        .route("/edge-access/probe", post(post_edge_access_probe))
        .route("/remote-access/connect", post(post_remote_access_connect))
        .route(
            "/remote-access/disconnect",
            post(post_remote_access_disconnect),
        )
        .nest("/nuorder", build_nuorder_router())
        .route("/fal/billing", get(get_fal_billing))
        .route("/fal/usage", get(get_fal_usage))
        .route(
            "/pos-station-config",
            get(get_pos_station_config).patch(patch_pos_station_config),
        )
        .route(
            "/pos-station-config/public",
            get(get_pos_station_config_public),
        )
        .route(
            "/printer-config/{register_lane}",
            get(get_printer_config).patch(patch_printer_config),
        )
}

async fn get_review_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StoreReviewPolicy>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let p = podium_reviews::load_store_review_policy(&state.db)
        .await
        .map_err(SettingsError::Database)?;
    Ok(Json(p))
}

#[derive(Debug, Deserialize)]
struct PatchReviewPolicyBody {
    #[serde(default)]
    pub review_invites_enabled: Option<bool>,
    #[serde(default)]
    pub send_review_invite_by_default: Option<bool>,
}

async fn patch_review_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchReviewPolicyBody>,
) -> Result<Json<StoreReviewPolicy>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let mut cur = podium_reviews::load_store_review_policy(&state.db)
        .await
        .map_err(SettingsError::Database)?;
    if let Some(v) = body.review_invites_enabled {
        cur.review_invites_enabled = v;
    }
    if let Some(v) = body.send_review_invite_by_default {
        cur.send_review_invite_by_default = v;
    }
    podium_reviews::save_store_review_policy(&state.db, &cur)
        .await
        .map_err(SettingsError::Database)?;
    Ok(Json(cur))
}

// ── POS Station Config ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct PosStationConfig {
    max_register_lanes: i16,
    #[serde(flatten)]
    extra: serde_json::Value,
}

async fn get_pos_station_config_public(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, SettingsError> {
    let raw: serde_json::Value =
        sqlx::query_scalar("SELECT pos_station_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let max_lanes = raw
        .get("max_register_lanes")
        .and_then(|v| v.as_i64())
        .unwrap_or(4) as i16;
    Ok(Json(json!({
        "max_register_lanes": max_lanes,
    })))
}

async fn get_pos_station_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: serde_json::Value =
        sqlx::query_scalar("SELECT pos_station_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    Ok(Json(raw))
}

async fn patch_pos_station_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let existing_raw: serde_json::Value =
        sqlx::query_scalar("SELECT pos_station_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut existing = existing_raw;
    if let (serde_json::Value::Object(existing_map), serde_json::Value::Object(new_map)) =
        (&mut existing, body)
    {
        for (k, v) in new_map {
            existing_map.insert(k, v);
        }
    }

    sqlx::query("UPDATE store_settings SET pos_station_config = $1 WHERE id = 1")
        .bind(&existing)
        .execute(&state.db)
        .await?;

    Ok(Json(existing))
}

// ── Printer Config (per register lane) ──────────────────────────────────────

async fn get_printer_config(
    State(state): State<AppState>,
    Path(register_lane): Path<i16>,
) -> Result<Json<serde_json::Value>, SettingsError> {
    let raw: serde_json::Value =
        sqlx::query_scalar("SELECT pos_station_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let config = raw
        .get("printer_config")
        .and_then(|v| v.get(register_lane.to_string()))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(Json(config))
}

async fn patch_printer_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(register_lane): Path<i16>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: serde_json::Value =
        sqlx::query_scalar("SELECT pos_station_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let mut existing = raw;
    let mut printer_config = existing
        .get("printer_config")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    if let serde_json::Value::Object(ref mut map) = printer_config {
        map.insert(register_lane.to_string(), body);
    }

    if let serde_json::Value::Object(ref mut root) = existing {
        root.insert("printer_config".to_string(), printer_config);
    }

    sqlx::query("UPDATE store_settings SET pos_station_config = $1 WHERE id = 1")
        .bind(&existing)
        .execute(&state.db)
        .await?;

    Ok(Json(existing))
}

async fn get_remote_access_status(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = RemoteAccessManager::new();
    let status = manager
        .get_status()
        .await
        .map_err(|e| SettingsError::InvalidPayload(e.to_string()))?;

    let ip = addr.ip().to_string();
    let mut current_peer = None;

    // Tailscale IPs start with 100.
    if ip.starts_with("100.") {
        if let Ok(peer) = manager.whois(&ip).await {
            current_peer = Some(peer);
        }
    }

    Ok(Json(json!({
        "status": status,
        "current_peer": current_peer,
    })))
}

#[derive(Deserialize)]
struct ConnectBody {
    auth_key: String,
}

async fn post_remote_access_connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ConnectBody>,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = RemoteAccessManager::new();
    manager
        .connect(&body.auth_key)
        .await
        .map_err(|e| SettingsError::InvalidPayload(e.to_string()))?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn post_remote_access_disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = RemoteAccessManager::new();
    manager
        .disconnect()
        .await
        .map_err(|e| SettingsError::InvalidPayload(e.to_string()))?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_fal_billing(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let fal_key = std::env::var("FAL_KEY").map_err(|_| {
        SettingsError::InvalidPayload("FAL_KEY is not configured in settings".to_string())
    })?;

    let res = state
        .http_client
        .get("https://api.fal.ai/v1/account/billing?expand=credits")
        .header("Authorization", format!("Key {}", fal_key))
        .send()
        .await
        .map_err(|e| SettingsError::InvalidPayload(format!("Failed to reach Fal.ai: {e}")))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(SettingsError::InvalidPayload(format!(
            "Fal.ai error ({}): {}",
            status, text
        )));
    }

    let val: Value = res
        .json()
        .await
        .map_err(|e| SettingsError::InvalidPayload(format!("Invalid JSON from Fal.ai: {e}")))?;
    Ok(Json(val))
}

async fn get_fal_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let fal_key = std::env::var("FAL_KEY").map_err(|_| {
        SettingsError::InvalidPayload("FAL_KEY is not configured in settings".to_string())
    })?;

    let res = state
        .http_client
        .get("https://api.fal.ai/v1/models/usage")
        .header("Authorization", format!("Key {}", fal_key))
        .send()
        .await
        .map_err(|e| SettingsError::InvalidPayload(format!("Failed to reach Fal.ai: {e}")))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(SettingsError::InvalidPayload(format!(
            "Fal.ai error ({}): {}",
            status, text
        )));
    }

    let val: Value = res
        .json()
        .await
        .map_err(|e| SettingsError::InvalidPayload(format!("Invalid JSON from Fal.ai: {e}")))?;
    Ok(Json(val))
}

#[cfg(test)]
mod tests {
    use super::{
        validate_restore_catalog_membership, validate_restore_confirmation,
        validate_restore_environment, validate_restore_register_blocker, SettingsError,
    };

    fn err_message(err: SettingsError) -> String {
        match err {
            SettingsError::Database(e) => e.to_string(),
            SettingsError::Backup(m)
            | SettingsError::Conflict(m)
            | SettingsError::InvalidPayload(m)
            | SettingsError::Unauthorized(m)
            | SettingsError::Forbidden(m) => m,
        }
    }

    #[test]
    fn restore_confirmation_requires_exact_filename() {
        let filename = "backup_20260425_120000.dump";

        assert!(validate_restore_confirmation(filename, Some(filename)).is_ok());

        let missing = validate_restore_confirmation(filename, None).expect_err("missing body");
        assert!(matches!(missing, SettingsError::InvalidPayload(_)));
        assert!(err_message(missing).contains("confirmation_filename"));

        let mismatch = validate_restore_confirmation(filename, Some("different.dump"))
            .expect_err("mismatched confirmation");
        assert!(matches!(mismatch, SettingsError::InvalidPayload(_)));
        assert!(err_message(mismatch).contains("exactly match"));
    }

    #[test]
    fn restore_environment_blocks_strict_production_without_emergency_unlock() {
        let locked =
            validate_restore_environment(true, false).expect_err("strict production is locked");
        assert!(matches!(locked, SettingsError::Conflict(_)));
        assert!(err_message(locked).contains("Production restore is locked"));

        assert!(validate_restore_environment(true, true).is_ok());
        assert!(validate_restore_environment(false, false).is_ok());
    }

    #[test]
    fn restore_register_blocker_rejects_open_or_reconciling_sessions() {
        assert!(validate_restore_register_blocker(0).is_ok());

        let blocked =
            validate_restore_register_blocker(2).expect_err("open registers block restore");
        assert!(matches!(blocked, SettingsError::Conflict(_)));
        assert!(err_message(blocked).contains("2 register session(s)"));
    }

    #[test]
    fn restore_catalog_membership_requires_listed_backup() {
        assert!(validate_restore_catalog_membership(true).is_ok());

        let missing =
            validate_restore_catalog_membership(false).expect_err("non-catalog backup rejected");
        assert!(matches!(missing, SettingsError::InvalidPayload(_)));
        assert!(err_message(missing).contains("local backup catalog"));
    }
}
