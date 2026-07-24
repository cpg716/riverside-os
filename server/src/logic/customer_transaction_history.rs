//! Paged Transaction Record and open Order lists for a single customer (CRM hub).

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
    pub is_exchange: bool,
    pub has_returns: bool,
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
    is_exchange: bool,
    has_returns: bool,
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
            COALESCE(o.display_id, o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS transaction_display_id,
            o.booked_at,
            CASE
                WHEN o.counterpoint_ticket_ref IS NOT NULL THEN 'fulfilled'::order_status
                ELSE o.status
            END AS status,
            o.sale_channel,
            o.total_price AS total_price,
            CASE
                WHEN o.counterpoint_ticket_ref IS NOT NULL THEN COALESCE(
                    NULLIF((SELECT SUM(pa.amount_allocated)
                            FROM payment_allocations pa
                            WHERE pa.target_transaction_id = o.id), 0),
                    o.amount_paid
                )
                ELSE o.amount_paid
            END AS amount_paid,
            CASE
                WHEN o.counterpoint_ticket_ref IS NOT NULL THEN 0::numeric
                ELSE o.balance_due
            END AS balance_due,
            COUNT(oi.id)::bigint AS item_count,
            EXISTS(
                SELECT 1
                FROM transaction_lines
                WHERE transaction_id = o.id
                  AND (
                      fulfillment_order_id IS NOT NULL
                      OR fulfillment::text IN ('special_order', 'custom', 'wedding_order')
                  )
            ) AS is_fulfillment_order,
            o.exchange_group_id IS NOT NULL AS is_exchange,
            EXISTS(
                SELECT 1
                FROM transaction_return_lines trl
                INNER JOIN transaction_lines returned_line
                    ON returned_line.id = trl.transaction_line_id
                WHERE returned_line.transaction_id = o.id
                  AND trl.quantity_returned > 0
            ) AS has_returns,
            o.is_counterpoint_import,
            CASE
                WHEN c.customer_created_source = 'counterpoint'
                 AND NULLIF(TRIM(c.customer_code), '') IS NOT NULL
                 AND NULLIF(TRIM(c.customer_code), '') !~* '^ROS-'
                THEN NULLIF(TRIM(c.customer_code), '')
                ELSE NULL
            END AS counterpoint_customer_code,
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
        r#" OR (
            o.is_counterpoint_import
            AND UPPER(BTRIM(o.metadata->>'counterpoint_customer_code')) = UPPER(BTRIM((
                SELECT customer_code FROM customers WHERE id = "#,
    );
    qb.push_bind(customer_id);
    qb.push(
        r#")::text))
        )
        OR EXISTS (
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
              AND (crp.unlinked_at IS NULL OR crp.parent_customer_id = "#,
    );
    qb.push_bind(customer_id);
    qb.push(
        r#")
        ))
        AND COALESCE(o.metadata->>'counterpoint_reconciliation_status', '') <> 'superseded' "#,
    );
    match q.record_scope {
        CustomerHistoryRecordScope::Transactions => {
            // Counterpoint tickets belong in Transactions; Counterpoint open docs do not.
            // Payment/deposit-only Counterpoint ticket artifacts are not purchases.
            qb.push(
                r#" AND o.counterpoint_doc_ref IS NULL
                AND NOT (
                    COALESCE(o.total_price, 0) = 0
                    AND COALESCE(o.amount_paid, 0) = 0
                    AND COALESCE(o.balance_due, 0) = 0
                    AND NOT EXISTS (
                        SELECT 1
                        FROM transaction_lines tl_payment_shell
                        WHERE tl_payment_shell.transaction_id = o.id
                    )
                    AND EXISTS (
                        SELECT 1
                        FROM payment_transactions pt_payment_shell
                        WHERE pt_payment_shell.metadata->>'checkout_transaction_id' = o.id::text
                    )
                )
                AND NOT (
                    COALESCE(o.is_counterpoint_import, false)
                    AND o.counterpoint_ticket_ref IS NOT NULL
                    AND COALESCE(o.total_price, 0) <= 0
                    AND COALESCE(o.amount_paid, 0) > 0
                    AND COALESCE(o.balance_due, 0) < 0
                ) "#,
            );
        }
        CustomerHistoryRecordScope::Orders => {
            // Customer Hub Orders includes the complete order record regardless of lifecycle status.
            qb.push(
                " AND (o.counterpoint_doc_ref IS NOT NULL OR EXISTS(SELECT 1 FROM transaction_lines tl_scope WHERE tl_scope.transaction_id = o.id AND (tl_scope.fulfillment_order_id IS NOT NULL OR tl_scope.fulfillment::text IN ('special_order', 'custom', 'wedding_order')))) ",
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
        " GROUP BY o.id, o.display_id, o.booked_at, o.status, o.sale_channel, o.total_price, o.amount_paid, o.balance_due, o.is_counterpoint_import, c.customer_code, c.customer_created_source, ps.full_name ",
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
            is_exchange: r.is_exchange,
            has_returns: r.has_returns,
            is_counterpoint_import: r.is_counterpoint_import,
            counterpoint_customer_code: r.counterpoint_customer_code,
            primary_salesperson_name: r.primary_salesperson_name,
        })
        .collect();

    Ok(CustomerTransactionHistoryResponse { items, total_count })
}
