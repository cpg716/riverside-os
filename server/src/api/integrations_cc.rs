use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{CONSTANT_CONTACT_MANAGE, CONSTANT_CONTACT_SYNC};
use crate::logic::constant_contact::{
    self, exchange_code, fetch_lists, get_authorize_url, ingest_webhook_event, sync_contacts,
};
use crate::logic::integration_credentials::{
    load_integration_credentials, save_integration_credentials,
};
use crate::middleware::require_staff_with_permission;

#[derive(Debug, Error)]
pub enum CcApiError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Credential error: {0}")]
    Credential(#[from] crate::logic::integration_credentials::IntegrationCredentialError),
    #[error("Constant Contact error: {0}")]
    ConstantContact(#[from] crate::logic::constant_contact::ConstantContactError),
    #[error("Forbidden: {0}")]
    Forbidden(String),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
}

impl IntoResponse for CcApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            CcApiError::Forbidden(m) => (StatusCode::FORBIDDEN, m.clone()),
            CcApiError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m.clone()),
            CcApiError::Database(e) => {
                tracing::error!(error = %e, "Database error in Constant Contact API");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to process Constant Contact database operation".to_string(),
                )
            }
            CcApiError::Credential(e) => {
                tracing::error!(error = %e, "Credential load/save error in Constant Contact API");
                (StatusCode::BAD_REQUEST, e.to_string())
            }
            CcApiError::ConstantContact(e) => {
                tracing::error!(error = %e, "Constant Contact client error");
                (StatusCode::BAD_REQUEST, e.to_string())
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Serialize)]
pub struct CcConfigPublic {
    pub client_id_masked: Option<String>,
    pub client_id_set: bool,
    pub has_client_secret: bool,
    pub has_access_token: bool,
    pub has_refresh_token: bool,
    pub target_list_id: Option<String>,
    pub list_mappings: Option<serde_json::Value>,
    pub last_logs: Vec<CcSyncLogRow>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CcSyncLogRow {
    pub id: Uuid,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    pub sync_type: String,
    pub status: String,
    pub created_count: i32,
    pub updated_count: i32,
    pub deleted_count: i32,
    pub error_summary: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CcCredentialsUpdate {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub target_list_id: Option<String>,
    pub list_mappings: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/config", get(get_config))
        .route("/credentials", post(put_credentials))
        .route("/oauth/authorize-url", post(post_authorize_url))
        .route("/lists", get(get_lists))
        .route("/sync/contacts", post(post_sync_contacts))
}

pub fn auth_router() -> Router<AppState> {
    Router::new()
        .route("/oauth/callback", get(get_oauth_callback))
        .route("/webhooks/receive", post(post_webhook_receive))
}

fn mask_client_id(s: &str) -> String {
    let t = s.trim();
    if t.len() <= 4 {
        "••••".to_string()
    } else {
        format!("••••{}", &t[t.len() - 4..])
    }
}

async fn get_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CcConfigPublic>, CcApiError> {
    require_staff_with_permission(&state, &headers, CONSTANT_CONTACT_MANAGE)
        .await
        .map_err(|_| {
            CcApiError::Forbidden("missing constant_contact.manage permission".to_string())
        })?;

    let credentials = load_integration_credentials(
        &state.db,
        "constant_contact",
        &[
            "client_id",
            "client_secret",
            "access_token",
            "refresh_token",
            "target_list_id",
            "list_mappings",
        ],
    )
    .await?;

    let client_id = credentials
        .get("client_id")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let client_secret = credentials
        .get("client_secret")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let access_token = credentials
        .get("access_token")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let refresh_token = credentials
        .get("refresh_token")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let target_list_id = credentials
        .get("target_list_id")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let list_mappings_val = credentials
        .get("list_mappings")
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    let last_logs = sqlx::query_as::<_, CcSyncLogRow>(
        r#"
        SELECT id, started_at, finished_at, sync_type, status, created_count, updated_count, deleted_count, error_summary
        FROM constant_contact_sync_logs
        ORDER BY started_at DESC
        LIMIT 20
        "#
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(CcConfigPublic {
        client_id_masked: client_id.map(mask_client_id),
        client_id_set: client_id.is_some(),
        has_client_secret: client_secret.is_some(),
        has_access_token: access_token.is_some(),
        has_refresh_token: refresh_token.is_some(),
        target_list_id,
        list_mappings: list_mappings_val,
        last_logs,
    }))
}

async fn put_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CcCredentialsUpdate>,
) -> Result<Json<serde_json::Value>, CcApiError> {
    let staff = require_staff_with_permission(&state, &headers, CONSTANT_CONTACT_MANAGE)
        .await
        .map_err(|_| {
            CcApiError::Forbidden("missing constant_contact.manage permission".to_string())
        })?;

    let mut updates = Vec::new();
    if let Some(cid) = body
        .client_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        updates.push(("client_id", cid.to_string()));
    }
    if let Some(sec) = body
        .client_secret
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        updates.push(("client_secret", sec.to_string()));
    }
    if let Some(lid) = body
        .target_list_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        updates.push(("target_list_id", lid.to_string()));
    }
    if let Some(maps) = body
        .list_mappings
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // Validate JSON
        if serde_json::from_str::<serde_json::Value>(maps).is_err() {
            return Err(CcApiError::InvalidPayload(
                "list_mappings must be a valid JSON object".to_string(),
            ));
        }
        updates.push(("list_mappings", maps.to_string()));
    }

    if !updates.is_empty() {
        save_integration_credentials(&state.db, "constant_contact", updates, Some(staff.id))
            .await?;
    }

    Ok(Json(json!({ "status": "credentials updated" })))
}

