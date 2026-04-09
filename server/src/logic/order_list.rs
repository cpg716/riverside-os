//! Paged order list SQL for Back Office and register-scoped reads.

use chrono::{DateTime, Utc};
use meilisearch_sdk::client::Client as MeilisearchClient;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;
use crate::models::DbOrderStatus;

#[derive(Debug, Deserialize)]
pub struct OrdersListQuery {
    #[serde(default)]
    pub show_closed: bool,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub search: Option<String>,
    pub kind_filter: Option<String>,
    pub payment_filter: Option<String>,
    pub salesperson_filter: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct OrderListRow {
    pub order_id: Uuid,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub customer_id: Option<Uuid>,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    pub wedding_party_id: Option<Uuid>,
    pub party_name: Option<String>,
    pub primary_salesperson_name: Option<String>,
    pub item_count: i64,
    pub has_special_order: bool,
    pub has_wedding_order: bool,
    pub has_layaway: bool,
    pub total_count: i64,
}

#[derive(Debug, Serialize)]
pub struct OrderListResponse {
    pub order_id: Uuid,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub customer_id: Option<Uuid>,
    pub customer_name: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    pub wedding_party_id: Option<Uuid>,
    pub party_name: Option<String>,
    pub primary_salesperson_name: Option<String>,
    pub item_count: i64,
    pub order_kind: String,
}

#[derive(Debug, Serialize)]
pub struct PagedOrdersResponse {
    pub items: Vec<OrderListResponse>,
    pub total_count: i64,
}

pub async fn query_paged_orders(
    pool: &sqlx::PgPool,
    q: &OrdersListQuery,
    meilisearch: Option<&MeilisearchClient>,
) -> Result<PagedOrdersResponse, sqlx::Error> {
    let search_trim = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let meili_order_ids: Option<Vec<Uuid>> = if let Some(st) = search_trim {
        if let Some(c) = meilisearch {
            let open_only = !q.show_closed;
            match crate::logic::meilisearch_search::order_search_ids(c, st, open_only).await {
                Ok(ids) if !ids.is_empty() => Some(ids),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Meilisearch order list search failed; using PostgreSQL ILIKE"
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
            o.id AS order_id,
            o.booked_at,
            o.status,
            o.total_price,
            o.amount_paid,
            o.balance_due,
            c.id AS customer_id,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            o.wedding_member_id,
            wm.wedding_party_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            ps.full_name AS primary_salesperson_name,
            COUNT(oi.id)::bigint AS item_count,
            BOOL_OR(oi.fulfillment::text IN ('special_order', 'custom')) AS has_special_order,
            BOOL_OR(oi.fulfillment::text = 'wedding_order') AS has_wedding_order,
            BOOL_OR(oi.fulfillment::text = 'layaway') AS has_layaway,
            COUNT(*) OVER()::bigint AS total_count
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE 1=1 
        "#
    ));

    if !q.show_closed {
        qb.push(" AND o.status IN ('open', 'pending_measurement') ");
    }

    if let Some(sid) = q.register_session_id {
        qb.push(
            " AND EXISTS (SELECT 1 FROM payment_allocations pa \
             INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id \
             WHERE pa.target_order_id = o.id AND pt.session_id = ",
        );
        qb.push_bind(sid);
        qb.push(" AND pa.amount_allocated > 0) ");
    }

    if let Some(ref ids) = meili_order_ids {
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

    if let Some(pf) = &q.payment_filter {
        if pf == "paid" {
            qb.push(" AND o.balance_due <= 0 ");
        } else if pf == "unpaid" {
            qb.push(" AND o.amount_paid <= 0 ");
        } else if pf == "partial" {
            qb.push(" AND o.amount_paid > 0 AND o.balance_due > 0 ");
        }
    }

    if let Some(sf) = &q.salesperson_filter {
        if sf != "all" && !sf.trim().is_empty() {
            qb.push(" AND ps.full_name = ");
            qb.push_bind(sf);
            qb.push(" ");
        }
    }

    if let Some(df) = &q.date_from {
        if !df.trim().is_empty() {
            qb.push(" AND o.booked_at >= ");
            let dt = format!("{}T00:00:00Z", df.trim());
            qb.push_bind(dt);
            qb.push("::timestamptz ");
        }
    }

    if let Some(dt) = &q.date_to {
        if !dt.trim().is_empty() {
            qb.push(" AND o.booked_at <= ");
            let dtt = format!("{}T23:59:59Z", dt.trim());
            qb.push_bind(dtt);
            qb.push("::timestamptz ");
        }
    }

    qb.push(" GROUP BY o.id, c.id, wm.wedding_party_id, wp.party_name, wp.groom_name, wp.event_date, ps.full_name ");

    if let Some(kf) = &q.kind_filter {
        if kf == "regular_order" {
            qb.push(" HAVING o.wedding_member_id IS NULL AND BOOL_OR(oi.fulfillment::text IN ('special_order', 'custom')) = false AND BOOL_OR(oi.fulfillment::text = 'wedding_order') = false ");
        } else if kf == "special_order" {
            qb.push(" HAVING o.wedding_member_id IS NULL AND BOOL_OR(oi.fulfillment::text IN ('special_order', 'custom')) = true ");
        } else if kf == "wedding_order" {
            qb.push(" HAVING o.wedding_member_id IS NOT NULL ");
        } else if kf == "layaway" {
            qb.push(" HAVING BOOL_OR(oi.fulfillment::text = 'layaway') = true ");
        }
    }

    qb.push(" ORDER BY o.booked_at DESC ");

    qb.push(" LIMIT ");
    qb.push_bind(q.limit.unwrap_or(50));
    qb.push(" OFFSET ");
    qb.push_bind(q.offset.unwrap_or(0));

    let rows: Vec<OrderListRow> = qb.build_query_as().fetch_all(pool).await?;

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
                _ => None,
            };
            let order_kind = if r.has_layaway {
                "layaway".to_string()
            } else if r.wedding_member_id.is_some() || r.has_wedding_order {
                "wedding_order".to_string()
            } else if r.has_special_order {
                "special_order".to_string()
            } else {
                "regular_order".to_string()
            };
            OrderListResponse {
                order_id: r.order_id,
                booked_at: r.booked_at,
                status: r.status,
                total_price: r.total_price,
                amount_paid: r.amount_paid,
                balance_due: r.balance_due,
                customer_id: r.customer_id,
                customer_name,
                wedding_member_id: r.wedding_member_id,
                wedding_party_id: r.wedding_party_id,
                party_name: r.party_name,
                primary_salesperson_name: r.primary_salesperson_name,
                item_count: r.item_count,
                order_kind,
            }
        })
        .collect();

    Ok(PagedOrdersResponse { items, total_count })
}
