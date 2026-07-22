use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::logic::counterpoint_sync::CounterpointSyncError;

pub const COUNTERPOINT_RECONCILIATION_CONFIRMATION: &str = "RECONCILE COUNTERPOINT ORDERS";
pub const COUNTERPOINT_BOOKING_DATE_REPAIR_CONFIRMATION: &str = "REPAIR COUNTERPOINT BOOKING DATES";

#[derive(Debug, Clone, FromRow)]
struct CandidatePairRow {
    canonical_transaction_id: Uuid,
    canonical_display_id: String,
    counterpoint_doc_ref: String,
    customer_id: Uuid,
    customer_name: String,
    canonical_booked_at: DateTime<Utc>,
    total_price: Decimal,
    canonical_amount_paid: Decimal,
    canonical_balance_due: Decimal,
    ticket_transaction_id: Uuid,
    ticket_display_id: String,
    counterpoint_ticket_ref: String,
    ticket_booked_at: DateTime<Utc>,
    ticket_is_counterpoint_import: bool,
    ticket_match_count: i64,
    line_signature: JsonValue,
    line_signature_matches: bool,
    canonical_is_existing_pos: bool,
    ticket_primary_salesperson_id: Option<Uuid>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
struct ReconciliationPaymentRow {
    id: Uuid,
    target_transaction_id: Uuid,
    business_date: NaiveDate,
    payment_method: String,
    amount: Decimal,
    status: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct PaymentSignature {
    business_date: NaiveDate,
    payment_method: String,
    amount: Decimal,
}

impl From<&ReconciliationPaymentRow> for PaymentSignature {
    fn from(payment: &ReconciliationPaymentRow) -> Self {
        Self {
            business_date: payment.business_date,
            payment_method: payment.payment_method.trim().to_ascii_lowercase(),
            amount: payment.amount.round_dp(2),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointReconciliationTicketSummary {
    pub transaction_id: Uuid,
    pub display_id: String,
    pub counterpoint_ticket_ref: String,
    pub booked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointReconciliationCandidateSummary {
    pub canonical_transaction_id: Uuid,
    pub canonical_display_id: String,
    pub counterpoint_doc_ref: String,
    pub customer_id: Uuid,
    pub customer_name: String,
    pub booked_at: DateTime<Utc>,
    pub total_price: String,
    pub current_amount_paid: String,
    pub current_balance_due: String,
    pub reconciled_amount_paid: String,
    pub reconciled_balance_due: String,
    pub ready: bool,
    pub review_reason: String,
    pub payments_to_move: usize,
    pub duplicate_payments_to_supersede: usize,
    pub ticket_transactions: Vec<CounterpointReconciliationTicketSummary>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointReconciliationPreview {
    pub generated_at: DateTime<Utc>,
    pub confirmation_phrase: &'static str,
    pub manifest_digest: String,
    pub candidate_count: usize,
    pub ready_count: usize,
    pub needs_review_count: usize,
    pub candidates: Vec<CounterpointReconciliationCandidateSummary>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointReconciliationApplySummary {
    pub applied_manifest_digest: String,
    pub reconciled_orders: usize,
    pub superseded_ticket_transactions: usize,
    pub moved_payments: usize,
    pub superseded_duplicate_payments: usize,
    pub remaining_review_count: usize,
}

#[derive(Debug, Clone, FromRow)]
struct CounterpointBookingDateRepairManifestRow {
    manifest_key: String,
    transaction_id: Uuid,
    display_id: String,
    counterpoint_ticket_ref: Option<String>,
    counterpoint_doc_ref: Option<String>,
    target_booked_at: DateTime<Utc>,
    line_rows_to_update: i64,
    transaction_line_ids: Vec<Uuid>,
    booking_events_to_update: i64,
    booking_event_ids: Vec<Uuid>,
    orphaned_initial_booking_event_count: i64,
    unreviewed_adjustment_event_count: i64,
    header_total: Decimal,
    line_total: Decimal,
    stored_amount_paid: Decimal,
    allocated_tender_total: Decimal,
    integrity_status: String,
    review_codes: Vec<String>,
    source_snapshot: JsonValue,
}

#[derive(Debug, Clone, Serialize)]
pub struct CounterpointBookingDateRepairCandidate {
    pub manifest_key: String,
    pub transaction_id: Uuid,
    pub display_id: String,
    pub counterpoint_ticket_ref: Option<String>,
    pub counterpoint_doc_ref: Option<String>,
    pub target_booked_at: DateTime<Utc>,
    pub line_rows_to_update: i64,
    pub booking_events_to_update: i64,
    pub orphaned_initial_booking_event_count: i64,
    pub unreviewed_adjustment_event_count: i64,
    pub header_total: String,
    pub line_total: String,
    pub stored_amount_paid: String,
    pub allocated_tender_total: String,
    pub integrity_status: String,
    pub review_codes: Vec<String>,
}

impl From<&CounterpointBookingDateRepairManifestRow> for CounterpointBookingDateRepairCandidate {
    fn from(row: &CounterpointBookingDateRepairManifestRow) -> Self {
        Self {
            manifest_key: row.manifest_key.clone(),
            transaction_id: row.transaction_id,
            display_id: row.display_id.clone(),
            counterpoint_ticket_ref: row.counterpoint_ticket_ref.clone(),
            counterpoint_doc_ref: row.counterpoint_doc_ref.clone(),
            target_booked_at: row.target_booked_at,
            line_rows_to_update: row.line_rows_to_update,
            booking_events_to_update: row.booking_events_to_update,
            orphaned_initial_booking_event_count: row.orphaned_initial_booking_event_count,
            unreviewed_adjustment_event_count: row.unreviewed_adjustment_event_count,
            header_total: row.header_total.to_string(),
            line_total: row.line_total.to_string(),
            stored_amount_paid: row.stored_amount_paid.to_string(),
            allocated_tender_total: row.allocated_tender_total.to_string(),
            integrity_status: row.integrity_status.clone(),
            review_codes: row.review_codes.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CounterpointBookingDateRepairPreview {
    pub generated_at: DateTime<Utc>,
    pub confirmation_phrase: &'static str,
    pub manifest_digest: String,
    pub candidate_count: usize,
    pub line_rows_to_update: i64,
    pub booking_events_to_update: i64,
    pub financial_review_count: usize,
    pub event_review_count: usize,
    pub tender_values_read_only: bool,
    pub candidates_truncated: bool,
    pub candidates: Vec<CounterpointBookingDateRepairCandidate>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointBookingDateRepairApplySummary {
    pub applied_manifest_digest: String,
    pub repaired_transactions: usize,
    pub line_rows_updated: u64,
    pub booking_events_updated: u64,
    pub already_applied_manifests: usize,
    pub remaining_booking_date_candidates: i64,
    pub remaining_financial_review_count: i64,
    pub remaining_event_review_count: i64,
    pub tender_values_changed: bool,
}

#[derive(Debug, Clone)]
struct PreparedCandidate {
    summary: CounterpointReconciliationCandidateSummary,
    line_signature: JsonValue,
    ticket_transaction_ids: Vec<Uuid>,
    moved_payments: Vec<ReconciliationPaymentRow>,
    duplicate_payments: Vec<ReconciliationPaymentRow>,
    manifest_payments: Vec<ReconciliationPaymentRow>,
    ticket_primary_salesperson_id: Option<Uuid>,
}

fn manifest_digest(value: &JsonValue) -> Result<String, CounterpointSyncError> {
    let encoded = serde_json::to_vec(value).map_err(|error| {
        CounterpointSyncError::InvalidPayload(format!(
            "could not encode reviewed Counterpoint manifest: {error}"
        ))
    })?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

fn reconciliation_manifest_payload(candidates: &[PreparedCandidate]) -> JsonValue {
    json!({
        "version": 1,
        "candidates": candidates.iter().map(|candidate| json!({
            "summary": candidate.summary,
            "line_signature": candidate.line_signature,
            "ticket_transaction_ids": candidate.ticket_transaction_ids,
            "payments": candidate.manifest_payments,
            "ticket_primary_salesperson_id": candidate.ticket_primary_salesperson_id,
        })).collect::<Vec<_>>(),
    })
}

fn booking_date_manifest_payload(
    candidates: &[CounterpointBookingDateRepairManifestRow],
) -> JsonValue {
    json!({
        "version": 1,
        "candidates": candidates.iter().map(|candidate| json!({
            "manifest_key": candidate.manifest_key,
            "transaction_id": candidate.transaction_id,
            "target_booked_at": candidate.target_booked_at,
            "transaction_line_ids": candidate.transaction_line_ids,
            "booking_event_ids": candidate.booking_event_ids,
            "line_rows_to_update": candidate.line_rows_to_update,
            "booking_events_to_update": candidate.booking_events_to_update,
            "source_snapshot": candidate.source_snapshot,
        })).collect::<Vec<_>>(),
    })
}

async fn discover_candidates(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<PreparedCandidate>, CounterpointSyncError> {
    let pairs: Vec<CandidatePairRow> = sqlx::query_as(
        r#"
        WITH line_signatures AS (
            SELECT
                t.id AS transaction_id,
                COALESCE(
                    jsonb_agg(
                        jsonb_build_array(
                            tl.product_id,
                            tl.variant_id,
                            tl.quantity,
                            ROUND(COALESCE(tl.unit_price, 0), 2),
                            ROUND(COALESCE(tl.state_tax, 0), 2),
                            ROUND(COALESCE(tl.local_tax, 0), 2)
                        )
                        ORDER BY tl.product_id, tl.variant_id, tl.quantity,
                                 ROUND(COALESCE(tl.unit_price, 0), 2), tl.id
                    ) FILTER (WHERE tl.id IS NOT NULL),
                    '[]'::jsonb
                ) AS line_signature
            FROM transactions t
            LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
            GROUP BY t.id
        ), item_signatures AS (
            SELECT
                t.id AS transaction_id,
                COALESCE(
                    jsonb_agg(
                        jsonb_build_array(tl.product_id, tl.quantity)
                        ORDER BY tl.product_id, tl.quantity, tl.id
                    ) FILTER (WHERE tl.id IS NOT NULL),
                    '[]'::jsonb
                ) AS item_signature
            FROM transactions t
            LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
            GROUP BY t.id
        ), candidate_pairs AS (
            SELECT
                d.id AS canonical_transaction_id,
                COALESCE(NULLIF(TRIM(d.display_id), ''), d.counterpoint_doc_ref, d.id::text) AS canonical_display_id,
                COALESCE(d.counterpoint_doc_ref, '') AS counterpoint_doc_ref,
                d.customer_id,
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                    NULLIF(TRIM(c.company_name), ''),
                    NULLIF(TRIM(c.customer_code), ''),
                    'Unknown customer'
                ) AS customer_name,
                d.booked_at AS canonical_booked_at,
                d.total_price,
                d.amount_paid AS canonical_amount_paid,
                d.balance_due AS canonical_balance_due,
                t.id AS ticket_transaction_id,
                COALESCE(NULLIF(TRIM(t.display_id), ''), t.counterpoint_ticket_ref, t.id::text) AS ticket_display_id,
                COALESCE(t.counterpoint_ticket_ref, '') AS counterpoint_ticket_ref,
                t.booked_at AS ticket_booked_at,
                COALESCE(t.is_counterpoint_import, false) AS ticket_is_counterpoint_import,
                t.primary_salesperson_id AS ticket_primary_salesperson_id,
                ds.line_signature,
                (ts.line_signature = ds.line_signature) AS line_signature_matches,
                (d.counterpoint_doc_ref IS NULL) AS canonical_is_existing_pos,
                COUNT(*) OVER (PARTITION BY t.id) AS ticket_match_count
            FROM transactions d
            INNER JOIN customers c ON c.id = d.customer_id
            INNER JOIN line_signatures ds ON ds.transaction_id = d.id
            INNER JOIN transactions t
                ON t.customer_id = d.customer_id
               AND (
                   t.counterpoint_ticket_ref IS NOT NULL
                   OR t.counterpoint_doc_ref IS NOT NULL
               )
               AND t.id <> d.id
               AND (
                   ABS(COALESCE(t.total_price, 0) - COALESCE(d.total_price, 0)) <= 0.01
                   OR (
                       d.counterpoint_doc_ref IS NULL
                       AND ABS(COALESCE(t.amount_paid, 0) - COALESCE(d.amount_paid, 0)) <= 0.01
                   )
               )
               AND t.booked_at >= d.booked_at - INTERVAL '730 days'
               AND t.booked_at <= d.booked_at + INTERVAL '730 days'
            INNER JOIN line_signatures ts
                ON ts.transaction_id = t.id
            INNER JOIN item_signatures di ON di.transaction_id = d.id
            INNER JOIN item_signatures ti
                ON ti.transaction_id = t.id
               AND (
                   ts.line_signature = ds.line_signature
                   OR (
                       di.item_signature = ti.item_signature
                       AND d.counterpoint_doc_ref IS NULL
                       AND NOT COALESCE(d.is_counterpoint_import, false)
                       AND ABS(COALESCE(t.amount_paid, 0) - COALESCE(d.amount_paid, 0)) <= 0.01
                   )
               )
            WHERE (
                d.counterpoint_doc_ref IS NOT NULL
                OR (
                    d.counterpoint_doc_ref IS NULL
                    AND NOT COALESCE(d.is_counterpoint_import, false)
                    AND COALESCE(t.is_counterpoint_import, false)
                )
            )
              AND d.customer_id IS NOT NULL
              AND COALESCE(d.total_price, 0) > 0
              AND di.item_signature <> '[]'::jsonb
              AND COALESCE(d.metadata->>'counterpoint_reconciliation_status', '') <> 'reconciled'
              AND COALESCE(t.metadata->>'counterpoint_reconciliation_status', '') <> 'superseded'
              AND NOT (
                  d.counterpoint_doc_ref IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM transactions existing_pos
                      INNER JOIN item_signatures existing_items
                          ON existing_items.transaction_id = existing_pos.id
                      WHERE existing_pos.customer_id = d.customer_id
                        AND NOT COALESCE(existing_pos.is_counterpoint_import, false)
                        AND ABS(COALESCE(existing_pos.amount_paid, 0) - COALESCE(d.amount_paid, 0)) <= 0.01
                        AND (
                            existing_items.item_signature = di.item_signature
                            OR jsonb_array_length(existing_items.item_signature) = jsonb_array_length(di.item_signature)
                        )
                  )
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM counterpoint_transaction_reconciliation r
                  WHERE r.canonical_transaction_id = d.id
              )
        )
        SELECT *
        FROM candidate_pairs
        ORDER BY canonical_booked_at, canonical_transaction_id, ticket_booked_at, ticket_transaction_id
        "#,
    )
    .fetch_all(&mut **tx)
    .await?;

    if pairs.is_empty() {
        return Ok(Vec::new());
    }

    let mut grouped: BTreeMap<Uuid, Vec<CandidatePairRow>> = BTreeMap::new();
    let mut all_transaction_ids = HashSet::new();
    for pair in pairs {
        all_transaction_ids.insert(pair.canonical_transaction_id);
        all_transaction_ids.insert(pair.ticket_transaction_id);
        grouped
            .entry(pair.canonical_transaction_id)
            .or_default()
            .push(pair);
    }

    let transaction_ids: Vec<Uuid> = all_transaction_ids.into_iter().collect();
    let payments: Vec<ReconciliationPaymentRow> = sqlx::query_as(
        r#"
        SELECT
            pt.id,
            pa.target_transaction_id,
            COALESCE(
                pt.effective_date,
                (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date
            ) AS business_date,
            COALESCE(NULLIF(TRIM(pt.payment_method), ''), 'unknown') AS payment_method,
            pa.amount_allocated AS amount,
            COALESCE(NULLIF(TRIM(pt.status), ''), 'success') AS status,
            pt.created_at
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = ANY($1)
        ORDER BY business_date, pt.created_at, pt.id
        "#,
    )
    .bind(&transaction_ids)
    .fetch_all(&mut **tx)
    .await?;

    let mut payments_by_target: HashMap<Uuid, Vec<ReconciliationPaymentRow>> = HashMap::new();
    for payment in payments {
        payments_by_target
            .entry(payment.target_transaction_id)
            .or_default()
            .push(payment);
    }

    let mut prepared = Vec::with_capacity(grouped.len());
    for (canonical_id, mut group) in grouped {
        group.sort_by_key(|row| (row.ticket_booked_at, row.ticket_transaction_id));
        let first = group.first().expect("candidate group is non-empty");
        let mut review_reasons = Vec::new();

        let existing_pos_match = first.canonical_is_existing_pos;
        let imported_doc_match = !existing_pos_match
            && !first.counterpoint_doc_ref.trim().is_empty()
            && group.iter().all(|row| {
                row.ticket_is_counterpoint_import
                    && !row.counterpoint_ticket_ref.trim().is_empty()
                    && row.line_signature_matches
            });

        if !imported_doc_match && group.iter().any(|row| row.ticket_match_count != 1) {
            review_reasons.push("At least one ticket matches more than one open order.");
        }
        if !existing_pos_match
            && !imported_doc_match
            && !group.iter().any(|row| {
                (row.ticket_booked_at - row.canonical_booked_at)
                    .num_seconds()
                    .abs()
                    <= 300
            })
        {
            review_reasons.push("No same-time ticket proves the original open-order lifecycle.");
        }

        let canonical_payments = payments_by_target
            .get(&canonical_id)
            .cloned()
            .unwrap_or_default();
        let mut manifest_payments = canonical_payments.clone();
        for row in &group {
            manifest_payments.extend(
                payments_by_target
                    .get(&row.ticket_transaction_id)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }
        manifest_payments.sort_by_key(|payment| {
            (
                payment.target_transaction_id,
                payment.business_date,
                payment.created_at,
                payment.id,
            )
        });
        manifest_payments.dedup_by_key(|payment| payment.id);
        let mut retained_signatures = HashSet::new();
        let mut reconciled_amount = Decimal::ZERO;
        for payment in &canonical_payments {
            if payment.status != "success" {
                review_reasons.push("The original order contains a non-success payment.");
            }
            if payment.amount <= Decimal::ZERO {
                review_reasons.push("The original order contains a zero or negative payment.");
            }
            if !retained_signatures.insert(PaymentSignature::from(payment)) {
                review_reasons.push(
                    "The original order already contains indistinguishable duplicate payments.",
                );
            }
            reconciled_amount += payment.amount;
        }

        let mut moved_payments = Vec::new();
        let mut duplicate_payments = Vec::new();
        let canonical_signatures = retained_signatures.clone();
        let mut later_ticket_signatures = HashSet::new();
        for row in &group {
            for payment in payments_by_target
                .get(&row.ticket_transaction_id)
                .into_iter()
                .flatten()
            {
                if payment.status != "success" {
                    review_reasons.push("A matching ticket contains a non-success payment.");
                }
                if existing_pos_match {
                    duplicate_payments.push(payment.clone());
                    continue;
                }
                if payment.amount <= Decimal::ZERO {
                    review_reasons.push("A matching ticket contains a zero or negative payment.");
                }
                let signature = PaymentSignature::from(payment);
                if canonical_signatures.contains(&signature) {
                    duplicate_payments.push(payment.clone());
                } else if !later_ticket_signatures.insert(signature.clone()) {
                    review_reasons.push("Later tickets contain indistinguishable payments that require Manager review.");
                } else {
                    retained_signatures.insert(signature);
                    reconciled_amount += payment.amount;
                    moved_payments.push(payment.clone());
                }
            }
        }

        if !existing_pos_match && !imported_doc_match && moved_payments.is_empty() {
            review_reasons.push("No later payment can be moved to the original order.");
        }
        if !existing_pos_match && (reconciled_amount - first.total_price).abs() > Decimal::new(1, 2)
        {
            review_reasons.push("Unique payment totals do not exactly equal the order total.");
        }

        review_reasons.sort_unstable();
        review_reasons.dedup();
        let ready = review_reasons.is_empty();
        let review_reason = if ready {
            if existing_pos_match {
                "Existing ROS transaction matched by customer, paid amount, and exact product/quantity lines; imported payment ticket is a duplicate.".to_string()
            } else if imported_doc_match {
                "Imported Counterpoint document and payment ticket have the same customer, total, and exact charged lines; the ticket is a duplicate.".to_string()
            } else {
                "Exact customer, total, line, same-time ticket, and unique-payment match."
                    .to_string()
            }
        } else {
            review_reasons.join(" ")
        };

        let ticket_transactions = group
            .iter()
            .map(|row| CounterpointReconciliationTicketSummary {
                transaction_id: row.ticket_transaction_id,
                display_id: row.ticket_display_id.clone(),
                counterpoint_ticket_ref: row.counterpoint_ticket_ref.clone(),
                booked_at: row.ticket_booked_at,
            })
            .collect::<Vec<_>>();
        let ticket_transaction_ids = ticket_transactions
            .iter()
            .map(|ticket| ticket.transaction_id)
            .collect();

        prepared.push(PreparedCandidate {
            summary: CounterpointReconciliationCandidateSummary {
                canonical_transaction_id: canonical_id,
                canonical_display_id: first.canonical_display_id.clone(),
                counterpoint_doc_ref: first.counterpoint_doc_ref.clone(),
                customer_id: first.customer_id,
                customer_name: first.customer_name.clone(),
                booked_at: first.canonical_booked_at,
                total_price: first.total_price.to_string(),
                current_amount_paid: first.canonical_amount_paid.to_string(),
                current_balance_due: first.canonical_balance_due.to_string(),
                reconciled_amount_paid: reconciled_amount.to_string(),
                reconciled_balance_due: (first.total_price - reconciled_amount)
                    .max(Decimal::ZERO)
                    .to_string(),
                ready,
                review_reason,
                payments_to_move: moved_payments.len(),
                duplicate_payments_to_supersede: duplicate_payments.len(),
                ticket_transactions,
            },
            line_signature: first.line_signature.clone(),
            ticket_transaction_ids,
            moved_payments,
            duplicate_payments,
            manifest_payments,
            ticket_primary_salesperson_id: first.ticket_primary_salesperson_id,
        });
    }

    Ok(prepared)
}

pub async fn preview_counterpoint_transaction_reconciliation(
    pool: &PgPool,
) -> Result<CounterpointReconciliationPreview, CounterpointSyncError> {
    let mut tx = pool.begin().await?;
    let candidates = discover_candidates(&mut tx).await?;
    tx.rollback().await?;
    let manifest_digest = manifest_digest(&reconciliation_manifest_payload(&candidates))?;
    let candidate_count = candidates.len();
    let summaries = candidates
        .iter()
        .map(|candidate| candidate.summary.clone())
        .collect::<Vec<_>>();
    Ok(CounterpointReconciliationPreview {
        generated_at: Utc::now(),
        confirmation_phrase: COUNTERPOINT_RECONCILIATION_CONFIRMATION,
        manifest_digest,
        candidate_count,
        ready_count: summaries.iter().filter(|candidate| candidate.ready).count(),
        needs_review_count: summaries
            .iter()
            .filter(|candidate| !candidate.ready)
            .count(),
        candidates: summaries,
    })
}

pub async fn preview_counterpoint_booking_date_repairs(
    pool: &PgPool,
) -> Result<CounterpointBookingDateRepairPreview, CounterpointSyncError> {
    let (financial_review_count, event_review_count): (i64, i64) = sqlx::query_as(
        r#"
        SELECT
            (
                SELECT COUNT(*)::bigint
                FROM reporting.counterpoint_import_financial_integrity
                WHERE cardinality(import_snapshot_review_codes) > 0
            ),
            (
                SELECT COUNT(*)::bigint
                FROM reporting.counterpoint_import_financial_integrity
                WHERE orphaned_initial_booking_event_count > 0
                   OR unreviewed_adjustment_event_count > 0
            )
        "#,
    )
    .fetch_one(pool)
    .await?;

    let rows = sqlx::query_as::<_, CounterpointBookingDateRepairManifestRow>(
        r#"
        SELECT
            manifest_key, transaction_id, display_id,
            counterpoint_ticket_ref, counterpoint_doc_ref, target_booked_at,
            line_rows_to_update, transaction_line_ids,
            booking_events_to_update, booking_event_ids,
            orphaned_initial_booking_event_count, unreviewed_adjustment_event_count,
            header_total, line_total, stored_amount_paid, allocated_tender_total,
            integrity_status, review_codes, source_snapshot
        FROM reporting.counterpoint_booking_date_repair_manifest
        ORDER BY transaction_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    if rows.len() > 10_000 {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "booking-date repair manifest contains {} transactions; review and reduce the source scope before applying",
            rows.len()
        )));
    }

    let manifest_digest = manifest_digest(&booking_date_manifest_payload(&rows))?;
    let line_rows_to_update = rows.iter().map(|row| row.line_rows_to_update).sum();
    let booking_events_to_update = rows.iter().map(|row| row.booking_events_to_update).sum();
    let candidate_rows = rows
        .iter()
        .take(200)
        .map(CounterpointBookingDateRepairCandidate::from)
        .collect::<Vec<_>>();

    Ok(CounterpointBookingDateRepairPreview {
        generated_at: Utc::now(),
        confirmation_phrase: COUNTERPOINT_BOOKING_DATE_REPAIR_CONFIRMATION,
        manifest_digest,
        candidate_count: rows.len(),
        line_rows_to_update,
        booking_events_to_update,
        financial_review_count: financial_review_count.max(0) as usize,
        event_review_count: event_review_count.max(0) as usize,
        tender_values_read_only: true,
        candidates_truncated: rows.len() > candidate_rows.len(),
        candidates: candidate_rows,
    })
}

pub async fn apply_counterpoint_booking_date_repairs(
    pool: &PgPool,
    repaired_by_staff_id: Uuid,
    confirmation_phrase: &str,
    reason: &str,
    expected_manifest_digest: &str,
    expected_candidate_count: usize,
) -> Result<CounterpointBookingDateRepairApplySummary, CounterpointSyncError> {
    if confirmation_phrase.trim() != COUNTERPOINT_BOOKING_DATE_REPAIR_CONFIRMATION {
        return Err(CounterpointSyncError::InvalidPayload(
            "confirmation phrase did not match".to_string(),
        ));
    }
    if reason.trim().len() < 12 {
        return Err(CounterpointSyncError::InvalidPayload(
            "a booking-date repair reason of at least 12 characters is required".to_string(),
        ));
    }
    if expected_manifest_digest.trim().len() != 64 {
        return Err(CounterpointSyncError::InvalidPayload(
            "a valid reviewed booking-date manifest digest is required".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('counterpoint_booking_date_repair'))")
        .execute(&mut *tx)
        .await?;

    let preview_candidates = sqlx::query_as::<_, CounterpointBookingDateRepairManifestRow>(
        r#"
        SELECT
            manifest_key, transaction_id, display_id,
            counterpoint_ticket_ref, counterpoint_doc_ref, target_booked_at,
            line_rows_to_update, transaction_line_ids,
            booking_events_to_update, booking_event_ids,
            orphaned_initial_booking_event_count, unreviewed_adjustment_event_count,
            header_total, line_total, stored_amount_paid, allocated_tender_total,
            integrity_status, review_codes, source_snapshot
        FROM reporting.counterpoint_booking_date_repair_manifest
        ORDER BY transaction_id
        LIMIT 10001
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;
    if preview_candidates.len() > 10_000 {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "booking-date repair manifest contains more than 10000 transactions; review and reduce the source scope before applying"
        )));
    }

    let candidate_ids = preview_candidates
        .iter()
        .map(|candidate| candidate.transaction_id)
        .collect::<Vec<_>>();
    let transaction_line_ids = preview_candidates
        .iter()
        .flat_map(|candidate| candidate.transaction_line_ids.iter().copied())
        .collect::<Vec<_>>();
    let booking_event_ids = preview_candidates
        .iter()
        .flat_map(|candidate| candidate.booking_event_ids.iter().copied())
        .collect::<Vec<_>>();
    if !candidate_ids.is_empty() {
        sqlx::query("SELECT id FROM transactions WHERE id = ANY($1) FOR UPDATE")
            .bind(&candidate_ids)
            .fetch_all(&mut *tx)
            .await?;
    }
    if !transaction_line_ids.is_empty() {
        sqlx::query("SELECT id FROM transaction_lines WHERE id = ANY($1) FOR UPDATE")
            .bind(&transaction_line_ids)
            .fetch_all(&mut *tx)
            .await?;
    }
    if !booking_event_ids.is_empty() {
        sqlx::query("SELECT id FROM transaction_line_booking_events WHERE id = ANY($1) FOR UPDATE")
            .bind(&booking_event_ids)
            .fetch_all(&mut *tx)
            .await?;
    }

    let candidates = sqlx::query_as::<_, CounterpointBookingDateRepairManifestRow>(
        r#"
        SELECT
            manifest_key, transaction_id, display_id,
            counterpoint_ticket_ref, counterpoint_doc_ref, target_booked_at,
            line_rows_to_update, transaction_line_ids,
            booking_events_to_update, booking_event_ids,
            orphaned_initial_booking_event_count, unreviewed_adjustment_event_count,
            header_total, line_total, stored_amount_paid, allocated_tender_total,
            integrity_status, review_codes, source_snapshot
        FROM reporting.counterpoint_booking_date_repair_manifest
        ORDER BY transaction_id
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;

    let current_manifest_digest = manifest_digest(&booking_date_manifest_payload(&candidates))?;
    if candidates.len() != expected_candidate_count
        || current_manifest_digest != expected_manifest_digest.trim()
    {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "the booking-date repair manifest changed after review (reviewed {} candidate(s), current {}); refresh the preview and review again; no changes were committed",
            expected_candidate_count,
            candidates.len()
        )));
    }
    let current_candidate_count = candidates.len();

    sqlx::query("SET LOCAL riverside.suppress_booking_event = 'true'")
        .execute(&mut *tx)
        .await?;

    let mut repaired_transactions = 0_usize;
    let mut line_rows_updated = 0_u64;
    let mut booking_events_updated = 0_u64;
    let already_applied_manifests = 0_usize;

    for candidate in candidates {
        let repair_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            INSERT INTO counterpoint_booking_date_repair_audit (
                manifest_key, transaction_id, repaired_by_staff_id, reason,
                review_manifest_digest, review_manifest_candidate_count, source_snapshot
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (manifest_key) DO NOTHING
            RETURNING id
            "#,
        )
        .bind(&candidate.manifest_key)
        .bind(candidate.transaction_id)
        .bind(repaired_by_staff_id)
        .bind(reason.trim())
        .bind(&current_manifest_digest)
        .bind(i32::try_from(current_candidate_count).unwrap_or(i32::MAX))
        .bind(&candidate.source_snapshot)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(repair_id) = repair_id else {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "transaction {} already has an audit row for this exact manifest; refresh the preview; no changes were committed",
                candidate.display_id
            )));
        };

        let line_result = sqlx::query(
            r#"
            UPDATE transaction_lines tl
            SET booked_at = t.booked_at
            FROM transactions t
            WHERE t.id = $1
              AND tl.transaction_id = t.id
              AND tl.id = ANY($2)
              AND COALESCE(t.is_counterpoint_import, FALSE)
              AND tl.booked_at IS DISTINCT FROM t.booked_at
            "#,
        )
        .bind(candidate.transaction_id)
        .bind(&candidate.transaction_line_ids)
        .execute(&mut *tx)
        .await?;
        if line_result.rows_affected() != candidate.line_rows_to_update as u64 {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "transaction {} line timestamps changed after manifest review; no changes were committed",
                candidate.display_id
            )));
        }

        let event_result = sqlx::query(
            r#"
            UPDATE transaction_line_booking_events e
            SET booked_at = t.booked_at,
                metadata = COALESCE(e.metadata, '{}'::jsonb) || jsonb_build_object(
                    'counterpoint_booking_date_repair_id', $2::text,
                    'counterpoint_booking_date_repair_manifest_key', $3::text
                )
            FROM transactions t, transaction_lines tl
            WHERE t.id = $1
              AND tl.transaction_id = t.id
              AND e.transaction_id = t.id
              AND e.transaction_line_id = tl.id
              AND e.event_kind = 'initial_booking'
              AND e.id = ANY($4)
              AND COALESCE(t.is_counterpoint_import, FALSE)
              AND e.booked_at IS DISTINCT FROM t.booked_at
            "#,
        )
        .bind(candidate.transaction_id)
        .bind(repair_id)
        .bind(&candidate.manifest_key)
        .bind(&candidate.booking_event_ids)
        .execute(&mut *tx)
        .await?;
        if event_result.rows_affected() != candidate.booking_events_to_update as u64 {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "transaction {} booking events changed after manifest review; no changes were committed",
                candidate.display_id
            )));
        }

