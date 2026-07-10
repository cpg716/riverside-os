//! Checkout: persist cart → `transactions` + `transaction_lines` in one transaction.

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Error as SqlxError, FromRow, PgPool, Postgres, Transaction};
use std::ops::DerefMut;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_can_approve_manager_access, staff_has_permission,
    ORDERS_CANCEL, ORDERS_MODIFY, ORDERS_REFUND_PROCESS, ORDERS_SUIT_COMPONENT_SWAP, ORDERS_VIEW,
    ORDERS_VOID_SALE, QBO_STAGING_APPROVE,
};
use crate::auth::pins::{self, log_staff_access};
use crate::auth::pos_session;
use crate::logic::custom_orders::{canonical_custom_order_details, known_custom_subtype_for_sku};
use crate::logic::customer_notifications::{
    record_customer_notification, CustomerNotificationChannel, CustomerNotificationKind,
};
use crate::logic::email as store_email;
use crate::logic::gift_card_ops;
use crate::logic::helcim;
use crate::logic::loyalty as loyalty_logic;
use crate::logic::order_lifecycle;
use crate::logic::podium::{self, looks_like_email};
use crate::logic::podium_messaging;
use crate::logic::podium_reviews;
use crate::logic::pos_rms_charge;
use crate::logic::receipt_escpos;
use crate::logic::receipt_plain_text;
use crate::logic::receipt_shared;
use crate::logic::receipt_studio_html;
use crate::logic::store_credit;
use crate::logic::suit_component_swap::{self, SuitSwapInput, SuitSwapOutcome};
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd, round_money_usd, TaxCategory};
use crate::logic::transaction_recalc;
use crate::logic::transaction_returns::{self, ReturnLineInput};
use crate::middleware;
use crate::models::{
    DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderItemLifecycleStatus, DbOrderStatus,
    DbTransactionCategory,
};

