//! Public `/api/store/*` (catalog, pages, coupons, tax, guest cart session, media) + Shippo shipping rates (`POST /shipping/rates`).
//! Admin: `/api/admin/store/*` (CMS pages, coupons, image assets for Studio).
//!
//! **FUTURE (Online Store checkout):** Guest `POST /shipping/rates` is **estimate-only** until `POST /api/store/checkout`
//! binds `rate_quote_id` into a paid order. Label purchase and Shippo webhooks for web orders are **not** implemented
//! here — use POS / Back Office shipments. See `docs/PLAN_ONLINE_STORE_MODULE.md` and `docs/PLAN_SHIPPO_SHIPPING.md`.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, ONLINE_STORE_MANAGE, SETTINGS_ADMIN,
};
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::shippo::{self, ShippoError};
use crate::logic::store_cart_resolve;
use crate::logic::store_catalog;
use crate::logic::store_checkout;
use crate::logic::store_guest_cart;
use crate::logic::store_media_asset;
use crate::logic::store_promotions::{self, CouponError};
use crate::logic::store_tax;
use crate::middleware;

// ── Shippo: POST /shipping/rates ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StoreShippingRatesBody {
    pub to_address: shippo::ShippingAddressInput,
    #[serde(default)]
    pub parcel: Option<shippo::ParcelInput>,
    /// When true, use demo rates only. Default **false**: live Shippo runs when Settings + `SHIPPO_API_TOKEN` allow (else server falls back to stub).
    #[serde(default)]
    pub force_stub: bool,
}

async fn post_store_shipping_rates(
    State(state): State<AppState>,
    Json(body): Json<StoreShippingRatesBody>,
) -> Result<Json<shippo::StoreShippingRatesResult>, StoreApiError> {
    let res = shippo::store_shipping_rates(
        &state.db,
        &state.http_client,
        &body.to_address,
        body.parcel.as_ref(),
        body.force_stub,
    )
    .await?;
    Ok(Json(res))
}

#[derive(Debug)]
enum StoreApiError {
    Shippo(ShippoError),
}

impl IntoResponse for StoreApiError {
    fn into_response(self) -> axum::response::Response {
        match self {
            StoreApiError::Shippo(ShippoError::InvalidAddress(m)) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response()
            }
            StoreApiError::Shippo(ShippoError::Parse(m)) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response()
            }
            StoreApiError::Shippo(ShippoError::Api(m)) => {
                tracing::warn!(error = %m, "store shipping rates API error");
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": "shipping provider unavailable" })),
                )
                    .into_response()
            }
            StoreApiError::Shippo(ShippoError::Database(e)) => {
                tracing::error!(error = %e, "store shipping rates DB error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "internal error" })),
                )
                    .into_response()
            }
        }
    }
}

impl From<ShippoError> for StoreApiError {
    fn from(e: ShippoError) -> Self {
        StoreApiError::Shippo(e)
    }
}

fn store_checkout_error_response(e: store_checkout::StoreCheckoutError) -> Response {
    let (status, message) = match e {
        store_checkout::StoreCheckoutError::Invalid(message) => (StatusCode::BAD_REQUEST, message),
        store_checkout::StoreCheckoutError::Provider(message) => (StatusCode::BAD_GATEWAY, message),
        store_checkout::StoreCheckoutError::NotFound => (
            StatusCode::NOT_FOUND,
            "checkout session not found".to_string(),
        ),
        store_checkout::StoreCheckoutError::NotReady => (
            StatusCode::CONFLICT,
            "checkout session is not ready for that action".to_string(),
        ),
        store_checkout::StoreCheckoutError::Database(error) => {
            tracing::error!(error = %error, "store checkout database error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "database error".to_string(),
            )
        }
        store_checkout::StoreCheckoutError::Stripe(error) => {
            tracing::error!(error = %error, "store checkout Stripe error");
            (
                StatusCode::BAD_GATEWAY,
                "payment processor unavailable".to_string(),
            )
        }
    };
    (status, Json(json!({ "error": message }))).into_response()
}

async fn get_checkout_config(State(state): State<AppState>) -> impl IntoResponse {
    match store_checkout::checkout_config(&state.db).await {
        Ok(config) => (StatusCode::OK, Json(json!(config))).into_response(),
        Err(e) => store_checkout_error_response(e),
    }
}

async fn post_checkout_session(
    State(state): State<AppState>,
    Json(body): Json<store_checkout::CreateCheckoutSessionInput>,
) -> impl IntoResponse {
    match store_checkout::create_session(&state, body).await {
        Ok(session) => (StatusCode::CREATED, Json(json!(session))).into_response(),
        Err(e) => store_checkout_error_response(e),
    }
}

async fn get_checkout_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
) -> impl IntoResponse {
    match store_checkout::load_session(&state.db, session_id).await {
        Ok(session) => (StatusCode::OK, Json(json!(session))).into_response(),
        Err(e) => store_checkout_error_response(e),
    }
}

async fn post_checkout_payment(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<store_checkout::CreatePaymentInput>,
) -> impl IntoResponse {
    match store_checkout::create_payment(&state, session_id, body).await {
        Ok(payment) => (StatusCode::OK, Json(json!(payment))).into_response(),
        Err(e) => store_checkout_error_response(e),
    }
}

async fn post_checkout_confirm(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<store_checkout::ConfirmPaymentInput>,
) -> impl IntoResponse {
    match store_checkout::confirm_payment(&state, session_id, body).await {
        Ok(payment) => (StatusCode::OK, Json(json!(payment))).into_response(),
        Err(e) => store_checkout_error_response(e),
    }
}

// ── Auth helper (admin) ─────────────────────────────────────────────────────

async fn require_store_manage_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedStaff, (StatusCode, Json<Value>)> {
    let staff = middleware::require_authenticated_staff_headers(state, headers).await?;
    let eff = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "effective_permissions failed (store admin)");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "permission resolution failed" })),
            )
        })?;
    if !staff_has_permission(&eff, ONLINE_STORE_MANAGE)
        && !staff_has_permission(&eff, SETTINGS_ADMIN)
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "missing permission", "permission": ONLINE_STORE_MANAGE })),
        ));
    }
    Ok(staff)
}

async fn require_store_manage(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<Value>)> {
    require_store_manage_staff(state, headers).await.map(|_| ())
}

fn sanitize_page_html(raw: &str) -> String {
    ammonia::Builder::default().clean(raw).to_string()
}

// ── Public catalog ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StoreListQuery {
    pub search: Option<String>,
    #[serde(default = "default_product_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_product_limit() -> i64 {
    48
}

