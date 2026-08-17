//! Template ↔ variant **override inheritance** for retail, sale, and cost.
//!
//! Effective values follow: `override ?? template.base` (nullable override = inherit).

use rust_decimal::Decimal;

/// Customer-facing retail: variant override, else product template base.
#[inline]
pub fn effective_retail_usd(
    template_base_retail: Decimal,
    retail_price_override: Option<Decimal>,
) -> Decimal {
    retail_price_override.unwrap_or(template_base_retail)
}

/// Optional promotional price: variant override, else product template sale price.
#[inline]
pub fn effective_sale_usd(
    template_base_sale: Option<Decimal>,
    sale_price_override: Option<Decimal>,
) -> Option<Decimal> {
    sale_price_override.or(template_base_sale)
}

/// Inventory / margin cost: variant override, else product template base.
#[inline]
pub fn effective_cost_usd(template_base_cost: Decimal, cost_override: Option<Decimal>) -> Decimal {
    cost_override.unwrap_or(template_base_cost)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn retail_inherits_when_no_override() {
        assert_eq!(effective_retail_usd(dec!(125.00), None), dec!(125.00));
    }

    #[test]
    fn retail_uses_override() {
        assert_eq!(
            effective_retail_usd(dec!(125.00), Some(dec!(145.00))),
            dec!(145.00)
        );
    }

    #[test]
    fn sale_inherits_when_no_override() {
        assert_eq!(
            effective_sale_usd(Some(dec!(99.00)), None),
            Some(dec!(99.00))
        );
    }

    #[test]
    fn sale_uses_override() {
        assert_eq!(
            effective_sale_usd(Some(dec!(99.00)), Some(dec!(89.00))),
            Some(dec!(89.00))
        );
    }

    #[test]
    fn sale_remains_unset_without_parent_or_sku_price() {
        assert_eq!(effective_sale_usd(None, None), None);
    }

    #[test]
    fn cost_inherits_when_no_override() {
        assert_eq!(effective_cost_usd(dec!(60.00), None), dec!(60.00));
    }
}