#[cfg(test)]
static FAIL_CARD_REFUND_LEDGER_AFTER_PROVIDER_APPROVAL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

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
    #[error("Transaction not found")]
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
            TransactionError::NotFound => {
                (StatusCode::NOT_FOUND, "Transaction not found".to_string())
            }
            TransactionError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            TransactionError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            TransactionError::BadGateway(m) => (StatusCode::BAD_GATEWAY, m),
            TransactionError::Database(e) => {
                if matches!(&e, SqlxError::RowNotFound) {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Transaction not found" })),
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
pub struct TransactionCustomerSummary {
    pub id: Uuid,
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TransactionWeddingSummary {
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
    pub booked_at: DateTime<Utc>,
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
    pub tax_category: String,
    pub fulfillment: DbFulfillmentType,
    pub order_lifecycle_status: DbOrderItemLifecycleStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alteration_status: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub po_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub po_line_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub po_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_eta: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_for_pickup_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picked_up_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipped_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipment_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fulfilled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TransactionLineLifecycleEvent {
    pub id: Uuid,
    pub transaction_line_id: Uuid,
    pub old_status: Option<DbOrderItemLifecycleStatus>,
    pub new_status: DbOrderItemLifecycleStatus,
    pub actor_staff_id: Option<Uuid>,
    pub actor_name: Option<String>,
    pub source_workflow: String,
    pub reason: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TransactionDetailedPayment {
    pub date: DateTime<Utc>,
    pub method: String,
    pub amount: Decimal,
    pub cash_tendered: Option<Decimal>,
    pub change_due: Option<Decimal>,
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
    pub is_counterpoint_import: bool,
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
    #[serde(default)]
    pub pickup_applications: Vec<TransactionPickupApplication>,
    pub operator_staff_id: Option<Uuid>,
    pub operator_name: Option<String>,
    pub primary_salesperson_id: Option<Uuid>,
    pub primary_salesperson_name: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wedding_summary: Option<TransactionWeddingSummary>,
    pub customer: Option<TransactionCustomerSummary>,
    pub financial_summary: TransactionFinancialSummary,
    pub linked_alteration_summary: TransactionLinkedAlterationSummary,
    #[serde(default)]
    pub linked_alterations: Vec<TransactionLinkedAlteration>,
    pub items: Vec<TransactionDetailItem>,
    #[serde(default)]
    pub lifecycle_events: Vec<TransactionLineLifecycleEvent>,
    pub is_tax_exempt: bool,
    pub tax_exempt_reason: Option<String>,
    pub register_session_id: Option<Uuid>,
    /// Set from `store_settings.receipt_config`: exported HTML exists for Receipt Builder merge.
    #[serde(default)]
    pub receipt_studio_layout_available: bool,
    /// `escpos` (thermal) or `studio_html` (browser print of merged HTML).
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
    #[serde(default)]
    pub customer_review_requests_opt_out: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub void_record: Option<TransactionVoidDetail>,
    #[serde(default)]
    pub payments: Vec<TransactionDetailedPayment>,
}

#[derive(Debug, Serialize)]
pub struct TransactionFinancialSummary {
    pub total_allocated_payments: Decimal,
    pub total_applied_deposit_amount: Decimal,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TransactionVoidDetail {
    pub id: Uuid,
    pub transaction_id: Uuid,
    pub original_status: DbOrderStatus,
    pub original_total_price: Decimal,
    pub original_amount_paid: Decimal,
    pub original_balance_due: Decimal,
    pub register_session_id: Option<Uuid>,
    pub voided_by_staff_id: Option<Uuid>,
    pub voided_by_staff_name: Option<String>,
    pub manager_staff_id: Uuid,
    pub manager_staff_name: Option<String>,
    pub reason: String,
    pub reversal_status: String,
    pub refundable_amount: Decimal,
    pub refund_queue_id: Option<Uuid>,
    pub tender_summary: serde_json::Value,
    pub inventory_summary: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TransactionLinkedAlterationSummary {
    pub open_count: i64,
    pub overdue_count: i64,
    pub ready_count: i64,
    pub picked_up_count: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TransactionLinkedAlteration {
    pub id: Uuid,
    pub status: String,
    pub item_description: Option<String>,
    pub work_requested: String,
    pub source_sku: Option<String>,
    pub ticket_number: Option<String>,
    pub source_transaction_line_id: Option<Uuid>,
    pub picked_up_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransactionPaymentApplication {
    pub target_transaction_id: Uuid,
    pub target_display_id: String,
    pub amount: Decimal,
    pub remaining_balance: Decimal,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransactionPickupApplicationItem {
    pub product_name: String,
    pub sku: String,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub variation_label: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TransactionPickupApplication {
    pub target_transaction_id: Uuid,
    pub target_display_id: String,
    pub items: Vec<TransactionPickupApplicationItem>,
}

impl TransactionDetailResponse {
    fn selected_receipt_items<'a>(
        &'a self,
        transaction_line_ids: Option<&[Uuid]>,
    ) -> Result<Vec<&'a TransactionDetailItem>, TransactionError> {
        use std::collections::HashSet;

        // Include ALL items regardless of is_internal — internal lines (RMS charge
        // payments, gift card loads, alteration services) represent real financial
        // activity that must appear on the customer receipt.
        let selected: Vec<&TransactionDetailItem> = match transaction_line_ids {
            None => self.items.iter().collect(),
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
                    .filter(|it| set.contains(&it.transaction_line_id))
                    .collect();
                if v.is_empty() {
                    return Err(TransactionError::InvalidPayload(
                        "No order lines matched transaction_line_ids for this order.".to_string(),
                    ));
                }
                v
            }
        };

        Ok(selected)
    }

    /// Build customer-facing receipt data. When `transaction_line_ids` is `Some`, only those lines are
    /// included (must match at least one line or returns `InvalidPayload`).
    pub(crate) fn build_receipt_data(
        &self,
        transaction_line_ids: Option<&[Uuid]>,
    ) -> Result<receipt_shared::ReceiptOrder, TransactionError> {
        let selected = self.selected_receipt_items(transaction_line_ids)?;
        let payment_only = selected.is_empty() && !self.payment_applications.is_empty();
        let mut receipt_items: Vec<receipt_shared::ReceiptLine> = if payment_only {
            self.payment_applications
                .iter()
                .map(|app| receipt_shared::ReceiptLine {
                    product_name: format!("Applied payment to {}", app.target_display_id),
                    sku: app.target_display_id.clone(),
                    quantity: 1,
                    unit_price: app.amount,
                    fulfillment: DbFulfillmentType::Takeaway,
                    salesperson_name: None,
                    variation_label: None,
                    original_unit_price: None,
                    discount_event_label: None,
                    gift_card_load_code: None,
                    custom_order_details: None,
                    custom_item_type: None,
                    is_fulfilled: true,
                    adjustment: None,
                    contributes_to_totals: true,
                })
                .collect()
        } else {
            let mut lines = Vec::new();
            for it in &selected {
                let effective_qty = (it.quantity - it.quantity_returned).max(0);
                if effective_qty > 0 {
                    lines.push(receipt_shared::ReceiptLine {
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
                        gift_card_load_code: it.gift_card_load_code.clone(),
                        custom_order_details: it.custom_order_details.clone(),
                        custom_item_type: it.custom_item_type.clone(),
                        is_fulfilled: it.is_fulfilled,
                        adjustment: None,
                        contributes_to_totals: true,
                    });
                }
                if it.quantity_returned > 0 {
                    let refund_unit = (it.unit_price + it.state_tax + it.local_tax).round_dp(2);
                    lines.push(receipt_shared::ReceiptLine {
                        product_name: it.product_name.clone(),
                        sku: it.sku.clone(),
                        quantity: it.quantity_returned,
                        unit_price: -refund_unit,
                        fulfillment: it.fulfillment,
                        salesperson_name: crate::logic::receipt_privacy::mask_name_for_receipt(
                            it.salesperson_name.as_deref(),
                        ),
                        variation_label: it.variation_label.clone(),
                        original_unit_price: None,
                        discount_event_label: Some(
                            "Refund/exchange credit includes item tax where applicable."
                                .to_string(),
                        ),
                        gift_card_load_code: None,
                        custom_order_details: it.custom_order_details.clone(),
                        custom_item_type: it.custom_item_type.clone(),
                        is_fulfilled: true,
                        adjustment: Some(if self.exchange_group_id.is_some() {
                            receipt_shared::ReceiptLineAdjustment::Exchanged
                        } else {
                            receipt_shared::ReceiptLineAdjustment::Returned
                        }),
                        contributes_to_totals: false,
                    });
                }
            }
            lines
        };
        for pickup in &self.pickup_applications {
            for item in &pickup.items {
                receipt_items.push(receipt_shared::ReceiptLine {
                    product_name: item.product_name.clone(),
                    sku: item.sku.clone(),
                    quantity: item.quantity,
                    unit_price: item.unit_price,
                    fulfillment: DbFulfillmentType::Takeaway,
                    salesperson_name: None,
                    variation_label: item.variation_label.clone(),
                    original_unit_price: None,
                    discount_event_label: Some(format!(
                        "Picked up from {}",
                        pickup.target_display_id
                    )),
                    gift_card_load_code: None,
                    custom_order_details: None,
                    custom_item_type: Some("linked_pickup".to_string()),
                    is_fulfilled: true,
                    adjustment: None,
                    contributes_to_totals: false,
                });
            }
        }
        if receipt_items.is_empty() {
            return Err(TransactionError::InvalidPayload(
                "No order lines matched this receipt request.".to_string(),
            ));
        }
        let subtotal_price = receipt_items
            .iter()
            .filter(|it| it.contributes_to_totals)
            .fold(Decimal::ZERO, |sum, it| {
                sum + it.unit_price * Decimal::from(it.quantity)
            })
            .round_dp(2);
        let tax_total = if payment_only {
            Decimal::ZERO
        } else {
            selected.iter().fold(Decimal::ZERO, |sum, it| {
                let effective_qty = (it.quantity - it.quantity_returned).max(0);
                sum + (it.state_tax + it.local_tax) * Decimal::from(effective_qty)
            })
        };
        let total_savings = if payment_only {
            Decimal::ZERO
        } else {
            selected.iter().fold(Decimal::ZERO, |sum, it| {
                let effective_qty = (it.quantity - it.quantity_returned).max(0);
                match it.receipt_original_unit_price {
                    Some(original) if original > it.unit_price && original > Decimal::ZERO => {
                        sum + (original - it.unit_price) * Decimal::from(effective_qty)
                    }
                    _ => sum,
                }
            })
        };
        let receipt_total_price = if payment_only {
            subtotal_price
        } else {
            self.total_price
        };

        Ok(receipt_shared::ReceiptOrder {
            transaction_id: self.transaction_id,
            transaction_display_id: self.transaction_display_id.clone(),
            booked_at: self.booked_at,
            status: self.status,
            subtotal_price,
            tax_total,
            total_price: receipt_total_price,
            total_savings,
            amount_paid: self.amount_paid,
            balance_due: self.balance_due,
            payment_methods_summary: self.payment_methods_summary.clone(),
            payment_applications: self
                .payment_applications
                .iter()
                .map(|app| receipt_shared::ReceiptPaymentApplication {
                    target_display_id: app.target_display_id.clone(),
                    amount: app.amount,
                    remaining_balance: app.remaining_balance,
                })
                .collect(),
            is_tax_exempt: self.is_tax_exempt,
            tax_exempt_reason: self.tax_exempt_reason.clone(),
            cashier_name: crate::logic::receipt_privacy::mask_name_for_receipt(
                self.operator_name.as_deref(),
            ),
            salesperson_display_name: crate::logic::receipt_privacy::mask_name_for_receipt(
                self.primary_salesperson_name.as_deref(),
            ),
            customer: self.customer.as_ref().map(|c| {
                let full = format!("{} {}", c.first_name.trim(), c.last_name.trim())
                    .trim()
                    .to_string();
                receipt_shared::ReceiptCustomerLine {
                    display_name: if full.is_empty() {
                        "—".to_string()
                    } else {
                        full
                    },
                    phone: c.phone.clone(),
                    customer_code: Some(c.customer_code.clone()),
                }
            }),
            items: receipt_items,
            fulfillment_method: self.fulfillment_method,
            payments: self
                .payments
                .iter()
                .map(|p| receipt_shared::ReceiptPayment {
                    date: p.date,
                    method: p.method.clone(),
                    amount: p.amount,
                    cash_tendered: p.cash_tendered,
                    change_due: p.change_due,
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use sqlx::Connection;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    static HELCIM_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn build_test_state(pool: PgPool) -> AppState {
        AppState {
            db: pool,
            global_employee_markup: Decimal::new(15, 0),
            http_client: reqwest::Client::new(),
            podium_token_cache: std::sync::Arc::new(tokio::sync::Mutex::new(
                crate::logic::podium::PodiumTokenCache::default(),
            )),
            database_url: "postgres://test".to_string(),
            counterpoint_sync_token: None,
            wedding_events: crate::logic::wedding_push::WeddingEventBus::new(),
            store_customer_jwt_secret: std::sync::Arc::<[u8]>::from(
                b"rosie-operational-test".as_slice(),
            ),
            store_account_rate: std::sync::Arc::new(tokio::sync::Mutex::new(
                crate::api::store_account_rate::StoreAccountRateState::default(),
            )),
            store_account_unauth_post_per_minute_ip: 0,
            store_account_authed_per_minute: 0,
            meilisearch: None,
            rosie_speech_state: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            server_log_ring: crate::observability::ServerLogRing::new(32, 512),
            cache: None,
            metrics_collector: None,
            rate_limit: crate::middleware::rate_limit::rate_limit_middleware(),
            github_token: None,
        }
    }

    fn sample_transaction_detail(items: Vec<TransactionDetailItem>) -> TransactionDetailResponse {
        TransactionDetailResponse {
            transaction_id: Uuid::nil(),
            transaction_display_id: "TXN-TEST".to_string(),
            booked_at: Utc::now(),
            status: DbOrderStatus::Open,
            total_price: Decimal::new(1000, 2),
            amount_paid: Decimal::new(1000, 2),
            balance_due: Decimal::ZERO,
            is_counterpoint_import: false,
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
            pickup_applications: Vec::new(),
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
            linked_alteration_summary: TransactionLinkedAlterationSummary {
                open_count: 0,
                overdue_count: 0,
                ready_count: 0,
                picked_up_count: 0,
            },
            linked_alterations: Vec::new(),
            items,
            lifecycle_events: Vec::new(),
            is_tax_exempt: false,
            tax_exempt_reason: None,
            register_session_id: None,
            receipt_studio_layout_available: false,
            receipt_thermal_mode: "escpos".to_string(),
            store_review_invites_enabled: false,
            store_send_review_invite_by_default: false,
            review_invite_sent_at: None,
            review_invite_suppressed_at: None,
            customer_review_requests_opt_out: false,
            void_record: None,
            payments: Vec::new(),
        }
    }

    fn sample_order_header(total_price: Decimal, is_counterpoint_import: bool) -> OrderHeaderRow {
        OrderHeaderRow {
            id: Uuid::nil(),
            display_id: "TXN-TEST".to_string(),
            booked_at: Utc::now(),
            status: DbOrderStatus::Open,
            total_price,
            amount_paid: total_price,
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
            customer_id: None,
            customer_code: None,
            customer_first_name: None,
            customer_last_name: None,
            customer_phone: None,
            customer_email: None,
            wedding_member_id: None,
            wedding_party_id: None,
            wedding_party_name: None,
            wedding_event_date: None,
            wedding_member_role: None,
            operator_staff_id: None,
            operator_name: None,
            primary_salesperson_id: None,
            primary_salesperson_name: None,
            review_invite_sent_at: None,
            review_invite_suppressed_at: None,
            customer_review_requests_opt_out: false,
            store_review_policy: sqlx::types::Json(json!({})),
            is_tax_exempt: false,
            tax_exempt_reason: None,
            register_session_id: None,
            is_counterpoint_import,
        }
    }

    fn sample_item(quantity: i32, quantity_returned: i32) -> TransactionDetailItem {
        TransactionDetailItem {
            transaction_line_id: Uuid::new_v4(),
            booked_at: Utc::now(),
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
            tax_category: "other".to_string(),
            fulfillment: DbFulfillmentType::Takeaway,
            order_lifecycle_status: DbOrderItemLifecycleStatus::PickedUp,
            alteration_status: None,
            is_fulfilled: true,
            is_internal: false,
            custom_item_type: None,
            custom_order_details: None,
            salesperson_id: None,
            salesperson_name: Some("Taylor Manager".to_string()),
            receipt_original_unit_price: None,
            discount_event_label: None,
            gift_card_load_code: None,
            po_id: None,
            po_line_id: None,
            po_number: None,
            vendor_id: None,
            vendor_name: None,
            vendor_eta: None,
            vendor_reference: None,
            ordered_at: None,
            received_at: None,
            ready_for_pickup_at: None,
            picked_up_at: None,
            shipped_at: None,
            shipment_id: None,
            fulfilled_at: None,
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
    fn counterpoint_legacy_detail_normalizer_restores_discounted_taxable_price() {
        let header = sample_order_header(Decimal::new(6809, 2), true);
        let mut item = sample_item(1, 0);
        item.unit_price = Decimal::new(7500, 2);
        item.state_tax = Decimal::ZERO;
        item.local_tax = Decimal::ZERO;
        item.tax_category = "clothing".to_string();
        let mut items = vec![item];

        normalize_counterpoint_legacy_detail_items(&header, &mut items);

        assert_eq!(items[0].unit_price, Decimal::new(6500, 2));
        assert_eq!(items[0].state_tax, Decimal::ZERO);
        assert_eq!(items[0].local_tax, Decimal::new(309, 2));
        assert_eq!(
            items[0].receipt_original_unit_price,
            Some(Decimal::new(7500, 2))
        );
        assert_eq!(
            items[0].discount_event_label.as_deref(),
            Some("Counterpoint imported discount")
        );
    }

    #[test]
    fn counterpoint_legacy_detail_normalizer_leaves_explicit_tax_rows_unchanged() {
        let header = sample_order_header(Decimal::new(7069, 2), true);
        let mut item = sample_item(1, 0);
        item.unit_price = Decimal::new(6500, 2);
        item.state_tax = Decimal::new(260, 2);
        item.local_tax = Decimal::new(309, 2);
        item.tax_category = "clothing".to_string();
        let mut items = vec![item];

        normalize_counterpoint_legacy_detail_items(&header, &mut items);

        assert_eq!(items[0].unit_price, Decimal::new(6500, 2));
        assert_eq!(items[0].state_tax, Decimal::new(260, 2));
        assert_eq!(items[0].local_tax, Decimal::new(309, 2));
        assert_eq!(items[0].receipt_original_unit_price, None);
    }

    #[test]
    fn receipt_builder_uses_effective_quantity_after_partial_return() {
        let detail = sample_transaction_detail(vec![sample_item(3, 1)]);

        let receipt = detail.build_receipt_data(None).expect("receipt builds");

        assert_eq!(receipt.items.len(), 2);
        assert_eq!(receipt.items[0].quantity, 2);
        assert_eq!(
            receipt.items[1].adjustment,
            Some(receipt_shared::ReceiptLineAdjustment::Returned)
        );
        assert_eq!(receipt.items[1].quantity, 1);
        assert_eq!(receipt.items[1].unit_price, Decimal::new(-26500, 2));
    }

    #[test]
    fn receipt_builder_prints_fully_returned_lines_as_adjustments() {
        let detail = sample_transaction_detail(vec![sample_item(2, 2), sample_item(1, 0)]);

        let receipt = detail.build_receipt_data(None).expect("receipt builds");

        assert_eq!(receipt.items.len(), 2);
        assert_eq!(receipt.items[0].quantity, 2);
        assert_eq!(
            receipt.items[0].adjustment,
            Some(receipt_shared::ReceiptLineAdjustment::Returned)
        );
        assert_eq!(receipt.items[1].quantity, 1);
        assert_eq!(receipt.items[1].sku, "SKU-1");
    }

    #[test]
    fn receipt_builder_allows_subset_when_all_selected_lines_were_returned() {
        let returned = sample_item(1, 1);
        let active = sample_item(2, 0);
        let returned_id = returned.transaction_line_id;
        let detail = sample_transaction_detail(vec![returned, active]);

        let receipt = detail
            .build_receipt_data(Some(&[returned_id]))
            .expect("returned-only subset should print");

        assert_eq!(receipt.items.len(), 1);
        assert_eq!(
            receipt.items[0].adjustment,
            Some(receipt_shared::ReceiptLineAdjustment::Returned)
        );
        assert!(!receipt.items[0].contributes_to_totals);
    }

    #[test]
    fn receipt_builder_includes_internal_lines_on_receipt() {
        // Internal lines (RMS charge payments, gift card loads) must appear on receipts.
        let detail = sample_transaction_detail(vec![sample_internal_item()]);

        let receipt = detail
            .build_receipt_data(None)
            .expect("internal-only receipt should build");

        assert_eq!(
            receipt.items.len(),
            1,
            "internal line should appear on the receipt"
        );
        assert_eq!(receipt.items[0].sku, "ROS-RMS-CHARGE-PAYMENT");
        assert_eq!(receipt.total_price, Decimal::new(1000, 2));
        assert_eq!(receipt.payment_methods_summary, "Card");
    }

    #[test]
    fn receipt_builder_includes_linked_pickup_without_changing_sale_totals() {
        let mut detail = sample_transaction_detail(vec![sample_item(1, 0)]);
        detail.pickup_applications = vec![TransactionPickupApplication {
            target_transaction_id: Uuid::new_v4(),
            target_display_id: "TXN-OLD".to_string(),
            items: vec![TransactionPickupApplicationItem {
                product_name: "Picked-up Suit".to_string(),
                sku: "PICKUP-SKU".to_string(),
                quantity: 1,
                unit_price: Decimal::new(26000, 2),
                variation_label: Some("42R".to_string()),
            }],
        }];

        let receipt = detail.build_receipt_data(None).expect("receipt builds");

        assert_eq!(receipt.items.len(), 2);
        assert_eq!(receipt.items[1].sku, "PICKUP-SKU");
        assert_eq!(
            receipt.items[1].discount_event_label.as_deref(),
            Some("Picked up from TXN-OLD")
        );
        assert!(!receipt.items[1].contributes_to_totals);
        assert_eq!(receipt.subtotal_price, Decimal::new(25000, 2));
        assert_eq!(receipt.total_price, Decimal::new(1000, 2));
    }

    #[test]
    fn receipt_builder_allows_order_payment_only_receipt() {
        let mut detail = sample_transaction_detail(Vec::new());
        detail.payment_applications = vec![TransactionPaymentApplication {
            target_transaction_id: Uuid::new_v4(),
            target_display_id: "TXN-ORDER".to_string(),
            amount: Decimal::new(5000, 2),
            remaining_balance: Decimal::ZERO,
        }];
        detail.total_price = Decimal::ZERO;
        detail.amount_paid = Decimal::new(5000, 2);
        detail.balance_due = Decimal::ZERO;

        let receipt = detail
            .build_receipt_data(None)
            .expect("payment-only receipt should build");

        assert_eq!(receipt.items.len(), 1);
        assert_eq!(
            receipt.items[0].product_name,
            "Applied payment to TXN-ORDER"
        );
        assert_eq!(receipt.items[0].unit_price, Decimal::new(5000, 2));
        assert_eq!(receipt.payment_applications.len(), 1);
        assert_eq!(
            receipt.payment_applications[0].target_display_id,
            "TXN-ORDER"
        );
        assert_eq!(receipt.total_price, Decimal::new(5000, 2));
        assert_eq!(receipt.amount_paid, Decimal::new(5000, 2));
    }

    #[test]
    fn cash_refund_tender_allows_exact_cash_without_rounding() {
        let (tender, rounding) =
            cash_refund_tender_amount("cash", Decimal::new(5000, 2), None, None)
                .expect("exact cash refund should pass");

        assert_eq!(tender, Decimal::new(5000, 2));
        assert_eq!(rounding, Decimal::ZERO);
    }

    #[test]
    fn cash_refund_tender_allows_zero_payout_when_refund_rounds_down() {
        let (tender, rounding) = cash_refund_tender_amount(
            "cash",
            Decimal::new(2, 2),
            Some(Decimal::ZERO),
            Some(Decimal::new(2, 2)),
        )
        .expect("cash rounding can settle tiny refunds without cash leaving");

        assert_eq!(tender, Decimal::ZERO);
        assert_eq!(rounding, Decimal::new(2, 2));
    }

    #[test]
    fn cash_refund_tender_allows_over_payout_when_refund_rounds_up() {
        let (tender, rounding) = cash_refund_tender_amount(
            "cash",
            Decimal::new(3, 2),
            Some(Decimal::new(5, 2)),
            Some(Decimal::new(-2, 2)),
        )
        .expect("cash rounding can round refund payout up to the nickel");

        assert_eq!(tender, Decimal::new(5, 2));
        assert_eq!(rounding, Decimal::new(-2, 2));
    }

    #[test]
    fn non_cash_refund_tender_rejects_rounding() {
        let err = cash_refund_tender_amount(
            "check",
            Decimal::new(3, 2),
            Some(Decimal::new(5, 2)),
            Some(Decimal::new(-2, 2)),
        )
        .expect_err("non-cash refund tenders cannot use cash rounding");

        assert!(err
            .to_string()
            .contains("cash rounding is only allowed for cash refunds"));
    }

    #[test]
    fn card_refund_idempotency_key_is_stable_until_ledger_records_refund() {
        let refund_queue_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();

        let first = card_refund_idempotency_key(refund_queue_id, 987654, 0, 1234);
        let retry_after_provider_success_before_ledger =
            card_refund_idempotency_key(refund_queue_id, 987654, 0, 1234);
        let next_refund_after_ledger_records_prior_card_refund =
            card_refund_idempotency_key(refund_queue_id, 987654, 1234, 1234);

        assert_eq!(first, retry_after_provider_success_before_ledger);
        assert_ne!(first, next_refund_after_ledger_records_prior_card_refund);
    }

    #[test]
    fn card_refund_audit_reference_scopes_attempt_to_refund_queue() {
        let transaction_id = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let refund_queue_id = Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap();

        assert_eq!(
            card_refund_audit_reference(transaction_id, refund_queue_id),
            "helcim:transactionRefund:22222222-2222-2222-2222-222222222222:33333333-3333-3333-3333-333333333333"
        );
    }

    #[test]
    fn only_approved_card_refund_attempts_can_be_reconciled_without_provider_call() {
        let base = DurableCardRefundAttempt {
            id: Uuid::new_v4(),
            status: "approved".to_string(),
            idempotency_key: "key".to_string(),
            provider_payment_id: Some("refund-1".to_string()),
            provider_transaction_id: Some("refund-1".to_string()),
        };
        assert!(base.is_approved());

        let failed = DurableCardRefundAttempt {
            status: "failed".to_string(),
            ..base
        };
        assert!(!failed.is_approved());
    }

    #[tokio::test]
    async fn card_refund_retry_reuses_approved_attempt_after_local_ledger_failure() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let _env_guard = HELCIM_ENV_LOCK.lock().await;
        let previous_token = std::env::var("HELCIM_API_TOKEN").ok();
        let previous_base_url = std::env::var("HELCIM_API_BASE_URL").ok();

        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");
        let state = build_test_state(pool.clone());
        let mock = MockServer::start().await;
        std::env::set_var("HELCIM_API_TOKEN", "test-helcim-token");
        std::env::set_var("HELCIM_API_BASE_URL", mock.uri());

        Mock::given(method("POST"))
            .and(path("/payment/refund"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "transactionId": "777000123",
                "status": "APPROVED",
                "amount": "100.00",
                "currency": "USD",
                "cardType": "VISA",
                "approvalCode": "SIMOK",
                "cardNumber": "4242424242424242"
            })))
            .mount(&mock)
            .await;

        let staff_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let till_close_group_id = Uuid::new_v4();
        let transaction_id = Uuid::new_v4();
        let original_payment_id = Uuid::new_v4();
        let refund_queue_id = Uuid::new_v4();
        let test_suffix = Uuid::new_v4().simple().to_string();
        let cashier_code = format!("T{}", &test_suffix[..9]);
        let display_id = format!("TXN-DUR-{}", &test_suffix[..12]);
        let original_provider_transaction_id =
            (9_000_000_000_i64 + (Utc::now().timestamp_micros() % 900_000_000)).to_string();
        let session_ordinal = 9_000_000_000_i64 + (Utc::now().timestamp_micros() % 900_000_000);
        let register_lane: i16 = sqlx::query_scalar(
            r#"
            SELECT gs.lane::smallint
            FROM generate_series(1, 99) AS gs(lane)
            WHERE NOT EXISTS (
                SELECT 1
                FROM register_sessions rs
                WHERE rs.is_open = TRUE AND rs.register_lane = gs.lane
            )
            LIMIT 1
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("find open register lane for refund durability test");

        sqlx::query(
            r#"
            INSERT INTO staff (id, full_name, cashier_code, role, is_active, pin_hash)
            VALUES ($1, 'Refund Durability Test', $2, 'admin', TRUE, NULL)
            "#,
        )
        .bind(staff_id)
        .bind(&cashier_code)
        .execute(&pool)
        .await
        .expect("insert staff");

        sqlx::query(
            r#"
            INSERT INTO register_sessions (
                id, opened_by, opening_float, lifecycle_status, session_ordinal,
                shift_primary_staff_id, register_lane, till_close_group_id
            )
            VALUES ($1, $2, 0.00, 'open', $3, $2, $4, $5)
            "#,
        )
        .bind(session_id)
        .bind(staff_id)
        .bind(session_ordinal)
        .bind(register_lane)
        .bind(till_close_group_id)
        .execute(&pool)
        .await
        .expect("insert register session");

        sqlx::query(
            r#"
            INSERT INTO transactions (
                id, operator_id, primary_salesperson_id, status, total_price,
                amount_paid, balance_due, display_id, business_date
            )
            VALUES ($1, $2, $2, 'open', 0.00, 100.00, -100.00, $3, CURRENT_DATE)
            "#,
        )
        .bind(transaction_id)
        .bind(staff_id)
        .bind(&display_id)
        .execute(&pool)
        .await
        .expect("insert transaction");

        sqlx::query(
            r#"
            INSERT INTO payment_transactions (
                id, session_id, category, payment_method, amount, status, metadata,
                merchant_fee, net_amount, payment_provider, provider_payment_id,
                provider_status, provider_transaction_id, effective_date
            )
            VALUES (
                $1, $2, 'retail_sale', 'card_present', 100.00, 'approved', $3,
                0.00, 100.00, 'helcim', $4, 'approved', $4, CURRENT_DATE
            )
            "#,
        )
        .bind(original_payment_id)
        .bind(session_id)
        .bind(json!({ "kind": "test_original_card_payment" }))
        .bind(&original_provider_transaction_id)
        .execute(&pool)
        .await
        .expect("insert original payment");

        sqlx::query(
            r#"
            INSERT INTO payment_allocations (
                transaction_id, target_transaction_id, amount_allocated, metadata
            )
            VALUES ($1, $2, 100.00, $3)
            "#,
        )
        .bind(original_payment_id)
        .bind(transaction_id)
        .bind(json!({ "kind": "test_original_card_allocation" }))
        .execute(&pool)
        .await
        .expect("insert original allocation");

        sqlx::query(
            r#"
            INSERT INTO transaction_refund_queue (
                id, transaction_id, amount_due, amount_refunded, is_open, reason
            )
            VALUES ($1, $2, 100.00, 0.00, TRUE, 'refund durability regression')
            "#,
        )
        .bind(refund_queue_id)
        .bind(transaction_id)
        .execute(&pool)
        .await
        .expect("insert refund queue");

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-riverside-staff-code",
            HeaderValue::from_str(&cashier_code).expect("staff code header"),
        );
        headers.insert(
            "x-riverside-staff-pin",
            HeaderValue::from_str(&cashier_code).expect("staff pin header"),
        );
        let make_request = || ProcessRefundRequest {
            session_id,
            payment_method: "card".to_string(),
            amount: Decimal::new(10000, 2),
            tender_amount: None,
            rounding_adjustment: None,
            final_cash_due: None,
            gift_card_code: None,
            manager_staff_id: None,
            manager_pin: None,
            manager_reason: None,
            external_refund_reference: None,
            return_lines: Vec::new(),
        };

        FAIL_CARD_REFUND_LEDGER_AFTER_PROVIDER_APPROVAL
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let first = process_refund(
            State(state.clone()),
            Path(transaction_id),
            headers.clone(),
            Json(make_request()),
        )
        .await;
        assert!(
            first.is_err(),
            "first refund should hit forced local failure"
        );

        let provider_calls = mock.received_requests().await.expect("mock requests");
        assert_eq!(
            provider_calls.len(),
            1,
            "first attempt should call Helcim exactly once"
        );

        let attempt_after_failure: (Uuid, String, Option<String>, String) = sqlx::query_as(
            r#"
            SELECT id, status, provider_payment_id, idempotency_key
            FROM payment_provider_attempts
            WHERE raw_audit_reference = $1
            "#,
        )
        .bind(card_refund_audit_reference(transaction_id, refund_queue_id))
        .fetch_one(&pool)
        .await
        .expect("approved provider attempt");
        assert_eq!(attempt_after_failure.1, "approved");
        assert_eq!(attempt_after_failure.2.as_deref(), Some("777000123"));

        let local_refund_rows_after_failure: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM payment_transactions
            WHERE metadata->>'provider_attempt_id' = $1
            "#,
        )
        .bind(attempt_after_failure.0.to_string())
        .fetch_one(&pool)
        .await
        .expect("count local rows after failure");
        assert_eq!(local_refund_rows_after_failure, 0);

        let retry = process_refund(
            State(state.clone()),
            Path(transaction_id),
            headers.clone(),
            Json(make_request()),
        )
        .await;
        assert!(
            retry.is_ok(),
            "retry should reconcile from approved attempt"
        );

        let provider_calls = mock.received_requests().await.expect("mock requests");
        assert_eq!(provider_calls.len(), 1, "retry must not call Helcim again");

        let attempts: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM payment_provider_attempts
            WHERE raw_audit_reference = $1
            "#,
        )
        .bind(card_refund_audit_reference(transaction_id, refund_queue_id))
        .fetch_one(&pool)
        .await
        .expect("count provider attempts");
        assert_eq!(attempts, 1);

        let refund_rows: Vec<(Uuid, Decimal, Option<String>, serde_json::Value)> = sqlx::query_as(
            r#"
            SELECT id, amount, provider_payment_id, metadata
            FROM payment_transactions
            WHERE metadata->>'provider_attempt_id' = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(attempt_after_failure.0.to_string())
        .fetch_all(&pool)
        .await
        .expect("load local refund rows");
        assert_eq!(refund_rows.len(), 1);
        assert_eq!(refund_rows[0].1, Decimal::new(-10000, 2));
        assert_eq!(refund_rows[0].2.as_deref(), Some("777000123"));
        assert_eq!(
            refund_rows[0].3["provider_idempotency_key"].as_str(),
            Some(attempt_after_failure.3.as_str())
        );
        assert_eq!(
            refund_rows[0].3["provider_refund_id"].as_str(),
            Some("777000123")
        );

        let allocation_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM payment_allocations
            WHERE transaction_id = $1
              AND target_transaction_id = $2
              AND amount_allocated = -100.00
              AND metadata->>'kind' = 'order_refund'
            "#,
        )
        .bind(refund_rows[0].0)
        .bind(transaction_id)
        .fetch_one(&pool)
        .await
        .expect("count refund allocation rows");
        assert_eq!(allocation_count, 1);

        let queue_state: (Decimal, bool) = sqlx::query_as(
            "SELECT amount_refunded, is_open FROM transaction_refund_queue WHERE id = $1",
        )
        .bind(refund_queue_id)
        .fetch_one(&pool)
        .await
        .expect("load refund queue");
        assert_eq!(queue_state.0, Decimal::new(10000, 2));
        assert!(!queue_state.1);

        let activity_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM transaction_activity_log
            WHERE transaction_id = $1
              AND event_kind = 'refund_processed'
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&pool)
        .await
        .expect("count refund activity");
        assert_eq!(activity_count, 1);

        sqlx::query("DELETE FROM transaction_activity_log WHERE transaction_id = $1")
            .bind(transaction_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query(
            "DELETE FROM payment_allocations WHERE target_transaction_id = $1 OR transaction_id = $2",
        )
        .bind(transaction_id)
        .bind(refund_rows[0].0)
        .execute(&pool)
        .await
        .ok();
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(vec![original_payment_id, refund_rows[0].0])
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM transaction_refund_queue WHERE id = $1")
            .bind(refund_queue_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM payment_provider_attempts WHERE id = $1")
            .bind(attempt_after_failure.0)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM register_sessions WHERE id = $1")
            .bind(session_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM staff WHERE id = $1")
            .bind(staff_id)
            .execute(&pool)
            .await
            .ok();

        match previous_token {
            Some(value) => std::env::set_var("HELCIM_API_TOKEN", value),
            None => std::env::remove_var("HELCIM_API_TOKEN"),
        }
        match previous_base_url {
            Some(value) => std::env::set_var("HELCIM_API_BASE_URL", value),
            None => std::env::remove_var("HELCIM_API_BASE_URL"),
        }
    }

    #[tokio::test]
    async fn gift_card_void_reversal_reactivates_depleted_card_and_records_event() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let transaction_id: Uuid = sqlx::query_scalar("SELECT id FROM transactions LIMIT 1")
            .fetch_one(&mut *tx)
            .await
            .expect("existing transaction");
        let session_id: Uuid = sqlx::query_scalar("SELECT id FROM register_sessions LIMIT 1")
            .fetch_one(&mut *tx)
            .await
            .expect("existing register session");
        let card_id = Uuid::new_v4();
        let code = format!("gc-void-{}", Uuid::new_v4().simple());

        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'purchased', 'depleted', 0.00, $3, TRUE, $4)
            "#,
        )
        .bind(card_id)
        .bind(&code)
        .bind(Decimal::new(2500, 2))
        .bind(Utc::now() + chrono::Duration::days(30))
        .execute(&mut *tx)
        .await
        .expect("insert depleted gift card");

        let balance_after = reverse_gift_card_void_tender_in_tx(
            &mut tx,
            &code.to_ascii_uppercase(),
            Decimal::new(1250, 2),
            transaction_id,
            session_id,
        )
        .await
        .expect("void reversal should restore tender");

        assert_eq!(balance_after, Decimal::new(1250, 2));
        let (balance, status): (Decimal, String) = sqlx::query_as(
            "SELECT current_balance, card_status::text FROM gift_cards WHERE id = $1",
        )
        .bind(card_id)
        .fetch_one(&mut *tx)
        .await
        .expect("load restored card");
        assert_eq!(balance, Decimal::new(1250, 2));
        assert_eq!(status, "active");

        let (event_kind, amount, event_balance): (String, Decimal, Decimal) = sqlx::query_as(
            r#"
            SELECT event_kind, amount, balance_after
            FROM gift_card_events
            WHERE gift_card_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(card_id)
        .fetch_one(&mut *tx)
        .await
        .expect("load void reversal event");
        assert_eq!(event_kind, "void_reversal");
        assert_eq!(amount, Decimal::new(1250, 2));
        assert_eq!(event_balance, Decimal::new(1250, 2));

        tx.rollback().await.expect("rollback transaction");
    }

    #[tokio::test]
    async fn store_credit_void_reversal_records_void_specific_ledger_entry() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let customer_id: Uuid = sqlx::query_scalar("SELECT id FROM customers LIMIT 1")
            .fetch_one(&mut *tx)
            .await
            .expect("existing customer");
        let transaction_id: Uuid = sqlx::query_scalar("SELECT id FROM transactions LIMIT 1")
            .fetch_one(&mut *tx)
            .await
            .expect("existing transaction");

        let balance_after = store_credit::credit_refund_in_tx(
            &mut tx,
            customer_id,
            Decimal::new(875, 2),
            transaction_id,
            "transaction_void_reversal",
        )
        .await
        .expect("store credit void reversal should credit account");

        let (amount, ledger_balance, reason): (Decimal, Decimal, String) = sqlx::query_as(
            r#"
            SELECT l.amount, l.balance_after, l.reason
            FROM store_credit_ledger l
            JOIN store_credit_accounts a ON a.id = l.account_id
            WHERE a.customer_id = $1
            ORDER BY l.created_at DESC
            LIMIT 1
            "#,
        )
        .bind(customer_id)
        .fetch_one(&mut *tx)
        .await
        .expect("load store credit ledger");

        assert_eq!(amount, Decimal::new(875, 2));
        assert_eq!(ledger_balance, balance_after);
        assert_eq!(reason, "transaction_void_reversal");

        tx.rollback().await.expect("rollback transaction");
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
    customer_code: Option<String>,
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
    customer_review_requests_opt_out: bool,
    store_review_policy: sqlx::types::Json<serde_json::Value>,
    is_tax_exempt: bool,
    tax_exempt_reason: Option<String>,
    register_session_id: Option<Uuid>,
    is_counterpoint_import: bool,
}

#[derive(Debug, FromRow)]
struct OrderItemRow {
    transaction_line_id: Uuid,
    booked_at: DateTime<Utc>,
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
    tax_category: String,
    fulfillment: DbFulfillmentType,
    order_lifecycle_status: DbOrderItemLifecycleStatus,
    alteration_status: Option<String>,
    is_fulfilled: bool,
    is_internal: bool,
    custom_item_type: Option<String>,
    custom_order_details: Option<serde_json::Value>,
    salesperson_id: Option<Uuid>,
    salesperson_name: Option<String>,
    receipt_original_unit_price: Option<Decimal>,
    discount_event_label: Option<String>,
    gift_card_load_code: Option<String>,
    po_id: Option<Uuid>,
    po_line_id: Option<Uuid>,
    po_number: Option<String>,
    vendor_id: Option<Uuid>,
    vendor_name: Option<String>,
    vendor_eta: Option<NaiveDate>,
    vendor_reference: Option<String>,
    ordered_at: Option<DateTime<Utc>>,
    received_at: Option<DateTime<Utc>>,
    ready_for_pickup_at: Option<DateTime<Utc>>,
    picked_up_at: Option<DateTime<Utc>>,
    shipped_at: Option<DateTime<Utc>>,
    shipment_id: Option<Uuid>,
    fulfilled_at: Option<DateTime<Utc>>,
}

fn counterpoint_legacy_unit_components_from_gross(
    category: TaxCategory,
    unit_gross: Decimal,
) -> (Decimal, Decimal, Decimal) {
    let gross = round_money_usd(unit_gross);
    if gross <= Decimal::ZERO {
        return (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    }

    let candidates = [
        gross,
        round_money_usd(gross / Decimal::new(10475, 4)),
        round_money_usd(gross / Decimal::new(10875, 4)),
    ];

    let mut best = (gross, Decimal::ZERO, Decimal::ZERO);
    let mut best_delta = gross;
    for net in candidates {
        if net < Decimal::ZERO {
            continue;
        }
        let state_tax = nys_state_tax_usd(category, net, net);
        let local_tax = erie_local_tax_usd(category, net, net);
        let reconstructed = round_money_usd(net + state_tax + local_tax);
        let delta = (reconstructed - gross).abs();
        if delta < best_delta {
            best = (net, state_tax, local_tax);
            best_delta = delta;
        }
    }

    best
}

fn normalize_counterpoint_legacy_detail_items(
    header: &OrderHeaderRow,
    items: &mut [TransactionDetailItem],
) {
    if !header.is_counterpoint_import || header.is_tax_exempt || items.is_empty() {
        return;
    }
    if items.iter().any(|item| {
        !item.state_tax.is_zero()
            || !item.local_tax.is_zero()
            || item.receipt_original_unit_price.is_some()
    }) {
        return;
    }

    let target_total = round_money_usd(header.total_price);
    if target_total <= Decimal::ZERO {
        return;
    }

    let current_line_total: Decimal = items
        .iter()
        .map(|item| {
            Decimal::from(item.quantity) * (item.unit_price + item.state_tax + item.local_tax)
        })
        .sum();
    if round_money_usd(current_line_total) <= target_total + Decimal::new(1, 2) {
        return;
    }

    let raw_subtotal: Decimal = items
        .iter()
        .map(|item| Decimal::from(item.quantity) * item.unit_price)
        .sum();
    if raw_subtotal <= Decimal::ZERO {
        return;
    }

    let last_positive_index = items.iter().rposition(|item| item.quantity > 0);
    let mut allocated_gross = Decimal::ZERO;
    for (index, item) in items.iter_mut().enumerate() {
        let qty = Decimal::from(item.quantity);
        if qty <= Decimal::ZERO {
            continue;
        }

        let raw_extended = item.unit_price * qty;
        let extended_gross = if Some(index) == last_positive_index {
            round_money_usd(target_total - allocated_gross)
        } else {
            round_money_usd(target_total * raw_extended / raw_subtotal)
        };
        allocated_gross += extended_gross;

        let unit_gross = round_money_usd(extended_gross / qty);
        let category = TaxCategory::from_db_text(&item.tax_category).unwrap_or(TaxCategory::Other);
        let (unit_price, state_tax, local_tax) =
            counterpoint_legacy_unit_components_from_gross(category, unit_gross);

        if item.receipt_original_unit_price.is_none()
            && item.unit_price > unit_price + Decimal::new(1, 2)
        {
            item.receipt_original_unit_price = Some(item.unit_price);
            item.discount_event_label
                .get_or_insert_with(|| "Counterpoint imported discount".to_string());
        }
        item.unit_price = unit_price;
        item.state_tax = state_tax;
        item.local_tax = local_tax;
    }
}

#[derive(Debug, FromRow)]
struct PaymentSummaryRow {
    payment_method: String,
    check_number: Option<String>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, FromRow)]
struct PickupGuardLine {
    sku: String,
    product_name: String,
    order_lifecycle_status: DbOrderItemLifecycleStatus,
    variant_id: Uuid,
    quantity: i32,
    stock_on_hand: i32,
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
pub struct PatchTransactionFinancialDateRequest {
    pub business_date: NaiveDate,
    #[serde(default)]
    pub payment_effective_date: Option<NaiveDate>,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct PickupTransactionRequest {
    #[serde(default)]
    pub delivered_item_ids: Vec<Uuid>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub override_readiness: bool,
    #[serde(default)]
    pub override_reason: Option<String>,
    #[serde(default)]
    pub payment_override_manager_staff_id: Option<Uuid>,
    #[serde(default)]
    pub payment_override_manager_pin: Option<String>,
    #[serde(default)]
    pub payment_override_reason: Option<String>,
    /// POS pickup without BO headers when this session has a positive allocation to the order.
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    /// Checkout that collected payment or new sale lines alongside this pickup.
    #[serde(default)]
    pub checkout_transaction_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ShipTransactionRequest {
    #[serde(default)]
    pub shipped_item_ids: Vec<Uuid>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub override_readiness: bool,
    #[serde(default)]
    pub override_reason: Option<String>,
    /// POS shipping release without BO headers when the register session is active.
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub shipment_id: Option<Uuid>,
    #[serde(default)]
    pub tracking_number: Option<String>,
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
    #[serde(default)]
    pub order_lifecycle_status: Option<DbOrderItemLifecycleStatus>,
}

#[derive(Debug, Deserialize)]
pub struct PatchTransactionLineRequest {
    pub variant_id: Option<Uuid>,
    pub quantity: Option<i32>,
    pub unit_price: Option<Decimal>,
    pub fulfillment: Option<DbFulfillmentType>,
    #[serde(default)]
    pub order_lifecycle_status: Option<DbOrderItemLifecycleStatus>,
    #[serde(default)]
    pub custom_order_details: Option<serde_json::Value>,
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
pub struct VoidTransactionRequest {
    pub register_session_id: Uuid,
    pub manager_staff_id: Uuid,
    pub manager_pin: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct VoidTransactionResponse {
    pub status: String,
    pub transaction_id: Uuid,
    pub void_record_id: Uuid,
    pub reversal_status: String,
    pub refundable_amount: Decimal,
    pub refund_queue_id: Option<Uuid>,
    pub tender_summary: serde_json::Value,
    pub inventory_summary: serde_json::Value,
    pub detail: TransactionDetailResponse,
    pub pop_cash_drawer: bool,
}

#[derive(Debug, Deserialize)]
pub struct ProcessRefundRequest {
    pub session_id: Uuid,
    pub payment_method: String,
    pub amount: Decimal,
    #[serde(default)]
    pub tender_amount: Option<Decimal>,
    #[serde(default)]
    pub rounding_adjustment: Option<Decimal>,
    #[serde(default)]
    pub final_cash_due: Option<Decimal>,
    /// Required when `payment_method` is a gift-card tender (e.g. `gift_card`).
    #[serde(default)]
    pub gift_card_code: Option<String>,
    /// Optional: Staff ID of the manager authorizing a legacy manual refund override.
    #[serde(default)]
    pub manager_staff_id: Option<Uuid>,
    /// Optional: 4-digit PIN of the manager authorizing a legacy manual refund override.
    #[serde(default)]
    pub manager_pin: Option<String>,
    /// Optional: Reason for the legacy manual refund override.
    #[serde(default)]
    pub manager_reason: Option<String>,
    /// Required for manual card refunds processed outside ROS, such as Helcim dashboard refunds.
    #[serde(default)]
    pub external_refund_reference: Option<String>,
    /// Optional staged return lines to record atomically with the refund.
    #[serde(default)]
    pub return_lines: Vec<TransactionReturnLineBody>,
}

#[derive(Debug, Deserialize)]
pub struct ExchangeRefundRemainderBody {
    pub payment_method: String,
    pub amount: Decimal,
    #[serde(default)]
    pub tender_amount: Option<Decimal>,
    #[serde(default)]
    pub rounding_adjustment: Option<Decimal>,
    #[serde(default)]
    pub final_cash_due: Option<Decimal>,
    #[serde(default)]
    pub gift_card_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExchangeSettlementRequest {
    pub session_id: Uuid,
    pub replacement_transaction_id: Uuid,
    pub exchange_credit_amount: Decimal,
    /// Optional staged return lines to record atomically with the exchange settlement.
    #[serde(default)]
    pub return_lines: Vec<TransactionReturnLineBody>,
    #[serde(default)]
    pub refund_remainder: Option<ExchangeRefundRemainderBody>,
}

#[derive(Debug, Deserialize)]
pub struct PostTransactionReturnsRequest {
    pub lines: Vec<TransactionReturnLineBody>,
    #[serde(default)]
    pub manager_staff_id: Option<Uuid>,
    #[serde(default)]
    pub manager_pin: Option<String>,
    #[serde(default)]
    pub manager_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TransactionReturnLineBody {
    pub transaction_line_id: Uuid,
    pub quantity: i32,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub restock: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct TransactionExchangeLinkBody {
    pub other_transaction_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct PatchTransactionAttributionRequest {
    pub manager_staff_id: Uuid,
    pub manager_pin: String,
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
        .route(
            "/{transaction_id}/financial-date",
            patch(patch_transaction_financial_date),
        )
        .route("/{transaction_id}/pickup", post(mark_transaction_pickup))
        .route("/{transaction_id}/ship", post(mark_transaction_ship))
        .route(
            "/{transaction_id}/review-invite",
            post(post_transaction_review_invite),
        )
        .route("/{transaction_id}/audit", get(get_transaction_audit))
        .route("/{transaction_id}/void", post(post_transaction_void))
        .route("/{transaction_id}/refunds/process", post(process_refund))
        .route(
            "/{transaction_id}/exchange-settlement",
            post(process_exchange_settlement),
        )
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
            "/{transaction_id}/receipt.escpos",
            get(get_transaction_receipt_escpos),
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

fn request_ip_address(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("127.0.0.1")
        .to_string()
}

fn cents_to_decimal_string(amount_cents: i64) -> String {
    let sign = if amount_cents < 0 { "-" } else { "" };
    let abs = amount_cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

fn cash_refund_tender_amount(
    method: &str,
    exact_amount: Decimal,
    tender_amount: Option<Decimal>,
    rounding_adjustment: Option<Decimal>,
) -> Result<(Decimal, Decimal), TransactionError> {
    let tender = tender_amount.unwrap_or(exact_amount).round_dp(2);
    let rounding = rounding_adjustment.unwrap_or(Decimal::ZERO).round_dp(2);
    if tender < Decimal::ZERO {
        return Err(TransactionError::InvalidPayload(
            "cash refund tender amount must be positive".to_string(),
        ));
    }
    if tender.is_zero() && method.trim().to_lowercase() != "cash" {
        return Err(TransactionError::InvalidPayload(
            "zero refund tender is only allowed when cash rounding settles the refund".to_string(),
        ));
    }
    if tender != exact_amount || !rounding.is_zero() {
        if method.trim().to_lowercase() != "cash" {
            return Err(TransactionError::InvalidPayload(
                "cash rounding is only allowed for cash refunds".to_string(),
            ));
        }
        if (tender + rounding).round_dp(2) != exact_amount {
            return Err(TransactionError::InvalidPayload(
                "cash refund tender plus rounding adjustment must equal the exact refund amount"
                    .to_string(),
            ));
        }
    }
    Ok((tender, rounding))
}

#[derive(Debug)]
struct RefundCapacity {
    corrected_amount_due: Decimal,
    void_original_paid: Option<Decimal>,
}

async fn validate_refund_capacity_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    refund: &RefundQueueRow,
    exact_refund_amount: Decimal,
) -> Result<RefundCapacity, TransactionError> {
    let (current_paid, current_balance_due): (Decimal, Decimal) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(amount_paid, 0)::numeric(14,2),
            COALESCE(balance_due, 0)::numeric(14,2)
        FROM transactions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut **tx)
    .await?;
    let void_original_paid: Option<Decimal> = sqlx::query_scalar(
        r#"
        SELECT original_amount_paid::numeric(14,2)
        FROM transaction_void_records
        WHERE transaction_id = $1
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut **tx)
    .await?;
    let queue_remaining = if refund.amount_due > refund.amount_refunded {
        refund.amount_due - refund.amount_refunded
    } else {
        Decimal::ZERO
    };
    let (remaining, corrected_amount_due, paid_capacity) =
        if let Some(original_paid) = void_original_paid {
            let paid_remaining = if original_paid > refund.amount_refunded {
                original_paid - refund.amount_refunded
            } else {
                Decimal::ZERO
            };
            let remaining = if queue_remaining < paid_remaining {
                queue_remaining
            } else {
                paid_remaining
            };
            (remaining, refund.amount_due, original_paid)
        } else {
            let refundable_credit = if current_balance_due < Decimal::ZERO {
                -current_balance_due
            } else {
                Decimal::ZERO
            };
            let remaining = if refundable_credit < current_paid {
                refundable_credit
            } else {
                current_paid
            };
            let corrected_amount_due = refund.amount_refunded + remaining;
            if corrected_amount_due != refund.amount_due {
                sqlx::query(
                    r#"
                    UPDATE transaction_refund_queue
                    SET amount_due = $1
                    WHERE id = $2
                    "#,
                )
                .bind(corrected_amount_due)
                .bind(refund.id)
                .execute(&mut **tx)
                .await?;
            }
            (remaining, corrected_amount_due, current_paid)
        };
    if exact_refund_amount > remaining {
        return Err(TransactionError::InvalidPayload(format!(
            "refund exceeds refundable paid credit of ${remaining}"
        )));
    }
    if exact_refund_amount > paid_capacity {
        return Err(TransactionError::InvalidPayload(
            "refund amount exceeds total amount paid on this order".to_string(),
        ));
    }

    Ok(RefundCapacity {
        corrected_amount_due,
        void_original_paid,
    })
}

#[derive(Debug, FromRow)]
struct DurableCardRefundAttempt {
    id: Uuid,
    status: String,
    idempotency_key: String,
    provider_payment_id: Option<String>,
    provider_transaction_id: Option<String>,
}

impl DurableCardRefundAttempt {
    fn is_approved(&self) -> bool {
        matches!(self.status.as_str(), "approved" | "captured")
    }
}

fn card_refund_audit_reference(transaction_id: Uuid, refund_queue_id: Uuid) -> String {
    format!("helcim:transactionRefund:{transaction_id}:{refund_queue_id}")
}

fn card_refund_idempotency_key(
    refund_queue_id: Uuid,
    original_transaction_id: i64,
    per_card_already_cents: i64,
    amount_cents: i64,
) -> String {
    format!(
        "helcim-refund-{refund_queue_id}-{original_transaction_id}-{per_card_already_cents}-{amount_cents}"
    )
}

fn is_payment_provider_idempotency_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|db_error| db_error.constraint())
        == Some("uq_payment_provider_attempts_provider_idempotency")
}

async fn find_approved_card_refund_attempt(
    db: &PgPool,
    audit_reference: &str,
    amount_cents: i64,
) -> Result<Option<DurableCardRefundAttempt>, TransactionError> {
    sqlx::query_as::<_, DurableCardRefundAttempt>(
        r#"
        SELECT id, status, idempotency_key, provider_payment_id, provider_transaction_id
        FROM payment_provider_attempts
        WHERE provider = 'helcim'
          AND raw_audit_reference = $1
          AND amount_cents = $2
          AND status IN ('approved', 'captured')
          AND provider_payment_id IS NOT NULL
        ORDER BY completed_at DESC NULLS LAST, created_at DESC
        LIMIT 1
        "#,
    )
    .bind(audit_reference)
    .bind(amount_cents)
    .fetch_optional(db)
    .await
    .map_err(TransactionError::Database)
}

async fn find_card_refund_attempt_by_key(
    db: &PgPool,
    idempotency_key: &str,
) -> Result<Option<DurableCardRefundAttempt>, TransactionError> {
    sqlx::query_as::<_, DurableCardRefundAttempt>(
        r#"
        SELECT id, status, idempotency_key, provider_payment_id, provider_transaction_id
        FROM payment_provider_attempts
        WHERE provider = 'helcim'
          AND idempotency_key = $1
        LIMIT 1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(db)
    .await
    .map_err(TransactionError::Database)
}

async fn create_pending_card_refund_attempt(
    db: &PgPool,
    provider_attempt_id: Uuid,
    amount_cents: i64,
    session_id: Uuid,
    idempotency_key: &str,
    original_transaction_id: i64,
    audit_reference: &str,
) -> Result<Option<DurableCardRefundAttempt>, TransactionError> {
    let insert_result = sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id,
            idempotency_key, provider_transaction_id, raw_audit_reference
        )
        VALUES ($1, 'helcim', 'pending', $2, 'usd', $3, $4, $5, $6)
        "#,
    )
    .bind(provider_attempt_id)
    .bind(amount_cents)
    .bind(session_id)
    .bind(idempotency_key)
    .bind(original_transaction_id.to_string())
    .bind(audit_reference)
    .execute(db)
    .await;

    if let Err(error) = insert_result {
        if is_payment_provider_idempotency_violation(&error) {
            return find_card_refund_attempt_by_key(db, idempotency_key).await;
        }
        return Err(TransactionError::Database(error));
    }

    Ok(None)
}

async fn mark_card_refund_attempt_failed(
    db: &PgPool,
    provider_attempt_id: Uuid,
    error_code: &str,
    error_message: String,
) -> Result<(), TransactionError> {
    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = 'failed',
            error_code = $2,
            error_message = $3,
            completed_at = now()
        WHERE id = $1
        "#,
    )
    .bind(provider_attempt_id)
    .bind(error_code)
    .bind(error_message)
    .execute(db)
    .await?;
    Ok(())
}

async fn transaction_has_positive_payment_in_session(
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

async fn authenticate_manager_approval(
    state: &AppState,
    staff_id: Uuid,
    pin: &str,
    denied_message: &'static str,
) -> Result<pins::AuthenticatedStaff, TransactionError> {
    let manager = pins::authenticate_staff_by_id(&state.db, staff_id, Some(pin))
        .await
        .map_err(|_| {
            TransactionError::InvalidPayload("Manager Access was not approved".to_string())
        })?;
    let effective = effective_permissions_for_staff(&state.db, manager.id, manager.role)
        .await
        .map_err(TransactionError::Database)?;
    if !staff_can_approve_manager_access(&effective, manager.role) {
        return Err(TransactionError::Forbidden(denied_message.to_string()));
    }
    Ok(manager)
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

        let in_session =
            transaction_has_positive_payment_in_session(&state.db, transaction_id, sid)
                .await
                .map_err(TransactionError::Database)?;

        if in_session {
            return Ok(None);
        }

        // Any open register session can process returns/exchanges once staff
        // selected the original Transaction Record. Refund tendering remains a
        // separate audited step.
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
) -> Result<Json<podium_reviews::ReviewInviteChoiceResult>, TransactionError> {
    authorize_transaction_read_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    let result = podium_reviews::apply_post_sale_review_choice(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        transaction_id,
        body.skip,
    )
    .await
    .map_err(|e| match e {
        podium_reviews::ReviewInviteError::Db(d) => TransactionError::Database(d),
        podium_reviews::ReviewInviteError::NotFound => TransactionError::NotFound,
        podium_reviews::ReviewInviteError::Podium(podium::PodiumError::NotConfigured) => {
            TransactionError::InvalidPayload(
                "Podium review requests are not configured".to_string(),
            )
        }
        podium_reviews::ReviewInviteError::Podium(err) => {
            TransactionError::BadGateway(format!("Podium review request failed: {err}"))
        }
    })?;
    Ok(Json(result))
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
        if status == DbOrderStatus::Fulfilled {
            return Err(TransactionError::InvalidPayload(
                "Use the pickup or shipment workflow to fulfill a transaction so line status, timestamps, loyalty, commissions, and reporting stay in sync.".to_string(),
            ));
        }

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
                let has_layaway_lines: bool = sqlx::query_scalar(
                    r#"
                    SELECT EXISTS(
                        SELECT 1
                        FROM transaction_lines
                        WHERE transaction_id = $1
                          AND fulfillment = 'layaway'
                    )
                    "#,
                )
                .bind(transaction_id)
                .fetch_one(&mut *tx)
                .await?;
                if !has_layaway_lines {
                    return Err(TransactionError::InvalidPayload(
                        "Forfeiture is only allowed for layaway transactions".to_string(),
                    ));
                }

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
    let register_session_id = body.register_session_id.ok_or_else(|| {
        TransactionError::InvalidPayload(
            "Pickup completion must be run from an open Register session.".to_string(),
        )
    })?;
    middleware::require_pos_register_session_for_checkout(&state, &headers, register_session_id)
        .await
        .map_err(map_perm_err)?;

    let actor_staff_id: Option<Uuid> =
        sqlx::query_scalar("SELECT opened_by FROM register_sessions WHERE id = $1")
            .bind(register_session_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();

    let mut tx = state.db.begin().await?;
    let _locked_transaction: Uuid =
        sqlx::query_scalar("SELECT id FROM transactions WHERE id = $1 FOR UPDATE")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;

    if let Some(checkout_transaction_id) = body.checkout_transaction_id {
        let valid_checkout_link: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM transactions checkout_transaction
                INNER JOIN transactions pickup_transaction ON pickup_transaction.id = $2
                WHERE checkout_transaction.id = $1
                  AND checkout_transaction.id <> pickup_transaction.id
                  AND checkout_transaction.register_session_id = $3
                  AND checkout_transaction.customer_id IS NOT DISTINCT FROM pickup_transaction.customer_id
            )
            "#,
        )
        .bind(checkout_transaction_id)
        .bind(transaction_id)
        .bind(register_session_id)
        .fetch_one(&mut *tx)
        .await?;
        if !valid_checkout_link {
            return Err(TransactionError::InvalidPayload(
                "Pickup checkout link does not match this Register session and customer."
                    .to_string(),
            ));
        }
    }

    let pickup_guard_lines: Vec<PickupGuardLine> = if body.delivered_item_ids.is_empty() {
        sqlx::query_as(
            r#"
            SELECT
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_sku'), '')
                        ELSE NULL
                    END,
                    pv.sku,
                    'Unknown SKU'
                ) AS sku,
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_description'), '')
                        ELSE NULL
                    END,
                    NULLIF(TRIM(p.name), ''),
                    pv.sku,
                    'Unknown item'
                ) AS product_name,
                oi.order_lifecycle_status,
                oi.variant_id,
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::int AS quantity,
                COALESCE(pv.stock_on_hand, 0)::int AS stock_on_hand
            FROM transaction_lines oi
            LEFT JOIN product_variants pv ON pv.id = oi.variant_id
            LEFT JOIN products p ON p.id = oi.product_id
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = $1
              AND oi.is_fulfilled = FALSE
              AND COALESCE(oi.is_internal, false) = FALSE
              AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
            ORDER BY p.name, pv.sku, oi.id
            FOR UPDATE OF oi
            "#,
        )
        .bind(transaction_id)
        .fetch_all(&mut *tx)
        .await?
    } else {
        sqlx::query_as(
            r#"
            SELECT
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_sku'), '')
                        ELSE NULL
                    END,
                    pv.sku,
                    'Unknown SKU'
                ) AS sku,
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_description'), '')
                        ELSE NULL
                    END,
                    NULLIF(TRIM(p.name), ''),
                    pv.sku,
                    'Unknown item'
                ) AS product_name,
                oi.order_lifecycle_status,
                oi.variant_id,
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::int AS quantity,
                COALESCE(pv.stock_on_hand, 0)::int AS stock_on_hand
            FROM transaction_lines oi
            LEFT JOIN product_variants pv ON pv.id = oi.variant_id
            LEFT JOIN products p ON p.id = oi.product_id
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = $1
              AND oi.id = ANY($2)
              AND oi.is_fulfilled = FALSE
              AND COALESCE(oi.is_internal, false) = FALSE
              AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
            ORDER BY p.name, pv.sku, oi.id
            FOR UPDATE OF oi
            "#,
        )
        .bind(transaction_id)
        .bind(&body.delivered_item_ids)
        .fetch_all(&mut *tx)
        .await?
    };

    let unready_lines = pickup_guard_lines
        .iter()
        .filter(|line| line.order_lifecycle_status != DbOrderItemLifecycleStatus::ReadyForPickup)
        .collect::<Vec<_>>();
    let override_reason = body.override_reason.as_deref().map(str::trim).unwrap_or("");
    let mut pickup_payment_override_metadata: Option<serde_json::Value> = None;
    if !unready_lines.is_empty() && !body.override_readiness {
        let examples = unready_lines
            .iter()
            .take(3)
            .map(|line| {
                format!(
                    "{} ({}, {})",
                    line.product_name,
                    line.sku,
                    line.order_lifecycle_status.as_str()
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(TransactionError::InvalidPayload(format!(
            "Pickup blocked: {count} item(s) are not Ready for Pickup. {examples}. Mark items ready first, or use an explicit readiness override with a reason.",
            count = unready_lines.len()
        )));
    }
    if !unready_lines.is_empty() && override_reason.len() < 12 {
        return Err(TransactionError::InvalidPayload(
            "Pickup readiness override requires a clear reason.".to_string(),
        ));
    }

    let (
        amount_paid,
        balance_due,
        is_counterpoint_import,
        already_released_value,
        selected_pickup_value,
        remaining_open_value,
    ): (Decimal, Decimal, bool, Decimal, Decimal, Decimal) = sqlx::query_as(
        r#"
        WITH line_values AS (
            SELECT
                oi.id,
                oi.is_fulfilled,
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)
                  * (GREATEST(COALESCE(oi.unit_price, 0) - COALESCE(oi.discount_amount, 0), 0)
                     + COALESCE(oi.state_tax, 0)
                     + COALESCE(oi.local_tax, 0)) AS line_total
            FROM transaction_lines oi
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = $1
              AND COALESCE(oi.is_internal, false) = FALSE
        )
        SELECT
            COALESCE(MAX(o.amount_paid), 0)::numeric(14,2) AS amount_paid,
            COALESCE(MAX(o.balance_due), 0)::numeric(14,2) AS balance_due,
            BOOL_OR(COALESCE(o.is_counterpoint_import, false)) AS is_counterpoint_import,
            COALESCE(SUM(line_total) FILTER (WHERE line_values.is_fulfilled), 0)::numeric(14,2) AS already_released_value,
            COALESCE(SUM(line_total) FILTER (
                WHERE line_values.is_fulfilled = false
                  AND ($2::boolean OR line_values.id = ANY($3))
            ), 0)::numeric(14,2) AS selected_pickup_value,
            COALESCE(SUM(line_total) FILTER (
                WHERE line_values.is_fulfilled = false
                  AND NOT ($2::boolean OR line_values.id = ANY($3))
            ), 0)::numeric(14,2) AS remaining_open_value
        FROM transactions o
        LEFT JOIN line_values ON TRUE
        WHERE o.id = $1
        GROUP BY o.id
        "#,
    )
    .bind(transaction_id)
    .bind(body.delivered_item_ids.is_empty())
    .bind(&body.delivered_item_ids)
    .fetch_one(&mut *tx)
    .await?;

    let required_after_pickup = already_released_value + selected_pickup_value;
    let imported_paid_in_full_release = is_counterpoint_import
        && balance_due <= Decimal::ZERO
        && remaining_open_value <= Decimal::ZERO;
    if !imported_paid_in_full_release && amount_paid < required_after_pickup {
        let shortage = required_after_pickup - amount_paid;
        return Err(TransactionError::InvalidPayload(format!(
            "Pickup blocked: Balance Due remains because selected item value exceeds payments by ${shortage}. Collect payment before release."
        )));
    }

    let remaining_deposit_required = (remaining_open_value * Decimal::new(50, 2)).round_dp(2);
    let remaining_paid_credit = if imported_paid_in_full_release {
        Decimal::ZERO
    } else {
        amount_paid - required_after_pickup
    };
    if remaining_open_value > Decimal::ZERO && remaining_paid_credit < remaining_deposit_required {
        let shortage = remaining_deposit_required - remaining_paid_credit;
        let payment_override_reason = body
            .payment_override_reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or(
                "Manager approved pickup release with remaining open items below the standard 50% deposit.",
            );
        if payment_override_reason.len() < 12 {
            return Err(TransactionError::InvalidPayload(
                "Manager Access pickup payment override requires a clear reason.".to_string(),
            ));
        }
        let (manager_staff_id, manager_pin) = body
            .payment_override_manager_staff_id
            .zip(body.payment_override_manager_pin.as_deref())
            .ok_or_else(|| {
                TransactionError::InvalidPayload(format!(
                    "Manager Access required: remaining open items need at least a 50% deposit after this pickup. Collect ${shortage} more or approve the release."
                ))
            })?;
        let manager = authenticate_manager_approval(
            &state,
            manager_staff_id,
            manager_pin,
            "Manager Access approval permission required for pickup payment override",
        )
        .await?;
        pickup_payment_override_metadata = Some(json!({
            "payment_override": true,
            "payment_override_manager_staff_id": manager.id,
            "payment_override_reason": payment_override_reason,
            "remaining_open_value": remaining_open_value,
            "remaining_deposit_required": remaining_deposit_required,
            "remaining_paid_credit": remaining_paid_credit,
            "shortage": shortage,
        }));
    }

    let insufficient_stock_lines = pickup_guard_lines
        .iter()
        .filter(|line| line.stock_on_hand < line.quantity)
        .collect::<Vec<_>>();
    let inventory_shortage_details = insufficient_stock_lines
        .iter()
        .map(|line| {
            json!({
                "sku": line.sku,
                "product_name": line.product_name,
                "quantity": line.quantity,
                "stock_on_hand_before_pickup": line.stock_on_hand,
            })
        })
        .collect::<Vec<_>>();
    let has_inventory_shortage = !inventory_shortage_details.is_empty();
    let inventory_shortage_alert = if insufficient_stock_lines.is_empty() {
        None
    } else {
        let examples = insufficient_stock_lines
            .iter()
            .take(3)
            .map(|line| {
                format!(
                    "{} ({}): need {}, had {}",
                    line.product_name, line.sku, line.quantity, line.stock_on_hand
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        Some(format!(
            "Inventory Reconciliation Over-Allocation: pickup completed with insufficient stock on {count} item(s). {examples}",
            count = insufficient_stock_lines.len()
        ))
    };

    let claimed_fulfillment_line_ids: Vec<Uuid> = if body.delivered_item_ids.is_empty() {
        sqlx::query_scalar(
            r#"
            WITH target AS (
                SELECT id
                FROM transaction_lines
                WHERE transaction_id = $1
                  AND is_fulfilled = FALSE
                FOR UPDATE
            ),
            claimed AS (
                UPDATE transaction_lines oi
                SET
                    is_fulfilled = TRUE,
                    fulfilled_at = COALESCE(oi.fulfilled_at, CURRENT_TIMESTAMP)
                FROM target
                WHERE oi.id = target.id
                RETURNING oi.id
            )
            SELECT id FROM claimed
            "#,
        )
        .bind(transaction_id)
        .fetch_all(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            WITH target AS (
                SELECT id
                FROM transaction_lines
                WHERE transaction_id = $1
                  AND id = ANY($2)
                  AND is_fulfilled = FALSE
                FOR UPDATE
            ),
            claimed AS (
                UPDATE transaction_lines oi
                SET
                    is_fulfilled = TRUE,
                    fulfilled_at = COALESCE(oi.fulfilled_at, CURRENT_TIMESTAMP)
                FROM target
                WHERE oi.id = target.id
                RETURNING oi.id
            )
            SELECT id FROM claimed
            "#,
        )
        .bind(transaction_id)
        .bind(&body.delivered_item_ids)
        .fetch_all(&mut *tx)
        .await?
    };

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
          AND COALESCE(oi.is_internal, false) = FALSE
          AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut *tx)
    .await?;
    if remaining_unfulfilled == 0 {
        sqlx::query("UPDATE transactions SET status = 'fulfilled'::order_status, fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP) WHERE id = $1")
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;
    }

    if !claimed_fulfillment_line_ids.is_empty() {
        crate::logic::commission_recalc::recalc_transaction_commissions_after_fulfillment(
            &mut tx,
            transaction_id,
            &claimed_fulfillment_line_ids,
        )
        .await?;
        crate::logic::commission_events::upsert_fulfilled_transaction_events(
            &mut tx,
            transaction_id,
            &claimed_fulfillment_line_ids,
        )
        .await?;
        order_lifecycle::apply_transition_tx(
            &mut tx,
            &claimed_fulfillment_line_ids,
            DbOrderItemLifecycleStatus::PickedUp,
            actor_staff_id,
            "pickup",
            Some("Fulfilled through pickup workflow"),
            json!({
                "transaction_id": transaction_id,
                "register_session_id": register_session_id,
            }),
        )
        .await?;
    }

    // For Special/Custom transactions: the item physically arrives from the vendor and goes
    // into reserved_stock. At pickup, the item leaves the store, so we decrement both
    // stock_on_hand and reserved_stock. Takeaway items already had stock_on_hand
    // decremented at checkout time, so only special/custom need adjustment here.
    let fulfilled_ids = &claimed_fulfillment_line_ids;
    if !fulfilled_ids.is_empty() {
        let pickup_stock_movements: Vec<(Uuid, i32)> = sqlx::query_as(
            r#"
            WITH movement AS (
                SELECT
                    oi.variant_id,
                    SUM(oi.quantity)::int AS qty,
                    SUM(CASE WHEN oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order') THEN oi.quantity ELSE 0 END)::int AS qty_reserved,
                    SUM(CASE WHEN oi.fulfillment::text = 'layaway' THEN oi.quantity ELSE 0 END)::int AS qty_layaway
                FROM transaction_lines oi
                WHERE oi.transaction_id = $1
                  AND oi.id = ANY($2)
                  AND oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
                GROUP BY oi.variant_id
            ),
            locked AS (
                SELECT pv.id, movement.qty, movement.qty_reserved, movement.qty_layaway
                FROM product_variants pv
                JOIN movement ON movement.variant_id = pv.id
                FOR UPDATE OF pv
            ),
            updated AS (
                UPDATE product_variants pv
                SET
                    stock_on_hand  = pv.stock_on_hand - locked.qty,
                    reserved_stock = GREATEST(pv.reserved_stock - locked.qty_reserved, 0),
                    on_layaway     = GREATEST(pv.on_layaway     - locked.qty_layaway, 0)
                FROM locked
                WHERE pv.id = locked.id
                RETURNING pv.id, locked.qty
            )
            SELECT id, qty FROM updated
            "#,
        )
        .bind(transaction_id)
        .bind(fulfilled_ids)
        .fetch_all(&mut *tx)
        .await?;

        for (variant_id, qty) in pickup_stock_movements {
            if qty <= 0 {
                continue;
            }
            sqlx::query(
                r#"
                INSERT INTO inventory_transactions (
                    variant_id, tx_type, quantity_delta, reference_table, reference_id, notes
                )
                VALUES ($1, 'sale', $2, 'transactions', $3, $4)
                "#,
            )
            .bind(variant_id)
            .bind(-qty)
            .bind(transaction_id)
            .bind(format!(
                "Pickup fulfillment stock decrement for transaction {transaction_id}"
            ))
            .execute(&mut *tx)
            .await?;
        }
    }

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;

    let status_after: DbOrderStatus =
        sqlx::query_scalar("SELECT status FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    let who = body
        .actor
        .as_deref()
        .map(str::trim)
        .filter(|actor| !actor.is_empty())
        .unwrap_or("Register");
    insert_transaction_activity_log_tx(
        &mut tx,
        transaction_id,
        customer_id,
        "pickup",
        &format!("Pickup completed in Register by {who}"),
        json!({
            "delivered_item_count": claimed_fulfillment_line_ids.len(),
            "requested_delivered_item_count": body.delivered_item_ids.len(),
            "readiness_override": body.override_readiness,
            "override_reason": if body.override_readiness { Some(override_reason) } else { None::<&str> },
            "payment_override": pickup_payment_override_metadata.is_some(),
            "payment_override_detail": pickup_payment_override_metadata,
            "inventory_shortage_warning": has_inventory_shortage,
            "inventory_shortage_lines": inventory_shortage_details,
            "checkout_transaction_id": body.checkout_transaction_id,
            "delivered_item_ids": claimed_fulfillment_line_ids,
        }),
    )
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

    if let Some(customer_id) = customer_id {
        if let Err(error) = sqlx::query(
            r#"
            INSERT INTO customer_timeline_notes (customer_id, body, created_by)
            VALUES ($1, $2, NULL)
            "#,
        )
        .bind(customer_id)
        .bind(format!("Pickup completed in Register by {who}"))
        .execute(&state.db)
        .await
        {
            tracing::warn!(
                error = %error,
                transaction_id = %transaction_id,
                "pickup customer timeline note failed after pickup committed"
            );
        }
    }

    if let Some(alert_msg) = inventory_shortage_alert {
        if let Err(e) =
            crate::logic::notifications::broadcast_system_alert(&state.db, &alert_msg).await
        {
            tracing::error!(error = %e, "Failed to broadcast system alert for pickup negative stock");
        }
    }

    // Accrue loyalty points if this pickup caused the order to become fully fulfilled.
    if let Err(e) = loyalty_logic::try_accrue_for_order(&state.db, transaction_id).await {
        tracing::error!(error = %e, transaction_id = %transaction_id, "loyalty accrual failed after pickup");
    }

    Ok(Json(json!({
        "status": "ok",
        "warnings": if has_inventory_shortage {
            vec!["Pickup completed with insufficient inventory; negative stock alert recorded.".to_string()]
        } else {
            Vec::<String>::new()
        }
    })))
}

async fn mark_transaction_ship(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ShipTransactionRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let register_session_id = body.register_session_id.ok_or_else(|| {
        TransactionError::InvalidPayload(
            "Shipping completion must be run from an open Register session.".to_string(),
        )
    })?;
    middleware::require_pos_register_session_for_checkout(&state, &headers, register_session_id)
        .await
        .map_err(map_perm_err)?;

    let actor_staff_id: Option<Uuid> =
        sqlx::query_scalar("SELECT opened_by FROM register_sessions WHERE id = $1")
            .bind(register_session_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();

    let mut tx = state.db.begin().await?;
    let _locked_transaction: Uuid =
        sqlx::query_scalar("SELECT id FROM transactions WHERE id = $1 FOR UPDATE")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;

    if let Some(shipment_id) = body.shipment_id {
        let shipment_transaction_id: Option<Uuid> =
            sqlx::query_scalar("SELECT transaction_id FROM shipment WHERE id = $1")
                .bind(shipment_id)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();
        if shipment_transaction_id != Some(transaction_id) {
            return Err(TransactionError::InvalidPayload(
                "Shipment does not belong to this Transaction Record.".to_string(),
            ));
        }
    }

    let ship_guard_lines: Vec<PickupGuardLine> = if body.shipped_item_ids.is_empty() {
        sqlx::query_as(
            r#"
            SELECT
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_sku'), '')
                        ELSE NULL
                    END,
                    pv.sku,
                    'Unknown SKU'
                ) AS sku,
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_description'), '')
                        ELSE NULL
                    END,
                    NULLIF(TRIM(p.name), ''),
                    pv.sku,
                    'Unknown item'
                ) AS product_name,
                oi.order_lifecycle_status,
                oi.variant_id,
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::int AS quantity,
                COALESCE(pv.stock_on_hand, 0)::int AS stock_on_hand
            FROM transaction_lines oi
            LEFT JOIN product_variants pv ON pv.id = oi.variant_id
            LEFT JOIN products p ON p.id = oi.product_id
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = $1
              AND oi.is_fulfilled = FALSE
              AND COALESCE(oi.is_internal, false) = FALSE
              AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
            ORDER BY p.name, pv.sku, oi.id
            FOR UPDATE OF oi
            "#,
        )
        .bind(transaction_id)
        .fetch_all(&mut *tx)
        .await?
    } else {
        sqlx::query_as(
            r#"
            SELECT
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_sku'), '')
                        ELSE NULL
                    END,
                    pv.sku,
                    'Unknown SKU'
                ) AS sku,
                COALESCE(
                    CASE
                        WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                        THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_description'), '')
                        ELSE NULL
                    END,
                    NULLIF(TRIM(p.name), ''),
                    pv.sku,
                    'Unknown item'
                ) AS product_name,
                oi.order_lifecycle_status,
                oi.variant_id,
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::int AS quantity,
                COALESCE(pv.stock_on_hand, 0)::int AS stock_on_hand
            FROM transaction_lines oi
            LEFT JOIN product_variants pv ON pv.id = oi.variant_id
            LEFT JOIN products p ON p.id = oi.product_id
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = $1
              AND oi.id = ANY($2)
              AND oi.is_fulfilled = FALSE
              AND COALESCE(oi.is_internal, false) = FALSE
              AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
            ORDER BY p.name, pv.sku, oi.id
            FOR UPDATE OF oi
            "#,
        )
        .bind(transaction_id)
        .bind(&body.shipped_item_ids)
        .fetch_all(&mut *tx)
        .await?
    };

    if ship_guard_lines.is_empty() {
        return Err(TransactionError::InvalidPayload(
            "No open order lines are available for shipping.".to_string(),
        ));
    }

    let unready_lines = ship_guard_lines
        .iter()
        .filter(|line| line.order_lifecycle_status != DbOrderItemLifecycleStatus::ReadyForPickup)
        .collect::<Vec<_>>();
    let override_reason = body.override_reason.as_deref().map(str::trim).unwrap_or("");
    if !unready_lines.is_empty() && !body.override_readiness {
        let examples = unready_lines
            .iter()
            .take(3)
            .map(|line| {
                format!(
                    "{} ({}, {})",
                    line.product_name,
                    line.sku,
                    line.order_lifecycle_status.as_str()
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(TransactionError::InvalidPayload(format!(
            "Shipping blocked: {count} item(s) are not Ready for Pickup/Shipping. {examples}. Mark items ready first, or use an explicit readiness override with a reason.",
            count = unready_lines.len()
        )));
    }
    if !unready_lines.is_empty() && override_reason.len() < 12 {
        return Err(TransactionError::InvalidPayload(
            "Shipping readiness override requires a clear reason.".to_string(),
        ));
    }

    let (
        amount_paid,
        balance_due,
        is_counterpoint_import,
        already_released_value,
        selected_ship_value,
        remaining_open_value,
    ): (Decimal, Decimal, bool, Decimal, Decimal, Decimal) = sqlx::query_as(
        r#"
        WITH line_values AS (
            SELECT
                oi.id,
                oi.is_fulfilled,
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)
                  * (GREATEST(COALESCE(oi.unit_price, 0) - COALESCE(oi.discount_amount, 0), 0)
                     + COALESCE(oi.state_tax, 0)
                     + COALESCE(oi.local_tax, 0)) AS line_total
            FROM transaction_lines oi
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = $1
              AND COALESCE(oi.is_internal, false) = FALSE
        )
        SELECT
            COALESCE(MAX(o.amount_paid), 0)::numeric(14,2) AS amount_paid,
            COALESCE(MAX(o.balance_due), 0)::numeric(14,2) AS balance_due,
            BOOL_OR(COALESCE(o.is_counterpoint_import, false)) AS is_counterpoint_import,
            COALESCE(SUM(line_total) FILTER (WHERE line_values.is_fulfilled), 0)::numeric(14,2) AS already_released_value,
            COALESCE(SUM(line_total) FILTER (
                WHERE line_values.is_fulfilled = false
                  AND ($2::boolean OR line_values.id = ANY($3))
            ), 0)::numeric(14,2) AS selected_ship_value,
            COALESCE(SUM(line_total) FILTER (
                WHERE line_values.is_fulfilled = false
                  AND NOT ($2::boolean OR line_values.id = ANY($3))
            ), 0)::numeric(14,2) AS remaining_open_value
        FROM transactions o
        LEFT JOIN line_values ON TRUE
        WHERE o.id = $1
        GROUP BY o.id
        "#,
    )
    .bind(transaction_id)
    .bind(body.shipped_item_ids.is_empty())
    .bind(&body.shipped_item_ids)
    .fetch_one(&mut *tx)
    .await?;

    let required_after_ship = already_released_value + selected_ship_value;
    let imported_paid_in_full_release = is_counterpoint_import
        && balance_due <= Decimal::ZERO
        && remaining_open_value <= Decimal::ZERO;
    if !imported_paid_in_full_release && amount_paid < required_after_ship {
        let shortage = required_after_ship - amount_paid;
        return Err(TransactionError::InvalidPayload(format!(
            "Shipping blocked: selected item value exceeds payments by ${shortage}. Collect payment before release."
        )));
    }

    let remaining_deposit_required = (remaining_open_value * Decimal::new(50, 2)).round_dp(2);
    let remaining_paid_credit = if imported_paid_in_full_release {
        Decimal::ZERO
    } else {
        amount_paid - required_after_ship
    };
    if remaining_open_value > Decimal::ZERO && remaining_paid_credit < remaining_deposit_required {
        let shortage = remaining_deposit_required - remaining_paid_credit;
        return Err(TransactionError::InvalidPayload(format!(
            "Shipping blocked: remaining open items need at least a 50% deposit after this shipment. Collect ${shortage} more before release."
        )));
    }

    let insufficient_stock_lines = ship_guard_lines
        .iter()
        .filter(|line| line.stock_on_hand < line.quantity)
        .collect::<Vec<_>>();
    let inventory_shortage_details = insufficient_stock_lines
        .iter()
        .map(|line| {
            json!({
                "sku": line.sku,
                "product_name": line.product_name,
                "quantity": line.quantity,
                "stock_on_hand_before_ship": line.stock_on_hand,
            })
        })
        .collect::<Vec<_>>();
    let has_inventory_shortage = !inventory_shortage_details.is_empty();
    let inventory_shortage_alert = if insufficient_stock_lines.is_empty() {
        None
    } else {
        let examples = insufficient_stock_lines
            .iter()
            .take(3)
            .map(|line| {
                format!(
                    "{} ({}): need {}, had {}",
                    line.product_name, line.sku, line.quantity, line.stock_on_hand
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        Some(format!(
            "Inventory Reconciliation Over-Allocation: shipping completed with insufficient stock on {count} item(s). {examples}",
            count = insufficient_stock_lines.len()
        ))
    };

    let shipped_ids: Vec<Uuid> = if body.shipped_item_ids.is_empty() {
        sqlx::query_scalar(
            r#"
            WITH target AS (
                SELECT id
                FROM transaction_lines
                WHERE transaction_id = $1
                  AND is_fulfilled = FALSE
                FOR UPDATE
            ),
            claimed AS (
                UPDATE transaction_lines oi
                SET
                    is_fulfilled = TRUE,
                    fulfilled_at = COALESCE(oi.fulfilled_at, CURRENT_TIMESTAMP),
                    shipped_at = COALESCE(oi.shipped_at, CURRENT_TIMESTAMP),
                    shipped_by = COALESCE(oi.shipped_by, $2),
                    shipment_id = COALESCE(oi.shipment_id, $3)
                FROM target
                WHERE oi.id = target.id
                RETURNING oi.id
            )
            SELECT id FROM claimed
            "#,
        )
        .bind(transaction_id)
        .bind(actor_staff_id)
        .bind(body.shipment_id)
        .fetch_all(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            WITH target AS (
                SELECT id
                FROM transaction_lines
                WHERE transaction_id = $1
                  AND id = ANY($2)
                  AND is_fulfilled = FALSE
                FOR UPDATE
            ),
            claimed AS (
                UPDATE transaction_lines oi
                SET
                    is_fulfilled = TRUE,
                    fulfilled_at = COALESCE(oi.fulfilled_at, CURRENT_TIMESTAMP),
                    shipped_at = COALESCE(oi.shipped_at, CURRENT_TIMESTAMP),
                    shipped_by = COALESCE(oi.shipped_by, $3),
                    shipment_id = COALESCE(oi.shipment_id, $4)
                FROM target
                WHERE oi.id = target.id
                RETURNING oi.id
            )
            SELECT id FROM claimed
            "#,
        )
        .bind(transaction_id)
        .bind(&body.shipped_item_ids)
        .bind(actor_staff_id)
        .bind(body.shipment_id)
        .fetch_all(&mut *tx)
        .await?
    };

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
        sqlx::query(
            "UPDATE transactions SET status = 'fulfilled'::order_status, fulfillment_method = 'ship'::order_fulfillment_method, fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP), tracking_number = COALESCE($2, tracking_number) WHERE id = $1",
        )
        .bind(transaction_id)
        .bind(body.tracking_number.as_deref().map(str::trim).filter(|v| !v.is_empty()))
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "UPDATE transactions SET fulfillment_method = 'ship'::order_fulfillment_method, tracking_number = COALESCE($2, tracking_number) WHERE id = $1",
        )
        .bind(transaction_id)
        .bind(body.tracking_number.as_deref().map(str::trim).filter(|v| !v.is_empty()))
        .execute(&mut *tx)
        .await?;
    }

    if let Some(shipment_id) = body.shipment_id {
        sqlx::query(
            "UPDATE shipment SET status = 'in_transit'::shipment_status, tracking_number = COALESCE($2, tracking_number), updated_at = NOW() WHERE id = $1",
        )
        .bind(shipment_id)
        .bind(body.tracking_number.as_deref().map(str::trim).filter(|v| !v.is_empty()))
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO shipment_event (shipment_id, kind, message, metadata, staff_id)
            VALUES ($1, 'in_transit', $2, $3, $4)
            "#,
        )
        .bind(shipment_id)
        .bind("Selected transaction lines released for shipping from Register.")
        .bind(json!({
            "transaction_id": transaction_id,
            "shipped_item_count": shipped_ids.len(),
            "tracking_number": body.tracking_number.as_deref().map(str::trim).filter(|v| !v.is_empty()),
        }))
        .bind(actor_staff_id)
        .execute(&mut *tx)
        .await?;
    }

    if !shipped_ids.is_empty() {
        crate::logic::commission_recalc::recalc_transaction_commissions_after_fulfillment(
            &mut tx,
            transaction_id,
            &shipped_ids,
        )
        .await?;
        crate::logic::commission_events::upsert_fulfilled_transaction_events(
            &mut tx,
            transaction_id,
            &shipped_ids,
        )
        .await?;
    }

    if !shipped_ids.is_empty() {
        let ship_stock_movements: Vec<(Uuid, i32)> = sqlx::query_as(
            r#"
            WITH movement AS (
                SELECT
                    oi.variant_id,
                    SUM(oi.quantity)::int AS qty,
                    SUM(CASE WHEN oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order') THEN oi.quantity ELSE 0 END)::int AS qty_reserved,
                    SUM(CASE WHEN oi.fulfillment::text = 'layaway' THEN oi.quantity ELSE 0 END)::int AS qty_layaway
                FROM transaction_lines oi
                WHERE oi.transaction_id = $1
                  AND oi.id = ANY($2)
                  AND oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
                GROUP BY oi.variant_id
            ),
            locked AS (
                SELECT pv.id, movement.qty, movement.qty_reserved, movement.qty_layaway
                FROM product_variants pv
                JOIN movement ON movement.variant_id = pv.id
                FOR UPDATE OF pv
            ),
            updated AS (
                UPDATE product_variants pv
                SET
                    stock_on_hand  = pv.stock_on_hand - locked.qty,
                    reserved_stock = GREATEST(pv.reserved_stock - locked.qty_reserved, 0),
                    on_layaway     = GREATEST(pv.on_layaway     - locked.qty_layaway, 0)
                FROM locked
                WHERE pv.id = locked.id
                RETURNING pv.id, locked.qty
            )
            SELECT id, qty FROM updated
            "#,
        )
        .bind(transaction_id)
        .bind(&shipped_ids)
        .fetch_all(&mut *tx)
        .await?;

        for (variant_id, qty) in ship_stock_movements {
            if qty <= 0 {
                continue;
            }
            sqlx::query(
                r#"
                INSERT INTO inventory_transactions (
                    variant_id, tx_type, quantity_delta, reference_table, reference_id, notes
                )
                VALUES ($1, 'sale', $2, 'transactions', $3, $4)
                "#,
            )
            .bind(variant_id)
            .bind(-qty)
            .bind(transaction_id)
            .bind(format!(
                "Shipping fulfillment stock decrement for transaction {transaction_id}"
            ))
            .execute(&mut *tx)
            .await?;
        }
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
        "shipping",
        &format!("Shipping release completed in Register by {}", who.trim()),
        json!({
            "shipped_item_count": shipped_ids.len(),
            "requested_shipped_item_count": body.shipped_item_ids.len(),
            "shipment_id": body.shipment_id,
            "tracking_number": body.tracking_number.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            "readiness_override": body.override_readiness,
            "override_reason": if body.override_readiness { Some(override_reason) } else { None::<&str> },
            "inventory_shortage_warning": has_inventory_shortage,
            "inventory_shortage_lines": inventory_shortage_details,
        }),
    )
    .await?;

    if let Some(alert_msg) = inventory_shortage_alert {
        if let Err(e) =
            crate::logic::notifications::broadcast_system_alert(&state.db, &alert_msg).await
        {
            tracing::error!(error = %e, "Failed to broadcast system alert for shipping negative stock");
        }
    }

    if let Err(e) = loyalty_logic::try_accrue_for_order(&state.db, transaction_id).await {
        tracing::error!(error = %e, transaction_id = %transaction_id, "loyalty accrual failed after shipping");
    }

    Ok(Json(json!({
        "status": "ok",
        "warnings": if has_inventory_shortage {
            vec!["Shipping completed with insufficient inventory; negative stock alert recorded.".to_string()]
        } else {
            Vec::<String>::new()
        }
    })))
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

#[derive(Debug, FromRow)]
struct VoidReturnCandidate {
    transaction_line_id: Uuid,
    quantity_remaining: i32,
    fulfillment: DbFulfillmentType,
    is_fulfilled: bool,
}

async fn load_void_return_candidates(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
) -> Result<Vec<VoidReturnCandidate>, TransactionError> {
    let rows = sqlx::query_as::<_, VoidReturnCandidate>(
        r#"
        SELECT
            oi.id AS transaction_line_id,
            GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::int AS quantity_remaining,
            oi.fulfillment,
            oi.is_fulfilled
        FROM transaction_lines oi
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE oi.transaction_id = $1
          AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
        ORDER BY oi.id
        "#,
    )
    .bind(transaction_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows)
}

async fn load_void_record(
    pool: &sqlx::PgPool,
    transaction_id: Uuid,
) -> Result<Option<TransactionVoidDetail>, TransactionError> {
    let row = sqlx::query_as::<_, TransactionVoidDetail>(
        r#"
        SELECT
            v.id,
            v.transaction_id,
            v.original_status,
            v.original_total_price,
            v.original_amount_paid,
            v.original_balance_due,
            v.register_session_id,
            v.voided_by_staff_id,
            voided.full_name AS voided_by_staff_name,
            v.manager_staff_id,
            manager.full_name AS manager_staff_name,
            v.reason,
            v.reversal_status,
            v.refundable_amount,
            v.refund_queue_id,
            v.tender_summary,
            v.inventory_summary,
            v.created_at
        FROM transaction_void_records v
        LEFT JOIN staff voided ON voided.id = v.voided_by_staff_id
        LEFT JOIN staff manager ON manager.id = v.manager_staff_id
        WHERE v.transaction_id = $1
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[derive(Debug, sqlx::FromRow)]
struct LinkedPaymentRow {
    id: Uuid,
    payment_method: String,
    payment_provider: Option<String>,
    amount: Decimal,
    provider_transaction_id: Option<String>,
    metadata: Option<serde_json::Value>,
}

fn map_store_credit_void_error(error: store_credit::StoreCreditError) -> TransactionError {
    match error {
        store_credit::StoreCreditError::Database(d) => TransactionError::Database(d),
        store_credit::StoreCreditError::NotFound => TransactionError::InvalidPayload(
            "customer store credit account was not found".to_string(),
        ),
        store_credit::StoreCreditError::InsufficientBalance => TransactionError::InvalidPayload(
            "store credit balance would become negative".to_string(),
        ),
        store_credit::StoreCreditError::ReasonRequired => {
            TransactionError::InvalidPayload("store credit reversal reason is required".to_string())
        }
    }
}

async fn reverse_gift_card_void_tender_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    code: &str,
    amount: Decimal,
    transaction_id: Uuid,
    session_id: Uuid,
) -> Result<Decimal, TransactionError> {
    if amount <= Decimal::ZERO {
        return Err(TransactionError::InvalidPayload(
            "gift card void reversal amount must be greater than zero".to_string(),
        ));
    }

    let normalized_code = gift_card_ops::normalize_gift_card_code(code);
    let row: Option<(Uuid, Decimal)> = sqlx::query_as(
        r#"
        SELECT id, current_balance
        FROM gift_cards
        WHERE UPPER(BTRIM(code::text)) = $1
          AND card_status != 'void'::gift_card_status
        FOR UPDATE
        "#,
    )
    .bind(&normalized_code)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((card_id, current_balance)) = row else {
        return Err(TransactionError::InvalidPayload(
            "gift card tender could not be restored because the card was not found or is void"
                .to_string(),
        ));
    };

    let new_balance = current_balance + amount;
    let new_status = if new_balance > Decimal::ZERO {
        "active"
    } else {
        "depleted"
    };

    sqlx::query(
        r#"
        UPDATE gift_cards
        SET current_balance = $1,
            card_status = $2::gift_card_status
        WHERE id = $3
        "#,
    )
    .bind(new_balance)
    .bind(new_status)
    .bind(card_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO gift_card_events
            (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id, notes)
        VALUES ($1, 'void_reversal', $2, $3, $4, $5, $6)
        "#,
    )
    .bind(card_id)
    .bind(amount)
    .bind(new_balance)
    .bind(transaction_id)
    .bind(session_id)
    .bind("Same-day transaction void restored gift card tender.")
    .execute(&mut **tx)
    .await?;

    Ok(new_balance)
}

async fn post_transaction_void(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<VoidTransactionRequest>,
) -> Result<Json<VoidTransactionResponse>, TransactionError> {
    let voiding_staff =
        middleware::require_staff_with_permission(&state, &headers, ORDERS_REFUND_PROCESS)
            .await
            .map_err(map_perm_err)?;

    if body.reason.trim().len() < 3 {
        return Err(TransactionError::InvalidPayload(
            "void reason is required".to_string(),
        ));
    }

    let manager = authenticate_manager_approval(
        &state,
        body.manager_staff_id,
        &body.manager_pin,
        "Manager Access approval permission required to void a completed transaction",
    )
    .await?;

    let mut tx = state.db.begin().await?;
    type VoidTransactionHeader = (
        Option<Uuid>,
        DbOrderStatus,
        Decimal,
        Decimal,
        Decimal,
        Option<Uuid>,
        DateTime<Utc>,
    );

    let session_open: Option<bool> = sqlx::query_scalar(
        r#"
        SELECT lifecycle_status = 'open'
        FROM register_sessions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(body.register_session_id)
    .fetch_optional(&mut *tx)
    .await?;
    if session_open != Some(true) {
        return Err(TransactionError::InvalidPayload(
            "register session is not open".to_string(),
        ));
    }

    let header: Option<VoidTransactionHeader> = sqlx::query_as(
        r#"
        SELECT
            customer_id,
            status,
            COALESCE(total_price, 0)::numeric(14,2),
            COALESCE(amount_paid, 0)::numeric(14,2),
            COALESCE(balance_due, 0)::numeric(14,2),
            operator_id,
            booked_at
        FROM transactions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((
        customer_id,
        original_status,
        original_total,
        amount_paid,
        balance_due,
        _operator_id,
        booked_at,
    )) = header
    else {
        return Err(TransactionError::NotFound);
    };

    if original_status == DbOrderStatus::Cancelled {
        return Err(TransactionError::InvalidPayload(
            "cancelled transactions cannot be voided".to_string(),
        ));
    }

    let booked_date = booked_at.date_naive();
    let current_date = Utc::now().date_naive();
    if booked_date < current_date {
        return Err(TransactionError::InvalidPayload(
            "Transaction was booked on a previous day and has been settled. Please use the Refund workflow.".to_string(),
        ));
    }

    let existing_void: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM transaction_void_records WHERE transaction_id = $1 FOR UPDATE",
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    if existing_void.is_some() {
        return Err(TransactionError::InvalidPayload(
            "transaction is already voided".to_string(),
        ));
    }

    let candidates = load_void_return_candidates(&mut tx, transaction_id).await?;
    let restock_units: i32 = candidates
        .iter()
        .filter(|line| line.fulfillment == DbFulfillmentType::Takeaway && line.is_fulfilled)
        .map(|line| line.quantity_remaining)
        .sum();

    if !candidates.is_empty() {
        let return_lines = candidates
            .iter()
            .map(|line| ReturnLineInput {
                transaction_line_id: line.transaction_line_id,
                quantity: line.quantity_remaining,
                reason: Some("void".to_string()),
                restock: Some(line.fulfillment == DbFulfillmentType::Takeaway && line.is_fulfilled),
            })
            .collect::<Vec<_>>();
        transaction_returns::apply_transaction_returns_in_tx(
            &mut tx,
            transaction_id,
            Some(manager.id),
            return_lines,
        )
        .await
        .map_err(|e| match e {
            transaction_returns::TransactionReturnError::Db(d) => TransactionError::Database(d),
            transaction_returns::TransactionReturnError::BadRequest(m) => {
                TransactionError::InvalidPayload(m)
            }
        })?;
    }

    let tender_summary: serde_json::Value = sqlx::query_scalar(
        r#"
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'payment_method', method,
                'amount', amount::text,
                'payment_provider', payment_provider,
                'gift_card_code', gift_card_code
            )
            ORDER BY method
        ), '[]'::jsonb)
        FROM (
            SELECT
                pt.payment_method AS method,
                SUM(pa.amount_allocated)::numeric(14,2) AS amount,
                MAX(pt.payment_provider) AS payment_provider,
                MAX(NULLIF(TRIM(pt.metadata->>'gift_card_code'), '')) AS gift_card_code
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pa.target_transaction_id = $1
              AND pa.amount_allocated > 0
            GROUP BY pt.payment_method
        ) tenders
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut *tx)
    .await?;

    let inventory_summary = json!({
        "returned_line_count": candidates.len(),
        "restocked_units": restock_units,
        "restock_rule": "takeaway lines that were fulfilled are returned to stock; order-style lines are not restocked"
    });

    let linked_payments: Vec<LinkedPaymentRow> = sqlx::query_as(
        r#"
        SELECT
            pt.id,
            pt.payment_method,
            pt.payment_provider,
            pt.amount::numeric(14,2) AS amount,
            pt.provider_transaction_id,
            pt.metadata
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
          AND pa.amount_allocated > 0
        "#,
    )
    .bind(transaction_id)
    .fetch_all(&mut *tx)
    .await?;

    let mut pop_cash_drawer = false;

    for payment in &linked_payments {
        if payment.payment_method == "cash" || payment.payment_method == "check" {
            sqlx::query(
                r#"
                UPDATE payment_transactions
                SET status = 'canceled',
                    amount = 0,
                    net_amount = 0,
                    metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                WHERE id = $1
                "#,
            )
            .bind(payment.id)
            .bind(json!({
                "voided_by_transaction_id": transaction_id,
                "voided_at": Utc::now()
            }))
            .execute(&mut *tx)
            .await?;

            if payment.payment_method == "cash" {
                pop_cash_drawer = true;
            }
        } else if payment.payment_provider.as_deref() == Some("helcim") {
            if let Some(ref prov_tx_id) = payment.provider_transaction_id {
                let config = helcim::HelcimConfig::from_env();
                if config.simulator_enabled() {
                    sqlx::query(
                        r#"
                        UPDATE payment_transactions
                        SET status = 'canceled',
                            amount = 0,
                            net_amount = 0,
                            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                        WHERE id = $1
                        "#,
                    )
                    .bind(payment.id)
                    .bind(json!({
                        "voided_by_transaction_id": transaction_id,
                        "voided_at": Utc::now(),
                        "helcim_reverse_simulated": true
                    }))
                    .execute(&mut *tx)
                    .await?;
                } else {
                    let original_tx_id = prov_tx_id.trim().parse::<i64>().map_err(|_| {
                        TransactionError::InvalidPayload(
                            "Invalid Helcim transaction ID format".to_string(),
                        )
                    })?;

                    let request = helcim::HelcimCardReverseRequest {
                        card_transaction_id: original_tx_id,
                        ip_address: "127.0.0.1".to_string(),
                        ecommerce: false,
                    };

                    let attempt_id = Uuid::new_v4();
                    let idempotency_key = format!("helcim-void-reversal-{attempt_id}");

                    match helcim::process_card_reverse(
                        &state.http_client,
                        &config,
                        request,
                        &idempotency_key,
                    )
                    .await
                    {
                        Ok(transaction) => {
                            let status = transaction.normalized_status();
                            sqlx::query(
                                r#"
                                UPDATE payment_transactions
                                SET status = 'canceled',
                                    amount = 0,
                                    net_amount = 0,
                                    metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                                WHERE id = $1
                                "#,
                            )
                            .bind(payment.id)
                            .bind(json!({
                                "voided_by_transaction_id": transaction_id,
                                "voided_at": Utc::now(),
                                "helcim_reversed_status": status,
                                "helcim_reversed_transaction_id": transaction.transaction_id_string()
                            }))
                            .execute(&mut *tx)
                            .await?;
                        }
                        Err(error) => {
                            let err_lower = error.to_lowercase();
                            if err_lower.contains("settled")
                                || err_lower.contains("batch closed")
                                || err_lower.contains("cannot reverse")
                            {
                                return Err(TransactionError::InvalidPayload(
                                    "This card transaction has already been settled and cannot be voided. Please use the Refund workflow instead.".to_string()
                                ));
                            } else {
                                return Err(TransactionError::InvalidPayload(format!(
                                    "Helcim card reversal failed: {error}"
                                )));
                            }
                        }
                    }
                }
            } else {
                sqlx::query(
                    r#"
                    UPDATE payment_transactions
                    SET status = 'canceled',
                        amount = 0,
                        net_amount = 0,
                        metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                    WHERE id = $1
                    "#,
                )
                .bind(payment.id)
                .bind(json!({
                    "voided_by_transaction_id": transaction_id,
                    "voided_at": Utc::now(),
                    "missing_provider_tx_id": true
                }))
                .execute(&mut *tx)
                .await?;
            }
        } else if payment.payment_method == "gift_card" {
            let gc_code = payment
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("gift_card_code"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    TransactionError::InvalidPayload(
                        "gift card void reversal requires gift_card_code metadata".to_string(),
                    )
                })?;
            let balance_after = reverse_gift_card_void_tender_in_tx(
                &mut tx,
                gc_code,
                payment.amount,
                transaction_id,
                body.register_session_id,
            )
            .await?;

            sqlx::query(
                r#"
                UPDATE payment_transactions
                SET status = 'canceled',
                    amount = 0,
                    net_amount = 0,
                    metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                WHERE id = $1
                "#,
            )
            .bind(payment.id)
            .bind(json!({
                "voided_by_transaction_id": transaction_id,
                "voided_at": Utc::now(),
                "gift_card_balance_after": balance_after
            }))
            .execute(&mut *tx)
            .await?;
        } else if payment.payment_method == "store_credit" {
            let customer_id = customer_id.ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "store credit void reversal requires a customer on the transaction".to_string(),
                )
            })?;
            let balance_after = store_credit::credit_refund_in_tx(
                &mut tx,
                customer_id,
                payment.amount,
                transaction_id,
                "transaction_void_reversal",
            )
            .await
            .map_err(map_store_credit_void_error)?;

            sqlx::query(
                r#"
                UPDATE payment_transactions
                SET status = 'canceled',
                    amount = 0,
                    net_amount = 0,
                    metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                WHERE id = $1
                "#,
            )
            .bind(payment.id)
            .bind(json!({
                "voided_by_transaction_id": transaction_id,
                "voided_at": Utc::now(),
                "store_credit_balance_after": balance_after
            }))
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                r#"
                UPDATE payment_transactions
                SET status = 'canceled',
                    amount = 0,
                    net_amount = 0,
                    metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                WHERE id = $1
                "#,
            )
            .bind(payment.id)
            .bind(json!({
                "voided_by_transaction_id": transaction_id,
                "voided_at": Utc::now()
            }))
            .execute(&mut *tx)
            .await?;
        }
    }

    sqlx::query(
        r#"
        UPDATE transactions
        SET status = 'cancelled'::order_status,
            total_price = 0,
            amount_paid = 0,
            balance_due = 0
        WHERE id = $1
        "#,
    )
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;

    loyalty_logic::reverse_order_accrual_in_tx(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;

    let open_refund_queue: Option<RefundQueueRow> = sqlx::query_as(
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
    let refund_queue_id = open_refund_queue.as_ref().map(|queue| queue.id);
    let refundable_amount = open_refund_queue
        .as_ref()
        .map(|queue| {
            let remaining = queue.amount_due - queue.amount_refunded;
            if remaining > Decimal::ZERO {
                remaining
            } else {
                Decimal::ZERO
            }
        })
        .unwrap_or(Decimal::ZERO);
    let reversal_status = if refundable_amount > Decimal::ZERO {
        "pending_refund"
    } else {
        "no_refund_due"
    };

    let void_record_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO transaction_void_records (
            transaction_id,
            original_status,
            original_total_price,
            original_amount_paid,
            original_balance_due,
            register_session_id,
            voided_by_staff_id,
            manager_staff_id,
            reason,
            reversal_status,
            refundable_amount,
            refund_queue_id,
            tender_summary,
            inventory_summary
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
        "#,
    )
    .bind(transaction_id)
    .bind(original_status)
    .bind(original_total)
    .bind(amount_paid)
    .bind(balance_due)
    .bind(body.register_session_id)
    .bind(voiding_staff.id)
    .bind(manager.id)
    .bind(body.reason.trim())
    .bind(reversal_status)
    .bind(refundable_amount)
    .bind(refund_queue_id)
    .bind(&tender_summary)
    .bind(&inventory_summary)
    .fetch_one(&mut *tx)
    .await?;

    insert_transaction_activity_log_tx(
        &mut tx,
        transaction_id,
        customer_id,
        "transaction_voided",
        &format!("Transaction voided; reversal status: {reversal_status}"),
        json!({
            "void_record_id": void_record_id,
            "voided_by_staff_id": voiding_staff.id,
            "manager_staff_id": manager.id,
            "register_session_id": body.register_session_id,
            "reason": body.reason.trim(),
            "refundable_amount": refundable_amount,
            "refund_queue_id": refund_queue_id,
            "tender_summary": tender_summary,
            "inventory_summary": inventory_summary,
            "original_status": original_status,
            "original_total_price": original_total,
            "original_amount_paid": amount_paid,
            "original_balance_due": balance_due,
        }),
    )
    .await?;

    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        manager.id,
        "transaction_voided",
        json!({
            "transaction_id": transaction_id,
            "void_record_id": void_record_id,
            "reason": body.reason.trim(),
        }),
    )
    .await;

    let detail = load_transaction_detail(&state.db, transaction_id).await?;

    Ok(Json(VoidTransactionResponse {
        status: "success".to_string(),
        transaction_id,
        void_record_id,
        reversal_status: reversal_status.to_string(),
        refundable_amount,
        refund_queue_id,
        tender_summary,
        inventory_summary,
        detail,
        pop_cash_drawer,
    }))
}

async fn process_refund(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ProcessRefundRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, ORDERS_REFUND_PROCESS)
        .await
        .map_err(map_perm_err)?;

    if body.amount <= Decimal::ZERO {
        return Err(TransactionError::InvalidPayload(
            "amount must be positive".to_string(),
        ));
    }

    let method_l = body.payment_method.to_lowercase();
    let exact_refund_amount = body.amount.round_dp(2);
    let (cash_tender_amount, cash_rounding_adjustment) = cash_refund_tender_amount(
        &body.payment_method,
        exact_refund_amount,
        body.tender_amount,
        body.rounding_adjustment,
    )?;

    let mut tx = state.db.begin().await?;
    let session_open: Option<bool> = sqlx::query_scalar(
        r#"
        SELECT lifecycle_status = 'open'
        FROM register_sessions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(body.session_id)
    .fetch_optional(&mut *tx)
    .await?;
    if session_open != Some(true) {
        return Err(TransactionError::InvalidPayload(
            "register session is not open".to_string(),
        ));
    }

    if !body.return_lines.is_empty() {
        let return_inputs = return_line_inputs_from_body(&body.return_lines, "refund");
        transaction_returns::apply_transaction_returns_in_tx(
            &mut tx,
            transaction_id,
            Some(staff.id),
            return_inputs,
        )
        .await
        .map_err(|e| match e {
            transaction_returns::TransactionReturnError::Db(d) => TransactionError::Database(d),
            transaction_returns::TransactionReturnError::BadRequest(m) => {
                TransactionError::InvalidPayload(m)
            }
        })?;
    }

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
    let Some(mut refund) = row else {
        return Err(TransactionError::InvalidPayload(
            "no open refund for this order".to_string(),
        ));
    };
    let mut capacity =
        validate_refund_capacity_in_tx(&mut tx, transaction_id, &refund, exact_refund_amount)
            .await?;

    let mut refund_metadata = json!({
        "kind": "order_refund",
        "transaction_id": transaction_id,
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
            exact_refund_amount,
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

    if method_l.contains("store_credit") {
        let customer_id = refund.customer_id.ok_or_else(|| {
            TransactionError::InvalidPayload(
                "store credit refunds require a customer on the transaction".to_string(),
            )
        })?;
        let balance_after = store_credit::credit_refund_in_tx(
            &mut tx,
            customer_id,
            exact_refund_amount,
            transaction_id,
            "transaction_refund",
        )
        .await
        .map_err(|e| match e {
            store_credit::StoreCreditError::Database(d) => TransactionError::Database(d),
            store_credit::StoreCreditError::NotFound => TransactionError::InvalidPayload(
                "customer store credit account was not found".to_string(),
            ),
            store_credit::StoreCreditError::InsufficientBalance => {
                TransactionError::InvalidPayload(
                    "store credit balance would become negative".to_string(),
                )
            }
            store_credit::StoreCreditError::ReasonRequired => TransactionError::InvalidPayload(
                "store credit refund reason is required".to_string(),
            ),
        })?;
        if let Some(object) = refund_metadata.as_object_mut() {
            object.insert(
                "store_credit_balance_after".to_string(),
                json!(balance_after),
            );
        }
    }

    let mut provider_payment_id: Option<String> = None;
    let mut provider_transaction_id: Option<String> = None;
    let mut provider_status: Option<String> = None;
    let mut provider_auth_code: Option<String> = None;
    let mut provider_card_type: Option<String> = None;
    let mut card_brand: Option<String> = None;
    let mut card_last4: Option<String> = None;

    if (method_l.contains("card") || method_l.contains("helcim")) && !method_l.contains("gift") {
        let manual_external_card_refund = method_l == "card_terminal_manual";
        // Query all positive Helcim charges on this transaction with per-card remaining capacity.
        // Prior refunds are attributed to their source card via the `original_provider_transaction_id`
        // metadata field written on every Helcim refund payment_transactions row.
        // We pick the card with the most remaining refundable capacity (not the most recent),
        // and cap the refund to that card's remaining capacity to avoid over-refunding a single charge.
        //
        // Multi-card iterative dispatch in a single call (e.g. $150 split across Card A $100 + Card B $100)
        // is intentionally deferred: it would require committing Card A's ledger rows before Card B's
        // provider call, creating a partial-commit hazard on provider failure. Staff can issue two
        // sequential refund calls to handle such splits safely.
        #[derive(sqlx::FromRow)]
        struct CardCapacityRow {
            provider_transaction_id: String,
            original_amount_cents: i64,
            already_refunded_cents: i64,
        }

        let cards: Vec<CardCapacityRow> = sqlx::query_as(
            r#"
            SELECT
                pt.provider_transaction_id,
                ROUND(SUM(pa.amount_allocated) * 100)::bigint AS original_amount_cents,
                COALESCE(
                    ROUND(SUM(
                        CASE
                            WHEN ref_pt.amount < 0
                             AND ref_pt.payment_provider = 'helcim'
                             AND (ref_pt.metadata->>'original_provider_transaction_id') = pt.provider_transaction_id
                            THEN ABS(ref_pt.amount)
                            ELSE 0
                        END
                    ) * 100),
                    0
                )::bigint AS already_refunded_cents
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            LEFT JOIN payment_transactions ref_pt
                ON ref_pt.payment_provider = 'helcim'
               AND (ref_pt.metadata->>'original_provider_transaction_id') = pt.provider_transaction_id
            WHERE pa.target_transaction_id = $1
              AND pa.amount_allocated > 0
              AND pt.payment_provider = 'helcim'
              AND pt.provider_transaction_id IS NOT NULL
            GROUP BY pt.provider_transaction_id
            ORDER BY
                (ROUND(SUM(pa.amount_allocated) * 100)::bigint
                 - COALESCE(ROUND(SUM(
                       CASE
                           WHEN ref_pt.amount < 0
                            AND ref_pt.payment_provider = 'helcim'
                            AND (ref_pt.metadata->>'original_provider_transaction_id') = pt.provider_transaction_id
                           THEN ABS(ref_pt.amount)
                           ELSE 0
                       END
                   ) * 100), 0)::bigint) DESC,
                pt.provider_transaction_id ASC
            "#,
        )
        .bind(transaction_id)
        .fetch_all(&mut *tx)
        .await?;

        if cards.is_empty() || manual_external_card_refund {
            // Check if this is a governed manual legacy refund override.
            if let (Some(m_id), Some(m_pin)) = (body.manager_staff_id, body.manager_pin.as_deref())
            {
                let manager = authenticate_manager_approval(
                    &state,
                    m_id,
                    m_pin,
                    "Manager Access approval permission required for legacy manual refund",
                )
                .await?;

                let reason = body
                    .manager_reason
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        TransactionError::InvalidPayload(
                            "reason is required for legacy manual refund override".to_string(),
                        )
                    })?;
                let external_refund_reference = body
                    .external_refund_reference
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        TransactionError::InvalidPayload(
                            "Helcim refund reference is required for manual card refund recording"
                                .to_string(),
                        )
                    })?;
                let refund_record_kind = if manual_external_card_refund {
                    "external_helcim_refund"
                } else {
                    "legacy_migration_refund"
                };
                let refund_summary = if manual_external_card_refund {
                    "Manual Helcim refund recorded in Register"
                } else {
                    "Manual legacy refund recorded in Register"
                };

                // Log the audit event.
                crate::auth::pins::log_staff_access(
                    &state.db,
                    manager.id,
                    "manual_legacy_refund",
                    json!({
                        "transaction_id": transaction_id,
                        "refund_queue_id": refund.id,
                        "amount_cents": (exact_refund_amount * Decimal::from(100)).to_i64(),
                        "authorizing_manager_id": manager.id,
                        "reason": reason,
                        "external_refund_reference": external_refund_reference,
                    }),
                )
                .await?;

                // Create the negative payment transaction (manual terminal record).
                let pt_id = Uuid::new_v4();
                sqlx::query(
                    r#"
                    INSERT INTO payment_transactions (
                        id, session_id, payer_id, category, payment_method, amount,
                        status, metadata, merchant_fee, net_amount, occurred_at, created_at
                    )
                    VALUES ($1, $2, $3, 'retail_sale', 'card_terminal_manual', $4, 'approved', $5, 0, $4, NOW(), NOW())
                    "#,
                )
                .bind(pt_id)
                .bind(body.session_id)
                .bind(refund.customer_id)
                .bind(-cash_tender_amount)
                .bind(json!({
                    "kind": refund_record_kind,
                    "manual_terminal_confirmation": true,
                    "requires_operator_terminal_action": true,
                    "authorizing_manager_id": manager.id,
                    "reason": reason,
                    "external_refund_reference": external_refund_reference,
                    "external_refund_processor": "helcim",
                    "original_provider_transaction_id": "MANUAL_MIGRATION",
                    "transaction_id": transaction_id,
                    "exact_refund_amount": exact_refund_amount,
                    "cash_tender_amount": cash_tender_amount,
                    "cash_rounding_adjustment": cash_rounding_adjustment,
                }))
                .execute(&mut *tx)
                .await?;

                // Allocate the payment to the transaction.
                sqlx::query(
                    r#"
                    INSERT INTO payment_allocations (id, transaction_id, target_transaction_id, amount_allocated)
                    VALUES ($1, $2, $3, $4)
                    "#,
                )
                .bind(Uuid::new_v4())
                .bind(pt_id)
                .bind(transaction_id)
                .bind(-cash_tender_amount)
                .execute(&mut *tx)
                .await?;

                // Update the refund queue.
                sqlx::query(
                "UPDATE transaction_refund_queue SET amount_refunded = amount_refunded + $1 WHERE id = $2"
                )
                .bind(exact_refund_amount)
                .bind(refund.id)
                .execute(&mut *tx)
                .await?;

                // Update the transaction amount paid.
                sqlx::query(
	                    r#"
	                    UPDATE transactions
	                    SET amount_paid = CASE WHEN $4 THEN amount_paid ELSE amount_paid - $1 END,
	                        rounding_adjustment = CASE WHEN $4 THEN rounding_adjustment ELSE COALESCE(rounding_adjustment, 0) + $2 END
	                    WHERE id = $3
	                    "#,
	                )
	                .bind(cash_tender_amount)
	                .bind(cash_rounding_adjustment)
	                .bind(transaction_id)
	                .bind(capacity.void_original_paid.is_some())
	                .execute(&mut *tx)
	                .await?;

                // If fully refunded, close the queue.
                if (refund.amount_refunded + exact_refund_amount) >= capacity.corrected_amount_due {
                    sqlx::query(
                        "UPDATE transaction_refund_queue SET is_open = FALSE WHERE id = $1",
                    )
                    .bind(refund.id)
                    .execute(&mut *tx)
                    .await?;
                }

                let void_close =
                    (refund.amount_refunded + exact_refund_amount) >= capacity.corrected_amount_due;
                sqlx::query(
                    r#"
                    UPDATE transaction_void_records
                    SET reversal_status = CASE WHEN $2 THEN 'completed' ELSE 'pending_refund' END,
                        refund_queue_id = COALESCE(refund_queue_id, $3)
                    WHERE transaction_id = $1
                    "#,
                )
                .bind(transaction_id)
                .bind(void_close)
                .bind(refund.id)
                .execute(&mut *tx)
                .await?;

                tx.commit().await?;

                log_order_activity(
                    &state.db,
                    transaction_id,
                    refund.customer_id,
                    "refund_processed",
                    refund_summary,
                    json!({
                        "kind": refund_record_kind,
                        "payment_transaction_id": pt_id,
                        "refund_queue_id": refund.id,
                        "amount": exact_refund_amount,
                        "cash_tender_amount": cash_tender_amount,
                        "cash_rounding_adjustment": cash_rounding_adjustment,
                        "authorizing_manager_id": manager.id,
                        "reason": reason,
                        "external_refund_reference": external_refund_reference,
                        "external_refund_processor": "helcim",
                    }),
                )
                .await?;

                return Ok(Json(json!({
                    "status": "success",
                    "message": if manual_external_card_refund {
                        "Manual Helcim refund recorded successfully."
                    } else {
                        "Manual legacy refund recorded successfully."
                    },
                    "payment_transaction_id": pt_id
                })));
            }

            if manual_external_card_refund {
                return Err(TransactionError::InvalidPayload(
                    "Manager Access is required to record a Helcim backend refund".to_string(),
                ));
            }

            return Err(TransactionError::InvalidPayload(
                "No original Helcim card charge found. Process this refund on the terminal first, then confirm it here with manager authorization.".to_string(),
            ));
        }

        let amount_cents = (exact_refund_amount * Decimal::from(100))
            .to_i64()
            .ok_or_else(|| {
                TransactionError::InvalidPayload("refund amount is not valid".to_string())
            })?;

        // Use the card with the most remaining capacity.
        let best = &cards[0];
        let per_card_remaining = best.original_amount_cents - best.already_refunded_cents;

        if per_card_remaining <= 0 {
            let total_remaining: i64 = cards
                .iter()
                .map(|c| (c.original_amount_cents - c.already_refunded_cents).max(0))
                .sum();
            return Err(TransactionError::InvalidPayload(format!(
                "all original Helcim card charges have been fully refunded (total remaining capacity: ${:.2}). No further card refund is possible.",
                Decimal::new(total_remaining, 2)
            )));
        }

        if amount_cents > per_card_remaining {
            let total_remaining: i64 = cards
                .iter()
                .map(|c| (c.original_amount_cents - c.already_refunded_cents).max(0))
                .sum();
            return Err(TransactionError::InvalidPayload(format!(
                "refund of ${:.2} exceeds the remaining refundable capacity (${:.2}) on the best available card. \
                 Total remaining across all cards: ${:.2}. \
                 To refund across multiple cards, issue separate refund requests up to each card's available limit.",
                Decimal::new(amount_cents, 2),
                Decimal::new(per_card_remaining, 2),
                Decimal::new(total_remaining, 2),
            )));
        }

        let original_transaction_id =
            best.provider_transaction_id
                .trim()
                .parse::<i64>()
                .map_err(|_| {
                    TransactionError::InvalidPayload(
                        "original Helcim transaction id is not valid for provider refund"
                            .to_string(),
                    )
                })?;

        // Idempotency key is per-card: uses the per-card already_refunded_cents (not queue-level),
        // so retrying after a partial split refund generates a fresh key scoped to this card's state.
        let per_card_already_cents = best.already_refunded_cents;
        let base_idempotency_key = card_refund_idempotency_key(
            refund.id,
            original_transaction_id,
            per_card_already_cents,
            amount_cents,
        );
        let audit_reference = card_refund_audit_reference(transaction_id, refund.id);

        let approved_attempt =
            find_approved_card_refund_attempt(&state.db, &audit_reference, amount_cents).await?;

        let (
            provider_attempt_id,
            idempotency_key,
            approved_provider_payment_id,
            approved_provider_transaction_id,
            approved_provider_status,
        ) = if let Some(attempt) = approved_attempt {
            (
                attempt.id,
                attempt.idempotency_key,
                attempt.provider_payment_id,
                attempt.provider_transaction_id,
                Some(attempt.status),
            )
        } else {
            tx.commit().await?;

            let mut provider_attempt_id = Uuid::new_v4();
            let mut idempotency_key = base_idempotency_key.clone();
            let attempt = if let Some(existing) = create_pending_card_refund_attempt(
                &state.db,
                provider_attempt_id,
                amount_cents,
                body.session_id,
                &idempotency_key,
                original_transaction_id,
                &audit_reference,
            )
            .await?
            {
                if existing.is_approved() {
                    (
                        existing.id,
                        existing.idempotency_key,
                        existing.provider_payment_id,
                        existing.provider_transaction_id,
                        Some(existing.status),
                    )
                } else if existing.status == "pending" {
                    return Err(TransactionError::BadGateway(
                        "Helcim refund is already being processed. Check the refund queue before retrying.".to_string(),
                    ));
                } else {
                    provider_attempt_id = Uuid::new_v4();
                    idempotency_key = format!("{base_idempotency_key}-retry-{provider_attempt_id}");
                    if let Some(retry_existing) = create_pending_card_refund_attempt(
                        &state.db,
                        provider_attempt_id,
                        amount_cents,
                        body.session_id,
                        &idempotency_key,
                        original_transaction_id,
                        &audit_reference,
                    )
                    .await?
                    {
                        if retry_existing.is_approved() {
                            (
                                retry_existing.id,
                                retry_existing.idempotency_key,
                                retry_existing.provider_payment_id,
                                retry_existing.provider_transaction_id,
                                Some(retry_existing.status),
                            )
                        } else {
                            return Err(TransactionError::BadGateway(
                                "Helcim refund retry is already being processed. Check the refund queue before retrying.".to_string(),
                            ));
                        }
                    } else {
                        (provider_attempt_id, idempotency_key, None, None, None)
                    }
                }
            } else {
                (provider_attempt_id, idempotency_key, None, None, None)
            };

            tx = state.db.begin().await?;
            let session_open: Option<bool> = sqlx::query_scalar(
                r#"
                SELECT lifecycle_status = 'open'
                FROM register_sessions
                WHERE id = $1
                FOR UPDATE
                "#,
            )
            .bind(body.session_id)
            .fetch_optional(&mut *tx)
            .await?;
            if session_open != Some(true) {
                return Err(TransactionError::InvalidPayload(
                    "register session is not open".to_string(),
                ));
            }

            refund = sqlx::query_as(
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
            .await?
            .ok_or_else(|| {
                TransactionError::InvalidPayload("no open refund for this order".to_string())
            })?;
            capacity = validate_refund_capacity_in_tx(
                &mut tx,
                transaction_id,
                &refund,
                exact_refund_amount,
            )
            .await?;

            let refreshed_card_remaining: Option<i64> = sqlx::query_scalar(
                r#"
                SELECT
                    ROUND(SUM(pa.amount_allocated) * 100)::bigint
                    - COALESCE(
                        ROUND(SUM(
                            CASE
                                WHEN ref_pt.amount < 0
                                 AND ref_pt.payment_provider = 'helcim'
                                 AND (ref_pt.metadata->>'original_provider_transaction_id') = pt.provider_transaction_id
                                THEN ABS(ref_pt.amount)
                                ELSE 0
                            END
                        ) * 100),
                        0
                    )::bigint AS remaining_cents
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                LEFT JOIN payment_transactions ref_pt
                    ON ref_pt.payment_provider = 'helcim'
                   AND (ref_pt.metadata->>'original_provider_transaction_id') = pt.provider_transaction_id
                WHERE pa.target_transaction_id = $1
                  AND pa.amount_allocated > 0
                  AND pt.payment_provider = 'helcim'
                  AND pt.provider_transaction_id = $2
                GROUP BY pt.provider_transaction_id
                "#,
            )
            .bind(transaction_id)
            .bind(original_transaction_id.to_string())
            .fetch_optional(&mut *tx)
            .await?;
            if amount_cents > refreshed_card_remaining.unwrap_or(0) {
                return Err(TransactionError::InvalidPayload(
                    "refund exceeds the remaining refundable capacity on the original Helcim card"
                        .to_string(),
                ));
            }

            attempt
        };

        let provider_call_required = approved_provider_payment_id.is_none();
        let mut ledger_tx = Some(tx);
        if provider_call_required {
            // The durable pending attempt serializes provider work. Never hold the register
            // session or refund-queue row locks while waiting on Helcim.
            ledger_tx
                .take()
                .expect("refund ledger transaction is available before provider call")
                .commit()
                .await?;
        }

        let (refund_provider_payment_id, refund_provider_status) = if let Some(
            provider_payment_id,
        ) =
            approved_provider_payment_id
        {
            (Some(provider_payment_id), approved_provider_status)
        } else {
            let config = helcim::HelcimConfig::from_env();
            let refund_request = helcim::HelcimCardRefundRequest {
                original_transaction_id,
                amount: cents_to_decimal_string(amount_cents),
                ip_address: request_ip_address(&headers),
                ecommerce: false,
            };
            let provider_started = std::time::Instant::now();
            let provider_result = helcim::process_card_refund(
                &state.http_client,
                &config,
                refund_request,
                &idempotency_key,
            )
            .await;
            crate::logic::operation_metrics::record_phase(
                state.db.clone(),
                "refund",
                "helcim_provider",
                provider_started.elapsed(),
                provider_result.is_ok(),
                Some(transaction_id),
                Some(body.session_id),
                json!({ "amount_cents": amount_cents }),
            );
            let refund_transaction = match provider_result {
                Ok(transaction) => transaction,
                Err(error) => {
                    let persisted_message = helcim::redact_provider_text(&error)
                        .chars()
                        .take(500)
                        .collect::<String>();
                    let staff_message = helcim::redact_provider_text(&error);
                    mark_card_refund_attempt_failed(
                        &state.db,
                        provider_attempt_id,
                        "request_failed",
                        persisted_message,
                    )
                    .await?;
                    return Err(TransactionError::BadGateway(format!(
                        "Helcim refund failed: {staff_message}"
                    )));
                }
            };

            let refund_status = refund_transaction.normalized_status();
            let refund_provider_payment_id = refund_transaction.transaction_id_string();
            let refund_provider_status = refund_transaction.provider_status();
            let refund_warning = refund_transaction
                .warning
                .as_deref()
                .map(helcim::redact_provider_text);

            sqlx::query(
                    r#"
                    UPDATE payment_provider_attempts
                    SET status = $2,
                        provider_payment_id = $3,
                        provider_transaction_id = COALESCE($3, provider_transaction_id),
                        error_code = CASE WHEN $2 = 'failed' THEN 'declined' ELSE NULL END,
                        error_message = CASE WHEN $2 = 'failed' THEN COALESCE($4, 'Helcim refund was declined.') ELSE NULL END,
                        completed_at = now()
                    WHERE id = $1
                    "#,
                )
                .bind(provider_attempt_id)
                .bind(&refund_status)
                .bind(refund_provider_payment_id.clone())
                .bind(refund_warning.clone())
                .execute(&state.db)
                .await?;

            if !matches!(refund_status.as_str(), "approved" | "captured") {
                let provider_status_label = refund_provider_status
                    .as_deref()
                    .unwrap_or("not approved")
                    .to_string();
                return Err(TransactionError::BadGateway(format!(
                    "Helcim refund was not approved: {provider_status_label}"
                )));
            }

            provider_auth_code = refund_transaction.approval_code.clone();
            provider_card_type = refund_transaction.card_type.clone();
            card_brand = refund_transaction.card_brand();
            card_last4 = refund_transaction.card_last4();

            (refund_provider_payment_id, refund_provider_status)
        };

        if provider_call_required {
            let mut resumed_tx = state.db.begin().await?;
            let session_open: Option<bool> = sqlx::query_scalar(
                r#"
                SELECT lifecycle_status = 'open'
                FROM register_sessions
                WHERE id = $1
                FOR UPDATE
                "#,
            )
            .bind(body.session_id)
            .fetch_optional(&mut *resumed_tx)
            .await?;
            if session_open != Some(true) {
                return Err(TransactionError::InvalidPayload(
                    "register session closed after the Helcim refund was approved; retry to record the approved refund locally"
                        .to_string(),
                ));
            }

            refund = sqlx::query_as(
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
            .fetch_optional(&mut *resumed_tx)
            .await?
            .ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "refund queue changed after the Helcim refund was approved; retry to reconcile the approved refund locally"
                        .to_string(),
                )
            })?;
            capacity = validate_refund_capacity_in_tx(
                &mut resumed_tx,
                transaction_id,
                &refund,
                exact_refund_amount,
            )
            .await?;

            let refreshed_card_remaining: Option<i64> = sqlx::query_scalar(
                r#"
                SELECT
                    ROUND(SUM(pa.amount_allocated) * 100)::bigint
                    - COALESCE(
                        ROUND(SUM(
                            CASE
                                WHEN ref_pt.amount < 0
                                 AND ref_pt.payment_provider = 'helcim'
                                 AND (ref_pt.metadata->>'original_provider_transaction_id') = pt.provider_transaction_id
                                THEN ABS(ref_pt.amount)
                                ELSE 0
                            END
                        ) * 100),
                        0
                    )::bigint AS remaining_cents
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                LEFT JOIN payment_transactions ref_pt
                    ON ref_pt.payment_provider = 'helcim'
                   AND (ref_pt.metadata->>'original_provider_transaction_id') = pt.provider_transaction_id
                WHERE pa.target_transaction_id = $1
                  AND pa.amount_allocated > 0
                  AND pt.payment_provider = 'helcim'
                  AND pt.provider_transaction_id = $2
                GROUP BY pt.provider_transaction_id
                "#,
            )
            .bind(transaction_id)
            .bind(original_transaction_id.to_string())
            .fetch_optional(&mut *resumed_tx)
            .await?;
            if amount_cents > refreshed_card_remaining.unwrap_or(0) {
                return Err(TransactionError::InvalidPayload(
                    "refund capacity changed after Helcim approval; retry to reconcile the approved refund locally"
                    .to_string(),
                ));
            }
            ledger_tx = Some(resumed_tx);
        }

        tx = ledger_tx.expect("refund ledger transaction is restored after provider call");

        provider_payment_id = refund_provider_payment_id;
        provider_transaction_id =
            approved_provider_transaction_id.or_else(|| provider_payment_id.clone());
        provider_status = refund_provider_status;

        if let Some(object) = refund_metadata.as_object_mut() {
            object.insert("payment_provider".to_string(), json!("helcim"));
            object.insert(
                "provider_attempt_id".to_string(),
                json!(provider_attempt_id),
            );
            object.insert(
                "original_provider_transaction_id".to_string(),
                json!(original_transaction_id.to_string()),
            );
            object.insert(
                "provider_refund_id".to_string(),
                json!(provider_payment_id.clone()),
            );
            object.insert(
                "provider_idempotency_key".to_string(),
                json!(idempotency_key.clone()),
            );
        }
    }

    #[cfg(test)]
    if FAIL_CARD_REFUND_LEDGER_AFTER_PROVIDER_APPROVAL
        .swap(false, std::sync::atomic::Ordering::SeqCst)
    {
        return Err(TransactionError::Database(sqlx::Error::Protocol(
            "forced local refund ledger failure after provider approval".to_string(),
        )));
    }

    let payment_tx_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_transactions (
            session_id, payer_id, category, payment_method, amount, effective_date, metadata,
            payment_provider, provider_payment_id, provider_status, provider_transaction_id,
            provider_auth_code, provider_card_type, card_brand, card_last4
        )
        VALUES (
            $1, $2, $3, $4, $5,
            (CURRENT_TIMESTAMP AT TIME ZONE reporting.effective_store_timezone())::date,
            $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
        RETURNING id
        "#,
    )
    .bind(body.session_id)
    .bind(refund.customer_id)
    .bind(DbTransactionCategory::RetailSale)
    .bind(body.payment_method.trim())
    .bind(-cash_tender_amount)
    .bind({
        let mut metadata = refund_metadata;
        if let Some(object) = metadata.as_object_mut() {
            object.insert(
                "exact_refund_amount".to_string(),
                json!(exact_refund_amount),
            );
            object.insert("cash_tender_amount".to_string(), json!(cash_tender_amount));
            object.insert(
                "cash_rounding_adjustment".to_string(),
                json!(cash_rounding_adjustment),
            );
            if let Some(final_cash_due) = body.final_cash_due {
                object.insert("final_cash_due".to_string(), json!(final_cash_due));
            }
        }
        metadata
    })
    .bind(if provider_payment_id.is_some() {
        Some("helcim")
    } else {
        None
    })
    .bind(provider_payment_id)
    .bind(provider_status)
    .bind(provider_transaction_id)
    .bind(provider_auth_code)
    .bind(provider_card_type)
    .bind(card_brand)
    .bind(card_last4)
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
    .bind(-cash_tender_amount)
    .bind(json!({ "kind": "order_refund" }))
    .execute(&mut *tx)
    .await?;

    let new_refunded = refund.amount_refunded + exact_refund_amount;
    let close = new_refunded >= capacity.corrected_amount_due;
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
        UPDATE transaction_void_records
        SET reversal_status = CASE WHEN $2 THEN 'completed' ELSE 'pending_refund' END,
            refund_queue_id = COALESCE(refund_queue_id, $3)
        WHERE transaction_id = $1
        "#,
    )
    .bind(transaction_id)
    .bind(close)
    .bind(refund.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
	        r#"
	        UPDATE transactions
	        SET amount_paid = CASE WHEN $4 THEN amount_paid ELSE amount_paid - $1 END,
	            rounding_adjustment = CASE WHEN $4 THEN rounding_adjustment ELSE COALESCE(rounding_adjustment, 0) + $2 END
	        WHERE id = $3
	        "#,
	    )
	    .bind(cash_tender_amount)
	    .bind(cash_rounding_adjustment)
	    .bind(transaction_id)
	    .bind(capacity.void_original_paid.is_some())
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
            exact_refund_amount,
            body.payment_method.trim()
        ),
        json!({
            "amount": exact_refund_amount,
            "payment_method": body.payment_method,
            "cash_tender_amount": cash_tender_amount,
            "cash_rounding_adjustment": cash_rounding_adjustment,
        }),
    )
    .await?;

    Ok(Json(json!({ "status": "ok" })))
}

async fn process_exchange_settlement(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ExchangeSettlementRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, ORDERS_REFUND_PROCESS)
        .await
        .map_err(map_perm_err)?;

    if body.replacement_transaction_id == transaction_id {
        return Err(TransactionError::InvalidPayload(
            "replacement transaction must differ from the return transaction".to_string(),
        ));
    }
    if body.exchange_credit_amount < Decimal::ZERO {
        return Err(TransactionError::InvalidPayload(
            "exchange credit amount cannot be negative".to_string(),
        ));
    }
    if let Some(remainder) = &body.refund_remainder {
        if remainder.amount <= Decimal::ZERO {
            return Err(TransactionError::InvalidPayload(
                "refund remainder amount must be positive".to_string(),
            ));
        }
        let method_l = remainder.payment_method.to_lowercase();
        if (method_l.contains("card") || method_l.contains("helcim")) && !method_l.contains("gift")
        {
            return Err(TransactionError::InvalidPayload(
                "card refund remainders must use the original provider refund flow".to_string(),
            ));
        }
    }

    let refund_remainder_amount = body
        .refund_remainder
        .as_ref()
        .map(|remainder| remainder.amount.round_dp(2))
        .unwrap_or(Decimal::ZERO);
    let (refund_remainder_tender_amount, refund_remainder_rounding_adjustment) =
        if let Some(remainder) = &body.refund_remainder {
            cash_refund_tender_amount(
                &remainder.payment_method,
                refund_remainder_amount,
                remainder.tender_amount,
                remainder.rounding_adjustment,
            )?
        } else {
            (Decimal::ZERO, Decimal::ZERO)
        };
    let total_relief = body.exchange_credit_amount + refund_remainder_amount;
    if total_relief < Decimal::ZERO || (total_relief.is_zero() && body.return_lines.is_empty()) {
        return Err(TransactionError::InvalidPayload(
            "exchange settlement must apply credit, refund a remainder, or record return lines"
                .to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let session_open: Option<bool> = sqlx::query_scalar(
        r#"
        SELECT lifecycle_status = 'open'
        FROM register_sessions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(body.session_id)
    .fetch_optional(&mut *tx)
    .await?;
    if session_open != Some(true) {
        return Err(TransactionError::InvalidPayload(
            "register session is not open".to_string(),
        ));
    }

    if !body.return_lines.is_empty() {
        let return_inputs = return_line_inputs_from_body(&body.return_lines, "exchange");
        transaction_returns::apply_transaction_returns_in_tx(
            &mut tx,
            transaction_id,
            Some(staff.id),
            return_inputs,
        )
        .await
        .map_err(|e| match e {
            transaction_returns::TransactionReturnError::Db(d) => TransactionError::Database(d),
            transaction_returns::TransactionReturnError::BadRequest(m) => {
                TransactionError::InvalidPayload(m)
            }
        })?;
    }

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
    let refund = match row {
        Some(refund) => Some(refund),
        None if total_relief.is_zero() && !body.return_lines.is_empty() => None,
        None => {
            return Err(TransactionError::InvalidPayload(
                "no open refund for this transaction".to_string(),
            ));
        }
    };

    let (original_customer_id, current_paid, current_balance_due, original_exchange_group_id): (
        Option<Uuid>,
        Decimal,
        Decimal,
        Option<Uuid>,
    ) = sqlx::query_as(
        r#"
        SELECT
            customer_id,
            COALESCE(amount_paid, 0)::numeric(14,2),
            COALESCE(balance_due, 0)::numeric(14,2),
            exchange_group_id
        FROM transactions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut *tx)
    .await?;

    let replacement_row: Option<(Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
        r#"
        SELECT
            customer_id,
            exchange_group_id
        FROM transactions
        WHERE id = $1 AND status <> 'cancelled'::order_status
        FOR UPDATE
        "#,
    )
    .bind(body.replacement_transaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((replacement_customer_id, replacement_exchange_group_id)) = replacement_row else {
        return Err(TransactionError::InvalidPayload(
            "replacement transaction was not found or is cancelled".to_string(),
        ));
    };

    if let (Some(original_customer), Some(replacement_customer)) =
        (original_customer_id, replacement_customer_id)
    {
        if original_customer != replacement_customer {
            return Err(TransactionError::InvalidPayload(
                "exchange transactions must belong to the same customer".to_string(),
            ));
        }
    }

    if total_relief.is_zero() {
        let exchange_group_id = match (original_exchange_group_id, replacement_exchange_group_id) {
            (Some(left), Some(right)) if left != right => {
                return Err(TransactionError::InvalidPayload(
                    "exchange transactions are already linked to different exchange groups"
                        .to_string(),
                ));
            }
            (Some(id), _) | (_, Some(id)) => id,
            (None, None) => Uuid::new_v4(),
        };
        sqlx::query("UPDATE transactions SET exchange_group_id = $1 WHERE id = $2 OR id = $3")
            .bind(exchange_group_id)
            .bind(transaction_id)
            .bind(body.replacement_transaction_id)
            .execute(&mut *tx)
            .await?;

        transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
            .await
            .map_err(TransactionError::Database)?;
        transaction_recalc::recalc_transaction_totals(&mut tx, body.replacement_transaction_id)
            .await
            .map_err(TransactionError::Database)?;

        tx.commit().await?;

        tracing::info!(
            original_transaction_id = %transaction_id,
            replacement_transaction_id = %body.replacement_transaction_id,
            "Exchange settlement recorded with return lines and no paid credit"
        );

        log_order_activity(
            &state.db,
            transaction_id,
            original_customer_id,
            "exchange_settled",
            "Exchange settled with return lines and no paid credit",
            json!({
                "exchange_group_id": exchange_group_id,
                "replacement_transaction_id": body.replacement_transaction_id,
                "exchange_credit_amount": body.exchange_credit_amount,
                "refund_remainder_amount": refund_remainder_amount,
                "refund_queue_id": null,
                "return_line_count": body.return_lines.len(),
            }),
        )
        .await?;

        log_order_activity(
            &state.db,
            body.replacement_transaction_id,
            replacement_customer_id.or(original_customer_id),
            "exchange_settled",
            "Exchange linked to original return with no paid credit",
            json!({
                "exchange_group_id": exchange_group_id,
                "original_transaction_id": transaction_id,
                "exchange_credit_amount": body.exchange_credit_amount,
                "refund_remainder_amount": refund_remainder_amount,
                "refund_queue_id": null,
                "return_line_count": body.return_lines.len(),
            }),
        )
        .await?;

        return Ok(Json(json!({
            "status": "ok",
            "exchange_group_id": exchange_group_id,
            "exchange_credit_amount": body.exchange_credit_amount,
            "refund_remainder_amount": refund_remainder_amount,
        })));
    }

    let refund = refund.expect("positive exchange relief requires an open refund queue");

    if body.exchange_credit_amount > Decimal::ZERO {
        let applied_exchange_credit: Decimal = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(pa.amount_allocated), 0)::numeric(14,2)
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pa.target_transaction_id = $1
              AND pt.session_id = $2
              AND LOWER(pt.payment_method) = 'exchange_credit'
              AND pa.amount_allocated > 0
            "#,
        )
        .bind(body.replacement_transaction_id)
        .bind(body.session_id)
        .fetch_one(&mut *tx)
        .await?;
        if applied_exchange_credit < body.exchange_credit_amount {
            return Err(TransactionError::InvalidPayload(format!(
                "replacement transaction is missing ${} of exchange credit tender",
                body.exchange_credit_amount
            )));
        }
    }

    let refundable_credit = if current_balance_due < Decimal::ZERO {
        -current_balance_due
    } else {
        Decimal::ZERO
    };
    let remaining = if refundable_credit < current_paid {
        refundable_credit
    } else {
        current_paid
    };
    let corrected_amount_due = refund.amount_refunded + remaining;
    if corrected_amount_due != refund.amount_due {
        sqlx::query(
            r#"
            UPDATE transaction_refund_queue
            SET amount_due = $1
            WHERE id = $2
            "#,
        )
        .bind(corrected_amount_due)
        .bind(refund.id)
        .execute(&mut *tx)
        .await?;
    }
    if total_relief > remaining {
        return Err(TransactionError::InvalidPayload(format!(
            "exchange settlement exceeds refundable paid credit of ${remaining}"
        )));
    }

    if body.exchange_credit_amount > Decimal::ZERO {
        let relief_payment_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO payment_transactions (
                session_id, payer_id, category, payment_method, amount, effective_date, metadata
            )
            VALUES (
                $1, $2, $3, 'exchange_credit', $4,
                (CURRENT_TIMESTAMP AT TIME ZONE reporting.effective_store_timezone())::date,
                $5
            )
            RETURNING id
            "#,
        )
        .bind(body.session_id)
        .bind(refund.customer_id)
        .bind(DbTransactionCategory::RetailSale)
        .bind(-body.exchange_credit_amount)
        .bind(json!({
            "kind": "exchange_credit_relief",
            "original_transaction_id": transaction_id,
            "replacement_transaction_id": body.replacement_transaction_id,
            "refund_queue_id": refund.id,
        }))
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated, metadata)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(relief_payment_id)
        .bind(transaction_id)
        .bind(-body.exchange_credit_amount)
        .bind(json!({
            "kind": "exchange_credit_relief",
            "replacement_transaction_id": body.replacement_transaction_id,
        }))
        .execute(&mut *tx)
        .await?;
    }

    if let Some(remainder) = &body.refund_remainder {
        let method_l = remainder.payment_method.to_lowercase();
        let mut refund_metadata = json!({
            "kind": "exchange_refund_remainder",
            "original_transaction_id": transaction_id,
            "replacement_transaction_id": body.replacement_transaction_id,
            "refund_queue_id": refund.id,
        });

        if method_l.contains("gift") {
            let code = remainder
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
                refund_remainder_amount,
                transaction_id,
                body.session_id,
            )
            .await
            .map_err(|e| match e {
                gift_card_ops::GiftCardOpError::Db(d) => TransactionError::Database(d),
                gift_card_ops::GiftCardOpError::BadRequest(m) => {
                    TransactionError::InvalidPayload(m)
                }
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
        if method_l.contains("store_credit") {
            let customer_id = refund.customer_id.ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "store credit refunds require a customer on the transaction".to_string(),
                )
            })?;
            let balance_after = store_credit::credit_refund_in_tx(
                &mut tx,
                customer_id,
                refund_remainder_amount,
                transaction_id,
                "exchange_refund_remainder",
            )
            .await
            .map_err(|e| match e {
                store_credit::StoreCreditError::Database(d) => TransactionError::Database(d),
                store_credit::StoreCreditError::NotFound => TransactionError::InvalidPayload(
                    "customer store credit account was not found".to_string(),
                ),
                store_credit::StoreCreditError::InsufficientBalance => {
                    TransactionError::InvalidPayload(
                        "store credit balance would become negative".to_string(),
                    )
                }
                store_credit::StoreCreditError::ReasonRequired => TransactionError::InvalidPayload(
                    "store credit refund reason is required".to_string(),
                ),
            })?;
            if let Some(object) = refund_metadata.as_object_mut() {
                object.insert(
                    "store_credit_balance_after".to_string(),
                    json!(balance_after),
                );
            }
        }
        if let Some(object) = refund_metadata.as_object_mut() {
            object.insert(
                "exact_refund_amount".to_string(),
                json!(refund_remainder_amount),
            );
            object.insert(
                "cash_tender_amount".to_string(),
                json!(refund_remainder_tender_amount),
            );
            object.insert(
                "cash_rounding_adjustment".to_string(),
                json!(refund_remainder_rounding_adjustment),
            );
            if let Some(final_cash_due) = remainder.final_cash_due {
                object.insert("final_cash_due".to_string(), json!(final_cash_due));
            }
        }

        let refund_payment_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO payment_transactions (
                session_id, payer_id, category, payment_method, amount, effective_date, metadata
            )
            VALUES (
                $1, $2, $3, $4, $5,
                (CURRENT_TIMESTAMP AT TIME ZONE reporting.effective_store_timezone())::date,
                $6
            )
            RETURNING id
            "#,
        )
        .bind(body.session_id)
        .bind(refund.customer_id)
        .bind(DbTransactionCategory::RetailSale)
        .bind(remainder.payment_method.trim())
        .bind(-refund_remainder_tender_amount)
        .bind(refund_metadata)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated, metadata)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(refund_payment_id)
        .bind(transaction_id)
        .bind(-refund_remainder_tender_amount)
        .bind(json!({
            "kind": "exchange_refund_remainder",
            "replacement_transaction_id": body.replacement_transaction_id,
        }))
        .execute(&mut *tx)
        .await?;
    }

    let new_refunded = refund.amount_refunded + total_relief;
    let close = new_refunded >= corrected_amount_due;
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
        SET amount_paid = amount_paid - $1,
            rounding_adjustment = COALESCE(rounding_adjustment, 0) + $2
        WHERE id = $3
        "#,
    )
    .bind(body.exchange_credit_amount + refund_remainder_tender_amount)
    .bind(refund_remainder_rounding_adjustment)
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;

    let exchange_group_id = match (original_exchange_group_id, replacement_exchange_group_id) {
        (Some(left), Some(right)) if left != right => {
            return Err(TransactionError::InvalidPayload(
                "exchange transactions are already linked to different exchange groups".to_string(),
            ));
        }
        (Some(id), _) | (_, Some(id)) => id,
        (None, None) => Uuid::new_v4(),
    };
    sqlx::query("UPDATE transactions SET exchange_group_id = $1 WHERE id = $2 OR id = $3")
        .bind(exchange_group_id)
        .bind(transaction_id)
        .bind(body.replacement_transaction_id)
        .execute(&mut *tx)
        .await?;

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;
    transaction_recalc::recalc_transaction_totals(&mut tx, body.replacement_transaction_id)
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
        original_transaction_id = %transaction_id,
        replacement_transaction_id = %body.replacement_transaction_id,
        exchange_credit_amount = %body.exchange_credit_amount,
        refund_remainder_amount = %refund_remainder_amount,
        "Exchange settlement recorded for QBO staging"
    );

    log_order_activity(
        &state.db,
        transaction_id,
        refund.customer_id,
        "exchange_settled",
        &format!(
            "Exchange settled with ${} credit applied to replacement transaction",
            body.exchange_credit_amount
        ),
        json!({
            "exchange_group_id": exchange_group_id,
            "replacement_transaction_id": body.replacement_transaction_id,
            "exchange_credit_amount": body.exchange_credit_amount,
            "refund_remainder_amount": refund_remainder_amount,
            "refund_queue_id": refund.id,
        }),
    )
    .await?;

    log_order_activity(
        &state.db,
        body.replacement_transaction_id,
        replacement_customer_id.or(original_customer_id),
        "exchange_settled",
        &format!(
            "Exchange credit ${} applied from original transaction",
            body.exchange_credit_amount
        ),
        json!({
            "exchange_group_id": exchange_group_id,
            "original_transaction_id": transaction_id,
            "exchange_credit_amount": body.exchange_credit_amount,
            "refund_remainder_amount": refund_remainder_amount,
            "refund_queue_id": refund.id,
        }),
    )
    .await?;

    Ok(Json(json!({
        "status": "ok",
        "exchange_group_id": exchange_group_id,
        "exchange_credit_amount": body.exchange_credit_amount,
        "refund_remainder_amount": refund_remainder_amount,
    })))
}

async fn get_transaction_receipt_escpos(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, TransactionError> {
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
    let receipt_order = detail.build_receipt_data(item_ids.as_deref())?;

    let receipt_cfg: crate::api::settings::ReceiptConfig =
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT receipt_config FROM store_settings WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<crate::api::settings::ReceiptConfig>(v).ok())
        .unwrap_or_default()
        .normalize_runtime();

    // Best-effort loyalty data for receipt tokens.
    let loyalty = {
        let points_earned: Option<i32> = sqlx::query_scalar(
            "SELECT points_earned FROM transaction_loyalty_accrual WHERE transaction_id = $1",
        )
        .bind(transaction_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();

        let points_balance: Option<i32> = if let Some(cid) = detail.customer.as_ref().map(|c| c.id)
        {
            sqlx::query_scalar("SELECT loyalty_points FROM customers WHERE id = $1")
                .bind(cid)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
        } else {
            None
        };

        receipt_escpos::LoyaltyReceiptData {
            points_earned,
            points_balance,
        }
    };

    let receiptline_markdown =
        receipt_escpos::build_receiptline_markdown(&receipt_order, &receipt_cfg, &params, &loyalty);
    let bytes = receipt_escpos::build_receipt_escpos(&receipt_order, &receipt_cfg, params);
    let escpos_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Json(serde_json::json!({
        "escpos_base64": escpos_base64,
        "receiptline_markdown": receiptline_markdown,
        "printer_language": "escpos",
        "printer_family": "epson_tm_m30iii"
    })))
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
    let receipt_order = detail.build_receipt_data(item_ids.as_deref())?;

    let receipt_cfg: crate::api::settings::ReceiptConfig =
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT receipt_config FROM store_settings WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<crate::api::settings::ReceiptConfig>(v).ok())
        .unwrap_or_default()
        .normalize_runtime();

    let tpl = receipt_cfg
        .receipt_studio_exported_html
        .as_deref()
        .unwrap_or("");
    let body = if tpl.trim().is_empty() {
        receipt_studio_html::render_standard_receipt_html(&receipt_order, &receipt_cfg, gift)
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
        "Could not send via Podium ({e}). Enable operational messaging in Settings → Integrations (Podium), verify credentials, and ensure SMS send is enabled."
    ))
}

fn map_store_email_err(e: crate::logic::email::EmailError) -> TransactionError {
    TransactionError::BadGateway(format!(
        "Could not send email ({e}). Check Mailbox settings and saved IONOS credentials."
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
        .and_then(|v| serde_json::from_value::<crate::api::settings::ReceiptConfig>(v).ok())
        .unwrap_or_default()
        .normalize_runtime();

    let item_ids = if body.transaction_line_ids.is_empty() {
        None
    } else {
        Some(body.transaction_line_ids.as_slice())
    };
    let receipt_order = detail.build_receipt_data(item_ids)?;

    let tpl = receipt_cfg
        .receipt_studio_exported_html
        .as_deref()
        .unwrap_or("");
    let html = if tpl.trim().is_empty() {
        receipt_studio_html::render_standard_receipt_html(&receipt_order, &receipt_cfg, body.gift)
    } else {
        let merged = receipt_studio_html::merge_receipt_studio_html(
            tpl,
            &receipt_order,
            &receipt_cfg,
            body.gift,
        );
        receipt_studio_html::wrap_receipt_fragment_for_podium_email_inline(&merged)
    };

    let order_ref = receipt_shared::receipt_display_ref(&receipt_order);
    let subject = if body.gift {
        format!("Gift receipt — {order_ref}")
    } else {
        format!("Receipt — {order_ref}")
    };

    match store_email::send_email(&state.db, &addr, &subject, &html, None, None, "outbound").await {
        Ok(_) => {
            if let Some(customer) = detail.customer.as_ref() {
                let _ = record_customer_notification(
                    &state.db,
                    customer.id,
                    "transaction",
                    transaction_id,
                    CustomerNotificationKind::Receipt,
                    CustomerNotificationChannel::Email,
                    Some(&format!("{subject}\n{html}")),
                    None,
                    json!({ "receipt": true, "gift": body.gift, "to_email": addr }),
                )
                .await;
            }
            Ok(Json(json!({ "status": "sent" })))
        }
        Err(e) => Err(map_store_email_err(e)),
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
        .and_then(|v| serde_json::from_value::<crate::api::settings::ReceiptConfig>(v).ok())
        .unwrap_or_default()
        .normalize_runtime();

    let item_ids = if body.transaction_line_ids.is_empty() {
        None
    } else {
        Some(body.transaction_line_ids.as_slice())
    };
    let receipt_order = detail.build_receipt_data(item_ids)?;

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
                Ok(()) => {
                    if let Some(customer) = detail.customer.as_ref() {
                        let e164 = podium::normalize_phone_e164(&phone_raw);
                        let _ = podium_messaging::record_outbound_message(
                            &state.db,
                            customer.id,
                            "sms",
                            &caption,
                            None,
                            e164.as_deref(),
                            None,
                            "automated",
                        )
                        .await;
                        let _ = record_customer_notification(
                            &state.db,
                            customer.id,
                            "transaction",
                            transaction_id,
                            CustomerNotificationKind::Receipt,
                            CustomerNotificationChannel::Sms,
                            Some(&caption),
                            None,
                            json!({ "receipt": true, "gift": body.gift, "mode": "mms_attachment", "to_phone": e164 }),
                        )
                        .await;
                    }
                    Ok(Json(json!({ "status": "sent", "mode": "mms_attachment" })))
                }
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
        Ok(()) => {
            if let Some(customer) = detail.customer.as_ref() {
                let e164 = podium::normalize_phone_e164(&phone_raw);
                let _ = podium_messaging::record_outbound_message(
                    &state.db,
                    customer.id,
                    "sms",
                    &sms_body,
                    None,
                    e164.as_deref(),
                    None,
                    "automated",
                )
                .await;
                let _ = record_customer_notification(
                    &state.db,
                    customer.id,
                    "transaction",
                    transaction_id,
                    CustomerNotificationKind::Receipt,
                    CustomerNotificationChannel::Sms,
                    Some(&sms_body),
                    None,
                    json!({ "receipt": true, "gift": body.gift, "mode": "sms_text", "to_phone": e164 }),
                )
                .await;
            }
            Ok(Json(json!({ "status": "sent", "mode": "sms_text" })))
        }
        Err(e) => Err(map_podium_order_err(e)),
    }
}

pub(crate) async fn load_transaction_detail(
    pool: &sqlx::PgPool,
    transaction_id: Uuid,
) -> Result<TransactionDetailResponse, TransactionError> {
    let has_review_opt_out: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'customers'
              AND column_name = 'review_requests_opt_out'
        )
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(false);

    let review_opt_out_expr = if has_review_opt_out {
        "COALESCE(c.review_requests_opt_out, false) AS customer_review_requests_opt_out"
    } else {
        "false AS customer_review_requests_opt_out"
    };

    let header_sql = format!(
        r#"
        SELECT
            o.id,
            o.display_id,
            o.booked_at,
            o.status,
            o.total_price,
            o.amount_paid,
            o.balance_due,
            COALESCE(o.is_counterpoint_import, false) AS is_counterpoint_import,
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
            c.customer_code AS customer_code,
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
            {review_opt_out_expr},
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
        "#
    );

    let header = sqlx::query_as::<_, OrderHeaderRow>(&header_sql)
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
            COALESCE(oi.booked_at, o.booked_at) AS booked_at,
            oi.product_id,
            oi.variant_id,
            COALESCE(
                CASE
                    WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                    THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_sku'), '')
                    ELSE NULL
                END,
                pv.sku
            ) AS sku,
            COALESCE(
                CASE
                    WHEN COALESCE(pv.sku, '') = 'HIST-CP-FALLBACK'
                    THEN NULLIF(TRIM(oi.size_specs->>'counterpoint_description'), '')
                    ELSE NULL
                END,
                NULLIF(TRIM(p.name), ''),
                p.name
            ) AS product_name,
            pv.variation_label,
            oi.quantity,
            COALESCE((
                SELECT SUM(orx.quantity_returned)::int
                FROM transaction_return_lines orx
                WHERE orx.transaction_line_id = oi.id
            ), 0) AS quantity_returned,
            CASE
                WHEN oi.size_specs ? 'overridden_unit_price'
                     AND NULLIF(TRIM(oi.size_specs->>'overridden_unit_price'), '') IS NOT NULL
                     AND TRIM(oi.size_specs->>'overridden_unit_price') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN (TRIM(oi.size_specs->>'overridden_unit_price'))::numeric(14,2)
                ELSE COALESCE(oi.unit_price, 0)
            END AS unit_price,
            COALESCE(oi.unit_cost, 0) AS unit_cost,
            COALESCE(oi.state_tax, 0) AS state_tax,
            COALESCE(oi.local_tax, 0) AS local_tax,
            CASE
                WHEN NULLIF(TRIM(oi.size_specs->'tax_category_override'->>'to'), '') IS NOT NULL
                THEN lower(TRIM(oi.size_specs->'tax_category_override'->>'to'))
                WHEN p.tax_category_override IS NOT NULL THEN p.tax_category_override::text
                WHEN lower(COALESCE(rc.resolved_category_name, '')) LIKE '%shoe%'
                  OR lower(COALESCE(rc.resolved_category_name, '')) LIKE '%footwear%'
                THEN 'footwear'
                WHEN rc.resolved_category_name IS NOT NULL THEN 'clothing'
                ELSE 'other'
            END AS tax_category,
            oi.fulfillment,
            oi.order_lifecycle_status,
            (
                SELECT status::text 
                FROM alteration_orders 
                WHERE source_transaction_line_id = oi.id 
                ORDER BY created_at DESC 
                LIMIT 1
            ) AS alteration_status,
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
            NULLIF(TRIM(oi.size_specs->>'gift_card_load_code'), '') AS gift_card_load_code,
            oi.po_id,
            oi.po_line_id,
            po.po_number,
            oi.vendor_id,
            v.name AS vendor_name,
            oi.vendor_eta,
            NULLIF(TRIM(oi.vendor_reference), '') AS vendor_reference,
            oi.ordered_at,
            oi.received_at,
            oi.ready_for_pickup_at,
            oi.picked_up_at,
            oi.shipped_at,
            oi.shipment_id,
            oi.fulfilled_at
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        LEFT JOIN LATERAL (
            WITH RECURSIVE cat_path AS (
                SELECT c.id, c.name, c.is_clothing_footwear, c.parent_id, 0 AS depth
                FROM categories c
                WHERE c.id = p.category_id
                UNION ALL
                SELECT parent.id, parent.name, parent.is_clothing_footwear, parent.parent_id, cat_path.depth + 1
                FROM categories parent
                JOIN cat_path ON cat_path.parent_id = parent.id
                WHERE cat_path.depth < 16
            )
            SELECT cp.name AS resolved_category_name
            FROM cat_path cp
            WHERE cp.is_clothing_footwear = true
            ORDER BY cp.depth
            LIMIT 1
        ) rc ON true
        LEFT JOIN staff sp ON sp.id = oi.salesperson_id
        LEFT JOIN purchase_orders po ON po.id = oi.po_id
        LEFT JOIN vendors v ON v.id = oi.vendor_id
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

    let payments_db = sqlx::query_as::<
        _,
        (
            DateTime<Utc>,
            String,
            Decimal,
            Option<Decimal>,
            Option<Decimal>,
        ),
    >(
        r#"
        SELECT DISTINCT
            pt.created_at,
            pt.payment_method,
            COALESCE(pa.amount_allocated, pt.amount)::numeric(14,2) AS amount,
            CASE
                WHEN LOWER(pt.payment_method) = 'cash'
                 AND COALESCE(pt.metadata->>'cash_tendered_cents', '') ~ '^[0-9]+$'
                THEN ROUND((pt.metadata->>'cash_tendered_cents')::numeric / 100, 2)
                ELSE NULL
            END AS cash_tendered,
            CASE
                WHEN LOWER(pt.payment_method) = 'cash'
                 AND COALESCE(pt.metadata->>'change_due_cents', '') ~ '^[0-9]+$'
                THEN ROUND((pt.metadata->>'change_due_cents')::numeric / 100, 2)
                ELSE NULL
            END AS change_due
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
           OR pt.metadata->>'checkout_transaction_id' = $1::text
        ORDER BY pt.created_at ASC
        "#,
    )
    .bind(transaction_id)
    .fetch_all(pool)
    .await?;

    let payments = payments_db
        .into_iter()
        .map(
            |(date, method, amount, cash_tendered, change_due)| TransactionDetailedPayment {
                date,
                method,
                amount,
                cash_tendered,
                change_due,
            },
        )
        .collect::<Vec<_>>();

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

    let pickup_applications = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            sqlx::types::Json<Vec<TransactionPickupApplicationItem>>,
        ),
    >(
        r#"
        SELECT
            target.id,
            COALESCE(
                NULLIF(TRIM(target.display_id), ''),
                target.counterpoint_doc_ref,
                target.counterpoint_ticket_ref,
                target.id::text
            ) AS target_display_id,
            jsonb_agg(jsonb_build_object(
                'product_name', COALESCE(NULLIF(TRIM(p.name), ''), pv.sku, 'Item'),
                'sku', COALESCE(pv.sku, 'Unknown SKU'),
                'quantity', tl.quantity,
                'unit_price', tl.unit_price::text,
                'variation_label', NULLIF(TRIM(pv.variation_label), '')
            ) ORDER BY tl.id) AS items
        FROM transaction_activity_log activity
        INNER JOIN transactions target ON target.id = activity.transaction_id
        CROSS JOIN LATERAL jsonb_array_elements_text(
            COALESCE(activity.metadata->'delivered_item_ids', '[]'::jsonb)
        ) delivered(line_id)
        INNER JOIN transaction_lines tl ON tl.id = delivered.line_id::uuid
        LEFT JOIN products p ON p.id = tl.product_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        WHERE activity.event_kind = 'pickup'
          AND activity.metadata->>'checkout_transaction_id' = $1::text
        GROUP BY target.id, target.display_id, target.counterpoint_doc_ref, target.counterpoint_ticket_ref
        ORDER BY target.display_id NULLS LAST, target.id
        "#,
    )
    .bind(transaction_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(target_transaction_id, target_display_id, items)| TransactionPickupApplication {
        target_transaction_id,
        target_display_id,
        items: items.0,
    })
    .collect::<Vec<_>>();

    let mut items: Vec<TransactionDetailItem> = items
        .into_iter()
        .map(|r| TransactionDetailItem {
            transaction_line_id: r.transaction_line_id,
            booked_at: r.booked_at,
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
            tax_category: r.tax_category,
            fulfillment: r.fulfillment,
            order_lifecycle_status: r.order_lifecycle_status,
            alteration_status: r.alteration_status,
            is_fulfilled: r.is_fulfilled,
            is_internal: r.is_internal,
            custom_item_type: r.custom_item_type,
            custom_order_details: r.custom_order_details,
            salesperson_id: r.salesperson_id,
            salesperson_name: r.salesperson_name,
            receipt_original_unit_price: r.receipt_original_unit_price,
            discount_event_label: r.discount_event_label,
            gift_card_load_code: r.gift_card_load_code,
            po_id: r.po_id,
            po_line_id: r.po_line_id,
            po_number: r.po_number,
            vendor_id: r.vendor_id,
            vendor_name: r.vendor_name,
            vendor_eta: r.vendor_eta,
            vendor_reference: r.vendor_reference,
            ordered_at: r.ordered_at,
            received_at: r.received_at,
            ready_for_pickup_at: r.ready_for_pickup_at,
            picked_up_at: r.picked_up_at,
            shipped_at: r.shipped_at,
            shipment_id: r.shipment_id,
            fulfilled_at: r.fulfilled_at,
        })
        .collect();
    normalize_counterpoint_legacy_detail_items(&h, &mut items);

    let customer = match (h.customer_id, h.customer_first_name, h.customer_last_name) {
        (Some(id), Some(first_name), Some(last_name)) => Some(TransactionCustomerSummary {
            id,
            customer_code: h.customer_code.unwrap_or_default(),
            first_name,
            last_name,
            phone: h.customer_phone,
            email: h.customer_email,
        }),
        _ => None,
    };

    let wedding_summary = match (h.wedding_party_id, h.wedding_member_id) {
        (Some(wedding_party_id), Some(wedding_member_id)) => Some(TransactionWeddingSummary {
            wedding_party_id,
            wedding_member_id,
            party_name: h.wedding_party_name,
            event_date: h.wedding_event_date,
            member_role: h.wedding_member_role,
        }),
        _ => None,
    };

    let transaction_line_ids = items
        .iter()
        .map(|item| item.transaction_line_id)
        .collect::<Vec<_>>();
    let lifecycle_events = if transaction_line_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, TransactionLineLifecycleEvent>(
            r#"
            SELECT
                e.id,
                e.transaction_line_id,
                e.old_status,
                e.new_status,
                e.actor_staff_id,
                s.full_name AS actor_name,
                e.source_workflow,
                e.reason,
                e.metadata,
                e.created_at
            FROM transaction_line_lifecycle_events e
            LEFT JOIN staff s ON s.id = e.actor_staff_id
            WHERE e.transaction_line_id = ANY($1)
            ORDER BY e.created_at DESC, e.id DESC
            "#,
        )
        .bind(&transaction_line_ids)
        .fetch_all(pool)
        .await?
    };

    let (total_allocated_payments, total_applied_deposit_amount): (Option<Decimal>, Option<Decimal>) =
        sqlx::query_as(
            r#"
            SELECT
                COALESCE(SUM(pa.amount_allocated)::numeric(14,2), 0::numeric) AS total_allocated_payments,
                COALESCE(SUM(NULLIF(pa.metadata->>'applied_deposit_amount', '')::numeric(14,2)), 0::numeric) AS total_applied_deposit_amount
            FROM payment_allocations pa
            WHERE pa.target_transaction_id = $1
            "#,
        )
        .bind(transaction_id)
        .fetch_one(pool)
        .await?;

    let linked_alteration_summary = sqlx::query_as::<_, TransactionLinkedAlterationSummary>(
        r#"
        SELECT
            COUNT(*) FILTER (
                WHERE a.status IN ('intake'::alteration_status, 'in_work'::alteration_status, 'verify_completed'::alteration_status)
            )::bigint AS open_count,
            COUNT(*) FILTER (
                WHERE a.status IN ('intake'::alteration_status, 'in_work'::alteration_status, 'verify_completed'::alteration_status)
                  AND a.due_at IS NOT NULL
                  AND a.due_at < now()
            )::bigint AS overdue_count,
            COUNT(*) FILTER (
                WHERE a.status = 'ready'::alteration_status
            )::bigint AS ready_count,
            COUNT(*) FILTER (
                WHERE a.status = 'picked_up'::alteration_status
            )::bigint AS picked_up_count
        FROM alteration_orders a
        WHERE a.transaction_id = $1
           OR a.source_transaction_id = $1
           OR a.source_transaction_line_id = ANY($2::uuid[])
        "#,
    )
    .bind(transaction_id)
    .bind(&transaction_line_ids)
    .fetch_one(pool)
    .await?;
    let linked_alterations = sqlx::query_as::<_, TransactionLinkedAlteration>(
        r#"
        SELECT
            a.id,
            a.status::text AS status,
            a.item_description,
            a.work_requested,
            a.source_sku,
            a.ticket_number,
            a.source_transaction_line_id,
            a.picked_up_at
        FROM alteration_orders a
        WHERE a.transaction_id = $1
           OR a.source_transaction_id = $1
           OR a.source_transaction_line_id = ANY($2::uuid[])
        ORDER BY
            CASE a.status
                WHEN 'ready'::alteration_status THEN 0
                WHEN 'verify_completed'::alteration_status THEN 1
                WHEN 'in_work'::alteration_status THEN 2
                WHEN 'intake'::alteration_status THEN 3
                ELSE 4
            END,
            a.created_at DESC
        "#,
    )
    .bind(transaction_id)
    .bind(&transaction_line_ids)
    .fetch_all(pool)
    .await?;

    let receipt_cfg_raw: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let (receipt_studio_layout_available, receipt_thermal_mode) = if let Some(v) = receipt_cfg_raw {
        match serde_json::from_value::<crate::api::settings::ReceiptConfig>(v) {
            Ok(c) => {
                let c = c.normalize_runtime();
                (
                    c.receipt_studio_exported_html
                        .as_ref()
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false),
                    c.receipt_thermal_mode,
                )
            }
            Err(_) => (false, "escpos".to_string()),
        }
    } else {
        (false, "escpos".to_string())
    };
    let void_record = load_void_record(pool, transaction_id).await?;
    let has_order_fulfillment = items.iter().any(|item| {
        matches!(
            item.fulfillment,
            DbFulfillmentType::SpecialOrder
                | DbFulfillmentType::Custom
                | DbFulfillmentType::WeddingOrder
                | DbFulfillmentType::Layaway
        )
    });
    let allocated_payment_total = total_allocated_payments.unwrap_or(Decimal::ZERO);
    let explicit_deposit_total = total_applied_deposit_amount.unwrap_or(Decimal::ZERO);
    let deposit_total = if has_order_fulfillment {
        explicit_deposit_total
            .max(allocated_payment_total)
            .max(h.amount_paid)
    } else {
        explicit_deposit_total
    };

    Ok(TransactionDetailResponse {
        transaction_id: h.id,
        transaction_display_id: h.display_id,
        booked_at: h.booked_at,
        status: h.status,
        total_price: h.total_price,
        amount_paid: h.amount_paid,
        balance_due: h.balance_due,
        is_counterpoint_import: h.is_counterpoint_import,
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
        pickup_applications,
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
            total_allocated_payments: allocated_payment_total,
            total_applied_deposit_amount: deposit_total,
        },
        linked_alteration_summary,
        linked_alterations,
        items,
        lifecycle_events,
        receipt_studio_layout_available,
        receipt_thermal_mode,
        store_review_invites_enabled: review_pol.review_invites_enabled,
        store_send_review_invite_by_default: review_pol.send_review_invite_by_default,
        review_invite_sent_at: h.review_invite_sent_at,
        review_invite_suppressed_at: h.review_invite_suppressed_at,
        customer_review_requests_opt_out: h.customer_review_requests_opt_out,
        void_record,
        payments,
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

fn return_line_inputs_from_body(
    lines: &[TransactionReturnLineBody],
    default_reason: &str,
) -> Vec<ReturnLineInput> {
    lines
        .iter()
        .map(|line| ReturnLineInput {
            transaction_line_id: line.transaction_line_id,
            quantity: line.quantity,
            reason: Some(
                line.reason
                    .as_deref()
                    .filter(|reason| !reason.trim().is_empty())
                    .unwrap_or(default_reason)
                    .to_string(),
            ),
            restock: line.restock,
        })
        .collect()
}

async fn post_transaction_returns(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<PostTransactionReturnsRequest>,
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

    let inputs = return_line_inputs_from_body(&body.lines, "return");

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
    Json(body): Json<TransactionExchangeLinkBody>,
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

async fn patch_transaction_financial_date(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchTransactionFinancialDateRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, QBO_STAGING_APPROVE)
        .await
        .map_err(map_perm_err)?;
    let reason = body.reason.trim();
    if reason.is_empty() {
        return Err(TransactionError::InvalidPayload(
            "Add a reason before changing the financial date.".to_string(),
        ));
    }
    let payment_effective_date = body.payment_effective_date.unwrap_or(body.business_date);

    let mut tx = state.db.begin().await?;
    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1 FOR UPDATE")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(TransactionError::NotFound)?;

    sqlx::query(
        r#"
        UPDATE transactions
        SET
            booked_at = (($2::date + TIME '15:00') AT TIME ZONE reporting.effective_store_timezone()),
            fulfilled_at = CASE
                WHEN fulfilled_at IS NOT NULL
                THEN (($2::date + TIME '15:00') AT TIME ZONE reporting.effective_store_timezone())
                ELSE fulfilled_at
            END,
            business_date = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'qbo_revision_required', true,
                'financial_date_correction', jsonb_build_object(
                    'business_date', $2::text,
                    'payment_effective_date', $3::text,
                    'reason', $4::text,
                    'staff_id', $5::text,
                    'corrected_at', NOW()
                )
            )
        WHERE id = $1
        "#,
    )
    .bind(transaction_id)
    .bind(body.business_date)
    .bind(payment_effective_date)
    .bind(reason)
    .bind(staff.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE transaction_lines
        SET fulfilled_at = CASE
            WHEN is_fulfilled THEN (($2::date + TIME '15:00') AT TIME ZONE reporting.effective_store_timezone())
            ELSE fulfilled_at
        END
        WHERE transaction_id = $1
        "#,
    )
    .bind(transaction_id)
    .bind(body.business_date)
    .execute(&mut *tx)
    .await?;

    let payment_rows = sqlx::query(
        r#"
        UPDATE payment_transactions pt
        SET
            effective_date = $2,
            metadata = COALESCE(pt.metadata, '{}'::jsonb) || jsonb_build_object(
                'payment_effective_date_corrected', true,
                'payment_effective_date_reason', $3::text,
                'payment_effective_date_staff_id', $4::text
            )
        WHERE pt.metadata->>'checkout_transaction_id' = $1::text
           OR EXISTS (
              SELECT 1
              FROM payment_allocations pa
              WHERE pa.transaction_id = pt.id
                AND pa.target_transaction_id = $1
           )
        "#,
    )
    .bind(transaction_id)
    .bind(payment_effective_date)
    .bind(reason)
    .bind(staff.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    tx.commit().await?;

    log_order_activity(
        &state.db,
        transaction_id,
        customer_id,
        "financial_date_corrected",
        "Financial date corrected for QBO review",
        json!({
            "business_date": body.business_date,
            "payment_effective_date": payment_effective_date,
            "payment_rows_updated": payment_rows,
            "staff_id": staff.id,
            "reason": reason,
        }),
    )
    .await?;
    let _ = log_staff_access(
        &state.db,
        staff.id,
        "financial_date_corrected",
        json!({
            "transaction_id": transaction_id,
            "business_date": body.business_date,
            "payment_effective_date": payment_effective_date,
            "payment_rows_updated": payment_rows,
        }),
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "transaction_id": transaction_id,
        "business_date": body.business_date,
        "payment_effective_date": payment_effective_date,
        "payment_rows_updated": payment_rows
    })))
}

