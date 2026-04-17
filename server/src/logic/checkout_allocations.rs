use crate::logic::transaction_checkout::{CheckoutError, CheckoutRequest};
use rust_decimal::Decimal;
use serde_json::json;

#[derive(Debug)]
pub struct ResolvedPaymentSplit {
    pub method: String,
    pub amount: Decimal,
    pub gift_card_code: Option<String>,
    pub metadata: serde_json::Value,
    pub stripe_intent_id: Option<String>,
    pub check_number: Option<String>,
    pub merchant_fee: Decimal,
    pub net_amount: Decimal,
    pub card_brand: Option<String>,
    pub card_last4: Option<String>,
}

pub fn tender_sum_excluding_deposit_like(splits: &[ResolvedPaymentSplit]) -> Decimal {
    let mut s = Decimal::ZERO;
    for sp in splits {
        let m = sp.method.trim().to_ascii_lowercase();
        if m == "deposit_ledger" || m == "open_deposit" {
            continue;
        }
        s += sp.amount;
    }
    s.round_dp(2)
}

/// Estimates Stripe processing fees to provide immediate net financial reporting.
/// In-person (Terminal) defaults to 2.7% + $0.05. Online / Manual Entry defaults to 2.9% + $0.30.
pub fn estimate_stripe_fee(amount: Decimal, is_terminal: bool) -> Decimal {
    if is_terminal {
        // 2.7% + 5 cents
        let pct = amount * Decimal::new(27, 3); // 0.027
        let fixed = Decimal::new(5, 2); // 0.05
        (pct + fixed).round_dp(2)
    } else {
        // 2.9% + 30 cents
        let pct = amount * Decimal::new(29, 3); // 0.029
        let fixed = Decimal::new(30, 2); // 0.30
        (pct + fixed).round_dp(2)
    }
}

/// Builds normalized split rows and a human-readable label for wedding activity / receipts.
pub fn resolve_payment_splits(
    payload: &CheckoutRequest,
) -> Result<(Vec<ResolvedPaymentSplit>, String), CheckoutError> {
    let amount_paid = payload.amount_paid.round_dp(2);

    if let Some(ref splits) = payload.payment_splits {
        if !splits.is_empty() {
            let mut out: Vec<ResolvedPaymentSplit> = Vec::new();
            let mut sum = Decimal::ZERO;
            let mut deposit_sum = Decimal::ZERO;
            for line in splits {
                let m = line.payment_method.trim();
                if m.is_empty() || m.len() > 50 {
                    return Err(CheckoutError::InvalidPayload(
                        "each split needs payment_method (max 50 characters)".to_string(),
                    ));
                }
                if m.eq_ignore_ascii_case("gift_card") {
                    let st = line
                        .sub_type
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| {
                            CheckoutError::InvalidPayload(
                                "gift_card split requires sub_type (`paid_liability`, `loyalty_giveaway`, or `donated_giveaway`)".to_string(),
                            )
                        })?;
                    if st != "paid_liability"
                        && st != "loyalty_giveaway"
                        && st != "donated_giveaway"
                    {
                        return Err(CheckoutError::InvalidPayload(
                            "gift_card sub_type must be `paid_liability`, `loyalty_giveaway`, or `donated_giveaway`".to_string(),
                        ));
                    }
                } else if line
                    .sub_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some()
                {
                    return Err(CheckoutError::InvalidPayload(
                        "sub_type is only allowed for gift_card payment_method".to_string(),
                    ));
                }
                let a = line.amount.round_dp(2);
                if a <= Decimal::ZERO {
                    return Err(CheckoutError::InvalidPayload(
                        "split amounts must be positive".to_string(),
                    ));
                }
                sum += a;
                let applied_deposit_amount = line
                    .applied_deposit_amount
                    .unwrap_or(Decimal::ZERO)
                    .round_dp(2);
                if applied_deposit_amount < Decimal::ZERO {
                    return Err(CheckoutError::InvalidPayload(
                        "applied_deposit_amount cannot be negative".to_string(),
                    ));
                }
                if applied_deposit_amount > a {
                    return Err(CheckoutError::InvalidPayload(
                        "applied_deposit_amount cannot exceed split amount".to_string(),
                    ));
                }
                deposit_sum += applied_deposit_amount;
                let gift_card_code = line
                    .gift_card_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);

                let incoming_meta = line.metadata.clone().unwrap_or_else(|| json!({}));
                let stripe_intent_id = incoming_meta
                    .get("stripe_intent_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let card_brand = incoming_meta
                    .get("card_brand")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let card_last4 = incoming_meta
                    .get("card_last4")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let check_number = line.check_number.clone().or_else(|| {
                    incoming_meta
                        .get("check_number")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                });

                let fee = if stripe_intent_id.is_some() {
                    estimate_stripe_fee(
                        a,
                        m.to_lowercase().contains("terminal")
                            || m.to_lowercase().contains("present"),
                    )
                } else {
                    Decimal::ZERO
                };

                out.push(ResolvedPaymentSplit {
                    method: m.to_string(),
                    amount: a,
                    gift_card_code: gift_card_code.clone(),
                    metadata: incoming_meta,
                    stripe_intent_id,
                    check_number,
                    merchant_fee: fee,
                    net_amount: a - fee,
                    card_brand,
                    card_last4,
                });
            }
            if sum.round_dp(2) != amount_paid {
                return Err(CheckoutError::InvalidPayload(
                    "payment_splits must sum to amount_paid".to_string(),
                ));
            }
            if deposit_sum > amount_paid {
                return Err(CheckoutError::InvalidPayload(
                    "sum(applied_deposit_amount) cannot exceed amount_paid".to_string(),
                ));
            }

            let label = if out.len() == 1 {
                out[0].method.clone()
            } else {
                out.iter()
                    .map(|s| format!("{} ${}", s.method, s.amount))
                    .collect::<Vec<_>>()
                    .join(" + ")
            };
            return Ok((out, label));
        }
    }

    let m = payload.payment_method.trim();
    if m.is_empty() || m.len() > 50 {
        return Err(CheckoutError::InvalidPayload(
            "payment_method is required (max 50 characters)".to_string(),
        ));
    }
    Ok((
        vec![ResolvedPaymentSplit {
            method: m.to_string(),
            amount: amount_paid,
            gift_card_code: None,
            metadata: json!({}),
            stripe_intent_id: None,
            check_number: None,
            merchant_fee: Decimal::ZERO,
            net_amount: amount_paid,
            card_brand: None,
            card_last4: None,
        }],
        m.to_string(),
    ))
}