async fn post_authorize_url(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, CcApiError> {
    require_staff_with_permission(&state, &headers, CONSTANT_CONTACT_MANAGE)
        .await
        .map_err(|_| {
            CcApiError::Forbidden("missing constant_contact.manage permission".to_string())
        })?;

    let url = get_authorize_url(&state.db).await?;
    Ok(Json(json!({ "url": url })))
}

async fn get_oauth_callback(
    State(state): State<AppState>,
    Query(q): Query<OAuthCallbackQuery>,
) -> impl IntoResponse {
    match exchange_code(&state.db, &q.code).await {
        Ok(_) => Html(r#"
            <html>
            <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #0c0a09; color: #fafaf9; margin: 0;">
              <div style="text-align: center; padding: 2.5rem; background: rgba(28, 25, 23, 0.6); border: 1px solid rgba(120, 113, 108, 0.2); border-radius: 12px; backdrop-filter: blur(12px); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);">
                <div style="font-size: 3rem; margin-bottom: 1rem; color: #22c55e;">✓</div>
                <h2 style="font-weight: 600; margin: 0 0 0.5rem 0;">Constant Contact Connected</h2>
                <p style="color: #a8a29e; font-size: 0.95rem; margin-bottom: 1.5rem;">Authentication completed successfully.</p>
                <p style="color: #78716c; font-size: 0.85rem;">You can now close this tab and return to the POS settings dashboard.</p>
              </div>
              <script>
                setTimeout(function() { window.close(); }, 3000);
              </script>
            </body>
            </html>
        "#).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "Constant Contact OAuth callback exchange failed");
            Html(format!(r#"
                <html>
                <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #0c0a09; color: #fafaf9; margin: 0;">
                  <div style="text-align: center; padding: 2.5rem; background: rgba(28, 25, 23, 0.6); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 12px; backdrop-filter: blur(12px); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);">
                    <div style="font-size: 3rem; margin-bottom: 1rem; color: #ef4444;">✗</div>
                    <h2 style="font-weight: 600; margin: 0 0 0.5rem 0;">Connection Failed</h2>
                    <p style="color: #a8a29e; font-size: 0.95rem; margin-bottom: 1.5rem;">OAuth token exchange rejected.</p>
                    <pre style="background: rgba(0,0,0,0.3); padding: 1rem; border-radius: 6px; font-family: monospace; font-size: 0.8rem; color: #f87171; text-align: left; max-width: 400px; overflow-x: auto;">{}</pre>
                    <p style="color: #78716c; font-size: 0.85rem; margin-top: 1.5rem;">Please close this window and try again.</p>
                  </div>
                </body>
                </html>
            "#, e)).into_response()
        }
    }
}

async fn get_lists(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<constant_contact::ConstantContactList>>, CcApiError> {
    require_staff_with_permission(&state, &headers, CONSTANT_CONTACT_MANAGE)
        .await
        .map_err(|_| {
            CcApiError::Forbidden("missing constant_contact.manage permission".to_string())
        })?;

    let lists = fetch_lists(&state.db).await?;
    Ok(Json(lists))
}

async fn post_sync_contacts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<constant_contact::SyncResult>, CcApiError> {
    let staff = require_staff_with_permission(&state, &headers, CONSTANT_CONTACT_SYNC)
        .await
        .map_err(|_| {
            CcApiError::Forbidden("missing constant_contact.sync permission".to_string())
        })?;

    let result = sync_contacts(&state.db, Some(staff.id)).await?;
    Ok(Json(result))
}

async fn post_webhook_receive(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, CcApiError> {
    // Ingest events
    ingest_webhook_event(&state.db, &body).await?;
    Ok(StatusCode::OK)
}
