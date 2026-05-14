use chrono::{NaiveDate, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Healthy,  // Green
    Concern,  // Amber
    Critical, // Red
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeddingHealthScore {
    pub wedding_id: Uuid,
    pub overall_score: f64, // 0.0 to 1.0
    pub status: HealthStatus,
    pub payment_progress: f64,
    pub measurement_progress: f64,
    pub days_until_event: i64,
    pub member_count: i64,
    pub measured_count: i64,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WeddingReadinessStatus {
    Safe,
    Watch,
    AtRisk,
    Critical,
    Complete,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WeddingReadinessSeverity {
    Blocking,
    Warning,
    Info,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeddingReadinessBlocker {
    pub severity: WeddingReadinessSeverity,
    pub label: String,
    pub explanation: String,
    pub next_safe_action: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct WeddingLifecycleCounts {
    pub needs_measurements: i64,
    pub ntbo: i64,
    pub ordered: i64,
    pub received: i64,
    pub ready_for_pickup: i64,
    pub picked_up: i64,
    pub open: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct WeddingMemberCounts {
    pub total: i64,
    pub measured: i64,
    pub ordered: i64,
    pub received: i64,
    pub fitting: i64,
    pub pickup_complete: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct WeddingPickupReadiness {
    pub ready_members: i64,
    pub blocked_members: i64,
    pub partial_ready_members: i64,
    pub balance_blocked_members: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct WeddingVendorRisk {
    pub ntbo_count: i64,
    pub stale_ordered_count: i64,
    pub missing_vendor_count: i64,
    pub delayed_vendor_count: i64,
    pub next_eta: Option<NaiveDate>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeddingReadinessMember {
    pub wedding_member_id: Uuid,
    pub customer_name: String,
    pub role: String,
    pub status: String,
    pub balance_due: Decimal,
    pub lifecycle: WeddingLifecycleCounts,
    pub blockers: Vec<WeddingReadinessBlocker>,
    pub next_safe_action: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeddingReadinessSummary {
    pub wedding_party_id: Uuid,
    pub party_name: String,
    pub event_date: NaiveDate,
    pub salesperson: Option<String>,
    pub days_until_event: i64,
    pub readiness_score: f64,
    pub status: WeddingReadinessStatus,
    pub lifecycle: WeddingLifecycleCounts,
    pub member_counts: WeddingMemberCounts,
    pub pickup: WeddingPickupReadiness,
    pub vendor_risk: WeddingVendorRisk,
    pub blockers: Vec<WeddingReadinessBlocker>,
    pub next_safe_action: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeddingReadinessDetail {
    #[serde(flatten)]
    pub summary: WeddingReadinessSummary,
    pub members: Vec<WeddingReadinessMember>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeddingReadinessDashboard {
    pub safe_count: i64,
    pub watch_count: i64,
    pub at_risk_count: i64,
    pub critical_count: i64,
    pub complete_count: i64,
    pub parties: Vec<WeddingReadinessSummary>,
}

#[derive(Debug, Clone)]
pub struct WeddingReadinessDashboardFilter {
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub salesperson: Option<String>,
    pub status: Option<WeddingReadinessStatus>,
    pub limit: i64,
}

#[derive(Debug, FromRow)]
struct ReadinessPartyRow {
    id: Uuid,
    party_name: Option<String>,
    groom_name: String,
    event_date: NaiveDate,
    salesperson: Option<String>,
}

#[derive(Debug, FromRow)]
struct MemberReadinessRow {
    wedding_member_id: Uuid,
    customer_name: Option<String>,
    role: String,
    measured: bool,
    suit_ordered: bool,
    received: bool,
    fitting: bool,
    pickup_status: Option<String>,
    balance_due: Decimal,
    needs_measurements_count: i64,
    ntbo_count: i64,
    ordered_count: i64,
    received_count: i64,
    ready_for_pickup_count: i64,
    picked_up_count: i64,
    open_count: i64,
}

pub async fn calculate_wedding_health(
    pool: &sqlx::PgPool,
    wedding_id: Uuid,
) -> Result<WeddingHealthScore, sqlx::Error> {
    // 1. Fetch event date
    let event_date = sqlx::query_scalar::<_, chrono::NaiveDate>(
        "SELECT event_date FROM wedding_parties WHERE id = $1",
    )
    .bind(wedding_id)
    .fetch_one(pool)
    .await?;

    // 2. Fetch Aggregates
    let stats = sqlx::query(
        r#"
        SELECT 
            COUNT(DISTINCT c.id) as total_members,
            COUNT(DISTINCT m.customer_id) as measured_members,
            COALESCE(SUM(o.total_price), 0) as total_value,
            COALESCE(SUM(o.amount_paid), 0) as total_paid
        FROM customers c
        LEFT JOIN measurements m ON m.customer_id = c.id
        LEFT JOIN transactions o ON o.customer_id = c.id AND o.status != 'cancelled'
        WHERE c.wedding_id = $1
        "#,
    )
    .bind(wedding_id)
    .fetch_one(pool)
    .await?;

    use sqlx::Row;

    let days_until = (event_date - Utc::now().naive_utc().date()).num_days();

    // Measurement Progress
    let total_members = stats.get::<Option<i64>, _>("total_members").unwrap_or(0);
    let measured_members = stats.get::<Option<i64>, _>("measured_members").unwrap_or(0);
    let measurement_progress = if total_members > 0 {
        measured_members as f64 / total_members as f64
    } else {
        1.0
    };

    // Payment Progress
    let total_value = stats
        .get::<Option<Decimal>, _>("total_value")
        .unwrap_or_default()
        .to_f64()
        .unwrap_or(0.0);
    let total_paid = stats
        .get::<Option<Decimal>, _>("total_paid")
        .unwrap_or_default()
        .to_f64()
        .unwrap_or(0.0);
    let payment_progress = if total_value > 0.0 {
        total_paid / total_value
    } else {
        1.0
    };

    // Overall Score Calculation (Weighted)
    // 40% Measurements, 40% Payments, 20% Baseline
    let mut score = (measurement_progress * 0.4) + (payment_progress * 0.4) + 0.2;

    // Time-based Penalty
    let mut status = HealthStatus::Healthy;
    let mut reason = "On track. Standard follow-up rules apply.".to_string();

    if days_until < 0 {
        reason = "Wedding date has passed.".to_string();
    } else if days_until < 14 {
        if score < 0.9 {
            status = HealthStatus::Critical;
            reason = format!(
                "Critical Risk: Event in {days_until} days with {}% completion.",
                (score * 100.0) as i32
            );
        } else if score < 0.98 {
            status = HealthStatus::Concern;
            reason = format!("Warning: Event in {days_until} days. Finalize remaining fittings.");
        }
    } else if days_until < 30 {
        if score < 0.7 {
            status = HealthStatus::Critical;
            reason =
                "High Risk: Significant missing measurements/payments < 30 days out.".to_string();
        } else if score < 0.85 {
            status = HealthStatus::Concern;
            reason = "Concern: Approaching 30-day window with incomplete party data.".to_string();
        }
    } else if score < 0.5 {
        status = HealthStatus::Concern;
        reason = "Initial Warning: Low engagement for upcoming event.".to_string();
    }

    // Cap score
    score = score.clamp(0.0, 1.0);

    Ok(WeddingHealthScore {
        wedding_id,
        overall_score: score,
        status,
        payment_progress,
        measurement_progress,
        days_until_event: days_until,
        member_count: total_members,
        measured_count: measured_members,
        reason,
    })
}

pub async fn calculate_wedding_readiness(
    pool: &PgPool,
    wedding_id: Uuid,
) -> Result<WeddingReadinessDetail, sqlx::Error> {
    let party = sqlx::query_as::<_, ReadinessPartyRow>(
        r#"
        SELECT id, party_name, groom_name, event_date, salesperson
        FROM wedding_parties
        WHERE id = $1
        "#,
    )
    .bind(wedding_id)
    .fetch_one(pool)
    .await?;

    let lifecycle_row = sqlx::query(
        r#"
        WITH scoped AS (
            SELECT
                tl.order_lifecycle_status::text AS lifecycle_status,
                tl.vendor_id,
                tl.po_id,
                COALESCE(tl.vendor_eta::date, po.expected_at::date) AS vendor_eta,
                COALESCE(tl.ordered_at::date, t.booked_at::date) AS ordered_date
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            LEFT JOIN wedding_members wm ON wm.id = t.wedding_member_id
            INNER JOIN wedding_parties wp ON wp.id = COALESCE(tl.wedding_id, wm.wedding_party_id)
            LEFT JOIN purchase_orders po ON po.id = tl.po_id
            WHERE wp.id = $1
              AND tl.fulfillment::text <> 'takeaway'
        )
        SELECT
            COUNT(*) FILTER (WHERE lifecycle_status = 'needs_measurements')::bigint AS needs_measurements_count,
            COUNT(*) FILTER (WHERE lifecycle_status = 'ntbo')::bigint AS ntbo_count,
            COUNT(*) FILTER (WHERE lifecycle_status = 'ordered')::bigint AS ordered_count,
            COUNT(*) FILTER (WHERE lifecycle_status = 'received')::bigint AS received_count,
            COUNT(*) FILTER (WHERE lifecycle_status = 'ready_for_pickup')::bigint AS ready_for_pickup_count,
            COUNT(*) FILTER (WHERE lifecycle_status = 'picked_up')::bigint AS picked_up_count,
            COUNT(*) FILTER (WHERE lifecycle_status <> 'picked_up')::bigint AS open_count,
            COUNT(*) FILTER (
                WHERE lifecycle_status IN ('ntbo', 'ordered')
                  AND (vendor_id IS NULL OR po_id IS NULL)
            )::bigint AS missing_vendor_count,
            COUNT(*) FILTER (
                WHERE lifecycle_status = 'ordered'
                  AND ordered_date <= CURRENT_DATE - INTERVAL '14 days'
            )::bigint AS stale_ordered_count,
            COUNT(*) FILTER (
                WHERE lifecycle_status = 'ordered'
                  AND vendor_eta IS NOT NULL
                  AND vendor_eta < CURRENT_DATE
            )::bigint AS delayed_vendor_count,
            MIN(vendor_eta) FILTER (
                WHERE lifecycle_status IN ('ntbo', 'ordered')
                  AND vendor_eta >= CURRENT_DATE
            ) AS next_eta
        FROM scoped
        "#,
    )
    .bind(wedding_id)
    .fetch_one(pool)
    .await?;

    let lifecycle = WeddingLifecycleCounts {
        needs_measurements: lifecycle_row
            .get::<Option<i64>, _>("needs_measurements_count")
            .unwrap_or(0),
        ntbo: lifecycle_row
            .get::<Option<i64>, _>("ntbo_count")
            .unwrap_or(0),
        ordered: lifecycle_row
            .get::<Option<i64>, _>("ordered_count")
            .unwrap_or(0),
        received: lifecycle_row
            .get::<Option<i64>, _>("received_count")
            .unwrap_or(0),
        ready_for_pickup: lifecycle_row
            .get::<Option<i64>, _>("ready_for_pickup_count")
            .unwrap_or(0),
        picked_up: lifecycle_row
            .get::<Option<i64>, _>("picked_up_count")
            .unwrap_or(0),
        open: lifecycle_row
            .get::<Option<i64>, _>("open_count")
            .unwrap_or(0),
    };
    let vendor_risk = WeddingVendorRisk {
        ntbo_count: lifecycle.ntbo,
        stale_ordered_count: lifecycle_row
            .get::<Option<i64>, _>("stale_ordered_count")
            .unwrap_or(0),
        missing_vendor_count: lifecycle_row
            .get::<Option<i64>, _>("missing_vendor_count")
            .unwrap_or(0),
        delayed_vendor_count: lifecycle_row
            .get::<Option<i64>, _>("delayed_vendor_count")
            .unwrap_or(0),
        next_eta: lifecycle_row.get::<Option<NaiveDate>, _>("next_eta"),
    };

    let member_rows = sqlx::query_as::<_, MemberReadinessRow>(
        r#"
        WITH balances AS (
            SELECT wedding_member_id, COALESCE(SUM(balance_due), 0)::numeric(12,2) AS balance_due
            FROM transactions
            WHERE wedding_member_id IS NOT NULL
              AND status::text <> 'cancelled'
            GROUP BY wedding_member_id
        ),
        line_counts AS (
            SELECT
                t.wedding_member_id,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'needs_measurements')::bigint AS needs_measurements_count,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'ntbo')::bigint AS ntbo_count,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'ordered')::bigint AS ordered_count,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'received')::bigint AS received_count,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'ready_for_pickup')::bigint AS ready_for_pickup_count,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'picked_up')::bigint AS picked_up_count,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status <> 'picked_up')::bigint AS open_count
            FROM transactions t
            INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
            WHERE t.wedding_member_id IS NOT NULL
              AND t.status::text <> 'cancelled'
              AND tl.fulfillment::text <> 'takeaway'
            GROUP BY t.wedding_member_id
        )
        SELECT
            wm.id AS wedding_member_id,
            NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
            wm.role,
            COALESCE(wm.measured, false) AS measured,
            COALESCE(wm.suit_ordered, false) AS suit_ordered,
            COALESCE(wm.received, false) AS received,
            COALESCE(wm.fitting, false) AS fitting,
            wm.pickup_status,
            COALESCE(b.balance_due, 0)::numeric(12,2) AS balance_due,
            COALESCE(lc.needs_measurements_count, 0)::bigint AS needs_measurements_count,
            COALESCE(lc.ntbo_count, 0)::bigint AS ntbo_count,
            COALESCE(lc.ordered_count, 0)::bigint AS ordered_count,
            COALESCE(lc.received_count, 0)::bigint AS received_count,
            COALESCE(lc.ready_for_pickup_count, 0)::bigint AS ready_for_pickup_count,
            COALESCE(lc.picked_up_count, 0)::bigint AS picked_up_count,
            COALESCE(lc.open_count, 0)::bigint AS open_count
        FROM wedding_members wm
        JOIN customers c ON c.id = wm.customer_id
        LEFT JOIN balances b ON b.wedding_member_id = wm.id
        LEFT JOIN line_counts lc ON lc.wedding_member_id = wm.id
        WHERE wm.wedding_party_id = $1
        ORDER BY wm.member_index ASC, wm.created_at ASC
        "#,
    )
    .bind(wedding_id)
    .fetch_all(pool)
    .await?;

    let member_counts = WeddingMemberCounts {
        total: member_rows.len() as i64,
        measured: member_rows.iter().filter(|m| m.measured).count() as i64,
        ordered: member_rows.iter().filter(|m| m.suit_ordered).count() as i64,
        received: member_rows.iter().filter(|m| m.received).count() as i64,
        fitting: member_rows.iter().filter(|m| m.fitting).count() as i64,
        pickup_complete: member_rows
            .iter()
            .filter(|m| m.pickup_status.as_deref() == Some("complete"))
            .count() as i64,
    };

    let mut pickup = WeddingPickupReadiness::default();
    let mut members = Vec::with_capacity(member_rows.len());
    for row in member_rows {
        let member_lifecycle = WeddingLifecycleCounts {
            needs_measurements: row.needs_measurements_count,
            ntbo: row.ntbo_count,
            ordered: row.ordered_count,
            received: row.received_count,
            ready_for_pickup: row.ready_for_pickup_count,
            picked_up: row.picked_up_count,
            open: row.open_count,
        };
        let (status, blockers, next_safe_action) = member_readiness_state(&row, &member_lifecycle);
        match status.as_str() {
            "ready" => pickup.ready_members += 1,
            "partial" => pickup.partial_ready_members += 1,
            "balance_blocked" => {
                pickup.balance_blocked_members += 1;
                pickup.blocked_members += 1;
            }
            "blocked" => pickup.blocked_members += 1,
            _ => {}
        }
        members.push(WeddingReadinessMember {
            wedding_member_id: row.wedding_member_id,
            customer_name: row
                .customer_name
                .unwrap_or_else(|| "Wedding member".to_string()),
            role: row.role,
            status,
            balance_due: row.balance_due,
            lifecycle: member_lifecycle,
            blockers,
            next_safe_action,
        });
    }

    let mut blockers = party_blockers(
        &lifecycle,
        &member_counts,
        &pickup,
        &vendor_risk,
        party.event_date,
    );
    for member in &members {
        if member.status == "balance_blocked" {
            blockers.push(WeddingReadinessBlocker {
                severity: WeddingReadinessSeverity::Blocking,
                label: "Pickup blocked until balance is cleared".to_string(),
                explanation: format!(
                    "{} has ready garments but an open balance.",
                    member.customer_name
                ),
                next_safe_action: "Collect payment or review the Transaction Record before pickup."
                    .to_string(),
            });
        }
    }

    let days_until_event = (party.event_date - Utc::now().date_naive()).num_days();
    let status = party_status(
        &lifecycle,
        &pickup,
        &vendor_risk,
        &blockers,
        days_until_event,
    );
    let readiness_score = readiness_score(&lifecycle, &member_counts, &pickup, &vendor_risk);
    let next_safe_action = party_next_safe_action(&status, &blockers, &lifecycle, &pickup);
    let party_name = party
        .party_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(party.groom_name);

    Ok(WeddingReadinessDetail {
        summary: WeddingReadinessSummary {
            wedding_party_id: party.id,
            party_name,
            event_date: party.event_date,
            salesperson: party.salesperson,
            days_until_event,
            readiness_score,
            status,
            lifecycle,
            member_counts,
            pickup,
            vendor_risk,
            blockers,
            next_safe_action,
        },
        members,
    })
}

pub async fn list_wedding_readiness_dashboard(
    pool: &PgPool,
    filter: WeddingReadinessDashboardFilter,
) -> Result<WeddingReadinessDashboard, sqlx::Error> {
    let start = filter.start_date.unwrap_or_else(|| Utc::now().date_naive());
    let end = filter
        .end_date
        .unwrap_or_else(|| start + chrono::Duration::days(120));
    let limit = filter.limit.clamp(1, 200);
    let salesperson = filter
        .salesperson
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let party_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM wedding_parties
        WHERE (is_deleted IS NULL OR is_deleted = FALSE)
          AND event_date >= $1
          AND event_date <= $2
          AND ($3::text IS NULL OR salesperson = $3)
        ORDER BY event_date ASC, created_at ASC
        LIMIT $4
        "#,
    )
    .bind(start)
    .bind(end)
    .bind(salesperson)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut parties = Vec::with_capacity(party_ids.len());
    for party_id in party_ids {
        let detail = calculate_wedding_readiness(pool, party_id).await?;
        if filter
            .status
            .map(|status| detail.summary.status == status)
            .unwrap_or(true)
        {
            parties.push(detail.summary);
        }
    }
    parties.sort_by_key(|party| readiness_sort_key(party.status));

    Ok(WeddingReadinessDashboard {
        safe_count: parties
            .iter()
            .filter(|party| party.status == WeddingReadinessStatus::Safe)
            .count() as i64,
        watch_count: parties
            .iter()
            .filter(|party| party.status == WeddingReadinessStatus::Watch)
            .count() as i64,
        at_risk_count: parties
            .iter()
            .filter(|party| party.status == WeddingReadinessStatus::AtRisk)
            .count() as i64,
        critical_count: parties
            .iter()
            .filter(|party| party.status == WeddingReadinessStatus::Critical)
            .count() as i64,
        complete_count: parties
            .iter()
            .filter(|party| party.status == WeddingReadinessStatus::Complete)
            .count() as i64,
        parties,
    })
}

fn member_readiness_state(
    row: &MemberReadinessRow,
    lifecycle: &WeddingLifecycleCounts,
) -> (String, Vec<WeddingReadinessBlocker>, String) {
    let mut blockers = Vec::new();
    if row.balance_due > Decimal::ZERO && lifecycle.ready_for_pickup > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Blocking,
            label: "Pickup blocked until balance is cleared".to_string(),
            explanation: "Garments can be ready before the financial balance is complete."
                .to_string(),
            next_safe_action: "Collect the remaining balance before releasing pickup.".to_string(),
        });
        return (
            "balance_blocked".to_string(),
            blockers,
            "Clear balance before pickup release.".to_string(),
        );
    }
    if lifecycle.needs_measurements > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Blocking,
            label: "Needs measurements".to_string(),
            explanation:
                "At least one placeholder item still needs measurements before vendor ordering."
                    .to_string(),
            next_safe_action:
                "Measure the member, update the line variation, then mark it Ready to Order."
                    .to_string(),
        });
    }
    if lifecycle.ntbo > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Blocking,
            label: "Needs vendor order".to_string(),
            explanation: "At least one item is still NTBO.".to_string(),
            next_safe_action: "Create or attach the vendor purchase order.".to_string(),
        });
    }
    if lifecycle.ordered > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Warning,
            label: "Vendor item still ordered".to_string(),
            explanation: "A vendor-linked item has not been received yet.".to_string(),
            next_safe_action: "Confirm ETA or receive through PO receiving when it arrives."
                .to_string(),
        });
    }
    if lifecycle.received > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Info,
            label: "Received, not ready for pickup".to_string(),
            explanation:
                "Goods are in store but still need prep, alterations, or readiness review."
                    .to_string(),
            next_safe_action: "Review prep and mark ready for pickup only when verified."
                .to_string(),
        });
    }

    if row.pickup_status.as_deref() == Some("complete")
        || (lifecycle.open == 0 && lifecycle.picked_up > 0)
    {
        (
            "complete".to_string(),
            blockers,
            "No action needed.".to_string(),
        )
    } else if lifecycle.ready_for_pickup > 0 && lifecycle.open == lifecycle.ready_for_pickup {
        (
            "ready".to_string(),
            blockers,
            "Release through the guarded pickup workflow.".to_string(),
        )
    } else if lifecycle.ready_for_pickup > 0 {
        (
            "partial".to_string(),
            blockers,
            "Release only ready items; keep blocked items in lifecycle.".to_string(),
        )
    } else if !blockers.is_empty() {
        (
            "blocked".to_string(),
            blockers,
            "Resolve listed blockers before pickup.".to_string(),
        )
    } else {
        (
            "blocked".to_string(),
            vec![WeddingReadinessBlocker {
                severity: WeddingReadinessSeverity::Warning,
                label: "No linked fulfillment order".to_string(),
                explanation: "This member does not yet have lifecycle-tracked order lines."
                    .to_string(),
                next_safe_action:
                    "Link or create the member transaction before promising readiness.".to_string(),
            }],
            "Link order or review member setup.".to_string(),
        )
    }
}

