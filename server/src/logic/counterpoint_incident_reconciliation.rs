use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::logic::counterpoint_sync::CounterpointSyncError;

pub const COUNTERPOINT_INCIDENT_RECONCILIATION_CONFIRMATION: &str =
    "RECONCILE JULY 21 COUNTERPOINT RECORDS";

#[derive(Debug, Clone, Deserialize, Serialize)]
struct LineRepair {
    line_id: Uuid,
    expected_quantity: i32,
    expected_unit_price: Decimal,
    expected_discount_amount: Decimal,
    expected_state_tax: Decimal,
    expected_local_tax: Decimal,
    expected_is_fulfilled: bool,
    corrected_quantity: i32,
    corrected_unit_price: Decimal,
    corrected_discount_amount: Decimal,
    corrected_state_tax: Decimal,
    corrected_local_tax: Decimal,
    corrected_is_fulfilled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct PaymentRemoval {
    allocation_id: Uuid,
    payment_id: Uuid,
    expected_amount: Decimal,
    reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct LineClone {
    source_line_id: Uuid,
    new_line_id: Uuid,
    quantity: i32,
    unit_price: Decimal,
    discount_amount: Decimal,
    state_tax: Decimal,
    local_tax: Decimal,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ReconciliationCandidate {
    transaction_id: Uuid,
    display_id: String,
    source_doc_id: String,
    expected_total: Decimal,
    expected_amount_paid: Decimal,
    expected_balance: Decimal,
    expected_allocation_total: Decimal,
    corrected_total: Decimal,
    corrected_amount_paid: Decimal,
    corrected_balance: Decimal,
    source_fulfilled_at: DateTime<Utc>,
    line_repairs: Vec<LineRepair>,
    payment_removals: Vec<PaymentRemoval>,
    line_clones: Vec<LineClone>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ReconciliationManifest {
    incident_key: String,
    source_review_sha256: String,
    candidates: Vec<ReconciliationCandidate>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
struct HeaderSnapshot {
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    display_id: String,
    status: String,
    counterpoint_doc_ref: Option<String>,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    fulfilled_at: Option<DateTime<Utc>>,
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
    payment_id: Uuid,
    amount_allocated: Decimal,
    payment_amount: Decimal,
    payment_method: String,
    payment_status: String,
    provider_payment_id: Option<String>,
    provider_transaction_id: Option<String>,
    payment_metadata: JsonValue,
}

#[derive(Debug, Clone)]
struct PreparedCandidate {
    manifest: ReconciliationCandidate,
    before_snapshot: JsonValue,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIncidentReconciliationPreviewRow {
    pub display_id: String,
    pub corrected_total: String,
    pub corrected_amount_paid: String,
    pub corrected_balance: String,
    pub line_rows_to_update: usize,
    pub imported_payment_rows_to_remove: usize,
    pub derived_tax_rows_to_add: usize,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIncidentReconciliationPreview {
    pub generated_at: DateTime<Utc>,
    pub confirmation_phrase: &'static str,
    pub manifest_digest: String,
    pub incident_key: String,
    pub candidate_count: usize,
    pub inventory_unchanged: bool,
    pub provider_payments_unchanged: bool,
    pub rows: Vec<CounterpointIncidentReconciliationPreviewRow>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIncidentReconciliationApplySummary {
    pub applied_manifest_digest: String,
    pub reconciled_transactions: usize,
    pub line_rows_updated: usize,
    pub derived_tax_rows_added: usize,
    pub imported_payment_rows_removed: usize,
    pub provider_payments_changed: bool,
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

fn manifest_digest(manifest: &ReconciliationManifest) -> Result<String, CounterpointSyncError> {
    let bytes = serde_json::to_vec(manifest).map_err(|error| {
        invalid(format!(
            "could not serialize Counterpoint incident manifest: {error}"
        ))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn parse_manifest(value: &JsonValue) -> Result<ReconciliationManifest, CounterpointSyncError> {
    let manifest =
        serde_json::from_value::<ReconciliationManifest>(value.clone()).map_err(|error| {
            invalid(format!(
                "Counterpoint incident manifest is invalid: {error}"
            ))
        })?;
    if manifest.incident_key.trim().is_empty()
        || !manifest
            .source_review_sha256
            .chars()
            .all(|value| value.is_ascii_hexdigit())
        || manifest.source_review_sha256.len() != 64
        || manifest.candidates.is_empty()
        || manifest.candidates.len() > 20
    {
        return Err(invalid(
            "Counterpoint incident manifest identity, source digest, or candidate count is invalid",
        ));
    }
    let mut transaction_ids = HashSet::new();
    let mut display_ids = HashSet::new();
    let mut payment_ids = HashSet::new();
    let mut allocation_ids = HashSet::new();
    let mut line_ids = HashSet::new();
    for candidate in &manifest.candidates {
        if !transaction_ids.insert(candidate.transaction_id)
            || !display_ids.insert(candidate.display_id.clone())
            || candidate.source_doc_id.trim().is_empty()
            || money(candidate.corrected_balance) != Decimal::ZERO
            || money(candidate.corrected_total) != money(candidate.corrected_amount_paid)
        {
            return Err(invalid(
                "Counterpoint incident manifest repeats a record or does not close exactly",
            ));
        }
        for line in &candidate.line_repairs {
            if !line_ids.insert(line.line_id)
                || line.corrected_quantity < 0
                || !line.corrected_is_fulfilled
            {
                return Err(invalid(
                    "Counterpoint incident manifest repeats or invalidates a line repair",
                ));
            }
        }
        for removal in &candidate.payment_removals {
            if !payment_ids.insert(removal.payment_id)
                || !allocation_ids.insert(removal.allocation_id)
                || !matches!(
                    removal.reason.as_str(),
                    "counterpoint_release_transfer_offset"
                        | "counterpoint_tender_duplicated_by_verified_provider_payment"
                )
            {
                return Err(invalid(
                    "Counterpoint incident manifest repeats or misclassifies a payment removal",
                ));
            }
        }
        for clone in &candidate.line_clones {
            if clone.quantity <= 0 || !line_ids.insert(clone.new_line_id) {
                return Err(invalid(
                    "Counterpoint incident manifest has an invalid derived tax line",
                ));
            }
        }
    }
    Ok(manifest)
}

async fn prepare_candidate(
    tx: &mut Transaction<'_, Postgres>,
    candidate: ReconciliationCandidate,
) -> Result<PreparedCandidate, CounterpointSyncError> {
    let header = sqlx::query_as::<_, HeaderSnapshot>(
        r#"
        SELECT
            id AS transaction_id,
            customer_id,
            display_id,
            status::text AS status,
            counterpoint_doc_ref,
            ROUND(COALESCE(total_price, 0), 2)::numeric AS total_price,
            ROUND(COALESCE(amount_paid, 0), 2)::numeric AS amount_paid,
            ROUND(COALESCE(balance_due, 0), 2)::numeric AS balance_due,
            fulfilled_at,
            COALESCE(is_counterpoint_import, FALSE) AS is_counterpoint_import
        FROM transactions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(candidate.transaction_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| invalid(format!("{} no longer exists", candidate.display_id)))?;
    if !header.is_counterpoint_import
        || header.display_id != candidate.display_id
        || !header
            .counterpoint_doc_ref
            .as_deref()
            .is_some_and(|value| value.contains(&candidate.source_doc_id))
        || header.status != "open"
        || money(header.total_price) != money(candidate.expected_total)
        || money(header.amount_paid) != money(candidate.expected_amount_paid)
        || money(header.balance_due) != money(candidate.expected_balance)
    {
        return Err(invalid(format!(
            "{} header changed after source review; no changes were committed",
            candidate.display_id
        )));
    }

    let lines = sqlx::query_as::<_, LineSnapshot>(
        r#"
        SELECT
            id AS line_id,
            quantity,
            ROUND(COALESCE(unit_price, 0), 2)::numeric AS unit_price,
            ROUND(COALESCE(discount_amount, 0), 2)::numeric AS discount_amount,
            ROUND(COALESCE(state_tax, 0), 2)::numeric AS state_tax,
            ROUND(COALESCE(local_tax, 0), 2)::numeric AS local_tax,
            COALESCE(is_fulfilled, FALSE) AS is_fulfilled,
            order_lifecycle_status::text AS order_lifecycle_status,
            fulfilled_at
        FROM transaction_lines
        WHERE transaction_id = $1
        ORDER BY id
        FOR UPDATE
        "#,
    )
    .bind(candidate.transaction_id)
    .fetch_all(&mut **tx)
    .await?;
    let lines_by_id = lines
        .iter()
        .map(|line| (line.line_id, line))
        .collect::<HashMap<_, _>>();
    for repair in &candidate.line_repairs {
        let current = lines_by_id.get(&repair.line_id).ok_or_else(|| {
            invalid(format!(
                "{} reviewed line no longer exists",
                candidate.display_id
            ))
        })?;
        if current.quantity != repair.expected_quantity
            || money(current.unit_price) != money(repair.expected_unit_price)
            || money(current.discount_amount) != money(repair.expected_discount_amount)
            || money(current.state_tax) != money(repair.expected_state_tax)
            || money(current.local_tax) != money(repair.expected_local_tax)
            || current.is_fulfilled != repair.expected_is_fulfilled
        {
            return Err(invalid(format!(
                "{} line evidence changed after source review; no changes were committed",
                candidate.display_id
            )));
        }
    }
    for clone in &candidate.line_clones {
        if !lines_by_id.contains_key(&clone.source_line_id)
            || lines_by_id.contains_key(&clone.new_line_id)
        {
            return Err(invalid(format!(
                "{} derived tax-line evidence changed",
                candidate.display_id
            )));
        }
    }

    let payments = sqlx::query_as::<_, PaymentSnapshot>(
        r#"
        SELECT
            pa.id AS allocation_id,
            pt.id AS payment_id,
            ROUND(COALESCE(pa.amount_allocated, 0), 2)::numeric AS amount_allocated,
            ROUND(COALESCE(pt.amount, 0), 2)::numeric AS payment_amount,
            pt.payment_method,
            pt.status AS payment_status,
            pt.provider_payment_id,
            pt.provider_transaction_id,
            COALESCE(pt.metadata, '{}'::jsonb) AS payment_metadata
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
        ORDER BY pa.id
        FOR UPDATE OF pa, pt
        "#,
    )
    .bind(candidate.transaction_id)
    .fetch_all(&mut **tx)
    .await?;
    let allocation_total = payments
        .iter()
        .fold(Decimal::ZERO, |sum, payment| sum + payment.amount_allocated);
    if money(allocation_total) != money(candidate.expected_allocation_total) {
        return Err(invalid(format!(
            "{} payment allocation total changed after source review",
            candidate.display_id
        )));
    }
    let payments_by_allocation = payments
        .iter()
        .map(|payment| (payment.allocation_id, payment))
        .collect::<HashMap<_, _>>();
    let removal_payment_ids = candidate
        .payment_removals
        .iter()
        .map(|removal| removal.payment_id)
        .collect::<HashSet<_>>();
    let mut removed_total = Decimal::ZERO;
    for removal in &candidate.payment_removals {
        let payment = payments_by_allocation
            .get(&removal.allocation_id)
            .ok_or_else(|| {
                invalid(format!(
                    "{} reviewed imported payment no longer exists",
                    candidate.display_id
                ))
            })?;
        if payment.payment_id != removal.payment_id
            || money(payment.amount_allocated) != money(removal.expected_amount)
            || money(payment.payment_amount) != money(removal.expected_amount)
            || payment.payment_status != "success"
            || payment.provider_payment_id.is_some()
            || payment.provider_transaction_id.is_some()
            || !payment
                .payment_metadata
                .get("counterpoint_doc_ref")
                .and_then(JsonValue::as_str)
                .is_some_and(|value| value.contains(&candidate.source_doc_id))
        {
            return Err(invalid(format!(
                "{} imported payment removal evidence changed",
                candidate.display_id
            )));
        }
        match removal.reason.as_str() {
            "counterpoint_release_transfer_offset" => {
                if payment.amount_allocated >= Decimal::ZERO
                    || payment.payment_method != "counterpoint_unmapped"
                    || payment
                        .payment_metadata
                        .get("counterpoint_pmt_typ")
                        .and_then(JsonValue::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                {
                    return Err(invalid(format!(
                        "{} row is not an unclassified Counterpoint transfer offset",
                        candidate.display_id
                    )));
                }
            }
            "counterpoint_tender_duplicated_by_verified_provider_payment" => {
                let has_provider_replacement = payments.iter().any(|candidate_payment| {
                    !removal_payment_ids.contains(&candidate_payment.payment_id)
                        && candidate_payment.amount_allocated == payment.amount_allocated
                        && candidate_payment.provider_transaction_id.is_some()
                });
                if payment.amount_allocated <= Decimal::ZERO || !has_provider_replacement {
                    return Err(invalid(format!(
                        "{} duplicate imported tender lacks its verified provider replacement",
                        candidate.display_id
                    )));
                }
            }
            _ => unreachable!("validated payment-removal reason"),
        }
        removed_total += payment.amount_allocated;
    }
    if money(allocation_total - removed_total) != money(candidate.corrected_amount_paid) {
        return Err(invalid(format!(
            "{} preserved payments do not equal the corrected source total",
            candidate.display_id
        )));
    }
    if candidate.payment_removals.is_empty()
        && lines
            .iter()
            .filter(|line| line.quantity > 0)
            .any(|line| !line.is_fulfilled)
        && candidate.line_repairs.is_empty()
    {
        return Err(invalid(format!(
            "{} still has an unreviewed active open line",
            candidate.display_id
        )));
    }

    let before_snapshot = json!({
        "manifest": candidate,
        "header": header,
        "lines": lines,
        "payments": payments,
        "allocation_total": money_string(allocation_total),
        "provider_payments_unchanged": true,
        "inventory_unchanged": true,
    });
    Ok(PreparedCandidate {
        manifest: candidate,
        before_snapshot,
    })
}

async fn prepare_manifest(
    tx: &mut Transaction<'_, Postgres>,
    manifest: &ReconciliationManifest,
) -> Result<Vec<PreparedCandidate>, CounterpointSyncError> {
    let mut prepared = Vec::with_capacity(manifest.candidates.len());
    for candidate in &manifest.candidates {
        prepared.push(prepare_candidate(tx, candidate.clone()).await?);
    }
    Ok(prepared)
}

pub async fn preview_counterpoint_incident_reconciliation(
    pool: &PgPool,
    manifest_json: &JsonValue,
) -> Result<CounterpointIncidentReconciliationPreview, CounterpointSyncError> {
    let manifest = parse_manifest(manifest_json)?;
    let digest = manifest_digest(&manifest)?;
    let mut tx = pool.begin().await?;
    let prepared = prepare_manifest(&mut tx, &manifest).await?;
    tx.rollback().await?;
    Ok(CounterpointIncidentReconciliationPreview {
        generated_at: Utc::now(),
        confirmation_phrase: COUNTERPOINT_INCIDENT_RECONCILIATION_CONFIRMATION,
        manifest_digest: digest,
        incident_key: manifest.incident_key,
        candidate_count: prepared.len(),
        inventory_unchanged: true,
        provider_payments_unchanged: true,
        rows: prepared
            .iter()
            .map(|candidate| CounterpointIncidentReconciliationPreviewRow {
                display_id: candidate.manifest.display_id.clone(),
                corrected_total: money_string(candidate.manifest.corrected_total),
                corrected_amount_paid: money_string(candidate.manifest.corrected_amount_paid),
                corrected_balance: money_string(candidate.manifest.corrected_balance),
                line_rows_to_update: candidate.manifest.line_repairs.len(),
                imported_payment_rows_to_remove: candidate.manifest.payment_removals.len(),
                derived_tax_rows_to_add: candidate.manifest.line_clones.len(),
            })
            .collect(),
    })
}

pub async fn apply_counterpoint_incident_reconciliation(
    pool: &PgPool,
    manifest_json: &JsonValue,
    repaired_by_staff_id: Uuid,
    confirmation_phrase: &str,
    reason: &str,
    expected_manifest_digest: &str,
    expected_candidate_count: usize,
) -> Result<CounterpointIncidentReconciliationApplySummary, CounterpointSyncError> {
    if confirmation_phrase.trim() != COUNTERPOINT_INCIDENT_RECONCILIATION_CONFIRMATION {
        return Err(invalid(
            "Counterpoint incident confirmation phrase did not match",
        ));
    }
    if reason.trim().len() < 12 {
        return Err(invalid(
            "Counterpoint incident reconciliation reason must be at least 12 characters",
        ));
    }
    let manifest = parse_manifest(manifest_json)?;
    let digest = manifest_digest(&manifest)?;
    if digest != expected_manifest_digest || manifest.candidates.len() != expected_candidate_count {
        return Err(invalid(
            "Counterpoint incident manifest digest or candidate count changed",
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('counterpoint_incident_reconciliation'))")
        .execute(&mut *tx)
        .await?;
    let prior_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM ops_action_audit WHERE action_key = $1 AND payload_hash_sha256 = $2",
    )
    .bind(&manifest.incident_key)
    .bind(&digest)
    .fetch_one(&mut *tx)
    .await?;
    if prior_count != 0 {
        return Err(invalid(
            "this exact Counterpoint incident reconciliation was already applied",
        ));
    }
    let prepared = prepare_manifest(&mut tx, &manifest).await?;

    let mut line_rows_updated = 0usize;
    let mut derived_tax_rows_added = 0usize;
    let mut imported_payment_rows_removed = 0usize;
    for candidate in &prepared {
        for removal in &candidate.manifest.payment_removals {
            let allocation_delete = sqlx::query(
                "DELETE FROM payment_allocations WHERE id = $1 AND transaction_id = $2 AND target_transaction_id = $3 AND ROUND(amount_allocated, 2) = $4",
            )
            .bind(removal.allocation_id)
            .bind(removal.payment_id)
            .bind(candidate.manifest.transaction_id)
            .bind(money(removal.expected_amount))
            .execute(&mut *tx)
            .await?;
            if allocation_delete.rows_affected() != 1 {
                return Err(invalid(format!(
                    "{} imported allocation changed during apply",
                    candidate.manifest.display_id
                )));
            }
            let payment_delete = sqlx::query(
                r#"
                DELETE FROM payment_transactions
                WHERE id = $1
                  AND NOT EXISTS (
                    SELECT 1 FROM payment_allocations WHERE transaction_id = $1
                  )
                "#,
            )
            .bind(removal.payment_id)
            .execute(&mut *tx)
            .await?;
            if payment_delete.rows_affected() != 1 {
                return Err(invalid(format!(
                    "{} imported payment is shared; no changes were committed",
                    candidate.manifest.display_id
                )));
            }
            imported_payment_rows_removed += 1;
        }

        for repair in &candidate.manifest.line_repairs {
            let update = sqlx::query(
                r#"
                UPDATE transaction_lines
                SET quantity = $2,
                    unit_price = $3,
                    discount_amount = $4,
                    state_tax = $5,
                    local_tax = $6,
                    is_fulfilled = $7,
                    order_lifecycle_status = CASE
                        WHEN $7 THEN 'picked_up'::order_item_lifecycle_status
                        ELSE order_lifecycle_status
                    END,
                    fulfilled_at = CASE WHEN $7 THEN $8 ELSE fulfilled_at END,
                    picked_up_at = CASE WHEN $7 THEN COALESCE(picked_up_at, $8) ELSE picked_up_at END,
                    picked_up_by = CASE WHEN $7 THEN COALESCE(picked_up_by, $9) ELSE picked_up_by END
                WHERE id = $1
                  AND quantity = $10
                  AND ROUND(unit_price, 2) = $11
                  AND ROUND(discount_amount, 2) = $12
                  AND ROUND(state_tax, 2) = $13
                  AND ROUND(local_tax, 2) = $14
                  AND is_fulfilled = $15
                "#,
            )
            .bind(repair.line_id)
            .bind(repair.corrected_quantity)
            .bind(money(repair.corrected_unit_price))
            .bind(money(repair.corrected_discount_amount))
            .bind(money(repair.corrected_state_tax))
            .bind(money(repair.corrected_local_tax))
            .bind(repair.corrected_is_fulfilled)
            .bind(candidate.manifest.source_fulfilled_at)
            .bind(repaired_by_staff_id)
            .bind(repair.expected_quantity)
            .bind(money(repair.expected_unit_price))
            .bind(money(repair.expected_discount_amount))
            .bind(money(repair.expected_state_tax))
            .bind(money(repair.expected_local_tax))
            .bind(repair.expected_is_fulfilled)
            .execute(&mut *tx)
            .await?;
            if update.rows_affected() != 1 {
                return Err(invalid(format!(
                    "{} line changed during apply; no changes were committed",
                    candidate.manifest.display_id
                )));
            }
            if !repair.expected_is_fulfilled
                || repair.expected_quantity != repair.corrected_quantity
            {
                sqlx::query(
                    r#"
                    INSERT INTO transaction_line_lifecycle_events (
                        transaction_line_id, old_status, new_status, actor_staff_id,
                        source_workflow, reason, metadata
                    )
                    VALUES (
                        $1, NULL, 'picked_up', $2,
                        'counterpoint_incident_reconciliation', $3,
                        jsonb_build_object(
                            'incident_key', $4::text,
                            'source_doc_id', $5::text,
                            'source_review_sha256', $6::text,
                            'inventory_unchanged', TRUE
                        )
                    )
                    "#,
                )
                .bind(repair.line_id)
                .bind(repaired_by_staff_id)
                .bind(reason.trim())
                .bind(&manifest.incident_key)
                .bind(&candidate.manifest.source_doc_id)
                .bind(&manifest.source_review_sha256)
                .execute(&mut *tx)
                .await?;
            }
            line_rows_updated += 1;
        }

        for clone in &candidate.manifest.line_clones {
            let insert = sqlx::query(
                r#"
                INSERT INTO transaction_lines (
                    id, transaction_id, product_id, variant_id, salesperson_id,
                    fulfillment, quantity, unit_price, unit_cost, state_tax, local_tax,
                    discount_amount, applied_spiff, calculated_commission, size_specs,
                    is_fulfilled, counterpoint_reason_code, custom_item_type, is_rush,
                    need_by_date, needs_gift_wrap, is_internal, fulfillment_order_id,
                    line_display_id, fulfilled_at, order_lifecycle_status, ordered_at,
                    ordered_by, po_id, po_line_id, vendor_id, received_at, received_by,
                    ready_for_pickup_at, ready_for_pickup_by, picked_up_at, picked_up_by,
                    wedding_id, wedding_date, vendor_eta, vendor_reference,
                    alteration_ready, booked_at, shipped_at, shipped_by, shipment_id
                )
                SELECT
                    $2, transaction_id, product_id, variant_id, salesperson_id,
                    fulfillment, $3, $4, unit_cost, $5, $6,
                    $7, applied_spiff, calculated_commission,
                    COALESCE(size_specs, '{}'::jsonb)
                        || jsonb_build_object(
                            'counterpoint_incident_derived_from_line_id', $1::text,
                            'counterpoint_incident_key', $8::text
                        ),
                    TRUE, counterpoint_reason_code, custom_item_type, is_rush,
                    need_by_date, needs_gift_wrap, is_internal, fulfillment_order_id,
                    NULL, $9, 'picked_up', ordered_at,
                    ordered_by, po_id, po_line_id, vendor_id, received_at, received_by,
                    ready_for_pickup_at, ready_for_pickup_by, $9, $10,
                    wedding_id, wedding_date, vendor_eta, vendor_reference,
                    alteration_ready, booked_at, shipped_at, shipped_by, shipment_id
                FROM transaction_lines
                WHERE id = $1
                  AND transaction_id = $11
                "#,
            )
            .bind(clone.source_line_id)
            .bind(clone.new_line_id)
            .bind(clone.quantity)
            .bind(money(clone.unit_price))
            .bind(money(clone.state_tax))
            .bind(money(clone.local_tax))
            .bind(money(clone.discount_amount))
            .bind(&manifest.incident_key)
            .bind(candidate.manifest.source_fulfilled_at)
            .bind(repaired_by_staff_id)
            .bind(candidate.manifest.transaction_id)
            .execute(&mut *tx)
            .await?;
            if insert.rows_affected() != 1 {
                return Err(invalid(format!(
                    "{} derived tax line could not be created",
                    candidate.manifest.display_id
                )));
            }
            sqlx::query(
                r#"
                INSERT INTO transaction_line_lifecycle_events (
                    transaction_line_id, old_status, new_status, actor_staff_id,
                    source_workflow, reason, metadata
                )
                VALUES (
                    $1, NULL, 'picked_up', $2,
                    'counterpoint_incident_reconciliation', $3,
                    jsonb_build_object(
                        'incident_key', $4::text,
                        'derived_from_line_id', $5::text,
                        'tax_rounding_representation', TRUE,
                        'inventory_unchanged', TRUE
                    )
                )
                "#,
            )
            .bind(clone.new_line_id)
            .bind(repaired_by_staff_id)
            .bind(reason.trim())
            .bind(&manifest.incident_key)
            .bind(clone.source_line_id)
            .execute(&mut *tx)
            .await?;
            derived_tax_rows_added += 1;
        }

        let updated_header = sqlx::query(
            r#"
            UPDATE transactions
            SET total_price = $2,
                amount_paid = $3,
                balance_due = $4,
                status = 'fulfilled',
                fulfilled_at = $5,
                metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                        'counterpoint_incident_reconciliation',
                        jsonb_build_object(
                            'incident_key', $6::text,
                            'manifest_digest', $7::text,
                            'source_review_sha256', $8::text,
                            'reconciled_at', CURRENT_TIMESTAMP,
                            'inventory_unchanged', TRUE,
                            'provider_payments_unchanged', TRUE
                        )
                    )
            WHERE id = $1
              AND status = 'open'
              AND ROUND(total_price, 2) = $9
              AND ROUND(amount_paid, 2) = $10
              AND ROUND(balance_due, 2) = $11
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .bind(money(candidate.manifest.corrected_total))
        .bind(money(candidate.manifest.corrected_amount_paid))
        .bind(money(candidate.manifest.corrected_balance))
        .bind(candidate.manifest.source_fulfilled_at)
        .bind(&manifest.incident_key)
        .bind(&digest)
        .bind(&manifest.source_review_sha256)
        .bind(money(candidate.manifest.expected_total))
        .bind(money(candidate.manifest.expected_amount_paid))
        .bind(money(candidate.manifest.expected_balance))
        .execute(&mut *tx)
        .await?;
        if updated_header.rows_affected() != 1 {
            return Err(invalid(format!(
                "{} header changed during apply; no changes were committed",
                candidate.manifest.display_id
            )));
        }

        let after_snapshot: JsonValue = sqlx::query_scalar(
            r#"
            SELECT jsonb_build_object(
                'display_id', t.display_id,
                'status', t.status,
                'total_price', ROUND(t.total_price, 2)::text,
                'amount_paid', ROUND(t.amount_paid, 2)::text,
                'balance_due', ROUND(t.balance_due, 2)::text,
                'fulfilled_at', t.fulfilled_at,
                'allocation_total', (
                    SELECT ROUND(COALESCE(SUM(pa.amount_allocated), 0), 2)::text
                    FROM payment_allocations pa
                    WHERE pa.target_transaction_id = t.id
                ),
                'active_line_total', (
                    SELECT ROUND(COALESCE(SUM(
                        tl.quantity * (tl.unit_price + tl.state_tax + tl.local_tax)
                    ), 0), 2)::text
                    FROM transaction_lines tl
                    WHERE tl.transaction_id = t.id
                      AND NOT COALESCE(tl.is_internal, FALSE)
                ),
                'active_open_line_count', (
                    SELECT COUNT(*)::bigint
                    FROM transaction_lines tl
                    WHERE tl.transaction_id = t.id
                      AND tl.quantity > 0
                      AND NOT tl.is_fulfilled
                      AND NOT COALESCE(tl.is_internal, FALSE)
                ),
                'provider_payments_unchanged', TRUE,
                'inventory_unchanged', TRUE
            )
            FROM transactions t
            WHERE t.id = $1
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .fetch_one(&mut *tx)
        .await?;
        if after_snapshot.get("status").and_then(JsonValue::as_str) != Some("fulfilled")
            || after_snapshot
                .get("total_price")
                .and_then(JsonValue::as_str)
                != Some(money_string(candidate.manifest.corrected_total).as_str())
            || after_snapshot
                .get("amount_paid")
                .and_then(JsonValue::as_str)
                != Some(money_string(candidate.manifest.corrected_amount_paid).as_str())
            || after_snapshot
                .get("balance_due")
                .and_then(JsonValue::as_str)
                != Some("0.00")
            || after_snapshot
                .get("allocation_total")
                .and_then(JsonValue::as_str)
                != Some(money_string(candidate.manifest.corrected_amount_paid).as_str())
            || after_snapshot
                .get("active_line_total")
                .and_then(JsonValue::as_str)
                != Some(money_string(candidate.manifest.corrected_total).as_str())
            || after_snapshot
                .get("active_open_line_count")
                .and_then(JsonValue::as_i64)
                != Some(0)
        {
            return Err(invalid(format!(
                "{} did not pass its atomic after-state verification",
                candidate.manifest.display_id
            )));
        }

        sqlx::query(
            r#"
            INSERT INTO transaction_activity_log (
                transaction_id, customer_id, event_kind, summary, metadata
            )
            SELECT
                id,
                customer_id,
                'counterpoint_incident_reconciliation',
                'Reconciled exact Counterpoint completion evidence after July 21 lifecycle recovery.',
                jsonb_build_object(
                    'incident_key', $2::text,
                    'manifest_digest', $3::text,
                    'source_review_sha256', $4::text,
                    'source_doc_id', $5::text,
                    'reason', $6::text,
                    'repaired_by_staff_id', $7::text,
                    'before', $8::jsonb,
                    'after', $9::jsonb,
                    'inventory_unchanged', TRUE,
                    'provider_payments_unchanged', TRUE
                )
            FROM transactions
            WHERE id = $1
            "#,
        )
        .bind(candidate.manifest.transaction_id)
        .bind(&manifest.incident_key)
        .bind(&digest)
        .bind(&manifest.source_review_sha256)
        .bind(&candidate.manifest.source_doc_id)
        .bind(reason.trim())
        .bind(repaired_by_staff_id)
        .bind(&candidate.before_snapshot)
        .bind(&after_snapshot)
        .execute(&mut *tx)
        .await?;
        super::counterpoint_return_safety::resolve_counterpoint_return_review_block(
            &mut tx,
            candidate.manifest.transaction_id,
            repaired_by_staff_id,
            "Resolved by exact July 21 Counterpoint incident reconciliation",
        )
        .await?;
    }

    let result = json!({
        "reconciled_transactions": prepared.len(),
        "line_rows_updated": line_rows_updated,
        "derived_tax_rows_added": derived_tax_rows_added,
        "imported_payment_rows_removed": imported_payment_rows_removed,
        "provider_payments_changed": false,
        "inventory_changed": false,
    });
    sqlx::query(
        r#"
        INSERT INTO ops_action_audit (
            actor_staff_id, action_key, reason, payload_json,
            payload_hash_sha256, result_ok, result_message, result_json
        )
        VALUES (
            $1, $2, $3,
            jsonb_build_object(
                'manifest_digest', $4::text,
                'source_review_sha256', $5::text,
                'candidate_count', $6::integer
            ),
            $4, TRUE,
            'Reconciled seven exact Counterpoint incident records without changing provider payments or inventory.',
            $7
        )
        "#,
    )
    .bind(repaired_by_staff_id)
    .bind(&manifest.incident_key)
    .bind(reason.trim())
    .bind(&digest)
    .bind(&manifest.source_review_sha256)
    .bind(i32::try_from(prepared.len()).unwrap_or(i32::MAX))
    .bind(&result)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(CounterpointIncidentReconciliationApplySummary {
        applied_manifest_digest: digest,
        reconciled_transactions: prepared.len(),
        line_rows_updated,
        derived_tax_rows_added,
        imported_payment_rows_removed,
        provider_payments_changed: false,
        inventory_changed: false,
    })
}
