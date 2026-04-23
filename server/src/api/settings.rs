//! Application settings API.
//!
//! Persists receipt configuration in `store_settings.receipt_config` (JSONB).

use crate::logic::backups::{BackupFile, BackupManager, BackupSettings};
use crate::logic::insights_config::StoreInsightsConfig;
use crate::logic::remote_access::RemoteAccessManager;
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
use std::net::SocketAddr;
use thiserror::Error;

use crate::api::AppState;
use crate::auth::permissions::SETTINGS_ADMIN;
use crate::auth::pins::log_staff_access;
use crate::logic::nuorder::{NuorderClient, NuorderCredentials};
use crate::logic::nuorder_sync;
use crate::logic::podium::{
    build_podium_oauth_authorize_url, exchange_podium_oauth_authorization_code,
    podium_rest_api_base, validate_podium_oauth_redirect_uri, validate_podium_oauth_state,
    PodiumEnvCredentials, PodiumOAuthAppCredentials, PodiumSmsSettingsResponse,
    StorePodiumSmsConfig,
};
use crate::logic::podium_reviews::{self, StoreReviewPolicy};
use crate::logic::podium_webhook::{
    allow_unsigned_podium_webhook, podium_inbound_inbox_enabled, podium_webhook_secret_from_env,
};
use crate::logic::shippo::{
    shippo_api_token_from_env, shippo_webhook_secret_from_env, DefaultParcel, ShippoAddressFields,
    StoreShippoConfig,
};
use crate::logic::weather::{merge_weather_env_overrides, StoreWeatherSettings};
use crate::middleware;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Backup error: {0}")]
    Backup(String),
    #[error("{0}")]
    InvalidPayload(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
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

pub struct MeilisearchStatusResponseBasic {
    pub configured: bool,
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
    /// `zpl` = legacy thermal (`receipt.zpl`). `studio_html` = merged HTML in browser print dialog.
    #[serde(default = "default_receipt_thermal_mode")]
    pub receipt_thermal_mode: String,
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
    "zpl".to_string()
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
            header_lines: Vec::new(),
            footer_lines: default_footer(),
            timezone: default_timezone(),
            receipt_studio_project_json: None,
            receipt_studio_exported_html: None,
            receipt_thermal_mode: default_receipt_thermal_mode(),
        }
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

    let cfg: ReceiptConfig = serde_json::from_value(raw).unwrap_or_default();
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

    sqlx::query("UPDATE store_settings SET receipt_config = $1 WHERE id = 1")
        .bind(&existing)
        .execute(&state.db)
        .await?;

    let cfg: ReceiptConfig = serde_json::from_value(existing).unwrap_or_default();
    Ok(Json(cfg))
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

    let cfg: ReceiptConfig = serde_json::from_value(raw).unwrap_or_default();
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
    let filename = match manager.create_backup().await {
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
    Ok(Json(json!({ "filename": filename })))
}

async fn restore_backup(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let manager = BackupManager::new(state.database_url);
    manager
        .restore_backup(&filename)
        .await
        .map_err(|e| SettingsError::Backup(e.to_string()))?;
    Ok(Json(json!({ "status": "restored" })))
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
    let path = std::path::PathBuf::from("backups").join(&filename);
    if !path.exists() {
        return Err(SettingsError::Backup("Backup not found".to_string()));
    }

    let content = tokio::fs::read(&path)
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
    let config: Value =
        sqlx::query_scalar("SELECT nuorder_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
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

    Ok(Json(json!({ "config": config, "recent_logs": logs })))
}

async fn patch_nuorder_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    sqlx::query("UPDATE store_settings SET nuorder_config = $1 WHERE id = 1")
        .bind(&body)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "status": "ok" })))
}

