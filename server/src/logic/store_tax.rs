//! Destination tax v1: flat combined rate per US state (see `store_tax_state_rate`).
//! Web cart preview also applies **store policy** for pickup vs ship (see `docs/ONLINE_STORE.md`).

use rust_decimal::Decimal;
use sqlx::PgPool;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebFulfillmentMode {
    /// Customer takes possession at the NY store — NY sales tax applies.
    StorePickup,
    /// Shipment to customer address — NY tax only when ship-to is NY; otherwise $0 per current nexus policy.
    Ship,
}

#[derive(Debug, Clone)]
pub struct WebTaxPreviewResult {
    pub effective_state: String,
    pub fulfillment: &'static str,
    pub combined_rate: Decimal,
    pub tax_estimated: Decimal,
    pub disclaimer: &'static str,
}

#[derive(Debug, Error)]
pub enum StoreTaxError {
    #[error("unknown or unsupported ship-to state")]
    UnknownState,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Returns combined sales tax rate for `state` (two-letter, case-insensitive), if configured.
pub async fn combined_rate_for_state(pool: &PgPool, state: &str) -> Result<Decimal, StoreTaxError> {
    let s = state.trim().to_uppercase();
    if s.len() != 2 {
        return Err(StoreTaxError::UnknownState);
    }
    let rate: Option<Decimal> = sqlx::query_scalar(
        r#"
        SELECT combined_rate
        FROM store_tax_state_rate
        WHERE state_code = $1
        "#,
    )
    .bind(&s)
    .fetch_optional(pool)
    .await?;

    rate.ok_or(StoreTaxError::UnknownState)
}

/// Tax amount = `subtotal * rate`, rounded to cents (half-up).
pub fn tax_amount_from_subtotal(subtotal: Decimal, rate: Decimal) -> Decimal {
    use rust_decimal::RoundingStrategy;
    let raw = subtotal * rate;
    raw.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

/// Public `/shop` tax estimate: pickup always NY; shipped orders use NY rate only when ship-to is NY.
pub async fn web_tax_preview(
    pool: &PgPool,
    mode: WebFulfillmentMode,
    ship_to_state: &str,
    subtotal: Decimal,
) -> Result<WebTaxPreviewResult, StoreTaxError> {
    match mode {
        WebFulfillmentMode::StorePickup => {
            let rate = combined_rate_for_state(pool, "NY").await?;
            let tax = tax_amount_from_subtotal(subtotal, rate);
            Ok(WebTaxPreviewResult {
                effective_state: "NY".to_string(),
                fulfillment: "store_pickup",
                combined_rate: rate,
                tax_estimated: tax,
                disclaimer: "In-store pickup: New York sales tax applies (possession in NY). Estimate only — confirm with your CPA.",
            })
        }
        WebFulfillmentMode::Ship => {
            let st = ship_to_state.trim().to_uppercase();
            if st.len() != 2 {
                return Err(StoreTaxError::UnknownState);
            }
            if st == "NY" {
                let rate = combined_rate_for_state(pool, "NY").await?;
                let tax = tax_amount_from_subtotal(subtotal, rate);
                Ok(WebTaxPreviewResult {
                    effective_state: st,
                    fulfillment: "ship",
                    combined_rate: rate,
                    tax_estimated: tax,
                    disclaimer: "Ship-to New York: NY sales tax estimate from configured combined rate. Confirm with your CPA.",
                })
            } else {
                Ok(WebTaxPreviewResult {
                    effective_state: st,
                    fulfillment: "ship",
                    combined_rate: Decimal::ZERO,
                    tax_estimated: Decimal::ZERO,
                    disclaimer: "Ship-to outside NY: we are not collecting New York sales tax on this shipment. We do not collect tax for other states where we have no sales tax nexus. Confirm with your CPA.",
                })
            }
        }
    }
}