async fn list_products(
    State(state): State<AppState>,
    Query(q): Query<StoreListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let rows = store_catalog::list_store_products(
        &state.db,
        q.search.as_deref(),
        q.limit,
        q.offset,
        state.meilisearch.as_ref(),
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "store list_products");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "database error" })),
        )
    })?;
    Ok(Json(json!({ "products": rows })))
}

async fn get_product(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let detail = store_catalog::get_store_product_by_slug(&state.db, &slug)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, slug = %slug, "store get_product");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
        })?;
    let Some(d) = detail else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "product not found" })),
        ));
    };
    Ok(Json(json!(d)))
}

// ── Published pages ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
struct PublishedPageRow {
    slug: String,
    title: String,
    seo_title: Option<String>,
    updated_at: chrono::DateTime<Utc>,
}

async fn list_published_pages(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_as::<_, PublishedPageRow>(
        r#"
        SELECT slug, title, seo_title, updated_at
        FROM store_pages
        WHERE published = true
        ORDER BY slug
        "#,
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => (StatusCode::OK, Json(json!({ "pages": r }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "list_published_pages");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn get_published_page(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> impl IntoResponse {
    let slug_l = slug.trim().to_lowercase();
    if slug_l.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid slug" })),
        )
            .into_response();
    }
    let row = match sqlx::query_as::<_, (String, String, Option<String>, String)>(
        r#"
        SELECT slug, title, seo_title, published_html
        FROM store_pages
        WHERE lower(slug) = $1 AND published = true
        "#,
    )
    .bind(&slug_l)
    .fetch_optional(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "get_published_page");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    match row {
        Some((s, title, seo, html)) => {
            let safe = sanitize_page_html(&html);
            (
                StatusCode::OK,
                Json(json!({
                    "slug": s,
                    "title": title,
                    "seo_title": seo,
                    "html": safe,
                })),
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "page not found" })),
        )
            .into_response(),
    }
}

// ── Cart coupon preview ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CartCouponBody {
    pub code: String,
    #[serde(default)]
    pub subtotal: Decimal,
    pub customer_email: Option<String>,
}

async fn apply_cart_coupon(
    State(state): State<AppState>,
    Json(body): Json<CartCouponBody>,
) -> impl IntoResponse {
    let _ = body.customer_email;
    match store_promotions::apply_coupon_code(&state.db, &body.code, body.subtotal).await {
        Ok(preview) => (
            StatusCode::OK,
            Json(json!({
                "coupon_id": preview.coupon_id,
                "code": preview.code,
                "kind": preview.kind,
                "discount_amount": preview.discount_amount.to_string(),
                "free_shipping": preview.free_shipping,
            })),
        )
            .into_response(),
        Err(e) => coupon_error_response(e),
    }
}

// ── Cart line resolution (priced lines for guest cart) ───────────────────────

#[derive(Debug, Deserialize)]
pub struct CartResolveLineIn {
    pub variant_id: Uuid,
    #[serde(default = "default_cart_line_qty")]
    pub qty: i32,
}

fn default_cart_line_qty() -> i32 {
    1
}

#[derive(Debug, Deserialize)]
pub struct CartResolveBody {
    pub lines: Vec<CartResolveLineIn>,
}

fn cart_lines_to_qty_inputs(lines: Vec<CartResolveLineIn>) -> Vec<store_cart_resolve::LineQty> {
    lines
        .into_iter()
        .map(|l| store_cart_resolve::LineQty {
            variant_id: l.variant_id,
            qty: l.qty,
        })
        .collect()
}

async fn post_cart_resolve_lines(
    State(state): State<AppState>,
    Json(body): Json<CartResolveBody>,
) -> impl IntoResponse {
    let pairs = match store_cart_resolve::merge_cart_input(cart_lines_to_qty_inputs(body.lines)) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
        }
    };

    match store_cart_resolve::priced_cart_value(&state.db, &pairs).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "priced_cart_value");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

// ── Guest cart session (server-backed) ──────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
pub struct CartSessionBody {
    #[serde(default)]
    pub lines: Vec<CartResolveLineIn>,
}

async fn post_cart_session(
    State(state): State<AppState>,
    Json(body): Json<CartSessionBody>,
) -> impl IntoResponse {
    let pairs = match store_cart_resolve::merge_cart_input(cart_lines_to_qty_inputs(body.lines)) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
        }
    };

    let cart_id = match store_guest_cart::create_cart_with_lines(&state.db, &pairs).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(error = %e, "create_cart_with_lines");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    match store_cart_resolve::priced_cart_value(&state.db, &pairs).await {
        Ok(Value::Object(mut m)) => {
            m.insert("cart_id".to_string(), json!(cart_id));
            (StatusCode::CREATED, Json(Value::Object(m))).into_response()
        }
        Ok(other) => (
            StatusCode::CREATED,
            Json(json!({ "cart_id": cart_id, "payload": other })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "priced_cart_value session create");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn get_cart_session(
    State(state): State<AppState>,
    Path(cart_id): Path<Uuid>,
) -> impl IntoResponse {
    let pairs = match store_guest_cart::load_cart_lines(&state.db, cart_id).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "cart not found" })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!(error = %e, "load_cart_lines");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    match store_cart_resolve::priced_cart_value(&state.db, &pairs).await {
        Ok(Value::Object(mut m)) => {
            m.insert("cart_id".to_string(), json!(cart_id));
            (StatusCode::OK, Json(Value::Object(m))).into_response()
        }
        Ok(other) => (
            StatusCode::OK,
            Json(json!({ "cart_id": cart_id, "payload": other })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "priced_cart_value session get");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn put_cart_session(
    State(state): State<AppState>,
    Path(cart_id): Path<Uuid>,
    Json(body): Json<CartResolveBody>,
) -> impl IntoResponse {
    let pairs = match store_cart_resolve::merge_cart_input(cart_lines_to_qty_inputs(body.lines)) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
        }
    };

    let ok = match store_guest_cart::replace_cart_lines(&state.db, cart_id, &pairs).await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(error = %e, "replace_cart_lines");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    if !ok {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "cart not found" })),
        )
            .into_response();
    }

    match store_cart_resolve::priced_cart_value(&state.db, &pairs).await {
        Ok(Value::Object(mut m)) => {
            m.insert("cart_id".to_string(), json!(cart_id));
            (StatusCode::OK, Json(Value::Object(m))).into_response()
        }
        Ok(other) => (
            StatusCode::OK,
            Json(json!({ "cart_id": cart_id, "payload": other })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "priced_cart_value session put");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn delete_cart_session(
    State(state): State<AppState>,
    Path(cart_id): Path<Uuid>,
) -> impl IntoResponse {
    match store_guest_cart::delete_cart(&state.db, cart_id).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "deleted" }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "delete_cart");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn get_store_media(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let Some(blob) = store_media_asset::fetch_image(&state.db, id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "fetch_image");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
        })?
    else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))));
    };

    let ct = HeaderValue::from_str(&blob.mime_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(blob.bytes))
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
        })
}