fn party_blockers(
    lifecycle: &WeddingLifecycleCounts,
    member_counts: &WeddingMemberCounts,
    pickup: &WeddingPickupReadiness,
    vendor_risk: &WeddingVendorRisk,
    event_date: NaiveDate,
) -> Vec<WeddingReadinessBlocker> {
    let mut blockers = Vec::new();
    if lifecycle.open == 0 && lifecycle.picked_up > 0 {
        return blockers;
    }
    let days_until = (event_date - Utc::now().date_naive()).num_days();
    if lifecycle.needs_measurements > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: if days_until <= 30 {
                WeddingReadinessSeverity::Blocking
            } else {
                WeddingReadinessSeverity::Warning
            },
            label: "Needs measurements".to_string(),
            explanation: format!(
                "{} item(s) need measurements before they can move to NTBO.",
                lifecycle.needs_measurements
            ),
            next_safe_action:
                "Measure members and update exact variations before creating vendor orders."
                    .to_string(),
        });
    }
    if lifecycle.ntbo > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Blocking,
            label: "Needs vendor order".to_string(),
            explanation: format!("{} item(s) are still NTBO.", lifecycle.ntbo),
            next_safe_action: "Create or attach vendor purchase orders for NTBO items.".to_string(),
        });
    }
    if vendor_risk.delayed_vendor_count > 0 || vendor_risk.stale_ordered_count > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Blocking,
            label: "Vendor delay risk".to_string(),
            explanation: "Ordered items are stale or past vendor ETA.".to_string(),
            next_safe_action: "Call the vendor and update ETA before promising pickup.".to_string(),
        });
    }
    if vendor_risk.missing_vendor_count > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Warning,
            label: "Missing vendor / PO link".to_string(),
            explanation: "Some unreceived items do not have clear vendor ordering evidence."
                .to_string(),
            next_safe_action: "Review Orders and attach vendor/PO context.".to_string(),
        });
    }
    if member_counts.total > member_counts.measured && lifecycle.ready_for_pickup < lifecycle.open {
        blockers.push(WeddingReadinessBlocker {
            severity: if days_until <= 14 {
                WeddingReadinessSeverity::Blocking
            } else {
                WeddingReadinessSeverity::Warning
            },
            label: "Measurements incomplete".to_string(),
            explanation: format!(
                "{} of {} member(s) are measured.",
                member_counts.measured, member_counts.total
            ),
            next_safe_action: "Schedule or complete remaining measurements.".to_string(),
        });
    }
    if pickup.balance_blocked_members > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Blocking,
            label: "Pickup blocked until balance is cleared".to_string(),
            explanation: format!(
                "{} member(s) have ready garments with open balances.",
                pickup.balance_blocked_members
            ),
            next_safe_action: "Collect payment before pickup release.".to_string(),
        });
    }
    if pickup.partial_ready_members > 0 {
        blockers.push(WeddingReadinessBlocker {
            severity: WeddingReadinessSeverity::Info,
            label: "Partial party readiness".to_string(),
            explanation: "Some members can release while others remain blocked.".to_string(),
            next_safe_action: "Use partial pickup only for verified ready members.".to_string(),
        });
    }
    blockers
}

