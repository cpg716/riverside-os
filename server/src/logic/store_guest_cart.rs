//! Persistent anonymous cart for the public storefront.

use sqlx::{PgPool, Row};
use uuid::Uuid;

pub async fn create_cart_with_lines(
    pool: &PgPool,
    pairs: &[(Uuid, i32)],
) -> Result<Uuid, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO store_guest_cart DEFAULT VALUES RETURNING id")
        .fetch_one(&mut *tx)
        .await?;
    for (vid, qty) in pairs {
        sqlx::query(
            "INSERT INTO store_guest_cart_line (cart_id, variant_id, qty) VALUES ($1, $2, $3)",
        )
        .bind(id)
        .bind(vid)
        .bind(qty)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

/// `None` when the cart is missing or expired.
pub async fn load_cart_lines(
    pool: &PgPool,
    cart_id: Uuid,
) -> Result<Option<Vec<(Uuid, i32)>>, sqlx::Error> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM store_guest_cart WHERE id = $1 AND expires_at > now())",
    )
    .bind(cart_id)
    .fetch_one(pool)
    .await?;

    if !ok {
        return Ok(None);
    }

    sqlx::query(
        r#"UPDATE store_guest_cart
           SET updated_at = now(),
               expires_at = now() + interval '90 days'
           WHERE id = $1"#,
    )
    .bind(cart_id)
    .execute(pool)
    .await?;

    let rows = sqlx::query(
        "SELECT variant_id, qty FROM store_guest_cart_line WHERE cart_id = $1 ORDER BY variant_id",
    )
    .bind(cart_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push((r.try_get("variant_id")?, r.try_get("qty")?));
    }
    Ok(Some(out))
}

/// `false` when the cart is missing or expired.
pub async fn replace_cart_lines(
    pool: &PgPool,
    cart_id: Uuid,
    pairs: &[(Uuid, i32)],
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let res = sqlx::query(
        r#"UPDATE store_guest_cart
           SET updated_at = now(),
               expires_at = now() + interval '90 days'
           WHERE id = $1 AND expires_at > now()"#,
    )
    .bind(cart_id)
    .execute(&mut *tx)
    .await?;

    if res.rows_affected() == 0 {
        let _ = tx.rollback().await;
        return Ok(false);
    }

    sqlx::query("DELETE FROM store_guest_cart_line WHERE cart_id = $1")
        .bind(cart_id)
        .execute(&mut *tx)
        .await?;

    for (vid, qty) in pairs {
        sqlx::query(
            "INSERT INTO store_guest_cart_line (cart_id, variant_id, qty) VALUES ($1, $2, $3)",
        )
        .bind(cart_id)
        .bind(vid)
        .bind(qty)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(true)
}

pub async fn delete_cart(pool: &PgPool, cart_id: Uuid) -> Result<u64, sqlx::Error> {
    let res = sqlx::query("DELETE FROM store_guest_cart WHERE id = $1")
        .bind(cart_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}