#[derive(Debug, Deserialize)]
pub struct UploadStoreMediaBody {
    pub file_base64: String,
    pub mime_type: String,
    #[serde(default)]
    pub filename: Option<String>,
}

async fn admin_upload_store_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UploadStoreMediaBody>,
) -> impl IntoResponse {
    let staff = match require_store_manage_staff(&state, &headers).await {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };

    let bytes = match BASE64_STANDARD.decode(body.file_base64.trim()) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid base64" })),
            )
                .into_response();
        }
    };

    let id = match store_media_asset::insert_image(
        &state.db,
        &body.mime_type,
        body.filename.as_deref(),
        &bytes,
        Some(staff.id),
    )
    .await
    {
        Ok(id) => id,
        Err(store_media_asset::MediaAssetError::TooLarge) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "file too large (max 3 MiB)" })),
            )
                .into_response();
        }
        Err(store_media_asset::MediaAssetError::BadMime) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "unsupported image type" })),
            )
                .into_response();
        }
        Err(store_media_asset::MediaAssetError::Database(e)) => {
            tracing::error!(error = %e, "insert_image");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    (
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "src": format!("/api/store/media/{id}"),
        })),
    )
        .into_response()
}

fn coupon_error_response(e: CouponError) -> axum::response::Response {
    let (status, msg) = match &e {
        CouponError::NotFound => (StatusCode::NOT_FOUND, "coupon not found"),
        CouponError::Inactive => (StatusCode::BAD_REQUEST, "coupon is inactive"),
        CouponError::NotStarted => (StatusCode::BAD_REQUEST, "coupon is not valid yet"),
        CouponError::Expired => (StatusCode::BAD_REQUEST, "coupon has expired"),
        CouponError::BelowMinSubtotal => (StatusCode::BAD_REQUEST, "subtotal below coupon minimum"),
        CouponError::MaxUsesReached => (StatusCode::BAD_REQUEST, "coupon has reached max uses"),
        CouponError::InvalidConfig => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "coupon configuration error",
        ),
        CouponError::Database(err) => {
            tracing::error!(error = %err, "coupon database error");
            (StatusCode::INTERNAL_SERVER_ERROR, "database error")
        }
    };
    (status, Json(json!({ "error": msg }))).into_response()
}

// ── Tax preview ─────────────────────────────────────────────────────────────

fn default_tax_fulfillment_ship() -> String {
    "ship".to_string()
}

#[derive(Debug, Deserialize)]
pub struct TaxPreviewQuery {
    /// For `fulfillment=ship`, two-letter ship-to state. Ignored for `store_pickup` (NY sourcing).
    pub state: String,
    pub subtotal: Decimal,
    /// `ship` (default) or `store_pickup` — see `store_tax::web_tax_preview`.
    #[serde(default = "default_tax_fulfillment_ship")]
    pub fulfillment: String,
}

async fn tax_preview_handler(
    State(state): State<AppState>,
    Query(q): Query<TaxPreviewQuery>,
) -> impl IntoResponse {
    let mode = match q.fulfillment.trim().to_lowercase().as_str() {
        "store_pickup" | "pickup" | "in_store_pickup" => store_tax::WebFulfillmentMode::StorePickup,
        _ => store_tax::WebFulfillmentMode::Ship,
    };

    match store_tax::web_tax_preview(&state.db, mode, &q.state, q.subtotal).await {
        Ok(r) => (
            StatusCode::OK,
            Json(json!({
                "state": r.effective_state,
                "fulfillment": r.fulfillment,
                "combined_rate": r.combined_rate.to_string(),
                "subtotal": q.subtotal.to_string(),
                "tax_estimated": r.tax_estimated.to_string(),
                "disclaimer": r.disclaimer,
            })),
        )
            .into_response(),
        Err(store_tax::StoreTaxError::UnknownState) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "unknown or unsupported ship-to state" })),
        )
            .into_response(),
        Err(store_tax::StoreTaxError::Database(e)) => {
            tracing::error!(error = %e, "tax_preview");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

// ── Admin: pages ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AdminPageRow {
    id: Uuid,
    slug: String,
    title: String,
    seo_title: Option<String>,
    published: bool,
    updated_at: chrono::DateTime<Utc>,
}

async fn admin_list_pages(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query_as::<_, AdminPageRow>(
        r#"
        SELECT id, slug, title, seo_title, published, updated_at
        FROM store_pages
        ORDER BY slug
        "#,
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => (StatusCode::OK, Json(json!({ "pages": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_list_pages");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateStorePageBody {
    pub slug: String,
    pub title: String,
    pub seo_title: Option<String>,
}

const RESERVED_PAGE_SLUGS: &[&str] = &[
    "account", "cart", "checkout", "products", "api", "shop", "admin", "store", "webhooks",
];

async fn admin_create_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateStorePageBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let slug = body.slug.trim().to_lowercase();
    if slug.is_empty() || RESERVED_PAGE_SLUGS.contains(&slug.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid or reserved slug" })),
        )
            .into_response();
    }
    let res = sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO store_pages (slug, title, seo_title, published, project_json, published_html)
        VALUES ($1, $2, $3, false, '{}'::jsonb, '')
        RETURNING id
        "#,
    )
    .bind(&slug)
    .bind(&body.title)
    .bind(&body.seo_title)
    .fetch_one(&state.db)
    .await;

    match res {
        Ok(id) => (StatusCode::CREATED, Json(json!({ "id": id, "slug": slug }))).into_response(),
        Err(e) => {
            if let sqlx::Error::Database(ref d) = e {
                if d.constraint() == Some("store_pages_slug_lower_uidx") {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({ "error": "slug already exists" })),
                    )
                        .into_response();
                }
            }
            tracing::error!(error = %e, "admin_create_page");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize)]
struct AdminPageDetail {
    id: Uuid,
    slug: String,
    title: String,
    seo_title: Option<String>,
    published: bool,
    project_json: Value,
    published_html: String,
    updated_at: chrono::DateTime<Utc>,
}

async fn admin_get_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let slug_l = slug.trim().to_lowercase();
    let row = match sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            String,
            Option<String>,
            bool,
            Value,
            String,
            chrono::DateTime<Utc>,
        ),
    >(
        r#"
            SELECT id, slug, title, seo_title, published, project_json, published_html, updated_at
            FROM store_pages
            WHERE lower(slug) = $1
            "#,
    )
    .bind(&slug_l)
    .fetch_optional(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "admin_get_page");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    match row {
        Some((id, s, title, seo, published, pj, html, updated_at)) => (
            StatusCode::OK,
            Json(json!(AdminPageDetail {
                id,
                slug: s,
                title,
                seo_title: seo,
                published,
                project_json: pj,
                published_html: html,
                updated_at,
            })),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "page not found" })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct PatchStorePageBody {
    pub title: Option<String>,
    pub seo_title: Option<String>,
    pub project_json: Option<Value>,
    pub published_html: Option<String>,
    pub published: Option<bool>,
}