        let result_snapshot = json!({
            "transaction_id": candidate.transaction_id,
            "display_id": candidate.display_id,
            "target_booked_at": candidate.target_booked_at,
            "line_rows_updated": line_result.rows_affected(),
            "booking_events_updated": event_result.rows_affected(),
            "financial_values_unchanged": {
                "header_total": candidate.header_total,
                "line_total": candidate.line_total,
                "stored_amount_paid": candidate.stored_amount_paid,
                "allocated_tender_total": candidate.allocated_tender_total,
            },
            "remaining_manual_event_review": {
                "orphaned_initial_booking_event_count": candidate.orphaned_initial_booking_event_count,
                "unreviewed_adjustment_event_count": candidate.unreviewed_adjustment_event_count,
            },
            "tender_values_changed": false,
            "review_manifest_digest": &current_manifest_digest,
            "review_manifest_candidate_count": current_candidate_count,
        });

        sqlx::query(
            r#"
            UPDATE counterpoint_booking_date_repair_audit
            SET line_rows_updated = $2,
                booking_events_updated = $3,
                result_snapshot = $4
            WHERE id = $1
            "#,
        )
        .bind(repair_id)
        .bind(i32::try_from(line_result.rows_affected()).unwrap_or(i32::MAX))
        .bind(i32::try_from(event_result.rows_affected()).unwrap_or(i32::MAX))
        .bind(&result_snapshot)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO transaction_activity_log (
                transaction_id, customer_id, event_kind, summary, metadata
            )
            SELECT
                t.id,
                t.customer_id,
                'counterpoint_booking_date_repair',
                'Aligned imported line booking evidence to the retained Counterpoint transaction booking time.',
                jsonb_build_object(
                    'counterpoint_booking_date_repair_id', $2::text,
                    'manifest_key', $3::text,
                    'repaired_by_staff_id', $4::text,
                    'reason', $5::text,
                    'line_rows_updated', $6::bigint,
                    'booking_events_updated', $7::bigint,
                    'review_manifest_digest', $8::text,
                    'tender_values_changed', FALSE
                )
            FROM transactions t
            WHERE t.id = $1
            "#,
        )
        .bind(candidate.transaction_id)
        .bind(repair_id)
        .bind(&candidate.manifest_key)
        .bind(repaired_by_staff_id)
        .bind(reason.trim())
        .bind(line_result.rows_affected() as i64)
        .bind(event_result.rows_affected() as i64)
        .bind(&current_manifest_digest)
        .execute(&mut *tx)
        .await?;

