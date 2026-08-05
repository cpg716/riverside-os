use chrono::Utc;
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    auth::pins, logic::transaction_recalc::recalc_transaction_totals, models::DbTransactionCategory,
};

pub const BLOCKED_EXCHANGE_REPAIR_CONFIRMATION: &str = "UNWIND BLOCKED EXCHANGE CREDIT";

#[derive(Debug, Serialize)]
pub struct BlockedExchangeRepairPreview {
    pub client_job_key: String,
    pub original_transaction_id: Uuid,
    pub original_display_id: String,
    pub replacement_transaction_id: Uuid,
    pub replacement_display_id: String,
    pub exchange_credit_amount: Decimal,
    pub amount_paid_before: Decimal,
    pub amount_paid_after: Decimal,
    pub balance_due_before: Decimal,
    pub balance_due_after: Decimal,
    pub ready: bool,
    pub already_applied: bool,
    pub blockers: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BlockedExchangeRepairResult {
    pub client_job_key: String,
    pub original_transaction_id: Uuid,
    pub replacement_transaction_id: Uuid,
    pub correction_payment_id: Uuid,
    pub amount_paid_after: Decimal,
    pub balance_due_after: Decimal,
}

fn payload_uuid(payload: &Value, key: &str) -> Option<Uuid> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
}

