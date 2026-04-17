use super::helpers::authorize_transaction_read_bo_or_register;
use super::TransactionError;
use crate::api::AppState;
use crate::logic::podium;
use crate::logic::podium_reviews;
use crate::logic::receipt_plain_text;
use crate::logic::receipt_studio_html;
use crate::logic::receipt_zpl;
use crate::models::{DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

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
pub struct TransactionDetailItem {
    pub transaction_line_id: Uuid,
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub variation_label: Option<String>,
    pub quantity: i32,
    pub quantity_returned: i32,
    pub unit_price: Decimal,
    pub unit_cost: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    pub fulfillment: DbFulfillmentType,
    pub is_fulfilled: bool,
    pub is_internal: bool,
    pub salesperson_id: Option<Uuid>,
    pub salesperson_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_original_unit_price: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount_event_label: Option<String>,
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
    pub operator_staff_id: Option<Uuid>,
    pub operator_name: Option<String>,
    pub primary_salesperson_id: Option<Uuid>,
    pub primary_salesperson_name: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    pub customer: Option<OrderCustomerSummary>,
    pub financial_summary: TransactionFinancialSummary,
    pub items: Vec<TransactionDetailItem>,
    pub is_tax_exempt: bool,
    pub tax_exempt_reason: Option<String>,
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub receipt_studio_layout_available: bool,
    #[serde(default)]
    pub receipt_thermal_mode: String,
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

#[derive(Debug, Deserialize)]
pub struct TransactionReadQuery {
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PostOrderReviewInviteBody {
    #[serde(default)]
    pub skip: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TransactionAuditEvent {
    pub id: Uuid,
    pub event_kind: String,
    pub summary: String,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
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
    salesperson_id: Option<Uuid>,
    salesperson_name: Option<String>,
    receipt_original_unit_price: Option<Decimal>,
    discount_event_label: Option<String>,
}

impl TransactionDetailResponse {
    pub fn receipt_for_zpl_filtered(
        &self,
        transaction_line_ids: Option<&[Uuid]>,
    ) -> Result<receipt_zpl::ReceiptOrderForZpl, TransactionError> {
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

        Ok(receipt_zpl::ReceiptOrderForZpl {
            transaction_id: self.transaction_id,
            booked_at: self.booked_at,
            status: self.status,
            total_price: self.total_price,
            amount_paid: self.amount_paid,
            balance_due: self.balance_due,
            payment_methods_summary: self.payment_methods_summary.clone(),
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
                .map(|it| receipt_zpl::ReceiptLineForZpl {
                    product_name: it.product_name.clone(),
                    sku: it.sku.clone(),
                    quantity: it.quantity,
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{transaction_id}", get(get_transaction_detail))
        .route("/{transaction_id}/audit", get(get_transaction_audit))
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
            axum::routing::post(post_transaction_receipt_send_email),
        )
        .route(
            "/{transaction_id}/receipt/send-sms",
            axum::routing::post(post_transaction_receipt_send_sms),
        )
        .route(
            "/{transaction_id}/review-invite",
            axum::routing::post(post_transaction_review_invite),
        )
}

pub async fn load_transaction_detail(
    pool: &PgPool,
    transaction_id: Uuid,
) -> Result<TransactionDetailResponse, TransactionError> {
    let h: OrderHeaderRow = sqlx::query_as(
        r#"
        SELECT o.id, o.display_id, o.booked_at, o.status, o.total_price, o.amount_paid,
               (o.total_price - o.amount_paid)::numeric(14,2) AS balance_due,
               o.is_forfeited, o.forfeited_at, o.forfeiture_reason, o.fulfillment_method,
               o.ship_to, o.shipping_amount_usd, o.shippo_shipment_object_id,
               o.shippo_transaction_object_id, o.tracking_number, o.tracking_url_provider,
               o.shipping_label_url, o.exchange_group_id, o.customer_id,
               c.first_name AS customer_first_name, c.last_name AS customer_last_name,
               c.phone AS customer_phone, c.email AS customer_email,
               o.wedding_member_id, o.operator_staff_id, op.name AS operator_name,
               o.primary_salesperson_id, ps.name AS primary_salesperson_name,
               o.review_invite_sent_at, o.review_invite_suppressed_at,
               ss.review_policy AS store_review_policy, o.is_tax_exempt, o.tax_exempt_reason,
               o.register_session_id
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN staff op ON op.id = o.operator_staff_id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        CROSS JOIN store_settings ss
        WHERE o.id = $1 AND ss.id = 1
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(pool)
    .await?
    .ok_or(TransactionError::NotFound)?;

    let pms: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT pt.payment_method
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
        "#,
    )
    .bind(transaction_id)
    .fetch_all(pool)
    .await?;
    let payment_methods_summary = if pms.is_empty() {
        "—".to_string()
    } else {
        pms.join(", ")
    };

    let customer = h.customer_id.map(|cid| OrderCustomerSummary {
        id: cid,
        first_name: h.customer_first_name.unwrap_or_default(),
        last_name: h.customer_last_name.unwrap_or_default(),
        phone: h.customer_phone,
        email: h.customer_email,
    });

    let review_pol: crate::logic::podium_reviews::StoreReviewPolicy =
        serde_json::from_value(h.store_review_policy.0).unwrap_or_default();

    let items_raw: Vec<OrderItemRow> = sqlx::query_as(
        r#"
        SELECT oi.id AS transaction_line_id, oi.product_id, oi.variant_id,
               v.sku, p.product_name, v.variation_label, oi.quantity,
               COALESCE((SELECT SUM(quantity) FROM transaction_return_lines rl WHERE rl.transaction_line_id = oi.id), 0)::int AS quantity_returned,
               oi.unit_price, oi.unit_cost, oi.state_tax, oi.local_tax,
               oi.fulfillment, oi.is_fulfilled, p.is_internal,
               oi.salesperson_id, sp.name AS salesperson_name,
               (oi.size_specs->>'original_unit_price')::numeric(14,2) AS receipt_original_unit_price,
               (oi.size_specs->>'discount_event_label') AS discount_event_label
        FROM transaction_lines oi
        INNER JOIN product_variants v ON v.id = oi.variant_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN staff sp ON sp.id = oi.salesperson_id
        WHERE oi.transaction_id = $1
        ORDER BY oi.created_at ASC
        "#,
    )
    .bind(transaction_id)
    .fetch_all(pool)
    .await?;

    let items: Vec<TransactionDetailItem> = items_raw
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
            salesperson_id: r.salesperson_id,
            salesperson_name: r.salesperson_name,
            receipt_original_unit_price: r.receipt_original_unit_price,
            discount_event_label: r.discount_event_label,
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
        operator_staff_id: h.operator_staff_id,
        operator_name: h.operator_name,
        primary_salesperson_id: h.primary_salesperson_id,
        primary_salesperson_name: h.primary_salesperson_name,
        wedding_member_id: h.wedding_member_id,
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

async fn get_transaction_audit(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<TransactionAuditEvent>>, TransactionError> {
    crate::middleware::require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(super::helpers::map_perm_err)?;
    let rows: Vec<TransactionAuditEvent> = sqlx::query_as(
        r#"
        SELECT id, event_kind, summary, metadata, created_at
        FROM transaction_activity_log
        WHERE transaction_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(transaction_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_transaction_receipt_zpl(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, TransactionError> {
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    let line_ids = params.get("transaction_line_ids").map(|s| {
        s.split(',')
            .filter_map(|t| Uuid::parse_str(t.trim()).ok())
            .collect::<Vec<_>>()
    });
    let receipt_order = detail.receipt_for_zpl_filtered(line_ids.as_deref())?;

    let receipt_cfg: sqlx::types::Json<crate::api::settings::ReceiptConfig> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let zpl = receipt_zpl::build_receipt_zpl(&receipt_order, &receipt_cfg, None, None, params);
    Ok(([(header::CONTENT_TYPE, "text/plain")], zpl).into_response())
}

async fn get_transaction_receipt_html(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, TransactionError> {
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    let gift = params
        .get("gift")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let line_ids = params.get("transaction_line_ids").map(|s| {
        s.split(',')
            .filter_map(|t| Uuid::parse_str(t.trim()).ok())
            .collect::<Vec<_>>()
    });
    let receipt_order = detail.receipt_for_zpl_filtered(line_ids.as_deref())?;

    let receipt_cfg: sqlx::types::Json<crate::api::settings::ReceiptConfig> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let tpl = receipt_cfg
        .receipt_studio_exported_html
        .as_deref()
        .unwrap_or("");

    let html =
        receipt_studio_html::merge_receipt_studio_html(tpl, &receipt_order, &receipt_cfg, gift);
    Ok(([(header::CONTENT_TYPE, "text/html")], html).into_response())
}

async fn post_transaction_receipt_send_email(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let email = body
        .get("email")
        .and_then(|v| v.as_str())
        .ok_or_else(|| TransactionError::InvalidPayload("email required".into()))?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    let receipt_order = detail.receipt_for_zpl_filtered(None)?;

    let receipt_cfg: sqlx::types::Json<crate::api::settings::ReceiptConfig> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let text = receipt_plain_text::format_pos_receipt_text_message(&receipt_order, &receipt_cfg);
    let subject = format!("Receipt from {}", receipt_cfg.store_name);

    podium::send_podium_email_message(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        email,
        &subject,
        &text,
    )
    .await
    .map_err(|e| TransactionError::BadGateway(e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

async fn post_transaction_receipt_send_sms(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let phone = body
        .get("phone")
        .and_then(|v| v.as_str())
        .ok_or_else(|| TransactionError::InvalidPayload("phone required".into()))?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    let receipt_order = detail.receipt_for_zpl_filtered(None)?;

    let receipt_cfg: sqlx::types::Json<crate::api::settings::ReceiptConfig> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let text = receipt_plain_text::format_pos_receipt_text_message(&receipt_order, &receipt_cfg);

    podium::send_podium_sms_message(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        phone,
        &text,
    )
    .await
    .map_err(|e| TransactionError::BadGateway(e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
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
