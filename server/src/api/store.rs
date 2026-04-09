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
    if let Err(e) = require_store_manage(&state, &headers).await {
        return e.into_response();
    }
    let slug_l = slug.trim().to_lowercase();
    let res = sqlx::query(
        r#"
        UPDATE store_pages
        SET published = true, updated_at = NOW()
        WHERE lower(slug) = $1
        "#,
    )
    .bind(&slug_l)
    .execute(&state.db)
    .await;

    match res {
        Ok(r) if r.rows_affected() > 0 => {
            (StatusCode::OK, Json(json!({ "status": "published" }))).into_response()
        }
        Ok(_) => (
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
        .route("/media/{id}", get(get_store_media))
        .route("/tax/preview", get(tax_preview_handler))
}

pub fn admin_router() -> Router<AppState> {
    Router::new()
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
