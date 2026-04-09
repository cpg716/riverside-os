//! Opaque `register_sessions.pos_api_token` validation for POS-scoped HTTP calls.

use axum::http::HeaderMap;
use uuid::Uuid;

pub const HEADER_POS_SESSION_ID: &str = "x-riverside-pos-session-id";
pub const HEADER_POS_SESSION_TOKEN: &str = "x-riverside-pos-session-token";

pub fn pos_session_headers(headers: &HeaderMap) -> Option<(Uuid, String)> {
    let sid = headers
        .get(HEADER_POS_SESSION_ID)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let session_id = Uuid::parse_str(sid).ok()?;
    let token = headers
        .get(HEADER_POS_SESSION_TOKEN)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)?;
    Some((session_id, token))
}

/// Returns true when the session is open and the token matches.
pub async fn verify_pos_session_token(
    pool: &sqlx::PgPool,
    session_id: Uuid,
    token: &str,
) -> Result<bool, sqlx::Error> {
    let ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM register_sessions
            WHERE id = $1
              AND is_open = true
              AND pos_api_token IS NOT NULL
              AND pos_api_token = $2
        )
        "#,
    )
    .bind(session_id)
    .bind(token)
    .fetch_one(pool)
    .await?;
    Ok(ok)
}

pub fn new_pos_api_token() -> String {
    Uuid::new_v4().to_string()
}
