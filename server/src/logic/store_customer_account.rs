//! Normalized email lookup and online credential writes for public `/api/store/account/*`.

use sqlx::PgPool;
use uuid::Uuid;

pub fn normalize_store_email(raw: &str) -> Option<String> {
    let t = raw.trim().to_lowercase();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

pub async fn find_customer_id_by_normalized_email(
    pool: &PgPool,
    email_norm: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT id FROM customers
        WHERE email IS NOT NULL AND lower(trim(email)) = $1
        LIMIT 1
        "#,
    )
    .bind(email_norm)
    .fetch_optional(pool)
    .await
}

pub async fn online_credential_exists(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM customer_online_credential WHERE customer_id = $1)",
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await
}

pub async fn fetch_online_password_hash(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT password_hash FROM customer_online_credential WHERE customer_id = $1",
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await
}

pub async fn insert_online_credential_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    customer_id: Uuid,
    password_hash: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO customer_online_credential (customer_id, password_hash)
        VALUES ($1, $2)
        "#,
    )
    .bind(customer_id)
    .bind(password_hash)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
