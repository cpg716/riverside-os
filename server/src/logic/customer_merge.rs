//! Transactional merge of duplicate customer rows into a master record.
//!
//! The former duplicate row is retained as an inactive historical customer.

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
    pub blocking_reasons: Vec<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct MergeRiskRow {
    account_access: bool,
    relationship_history: bool,
}

const MERGE_RISK_SQL: &str = r#"
    SELECT
        (
            EXISTS(SELECT 1 FROM staff WHERE employee_customer_id = $1)
        ) AS account_access,
        (
            EXISTS(SELECT 1 FROM customer_relationship_periods WHERE child_customer_id = $1 OR parent_customer_id = $1)
            OR EXISTS(SELECT 1 FROM customers WHERE couple_primary_id = $1)
        ) AS relationship_history
"#;

fn merge_risk_reasons(risk: MergeRiskRow) -> Vec<String> {
    let mut reasons = Vec::new();
    if risk.account_access {
        reasons.push("staff account identity".to_string());
    }
    if risk.relationship_history {
        reasons.push("linked customer relationships".to_string());
    }
    reasons
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

    let blocking_reasons = merge_risk_reasons(
        sqlx::query_as::<_, MergeRiskRow>(MERGE_RISK_SQL)
            .bind(slave)
            .bind(master)
            .fetch_one(pool)
            .await?,
    );

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
        blocking_reasons,
    })
}

/// Re-point customer history from `slave` to `master`, then retain `slave` as inactive history.
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

    let blocking_reasons = merge_risk_reasons(
        sqlx::query_as::<_, MergeRiskRow>(MERGE_RISK_SQL)
            .bind(slave)
            .bind(master)
            .fetch_one(&mut *tx)
            .await?,
    );
    if !blocking_reasons.is_empty() {
        return Err(CustomerMergeError::BadRequest(format!(
            "Merge blocked to protect linked data: {}. Keep the customer with these records as the master, or resolve the links before merging.",
            blocking_reasons.join(", ")
        )));
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

    repoint_customer_fk(&mut tx, "transactions", master, slave).await?;
    repoint_customer_fk(&mut tx, "alteration_orders", master, slave).await?;
    repoint_customer_fk(&mut tx, "customer_corecredit_accounts", master, slave).await?;
    repoint_customer_fk(&mut tx, "loyalty_point_ledger", master, slave).await?;
    repoint_customer_fk(&mut tx, "loyalty_reward_issuances", master, slave).await?;
    repoint_customer_fk(&mut tx, "measurements", master, slave).await?;
    repoint_customer_fk(&mut tx, "fulfillment_orders", master, slave).await?;
    repoint_customer_fk(&mut tx, "wedding_members", master, slave).await?;
    repoint_customer_fk(&mut tx, "wedding_appointments", master, slave).await?;
    repoint_customer_fk(&mut tx, "gift_cards", master, slave).await?;
    repoint_customer_fk(&mut tx, "transaction_activity_log", master, slave).await?;
    repoint_customer_fk(&mut tx, "transaction_refund_queue", master, slave).await?;
    repoint_customer_fk(&mut tx, "podium_conversation", master, slave).await?;
    repoint_customer_fk(&mut tx, "pos_parked_sale", master, slave).await?;
    repoint_customer_fk(&mut tx, "pos_rms_charge_record", master, slave).await?;
    repoint_customer_fk(&mut tx, "shipment", master, slave).await?;
    repoint_customer_fk(&mut tx, "task_assignment", master, slave).await?;
    repoint_customer_fk(&mut tx, "task_instance", master, slave).await?;

    sqlx::query("UPDATE customer_timeline_notes SET customer_id = $1 WHERE customer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO measurements (
            customer_id, neck, sleeve, chest, waist, seat, inseam, outseam,
            shoulder, measured_by, created_at
        )
        SELECT $1, neck, sleeve, chest, waist, seat, inseam, outseam,
               shoulder, measured_by, measured_at
        FROM customer_measurements
        WHERE customer_id = $2
          AND EXISTS (
              SELECT 1 FROM customer_measurements WHERE customer_id = $1
          )
        "#,
    )
    .bind(master)
    .bind(slave)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE payment_transactions SET payer_id = $1 WHERE payer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE customer_open_deposit_ledger SET payer_customer_id = $1 WHERE payer_customer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE corecard_posting_event SET customer_id = $1 WHERE customer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE corecredit_event_log SET related_customer_id = $1 WHERE related_customer_id = $2",
    )
    .bind(master)
    .bind(slave)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE rms_account_list_snapshots SET matched_customer_id = $1 WHERE matched_customer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE store_checkout_session SET customer_id = $1 WHERE customer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE store_checkout_session SET account_conversion_customer_id = $1 WHERE account_conversion_customer_id = $2")
        .bind(master)
        .bind(slave)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
        UPDATE customer_measurements
        SET customer_id = $1
        WHERE customer_id = $2
          AND NOT EXISTS (
              SELECT 1 FROM customer_measurements WHERE customer_id = $1
          )
        "#,
    )
    .bind(master)
    .bind(slave)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE customer_online_credential
        SET customer_id = $1, updated_at = now()
        WHERE customer_id = $2
          AND NOT EXISTS (
              SELECT 1 FROM customer_online_credential WHERE customer_id = $1
          )
        "#,
    )
    .bind(master)
    .bind(slave)
    .execute(&mut *tx)
    .await?;

    merge_store_credit_accounts(&mut tx, master, slave).await?;
    merge_open_deposit_accounts(&mut tx, master, slave).await?;

    sqlx::query(
        r#"
        INSERT INTO customer_group_members (customer_id, group_id)
        SELECT $1, group_id FROM customer_group_members WHERE customer_id = $2
        ON CONFLICT (customer_id, group_id) DO NOTHING
        "#,
    )
    .bind(master)
    .bind(slave)
    .execute(&mut *tx)
    .await?;
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

    sqlx::query(
        "UPDATE customer_duplicate_review_queue SET status = 'merged' WHERE status = 'pending' AND (customer_a_id = $1 OR customer_b_id = $1)",
    )
    .bind(slave)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE customers SET is_active = FALSE, merged_into_customer_id = $1, loyalty_points = 0 WHERE id = $2",
    )
        .bind(master)
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