        repaired_transactions += 1;
        line_rows_updated += line_result.rows_affected();
        booking_events_updated += event_result.rows_affected();
    }

    let (
        remaining_booking_date_candidates,
        remaining_financial_review_count,
        remaining_event_review_count,
    ): (i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint FROM reporting.counterpoint_booking_date_repair_manifest),
            (
                SELECT COUNT(*)::bigint
                FROM reporting.counterpoint_import_financial_integrity
                WHERE cardinality(import_snapshot_review_codes) > 0
            ),
            (
                SELECT COUNT(*)::bigint
                FROM reporting.counterpoint_import_financial_integrity
                WHERE orphaned_initial_booking_event_count > 0
                   OR unreviewed_adjustment_event_count > 0
            )
        "#,
    )
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(CounterpointBookingDateRepairApplySummary {
        applied_manifest_digest: current_manifest_digest,
        repaired_transactions,
        line_rows_updated,
        booking_events_updated,
        already_applied_manifests,
        remaining_booking_date_candidates,
        remaining_financial_review_count,
        remaining_event_review_count,
        tender_values_changed: false,
    })
}

async fn reconciliation_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    transaction_ids: &[Uuid],
) -> Result<JsonValue, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT jsonb_build_object(
            'transactions', COALESCE((
                SELECT jsonb_agg(to_jsonb(t) ORDER BY t.booked_at, t.id)
                FROM transactions t
                WHERE t.id = ANY($1)
            ), '[]'::jsonb),
            'lines', COALESCE((
                SELECT jsonb_agg(to_jsonb(tl) ORDER BY tl.transaction_id, tl.id)
                FROM transaction_lines tl
                WHERE tl.transaction_id = ANY($1)
            ), '[]'::jsonb),
            'payments', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object('payment', to_jsonb(pt), 'allocation', to_jsonb(pa))
                    ORDER BY pt.created_at, pt.id
                )
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = ANY($1)
            ), '[]'::jsonb)
        )
        "#,
    )
    .bind(transaction_ids)
    .fetch_one(&mut **tx)
    .await
}

