use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::logic::counterpoint_sync::CounterpointSyncError;

pub const COUNTERPOINT_RECONCILIATION_CONFIRMATION: &str = "RECONCILE COUNTERPOINT ORDERS";

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
    ticket_match_count: i64,
    line_signature: JsonValue,
}

#[derive(Debug, Clone, FromRow)]
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
    pub ready_count: usize,
    pub needs_review_count: usize,
    pub candidates: Vec<CounterpointReconciliationCandidateSummary>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointReconciliationApplySummary {
    pub reconciled_orders: usize,
    pub superseded_ticket_transactions: usize,
    pub moved_payments: usize,
    pub superseded_duplicate_payments: usize,
    pub remaining_review_count: usize,
}

#[derive(Debug, Clone)]
struct PreparedCandidate {
    summary: CounterpointReconciliationCandidateSummary,
    line_signature: JsonValue,
    ticket_transaction_ids: Vec<Uuid>,
    moved_payments: Vec<ReconciliationPaymentRow>,
    duplicate_payments: Vec<ReconciliationPaymentRow>,
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
            WHERE t.counterpoint_doc_ref IS NOT NULL
               OR t.counterpoint_ticket_ref IS NOT NULL
            GROUP BY t.id
        ), candidate_pairs AS (
            SELECT
                d.id AS canonical_transaction_id,
                COALESCE(NULLIF(TRIM(d.display_id), ''), d.counterpoint_doc_ref, d.id::text) AS canonical_display_id,
                d.counterpoint_doc_ref,
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
                t.counterpoint_ticket_ref,
                t.booked_at AS ticket_booked_at,
                ds.line_signature,
                COUNT(*) OVER (PARTITION BY t.id) AS ticket_match_count
            FROM transactions d
            INNER JOIN customers c ON c.id = d.customer_id
            INNER JOIN line_signatures ds ON ds.transaction_id = d.id
            INNER JOIN transactions t
                ON t.customer_id = d.customer_id
               AND t.counterpoint_ticket_ref IS NOT NULL
               AND t.id <> d.id
               AND ABS(COALESCE(t.total_price, 0) - COALESCE(d.total_price, 0)) <= 0.01
               AND t.booked_at >= d.booked_at - INTERVAL '5 minutes'
               AND t.booked_at <= d.booked_at + INTERVAL '730 days'
            INNER JOIN line_signatures ts
                ON ts.transaction_id = t.id
               AND ts.line_signature = ds.line_signature
            WHERE d.counterpoint_doc_ref IS NOT NULL
              AND d.customer_id IS NOT NULL
              AND COALESCE(d.total_price, 0) > 0
              AND ds.line_signature <> '[]'::jsonb
              AND COALESCE(d.metadata->>'counterpoint_reconciliation_status', '') <> 'reconciled'
              AND COALESCE(t.metadata->>'counterpoint_reconciliation_status', '') <> 'superseded'
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

        if group.iter().any(|row| row.ticket_match_count != 1) {
            review_reasons.push("At least one ticket matches more than one open order.");
        }
        if !group.iter().any(|row| {
            (row.ticket_booked_at - row.canonical_booked_at)
                .num_seconds()
                .abs()
                <= 300
        }) {
            review_reasons.push("No same-time ticket proves the original open-order lifecycle.");
        }

        let canonical_payments = payments_by_target
            .get(&canonical_id)
            .cloned()
            .unwrap_or_default();
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

        if moved_payments.is_empty() {
            review_reasons.push("No later payment can be moved to the original order.");
        }
        if (reconciled_amount - first.total_price).abs() > Decimal::new(1, 2) {
            review_reasons.push("Unique payment totals do not exactly equal the order total.");
        }

        review_reasons.sort_unstable();
        review_reasons.dedup();
        let ready = review_reasons.is_empty();
        let review_reason = if ready {
            "Exact customer, total, line, same-time ticket, and unique-payment match.".to_string()
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
    let summaries = candidates
        .into_iter()
        .map(|candidate| candidate.summary)
        .collect::<Vec<_>>();
    Ok(CounterpointReconciliationPreview {
        generated_at: Utc::now(),
        confirmation_phrase: COUNTERPOINT_RECONCILIATION_CONFIRMATION,
        ready_count: summaries.iter().filter(|candidate| candidate.ready).count(),
        needs_review_count: summaries
            .iter()
            .filter(|candidate| !candidate.ready)
            .count(),
        candidates: summaries,
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

    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtext('counterpoint_transaction_reconciliation'))",
    )
    .execute(&mut *tx)
    .await?;
    let candidates = discover_candidates(&mut tx).await?;
    let remaining_review_count = candidates
        .iter()
        .filter(|candidate| !candidate.summary.ready)
        .count();

    let mut summary = CounterpointReconciliationApplySummary {
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
                reason
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
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
        }))
        .bind(reconciled_by_staff_id)
        .bind(reason.trim())
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
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'counterpoint_reconciliation_status', 'reconciled',
                    'counterpoint_reconciliation_id', $3::text,
                    'counterpoint_reconciled_at', NOW()
                )
            WHERE id = $1
              AND counterpoint_doc_ref IS NOT NULL
            "#,
        )
        .bind(canonical_id)
        .bind(reconciled_amount)
        .bind(reconciliation_id)
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
              AND counterpoint_ticket_ref IS NOT NULL
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
                    'canonical_transaction_id', $1::text
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
        let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgresql://postgres:password@localhost:5433/riverside_os".to_string()
        });
        PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
            .expect("connect to reconciliation test database")
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

        let applied = apply_counterpoint_transaction_reconciliation(
            &pool,
            staff_id,
            COUNTERPOINT_RECONCILIATION_CONFIRMATION,
            "Automated test of exact Counterpoint order reconciliation.",
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
