//! QuickBooks Online bridge: credentials, mapping-first COA, journal staging (Phase 2.15).

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, NaiveDate, Utc};
use reqwest::Client;
use ring::aead::{self, Aad, LessSafeKey, UnboundKey};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::env;
use std::str::FromStr;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{QBO_MAPPING_EDIT, QBO_STAGING_APPROVE, QBO_SYNC, QBO_VIEW};
use crate::auth::pins::log_staff_access;
use crate::logic::integration_alerts::{record_integration_failure, record_integration_success};
use crate::logic::qbo_journal;
use crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL;
use crate::middleware::require_staff_with_permission;

const DEFAULT_QBO_TOKEN_KEY: &str = "riverside-dev-token-key-change-me";
const QBO_TOKEN_KEY_MIN_LEN: usize = 32;
const QBO_TOKEN_AEAD_PREFIX: &str = "v2:";

#[derive(Debug, Error)]
pub enum QboError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Not found")]
    NotFound,
    #[error("Conflict: {0}")]
    Conflict(String),
    #[error("Forbidden")]
    Forbidden,
}

impl IntoResponse for QboError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            QboError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m.clone()),
            QboError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            QboError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            QboError::Forbidden => (StatusCode::FORBIDDEN, self.to_string()),
            QboError::Database(e) => {
                tracing::error!(error = %e, "Database error in qbo");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to process QuickBooks request".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct QboIntegration {
    pub id: Uuid,
    pub company_id: String,
    pub is_active: bool,
    pub last_sync_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct QboCredentialsPublic {
    pub realm_id: Option<String>,
    pub company_id: String,
    pub client_id_masked: Option<String>,
    pub client_id_set: bool,
    pub has_client_secret: bool,
    pub has_refresh_token: bool,
    pub use_sandbox: bool,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct QboCredentialsUpdate {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub realm_id: Option<String>,
    #[serde(default)]
    pub use_sandbox: Option<bool>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct QboAccount {
    pub id: String,
    pub name: String,
    pub account_type: Option<String>,
    pub account_number: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct LedgerMapping {
    pub id: Uuid,
    pub internal_key: String,
    pub internal_description: Option<String>,
    pub qbo_account_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct GranularMappingRow {
    pub id: Uuid,
    pub source_type: String,
    pub source_id: String,
    pub qbo_account_id: String,
    pub qbo_account_name: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct SaveGranularMappingRequest {
    pub source_type: String,
    pub source_id: String,
    pub qbo_account_id: String,
    pub qbo_account_name: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveMappingRequest {
    pub internal_key: String,
    pub qbo_account_id: String,
    pub internal_description: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct QboSyncLogRow {
    pub id: Uuid,
    pub sync_date: NaiveDate,
    pub journal_entry_id: Option<String>,
    pub status: String,
    pub payload: serde_json::Value,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct StagingListQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
}

#[derive(Debug, Deserialize)]
pub struct DrilldownQuery {
    pub line_index: usize,
}

#[derive(Debug, Serialize)]
pub struct DrilldownContributor {
    pub transaction_id: Uuid,
    pub amount: rust_decimal::Decimal,
}

#[derive(Debug, Serialize)]
pub struct StagingDrilldownResponse {
    pub line_index: usize,
    pub memo: String,
    pub contributors: Vec<DrilldownContributor>,
}

#[derive(Debug, Deserialize)]
pub struct ProposeJournalRequest {
    pub activity_date: NaiveDate,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/integration", get(get_integration_status))
        .route("/credentials", get(get_credentials).put(put_credentials))
        .route("/tokens/refresh", post(refresh_tokens_stub))
        .route("/accounts-cache", get(list_accounts_cache))
        .route("/accounts-cache/refresh", post(refresh_accounts_cache))
        .route("/mappings", get(list_mappings).post(save_mapping))
        .route(
            "/granular-mappings",
            get(list_granular_mappings).post(save_granular_mapping),
        )
        .route("/staging", get(list_staging))
        .route("/staging/propose", post(propose_staging))
        .route("/staging/{id}/drilldown", get(staging_drilldown))
        .route("/staging/{id}/approve", post(approve_staging))
        .route("/staging/{id}/sync", post(sync_staging))
}

pub fn auth_router() -> Router<AppState> {
    Router::new().route("/callback", get(oauth_callback))
}

pub async fn get_mapping(pool: &PgPool, key: &str) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT qbo_account_id FROM ledger_mappings WHERE internal_key = $1")
        .bind(key)
        .fetch_one(pool)
        .await
}

fn json_decimal(v: &serde_json::Value) -> Option<Decimal> {
    if let Some(s) = v.as_str() {
        return Decimal::from_str(s.trim()).ok();
    }
    v.as_number()
        .and_then(|n| Decimal::from_str(&n.to_string()).ok())
}

fn validate_staging_journal_balanced(payload: &serde_json::Value) -> Result<(), QboError> {
    let totals_balanced = payload
        .get("totals")
        .and_then(|v| v.get("balanced"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !totals_balanced {
        return Err(QboError::Conflict(
            "QBO staging journal is not balanced. Fix mappings and regenerate before approval or sync."
                .to_string(),
        ));
    }

    let lines = payload
        .get("lines")
        .and_then(|v| v.as_array())
        .ok_or_else(|| QboError::InvalidPayload("staging payload has no lines".to_string()))?;

    let mut debits = Decimal::ZERO;
    let mut credits = Decimal::ZERO;
    let mut postable_count = 0usize;

    for line in lines {
        let account_id = line
            .get("qbo_account_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if account_id.is_empty() {
            continue;
        }

        let debit = line
            .get("debit")
            .and_then(json_decimal)
            .unwrap_or(Decimal::ZERO)
            .abs();
        let credit = line
            .get("credit")
            .and_then(json_decimal)
            .unwrap_or(Decimal::ZERO)
            .abs();

        if debit != Decimal::ZERO {
            debits += debit;
            postable_count += 1;
        } else if credit != Decimal::ZERO {
            credits += credit;
            postable_count += 1;
        }
    }

    if postable_count == 0 {
        return Err(QboError::InvalidPayload(
            "staging payload has no postable journal lines".to_string(),
        ));
    }

    if debits != credits {
        return Err(QboError::Conflict(format!(
            "QBO staging journal postable lines are not balanced (debits {debits:.2}, credits {credits:.2}). Fix missing mappings and regenerate before approval or sync."
        )));
    }

    Ok(())
}

fn mask_client_id(s: &str) -> String {
    let t = s.trim();
    if t.len() <= 4 {
        "••••".to_string()
    } else {
        format!("••••{}", &t[t.len() - 4..])
    }
}

async fn integration_row(pool: &PgPool) -> Result<Option<IntegrationSecretsRow>, sqlx::Error> {
    sqlx::query_as::<_, IntegrationSecretsRow>(
        r#"
        SELECT
            id,
            company_id,
            client_id,
            client_secret,
            realm_id,
            use_sandbox,
            access_token,
            refresh_token,
            token_expires_at,
            is_active
        FROM qbo_integration
        WHERE is_active = true
        ORDER BY id
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
}

#[derive(Debug, FromRow)]
struct IntegrationSecretsRow {
    id: Uuid,
    company_id: String,
    client_id: Option<String>,
    client_secret: Option<String>,
    realm_id: Option<String>,
    use_sandbox: bool,
    #[allow(dead_code)]
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_expires_at: Option<DateTime<Utc>>,
    is_active: bool,
}

#[derive(Debug, Deserialize)]
struct QboQueryResponse {
    #[serde(rename = "QueryResponse")]
    query_response: QboAccountQueryResponse,
}

#[derive(Debug, Deserialize)]
struct QboAccountQueryResponse {
    #[serde(rename = "Account", default)]
    accounts: Vec<QboRemoteAccount>,
}

#[derive(Debug, Deserialize)]
struct QboRemoteAccount {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "FullyQualifiedName")]
    fully_qualified_name: Option<String>,
    #[serde(rename = "AccountType")]
    account_type: Option<String>,
    #[serde(rename = "AcctNum")]
    account_number: Option<String>,
    #[serde(rename = "Active")]
    active: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct OAuthCallbackQuery {
    code: String,
    #[serde(rename = "realmId")]
    realm_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

fn env_truthy(key: &str) -> bool {
    env::var(key)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn validate_qbo_token_key_configured() -> Result<String, QboError> {
    let key = env::var("QBO_TOKEN_ENC_KEY").unwrap_or_default();
    let trimmed = key.trim();
    if trimmed.len() < QBO_TOKEN_KEY_MIN_LEN || trimmed == DEFAULT_QBO_TOKEN_KEY {
        return Err(QboError::InvalidPayload(format!(
            "QBO_TOKEN_ENC_KEY must be set to a non-default secret at least {QBO_TOKEN_KEY_MIN_LEN} characters long before QuickBooks credentials can be activated."
        )));
    }
    Ok(trimmed.to_string())
}

pub fn validate_qbo_token_key_for_startup() -> Result<(), QboError> {
    if env_truthy("RIVERSIDE_STRICT_PRODUCTION") {
        validate_qbo_token_key_configured()?;
    }
    Ok(())
}

fn qbo_token_key_material(require_configured: bool) -> Result<Vec<u8>, QboError> {
    let key = if require_configured || env_truthy("RIVERSIDE_STRICT_PRODUCTION") {
        validate_qbo_token_key_configured()?
    } else {
        env::var("QBO_TOKEN_ENC_KEY").unwrap_or_else(|_| DEFAULT_QBO_TOKEN_KEY.to_string())
    };
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    Ok(hasher.finalize().to_vec())
}

fn xor_crypt(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect()
}

fn encrypt_token(plain: &str) -> Result<String, QboError> {
    let key_material = qbo_token_key_material(true)?;
    let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, &key_material).map_err(|_| {
        QboError::InvalidPayload("failed to initialize QBO token encryption".to_string())
    })?;
    let key = LessSafeKey::new(unbound);
    let nonce_uuid = Uuid::new_v4();
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&nonce_uuid.as_bytes()[..12]);
    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plain.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, Aad::from(b"riverside-os-qbo-token-v2"), &mut in_out)
        .map_err(|_| QboError::InvalidPayload("failed to encrypt QBO token".to_string()))?;
    let mut packed = nonce_bytes.to_vec();
    packed.extend_from_slice(&in_out);
    Ok(format!(
        "{QBO_TOKEN_AEAD_PREFIX}{}",
        general_purpose::STANDARD.encode(packed)
    ))
}

fn decrypt_token(cipher: &str) -> Option<String> {
    let trimmed = cipher.trim();
    if let Some(encoded) = trimmed.strip_prefix(QBO_TOKEN_AEAD_PREFIX) {
        let key_material = qbo_token_key_material(true).ok()?;
        let decoded = general_purpose::STANDARD.decode(encoded).ok()?;
        if decoded.len() <= 12 {
            return None;
        }
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes.copy_from_slice(&decoded[..12]);
        let mut in_out = decoded[12..].to_vec();
        let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, &key_material).ok()?;
        let key = LessSafeKey::new(unbound);
        let plain = key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce_bytes),
                Aad::from(b"riverside-os-qbo-token-v2"),
                &mut in_out,
            )
            .ok()?;
        return String::from_utf8(plain.to_vec()).ok();
    }

    let key = qbo_token_key_material(true).ok()?;
    let decoded = general_purpose::STANDARD.decode(trimmed).ok()?;
    let raw = xor_crypt(&decoded, &key);
    String::from_utf8(raw).ok()
}

fn qbo_base_url(use_sandbox: bool) -> &'static str {
    if use_sandbox {
        "https://sandbox-quickbooks.api.intuit.com"
    } else {
        "https://quickbooks.api.intuit.com"
    }
}

const QBO_OAUTH_TOKEN_URL: &str = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

fn redirect_uri() -> String {
    env::var("QBO_REDIRECT_URI")
        .unwrap_or_else(|_| "http://127.0.0.1:3000/api/auth/qbo/callback".to_string())
}

async fn refresh_access_token(
    pool: &PgPool,
    row: &IntegrationSecretsRow,
) -> Result<String, QboError> {
    let client_id = row
        .client_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| QboError::InvalidPayload("missing client_id".to_string()))?;
    let client_secret = row
        .client_secret
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| QboError::InvalidPayload("missing client_secret".to_string()))?;
    let refresh_enc = row
        .refresh_token
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| QboError::InvalidPayload("missing refresh_token".to_string()))?;
    let refresh_token = decrypt_token(refresh_enc).ok_or_else(|| {
        QboError::InvalidPayload("failed to decrypt stored refresh_token".to_string())
    })?;

    let basic = general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"));
    let client = Client::new();
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
    ];
    let res = client
        .post(QBO_OAUTH_TOKEN_URL)
        .header("Authorization", format!("Basic {basic}"))
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| QboError::Conflict(format!("refresh request failed: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        let body = res
            .text()
            .await
            .unwrap_or_else(|_| "unknown oauth error".to_string());
        return Err(QboError::Conflict(format!(
            "OAuth refresh rejected: {body}"
        )));
    }
    let body: OAuthTokenResponse = res
        .json()
        .await
        .map_err(|e| QboError::Conflict(format!("invalid refresh response: {e}")))?;
    let refresh_plain = body.refresh_token.clone().unwrap_or(refresh_token);
    let enc_access = encrypt_token(&body.access_token)?;
    let enc_refresh = encrypt_token(&refresh_plain)?;
    sqlx::query(
        r#"
        UPDATE qbo_integration
        SET
            access_token = $2,
            refresh_token = $3,
            token_expires_at = CURRENT_TIMESTAMP + ($4::text || ' seconds')::interval
        WHERE id = $1
        "#,
    )
    .bind(row.id)
    .bind(enc_access)
    .bind(enc_refresh)
    .bind(body.expires_in)
    .execute(pool)
    .await?;
    Ok(body.access_token)
}

pub async fn refresh_due_tokens(pool: &PgPool) -> Result<(), QboError> {
    let row = integration_row(pool).await?;
    let Some(r) = row else {
        return Ok(());
    };
    let due = match r.token_expires_at {
        Some(ts) => ts <= Utc::now() + chrono::Duration::minutes(10),
        None => true,
    };
    if !due {
        return Ok(());
    }
    let has_refresh = r
        .refresh_token
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if has_refresh {
        match refresh_access_token(pool, &r).await {
            Ok(_) => {
                let _ = record_integration_success(pool, "qbo_token_refresh").await;
            }
            Err(e) => {
                let _ = record_integration_failure(pool, "qbo_token_refresh", &e.to_string()).await;
                return Err(e);
            }
        }
    } else {
        let _ = record_integration_failure(
            pool,
            "qbo_token_refresh",
            "access token due for refresh but no refresh token on file",
        )
        .await;
    }
    Ok(())
}

async fn get_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<QboCredentialsPublic>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_VIEW)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let row = integration_row(&state.db).await?;
    let Some(r) = row else {
        return Ok(Json(QboCredentialsPublic {
            realm_id: None,
            company_id: "—".to_string(),
            client_id_masked: None,
            client_id_set: false,
            has_client_secret: false,
            has_refresh_token: false,
            use_sandbox: true,
            token_expires_at: None,
            is_active: false,
        }));
    };
    let cid = r.client_id.as_deref().unwrap_or("").trim();
    Ok(Json(QboCredentialsPublic {
        realm_id: r.realm_id.clone().or_else(|| Some(r.company_id.clone())),
        company_id: r.company_id.clone(),
        client_id_masked: if cid.is_empty() {
            None
        } else {
            Some(mask_client_id(cid))
        },
        client_id_set: !cid.is_empty(),
        has_client_secret: r
            .client_secret
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        has_refresh_token: r
            .refresh_token
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        use_sandbox: r.use_sandbox,
        token_expires_at: r.token_expires_at,
        is_active: r.is_active,
    }))
}