pub async fn apply_counterpoint_transaction_reconciliation(
    pool: &PgPool,
    reconciled_by_staff_id: Uuid,
    confirmation_phrase: &str,
    reason: &str,
    expected_manifest_digest: &str,
    expected_candidate_count: usize,
) -> Result<CounterpointReconciliationApplySummary, CounterpointSyncError> {
    if confirmation_phrase.trim() != COUNTERPOINT_RECONCILIATION_CONFIRMATION {
        return Err(CounterpointSyncError::InvalidPayload(
            "confirmation phrase did not match".to_string(),
        ));
    }
    if reason.trim().len() < 12 {
        return Err(CounterpointSyncError::InvalidPayload(
            "a reconciliation reason of at least 12 characters is required".to_string(),
        ));
    }
    if expected_manifest_digest.trim().len() != 64 {
        return Err(CounterpointSyncError::InvalidPayload(
            "a valid reviewed reconciliation manifest digest is required".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtext('counterpoint_transaction_reconciliation'))",
    )
    .execute(&mut *tx)
    .await?;
    let preview_candidates = discover_candidates(&mut tx).await?;
    let transaction_ids = preview_candidates
        .iter()
        .flat_map(|candidate| {
            std::iter::once(candidate.summary.canonical_transaction_id)
                .chain(candidate.ticket_transaction_ids.iter().copied())
        })
        .collect::<Vec<_>>();
    let payment_ids = preview_candidates
        .iter()
        .flat_map(|candidate| candidate.manifest_payments.iter().map(|payment| payment.id))
        .collect::<Vec<_>>();
    if !transaction_ids.is_empty() {
        sqlx::query("SELECT id FROM transactions WHERE id = ANY($1) FOR UPDATE")
            .bind(&transaction_ids)
            .fetch_all(&mut *tx)
            .await?;
    }
    if !payment_ids.is_empty() {
        sqlx::query(
            r#"
            SELECT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pa.transaction_id = ANY($1)
            FOR UPDATE OF pa, pt
            "#,
        )
        .bind(&payment_ids)
        .fetch_all(&mut *tx)
        .await?;
    }

    let candidates = discover_candidates(&mut tx).await?;
    let current_manifest_digest = manifest_digest(&reconciliation_manifest_payload(&candidates))?;
    if candidates.len() != expected_candidate_count
        || current_manifest_digest != expected_manifest_digest.trim()
    {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "the order/payment reconciliation manifest changed after review (reviewed {} candidate(s), current {}); refresh the preview and review again; no changes were committed",
            expected_candidate_count,
            candidates.len()
        )));
    }
    let remaining_review_count = candidates
        .iter()
        .filter(|candidate| !candidate.summary.ready)
        .count();

    let mut summary = CounterpointReconciliationApplySummary {
        applied_manifest_digest: current_manifest_digest.clone(),
        reconciled_orders: 0,
        superseded_ticket_transactions: 0,
        moved_payments: 0,
        superseded_duplicate_payments: 0,
        remaining_review_count,
    };

    for candidate in candidates
        .into_iter()
        .filter(|candidate| candidate.summary.ready)
    {
        let canonical_id = candidate.summary.canonical_transaction_id;
        let mut snapshot_transaction_ids = vec![canonical_id];
        snapshot_transaction_ids.extend(candidate.ticket_transaction_ids.iter().copied());

        sqlx::query("SELECT id FROM transactions WHERE id = ANY($1) FOR UPDATE")
            .bind(&snapshot_transaction_ids)
            .fetch_all(&mut *tx)
            .await?;
        let snapshot = reconciliation_snapshot(&mut tx, &snapshot_transaction_ids).await?;
        let moved_payment_ids = candidate
            .moved_payments
            .iter()
            .map(|payment| payment.id)
            .collect::<Vec<_>>();
        let duplicate_payment_ids = candidate
            .duplicate_payments
            .iter()
            .map(|payment| payment.id)
            .collect::<Vec<_>>();

        let reconciliation_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO counterpoint_transaction_reconciliation (
                canonical_transaction_id,
                superseded_transaction_ids,
                moved_payment_ids,
                superseded_payment_ids,
                snapshot,
                reconciled_by_staff_id,
                reason,
                review_manifest_digest
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
            "#,
        )
        .bind(canonical_id)
        .bind(&candidate.ticket_transaction_ids)
        .bind(&moved_payment_ids)
        .bind(&duplicate_payment_ids)
        .bind(json!({
            "source": snapshot,
            "line_signature": candidate.line_signature,
            "preview": candidate.summary,
            "review_manifest_digest": &current_manifest_digest,
            "review_manifest_candidate_count": expected_candidate_count,
        }))
        .bind(reconciled_by_staff_id)
        .bind(reason.trim())
        .bind(&current_manifest_digest)
        .fetch_one(&mut *tx)
        .await?;

        for payment in &candidate.moved_payments {
            let moved = sqlx::query(
                r#"
                UPDATE payment_allocations
                SET target_transaction_id = $1,
                    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                        'counterpoint_reconciliation_id', $2::text,
                        'counterpoint_reconciliation_action', 'moved_to_original_order',
                        'counterpoint_reconciliation_from_transaction_id', $3::text
                    )
                WHERE transaction_id = $4
                  AND target_transaction_id = $3
                "#,
            )
            .bind(canonical_id)
            .bind(reconciliation_id)
            .bind(payment.target_transaction_id)
            .bind(payment.id)
            .execute(&mut *tx)
            .await?;
            if moved.rows_affected() != 1 {
                return Err(CounterpointSyncError::InvalidPayload(format!(
                    "payment {} changed during reconciliation; no changes were committed",
                    payment.id
                )));
            }
            sqlx::query(
                r#"
                UPDATE payment_transactions
                SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'counterpoint_reconciliation_id', $1::text,
                    'counterpoint_reconciliation_action', 'moved_to_original_order'
                )
                WHERE id = $2
                "#,
            )
            .bind(reconciliation_id)
            .bind(payment.id)
            .execute(&mut *tx)
            .await?;
        }

        for payment in &candidate.duplicate_payments {
            let removed = sqlx::query(
                "DELETE FROM payment_allocations WHERE transaction_id = $1 AND target_transaction_id = $2",
            )
            .bind(payment.id)
            .bind(payment.target_transaction_id)
            .execute(&mut *tx)
            .await?;
            if removed.rows_affected() != 1 {
                return Err(CounterpointSyncError::InvalidPayload(format!(
                    "duplicate payment {} changed during reconciliation; no changes were committed",
                    payment.id
                )));
            }
            sqlx::query(
                r#"
                UPDATE payment_transactions
                SET amount = 0,
                    merchant_fee = 0,
                    net_amount = 0,
                    status = 'superseded',
                    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                        'counterpoint_reconciliation_id', $1::text,
                        'counterpoint_reconciliation_action', 'superseded_duplicate',
                        'counterpoint_reconciliation_original_amount', $2::text
                    )
                WHERE id = $3
                "#,
            )
            .bind(reconciliation_id)
            .bind(payment.amount)
            .bind(payment.id)
            .execute(&mut *tx)
            .await?;
        }

        let reconciled_amount = candidate
            .summary
            .reconciled_amount_paid
            .parse::<Decimal>()
            .map_err(|_| {
                CounterpointSyncError::InvalidPayload(
                    "reconciled amount could not be parsed".to_string(),
                )
            })?;
        sqlx::query(
            r#"
            UPDATE transactions
            SET amount_paid = $2,
                balance_due = GREATEST(total_price - $2, 0),
                primary_salesperson_id = COALESCE($4, primary_salesperson_id),
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'counterpoint_reconciliation_status', 'reconciled',
                    'counterpoint_reconciliation_id', $3::text,
                    'counterpoint_reconciled_at', NOW()
                )
            WHERE id = $1
            "#,
        )
        .bind(canonical_id)
        .bind(reconciled_amount)
        .bind(reconciliation_id)
        .bind(candidate.ticket_primary_salesperson_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE transactions
            SET status = 'cancelled',
                fulfilled_at = NULL,
                total_price = 0,
                amount_paid = 0,
                balance_due = 0,
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'counterpoint_reconciliation_status', 'superseded',
                    'counterpoint_reconciliation_id', $2::text,
                    'counterpoint_reconciliation_canonical_transaction_id', $3::text,
                    'counterpoint_reconciled_at', NOW()
                )
            WHERE id = ANY($1)
              AND (
                  counterpoint_ticket_ref IS NOT NULL
                  OR counterpoint_doc_ref IS NOT NULL
              )
            "#,
        )
        .bind(&candidate.ticket_transaction_ids)
        .bind(reconciliation_id)
        .bind(canonical_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO transaction_activity_log (
                transaction_id, customer_id, event_kind, summary, metadata
            )
            SELECT
                id,
                customer_id,
                'counterpoint_reconciliation',
                'Reconciled legacy Counterpoint order payments and duplicate ticket history.',
                jsonb_build_object(
                    'counterpoint_reconciliation_id', $2::text,
                    'reconciled_by_staff_id', $3::text,
                    'reason', $4,
                    'canonical_transaction_id', $1::text,
                    'review_manifest_digest', $6::text
                )
            FROM transactions
            WHERE id = ANY($5)
            "#,
        )
        .bind(canonical_id)
        .bind(reconciliation_id)
        .bind(reconciled_by_staff_id)
        .bind(reason.trim())
        .bind(&snapshot_transaction_ids)
        .bind(&current_manifest_digest)
        .execute(&mut *tx)
        .await?;

        summary.reconciled_orders += 1;
        summary.superseded_ticket_transactions += candidate.ticket_transaction_ids.len();
        summary.moved_payments += candidate.moved_payments.len();
        summary.superseded_duplicate_payments += candidate.duplicate_payments.len();
    }

    tx.commit().await?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;

    async fn test_pool() -> PgPool {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must name an isolated migrated test database");
        PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
            .expect("connect to reconciliation test database")
    }

    #[tokio::test]
    #[ignore = "requires an isolated migrated test database"]
    async fn booking_date_repair_is_audited_and_never_changes_tenders() {
        let pool = test_pool().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let transaction_id = Uuid::new_v4();
        let staff_id: Uuid = sqlx::query_scalar("SELECT id FROM staff ORDER BY created_at LIMIT 1")
            .fetch_one(&pool)
            .await
            .expect("seeded staff is required");
        let (product_id, variant_id): (Uuid, Uuid) = sqlx::query_as(
            r#"
            SELECT p.id, pv.id
            FROM products p
            INNER JOIN product_variants pv ON pv.product_id = p.id
            ORDER BY p.created_at, pv.created_at
            LIMIT 1
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("seeded product variant is required");
        let source_booked_at = Utc::now() - chrono::Duration::days(45);
        let wrong_imported_at = Utc::now();
        let total = Decimal::new(4000, 2);

        sqlx::query(
            r#"
            INSERT INTO transactions (
                id, status, booked_at, total_price, amount_paid, balance_due,
                counterpoint_ticket_ref, is_counterpoint_import, display_id
            )
            VALUES ($1, 'fulfilled', $2, $3, $3, 0, $4, TRUE, $5)
            "#,
        )
        .bind(transaction_id)
        .bind(source_booked_at)
        .bind(total)
        .bind(format!("CP-DATE-REPAIR-{suffix}"))
        .bind(format!("TEST-DATE-REPAIR-{suffix}"))
        .execute(&pool)
        .await
        .expect("insert imported transaction fixture");

        sqlx::query(
            r#"
            INSERT INTO transaction_lines (
                transaction_id, product_id, variant_id, fulfillment, quantity,
                unit_price, unit_cost, state_tax, local_tax, booked_at,
                is_fulfilled, fulfilled_at
            )
            VALUES ($1, $2, $3, 'takeaway', 1, $4, 0, 0, 0, $5, TRUE, $6)
            "#,
        )
        .bind(transaction_id)
        .bind(product_id)
        .bind(variant_id)
        .bind(total)
        .bind(wrong_imported_at)
        .bind(source_booked_at)
        .execute(&pool)
        .await
        .expect("insert mismatched imported line fixture");

        let payment_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO payment_transactions (
                category, payment_method, amount, created_at, effective_date, metadata
            )
            VALUES (
                'retail_sale', 'cash', $1, $2,
                ($2 AT TIME ZONE reporting.effective_store_timezone())::date,
                jsonb_build_object('counterpoint_ticket_ref', $3::text)
            )
            RETURNING id
            "#,
        )
        .bind(total)
        .bind(source_booked_at)
        .bind(format!("CP-DATE-REPAIR-{suffix}"))
        .fetch_one(&pool)
        .await
        .expect("insert imported tender fixture");
        sqlx::query(
            "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
        )
        .bind(payment_id)
        .bind(transaction_id)
        .bind(total)
        .execute(&pool)
        .await
        .expect("allocate imported tender fixture");

        let preview = preview_counterpoint_booking_date_repairs(&pool)
            .await
            .expect("preview booking-date repair");
        let candidate = preview
            .candidates
            .iter()
            .find(|candidate| candidate.transaction_id == transaction_id)
            .expect("fixture appears in dry-run manifest");
        assert_eq!(candidate.line_rows_to_update, 1);
        assert_eq!(candidate.booking_events_to_update, 1);
        assert!(preview.tender_values_read_only);

        let applied = apply_counterpoint_booking_date_repairs(
            &pool,
            staff_id,
            COUNTERPOINT_BOOKING_DATE_REPAIR_CONFIRMATION,
            "Verified Counterpoint source booking timestamp",
            &preview.manifest_digest,
            preview.candidate_count,
        )
        .await
        .expect("apply booking-date repair");
        assert_eq!(applied.repaired_transactions, 1);
        assert_eq!(applied.line_rows_updated, 1);
        assert_eq!(applied.booking_events_updated, 1);
        assert!(!applied.tender_values_changed);

        let repaired_truth: (bool, bool, Decimal, Decimal, i64, i64) = sqlx::query_as(
            r#"
            SELECT
                bool_and(tl.booked_at = t.booked_at),
                bool_and(e.booked_at = t.booked_at),
                pt.amount,
                pa.amount_allocated,
                COUNT(DISTINCT repair.id)::bigint,
                COUNT(DISTINCT activity.id)::bigint
            FROM transactions t
            INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
            INNER JOIN transaction_line_booking_events e
                ON e.transaction_id = t.id
               AND e.transaction_line_id = tl.id
               AND e.event_kind = 'initial_booking'
            INNER JOIN payment_allocations pa ON pa.target_transaction_id = t.id
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            LEFT JOIN counterpoint_booking_date_repair_audit repair
                ON repair.transaction_id = t.id
            LEFT JOIN transaction_activity_log activity
                ON activity.transaction_id = t.id
               AND activity.event_kind = 'counterpoint_booking_date_repair'
            WHERE t.id = $1
            GROUP BY pt.amount, pa.amount_allocated
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&pool)
        .await
        .expect("load repaired booking and tender truth");
        assert_eq!(repaired_truth, (true, true, total, total, 1, 1));

        let stale_apply = apply_counterpoint_booking_date_repairs(
            &pool,
            staff_id,
            COUNTERPOINT_BOOKING_DATE_REPAIR_CONFIRMATION,
            "Verified Counterpoint source booking timestamp",
            &preview.manifest_digest,
            preview.candidate_count,
        )
        .await;
        assert!(stale_apply.is_err(), "a stale reviewed manifest must abort");

        let second_preview = preview_counterpoint_booking_date_repairs(&pool)
            .await
            .expect("refresh empty booking-date manifest");
        let second = apply_counterpoint_booking_date_repairs(
            &pool,
            staff_id,
            COUNTERPOINT_BOOKING_DATE_REPAIR_CONFIRMATION,
            "Verified Counterpoint source booking timestamp",
            &second_preview.manifest_digest,
            second_preview.candidate_count,
        )
        .await
        .expect("fresh empty booking-date manifest is a safe no-op");
        assert_eq!(second.repaired_transactions, 0);
        assert!(!second.tender_values_changed);

        sqlx::query("DELETE FROM counterpoint_booking_date_repair_audit WHERE transaction_id = $1")
            .bind(transaction_id)
            .execute(&pool)
            .await
            .expect("cleanup repair audit fixture");
        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = $1")
            .bind(transaction_id)
            .execute(&pool)
            .await
            .expect("cleanup payment allocation fixture");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = $1")
            .bind(transaction_id)
            .execute(&pool)
            .await
            .expect("cleanup line fixture");
        sqlx::query("DELETE FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .execute(&pool)
            .await
            .expect("cleanup transaction fixture");
        sqlx::query("DELETE FROM payment_transactions WHERE id = $1")
            .bind(payment_id)
            .execute(&pool)
            .await
            .expect("cleanup payment fixture");
    }

    #[tokio::test]
    #[ignore = "requires an isolated migrated test database"]
    async fn post_import_return_is_current_state_not_import_corruption() {
        let pool = test_pool().await;
        let mut tx = pool.begin().await.expect("begin isolated fixture");
        let suffix = Uuid::new_v4().simple().to_string();
        let transaction_id = Uuid::new_v4();
        let (product_id, variant_id): (Uuid, Uuid) = sqlx::query_as(
            r#"
            SELECT p.id, pv.id
            FROM products p
            INNER JOIN product_variants pv ON pv.product_id = p.id
            ORDER BY p.created_at, pv.created_at
            LIMIT 1
            "#,
        )
        .fetch_one(&mut *tx)
        .await
        .expect("seeded product variant is required");
        let booked_at = Utc::now() - chrono::Duration::days(30);
        let total = Decimal::new(4000, 2);
        let ticket_ref = format!("CP-RETURN-NET-{suffix}");

        sqlx::query(
            r#"
            INSERT INTO transactions (
                id, status, booked_at, total_price, amount_paid, balance_due,
                counterpoint_ticket_ref, is_counterpoint_import, display_id
            )
            VALUES ($1, 'fulfilled', $2, 0, $3, -$3, $4, TRUE, $5)
            "#,
        )
        .bind(transaction_id)
        .bind(booked_at)
        .bind(total)
        .bind(&ticket_ref)
        .bind(format!("TEST-RETURN-NET-{suffix}"))
        .execute(&mut *tx)
        .await
        .expect("insert returned imported transaction");

        let line_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO transaction_lines (
                transaction_id, product_id, variant_id, fulfillment, quantity,
                unit_price, unit_cost, state_tax, local_tax, booked_at,
                is_fulfilled, fulfilled_at
            )
            VALUES ($1, $2, $3, 'takeaway', 1, $4, 0, 0, 0, $5, TRUE, $5)
            RETURNING id
            "#,
        )
        .bind(transaction_id)
        .bind(product_id)
        .bind(variant_id)
        .bind(total)
        .bind(booked_at)
        .fetch_one(&mut *tx)
        .await
        .expect("insert returned imported line");

        let financial_evidence = json!({
            "imported_header_total": total,
            "imported_line_total": total,
            "source_tender_total": total,
            "source_tender_rows_present": true,
            "source_header_line_delta": "0.00",
            "source_tender_line_delta": "0.00",
            "source_header_tender_delta": "0.00",
            "source_amount_paid_tender_delta": "0.00",
            "review_codes": [],
        });
        sqlx::query(
            r#"
            INSERT INTO transaction_activity_log (
                transaction_id, event_kind, summary, metadata, created_at
            )
            VALUES (
                $1, 'counterpoint_import', 'Retained immutable import evidence.',
                jsonb_build_object('financial_evidence', $2::jsonb), $3
            )
            "#,
        )
        .bind(transaction_id)
        .bind(financial_evidence)
        .bind(booked_at)
        .execute(&mut *tx)
        .await
        .expect("insert immutable financial evidence");

        sqlx::query(
            r#"
            INSERT INTO transaction_return_lines (
                transaction_id, transaction_line_id, quantity_returned, reason,
                refund_event_id, refund_subtotal, refund_state_tax,
                refund_local_tax, refund_total
            )
            VALUES ($1, $2, 1, 'Customer return after import', $3, $4, 0, 0, $4)
            "#,
        )
        .bind(transaction_id)
        .bind(line_id)
        .bind(Uuid::new_v4())
        .bind(total)
        .execute(&mut *tx)
        .await
        .expect("insert post-import return");

        let refund_payment_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO payment_transactions (
                category, payment_method, amount, status, created_at, metadata
            )
            VALUES (
                'retail_sale', 'cash', -$1, 'success', NOW(),
                jsonb_build_object('kind', 'order_refund')
            )
            RETURNING id
            "#,
        )
        .bind(total)
        .fetch_one(&mut *tx)
        .await
        .expect("insert post-import refund payment");
        sqlx::query(
            "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, -$3)",
        )
        .bind(refund_payment_id)
        .bind(transaction_id)
        .bind(total)
        .execute(&mut *tx)
        .await
        .expect("allocate post-import refund");

        let (status, review_codes, has_post_import_activity): (String, Vec<String>, bool) =
            sqlx::query_as(
                r#"
                SELECT integrity_status, review_codes, has_post_import_activity
                FROM reporting.counterpoint_import_financial_integrity
                WHERE transaction_id = $1
                "#,
            )
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await
            .expect("load immutable import versus current net classification");
        assert_eq!(status, "ok");
        assert!(has_post_import_activity);
        assert!(!review_codes
            .iter()
            .any(|code| code == "current_net_changed_without_post_import_evidence"));

        tx.rollback().await.expect("rollback isolated fixture");
    }

    #[tokio::test]
    async fn exact_legacy_order_reconciliation_moves_only_the_real_later_payment() {
        let pool = test_pool().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let customer_id = Uuid::new_v4();
        let canonical_id = Uuid::new_v4();
        let initial_ticket_id = Uuid::new_v4();
        let later_ticket_id = Uuid::new_v4();
        let staff_id: Uuid = sqlx::query_scalar("SELECT id FROM staff ORDER BY created_at LIMIT 1")
            .fetch_one(&pool)
            .await
            .expect("seeded staff is required");
        let (product_id, variant_id): (Uuid, Uuid) = sqlx::query_as(
            r#"
            SELECT p.id, pv.id
            FROM products p
            INNER JOIN product_variants pv ON pv.product_id = p.id
            ORDER BY p.created_at, pv.created_at
            LIMIT 1
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("seeded product variant is required");
        let booked_at = Utc::now() - chrono::Duration::days(30);
        let later_at = booked_at + chrono::Duration::days(14);
        let total = Decimal::new(26000, 2);
        let deposit = Decimal::new(13000, 2);

        sqlx::query(
            "INSERT INTO customers (id, first_name, last_name, customer_code, customer_created_source) VALUES ($1, 'Legacy', 'Repair Test', $2, 'counterpoint')",
        )
        .bind(customer_id)
        .bind(format!("CP-REPAIR-{suffix}"))
        .execute(&pool)
        .await
        .expect("insert reconciliation customer");

        for (id, display_id, ticket_ref, doc_ref, at, status) in [
            (
                canonical_id,
                format!("TEST-DOC-{suffix}"),
                None,
                Some(format!("O-{suffix}")),
                booked_at,
                "open",
            ),
            (
                initial_ticket_id,
                format!("TEST-TKT-A-{suffix}"),
                Some(format!("CP-TICKET-A-{suffix}")),
                None,
                booked_at,
                "fulfilled",
            ),
            (
                later_ticket_id,
                format!("TEST-TKT-B-{suffix}"),
                Some(format!("CP-TICKET-B-{suffix}")),
                None,
                later_at,
                "fulfilled",
            ),
        ] {
            sqlx::query(
                r#"
                INSERT INTO transactions (
                    id, customer_id, status, booked_at, total_price, amount_paid, balance_due,
                    counterpoint_ticket_ref, counterpoint_doc_ref, is_counterpoint_import,
                    display_id
                )
                VALUES ($1, $2, $3::order_status, $4, $5, $6, $7, $8, $9, TRUE, $10)
                "#,
            )
            .bind(id)
            .bind(customer_id)
            .bind(status)
            .bind(at)
            .bind(total)
            .bind(if id == canonical_id { deposit } else { total })
            .bind(if id == canonical_id {
                total - deposit
            } else {
                Decimal::ZERO
            })
            .bind(ticket_ref)
            .bind(doc_ref)
            .bind(display_id)
            .execute(&pool)
            .await
            .expect("insert reconciliation transaction");

            sqlx::query(
                r#"
                INSERT INTO transaction_lines (
                    transaction_id, product_id, variant_id, fulfillment, quantity,
                    unit_price, unit_cost, state_tax, local_tax
                )
                VALUES ($1, $2, $3, 'special_order', 1, $4, 100, 0, 0)
                "#,
            )
            .bind(id)
            .bind(product_id)
            .bind(variant_id)
            .bind(total)
            .execute(&pool)
            .await
            .expect("insert reconciliation line");
        }

        let mut payment_ids = Vec::new();
        for (target_id, at) in [
            (canonical_id, booked_at),
            (initial_ticket_id, booked_at),
            (later_ticket_id, later_at),
        ] {
            let payment_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    payer_id, category, payment_method, amount, created_at,
                    occurred_at, effective_date, status, metadata
                )
                VALUES ($1, 'retail_sale', 'credit_card', $2, $3, $3,
                    ($3 AT TIME ZONE reporting.effective_store_timezone())::date,
                    'success', jsonb_build_object('test', 'counterpoint_reconciliation'))
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(deposit)
            .bind(at)
            .fetch_one(&pool)
            .await
            .expect("insert reconciliation payment");
            payment_ids.push(payment_id);
            sqlx::query(
                "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(payment_id)
            .bind(target_id)
            .bind(deposit)
            .execute(&pool)
            .await
            .expect("insert reconciliation allocation");
        }

        let preview = preview_counterpoint_transaction_reconciliation(&pool)
            .await
            .expect("preview exact reconciliation");
        let candidate = preview
            .candidates
            .iter()
            .find(|candidate| candidate.canonical_transaction_id == canonical_id)
            .expect("test candidate is present");
        assert!(candidate.ready, "{}", candidate.review_reason);
        assert_eq!(candidate.payments_to_move, 1);
        assert_eq!(candidate.duplicate_payments_to_supersede, 1);

        sqlx::query("UPDATE payment_transactions SET status = 'pending' WHERE id = $1")
            .bind(payment_ids[2])
            .execute(&pool)
            .await
            .expect("drift reviewed payment status");
        let stale_apply = apply_counterpoint_transaction_reconciliation(
            &pool,
            staff_id,
            COUNTERPOINT_RECONCILIATION_CONFIRMATION,
            "Automated test of exact Counterpoint order reconciliation.",
            &preview.manifest_digest,
            preview.candidate_count,
        )
        .await;
        assert!(
            stale_apply.is_err(),
            "payment drift must abort the whole repair"
        );
        let unchanged_target: Uuid = sqlx::query_scalar(
            "SELECT target_transaction_id FROM payment_allocations WHERE transaction_id = $1",
        )
        .bind(payment_ids[2])
        .fetch_one(&pool)
        .await
        .expect("load allocation after stale repair rejection");
        assert_eq!(unchanged_target, later_ticket_id);
        sqlx::query("UPDATE payment_transactions SET status = 'success' WHERE id = $1")
            .bind(payment_ids[2])
            .execute(&pool)
            .await
            .expect("restore reviewed payment status");
        let refreshed_preview = preview_counterpoint_transaction_reconciliation(&pool)
            .await
            .expect("refresh exact reconciliation after drift");

        let applied = apply_counterpoint_transaction_reconciliation(
            &pool,
            staff_id,
            COUNTERPOINT_RECONCILIATION_CONFIRMATION,
            "Automated test of exact Counterpoint order reconciliation.",
            &refreshed_preview.manifest_digest,
            refreshed_preview.candidate_count,
        )
        .await
        .expect("apply exact reconciliation");
        assert!(applied.reconciled_orders >= 1);

        let (amount_paid, balance_due): (Decimal, Decimal) =
            sqlx::query_as("SELECT amount_paid, balance_due FROM transactions WHERE id = $1")
                .bind(canonical_id)
                .fetch_one(&pool)
                .await
                .expect("load reconciled order totals");
        assert_eq!(amount_paid, total);
        assert_eq!(balance_due, Decimal::ZERO);

        let moved_target: Uuid = sqlx::query_scalar(
            "SELECT target_transaction_id FROM payment_allocations WHERE transaction_id = $1",
        )
        .bind(payment_ids[2])
        .fetch_one(&pool)
        .await
        .expect("load moved payment allocation");
        assert_eq!(moved_target, canonical_id);
        let (duplicate_amount, duplicate_status): (Decimal, String) =
            sqlx::query_as("SELECT amount, status FROM payment_transactions WHERE id = $1")
                .bind(payment_ids[1])
                .fetch_one(&pool)
                .await
                .expect("load superseded payment");
        assert_eq!(duplicate_amount, Decimal::ZERO);
        assert_eq!(duplicate_status, "superseded");

        sqlx::query("DELETE FROM counterpoint_transaction_reconciliation WHERE canonical_transaction_id = $1")
            .bind(canonical_id)
            .execute(&pool)
            .await
            .expect("cleanup reconciliation audit");
        sqlx::query("DELETE FROM transaction_activity_log WHERE transaction_id = ANY($1)")
            .bind(&[canonical_id, initial_ticket_id, later_ticket_id])
            .execute(&pool)
            .await
            .expect("cleanup reconciliation activity");
        sqlx::query("DELETE FROM payment_allocations WHERE transaction_id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup reconciliation allocations");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup reconciliation payments");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(&[canonical_id, initial_ticket_id, later_ticket_id])
            .execute(&pool)
            .await
            .expect("cleanup reconciliation lines");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&[canonical_id, initial_ticket_id, later_ticket_id])
            .execute(&pool)
            .await
            .expect("cleanup reconciliation transactions");
        sqlx::query("DELETE FROM customers WHERE id = $1")
            .bind(customer_id)
            .execute(&pool)
            .await
            .expect("cleanup reconciliation customer");
    }
}
