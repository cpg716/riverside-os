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
    pub blocking_reasons: Vec<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct MergeRiskRow {
    measurement_history: bool,
    alteration_history: bool,
    group_memberships: bool,
    open_deposit: bool,
    financial_history: bool,
    account_access: bool,
    relationship_history: bool,
    operational_history: bool,
    duplicate_wedding_membership: bool,
}

const MERGE_RISK_SQL: &str = r#"
    SELECT
        (
            EXISTS(SELECT 1 FROM customer_measurements WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM measurements WHERE customer_id = $1)
        ) AS measurement_history,
        EXISTS(SELECT 1 FROM alteration_orders WHERE customer_id = $1) AS alteration_history,
        EXISTS(SELECT 1 FROM customer_group_members WHERE customer_id = $1) AS group_memberships,
        EXISTS(SELECT 1 FROM customer_open_deposit_accounts WHERE customer_id = $1) AS open_deposit,
        (
            EXISTS(SELECT 1 FROM customer_corecredit_accounts WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM loyalty_point_ledger WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM loyalty_reward_issuances WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM payment_transactions WHERE payer_id = $1)
            OR EXISTS(SELECT 1 FROM customer_open_deposit_ledger WHERE payer_customer_id = $1)
        ) AS financial_history,
        (
            EXISTS(SELECT 1 FROM customer_online_credential WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM staff WHERE employee_customer_id = $1)
        ) AS account_access,
        (
            EXISTS(SELECT 1 FROM customer_relationship_periods WHERE child_customer_id = $1 OR parent_customer_id = $1)
            OR EXISTS(SELECT 1 FROM customers WHERE couple_primary_id = $1)
        ) AS relationship_history,
        (
            EXISTS(SELECT 1 FROM fulfillment_orders WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM order_activity_log WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM order_refund_queue WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM orders WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM podium_conversation WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM pos_parked_sale WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM pos_rms_charge_record WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM shipment WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM task_assignment WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM task_instance WHERE customer_id = $1)
            OR EXISTS(SELECT 1 FROM store_checkout_session WHERE customer_id = $1 OR account_conversion_customer_id = $1)
        ) AS operational_history,
        EXISTS(
            SELECT 1
            FROM wedding_members slave_member
            JOIN wedding_members master_member
              ON master_member.wedding_party_id = slave_member.wedding_party_id
            WHERE slave_member.customer_id = $1
              AND master_member.customer_id = $2
        ) AS duplicate_wedding_membership
"#;

fn merge_risk_reasons(risk: MergeRiskRow) -> Vec<String> {
    let mut reasons = Vec::new();
    if risk.measurement_history {
        reasons.push("measurement history".to_string());
    }
    if risk.alteration_history {
        reasons.push("alteration history".to_string());
    }
    if risk.group_memberships {
        reasons.push("customer group memberships".to_string());
    }
    if risk.open_deposit {
        reasons.push("open deposit funds".to_string());
    }
    if risk.financial_history {
        reasons.push("financial or loyalty history".to_string());
    }
    if risk.account_access {
        reasons.push("online or staff account access".to_string());
    }
    if risk.relationship_history {
        reasons.push("linked customer relationships".to_string());
    }
    if risk.operational_history {
        reasons.push("operational order, shipment, task, or communication history".to_string());
    }
    if risk.duplicate_wedding_membership {
        reasons.push("both customers are members of the same wedding party".to_string());
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
