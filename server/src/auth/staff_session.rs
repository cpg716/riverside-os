//! Opaque, station-bound Staff Access sessions.

use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::pins::AuthenticatedStaff;
use crate::models::DbStaffRole;

pub const HEADER_STAFF_SESSION: &str = "x-riverside-staff-session";
pub const HEADER_STATION_KEY: &str = "x-riverside-station-key";
pub const HEADER_CONNECTION_KEY: &str = "x-riverside-connection-key";
const DEFAULT_SESSION_HOURS: i64 = 16;
const LAST_SEEN_WRITE_INTERVAL_SECONDS: i64 = 60;

#[derive(Debug, Clone)]
pub struct IssuedStaffSession {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn session_hours() -> i64 {
    std::env::var("RIVERSIDE_STAFF_SESSION_HOURS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| (1..=24).contains(value))
        .unwrap_or(DEFAULT_SESSION_HOURS)
}

pub fn new_staff_session_token() -> String {
    format!("{}.{}", Uuid::new_v4(), Uuid::new_v4())
}

pub async fn issue_staff_session(
    pool: &PgPool,
    staff_id: Uuid,
    station_key: &str,
    connection_key: &str,
    runtime_surface: &str,
    user_agent: Option<&str>,
    api_base: Option<&str>,
) -> Result<IssuedStaffSession, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        DELETE FROM staff_access_sessions
        WHERE expires_at < now() - interval '7 days'
           OR revoked_at < now() - interval '7 days'
        "#,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE staff_access_sessions
        SET revoked_at = now()
        WHERE staff_id = $1
          AND station_key = $2
          AND connection_key = $3
          AND revoked_at IS NULL
        "#,
    )
    .bind(staff_id)
    .bind(station_key)
    .bind(connection_key)
    .execute(&mut *tx)
    .await?;

    let token = new_staff_session_token();
    let expires_at = Utc::now() + Duration::hours(session_hours());
    sqlx::query(
        r#"
        INSERT INTO staff_access_sessions (
            id, staff_id, token_hash, station_key, connection_key, runtime_surface,
            user_agent, api_base, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(staff_id)
    .bind(token_hash(&token))
    .bind(station_key)
    .bind(connection_key)
    .bind(runtime_surface)
    .bind(user_agent)
    .bind(api_base)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(IssuedStaffSession { token, expires_at })
}

#[allow(clippy::type_complexity)]
pub async fn authenticate_staff_session(
    pool: &PgPool,
    token: &str,
    station_key: &str,
    connection_key: &str,
) -> Result<Option<AuthenticatedStaff>, sqlx::Error> {
    let row: Option<(
        Uuid,
        String,
        DbStaffRole,
        String,
        Option<String>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        r#"
        SELECT
            staff.id,
            staff.full_name,
            staff.role,
            staff.avatar_key,
            staff.avatar_photo_url,
            staff_access_sessions.last_seen_at
        FROM staff_access_sessions
        INNER JOIN staff ON staff.id = staff_access_sessions.staff_id
        WHERE staff_access_sessions.token_hash = $1
          AND staff_access_sessions.station_key = $2
          AND staff_access_sessions.connection_key = $3
          AND staff_access_sessions.revoked_at IS NULL
          AND staff_access_sessions.expires_at > now()
          AND staff.is_active = TRUE
        "#,
    )
    .bind(token_hash(token))
    .bind(station_key)
    .bind(connection_key)
    .fetch_optional(pool)
    .await?;

    let Some((id, full_name, role, avatar_key, avatar_photo_url, last_seen_at)) = row else {
        return Ok(None);
    };

    if last_seen_at < Utc::now() - Duration::seconds(LAST_SEEN_WRITE_INTERVAL_SECONDS) {
        sqlx::query(
            r#"
            UPDATE staff_access_sessions
            SET last_seen_at = now()
            WHERE token_hash = $1
              AND station_key = $2
              AND connection_key = $3
              AND revoked_at IS NULL
              AND expires_at > now()
              AND last_seen_at < now() - interval '60 seconds'
            "#,
        )
        .bind(token_hash(token))
        .bind(station_key)
        .bind(connection_key)
        .execute(pool)
        .await?;
    }

    Ok(Some(AuthenticatedStaff {
        id,
        full_name,
        role,
        avatar_key,
        avatar_photo_url,
    }))
}

pub async fn revoke_staff_session(
    pool: &PgPool,
    token: &str,
    station_key: &str,
    connection_key: &str,
) -> Result<bool, sqlx::Error> {
    let changed = sqlx::query(
        r#"
        UPDATE staff_access_sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE token_hash = $1 AND station_key = $2 AND connection_key = $3
        "#,
    )
    .bind(token_hash(token))
    .bind(station_key)
    .bind(connection_key)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::{new_staff_session_token, token_hash};

    #[test]
    fn staff_session_tokens_are_opaque_and_hash_stably() {
        let first = new_staff_session_token();
        let second = new_staff_session_token();
        assert_ne!(first, second);
        assert!(first.len() >= 64);
        assert_eq!(token_hash(&first), token_hash(&first));
        assert_ne!(token_hash(&first), token_hash(&second));
        assert!(!token_hash(&first).contains(&first));
    }
}
