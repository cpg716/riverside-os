//! Weighted average cost (WAC), freight allocation for ledger mapping, and cost-variance helpers.
//!
//! **Inventory / WAC:** Blended cost uses **invoice unit cost only** — freight is excluded from
//! `cost_override` and WAC so inventory assets stay aligned with physical product cost; freight is
//! carried separately (e.g. `inventory_transactions.landed_cost_component` → QBO expense).

use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use rust_decimal_macros::dec;

/// Round inventory unit cost to four decimal places (internal precision).
#[inline]
pub fn round_unit_cost(d: Decimal) -> Decimal {
    d.round_dp_with_strategy(4, RoundingStrategy::AwayFromZero)
}

/// Blended cost after receiving: \((Q_{old} \cdot C_{old}) + (Q_{new} \cdot C_{landed}) / (Q_{old} + Q_{new})\).
#[inline]
pub fn weighted_average_cost(
    qty_on_hand_before: i32,
    cost_before: Decimal,
    qty_incoming: i32,
    landed_unit_cost: Decimal,
) -> Option<Decimal> {
    if qty_incoming <= 0 {
        return None;
    }
    let q_old = Decimal::from(qty_on_hand_before);
    let q_new = Decimal::from(qty_incoming);
    let denom = q_old + q_new;
    if denom.is_zero() {
        return None;
    }
    let numer = q_old * cost_before + q_new * landed_unit_cost;
    Some(round_unit_cost(numer / denom))
}

/// Prorate freight by each line's extended cost share; return **added cost per unit** for that line.
pub fn freight_add_per_unit_by_extended_cost(
    lines: &[(i32, Decimal)],
    freight_total: Decimal,
) -> Vec<Decimal> {
    let mut extended = Decimal::ZERO;
    for (q, uc) in lines {
        if *q > 0 {
            extended += Decimal::from(*q) * *uc;
        }
    }
    if extended.is_zero() || freight_total.is_zero() {
        return lines.iter().map(|_| Decimal::ZERO).collect();
    }
    lines
        .iter()
        .map(|(q, uc)| {
            if *q <= 0 {
                return Decimal::ZERO;
            }
            let line_ext = Decimal::from(*q) * *uc;
            let line_freight = freight_total * (line_ext / extended);
            round_unit_cost(line_freight / Decimal::from(*q))
        })
        .collect()
}

/// Absolute relative deviation: `|invoice - prior| / prior` when prior > 0.
#[inline]
pub fn cost_relative_deviation(prior_effective: Decimal, invoice_landed_unit: Decimal) -> Decimal {
    if prior_effective <= Decimal::ZERO {
        return Decimal::ZERO;
    }
    ((invoice_landed_unit - prior_effective).abs() / prior_effective)
        .round_dp_with_strategy(6, RoundingStrategy::AwayFromZero)
}

/// True when deviation strictly exceeds threshold (default 5%).
#[inline]
pub fn exceeds_cost_alert_threshold(
    prior_effective: Decimal,
    invoice_landed_unit: Decimal,
    threshold: Decimal,
) -> bool {
    cost_relative_deviation(prior_effective, invoice_landed_unit) > threshold
}

/// Default vendor overcharge alert band (5%).
pub const DEFAULT_COST_ALERT_THRESHOLD: Decimal = dec!(0.05);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wac_example_from_spec() {
        // 5 @ 10 + 10 @ 12 → 170 / 15 = 11.333…
        let blended = weighted_average_cost(5, dec!(10.00), 10, dec!(12.00)).unwrap();
        assert!(blended >= dec!(11.33) && blended <= dec!(11.34));
    }

    #[test]
    fn freight_split_two_lines() {
        // Line A: 2 @ 10 = 20, Line B: 1 @ 30 = 30 → extended 50, freight 10
        // A gets 10 * 20/50 = 4 → 2/unit ; B gets 10 * 30/50 = 6 → 6/unit
        let add = freight_add_per_unit_by_extended_cost(&[(2, dec!(10)), (1, dec!(30))], dec!(10));
        assert_eq!(add.len(), 2);
        assert_eq!(add[0], dec!(2));
        assert_eq!(add[1], dec!(6));
    }
}
