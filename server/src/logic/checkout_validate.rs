//! Server-side checkout line validation (catalog prices, §3.3 tax on charged unit price).

use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use uuid::Uuid;

use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd};
use crate::services::inventory;

/// Public tolerance for comparing catalog vs charged unit prices (checkout, discount events).
pub const CHECKOUT_MONEY_TOLERANCE: Decimal = dec!(0.02);

#[derive(Debug, Clone)]
pub struct CheckoutLineSnapshot {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub unit_cost: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    pub has_price_override: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum CheckoutValidateError {
    #[error(transparent)]
    Inventory(#[from] inventory::InventoryError),
    #[error("{0}")]
    Invalid(String),
}

/// Compares two decimals using the global CHECKOUT_MONEY_TOLERANCE.
#[inline]
fn money_close(a: Decimal, b: Decimal) -> bool {
    (a - b).abs() <= CHECKOUT_MONEY_TOLERANCE
}

/// Exposed for order checkout (discount events, etc.).
#[inline]
pub fn money_close_decimal(a: Decimal, b: Decimal) -> bool {
    (a - b).abs() <= CHECKOUT_MONEY_TOLERANCE
}

/// Returns the sum of (unit_price + state_tax + local_tax) * qty for all lines.
pub async fn validate_checkout_lines_and_sum(
    pool: &sqlx::PgPool,
    global_employee_markup: Decimal,
    lines: &[CheckoutLineSnapshot],
    is_tax_exempt: bool,
) -> Result<Decimal, CheckoutValidateError> {
    let mut sum = Decimal::ZERO;
    for line in lines {
        let resolved =
            inventory::resolve_variant_by_id(pool, line.variant_id, global_employee_markup).await?;

        let is_rms_payment = resolved.pos_line_kind.as_deref() == Some("rms_charge_payment");
        let is_pos_gc_load = resolved.pos_line_kind.as_deref() == Some("pos_gift_card_load");

        if is_rms_payment {
            if line.quantity != 1 {
                return Err(CheckoutValidateError::Invalid(
                    "RMS CHARGE PAYMENT lines must have quantity 1".to_string(),
                ));
            }
            if !line.state_tax.is_zero() || !line.local_tax.is_zero() {
                return Err(CheckoutValidateError::Invalid(
                    "RMS CHARGE PAYMENT lines must have zero tax".to_string(),
                ));
            }
        } else if is_pos_gc_load {
            if line.quantity != 1 {
                return Err(CheckoutValidateError::Invalid(
                    "POS GIFT CARD LOAD lines must have quantity 1".to_string(),
                ));
            }
            if line.unit_price <= Decimal::ZERO {
                return Err(CheckoutValidateError::Invalid(
                    "POS GIFT CARD LOAD requires an amount greater than zero".to_string(),
                ));
            }
            if !line.state_tax.is_zero() || !line.local_tax.is_zero() {
                return Err(CheckoutValidateError::Invalid(
                    "POS GIFT CARD LOAD lines must have zero tax".to_string(),
                ));
            }
        } else if !line.has_price_override {
            let ok_retail = money_close(line.unit_price, resolved.standard_retail_price);
            let ok_emp = money_close(line.unit_price, resolved.employee_price);
            if !ok_retail && !ok_emp {
                return Err(CheckoutValidateError::Invalid(format!(
                    "Unit price for variant {} does not match catalog retail or employee price",
                    line.variant_id
                )));
            }
            if !money_close(line.unit_cost, resolved.unit_cost) {
                return Err(CheckoutValidateError::Invalid(format!(
                    "Unit cost for variant {} does not match catalog",
                    line.variant_id
                )));
            }

            let exp_state = if is_tax_exempt {
                Decimal::ZERO
            } else {
                nys_state_tax_usd(resolved.tax_category, line.unit_price, line.unit_price)
            };
            let exp_local = if is_tax_exempt {
                Decimal::ZERO
            } else {
                erie_local_tax_usd(resolved.tax_category, line.unit_price, line.unit_price)
            };

            // Use money_close for all monetary comparisons to avoid precision issues
            if !money_close(line.state_tax, exp_state) || !money_close(line.local_tax, exp_local) {
                tracing::error!(
                    variant_id = %line.variant_id,
                    sku = %resolved.sku,
                    provided_state = %line.state_tax,
                    expected_state = %exp_state,
                    provided_local = %line.local_tax,
                    expected_local = %exp_local,
                    unit_price = %line.unit_price,
                    tax_category = ?resolved.tax_category,
                    is_tax_exempt = %is_tax_exempt,
                    "Tax parity mismatch in checkout"
                );
                return Err(CheckoutValidateError::Invalid(format!(
                    "Tax per unit for variant {} ({}) does not match server calculation (Exp: S:{} L:{} vs Got: S:{} L:{})",
                    line.variant_id,
                    resolved.sku,
                    exp_state,
                    exp_local,
                    line.state_tax,
                    line.local_tax
                )));
            }
        } else {
            let exp_state = if is_tax_exempt {
                Decimal::ZERO
            } else {
                nys_state_tax_usd(resolved.tax_category, line.unit_price, line.unit_price)
            };
            let exp_local = if is_tax_exempt {
                Decimal::ZERO
            } else {
                erie_local_tax_usd(resolved.tax_category, line.unit_price, line.unit_price)
            };

            if !money_close(line.state_tax, exp_state) || !money_close(line.local_tax, exp_local) {
                tracing::error!(
                    variant_id = %line.variant_id,
                    sku = %resolved.sku,
                    provided_state = %line.state_tax,
                    expected_state = %exp_state,
                    provided_local = %line.local_tax,
                    expected_local = %exp_local,
                    unit_price = %line.unit_price,
                    tax_category = ?resolved.tax_category,
                    is_tax_exempt = %is_tax_exempt,
                    "Tax parity mismatch in checkout (price override fail)"
                );
                return Err(CheckoutValidateError::Invalid(format!(
                    "Tax per unit for variant {} ({}) does not match server calculation (Exp: S:{} L:{} vs Got: S:{} L:{})",
                    line.variant_id,
                    resolved.sku,
                    exp_state,
                    exp_local,
                    line.state_tax,
                    line.local_tax
                )));
            }
        }

        sum += (line.unit_price + line.state_tax + line.local_tax) * Decimal::from(line.quantity);
    }
    Ok(sum)
}