fn party_status(
    lifecycle: &WeddingLifecycleCounts,
    pickup: &WeddingPickupReadiness,
    vendor_risk: &WeddingVendorRisk,
    blockers: &[WeddingReadinessBlocker],
    days_until_event: i64,
) -> WeddingReadinessStatus {
    if lifecycle.open == 0 && lifecycle.picked_up > 0 {
        return WeddingReadinessStatus::Complete;
    }
    let has_blocking = blockers
        .iter()
        .any(|b| b.severity == WeddingReadinessSeverity::Blocking);
    let all_open_items_ready =
        lifecycle.open > 0 && lifecycle.open == lifecycle.ready_for_pickup && blockers.is_empty();
    if (days_until_event < 0 && lifecycle.open > 0)
        || (days_until_event <= 14 && has_blocking)
        || vendor_risk.delayed_vendor_count > 0
        || (days_until_event <= 30 && (lifecycle.needs_measurements > 0 || lifecycle.ntbo > 0))
    {
        WeddingReadinessStatus::Critical
    } else if has_blocking || pickup.balance_blocked_members > 0 {
        WeddingReadinessStatus::AtRisk
    } else if all_open_items_ready {
        WeddingReadinessStatus::Safe
    } else if !blockers.is_empty() || lifecycle.open > 0 {
        WeddingReadinessStatus::Watch
    } else {
        WeddingReadinessStatus::Safe
    }
}

