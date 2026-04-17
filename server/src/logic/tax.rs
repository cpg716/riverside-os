//! NYS Publication 718-C logic for Erie County clothing/footwear exemption (ROS §3.3).
//!
//! **Criteria:** (Category: Clothing **or** Footwear) **and** (Net Price strictly less than $110.00).  
//! **When criteria match:** 4.00% State Tax = 0; 4.75% Local Tax active (4.75% combined).  
//! **Otherwise:** 4.00% State + 4.75% Local (8.75% combined)—e.g. net ≥ $110 or non-clothing/footwear.

use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use rust_decimal_macros::dec;

/// Net price must be **strictly less than** this amount (USD) for the exemption criteria (§3.3).
pub const CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_USD: Decimal = dec!(110.00);

/// NYS state component when it applies (4.00%).
pub const NYS_STATE_SALES_TAX_RATE: Decimal = dec!(0.04);

/// Erie County local component (4.75%).
pub const ERIE_LOCAL_SALES_TAX_RATE: Decimal = dec!(0.0475);

/// Combined state + local when both apply (8.75%).
pub const FULL_COMBINED_SALES_TAX_RATE: Decimal = dec!(0.0875);

/// Combined rate when state is zeroed under 718-C (local only: 4.75%).
pub const LOCAL_ONLY_COMBINED_SALES_TAX_RATE: Decimal = dec!(0.0475);

/// Product tax classification for Publication 718-C.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, sqlx::Type,
)]
#[sqlx(type_name = "tax_category", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum TaxCategory {
    Clothing,
    Footwear,
    Accessory,
    Service,
    /// Any other category (mapped to full state + local).
    Other,
}

impl TaxCategory {
    #[inline]
    pub fn is_clothing_or_footwear(self) -> bool {
        matches!(self, TaxCategory::Clothing | TaxCategory::Footwear)
    }
}

/// State and local **ad valorem** rates that apply to the line’s net taxable price (§3.3).
///
/// Returns `(state_rate, local_rate)` as decimals (e.g. `0.04`, `0.0475`).
#[inline]
pub fn nys_erie_state_and_local_rates(
    category: TaxCategory,
    net_taxable_price_usd: Decimal,
) -> (Decimal, Decimal) {
    let exempt_window = category.is_clothing_or_footwear()
        && net_taxable_price_usd < CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_USD;

    if exempt_window {
        (Decimal::ZERO, ERIE_LOCAL_SALES_TAX_RATE)
    } else {
        (NYS_STATE_SALES_TAX_RATE, ERIE_LOCAL_SALES_TAX_RATE)
    }
}

/// Combined sales tax rate for the line (state + local).
#[inline]
pub fn nys_erie_combined_rate(category: TaxCategory, net_taxable_price_usd: Decimal) -> Decimal {
    let (s, l) = nys_erie_state_and_local_rates(category, net_taxable_price_usd);
    s + l
}

/// Rounds USD monetary amounts to cents (half away from zero).
#[inline]
pub fn round_money_usd(amount: Decimal) -> Decimal {
    amount.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

/// State tax dollars on `taxable_base_usd` after applying §3.3 rates.
#[inline]
pub fn nys_state_tax_usd(
    category: TaxCategory,
    net_taxable_price_usd: Decimal,
    taxable_base_usd: Decimal,
) -> Decimal {
    let (state_rate, _) = nys_erie_state_and_local_rates(category, net_taxable_price_usd);
    round_money_usd(taxable_base_usd * state_rate)
}

/// Local tax dollars on `taxable_base_usd` after applying §3.3 rates.
#[inline]
pub fn erie_local_tax_usd(
    category: TaxCategory,
    net_taxable_price_usd: Decimal,
    taxable_base_usd: Decimal,
) -> Decimal {
    let (_, local_rate) = nys_erie_state_and_local_rates(category, net_taxable_price_usd);
    round_money_usd(taxable_base_usd * local_rate)
}

/// Total sales tax (state + local) on `taxable_base_usd`, recalculated from the line net price (§3.3).
#[inline]
pub fn nys_erie_total_sales_tax_usd(
    category: TaxCategory,
    net_taxable_price_usd: Decimal,
    taxable_base_usd: Decimal,
) -> Decimal {
    round_money_usd(
        nys_state_tax_usd(category, net_taxable_price_usd, taxable_base_usd)
            + erie_local_tax_usd(category, net_taxable_price_usd, taxable_base_usd),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clothing_under_110_local_only_matches_spec() {
        // §3.3: net $105 → 4.75% (state 0, local active); contrast 8.75% above threshold.
        let net = dec!(105.00);
        let (s, l) = nys_erie_state_and_local_rates(TaxCategory::Clothing, net);
        assert_eq!(s, Decimal::ZERO);
        assert_eq!(l, ERIE_LOCAL_SALES_TAX_RATE);
        assert_eq!(s + l, LOCAL_ONLY_COMBINED_SALES_TAX_RATE);

        let tax = nys_erie_total_sales_tax_usd(TaxCategory::Clothing, net, net);
        assert_eq!(
            tax,
            round_money_usd(net * LOCAL_ONLY_COMBINED_SALES_TAX_RATE)
        );
    }

    #[test]
    fn clothing_at_or_above_110_full_rate() {
        let net = dec!(110.00);
        let (s, l) = nys_erie_state_and_local_rates(TaxCategory::Clothing, net);
        assert_eq!(s, NYS_STATE_SALES_TAX_RATE);
        assert_eq!(l, ERIE_LOCAL_SALES_TAX_RATE);
        assert_eq!(s + l, FULL_COMBINED_SALES_TAX_RATE);

        let net115 = dec!(115.00);
        assert_eq!(
            nys_erie_combined_rate(TaxCategory::Clothing, net115),
            FULL_COMBINED_SALES_TAX_RATE
        );
    }

    #[test]
    fn discount_crossing_threshold_recalculates_instantly() {
        // §3.3 example: $115 → $105 shifts 8.75% to 4.75%.
        let high = dec!(115.00);
        let low = dec!(105.00);
        assert_eq!(
            nys_erie_combined_rate(TaxCategory::Clothing, high),
            FULL_COMBINED_SALES_TAX_RATE
        );
        assert_eq!(
            nys_erie_combined_rate(TaxCategory::Clothing, low),
            LOCAL_ONLY_COMBINED_SALES_TAX_RATE
        );
    }

    #[test]
    fn footwear_mirrors_clothing_for_threshold() {
        let net = dec!(109.99);
        let (s, l) = nys_erie_state_and_local_rates(TaxCategory::Footwear, net);
        assert_eq!(s, Decimal::ZERO);
        assert_eq!(l, ERIE_LOCAL_SALES_TAX_RATE);
    }

    #[test]
    fn other_category_always_full_rate_regardless_of_price() {
        let net = dec!(50.00);
        assert_eq!(
            nys_erie_combined_rate(TaxCategory::Other, net),
            FULL_COMBINED_SALES_TAX_RATE
        );
    }
}