async fn add_transaction_line(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<AddTransactionLineRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
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
    let transaction_line_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO transaction_lines (
            transaction_id, product_id, variant_id, fulfillment, quantity,
            unit_price, unit_cost, state_tax, local_tax, is_fulfilled, salesperson_id, booked_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)
        RETURNING id
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
    .fetch_one(&mut *tx)
    .await?;
    let initial_status = match body.order_lifecycle_status {
        Some(DbOrderItemLifecycleStatus::NeedsMeasurements) => {
            DbOrderItemLifecycleStatus::NeedsMeasurements
        }
        Some(DbOrderItemLifecycleStatus::Ntbo) | None => DbOrderItemLifecycleStatus::Ntbo,
        Some(other) => {
            return Err(TransactionError::InvalidPayload(format!(
                "order line cannot be added as {}",
                other.as_str()
            )));
        }
    };
    order_lifecycle::initialize_line_tx(
        &mut tx,
        transaction_line_id,
        initial_status,
        Some(staff.id),
        "transaction_line_add",
    )
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
    let staff = middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
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

    let current_line: Option<(
        Uuid,
        DbOrderItemLifecycleStatus,
        bool,
        DbFulfillmentType,
        String,
    )> = sqlx::query_as(
        r#"
            SELECT oi.product_id, oi.order_lifecycle_status, oi.is_fulfilled, oi.fulfillment, pv.sku
            FROM transaction_lines oi
            JOIN product_variants pv ON pv.id = oi.variant_id
            WHERE oi.id = $1
              AND oi.transaction_id = $2
            FOR UPDATE
            "#,
    )
    .bind(transaction_line_id)
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((
        current_product_id,
        current_lifecycle_status,
        is_fulfilled,
        current_fulfillment,
        current_sku,
    )) = current_line
    else {
        return Err(TransactionError::NotFound);
    };

    if let Some(next_variant_id) = body.variant_id {
        let variant_product_id: Option<Uuid> =
            sqlx::query_scalar("SELECT product_id FROM product_variants WHERE id = $1")
                .bind(next_variant_id)
                .fetch_optional(&mut *tx)
                .await?;
        match variant_product_id {
            Some(product_id) if product_id == current_product_id => {}
            Some(_) => {
                return Err(TransactionError::InvalidPayload(
                    "Use Delete and Add when changing to a different item.".to_string(),
                ));
            }
            None => {
                return Err(TransactionError::InvalidPayload(
                    "variant not found".to_string(),
                ))
            }
        }
    }

    if let Some(next_status) = body.order_lifecycle_status {
        if is_fulfilled || current_fulfillment == DbFulfillmentType::Takeaway {
            return Err(TransactionError::InvalidPayload(
                "fulfilled items cannot be moved back into order review.".to_string(),
            ));
        }
        if !matches!(
            current_lifecycle_status,
            DbOrderItemLifecycleStatus::NeedsMeasurements | DbOrderItemLifecycleStatus::Ntbo
        ) {
            return Err(TransactionError::InvalidPayload(
                "only items waiting on measurements or vendor ordering can be changed here"
                    .to_string(),
            ));
        }
        if !matches!(
            next_status,
            DbOrderItemLifecycleStatus::NeedsMeasurements | DbOrderItemLifecycleStatus::Ntbo
        ) {
            return Err(TransactionError::InvalidPayload(
                "item edit can only mark Needs Measurements or Ready to Order".to_string(),
            ));
        }
    }

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
    if body.variant_id.is_some() {
        touched = true;
    }
    if normalized_fulfillment.is_some() {
        touched = true;
    }
    let canonical_custom_details = if let Some(details) = body.custom_order_details.as_ref() {
        let subtype = known_custom_subtype_for_sku(&current_sku).ok_or_else(|| {
            TransactionError::InvalidPayload(
                "custom details can only be saved for a configured Custom SKU".to_string(),
            )
        })?;
        Some(
            canonical_custom_order_details(Some(subtype), Some(details)).ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "custom details were not in the expected form".to_string(),
                )
            })?,
        )
    } else {
        None
    };
    if touched {
        sqlx::query(
            r#"
            UPDATE transaction_lines
            SET
                quantity = COALESCE($1, quantity),
                unit_price = COALESCE($2, unit_price),
                fulfillment = COALESCE($3, fulfillment),
                variant_id = COALESCE($4, variant_id)
            WHERE id = $5
              AND transaction_id = $6
            "#,
        )
        .bind(body.quantity)
        .bind(body.unit_price)
        .bind(normalized_fulfillment)
        .bind(body.variant_id)
        .bind(transaction_line_id)
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(details) = canonical_custom_details.as_ref() {
        sqlx::query(
            r#"
            UPDATE transaction_lines
            SET size_specs = jsonb_set(
                COALESCE(size_specs, '{}'::jsonb),
                '{custom_order_details}',
                $1::jsonb,
                true
            )
            WHERE id = $2
              AND transaction_id = $3
            "#,
        )
        .bind(sqlx::types::Json(details.clone()))
        .bind(transaction_line_id)
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(next_status) = body.order_lifecycle_status {
        order_lifecycle::apply_transition_tx(
            &mut tx,
            &[transaction_line_id],
            next_status,
            Some(staff.id),
            "transaction_line_edit",
            Some("Order item review updated"),
            json!({ "transaction_line_id": transaction_line_id }),
        )
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
        "Order item edited",
        json!({
            "transaction_line_id": transaction_line_id,
            "variant_id": body.variant_id,
            "quantity": body.quantity,
            "unit_price": body.unit_price,
            "fulfillment": normalized_fulfillment,
            "order_lifecycle_status": body.order_lifecycle_status.map(|s| s.as_str()),
            "custom_order_details_updated": canonical_custom_details.is_some(),
        }),
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
        let Some((h_sid, tok, station_key)) = pos_session::pos_session_headers(&headers) else {
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
        let ok = pos_session::verify_pos_session_token(&state.db, h_sid, &tok, &station_key)
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
    let staff = middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    let mut tx = state.db.begin().await?;

    let line_state: Option<(
        Option<Uuid>,
        DbOrderStatus,
        bool,
        DbFulfillmentType,
        DbOrderItemLifecycleStatus,
        i32,
        bool,
    )> = sqlx::query_as(
        r#"
        SELECT
            t.customer_id,
            t.status,
            tl.is_fulfilled,
            tl.fulfillment,
            tl.order_lifecycle_status,
            tl.quantity,
            EXISTS (
                SELECT 1
                FROM payment_allocations pa
                WHERE pa.target_transaction_id = t.id
            ) AS has_payments
        FROM transactions t
        INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
        WHERE t.id = $1 AND tl.id = $2
        FOR UPDATE OF t, tl
        "#,
    )
    .bind(transaction_id)
    .bind(transaction_line_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((
        customer_id,
        status,
        is_fulfilled,
        fulfillment,
        lifecycle_status,
        quantity,
        has_payments,
    )) = line_state
    else {
        return Err(TransactionError::NotFound);
    };

    if !matches!(
        status,
        DbOrderStatus::Open | DbOrderStatus::PendingMeasurement
    ) {
        return Err(TransactionError::InvalidPayload(
            "Only open unpaid order lines can be deleted. Use void, return, or cancellation workflow for completed or processing transactions.".to_string(),
        ));
    }
    if has_payments {
        return Err(TransactionError::InvalidPayload(
            "Paid transactions cannot have lines deleted. Use return, refund, or cancellation workflow.".to_string(),
        ));
    }
    if is_fulfilled || fulfillment == DbFulfillmentType::Takeaway {
        return Err(TransactionError::InvalidPayload(
            "Fulfilled or takeaway sale lines cannot be deleted. Use return or void workflow."
                .to_string(),
        ));
    }
    if !matches!(
        lifecycle_status,
        DbOrderItemLifecycleStatus::NeedsMeasurements | DbOrderItemLifecycleStatus::Ntbo
    ) {
        return Err(TransactionError::InvalidPayload(
            "Only uncommitted order lines waiting on measurements or vendor ordering can be deleted."
                .to_string(),
        ));
    }

    sqlx::query("DELETE FROM transaction_lines WHERE id = $1 AND transaction_id = $2")
        .bind(transaction_line_id)
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;

    insert_transaction_activity_log_tx(
        &mut tx,
        transaction_id,
        customer_id,
        "item_deleted",
        "Order item removed",
        json!({
            "transaction_line_id": transaction_line_id,
            "quantity": quantity,
            "fulfillment": fulfillment,
            "order_lifecycle_status": lifecycle_status,
            "deleted_by_staff_id": staff.id,
        }),
    )
    .await?;
    tx.commit().await?;
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
                warnings: Vec::new(),
            }))
        }
        CheckoutDone::Completed {
            transaction_id,
            display_id,
            operator_staff_id,
            customer_id: _customer_id,
            price_override_audit: _price_override_audit,
            alteration_order_ids,
            amount_paid,
            total_price,
            warnings,
        } => {
            spawn_meilisearch_transaction_upsert(&state, transaction_id);
            spawn_meilisearch_alteration_upserts(&state, alteration_order_ids);

            Ok(Json(CheckoutResponse {
                transaction_id,
                transaction_display_id: display_id,
                status: "success".to_string(),
                loyalty_points_earned: 0,
                loyalty_points_balance: None,
                warnings,
            }))
        }
    }
}