fn readiness_score(
    lifecycle: &WeddingLifecycleCounts,
    member_counts: &WeddingMemberCounts,
    pickup: &WeddingPickupReadiness,
    vendor_risk: &WeddingVendorRisk,
) -> f64 {
    let lifecycle_total = lifecycle.needs_measurements
        + lifecycle.ntbo
        + lifecycle.ordered
        + lifecycle.received
        + lifecycle.ready_for_pickup
        + lifecycle.picked_up;
    let lifecycle_score = if lifecycle_total > 0 {
        ((lifecycle.picked_up as f64)
            + (lifecycle.ready_for_pickup as f64 * 0.85)
            + (lifecycle.received as f64 * 0.65)
            + (lifecycle.ordered as f64 * 0.35))
            / lifecycle_total as f64
    } else {
        0.0
    };
    let member_score = if member_counts.total > 0 {
        (member_counts.measured as f64 / member_counts.total as f64) * 0.35
            + (member_counts.fitting as f64 / member_counts.total as f64) * 0.25
            + (member_counts.pickup_complete as f64 / member_counts.total as f64) * 0.4
    } else {
        0.0
    };
    let risk_penalty = ((vendor_risk.delayed_vendor_count
        + vendor_risk.stale_ordered_count
        + vendor_risk.missing_vendor_count
        + lifecycle.needs_measurements
        + pickup.balance_blocked_members) as f64
        * 0.08)
        .min(0.35);
    ((lifecycle_score * 0.65) + (member_score * 0.35) - risk_penalty).clamp(0.0, 1.0)
}

