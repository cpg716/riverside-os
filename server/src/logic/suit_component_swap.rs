//! Per-order suit / component variant swap: line cost & retail, optional floor stock in/out.

use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::logic::sales_commission;
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd};
use crate::logic::transaction_recalc;
use crate::logic::transaction_returns;
use crate::models::{DbFulfillmentType, DbOrderStatus};
use crate::services::inventory::{self, InventoryError};

#[derive(Debug, thiserror::Error)]
pub enum SuitSwapError {
    #[error("order or line not found")]
    NotFound,
    #[error("{0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Inventory(#[from] InventoryError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct SuitSwapInput {
    pub in_variant_id: Uuid,
    pub note: Option<String>,
    pub unit_price: Option<Decimal>,
    pub unit_cost: Option<Decimal>,
}

#[derive(Debug, Serialize)]
pub struct SuitSwapOutcome {
    pub event_id: Uuid,
    pub old_sku: String,
    pub new_sku: String,
    pub inventory_adjusted: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct SwapLineRow {
    order_status: DbOrderStatus,
    is_employee_purchase: bool,
    product_id: Uuid,
    variant_id: Uuid,
    fulfillment: DbFulfillmentType,
    quantity: i32,
    is_fulfilled: bool,
    unit_price: Decimal,
    unit_cost: Decimal,
    salesperson_id: Option<Uuid>,
    old_sku: String,
}

pub async fn execute_suit_component_swap(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    transaction_line_id: Uuid,
    staff_id: Option<Uuid>,
    global_employee_markup: Decimal,
    body: SuitSwapInput,
) -> Result<SuitSwapOutcome, SuitSwapError> {
    if body.in_variant_id.is_nil() {
        return Err(SuitSwapError::InvalidPayload(
            "in_variant_id required".to_string(),
        ));
    }

    let row: Option<SwapLineRow> = sqlx::query_as(
        r#"
        SELECT
            o.status AS order_status,
            COALESCE(o.is_employee_purchase, false) AS is_employee_purchase,
            oi.product_id,
            oi.variant_id,
            oi.fulfillment,
            oi.quantity,
            oi.is_fulfilled,
            oi.unit_price,
            oi.unit_cost,
            oi.salesperson_id,
            pv.sku AS old_sku
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        WHERE oi.transaction_id = $1 AND oi.id = $2
        FOR UPDATE OF oi, o
        "#,
    )
    .bind(transaction_id)
    .bind(transaction_line_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some(ctx) = row else {
        return Err(SuitSwapError::NotFound);
    };

    if ctx.order_status == DbOrderStatus::Cancelled {
        return Err(SuitSwapError::InvalidPayload(
            "cannot swap lines on a cancelled order".to_string(),
        ));
    }

    if ctx.variant_id == body.in_variant_id {
        return Err(SuitSwapError::InvalidPayload(
            "new variant must differ from the current line variant".to_string(),
        ));
    }

    let returned = transaction_returns::returned_qty_for_item(tx, transaction_line_id).await?;
    let eff_qty = ctx.quantity.saturating_sub(returned);
    if eff_qty <= 0 {
        return Err(SuitSwapError::InvalidPayload(
            "line has no remaining quantity to swap (fully returned)".to_string(),
        ));
    }

    let new_resolved =
        inventory::resolve_variant_by_id(&mut **tx, body.in_variant_id, global_employee_markup)
            .await?;

    let new_unit_cost = body.unit_cost.unwrap_or(new_resolved.unit_cost).round_dp(2);
    let base_retail = if ctx.is_employee_purchase {
        new_resolved.employee_price
    } else {
        new_resolved.standard_retail_price
    };
    let new_unit_price = body.unit_price.unwrap_or(base_retail).round_dp(2);

    let state_tax = nys_state_tax_usd(new_resolved.tax_category, new_unit_price, new_unit_price);
    let local_tax = erie_local_tax_usd(new_resolved.tax_category, new_unit_price, new_unit_price);

    let mut inventory_adjusted = false;
    let takeaway = ctx.fulfillment == DbFulfillmentType::Takeaway;

    if takeaway && !ctx.is_fulfilled && new_resolved.available_stock < eff_qty {
        return Err(SuitSwapError::InvalidPayload(format!(
            "insufficient available stock for {} (need {}, have {})",
            new_resolved.sku, eff_qty, new_resolved.available_stock
        )));
    }

    let special_like = matches!(
        ctx.fulfillment,
        DbFulfillmentType::SpecialOrder
            | DbFulfillmentType::WeddingOrder
            | DbFulfillmentType::Custom
    );

    if takeaway && ctx.is_fulfilled {
        let old_ok = sqlx::query(
            r#"
            UPDATE product_variants
            SET stock_on_hand = stock_on_hand + $1
            WHERE id = $2
            "#,
        )
        .bind(eff_qty)
        .bind(ctx.variant_id)
        .execute(&mut **tx)
        .await?
        .rows_affected();
        if old_ok == 0 {
            return Err(SuitSwapError::InvalidPayload(
                "old variant not found for stock restore".to_string(),
            ));
        }

        let new_affected = sqlx::query(
            r#"
            UPDATE product_variants
            SET stock_on_hand = stock_on_hand - $1
            WHERE id = $2 AND stock_on_hand >= $1
            "#,
        )
        .bind(eff_qty)
        .bind(body.in_variant_id)
        .execute(&mut **tx)
        .await?
        .rows_affected();
        if new_affected == 0 {
            return Err(SuitSwapError::InvalidPayload(format!(
                "insufficient stock_on_hand to pull {} for swap (SKU {})",
                eff_qty, new_resolved.sku
            )));
        }

        let note_out = format!("Suit/component swap: return to stock from order {transaction_id}");
        let note_in = format!("Suit/component swap: issue from stock for order {transaction_id}");

        sqlx::query(
            r#"
            INSERT INTO inventory_transactions
                (variant_id, tx_type, quantity_delta, unit_cost, reference_table, reference_id, notes)
            VALUES ($1, 'adjustment', $2, $3, 'suit_component_swap', $4, $5)
            "#,
        )
        .bind(ctx.variant_id)
        .bind(eff_qty)
        .bind(ctx.unit_cost)
        .bind(transaction_id)
        .bind(&note_out)
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO inventory_transactions
                (variant_id, tx_type, quantity_delta, unit_cost, reference_table, reference_id, notes)
            VALUES ($1, 'adjustment', $2, $3, 'suit_component_swap', $4, $5)
            "#,
        )
        .bind(body.in_variant_id)
        .bind(-eff_qty)
        .bind(new_unit_cost)
        .bind(transaction_id)
        .bind(&note_in)
        .execute(&mut **tx)
        .await?;

        inventory_adjusted = true;
    } else if special_like && ctx.is_fulfilled {
        // Undo pickup-style movement for the old SKU, apply it to the new (see `mark_order_pickup`).
        let old_ok = sqlx::query(
            r#"
            UPDATE product_variants
            SET
                stock_on_hand = stock_on_hand + $1,
                reserved_stock = reserved_stock + $1
            WHERE id = $2
            "#,
        )
        .bind(eff_qty)
        .bind(ctx.variant_id)
        .execute(&mut **tx)
        .await?
        .rows_affected();
        if old_ok == 0 {
            return Err(SuitSwapError::InvalidPayload(
                "old variant not found for special-order stock restore".to_string(),
            ));
        }

        let new_affected = sqlx::query(
            r#"
            UPDATE product_variants
            SET
                stock_on_hand = GREATEST(stock_on_hand - $1, 0),
                reserved_stock = GREATEST(reserved_stock - $1, 0)
            WHERE id = $2
              AND stock_on_hand >= $1
              AND reserved_stock >= $1
            "#,
        )
        .bind(eff_qty)
        .bind(body.in_variant_id)
        .execute(&mut **tx)
        .await?
        .rows_affected();
        if new_affected == 0 {
            return Err(SuitSwapError::InvalidPayload(format!(
                "insufficient stock_on_hand + reserved_stock for {} (need {} each for special-order swap)",
                new_resolved.sku, eff_qty
            )));
        }

        let note_out = format!(
            "Suit/component swap (special/wedding fulfilled): restore old variant order {transaction_id}"
        );
        let note_in = format!(
            "Suit/component swap (special/wedding fulfilled): pull new variant order {transaction_id}"
        );

        sqlx::query(
            r#"
            INSERT INTO inventory_transactions
                (variant_id, tx_type, quantity_delta, unit_cost, reference_table, reference_id, notes)
            VALUES ($1, 'adjustment', $2, $3, 'suit_component_swap', $4, $5)
            "#,
        )
        .bind(ctx.variant_id)
        .bind(eff_qty)
        .bind(ctx.unit_cost)
        .bind(transaction_id)
        .bind(&note_out)
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO inventory_transactions
                (variant_id, tx_type, quantity_delta, unit_cost, reference_table, reference_id, notes)
            VALUES ($1, 'adjustment', $2, $3, 'suit_component_swap', $4, $5)
            "#,
        )
        .bind(body.in_variant_id)
        .bind(-eff_qty)
        .bind(new_unit_cost)
        .bind(transaction_id)
        .bind(&note_in)
        .execute(&mut **tx)
        .await?;

        inventory_adjusted = true;
    }

