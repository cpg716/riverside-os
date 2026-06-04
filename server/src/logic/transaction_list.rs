#![allow(clippy::items_after_test_module)]

//! Paged Transaction Record and open Order list SQL for Back Office and register-scoped reads.

use chrono::{DateTime, NaiveDate, Utc};
use meilisearch_sdk::client::Client as MeilisearchClient;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;
use crate::models::DbOrderStatus;

#[derive(Debug, Serialize, FromRow)]
pub struct FulfillmentItem {
    pub fulfillment_order_id: Uuid,
    pub display_id: String,
    pub created_at: DateTime<Utc>,
    pub status: String,
    pub customer_id: Option<Uuid>,
    pub customer_name: Option<String>,
    pub item_count: i64,
    pub fulfilled_item_count: i64,
    pub urgency: String,
    pub next_deadline: Option<DateTime<Utc>>,
    pub balance_due: Decimal,
    pub wedding_party_id: Option<Uuid>,
    pub wedding_party_name: Option<String>,
    pub counterpoint_customer_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TransactionPipelineStats {
    pub needs_action: i64,       // open/pending_measurement
    pub ready_check_needed: i64, // received items awaiting staff ready-for-pickup check
    pub ready_for_pickup: i64,   // has items marked Arrived (inventory) but not fulfilled
    pub overdue: i64,            // 30+ days old and unfulfilled
    pub wedding_orders: i64,     // active wedding-linked orders
}

#[derive(Debug, Deserialize, Serialize, FromRow)]
pub struct TransactionListRow {
    pub transaction_id: Uuid,
    pub display_id: Option<String>,
    pub order_payment_display_id: Option<String>,
    pub booked_at: DateTime<Utc>,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub customer_id: Option<Uuid>,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
    pub customer_code: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    pub wedding_party_id: Option<Uuid>,
    pub party_name: Option<String>,
    pub wedding_event_date: Option<NaiveDate>,
    pub operator_name: Option<String>,
    pub primary_salesperson_name: Option<String>,
    pub item_count: i64,
    pub order_items_summary: Option<String>,
    pub order_print_items: serde_json::Value,
    pub is_rush: bool,
    pub need_by_date: Option<NaiveDate>,
    pub has_special_order: bool,
    pub has_wedding_order: bool,
    pub has_layaway: bool,
    pub has_custom: bool,
    pub is_fulfillment_order: bool,
    pub status: DbOrderStatus,
    pub is_counterpoint_import: bool,
    pub counterpoint_doc_ref: Option<String>,
    pub counterpoint_ticket_ref: Option<String>,
    pub counterpoint_customer_code: Option<String>,
    pub total_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct TransactionListQuery {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub show_closed: bool,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub payment_filter: Option<String>,
    #[serde(default)]
    pub kind_filter: Option<String>,
    #[serde(default)]
    pub salesperson_filter: Option<String>,
    #[serde(default)]
    pub lifecycle_filter: Option<String>,
    #[serde(default)]
    pub status_scope: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TransactionListResponse {
    pub transaction_id: Uuid,
    pub display_id: String,
    pub order_payment_display_id: String,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub customer_id: Option<Uuid>,
    pub customer_name: Option<String>,
    pub customer_code: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    pub wedding_party_id: Option<Uuid>,
    pub party_name: Option<String>,
    pub wedding_event_date: Option<NaiveDate>,
    pub operator_name: Option<String>,
    pub primary_salesperson_name: Option<String>,
    pub item_count: i64,
    pub order_items_summary: Option<String>,
    pub order_print_items: serde_json::Value,
    pub is_rush: bool,
    pub need_by_date: Option<NaiveDate>,
    pub order_kind: String,
    pub has_special_order: bool,
    pub has_wedding_order: bool,
    pub has_layaway: bool,
    pub has_custom: bool,
    pub is_fulfillment_order: bool,
    pub is_counterpoint_import: bool,
    pub counterpoint_doc_ref: Option<String>,
    pub counterpoint_ticket_ref: Option<String>,
    pub counterpoint_customer_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PagedTransactionsResponse {
    pub items: Vec<TransactionListResponse>,
    pub total_count: i64,
}

fn kind_filter_having_clause(kind_filter: &str) -> Option<&'static str> {
    match kind_filter {
        "regular_order" => Some(
            " HAVING o.wedding_member_id IS NULL AND BOOL_OR(oi.fulfillment::text IN ('special_order', 'custom')) = false AND BOOL_OR(oi.fulfillment::text = 'wedding_order') = false AND BOOL_OR(oi.fulfillment::text = 'layaway') = false ",
        ),
        "special_order" => Some(
            " HAVING o.wedding_member_id IS NULL AND BOOL_OR(oi.fulfillment::text = 'special_order') = true AND BOOL_OR(oi.fulfillment::text = 'custom') = false ",
        ),
        "custom" => Some(
            " HAVING o.wedding_member_id IS NULL AND BOOL_OR(oi.fulfillment::text = 'custom') = true ",
        ),
        "wedding_order" => Some(" HAVING o.wedding_member_id IS NOT NULL "),
        "layaway" => Some(" HAVING BOOL_OR(oi.fulfillment::text = 'layaway') = true "),
        _ => None,
    }
}

fn lifecycle_filter_status(lifecycle_filter: &str) -> Option<&'static str> {
    match lifecycle_filter {
        "ntbo" => Some("ntbo"),
        "needs_measurements" => Some("needs_measurements"),
        "ordered" => Some("ordered"),
        "received" | "ready_check_needed" => Some("received"),
        "ready_for_pickup" => Some("ready_for_pickup"),
        "picked_up" => Some("picked_up"),
        _ => None,
    }
}

fn order_kind_from_flags(
    has_layaway: bool,
    wedding_member_id: Option<Uuid>,
    has_wedding_order: bool,
    has_custom: bool,
    has_special_order: bool,
) -> String {
    if has_layaway {
        "layaway".to_string()
    } else if wedding_member_id.is_some() || has_wedding_order {
        "wedding_order".to_string()
    } else if has_custom {
        "custom".to_string()
    } else if has_special_order {
        "special_order".to_string()
    } else {
        "regular_order".to_string()
    }
}

pub async fn query_paged_transactions(
    pool: &sqlx::PgPool,
    q: &TransactionListQuery,
    meilisearch: Option<&MeilisearchClient>,
) -> Result<PagedTransactionsResponse, sqlx::Error> {
    let search_trim = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let status_scope = q.status_scope.as_deref().map(str::trim);
    let kind_filter = q.kind_filter.as_deref().map(str::trim);
    let lifecycle_filter = q
        .lifecycle_filter
        .as_deref()
        .map(str::trim)
        .and_then(lifecycle_filter_status);
    let is_layaway_filter = kind_filter == Some("layaway");
    let is_order_kind_filter = matches!(
        kind_filter,
        Some("special_order" | "custom" | "wedding_order")
    );
    let default_order_scope =
        matches!(status_scope, Some("open")) || (status_scope.is_none() && !q.show_closed);
    let list_line_filter = if is_layaway_filter {
        "oi.fulfillment::text = 'layaway'"
    } else if default_order_scope || is_order_kind_filter {
        "oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order')"
    } else {
        "oi.id IS NOT NULL"
    };

    let meili_transaction_ids: Option<Vec<Uuid>> = if let Some(st) = search_trim {
        if let Some(c) = meilisearch {
            let open_only =
                matches!(status_scope, Some("open")) || (status_scope.is_none() && !q.show_closed);
            match crate::logic::meilisearch_search::order_search_ids(c, st, open_only).await {
                Ok(ids) if !ids.is_empty() => Some(ids),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Meilisearch transaction list search failed; using PostgreSQL ILIKE"
                    );
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(format!(
        r#"
        SELECT
            o.id AS transaction_id,
            COALESCE(o.display_id, o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS display_id,
            COALESCE(
                NULLIF(string_agg(DISTINCT fo.display_id, ', ' ORDER BY fo.display_id) FILTER (WHERE fo.display_id IS NOT NULL), ''),
                o.counterpoint_doc_ref,
                o.counterpoint_ticket_ref,
                o.display_id,
                o.id::text
            ) AS order_payment_display_id,
            o.booked_at,
            o.total_price,
            o.amount_paid,
            o.balance_due,
            c.id AS customer_id,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            NULLIF(TRIM(c.customer_code), '') AS customer_code,
            NULLIF(TRIM(c.phone), '') AS customer_phone,
            NULLIF(TRIM(c.email), '') AS customer_email,
            o.wedding_member_id,
            wm.wedding_party_id,
            o.status,
            COALESCE(o.is_counterpoint_import, false) AS is_counterpoint_import,
            NULLIF(TRIM(o.counterpoint_doc_ref), '') AS counterpoint_doc_ref,
            NULLIF(TRIM(o.counterpoint_ticket_ref), '') AS counterpoint_ticket_ref,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            wp.event_date AS wedding_event_date,
            op.full_name AS operator_name,
            COALESCE(BOOL_OR(oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order')), false) AS is_fulfillment_order,
            ps.full_name AS primary_salesperson_name,
            CASE
                WHEN COALESCE(o.is_counterpoint_import, false)
                THEN NULLIF(TRIM(c.customer_code), '')
                ELSE NULL
            END AS counterpoint_customer_code,
            COUNT(oi.id) FILTER (WHERE {list_line_filter})::bigint AS item_count,
            NULLIF(
                string_agg(
                    CONCAT(
                        oi.quantity,
                        'x ',
                        COALESCE(
                            NULLIF(p.name, ''),
                            NULLIF(oi.size_specs->>'counterpoint_description', ''),
                            NULLIF(oi.size_specs->>'line_description', ''),
                            NULLIF(pv.sku, ''),
                            NULLIF(oi.size_specs->>'counterpoint_sku', ''),
                            NULLIF(oi.size_specs->>'counterpoint_item_key', ''),
                            'Order item'
                        ),
                        CASE
                            WHEN COALESCE(NULLIF(pv.sku, ''), NULLIF(oi.size_specs->>'counterpoint_sku', ''), NULLIF(oi.size_specs->>'counterpoint_item_key', '')) IS NOT NULL
                            THEN CONCAT(' (', COALESCE(NULLIF(pv.sku, ''), NULLIF(oi.size_specs->>'counterpoint_sku', ''), NULLIF(oi.size_specs->>'counterpoint_item_key', '')), ')')
                            ELSE ''
                        END
                    ),
                    E'\n'
                    ORDER BY oi.id
                ) FILTER (WHERE {list_line_filter}),
                ''
            ) AS order_items_summary,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'name',
                        COALESCE(
                            NULLIF(TRIM(p.name), ''),
                            NULLIF(TRIM(oi.size_specs->>'counterpoint_description'), ''),
                            NULLIF(TRIM(oi.size_specs->>'line_description'), ''),
                            NULLIF(TRIM(oi.size_specs->>'item_description'), ''),
                            NULLIF(TRIM(pv.sku), ''),
                            NULLIF(TRIM(oi.size_specs->>'counterpoint_sku'), ''),
                            NULLIF(TRIM(oi.size_specs->>'counterpoint_item_key'), ''),
                            'Order item'
                        ),
                        'sku',
                        COALESCE(
                            NULLIF(TRIM(pv.sku), ''),
                            NULLIF(TRIM(oi.size_specs->>'counterpoint_sku'), ''),
                            NULLIF(TRIM(oi.size_specs->>'counterpoint_item_key'), '')
                        ),
                        'quantity', oi.quantity,
                        'status',
                        CASE
                            WHEN oi.order_lifecycle_status = 'needs_measurements' THEN 'Needs measurements'
                            WHEN oi.order_lifecycle_status = 'picked_up' THEN 'Picked up'
                            WHEN oi.order_lifecycle_status = 'ready_for_pickup' THEN 'Ready for pickup'
                            WHEN oi.order_lifecycle_status = 'received' THEN
                                COALESCE(
                                    (
                                        SELECT 
                                            CASE 
                                                WHEN alt.status = 'intake' THEN 'Scheduled for Alterations'
                                                WHEN alt.status IN ('in_work', 'verify_completed') THEN 'In Alterations'
                                                ELSE 'Received'
                                            END
                                        FROM alteration_orders alt
                                        WHERE alt.source_transaction_line_id = oi.id
                                        ORDER BY alt.created_at DESC
                                        LIMIT 1
                                    ),
                                    'Received'
                                )
                            WHEN oi.order_lifecycle_status = 'ordered' THEN 'Ordered'
                            ELSE 'NTBO'
                        END
                    )
                    ORDER BY oi.id
                ) FILTER (WHERE {list_line_filter}),
                '[]'::jsonb
            ) AS order_print_items,
            (COALESCE(o.is_rush, false) OR COALESCE(BOOL_OR(oi.is_rush) FILTER (WHERE {list_line_filter}), false)) AS is_rush,
            COALESCE(MIN(oi.need_by_date) FILTER (WHERE {list_line_filter}), o.need_by_date) AS need_by_date,
            COALESCE(BOOL_OR(oi.fulfillment::text = 'special_order'), false) AS has_special_order,
            COALESCE(BOOL_OR(oi.fulfillment::text = 'wedding_order'), false) AS has_wedding_order,
            COALESCE(BOOL_OR(oi.fulfillment::text = 'layaway'), false) AS has_layaway,
            COALESCE(BOOL_OR(oi.fulfillment::text = 'custom'), false) AS has_custom,
            COUNT(*) OVER()::bigint AS total_count
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN staff op ON op.id = o.operator_id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN product_variants pv ON pv.id = oi.variant_id
        LEFT JOIN fulfillment_orders fo ON fo.id = oi.fulfillment_order_id
        WHERE 1=1
        "#
    ));

    if let Some(cid) = q.customer_id {
        qb.push(" AND c.id = ");
        qb.push_bind(cid);
    } else if meili_transaction_ids.is_none()
        && q.register_session_id.is_none()
        && q.search.as_ref().is_none_or(|s| s.trim().is_empty())
        && q.date_from.is_none()
        && q.date_to.is_none()
        && q.payment_filter.is_none()
        && q.salesperson_filter.is_none()
        && q.lifecycle_filter.is_none()
    {
        qb.push(" AND c.id IS NOT NULL "); // Only show orders with customers (not walk-ins)
    }

    let open_orders_predicate =
        "((COALESCE(o.is_counterpoint_import, false) AND o.counterpoint_doc_ref IS NOT NULL) OR EXISTS (SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = o.id AND tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order') AND tl.is_fulfilled = false))";
    let open_work_predicate = if is_layaway_filter {
        "EXISTS (SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = o.id AND tl.fulfillment::text = 'layaway' AND tl.is_fulfilled = false)"
    } else {
        open_orders_predicate
    };
    match status_scope {
        Some("open") => {
            qb.push(" AND o.status <> 'cancelled' AND ");
            qb.push(open_work_predicate);
            qb.push(" ");
        }
        Some("closed") => {
            qb.push(" AND o.status <> 'cancelled' AND NOT ");
            qb.push(open_work_predicate);
            qb.push(" ");
        }
        Some("cancelled") => {
            qb.push(" AND o.status = 'cancelled' ");
        }
        Some("all") => {}
        _ if !q.show_closed => {
            qb.push(" AND o.status <> 'cancelled' AND ");
            qb.push(open_work_predicate);
            qb.push(" ");
        }
        _ => {}
    }

    if let Some(sid) = q.register_session_id.filter(|_| q.customer_id.is_none()) {
        qb.push(
            " AND EXISTS (SELECT 1 FROM payment_allocations pa \
             INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id \
             WHERE pa.target_transaction_id = o.id AND pt.session_id = ",
        );
        qb.push_bind(sid);
        qb.push(" AND pa.amount_allocated > 0) ");
    }

    if let Some(ref ids) = meili_transaction_ids {
        if ids.is_empty() {
            qb.push(" AND FALSE ");
        } else {
            qb.push(" AND o.id = ANY(");
            qb.push_bind(ids.clone());
            qb.push(") ");
        }
    } else if let Some(search) = &q.search {
        if !search.trim().is_empty() {
            let s = format!("%{}%", search.trim());
            qb.push(" AND (o.id::text ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR o.display_id ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR o.counterpoint_doc_ref ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR o.counterpoint_ticket_ref ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR fo.display_id ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR c.first_name ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR c.last_name ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR wp.party_name ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR wp.groom_name ILIKE ");
            qb.push_bind(s.clone());
            qb.push(" OR ps.full_name ILIKE ");
            qb.push_bind(s.clone());
            qb.push(") ");
        }
    }

    if let Some(df) = &q.date_from {
        if let Ok(d) = DateTime::parse_from_rfc3339(df) {
            qb.push(" AND o.booked_at >= ");
            qb.push_bind(d.with_timezone(&Utc));
        }
    }
    if let Some(dt) = &q.date_to {
        if let Ok(d) = DateTime::parse_from_rfc3339(dt) {
            qb.push(" AND o.booked_at <= ");
            qb.push_bind(d.with_timezone(&Utc));
        }
    }

    if let Some(pf) = &q.payment_filter {
        if pf == "paid" {
            qb.push(" AND o.balance_due <= 0 ");
        } else if pf == "unpaid" {
            qb.push(" AND o.amount_paid <= 0 ");
        } else if pf == "partial" {
            qb.push(" AND o.amount_paid > 0 AND o.balance_due > 0 ");
        }
    }

    if let Some(sf) = q
        .salesperson_filter
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        qb.push(" AND ps.full_name = ");
        qb.push_bind(sf);
        qb.push(" ");
    }

    if let Some(lf) = lifecycle_filter {
        qb.push(
            " AND EXISTS (
                SELECT 1
                FROM transaction_lines tl_lifecycle
                WHERE tl_lifecycle.transaction_id = o.id
                  AND tl_lifecycle.fulfillment::text IN ('special_order', 'custom', 'wedding_order')
                  AND tl_lifecycle.order_lifecycle_status = ",
        );
        qb.push_bind(lf);
        qb.push("::order_item_lifecycle_status) ");
    }

    qb.push(" GROUP BY o.id, c.id, c.customer_code, c.phone, c.email, wm.wedding_party_id, wp.party_name, wp.groom_name, wp.event_date, op.full_name, ps.full_name, o.status ");

    if let Some(kf) = kind_filter {
        if let Some(clause) = kind_filter_having_clause(kf) {
            qb.push(clause);
        }
    } else if default_order_scope {
        qb.push(" HAVING (o.wedding_member_id IS NOT NULL OR BOOL_OR(oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order')) = true) ");
    }

    qb.push(" ORDER BY o.booked_at DESC ");

    qb.push(" LIMIT ");
    qb.push_bind(q.limit.unwrap_or(50));
    qb.push(" OFFSET ");
    qb.push_bind(q.offset.unwrap_or(0));

    let rows: Vec<TransactionListRow> = qb.build_query_as().fetch_all(pool).await?;

    let total_count = rows.first().map(|r| r.total_count).unwrap_or(0);

    let items = rows
        .into_iter()
        .map(|r| {
            let customer_name = match (
                r.customer_first_name.as_deref(),
                r.customer_last_name.as_deref(),
            ) {
                (Some(f), Some(l)) => Some(format!("{f} {l}")),
                (Some(f), None) => Some(f.to_string()),
                (None, Some(l)) => Some(l.to_string()),
                _ => r
                    .counterpoint_customer_code
                    .as_ref()
                    .map(|cc| format!("CP: {cc}")),
            };
            let order_kind = order_kind_from_flags(
                r.has_layaway,
                r.wedding_member_id,
                r.has_wedding_order,
                r.has_custom,
                r.has_special_order,
            );
            let fallback_display_id = r.display_id.unwrap_or_else(|| r.transaction_id.to_string());
            let order_payment_display_id = r
                .order_payment_display_id
                .unwrap_or_else(|| fallback_display_id.clone());
            TransactionListResponse {
                transaction_id: r.transaction_id,
                display_id: fallback_display_id,
                order_payment_display_id,
                booked_at: r.booked_at,
                total_price: r.total_price,
                amount_paid: r.amount_paid,
                balance_due: r.balance_due,
                customer_id: r.customer_id,
                customer_name,
                customer_code: r.customer_code,
                customer_phone: r.customer_phone,
                customer_email: r.customer_email,
                wedding_member_id: r.wedding_member_id,
                wedding_party_id: r.wedding_party_id,
                party_name: r.party_name,
                wedding_event_date: r.wedding_event_date,
                operator_name: r.operator_name,
                primary_salesperson_name: r.primary_salesperson_name,
                item_count: r.item_count,
                order_items_summary: r.order_items_summary,
                order_print_items: r.order_print_items,
                is_rush: r.is_rush,
                need_by_date: r.need_by_date,
                status: r.status,
                order_kind,
                has_special_order: r.has_special_order,
                has_wedding_order: r.has_wedding_order,
                has_layaway: r.has_layaway,
                has_custom: r.has_custom,
                is_fulfillment_order: r.is_fulfillment_order,
                is_counterpoint_import: r.is_counterpoint_import,
                counterpoint_doc_ref: r.counterpoint_doc_ref,
                counterpoint_ticket_ref: r.counterpoint_ticket_ref,
                counterpoint_customer_code: r.counterpoint_customer_code,
            }
        })
        .collect();

    Ok(PagedTransactionsResponse { items, total_count })
}

#[cfg(test)]
mod tests {
    use super::{kind_filter_having_clause, lifecycle_filter_status, order_kind_from_flags};
    use uuid::Uuid;

    #[test]
    fn custom_kind_wins_when_custom_lines_exist() {
        assert_eq!(
            order_kind_from_flags(false, None, false, true, false),
            "custom"
        );
    }

    #[test]
    fn wedding_kind_wins_when_wedding_member_is_present() {
        assert_eq!(
            order_kind_from_flags(false, Some(Uuid::new_v4()), false, true, true),
            "wedding_order"
        );
    }

    #[test]
    fn custom_filter_clause_is_distinct_from_special_orders() {
        let clause = kind_filter_having_clause("custom").expect("custom clause should exist");
        assert!(clause.contains("fulfillment::text = 'custom'"));
        assert!(!clause.contains("special_order') = true"));
    }

    #[test]
    fn special_filter_clause_excludes_custom_orders() {
        let clause =
            kind_filter_having_clause("special_order").expect("special order clause should exist");
        assert!(clause.contains("fulfillment::text = 'special_order'"));
        assert!(clause.contains("fulfillment::text = 'custom') = false"));
    }

    #[test]
    fn wedding_filter_clause_requires_linked_member_context() {
        let clause =
            kind_filter_having_clause("wedding_order").expect("wedding clause should exist");
        assert!(clause.contains("o.wedding_member_id IS NOT NULL"));
    }

    #[test]
    fn lifecycle_ready_check_filter_maps_to_received_status() {
        assert_eq!(
            lifecycle_filter_status("ready_check_needed"),
            Some("received")
        );
        assert_eq!(
            lifecycle_filter_status("ready_for_pickup"),
            Some("ready_for_pickup")
        );
        assert_eq!(lifecycle_filter_status("not_real"), None);
    }
}

pub async fn query_pipeline_stats(
    pool: &sqlx::PgPool,
) -> Result<TransactionPipelineStats, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT
            (
                SELECT COUNT(DISTINCT o.id)::bigint
                FROM transactions o
                LEFT JOIN customers c ON c.id = o.customer_id
                WHERE c.id IS NOT NULL
                  AND o.status <> 'cancelled'
                  AND (
                    (COALESCE(o.is_counterpoint_import, false) AND o.counterpoint_doc_ref IS NOT NULL)
                    OR EXISTS (
                        SELECT 1
                        FROM transaction_lines tl
                        WHERE tl.transaction_id = o.id
                          AND tl.is_fulfilled = false
                    )
                  )
                  AND (
                    o.wedding_member_id IS NOT NULL
                    OR EXISTS (
                        SELECT 1
                        FROM transaction_lines oi
                        WHERE oi.transaction_id = o.id
                          AND oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order')
                    )
                  )
            ) AS needs_action,
            (
                SELECT COUNT(DISTINCT tl.transaction_id)::bigint
                FROM transaction_lines tl
                INNER JOIN transactions t ON t.id = tl.transaction_id
                WHERE t.status <> 'cancelled'
                  AND tl.is_fulfilled = false
                  AND tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order')
                  AND tl.order_lifecycle_status = 'received'
            ) AS ready_check_needed,
            (
                SELECT COUNT(DISTINCT tl.transaction_id)::bigint
                FROM transaction_lines tl
                INNER JOIN transactions t ON t.id = tl.transaction_id
                WHERE t.status <> 'cancelled'
                  AND tl.is_fulfilled = false
                  AND tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order')
                  AND tl.order_lifecycle_status = 'ready_for_pickup'
            ) AS ready_for_pickup,
            COUNT(*) FILTER (
                WHERE status = 'open'
                  AND created_at < NOW() - INTERVAL '30 days'
                  AND EXISTS (
                      SELECT 1
                      FROM transaction_lines tl
                      WHERE tl.fulfillment_order_id = fulfillment_orders.id
                        AND tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order')
                  )
            )::bigint AS overdue,
            COUNT(*) FILTER (WHERE wedding_id IS NOT NULL AND status IN ('open', 'ready'))::bigint AS wedding_orders
        FROM fulfillment_orders
        "#
    )
    .fetch_one(pool)
    .await?;

