//! Aggregates for Customer Relationship Hub (stats, timeline sources, measurements).

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct HubStats {
    pub lifetime_spend_usd: Decimal,
    pub balance_due_usd: Decimal,
    pub wedding_party_count: i64,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub loyalty_points: i32,
}

#[derive(Debug, Clone)]
pub struct CustomerSnapshotContext {
    pub balance_due_usd: Decimal,
    pub marketing_email_opt_in: bool,
    pub marketing_sms_opt_in: bool,
    pub transactional_sms_opt_in: bool,
    pub transactional_email_opt_in: bool,
    pub next_wedding_party_name: Option<String>,
    pub next_wedding_event_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomerSnapshotSeverity {
    Info,
    Warning,
    Success,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomerSnapshotItem {
    pub label: String,
    pub severity: CustomerSnapshotSeverity,
}

#[derive(Debug, sqlx::FromRow)]
struct CustomerSnapshotFacts {
    open_orders_count: i64,
    store_credit_balance: Decimal,
    open_deposit_balance: Decimal,
    open_alterations_count: i64,
    overdue_alterations_count: i64,
    due_soon_alterations_count: i64,
    recent_salesperson_name: Option<String>,
}

fn plural(count: i64, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {many}")
    }
}

fn money_label(value: Decimal) -> String {
    format!("${value:.2}")
}

fn contact_preference_label(ctx: &CustomerSnapshotContext) -> CustomerSnapshotItem {
    let transactional = match (ctx.transactional_sms_opt_in, ctx.transactional_email_opt_in) {
        (true, true) => "Operational contact: text and email",
        (true, false) => "Operational contact: text only",
        (false, true) => "Operational contact: email only",
        (false, false) => "No operational contact channel enabled",
    };

    if ctx.marketing_sms_opt_in || ctx.marketing_email_opt_in {
        CustomerSnapshotItem {
            label: format!("{transactional}; marketing opt-in on file"),
            severity: CustomerSnapshotSeverity::Info,
        }
    } else if ctx.transactional_sms_opt_in || ctx.transactional_email_opt_in {
        CustomerSnapshotItem {
            label: transactional.to_string(),
            severity: CustomerSnapshotSeverity::Info,
        }
    } else {
        CustomerSnapshotItem {
            label: transactional.to_string(),
            severity: CustomerSnapshotSeverity::Warning,
        }
    }
}

fn wedding_snapshot_item(ctx: &CustomerSnapshotContext) -> Option<CustomerSnapshotItem> {
    let event_date = ctx.next_wedding_event_date?;
    let party_name = ctx
        .next_wedding_party_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("current party");
    let days = event_date
        .signed_duration_since(Utc::now().date_naive())
        .num_days();
    if days < 0 {
        return None;
    }

    let label = match days {
        0 => format!("Wedding today: {party_name}"),
        1 => format!("Wedding tomorrow: {party_name}"),
        _ => format!("Wedding in {days} days: {party_name}"),
    };

    Some(CustomerSnapshotItem {
        label,
        severity: if days <= 7 {
            CustomerSnapshotSeverity::Warning
        } else {
            CustomerSnapshotSeverity::Info
        },
    })
}

pub async fn fetch_customer_snapshot_items(
    pool: &PgPool,
    customer_id: Uuid,
    ctx: CustomerSnapshotContext,
) -> Result<Vec<CustomerSnapshotItem>, sqlx::Error> {
    let facts = sqlx::query_as::<_, CustomerSnapshotFacts>(
        r#"
        SELECT
            (
                SELECT COUNT(*)::bigint
                FROM transactions t
                WHERE t.customer_id = $1
                  AND t.status IN ('open'::order_status, 'pending_measurement'::order_status)
                  AND t.counterpoint_ticket_ref IS NULL
            ) AS open_orders_count,
            COALESCE((
                SELECT sca.balance
                FROM store_credit_accounts sca
                WHERE sca.customer_id = $1
                LIMIT 1
            ), 0)::numeric(14, 2) AS store_credit_balance,
            COALESCE((
                SELECT coda.balance
                FROM customer_open_deposit_accounts coda
                WHERE coda.customer_id = $1
                LIMIT 1
            ), 0)::numeric(14, 2) AS open_deposit_balance,
            (
                SELECT COUNT(*)::bigint
                FROM alteration_orders ao
                WHERE ao.customer_id = $1
                  AND ao.status::text NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'picked_up')
            ) AS open_alterations_count,
            (
                SELECT COUNT(*)::bigint
                FROM alteration_orders ao
                WHERE ao.customer_id = $1
                  AND ao.due_at IS NOT NULL
                  AND ao.due_at < now()
                  AND ao.status::text NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'picked_up', 'ready')
            ) AS overdue_alterations_count,
            (
                SELECT COUNT(*)::bigint
                FROM alteration_orders ao
                WHERE ao.customer_id = $1
                  AND ao.due_at IS NOT NULL
                  AND ao.due_at >= now()
                  AND ao.due_at <= now() + interval '7 days'
                  AND ao.status::text NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'picked_up', 'ready')
            ) AS due_soon_alterations_count,
            (
                SELECT NULLIF(TRIM(st.full_name), '')
                FROM transactions t
                JOIN staff st ON st.id = t.primary_salesperson_id
                WHERE t.customer_id = $1
                  AND t.status != 'cancelled'::order_status
                ORDER BY t.booked_at DESC
                LIMIT 1
            ) AS recent_salesperson_name
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    let mut items = Vec::new();

    if facts.open_orders_count > 0 {
        items.push(CustomerSnapshotItem {
            label: plural(facts.open_orders_count, "open order", "open orders"),
            severity: CustomerSnapshotSeverity::Info,
        });
    }

    if ctx.balance_due_usd > Decimal::ZERO {
        items.push(CustomerSnapshotItem {
            label: format!("Balance due {}", money_label(ctx.balance_due_usd)),
            severity: CustomerSnapshotSeverity::Warning,
        });
    }

    if facts.store_credit_balance > Decimal::ZERO {
        items.push(CustomerSnapshotItem {
            label: format!(
                "Store credit available {}",
                money_label(facts.store_credit_balance)
            ),
            severity: CustomerSnapshotSeverity::Success,
        });
    }

    if facts.open_deposit_balance > Decimal::ZERO {
        items.push(CustomerSnapshotItem {
            label: format!(
                "Deposit waiting {}",
                money_label(facts.open_deposit_balance)
            ),
            severity: CustomerSnapshotSeverity::Success,
        });
    }

    if let Some(item) = wedding_snapshot_item(&ctx) {
        items.push(item);
    }

    if facts.overdue_alterations_count > 0 {
        items.push(CustomerSnapshotItem {
            label: plural(
                facts.overdue_alterations_count,
                "overdue alteration",
                "overdue alterations",
            ),
            severity: CustomerSnapshotSeverity::Warning,
        });
    } else if facts.due_soon_alterations_count > 0 {
        items.push(CustomerSnapshotItem {
            label: plural(
                facts.due_soon_alterations_count,
                "alteration due within 7 days",
                "alterations due within 7 days",
            ),
            severity: CustomerSnapshotSeverity::Warning,
        });
    } else if facts.open_alterations_count > 0 {
        items.push(CustomerSnapshotItem {
            label: plural(
                facts.open_alterations_count,
                "open alteration",
                "open alterations",
            ),
            severity: CustomerSnapshotSeverity::Info,
        });
    }

    items.push(contact_preference_label(&ctx));

    if let Some(name) = facts
        .recent_salesperson_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        items.push(CustomerSnapshotItem {
            label: format!("Recent sale with {name}"),
            severity: CustomerSnapshotSeverity::Info,
        });
    }

    items.truncate(7);
    Ok(items)
}

