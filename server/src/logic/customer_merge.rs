//! Transactional merge of duplicate customer rows into a master record.

use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CustomerMergeError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
}

#[derive(Debug, Serialize)]
pub struct MergePreview {
    pub orders: i64,
    pub wedding_members: i64,
    pub wedding_appointments: i64,
    pub gift_cards: i64,
    pub timeline_notes: i64,
    pub customer_group_memberships: i64,
    pub alteration_orders: i64,
    pub loyalty_points_on_slave: i32,
    pub store_credit_balance_on_slave: Option<String>,
}

/// Read-only counts for CRM merge confirmation (no mutations).
pub async fn merge_preview(
    pool: &PgPool,
    master: Uuid,
    slave: Uuid,
) -> Result<MergePreview, CustomerMergeError> {
    if master == slave {
        return Err(CustomerMergeError::BadRequest(
            "master and slave must differ".to_string(),
        ));
    }

    let m_ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(master)
        .fetch_one(pool)
        .await?;
    let s_ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(slave)
        .fetch_one(pool)
        .await?;
    if !m_ok || !s_ok {
        return Err(CustomerMergeError::BadRequest(
            "one or both customers not found".to_string(),
        ));
    }

    let orders: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM transactions WHERE customer_id = $1")
            .bind(slave)
            .fetch_one(pool)
            .await?;
    let wedding_members: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM wedding_members WHERE customer_id = $1")
            .bind(slave)
            .fetch_one(pool)
            .await?;
    let wedding_appointments: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM wedding_appointments WHERE customer_id = $1",
    )
    .bind(slave)
    .fetch_one(pool)
    .await?;
    let gift_cards: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM gift_cards WHERE customer_id = $1")
            .bind(slave)
            .fetch_one(pool)
            .await?;
    let timeline_notes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM customer_timeline_notes WHERE customer_id = $1",
    )
    .bind(slave)
    .fetch_one(pool)
    .await?;
    let customer_group_memberships: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM customer_group_members WHERE customer_id = $1",
    )
    .bind(slave)
    .fetch_one(pool)
    .await?;
    let alteration_orders: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM alteration_orders WHERE customer_id = $1")
            .bind(slave)
            .fetch_one(pool)
            .await?;

    let loyalty_points_on_slave: i32 =
        sqlx::query_scalar("SELECT loyalty_points FROM customers WHERE id = $1")
            .bind(slave)
            .fetch_one(pool)
            .await?;

    let store_credit_balance_on_slave: Option<String> =
        sqlx::query_scalar("SELECT balance FROM store_credit_accounts WHERE customer_id = $1")
            .bind(slave)
            .fetch_optional(pool)
            .await?
            .map(|d: Decimal| d.to_string());

    Ok(MergePreview {
        orders,
        wedding_members,
        wedding_appointments,
        gift_cards,
        timeline_notes,
        customer_group_memberships,
        alteration_orders,
        loyalty_points_on_slave,
        store_credit_balance_on_slave,
    })
}

/// Re-point foreign keys from `slave` to `master`, then delete `slave`.
pub async fn merge_customers(
    pool: &PgPool,
    master: Uuid,
    slave: Uuid,
) -> Result<(), CustomerMergeError> {
    if master == slave {
        return Err(CustomerMergeError::BadRequest(
            "master and slave must differ".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;

    let m_ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(master)
        .fetch_one(&mut *tx)
        .await?;
    let s_ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(slave)
        .fetch_one(&mut *tx)
        .await?;
    if !m_ok || !s_ok {
        return Err(CustomerMergeError::BadRequest(
            "one or both customers not found".to_string(),
        ));
    }

    let slave_pts: i32 = sqlx::query_scalar("SELECT loyalty_points FROM customers WHERE id = $1")
        .bind(slave)
        .fetch_one(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        DELETE FROM wedding_members wm1
        USING wedding_members wm2
        WHERE wm1.customer_id = $1
          AND wm2.customer_id = $2
          AND wm1.wedding_party_id = wm2.wedding_party_id
        "#,
    )
    .bind(slave)
    .bind(master)
    .execute(&mut *tx)
    .await?;

    repoint_customer_fk(&mut tx, "orders", master, slave).await?;
    repoint_customer_fk(&mut tx, "wedding_members", master, slave).await?;
    repoint_customer_fk(&mut tx, "wedding_appointments", master, slave).await?;
    repoint_customer_fk(&mut tx, "gift_cards", master, slave).await?;

    sqlx::query("UPDATE customer_timeline_notes SET customer_id = $1 WHERE customer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM customer_measurements WHERE customer_id = $1")
        .bind(slave)
        .execute(&mut *tx)
        .await?;

    merge_store_credit_accounts(&mut tx, master, slave).await?;

    sqlx::query("DELETE FROM customer_group_members WHERE customer_id = $1")
        .bind(slave)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        UPDATE customers
        SET loyalty_points = loyalty_points + $2
        WHERE id = $1
        "#,
    )
    .bind(master)
    .bind(slave_pts)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM customers WHERE id = $1")
        .bind(slave)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

async fn merge_store_credit_accounts(
    tx: &mut Transaction<'_, Postgres>,
    master: Uuid,
    slave: Uuid,
) -> Result<(), sqlx::Error> {
    let slave_acc: Option<(Uuid, Decimal)> = sqlx::query_as(
        "SELECT id, balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE",
    )
    .bind(slave)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((slave_id, slave_bal)) = slave_acc else {
        return Ok(());
    };

    let master_acc: Option<(Uuid, Decimal)> = sqlx::query_as(
        "SELECT id, balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE",
    )
    .bind(master)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some((master_id, master_bal)) = master_acc {
        let combined = master_bal + slave_bal;
        sqlx::query(
            "UPDATE store_credit_accounts SET balance = $1, updated_at = now() WHERE id = $2",
        )
        .bind(combined)
        .bind(master_id)
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE store_credit_ledger SET account_id = $1 WHERE account_id = $2
            "#,
        )
        .bind(master_id)
        .bind(slave_id)
        .execute(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM store_credit_accounts WHERE id = $1")
            .bind(slave_id)
            .execute(&mut **tx)
            .await?;
    } else {
        sqlx::query("UPDATE store_credit_accounts SET customer_id = $1 WHERE id = $2")
            .bind(master)
            .bind(slave_id)
            .execute(&mut **tx)
            .await?;
    }

    Ok(())
}

async fn repoint_customer_fk(
    tx: &mut Transaction<'_, Postgres>,
    table: &str,
    master: Uuid,
    slave: Uuid,
) -> Result<(), sqlx::Error> {
    let sql = format!("UPDATE {table} SET customer_id = $1 WHERE customer_id = $2");
    sqlx::query(&sql)
        .bind(master)
        .bind(slave)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
