use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::logic::{
    counterpoint_sync::CounterpointSyncError, transaction_recalc::recalc_transaction_totals,
};

pub const COUNTERPOINT_HISTORICAL_REFUND_REPAIR_CONFIRMATION: &str =
    "RESTORE COUNTERPOINT HISTORICAL REFUNDS";

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ReviewedLineRepair {
    line_id: Uuid,
    expected_quantity: i32,
    expected_unit_price: Decimal,
    expected_discount_amount: Decimal,
    expected_state_tax: Decimal,
    expected_local_tax: Decimal,
    corrected_quantity: i32,
    corrected_unit_price: Decimal,
    corrected_discount_amount: Decimal,
    corrected_state_tax: Decimal,
    corrected_local_tax: Decimal,
    returned_quantity: i32,
    refund_subtotal: Decimal,
    refund_state_tax: Decimal,
    refund_local_tax: Decimal,
    refund_total: Decimal,
    source_evidence: JsonValue,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ReviewedCandidate {
    manifest_key: String,
    transaction_id: Uuid,
    display_id: String,
    source_doc_id: String,
    expected_status: String,
    expected_total: Decimal,
    expected_amount_paid: Decimal,
    expected_balance: Decimal,
    expected_positive_tender_total: Decimal,
    expected_refunded_tender_total: Decimal,
    expected_net_tender_total: Decimal,
    source_total: Decimal,
    source_fulfilled_at: DateTime<Utc>,
    corrected_total: Decimal,
    corrected_balance: Decimal,
    line_repairs: Vec<ReviewedLineRepair>,
    source_kind: String,
}

#[derive(Debug, Deserialize)]
struct ReviewedManifest {
    lifecycle_repair_manifest_digest: String,
    lifecycle_repair_candidates: Vec<ReviewedCandidate>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
struct HeaderSnapshot {
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    display_id: String,
    status: String,
    counterpoint_doc_ref: Option<String>,
    counterpoint_ticket_ref: Option<String>,
    booked_at: DateTime<Utc>,
    fulfilled_at: Option<DateTime<Utc>>,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    shipping_amount_usd: Decimal,
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
struct AllocationSnapshot {
    allocation_id: Uuid,
    payment_transaction_id: Uuid,
    amount_allocated: Decimal,
    payment_amount: Decimal,
    payment_status: String,
    payment_method: String,
    allocation_metadata: JsonValue,
    payment_metadata: JsonValue,
    payment_created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct PreparedCandidate {
    manifest: ReviewedCandidate,
    header: HeaderSnapshot,
    lines: Vec<LineSnapshot>,
    allocations: Vec<AllocationSnapshot>,
    refund_at: Option<DateTime<Utc>>,
    snapshot: JsonValue,
}

#[derive(Debug)]
struct PreparedManifest {
    source_manifest_digest: String,
    ready: Vec<PreparedCandidate>,
    blocked: Vec<CounterpointHistoricalRefundRepairBlocked>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointHistoricalRefundRepairBlocked {
    pub display_id: String,
    pub manifest_key: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointHistoricalRefundRepairCandidate {
    pub display_id: String,
    pub transaction_id: Uuid,
    pub source_total: String,
    pub refunded_total: String,
    pub corrected_effective_total: String,
    pub amount_paid_unchanged: String,
    pub lines_to_restore: usize,
    pub returned_units_to_record: i32,
}

#[derive(Debug, Serialize)]
pub struct CounterpointHistoricalRefundRepairPreview {
    pub generated_at: DateTime<Utc>,
    pub confirmation_phrase: &'static str,
    pub source_manifest_digest: String,
    pub prepared_manifest_digest: String,
    pub reviewed_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub lines_to_restore: usize,
    pub returned_units_to_record: i32,
    pub payment_amounts_unchanged: bool,
    pub inventory_unchanged: bool,
    pub candidates: Vec<CounterpointHistoricalRefundRepairCandidate>,
    pub blocked: Vec<CounterpointHistoricalRefundRepairBlocked>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointHistoricalRefundRepairApplySummary {
    pub applied_manifest_digest: String,
    pub repaired_transactions: usize,
    pub repaired_lines: usize,
    pub historical_return_lines_created: usize,
    pub historical_return_units_recorded: i32,
    pub payment_amounts_changed: bool,
    pub payment_allocation_amounts_changed: bool,
    pub inventory_changed: bool,
}

fn money(value: Decimal) -> Decimal {
    value.round_dp(2)
}

fn money_string(value: Decimal) -> String {
    format!("{:.2}", money(value))
}

fn invalid(message: impl Into<String>) -> CounterpointSyncError {
    CounterpointSyncError::InvalidPayload(message.into())
}

fn parse_manifest(manifest_json: &JsonValue) -> Result<ReviewedManifest, CounterpointSyncError> {
    let manifest =
        serde_json::from_value::<ReviewedManifest>(manifest_json.clone()).map_err(|error| {
            invalid(format!(
                "reviewed Counterpoint historical-refund manifest is invalid: {error}"
            ))
        })?;
    if manifest.lifecycle_repair_manifest_digest.trim().is_empty() {
        return Err(invalid(
            "reviewed Counterpoint historical-refund manifest digest is blank",
        ));
    }
    if manifest.lifecycle_repair_candidates.is_empty()
        || manifest.lifecycle_repair_candidates.len() > 100
    {
        return Err(invalid(format!(
            "reviewed Counterpoint historical-refund manifest must contain 1 to 100 candidates; received {}",
            manifest.lifecycle_repair_candidates.len()
        )));
    }
    let mut transaction_ids = HashSet::new();
    let mut manifest_keys = HashSet::new();
    for candidate in &manifest.lifecycle_repair_candidates {
        if !transaction_ids.insert(candidate.transaction_id) {
            return Err(invalid(
                "reviewed historical-refund manifest repeats a transaction",
            ));
        }
        if candidate.manifest_key.trim().is_empty()
            || !manifest_keys.insert(candidate.manifest_key.clone())
        {
            return Err(invalid(
                "reviewed historical-refund manifest has a blank or repeated manifest key",
            ));
        }
    }
    Ok(manifest)
}

async fn prepare_candidate(
    tx: &mut Transaction<'_, Postgres>,
    candidate: ReviewedCandidate,
) -> Result<PreparedCandidate, String> {
    if candidate.source_kind != "closed_order_lifecycle" {
        return Err("only exact closed-order lifecycle restorations are supported".to_string());
    }
    if candidate.line_repairs.is_empty() {
        return Err("reviewed restoration has no line repairs".to_string());
    }

    let header = sqlx::query_as::<_, HeaderSnapshot>(
        r#"
        SELECT
            t.id AS transaction_id,
            t.customer_id,
            COALESCE(t.display_id, t.id::text) AS display_id,
            t.status::text AS status,
            t.counterpoint_doc_ref,
            t.counterpoint_ticket_ref,
            t.booked_at,
            t.fulfilled_at,
            ROUND(COALESCE(t.total_price, 0), 2)::numeric AS total_price,
            ROUND(COALESCE(t.amount_paid, 0), 2)::numeric AS amount_paid,
            ROUND(COALESCE(t.balance_due, 0), 2)::numeric AS balance_due,
            ROUND(COALESCE(t.shipping_amount_usd, 0), 2)::numeric AS shipping_amount_usd,
            COALESCE(t.is_counterpoint_import, FALSE) AS is_counterpoint_import
        FROM transactions t
        WHERE t.id = $1
        "#,
    )
    .bind(candidate.transaction_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| format!("could not read current Transaction Record: {error}"))?
    .ok_or_else(|| "current Transaction Record no longer exists".to_string())?;

    if !header.is_counterpoint_import {
        return Err("Transaction Record is not an imported Counterpoint record".to_string());
    }
    if header.display_id != candidate.display_id || header.status != candidate.expected_status {
        return Err("transaction identity or status changed after source review".to_string());
    }
    if !header
        .counterpoint_doc_ref
        .as_deref()
        .is_some_and(|value| value.contains(&candidate.source_doc_id))
    {
        return Err("Counterpoint order source reference changed after review".to_string());
    }
    if header.counterpoint_ticket_ref.is_some() {
        return Err(
            "reviewed closed-order restoration unexpectedly has a ticket reference".to_string(),
        );
    }
    if money(header.total_price) != money(candidate.expected_total)
        || money(header.amount_paid) != money(candidate.expected_amount_paid)
        || money(header.balance_due) != money(candidate.expected_balance)
    {
        return Err(
            "transaction total, paid amount, or balance changed after source review".to_string(),
        );
    }
    if money(header.shipping_amount_usd) != Decimal::ZERO {
        return Err("historical-refund restoration does not support shipping charges".to_string());
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
    .bind(candidate.transaction_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| format!("could not read current transaction lines: {error}"))?;
    if lines.len() != candidate.line_repairs.len() {
        return Err("reviewed restoration no longer covers every transaction line".to_string());
    }
    let lines_by_id = lines
        .iter()
        .map(|line| (line.line_id, line))
        .collect::<HashMap<_, _>>();
    let mut line_ids = HashSet::new();
    let mut source_total = Decimal::ZERO;
    let mut refund_total = Decimal::ZERO;
    let mut returned_units = 0_i32;
    for repair in &candidate.line_repairs {
        if !line_ids.insert(repair.line_id) {
            return Err("reviewed restoration repeats a transaction line".to_string());
        }
        let current = lines_by_id
            .get(&repair.line_id)
            .ok_or_else(|| "a reviewed transaction line no longer exists".to_string())?;
        if current.quantity != repair.expected_quantity
            || money(current.unit_price) != money(repair.expected_unit_price)
            || money(current.discount_amount) != money(repair.expected_discount_amount)
            || money(current.state_tax) != money(repair.expected_state_tax)
            || money(current.local_tax) != money(repair.expected_local_tax)
        {
            return Err("transaction line values changed after source review".to_string());
        }
        if repair.corrected_quantity <= 0
            || repair.returned_quantity < 0
            || repair.returned_quantity > repair.corrected_quantity
            || repair.corrected_quantity < repair.expected_quantity
        {
            return Err("reviewed restoration contains an invalid quantity transition".to_string());
        }
        if !repair.source_evidence.is_object() {
            return Err("reviewed Counterpoint line evidence is missing".to_string());
        }
        let corrected_unit_total = money(
            repair.corrected_unit_price + repair.corrected_state_tax + repair.corrected_local_tax,
        );
        if money(repair.refund_subtotal)
            != money(repair.corrected_unit_price * Decimal::from(repair.returned_quantity))
            || money(repair.refund_state_tax)
                != money(repair.corrected_state_tax * Decimal::from(repair.returned_quantity))
            || money(repair.refund_local_tax)
                != money(repair.corrected_local_tax * Decimal::from(repair.returned_quantity))
            || money(repair.refund_total)
                != money(corrected_unit_total * Decimal::from(repair.returned_quantity))
        {
            return Err(
                "reviewed return components do not match the corrected paid price".to_string(),
            );
        }
        source_total += corrected_unit_total * Decimal::from(repair.corrected_quantity);
        refund_total += repair.refund_total;
        returned_units += repair.returned_quantity;
    }
    if money(source_total) != money(candidate.source_total)
        || money(refund_total) != money(candidate.expected_refunded_tender_total)
        || money(source_total - refund_total) != money(candidate.corrected_total)
        || money(candidate.corrected_total) != money(candidate.expected_amount_paid)
        || money(candidate.corrected_balance) != Decimal::ZERO
    {
        return Err(
            "reviewed gross sale, refund, paid amount, and effective total do not reconcile"
                .to_string(),
        );
    }

    let existing_return_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM transaction_return_lines WHERE transaction_id = $1",
    )
    .bind(candidate.transaction_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| format!("could not verify current return history: {error}"))?;
    if existing_return_count != 0 {
        return Err("transaction already has return-line history".to_string());
    }
    let existing_repair_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM transaction_activity_log
        WHERE transaction_id = $1
          AND event_kind = 'counterpoint_historical_refund_restoration'
        "#,
    )
    .bind(candidate.transaction_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| format!("could not verify prior restoration audit: {error}"))?;
    if existing_repair_count != 0 {
        return Err("transaction already has a historical-refund restoration audit".to_string());
    }

    let allocations = sqlx::query_as::<_, AllocationSnapshot>(
        r#"
        SELECT
            pa.id AS allocation_id,
            pt.id AS payment_transaction_id,
            ROUND(COALESCE(pa.amount_allocated, 0), 2)::numeric AS amount_allocated,
            ROUND(COALESCE(pt.amount, 0), 2)::numeric AS payment_amount,
            pt.status::text AS payment_status,
            pt.payment_method,
            COALESCE(pa.metadata, '{}'::jsonb) AS allocation_metadata,
            COALESCE(pt.metadata, '{}'::jsonb) AS payment_metadata,
            pt.created_at AS payment_created_at
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
        ORDER BY pt.created_at, pa.id
        "#,
    )
    .bind(candidate.transaction_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| format!("could not read payment allocation evidence: {error}"))?;
    if allocations
        .iter()
        .any(|allocation| allocation.payment_status != "success")
    {
        return Err("reviewed restoration has a non-success payment allocation".to_string());
    }
    let positive_tender = allocations
        .iter()
        .filter(|allocation| allocation.amount_allocated > Decimal::ZERO)
        .fold(Decimal::ZERO, |sum, allocation| {
            sum + allocation.amount_allocated
        });
    let refunded_tender = allocations
        .iter()
        .filter(|allocation| allocation.amount_allocated < Decimal::ZERO)
        .fold(Decimal::ZERO, |sum, allocation| {
            sum - allocation.amount_allocated
        });
    let net_tender = allocations.iter().fold(Decimal::ZERO, |sum, allocation| {
        sum + allocation.amount_allocated
    });
    if money(positive_tender) != money(candidate.expected_positive_tender_total)
        || money(refunded_tender) != money(candidate.expected_refunded_tender_total)
        || money(net_tender) != money(candidate.expected_net_tender_total)
        || money(net_tender) != money(candidate.expected_amount_paid)
        || money(positive_tender) != money(candidate.source_total)
    {
        return Err("payment allocation evidence changed or no longer reconciles".to_string());
    }
    if (returned_units > 0) != (refunded_tender > Decimal::ZERO) {
        return Err(
            "returned quantities and negative payment allocations do not agree".to_string(),
        );
    }
    let negative_payment_ids = allocations
        .iter()
        .filter(|allocation| allocation.amount_allocated < Decimal::ZERO)
        .map(|allocation| allocation.payment_transaction_id)
        .collect::<HashSet<_>>();
    if !negative_payment_ids.is_empty() {
        let negative_payment_ids = negative_payment_ids.into_iter().collect::<Vec<_>>();
        let unrelated_allocation_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM payment_allocations
            WHERE transaction_id = ANY($1)
              AND (
                    target_transaction_id <> $2
                    OR amount_allocated >= 0
                  )
            "#,
        )
        .bind(&negative_payment_ids)
        .bind(candidate.transaction_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|error| {
            format!("could not verify historical refund payment ownership: {error}")
        })?;
        if unrelated_allocation_count != 0 {
            return Err(
                "a historical refund payment is shared with another allocation".to_string(),
            );
        }
    }
    let refund_at = allocations
        .iter()
        .filter(|allocation| allocation.amount_allocated < Decimal::ZERO)
        .map(|allocation| allocation.payment_created_at)
        .max();

    let snapshot = json!({
        "manifest": candidate,
        "current_transaction": header,
        "current_lines": lines,
        "current_payment_allocations": allocations,
        "source_total": money_string(source_total),
        "historical_refund_total": money_string(refund_total),
        "returned_units_to_record": returned_units,
        "refund_at": refund_at,
        "payment_amounts_unchanged": true,
        "payment_allocation_amounts_unchanged": true,
        "inventory_unchanged": true,
    });
    Ok(PreparedCandidate {
        manifest: candidate,
        header,
        lines,
        allocations,
        refund_at,
        snapshot,
    })
}

async fn prepare_manifest(
    tx: &mut Transaction<'_, Postgres>,
    manifest: ReviewedManifest,
) -> Result<PreparedManifest, CounterpointSyncError> {
    let mut ready = Vec::new();
    let mut blocked = Vec::new();
    for candidate in manifest.lifecycle_repair_candidates {
        match prepare_candidate(tx, candidate.clone()).await {
            Ok(prepared) => ready.push(prepared),
            Err(reason) => blocked.push(CounterpointHistoricalRefundRepairBlocked {
                display_id: candidate.display_id,
                manifest_key: candidate.manifest_key,
                reason,
            }),
        }
    }
    Ok(PreparedManifest {
        source_manifest_digest: manifest.lifecycle_repair_manifest_digest,
        ready,
        blocked,
    })
}

fn prepared_digest(candidates: &[PreparedCandidate]) -> Result<String, CounterpointSyncError> {
    let snapshots = candidates
        .iter()
        .map(|candidate| &candidate.snapshot)
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&snapshots).map_err(|error| {
        invalid(format!(
            "could not serialize prepared repair evidence: {error}"
        ))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub async fn preview_counterpoint_historical_refund_repairs(
    pool: &PgPool,
    manifest_json: &JsonValue,
) -> Result<CounterpointHistoricalRefundRepairPreview, CounterpointSyncError> {
    let manifest = parse_manifest(manifest_json)?;
    let reviewed_count = manifest.lifecycle_repair_candidates.len();
    let mut tx = pool.begin().await?;
    let prepared = prepare_manifest(&mut tx, manifest).await?;
    tx.rollback().await?;
    let digest = prepared_digest(&prepared.ready)?;
    let lines_to_restore = prepared
        .ready
        .iter()
        .map(|candidate| candidate.manifest.line_repairs.len())
        .sum();
    let returned_units_to_record = prepared
        .ready
        .iter()
        .flat_map(|candidate| &candidate.manifest.line_repairs)
        .map(|line| line.returned_quantity)
        .sum();
    let candidates = prepared
        .ready
        .iter()
        .map(|candidate| CounterpointHistoricalRefundRepairCandidate {
            display_id: candidate.manifest.display_id.clone(),
            transaction_id: candidate.manifest.transaction_id,
            source_total: money_string(candidate.manifest.source_total),
            refunded_total: money_string(candidate.manifest.expected_refunded_tender_total),
            corrected_effective_total: money_string(candidate.manifest.corrected_total),
            amount_paid_unchanged: money_string(candidate.manifest.expected_amount_paid),
            lines_to_restore: candidate.manifest.line_repairs.len(),
            returned_units_to_record: candidate
                .manifest
                .line_repairs
                .iter()
                .map(|line| line.returned_quantity)
                .sum(),
        })
        .collect();
    Ok(CounterpointHistoricalRefundRepairPreview {
        generated_at: Utc::now(),
        confirmation_phrase: COUNTERPOINT_HISTORICAL_REFUND_REPAIR_CONFIRMATION,
        source_manifest_digest: prepared.source_manifest_digest,
        prepared_manifest_digest: digest,
        reviewed_count,
        ready_count: prepared.ready.len(),
        blocked_count: prepared.blocked.len(),
        lines_to_restore,
        returned_units_to_record,
        payment_amounts_unchanged: true,
        inventory_unchanged: true,
        candidates,
        blocked: prepared.blocked,
    })
}

pub async fn apply_counterpoint_historical_refund_repairs(
    pool: &PgPool,
    manifest_json: &JsonValue,
    repaired_by_staff_id: Uuid,
    confirmation: &str,
    reason: &str,
    expected_manifest_digest: &str,
    expected_candidate_count: usize,
) -> Result<CounterpointHistoricalRefundRepairApplySummary, CounterpointSyncError> {
    if confirmation.trim() != COUNTERPOINT_HISTORICAL_REFUND_REPAIR_CONFIRMATION {
        return Err(invalid(
            "Counterpoint historical-refund repair confirmation phrase did not match",
        ));
    }
    if reason.trim().len() < 12 {
        return Err(invalid("repair reason must be at least 12 characters"));
    }
    let manifest = parse_manifest(manifest_json)?;
    let transaction_ids = manifest
        .lifecycle_repair_candidates
        .iter()
        .map(|candidate| candidate.transaction_id)
        .collect::<Vec<_>>();

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('counterpoint_historical_refund_repair'))")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM transactions WHERE id = ANY($1) FOR UPDATE")
        .bind(&transaction_ids)
        .fetch_all(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM transaction_lines WHERE transaction_id = ANY($1) FOR UPDATE")
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
    sqlx::query(
        "SELECT id FROM payment_allocations WHERE target_transaction_id = ANY($1) FOR UPDATE",
    )
    .bind(&transaction_ids)
    .fetch_all(&mut *tx)
    .await?;

    let prepared = prepare_manifest(&mut tx, manifest).await?;
    if !prepared.blocked.is_empty() {
        return Err(invalid(format!(
            "{} historical-refund candidate(s) changed or require review; no changes were committed",
            prepared.blocked.len()
        )));
    }
    let current_digest = prepared_digest(&prepared.ready)?;
    if prepared.ready.len() != expected_candidate_count
        || current_digest != expected_manifest_digest.trim()
    {
        return Err(invalid(format!(
            "historical-refund manifest changed after review (reviewed {} candidate(s), current {}); no changes were committed",
            expected_candidate_count,
            prepared.ready.len()
        )));
    }

    sqlx::query("SET LOCAL riverside.suppress_booking_event = 'true'")
        .execute(&mut *tx)
        .await?;

    let mut repaired_transactions = 0_usize;
    let mut repaired_lines = 0_usize;
    let mut return_lines_created = 0_usize;
    let mut return_units_recorded = 0_i32;
    for candidate in prepared.ready {
        let refund_event_id =
            (candidate.manifest.expected_refunded_tender_total > Decimal::ZERO).then(Uuid::new_v4);
        let refund_at = candidate
            .refund_at
            .unwrap_or(candidate.manifest.source_fulfilled_at);
        let current_lines = candidate
            .lines
            .iter()
            .map(|line| (line.line_id, line))
            .collect::<HashMap<_, _>>();

        for line in &candidate.manifest.line_repairs {
            let current = current_lines
                .get(&line.line_id)
                .expect("prepared line snapshot must exist");
            let update = sqlx::query(
                r#"
                UPDATE transaction_lines tl
                SET quantity = $3,
                    unit_price = $4,
                    discount_amount = $5,
                    state_tax = $6,
                    local_tax = $7,
                    is_fulfilled = TRUE,
                    fulfilled_at = COALESCE(tl.fulfilled_at, $8),
                    order_lifecycle_status = 'picked_up'::order_item_lifecycle_status,
                    picked_up_at = COALESCE(tl.picked_up_at, $8),
                    size_specs = COALESCE(tl.size_specs, '{}'::jsonb)
                        || jsonb_build_object(
                            'counterpoint_historical_refund_restoration',
                            jsonb_build_object(
                                'manifest_key', $9::text,
                                'source_doc_id', $10::text,
                                'source_evidence', $11::jsonb,
                                'expected_quantity', $12::integer,
                                'corrected_quantity', $3::integer,
                                'historical_returned_quantity', $13::integer
                            )
                        )
                WHERE tl.id = $1
                  AND tl.transaction_id = $2
                  AND tl.quantity = $12
                  AND ROUND(COALESCE(tl.unit_price, 0), 2) = $14
                  AND ROUND(COALESCE(tl.discount_amount, 0), 2) = $15
                  AND ROUND(COALESCE(tl.state_tax, 0), 2) = $16
                  AND ROUND(COALESCE(tl.local_tax, 0), 2) = $17
                "#,
            )
            .bind(line.line_id)
            .bind(candidate.manifest.transaction_id)
            .bind(line.corrected_quantity)
            .bind(money(line.corrected_unit_price))
            .bind(money(line.corrected_discount_amount))
            .bind(money(line.corrected_state_tax))
            .bind(money(line.corrected_local_tax))
            .bind(candidate.manifest.source_fulfilled_at)
            .bind(&candidate.manifest.manifest_key)
            .bind(&candidate.manifest.source_doc_id)
            .bind(&line.source_evidence)
            .bind(line.expected_quantity)
            .bind(line.returned_quantity)
            .bind(money(line.expected_unit_price))
            .bind(money(line.expected_discount_amount))
            .bind(money(line.expected_state_tax))
            .bind(money(line.expected_local_tax))
            .execute(&mut *tx)
            .await?;
            if update.rows_affected() != 1 {
                return Err(invalid(format!(
                    "{} line values changed after review; no changes were committed",
                    candidate.manifest.display_id
                )));
            }
            repaired_lines += 1;

            if !current.is_fulfilled || current.order_lifecycle_status != "picked_up" {
                sqlx::query(
                    r#"
                    INSERT INTO transaction_line_lifecycle_events (
                        transaction_line_id, old_status, new_status, actor_staff_id,
                        source_workflow, reason, metadata
                    )
                    VALUES (
                        $1, $2::order_item_lifecycle_status,
                        'picked_up'::order_item_lifecycle_status, $3,
                        'counterpoint_historical_refund_restoration', $4,
                        jsonb_build_object(
                            'manifest_key', $5::text,
                            'source_doc_id', $6::text,
                            'source_fulfilled_at', $7::text
                        )
                    )
                    "#,
                )
                .bind(line.line_id)
                .bind(&current.order_lifecycle_status)
                .bind(repaired_by_staff_id)
                .bind(reason.trim())
                .bind(&candidate.manifest.manifest_key)
                .bind(&candidate.manifest.source_doc_id)
                .bind(candidate.manifest.source_fulfilled_at.to_rfc3339())
                .execute(&mut *tx)
                .await?;
            }

            if line.returned_quantity > 0 {
                sqlx::query(
                    r#"
                    INSERT INTO transaction_return_lines (
                        transaction_id, transaction_line_id, quantity_returned,
                        reason, restocked, staff_id, created_at, refund_event_id,
                        refund_subtotal, refund_state_tax, refund_local_tax, refund_total
                    )
                    VALUES (
                        $1, $2, $3,
                        'Counterpoint historical refund restoration', FALSE, $4, $5, $6,
                        $7, $8, $9, $10
                    )
                    "#,
                )
                .bind(candidate.manifest.transaction_id)
                .bind(line.line_id)
                .bind(line.returned_quantity)
                .bind(repaired_by_staff_id)
                .bind(refund_at)
                .bind(refund_event_id)
                .bind(money(line.refund_subtotal))
                .bind(money(line.refund_state_tax))
                .bind(money(line.refund_local_tax))
                .bind(money(line.refund_total))
                .execute(&mut *tx)
                .await?;
                return_lines_created += 1;
                return_units_recorded += line.returned_quantity;
            }
        }

        if let Some(event_id) = refund_event_id {
            let expected_refund_allocations = candidate
                .allocations
                .iter()
                .filter(|allocation| allocation.amount_allocated < Decimal::ZERO)
                .count() as u64;
            let refund_payment_ids = candidate
                .allocations
                .iter()
                .filter(|allocation| allocation.amount_allocated < Decimal::ZERO)
                .map(|allocation| allocation.payment_transaction_id)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let updated_payments = sqlx::query(
                r#"
                UPDATE payment_transactions
                SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                        'kind', 'legacy_migration_refund',
                        'refund_event_id', $2::text,
                        'counterpoint_historical_refund_manifest_key', $3::text
                    )
                WHERE id = ANY($1)
                "#,
            )
            .bind(&refund_payment_ids)
            .bind(event_id)
            .bind(&candidate.manifest.manifest_key)
            .execute(&mut *tx)
            .await?;
            if updated_payments.rows_affected() != refund_payment_ids.len() as u64 {
                return Err(invalid(format!(
                    "{} refund payment count changed after review; no changes were committed",
                    candidate.manifest.display_id
                )));
            }
            let updated_allocations = sqlx::query(
                r#"
                UPDATE payment_allocations
                SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                        'kind', 'legacy_migration_refund',
                        'refund_event_id', $2::text,
                        'counterpoint_historical_refund_manifest_key', $3::text
                    )
                WHERE target_transaction_id = $1
                  AND amount_allocated < 0
                "#,
            )
            .bind(candidate.manifest.transaction_id)
            .bind(event_id)
            .bind(&candidate.manifest.manifest_key)
            .execute(&mut *tx)
            .await?;
            if updated_allocations.rows_affected() != expected_refund_allocations {
                return Err(invalid(format!(
                    "{} refund allocation count changed after review; no changes were committed",
                    candidate.manifest.display_id
                )));
            }
        }

        let updated_transaction = sqlx::query(
            r#"
            UPDATE transactions
            SET fulfilled_at = COALESCE(fulfilled_at, $3),
                metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                        'counterpoint_historical_refund_restoration',
                        jsonb_build_object(
                            'manifest_key', $4::text,
                            'source_doc_id', $5::text,
                            'source_total', $6::text,
                            'historical_refund_total', $7::text,
                            'source_fulfilled_at', $8::text
                        )
                    )
            WHERE id = $1
              AND display_id = $2
              AND ROUND(COALESCE(total_price, 0), 2) = $9
              AND ROUND(COALESCE(amount_paid, 0), 2) = $10
              AND ROUND(COALESCE(balance_due, 0), 2) = $11
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .bind(&candidate.manifest.display_id)
        .bind(candidate.manifest.source_fulfilled_at)
        .bind(&candidate.manifest.manifest_key)
        .bind(&candidate.manifest.source_doc_id)
        .bind(money_string(candidate.manifest.source_total))
        .bind(money_string(
            candidate.manifest.expected_refunded_tender_total,
        ))
        .bind(candidate.manifest.source_fulfilled_at.to_rfc3339())
        .bind(money(candidate.manifest.expected_total))
        .bind(money(candidate.manifest.expected_amount_paid))
        .bind(money(candidate.manifest.expected_balance))
        .execute(&mut *tx)
        .await?;
        if updated_transaction.rows_affected() != 1 {
            return Err(invalid(format!(
                "{} transaction values changed after review; no changes were committed",
                candidate.manifest.display_id
            )));
        }

        recalc_transaction_totals(&mut tx, candidate.manifest.transaction_id).await?;
        let repaired_header: (String, Decimal, Decimal, Decimal) = sqlx::query_as(
            r#"
            SELECT status::text,
                   ROUND(COALESCE(total_price, 0), 2)::numeric,
                   ROUND(COALESCE(amount_paid, 0), 2)::numeric,
                   ROUND(COALESCE(balance_due, 0), 2)::numeric
            FROM transactions
            WHERE id = $1
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .fetch_one(&mut *tx)
        .await?;
        if repaired_header.0 != "fulfilled"
            || money(repaired_header.1) != money(candidate.manifest.corrected_total)
            || money(repaired_header.2) != money(candidate.manifest.expected_amount_paid)
            || money(repaired_header.3) != money(candidate.manifest.corrected_balance)
        {
            return Err(invalid(format!(
                "{} did not reconcile to the reviewed effective total and zero balance; no changes were committed",
                candidate.manifest.display_id
            )));
        }
        let repaired_allocations = sqlx::query_as::<_, AllocationSnapshot>(
            r#"
            SELECT
                pa.id AS allocation_id,
                pt.id AS payment_transaction_id,
                ROUND(COALESCE(pa.amount_allocated, 0), 2)::numeric AS amount_allocated,
                ROUND(COALESCE(pt.amount, 0), 2)::numeric AS payment_amount,
                pt.status::text AS payment_status,
                pt.payment_method,
                COALESCE(pa.metadata, '{}'::jsonb) AS allocation_metadata,
                COALESCE(pt.metadata, '{}'::jsonb) AS payment_metadata,
                pt.created_at AS payment_created_at
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pa.target_transaction_id = $1
            ORDER BY pt.created_at, pa.id
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .fetch_all(&mut *tx)
        .await?;
        let payments_unchanged = repaired_allocations.len() == candidate.allocations.len()
            && repaired_allocations.iter().zip(&candidate.allocations).all(
                |(repaired, original)| {
                    repaired.allocation_id == original.allocation_id
                        && repaired.payment_transaction_id == original.payment_transaction_id
                        && money(repaired.amount_allocated) == money(original.amount_allocated)
                        && money(repaired.payment_amount) == money(original.payment_amount)
                        && repaired.payment_status == original.payment_status
                        && repaired.payment_method == original.payment_method
                        && repaired.payment_created_at == original.payment_created_at
                },
            );
        if !payments_unchanged {
            return Err(invalid(format!(
                "{} payment amounts or allocations changed during repair; no changes were committed",
                candidate.manifest.display_id
            )));
        }

        sqlx::query(
            r#"
            INSERT INTO transaction_activity_log (
                transaction_id, customer_id, event_kind, summary, metadata
            )
            VALUES (
                $1, $2, 'counterpoint_historical_refund_restoration',
                'Restored the original Counterpoint sale and attached its historical refund without changing payment amounts or inventory.',
                jsonb_build_object(
                    'repaired_by_staff_id', $3::text,
                    'reason', $4::text,
                    'prepared_manifest_digest', $5::text,
                    'source_snapshot', $6::jsonb,
                    'result', jsonb_build_object(
                        'source_total', $7::text,
                        'historical_refund_total', $8::text,
                        'effective_total', $9::text,
                        'amount_paid_unchanged', $10::text,
                        'balance', $11::text,
                        'refund_event_id', $12::text,
                        'payment_amounts_changed', FALSE,
                        'payment_allocation_amounts_changed', FALSE,
                        'inventory_changed', FALSE
                    )
                )
            )
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .bind(candidate.header.customer_id)
        .bind(repaired_by_staff_id)
        .bind(reason.trim())
        .bind(&current_digest)
        .bind(&candidate.snapshot)
        .bind(money_string(candidate.manifest.source_total))
        .bind(money_string(
            candidate.manifest.expected_refunded_tender_total,
        ))
        .bind(money_string(candidate.manifest.corrected_total))
        .bind(money_string(candidate.manifest.expected_amount_paid))
        .bind(money_string(candidate.manifest.corrected_balance))
        .bind(refund_event_id.map(|value| value.to_string()))
        .execute(&mut *tx)
        .await?;
        super::counterpoint_return_safety::resolve_counterpoint_return_review_block(
            &mut tx,
            candidate.manifest.transaction_id,
            repaired_by_staff_id,
            "Resolved by exact reviewed Counterpoint historical-refund restoration",
        )
        .await?;
        repaired_transactions += 1;
    }

    let result_json = json!({
        "repaired_transactions": repaired_transactions,
        "repaired_lines": repaired_lines,
        "historical_return_lines_created": return_lines_created,
        "historical_return_units_recorded": return_units_recorded,
        "payment_amounts_changed": false,
        "payment_allocation_amounts_changed": false,
        "inventory_changed": false,
    });
    sqlx::query(
        r#"
        INSERT INTO ops_action_audit (
            actor_staff_id, action_key, reason, payload_json,
            payload_hash_sha256, result_ok, result_message, result_json
        )
        VALUES (
            $1, 'counterpoint_historical_refund_restoration', $2,
            jsonb_build_object(
                'source_manifest_digest', $3::text,
                'prepared_manifest_digest', $4::text,
                'candidate_count', $5::integer
            ),
            $4, TRUE,
            'Restored exact Counterpoint historical sale quantities and refund evidence.',
            $6
        )
        "#,
    )
    .bind(repaired_by_staff_id)
    .bind(reason.trim())
    .bind(&prepared.source_manifest_digest)
    .bind(&current_digest)
    .bind(i32::try_from(expected_candidate_count).unwrap_or(i32::MAX))
    .bind(&result_json)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(CounterpointHistoricalRefundRepairApplySummary {
        applied_manifest_digest: current_digest,
        repaired_transactions,
        repaired_lines,
        historical_return_lines_created: return_lines_created,
        historical_return_units_recorded: return_units_recorded,
        payment_amounts_changed: false,
        payment_allocation_amounts_changed: false,
        inventory_changed: false,
    })
}
