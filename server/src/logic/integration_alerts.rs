//! Persist last success/failure for background integrations (admin notification generators).

use sqlx::PgPool;
use uuid::Uuid;

const DETAIL_MAX: usize = 500;

fn clip(s: &str) -> String {
    let t = s.trim();
    if t.len() <= DETAIL_MAX {
        t.to_string()
    } else {
        format!("{}…", &t[..DETAIL_MAX.saturating_sub(1)])
    }
}

pub async fn record_integration_success(pool: &PgPool, source: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO integration_alert_state (source, last_success_at, updated_at)
        VALUES ($1, NOW(), NOW())
        ON CONFLICT (source) DO UPDATE SET
            last_success_at = EXCLUDED.last_success_at,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_integration_failure(
    pool: &PgPool,
    source: &str,
    detail: &str,
) -> Result<(), sqlx::Error> {
    let d = clip(detail);
    sqlx::query(
        r#"
        INSERT INTO integration_alert_state (source, last_failure_at, detail, updated_at)
        VALUES ($1, NOW(), $2, NOW())
        ON CONFLICT (source) DO UPDATE SET
            last_failure_at = EXCLUDED.last_failure_at,
            detail = EXCLUDED.detail,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(source)
    .bind(&d)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn log_staff_pin_mismatch(pool: &PgPool, staff_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO staff_auth_failure_event (staff_id, failure_kind)
        VALUES ($1, 'pin_mismatch')
        "#,
    )
    .bind(staff_id)
    .execute(pool)
    .await?;
    Ok(())
}