    sqlx::query("DELETE FROM discount_event_usage WHERE transaction_line_id = $1")
        .bind(transaction_line_id)
        .execute(&mut **tx)
        .await?;

    let commission = sales_commission::commission_for_line(
        tx,
        sales_commission::CommissionLineInput {
            unit_price: new_unit_price,
            quantity: ctx.quantity,
            salesperson_id: ctx.salesperson_id,
            product_id: new_resolved.product_id,
            variant_id: body.in_variant_id,
            is_employee_sale: ctx.is_employee_purchase,
        },
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE transaction_lines
        SET
            product_id = $1,
            variant_id = $2,
            unit_price = $3,
            unit_cost = $4,
            state_tax = $5,
            local_tax = $6,
            applied_spiff = $7,
            calculated_commission = $8
        WHERE id = $9 AND transaction_id = $10
        "#,
    )
    .bind(new_resolved.product_id)
    .bind(body.in_variant_id)
    .bind(new_unit_price)
    .bind(new_unit_cost)
    .bind(state_tax)
    .bind(local_tax)
    .bind(new_resolved.spiff_amount)
    .bind(commission)
    .bind(transaction_line_id)
    .bind(transaction_id)
    .execute(&mut **tx)
    .await?;

    let note_trim = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let event_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO suit_component_swap_events (
            transaction_id, transaction_line_id, staff_id,
            old_variant_id, new_variant_id, old_product_id, new_product_id,
            effective_quantity,
            old_unit_cost, new_unit_cost, old_unit_price, new_unit_price,
            inventory_adjusted, note
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id
        "#,
    )
    .bind(transaction_id)
    .bind(transaction_line_id)
    .bind(staff_id) // NULL when register session swap
    .bind(ctx.variant_id)
    .bind(body.in_variant_id)
    .bind(ctx.product_id)
    .bind(new_resolved.product_id)
    .bind(eff_qty)
    .bind(ctx.unit_cost)
    .bind(new_unit_cost)
    .bind(ctx.unit_price)
    .bind(new_unit_price)
    .bind(inventory_adjusted)
    .bind(note_trim)
    .fetch_one(&mut **tx)
    .await?;

    transaction_recalc::recalc_transaction_totals(tx, transaction_id).await?;

    Ok(SuitSwapOutcome {
        event_id,
        old_sku: ctx.old_sku,
        new_sku: new_resolved.sku,
        inventory_adjusted,
    })
}
