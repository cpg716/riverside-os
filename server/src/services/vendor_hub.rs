//! Read models for the vendor workspace (supply-chain health strip).

use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct VendorHubDto {
    pub vendor_id: Uuid,
    pub vendor_name: String,
    pub account_number: Option<String>,
    pub payment_terms: Option<String>,
    pub vendor_code: Option<String>,
    pub nuorder_brand_id: Option<String>,
    pub use_vendor_upc: bool,
    /// POs not in closed/cancelled — includes draft standard POs and in-flight docs.
    pub active_po_count: i64,
    /// Sum of `quantity_received * unit_cost` on non-cancelled PO lines (received value).
    pub total_received_spend: Decimal,
    /// Placeholder until AP credits / vendor CR notes are modeled.
    pub open_credits_usd: Decimal,
    /// Mean days from `submitted_at` to first `receiving_events.received_at`, when both exist.
    pub avg_lead_time_days: Option<f64>,
}

type VendorHubHeaderRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

pub async fn fetch_vendor_hub(
    pool: &PgPool,
    vendor_id: Uuid,
) -> Result<Option<VendorHubDto>, sqlx::Error> {
    let header: Option<VendorHubHeaderRow> = sqlx::query_as(
        r#"
        SELECT
            name,
            account_number,
            payment_terms,
            vendor_code,
            nuorder_brand_id,
            COALESCE(use_vendor_upc, false) AS use_vendor_upc
        FROM vendors
        WHERE id = $1 AND is_active = TRUE
        "#,
    )
    .bind(vendor_id)
    .fetch_optional(pool)
    .await?;

    let Some((
        vendor_name,
        account_number,
        payment_terms,
        vendor_code,
        nuorder_brand_id,
        use_vendor_upc,
    )) = header
    else {
        return Ok(None);
    };

    let active_po_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM purchase_orders
        WHERE vendor_id = $1
          AND status::text NOT IN ('closed', 'cancelled')
        "#,
    )
    .bind(vendor_id)
    .fetch_one(pool)
    .await?;

    let total_received_spend: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(
            SUM(pol.quantity_received::numeric * pol.unit_cost),
            0
        )::decimal
        FROM purchase_order_lines pol
        INNER JOIN purchase_orders po ON po.id = pol.purchase_order_id
        WHERE po.vendor_id = $1
          AND po.status::text <> 'cancelled'
        "#,
    )
    .bind(vendor_id)
    .fetch_one(pool)
    .await?;

    let avg_lead_time_days: Option<f64> = sqlx::query_scalar(
        r#"
        SELECT AVG(
            EXTRACT(EPOCH FROM (fr.first_at - po.submitted_at)) / 86400.0
        )::float8
        FROM purchase_orders po
        INNER JOIN (
            SELECT purchase_order_id, MIN(received_at) AS first_at
            FROM receiving_events
            GROUP BY purchase_order_id
        ) fr ON fr.purchase_order_id = po.id
        WHERE po.vendor_id = $1
          AND po.submitted_at IS NOT NULL
          AND fr.first_at IS NOT NULL
        "#,
    )
    .bind(vendor_id)
    .fetch_one(pool)
    .await?;

    Ok(Some(VendorHubDto {
        vendor_id,
        vendor_name,
        account_number,
        payment_terms,
        vendor_code,
        nuorder_brand_id,
        use_vendor_upc,
        active_po_count,
        total_received_spend,
        open_credits_usd: Decimal::ZERO,
        avg_lead_time_days,
    }))
}
