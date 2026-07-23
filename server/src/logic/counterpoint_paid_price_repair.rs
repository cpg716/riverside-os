use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::logic::counterpoint_sync::CounterpointSyncError;

pub const COUNTERPOINT_PAID_PRICE_REPAIR_CONFIRMATION: &str = "REPAIR COUNTERPOINT PAID PRICES";

#[derive(Debug, Clone, FromRow)]
struct ManifestRow {
    manifest_key: String,
    transaction_id: Uuid,
    display_id: String,
    source_doc_id: String,
    expected_total: Decimal,
    expected_amount_paid: Decimal,
    expected_balance: Decimal,
    corrected_total: Decimal,
    corrected_balance: Decimal,
    line_repairs: JsonValue,
    source_manifest_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct LineRepair {
    line_id: Uuid,
    expected_quantity: i32,
    expected_unit_price: Decimal,
    expected_discount_amount: Decimal,
    expected_state_tax: Decimal,
    expected_local_tax: Decimal,
    corrected_unit_price: Decimal,
    corrected_discount_amount: Decimal,
    corrected_state_tax: Decimal,
    corrected_local_tax: Decimal,
    source_evidence: JsonValue,
}

#[derive(Debug, Clone, FromRow, Serialize)]
struct TransactionSnapshot {
    transaction_id: Uuid,
    display_id: String,
    counterpoint_doc_ref: Option<String>,
    counterpoint_ticket_ref: Option<String>,
    status: String,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    shipping_amount_usd: Decimal,
    rounding_adjustment: Decimal,
    is_counterpoint_import: bool,
}

#[derive(Debug, Clone, FromRow, Serialize)]
struct LineSnapshot {
    line_id: Uuid,
    quantity: i32,
    unit_price: Decimal,
    discount_amount: Decimal,
    state_tax: Decimal,
    local_tax: Decimal,
    is_fulfilled: bool,
    order_lifecycle_status: String,
    fulfilled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
struct PaymentSnapshot {
    allocation_id: Uuid,
    payment_transaction_id: Uuid,
    amount_allocated: Decimal,
    payment_amount: Decimal,
    payment_status: String,
    payment_method: String,
    provider_payment_id: Option<String>,
    provider_transaction_id: Option<String>,
    allocation_kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointPaidPriceRepairCandidate {
    pub manifest_key: String,
    pub transaction_id: Uuid,
    pub display_id: String,
    pub source_doc_id: String,
    pub current_total: String,
    pub corrected_total: String,
    pub amount_paid_unchanged: String,
    pub current_balance: String,
    pub corrected_balance: String,
    pub line_rows_to_update: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointPaidPriceRepairBlocked {
    pub manifest_key: String,
    pub display_id: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointPaidPriceRepairPreview {
    pub generated_at: DateTime<Utc>,
    pub confirmation_phrase: &'static str,
    pub manifest_digest: String,
    pub staged_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub already_applied_count: usize,
    pub line_rows_to_update: usize,
    pub payments_unchanged: bool,
    pub quantities_unchanged: bool,
    pub lifecycle_unchanged: bool,
    pub candidates: Vec<CounterpointPaidPriceRepairCandidate>,
    pub blocked: Vec<CounterpointPaidPriceRepairBlocked>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointPaidPriceRepairApplySummary {
    pub applied_manifest_digest: String,
    pub repaired_transactions: usize,
    pub repaired_lines: usize,
    pub payments_changed: bool,
    pub quantities_changed: bool,
    pub lifecycle_changed: bool,
    pub remaining_ready_count: usize,
    pub remaining_blocked_count: usize,
}

#[derive(Debug, Clone)]
struct PreparedCandidate {
    manifest: ManifestRow,
    summary: CounterpointPaidPriceRepairCandidate,
    line_repairs: Vec<LineRepair>,
    source_snapshot: JsonValue,
}

#[derive(Debug)]
struct PreparedManifest {
    staged_count: usize,
    already_applied_count: usize,
    candidates: Vec<PreparedCandidate>,
    blocked: Vec<CounterpointPaidPriceRepairBlocked>,
}

fn money(value: Decimal) -> Decimal {
    value.round_dp(2)
}

fn money_string(value: Decimal) -> String {
    format!("{:.2}", money(value))
}

fn manifest_digest(candidates: &[PreparedCandidate]) -> Result<String, CounterpointSyncError> {
    let payload = candidates
        .iter()
        .map(|candidate| &candidate.source_snapshot)
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&payload).map_err(|error| {
        CounterpointSyncError::InvalidPayload(format!(
            "could not serialize Counterpoint paid-price repair manifest: {error}"
        ))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

async fn prepare_manifest(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<PreparedManifest, CounterpointSyncError> {
    let staged_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM counterpoint_paid_price_repair_manifest WHERE active",
    )
    .fetch_one(&mut **tx)
    .await?;
    let already_applied_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM counterpoint_paid_price_repair_audit")
            .fetch_one(&mut **tx)
            .await?;
    let rows = sqlx::query_as::<_, ManifestRow>(
        r#"
        SELECT
            m.manifest_key,
            m.transaction_id,
            m.display_id,
            m.source_doc_id,
            m.expected_total,
            m.expected_amount_paid,
            m.expected_balance,
            m.corrected_total,
            m.corrected_balance,
            m.line_repairs,
            m.source_manifest_digest
        FROM counterpoint_paid_price_repair_manifest m
        LEFT JOIN counterpoint_paid_price_repair_audit a
            ON a.manifest_key = m.manifest_key
        WHERE m.active
          AND a.id IS NULL
        ORDER BY m.display_id, m.transaction_id
        "#,
    )
    .fetch_all(&mut **tx)
    .await?;

    let mut candidates = Vec::new();
    let mut blocked = Vec::new();
    for row in rows {
        match prepare_candidate(tx, row.clone()).await {
            Ok(candidate) => candidates.push(candidate),
            Err(reason) => blocked.push(CounterpointPaidPriceRepairBlocked {
                manifest_key: row.manifest_key,
                display_id: row.display_id,
                reason,
            }),
        }
    }

    Ok(PreparedManifest {
        staged_count: staged_count.max(0) as usize,
        already_applied_count: already_applied_count.max(0) as usize,
        candidates,
        blocked,
    })
}

async fn prepare_candidate(
    tx: &mut Transaction<'_, Postgres>,
    manifest: ManifestRow,
) -> Result<PreparedCandidate, String> {
    let line_repairs = serde_json::from_value::<Vec<LineRepair>>(manifest.line_repairs.clone())
        .map_err(|error| format!("staged line evidence is invalid: {error}"))?;
    if line_repairs.is_empty() {
        return Err("staged repair has no line corrections".to_string());
    }
    let unique_line_ids = line_repairs
        .iter()
        .map(|line| line.line_id)
        .collect::<HashSet<_>>();
    if unique_line_ids.len() != line_repairs.len() {
        return Err("staged repair repeats a transaction line".to_string());
    }

    let header = sqlx::query_as::<_, TransactionSnapshot>(
        r#"
        SELECT
            t.id AS transaction_id,
            COALESCE(t.display_id, t.id::text) AS display_id,
            t.counterpoint_doc_ref,
            t.counterpoint_ticket_ref,
            t.status::text AS status,
            ROUND(COALESCE(t.total_price, 0), 2)::numeric AS total_price,
            ROUND(COALESCE(t.amount_paid, 0), 2)::numeric AS amount_paid,
            ROUND(COALESCE(t.balance_due, 0), 2)::numeric AS balance_due,
            ROUND(COALESCE(t.shipping_amount_usd, 0), 2)::numeric AS shipping_amount_usd,
            ROUND(COALESCE(t.rounding_adjustment, 0), 2)::numeric AS rounding_adjustment,
            COALESCE(t.is_counterpoint_import, FALSE) AS is_counterpoint_import
        FROM transactions t
        WHERE t.id = $1
        "#,
    )
    .bind(manifest.transaction_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| format!("could not read current Transaction Record: {error}"))?
    .ok_or_else(|| "current Transaction Record no longer exists".to_string())?;

    if !header.is_counterpoint_import {
        return Err("Transaction Record is not an imported Counterpoint record".to_string());
    }
    if header.display_id != manifest.display_id {
        return Err("Transaction display ID changed after source review".to_string());
    }
    if !header
        .counterpoint_doc_ref
        .as_deref()
        .is_some_and(|value| value.contains(&manifest.source_doc_id))
    {
        return Err("Counterpoint open-document reference changed after source review".to_string());
    }
    if money(header.total_price) != money(manifest.expected_total)
        || money(header.amount_paid) != money(manifest.expected_amount_paid)
        || money(header.balance_due) != money(manifest.expected_balance)
    {
        return Err(
            "transaction total, paid amount, or balance changed after source review".to_string(),
        );
    }

    let lines = sqlx::query_as::<_, LineSnapshot>(
        r#"
        SELECT
            tl.id AS line_id,
            tl.quantity,
            ROUND(COALESCE(tl.unit_price, 0), 2)::numeric AS unit_price,
            ROUND(COALESCE(tl.discount_amount, 0), 2)::numeric AS discount_amount,
            ROUND(COALESCE(tl.state_tax, 0), 2)::numeric AS state_tax,
            ROUND(COALESCE(tl.local_tax, 0), 2)::numeric AS local_tax,
            COALESCE(tl.is_fulfilled, FALSE) AS is_fulfilled,
            COALESCE(tl.order_lifecycle_status::text, '') AS order_lifecycle_status,
            tl.fulfilled_at
        FROM transaction_lines tl
        WHERE tl.transaction_id = $1
        ORDER BY tl.id
        "#,
    )
    .bind(manifest.transaction_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| format!("could not read current transaction lines: {error}"))?;
    let lines_by_id = lines
        .iter()
        .map(|line| (line.line_id, line))
        .collect::<HashMap<_, _>>();

    for repair in &line_repairs {
        let current = lines_by_id
            .get(&repair.line_id)
            .ok_or_else(|| "a reviewed transaction line no longer exists".to_string())?;
        if current.quantity != repair.expected_quantity {
            return Err("transaction line quantity changed after source review".to_string());
        }
        if money(current.unit_price) != money(repair.expected_unit_price)
            || money(current.discount_amount) != money(repair.expected_discount_amount)
            || money(current.state_tax) != money(repair.expected_state_tax)
            || money(current.local_tax) != money(repair.expected_local_tax)
        {
            return Err(
                "transaction line price, discount, or tax changed after source review".to_string(),
            );
        }
        if !repair.source_evidence.is_object() {
            return Err("reviewed Counterpoint line evidence is missing".to_string());
        }
    }

    let return_event_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM transaction_return_lines WHERE transaction_id = $1",
    )
    .bind(manifest.transaction_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| format!("could not verify return history: {error}"))?;
    if return_event_count != 0 {
        return Err("post-sale return history requires separate review".to_string());
    }

    let payments = sqlx::query_as::<_, PaymentSnapshot>(
        r#"
        SELECT
            pa.id AS allocation_id,
            pt.id AS payment_transaction_id,
            ROUND(COALESCE(pa.amount_allocated, 0), 2)::numeric AS amount_allocated,
            ROUND(COALESCE(pt.amount, 0), 2)::numeric AS payment_amount,
            pt.status::text AS payment_status,
            pt.payment_method,
            pt.provider_payment_id,
            pt.provider_transaction_id,
            COALESCE(pa.metadata->>'kind', '') AS allocation_kind
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
        ORDER BY pa.id
        "#,
    )
    .bind(manifest.transaction_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| format!("could not verify payment allocations: {error}"))?;
    if payments.iter().any(|payment| {
        payment.amount_allocated < Decimal::ZERO
            || matches!(
                payment.allocation_kind.as_str(),
                "order_refund" | "exchange_refund_remainder"
            )
    }) {
        return Err("refund allocation history requires separate review".to_string());
    }
    let allocated_total = payments
        .iter()
        .fold(Decimal::ZERO, |sum, payment| sum + payment.amount_allocated);
    if money(allocated_total) != money(header.amount_paid) {
        return Err("stored paid amount no longer matches payment allocations".to_string());
    }

    let repairs_by_id = line_repairs
        .iter()
        .map(|repair| (repair.line_id, repair))
        .collect::<HashMap<_, _>>();
    let projected_line_total = lines.iter().fold(Decimal::ZERO, |sum, line| {
        let (unit_price, state_tax, local_tax) = repairs_by_id
            .get(&line.line_id)
            .map(|repair| {
                (
                    repair.corrected_unit_price,
                    repair.corrected_state_tax,
                    repair.corrected_local_tax,
                )
            })
            .unwrap_or((line.unit_price, line.state_tax, line.local_tax));
        sum + Decimal::from(line.quantity) * (unit_price + state_tax + local_tax)
    });
    let projected_total = money(projected_line_total + header.shipping_amount_usd);
    if projected_total != money(manifest.corrected_total) {
        return Err(
            "corrected line prices do not exactly equal the reviewed Counterpoint total"
                .to_string(),
        );
    }
    let projected_balance = money((projected_total - header.amount_paid).max(Decimal::ZERO));
    if projected_balance != money(manifest.corrected_balance) {
        return Err(
            "corrected balance does not exactly follow total minus preserved payments".to_string(),
        );
    }

    let source_snapshot = json!({
        "manifest": {
            "manifest_key": manifest.manifest_key,
            "source_doc_id": manifest.source_doc_id,
            "source_manifest_digest": manifest.source_manifest_digest,
            "expected_total": money_string(manifest.expected_total),
            "corrected_total": money_string(manifest.corrected_total),
            "expected_amount_paid": money_string(manifest.expected_amount_paid),
            "expected_balance": money_string(manifest.expected_balance),
            "corrected_balance": money_string(manifest.corrected_balance),
            "line_repairs": line_repairs,
        },
        "current_transaction": header,
        "current_lines": lines,
        "current_payment_allocations": payments,
        "return_event_count": return_event_count,
        "projected_line_total": money_string(projected_line_total),
        "projected_total": money_string(projected_total),
        "projected_balance": money_string(projected_balance),
        "payments_unchanged": true,
        "quantities_unchanged": true,
        "lifecycle_unchanged": true,
    });
    let summary = CounterpointPaidPriceRepairCandidate {
        manifest_key: manifest.manifest_key.clone(),
        transaction_id: manifest.transaction_id,
        display_id: manifest.display_id.clone(),
        source_doc_id: manifest.source_doc_id.clone(),
        current_total: money_string(manifest.expected_total),
        corrected_total: money_string(manifest.corrected_total),
        amount_paid_unchanged: money_string(manifest.expected_amount_paid),
        current_balance: money_string(manifest.expected_balance),
        corrected_balance: money_string(manifest.corrected_balance),
        line_rows_to_update: line_repairs.len(),
    };
    Ok(PreparedCandidate {
        manifest,
        summary,
        line_repairs,
        source_snapshot,
    })
}

pub async fn preview_counterpoint_paid_price_repairs(
    pool: &PgPool,
) -> Result<CounterpointPaidPriceRepairPreview, CounterpointSyncError> {
    let mut tx = pool.begin().await?;
    let prepared = prepare_manifest(&mut tx).await?;
    tx.rollback().await?;
    let digest = manifest_digest(&prepared.candidates)?;
    let line_rows_to_update = prepared
        .candidates
        .iter()
        .map(|candidate| candidate.line_repairs.len())
        .sum();
    Ok(CounterpointPaidPriceRepairPreview {
        generated_at: Utc::now(),
        confirmation_phrase: COUNTERPOINT_PAID_PRICE_REPAIR_CONFIRMATION,
        manifest_digest: digest,
        staged_count: prepared.staged_count,
        ready_count: prepared.candidates.len(),
        blocked_count: prepared.blocked.len(),
        already_applied_count: prepared.already_applied_count,
        line_rows_to_update,
        payments_unchanged: true,
        quantities_unchanged: true,
        lifecycle_unchanged: true,
        candidates: prepared
            .candidates
            .into_iter()
            .map(|candidate| candidate.summary)
            .collect(),
        blocked: prepared.blocked,
    })
}

pub async fn apply_counterpoint_paid_price_repairs(
    pool: &PgPool,
    repaired_by_staff_id: Uuid,
    confirmation_phrase: &str,
    reason: &str,
    expected_manifest_digest: &str,
    expected_candidate_count: usize,
) -> Result<CounterpointPaidPriceRepairApplySummary, CounterpointSyncError> {
    if confirmation_phrase.trim() != COUNTERPOINT_PAID_PRICE_REPAIR_CONFIRMATION {
        return Err(CounterpointSyncError::InvalidPayload(
            "confirmation phrase did not match".to_string(),
        ));
    }
    if reason.trim().len() < 12 {
        return Err(CounterpointSyncError::InvalidPayload(
            "a paid-price repair reason of at least 12 characters is required".to_string(),
        ));
    }
    if expected_manifest_digest.trim().len() != 64 {
        return Err(CounterpointSyncError::InvalidPayload(
            "a valid reviewed paid-price manifest digest is required".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('counterpoint_paid_price_repair'))")
        .execute(&mut *tx)
        .await?;
    sqlx::query("LOCK TABLE counterpoint_paid_price_repair_manifest IN SHARE MODE")
        .execute(&mut *tx)
        .await?;

    let transaction_ids = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT m.transaction_id
        FROM counterpoint_paid_price_repair_manifest m
        LEFT JOIN counterpoint_paid_price_repair_audit a
            ON a.manifest_key = m.manifest_key
        WHERE m.active AND a.id IS NULL
        ORDER BY m.transaction_id
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;
    if !transaction_ids.is_empty() {
        sqlx::query("SELECT id FROM transactions WHERE id = ANY($1) FOR UPDATE")
            .bind(&transaction_ids)
            .fetch_all(&mut *tx)
            .await?;
        sqlx::query("SELECT id FROM transaction_lines WHERE transaction_id = ANY($1) FOR UPDATE")
            .bind(&transaction_ids)
            .fetch_all(&mut *tx)
            .await?;
        sqlx::query(
            "SELECT id FROM payment_allocations WHERE target_transaction_id = ANY($1) FOR UPDATE",
        )
        .bind(&transaction_ids)
        .fetch_all(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            SELECT pt.id
            FROM payment_transactions pt
            INNER JOIN payment_allocations pa ON pa.transaction_id = pt.id
            WHERE pa.target_transaction_id = ANY($1)
            FOR UPDATE OF pt
            "#,
        )
        .bind(&transaction_ids)
        .fetch_all(&mut *tx)
        .await?;
    }

    let prepared = prepare_manifest(&mut tx).await?;
    if !prepared.blocked.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "{} paid-price repair candidate(s) changed or require review; refresh the preview; no changes were committed",
            prepared.blocked.len()
        )));
    }
    let current_digest = manifest_digest(&prepared.candidates)?;
    if prepared.candidates.len() != expected_candidate_count
        || current_digest != expected_manifest_digest.trim()
    {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "the paid-price repair manifest changed after review (reviewed {} candidate(s), current {}); refresh and review again; no changes were committed",
            expected_candidate_count,
            prepared.candidates.len()
        )));
    }

