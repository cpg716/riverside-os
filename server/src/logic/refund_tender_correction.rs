use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use thiserror::Error;
use uuid::Uuid;

use crate::auth::pins;

#[derive(Debug)]
pub struct CorrectInternalRefundTenderInput<'a> {
    pub transaction_id: Uuid,
    pub refund_event_id: Uuid,
    pub payment_transaction_id: Uuid,
    pub expected_payment_method: &'a str,
    pub payment_method: &'a str,
    pub check_number: Option<&'a str>,
    pub requesting_staff_id: Uuid,
    pub manager_staff_id: Uuid,
    pub reason: &'a str,
}

#[derive(Debug)]
pub struct CorrectInternalRefundTenderOutcome {
    pub amount: Decimal,
    pub payment_method: String,
    pub check_number: Option<String>,
    pub effective_date: NaiveDate,
    pub register_was_closed: bool,
    pub corrected_expected_cash: Option<Decimal>,
    pub preserved_actual_cash: Option<Decimal>,
    pub corrected_cash_discrepancy: Option<Decimal>,
    pub snapshot_context: Option<(Uuid, Uuid)>,
    pub daily_report_was_already_sent: bool,
}

#[derive(Debug, Error)]
pub enum RefundTenderCorrectionError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Conflict(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, FromRow)]
struct InternalRefundTenderCorrectionRow {
    payment_method: String,
    amount: Decimal,
    check_number: Option<String>,
    session_id: Option<Uuid>,
    effective_date: NaiveDate,
    payment_provider: Option<String>,
    status: String,
    customer_id: Option<Uuid>,
    till_close_group_id: Option<Uuid>,
    session_is_open: Option<bool>,
    actual_cash: Option<Decimal>,
}

