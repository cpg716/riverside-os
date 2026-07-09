//! Staff account receivables and ledger.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StaffAccountError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Customer is not linked to an active staff account")]
    NotLinked,
    #[error("Staff account is not active")]
    NotActive,
    #[error("Payment exceeds current staff account balance")]
    Overpayment,
    #[error("Staff account amount must be greater than zero")]
    InvalidAmount,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StaffAccountLedgerRow {
    pub id: Uuid,
    pub entry_kind: String,
    pub amount: Decimal,
    pub balance_before: Decimal,
    pub balance_after: Decimal,
    pub transaction_id: Option<Uuid>,
    pub transaction_display_id: Option<String>,
    pub payment_transaction_id: Option<Uuid>,
    pub operator_staff_id: Option<Uuid>,
    pub operator_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StaffAccountSummary {
    pub account_id: Uuid,
    pub staff_id: Uuid,
    pub staff_name: String,
    pub customer_id: Uuid,
    pub customer_code: Option<String>,
    pub customer_name: String,
    pub status: String,
    pub current_balance: Decimal,
    pub credit_limit: Decimal,
}

#[derive(Debug, Serialize)]
pub struct StaffAccountDetail {
    #[serde(flatten)]
    pub summary: StaffAccountSummary,
    pub ledger: Vec<StaffAccountLedgerRow>,
}

pub async fn summary_for_customer(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Option<StaffAccountSummary>, sqlx::Error> {
    sqlx::query_as::<_, StaffAccountSummary>(
        r#"
        SELECT
            a.id AS account_id,
            s.id AS staff_id,
            s.full_name AS staff_name,
            c.id AS customer_id,
            NULLIF(trim(c.customer_code), '') AS customer_code,
            COALESCE(NULLIF(trim(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), ''), NULLIF(trim(c.customer_code), ''), 'Staff Customer') AS customer_name,
            a.status,
            a.current_balance,
            a.credit_limit
        FROM staff_accounts a
        INNER JOIN staff s ON s.id = a.staff_id
        INNER JOIN customers c ON c.id = a.customer_id
        WHERE a.customer_id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await
}

pub async fn detail_for_staff(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<Option<StaffAccountDetail>, sqlx::Error> {
    let summary = sqlx::query_as::<_, StaffAccountSummary>(
        r#"
        SELECT
            a.id AS account_id,
            s.id AS staff_id,
            s.full_name AS staff_name,
            c.id AS customer_id,
            NULLIF(trim(c.customer_code), '') AS customer_code,
            COALESCE(NULLIF(trim(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), ''), NULLIF(trim(c.customer_code), ''), 'Staff Customer') AS customer_name,
            a.status,
            a.current_balance,
            a.credit_limit
        FROM staff_accounts a
        INNER JOIN staff s ON s.id = a.staff_id
        INNER JOIN customers c ON c.id = a.customer_id
        WHERE a.staff_id = $1
        "#,
    )
    .bind(staff_id)
    .fetch_optional(pool)
    .await?;

    let Some(summary) = summary else {
        return Ok(None);
    };
    let ledger = ledger_for_account(pool, summary.account_id, 80).await?;
    Ok(Some(StaffAccountDetail { summary, ledger }))
}

pub async fn list_staff_accounts(pool: &PgPool) -> Result<Vec<StaffAccountSummary>, sqlx::Error> {
    sqlx::query_as::<_, StaffAccountSummary>(
        r#"
        SELECT
            a.id AS account_id,
            s.id AS staff_id,
            s.full_name AS staff_name,
            c.id AS customer_id,
            NULLIF(trim(c.customer_code), '') AS customer_code,
            COALESCE(NULLIF(trim(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), ''), NULLIF(trim(c.customer_code), ''), 'Staff Customer') AS customer_name,
            a.status,
            a.current_balance,
            a.credit_limit
        FROM staff_accounts a
        INNER JOIN staff s ON s.id = a.staff_id
        INNER JOIN customers c ON c.id = a.customer_id
        ORDER BY a.current_balance DESC, s.full_name ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn ledger_for_account(
    pool: &PgPool,
    account_id: Uuid,
    limit: i64,
) -> Result<Vec<StaffAccountLedgerRow>, sqlx::Error> {
    sqlx::query_as::<_, StaffAccountLedgerRow>(
        r#"
        SELECT
            l.id,
            l.entry_kind,
            l.amount,
            l.balance_before,
            l.balance_after,
            l.transaction_id,
            t.display_id AS transaction_display_id,
            l.payment_transaction_id,
            l.operator_staff_id,
            os.full_name AS operator_name,
            l.created_at
        FROM staff_account_ledger l
        LEFT JOIN transactions t ON t.id = l.transaction_id
        LEFT JOIN staff os ON os.id = l.operator_staff_id
        WHERE l.staff_account_id = $1
        ORDER BY l.created_at DESC
        LIMIT $2
        "#,
    )
    .bind(account_id)
    .bind(limit.clamp(1, 250))
    .fetch_all(pool)
    .await
}

async fn ensure_account_for_customer(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
) -> Result<(Uuid, String, Decimal), StaffAccountError> {
    sqlx::query(
        r#"
        INSERT INTO staff_accounts (staff_id, customer_id)
        SELECT s.id, s.employee_customer_id
        FROM staff s
        WHERE s.employee_customer_id = $1
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(customer_id)
    .execute(&mut **tx)
    .await?;

    let row: Option<(Uuid, String, Decimal)> = sqlx::query_as(
        r#"
        SELECT id, status, current_balance
        FROM staff_accounts
        WHERE customer_id = $1
        FOR UPDATE
        "#,
    )
    .bind(customer_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some(row) = row else {
        return Err(StaffAccountError::NotLinked);
    };
    if row.1 != "active" {
        return Err(StaffAccountError::NotActive);
    }
    Ok(row)
}

async fn record_entry(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    entry_kind: &str,
    amount: Decimal,
    transaction_id: Uuid,
    payment_transaction_id: Option<Uuid>,
    register_session_id: Uuid,
    operator_staff_id: Uuid,
    metadata: Value,
) -> Result<Decimal, StaffAccountError> {
    let amount = amount.round_dp(2);
    if amount.is_zero() {
        return Err(StaffAccountError::InvalidAmount);
    }
    let (account_id, _status, balance_before) =
        ensure_account_for_customer(tx, customer_id).await?;
    let balance_after = (balance_before + amount).round_dp(2);
    if balance_after < Decimal::ZERO {
        return Err(StaffAccountError::Overpayment);
    }

    sqlx::query(
        r#"
        UPDATE staff_accounts
        SET current_balance = $1, updated_at = now()
        WHERE id = $2
        "#,
    )
    .bind(balance_after)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO staff_account_ledger (
            staff_account_id, entry_kind, amount, balance_before, balance_after,
            transaction_id, payment_transaction_id, register_session_id, operator_staff_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(account_id)
    .bind(entry_kind)
    .bind(amount)
    .bind(balance_before)
    .bind(balance_after)
    .bind(transaction_id)
    .bind(payment_transaction_id)
    .bind(register_session_id)
    .bind(operator_staff_id)
    .bind(metadata)
    .execute(&mut **tx)
    .await?;

    Ok(balance_after)
}

pub async fn record_charge_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    amount: Decimal,
    transaction_id: Uuid,
    payment_transaction_id: Uuid,
    register_session_id: Uuid,
    operator_staff_id: Uuid,
    metadata: Option<&Value>,
) -> Result<Decimal, StaffAccountError> {
    if amount <= Decimal::ZERO {
        return Err(StaffAccountError::InvalidAmount);
    }
    record_entry(
        tx,
        customer_id,
        "charge",
        amount,
        transaction_id,
        Some(payment_transaction_id),
        register_session_id,
        operator_staff_id,
        metadata.cloned().unwrap_or_else(|| json!({})),
    )
    .await
}

pub async fn record_payment_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    amount: Decimal,
    transaction_id: Uuid,
    payment_transaction_id: Option<Uuid>,
    register_session_id: Uuid,
    operator_staff_id: Uuid,
    metadata: Option<&Value>,
) -> Result<Decimal, StaffAccountError> {
    if amount <= Decimal::ZERO {
        return Err(StaffAccountError::InvalidAmount);
    }
    record_entry(
        tx,
        customer_id,
        "payment",
        -amount,
        transaction_id,
        payment_transaction_id,
        register_session_id,
        operator_staff_id,
        metadata.cloned().unwrap_or_else(|| json!({})),
    )
    .await
}
