//! Paged order list for a single customer (CRM hub).

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, QueryBuilder};
use uuid::Uuid;

use crate::models::{DbOrderStatus, DbSaleChannel};

#[derive(Debug, Deserialize)]
pub struct CustomerOrderHistoryQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CustomerOrderHistoryItem {
    pub order_id: Uuid,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub sale_channel: DbSaleChannel,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub item_count: i64,
    pub primary_salesperson_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CustomerOrderHistoryResponse {
    pub items: Vec<CustomerOrderHistoryItem>,
    pub total_count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
    order_id: Uuid,
    booked_at: DateTime<Utc>,
    status: DbOrderStatus,
    sale_channel: DbSaleChannel,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    item_count: i64,
    primary_salesperson_name: Option<String>,
    total_count: i64,
}

pub async fn query_customer_order_history(
    pool: &PgPool,
    customer_id: Uuid,
    q: &CustomerOrderHistoryQuery,
) -> Result<CustomerOrderHistoryResponse, sqlx::Error> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);

    let mut qb = QueryBuilder::new(
        r#"SELECT
            o.id AS order_id,
            o.booked_at,
            o.status,
            o.sale_channel,
            o.total_price,
            o.amount_paid,
            o.balance_due,
            COUNT(oi.id)::bigint AS item_count,
            ps.full_name AS primary_salesperson_name,
            COUNT(*) OVER()::bigint AS total_count
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        WHERE o.customer_id = "#,
    );
    qb.push_bind(customer_id);
    qb.push(" AND o.status != 'cancelled'::order_status ");
    if let Some(from) = &q.from {
        if !from.trim().is_empty() {
            qb.push(" AND o.booked_at >= ");
            let dt = format!("{}T00:00:00Z", from.trim());
            qb.push_bind(dt);
            qb.push("::timestamptz ");
        }
    }
    if let Some(to) = &q.to {
        if !to.trim().is_empty() {
            qb.push(" AND o.booked_at <= ");
            let dtt = format!("{}T23:59:59Z", to.trim());
            qb.push_bind(dtt);
            qb.push("::timestamptz ");
        }
    }
    qb.push(
        " GROUP BY o.id, o.booked_at, o.status, o.sale_channel, o.total_price, o.amount_paid, o.balance_due, ps.full_name ",
    );
    qb.push(" ORDER BY o.booked_at DESC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows: Vec<Row> = qb.build_query_as().fetch_all(pool).await?;
    let total_count = rows.first().map(|r| r.total_count).unwrap_or(0);
    let items = rows
        .into_iter()
        .map(|r| CustomerOrderHistoryItem {
            order_id: r.order_id,
            booked_at: r.booked_at,
            status: r.status,
            sale_channel: r.sale_channel,
            total_price: r.total_price,
            amount_paid: r.amount_paid,
            balance_due: r.balance_due,
            item_count: r.item_count,
            primary_salesperson_name: r.primary_salesperson_name,
        })
        .collect();

    Ok(CustomerOrderHistoryResponse { items, total_count })
}