async fn staff_id_active_salesperson(
    pool: &sqlx::PgPool,
    id: Uuid,
) -> Result<bool, TransactionError> {
    let ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM staff
            WHERE id = $1
              AND is_active = TRUE
              AND (role = 'salesperson' OR base_commission_rate > 0)
        )
        "#,
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(TransactionError::Database)?;
    Ok(ok)
}

async fn patch_transaction_attribution(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Json(body): Json<PatchTransactionAttributionRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let pin = body.manager_pin.trim();
    if pin.is_empty() {
        return Err(TransactionError::InvalidPayload(
            "manager_pin is required".to_string(),
        ));
    }

    let admin = pins::authenticate_staff_by_id(&state.db, body.manager_staff_id, Some(pin))
        .await
        .map_err(|_| {
            TransactionError::Unauthorized(
                "valid Manager Access staff and PIN required".to_string(),
            )
        })?;
    let eff =
        crate::auth::permissions::effective_permissions_for_staff(&state.db, admin.id, admin.role)
            .await
            .map_err(TransactionError::Database)?;
    if !staff_can_approve_manager_access(&eff, admin.role) {
        return Err(TransactionError::Forbidden(
            "manager.approval permission required".to_string(),
        ));
    }
    let corrector_id = admin.id;

    if body.line_attribution.is_empty() && body.primary_salesperson_id.is_none() {
        return Err(TransactionError::InvalidPayload(
            "provide primary_salesperson_id and/or line_attribution".to_string(),
        ));
    }

    if let Some(pid) = body.primary_salesperson_id {
        if !staff_id_active_salesperson(&state.db, pid).await? {
            return Err(TransactionError::InvalidPayload(
                "primary_salesperson_id must be an active salesperson".to_string(),
            ));
        }
    }

    for line in &body.line_attribution {
        if let Some(sid) = line.salesperson_id {
            if !staff_id_active_salesperson(&state.db, sid).await? {
                return Err(TransactionError::InvalidPayload(format!(
                    "salesperson_id must be an active salesperson for line {}",
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
        has_commission_event: bool,
    }

    for line in &body.line_attribution {
        let row: Option<LineAttribRow> = sqlx::query_as(
            r#"
            SELECT
                oi.salesperson_id,
                EXISTS (
                    SELECT 1
                    FROM commission_events ce
                    WHERE ce.transaction_line_id = oi.id
                ) AS has_commission_event
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
            has_commission_event,
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

        line_attribution_changes += 1;

        crate::logic::commission_recalc::recalc_transaction_line_commission(
            &mut tx,
            transaction_id,
            line.transaction_line_id,
            line.salesperson_id,
        )
        .await
        .map_err(TransactionError::Database)?;

        if has_commission_event {
            sqlx::query(
                r#"
                UPDATE commission_events ce
                SET
                    staff_id = oi.salesperson_id,
                    base_rate_used = COALESCE((
                        SELECT h.base_commission_rate
                        FROM staff_commission_rate_history h
                        WHERE h.staff_id = oi.salesperson_id
                          AND h.effective_start_date <= ce.event_at::date
                        ORDER BY h.effective_start_date DESC, h.created_at DESC
                        LIMIT 1
                    ), st.base_commission_rate, 0),
                    total_commission_amount = oi.calculated_commission,
                    base_commission_amount = CASE
                        WHEN ce.event_type = 'combo_incentive' THEN 0
                        ELSE ROUND((oi.unit_price * oi.quantity) * COALESCE((
                            SELECT h.base_commission_rate
                            FROM staff_commission_rate_history h
                            WHERE h.staff_id = oi.salesperson_id
                              AND h.effective_start_date <= ce.event_at::date
                            ORDER BY h.effective_start_date DESC, h.created_at DESC
                            LIMIT 1
                        ), st.base_commission_rate, 0), 2)
                    END,
                    incentive_amount = CASE
                        WHEN ce.event_type = 'combo_incentive' THEN oi.calculated_commission
                        ELSE oi.calculated_commission - ROUND((oi.unit_price * oi.quantity) * COALESCE((
                            SELECT h.base_commission_rate
                            FROM staff_commission_rate_history h
                            WHERE h.staff_id = oi.salesperson_id
                              AND h.effective_start_date <= ce.event_at::date
                            ORDER BY h.effective_start_date DESC, h.created_at DESC
                            LIMIT 1
                        ), st.base_commission_rate, 0), 2)
                    END,
                    snapshot_json = jsonb_set(
                        jsonb_set(
                            ce.snapshot_json,
                            '{staff_name}',
                            to_jsonb(COALESCE(st.full_name, 'Unassigned')),
                            true
                        ),
                        '{attribution_corrected_by_staff_id}',
                        to_jsonb($3::text),
                        true
                    ),
                    note = CONCAT_WS(
                        ' ',
                        NULLIF(ce.note, ''),
                        '(Attribution corrected after recognition; see order_attribution_audit.)'
                    )
                FROM transaction_lines oi
                LEFT JOIN staff st ON st.id = oi.salesperson_id
                WHERE ce.transaction_line_id = oi.id
                  AND oi.transaction_id = $1
                  AND oi.id = $2
                  AND ce.event_type IN ('sale_commission', 'combo_incentive')
                "#,
            )
            .bind(transaction_id)
            .bind(line.transaction_line_id)
            .bind(corrector_id)
            .execute(&mut *tx)
            .await
            .map_err(TransactionError::Database)?;
        }

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
