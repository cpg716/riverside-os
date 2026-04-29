//! Paged order list for a single customer (CRM hub).

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, QueryBuilder};
use uuid::Uuid;

use crate::models::{DbOrderStatus, DbSaleChannel};

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CustomerHistoryRecordScope {
    #[default]
    Transactions,
    Orders,
}

#[derive(Debug, Deserialize)]
pub struct CustomerTransactionHistoryQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    #[serde(default)]
    pub record_scope: CustomerHistoryRecordScope,
}

#[derive(Debug, Serialize)]
pub struct CustomerTransactionHistoryItem {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub sale_channel: DbSaleChannel,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub item_count: i64,
    pub is_fulfillment_order: bool,
    pub is_counterpoint_import: bool,
    pub counterpoint_customer_code: Option<String>,
    pub primary_salesperson_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CustomerTransactionHistoryResponse {
    pub items: Vec<CustomerTransactionHistoryItem>,
    pub total_count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
    transaction_id: Uuid,
    transaction_display_id: String,
    booked_at: DateTime<Utc>,
    status: DbOrderStatus,
    sale_channel: DbSaleChannel,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    item_count: i64,
    is_fulfillment_order: bool,
    is_counterpoint_import: bool,
    counterpoint_customer_code: Option<String>,
    primary_salesperson_name: Option<String>,
    total_count: i64,
}

pub async fn query_customer_transaction_history(
    pool: &PgPool,
    customer_id: Uuid,
    q: &CustomerTransactionHistoryQuery,
) -> Result<CustomerTransactionHistoryResponse, sqlx::Error> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);

    let mut qb = QueryBuilder::new(
        r#"SELECT
            o.id AS transaction_id,
            o.display_id AS transaction_display_id,
            o.booked_at,
            o.status,
            o.sale_channel,
            o.total_price,
            o.amount_paid,
            o.balance_due,
            COUNT(oi.id)::bigint AS item_count,
            EXISTS(SELECT 1 FROM transaction_lines WHERE transaction_id = o.id AND fulfillment != 'takeaway') AS is_fulfillment_order,
            o.is_counterpoint_import,
            NULLIF(TRIM(c.customer_code), '') AS counterpoint_customer_code,
            ps.full_name AS primary_salesperson_name,
            COUNT(*) OVER()::bigint AS total_count
        FROM transactions o
        LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE (o.customer_id = "#,
    );
    qb.push_bind(customer_id);
    qb.push(
        r#" OR EXISTS (
            SELECT 1
            FROM customer_relationship_periods crp
            WHERE (
                (crp.parent_customer_id = "#,
    );
    qb.push_bind(customer_id);
    qb.push(
        r#" AND crp.child_customer_id = o.customer_id)
                OR
                (crp.child_customer_id = "#,
    );
    qb.push_bind(customer_id);
    qb.push(
        r#" AND crp.parent_customer_id = o.customer_id)
            )
              AND o.booked_at >= crp.linked_at
              AND (crp.unlinked_at IS NULL OR o.booked_at <= crp.unlinked_at)
        )) "#,
    );
    qb.push(" AND o.status != 'cancelled'::order_status ");
    match q.record_scope {
        CustomerHistoryRecordScope::Transactions => {
            // Counterpoint tickets belong in Transactions; Counterpoint open docs do not.
            qb.push(" AND o.counterpoint_doc_ref IS NULL ");
        }
        CustomerHistoryRecordScope::Orders => {
            // Orders should show Counterpoint open docs plus ROS order-style activity.
            qb.push(
                " AND (o.counterpoint_doc_ref IS NOT NULL OR EXISTS(SELECT 1 FROM transaction_lines tl_scope WHERE tl_scope.transaction_id = o.id AND tl_scope.fulfillment != 'takeaway')) ",
            );
        }
    }
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
        " GROUP BY o.id, o.display_id, o.booked_at, o.status, o.sale_channel, o.total_price, o.amount_paid, o.balance_due, o.is_counterpoint_import, c.customer_code, ps.full_name ",
    );
    qb.push(" ORDER BY o.booked_at DESC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows: Vec<Row> = qb.build_query_as().fetch_all(pool).await?;
    let total_count = rows.first().map(|r| r.total_count).unwrap_or(0);
    let items = rows
        .into_iter()
        .map(|r| CustomerTransactionHistoryItem {
            transaction_id: r.transaction_id,
            transaction_display_id: r.transaction_display_id,
            booked_at: r.booked_at,
            status: r.status,
            sale_channel: r.sale_channel,
            total_price: r.total_price,
            amount_paid: r.amount_paid,
            balance_due: r.balance_due,
            item_count: r.item_count,
            is_fulfillment_order: r.is_fulfillment_order,
            is_counterpoint_import: r.is_counterpoint_import,
            counterpoint_customer_code: r.counterpoint_customer_code,
            primary_salesperson_name: r.primary_salesperson_name,
        })
        .collect();

    Ok(CustomerTransactionHistoryResponse { items, total_count })
}
