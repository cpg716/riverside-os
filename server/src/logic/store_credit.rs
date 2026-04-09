//! Store credit accounts and ledger (separate from gift cards).

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StoreCreditError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Customer not found")]
    NotFound,
    #[error("Insufficient store credit balance")]
    InsufficientBalance,
    #[error("Reason is required for store credit adjustments")]
    ReasonRequired,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StoreCreditLedgerRow {
    pub id: Uuid,
    pub amount: Decimal,
    pub balance_after: Decimal,
    pub reason: String,
    pub order_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct StoreCreditSummary {
    pub balance: Decimal,
    pub ledger: Vec<StoreCreditLedgerRow>,
}

pub async fn fetch_summary(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<StoreCreditSummary, sqlx::Error> {
    let bal: Option<Decimal> = sqlx::query_scalar(
        r#"
        SELECT sca.balance
        FROM store_credit_accounts sca
        WHERE sca.customer_id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;

    let balance = bal.unwrap_or(Decimal::ZERO);

    let ledger = sqlx::query_as::<_, StoreCreditLedgerRow>(
        r#"
        SELECT l.id, l.amount, l.balance_after, l.reason, l.order_id, l.created_at
        FROM store_credit_ledger l
        JOIN store_credit_accounts a ON a.id = l.account_id
        WHERE a.customer_id = $1
        ORDER BY l.created_at DESC
        LIMIT 40
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    Ok(StoreCreditSummary { balance, ledger })
}

/// Ensures account row exists; returns account id.
async fn ensure_account(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO store_credit_accounts (customer_id) VALUES ($1)
        ON CONFLICT (customer_id) DO NOTHING
        "#,
    )
    .bind(customer_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query_scalar("SELECT id FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE")
        .bind(customer_id)
        .fetch_one(&mut **tx)
        .await
}

pub async fn apply_checkout_redemption(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    amount: Decimal,
    order_id: Uuid,
) -> Result<(), StoreCreditError> {
    if amount <= Decimal::ZERO {
        return Ok(());
    }

    let account_id = ensure_account(tx, customer_id).await?;

    let row: Option<Decimal> =
        sqlx::query_scalar("SELECT balance FROM store_credit_accounts WHERE id = $1 FOR UPDATE")
            .bind(account_id)
            .fetch_optional(&mut **tx)
            .await?;

    let balance = row.ok_or(StoreCreditError::NotFound)?;
    if balance < amount {
        return Err(StoreCreditError::InsufficientBalance);
    }

    let new_bal = balance - amount;

    sqlx::query("UPDATE store_credit_accounts SET balance = $1, updated_at = now() WHERE id = $2")
        .bind(new_bal)
        .bind(account_id)
        .execute(&mut **tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO store_credit_ledger (account_id, amount, balance_after, reason, order_id)
        VALUES ($1, $2, $3, 'checkout_redemption', $4)
        "#,
    )
    .bind(account_id)
    .bind(-amount)
    .bind(new_bal)
    .bind(order_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn adjust_balance(
    pool: &PgPool,
    customer_id: Uuid,
    amount: Decimal,
    reason: &str,
) -> Result<Decimal, StoreCreditError> {
    if amount == Decimal::ZERO {
        return fetch_summary(pool, customer_id)
            .await
            .map(|s| s.balance)
            .map_err(Into::into);
    }

    let reason = reason.trim();
    if reason.is_empty() {
        return Err(StoreCreditError::ReasonRequired);
    }

    let mut tx = pool.begin().await?;

    let account_id = ensure_account(&mut tx, customer_id).await?;

    let balance: Decimal =
        sqlx::query_scalar("SELECT balance FROM store_credit_accounts WHERE id = $1 FOR UPDATE")
            .bind(account_id)
            .fetch_one(&mut *tx)
            .await?;

    let new_bal = balance + amount;
    if new_bal < Decimal::ZERO {
        return Err(StoreCreditError::InsufficientBalance);
    }

    sqlx::query("UPDATE store_credit_accounts SET balance = $1, updated_at = now() WHERE id = $2")
        .bind(new_bal)
        .bind(account_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO store_credit_ledger (account_id, amount, balance_after, reason, order_id)
        VALUES ($1, $2, $3, $4, NULL)
        "#,
    )
    .bind(account_id)
    .bind(amount)
    .bind(new_bal)
    .bind(reason)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(new_bal)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CounterpointOpeningBalanceOutcome {
    Applied,
    SkippedNonPositive,
    SkippedAlreadyImported,
}

/// One-time Counterpoint import: set opening balance and a single ledger row (`counterpoint_opening_balance`).
pub async fn apply_counterpoint_opening_balance(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    balance: Decimal,
) -> Result<CounterpointOpeningBalanceOutcome, StoreCreditError> {
    if balance <= Decimal::ZERO {
        return Ok(CounterpointOpeningBalanceOutcome::SkippedNonPositive);
    }

    let already: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM store_credit_ledger l
            JOIN store_credit_accounts a ON a.id = l.account_id
            WHERE a.customer_id = $1
              AND l.reason = 'counterpoint_opening_balance'
        )
        "#,
    )
    .bind(customer_id)
    .fetch_one(&mut **tx)
    .await?;

    if already {
        return Ok(CounterpointOpeningBalanceOutcome::SkippedAlreadyImported);
    }

    let account_id = ensure_account(tx, customer_id).await?;

    sqlx::query("UPDATE store_credit_accounts SET balance = $1, updated_at = now() WHERE id = $2")
        .bind(balance)
        .bind(account_id)
        .execute(&mut **tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO store_credit_ledger (account_id, amount, balance_after, reason, order_id)
        VALUES ($1, $2, $3, 'counterpoint_opening_balance', NULL)
        "#,
    )
    .bind(account_id)
    .bind(balance)
    .bind(balance)
    .execute(&mut **tx)
    .await?;

    Ok(CounterpointOpeningBalanceOutcome::Applied)
}
