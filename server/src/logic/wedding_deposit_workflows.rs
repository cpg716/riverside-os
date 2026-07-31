use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::PgPool;
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct WeddingDepositPreflightAllocation {
    pub wedding_member_id: Uuid,
    pub amount: Decimal,
    pub destination_kind: String,
    pub target_transaction_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct WeddingDepositPreflightResult {
    pub wedding_party_id: Uuid,
    pub allocation_count: usize,
    pub total_amount: Decimal,
}

#[derive(Debug, Error)]
pub enum WeddingDepositPreflightError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub async fn preflight(
    pool: &PgPool,
    payer_customer_id: Uuid,
    payer_wedding_member_id: Uuid,
    allocations: &[WeddingDepositPreflightAllocation],
) -> Result<WeddingDepositPreflightResult, WeddingDepositPreflightError> {
    if allocations.is_empty() {
        return Err(WeddingDepositPreflightError::Invalid(
            "Select at least one wedding member deposit before Payment.".to_string(),
        ));
    }

    let mut unique_member_ids = HashSet::with_capacity(allocations.len());
    for allocation in allocations {
        if !unique_member_ids.insert(allocation.wedding_member_id) {
            return Err(WeddingDepositPreflightError::Invalid(
                "Each wedding member may appear only once in a deposit transaction.".to_string(),
            ));
        }
        if allocation.amount.round_dp(2) <= Decimal::ZERO {
            return Err(WeddingDepositPreflightError::Invalid(
                "Every wedding member deposit must be greater than $0.00.".to_string(),
            ));
        }
    }

    let member_ids = unique_member_ids.into_iter().collect::<Vec<_>>();
    let member_rows = sqlx::query_as::<_, (Uuid, Uuid, Uuid)>(
        r#"
        SELECT id, customer_id, wedding_party_id
        FROM wedding_members member
        INNER JOIN wedding_parties party ON party.id = member.wedding_party_id
        WHERE member.id = ANY($1)
          AND COALESCE(party.is_deleted, FALSE) = FALSE
        "#,
    )
    .bind(&member_ids)
    .fetch_all(pool)
    .await?;
    if member_rows.len() != allocations.len() {
        return Err(WeddingDepositPreflightError::Invalid(
            "One or more selected wedding members no longer exist. Return to Wedding Deposit and reload the party."
                .to_string(),
        ));
    }
    let wedding_party_id = member_rows[0].2;
    if member_rows
        .iter()
        .any(|(_, _, party_id)| *party_id != wedding_party_id)
    {
        return Err(WeddingDepositPreflightError::Invalid(
            "All wedding deposits in one payment must belong to the same party.".to_string(),
        ));
    }
    if member_rows
        .iter()
        .any(|(_, customer_id, _)| *customer_id == payer_customer_id)
    {
        return Err(WeddingDepositPreflightError::Invalid(
            "The payer cannot also be a deposit beneficiary.".to_string(),
        ));
    }

    let payer_matches_party: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM wedding_members
            WHERE id = $1
              AND customer_id = $2
              AND wedding_party_id = $3
        )
        "#,
    )
    .bind(payer_wedding_member_id)
    .bind(payer_customer_id)
    .bind(wedding_party_id)
    .fetch_one(pool)
    .await?;
    if !payer_matches_party {
        return Err(WeddingDepositPreflightError::Invalid(
            "The payer is no longer linked to this wedding party. Return to Wedding Deposit and resolve the member link before Payment."
                .to_string(),
        ));
    }

    for allocation in allocations {
        match allocation.destination_kind.trim() {
            "held_for_future_order" => {
                if allocation.target_transaction_id.is_some() {
                    return Err(WeddingDepositPreflightError::Invalid(
                        "A held wedding deposit cannot name an existing Transaction Record."
                            .to_string(),
                    ));
                }
            }
            "existing_transaction" => {
                let target_transaction_id = allocation.target_transaction_id.ok_or_else(|| {
                    WeddingDepositPreflightError::Invalid(
                        "Select the exact member Transaction Record for every direct deposit."
                            .to_string(),
                    )
                })?;
                let target = sqlx::query_as::<_, (String, Decimal)>(
                    r#"
                    SELECT
                        COALESCE(NULLIF(TRIM(display_id), ''), id::text),
                        ROUND(balance_due, 2)::numeric(14,2)
                    FROM transactions
                    WHERE id = $1
                      AND wedding_member_id = $2
                      AND status IN ('open', 'pending_measurement')
                      AND balance_due > 0
                    "#,
                )
                .bind(target_transaction_id)
                .bind(allocation.wedding_member_id)
                .fetch_optional(pool)
                .await?;
                let Some((display_id, balance_due)) = target else {
                    return Err(WeddingDepositPreflightError::Invalid(
                        "A selected member Transaction Record is no longer open with a balance. Return to Wedding Deposit and choose the current destination."
                            .to_string(),
                    ));
                };
                if allocation.amount.round_dp(2) > balance_due.round_dp(2) {
                    return Err(WeddingDepositPreflightError::Invalid(format!(
                        "The ${:.2} wedding deposit exceeds the current ${:.2} balance on {display_id}. Return to Wedding Deposit and correct the amount before taking payment.",
                        allocation.amount.round_dp(2),
                        balance_due.round_dp(2)
                    )));
                }
            }
            _ => {
                return Err(WeddingDepositPreflightError::Invalid(
                    "Choose whether each wedding deposit is held for a future order or applied to an exact existing Transaction Record."
                        .to_string(),
                ));
            }
        }
    }

    Ok(WeddingDepositPreflightResult {
        wedding_party_id,
        allocation_count: allocations.len(),
        total_amount: allocations
            .iter()
            .map(|allocation| allocation.amount.round_dp(2))
            .sum::<Decimal>()
            .round_dp(2),
    })
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WeddingDepositWorkflowAllocation {
    pub id: Uuid,
    pub wedding_member_id: Uuid,
    pub beneficiary_customer_id: Uuid,
    pub beneficiary_name: String,
    pub role: String,
    pub amount: Decimal,
    pub remaining_amount: Decimal,
    pub destination_kind: String,
    pub target_transaction_id: Option<Uuid>,
    pub target_display_id: Option<String>,
    pub source_credit_ledger_id: Option<Uuid>,
    pub member_transaction_id: Option<Uuid>,
    pub member_transaction_display_id: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct WeddingDepositWorkflowRow {
    id: Uuid,
    payer_transaction_id: Uuid,
    payer_transaction_display_id: String,
    payer_customer_id: Uuid,
    payer_name: String,
    payer_wedding_member_id: Option<Uuid>,
    wedding_party_id: Uuid,
    party_name: String,
    event_date: NaiveDate,
    total_amount: Decimal,
    status: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct WeddingDepositWorkflow {
    pub id: Uuid,
    pub payer_transaction_id: Uuid,
    pub payer_transaction_display_id: String,
    pub payer_customer_id: Uuid,
    pub payer_name: String,
    pub payer_wedding_member_id: Option<Uuid>,
    pub wedding_party_id: Uuid,
    pub party_name: String,
    pub event_date: NaiveDate,
    pub total_amount: Decimal,
    pub remaining_amount: Decimal,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub allocations: Vec<WeddingDepositWorkflowAllocation>,
}

const WORKFLOW_SELECT: &str = r#"
    SELECT
        workflow.id,
        workflow.payer_transaction_id,
        COALESCE(NULLIF(TRIM(payer_transaction.display_id), ''), workflow.payer_transaction_id::text) AS payer_transaction_display_id,
        workflow.payer_customer_id,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', payer.first_name, payer.last_name)), ''), 'Wedding deposit payer') AS payer_name,
        workflow.payer_wedding_member_id,
        workflow.wedding_party_id,
        COALESCE(NULLIF(TRIM(party.party_name), ''), NULLIF(TRIM(party.groom_name), ''), 'Wedding party') AS party_name,
        party.event_date,
        workflow.total_amount,
        workflow.status,
        workflow.created_at
    FROM wedding_deposit_workflows workflow
    INNER JOIN transactions payer_transaction ON payer_transaction.id = workflow.payer_transaction_id
    INNER JOIN customers payer ON payer.id = workflow.payer_customer_id
    INNER JOIN wedding_parties party ON party.id = workflow.wedding_party_id
"#;

async fn load_allocations(
    pool: &PgPool,
    workflow_id: Uuid,
) -> Result<Vec<WeddingDepositWorkflowAllocation>, sqlx::Error> {
    sqlx::query_as::<_, WeddingDepositWorkflowAllocation>(
        r#"
        SELECT
            allocation.id,
            allocation.wedding_member_id,
            allocation.beneficiary_customer_id,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', customer.first_name, customer.last_name)), ''), 'Wedding member') AS beneficiary_name,
            COALESCE(NULLIF(TRIM(member.role), ''), 'Member') AS role,
            allocation.amount,
            CASE
                WHEN allocation.destination_kind = 'existing_transaction' THEN 0::numeric
                ELSE ROUND(
                    allocation.amount
                    - COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'redemption'), 0)
                    + COALESCE(SUM(source_event.amount) FILTER (WHERE source_event.event_kind = 'restoration'), 0),
                    2
                )::numeric(14,2)
            END AS remaining_amount,
            allocation.destination_kind,
            allocation.target_transaction_id,
            target.display_id AS target_display_id,
            allocation.held_credit_ledger_id AS source_credit_ledger_id,
            latest_member_transaction.id AS member_transaction_id,
            latest_member_transaction.display_id AS member_transaction_display_id
        FROM wedding_deposit_workflow_allocations allocation
        INNER JOIN wedding_members member ON member.id = allocation.wedding_member_id
        INNER JOIN customers customer ON customer.id = allocation.beneficiary_customer_id
        LEFT JOIN transactions target ON target.id = allocation.target_transaction_id
        LEFT JOIN customer_open_deposit_source_events source_event
            ON source_event.source_credit_ledger_id = allocation.held_credit_ledger_id
        LEFT JOIN LATERAL (
            SELECT transaction_record.id, transaction_record.display_id
            FROM customer_open_deposit_source_events redemption_event
            INNER JOIN customer_open_deposit_ledger redemption_ledger
                ON redemption_ledger.id = redemption_event.ledger_event_id
            INNER JOIN transactions transaction_record
                ON transaction_record.id = redemption_ledger.transaction_id
            WHERE redemption_event.source_credit_ledger_id = allocation.held_credit_ledger_id
              AND redemption_event.event_kind = 'redemption'
            ORDER BY redemption_event.created_at DESC, redemption_event.id DESC
            LIMIT 1
        ) latest_member_transaction ON TRUE
        WHERE allocation.workflow_id = $1
        GROUP BY
            allocation.id,
            customer.first_name,
            customer.last_name,
            member.role,
            target.display_id,
            latest_member_transaction.id,
            latest_member_transaction.display_id
        ORDER BY allocation.created_at, allocation.id
        "#,
    )
    .bind(workflow_id)
    .fetch_all(pool)
    .await
}