pub async fn fetch_hub_stats(pool: &PgPool, customer_id: Uuid) -> Result<HubStats, sqlx::Error> {
    // If the customer is in a couple, we sum the history for BOTH.
    // However, if the user requested "Only 1 account keeps history as counted",
    // it usually means we report from the primary's perspective.
    // If we're loading the secondary's profile, we still show the combined data.

    let couple_id: Option<Uuid> =
        sqlx::query_scalar("SELECT couple_id FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(pool)
            .await?;

    let lifetime_spend_usd: Decimal = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(line_sales.sales_subtotal), 0)::DECIMAL(14, 2)
            FROM transactions t
            LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(((tl.unit_price - COALESCE(tl.discount_amount, 0)) * tl.quantity)::numeric(14,2)), 0)::numeric(14,2) AS sales_subtotal
                FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
            ) line_sales ON TRUE
            WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND status != 'cancelled'::order_status
              AND booked_at >= '2018-01-01'
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(line_sales.sales_subtotal), 0)::DECIMAL(14, 2)
            FROM transactions t
            LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(((tl.unit_price - COALESCE(tl.discount_amount, 0)) * tl.quantity)::numeric(14,2)), 0)::numeric(14,2) AS sales_subtotal
                FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
            ) line_sales ON TRUE
            WHERE (
                t.customer_id = $1
                OR EXISTS (
                    SELECT 1
                    FROM customer_relationship_periods crp
                    WHERE (
                        (crp.parent_customer_id = $1 AND crp.child_customer_id = t.customer_id)
                        OR
                        (crp.child_customer_id = $1 AND crp.parent_customer_id = t.customer_id)
                    )
                      AND t.booked_at >= crp.linked_at
                      AND (crp.unlinked_at IS NULL OR t.booked_at <= crp.unlinked_at)
                      AND (crp.unlinked_at IS NULL OR crp.parent_customer_id = $1)
                )
            )
              AND t.status != 'cancelled'::order_status
              AND t.booked_at >= '2018-01-01'
            "#,
        )
        .bind(customer_id)
        .fetch_one(pool)
        .await?
    };

    let balance_due_usd: Decimal = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(balance_due), 0)::DECIMAL(14, 2)
            FROM transactions
            WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND status = 'open'::order_status
              AND counterpoint_ticket_ref IS NULL
              AND balance_due > 0
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(balance_due), 0)::DECIMAL(14, 2)
            FROM transactions t
            WHERE (
                t.customer_id = $1
                OR EXISTS (
                    SELECT 1
                    FROM customer_relationship_periods crp
                    WHERE (
                        (crp.parent_customer_id = $1 AND crp.child_customer_id = t.customer_id)
                        OR
                        (crp.child_customer_id = $1 AND crp.parent_customer_id = t.customer_id)
                    )
                      AND t.booked_at >= crp.linked_at
                      AND (crp.unlinked_at IS NULL OR t.booked_at <= crp.unlinked_at)
                      AND (crp.unlinked_at IS NULL OR crp.parent_customer_id = $1)
                )
            )
              AND t.status = 'open'::order_status
              AND t.counterpoint_ticket_ref IS NULL
              AND t.balance_due > 0
            "#,
        )
        .bind(customer_id)
        .fetch_one(pool)
        .await?
    };

    let wedding_party_count: i64 = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(DISTINCT wm.wedding_party_id)::BIGINT
            FROM wedding_members wm
            JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
            WHERE wm.customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(DISTINCT wm.wedding_party_id)::BIGINT
            FROM wedding_members wm
            JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
            WHERE wm.customer_id = $1
              AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
            "#,
        )
        .bind(customer_id)
        .fetch_one(pool)
        .await?
    };

    let last_activity_at: Option<DateTime<Utc>> = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT MAX(ts) FROM (
                SELECT MAX(booked_at) AS ts FROM transactions WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(created_at) FROM payment_transactions WHERE payer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(created_at) FROM measurements WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(measured_at) FROM customer_measurements WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(created_at) FROM customer_timeline_notes WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(l.created_at)
                FROM customer_open_deposit_ledger l
                INNER JOIN customer_open_deposit_accounts a ON a.id = l.account_id
                WHERE a.customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(l.created_at)
                FROM wedding_activity_log l
                WHERE EXISTS (
                    SELECT 1 FROM wedding_members wm
                    WHERE wm.wedding_party_id = l.wedding_party_id
                      AND wm.customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                      AND (
                        l.wedding_member_id IS NULL
                        OR l.wedding_member_id = wm.id
                      )
                )
            ) x
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT MAX(ts) FROM (
                SELECT MAX(booked_at) AS ts
                FROM transactions t
                WHERE (
                    t.customer_id = $1
                    OR EXISTS (
                        SELECT 1
                        FROM customer_relationship_periods crp
                        WHERE (
                            (crp.parent_customer_id = $1 AND crp.child_customer_id = t.customer_id)
                            OR
                            (crp.child_customer_id = $1 AND crp.parent_customer_id = t.customer_id)
                        )
                          AND t.booked_at >= crp.linked_at
                          AND (crp.unlinked_at IS NULL OR t.booked_at <= crp.unlinked_at)
                          AND (crp.unlinked_at IS NULL OR crp.parent_customer_id = $1)
                    )
                )
                UNION ALL
                SELECT MAX(created_at)
                FROM payment_transactions p
                WHERE (
                    p.payer_id = $1
                    OR EXISTS (
                        SELECT 1
                        FROM customer_relationship_periods crp
                        WHERE (
                            (crp.parent_customer_id = $1 AND crp.child_customer_id = p.payer_id)
                            OR
                            (crp.child_customer_id = $1 AND crp.parent_customer_id = p.payer_id)
                        )
                          AND p.created_at >= crp.linked_at
                          AND (crp.unlinked_at IS NULL OR p.created_at <= crp.unlinked_at)
                          AND (crp.unlinked_at IS NULL OR crp.parent_customer_id = $1)
                    )
                )
                UNION ALL
                SELECT MAX(created_at) FROM measurements WHERE customer_id = $1
                UNION ALL
                SELECT MAX(measured_at) FROM customer_measurements WHERE customer_id = $1
                UNION ALL
                SELECT MAX(created_at) FROM customer_timeline_notes WHERE customer_id = $1
                UNION ALL
                SELECT MAX(l.created_at)
                FROM customer_open_deposit_ledger l
                INNER JOIN customer_open_deposit_accounts a ON a.id = l.account_id
                WHERE a.customer_id = $1
                UNION ALL
                SELECT MAX(l.created_at)
                FROM wedding_activity_log l
                WHERE EXISTS (
                    SELECT 1 FROM wedding_members wm
                    WHERE wm.wedding_party_id = l.wedding_party_id
                      AND wm.customer_id = $1
                      AND (
                        l.wedding_member_id IS NULL
                        OR l.wedding_member_id = wm.id
                      )
                )
            ) x
            "#,
        )
        .bind(customer_id)
        .fetch_one(pool)
        .await?
    };

    let loyalty_points: i32 = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            "SELECT COALESCE(SUM(loyalty_points), 0)::INT FROM customers WHERE couple_id = $1",
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar("SELECT loyalty_points FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(pool)
            .await?
    };

    Ok(HubStats {
        lifetime_spend_usd,
        balance_due_usd,
        wedding_party_count,
        last_activity_at,
        loyalty_points,
    })
}

pub fn days_since_last_visit(last: Option<DateTime<Utc>>) -> Option<i64> {
    last.map(|t| (Utc::now() - t).num_days())
}