async fn put_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<QboCredentialsUpdate>,
) -> Result<Json<serde_json::Value>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_MAPPING_EDIT)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let realm = body
        .realm_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let client_id = body
        .client_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let client_secret = body
        .client_secret
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let use_sandbox = body.use_sandbox.unwrap_or(true);
    validate_qbo_token_key_configured()?;

    let company = realm.clone().unwrap_or_else(|| "pending".to_string());

    let existing = integration_row(&state.db).await?;

    if let Some(r) = existing {
        let company_update = realm.clone().unwrap_or_else(|| r.company_id.clone());
        let realm_update = realm.or(r.realm_id.clone());
        let use_sb = body.use_sandbox.unwrap_or(r.use_sandbox);
        sqlx::query(
            r#"
            UPDATE qbo_integration SET
                company_id = $2,
                realm_id = $3,
                client_id = COALESCE($4, client_id),
                client_secret = COALESCE($5, client_secret),
                use_sandbox = $6,
                is_active = true
            WHERE id = $1
            "#,
        )
        .bind(r.id)
        .bind(&company_update)
        .bind(&realm_update)
        .bind(client_id.as_ref())
        .bind(client_secret.as_ref())
        .bind(use_sb)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO qbo_integration (
                company_id, realm_id, client_id, client_secret, use_sandbox, is_active
            )
            VALUES ($1, $2, $3, $4, $5, true)
            "#,
        )
        .bind(&company)
        .bind(realm.as_ref().unwrap_or(&company))
        .bind(client_id.as_ref())
        .bind(client_secret.as_ref())
        .bind(use_sandbox)
        .execute(&state.db)
        .await?;
    }

    Ok(Json(json!({ "status": "saved" })))
}