fn nuorder_client_from_config(config: &Value) -> Result<NuorderClient, SettingsError> {
    let consumer_key = config
        .get("consumer_key")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let consumer_secret = config
        .get("consumer_secret")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let user_token = config
        .get("user_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let user_secret = config
        .get("user_secret")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if consumer_key.is_empty() || consumer_secret.is_empty() {
        return Err(SettingsError::InvalidPayload(
            "Missing Nuorder Consumer Key/Secret".into(),
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
    let config: Value =
        sqlx::query_scalar("SELECT nuorder_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let client = nuorder_client_from_config(&config)?;

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
    let config: Value =
        sqlx::query_scalar("SELECT nuorder_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let client = nuorder_client_from_config(&config)?;

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
    let config: Value =
        sqlx::query_scalar("SELECT nuorder_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let client = nuorder_client_from_config(&config)?;

    match nuorder_sync::sync_inventory_ats(&state.db, &client).await {
        Ok(count) => Ok(Json(
            json!({ "message": format!("Synced {} items", count) }),
        )),
        Err(e) => Err(SettingsError::InvalidPayload(e.to_string())),
    }
}

pub fn build_nuorder_router() -> Router<AppState> {
    Router::new()
        .route(
            "/config",
            get(get_nuorder_config).patch(patch_nuorder_config),
        )
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

async fn get_backup_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<BackupSettings>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let raw: Value = sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
        .fetch_one(&state.db)
        .await?;

    let cfg: BackupSettings = serde_json::from_value(raw).unwrap_or_default();
    Ok(Json(cfg))
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

fn weather_settings_response_from_db(cfg: StoreWeatherSettings) -> WeatherSettingsResponse {
    weather_settings_public(&merge_weather_env_overrides(cfg))
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
    Ok(Json(weather_settings_response_from_db(cfg)))
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

    Ok(Json(weather_settings_response_from_db(current)))
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

fn podium_sms_settings_response(cfg: StorePodiumSmsConfig) -> PodiumSmsSettingsResponse {
    let templates_effective = cfg.templates.merged_defaults();
    let email_templates_effective = cfg.email_templates.merged_defaults();
    PodiumSmsSettingsResponse {
        settings: cfg,
        templates_effective,
        email_templates_effective,
        credentials_configured: PodiumEnvCredentials::from_env().is_some(),
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
    Ok(Json(podium_sms_settings_response(cfg)))
}

#[derive(Debug, Deserialize, Default)]
struct PatchPodiumSmsTemplatesBody {
    ready_for_pickup: Option<String>,
    alteration_ready: Option<String>,
    unknown_sender_welcome: Option<String>,
    loyalty_reward_redeemed: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct PatchPodiumEmailTemplatesBody {
    ready_for_pickup_subject: Option<String>,
    ready_for_pickup_html: Option<String>,
    alteration_ready_subject: Option<String>,
    alteration_ready_html: Option<String>,
    appointment_confirmation_subject: Option<String>,
    appointment_confirmation_html: Option<String>,
    loyalty_reward_redeemed_subject: Option<String>,
    loyalty_reward_redeemed_html: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct PatchPodiumSmsBody {
    sms_send_enabled: Option<bool>,
    email_send_enabled: Option<bool>,
    location_uid: Option<String>,
    widget_embed_enabled: Option<bool>,
    widget_snippet_html: Option<String>,
    templates: Option<PatchPodiumSmsTemplatesBody>,
    email_templates: Option<PatchPodiumEmailTemplatesBody>,
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
    if let Some(v) = body.email_send_enabled {
        current.email_send_enabled = v;
    }
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
    if let Some(et) = body.email_templates {
        if let Some(s) = et.ready_for_pickup_subject {
            current.email_templates.ready_for_pickup_subject = s;
        }
        if let Some(s) = et.ready_for_pickup_html {
            current.email_templates.ready_for_pickup_html = s;
        }
        if let Some(s) = et.alteration_ready_subject {
            current.email_templates.alteration_ready_subject = s;
        }
        if let Some(s) = et.alteration_ready_html {
            current.email_templates.alteration_ready_html = s;
        }
        if let Some(s) = et.appointment_confirmation_subject {
            current.email_templates.appointment_confirmation_subject = s;
        }
        if let Some(s) = et.appointment_confirmation_html {
            current.email_templates.appointment_confirmation_html = s;
        }
        if let Some(s) = et.loyalty_reward_redeemed_subject {
            current.email_templates.loyalty_reward_redeemed_subject = s;
        }
        if let Some(s) = et.loyalty_reward_redeemed_html {
            current.email_templates.loyalty_reward_redeemed_html = s;
        }
    }

    let updated = serde_json::to_value(&current).map_err(|e| {
        SettingsError::InvalidPayload(format!("podium_sms_config serialization: {e}"))
    })?;

    sqlx::query("UPDATE store_settings SET podium_sms_config = $1 WHERE id = 1")
        .bind(&updated)
        .execute(&state.db)
        .await?;

    Ok(Json(podium_sms_settings_response(current)))
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
    email_send_enabled: bool,
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
        credentials_configured: PodiumEnvCredentials::from_env().is_some(),
        webhook_secret_configured: podium_webhook_secret_from_env().is_some(),
        allow_unsigned_webhook: allow_unsigned_podium_webhook(),
        inbound_inbox_preview_enabled: podium_inbound_inbox_enabled(),
        api_base: podium_rest_api_base(),
        sms_send_enabled: cfg.sms_send_enabled,
        email_send_enabled: cfg.email_send_enabled,
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
    let client_id = std::env::var("RIVERSIDE_PODIUM_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            SettingsError::InvalidPayload("RIVERSIDE_PODIUM_CLIENT_ID is not set".to_string())
        })?;
    let scope = q.scope.as_deref();
    let url = build_podium_oauth_authorize_url(
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
    let Some(app) = PodiumOAuthAppCredentials::from_env() else {
        return Err(SettingsError::InvalidPayload(
            "RIVERSIDE_PODIUM_CLIENT_ID and RIVERSIDE_PODIUM_CLIENT_SECRET must be set".to_string(),
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

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MeilisearchSyncRow {
    pub index_name: String,
    pub last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_attempt_at: chrono::DateTime<chrono::Utc>,
    pub is_success: bool,
    pub row_count: i64,
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MeilisearchStatusResponse {
    pub configured: bool,
    pub indices: Vec<MeilisearchSyncRow>,
    pub is_indexing: bool,
}

async fn get_meilisearch_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeilisearchStatusResponse>, SettingsError> {
    require_settings_admin(&state, &headers).await?;
    let indices = sqlx::query_as::<_, MeilisearchSyncRow>(
        "SELECT index_name, last_success_at, last_attempt_at, is_success, row_count, error_message FROM meilisearch_sync_status ORDER BY index_name"
    )
    .fetch_all(&state.db)
    .await?;

    let is_indexing = if let Some(c) = &state.meilisearch {
        crate::logic::meilisearch_client::is_indexing(c).await
    } else {
        false
    };

    Ok(Json(MeilisearchStatusResponse {
        configured: state.meilisearch.is_some(),
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
    let Some(c) = state.meilisearch.clone() else {
        return Err(SettingsError::InvalidPayload(
            "Meilisearch is not configured (set RIVERSIDE_MEILISEARCH_URL)".to_string(),
        ));
    };
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
) -> Result<Json<BackupSettings>, SettingsError> {
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
    Ok(Json(cfg))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/receipt/preview-html", get(get_receipt_preview_html))
        .route(
            "/receipt",
            get(get_receipt_config).patch(patch_receipt_config),
        )
        .route("/rosie", get(get_rosie_config).patch(patch_rosie_config))
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
            "/weather",
            get(get_weather_settings).patch(patch_weather_settings),
        )
        .route(
            "/shippo",
            get(get_shippo_settings).patch(patch_shippo_settings),
        )
        .route(
            "/podium-sms",
            get(get_podium_sms_settings).patch(patch_podium_sms_settings),
        )
        .route("/podium-sms/readiness", get(get_podium_sms_readiness))
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
        .route("/remote-access/connect", post(post_remote_access_connect))
        .route(
            "/remote-access/disconnect",
            post(post_remote_access_disconnect),
        )
        .nest("/nuorder", build_nuorder_router())
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

async fn get_remote_access_status(
    State(_state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    _headers: HeaderMap,
) -> Result<Json<serde_json::Value>, SettingsError> {
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