    sqlx::query("SET LOCAL riverside.suppress_booking_event = 'true'")
        .execute(&mut *tx)
        .await?;

    let mut repaired_transactions = 0_usize;
    let mut repaired_lines = 0_usize;
    for candidate in prepared.candidates {
        let repair_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            INSERT INTO counterpoint_paid_price_repair_audit (
                manifest_key,
                transaction_id,
                repaired_by_staff_id,
                reason,
                review_manifest_digest,
                review_manifest_candidate_count,
                source_snapshot
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            "#,
        )
        .bind(&candidate.manifest.manifest_key)
        .bind(candidate.manifest.transaction_id)
        .bind(repaired_by_staff_id)
        .bind(reason.trim())
        .bind(&current_digest)
        .bind(i32::try_from(expected_candidate_count).unwrap_or(i32::MAX))
        .bind(&candidate.source_snapshot)
        .fetch_one(&mut *tx)
        .await?;

        for line in &candidate.line_repairs {
            let result = sqlx::query(
                r#"
                UPDATE transaction_lines
                SET unit_price = $3,
                    discount_amount = $4,
                    state_tax = $5,
                    local_tax = $6,
                    size_specs = COALESCE(size_specs, '{}'::jsonb)
                        || jsonb_build_object(
                            'counterpoint_paid_price_repair',
                            jsonb_build_object(
                                'repair_id', $7::text,
                                'manifest_key', $8::text,
                                'source_doc_id', $9::text,
                                'source_evidence', $10::jsonb,
                                'expected_before', jsonb_build_object(
                                    'unit_price', $11::text,
                                    'discount_amount', $12::text,
                                    'state_tax', $13::text,
                                    'local_tax', $14::text
                                ),
                                'corrected', jsonb_build_object(
                                    'unit_price', $3::text,
                                    'discount_amount', $4::text,
                                    'state_tax', $5::text,
                                    'local_tax', $6::text
                                )
                            )
                        )
                WHERE id = $1
                  AND transaction_id = $2
                  AND quantity = $15
                  AND ROUND(COALESCE(unit_price, 0), 2) = $11
                  AND ROUND(COALESCE(discount_amount, 0), 2) = $12
                  AND ROUND(COALESCE(state_tax, 0), 2) = $13
                  AND ROUND(COALESCE(local_tax, 0), 2) = $14
                "#,
            )
            .bind(line.line_id)
            .bind(candidate.manifest.transaction_id)
            .bind(money(line.corrected_unit_price))
            .bind(money(line.corrected_discount_amount))
            .bind(money(line.corrected_state_tax))
            .bind(money(line.corrected_local_tax))
            .bind(repair_id)
            .bind(&candidate.manifest.manifest_key)
            .bind(&candidate.manifest.source_doc_id)
            .bind(&line.source_evidence)
            .bind(money(line.expected_unit_price))
            .bind(money(line.expected_discount_amount))
            .bind(money(line.expected_state_tax))
            .bind(money(line.expected_local_tax))
            .bind(line.expected_quantity)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                return Err(CounterpointSyncError::InvalidPayload(format!(
                    "{} line values changed after review; no changes were committed",
                    candidate.manifest.display_id
                )));
            }
            repaired_lines += 1;
        }

