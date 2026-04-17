use rust_decimal::Decimal;

/// Swedish (Swedish) Rounding logic ($0.05 step).
///
/// Rules:
/// - .00, .01, .02 -> .00
/// - .03, .04, .05, .06, .07 -> .05
/// - .08, .09 -> .10
///
/// Formula: (val * 20).round() / 20
pub fn calculate_swedish_rounding(amount: Decimal) -> Decimal {
    if amount == Decimal::ZERO {
        return Decimal::ZERO;
    }

    // (amount * 20).round() / 20
    let factor = Decimal::from(20);
    (amount * factor).round() / factor
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn test_swedish_rounding() {
        assert_eq!(calculate_swedish_rounding(dec!(10.00)), dec!(10.00));
        assert_eq!(calculate_swedish_rounding(dec!(10.01)), dec!(10.00));
        assert_eq!(calculate_swedish_rounding(dec!(10.02)), dec!(10.00));
        assert_eq!(calculate_swedish_rounding(dec!(10.03)), dec!(10.05));
        assert_eq!(calculate_swedish_rounding(dec!(10.04)), dec!(10.05));
        assert_eq!(calculate_swedish_rounding(dec!(10.05)), dec!(10.05));
        assert_eq!(calculate_swedish_rounding(dec!(10.06)), dec!(10.05));
        assert_eq!(calculate_swedish_rounding(dec!(10.07)), dec!(10.05));
        assert_eq!(calculate_swedish_rounding(dec!(10.08)), dec!(10.10));
        assert_eq!(calculate_swedish_rounding(dec!(10.09)), dec!(10.10));
        assert_eq!(calculate_swedish_rounding(dec!(10.10)), dec!(10.10));
    }
}