async fn admin_patch_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<PatchStorePageBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let slug_l = slug.trim().to_lowercase();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM store_pages WHERE lower(slug) = $1)")
            .bind(&slug_l)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);

    if !exists {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "page not found" })),
        )
            .into_response();
    }

    if body.title.is_none()
        && body.seo_title.is_none()
        && body.project_json.is_none()
        && body.published_html.is_none()
        && body.published.is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "no fields to update" })),
        )
            .into_response();
    }

    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "admin_patch_page begin");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    if let Some(t) = &body.title {
        if sqlx::query(
            "UPDATE store_pages SET title = $2, updated_at = NOW() WHERE lower(slug) = $1",
        )
        .bind(&slug_l)
        .bind(t)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }
    if let Some(s) = &body.seo_title {
        if sqlx::query(
            "UPDATE store_pages SET seo_title = $2, updated_at = NOW() WHERE lower(slug) = $1",
        )
        .bind(&slug_l)
        .bind(s)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }
    if let Some(pj) = &body.project_json {
        if sqlx::query(
            "UPDATE store_pages SET project_json = $2, updated_at = NOW() WHERE lower(slug) = $1",
        )
        .bind(&slug_l)
        .bind(pj)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }
    if let Some(html) = &body.published_html {
        if sqlx::query(
            "UPDATE store_pages SET published_html = $2, updated_at = NOW() WHERE lower(slug) = $1",
        )
        .bind(&slug_l)
        .bind(html)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }
    if let Some(p) = body.published {
        if sqlx::query(
            "UPDATE store_pages SET published = $2, updated_at = NOW() WHERE lower(slug) = $1",
        )
        .bind(&slug_l)
        .bind(p)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }

    if let Err(e) = tx.commit().await {
        tracing::error!(error = %e, "admin_patch_page commit");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "database error" })),
        )
            .into_response();
    }

    (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response()
}