        let header_result = sqlx::query(
            r#"
            UPDATE transactions
            SET total_price = $3,
                balance_due = $4,
                metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                        'counterpoint_paid_price_repair',
                        jsonb_build_object(
                            'repair_id', $5::text,
                            'manifest_key', $6::text,
                            'source_doc_id', $7::text,
                            'review_manifest_digest', $8::text
                        )
                    )
            WHERE id = $1
              AND COALESCE(is_counterpoint_import, FALSE)
              AND counterpoint_doc_ref LIKE '%' || $7 || '%'
              AND ROUND(COALESCE(total_price, 0), 2) = $9
              AND ROUND(COALESCE(amount_paid, 0), 2) = $10
              AND ROUND(COALESCE(balance_due, 0), 2) = $11
              AND display_id = $2
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .bind(&candidate.manifest.display_id)
        .bind(money(candidate.manifest.corrected_total))
        .bind(money(candidate.manifest.corrected_balance))
        .bind(repair_id)
        .bind(&candidate.manifest.manifest_key)
        .bind(&candidate.manifest.source_doc_id)
        .bind(&current_digest)
        .bind(money(candidate.manifest.expected_total))
        .bind(money(candidate.manifest.expected_amount_paid))
        .bind(money(candidate.manifest.expected_balance))
        .execute(&mut *tx)
        .await?;
        if header_result.rows_affected() != 1 {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "{} transaction values changed after review; no changes were committed",
                candidate.manifest.display_id
            )));
        }

        let result_snapshot = json!({
            "transaction_id": candidate.manifest.transaction_id,
            "display_id": candidate.manifest.display_id,
            "corrected_total": money_string(candidate.manifest.corrected_total),
            "amount_paid_unchanged": money_string(candidate.manifest.expected_amount_paid),
            "corrected_balance": money_string(candidate.manifest.corrected_balance),
            "line_rows_updated": candidate.line_repairs.len(),
            "payments_changed": false,
            "quantities_changed": false,
            "lifecycle_changed": false,
            "review_manifest_digest": current_digest,
        });
        sqlx::query(
            "UPDATE counterpoint_paid_price_repair_audit SET result_snapshot = $2 WHERE id = $1",
        )
        .bind(repair_id)
        .bind(&result_snapshot)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO transaction_activity_log (
                transaction_id,
                customer_id,
                event_kind,
                summary,
                metadata
            )
            SELECT
                t.id,
                t.customer_id,
                'counterpoint_paid_price_repair',
                'Restored exact Counterpoint paid line prices and lifecycle tax without changing payments or fulfillment.',
                jsonb_build_object(
                    'repair_id', $2::text,
                    'manifest_key', $3::text,
                    'source_doc_id', $4::text,
                    'repaired_by_staff_id', $5::text,
                    'reason', $6::text,
                    'before_total', $7::text,
                    'corrected_total', $8::text,
                    'amount_paid_unchanged', $9::text,
                    'before_balance', $10::text,
                    'corrected_balance', $11::text,
                    'line_rows_updated', $12::integer,
                    'payments_changed', FALSE,
                    'quantities_changed', FALSE,
                    'lifecycle_changed', FALSE,
                    'review_manifest_digest', $13::text
                )
            FROM transactions t
            WHERE t.id = $1
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .bind(repair_id)
        .bind(&candidate.manifest.manifest_key)
        .bind(&candidate.manifest.source_doc_id)
        .bind(repaired_by_staff_id)
        .bind(reason.trim())
        .bind(money_string(candidate.manifest.expected_total))
        .bind(money_string(candidate.manifest.corrected_total))
        .bind(money_string(candidate.manifest.expected_amount_paid))
        .bind(money_string(candidate.manifest.expected_balance))
        .bind(money_string(candidate.manifest.corrected_balance))
        .bind(i32::try_from(candidate.line_repairs.len()).unwrap_or(i32::MAX))
        .bind(&current_digest)
        .execute(&mut *tx)
        .await?;

        repaired_transactions += 1;
    }

    let remaining = prepare_manifest(&mut tx).await?;
    tx.commit().await?;
    Ok(CounterpointPaidPriceRepairApplySummary {
        applied_manifest_digest: current_digest,
        repaired_transactions,
        repaired_lines,
        payments_changed: false,
        quantities_changed: false,
        lifecycle_changed: false,
        remaining_ready_count: remaining.candidates.len(),
        remaining_blocked_count: remaining.blocked.len(),
    })
}
