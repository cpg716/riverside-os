//! Customer-held deposits (party split credits), separate from store credit.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use std::collections::HashMap;
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
    #[error("A source-tracked wedding deposit must name its exact source")]
    SourceRequired,
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
    pub workflow_sources: Vec<CustomerOpenDepositWorkflowSource>,
    pub ledger: Vec<CustomerOpenDepositLedgerRow>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CustomerOpenDepositWorkflowSource {
    pub workflow_id: Uuid,
    pub workflow_allocation_id: Uuid,
    pub source_credit_ledger_id: Uuid,
    pub wedding_party_id: Uuid,
    pub party_name: String,
    pub payer_display_name: Option<String>,
    pub original_amount: Decimal,
    pub remaining_amount: Decimal,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy)]
pub struct OpenDepositSourceChunk {
    pub source_payment_transaction_id: Uuid,
    pub amount: Decimal,
}

#[derive(Debug, Clone, Copy)]
pub enum OpenDepositRestoreReason {
    TransactionVoid,
    TransactionCancel,
}

impl OpenDepositRestoreReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::TransactionVoid => "transaction_void_reversal",
            Self::TransactionCancel => "transaction_cancel_reversal",
        }
    }
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
        WHERE a.customer_id = $1
          AND l.amount > 0
          AND l.reason = 'party_split_deposit'
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

    let workflow_sources = sqlx::query_as::<_, CustomerOpenDepositWorkflowSource>(
        r#"
        SELECT
            workflow.id AS workflow_id,
            allocation.id AS workflow_allocation_id,
            credit.id AS source_credit_ledger_id,
            workflow.wedding_party_id,
            COALESCE(NULLIF(TRIM(party.party_name), ''), NULLIF(TRIM(party.groom_name), ''), 'Wedding party') AS party_name,
            credit.payer_display_name,
            allocation.amount AS original_amount,
            ROUND(
                allocation.amount
                - COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'redemption'), 0)
                + COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'restoration'), 0),
                2
            )::numeric(14,2) AS remaining_amount,
            allocation.created_at
        FROM wedding_deposit_workflow_allocations allocation
        INNER JOIN wedding_deposit_workflows workflow ON workflow.id = allocation.workflow_id
        INNER JOIN customer_open_deposit_ledger credit ON credit.id = allocation.held_credit_ledger_id
        INNER JOIN customer_open_deposit_accounts account ON account.id = credit.account_id
        INNER JOIN wedding_parties party ON party.id = workflow.wedding_party_id
        LEFT JOIN customer_open_deposit_source_events source_event
            ON source_event.source_credit_ledger_id = credit.id
        WHERE account.customer_id = $1
          AND allocation.destination_kind = 'held_for_future_order'
          AND workflow.status <> 'voided'
        GROUP BY
            workflow.id,
            allocation.id,
            credit.id,
            workflow.wedding_party_id,
            party.party_name,
            party.groom_name,
            credit.payer_display_name,
            allocation.amount,
            allocation.created_at
        HAVING ROUND(
            allocation.amount
            - COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'redemption'), 0)
            + COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'restoration'), 0),
            2
        ) > 0
        ORDER BY allocation.created_at, allocation.id
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    Ok(CustomerOpenDepositSummary {
        balance,
        last_payer_display_name,
        last_credit_amount,
        workflow_sources,
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
    credit_party_split_with_sources(
        tx,
        beneficiary_customer_id,
        amount,
        payer_customer_id,
        payer_display_name,
        wedding_party_id,
        source_transaction_id,
        &[],
        None,
        None,
    )
    .await
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub async fn credit_party_split_with_sources(
    tx: &mut Transaction<'_, Postgres>,
    beneficiary_customer_id: Uuid,
    amount: Decimal,
    payer_customer_id: Option<Uuid>,
    payer_display_name: Option<&str>,
    wedding_party_id: Option<Uuid>,
    source_transaction_id: Uuid,
    source_chunks: &[OpenDepositSourceChunk],
    payer_wedding_member_id: Option<Uuid>,
    beneficiary_wedding_member_id: Option<Uuid>,
) -> Result<Uuid, CustomerOpenDepositError> {
    if amount <= Decimal::ZERO {
        return Ok(Uuid::nil());
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

    let ledger_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO customer_open_deposit_ledger (
            account_id, amount, balance_after, reason, transaction_id,
            payer_customer_id, payer_display_name, wedding_party_id
        )
        VALUES ($1, $2, $3, 'party_split_deposit', $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(account_id)
    .bind(amount)
    .bind(new_bal)
    .bind(source_transaction_id)
    .bind(payer_customer_id)
    .bind(payer_display_name)
    .bind(wedding_party_id)
    .fetch_one(&mut **tx)
    .await?;

    for chunk in source_chunks {
        sqlx::query(
            r#"
            INSERT INTO customer_open_deposit_ledger_sources (
                ledger_id, source_payment_transaction_id, amount,
                payer_wedding_member_id, beneficiary_wedding_member_id
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(ledger_id)
        .bind(chunk.source_payment_transaction_id)
        .bind(chunk.amount)
        .bind(payer_wedding_member_id)
        .bind(beneficiary_wedding_member_id)
        .execute(&mut **tx)
        .await?;
    }

    Ok(ledger_id)
}

pub async fn apply_checkout_redemption(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    amount: Decimal,
    transaction_id: Uuid,
    source_credit_ledger_id: Option<Uuid>,
) -> Result<Uuid, CustomerOpenDepositError> {
    if amount <= Decimal::ZERO {
        return Ok(Uuid::nil());
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

    if source_credit_ledger_id.is_none() {
        let tracked_source_available: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM wedding_deposit_workflow_allocations allocation
                INNER JOIN wedding_deposit_workflows workflow
                    ON workflow.id = allocation.workflow_id
                INNER JOIN customer_open_deposit_ledger credit
                    ON credit.id = allocation.held_credit_ledger_id
                INNER JOIN customer_open_deposit_accounts account
                    ON account.id = credit.account_id
                WHERE account.customer_id = $1
                  AND allocation.destination_kind = 'held_for_future_order'
                  AND workflow.status <> 'voided'
                  AND allocation.amount > COALESCE((
                      SELECT
                          COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'redemption'), 0)
                          - COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'restoration'), 0)
                      FROM customer_open_deposit_source_events source_event
                      WHERE source_event.source_credit_ledger_id = credit.id
                  ), 0)
            )
            "#,
        )
        .bind(customer_id)
        .fetch_one(&mut **tx)
        .await?;
        if tracked_source_available {
            return Err(CustomerOpenDepositError::SourceRequired);
        }
    }

    if let Some(source_credit_ledger_id) = source_credit_ledger_id {
        let source_locked: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM customer_open_deposit_ledger WHERE id = $1 FOR UPDATE",
        )
        .bind(source_credit_ledger_id)
        .fetch_optional(&mut **tx)
        .await?;
        if source_locked.is_none() {
            return Err(CustomerOpenDepositError::NotFound);
        }
        let source_remaining: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT ROUND(
                allocation.amount
                - COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'redemption'), 0)
                + COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'restoration'), 0),
                2
            )::numeric(14,2)
            FROM wedding_deposit_workflow_allocations allocation
            INNER JOIN customer_open_deposit_ledger credit ON credit.id = allocation.held_credit_ledger_id
            INNER JOIN customer_open_deposit_accounts account ON account.id = credit.account_id
            LEFT JOIN customer_open_deposit_source_events source_event
                ON source_event.source_credit_ledger_id = credit.id
            WHERE credit.id = $1
              AND account.customer_id = $2
              AND allocation.destination_kind = 'held_for_future_order'
            GROUP BY allocation.id, allocation.amount
            "#,
        )
        .bind(source_credit_ledger_id)
        .bind(customer_id)
        .fetch_optional(&mut **tx)
        .await?;
        if source_remaining.is_none_or(|remaining| remaining < amount) {
            return Err(CustomerOpenDepositError::InsufficientBalance);
        }
    }

    let new_bal = balance - amount;

    sqlx::query(
        "UPDATE customer_open_deposit_accounts SET balance = $1, updated_at = now() WHERE id = $2",
    )
    .bind(new_bal)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;

    let redemption_ledger_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO customer_open_deposit_ledger (
            account_id, amount, balance_after, reason, transaction_id,
            payer_customer_id, payer_display_name, wedding_party_id
        )
        VALUES ($1, $2, $3, 'checkout_redemption', $4, NULL, NULL, NULL)
        RETURNING id
        "#,
    )
    .bind(account_id)
    .bind(-amount)
    .bind(new_bal)
    .bind(transaction_id)
    .fetch_one(&mut **tx)
    .await?;

    if let Some(source_credit_ledger_id) = source_credit_ledger_id {
        let source_event_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO customer_open_deposit_source_events (
                source_credit_ledger_id, ledger_event_id, event_kind, amount
            )
            VALUES ($1, $2, 'redemption', $3)
            RETURNING id
            "#,
        )
        .bind(source_credit_ledger_id)
        .bind(redemption_ledger_id)
        .bind(amount)
        .fetch_one(&mut **tx)
        .await?;

        let payment_sources = sqlx::query_as::<_, (Uuid, Decimal)>(
            r#"
            SELECT
                sources.source_payment_transaction_id,
                ROUND(
                    SUM(sources.amount)
                    - COALESCE((
                        SELECT SUM(
                            CASE source_event.event_kind
                                WHEN 'redemption' THEN event_payment.amount
                                ELSE -event_payment.amount
                            END
                        )
                        FROM customer_open_deposit_source_event_payments event_payment
                        INNER JOIN customer_open_deposit_source_events source_event
                            ON source_event.id = event_payment.source_event_id
                        WHERE source_event.source_credit_ledger_id = $1
                          AND event_payment.source_payment_transaction_id = sources.source_payment_transaction_id
                    ), 0),
                    2
                )::numeric(14,2) AS remaining_amount
            FROM customer_open_deposit_ledger_sources sources
            WHERE sources.ledger_id = $1
            GROUP BY sources.source_payment_transaction_id
            ORDER BY (ARRAY_AGG(sources.id ORDER BY sources.id))[1]
            "#,
        )
        .bind(source_credit_ledger_id)
        .fetch_all(&mut **tx)
        .await?;
        let mut source_amount_remaining = amount;
        for (source_payment_transaction_id, available) in payment_sources {
            if source_amount_remaining <= Decimal::ZERO {
                break;
            }
            let chunk = available.max(Decimal::ZERO).min(source_amount_remaining);
            if chunk <= Decimal::ZERO {
                continue;
            }
            sqlx::query(
                r#"
                INSERT INTO customer_open_deposit_source_event_payments (
                    source_event_id, source_payment_transaction_id, amount
                )
                VALUES ($1, $2, $3)
                "#,
            )
            .bind(source_event_id)
            .bind(source_payment_transaction_id)
            .bind(chunk)
            .execute(&mut **tx)
            .await?;
            source_amount_remaining = (source_amount_remaining - chunk).round_dp(2);
        }
        if source_amount_remaining > Decimal::ZERO {
            return Err(CustomerOpenDepositError::InsufficientBalance);
        }

        sqlx::query(
            r#"
            UPDATE wedding_deposit_workflows workflow
            SET status = CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM wedding_deposit_workflow_allocations allocation
                        INNER JOIN customer_open_deposit_ledger credit
                            ON credit.id = allocation.held_credit_ledger_id
                        LEFT JOIN customer_open_deposit_source_events source_event
                            ON source_event.source_credit_ledger_id = credit.id
                        WHERE allocation.workflow_id = workflow.id
                          AND allocation.destination_kind = 'held_for_future_order'
                        GROUP BY allocation.id, allocation.amount
                        HAVING allocation.amount
                            - COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'redemption'), 0)
                            + COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'restoration'), 0) > 0
                    ) THEN 'partially_ordered'
                    ELSE 'complete'
                END,
                updated_at = now()
            WHERE workflow.id = (
                SELECT workflow_id
                FROM wedding_deposit_workflow_allocations
                WHERE held_credit_ledger_id = $1
            )
            "#,
        )
        .bind(source_credit_ledger_id)
        .execute(&mut **tx)
        .await?;
    }

    Ok(redemption_ledger_id)
}