async fn admin_publish_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> impl IntoResponse {
    let staff = match require_store_manage_staff(&state, &headers).await {
        Ok(staff) => staff,
        Err(e) => return e.into_response(),
    };
    let slug_l = slug.trim().to_lowercase();
    let res = sqlx::query_as::<_, (Uuid, String, String, Value, String)>(
        r#"
        UPDATE store_pages
        SET published = true, updated_at = NOW()
        WHERE lower(slug) = $1
        RETURNING id, slug, title, project_json, published_html
        "#,
    )
    .bind(&slug_l)
    .fetch_optional(&state.db)
    .await;

    match res {
        Ok(Some((page_id, page_slug, title, project_json, published_html))) => {
            if let Err(e) = sqlx::query(
                r#"
                INSERT INTO storefront_publish_revision (
                    page_id, slug, title, project_json, published_html, published_by_staff_id
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                "#,
            )
            .bind(page_id)
            .bind(&page_slug)
            .bind(&title)
            .bind(project_json)
            .bind(&published_html)
            .bind(staff.id)
            .execute(&state.db)
            .await
            {
                tracing::error!(error = %e, "admin_publish_page revision insert");
            }
            (StatusCode::OK, Json(json!({ "status": "published" }))).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "page not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_publish_page");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

// ── Storefront control, growth, and operations ─────────────────────────────

async fn get_public_navigation(State(state): State<AppState>) -> impl IntoResponse {
    match load_navigation(&state.db, false).await {
        Ok(menus) => (StatusCode::OK, Json(json!({ "menus": menus }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "get_public_navigation");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn get_public_home_layout(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, Value>(
        "SELECT storefront_home_layout FROM store_settings WHERE id = 1",
    )
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(layout)) => (StatusCode::OK, Json(json!({ "blocks": layout }))).into_response(),
        Ok(None) => (StatusCode::OK, Json(json!({ "blocks": [] }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "get_public_home_layout");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AdminStoreDashboardRow {
    web_transactions: i64,
    web_sales_usd: Decimal,
    pending_checkouts: i64,
    abandoned_checkouts: i64,
    active_campaigns: i64,
    media_assets: i64,
}

async fn admin_store_dashboard(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query_as::<_, AdminStoreDashboardRow>(
        r#"
        SELECT
            COALESCE((SELECT COUNT(*)::bigint FROM transactions WHERE sale_channel = 'web'), 0) AS web_transactions,
            COALESCE((SELECT ROUND(SUM(total_price), 2) FROM transactions WHERE sale_channel = 'web'), 0)::numeric AS web_sales_usd,
            COALESCE((SELECT COUNT(*)::bigint FROM store_checkout_session WHERE status IN ('draft', 'payment_pending')), 0) AS pending_checkouts,
            COALESCE((SELECT COUNT(*)::bigint FROM store_checkout_session WHERE status IN ('failed', 'expired', 'cancelled')), 0) AS abandoned_checkouts,
            COALESCE((SELECT COUNT(*)::bigint FROM storefront_campaign WHERE is_active = true), 0) AS active_campaigns,
            COALESCE((SELECT COUNT(*)::bigint FROM store_media_asset WHERE deleted_at IS NULL), 0) AS media_assets
        "#,
    )
    .fetch_one(&state.db)
    .await
    {
        Ok(row) => (StatusCode::OK, Json(json!(row))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_store_dashboard");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AdminWebOrderRow {
    transaction_id: Uuid,
    display_id: String,
    booked_at: chrono::DateTime<Utc>,
    status: String,
    web_order_status: Option<String>,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    fulfillment_method: String,
    shipping_amount_usd: Option<Decimal>,
    tracking_number: Option<String>,
    tracking_url_provider: Option<String>,
    payment_provider: Option<String>,
    customer_display_name: Option<String>,
    customer_email: Option<String>,
}

async fn admin_list_web_orders(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query_as::<_, AdminWebOrderRow>(
        r#"
        SELECT
            t.id AS transaction_id,
            t.display_id,
            t.booked_at,
            t.status::text AS status,
            t.metadata->>'web_order_status' AS web_order_status,
            t.total_price,
            t.amount_paid,
            t.balance_due,
            t.fulfillment_method::text AS fulfillment_method,
            t.shipping_amount_usd,
            t.tracking_number,
            t.tracking_url_provider,
            (
                SELECT string_agg(DISTINCT COALESCE(pt.payment_provider, pt.payment_method), ', ' ORDER BY COALESCE(pt.payment_provider, pt.payment_method))
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = t.id
            ) AS payment_provider,
            NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), '') AS customer_display_name,
            c.email AS customer_email
        FROM transactions t
        LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.sale_channel = 'web'
        ORDER BY t.booked_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => (StatusCode::OK, Json(json!({ "orders": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_list_web_orders");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct AdminWebOrderActionBody {
    action: String,
    tracking_number: Option<String>,
    tracking_url_provider: Option<String>,
    note: Option<String>,
}

async fn admin_update_web_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<AdminWebOrderActionBody>,
) -> impl IntoResponse {
    let staff = match require_store_manage_staff(&state, &headers).await {
        Ok(staff) => staff,
        Err(e) => return e.into_response(),
    };
    let action = body.action.trim().to_lowercase();
    let status = match action.as_str() {
        "ready_for_pickup" => "ready_for_pickup",
        "mark_shipped" => "shipped",
        "cancel_requested" => "cancel_requested",
        "refund_needed" => "refund_needed",
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "unsupported web transaction action" })),
            )
                .into_response();
        }
    };
    let tracking_number = body
        .tracking_number
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let tracking_url_provider = body
        .tracking_url_provider
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let note = body
        .note
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let event = json!({
        "web_order_status": status,
        "web_order_action": action,
        "web_order_action_at": Utc::now(),
        "web_order_action_staff_id": staff.id,
        "web_order_note": note,
    });
    let result = sqlx::query(
        r#"
        UPDATE transactions
        SET
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            tracking_number = COALESCE($3, tracking_number),
            tracking_url_provider = COALESCE($4, tracking_url_provider)
        WHERE id = $1 AND sale_channel = 'web'
        "#,
    )
    .bind(id)
    .bind(event)
    .bind(tracking_number)
    .bind(tracking_url_provider)
    .execute(&state.db)
    .await;
    match result {
        Ok(r) if r.rows_affected() > 0 => (
            StatusCode::OK,
            Json(json!({ "status": "updated", "web_order_status": status })),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "web transaction not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_update_web_order");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AdminCheckoutSessionRow {
    id: Uuid,
    status: String,
    selected_provider: Option<String>,
    total_usd: Decimal,
    coupon_code: Option<String>,
    campaign_slug: Option<String>,
    finalized_transaction_id: Option<Uuid>,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
    expires_at: chrono::DateTime<Utc>,
    contact: Value,
}

async fn admin_list_checkout_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query_as::<_, AdminCheckoutSessionRow>(
        r#"
        SELECT id, status, selected_provider, total_usd, coupon_code, campaign_slug,
               finalized_transaction_id, created_at, updated_at, expires_at, contact
        FROM store_checkout_session
        ORDER BY created_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => (StatusCode::OK, Json(json!({ "sessions": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_list_checkout_sessions");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct StoreAnalyticsSummaryRow {
    checkout_sessions: i64,
    checkout_started: i64,
    payment_started: i64,
    paid_sessions: i64,
    failed_sessions: i64,
    expired_sessions: i64,
    cancelled_sessions: i64,
    paid_revenue_usd: Decimal,
    web_transactions: i64,
    web_transaction_revenue_usd: Decimal,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct StoreAnalyticsCampaignRow {
    campaign_slug: Option<String>,
    sessions: i64,
    paid_sessions: i64,
    revenue_usd: Decimal,
}

async fn admin_store_analytics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let summary = sqlx::query_as::<_, StoreAnalyticsSummaryRow>(
        r#"
        SELECT
            COUNT(*)::bigint AS checkout_sessions,
            COUNT(*) FILTER (WHERE checkout_started_at IS NOT NULL)::bigint AS checkout_started,
            COUNT(*) FILTER (WHERE payment_started_at IS NOT NULL)::bigint AS payment_started,
            COUNT(*) FILTER (WHERE status = 'paid')::bigint AS paid_sessions,
            COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed_sessions,
            COUNT(*) FILTER (WHERE status = 'expired')::bigint AS expired_sessions,
            COUNT(*) FILTER (WHERE status = 'cancelled')::bigint AS cancelled_sessions,
            COALESCE(ROUND(SUM(total_usd) FILTER (WHERE status = 'paid'), 2), 0)::numeric AS paid_revenue_usd,
            COALESCE((SELECT COUNT(*)::bigint FROM transactions WHERE sale_channel = 'web'), 0) AS web_transactions,
            COALESCE((SELECT ROUND(SUM(total_price), 2)::numeric FROM transactions WHERE sale_channel = 'web'), 0)::numeric AS web_transaction_revenue_usd
        FROM store_checkout_session
        "#,
    )
    .fetch_one(&state.db)
    .await;
    let campaigns = sqlx::query_as::<_, StoreAnalyticsCampaignRow>(
        r#"
        SELECT
            NULLIF(btrim(campaign_slug), '') AS campaign_slug,
            COUNT(*)::bigint AS sessions,
            COUNT(*) FILTER (WHERE status = 'paid')::bigint AS paid_sessions,
            COALESCE(ROUND(SUM(total_usd) FILTER (WHERE status = 'paid'), 2), 0)::numeric AS revenue_usd
        FROM store_checkout_session
        GROUP BY NULLIF(btrim(campaign_slug), '')
        ORDER BY revenue_usd DESC, sessions DESC
        LIMIT 25
        "#,
    )
    .fetch_all(&state.db)
    .await;
    match (summary, campaigns) {
        (Ok(summary), Ok(campaigns)) => (
            StatusCode::OK,
            Json(json!({ "summary": summary, "campaigns": campaigns })),
        )
            .into_response(),
        (Err(e), _) | (_, Err(e)) => {
            tracing::error!(error = %e, "admin_store_analytics");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AdminCampaignRow {
    id: Uuid,
    slug: String,
    name: String,
    coupon_id: Option<Uuid>,
    coupon_code: Option<String>,
    landing_page_slug: Option<String>,
    source: Option<String>,
    medium: Option<String>,
    starts_at: Option<chrono::DateTime<Utc>>,
    ends_at: Option<chrono::DateTime<Utc>>,
    is_active: bool,
    notes: Option<String>,
    paid_checkouts: i64,
    revenue_usd: Decimal,
    created_at: chrono::DateTime<Utc>,
}

async fn admin_list_campaigns(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query_as::<_, AdminCampaignRow>(
        r#"
        SELECT
            c.id, c.slug, c.name, c.coupon_id, sc.code AS coupon_code,
            c.landing_page_slug, c.source, c.medium, c.starts_at, c.ends_at,
            c.is_active, c.notes,
            COALESCE(COUNT(s.id) FILTER (WHERE s.status = 'paid'), 0)::bigint AS paid_checkouts,
            COALESCE(ROUND(SUM(s.total_usd) FILTER (WHERE s.status = 'paid'), 2), 0)::numeric AS revenue_usd,
            c.created_at
        FROM storefront_campaign c
        LEFT JOIN store_coupons sc ON sc.id = c.coupon_id
        LEFT JOIN store_checkout_session s ON lower(s.campaign_slug) = lower(c.slug)
        GROUP BY c.id, sc.code
        ORDER BY c.created_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => (StatusCode::OK, Json(json!({ "campaigns": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_list_campaigns");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct CampaignBody {
    slug: String,
    name: String,
    coupon_id: Option<Uuid>,
    landing_page_slug: Option<String>,
    source: Option<String>,
    medium: Option<String>,
    starts_at: Option<chrono::DateTime<Utc>>,
    ends_at: Option<chrono::DateTime<Utc>>,
    is_active: Option<bool>,
    notes: Option<String>,
}

async fn admin_create_campaign(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CampaignBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let slug = body.slug.trim().to_lowercase();
    let name = body.name.trim();
    if slug.is_empty() || name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "slug and name are required" })),
        )
            .into_response();
    }
    match sqlx::query(
        r#"
        INSERT INTO storefront_campaign (
            slug, name, coupon_id, landing_page_slug, source, medium,
            starts_at, ends_at, is_active, notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, true), $10)
        "#,
    )
    .bind(slug)
    .bind(name)
    .bind(body.coupon_id)
    .bind(body.landing_page_slug)
    .bind(body.source)
    .bind(body.medium)
    .bind(body.starts_at)
    .bind(body.ends_at)
    .bind(body.is_active)
    .bind(body.notes)
    .execute(&state.db)
    .await
    {
        Ok(_) => (StatusCode::CREATED, Json(json!({ "status": "created" }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_create_campaign");
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "could not create campaign" })),
            )
                .into_response()
        }
    }
}

async fn admin_patch_campaign(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<CampaignBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let slug = body.slug.trim().to_lowercase();
    let name = body.name.trim();
    if slug.is_empty() || name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "slug and name are required" })),
        )
            .into_response();
    }
    match sqlx::query(
        r#"
        UPDATE storefront_campaign
        SET slug = $2, name = $3, coupon_id = $4, landing_page_slug = $5,
            source = $6, medium = $7, starts_at = $8, ends_at = $9,
            is_active = COALESCE($10, is_active), notes = $11
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(slug)
    .bind(name)
    .bind(body.coupon_id)
    .bind(body.landing_page_slug)
    .bind(body.source)
    .bind(body.medium)
    .bind(body.starts_at)
    .bind(body.ends_at)
    .bind(body.is_active)
    .bind(body.notes)
    .execute(&state.db)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => {
            (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response()
        }
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "campaign not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_patch_campaign");
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "could not update campaign" })),
            )
                .into_response()
        }
    }
}

async fn admin_seo_health(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let product_issues = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT issue_kind, product_id::text AS entity_id, label
        FROM (
            SELECT 'missing_slug' AS issue_kind, p.id AS product_id, p.name AS label
            FROM products p
            WHERE EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.web_published = true)
              AND (p.catalog_handle IS NULL OR btrim(p.catalog_handle) = '')
            UNION ALL
            SELECT 'missing_image', p.id, p.name
            FROM products p
            WHERE EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.web_published = true)
              AND (p.images IS NULL OR cardinality(p.images) = 0)
            UNION ALL
            SELECT 'zero_stock', p.id, p.name
            FROM products p
            WHERE EXISTS (
                SELECT 1 FROM product_variants pv
                WHERE pv.product_id = p.id
                  AND pv.web_published = true
                GROUP BY pv.product_id
                HAVING SUM(GREATEST(0, pv.stock_on_hand - pv.reserved_stock)) <= 0
            )
        ) issues
        ORDER BY issue_kind, label
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await;
    let page_issues = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT 'page_unpublished' AS issue_kind, slug AS entity_id, title AS label
        FROM store_pages
        WHERE published = false
        UNION ALL
        SELECT 'page_empty_html', slug, title
        FROM store_pages
        WHERE published = true AND btrim(published_html) = ''
        ORDER BY issue_kind, label
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await;

    match (product_issues, page_issues) {
        (Ok(products), Ok(pages)) => {
            let issues: Vec<Value> = products
                .into_iter()
                .chain(pages.into_iter())
                .map(|(kind, entity_id, label)| {
                    json!({ "kind": kind, "entity_id": entity_id, "label": label })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "issues": issues }))).into_response()
        }
        (Err(e), _) | (_, Err(e)) => {
            tracing::error!(error = %e, "admin_seo_health");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct NavigationMenuRow {
    id: Uuid,
    handle: String,
    title: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct NavigationItemRow {
    id: Uuid,
    menu_id: Uuid,
    label: String,
    url: String,
    item_kind: String,
    sort_order: i32,
    is_active: bool,
}

async fn load_navigation(
    pool: &sqlx::PgPool,
    include_inactive: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let menus = sqlx::query_as::<_, NavigationMenuRow>(
        "SELECT id, handle, title FROM storefront_navigation_menu ORDER BY handle",
    )
    .fetch_all(pool)
    .await?;
    let item_sql = if include_inactive {
        r#"
        SELECT id, menu_id, label, url, item_kind, sort_order, is_active
        FROM storefront_navigation_item
        ORDER BY menu_id, sort_order, created_at
        "#
    } else {
        r#"
        SELECT id, menu_id, label, url, item_kind, sort_order, is_active
        FROM storefront_navigation_item
        WHERE is_active = true
        ORDER BY menu_id, sort_order, created_at
        "#
    };
    let items = sqlx::query_as::<_, NavigationItemRow>(item_sql)
        .fetch_all(pool)
        .await?;
    Ok(menus
        .into_iter()
        .map(|menu| {
            let menu_items: Vec<&NavigationItemRow> = items
                .iter()
                .filter(|item| item.menu_id == menu.id)
                .collect();
            json!({
                "id": menu.id,
                "handle": menu.handle,
                "title": menu.title,
                "items": menu_items,
            })
        })
        .collect())
}

async fn admin_get_navigation(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match load_navigation(&state.db, true).await {
        Ok(menus) => (StatusCode::OK, Json(json!({ "menus": menus }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_get_navigation");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct NavigationUpsertBody {
    handle: String,
    title: String,
    items: Vec<NavigationItemBody>,
}

#[derive(Debug, Deserialize)]
struct NavigationItemBody {
    label: String,
    url: String,
    #[serde(default = "default_nav_kind")]
    item_kind: String,
    #[serde(default)]
    sort_order: i32,
    #[serde(default = "default_true")]
    is_active: bool,
}

fn default_nav_kind() -> String {
    "custom".to_string()
}

fn default_true() -> bool {
    true
}

async fn admin_put_navigation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NavigationUpsertBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let handle = body.handle.trim().to_lowercase();
    let title = body.title.trim();
    if handle.is_empty() || title.is_empty() || body.items.len() > 50 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "valid handle, title, and up to 50 items are required" })),
        )
            .into_response();
    }
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!(error = %e, "admin_put_navigation begin");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };
    let existing_menu_id: Result<Option<Uuid>, sqlx::Error> = sqlx::query_scalar(
        "SELECT id FROM storefront_navigation_menu WHERE lower(btrim(handle)) = $1",
    )
    .bind(&handle)
    .fetch_optional(&mut *tx)
    .await;
    let menu_id: Uuid = match existing_menu_id {
        Ok(Some(id)) => {
            if let Err(e) =
                sqlx::query("UPDATE storefront_navigation_menu SET title = $2 WHERE id = $1")
                    .bind(id)
                    .bind(title)
                    .execute(&mut *tx)
                    .await
            {
                let _ = tx.rollback().await;
                tracing::error!(error = %e, "admin_put_navigation update");
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "could not save menu" })),
                )
                    .into_response();
            }
            id
        }
        Ok(None) => match sqlx::query_scalar(
            "INSERT INTO storefront_navigation_menu (handle, title) VALUES ($1, $2) RETURNING id",
        )
        .bind(&handle)
        .bind(title)
        .fetch_one(&mut *tx)
        .await
        {
            Ok(id) => id,
            Err(e) => {
                let _ = tx.rollback().await;
                tracing::error!(error = %e, "admin_put_navigation insert");
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "could not save menu" })),
                )
                    .into_response();
            }
        },
        Err(e) => {
            let _ = tx.rollback().await;
            tracing::error!(error = %e, "admin_put_navigation lookup");
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "could not save menu" })),
            )
                .into_response();
        }
    };
    if sqlx::query("DELETE FROM storefront_navigation_item WHERE menu_id = $1")
        .bind(menu_id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        let _ = tx.rollback().await;
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "database error" })),
        )
            .into_response();
    }
    for (idx, item) in body.items.iter().enumerate() {
        let label = item.label.trim();
        let url = item.url.trim();
        let kind = item.item_kind.trim().to_lowercase();
        if label.is_empty() || url.is_empty() {
            let _ = tx.rollback().await;
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "navigation items require label and URL" })),
            )
                .into_response();
        }
        if sqlx::query(
            r#"
            INSERT INTO storefront_navigation_item (
                menu_id, label, url, item_kind, sort_order, is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(menu_id)
        .bind(label)
        .bind(url)
        .bind(kind)
        .bind(if item.sort_order == 0 {
            idx as i32 * 10
        } else {
            item.sort_order
        })
        .bind(item.is_active)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "could not save navigation item" })),
            )
                .into_response();
        }
    }
    if tx.commit().await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "database error" })),
        )
            .into_response();
    }
    (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response()
}

