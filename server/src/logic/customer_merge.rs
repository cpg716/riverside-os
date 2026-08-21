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

const MERGE_MISSING_PROFILE_SQL: &str = r#"
    UPDATE customers AS master
    SET
        first_name = COALESCE(NULLIF(BTRIM(master.first_name), ''), NULLIF(BTRIM(slave.first_name), ''), master.first_name),
        last_name = COALESCE(NULLIF(BTRIM(master.last_name), ''), NULLIF(BTRIM(slave.last_name), ''), master.last_name),
        company_name = COALESCE(NULLIF(BTRIM(master.company_name), ''), NULLIF(BTRIM(slave.company_name), '')),
        email = COALESCE(NULLIF(BTRIM(master.email), ''), NULLIF(BTRIM($3::text), '')),
        phone = COALESCE(NULLIF(BTRIM(master.phone), ''), NULLIF(BTRIM(slave.phone), '')),
        address_line1 = COALESCE(NULLIF(BTRIM(master.address_line1), ''), NULLIF(BTRIM(slave.address_line1), '')),
        address_line2 = COALESCE(NULLIF(BTRIM(master.address_line2), ''), NULLIF(BTRIM(slave.address_line2), '')),
        city = COALESCE(NULLIF(BTRIM(master.city), ''), NULLIF(BTRIM(slave.city), '')),
        state = COALESCE(NULLIF(BTRIM(master.state), ''), NULLIF(BTRIM(slave.state), '')),
        postal_code = COALESCE(NULLIF(BTRIM(master.postal_code), ''), NULLIF(BTRIM(slave.postal_code), '')),
        date_of_birth = COALESCE(master.date_of_birth, slave.date_of_birth),
        anniversary_date = COALESCE(master.anniversary_date, slave.anniversary_date),
        custom_field_1 = COALESCE(NULLIF(BTRIM(master.custom_field_1), ''), NULLIF(BTRIM(slave.custom_field_1), '')),
        custom_field_2 = COALESCE(NULLIF(BTRIM(master.custom_field_2), ''), NULLIF(BTRIM(slave.custom_field_2), '')),
        custom_field_3 = COALESCE(NULLIF(BTRIM(master.custom_field_3), ''), NULLIF(BTRIM(slave.custom_field_3), '')),
        custom_field_4 = COALESCE(NULLIF(BTRIM(master.custom_field_4), ''), NULLIF(BTRIM(slave.custom_field_4), '')),
        podium_conversation_url = COALESCE(NULLIF(BTRIM(master.podium_conversation_url), ''), NULLIF(BTRIM(slave.podium_conversation_url), '')),
        preferred_salesperson_id = COALESCE(master.preferred_salesperson_id, slave.preferred_salesperson_id),
        is_vip = master.is_vip OR slave.is_vip,
        review_requests_opt_out = master.review_requests_opt_out OR slave.review_requests_opt_out
    FROM customers AS slave
    WHERE master.id = $1
      AND slave.id = $2
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
    actor_id: Uuid,
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

    merge_missing_customer_profile(&mut tx, master, slave).await?;

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

    record_customer_merge_history(&mut tx, master, slave, actor_id).await?;

    tx.commit().await?;
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct MergeHistoryCustomer {
    customer_code: String,
    display_name: String,
}

