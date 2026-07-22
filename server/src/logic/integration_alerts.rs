//! Persist last success/failure for background integrations (admin notification generators).

use sqlx::PgPool;
use uuid::Uuid;

const DETAIL_MAX: usize = 500;

fn clip(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= DETAIL_MAX {
        t.to_string()
    } else {
        let clipped = t
            .chars()
            .take(DETAIL_MAX.saturating_sub(1))
            .collect::<String>();
        format!("{clipped}…")
    }
}

pub async fn record_integration_success(pool: &PgPool, source: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO integration_alert_state (source, status, last_success_at, detail, updated_at)
        VALUES ($1, 'GOOD', NOW(), NULL, NOW())
        ON CONFLICT (source) DO UPDATE SET
            status = EXCLUDED.status,
            last_success_at = EXCLUDED.last_success_at,
            detail = NULL,
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
        INSERT INTO integration_alert_state (source, status, last_failure_at, detail, updated_at)
        VALUES ($1, 'WARNING', NOW(), $2, NOW())
        ON CONFLICT (source) DO UPDATE SET
            status = EXCLUDED.status,
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

pub async fn record_integration_caution(
    pool: &PgPool,
    source: &str,
    detail: &str,
) -> Result<(), sqlx::Error> {
    let detail = clip(detail);
    sqlx::query(
        r#"
        INSERT INTO integration_alert_state (source, status, detail, updated_at)
        VALUES ($1, 'CAUTION', $2, NOW())
        ON CONFLICT (source) DO UPDATE SET
            status = EXCLUDED.status,
            detail = EXCLUDED.detail,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(source)
    .bind(detail)
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

#[cfg(test)]
mod tests {
    use super::{clip, DETAIL_MAX};

    #[test]
    fn integration_detail_clipping_is_unicode_safe() {
        let detail = "é".repeat(DETAIL_MAX + 20);
        let clipped = clip(&detail);
        assert_eq!(clipped.chars().count(), DETAIL_MAX);
        assert!(clipped.ends_with('…'));
    }
}
