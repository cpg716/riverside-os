//! Customer-held deposits (party split credits), separate from store credit.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CustomerOpenDepositError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Customer not found")]
    NotFound,
    #[error("Insufficient open deposit balance")]
    InsufficientBalance,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CustomerOpenDepositLedgerRow {
    pub id: Uuid,
    pub amount: Decimal,
    pub balance_after: Decimal,
    pub reason: String,
    pub transaction_id: Option<Uuid>,
    pub payer_display_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CustomerOpenDepositSummary {
    pub balance: Decimal,
    pub last_payer_display_name: Option<String>,
    pub last_credit_amount: Option<Decimal>,
    pub ledger: Vec<CustomerOpenDepositLedgerRow>,
}

pub async fn fetch_summary(
    pool: &sqlx::PgPool,
    customer_id: Uuid,
) -> Result<CustomerOpenDepositSummary, sqlx::Error> {
    let bal: Option<Decimal> = sqlx::query_scalar(
        r#"
        SELECT coda.balance
        FROM customer_open_deposit_accounts coda
        WHERE coda.customer_id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;

    let balance = bal.unwrap_or(Decimal::ZERO);

    let last: Option<(Decimal, Option<String>)> = sqlx::query_as(
        r#"
        SELECT l.amount, l.payer_display_name
        FROM customer_open_deposit_ledger l
        JOIN customer_open_deposit_accounts a ON a.id = l.account_id
        WHERE a.customer_id = $1 AND l.amount > 0
        ORDER BY l.created_at DESC
        LIMIT 1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;

    let (last_credit_amount, last_payer_display_name) = match last {
        Some((amt, name)) => (Some(amt), name),
        None => (None, None),
    };

    let ledger = sqlx::query_as::<_, CustomerOpenDepositLedgerRow>(
        r#"
        SELECT l.id, l.amount, l.balance_after, l.reason, l.transaction_id, l.payer_display_name, l.created_at
        FROM customer_open_deposit_ledger l
        JOIN customer_open_deposit_accounts a ON a.id = l.account_id
        WHERE a.customer_id = $1
        ORDER BY l.created_at DESC
        LIMIT 40
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    Ok(CustomerOpenDepositSummary {
        balance,
        last_payer_display_name,
        last_credit_amount,
        ledger,
    })
}

async fn ensure_account(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO customer_open_deposit_accounts (customer_id) VALUES ($1)
        ON CONFLICT (customer_id) DO NOTHING
        "#,
    )
    .bind(customer_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query_scalar(
        "SELECT id FROM customer_open_deposit_accounts WHERE customer_id = $1 FOR UPDATE",
    )
    .bind(customer_id)
    .fetch_one(&mut **tx)
    .await
}

/// Credit when a wedding disbursement cannot attach to an open order (held until used).
pub async fn credit_party_split(
    tx: &mut Transaction<'_, Postgres>,
    beneficiary_customer_id: Uuid,
    amount: Decimal,
    payer_customer_id: Option<Uuid>,
    payer_display_name: Option<&str>,
    wedding_party_id: Option<Uuid>,
    source_transaction_id: Uuid,
) -> Result<(), CustomerOpenDepositError> {
    if amount <= Decimal::ZERO {
        return Ok(());
    }

    let account_id = ensure_account(tx, beneficiary_customer_id).await?;

    let balance: Decimal = sqlx::query_scalar(
        "SELECT balance FROM customer_open_deposit_accounts WHERE id = $1 FOR UPDATE",
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await?;

    let new_bal = balance + amount;

    sqlx::query(
        "UPDATE customer_open_deposit_accounts SET balance = $1, updated_at = now() WHERE id = $2",
    )
    .bind(new_bal)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO customer_open_deposit_ledger (
            account_id, amount, balance_after, reason, transaction_id,
            payer_customer_id, payer_display_name, wedding_party_id
        )
        VALUES ($1, $2, $3, 'party_split_deposit', $4, $5, $6, $7)
        "#,
    )
    .bind(account_id)
    .bind(amount)
    .bind(new_bal)
    .bind(source_transaction_id)
    .bind(payer_customer_id)
    .bind(payer_display_name)
    .bind(wedding_party_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn apply_checkout_redemption(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    amount: Decimal,
    transaction_id: Uuid,
) -> Result<(), CustomerOpenDepositError> {
    if amount <= Decimal::ZERO {
        return Ok(());
    }

    let account_id = ensure_account(tx, customer_id).await?;

    let row: Option<Decimal> = sqlx::query_scalar(
        "SELECT balance FROM customer_open_deposit_accounts WHERE id = $1 FOR UPDATE",
    )
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await?;

    let balance = row.ok_or(CustomerOpenDepositError::NotFound)?;
    if balance < amount {
        return Err(CustomerOpenDepositError::InsufficientBalance);
    }

    let new_bal = balance - amount;

    sqlx::query(
        "UPDATE customer_open_deposit_accounts SET balance = $1, updated_at = now() WHERE id = $2",
    )
    .bind(new_bal)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO customer_open_deposit_ledger (
            account_id, amount, balance_after, reason, transaction_id,
            payer_customer_id, payer_display_name, wedding_party_id
        )
        VALUES ($1, $2, $3, 'checkout_redemption', $4, NULL, NULL, NULL)
        "#,
    )
    .bind(account_id)
    .bind(-amount)
    .bind(new_bal)
    .bind(transaction_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