async fn record_customer_merge_history(
    tx: &mut Transaction<'_, Postgres>,
    master: Uuid,
    slave: Uuid,
    actor_id: Uuid,
) -> Result<(), sqlx::Error> {
    let customer_identity_sql = r#"
        SELECT
            customer_code,
            COALESCE(
                NULLIF(BTRIM(CONCAT_WS(' ', first_name, last_name)), ''),
                NULLIF(BTRIM(company_name), ''),
                customer_code
            ) AS display_name
        FROM customers
        WHERE id = $1
    "#;
    let master_identity = sqlx::query_as::<_, MergeHistoryCustomer>(customer_identity_sql)
        .bind(master)
        .fetch_one(&mut **tx)
        .await?;
    let slave_identity = sqlx::query_as::<_, MergeHistoryCustomer>(customer_identity_sql)
        .bind(slave)
        .fetch_one(&mut **tx)
        .await?;
    let actor_name: String = sqlx::query_scalar(
        "SELECT COALESCE(NULLIF(BTRIM(full_name), ''), 'Staff') FROM staff WHERE id = $1",
    )
    .bind(actor_id)
    .fetch_one(&mut **tx)
    .await?;

    let (master_note, slave_note) =
        customer_merge_history_notes(&master_identity, &slave_identity, &actor_name);

    sqlx::query(
        r#"
        INSERT INTO customer_timeline_notes (customer_id, body, created_by)
        VALUES ($1, $2, $3), ($4, $5, $3)
        "#,
    )
    .bind(master)
    .bind(master_note)
    .bind(actor_id)
    .bind(slave)
    .bind(slave_note)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

fn customer_merge_history_notes(
    master: &MergeHistoryCustomer,
    slave: &MergeHistoryCustomer,
    actor_name: &str,
) -> (String, String) {
    (
        format!(
            "Customer merge: {} ({}) was merged into this surviving account, {} ({}). Completed by {}.",
            slave.display_name,
            slave.customer_code,
            master.display_name,
            master.customer_code,
            actor_name,
        ),
        format!(
            "Customer merge: this inactive account, {} ({}), was merged into {} ({}). Completed by {}.",
            slave.display_name,
            slave.customer_code,
            master.display_name,
            master.customer_code,
            actor_name,
        ),
    )
}

async fn merge_missing_customer_profile(
    tx: &mut Transaction<'_, Postgres>,
    master: Uuid,
    slave: Uuid,
) -> Result<(), sqlx::Error> {
    let slave_email: Option<String> =
        sqlx::query_scalar("SELECT email FROM customers WHERE id = $1 FOR UPDATE")
            .bind(slave)
            .fetch_one(&mut **tx)
            .await?;

    // Email is unique. Release the duplicate row's value only when the selected
    // master needs it, then copy it in the same transaction.
    sqlx::query(
        r#"
        UPDATE customers
        SET email = NULL
        WHERE id = $2
          AND NULLIF(BTRIM($3::text), '') IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM customers AS master
              WHERE master.id = $1
                AND NULLIF(BTRIM(master.email), '') IS NULL
          )
        "#,
    )
    .bind(master)
    .bind(slave)
    .bind(slave_email.as_deref())
    .execute(&mut **tx)
    .await?;

    sqlx::query(MERGE_MISSING_PROFILE_SQL)
        .bind(master)
        .bind(slave)
        .bind(slave_email.as_deref())
        .execute(&mut **tx)
        .await?;

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

    #[test]
    fn merge_history_names_both_accounts_and_the_staff_actor() {
        let master = MergeHistoryCustomer {
            customer_code: "C-100".to_string(),
            display_name: "Alex Survivor".to_string(),
        };
        let slave = MergeHistoryCustomer {
            customer_code: "C-200".to_string(),
            display_name: "Alex Duplicate".to_string(),
        };

        let (master_note, slave_note) = customer_merge_history_notes(&master, &slave, "Chris G");

        for note in [&master_note, &slave_note] {
            assert!(note.starts_with("Customer merge:"));
            assert!(note.contains("Alex Survivor (C-100)"));
            assert!(note.contains("Alex Duplicate (C-200)"));
            assert!(note.contains("Completed by Chris G."));
        }
        assert!(master_note.contains("surviving account"));
        assert!(slave_note.contains("this inactive account"));
    }

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

    #[tokio::test]
    #[ignore = "requires an isolated migrated test database"]
    async fn merge_profile_fills_blanks_without_overwriting_master_values() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must name an isolated migrated test database");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = pool.begin().await.expect("begin test transaction");
        let master = Uuid::new_v4();
        let slave = Uuid::new_v4();
        let slave_email = format!("merge-{slave}@example.test");

        sqlx::query(
            r#"
            INSERT INTO customers (
                id, customer_code, first_name, last_name, email, phone,
                address_line1, city, state, postal_code,
                marketing_email_opt_in, is_vip, review_requests_opt_out
            ) VALUES
                ($1, $2, 'Primary', '', NULL, '555-PRIMARY', NULL, NULL, NULL, NULL, FALSE, FALSE, FALSE),
                ($3, $4, 'Duplicate', 'Person', $5, '555-DUPLICATE', '10 Main St', 'Buffalo', 'NY', '14202', TRUE, TRUE, TRUE)
            "#,
        )
        .bind(master)
        .bind(format!("TEST-{master}"))
        .bind(slave)
        .bind(format!("TEST-{slave}"))
        .bind(&slave_email)
        .execute(&mut *tx)
        .await
        .expect("insert test customers");

        merge_missing_customer_profile(&mut tx, master, slave)
            .await
            .expect("merge missing profile data");

        let merged: (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            bool,
            bool,
            bool,
        ) = sqlx::query_as(
            r#"
                SELECT first_name, last_name, email, phone, address_line1,
                       marketing_email_opt_in, is_vip, review_requests_opt_out
                FROM customers
                WHERE id = $1
                "#,
        )
        .bind(master)
        .fetch_one(&mut *tx)
        .await
        .expect("load merged profile");

        assert_eq!(merged.0, "Primary");
        assert_eq!(merged.1, "Person");
        assert_eq!(merged.2.as_deref(), Some(slave_email.as_str()));
        assert_eq!(merged.3.as_deref(), Some("555-PRIMARY"));
        assert_eq!(merged.4.as_deref(), Some("10 Main St"));
        assert!(!merged.5, "marketing consent must remain master-owned");
        assert!(
            merged.6,
            "VIP status should be preserved from either profile"
        );
        assert!(
            merged.7,
            "review opt-out must be preserved from either profile"
        );

        let retained_slave_email: Option<String> =
            sqlx::query_scalar("SELECT email FROM customers WHERE id = $1")
                .bind(slave)
                .fetch_one(&mut *tx)
                .await
                .expect("load retained duplicate email");
        assert!(retained_slave_email.is_none());

        tx.rollback().await.expect("roll back test customers");
    }
}
