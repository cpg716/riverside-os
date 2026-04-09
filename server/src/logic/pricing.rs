//! Employee “cost-plus” sale pricing (ROS §4.2).
//!
//! **Logic:** Unit Cost × (1 + Global Employee Markup Percentage).  
//! **Safety:** Employee sales use **0%** commission (exposed as a constant for order/commission layers).

use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use rust_decimal_macros::dec;

/// Commission rate applied to employee sales (§4.2 safety).
pub const EMPLOYEE_SALE_COMMISSION_RATE: Decimal = Decimal::ZERO;

/// Rounds USD monetary amounts to cents (half away from zero).
#[inline]
pub fn round_money_usd(amount: Decimal) -> Decimal {
    amount.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

/// Employee unit sale price: **Unit Cost × (1 + markup%) + flat extra** (§4.2).
///
/// `markup_percent` is a **whole percent of cost**, e.g. `25` means multiplier `1.25`.
/// `extra_amount_usd` is added per unit after the cost-plus step (default 0).
#[inline]
pub fn employee_sale_unit_price_usd(
    unit_cost_usd: Decimal,
    markup_percent: Decimal,
    extra_amount_usd: Decimal,
) -> Decimal {
    let multiplier = Decimal::ONE + (markup_percent / dec!(100));
    round_money_usd(unit_cost_usd * multiplier + extra_amount_usd)
}

/// Whether commission should be suppressed for an employee sale (§4.2).
#[inline]
pub const fn employee_sale_commission_rate() -> Decimal {
    EMPLOYEE_SALE_COMMISSION_RATE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_plus_formula_example() {
        // cost $100, 25% markup → $125
        let price = employee_sale_unit_price_usd(dec!(100.00), dec!(25), Decimal::ZERO);
        assert_eq!(price, dec!(125.00));
        assert_eq!(
            employee_sale_unit_price_usd(dec!(100.00), dec!(25), dec!(5.00)),
            dec!(130.00)
        );
    }

    #[test]
    fn commission_is_zero_for_employee_sales() {
        assert_eq!(employee_sale_commission_rate(), Decimal::ZERO);
    }

    #[test]
    fn rounding_half_away() {
        // 10 * 1.333...% = 10 * 1.013333... = 101.333... → 101.33 if we used markup 1.333 - use clearer case
        let price = employee_sale_unit_price_usd(dec!(10.00), dec!(33.33), Decimal::ZERO);
        let mult = dec!(1.3333);
        let expected = round_money_usd(dec!(10.00) * mult);
        assert_eq!(price, expected);
    }
}