async fn build_workflow(
    pool: &PgPool,
    row: WeddingDepositWorkflowRow,
) -> Result<WeddingDepositWorkflow, sqlx::Error> {
    let allocations = load_allocations(pool, row.id).await?;
    let remaining_amount = allocations
        .iter()
        .fold(Decimal::ZERO, |total, allocation| {
            total + allocation.remaining_amount
        })
        .round_dp(2);
    Ok(WeddingDepositWorkflow {
        id: row.id,
        payer_transaction_id: row.payer_transaction_id,
        payer_transaction_display_id: row.payer_transaction_display_id,
        payer_customer_id: row.payer_customer_id,
        payer_name: row.payer_name,
        payer_wedding_member_id: row.payer_wedding_member_id,
        wedding_party_id: row.wedding_party_id,
        party_name: row.party_name,
        event_date: row.event_date,
        total_amount: row.total_amount,
        remaining_amount,
        status: row.status,
        created_at: row.created_at,
        allocations,
    })
}

pub async fn list_for_payer(
    pool: &PgPool,
    payer_customer_id: Uuid,
) -> Result<Vec<WeddingDepositWorkflow>, sqlx::Error> {
    let sql = format!(
        "{WORKFLOW_SELECT} WHERE workflow.payer_customer_id = $1 AND workflow.status <> 'voided' ORDER BY workflow.created_at DESC LIMIT 50"
    );
    let rows = sqlx::query_as::<_, WeddingDepositWorkflowRow>(&sql)
        .bind(payer_customer_id)
        .fetch_all(pool)
        .await?;
    let mut workflows = Vec::with_capacity(rows.len());
    for row in rows {
        workflows.push(build_workflow(pool, row).await?);
    }
    Ok(workflows)
}

pub async fn get_by_id(
    pool: &PgPool,
    workflow_id: Uuid,
) -> Result<Option<WeddingDepositWorkflow>, sqlx::Error> {
    let sql = format!("{WORKFLOW_SELECT} WHERE workflow.id = $1");
    let row = sqlx::query_as::<_, WeddingDepositWorkflowRow>(&sql)
        .bind(workflow_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some(row) => Ok(Some(build_workflow(pool, row).await?)),
        None => Ok(None),
    }
}