    use sqlx::Row;

    Ok(TransactionPipelineStats {
        needs_action: row.get::<Option<i64>, _>("needs_action").unwrap_or(0),
        ready_check_needed: row.get::<Option<i64>, _>("ready_check_needed").unwrap_or(0),
        ready_for_pickup: row.get::<Option<i64>, _>("ready_for_pickup").unwrap_or(0),
        overdue: row.get::<Option<i64>, _>("overdue").unwrap_or(0),
        wedding_orders: row.get::<Option<i64>, _>("wedding_orders").unwrap_or(0),
    })
}

pub async fn query_fulfillment_queue(
    pool: &sqlx::PgPool,
) -> Result<Vec<FulfillmentItem>, sqlx::Error> {
    let rows = sqlx::query_as::<_, FulfillmentItem>(
        format!(
            r#"
        SELECT
            o.id AS fulfillment_order_id,
            o.display_id,
            o.created_at,
            o.status,
            c.id AS customer_id,
            COALESCE(NULLIF(TRIM(CONCAT(MIN(c.first_name), ' ', MIN(c.last_name))), ''), 'CP: ' || NULLIF(TRIM(c.customer_code), ''), 'Walk-in') AS customer_name,
            COUNT(tl.id)::bigint AS item_count,
            COUNT(tl.id) FILTER (WHERE tl.is_fulfilled = true)::bigint AS fulfilled_item_count,
            CASE
                WHEN EXISTS (SELECT 1 FROM transaction_lines tl2 WHERE tl2.fulfillment_order_id = o.id AND tl2.is_rush = true) THEN 'rush'
                WHEN o.status = 'open' AND EXISTS (SELECT 1 FROM transaction_lines tl3 WHERE tl3.fulfillment_order_id = o.id AND tl3.is_fulfilled = false) THEN 'standard'
                WHEN o.status = 'ready' THEN 'ready'
                ELSE 'standard'
            END AS urgency,
            NULL::timestamptz AS next_deadline, -- Logic for deadline moves to fulfillment_orders soon
            COALESCE(t.balance_due, 0) AS balance_due,
            wp.id AS wedding_party_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS wedding_party_name,
            NULLIF(TRIM(c.customer_code), '') AS counterpoint_customer_code
        FROM fulfillment_orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN transaction_lines tl ON tl.fulfillment_order_id = o.id
        LEFT JOIN transactions t ON t.id = tl.transaction_id
        LEFT JOIN wedding_members wm ON wm.id = t.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        WHERE o.status IN ('open', 'ready')
          AND EXISTS (
              SELECT 1
              FROM transaction_lines tl_order
              WHERE tl_order.fulfillment_order_id = o.id
                AND tl_order.fulfillment::text IN ('special_order', 'custom', 'wedding_order')
          )
        GROUP BY o.id, c.id, c.customer_code, wp.id, wm.id, t.balance_due
        ORDER BY
            CASE
                WHEN o.status = 'ready' THEN 1
                ELSE 5
            END ASC,
            o.created_at ASC
        LIMIT 100
        "#
        )
        .as_str(),
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}