pub async fn correct_internal_refund_tender(
    pool: &PgPool,
    input: CorrectInternalRefundTenderInput<'_>,
) -> Result<CorrectInternalRefundTenderOutcome, RefundTenderCorrectionError> {
    let mut tx = pool.begin().await?;
    let refund = sqlx::query_as::<_, InternalRefundTenderCorrectionRow>(
        r#"
        SELECT
            pt.payment_method,
            pt.amount::numeric(14,2) AS amount,
            pt.check_number,
            pt.session_id,
            pt.effective_date,
            pt.payment_provider,
            pt.status,
            customer_transaction.customer_id,
            register_session.till_close_group_id,
            register_session.is_open AS session_is_open,
            register_session.actual_cash
        FROM payment_transactions pt
        INNER JOIN payment_allocations allocation
            ON allocation.transaction_id = pt.id
           AND allocation.target_transaction_id = $1
        INNER JOIN transactions customer_transaction
            ON customer_transaction.id = allocation.target_transaction_id
        LEFT JOIN register_sessions register_session
            ON register_session.id = pt.session_id
        WHERE pt.id = $2
          AND pt.metadata->>'refund_event_id' = $3
          AND allocation.metadata->>'refund_event_id' = $3
        FOR UPDATE OF pt, allocation
        "#,
    )
    .bind(input.transaction_id)
    .bind(input.payment_transaction_id)
    .bind(input.refund_event_id.to_string())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        RefundTenderCorrectionError::Invalid(
            "the exact completed refund tender was not found for this refund event".to_string(),
        )
    })?;
    let current_method = refund.payment_method.trim().to_ascii_lowercase();
    if current_method != input.expected_payment_method {
        return Err(RefundTenderCorrectionError::Conflict(format!(
            "refund tender changed before correction; expected {}, found {current_method}",
            input.expected_payment_method
        )));
    }
    if refund.amount >= Decimal::ZERO
        || !matches!(
            refund.status.trim().to_ascii_lowercase().as_str(),
            "success" | "approved" | "captured"
        )
        || refund.payment_provider.is_some()
    {
        return Err(RefundTenderCorrectionError::Invalid(
            "only a successful provider-free internal refund tender can be corrected".to_string(),
        ));
    }
    let session_id = refund.session_id.ok_or_else(|| {
        RefundTenderCorrectionError::Invalid(
            "the completed refund has no Register session and cannot be corrected".to_string(),
        )
    })?;
    let allocation: Option<(Uuid, Decimal, Option<String>)> = sqlx::query_as(
        r#"
        SELECT id, amount_allocated::numeric(14,2), check_number
        FROM payment_allocations
        WHERE transaction_id = $1
          AND target_transaction_id = $2
          AND metadata->>'refund_event_id' = $3
        FOR UPDATE
        "#,
    )
    .bind(input.payment_transaction_id)
    .bind(input.transaction_id)
    .bind(input.refund_event_id.to_string())
    .fetch_optional(&mut *tx)
    .await?;
    let Some((allocation_id, allocation_amount, allocation_check_number)) = allocation else {
        return Err(RefundTenderCorrectionError::Invalid(
            "the refund tender allocation is missing; no correction was applied".to_string(),
        ));
    };
    let allocation_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM payment_allocations WHERE transaction_id = $1",
    )
    .bind(input.payment_transaction_id)
    .fetch_one(&mut *tx)
    .await?;
    if allocation_count != 1 || allocation_amount.round_dp(2) != refund.amount.round_dp(2) {
        return Err(RefundTenderCorrectionError::Invalid(
            "the refund tender allocation is not a single exact match; no correction was applied"
                .to_string(),
        ));
    }
    let locked_qbo_status: Option<String> = sqlx::query_scalar(
        r#"
        SELECT status
        FROM qbo_sync_logs
        WHERE sync_date = $1
          AND status IN ('approved', 'syncing', 'synced', 'voided')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(refund.effective_date)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(status) = locked_qbo_status {
        return Err(RefundTenderCorrectionError::Conflict(format!(
            "the {} QBO journal is {status}; correct or void that accounting entry before changing its refund tender",
            refund.effective_date
        )));
    }

    let updated_payment = sqlx::query(
        r#"
        UPDATE payment_transactions
        SET payment_method = $2,
            check_number = $3
        WHERE id = $1
          AND LOWER(TRIM(payment_method)) = $4
        "#,
    )
    .bind(input.payment_transaction_id)
    .bind(input.payment_method)
    .bind(input.check_number)
    .bind(input.expected_payment_method)
    .execute(&mut *tx)
    .await?;
    if updated_payment.rows_affected() != 1 {
        return Err(RefundTenderCorrectionError::Conflict(
            "refund tender changed before the correction could be saved".to_string(),
        ));
    }
    sqlx::query("UPDATE payment_allocations SET check_number = $2 WHERE id = $1")
        .bind(allocation_id)
        .bind(input.check_number)
        .execute(&mut *tx)
        .await?;

    let corrected_expected_cash = if let Some(till_close_group_id) = refund.till_close_group_id {
        Some(
            sqlx::query_scalar::<_, Decimal>(
                r#"
                SELECT (
                    COALESCE((
                        SELECT SUM(opening_float)
                        FROM register_sessions
                        WHERE till_close_group_id = $1
                    ), 0)
                    + COALESCE((
                        SELECT SUM(payment.amount)
                        FROM payment_transactions payment
                        WHERE payment.session_id IN (
                            SELECT id FROM register_sessions WHERE till_close_group_id = $1
                        )
                          AND LOWER(TRIM(payment.payment_method)) = 'cash'
                    ), 0)
                    + COALESCE((
                        SELECT SUM(CASE
                            WHEN adjustment.direction = 'paid_in' THEN adjustment.amount
                            ELSE -adjustment.amount
                        END)
                        FROM register_cash_adjustments adjustment
                        WHERE adjustment.session_id IN (
                            SELECT id FROM register_sessions WHERE till_close_group_id = $1
                        )
                    ), 0)
                )::numeric(14,2)
                "#,
            )
            .bind(till_close_group_id)
            .fetch_one(&mut *tx)
            .await?,
        )
    } else {
        None
    };
    let corrected_cash_discrepancy = corrected_expected_cash
        .zip(refund.actual_cash)
        .map(|(expected, actual)| (actual - expected).round_dp(2));
    let corrected_at = Utc::now();
    let correction = json!({
        "payment_transaction_id": input.payment_transaction_id,
        "allocation_id": allocation_id,
        "refund_event_id": input.refund_event_id,
        "transaction_id": input.transaction_id,
        "amount": refund.amount.abs().round_dp(2),
        "before": {
            "payment_method": current_method,
            "payment_check_number": refund.check_number,
            "allocation_check_number": allocation_check_number,
        },
        "after": {
            "payment_method": input.payment_method,
            "check_number": input.check_number,
        },
        "effective_date": refund.effective_date,
        "register_session_id": session_id,
        "register_was_closed": refund.session_is_open == Some(false),
        "corrected_expected_cash": corrected_expected_cash,
        "preserved_actual_cash": refund.actual_cash,
        "corrected_cash_discrepancy": corrected_cash_discrepancy,
        "requesting_staff_id": input.requesting_staff_id,
        "manager_staff_id": input.manager_staff_id,
        "reason": input.reason,
        "corrected_at": corrected_at,
    });
    attach_correction_metadata(
        &mut tx,
        input.payment_transaction_id,
        allocation_id,
        &correction,
    )
    .await?;
    if let Some(till_close_group_id) = refund
        .till_close_group_id
        .filter(|_| refund.session_is_open == Some(false))
    {
        append_post_close_audit(
            &mut tx,
            till_close_group_id,
            refund.effective_date,
            &correction,
        )
        .await?;
    }
    insert_transaction_activity(
        &mut tx,
        input.transaction_id,
        refund.customer_id,
        &format!(
            "Refund tender corrected from {} to {}{}",
            input.expected_payment_method,
            input.payment_method,
            input
                .check_number
                .map(|number| format!(" #{number}"))
                .unwrap_or_default()
        ),
        &correction,
    )
    .await?;
    pins::log_staff_access_once(
        &mut *tx,
        input.manager_staff_id,
        "refund_tender_corrected",
        correction,
        &format!(
            "refund-tender-correction:{}:{}:{}",
            input.payment_transaction_id, input.expected_payment_method, input.payment_method
        ),
    )
    .await?;
    let snapshot_context: Option<(Uuid, Uuid)> = sqlx::query_as(
        r#"
        SELECT till_close_group_id, primary_register_session_id
        FROM store_register_eod_snapshot
        WHERE store_local_date = $1
        "#,
    )
    .bind(refund.effective_date)
    .fetch_optional(&mut *tx)
    .await?;
    let daily_report_was_already_sent: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM daily_financial_reports
            WHERE report_date = $1
              AND is_test = FALSE
              AND sent_at IS NOT NULL
              AND send_error IS NULL
        )
        "#,
    )
    .bind(refund.effective_date)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(CorrectInternalRefundTenderOutcome {
        amount: refund.amount.abs().round_dp(2),
        payment_method: input.payment_method.to_string(),
        check_number: input.check_number.map(str::to_string),
        effective_date: refund.effective_date,
        register_was_closed: refund.session_is_open == Some(false),
        corrected_expected_cash,
        preserved_actual_cash: refund.actual_cash,
        corrected_cash_discrepancy,
        snapshot_context,
        daily_report_was_already_sent,
    })
}