async fn admin_list_media(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match store_media_asset::list_images(&state.db, 200).await {
        Ok(assets) => (StatusCode::OK, Json(json!({ "assets": assets }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_list_media");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct PatchMediaBody {
    alt_text: Option<String>,
    usage_note: Option<String>,
}

async fn admin_patch_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchMediaBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query(
        r#"
        UPDATE store_media_asset
        SET alt_text = $2, usage_note = $3
        WHERE id = $1 AND deleted_at IS NULL
        "#,
    )
    .bind(id)
    .bind(body.alt_text)
    .bind(body.usage_note)
    .execute(&state.db)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => {
            (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response()
        }
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "asset not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_patch_media");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn admin_archive_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let asset_ref = format!("/api/store/media/{id}");
    let used = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM store_pages
            WHERE COALESCE(published_html, '') LIKE '%' || $1 || '%'
               OR COALESCE(project_json::text, '') LIKE '%' || $1 || '%'
        )
        "#,
    )
    .bind(&asset_ref)
    .fetch_one(&state.db)
    .await;
    let is_used = match used {
        Ok(value) => value,
        Err(e) => {
            tracing::error!(error = %e, "admin_archive_media usage check");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };
    if is_used {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "asset is used by a store page" })),
        )
            .into_response();
    }
    match sqlx::query(
        "UPDATE store_media_asset SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .execute(&state.db)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => {
            (StatusCode::OK, Json(json!({ "status": "archived" }))).into_response()
        }
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "asset not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_archive_media");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct PublishRevisionRow {
    id: Uuid,
    slug: String,
    title: String,
    published_at: chrono::DateTime<Utc>,
    published_by_staff_id: Option<Uuid>,
}

