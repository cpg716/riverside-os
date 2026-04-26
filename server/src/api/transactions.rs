//! Checkout: persist cart → `transactions` + `transaction_lines` in one transaction.

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Error as SqlxError, FromRow};
use std::ops::DerefMut;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, ORDERS_CANCEL, ORDERS_EDIT_ATTRIBUTION,
    ORDERS_MODIFY, ORDERS_REFUND_PROCESS, ORDERS_SUIT_COMPONENT_SWAP, ORDERS_VIEW,
    ORDERS_VOID_SALE,
};
use crate::auth::pins::{self, log_staff_access};
use crate::auth::pos_session;
use crate::logic::gift_card_ops;
use crate::logic::loyalty as loyalty_logic;
use crate::logic::podium::{self, looks_like_email};
use crate::logic::podium_reviews;
use crate::logic::pos_rms_charge;
use crate::logic::receipt_plain_text;
use crate::logic::receipt_studio_html;
use crate::logic::receipt_zpl;
use crate::logic::suit_component_swap::{self, SuitSwapInput, SuitSwapOutcome};
use crate::logic::transaction_recalc;
use crate::logic::transaction_returns::{self, ReturnLineInput};
use crate::middleware;
use crate::models::{
    DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus, DbTransactionCategory,
};

pub(crate) async fn rosie_order_summary(
    state: &AppState,
    headers: &HeaderMap,
    transaction_id: Uuid,
    register_session_id: Option<Uuid>,
) -> Result<serde_json::Value, Response> {
    let Json(detail) = get_transaction_detail(
        State(state.clone()),
        Path(transaction_id),
        Query(TransactionReadQuery {
            register_session_id,
        }),
        headers.clone(),
    )
    .await
    .map_err(IntoResponse::into_response)?;

    serde_json::to_value(detail).map_err(|error| {
        tracing::error!(error = %error, %transaction_id, "serialize ROSIE order summary");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to serialize order summary" })),
        )
            .into_response()
    })
}

#[derive(Debug, Error)]
pub enum TransactionError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Order not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    BadGateway(String),
}

impl IntoResponse for TransactionError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            TransactionError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            TransactionError::NotFound => (StatusCode::NOT_FOUND, "Order not found".to_string()),
            TransactionError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            TransactionError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            TransactionError::BadGateway(m) => (StatusCode::BAD_GATEWAY, m),
            TransactionError::Database(e) => {
                if matches!(&e, SqlxError::RowNotFound) {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Order not found" })),
                    )
                        .into_response();
                }
                tracing::error!(error = %e, "Database error in transactions");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl From<crate::logic::transaction_checkout::CheckoutError> for TransactionError {
    fn from(e: crate::logic::transaction_checkout::CheckoutError) -> Self {
        match e {
            crate::logic::transaction_checkout::CheckoutError::InvalidPayload(m) => {
                TransactionError::InvalidPayload(m)
            }
            crate::logic::transaction_checkout::CheckoutError::Database(d) => {
                TransactionError::Database(d)
            }
            crate::logic::transaction_checkout::CheckoutError::CoreCardHostFailure(m) => {
                TransactionError::BadGateway(m)
            }
        }
    }
}

impl From<suit_component_swap::SuitSwapError> for TransactionError {
    fn from(e: suit_component_swap::SuitSwapError) -> Self {
        match e {
            suit_component_swap::SuitSwapError::NotFound => TransactionError::NotFound,
            suit_component_swap::SuitSwapError::InvalidPayload(m) => {
                TransactionError::InvalidPayload(m)
            }
            suit_component_swap::SuitSwapError::Inventory(i) => {
                TransactionError::InvalidPayload(i.to_string())
            }
            suit_component_swap::SuitSwapError::Database(d) => TransactionError::Database(d),
        }
    }
}

fn spawn_meilisearch_transaction_upsert(state: &AppState, transaction_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        tokio::spawn(async move {
            crate::logic::meilisearch_sync::upsert_transaction_document(&c, &pool, transaction_id)
                .await;
            crate::logic::meilisearch_sync::upsert_order_document(&c, &pool, transaction_id).await;
        });
    }
}

fn spawn_meilisearch_alteration_upserts(state: &AppState, alteration_ids: Vec<Uuid>) {
    let Some(client) = state.meilisearch.clone() else {
        return;
    };
    let pool = state.db.clone();
    tokio::spawn(async move {
        for alteration_id in alteration_ids {
            crate::logic::meilisearch_sync::upsert_alteration_document(
                &client,
                &pool,
                alteration_id,
            )
            .await;
        }
    });
}

pub use crate::logic::transaction_checkout::{
    CheckoutItem, CheckoutPaymentSplit, CheckoutRequest, CheckoutResponse, WeddingDisbursement,
};
pub use crate::logic::transaction_list::{
    PagedTransactionsResponse, TransactionListQuery, TransactionListResponse,
    TransactionPipelineStats,
};