async fn oauth_callback(
    State(state): State<AppState>,
    Query(q): Query<OAuthCallbackQuery>,
) -> Result<Json<serde_json::Value>, QboError> {
    let row = integration_row(&state.db).await?;
    let Some(r) = row else {
        return Err(QboError::InvalidPayload(
            "no active QBO integration row".to_string(),
        ));
    };
    let client_id = r
        .client_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| QboError::InvalidPayload("missing client_id".to_string()))?;
    let client_secret = r
        .client_secret
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| QboError::InvalidPayload("missing client_secret".to_string()))?;

    let basic = general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"));
    let code = q.code.trim();
    if code.is_empty() {
        return Err(QboError::InvalidPayload(
            "missing authorization code".to_string(),
        ));
    }
    let redirect = redirect_uri();
    let client = Client::new();
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
    ];
    let res = client
        .post(QBO_OAUTH_TOKEN_URL)
        .header("Authorization", format!("Basic {basic}"))
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| QboError::Conflict(format!("oauth callback request failed: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        let body = res
            .text()
            .await
            .unwrap_or_else(|_| "unknown oauth error".to_string());
        return Err(QboError::Conflict(format!(
            "OAuth callback rejected: {body}"
        )));
    }
    let body: OAuthTokenResponse = res
        .json()
        .await
        .map_err(|e| QboError::Conflict(format!("invalid callback response: {e}")))?;
    let realm = q
        .realm_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(r.realm_id.clone())
        .unwrap_or_else(|| r.company_id.clone());
    sqlx::query(
        r#"
        UPDATE qbo_integration
        SET
            realm_id = $2,
            company_id = $2,
            access_token = $3,
            refresh_token = $4,
            token_expires_at = CURRENT_TIMESTAMP + ($5::text || ' seconds')::interval,
            is_active = true
        WHERE id = $1
        "#,
    )
    .bind(r.id)
    .bind(realm)
    .bind(encrypt_token(&body.access_token)?)
    .bind(encrypt_token(body.refresh_token.as_deref().unwrap_or(""))?)
    .bind(body.expires_in)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "status": "authorized" })))
}