pub async fn restore_checkout_redemption(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    amount: Decimal,
    transaction_id: Uuid,
    reason: OpenDepositRestoreReason,
) -> Result<Decimal, CustomerOpenDepositError> {
    if amount <= Decimal::ZERO {
        return Ok(Decimal::ZERO);
    }
    let account_id = ensure_account(tx, customer_id).await?;
    let balance: Decimal = sqlx::query_scalar(
        "SELECT balance FROM customer_open_deposit_accounts WHERE id = $1 FOR UPDATE",
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await?;
    let new_balance = (balance + amount).round_dp(2);

    sqlx::query(
        "UPDATE customer_open_deposit_accounts SET balance = $1, updated_at = now() WHERE id = $2",
    )
    .bind(new_balance)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;

    let restoration_ledger_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO customer_open_deposit_ledger (
            account_id, amount, balance_after, reason, transaction_id,
            payer_customer_id, payer_display_name, wedding_party_id
        )
        VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL)
        RETURNING id
        "#,
    )
    .bind(account_id)
    .bind(amount)
    .bind(new_balance)
    .bind(reason.as_str())
    .bind(transaction_id)
    .fetch_one(&mut **tx)
    .await?;

    let restored_source_payments = sqlx::query_as::<_, (Uuid, Uuid, Decimal)>(
        r#"
        SELECT
            source_event.source_credit_ledger_id,
            event_payment.source_payment_transaction_id,
            ROUND(SUM(event_payment.amount), 2)::numeric(14,2)
        FROM customer_open_deposit_source_events source_event
        INNER JOIN customer_open_deposit_ledger redemption
            ON redemption.id = source_event.ledger_event_id
        INNER JOIN customer_open_deposit_source_event_payments event_payment
            ON event_payment.source_event_id = source_event.id
        WHERE source_event.event_kind = 'redemption'
          AND redemption.reason = 'checkout_redemption'
          AND redemption.transaction_id = $1
        GROUP BY
            source_event.source_credit_ledger_id,
            event_payment.source_payment_transaction_id
        "#,
    )
    .bind(transaction_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut restored_sources: HashMap<Uuid, Vec<(Uuid, Decimal)>> = HashMap::new();
    for (source_credit_ledger_id, source_payment_transaction_id, source_amount) in
        restored_source_payments
    {
        restored_sources
            .entry(source_credit_ledger_id)
            .or_default()
            .push((source_payment_transaction_id, source_amount));
    }
    for (source_credit_ledger_id, source_payments) in restored_sources {
        let source_amount = source_payments
            .iter()
            .map(|(_, payment_amount)| *payment_amount)
            .sum::<Decimal>()
            .min(amount)
            .round_dp(2);
        let restoration_source_event_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO customer_open_deposit_source_events (
                source_credit_ledger_id, ledger_event_id, event_kind, amount
            )
            VALUES ($1, $2, 'restoration', $3)
            RETURNING id
            "#,
        )
        .bind(source_credit_ledger_id)
        .bind(restoration_ledger_id)
        .bind(source_amount)
        .fetch_one(&mut **tx)
        .await?;

        let mut restoration_amount_remaining = source_amount;
        for (source_payment_transaction_id, payment_amount) in source_payments {
            if restoration_amount_remaining <= Decimal::ZERO {
                break;
            }
            let chunk = payment_amount.min(restoration_amount_remaining);
            sqlx::query(
                r#"
                INSERT INTO customer_open_deposit_source_event_payments (
                    source_event_id, source_payment_transaction_id, amount
                )
                VALUES ($1, $2, $3)
                "#,
            )
            .bind(restoration_source_event_id)
            .bind(source_payment_transaction_id)
            .bind(chunk)
            .execute(&mut **tx)
            .await?;
            restoration_amount_remaining = (restoration_amount_remaining - chunk).round_dp(2);
        }

        sqlx::query(
            r#"
            UPDATE wedding_deposit_workflows
            SET status = 'partially_ordered', updated_at = now()
            WHERE id = (
                SELECT workflow_id
                FROM wedding_deposit_workflow_allocations
                WHERE held_credit_ledger_id = $1
            )
              AND status <> 'voided'
            "#,
        )
        .bind(source_credit_ledger_id)
        .execute(&mut **tx)
        .await?;
    }

    Ok(new_balance)
}
