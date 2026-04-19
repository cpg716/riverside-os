//! RMS / RMS90 register tenders + R2S payment collection: durable rows and Sales Support follow-up.

use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{Executor, PgPool, Postgres};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RmsChargeNotify {
    pub payment_transaction_id: Uuid,
    pub amount: Decimal,
    pub method: String,
}

pub fn is_rms_method(method: &str) -> bool {
    let m = method.trim().to_ascii_lowercase();
    m == "on_account_rms" || m == "on_account_rms90"
}

pub fn transaction_compact_ref(transaction_id: Uuid) -> String {
    transaction_id
        .as_simple()
        .to_string()
        .chars()
        .take(12)
        .collect()
}

/// `record_kind`: `charge` (sale tender) or `payment` (cash/check R2S collection).
#[allow(clippy::too_many_arguments)]
pub async fn insert_rms_record<'e, E>(
    ex: E,
    record_kind: &str,
    transaction_id: Uuid,
    register_session_id: Uuid,
    customer_id: Option<Uuid>,
    payment_method: &str,
    amount: Decimal,
    operator_staff_id: Uuid,
    payment_transaction_id: Uuid,
    customer_display: Option<&str>,
    order_short_ref: &str,
) -> Result<(), sqlx::Error>
where
    E: Executor<'e, Database = Postgres>,
{
    sqlx::query(
        r#"
        INSERT INTO pos_rms_charge_record (
            transaction_id, register_session_id, customer_id, payment_method, amount,
            operator_staff_id, payment_transaction_id, customer_display, order_short_ref,
            record_kind
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(transaction_id)
    .bind(register_session_id)
    .bind(customer_id)
    .bind(payment_method)
    .bind(amount)
    .bind(operator_staff_id)
    .bind(payment_transaction_id)
    .bind(customer_display)
    .bind(order_short_ref)
    .bind(record_kind)
    .execute(ex)
    .await?;
    Ok(())
}

/// Fan-out one inbox notification per Sales Support staff member per RMS split (deduped per payment tx).
#[allow(clippy::too_many_arguments)]
pub async fn notify_sales_support_after_checkout(
    pool: &PgPool,
    transaction_id: Uuid,
    register_session_id: Uuid,
    customer_id: Option<Uuid>,
    customer_display: Option<&str>,
    order_short_ref: &str,
    operator_staff_id: Uuid,
    charges: &[RmsChargeNotify],
) -> Result<(), sqlx::Error> {
    if charges.is_empty() {
        return Ok(());
    }

    let staff_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM staff
        WHERE is_active = TRUE AND role = 'sales_support'::staff_role
        "#,
    )
    .fetch_all(pool)
    .await?;

    if staff_ids.is_empty() {
        tracing::warn!("no active sales_support staff for RMS charge notifications");
        return Ok(());
    }

    let cust_label = customer_display
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Walk-in / no customer".to_string());

    for c in charges {
        let method_label = if c.method.eq_ignore_ascii_case("on_account_rms90") {
            "RMS90 Plan"
        } else {
            "RMS Charge"
        };
        let body = format!(
            "Submit R2S charge in portal. Order ref: {}. Method: {}. Amount: ${}. Customer: {}. Transaction: {}.",
            order_short_ref,
            method_label,
            c.amount,
            cust_label,
            c.payment_transaction_id
        );
        let deep = json!({
            "kind": "rms_r2s_charge",
            "transaction_id": transaction_id,
            "register_session_id": register_session_id,
            "customer_id": customer_id,
            "payment_transaction_id": c.payment_transaction_id,
            "payment_method": c.method,
            "amount": c.amount.to_string(),
        });
        let dedupe = format!("rms_r2s:{}:{}", transaction_id, c.payment_transaction_id);
        let audience = json!({ "roles": ["sales_support"] });

        let nid = match crate::logic::notifications::insert_app_notification_deduped(
            pool,
            "rms_r2s_charge",
            "Submit R2S charge",
            &body,
            deep,
            "pos_checkout",
            audience,
            Some(&dedupe),
        )
        .await?
        {
            Some(id) => id,
            None => continue,
        };

        crate::logic::notifications::fan_out_to_staff_ids(pool, nid, &staff_ids).await?;
    }

    let _ = crate::auth::pins::log_staff_access(
        pool,
        operator_staff_id,
        "rms_charge_notified",
        json!({
            "transaction_id": transaction_id,
            "register_session_id": register_session_id,
            "charge_count": charges.len(),
        }),
    )
    .await;

    Ok(())
}