async fn refresh_tokens_stub(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_MAPPING_EDIT)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let row = integration_row(&state.db).await?;
    let Some(r) = row else {
        return Err(QboError::InvalidPayload(
            "no active QBO integration row".to_string(),
        ));
    };
    let _new_access = refresh_access_token(&state.db, &r).await?;

    Ok(Json(json!({
        "status": "refreshed",
        "note": "Access token refreshed using Intuit OAuth refresh_token."
    })))
}

async fn get_integration_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Option<QboIntegration>>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_VIEW)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let row = sqlx::query_as::<_, QboIntegration>(
        r#"
        SELECT id, company_id, is_active, last_sync_at
        FROM qbo_integration
        WHERE is_active = true
        ORDER BY id
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(row))
}

async fn list_accounts_cache(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<QboAccount>>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_VIEW)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let rows = sqlx::query_as::<_, QboAccount>(
        r#"
        SELECT id, name, account_type, account_number, is_active
        FROM qbo_accounts_cache
        WHERE is_active = true
        ORDER BY account_number NULLS LAST, name
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn refresh_accounts_cache(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_MAPPING_EDIT)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let integ = integration_row(&state.db).await?.ok_or_else(|| {
        QboError::InvalidPayload(
            "QuickBooks credentials are missing. Add them in Settings → Integrations → QuickBooks Online.".to_string(),
        )
    })?;
    let realm_id = integ
        .realm_id
        .as_ref()
        .or(Some(&integ.company_id))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "pending")
        .ok_or_else(|| {
            QboError::InvalidPayload(
                "QuickBooks Realm ID is missing. Add it in Settings → Integrations → QuickBooks Online.".to_string(),
            )
        })?;
    if integ
        .refresh_token
        .as_ref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
    {
        return Err(QboError::InvalidPayload(
            "QuickBooks is not authorized yet. Complete OAuth authorization before refreshing accounts.".to_string(),
        ));
    }
    let access_token = match integ
        .access_token
        .as_ref()
        .and_then(|s| decrypt_token(s))
        .filter(|s| !s.trim().is_empty())
    {
        Some(token)
            if integ
                .token_expires_at
                .map(|t| t > Utc::now())
                .unwrap_or(false) =>
        {
            token
        }
        _ => refresh_access_token(&state.db, &integ).await?,
    };

    let query = "select * from Account where Active in (true, false) order by AcctNum, Name";
    let url = format!(
        "{}/v3/company/{}/query",
        qbo_base_url(integ.use_sandbox),
        realm_id
    );
    let res = state
        .http_client
        .get(url)
        .bearer_auth(access_token)
        .query(&[("query", query), ("minorversion", "73")])
        .send()
        .await
        .map_err(|e| QboError::Conflict(format!("QBO accounts request failed: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        let body = res
            .text()
            .await
            .unwrap_or_else(|_| "unknown QBO accounts error".to_string());
        let _ = record_integration_failure(&state.db, "qbo_accounts_refresh", &body).await;
        return Err(QboError::Conflict(format!(
            "QuickBooks rejected the account refresh: {body}"
        )));
    }
    let body = res
        .json::<QboQueryResponse>()
        .await
        .map_err(|e| QboError::Conflict(format!("invalid QBO accounts response: {e}")))?;

    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE qbo_accounts_cache SET is_active = false")
        .execute(&mut *tx)
        .await?;
    let mut count = 0_i64;
    for account in body.query_response.accounts {
        let name = account.fully_qualified_name.unwrap_or(account.name);
        sqlx::query(
            r#"
            INSERT INTO qbo_accounts_cache (id, name, account_type, account_number, is_active)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE
            SET
                name = EXCLUDED.name,
                account_type = EXCLUDED.account_type,
                account_number = EXCLUDED.account_number,
                is_active = EXCLUDED.is_active,
                refreshed_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(&account.id)
        .bind(&name)
        .bind(account.account_type.as_deref())
        .bind(account.account_number.as_deref())
        .bind(account.active.unwrap_or(true))
        .execute(&mut *tx)
        .await?;
        count += 1;
    }

    sqlx::query(
        r#"
        UPDATE qbo_integration
        SET last_sync_at = CURRENT_TIMESTAMP
        WHERE is_active = true
        "#,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let _ = record_integration_success(&state.db, "qbo_accounts_refresh").await;

    Ok(Json(json!({ "status": "refreshed", "count": count })))
}

async fn list_mappings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<LedgerMapping>>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_VIEW)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let rows = sqlx::query_as::<_, LedgerMapping>(
        r#"
        SELECT id, internal_key, internal_description, qbo_account_id, updated_at
        FROM ledger_mappings
        ORDER BY internal_key
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn save_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SaveMappingRequest>,
) -> Result<Json<LedgerMapping>, QboError> {
    let admin = require_staff_with_permission(&state, &headers, QBO_MAPPING_EDIT)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let key = payload.internal_key.trim();
    if key.is_empty() {
        return Err(QboError::InvalidPayload(
            "internal_key is required".to_string(),
        ));
    }
    let account_id = payload.qbo_account_id.trim();
    if account_id.is_empty() {
        return Err(QboError::InvalidPayload(
            "qbo_account_id is required".to_string(),
        ));
    }

    let row = sqlx::query_as::<_, LedgerMapping>(
        r#"
        INSERT INTO ledger_mappings (internal_key, internal_description, qbo_account_id, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (internal_key) DO UPDATE
        SET
            internal_description = COALESCE(EXCLUDED.internal_description, ledger_mappings.internal_description),
            qbo_account_id = EXCLUDED.qbo_account_id,
            updated_at = CURRENT_TIMESTAMP
        RETURNING id, internal_key, internal_description, qbo_account_id, updated_at
        "#,
    )
    .bind(key)
    .bind(payload.internal_description.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(account_id)
    .fetch_one(&state.db)
    .await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "qbo_mapping_save",
        json!({
            "internal_key": row.internal_key,
            "qbo_account_id": row.qbo_account_id,
            "mapping_id": row.id
        }),
    )
    .await;

    Ok(Json(row))
}

async fn list_granular_mappings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<GranularMappingRow>>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_VIEW)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let rows = sqlx::query_as::<_, GranularMappingRow>(
        r#"
        SELECT id, source_type, source_id, qbo_account_id, qbo_account_name, updated_at
        FROM qbo_mappings
        ORDER BY source_type, source_id
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn save_granular_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SaveGranularMappingRequest>,
) -> Result<Json<GranularMappingRow>, QboError> {
    let admin = require_staff_with_permission(&state, &headers, QBO_MAPPING_EDIT)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let st = body.source_type.trim();
    let sid = body.source_id.trim();
    let aid = body.qbo_account_id.trim();
    let aname = body.qbo_account_name.trim();
    if st.is_empty() || sid.is_empty() || aid.is_empty() || aname.is_empty() {
        return Err(QboError::InvalidPayload(
            "source_type, source_id, qbo_account_id, qbo_account_name are required".to_string(),
        ));
    }

    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM qbo_accounts_cache WHERE id = $1 AND is_active = true)",
    )
    .bind(aid)
    .fetch_one(&state.db)
    .await?;
    if !exists {
        return Err(QboError::InvalidPayload(
            "qbo_account_id must exist in accounts cache (refresh accounts first)".to_string(),
        ));
    }

    let row = sqlx::query_as::<_, GranularMappingRow>(
        r#"
        INSERT INTO qbo_mappings (source_type, source_id, qbo_account_id, qbo_account_name, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (source_type, source_id) DO UPDATE
        SET
            qbo_account_id = EXCLUDED.qbo_account_id,
            qbo_account_name = EXCLUDED.qbo_account_name,
            updated_at = CURRENT_TIMESTAMP
        RETURNING id, source_type, source_id, qbo_account_id, qbo_account_name, updated_at
        "#,
    )
    .bind(st)
    .bind(sid)
    .bind(aid)
    .bind(aname)
    .fetch_one(&state.db)
    .await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "qbo_granular_mapping_save",
        json!({
            "source_type": row.source_type,
            "source_id": row.source_id,
            "qbo_account_id": row.qbo_account_id,
            "mapping_id": row.id
        }),
    )
    .await;

    Ok(Json(row))
}