async fn merge_open_deposit_accounts(
    tx: &mut Transaction<'_, Postgres>,
    master: Uuid,
    slave: Uuid,
) -> Result<(), sqlx::Error> {
    let slave_acc: Option<(Uuid, Decimal)> = sqlx::query_as(
        "SELECT id, balance FROM customer_open_deposit_accounts WHERE customer_id = $1 FOR UPDATE",
    )
    .bind(slave)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((slave_id, slave_balance)) = slave_acc else {
        return Ok(());
    };

    let master_acc: Option<(Uuid, Decimal)> = sqlx::query_as(
        "SELECT id, balance FROM customer_open_deposit_accounts WHERE customer_id = $1 FOR UPDATE",
    )
    .bind(master)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some((master_id, master_balance)) = master_acc {
        sqlx::query(
            "UPDATE customer_open_deposit_accounts SET balance = $1, updated_at = now() WHERE id = $2",
        )
        .bind(master_balance + slave_balance)
        .bind(master_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE customer_open_deposit_ledger SET account_id = $1 WHERE account_id = $2",
        )
        .bind(master_id)
        .bind(slave_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM customer_open_deposit_accounts WHERE id = $1")
            .bind(slave_id)
            .execute(&mut **tx)
            .await?;
    } else {
        sqlx::query("UPDATE customer_open_deposit_accounts SET customer_id = $1 WHERE id = $2")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn merge_risk_query_matches_current_schema() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let risk = sqlx::query_as::<_, MergeRiskRow>(MERGE_RISK_SQL)
            .bind(Uuid::nil())
            .bind(Uuid::nil())
            .fetch_one(&pool)
            .await
            .expect("customer merge risk query matches the current schema");

        assert!(merge_risk_reasons(risk).is_empty());
    }
}
