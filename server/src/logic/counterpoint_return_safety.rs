use std::collections::HashSet;

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::logic::counterpoint_sync::CounterpointSyncError;

pub const COUNTERPOINT_RETURN_REVIEW_CONFIRMATION: &str = "BLOCK UNRECONCILED COUNTERPOINT RETURNS";
pub const COUNTERPOINT_RETURN_REVIEW_MESSAGE: &str = "This imported Counterpoint transaction has financial or return history that has not been reconciled to exact source evidence. Do not refund, exchange, or return items from this record until support completes the reviewed Counterpoint reconciliation.";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
struct ReviewedLineSnapshot {
    line_id: Uuid,
    quantity: i32,
    unit_price: Decimal,
    discount_amount: Decimal,
    state_tax: Decimal,
    local_tax: Decimal,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ReviewedReturnBlock {
    manifest_key: String,
    transaction_id: Uuid,
    display_id: String,
    source_kind: String,
    reasons: Vec<String>,
    expected_counterpoint_ticket_ref: Option<String>,
    expected_counterpoint_doc_ref: Option<String>,
    expected_total: Decimal,
    expected_amount_paid: Decimal,
    expected_balance: Decimal,
    expected_allocated_tender_total: Decimal,
    line_snapshot: Vec<ReviewedLineSnapshot>,
}

#[derive(Debug, Deserialize)]
struct ReviewedReturnBlockFile {
    return_review_block_manifest_digest: String,
    return_review_blocks: Vec<ReviewedReturnBlock>,
}

#[derive(Debug, Clone, FromRow)]
struct CurrentHeader {
    transaction_id: Uuid,
    display_id: String,
    counterpoint_ticket_ref: Option<String>,
    counterpoint_doc_ref: Option<String>,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    allocated_tender_total: Decimal,
    is_counterpoint_import: bool,
}

#[derive(Debug, Clone, FromRow, Serialize, PartialEq)]
struct CurrentLineSnapshot {
    line_id: Uuid,
    quantity: i32,
    unit_price: Decimal,
    discount_amount: Decimal,
    state_tax: Decimal,
    local_tax: Decimal,
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointReturnReviewBlocked {
    pub transaction_id: Uuid,
    pub display_id: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointReturnReviewPreview {
    pub generated_at: DateTime<Utc>,
    pub confirmation_phrase: &'static str,
    pub manifest_digest: String,
    pub reviewed_count: usize,
    pub ready_count: usize,
    pub already_active_count: usize,
    pub blocked_count: usize,
    pub line_rows_reviewed: usize,
    pub financial_values_changed: bool,
    pub blocked: Vec<CounterpointReturnReviewBlocked>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointReturnReviewApplySummary {
    pub applied_manifest_digest: String,
    pub newly_blocked_transactions: usize,
    pub already_blocked_transactions: usize,
    pub financial_values_changed: bool,
}

#[derive(Debug)]
struct PreparedReturnBlocks {
    digest: String,
    reviewed_count: usize,
    line_rows_reviewed: usize,
    ready: Vec<(ReviewedReturnBlock, JsonValue)>,
    already_active_count: usize,
    blocked: Vec<CounterpointReturnReviewBlocked>,
}

fn money(value: Decimal) -> Decimal {
    value.round_dp(2)
}

fn normalized_optional(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn parse_reviewed_file(
    manifest_json: &JsonValue,
) -> Result<(ReviewedReturnBlockFile, String), CounterpointSyncError> {
    let reviewed = serde_json::from_value::<ReviewedReturnBlockFile>(manifest_json.clone())
        .map_err(|error| {
            CounterpointSyncError::InvalidPayload(format!(
                "reviewed Counterpoint return-safety manifest is invalid: {error}"
            ))
        })?;
    if reviewed.return_review_blocks.is_empty() || reviewed.return_review_blocks.len() > 1_000 {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "reviewed Counterpoint return-safety manifest must contain 1 to 1000 records; received {}",
            reviewed.return_review_blocks.len()
        )));
    }

    let mut manifest_keys = HashSet::new();
    let mut transaction_ids = HashSet::new();
    for block in &reviewed.return_review_blocks {
        if block.manifest_key.trim().is_empty()
            || block.display_id.trim().is_empty()
            || block.source_kind.trim().is_empty()
            || block.reasons.is_empty()
            || block.line_snapshot.is_empty()
        {
            return Err(CounterpointSyncError::InvalidPayload(
                "reviewed Counterpoint return-safety manifest contains incomplete evidence"
                    .to_string(),
            ));
        }
        if block.reasons.iter().any(|reason| reason.trim().is_empty()) {
            return Err(CounterpointSyncError::InvalidPayload(
                "reviewed Counterpoint return-safety manifest contains a blank reason".to_string(),
            ));
        }
        if !manifest_keys.insert(block.manifest_key.clone()) {
            return Err(CounterpointSyncError::InvalidPayload(
                "reviewed Counterpoint return-safety manifest repeats a manifest key".to_string(),
            ));
        }
        if !transaction_ids.insert(block.transaction_id) {
            return Err(CounterpointSyncError::InvalidPayload(
                "reviewed Counterpoint return-safety manifest repeats a transaction".to_string(),
            ));
        }
    }

    let bytes = serde_json::to_vec(&reviewed.return_review_blocks).map_err(|error| {
        CounterpointSyncError::InvalidPayload(format!(
            "could not serialize reviewed Counterpoint return-safety records: {error}"
        ))
    })?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    if reviewed.return_review_block_manifest_digest.trim() != digest {
        return Err(CounterpointSyncError::InvalidPayload(
            "reviewed Counterpoint return-safety manifest digest does not match its records"
                .to_string(),
        ));
    }
    Ok((reviewed, digest))
}

async fn prepare_return_blocks(
    tx: &mut Transaction<'_, Postgres>,
    reviewed: ReviewedReturnBlockFile,
    digest: String,
) -> Result<PreparedReturnBlocks, CounterpointSyncError> {
    let reviewed_count = reviewed.return_review_blocks.len();
    let line_rows_reviewed = reviewed
        .return_review_blocks
        .iter()
        .map(|block| block.line_snapshot.len())
        .sum();
    let mut ready = Vec::new();
    let mut already_active_count = 0_usize;
    let mut blocked = Vec::new();

    for block in reviewed.return_review_blocks {
        let header: Option<CurrentHeader> = sqlx::query_as(
            r#"
            SELECT
                t.id AS transaction_id,
                t.display_id,
                t.counterpoint_ticket_ref,
                t.counterpoint_doc_ref,
                ROUND(COALESCE(t.total_price, 0), 2)::numeric(14,2) AS total_price,
                ROUND(COALESCE(t.amount_paid, 0), 2)::numeric(14,2) AS amount_paid,
                ROUND(COALESCE(t.balance_due, 0), 2)::numeric(14,2) AS balance_due,
                ROUND(COALESCE((
                    SELECT SUM(pa.amount_allocated)
                    FROM payment_allocations pa
                    WHERE pa.target_transaction_id = t.id
                ), 0), 2)::numeric(14,2) AS allocated_tender_total,
                COALESCE(t.is_counterpoint_import, FALSE) AS is_counterpoint_import
            FROM transactions t
            WHERE t.id = $1
            "#,
        )
        .bind(block.transaction_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(header) = header else {
            blocked.push(CounterpointReturnReviewBlocked {
                transaction_id: block.transaction_id,
                display_id: block.display_id,
                reason: "Transaction Record no longer exists".to_string(),
            });
            continue;
        };

        let current_lines = sqlx::query_as::<_, CurrentLineSnapshot>(
            r#"
            SELECT
                id AS line_id,
                quantity,
                ROUND(COALESCE(unit_price, 0), 2)::numeric(14,2) AS unit_price,
                ROUND(COALESCE(discount_amount, 0), 2)::numeric(14,2) AS discount_amount,
                ROUND(COALESCE(state_tax, 0), 2)::numeric(14,2) AS state_tax,
                ROUND(COALESCE(local_tax, 0), 2)::numeric(14,2) AS local_tax
            FROM transaction_lines
            WHERE transaction_id = $1
            ORDER BY id
            "#,
        )
        .bind(block.transaction_id)
        .fetch_all(&mut **tx)
        .await?;
        let reviewed_lines = block
            .line_snapshot
            .iter()
            .map(|line| CurrentLineSnapshot {
                line_id: line.line_id,
                quantity: line.quantity,
                unit_price: money(line.unit_price),
                discount_amount: money(line.discount_amount),
                state_tax: money(line.state_tax),
                local_tax: money(line.local_tax),
            })
            .collect::<Vec<_>>();

        let evidence_matches = header.is_counterpoint_import
            && header.transaction_id == block.transaction_id
            && header.display_id == block.display_id
            && normalized_optional(&header.counterpoint_ticket_ref)
                == normalized_optional(&block.expected_counterpoint_ticket_ref)
            && normalized_optional(&header.counterpoint_doc_ref)
                == normalized_optional(&block.expected_counterpoint_doc_ref)
            && money(header.total_price) == money(block.expected_total)
            && money(header.amount_paid) == money(block.expected_amount_paid)
            && money(header.balance_due) == money(block.expected_balance)
            && money(header.allocated_tender_total) == money(block.expected_allocated_tender_total)
            && current_lines == reviewed_lines;
        if !evidence_matches {
            blocked.push(CounterpointReturnReviewBlocked {
                transaction_id: block.transaction_id,
                display_id: block.display_id,
                reason: "stored transaction, line, or payment evidence changed after Counterpoint review"
                    .to_string(),
            });
            continue;
        }

        let active_manifest_key: Option<String> = sqlx::query_scalar(
            r#"
            SELECT manifest_key
            FROM counterpoint_return_review_blocks
            WHERE transaction_id = $1 AND active
            "#,
        )
        .bind(block.transaction_id)
        .fetch_optional(&mut **tx)
        .await?;
        if active_manifest_key.as_deref() == Some(block.manifest_key.as_str()) {
            already_active_count += 1;
            continue;
        }

        let source_snapshot = json!({
            "reviewed_block": block,
            "current_header": {
                "transaction_id": header.transaction_id,
                "display_id": header.display_id,
                "counterpoint_ticket_ref": header.counterpoint_ticket_ref,
                "counterpoint_doc_ref": header.counterpoint_doc_ref,
                "total_price": money(header.total_price),
                "amount_paid": money(header.amount_paid),
                "balance_due": money(header.balance_due),
                "allocated_tender_total": money(header.allocated_tender_total),
                "is_counterpoint_import": header.is_counterpoint_import,
            },
            "current_lines": current_lines,
            "financial_values_mutated": false,
        });
        ready.push((block, source_snapshot));
    }

    Ok(PreparedReturnBlocks {
        digest,
        reviewed_count,
        line_rows_reviewed,
        ready,
        already_active_count,
        blocked,
    })
}

pub async fn preview_counterpoint_return_review_blocks(
    pool: &PgPool,
    manifest_json: &JsonValue,
) -> Result<CounterpointReturnReviewPreview, CounterpointSyncError> {
    let (reviewed, digest) = parse_reviewed_file(manifest_json)?;
    let mut tx = pool.begin().await?;
    let prepared = prepare_return_blocks(&mut tx, reviewed, digest).await?;
    tx.rollback().await?;
    Ok(CounterpointReturnReviewPreview {
        generated_at: Utc::now(),
        confirmation_phrase: COUNTERPOINT_RETURN_REVIEW_CONFIRMATION,
        manifest_digest: prepared.digest,
        reviewed_count: prepared.reviewed_count,
        ready_count: prepared.ready.len(),
        already_active_count: prepared.already_active_count,
        blocked_count: prepared.blocked.len(),
        line_rows_reviewed: prepared.line_rows_reviewed,
        financial_values_changed: false,
        blocked: prepared.blocked,
    })
}

pub async fn resolve_counterpoint_return_review_block(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    resolved_by_staff_id: Uuid,
    resolution_reason: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE counterpoint_return_review_blocks
        SET active = FALSE,
            resolved_by_staff_id = $2,
            resolved_at = CURRENT_TIMESTAMP,
            resolution_reason = $3
        WHERE transaction_id = $1 AND active
        "#,
    )
    .bind(transaction_id)
    .bind(resolved_by_staff_id)
    .bind(resolution_reason)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

pub async fn apply_counterpoint_return_review_blocks(
    pool: &PgPool,
    manifest_json: &JsonValue,
    blocked_by_staff_id: Uuid,
    confirmation_phrase: &str,
    expected_manifest_digest: &str,
    expected_candidate_count: usize,
) -> Result<CounterpointReturnReviewApplySummary, CounterpointSyncError> {
    if confirmation_phrase.trim() != COUNTERPOINT_RETURN_REVIEW_CONFIRMATION {
        return Err(CounterpointSyncError::InvalidPayload(
            "confirmation phrase did not match".to_string(),
        ));
    }
    let (reviewed, digest) = parse_reviewed_file(manifest_json)?;
    if digest != expected_manifest_digest.trim()
        || reviewed.return_review_blocks.len() != expected_candidate_count
    {
        return Err(CounterpointSyncError::InvalidPayload(
            "the Counterpoint return-safety manifest changed after review; no blocks were applied"
                .to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('counterpoint_return_review_blocks'))")
        .execute(&mut *tx)
        .await?;
    sqlx::query("LOCK TABLE counterpoint_return_review_blocks IN EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;

    let staff_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1)")
        .bind(blocked_by_staff_id)
        .fetch_one(&mut *tx)
        .await?;
    if !staff_exists {
        return Err(CounterpointSyncError::InvalidPayload(
            "blocking staff identity was not found".to_string(),
        ));
    }

    let transaction_ids = reviewed
        .return_review_blocks
        .iter()
        .map(|block| block.transaction_id)
        .collect::<Vec<_>>();
    sqlx::query("SELECT id FROM transactions WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(&transaction_ids)
        .fetch_all(&mut *tx)
        .await?;
    sqlx::query(
        "SELECT id FROM transaction_lines WHERE transaction_id = ANY($1) ORDER BY id FOR UPDATE",
    )
    .bind(&transaction_ids)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query(
        "SELECT id FROM payment_allocations WHERE target_transaction_id = ANY($1) ORDER BY id FOR UPDATE",
    )
    .bind(&transaction_ids)
    .fetch_all(&mut *tx)
    .await?;

    let prepared = prepare_return_blocks(&mut tx, reviewed, digest.clone()).await?;
    if !prepared.blocked.is_empty()
        || prepared.ready.len() + prepared.already_active_count != prepared.reviewed_count
    {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "{} Counterpoint return-safety record(s) changed or require review; no blocks were applied",
            prepared.blocked.len()
        )));
    }

    let newly_blocked_transactions = prepared.ready.len();
    for (block, source_snapshot) in prepared.ready {
        sqlx::query(
            r#"
            UPDATE counterpoint_return_review_blocks
            SET active = FALSE,
                resolved_by_staff_id = $2,
                resolved_at = CURRENT_TIMESTAMP,
                resolution_reason = 'Superseded by refreshed reviewed Counterpoint return block'
            WHERE transaction_id = $1 AND active
            "#,
        )
        .bind(block.transaction_id)
        .bind(blocked_by_staff_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO counterpoint_return_review_blocks (
                manifest_key,
                transaction_id,
                display_id,
                source_kind,
                reasons,
                review_manifest_digest,
                source_snapshot,
                active,
                blocked_by_staff_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
            ON CONFLICT (manifest_key) DO UPDATE
            SET display_id = EXCLUDED.display_id,
                source_kind = EXCLUDED.source_kind,
                reasons = EXCLUDED.reasons,
                review_manifest_digest = EXCLUDED.review_manifest_digest,
                source_snapshot = EXCLUDED.source_snapshot,
                active = TRUE,
                blocked_by_staff_id = EXCLUDED.blocked_by_staff_id,
                blocked_at = CURRENT_TIMESTAMP,
                resolved_by_staff_id = NULL,
                resolved_at = NULL,
                resolution_reason = NULL
            "#,
        )
        .bind(&block.manifest_key)
        .bind(block.transaction_id)
        .bind(&block.display_id)
        .bind(&block.source_kind)
        .bind(json!(block.reasons))
        .bind(&digest)
        .bind(source_snapshot)
        .bind(blocked_by_staff_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(CounterpointReturnReviewApplySummary {
        applied_manifest_digest: digest,
        newly_blocked_transactions,
        already_blocked_transactions: prepared.already_active_count,
        financial_values_changed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_review_message_is_fail_closed_and_staff_actionable() {
        assert!(COUNTERPOINT_RETURN_REVIEW_MESSAGE.contains("Do not refund"));
        assert!(COUNTERPOINT_RETURN_REVIEW_MESSAGE.contains("reconciliation"));
    }
}