fn payload_decimal(payload: &Value, key: &str) -> Option<Decimal> {
    payload
        .get(key)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

async fn preview_locked(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    client_job_key: &str,
) -> Result<BlockedExchangeRepairPreview, sqlx::Error> {
    let job = sqlx::query(
        r#"
        SELECT status, transaction_id, checkout_client_id, payload
        FROM operational_recovery_job
        WHERE client_job_key = $1 AND kind = 'exchange_settlement'
        FOR UPDATE
        "#,
    )
    .bind(client_job_key)
    .fetch_optional(&mut **tx)
    .await?;

    let Some(job) = job else {
        return Ok(BlockedExchangeRepairPreview {
            client_job_key: client_job_key.to_string(),
            original_transaction_id: Uuid::nil(),
            original_display_id: String::new(),
            replacement_transaction_id: Uuid::nil(),
            replacement_display_id: String::new(),
            exchange_credit_amount: Decimal::ZERO,
            amount_paid_before: Decimal::ZERO,
            amount_paid_after: Decimal::ZERO,
            balance_due_before: Decimal::ZERO,
            balance_due_after: Decimal::ZERO,
            ready: false,
            already_applied: false,
            blockers: vec!["exchange recovery job was not found".to_string()],
        });
    };

    let status: String = job.get("status");
    let replacement_job_id: Option<Uuid> = job.get("transaction_id");
    let checkout_client_id: Option<Uuid> = job.get("checkout_client_id");
    let payload: Value = job.get("payload");
    let original_transaction_id =
        payload_uuid(&payload, "original_transaction_id").unwrap_or_else(Uuid::nil);
    let replacement_transaction_id = payload_uuid(&payload, "replacement_transaction_id")
        .or(replacement_job_id)
        .unwrap_or_else(Uuid::nil);
    let exchange_credit_amount = payload_decimal(&payload, "exchange_credit_amount")
        .unwrap_or(Decimal::ZERO)
        .round_dp(2);
    let mut blockers = Vec::new();

    if !matches!(status.as_str(), "blocked" | "resolved") {
        blockers.push(format!("exchange recovery has unsupported status {status}"));
    }
    if original_transaction_id.is_nil() || replacement_transaction_id.is_nil() {
        blockers.push("exchange recovery transaction identity is incomplete".to_string());
    }
    if exchange_credit_amount <= Decimal::ZERO {
        blockers.push("exchange recovery has no positive exchange credit to unwind".to_string());
    }

    let original = sqlx::query(
        r#"
        SELECT COALESCE(NULLIF(TRIM(display_id), ''), id::text) AS display_id,
               COALESCE(total_price, 0)::numeric(14,2) AS total_price,
               COALESCE(amount_paid, 0)::numeric(14,2) AS amount_paid,
               COALESCE(balance_due, 0)::numeric(14,2) AS balance_due,
               customer_id
        FROM transactions WHERE id = $1 FOR UPDATE
        "#,
    )
    .bind(original_transaction_id)
    .fetch_optional(&mut **tx)
    .await?;
    let replacement = sqlx::query(
        r#"
        SELECT COALESCE(NULLIF(TRIM(display_id), ''), id::text) AS display_id,
               status::text AS status,
               COALESCE(total_price, 0)::numeric(14,2) AS total_price,
               COALESCE(amount_paid, 0)::numeric(14,2) AS amount_paid,
               checkout_client_id
        FROM transactions WHERE id = $1 FOR UPDATE
        "#,
    )
    .bind(replacement_transaction_id)
    .fetch_optional(&mut **tx)
    .await?;

    let (original_display_id, total_price, amount_paid, balance_due) = match original {
        Some(row) => (
            row.get::<String, _>("display_id"),
            row.get::<Decimal, _>("total_price"),
            row.get::<Decimal, _>("amount_paid"),
            row.get::<Decimal, _>("balance_due"),
        ),
        None => {
            blockers.push("original Transaction Record was not found".to_string());
            (String::new(), Decimal::ZERO, Decimal::ZERO, Decimal::ZERO)
        }
    };
    let replacement_display_id = match replacement {
        Some(row) => {
            if row.get::<Decimal, _>("total_price") != Decimal::ZERO
                || row.get::<Decimal, _>("amount_paid") != Decimal::ZERO
            {
                blockers.push(
                    "replacement Transaction Record is not an empty exchange artifact".to_string(),
                );
            }
            if row.get::<Option<Uuid>, _>("checkout_client_id") != checkout_client_id {
                blockers.push("replacement checkout identity does not match recovery".to_string());
            }
            row.get::<String, _>("display_id")
        }
        None => {
            blockers.push("replacement Transaction Record was not found".to_string());
            String::new()
        }
    };

    let existing_correction: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM payment_transactions
        WHERE metadata->>'kind' = 'blocked_exchange_credit_unwind'
          AND metadata->>'client_job_key' = $1
        LIMIT 1
        "#,
    )
    .bind(client_job_key)
    .fetch_optional(&mut **tx)
    .await?;
    let already_applied = existing_correction.is_some();

    let source_credit_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pt.payment_method = 'exchange_credit'
          AND pt.status = 'success'
          AND pt.amount = $1
          AND pa.amount_allocated = $1
          AND pa.target_transaction_id = $2
          AND pt.metadata->>'checkout_transaction_id' = $3
          AND pt.metadata->>'original_transaction_id' = $2::text
        "#,
    )
    .bind(exchange_credit_amount)
    .bind(original_transaction_id)
    .bind(replacement_transaction_id.to_string())
    .fetch_one(&mut **tx)
    .await?;
    if source_credit_count != 1 && !already_applied {
        blockers.push(format!(
            "expected one exact exchange-credit allocation, found {source_credit_count}"
        ));
    }

    let exchange_settled: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM transaction_activity_log
            WHERE transaction_id = $1
              AND event_kind = 'exchange_settled'
              AND metadata->>'replacement_transaction_id' = $2
        )
        "#,
    )
    .bind(original_transaction_id)
    .bind(replacement_transaction_id.to_string())
    .fetch_one(&mut **tx)
    .await?;
    if exchange_settled {
        blockers.push("exchange settlement is already complete".to_string());
    }

    let amount_paid_after = (amount_paid - exchange_credit_amount).round_dp(2);
    let balance_due_after = (total_price - amount_paid_after).round_dp(2);
    if amount_paid_after < Decimal::ZERO || balance_due_after < Decimal::ZERO {
        blockers.push("unwind would create an invalid paid or balance amount".to_string());
    }

    Ok(BlockedExchangeRepairPreview {
        client_job_key: client_job_key.to_string(),
        original_transaction_id,
        original_display_id,
        replacement_transaction_id,
        replacement_display_id,
        exchange_credit_amount,
        amount_paid_before: amount_paid,
        amount_paid_after,
        balance_due_before: balance_due,
        balance_due_after,
        ready: blockers.is_empty() && !already_applied,
        already_applied,
        blockers,
    })
}

pub async fn preview_blocked_exchange_repair(
    pool: &PgPool,
    client_job_key: &str,
) -> Result<BlockedExchangeRepairPreview, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let preview = preview_locked(&mut tx, client_job_key).await?;
    tx.rollback().await?;
    Ok(preview)
}

