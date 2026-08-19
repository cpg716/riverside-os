use std::collections::HashSet;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::models::{DbFulfillmentType, DbOrderItemLifecycleStatus, DbOrderStatus};

use super::transaction_returns::{self, ReturnLineInput};

const MAX_CANCELLATION_LINES: usize = 100;

#[derive(Debug, Clone, Deserialize)]
pub struct OrderLineCancellationLineInput {
    pub transaction_line_id: Uuid,
    pub quantity: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderLineCancellationLinePreview {
    pub transaction_line_id: Uuid,
    pub product_name: String,
    pub sku: String,
    pub quantity: i32,
    pub subtotal_credit: Decimal,
    pub state_tax_credit: Decimal,
    pub local_tax_credit: Decimal,
    pub total_credit: Decimal,
    pub inventory_disposition: String,
    #[serde(skip_serializing)]
    variant_id: Uuid,
    #[serde(skip_serializing)]
    inventory_bucket: CancellationInventoryBucket,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum CancellationInventoryBucket {
    None,
    ReservedStock,
    Layaway,
}

fn cancellation_inventory_bucket(
    fulfillment: DbFulfillmentType,
    lifecycle: DbOrderItemLifecycleStatus,
    has_received_at: bool,
) -> CancellationInventoryBucket {
    if fulfillment == DbFulfillmentType::Layaway {
        CancellationInventoryBucket::Layaway
    } else if fulfillment == DbFulfillmentType::PickupLater {
        CancellationInventoryBucket::ReservedStock
    } else if matches!(
        fulfillment,
        DbFulfillmentType::SpecialOrder
            | DbFulfillmentType::Custom
            | DbFulfillmentType::WeddingOrder
    ) && (has_received_at
        || matches!(
            lifecycle,
            DbOrderItemLifecycleStatus::Received | DbOrderItemLifecycleStatus::ReadyForPickup
        ))
    {
        CancellationInventoryBucket::ReservedStock
    } else {
        CancellationInventoryBucket::None
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderLineCancellationPreview {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
    pub original_total: Decimal,
    pub amount_paid: Decimal,
    pub original_balance_due: Decimal,
    pub cancellation_subtotal: Decimal,
    pub cancellation_state_tax: Decimal,
    pub cancellation_local_tax: Decimal,
    pub cancellation_total: Decimal,
    pub credit_applied_to_balance: Decimal,
    pub revised_total: Decimal,
    pub balance_due_after: Decimal,
    pub refund_due: Decimal,
    pub lines: Vec<OrderLineCancellationLinePreview>,
}

#[derive(Debug, thiserror::Error)]
pub enum OrderLineCancellationError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
    #[error("transaction not found")]
    NotFound,
}

type HeaderRow = (
    String,
    DbOrderStatus,
    Decimal,
    Decimal,
    Decimal,
    Option<Uuid>,
);

type LineRow = (
    Uuid,
    Uuid,
    i32,
    i32,
    DbFulfillmentType,
    DbOrderItemLifecycleStatus,
    bool,
    bool,
    Option<Uuid>,
    Option<Uuid>,
    Option<chrono::DateTime<chrono::Utc>>,
    String,
    String,
    Decimal,
    Decimal,
    Decimal,
);

fn financial_effect(
    original_total: Decimal,
    balance_due: Decimal,
    cancellation_total: Decimal,
) -> (Decimal, Decimal, Decimal, Decimal) {
    let projected_balance = (balance_due - cancellation_total).round_dp(2);
    let balance_due_after = projected_balance.max(Decimal::ZERO);
    let refund_due = (-projected_balance).max(Decimal::ZERO);
    let credit_applied_to_balance = cancellation_total.min(balance_due.max(Decimal::ZERO));
    let revised_total = (original_total - cancellation_total)
        .max(Decimal::ZERO)
        .round_dp(2);
    (
        credit_applied_to_balance,
        revised_total,
        balance_due_after,
        refund_due,
    )
}

pub async fn preview_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    requested: &[OrderLineCancellationLineInput],
) -> Result<OrderLineCancellationPreview, OrderLineCancellationError> {
    if requested.is_empty() {
        return Err(OrderLineCancellationError::BadRequest(
            "Select at least one open Order item to cancel.".to_string(),
        ));
    }
    if requested.len() > MAX_CANCELLATION_LINES {
        return Err(OrderLineCancellationError::BadRequest(format!(
            "Order item cancellation is limited to {MAX_CANCELLATION_LINES} lines at a time."
        )));
    }
    if requested
        .iter()
        .map(|line| line.transaction_line_id)
        .collect::<HashSet<_>>()
        .len()
        != requested.len()
    {
        return Err(OrderLineCancellationError::BadRequest(
            "Each Order item can be selected only once.".to_string(),
        ));
    }
    if requested.iter().any(|line| line.quantity <= 0) {
        return Err(OrderLineCancellationError::BadRequest(
            "Cancellation quantities must be positive.".to_string(),
        ));
    }

    let header: Option<HeaderRow> = sqlx::query_as(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM(display_id), ''), id::text),
            status,
            COALESCE(total_price, 0)::numeric(14,2),
            COALESCE(amount_paid, 0)::numeric(14,2),
            COALESCE(balance_due, 0)::numeric(14,2),
            customer_id
        FROM transactions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((display_id, status, total, amount_paid, balance_due, _customer_id)) = header else {
        return Err(OrderLineCancellationError::NotFound);
    };
    if !matches!(
        status,
        DbOrderStatus::Open | DbOrderStatus::PendingMeasurement
    ) {
        return Err(OrderLineCancellationError::BadRequest(
            "Only open Order Transactions can have individual items cancelled.".to_string(),
        ));
    }

    let requested_ids = requested
        .iter()
        .map(|line| line.transaction_line_id)
        .collect::<Vec<_>>();
    let rows: Vec<LineRow> = sqlx::query_as(
        r#"
        SELECT
            line.id,
            line.variant_id,
            line.quantity,
            COALESCE((
                SELECT SUM(returned.quantity_returned)::int
                FROM transaction_return_lines returned
                WHERE returned.transaction_line_id = line.id
            ), 0) AS quantity_removed,
            line.fulfillment,
            line.order_lifecycle_status,
            line.is_fulfilled,
            COALESCE(line.is_internal, FALSE),
            line.po_line_id,
            line.vendor_id,
            line.received_at,
            product.name,
            variant.sku,
            COALESCE(line.unit_price, 0)::numeric(14,2),
            COALESCE(line.state_tax, 0)::numeric(14,2),
            COALESCE(line.local_tax, 0)::numeric(14,2)
        FROM transaction_lines line
        INNER JOIN products product ON product.id = line.product_id
        INNER JOIN product_variants variant ON variant.id = line.variant_id
        WHERE line.transaction_id = $1
          AND line.id = ANY($2)
        FOR UPDATE OF line
        "#,
    )
    .bind(transaction_id)
    .bind(&requested_ids)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() != requested.len() {
        return Err(OrderLineCancellationError::BadRequest(
            "One or more selected Order items are no longer available. Refresh and try again."
                .to_string(),
        ));
    }

    let requested_by_id = requested
        .iter()
        .map(|line| (line.transaction_line_id, line.quantity))
        .collect::<std::collections::HashMap<_, _>>();
    let mut line_previews = Vec::with_capacity(rows.len());
    let mut cancellation_subtotal = Decimal::ZERO;
    let mut cancellation_state_tax = Decimal::ZERO;
    let mut cancellation_local_tax = Decimal::ZERO;

    for (
        line_id,
        variant_id,
        sold_quantity,
        removed_quantity,
        fulfillment,
        lifecycle,
        is_fulfilled,
        is_internal,
        po_line_id,
        vendor_id,
        received_at,
        product_name,
        sku,
        unit_price,
        state_tax,
        local_tax,
    ) in rows
    {
        let requested_quantity = requested_by_id[&line_id];
        let remaining_quantity = sold_quantity - removed_quantity;
        if requested_quantity > remaining_quantity {
            return Err(OrderLineCancellationError::BadRequest(format!(
                "Only {remaining_quantity} unit(s) of {product_name} remain open. Refresh and try again."
            )));
        }
        if is_internal || is_fulfilled || fulfillment == DbFulfillmentType::Takeaway {
            return Err(OrderLineCancellationError::BadRequest(format!(
                "{product_name} is not an open deferred Order item. Use Return / Exchange for merchandise already given to the customer."
            )));
        }
        if lifecycle == DbOrderItemLifecycleStatus::PickedUp {
            return Err(OrderLineCancellationError::BadRequest(format!(
                "{product_name} is already marked Picked Up. Use Return / Exchange instead."
            )));
        }
        let inventory_bucket =
            cancellation_inventory_bucket(fulfillment, lifecycle, received_at.is_some());
        let inventory_disposition = match inventory_bucket {
            CancellationInventoryBucket::ReservedStock => {
                if fulfillment == DbFulfillmentType::PickupLater {
                    "Held item stays on hand and its customer reservation is released.".to_string()
                } else {
                    "Received item stays on hand and its customer reservation is released."
                        .to_string()
                }
            }
            CancellationInventoryBucket::Layaway => {
                "Layaway hold is released and the item returns to available stock.".to_string()
            }
            CancellationInventoryBucket::None if po_line_id.is_some() || vendor_id.is_some() => {
                "Customer commitment is cancelled; the existing vendor/PO commitment remains for receiving follow-up."
                    .to_string()
            }
            CancellationInventoryBucket::None => {
                "No received inventory or customer stock reservation changes.".to_string()
            }
        };

        let quantity = Decimal::from(requested_quantity);
        let subtotal = (unit_price * quantity).round_dp(2);
        let state = (state_tax * quantity).round_dp(2);
        let local = (local_tax * quantity).round_dp(2);
        let total_credit = (subtotal + state + local).round_dp(2);
        cancellation_subtotal += subtotal;
        cancellation_state_tax += state;
        cancellation_local_tax += local;
        line_previews.push(OrderLineCancellationLinePreview {
            transaction_line_id: line_id,
            product_name,
            sku,
            quantity: requested_quantity,
            subtotal_credit: subtotal,
            state_tax_credit: state,
            local_tax_credit: local,
            total_credit,
            inventory_disposition,
            variant_id,
            inventory_bucket,
        });
    }

    cancellation_subtotal = cancellation_subtotal.round_dp(2);
    cancellation_state_tax = cancellation_state_tax.round_dp(2);
    cancellation_local_tax = cancellation_local_tax.round_dp(2);
    let cancellation_total =
        (cancellation_subtotal + cancellation_state_tax + cancellation_local_tax).round_dp(2);
    let (credit_applied_to_balance, revised_total, balance_due_after, refund_due) =
        financial_effect(total, balance_due, cancellation_total);

    Ok(OrderLineCancellationPreview {
        transaction_id,
        transaction_display_id: display_id,
        original_total: total,
        amount_paid,
        original_balance_due: balance_due,
        cancellation_subtotal,
        cancellation_state_tax,
        cancellation_local_tax,
        cancellation_total,
        credit_applied_to_balance,
        revised_total,
        balance_due_after,
        refund_due,
        lines: line_previews,
    })
}

pub async fn apply_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    staff_id: Uuid,
    requested: &[OrderLineCancellationLineInput],
    reason: &str,
) -> Result<OrderLineCancellationPreview, OrderLineCancellationError> {
    let reason = reason.trim();
    if reason.len() < 12 {
        return Err(OrderLineCancellationError::BadRequest(
            "Enter a specific cancellation reason of at least 12 characters.".to_string(),
        ));
    }
    let preview = preview_in_tx(tx, transaction_id, requested).await?;
    let event_id = Uuid::new_v4();
    let return_lines = preview
        .lines
        .iter()
        .map(|line| ReturnLineInput {
            transaction_line_id: line.transaction_line_id,
            quantity: line.quantity,
            reason: Some(format!("Order item cancellation: {reason}")),
            restock: Some(false),
            refund_event_id: event_id,
            register_session_id: None,
            refund_subtotal: Some(line.subtotal_credit),
            refund_state_tax: Some(line.state_tax_credit),
            refund_local_tax: Some(line.local_tax_credit),
            refund_total: Some(line.total_credit),
        })
        .collect();

    transaction_returns::apply_order_line_cancellations_in_tx(
        tx,
        transaction_id,
        Some(staff_id),
        return_lines,
    )
    .await
    .map_err(|error| match error {
        transaction_returns::TransactionReturnError::Db(database) => {
            OrderLineCancellationError::Db(database)
        }
        transaction_returns::TransactionReturnError::BadRequest(message) => {
            OrderLineCancellationError::BadRequest(message)
        }
    })?;

    let mut inventory_releases = Vec::with_capacity(preview.lines.len());
    for line in &preview.lines {
        let (bucket, released_quantity) = match line.inventory_bucket {
            CancellationInventoryBucket::None => ("none", 0),
            CancellationInventoryBucket::ReservedStock => {
                let current: i32 = sqlx::query_scalar(
                    "SELECT reserved_stock FROM product_variants WHERE id = $1 FOR UPDATE",
                )
                .bind(line.variant_id)
                .fetch_one(&mut **tx)
                .await?;
                let released = current.max(0).min(line.quantity);
                if released > 0 {
                    sqlx::query(
                        "UPDATE product_variants SET reserved_stock = reserved_stock - $1 WHERE id = $2",
                    )
                    .bind(released)
                    .bind(line.variant_id)
                    .execute(&mut **tx)
                    .await?;
                }
                ("reserved_stock", released)
            }
            CancellationInventoryBucket::Layaway => {
                let current: i32 = sqlx::query_scalar(
                    "SELECT on_layaway FROM product_variants WHERE id = $1 FOR UPDATE",
                )
                .bind(line.variant_id)
                .fetch_one(&mut **tx)
                .await?;
                let released = current.max(0).min(line.quantity);
                if released > 0 {
                    sqlx::query(
                        "UPDATE product_variants SET on_layaway = on_layaway - $1 WHERE id = $2",
                    )
                    .bind(released)
                    .bind(line.variant_id)
                    .execute(&mut **tx)
                    .await?;
                }
                ("on_layaway", released)
            }
        };
        inventory_releases.push(json!({
            "transaction_line_id": line.transaction_line_id,
            "variant_id": line.variant_id,
            "bucket": bucket,
            "quantity_released": released_quantity,
            "disposition": line.inventory_disposition,
        }));
    }

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();
    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log
            (transaction_id, customer_id, event_kind, summary, metadata)
        VALUES ($1, $2, 'order_item_cancellation_summary', $3, $4)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(format!(
        "Cancelled {} Order item line(s); ${} applied to balance; ${} refund due",
        preview.lines.len(),
        preview.credit_applied_to_balance,
        preview.refund_due
    ))
    .bind(json!({
        "event_id": event_id,
        "reason": reason,
        "cancelled_line_count": preview.lines.len(),
        "cancellation_total": preview.cancellation_total,
        "credit_applied_to_balance": preview.credit_applied_to_balance,
        "revised_total": preview.revised_total,
        "balance_due_after": preview.balance_due_after,
        "refund_due": preview.refund_due,
        "cancelled_by_staff_id": staff_id,
        "inventory_releases": inventory_releases,
        "lines": preview.lines,
    }))
    .execute(&mut **tx)
    .await?;

    Ok(preview)
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    use super::{cancellation_inventory_bucket, financial_effect, CancellationInventoryBucket};
    use crate::models::{DbFulfillmentType, DbOrderItemLifecycleStatus};

    #[test]
    fn cancellation_credit_first_reduces_unpaid_balance() {
        let (applied, revised_total, balance_after, refund_due) =
            financial_effect(dec!(485.12), dec!(242.56), dec!(202.37));

        assert_eq!(applied, dec!(202.37));
        assert_eq!(revised_total, dec!(282.75));
        assert_eq!(balance_after, dec!(40.19));
        assert_eq!(refund_due, dec!(0));
    }

    #[test]
    fn only_overpayment_becomes_refundable() {
        let (applied, revised_total, balance_after, refund_due) =
            financial_effect(dec!(140.00), dec!(40.00), dec!(100.00));

        assert_eq!(applied, dec!(40.00));
        assert_eq!(revised_total, dec!(40.00));
        assert_eq!(balance_after, dec!(0));
        assert_eq!(refund_due, dec!(60.00));
    }

    #[test]
    fn ready_order_releases_reserved_stock_without_removing_on_hand() {
        assert_eq!(
            cancellation_inventory_bucket(
                DbFulfillmentType::SpecialOrder,
                DbOrderItemLifecycleStatus::ReadyForPickup,
                true,
            ),
            CancellationInventoryBucket::ReservedStock,
        );
        assert_eq!(
            cancellation_inventory_bucket(
                DbFulfillmentType::Layaway,
                DbOrderItemLifecycleStatus::Ntbo,
                false,
            ),
            CancellationInventoryBucket::Layaway,
        );
    }

    #[test]
    fn pickup_later_always_releases_reserved_stock() {
        assert_eq!(
            cancellation_inventory_bucket(
                DbFulfillmentType::PickupLater,
                DbOrderItemLifecycleStatus::ReadyForPickup,
                false,
            ),
            CancellationInventoryBucket::ReservedStock
        );
    }
}