async fn admin_list_publish_history(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query_as::<_, PublishRevisionRow>(
        r#"
        SELECT id, slug, title, published_at, published_by_staff_id
        FROM storefront_publish_revision
        ORDER BY published_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(revisions) => (StatusCode::OK, Json(json!({ "revisions": revisions }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_list_publish_history");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

async fn admin_restore_publish_revision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let staff = match require_store_manage_staff(&state, &headers).await {
        Ok(staff) => staff,
        Err(e) => return e.into_response(),
    };
    let result = sqlx::query(
        r#"
        UPDATE store_pages p
        SET
            project_json = r.project_json,
            published_html = r.published_html,
            published = true,
            updated_at = now()
        FROM storefront_publish_revision r
        WHERE r.id = $1 AND p.id = r.page_id
        "#,
    )
    .bind(id)
    .execute(&state.db)
    .await;
    match result {
        Ok(r) if r.rows_affected() > 0 => (
            StatusCode::OK,
            Json(json!({
                "status": "restored",
                "restored_by_staff_id": staff.id,
            })),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "publish revision not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_restore_publish_revision");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct HomeLayoutBody {
    blocks: Value,
}

async fn admin_get_home_layout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    get_public_home_layout(State(state)).await.into_response()
}

async fn admin_patch_home_layout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<HomeLayoutBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    if !body.blocks.is_array() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "home layout blocks must be an array" })),
        )
            .into_response();
    }
    match sqlx::query("UPDATE store_settings SET storefront_home_layout = $1 WHERE id = 1")
        .bind(body.blocks)
        .execute(&state.db)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_patch_home_layout");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