#[derive(Debug, Serialize)]
pub struct OrderCustomerSummary {
    pub id: Uuid,
    pub first_name: String,
    pub last_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OrderWeddingSummary {
    pub wedding_party_id: Uuid,
    pub wedding_member_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_date: Option<chrono::NaiveDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_role: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TransactionDetailItem {
    pub transaction_line_id: Uuid,
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub variation_label: Option<String>,
    pub quantity: i32,
    /// Units recorded on `transaction_return_lines` for this line.
    pub quantity_returned: i32,
    pub unit_price: Decimal,
    pub unit_cost: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    pub fulfillment: DbFulfillmentType,
    /// Takeaway lines fulfilled at checkout; special transactions fulfill at pickup.
    pub is_fulfilled: bool,
    pub is_internal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_item_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_order_details: Option<serde_json::Value>,
    pub salesperson_id: Option<Uuid>,
    pub salesperson_name: Option<String>,
    /// From `transaction_lines.size_specs` when checkout stored a price override (receipt / audit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_original_unit_price: Option<Decimal>,
    /// Discount event receipt label from `size_specs`, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount_event_label: Option<String>,
    /// Masked or scanned code for POS purchased-card load lines when checkout stored it in `size_specs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gift_card_load_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TransactionDetailResponse {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub is_forfeited: bool,
    pub forfeited_at: Option<DateTime<Utc>>,
    pub forfeiture_reason: Option<String>,
    #[serde(default)]
    pub fulfillment_method: DbOrderFulfillmentMethod,
    #[serde(default)]
    pub ship_to: Option<serde_json::Value>,
    #[serde(default)]
    pub shipping_amount_usd: Option<Decimal>,
    #[serde(default)]
    pub shippo_shipment_object_id: Option<String>,
    #[serde(default)]
    pub shippo_transaction_object_id: Option<String>,
    #[serde(default)]
    pub tracking_number: Option<String>,
    #[serde(default)]
    pub tracking_url_provider: Option<String>,
    #[serde(default)]
    pub shipping_label_url: Option<String>,
    #[serde(default)]
    pub exchange_group_id: Option<Uuid>,
    pub payment_methods_summary: String,
    #[serde(default)]
    pub payment_applications: Vec<TransactionPaymentApplication>,
    pub operator_staff_id: Option<Uuid>,
    pub operator_name: Option<String>,
    pub primary_salesperson_id: Option<Uuid>,
    pub primary_salesperson_name: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wedding_summary: Option<OrderWeddingSummary>,
    pub customer: Option<OrderCustomerSummary>,
    pub financial_summary: TransactionFinancialSummary,
    pub items: Vec<TransactionDetailItem>,
    pub is_tax_exempt: bool,
    pub tax_exempt_reason: Option<String>,
    pub register_session_id: Option<Uuid>,
    /// Set from `store_settings.receipt_config`: exported HTML exists for Receipt Builder merge.
    #[serde(default)]
    pub receipt_studio_layout_available: bool,
    /// `zpl` (thermal ZPL) or `studio_html` (browser print of merged HTML).
    #[serde(default)]
    pub receipt_thermal_mode: String,
    /// From `store_settings.review_policy` (for receipt / POS review invite UX).
    #[serde(default)]
    pub store_review_invites_enabled: bool,
    #[serde(default)]
    pub store_send_review_invite_by_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_invite_sent_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_invite_suppressed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct TransactionFinancialSummary {
    pub total_allocated_payments: Decimal,
    pub total_applied_deposit_amount: Decimal,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransactionPaymentApplication {
    pub target_transaction_id: Uuid,
    pub target_display_id: String,
    pub amount: Decimal,
    pub remaining_balance: Decimal,
}

impl TransactionDetailResponse {
    fn selected_receipt_items_with_effective_qty<'a>(
        &'a self,
        transaction_line_ids: Option<&[Uuid]>,
    ) -> Result<Vec<(&'a TransactionDetailItem, i32)>, TransactionError> {
        use std::collections::HashSet;

        let selected: Vec<&TransactionDetailItem> = match transaction_line_ids {
            None => self.items.iter().filter(|it| !it.is_internal).collect(),
            Some(ids) => {
                if ids.is_empty() {
                    return Err(TransactionError::InvalidPayload(
                        "transaction_line_ids must list at least one line id.".to_string(),
                    ));
                }
                let set: HashSet<Uuid> = ids.iter().copied().collect();
                let v: Vec<_> = self
                    .items
                    .iter()
                    .filter(|it| !it.is_internal && set.contains(&it.transaction_line_id))
                    .collect();
                if v.is_empty() {
                    return Err(TransactionError::InvalidPayload(
                        "No order lines matched transaction_line_ids for this order.".to_string(),
                    ));
                }
                v
            }
        };

        let active: Vec<_> = selected
            .into_iter()
            .filter_map(|it| {
                let effective_qty = (it.quantity - it.quantity_returned).max(0);
                (effective_qty > 0).then_some((it, effective_qty))
            })
            .collect();

        if active.is_empty() {
            let allow_internal_only_receipt = transaction_line_ids.is_none()
                && self.items.iter().any(|it| it.is_internal)
                && self
                    .items
                    .iter()
                    .all(|it| it.is_internal || (it.quantity - it.quantity_returned).max(0) == 0);
            if allow_internal_only_receipt {
                return Ok(Vec::new());
            }
            return Err(TransactionError::InvalidPayload(
                "No active order lines remained after applied returns for this receipt."
                    .to_string(),
            ));
        }

        Ok(active)
    }

    /// Build customer-facing receipt data. When `transaction_line_ids` is `Some`, only those lines are
    /// included (must match at least one line or returns `InvalidPayload`).
    pub(crate) fn receipt_for_zpl_filtered(
        &self,
        transaction_line_ids: Option<&[Uuid]>,
    ) -> Result<receipt_zpl::ReceiptOrderForZpl, TransactionError> {
        let selected = self.selected_receipt_items_with_effective_qty(transaction_line_ids)?;

        Ok(receipt_zpl::ReceiptOrderForZpl {
            transaction_id: self.transaction_id,
            booked_at: self.booked_at,
            status: self.status,
            total_price: self.total_price,
            amount_paid: self.amount_paid,
            balance_due: self.balance_due,
            payment_methods_summary: self.payment_methods_summary.clone(),
            payment_applications: self
                .payment_applications
                .iter()
                .map(|app| receipt_zpl::ReceiptPaymentApplicationForZpl {
                    target_display_id: app.target_display_id.clone(),
                    amount: app.amount,
                    remaining_balance: app.remaining_balance,
                })
                .collect(),
            is_tax_exempt: self.is_tax_exempt,
            tax_exempt_reason: self.tax_exempt_reason.clone(),
            customer: self.customer.as_ref().map(|c| {
                let full = format!("{} {}", c.first_name, c.last_name);
                let masked = crate::logic::receipt_privacy::mask_name_for_receipt(Some(&full))
                    .unwrap_or_else(|| "—".to_string());
                receipt_zpl::ReceiptCustomerLine {
                    display_name: masked,
                }
            }),
            items: selected
                .into_iter()
                .map(|(it, effective_qty)| receipt_zpl::ReceiptLineForZpl {
                    product_name: it.product_name.clone(),
                    sku: it.sku.clone(),
                    quantity: effective_qty,
                    unit_price: it.unit_price,
                    fulfillment: it.fulfillment,
                    salesperson_name: crate::logic::receipt_privacy::mask_name_for_receipt(
                        it.salesperson_name.as_deref(),
                    ),
                    variation_label: it.variation_label.clone(),
                    original_unit_price: it.receipt_original_unit_price,
                    discount_event_label: it.discount_event_label.clone(),
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_transaction_detail(items: Vec<TransactionDetailItem>) -> TransactionDetailResponse {
        TransactionDetailResponse {
            transaction_id: Uuid::nil(),
            transaction_display_id: "TXN-TEST".to_string(),
            booked_at: Utc::now(),
            status: DbOrderStatus::Open,
            total_price: Decimal::new(1000, 2),
            amount_paid: Decimal::new(1000, 2),
            balance_due: Decimal::ZERO,
            is_forfeited: false,
            forfeited_at: None,
            forfeiture_reason: None,
            fulfillment_method: DbOrderFulfillmentMethod::Pickup,
            ship_to: None,
            shipping_amount_usd: None,
            shippo_shipment_object_id: None,
            shippo_transaction_object_id: None,
            tracking_number: None,
            tracking_url_provider: None,
            shipping_label_url: None,
            exchange_group_id: None,
            payment_methods_summary: "Card".to_string(),
            payment_applications: Vec::new(),
            operator_staff_id: None,
            operator_name: None,
            primary_salesperson_id: None,
            primary_salesperson_name: None,
            wedding_member_id: None,
            wedding_summary: None,
            customer: None,
            financial_summary: TransactionFinancialSummary {
                total_allocated_payments: Decimal::new(1000, 2),
                total_applied_deposit_amount: Decimal::ZERO,
            },
            items,
            is_tax_exempt: false,
            tax_exempt_reason: None,
            register_session_id: None,
            receipt_studio_layout_available: false,
            receipt_thermal_mode: "zpl".to_string(),
            store_review_invites_enabled: false,
            store_send_review_invite_by_default: false,
            review_invite_sent_at: None,
            review_invite_suppressed_at: None,
        }
    }

    fn sample_item(quantity: i32, quantity_returned: i32) -> TransactionDetailItem {
        TransactionDetailItem {
            transaction_line_id: Uuid::new_v4(),
            product_id: Uuid::new_v4(),
            variant_id: Uuid::new_v4(),
            sku: "SKU-1".to_string(),
            product_name: "Navy Suit".to_string(),
            variation_label: Some("42R".to_string()),
            quantity,
            quantity_returned,
            unit_price: Decimal::new(25000, 2),
            unit_cost: Decimal::new(10000, 2),
            state_tax: Decimal::new(1000, 2),
            local_tax: Decimal::new(500, 2),
            fulfillment: DbFulfillmentType::Takeaway,
            is_fulfilled: true,
            is_internal: false,
            custom_item_type: None,
            custom_order_details: None,
            salesperson_id: None,
            salesperson_name: Some("Taylor Manager".to_string()),
            receipt_original_unit_price: None,
            discount_event_label: None,
            gift_card_load_code: None,
        }
    }

    fn sample_internal_item() -> TransactionDetailItem {
        let mut item = sample_item(1, 0);
        item.product_name = "RMS CHARGE PAYMENT".to_string();
        item.sku = "ROS-RMS-CHARGE-PAYMENT".to_string();
        item.is_internal = true;
        item
    }

    #[test]
    fn receipt_builder_uses_effective_quantity_after_partial_return() {
        let detail = sample_transaction_detail(vec![sample_item(3, 1)]);

        let receipt = detail
            .receipt_for_zpl_filtered(None)
            .expect("receipt builds");

        assert_eq!(receipt.items.len(), 1);
        assert_eq!(receipt.items[0].quantity, 2);
    }

    #[test]
    fn receipt_builder_omits_fully_returned_lines() {
        let detail = sample_transaction_detail(vec![sample_item(2, 2), sample_item(1, 0)]);

        let receipt = detail
            .receipt_for_zpl_filtered(None)
            .expect("receipt builds");

        assert_eq!(receipt.items.len(), 1);
        assert_eq!(receipt.items[0].quantity, 1);
        assert_eq!(receipt.items[0].sku, "SKU-1");
    }

    #[test]
    fn receipt_builder_rejects_subset_when_all_selected_lines_were_returned() {
        let returned = sample_item(1, 1);
        let active = sample_item(2, 0);
        let returned_id = returned.transaction_line_id;
        let detail = sample_transaction_detail(vec![returned, active]);

        let err = detail
            .receipt_for_zpl_filtered(Some(&[returned_id]))
            .expect_err("fully returned subset should fail");

        assert!(matches!(err, TransactionError::InvalidPayload(_)));
        assert!(err
            .to_string()
            .contains("No active order lines remained after applied returns"));
    }

    #[test]
    fn receipt_builder_allows_internal_only_transaction_summary() {
        let detail = sample_transaction_detail(vec![sample_internal_item()]);

        let receipt = detail
            .receipt_for_zpl_filtered(None)
            .expect("internal-only receipt should build");

        assert!(receipt.items.is_empty());
        assert_eq!(receipt.total_price, Decimal::new(1000, 2));
        assert_eq!(receipt.payment_methods_summary, "Card");
    }
}

fn receipt_query_gift_flag(params: &std::collections::HashMap<String, String>) -> bool {
    params
        .get("gift")
        .map(|v| {
            let t = v.trim().to_ascii_lowercase();
            matches!(t.as_str(), "1" | "true" | "yes")
        })
        .unwrap_or(false)
}

fn receipt_query_transaction_line_ids(
    params: &std::collections::HashMap<String, String>,
) -> Option<Vec<Uuid>> {
    let raw = params.get("transaction_line_ids")?;
    let ids: Vec<Uuid> = raw
        .split([',', ' '])
        .filter_map(|t| Uuid::parse_str(t.trim()).ok())
        .collect();
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}

#[derive(Debug, FromRow)]
struct OrderHeaderRow {
    id: Uuid,
    display_id: String,
    booked_at: DateTime<Utc>,
    status: DbOrderStatus,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    is_forfeited: bool,
    forfeited_at: Option<DateTime<Utc>>,
    forfeiture_reason: Option<String>,
    fulfillment_method: DbOrderFulfillmentMethod,
    /// JSONB may be NULL (e.g. pickup / legacy rows); `sqlx::types::Json` decodes NULL ↔ `None` reliably.
    ship_to: Option<sqlx::types::Json<serde_json::Value>>,
    shipping_amount_usd: Option<Decimal>,
    shippo_shipment_object_id: Option<String>,
    shippo_transaction_object_id: Option<String>,
    tracking_number: Option<String>,
    tracking_url_provider: Option<String>,
    shipping_label_url: Option<String>,
    exchange_group_id: Option<Uuid>,
    customer_id: Option<Uuid>,
    customer_first_name: Option<String>,
    customer_last_name: Option<String>,
    customer_phone: Option<String>,
    customer_email: Option<String>,
    wedding_member_id: Option<Uuid>,
    wedding_party_id: Option<Uuid>,
    wedding_party_name: Option<String>,
    wedding_event_date: Option<chrono::NaiveDate>,
    wedding_member_role: Option<String>,
    operator_staff_id: Option<Uuid>,
    operator_name: Option<String>,
    primary_salesperson_id: Option<Uuid>,
    primary_salesperson_name: Option<String>,
    review_invite_sent_at: Option<DateTime<Utc>>,
    review_invite_suppressed_at: Option<DateTime<Utc>>,
    store_review_policy: sqlx::types::Json<serde_json::Value>,
    is_tax_exempt: bool,
    tax_exempt_reason: Option<String>,
    register_session_id: Option<Uuid>,
}

#[derive(Debug, FromRow)]
struct OrderItemRow {
    transaction_line_id: Uuid,
    product_id: Uuid,
    variant_id: Uuid,
    sku: String,
    product_name: String,
    variation_label: Option<String>,
    quantity: i32,
    quantity_returned: i32,
    unit_price: Decimal,
    unit_cost: Decimal,
    state_tax: Decimal,
    local_tax: Decimal,
    fulfillment: DbFulfillmentType,
    is_fulfilled: bool,
    is_internal: bool,
    custom_item_type: Option<String>,
    custom_order_details: Option<serde_json::Value>,
    salesperson_id: Option<Uuid>,
    salesperson_name: Option<String>,
    receipt_original_unit_price: Option<Decimal>,
    discount_event_label: Option<String>,
    gift_card_load_code: Option<String>,
}

#[derive(Debug, FromRow)]
struct PaymentSummaryRow {
    payment_method: String,
    check_number: Option<String>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct TransactionReadQuery {
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchTransactionRequest {
    pub status: Option<DbOrderStatus>,
    pub forfeiture_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PickupTransactionRequest {
    #[serde(default)]
    pub delivered_item_ids: Vec<Uuid>,
    #[serde(default)]
    pub actor: Option<String>,
    /// POS pickup without BO headers when this session has a positive allocation to the order.
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct AddTransactionLineRequest {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub fulfillment: DbFulfillmentType,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub unit_cost: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    #[serde(default)]
    pub salesperson_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchTransactionLineRequest {
    pub quantity: Option<i32>,
    pub unit_price: Option<Decimal>,
    pub fulfillment: Option<DbFulfillmentType>,
}

#[derive(Debug, Deserialize)]
pub struct SuitComponentSwapRequest {
    pub in_variant_id: Uuid,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub unit_price: Option<Decimal>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
    /// When set, POS must send matching `x-riverside-pos-session-id` + token; order must have a positive allocation from this session.
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TransactionAuditEvent {
    pub id: Uuid,
    pub event_kind: String,
    pub summary: String,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RefundQueueRow {
    pub id: Uuid,
    pub transaction_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub amount_due: Decimal,
    pub amount_refunded: Decimal,
    pub is_open: bool,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ProcessRefundRequest {
    pub session_id: Uuid,
    pub payment_method: String,
    pub amount: Decimal,
    /// Required when `payment_method` is a gift-card tender (e.g. `gift_card`).
    #[serde(default)]
    pub gift_card_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PostOrderReturnsRequest {
    pub lines: Vec<OrderReturnLineBody>,
}

#[derive(Debug, Deserialize)]
pub struct OrderReturnLineBody {
    pub transaction_line_id: Uuid,
    pub quantity: i32,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub restock: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct OrderExchangeLinkBody {
    pub other_transaction_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct PatchOrderAttributionRequest {
    pub manager_cashier_code: String,
    /// Required when the manager has a hashed PIN set (`staff.pin_hash`).
    #[serde(default)]
    pub manager_pin: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub primary_salesperson_id: Option<Uuid>,
    #[serde(default)]
    pub line_attribution: Vec<LineAttributionUpdate>,
}

#[derive(Debug, Deserialize)]
pub struct LineAttributionUpdate {
    pub transaction_line_id: Uuid,
    #[serde(default)]
    pub salesperson_id: Option<Uuid>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_transactions))
        .route("/pipeline-stats", get(get_pipeline_stats))
        .route("/refunds/due", get(list_refunds_due))
        .route("/fulfillment-queue", get(get_fulfillment_queue))
        .route("/checkout", post(checkout))
        .route(
            "/{transaction_id}/attribution",
            patch(patch_transaction_attribution),
        )
        .route("/{transaction_id}/pickup", post(mark_transaction_pickup))
        .route(
            "/{transaction_id}/review-invite",
            post(post_transaction_review_invite),
        )
        .route("/{transaction_id}/audit", get(get_transaction_audit))
        .route("/{transaction_id}/refunds/process", post(process_refund))
        .route("/{transaction_id}/returns", post(post_transaction_returns))
        .route(
            "/{transaction_id}/exchange-link",
            post(post_transaction_exchange_link),
        )
        .route(
            "/{transaction_id}/items",
            get(get_transaction_items).post(add_transaction_line),
        )
        .route(
            "/{transaction_id}/items/{transaction_line_id}",
            patch(update_transaction_line).delete(delete_transaction_line),
        )
        .route(
            "/{transaction_id}/items/{transaction_line_id}/suit-swap",
            post(post_suit_component_swap),
        )
        .route(
            "/{transaction_id}/receipt.zpl",
            get(get_transaction_receipt_zpl),
        )
        .route(
            "/{transaction_id}/receipt.html",
            get(get_transaction_receipt_html),
        )
        .route(
            "/{transaction_id}/receipt/send-email",
            post(post_transaction_receipt_send_email),
        )
        .route(
            "/{transaction_id}/receipt/send-sms",
            post(post_transaction_receipt_send_sms),
        )
        // Catch-all /{transaction_id} must be AFTER all other /{transaction_id}/... routes and static routes
        .route(
            "/{transaction_id}",
            get(get_transaction_detail).patch(patch_transaction),
        )
}

fn map_perm_err(e: (StatusCode, axum::Json<serde_json::Value>)) -> TransactionError {
    let (status, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => TransactionError::Unauthorized(msg),
        StatusCode::FORBIDDEN => TransactionError::Forbidden(msg),
        _ => TransactionError::Forbidden(msg),
    }
}

async fn register_session_is_open(
    pool: &sqlx::PgPool,
    sid: Uuid,
) -> Result<bool, TransactionError> {
    let ok: Option<bool> = sqlx::query_scalar(
        r#"SELECT (lifecycle_status = 'open') FROM register_sessions WHERE id = $1"#,
    )
    .bind(sid)
    .fetch_optional(pool)
    .await?;
    Ok(ok.unwrap_or(false))
}

async fn order_has_positive_payment_in_session(
    pool: &sqlx::PgPool,
    transaction_id: Uuid,
    session_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pa.target_transaction_id = $1
              AND pt.session_id = $2
              AND pa.amount_allocated > 0
        )
        "#,
    )
    .bind(transaction_id)
    .bind(session_id)
    .fetch_one(pool)
    .await
}

async fn authorize_transaction_read_bo_or_register(
    state: &AppState,
    headers: &HeaderMap,
    _transaction_id: Uuid,
    register_session_id: Option<Uuid>,
) -> Result<(), TransactionError> {
    if let Some(sid) = register_session_id {
        if !register_session_is_open(&state.db, sid).await? {
            return Err(TransactionError::Forbidden(
                "register session is not open".to_string(),
            ));
        }
        return Ok(());
    }
    middleware::require_staff_with_permission(state, headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    Ok(())
}

/// `Ok(Some(staff_id))` when BO headers were used; `Ok(None)` for register-session authorization.
async fn authorize_transaction_modify_bo_or_register(
    state: &AppState,
    headers: &HeaderMap,
    transaction_id: Uuid,
    register_session_id: Option<Uuid>,
) -> Result<Option<Uuid>, TransactionError> {
    if let Some(sid) = register_session_id {
        if !register_session_is_open(&state.db, sid).await? {
            return Err(TransactionError::Forbidden(
                "register session is not open".to_string(),
            ));
        }
        let ok = order_has_positive_payment_in_session(&state.db, transaction_id, sid)
            .await
            .map_err(TransactionError::Database)?;
        if !ok {
            return Err(TransactionError::Forbidden(
                "order is not linked to this register session".to_string(),
            ));
        }
        return Ok(None);
    }
    let s = middleware::require_staff_with_permission(state, headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    Ok(Some(s.id))
}

async fn get_transaction_detail(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    Ok(Json(detail))
}

async fn get_transaction_items(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<TransactionDetailItem>>, TransactionError> {
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    Ok(Json(detail.items))
}

#[derive(Debug, Deserialize)]
struct PostOrderReviewInviteBody {
    #[serde(default)]
    skip: bool,
}

async fn post_transaction_review_invite(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<PostOrderReviewInviteBody>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    podium_reviews::apply_post_sale_review_choice(&state.db, transaction_id, body.skip)
        .await
        .map_err(|e| match e {
            podium_reviews::ReviewInviteError::Db(d) => TransactionError::Database(d),
            podium_reviews::ReviewInviteError::NotFound => TransactionError::NotFound,
        })?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_transactions(
    State(state): State<AppState>,
    Query(q): Query<TransactionListQuery>,
    headers: HeaderMap,
) -> Result<Json<PagedTransactionsResponse>, TransactionError> {
    if let Some(sid) = q.register_session_id {
        if !register_session_is_open(&state.db, sid).await? {
            return Err(TransactionError::Forbidden(
                "register session is not open".to_string(),
            ));
        }
    } else {
        middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
            .await
            .map_err(map_perm_err)?;
    }

    let page = crate::logic::transaction_list::query_paged_transactions(
        &state.db,
        &q,
        state.meilisearch.as_ref(),
    )
    .await
    .map_err(TransactionError::Database)?;
    Ok(Json(page))
}

async fn patch_transaction(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchTransactionRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    if let Some(status) = body.status {
        if status == DbOrderStatus::Cancelled {
            let refundable_pre: Decimal = sqlx::query_scalar(
                r#"
                SELECT COALESCE(SUM(pa.amount_allocated), 0)::numeric(14,2)
                FROM payment_allocations pa
                WHERE pa.target_transaction_id = $1
                "#,
            )
            .bind(transaction_id)
            .fetch_one(&state.db)
            .await?;

            if refundable_pre > Decimal::ZERO {
                middleware::require_staff_with_permission(&state, &headers, ORDERS_CANCEL)
                    .await
                    .map_err(map_perm_err)?;
            } else {
                let staff = middleware::require_authenticated_staff_headers(&state, &headers)
                    .await
                    .map_err(map_perm_err)?;
                let eff = effective_permissions_for_staff(&state.db, staff.id, staff.role)
                    .await
                    .map_err(TransactionError::Database)?;
                if !staff_has_permission(&eff, ORDERS_CANCEL)
                    && !staff_has_permission(&eff, ORDERS_VOID_SALE)
                {
                    return Err(TransactionError::Forbidden(
                        "transactions.cancel or transactions.void_sale required to cancel an order with no payments"
                            .to_string(),
                    ));
                }
            }
        } else {
            middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
                .await
                .map_err(map_perm_err)?;
        }

        let mut tx = state.db.begin().await?;
        if status == DbOrderStatus::Cancelled {
            loyalty_logic::reverse_order_accrual_in_tx(&mut tx, transaction_id)
                .await
                .map_err(TransactionError::Database)?;
        }

        let upd = sqlx::query("UPDATE transactions SET status = $1 WHERE id = $2")
            .bind(status)
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;
        if upd.rows_affected() == 0 {
            return Err(TransactionError::NotFound);
        }

        let customer_id: Option<Uuid> =
            sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
                .bind(transaction_id)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();

        if status == DbOrderStatus::Cancelled {
            insert_transaction_activity_log_tx(
                &mut tx,
                transaction_id,
                customer_id,
                "status_change",
                &format!("Order status set to {status:?}"),
                json!({ "status": status }),
            )
            .await?;

            if let Some(reason) = body.forfeiture_reason {
                sqlx::query(
                    r#"
                    UPDATE transactions 
                    SET is_forfeited = true, 
                        forfeited_at = now(),
                        forfeiture_reason = $1
                    WHERE id = $2
                    "#,
                )
                .bind(&reason)
                .bind(transaction_id)
                .execute(&mut *tx)
                .await?;

                // Release on_layaway inventory
                sqlx::query(
                    r#"
                    UPDATE product_variants pv
                    SET on_layaway = GREATEST(pv.on_layaway - oi.quantity, 0)
                    FROM transaction_lines oi
                    WHERE oi.transaction_id = $1
                      AND oi.fulfillment = 'layaway'
                      AND pv.id = oi.variant_id
                    "#,
                )
                .bind(transaction_id)
                .execute(&mut *tx)
                .await?;

                insert_transaction_activity_log_tx(
                    &mut tx,
                    transaction_id,
                    customer_id,
                    "forfeiture",
                    &format!("Layaway forfeited: {reason}"),
                    json!({ "reason": reason }),
                )
                .await?;
            } else {
                let refundable: Decimal = sqlx::query_scalar(
                    r#"
                    SELECT COALESCE(SUM(pa.amount_allocated), 0)::numeric(14,2)
                    FROM payment_allocations pa
                    WHERE pa.target_transaction_id = $1
                    "#,
                )
                .bind(transaction_id)
                .fetch_one(&mut *tx)
                .await?;

                if refundable > Decimal::ZERO {
                    let reason = "Order cancelled; refund customer deposits/payments in register";
                    sqlx::query(
                        r#"
                        INSERT INTO transaction_refund_queue (transaction_id, customer_id, amount_due, reason)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (transaction_id) WHERE (is_open = true)
                        DO UPDATE SET
                            amount_due = transaction_refund_queue.amount_due + EXCLUDED.amount_due,
                            reason = transaction_refund_queue.reason || '; ' || EXCLUDED.reason
                        "#,
                    )
                    .bind(transaction_id)
                    .bind(customer_id)
                    .bind(refundable)
                    .bind(reason)
                    .execute(&mut *tx)
                    .await?;
                    insert_transaction_activity_log_tx(
                        &mut tx,
                        transaction_id,
                        customer_id,
                        "refund_queued",
                        &format!("Refund queued for ${refundable}"),
                        json!({ "amount_due": refundable }),
                    )
                    .await?;
                }
            }
        }

        tx.commit().await?;

        if status != DbOrderStatus::Cancelled {
            log_order_activity(
                &state.db,
                transaction_id,
                customer_id,
                "status_change",
                &format!("Order status set to {status:?}"),
                json!({ "status": status }),
            )
            .await?;
        }
    } else {
        middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
            .await
            .map_err(map_perm_err)?;
    }
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    spawn_meilisearch_transaction_upsert(&state, transaction_id);
    Ok(Json(detail))
}

async fn mark_transaction_pickup(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PickupTransactionRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let _ = authorize_transaction_modify_bo_or_register(
        &state,
        &headers,
        transaction_id,
        body.register_session_id,
    )
    .await?;

    let mut tx = state.db.begin().await?;
    if body.delivered_item_ids.is_empty() {
        sqlx::query("UPDATE transaction_lines SET is_fulfilled = TRUE WHERE transaction_id = $1")
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query(
            "UPDATE transaction_lines SET is_fulfilled = TRUE WHERE transaction_id = $1 AND id = ANY($2)",
        )
        .bind(transaction_id)
        .bind(&body.delivered_item_ids)
        .execute(&mut *tx)
        .await?;
    }
    let remaining_unfulfilled: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM transaction_lines oi
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE oi.transaction_id = $1
          AND oi.is_fulfilled = FALSE
          AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut *tx)
    .await?;
    if remaining_unfulfilled == 0 {
        sqlx::query("UPDATE transactions SET status = 'fulfilled'::order_status, fulfilled_at = CURRENT_TIMESTAMP WHERE id = $1")
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;
    }

    crate::logic::commission_recalc::recalc_transaction_commissions_after_fulfillment(
        &mut tx,
        transaction_id,
        &body.delivered_item_ids,
    )
    .await?;
    crate::logic::commission_events::upsert_fulfilled_transaction_events(
        &mut tx,
        transaction_id,
        &body.delivered_item_ids,
    )
    .await?;

    // For Special/Custom transactions: the item physically arrives from the vendor and goes
    // into reserved_stock. At pickup, the item leaves the store, so we decrement both
    // stock_on_hand and reserved_stock. Takeaway items already had stock_on_hand
    // decremented at checkout time, so only special/custom need adjustment here.
    let fulfilled_ids = &body.delivered_item_ids;
    if !fulfilled_ids.is_empty() {
        sqlx::query(
            r#"
            UPDATE product_variants pv
            SET
                stock_on_hand  = GREATEST(stock_on_hand  - sub.qty, 0),
                reserved_stock = GREATEST(reserved_stock - sub.qty_reserved, 0),
                on_layaway     = GREATEST(on_layaway     - sub.qty_layaway, 0)
            FROM (
                SELECT 
                    oi.variant_id, 
                    SUM(oi.quantity) AS qty,
                    SUM(CASE WHEN oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order') THEN oi.quantity ELSE 0 END) AS qty_reserved,
                    SUM(CASE WHEN oi.fulfillment::text = 'layaway' THEN oi.quantity ELSE 0 END) AS qty_layaway
                FROM transaction_lines oi
                WHERE oi.transaction_id = $1
                  AND oi.id = ANY($2)
                  AND oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
                GROUP BY oi.variant_id
            ) sub
            WHERE pv.id = sub.variant_id
            "#,
        )
        .bind(transaction_id)
        .bind(fulfilled_ids)
        .execute(&mut *tx)
        .await?;
    } else {
        // Empty delivered_item_ids means "fulfill everything"
        sqlx::query(
            r#"
            UPDATE product_variants pv
            SET
                stock_on_hand  = GREATEST(stock_on_hand  - sub.qty, 0),
                reserved_stock = GREATEST(reserved_stock - sub.qty_reserved, 0),
                on_layaway     = GREATEST(on_layaway     - sub.qty_layaway, 0)
            FROM (
                SELECT 
                    oi.variant_id, 
                    SUM(oi.quantity) AS qty,
                    SUM(CASE WHEN oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order') THEN oi.quantity ELSE 0 END) AS qty_reserved,
                    SUM(CASE WHEN oi.fulfillment::text = 'layaway' THEN oi.quantity ELSE 0 END) AS qty_layaway
                FROM transaction_lines oi
                WHERE oi.transaction_id = $1
                  AND oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
                GROUP BY oi.variant_id
            ) sub
            WHERE pv.id = sub.variant_id
            "#,
        )
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
    }

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;

    let status_after: DbOrderStatus =
        sqlx::query_scalar("SELECT status FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;

    tx.commit().await?;

    spawn_meilisearch_transaction_upsert(&state, transaction_id);

    if status_after == DbOrderStatus::Fulfilled {
        let pool = state.db.clone();
        let oid = transaction_id;
        let label = {
            let s = oid.to_string();
            s.chars().take(8).collect::<String>()
        };
        tokio::spawn(async move {
            if let Err(e) =
                crate::logic::notifications::emit_order_fully_fulfilled(&pool, oid, &label).await
            {
                tracing::error!(error = %e, "emit_order_fully_fulfilled");
            }
        });
    }

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let who = body.actor.unwrap_or_else(|| "Register".to_string());
    log_order_activity(
        &state.db,
        transaction_id,
        customer_id,
        "pickup",
        &format!("Pickup completed in Register by {}", who.trim()),
        json!({ "delivered_item_count": body.delivered_item_ids.len() }),
    )
    .await?;

    // Accrue loyalty points if this pickup caused the order to become fully fulfilled.
    if let Err(e) = loyalty_logic::try_accrue_for_order(&state.db, transaction_id).await {
        tracing::error!(error = %e, transaction_id = %transaction_id, "loyalty accrual failed after pickup");
    }

    // Trigger automated "Ready for Pickup" pings if order is now fulfilled.
    let _ = crate::logic::messaging::MessagingService::handle_status_change(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        transaction_id,
        status_after,
    )
    .await;

    Ok(Json(json!({ "status": "ok" })))
}

async fn get_transaction_audit(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<TransactionAuditEvent>>, TransactionError> {
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    let rows = sqlx::query_as::<_, TransactionAuditEvent>(
        r#"
        SELECT id, event_kind, summary, metadata, created_at
        FROM transaction_activity_log
        WHERE transaction_id = $1
        ORDER BY created_at DESC
        LIMIT 100
        "#,
    )
    .bind(transaction_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn list_refunds_due(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RefundQueueRow>>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_REFUND_PROCESS)
        .await
        .map_err(map_perm_err)?;
    let rows = sqlx::query_as::<_, RefundQueueRow>(
        r#"
        SELECT id, transaction_id, customer_id, amount_due, amount_refunded, is_open, reason, created_at
        FROM transaction_refund_queue
        WHERE is_open = TRUE
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn process_refund(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ProcessRefundRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_REFUND_PROCESS)
        .await
        .map_err(map_perm_err)?;

    if !register_session_is_open(&state.db, body.session_id).await? {
        return Err(TransactionError::InvalidPayload(
            "register session is not open".to_string(),
        ));
    }

    if body.amount <= Decimal::ZERO {
        return Err(TransactionError::InvalidPayload(
            "amount must be positive".to_string(),
        ));
    }

    let method_l = body.payment_method.to_lowercase();

    let mut tx = state.db.begin().await?;
    let row: Option<RefundQueueRow> = sqlx::query_as(
        r#"
        SELECT id, transaction_id, customer_id, amount_due, amount_refunded, is_open, reason, created_at
        FROM transaction_refund_queue
        WHERE transaction_id = $1 AND is_open = TRUE
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(refund) = row else {
        return Err(TransactionError::InvalidPayload(
            "no open refund for this order".to_string(),
        ));
    };
    let remaining = refund.amount_due - refund.amount_refunded;
    if body.amount > remaining {
        return Err(TransactionError::InvalidPayload(
            "refund exceeds amount due".to_string(),
        ));
    }

    let current_paid: Decimal =
        sqlx::query_scalar("SELECT amount_paid FROM transactions WHERE id = $1 FOR UPDATE")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;
    if body.amount > current_paid {
        return Err(TransactionError::InvalidPayload(
            "refund amount exceeds total amount paid on this order".to_string(),
        ));
    }

    let stripe_intent: Option<String> = sqlx::query_scalar(
        r#"
        SELECT pt.stripe_intent_id
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
          AND pa.amount_allocated > 0::numeric
          AND pt.stripe_intent_id IS NOT NULL
          AND btrim(pt.stripe_intent_id) <> ''
        ORDER BY pt.created_at ASC
        LIMIT 1
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();

    let mut stripe_refund_id: Option<String> = None;
    let wants_card_refund =
        method_l.contains("card") || method_l.contains("stripe") || method_l.contains("present");
    if wants_card_refund {
        if let Some(ref iid) = stripe_intent {
            let pi: stripe::PaymentIntentId = iid.parse().map_err(|_| {
                TransactionError::InvalidPayload(
                    "invalid stripe intent id on original payment".to_string(),
                )
            })?;
            let cents = (body.amount * Decimal::from(100)).to_i64().ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "refund amount is too large or invalid".to_string(),
                )
            })?;
            let mut cp = stripe::CreateRefund::new();
            cp.payment_intent = Some(pi);
            cp.amount = Some(cents);
            let rf = stripe::Refund::create(&state.stripe_client, cp)
                .await
                .map_err(|e| {
                    TransactionError::InvalidPayload(format!("Stripe refund failed: {e}"))
                })?;
            stripe_refund_id = Some(rf.id.to_string());
        }
    }

    let mut refund_metadata = json!({
        "kind": "order_refund",
        "transaction_id": transaction_id,
        "stripe_refund_id": stripe_refund_id,
    });

    if method_l.contains("gift") {
        let code = body
            .gift_card_code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "gift_card_code is required when refunding to a gift card".to_string(),
                )
            })?;
        let refund_plan = gift_card_ops::credit_gift_card_in_tx(
            &mut tx,
            code,
            body.amount,
            transaction_id,
            body.session_id,
        )
        .await
        .map_err(|e| match e {
            gift_card_ops::GiftCardOpError::Db(d) => TransactionError::Database(d),
            gift_card_ops::GiftCardOpError::BadRequest(m) => TransactionError::InvalidPayload(m),
        })?;
        if let Some(object) = refund_metadata.as_object_mut() {
            let canonical_sub_type =
                gift_card_ops::canonical_gift_card_sub_type_for_kind(&refund_plan.card_kind)
                    .map_err(|e| TransactionError::InvalidPayload(e.to_string()))?;
            object.insert(
                "gift_card_code".to_string(),
                json!(refund_plan.normalized_code),
            );
            object.insert(
                "gift_card_card_kind".to_string(),
                json!(refund_plan.card_kind.clone()),
            );
            object.insert("sub_type".to_string(), json!(canonical_sub_type));
            object.insert("balance_after".to_string(), json!(refund_plan.new_balance));
        }
    }

    let payment_tx_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_transactions (session_id, payer_id, category, payment_method, amount, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(body.session_id)
    .bind(refund.customer_id)
    .bind(DbTransactionCategory::RetailSale)
    .bind(body.payment_method.trim())
    .bind(-body.amount)
    .bind(refund_metadata)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated, metadata)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(payment_tx_id)
    .bind(transaction_id)
    .bind(-body.amount)
    .bind(json!({ "kind": "order_refund" }))
    .execute(&mut *tx)
    .await?;

    let new_refunded = refund.amount_refunded + body.amount;
    let close = new_refunded >= refund.amount_due;
    sqlx::query(
        r#"
        UPDATE transaction_refund_queue
        SET amount_refunded = $1, is_open = $2, closed_at = CASE WHEN $2 = FALSE THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = $3
        "#,
    )
    .bind(new_refunded)
    .bind(!close)
    .bind(refund.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE transactions
        SET amount_paid = GREATEST(amount_paid - $1, 0)
        WHERE id = $2
        "#,
    )
    .bind(body.amount)
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;

    let new_paid: Decimal =
        sqlx::query_scalar("SELECT amount_paid FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;
    if new_paid.is_zero() {
        loyalty_logic::reverse_order_accrual_in_tx(&mut tx, transaction_id)
            .await
            .map_err(TransactionError::Database)?;
    }

    tx.commit().await?;

    tracing::info!(
        transaction_id = %transaction_id,
        "Refund recorded; verify QBO journal maps negative retail payment lines"
    );

    log_order_activity(
        &state.db,
        transaction_id,
        refund.customer_id,
        "refund_processed",
        &format!(
            "Refunded ${} in Register via {}",
            body.amount,
            body.payment_method.trim()
        ),
        json!({ "amount": body.amount, "payment_method": body.payment_method }),
    )
    .await?;

    Ok(Json(json!({ "status": "ok" })))
}

async fn get_transaction_receipt_zpl(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, TransactionError> {
    let register_session_id = params
        .get("register_session_id")
        .and_then(|s| Uuid::parse_str(s.trim()).ok());
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        register_session_id,
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;

    let item_ids = receipt_query_transaction_line_ids(&params);
    let receipt_order = detail.receipt_for_zpl_filtered(item_ids.as_deref())?;

    // Load receipt config (best-effort; fall back to defaults on error).
    let receipt_cfg: crate::api::settings::ReceiptConfig =
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT receipt_config FROM store_settings WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let body = receipt_zpl::build_receipt_zpl(&receipt_order, &receipt_cfg, None, None, params);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body.into())
        .map_err(|e| {
            tracing::warn!(error = %e, "ZPL response build error");
            TransactionError::InvalidPayload("failed to build response".to_string())
        })
}

async fn get_transaction_receipt_html(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, TransactionError> {
    let register_session_id = params
        .get("register_session_id")
        .and_then(|s| Uuid::parse_str(s.trim()).ok());
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        register_session_id,
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;

    let gift = receipt_query_gift_flag(&params);
    let item_ids = receipt_query_transaction_line_ids(&params);
    let receipt_order = detail.receipt_for_zpl_filtered(item_ids.as_deref())?;

    let receipt_cfg: crate::api::settings::ReceiptConfig =
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT receipt_config FROM store_settings WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let tpl = receipt_cfg
        .receipt_studio_exported_html
        .as_deref()
        .unwrap_or("");
    let body = if tpl.trim().is_empty() {
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Receipt</title></head><body><p>No Receipt Builder HTML template configured.</p></body></html>".to_string()
    } else {
        receipt_studio_html::merge_receipt_studio_html(tpl, &receipt_order, &receipt_cfg, gift)
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(body.into())
        .map_err(|e| {
            tracing::warn!(error = %e, "Receipt HTML response build error");
            TransactionError::InvalidPayload("failed to build response".to_string())
        })
}

#[derive(Debug, Deserialize)]
struct SendOrderReceiptEmailBody {
    #[serde(default)]
    to_email: Option<String>,
    /// When true, merged receipt omits pricing (gift receipt).
    #[serde(default)]
    gift: bool,
    /// Subset of `transaction_lines.id` to include; when empty, all lines are used.
    #[serde(default)]
    transaction_line_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
struct SendOrderReceiptSmsBody {
    #[serde(default)]
    to_phone: Option<String>,
    /// PNG (base64) of rasterized merged receipt; sent via Podium MMS attachment when set.
    #[serde(default)]
    png_base64: Option<String>,
    #[serde(default)]
    gift: bool,
    #[serde(default)]
    transaction_line_ids: Vec<Uuid>,
}

/// Max decoded PNG size for receipt MMS (Podium allows 30 MB; keep lower for carriers).
const RECEIPT_SMS_PNG_MAX_BYTES: usize = 6 * 1024 * 1024;

fn map_podium_order_err(e: crate::logic::podium::PodiumError) -> TransactionError {
    TransactionError::BadGateway(format!(
        "Could not send via Podium ({e}). Enable operational messaging in Settings → Integrations (Podium), verify credentials, and ensure email and SMS send are enabled."
    ))
}

async fn post_transaction_receipt_send_email(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<SendOrderReceiptEmailBody>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;

    let to_email = body
        .to_email
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            detail
                .customer
                .as_ref()
                .and_then(|c| c.email.as_ref().map(|e| e.trim().to_string()))
                .filter(|s| !s.is_empty())
        });

    let Some(addr) = to_email else {
        return Err(TransactionError::InvalidPayload(
            "Add an email address for this customer (or pass to_email).".to_string(),
        ));
    };

    if !looks_like_email(&addr) {
        return Err(TransactionError::InvalidPayload(
            "Invalid email address.".to_string(),
        ));
    }

    let receipt_cfg: crate::api::settings::ReceiptConfig =
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT receipt_config FROM store_settings WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let tpl = receipt_cfg
        .receipt_studio_exported_html
        .as_deref()
        .unwrap_or("");
    if tpl.trim().is_empty() {
        return Err(TransactionError::InvalidPayload(
            "Receipt Builder HTML is not configured. Export HTML from Settings → Receipt Builder."
                .to_string(),
        ));
    }

    let item_ids = if body.transaction_line_ids.is_empty() {
        None
    } else {
        Some(body.transaction_line_ids.as_slice())
    };
    let receipt_order = detail.receipt_for_zpl_filtered(item_ids)?;

    let merged = receipt_studio_html::merge_receipt_studio_html(
        tpl,
        &receipt_order,
        &receipt_cfg,
        body.gift,
    );
    let html = receipt_studio_html::wrap_receipt_fragment_for_podium_email_inline(&merged);

    let order_ref: String = transaction_id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase();
    let subject = if body.gift {
        format!("Gift receipt — {order_ref}")
    } else {
        format!("Receipt — {order_ref}")
    };

    match podium::send_podium_email_message(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        &addr,
        &subject,
        &html,
    )
    .await
    {
        Ok(()) => Ok(Json(json!({ "status": "sent" }))),
        Err(e) => Err(map_podium_order_err(e)),
    }
}

async fn post_transaction_receipt_send_sms(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<SendOrderReceiptSmsBody>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;

    let to_phone = body
        .to_phone
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            detail
                .customer
                .as_ref()
                .and_then(|c| c.phone.as_ref().map(|p| p.trim().to_string()))
                .filter(|s| !s.is_empty())
        });

    let Some(phone_raw) = to_phone else {
        return Err(TransactionError::InvalidPayload(
            "Add a phone number for this customer (or pass to_phone).".to_string(),
        ));
    };

    if podium::normalize_phone_e164(&phone_raw).is_none() {
        return Err(TransactionError::InvalidPayload(
            "Invalid phone number. Use a 10-digit US number or E.164.".to_string(),
        ));
    }

    let receipt_cfg: crate::api::settings::ReceiptConfig =
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT receipt_config FROM store_settings WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let item_ids = if body.transaction_line_ids.is_empty() {
        None
    } else {
        Some(body.transaction_line_ids.as_slice())
    };
    let receipt_order = detail.receipt_for_zpl_filtered(item_ids)?;

    if let Some(b64_raw) = body.png_base64.as_ref() {
        let b64 = b64_raw.trim();
        if !b64.is_empty() {
            let png = general_purpose::STANDARD.decode(b64).map_err(|_| {
                TransactionError::InvalidPayload("Invalid base64 for receipt image.".to_string())
            })?;
            if png.is_empty() {
                return Err(TransactionError::InvalidPayload(
                    "Receipt image data was empty.".to_string(),
                ));
            }
            if png.len() > RECEIPT_SMS_PNG_MAX_BYTES {
                return Err(TransactionError::InvalidPayload(
                    "Receipt image is too large to send by text.".to_string(),
                ));
            }
            let order_ref: String = transaction_id
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
                .to_uppercase();
            let caption = if body.gift {
                format!(
                    "{} — Gift receipt {} (image attached).",
                    receipt_cfg.store_name.trim(),
                    order_ref
                )
            } else {
                format!(
                    "{} — Receipt {} (image attached).",
                    receipt_cfg.store_name.trim(),
                    order_ref
                )
            };
            return match podium::send_podium_phone_message_with_png_attachment(
                &state.db,
                &state.http_client,
                &state.podium_token_cache,
                &phone_raw,
                &caption,
                png,
            )
            .await
            {
                Ok(()) => Ok(Json(json!({ "status": "sent", "mode": "mms_attachment" }))),
                Err(e) => Err(map_podium_order_err(e)),
            };
        }
    }

    let sms_body = if body.gift {
        receipt_plain_text::format_pos_gift_receipt_text_message(&receipt_order, &receipt_cfg)
    } else {
        receipt_plain_text::format_pos_receipt_text_message(&receipt_order, &receipt_cfg)
    };
    let sms_body = receipt_plain_text::clamp_sms_text(&sms_body, 1500);

    match podium::send_podium_sms_message(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        &phone_raw,
        &sms_body,
    )
    .await
    {
        Ok(()) => Ok(Json(json!({ "status": "sent", "mode": "sms_text" }))),
        Err(e) => Err(map_podium_order_err(e)),
    }
}

pub(crate) async fn load_transaction_detail(
    pool: &sqlx::PgPool,
    transaction_id: Uuid,
) -> Result<TransactionDetailResponse, TransactionError> {
    let header = sqlx::query_as::<_, OrderHeaderRow>(
        r#"
        SELECT
            o.id,
            o.display_id,
            o.booked_at,
            o.status,
            o.total_price,
            o.amount_paid,
            o.balance_due,
            o.is_forfeited,
            o.forfeited_at,
            o.forfeiture_reason,
            COALESCE(o.fulfillment_method, 'pickup') AS fulfillment_method,
            o.ship_to,
            o.shipping_amount_usd,
            o.shippo_shipment_object_id,
            o.shippo_transaction_object_id,
            o.tracking_number,
            o.tracking_url_provider,
            o.shipping_label_url,
            o.exchange_group_id,
            c.id AS customer_id,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            c.phone AS customer_phone,
            c.email AS customer_email,
            o.wedding_member_id,
            wm.wedding_party_id,
            NULLIF(TRIM(COALESCE(wp.party_name, wp.groom_name, '')), '') AS wedding_party_name,
            wp.event_date AS wedding_event_date,
            NULLIF(TRIM(wm.role), '') AS wedding_member_role,
            o.operator_id AS operator_staff_id,
            op.full_name AS operator_name,
            o.primary_salesperson_id,
            ps.full_name AS primary_salesperson_name,
            o.review_invite_sent_at,
            o.review_invite_suppressed_at,
            ros_store.review_policy AS store_review_policy,
            COALESCE(o.is_tax_exempt, false) AS is_tax_exempt,
            o.tax_exempt_reason,
            o.register_session_id
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN staff op ON op.id = o.operator_id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        CROSS JOIN store_settings ros_store
        WHERE o.id = $1 AND ros_store.id = 1
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(pool)
    .await?;

    let Some(h) = header else {
        return Err(TransactionError::NotFound);
    };

    let review_pol = podium_reviews::parse_review_policy(h.store_review_policy.0.clone());

    let items = sqlx::query_as::<_, OrderItemRow>(
        r#"
        SELECT
            oi.id AS transaction_line_id,
            oi.product_id,
            oi.variant_id,
            pv.sku,
            p.name AS product_name,
            pv.variation_label,
            oi.quantity,
            COALESCE((
                SELECT SUM(orx.quantity_returned)::int
                FROM transaction_return_lines orx
                WHERE orx.transaction_line_id = oi.id
            ), 0) AS quantity_returned,
            COALESCE(oi.unit_price, 0) AS unit_price,
            COALESCE(oi.unit_cost, 0) AS unit_cost,
            COALESCE(oi.state_tax, 0) AS state_tax,
            COALESCE(oi.local_tax, 0) AS local_tax,
            oi.fulfillment,
            oi.is_fulfilled,
            COALESCE(oi.is_internal, false) AS is_internal,
            NULLIF(TRIM(oi.custom_item_type), '') AS custom_item_type,
            CASE
                WHEN oi.size_specs ? 'custom_order_details'
                THEN oi.size_specs->'custom_order_details'
                ELSE NULL
            END AS custom_order_details,
            oi.salesperson_id,
            sp.full_name AS salesperson_name,
            CASE
                WHEN oi.size_specs ? 'original_unit_price'
                     AND NULLIF(TRIM(oi.size_specs->>'original_unit_price'), '') IS NOT NULL
                     AND TRIM(oi.size_specs->>'original_unit_price') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN (TRIM(oi.size_specs->>'original_unit_price'))::numeric(14,2)
                ELSE NULL
            END AS receipt_original_unit_price,
            NULLIF(TRIM(oi.size_specs->>'discount_event_label'), '') AS discount_event_label,
            NULLIF(TRIM(oi.size_specs->>'gift_card_load_code'), '') AS gift_card_load_code
        FROM transaction_lines oi
        INNER JOIN products p ON p.id = oi.product_id
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        LEFT JOIN staff sp ON sp.id = oi.salesperson_id
        WHERE oi.transaction_id = $1
        ORDER BY oi.id
        "#,
    )
    .bind(transaction_id)
    .fetch_all(pool)
    .await?;

    let payment_rows = sqlx::query_as::<_, PaymentSummaryRow>(
        r#"
        SELECT DISTINCT
            pt.payment_method,
            pt.check_number,
            pt.metadata
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
           OR pt.metadata->>'checkout_transaction_id' = $1::text
        "#,
    )
    .bind(transaction_id)
    .fetch_all(pool)
    .await?;

    let mut summary_parts: Vec<String> = Vec::new();
    for row in payment_rows {
        let part = pos_rms_charge::payment_method_summary(
            &row.payment_method,
            row.check_number.as_deref(),
            row.metadata.as_ref(),
        );
        if !summary_parts.iter().any(|existing| existing == &part) {
            summary_parts.push(part);
        }
    }
    let payment_methods_summary = if summary_parts.is_empty() {
        "—".to_string()
    } else {
        summary_parts.join(", ")
    };

    let payment_applications = sqlx::query_as::<_, (Uuid, String, Decimal, Decimal)>(
        r#"
        SELECT
            target.id AS target_transaction_id,
            COALESCE(
                NULLIF(TRIM(pa.metadata->>'target_display_id'), ''),
                (
                    SELECT string_agg(DISTINCT fo.display_id, ', ' ORDER BY fo.display_id)
                    FROM transaction_lines tl
                    INNER JOIN fulfillment_orders fo ON fo.id = tl.fulfillment_order_id
                    WHERE tl.transaction_id = target.id
                ),
                target.counterpoint_doc_ref,
                target.counterpoint_ticket_ref,
                target.display_id,
                target.id::text
            ) AS target_display_id,
            COALESCE(pa.amount_allocated, 0)::numeric(14,2) AS amount,
            COALESCE(target.balance_due, 0)::numeric(14,2) AS remaining_balance
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        INNER JOIN transactions target ON target.id = pa.target_transaction_id
        WHERE pt.metadata->>'checkout_transaction_id' = $1::text
          AND pa.metadata->>'kind' = 'existing_order_payment'
        ORDER BY target.display_id NULLS LAST, target.id
        "#,
    )
    .bind(transaction_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(
        |(target_transaction_id, target_display_id, amount, remaining_balance)| {
            TransactionPaymentApplication {
                target_transaction_id,
                target_display_id,
                amount,
                remaining_balance,
            }
        },
    )
    .collect::<Vec<_>>();

    let customer = match (h.customer_id, h.customer_first_name, h.customer_last_name) {
        (Some(id), Some(first_name), Some(last_name)) => Some(OrderCustomerSummary {
            id,
            first_name,
            last_name,
            phone: h.customer_phone,
            email: h.customer_email,
        }),
        _ => None,
    };

    let wedding_summary = match (h.wedding_party_id, h.wedding_member_id) {
        (Some(wedding_party_id), Some(wedding_member_id)) => Some(OrderWeddingSummary {
            wedding_party_id,
            wedding_member_id,
            party_name: h.wedding_party_name,
            event_date: h.wedding_event_date,
            member_role: h.wedding_member_role,
        }),
        _ => None,
    };

    let items = items
        .into_iter()
        .map(|r| TransactionDetailItem {
            transaction_line_id: r.transaction_line_id,
            product_id: r.product_id,
            variant_id: r.variant_id,
            sku: r.sku,
            product_name: r.product_name,
            variation_label: r.variation_label,
            quantity: r.quantity,
            quantity_returned: r.quantity_returned,
            unit_price: r.unit_price,
            unit_cost: r.unit_cost,
            state_tax: r.state_tax,
            local_tax: r.local_tax,
            fulfillment: r.fulfillment,
            is_fulfilled: r.is_fulfilled,
            is_internal: r.is_internal,
            custom_item_type: r.custom_item_type,
            custom_order_details: r.custom_order_details,
            salesperson_id: r.salesperson_id,
            salesperson_name: r.salesperson_name,
            receipt_original_unit_price: r.receipt_original_unit_price,
            discount_event_label: r.discount_event_label,
            gift_card_load_code: r.gift_card_load_code,
        })
        .collect();

    let (total_allocated_payments, total_applied_deposit_amount): (Option<Decimal>, Option<Decimal>) =
        sqlx::query_as(
            r#"
            SELECT
                COALESCE(SUM(pa.amount_allocated)::numeric(14,2), 0::numeric) AS total_allocated_payments,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS total_applied_deposit_amount
            FROM payment_allocations pa
            WHERE pa.target_transaction_id = $1
            "#,
        )
        .bind(transaction_id)
        .fetch_one(pool)
        .await?;

    let receipt_cfg_raw: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let (receipt_studio_layout_available, receipt_thermal_mode) = if let Some(v) = receipt_cfg_raw {
        match serde_json::from_value::<crate::api::settings::ReceiptConfig>(v) {
            Ok(c) => (
                c.receipt_studio_exported_html
                    .as_ref()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false),
                c.receipt_thermal_mode,
            ),
            Err(_) => (false, "zpl".to_string()),
        }
    } else {
        (false, "zpl".to_string())
    };

    Ok(TransactionDetailResponse {
        transaction_id: h.id,
        transaction_display_id: h.display_id,
        booked_at: h.booked_at,
        status: h.status,
        total_price: h.total_price,
        amount_paid: h.amount_paid,
        balance_due: h.balance_due,
        is_forfeited: h.is_forfeited,
        forfeited_at: h.forfeited_at,
        forfeiture_reason: h.forfeiture_reason,
        fulfillment_method: h.fulfillment_method,
        ship_to: h.ship_to.map(|j| j.0),
        shipping_amount_usd: h.shipping_amount_usd,
        shippo_shipment_object_id: h.shippo_shipment_object_id,
        shippo_transaction_object_id: h.shippo_transaction_object_id,
        tracking_number: h.tracking_number,
        tracking_url_provider: h.tracking_url_provider,
        shipping_label_url: h.shipping_label_url,
        exchange_group_id: h.exchange_group_id,
        payment_methods_summary,
        payment_applications,
        operator_staff_id: h.operator_staff_id,
        operator_name: h.operator_name,
        primary_salesperson_id: h.primary_salesperson_id,
        primary_salesperson_name: h.primary_salesperson_name,
        wedding_member_id: h.wedding_member_id,
        wedding_summary,
        is_tax_exempt: h.is_tax_exempt,
        tax_exempt_reason: h.tax_exempt_reason,
        register_session_id: h.register_session_id,
        customer,
        financial_summary: TransactionFinancialSummary {
            total_allocated_payments: total_allocated_payments.unwrap_or(Decimal::ZERO),
            total_applied_deposit_amount: total_applied_deposit_amount.unwrap_or(Decimal::ZERO),
        },
        items,
        receipt_studio_layout_available,
        receipt_thermal_mode,
        store_review_invites_enabled: review_pol.review_invites_enabled,
        store_send_review_invite_by_default: review_pol.send_review_invite_by_default,
        review_invite_sent_at: h.review_invite_sent_at,
        review_invite_suppressed_at: h.review_invite_suppressed_at,
    })
}

async fn insert_transaction_activity_log_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    event_kind: &str,
    summary: &str,
    metadata: serde_json::Value,
) -> Result<(), TransactionError> {
    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (transaction_id, customer_id, event_kind, summary, metadata)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(event_kind)
    .bind(summary)
    .bind(metadata)
    .execute(tx.deref_mut())
    .await?;
    Ok(())
}

async fn log_order_activity(
    db: &sqlx::PgPool,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    event_kind: &str,
    summary: &str,
    metadata: serde_json::Value,
) -> Result<(), TransactionError> {
    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (transaction_id, customer_id, event_kind, summary, metadata)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(event_kind)
    .bind(summary)
    .bind(metadata)
    .execute(db)
    .await?;

    // Only emit customer-timeline notes for meaningful business milestones.
    // Internal events (item_added, item_updated, etc.) are logged but not surfaced to customers.
    let is_customer_milestone = matches!(event_kind, "checkout" | "pickup" | "refund_processed");
    if is_customer_milestone {
        if let Some(cid) = customer_id {
            sqlx::query(
                r#"
                INSERT INTO customer_timeline_notes (customer_id, body, created_by)
                VALUES ($1, $2, NULL)
                "#,
            )
            .bind(cid)
            .bind(format!("Order {transaction_id}: {summary}"))
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

async fn post_transaction_returns(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<PostOrderReturnsRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    let staff_id = authorize_transaction_modify_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;

    if body.lines.is_empty() {
        return Err(TransactionError::InvalidPayload(
            "at least one return line is required".to_string(),
        ));
    }

    let inputs: Vec<ReturnLineInput> = body
        .lines
        .into_iter()
        .map(|l| ReturnLineInput {
            transaction_line_id: l.transaction_line_id,
            quantity: l.quantity,
            reason: l.reason,
            restock: l.restock,
        })
        .collect();

    transaction_returns::apply_transaction_returns(&state.db, transaction_id, staff_id, inputs)
        .await
        .map_err(|e| match e {
            transaction_returns::TransactionReturnError::Db(d) => TransactionError::Database(d),
            transaction_returns::TransactionReturnError::BadRequest(m) => {
                TransactionError::InvalidPayload(m)
            }
        })?;

    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    Ok(Json(detail))
}

async fn post_transaction_exchange_link(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<OrderExchangeLinkBody>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    if body.other_transaction_id == transaction_id {
        return Err(TransactionError::InvalidPayload(
            "other_transaction_id must differ from this order".to_string(),
        ));
    }

    if let Some(sid) = q.register_session_id {
        authorize_transaction_modify_bo_or_register(
            &state,
            &headers,
            body.other_transaction_id,
            Some(sid),
        )
        .await?;
    } else {
        middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
            .await
            .map_err(map_perm_err)?;
    }

    let mut tx = state.db.begin().await?;
    let n: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM transactions
        WHERE id IN ($1, $2) AND status <> 'cancelled'::order_status
        "#,
    )
    .bind(transaction_id)
    .bind(body.other_transaction_id)
    .fetch_one(&mut *tx)
    .await?;
    if n != 2 {
        return Err(TransactionError::InvalidPayload(
            "one or both transactions were not found or are cancelled".to_string(),
        ));
    }

    let gid = Uuid::new_v4();
    sqlx::query("UPDATE transactions SET exchange_group_id = $1 WHERE id = $2 OR id = $3")
        .bind(gid)
        .bind(transaction_id)
        .bind(body.other_transaction_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    log_order_activity(
        &state.db,
        transaction_id,
        customer_id,
        "exchange_linked",
        "Orders linked for exchange reporting",
        json!({
            "exchange_group_id": gid,
            "other_transaction_id": body.other_transaction_id,
        }),
    )
    .await?;

    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    Ok(Json(detail))
}

async fn add_transaction_line(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<AddTransactionLineRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    if body.quantity <= 0 {
        return Err(TransactionError::InvalidPayload(
            "quantity must be positive".to_string(),
        ));
    }
    let mut tx = state.db.begin().await?;
    let wedding_row: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT wedding_member_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?;
    let wedding_member_id = match wedding_row {
        None => return Err(TransactionError::NotFound),
        Some(wm) => wm,
    };
    let fulfillment = crate::logic::transaction_fulfillment::persist_fulfillment(
        wedding_member_id,
        body.fulfillment,
    )
    .map_err(|m| TransactionError::InvalidPayload(m.to_string()))?;
    sqlx::query(
        r#"
        INSERT INTO transaction_lines (
            transaction_id, product_id, variant_id, fulfillment, quantity,
            unit_price, unit_cost, state_tax, local_tax, is_fulfilled, salesperson_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        "#,
    )
    .bind(transaction_id)
    .bind(body.product_id)
    .bind(body.variant_id)
    .bind(fulfillment)
    .bind(body.quantity)
    .bind(body.unit_price)
    .bind(body.unit_cost)
    .bind(body.state_tax)
    .bind(body.local_tax)
    .bind(false)
    .bind(body.salesperson_id)
    .execute(&mut *tx)
    .await?;
    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;
    tx.commit().await?;
    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    log_order_activity(
        &state.db,
        transaction_id,
        customer_id,
        "item_added",
        "Item added to order",
        json!({ "product_id": body.product_id, "variant_id": body.variant_id, "quantity": body.quantity }),
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    Ok(Json(detail))
}

async fn update_transaction_line(
    State(state): State<AppState>,
    Path((transaction_id, transaction_line_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<PatchTransactionLineRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    let mut tx = state.db.begin().await?;
    let wedding_row: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT wedding_member_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?;
    let wedding_member_id = match wedding_row {
        None => return Err(TransactionError::NotFound),
        Some(wm) => wm,
    };
    let normalized_fulfillment = match body.fulfillment {
        Some(f) => Some(
            crate::logic::transaction_fulfillment::persist_fulfillment(wedding_member_id, f)
                .map_err(|m| TransactionError::InvalidPayload(m.to_string()))?,
        ),
        None => None,
    };

    let mut touched = false;
    if let Some(q) = body.quantity {
        if q <= 0 {
            return Err(TransactionError::InvalidPayload(
                "quantity must be positive".to_string(),
            ));
        }
        touched = true;
    }
    if body.unit_price.is_some() {
        touched = true;
    }
    if normalized_fulfillment.is_some() {
        touched = true;
    }
    if touched {
        sqlx::query(
            r#"
            UPDATE transaction_lines
            SET
                quantity = COALESCE($1, quantity),
                unit_price = COALESCE($2, unit_price),
                fulfillment = COALESCE($3, fulfillment)
            WHERE id = $4
              AND transaction_id = $5
            "#,
        )
        .bind(body.quantity)
        .bind(body.unit_price)
        .bind(normalized_fulfillment)
        .bind(transaction_line_id)
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
    }
    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;
    tx.commit().await?;
    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    log_order_activity(
        &state.db,
        transaction_id,
        customer_id,
        "item_updated",
        "Order line edited",
        json!({ "transaction_line_id": transaction_line_id, "quantity": body.quantity, "unit_price": body.unit_price, "fulfillment": normalized_fulfillment }),
    )
    .await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    Ok(Json(detail))
}

async fn post_suit_component_swap(
    State(state): State<AppState>,
    Path((transaction_id, transaction_line_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<SuitComponentSwapRequest>,
) -> Result<Json<SuitSwapOutcome>, TransactionError> {
    let staff_id_for_event: Option<Uuid> = if let Some(reg_sid) = body.register_session_id {
        let Some((h_sid, tok)) = pos_session::pos_session_headers(&headers) else {
            return Err(TransactionError::Unauthorized(
                "register suit swap requires x-riverside-pos-session-id and x-riverside-pos-session-token"
                    .to_string(),
            ));
        };
        if h_sid != reg_sid {
            return Err(TransactionError::InvalidPayload(
                "register_session_id must match x-riverside-pos-session-id header".to_string(),
            ));
        }
        let ok = pos_session::verify_pos_session_token(&state.db, h_sid, &tok)
            .await
            .map_err(TransactionError::Database)?;
        if !ok {
            return Err(TransactionError::Unauthorized(
                "invalid or expired register session token".to_string(),
            ));
        }
        authorize_transaction_modify_bo_or_register(
            &state,
            &headers,
            transaction_id,
            Some(reg_sid),
        )
        .await?;
        let opened_by: Option<Uuid> = sqlx::query_scalar(
            "SELECT opened_by FROM register_sessions WHERE id = $1 AND is_open = true",
        )
        .bind(reg_sid)
        .fetch_optional(&state.db)
        .await
        .map_err(TransactionError::Database)?
        .flatten();
        opened_by
    } else {
        let staff = middleware::require_authenticated_staff_headers(&state, &headers)
            .await
            .map_err(map_perm_err)?;
        let eff = effective_permissions_for_staff(&state.db, staff.id, staff.role)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "effective_permissions failed for suit swap");
                TransactionError::Database(e)
            })?;
        if !staff_has_permission(&eff, ORDERS_MODIFY) {
            return Err(TransactionError::Forbidden(
                "missing permission transactions.modify".to_string(),
            ));
        }
        if !staff_has_permission(&eff, ORDERS_SUIT_COMPONENT_SWAP) {
            return Err(TransactionError::Forbidden(
                "missing permission transactions.suit_component_swap".to_string(),
            ));
        }
        Some(staff.id)
    };

    let mut tx = state.db.begin().await?;
    let outcome: SuitSwapOutcome = suit_component_swap::execute_suit_component_swap(
        &mut tx,
        transaction_id,
        transaction_line_id,
        staff_id_for_event,
        state.global_employee_markup,
        SuitSwapInput {
            in_variant_id: body.in_variant_id,
            note: body.note,
            unit_price: body.unit_price,
            unit_cost: body.unit_cost,
        },
    )
    .await?;

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();

    insert_transaction_activity_log_tx(
        &mut tx,
        transaction_id,
        customer_id,
        "suit_component_swap",
        &format!(
            "Swapped {} → {} (inventory adjusted: {})",
            outcome.old_sku, outcome.new_sku, outcome.inventory_adjusted
        ),
        json!({
            "event_id": outcome.event_id,
            "old_sku": outcome.old_sku,
            "new_sku": outcome.new_sku,
            "inventory_adjusted": outcome.inventory_adjusted,
        }),
    )
    .await?;

    tx.commit().await?;

    if let Some(sid) = staff_id_for_event {
        let _ = log_staff_access(
            &state.db,
            sid,
            "suit_component_swap",
            json!({
                "transaction_id": transaction_id,
                "transaction_line_id": transaction_line_id,
                "event_id": outcome.event_id,
                "old_sku": outcome.old_sku,
                "new_sku": outcome.new_sku,
                "register_session_id": body.register_session_id,
            }),
        )
        .await;
    } else {
        tracing::info!(
            transaction_id = %transaction_id,
            transaction_line_id = %transaction_line_id,
            event_id = %outcome.event_id,
            "suit_component_swap via register session (no BO staff access log row)"
        );
    }

    Ok(Json(outcome))
}

async fn delete_transaction_line(
    State(state): State<AppState>,
    Path((transaction_id, transaction_line_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM transaction_lines WHERE id = $1 AND transaction_id = $2")
        .bind(transaction_line_id)
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;
    tx.commit().await?;
    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    log_order_activity(
        &state.db,
        transaction_id,
        customer_id,
        "item_deleted",
        "Order line removed",
        json!({ "transaction_line_id": transaction_line_id }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn checkout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CheckoutRequest>,
) -> Result<Json<CheckoutResponse>, TransactionError> {
    middleware::require_pos_register_session_for_checkout(&state, &headers, payload.session_id)
        .await
        .map_err(|(status, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            if status == StatusCode::UNAUTHORIZED {
                TransactionError::Unauthorized(msg)
            } else {
                TransactionError::InvalidPayload(msg)
            }
        })?;

    use crate::logic::transaction_checkout::{execute_checkout, CheckoutDone};

    let outcome = execute_checkout(
        &state.db,
        &state.http_client,
        &state.corecard_config,
        &state.corecard_token_cache,
        state.global_employee_markup,
        payload,
    )
    .await?;

    match outcome {
        CheckoutDone::Idempotent {
            transaction_id: tid,
            display_id: d_id,
        } => {
            spawn_meilisearch_transaction_upsert(&state, tid);
            Ok(Json(CheckoutResponse {
                transaction_id: tid,
                transaction_display_id: d_id,
                status: "success".to_string(),
                loyalty_points_earned: 0,
                loyalty_points_balance: None,
            }))
        }
        CheckoutDone::Completed {
            transaction_id,
            display_id,
            operator_staff_id,
            customer_id: _customer_id,
            price_override_audit,
            alteration_order_ids,
            amount_paid,
            total_price,
        } => {
            for detail in price_override_audit {
                let _ = log_staff_access(
                    &state.db,
                    operator_staff_id,
                    "price_override",
                    json!({ "transaction_id": transaction_id, "detail": detail }),
                )
                .await;
            }

            let _ = log_staff_access(
                &state.db,
                operator_staff_id,
                "checkout_auth",
                json!({
                    "transaction_id": transaction_id,
                    "amount_paid": amount_paid,
                    "total_price": total_price,
                }),
            )
            .await;

            let accrual_res = loyalty_logic::try_accrue_for_order(&state.db, transaction_id).await;
            let loyalty_points_earned = match &accrual_res {
                Ok(Some(o)) => o.points_earned,
                Ok(None) => 0,
                Err(e) => {
                    tracing::error!(
                        error = %e,
                        transaction_id = %transaction_id,
                        "loyalty accrual failed after checkout"
                    );
                    0
                }
            };

            let loyalty_points_balance: Option<i32> = match &accrual_res {
                Ok(Some(o)) => Some(o.balance_after),
                _ => None,
            };

            spawn_meilisearch_transaction_upsert(&state, transaction_id);
            spawn_meilisearch_alteration_upserts(&state, alteration_order_ids);

            if let Ok(url_raw) = std::env::var("RIVERSIDE_WEBHOOK_URL") {
                let target_url = url_raw.trim().to_string();
                if !target_url.is_empty() {
                    let amount_paid_s = amount_paid.to_string();
                    let total_price_s = total_price.to_string();
                    let d_id = display_id.clone();
                    tokio::spawn(async move {
                        let client = reqwest::Client::new();
                        let webhook_payload = serde_json::json!({
                            "event": "transaction.finalized",
                            "transaction_id": transaction_id.to_string(),
                            "transaction_display_id": d_id,
                            "amount_paid": amount_paid_s,
                            "total_price": total_price_s,
                            "loyalty_points_earned": loyalty_points_earned
                        });
                        if let Err(e) = client.post(&target_url).json(&webhook_payload).send().await
                        {
                            tracing::warn!(error = %e, transaction_id = %transaction_id, "Webhook dispatch failed");
                        } else {
                            tracing::info!(transaction_id = %transaction_id, "Webhook successfully dispatched");
                        }
                    });
                }
            }

            Ok(Json(CheckoutResponse {
                transaction_id,
                transaction_display_id: display_id,
                status: "success".to_string(),
                loyalty_points_earned,
                loyalty_points_balance,
            }))
        }
    }
}

async fn staff_id_active(pool: &sqlx::PgPool, id: Uuid) -> Result<bool, TransactionError> {
    let ok: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1 AND is_active = TRUE)")
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(TransactionError::Database)?;
    Ok(ok)
}

async fn patch_transaction_attribution(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Json(body): Json<PatchOrderAttributionRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let code = body.manager_cashier_code.trim();
    if code.is_empty() {
        return Err(TransactionError::InvalidPayload(
            "manager_cashier_code is required".to_string(),
        ));
    }

    let admin = pins::authenticate_pos_staff(&state.db, code, body.manager_pin.as_deref())
        .await
        .map_err(|_| {
            TransactionError::Unauthorized(
                "valid manager cashier code and PIN required".to_string(),
            )
        })?;
    let eff =
        crate::auth::permissions::effective_permissions_for_staff(&state.db, admin.id, admin.role)
            .await
            .map_err(TransactionError::Database)?;
    if !staff_has_permission(&eff, ORDERS_EDIT_ATTRIBUTION) {
        return Err(TransactionError::Forbidden(
            "transactions.edit_attribution permission required".to_string(),
        ));
    }
    let corrector_id = admin.id;

    if body.line_attribution.is_empty() && body.primary_salesperson_id.is_none() {
        return Err(TransactionError::InvalidPayload(
            "provide primary_salesperson_id and/or line_attribution".to_string(),
        ));
    }

    if let Some(pid) = body.primary_salesperson_id {
        if !staff_id_active(&state.db, pid).await? {
            return Err(TransactionError::InvalidPayload(
                "primary_salesperson_id is invalid or inactive".to_string(),
            ));
        }
    }

    for line in &body.line_attribution {
        if let Some(sid) = line.salesperson_id {
            if !staff_id_active(&state.db, sid).await? {
                return Err(TransactionError::InvalidPayload(format!(
                    "salesperson_id invalid for line {}",
                    line.transaction_line_id
                )));
            }
        }
    }

    let mut tx = state.db.begin().await?;

    let order_gate: Option<(String, bool)> = sqlx::query_as(
        r#"
        SELECT status::text, COALESCE(o.is_employee_purchase, false)
        FROM transactions o
        WHERE o.id = $1
        FOR UPDATE OF o
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(TransactionError::Database)?;

    let Some((status, _is_employee_purchase_order)) = order_gate else {
        return Err(TransactionError::NotFound);
    };

    if status == "cancelled" {
        return Err(TransactionError::InvalidPayload(
            "cannot edit attribution on cancelled transactions".to_string(),
        ));
    }

    let mut primary_touched = false;
    if let Some(pid) = body.primary_salesperson_id {
        sqlx::query("UPDATE transactions SET primary_salesperson_id = $1 WHERE id = $2")
            .bind(pid)
            .bind(transaction_id)
            .execute(&mut *tx)
            .await
            .map_err(TransactionError::Database)?;
        primary_touched = true;
    }

    let mut line_attribution_changes: i32 = 0;

    #[derive(FromRow)]
    struct LineAttribRow {
        salesperson_id: Option<Uuid>,
        commission_payout_finalized_at: Option<DateTime<Utc>>,
    }

    for line in &body.line_attribution {
        let row: Option<LineAttribRow> = sqlx::query_as(
            r#"
            SELECT oi.salesperson_id, oi.commission_payout_finalized_at
            FROM transaction_lines oi
            WHERE oi.id = $1 AND oi.transaction_id = $2
            "#,
        )
        .bind(line.transaction_line_id)
        .bind(transaction_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(TransactionError::Database)?;

        let Some(LineAttribRow {
            salesperson_id: prior_sp,
            commission_payout_finalized_at,
        }) = row
        else {
            return Err(TransactionError::InvalidPayload(format!(
                "order item {} not on this order",
                line.transaction_line_id
            )));
        };

        if prior_sp == line.salesperson_id {
            continue;
        }

        if commission_payout_finalized_at.is_some() {
            return Err(TransactionError::InvalidPayload(
                "cannot change salesperson on lines with a finalized commission payout — use accounting adjustments"
                    .to_string(),
            ));
        }

        line_attribution_changes += 1;

        crate::logic::commission_recalc::recalc_transaction_line_commission(
            &mut tx,
            transaction_id,
            line.transaction_line_id,
            line.salesperson_id,
        )
        .await
        .map_err(TransactionError::Database)?;

        sqlx::query(
            r#"
            INSERT INTO order_attribution_audit (
                transaction_id, transaction_line_id, prior_salesperson_id, new_salesperson_id,
                corrected_by_staff_id, reason
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(transaction_id)
        .bind(line.transaction_line_id)
        .bind(prior_sp)
        .bind(line.salesperson_id)
        .bind(corrector_id)
        .bind(body.reason.as_deref())
        .execute(&mut *tx)
        .await
        .map_err(TransactionError::Database)?;
    }

    tx.commit().await.map_err(TransactionError::Database)?;

    if primary_touched || line_attribution_changes > 0 {
        let _ = log_staff_access(
            &state.db,
            corrector_id,
            "attribution_edit",
            json!({
                "transaction_id": transaction_id,
                "line_attribution_changes": line_attribution_changes,
                "primary_salesperson_updated": primary_touched,
                "reason": body.reason,
            }),
        )
        .await;
    }

    Ok(Json(json!({ "status": "updated" })))
}

async fn get_pipeline_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TransactionPipelineStats>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    let stats = crate::logic::transaction_list::query_pipeline_stats(&state.db).await?;
    Ok(Json(stats))
}

async fn get_fulfillment_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::logic::transaction_list::FulfillmentItem>>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    let items = crate::logic::transaction_list::query_fulfillment_queue(&state.db).await?;
    Ok(Json(items))
}