async fn list_staging(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StagingListQuery>,
) -> Result<Json<Vec<QboSyncLogRow>>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_VIEW)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let from = q.from;
    let to = q.to;
    let rows = if from.is_some() || to.is_some() {
        sqlx::query_as::<_, QboSyncLogRow>(
            r#"
            SELECT id, sync_date, journal_entry_id, status, payload, error_message, created_at
            FROM qbo_sync_logs
            WHERE ($1::date IS NULL OR sync_date >= $1)
              AND ($2::date IS NULL OR sync_date <= $2)
            ORDER BY sync_date DESC, created_at DESC
            LIMIT 200
            "#,
        )
        .bind(from)
        .bind(to)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, QboSyncLogRow>(
            r#"
            SELECT id, sync_date, journal_entry_id, status, payload, error_message, created_at
            FROM qbo_sync_logs
            ORDER BY sync_date DESC, created_at DESC
            LIMIT 200
            "#,
        )
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(rows))
}

async fn propose_staging(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ProposeJournalRequest>,
) -> Result<Json<QboSyncLogRow>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_MAPPING_EDIT)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let dup: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM qbo_sync_logs
        WHERE sync_date = $1 AND status = 'pending'
        LIMIT 1
        "#,
    )
    .bind(body.activity_date)
    .fetch_optional(&state.db)
    .await?;

    if let Some(id) = dup {
        let row = sqlx::query_as::<_, QboSyncLogRow>(
            r#"
            SELECT id, sync_date, journal_entry_id, status, payload, error_message, created_at
            FROM qbo_sync_logs WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_one(&state.db)
        .await?;
        return Ok(Json(row));
    }

    let proposal = qbo_journal::propose_daily_journal(&state.db, body.activity_date).await?;
    let payload = serde_json::to_value(&proposal)
        .map_err(|e| QboError::InvalidPayload(format!("serialize proposal: {e}")))?;

    let row = sqlx::query_as::<_, QboSyncLogRow>(
        r#"
        INSERT INTO qbo_sync_logs (sync_date, status, payload)
        VALUES ($1, 'pending', $2)
        RETURNING id, sync_date, journal_entry_id, status, payload, error_message, created_at
        "#,
    )
    .bind(body.activity_date)
    .bind(payload)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

async fn approve_staging(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, QboError> {
    let admin = require_staff_with_permission(&state, &headers, QBO_STAGING_APPROVE)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let row: Option<(String, serde_json::Value)> =
        sqlx::query_as("SELECT status, payload FROM qbo_sync_logs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;

    let Some((status, payload)) = row else {
        return Err(QboError::NotFound);
    };
    if status != "pending" {
        return Err(QboError::Conflict(
            "only pending entries can be approved".to_string(),
        ));
    }
    validate_staging_journal_balanced(&payload)?;

    let n = sqlx::query(
        r#"
        UPDATE qbo_sync_logs
        SET status = 'approved', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'pending'
        "#,
    )
    .bind(id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(QboError::Conflict(
            "staging entry changed before approval; reload and try again".to_string(),
        ));
    }
    let _ = log_staff_access(
        &state.db,
        admin.id,
        "qbo_staging_approve",
        json!({ "staging_id": id }),
    )
    .await;
    Ok(Json(json!({ "status": "approved" })))
}

async fn staging_drilldown(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<DrilldownQuery>,
) -> Result<Json<StagingDrilldownResponse>, QboError> {
    require_staff_with_permission(&state, &headers, QBO_VIEW)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let row: Option<(NaiveDate, serde_json::Value)> =
        sqlx::query_as("SELECT sync_date, payload FROM qbo_sync_logs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let Some((sync_date, payload)) = row else {
        return Err(QboError::NotFound);
    };
    let lines = payload
        .get("lines")
        .and_then(|v| v.as_array())
        .ok_or_else(|| QboError::InvalidPayload("staging payload has no lines".to_string()))?;
    let Some(line) = lines.get(q.line_index) else {
        return Err(QboError::InvalidPayload(
            "line_index out of range".to_string(),
        ));
    };
    let memo = line
        .get("memo")
        .and_then(|v| v.as_str())
        .unwrap_or("Journal line")
        .to_string();
    let detail0 = line
        .get("detail")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let order_recognition_ts = ORDER_RECOGNITION_TS_SQL.trim();
    let line_recognition_ts = format!("(COALESCE(({order_recognition_ts}), oi.fulfilled_at))");
    let mut contributors: Vec<DrilldownContributor> = Vec::new();

    if let Some(method) = detail0.get("payment_method").and_then(|v| v.as_str()) {
        let sub_type = detail0
            .get("sub_type")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let rows: Vec<(Uuid, rust_decimal::Decimal)> = sqlx::query_as(
            r#"
            SELECT
                pa.target_transaction_id AS transaction_id,
                SUM(pa.amount_allocated)::numeric(14,2) AS amount
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
              AND pt.payment_method = $2
              AND ($3::text IS NULL OR NULLIF(TRIM(COALESCE(pt.metadata->>'sub_type', '')), '') = $3)
            GROUP BY pa.target_transaction_id
            ORDER BY amount DESC
            "#,
        )
        .bind(sync_date)
        .bind(method)
        .bind(sub_type.as_deref())
        .fetch_all(&state.db)
        .await?;
        contributors = rows
            .into_iter()
            .map(|(transaction_id, amount)| DrilldownContributor {
                transaction_id,
                amount,
            })
            .collect();
    } else if detail0.get("net_sales").is_some() {
        let category_id = detail0
            .get("category_id")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let rows: Vec<(Uuid, rust_decimal::Decimal)> = if let Some(cat_str) = category_id.as_str() {
            let cat_uuid = Uuid::parse_str(cat_str).map_err(|_| {
                QboError::InvalidPayload("invalid category_id in payload".to_string())
            })?;
            sqlx::query_as(&format!(
                r#"
                SELECT
                    oi.transaction_id,
                    SUM((oi.unit_price * oi.quantity)::numeric(14,2)) AS amount
                FROM transaction_lines oi
                INNER JOIN transactions o ON o.id = oi.transaction_id
                INNER JOIN products p ON p.id = oi.product_id
                WHERE o.status::text NOT IN ('cancelled')
                  AND {line_recognition_ts} IS NOT NULL
                  AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
                  AND p.category_id = $2
                GROUP BY oi.transaction_id
                ORDER BY amount DESC
                "#
            ))
            .bind(sync_date)
            .bind(cat_uuid)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as(&format!(
                r#"
                SELECT
                    oi.transaction_id,
                    SUM((oi.unit_price * oi.quantity)::numeric(14,2)) AS amount
                FROM transaction_lines oi
                INNER JOIN transactions o ON o.id = oi.transaction_id
                INNER JOIN products p ON p.id = oi.product_id
                WHERE o.status::text NOT IN ('cancelled')
                  AND {line_recognition_ts} IS NOT NULL
                  AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
                  AND p.category_id IS NULL
                GROUP BY oi.transaction_id
                ORDER BY amount DESC
                "#
            ))
            .bind(sync_date)
            .fetch_all(&state.db)
            .await?
        };
        contributors = rows
            .into_iter()
            .map(|(transaction_id, amount)| DrilldownContributor {
                transaction_id,
                amount,
            })
            .collect();
    } else if detail0.get("release_amount").is_some() {
        let category_id = detail0.get("category_id").and_then(|v| v.as_str());
        let rows: Vec<(Uuid, rust_decimal::Decimal)> = if let Some(cat) = category_id {
            let cat_uuid = Uuid::parse_str(cat).map_err(|_| {
                QboError::InvalidPayload("invalid category_id in payload".to_string())
            })?;
            sqlx::query_as(&format!(
                r#"
                WITH fulfilled_orders AS (
                    SELECT o.id
                    FROM transactions o
                    WHERE o.status::text NOT IN ('cancelled')
                      AND ({order_recognition_ts}) IS NOT NULL
                      AND (({order_recognition_ts}) AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
                ),
                order_deposit AS (
                    SELECT
                        pa.target_transaction_id AS transaction_id,
                        COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
                    FROM payment_allocations pa
                    INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                    INNER JOIN fulfilled_orders fo ON fo.id = pa.target_transaction_id
                    WHERE (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date < $1::date
                    GROUP BY pa.target_transaction_id
                ),
                category_net AS (
                    SELECT
                        oi.transaction_id,
                        p.category_id,
                        SUM((oi.unit_price * oi.quantity)::numeric(14,2)) AS cat_net
                    FROM transaction_lines oi
                    INNER JOIN products p ON p.id = oi.product_id
                    INNER JOIN fulfilled_orders fo ON fo.id = oi.transaction_id
                    GROUP BY oi.transaction_id, p.category_id
                ),
                order_net AS (
                    SELECT transaction_id, SUM(cat_net)::numeric(14,2) AS order_net
                    FROM category_net
                    GROUP BY transaction_id
                )
                SELECT
                    cn.transaction_id,
                    ROUND(od.deposit_total * (cn.cat_net / NULLIF(onet.order_net, 0)), 2)::numeric(14,2) AS amount
                FROM category_net cn
                INNER JOIN order_net onet ON onet.transaction_id = cn.transaction_id
                INNER JOIN order_deposit od ON od.transaction_id = cn.transaction_id
                WHERE cn.category_id = $2
                  AND od.deposit_total > 0
                ORDER BY amount DESC
                "#
            ))
            .bind(sync_date)
            .bind(cat_uuid)
            .fetch_all(&state.db)
            .await?
        } else {
            vec![]
        };
        contributors = rows
            .into_iter()
            .map(|(transaction_id, amount)| DrilldownContributor {
                transaction_id,
                amount,
            })
            .collect();
    }

    Ok(Json(StagingDrilldownResponse {
        line_index: q.line_index,
        memo,
        contributors,
    }))
}

async fn sync_staging(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, QboError> {
    let admin = require_staff_with_permission(&state, &headers, QBO_SYNC)
        .await
        .map_err(|_| QboError::Forbidden)?;
    let row: Option<(String, serde_json::Value)> =
        sqlx::query_as("SELECT status, payload FROM qbo_sync_logs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;

    let Some((status, payload)) = row else {
        return Err(QboError::NotFound);
    };
    if status != "approved" {
        return Err(QboError::Conflict(
            "only approved entries can be pushed to QBO".to_string(),
        ));
    }
    validate_staging_journal_balanced(&payload)?;

    let integ = integration_row(&state.db)
        .await?
        .ok_or_else(|| QboError::InvalidPayload("no active QBO integration".to_string()))?;
    let realm_id = integ
        .realm_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| QboError::InvalidPayload("missing realm_id".to_string()))?;

    let access_token = match integ
        .access_token
        .as_ref()
        .and_then(|s| decrypt_token(s))
        .filter(|s| !s.trim().is_empty())
    {
        Some(t) => t,
        None => refresh_access_token(&state.db, &integ).await?,
    };

    fn to_amount(v: &serde_json::Value) -> Option<String> {
        if let Some(s) = v.as_str() {
            return Some(s.to_string());
        }
        if let Some(n) = v.as_f64() {
            return Some(format!("{:.2}", n.abs()));
        }
        None
    }
    let sync_date = payload
        .get("activity_date")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut line_payloads: Vec<serde_json::Value> = Vec::new();
    if let Some(lines) = payload.get("lines").and_then(|v| v.as_array()) {
        for l in lines {
            let debit = l.get("debit").and_then(to_amount);
            let credit = l.get("credit").and_then(to_amount);
            let (posting_type, amount) = if let Some(d) = debit.as_ref().filter(|d| *d != "0.00") {
                ("Debit", d.clone())
            } else if let Some(c) = credit.as_ref().filter(|c| *c != "0.00") {
                ("Credit", c.clone())
            } else {
                continue;
            };
            let account_id = l
                .get("qbo_account_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if account_id.is_empty() {
                continue;
            }
            let account_name = l
                .get("qbo_account_name")
                .and_then(|v| v.as_str())
                .unwrap_or(account_id);
            let memo = l
                .get("memo")
                .and_then(|v| v.as_str())
                .unwrap_or("ROS journal line");
            line_payloads.push(json!({
                "Description": memo,
                "Amount": amount,
                "DetailType": "JournalEntryLineDetail",
                "JournalEntryLineDetail": {
                    "PostingType": posting_type,
                    "AccountRef": { "value": account_id, "name": account_name }
                }
            }));
        }
    }
    if line_payloads.is_empty() {
        return Err(QboError::InvalidPayload(
            "staging payload has no journal lines".to_string(),
        ));
    }
    let je_body = json!({
        "TxnDate": sync_date,
        "Line": line_payloads
    });
    let url = format!(
        "{}/v3/company/{}/journalentry?minorversion=73",
        qbo_base_url(integ.use_sandbox),
        realm_id
    );
    let http = Client::new();
    let resp = http
        .post(&url)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .json(&je_body)
        .send()
        .await
        .map_err(|e| QboError::Conflict(format!("QBO JournalEntry request failed: {e}")))?;
    let status_code = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .unwrap_or_else(|_| json!({ "fault": "invalid response from qbo" }));
    if !status_code.is_success() {
        let err_msg = body
            .get("Fault")
            .and_then(|f| f.get("Error"))
            .and_then(|e| e.get(0))
            .and_then(|e| e.get("Detail"))
            .and_then(|d| d.as_str())
            .or_else(|| body.get("fault").and_then(|v| v.as_str()))
            .unwrap_or("QBO sync failed")
            .to_string();
        sqlx::query(
            r#"
            UPDATE qbo_sync_logs
            SET status = 'failed', error_message = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&err_msg)
        .execute(&state.db)
        .await?;
        if let Err(e) =
            crate::logic::notifications::emit_qbo_sync_failed(&state.db, id, &err_msg).await
        {
            tracing::error!(error = %e, "emit_qbo_sync_failed");
        }
        let _ = log_staff_access(
            &state.db,
            admin.id,
            "qbo_sync_failed",
            json!({ "staging_id": id, "error_message": err_msg }),
        )
        .await;
        return Err(QboError::Conflict(err_msg));
    }
    let je_id = body
        .get("JournalEntry")
        .and_then(|j| j.get("Id"))
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN")
        .to_string();
    sqlx::query(
        r#"
        UPDATE qbo_sync_logs
        SET
            status = 'synced',
            journal_entry_id = $2,
            updated_at = CURRENT_TIMESTAMP,
            error_message = NULL
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(&je_id)
    .execute(&state.db)
    .await?;
    let _ = log_staff_access(
        &state.db,
        admin.id,
        "qbo_sync_success",
        json!({ "staging_id": id, "journal_entry_id": je_id.clone() }),
    )
    .await;

    sqlx::query(
        r#"
        UPDATE qbo_integration
        SET last_sync_at = CURRENT_TIMESTAMP
        WHERE is_active = true
        "#,
    )
    .execute(&state.db)
    .await?;

    Ok(Json(json!({
        "status": "synced",
        "journal_entry_id": je_id
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn with_qbo_token_env<T>(key: Option<&str>, strict: Option<&str>, f: impl FnOnce() -> T) -> T {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let previous_key = env::var("QBO_TOKEN_ENC_KEY").ok();
        let previous_strict = env::var("RIVERSIDE_STRICT_PRODUCTION").ok();

        match key {
            Some(value) => env::set_var("QBO_TOKEN_ENC_KEY", value),
            None => env::remove_var("QBO_TOKEN_ENC_KEY"),
        }
        match strict {
            Some(value) => env::set_var("RIVERSIDE_STRICT_PRODUCTION", value),
            None => env::remove_var("RIVERSIDE_STRICT_PRODUCTION"),
        }

        let result = f();

        match previous_key {
            Some(value) => env::set_var("QBO_TOKEN_ENC_KEY", value),
            None => env::remove_var("QBO_TOKEN_ENC_KEY"),
        }
        match previous_strict {
            Some(value) => env::set_var("RIVERSIDE_STRICT_PRODUCTION", value),
            None => env::remove_var("RIVERSIDE_STRICT_PRODUCTION"),
        }

        result
    }

    fn balanced_payload() -> serde_json::Value {
        json!({
            "totals": {
                "debits": "25.00",
                "credits": "25.00",
                "balanced": true
            },
            "lines": [
                {
                    "qbo_account_id": "101",
                    "qbo_account_name": "Cash",
                    "debit": "25.00",
                    "credit": "0.00"
                },
                {
                    "qbo_account_id": "401",
                    "qbo_account_name": "Sales",
                    "debit": "0.00",
                    "credit": "25.00"
                }
            ]
        })
    }

    #[test]
    fn balanced_staging_payload_passes_gate() {
        assert!(validate_staging_journal_balanced(&balanced_payload()).is_ok());
    }

    #[test]
    fn totals_unbalanced_payload_fails_gate() {
        let mut payload = balanced_payload();
        payload["totals"]["balanced"] = json!(false);

        let err = validate_staging_journal_balanced(&payload).unwrap_err();
        assert!(matches!(err, QboError::Conflict(_)));
    }

    #[test]
    fn missing_mapping_that_unbalances_postable_lines_fails_gate() {
        let mut payload = balanced_payload();
        payload["lines"][1]["qbo_account_id"] = json!("");

        let err = validate_staging_journal_balanced(&payload).unwrap_err();
        assert!(matches!(err, QboError::Conflict(_)));
    }

    #[test]
    fn strict_production_rejects_missing_or_default_qbo_token_key() {
        with_qbo_token_env(None, Some("true"), || {
            assert!(validate_qbo_token_key_for_startup().is_err());
        });

        with_qbo_token_env(Some(DEFAULT_QBO_TOKEN_KEY), Some("true"), || {
            assert!(validate_qbo_token_key_for_startup().is_err());
        });
    }

    #[test]
    fn qbo_token_encryption_requires_configured_key_and_round_trips_v2() {
        with_qbo_token_env(
            Some("test-qbo-token-key-32-characters-minimum-value"),
            None,
            || {
                let encrypted = encrypt_token("refresh-token-secret").expect("encrypt token");
                assert!(encrypted.starts_with(QBO_TOKEN_AEAD_PREFIX));
                assert_ne!(encrypted, "refresh-token-secret");
                assert_eq!(
                    decrypt_token(&encrypted).as_deref(),
                    Some("refresh-token-secret")
                );
            },
        );
    }

    #[test]
    fn qbo_token_encryption_rejects_default_key_even_outside_strict_mode() {
        with_qbo_token_env(Some(DEFAULT_QBO_TOKEN_KEY), None, || {
            assert!(encrypt_token("secret").is_err());
        });
    }
}