fn party_next_safe_action(
    status: &WeddingReadinessStatus,
    blockers: &[WeddingReadinessBlocker],
    lifecycle: &WeddingLifecycleCounts,
    pickup: &WeddingPickupReadiness,
) -> String {
    if let Some(blocker) = blockers
        .iter()
        .find(|b| b.severity == WeddingReadinessSeverity::Blocking)
    {
        return blocker.next_safe_action.clone();
    }
    if pickup.ready_members > 0 || pickup.partial_ready_members > 0 {
        return "Use guarded pickup for ready members; do not release blocked items.".to_string();
    }
    if lifecycle.needs_measurements > 0 {
        return "Complete measurements and update exact line variations before vendor ordering."
            .to_string();
    }
    if lifecycle.received > 0 {
        return "Review received garments and mark ready only after prep is complete.".to_string();
    }
    match status {
        WeddingReadinessStatus::Complete => {
            "No action needed; party pickup is complete.".to_string()
        }
        WeddingReadinessStatus::Safe => "Continue normal monitoring.".to_string(),
        WeddingReadinessStatus::Watch => "Review warnings before promising pickup.".to_string(),
        WeddingReadinessStatus::AtRisk => {
            "Resolve readiness blockers before pickup commitment.".to_string()
        }
        WeddingReadinessStatus::Critical => {
            "Escalate today; wedding readiness is unsafe.".to_string()
        }
    }
}

fn readiness_sort_key(status: WeddingReadinessStatus) -> i32 {
    match status {
        WeddingReadinessStatus::Critical => 0,
        WeddingReadinessStatus::AtRisk => 1,
        WeddingReadinessStatus::Watch => 2,
        WeddingReadinessStatus::Safe => 3,
        WeddingReadinessStatus::Complete => 4,
    }
}
