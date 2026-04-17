//! BOOKED vs COMPLETED axis for revenue and order analytics.
//! - **Booked**: date of sale (`orders.booked_at`) — registers, deposits on open orders.
//! - **Completed** (recognition): pickup / in-store takeaway uses `orders.fulfilled_at`; **ship**
//!   (POS or web, `fulfillment_method = ship`) uses the earliest qualifying `shipment_event`
//!   (`label_purchased` or manual `in_transit` / `delivered` patch — same rule as `reporting.order_recognition_at`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportBasis {
    Booked,
    Completed,
}

impl ReportBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            ReportBasis::Booked => "booked",
            ReportBasis::Completed => "completed",
        }
    }

    pub fn is_completed(self) -> bool {
        matches!(self, ReportBasis::Completed)
    }
}

/// SQL expression (orders alias `o`) for the recognition instant. Must stay aligned with
/// `reporting.order_recognition_at` in migration `106_reporting_order_recognition.sql`.
pub const ORDER_RECOGNITION_TS_SQL: &str = r#"(CASE
    WHEN o.status::text = 'cancelled' THEN NULL::timestamptz
    WHEN COALESCE(NULLIF(BTRIM(o.fulfillment_method::text), ''), 'pickup') = 'pickup' THEN o.fulfilled_at
    ELSE (
        SELECT MIN(se.at)
        FROM shipment s
        INNER JOIN shipment_event se ON se.shipment_id = s.id
        WHERE s.transaction_id = o.id
          AND COALESCE(s.status::text, '') <> 'cancelled'
          AND (
              se.kind = 'label_purchased'
              OR (se.kind = 'updated' AND (
                  se.message LIKE '%status set to in_transit%'
                  OR se.message LIKE '%status set to delivered%'
              ))
          )
    )
END)"#;

/// `orders` row must be aliased `o`. Bind UTC `$1`/`$2` as half-open `[start, end)`.
pub fn order_date_filter_sql(basis: ReportBasis) -> String {
    match basis {
        ReportBasis::Booked => {
            "o.status::text NOT IN ('cancelled') AND o.booked_at >= $1 AND o.booked_at < $2"
                .to_string()
        }
        ReportBasis::Completed => format!(
            "o.status::text <> 'cancelled' AND ({ts}) IS NOT NULL AND ({ts}) >= $1 AND ({ts}) < $2",
            ts = ORDER_RECOGNITION_TS_SQL.trim()
        ),
    }
}

/// Sales tax and other **recognition-only** reports: always completed (recognition) window.
pub fn order_recognition_tax_filter_sql() -> String {
    order_date_filter_sql(ReportBasis::Completed)
}

/// Accepts `booked` / `completed` and legacy aliases `sale` / `pickup`.
pub fn parse_report_basis(raw: &str) -> Result<ReportBasis, String> {
    match raw.trim().to_lowercase().as_str() {
        "" | "booked" | "sale" | "booking" => Ok(ReportBasis::Booked),
        "completed" | "pickup" | "fulfillment" | "fulfilled" => Ok(ReportBasis::Completed),
        other => Err(format!(
            "basis must be 'booked' or 'completed' (got '{other}'; aliases: sale, pickup)"
        )),
    }
}