async fn attach_correction_metadata(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    payment_transaction_id: Uuid,
    allocation_id: Uuid,
    correction: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE payment_transactions
        SET metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('internal_refund_tender_correction', $2::jsonb)
        WHERE id = $1
        "#,
    )
    .bind(payment_transaction_id)
    .bind(correction)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE payment_allocations
        SET metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('internal_refund_tender_correction', $2::jsonb)
        WHERE id = $1
        "#,
    )
    .bind(allocation_id)
    .bind(correction)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn append_post_close_audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    till_close_group_id: Uuid,
    effective_date: NaiveDate,
    correction: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE register_sessions
        SET z_report_json = jsonb_set(
            COALESCE(z_report_json, '{}'::jsonb),
            '{post_close_tender_corrections}',
            COALESCE(z_report_json->'post_close_tender_corrections', '[]'::jsonb)
                || jsonb_build_array($2::jsonb),
            true
        )
        WHERE till_close_group_id = $1
          AND is_open = FALSE
        "#,
    )
    .bind(till_close_group_id)
    .bind(correction)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE register_business_day_z_reports
        SET z_report_json = jsonb_set(
            COALESCE(z_report_json, '{}'::jsonb),
            '{post_close_tender_corrections}',
            COALESCE(z_report_json->'post_close_tender_corrections', '[]'::jsonb)
                || jsonb_build_array($3::jsonb),
            true
        )
        WHERE till_close_group_id = $1
          AND business_date = $2
        "#,
    )
    .bind(till_close_group_id)
    .bind(effective_date)
    .bind(correction)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_transaction_activity(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    summary: &str,
    correction: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (
            transaction_id, customer_id, event_kind, summary, metadata
        )
        VALUES ($1, $2, 'refund_tender_corrected', $3, $4)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(summary)
    .bind(correction)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