pub async fn apply_blocked_exchange_repair(
    pool: &PgPool,
    client_job_key: &str,
    staff_id: Uuid,
    confirmation: &str,
    reason: &str,
) -> Result<BlockedExchangeRepairResult, String> {
    if confirmation != BLOCKED_EXCHANGE_REPAIR_CONFIRMATION {
        return Err("exact repair confirmation phrase is required".to_string());
    }
    if reason.trim().len() < 12 {
        return Err("specific repair reason of at least 12 characters is required".to_string());
    }

    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    let authorized: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1 AND is_active AND role::text IN ('admin', 'manager'))",
    )
    .bind(staff_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    if !authorized {
        return Err("repair staff member is not an active Manager or Admin".to_string());
    }

    let preview = preview_locked(&mut tx, client_job_key)
        .await
        .map_err(|error| error.to_string())?;
    if preview.already_applied {
        return Err("blocked exchange credit was already unwound".to_string());
    }
    if !preview.ready {
        return Err(format!(
            "repair is blocked: {}",
            preview.blockers.join("; ")
        ));
    }

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(preview.original_transaction_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    let correction_payment_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_transactions (
            payer_id, category, payment_method, amount, status, effective_date, metadata
        )
        VALUES (
            $1, $2, 'exchange_credit', $3, 'success',
            (CURRENT_TIMESTAMP AT TIME ZONE reporting.effective_store_timezone())::date,
            $4
        )
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(DbTransactionCategory::RetailSale)
    .bind(-preview.exchange_credit_amount)
    .bind(json!({
        "kind": "blocked_exchange_credit_unwind",
        "client_job_key": client_job_key,
        "original_transaction_id": preview.original_transaction_id,
        "replacement_transaction_id": preview.replacement_transaction_id,
        "reason": reason.trim(),
        "corrected_by_staff_id": staff_id,
    }))
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        r#"
        INSERT INTO payment_allocations (
            transaction_id, target_transaction_id, amount_allocated, metadata
        ) VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(correction_payment_id)
    .bind(preview.original_transaction_id)
    .bind(-preview.exchange_credit_amount)
    .bind(json!({
        "kind": "blocked_exchange_credit_unwind",
        "client_job_key": client_job_key,
        "replacement_transaction_id": preview.replacement_transaction_id,
    }))
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    sqlx::query("UPDATE transactions SET amount_paid = $2 WHERE id = $1")
        .bind(preview.original_transaction_id)
        .bind(preview.amount_paid_after)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    recalc_transaction_totals(&mut tx, preview.original_transaction_id)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE transactions SET status = 'cancelled'::order_status WHERE id = $1 AND total_price = 0 AND amount_paid = 0",
    )
    .bind(preview.replacement_transaction_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        r#"
        UPDATE operational_recovery_job
        SET status = 'resolved', resolved_at = now(), resolved_by_staff_id = $2,
            resolution_note = $3, last_seen_at = now()
        WHERE client_job_key = $1 AND status = 'blocked'
        "#,
    )
    .bind(client_job_key)
    .bind(staff_id)
    .bind(reason.trim())
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;

    let audit = json!({
        "client_job_key": client_job_key,
        "original_transaction_id": preview.original_transaction_id,
        "replacement_transaction_id": preview.replacement_transaction_id,
        "correction_payment_id": correction_payment_id,
        "exchange_credit_amount": preview.exchange_credit_amount,
        "amount_paid_before": preview.amount_paid_before,
        "amount_paid_after": preview.amount_paid_after,
        "balance_due_before": preview.balance_due_before,
        "balance_due_after": preview.balance_due_after,
        "reason": reason.trim(),
        "corrected_at": Utc::now(),
    });
    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (
            transaction_id, customer_id, event_kind, summary, metadata
        ) VALUES ($1, $2, 'blocked_exchange_credit_unwound', $3, $4)
        "#,
    )
    .bind(preview.original_transaction_id)
    .bind(customer_id)
    .bind(format!(
        "Unwound ${} from a blocked exchange; ${} remains due",
        preview.exchange_credit_amount, preview.balance_due_after
    ))
    .bind(&audit)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    pins::log_staff_access_once(
        &mut *tx,
        staff_id,
        "blocked_exchange_credit_unwound",
        audit,
        &format!("blocked-exchange-credit-unwind:{client_job_key}"),
    )
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;

    Ok(BlockedExchangeRepairResult {
        client_job_key: client_job_key.to_string(),
        original_transaction_id: preview.original_transaction_id,
        replacement_transaction_id: preview.replacement_transaction_id,
        correction_payment_id,
        amount_paid_after: preview.amount_paid_after,
        balance_due_after: preview.balance_due_after,
    })
}