// ── Admin: coupons ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AdminCouponRow {
    id: Uuid,
    code: String,
    kind: String,
    value: Decimal,
    max_discount_usd: Option<Decimal>,
    starts_at: Option<chrono::DateTime<Utc>>,
    ends_at: Option<chrono::DateTime<Utc>>,
    min_subtotal_usd: Option<Decimal>,
    max_uses: Option<i32>,
    uses_count: i32,
    is_active: bool,
    allow_stack: bool,
}

async fn admin_list_coupons(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    match sqlx::query_as::<_, AdminCouponRow>(
        r#"
        SELECT
            id, code, kind::text AS kind, value, max_discount_usd,
            starts_at, ends_at, min_subtotal_usd, max_uses, uses_count,
            is_active, allow_stack
        FROM store_coupons
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => (StatusCode::OK, Json(json!({ "coupons": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "admin_list_coupons");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateCouponBody {
    pub code: String,
    pub kind: String,
    pub value: Decimal,
    pub max_discount_usd: Option<Decimal>,
    pub starts_at: Option<chrono::DateTime<Utc>>,
    pub ends_at: Option<chrono::DateTime<Utc>>,
    pub min_subtotal_usd: Option<Decimal>,
    pub max_uses: Option<i32>,
    #[serde(default = "default_coupon_active")]
    pub is_active: bool,
    #[serde(default)]
    pub allow_stack: bool,
}

fn default_coupon_active() -> bool {
    true
}

async fn admin_create_coupon(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateCouponBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let code = body.code.trim().to_string();
    if code.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "code required" })),
        )
            .into_response();
    }
    let kind = body.kind.trim().to_lowercase();
    if !matches!(kind.as_str(), "percent" | "fixed_amount" | "free_shipping") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid kind" })),
        )
            .into_response();
    }

    let id = sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO store_coupons (
            code, kind, value, max_discount_usd, starts_at, ends_at,
            min_subtotal_usd, max_uses, is_active, allow_stack
        )
        VALUES (
            $1, $2::store_coupon_kind, $3, $4, $5, $6, $7, $8, $9, $10
        )
        RETURNING id
        "#,
    )
    .bind(&code)
    .bind(&kind)
    .bind(body.value)
    .bind(body.max_discount_usd)
    .bind(body.starts_at)
    .bind(body.ends_at)
    .bind(body.min_subtotal_usd)
    .bind(body.max_uses)
    .bind(body.is_active)
    .bind(body.allow_stack)
    .fetch_one(&state.db)
    .await;

    match id {
        Ok(uid) => (StatusCode::CREATED, Json(json!({ "id": uid }))).into_response(),
        Err(e) => {
            if let sqlx::Error::Database(ref d) = e {
                if d.constraint() == Some("store_coupons_code_lower_uidx") {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({ "error": "code already exists" })),
                    )
                        .into_response();
                }
            }
            tracing::error!(error = %e, "admin_create_coupon");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PatchCouponBody {
    pub is_active: Option<bool>,
    pub max_uses: Option<i32>,
    pub ends_at: Option<chrono::DateTime<Utc>>,
}

async fn admin_patch_coupon(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchCouponBody>,
) -> impl IntoResponse {
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    if body.is_active.is_none() && body.max_uses.is_none() && body.ends_at.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "no fields to update" })),
        )
            .into_response();
    }

    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "admin_patch_coupon begin");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    };

    if let Some(a) = body.is_active {
        if sqlx::query("UPDATE store_coupons SET is_active = $2 WHERE id = $1")
            .bind(id)
            .bind(a)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }
    if let Some(m) = body.max_uses {
        if sqlx::query("UPDATE store_coupons SET max_uses = $2 WHERE id = $1")
            .bind(id)
            .bind(m)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }
    if let Some(end) = body.ends_at {
        if sqlx::query("UPDATE store_coupons SET ends_at = $2 WHERE id = $1")
            .bind(id)
            .bind(end)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
                .into_response();
        }
    }

    if tx.commit().await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "database error" })),
        )
            .into_response();
    }

    (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response()
}

pub fn public_router() -> Router<AppState> {
    Router::new()
        .nest("/account", crate::api::store_account::router())
        .route("/shipping/rates", post(post_store_shipping_rates))
        .route("/products", get(list_products))
        .route("/products/{slug}", get(get_product))
        .route("/pages", get(list_published_pages))
        .route("/pages/{slug}", get(get_published_page))
        .route("/cart/coupon", post(apply_cart_coupon))
        .route("/cart/lines", post(post_cart_resolve_lines))
        .route("/cart/session", post(post_cart_session))
        .route(
            "/cart/session/{id}",
            get(get_cart_session)
                .put(put_cart_session)
                .delete(delete_cart_session),
        )
        .route("/checkout/config", get(get_checkout_config))
        .route("/checkout/session", post(post_checkout_session))
        .route("/checkout/session/{id}", get(get_checkout_session))
        .route(
            "/checkout/session/{id}/payment",
            post(post_checkout_payment),
        )
        .route(
            "/checkout/session/{id}/confirm",
            post(post_checkout_confirm),
        )
        .route("/navigation", get(get_public_navigation))
        .route("/home-layout", get(get_public_home_layout))
        .route("/media/{id}", get(get_store_media))
        .route("/tax/preview", get(tax_preview_handler))
}

pub fn admin_router() -> Router<AppState> {
    Router::new()
        .route("/dashboard", get(admin_store_dashboard))
        .route("/orders", get(admin_list_web_orders))
        .route("/orders/{id}", patch(admin_update_web_order))
        .route("/carts", get(admin_list_checkout_sessions))
        .route("/analytics", get(admin_store_analytics))
        .route(
            "/campaigns",
            get(admin_list_campaigns).post(admin_create_campaign),
        )
        .route("/campaigns/{id}", patch(admin_patch_campaign))
        .route("/seo", get(admin_seo_health))
        .route(
            "/navigation",
            get(admin_get_navigation).put(admin_put_navigation),
        )
        .route("/media", get(admin_list_media))
        .route("/media/{id}", patch(admin_patch_media))
        .route("/media/{id}/archive", post(admin_archive_media))
        .route("/publish-history", get(admin_list_publish_history))
        .route(
            "/publish-history/{id}/restore",
            post(admin_restore_publish_revision),
        )
        .route(
            "/home-layout",
            get(admin_get_home_layout).patch(admin_patch_home_layout),
        )
        .route("/pages", get(admin_list_pages).post(admin_create_page))
        .route("/pages/{slug}", get(admin_get_page).patch(admin_patch_page))
        .route("/pages/{slug}/publish", post(admin_publish_page))
        .route(
            "/coupons",
            get(admin_list_coupons).post(admin_create_coupon),
        )
        .route("/coupons/{id}", patch(admin_patch_coupon))
        .route("/assets", post(admin_upload_store_media))
}
