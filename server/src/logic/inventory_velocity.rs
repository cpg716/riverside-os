//! Best-sellers and dead-stock aggregate queries (order_items × orders with report basis).

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{FromRow, PgPool};

use super::report_basis::{order_date_filter_sql, ReportBasis};

#[derive(Debug, Serialize, FromRow)]
pub struct BestSellerRow {
    pub variant_id: uuid::Uuid,
    pub product_id: uuid::Uuid,
    pub sku: String,
    pub product_name: String,
    pub units_sold: i64,
    pub net_sales: Decimal,
    pub avg_unit_price: Decimal,
}

#[derive(Debug, Serialize, FromRow)]
pub struct DeadStockRow {
    pub variant_id: uuid::Uuid,
    pub product_id: uuid::Uuid,
    pub sku: String,
    pub product_name: String,
    pub stock_on_hand: i32,
    pub reserved_stock: i32,
    pub units_sold_in_period: i64,
    pub retail_value_on_hand: Decimal,
}

pub async fn fetch_best_sellers(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    basis: ReportBasis,
    limit: i64,
) -> Result<Vec<BestSellerRow>, sqlx::Error> {
    let order_filter = order_date_filter_sql(basis);
    let sql = format!(
        r#"
        SELECT
          oi.variant_id,
          p.id AS product_id,
          pv.sku,
          p.name AS product_name,
          SUM(oi.quantity)::bigint AS units_sold,
          SUM((oi.unit_price * oi.quantity)::numeric)::numeric(14, 2) AS net_sales,
          CASE
            WHEN SUM(oi.quantity) > 0 THEN
              (SUM((oi.unit_price * oi.quantity)::numeric) / NULLIF(SUM(oi.quantity)::numeric, 0))::numeric(14, 2)
            ELSE 0::numeric(14, 2)
          END AS avg_unit_price
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        INNER JOIN products p ON p.id = pv.product_id
        WHERE p.is_active = true
          AND {order_filter}
        GROUP BY oi.variant_id, p.id, pv.sku, p.name
        ORDER BY units_sold DESC, net_sales DESC
        LIMIT $3
        "#
    );

    sqlx::query_as::<_, BestSellerRow>(&sql)
        .bind(start)
        .bind(end)
        .bind(limit)
        .fetch_all(pool)
        .await
}

pub async fn fetch_dead_stock(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    basis: ReportBasis,
    max_units_sold: i64,
    limit: i64,
) -> Result<Vec<DeadStockRow>, sqlx::Error> {
    let order_filter = order_date_filter_sql(basis);
    let sql = format!(
        r#"
        WITH sales AS (
          SELECT
            oi.variant_id,
            SUM(oi.quantity)::bigint AS units_sold
          FROM order_items oi
          INNER JOIN orders o ON o.id = oi.order_id
          INNER JOIN product_variants pv2 ON pv2.id = oi.variant_id
          INNER JOIN products p2 ON p2.id = pv2.product_id
          WHERE p2.is_active = true
            AND {order_filter}
          GROUP BY oi.variant_id
        )
        SELECT
          pv.id AS variant_id,
          p.id AS product_id,
          pv.sku,
          p.name AS product_name,
          pv.stock_on_hand,
          pv.reserved_stock,
          COALESCE(s.units_sold, 0)::bigint AS units_sold_in_period,
          (pv.stock_on_hand::numeric
            * COALESCE(pv.retail_price_override, p.base_retail_price)::numeric)::numeric(14, 2) AS retail_value_on_hand
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN sales s ON s.variant_id = pv.id
        WHERE p.is_active = true
          AND (pv.stock_on_hand > 0 OR pv.reserved_stock > 0)
          AND COALESCE(s.units_sold, 0) <= $3
        ORDER BY retail_value_on_hand DESC, pv.stock_on_hand DESC
        LIMIT $4
        "#
    );

    sqlx::query_as::<_, DeadStockRow>(&sql)
        .bind(start)
        .bind(end)
        .bind(max_units_sold)
        .bind(limit)
        .fetch_all(pool)
        .await
}
