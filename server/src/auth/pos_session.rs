//! Opaque `register_sessions.pos_api_token` validation for POS-scoped HTTP calls.

use axum::http::HeaderMap;
use uuid::Uuid;

pub const HEADER_POS_SESSION_ID: &str = "x-riverside-pos-session-id";
pub const HEADER_POS_SESSION_TOKEN: &str = "x-riverside-pos-session-token";
pub const HEADER_STATION_KEY: &str = "x-riverside-station-key";

pub fn pos_session_headers(headers: &HeaderMap) -> Option<(Uuid, String, String)> {
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
    let station_key = headers
        .get(HEADER_STATION_KEY)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)?;
    Some((session_id, token, station_key))
}

/// Returns true when the session is open and the token matches the issuing station.
pub async fn verify_pos_session_token(
    pool: &sqlx::PgPool,
    session_id: Uuid,
    token: &str,
    station_key: &str,
) -> Result<bool, sqlx::Error> {
    let ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM register_sessions
            JOIN register_session_station_tokens station_token
              ON station_token.register_session_id = register_sessions.id
            WHERE register_sessions.id = $1
              AND register_sessions.is_open = true
              AND station_token.pos_api_token = $2
              AND station_token.station_key = $3
        )
        "#,
    )
    .bind(session_id)
    .bind(token)
    .bind(station_key)
    .fetch_one(pool)
    .await?;
    if ok {
        let _ = sqlx::query(
            r#"
            UPDATE register_session_station_tokens
            SET last_used_at = now()
            WHERE register_session_id = $1
              AND pos_api_token = $2
              AND station_key = $3
            "#,
        )
        .bind(session_id)
        .bind(token)
        .bind(station_key)
        .execute(pool)
        .await;
    }
    Ok(ok)
}

pub fn new_pos_api_token() -> String {
    Uuid::new_v4().to_string()
}
