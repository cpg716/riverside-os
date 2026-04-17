//! Public storefront customer accounts (JWT): login, register, link password, profile, order history.
//! Rate limits + ConnectInfo client keys reduce credential-stuffing and scraping.

use std::net::SocketAddr;
use std::time::Instant;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::api::store_account_rate::store_account_client_key;
use crate::api::transactions::{
    load_transaction_detail, TransactionDetailResponse, TransactionError,
    TransactionFinancialSummary,
};
use crate::api::AppState;
use crate::auth::store_customer_jwt::{
    sign_store_customer_token, verify_store_customer_token, StoreCustomerJwtError,
};
use crate::auth::store_customer_password::{
    hash_customer_password, verify_customer_password, StoreCustomerPasswordError,
};
use crate::logic::customer_transaction_history::{
    query_customer_transaction_history, CustomerTransactionHistoryQuery,
};
use crate::logic::customers::{insert_customer_in_tx, CustomerCreatedSource, InsertCustomerParams};
use crate::logic::store_customer_account::{
    fetch_online_password_hash, find_customer_id_by_normalized_email,
    insert_online_credential_in_tx, normalize_store_email, online_credential_exists,
};
use crate::models::{DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus, DbSaleChannel};

fn rate_limit_response() -> axum::response::Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": "Too many requests. Please wait a minute and try again."
        })),
    )
        .into_response()
}

fn auth_failure_response(needs_activate: bool) -> axum::response::Response {
    if needs_activate {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "Invalid email or password.",
                "code": "needs_activate"
            })),
        )
            .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid email or password." })),
        )
            .into_response()
    }
}

fn bearer_customer_id(headers: &HeaderMap, secret: &[u8]) -> Result<Uuid, StoreCustomerJwtError> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(StoreCustomerJwtError::Invalid)?;
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .ok_or(StoreCustomerJwtError::Invalid)?;
    verify_store_customer_token(token, secret)
}

async fn check_unauth_rate(
    state: &AppState,
    headers: &HeaderMap,
    peer: SocketAddr,
    route: &'static str,
) -> Result<(), axum::response::Response> {
    let key = store_account_client_key(headers, peer);
    let now = Instant::now();
    let mut g = state.store_account_rate.lock().await;
    if !g.try_consume_unauth_post(&key, state.store_account_unauth_post_per_minute_ip, now) {
        tracing::warn!(%key, route, "store account unauth rate limit");
        return Err(rate_limit_response());
    }
    Ok(())
}

async fn check_authed_rate(
    state: &AppState,
    cid: Uuid,
    route: &'static str,
) -> Result<(), axum::response::Response> {
    let key = format!("cid:{cid}");
    let now = Instant::now();
    let mut g = state.store_account_rate.lock().await;
    if !g.try_consume_authed(&key, state.store_account_authed_per_minute, now) {
        tracing::warn!(%key, route, "store account authed rate limit");
        return Err(rate_limit_response());
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct StoreAccountEmailPasswordBody {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct StoreAccountRegisterBody {
    pub email: String,
    pub password: String,
    pub first_name: String,
    pub last_name: String,
    #[serde(default)]
    pub phone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StoreAccountProfilePatch {
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub address_line1: Option<String>,
    #[serde(default)]
    pub address_line2: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub postal_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StoreAccountChangePasswordBody {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Serialize)]
struct TokenResponse {
    token: String,
    customer_id: Uuid,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct StoreAccountMeRow {
    id: Uuid,
    customer_code: String,
    first_name: String,
    last_name: String,
    company_name: Option<String>,
    email: Option<String>,
    phone: Option<String>,
    address_line1: Option<String>,
    address_line2: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    customer_created_source: String,
}

#[derive(Debug, Serialize)]
struct StoreAccountOrderLineJson {
    pub product_name: String,
    pub sku: String,
    pub variation_label: Option<String>,
    pub quantity: i32,
    pub quantity_returned: i32,
    pub unit_price: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    pub fulfillment: DbFulfillmentType,
    pub is_fulfilled: bool,
    pub salesperson_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct StoreAccountTransactionDetailResponse {
    pub transaction_id: Uuid,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub sale_channel: DbSaleChannel,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub fulfillment_method: DbOrderFulfillmentMethod,
    pub ship_to: Option<serde_json::Value>,
    pub shipping_amount_usd: Option<Decimal>,
    pub tracking_number: Option<String>,
    pub tracking_url_provider: Option<String>,
    pub payment_methods_summary: String,
    pub primary_salesperson_name: Option<String>,
    pub financial_summary: TransactionFinancialSummary,
    pub items: Vec<StoreAccountOrderLineJson>,
}

fn map_store_transaction_detail(
    d: TransactionDetailResponse,
    sale_channel: DbSaleChannel,
) -> StoreAccountTransactionDetailResponse {
    let items = d
        .items
        .into_iter()
        .map(|it| StoreAccountOrderLineJson {
            product_name: it.product_name,
            sku: it.sku,
            variation_label: it.variation_label,
            quantity: it.quantity,
            quantity_returned: it.quantity_returned,
            unit_price: it.unit_price,
            state_tax: it.state_tax,
            local_tax: it.local_tax,
            fulfillment: it.fulfillment,
            is_fulfilled: it.is_fulfilled,
            salesperson_name: it.salesperson_name,
        })
        .collect();

    StoreAccountTransactionDetailResponse {
        transaction_id: d.transaction_id,
        booked_at: d.booked_at,
        status: d.status,
        sale_channel,
        total_price: d.total_price,
        amount_paid: d.amount_paid,
        balance_due: d.balance_due,
        fulfillment_method: d.fulfillment_method,
        ship_to: d.ship_to,
        shipping_amount_usd: d.shipping_amount_usd,
        tracking_number: d.tracking_number,
        tracking_url_provider: d.tracking_url_provider,
        payment_methods_summary: d.payment_methods_summary,
        primary_salesperson_name: d.primary_salesperson_name,
        financial_summary: d.financial_summary,
        items,
    }
}

fn normalize_opt(s: Option<String>, max: usize) -> Result<Option<String>, &'static str> {
    match s {
        None => Ok(None),
        Some(v) => {
            let t = v.trim();
            if t.is_empty() {
                Ok(None)
            } else if t.len() > max {
                Err("field too long")
            } else {
                Ok(Some(t.to_string()))
            }
        }
    }
}

async fn post_store_account_login(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StoreAccountEmailPasswordBody>,
) -> impl IntoResponse {
    if let Err(r) = check_unauth_rate(&state, &headers, peer, "login").await {
        return r;
    }
    let Some(email_norm) = normalize_store_email(&body.email) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "email is required" })),
        )
            .into_response();
    };
    let Ok(Some(cid)) = find_customer_id_by_normalized_email(&state.db, &email_norm).await else {
        return auth_failure_response(false);
    };
    let Ok(Some(hash)) = fetch_online_password_hash(&state.db, cid).await else {
        return auth_failure_response(true);
    };
    if !verify_customer_password(&body.password, &hash) {
        return auth_failure_response(false);
    }
    let token = match sign_store_customer_token(cid, &state.store_customer_jwt_secret) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "store customer jwt sign failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };
    (
        StatusCode::OK,
        Json(TokenResponse {
            token,
            customer_id: cid,
        }),
    )
        .into_response()
}

async fn post_store_account_register(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StoreAccountRegisterBody>,
) -> impl IntoResponse {
    if let Err(r) = check_unauth_rate(&state, &headers, peer, "register").await {
        return r;
    }
    let Some(email_norm) = normalize_store_email(&body.email) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "email is required" })),
        )
            .into_response();
    };
    let first = body.first_name.trim().to_string();
    let last = body.last_name.trim().to_string();
    if first.is_empty() || last.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "first and last name are required" })),
        )
            .into_response();
    }

    if let Ok(Some(existing)) = find_customer_id_by_normalized_email(&state.db, &email_norm).await {
        let has_cred = online_credential_exists(&state.db, existing)
            .await
            .unwrap_or(false);
        return (
            StatusCode::CONFLICT,
            Json(if has_cred {
                json!({
                    "error": "An account with this email already exists. Sign in instead.",
                    "code": "use_login"
                })
            } else {
                json!({
                    "error": "This email is already on file at the store. Use Link password to activate online access.",
                    "code": "use_activate"
                })
            }),
        )
            .into_response();
    }

    let password_hash = match hash_customer_password(&body.password) {
        Ok(h) => h,
        Err(StoreCustomerPasswordError::TooShort) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "password must be at least 8 characters" })),
            )
                .into_response();
        }
        Err(StoreCustomerPasswordError::TooLong) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "password is too long" })),
            )
                .into_response();
        }
        Err(StoreCustomerPasswordError::Hash) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    let phone = body
        .phone
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "store account register tx begin");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    let id = match insert_customer_in_tx(
        &mut tx,
        InsertCustomerParams {
            customer_code: None,
            first_name: first,
            last_name: last,
            company_name: None,
            email: Some(email_norm.clone()),
            phone,
            address_line1: None,
            address_line2: None,
            city: None,
            state: None,
            postal_code: None,
            date_of_birth: None,
            anniversary_date: None,
            custom_field_1: None,
            custom_field_2: None,
            custom_field_3: None,
            custom_field_4: None,
            marketing_email_opt_in: false,
            marketing_sms_opt_in: false,
            transactional_sms_opt_in: false,
            transactional_email_opt_in: true,
            customer_created_source: CustomerCreatedSource::OnlineStore,
        },
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            let _ = tx.rollback().await;
            tracing::error!(error = %e, "store account register insert customer");
            if let sqlx::Error::Database(ref d) = e {
                if d.is_unique_violation() {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({
                            "error": "This email is already in use.",
                            "code": "email_taken"
                        })),
                    )
                        .into_response();
                }
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    if let Err(e) = insert_online_credential_in_tx(&mut tx, id, &password_hash).await {
        let _ = tx.rollback().await;
        tracing::error!(error = %e, "store account register credential");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
            .into_response();
    }

    if let Err(e) = tx.commit().await {
        tracing::error!(error = %e, "store account register commit");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
            .into_response();
    }

    let token = match sign_store_customer_token(id, &state.store_customer_jwt_secret) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "store customer jwt sign after register");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        Json(TokenResponse {
            token,
            customer_id: id,
        }),
    )
        .into_response()
}

async fn post_store_account_activate(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StoreAccountEmailPasswordBody>,
) -> impl IntoResponse {
    if let Err(r) = check_unauth_rate(&state, &headers, peer, "activate").await {
        return r;
    }
    let Some(email_norm) = normalize_store_email(&body.email) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "email is required" })),
        )
            .into_response();
    };
    let Ok(Some(cid)) = find_customer_id_by_normalized_email(&state.db, &email_norm).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "No customer found with this email. Register a new account or use the email on file at the store."
            })),
        )
            .into_response();
    };
    let has_cred = match online_credential_exists(&state.db, cid).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, "store account activate credential check");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };
    if has_cred {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Online access is already set up. Sign in instead.",
                "code": "use_login"
            })),
        )
            .into_response();
    }

    let password_hash = match hash_customer_password(&body.password) {
        Ok(h) => h,
        Err(StoreCustomerPasswordError::TooShort) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "password must be at least 8 characters" })),
            )
                .into_response();
        }
        Err(StoreCustomerPasswordError::TooLong) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "password is too long" })),
            )
                .into_response();
        }
        Err(StoreCustomerPasswordError::Hash) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "store account activate tx begin");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };
    if let Err(e) = insert_online_credential_in_tx(&mut tx, cid, &password_hash).await {
        let _ = tx.rollback().await;
        tracing::error!(error = %e, "store account activate insert credential");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
            .into_response();
    }
    if let Err(e) = tx.commit().await {
        tracing::error!(error = %e, "store account activate commit");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
            .into_response();
    }

    let token = match sign_store_customer_token(cid, &state.store_customer_jwt_secret) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "store customer jwt sign after activate");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        Json(TokenResponse {
            token,
            customer_id: cid,
        }),
    )
        .into_response()
}

async fn fetch_store_account_me_row(
    pool: &sqlx::PgPool,
    cid: Uuid,
) -> Result<StoreAccountMeRow, sqlx::Error> {
    sqlx::query_as::<_, StoreAccountMeRow>(
        r#"
        SELECT id, customer_code,
            COALESCE(first_name, '') AS first_name,
            COALESCE(last_name, '') AS last_name,
            company_name, email, phone,
            address_line1, address_line2, city, state, postal_code,
            customer_created_source
        FROM customers WHERE id = $1
        "#,
    )
    .bind(cid)
    .fetch_optional(pool)
    .await?
    .ok_or(sqlx::Error::RowNotFound)
}

async fn get_store_account_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let cid = match bearer_customer_id(&headers, &state.store_customer_jwt_secret) {
        Ok(id) => id,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
    };
    if let Err(r) = check_authed_rate(&state, cid, "me_get").await {
        return r;
    }
    let row = match fetch_store_account_me_row(&state.db, cid).await {
        Ok(r) => r,
        Err(sqlx::Error::RowNotFound) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!(error = %e, "store account me");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };
    (StatusCode::OK, Json(row)).into_response()
}

async fn patch_store_account_me(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StoreAccountProfilePatch>,
) -> impl IntoResponse {
    let cid = match bearer_customer_id(&headers, &state.store_customer_jwt_secret) {
        Ok(id) => id,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
    };
    if let Err(r) = check_authed_rate(&state, cid, "me_patch").await {
        return r;
    }

    let has_any = body.first_name.is_some()
        || body.last_name.is_some()
        || body.company_name.is_some()
        || body.phone.is_some()
        || body.address_line1.is_some()
        || body.address_line2.is_some()
        || body.city.is_some()
        || body.state.is_some()
        || body.postal_code.is_some();
    if !has_any {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "no fields to update" })),
        )
            .into_response();
    }

    let first_name: Option<String> = match body.first_name {
        None => None,
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else if t.len() > 120 {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "field too long" })),
                )
                    .into_response();
            } else {
                Some(t.to_string())
            }
        }
    };
    let last_name: Option<String> = match body.last_name {
        None => None,
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else if t.len() > 120 {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "field too long" })),
                )
                    .into_response();
            } else {
                Some(t.to_string())
            }
        }
    };

    let company_name = match normalize_opt(body.company_name, 200) {
        Ok(v) => v,
        Err(m) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
    };
    let phone = match normalize_opt(body.phone, 64) {
        Ok(v) => v,
        Err(m) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
    };
    let address_line1 = match normalize_opt(body.address_line1, 255) {
        Ok(v) => v,
        Err(m) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
    };
    let address_line2 = match normalize_opt(body.address_line2, 255) {
        Ok(v) => v,
        Err(m) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
    };
    let city = match normalize_opt(body.city, 120) {
        Ok(v) => v,
        Err(m) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
    };
    let state_st = match normalize_opt(body.state, 64) {
        Ok(v) => v,
        Err(m) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
    };
    let postal_code = match normalize_opt(body.postal_code, 32) {
        Ok(v) => v,
        Err(m) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
    };

    let res = sqlx::query(
        r#"
        UPDATE customers SET
            first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            company_name = COALESCE($4, company_name),
            phone = COALESCE($5, phone),
            address_line1 = COALESCE($6, address_line1),
            address_line2 = COALESCE($7, address_line2),
            city = COALESCE($8, city),
            state = COALESCE($9, state),
            postal_code = COALESCE($10, postal_code)
        WHERE id = $1
        "#,
    )
    .bind(cid)
    .bind(first_name.as_deref())
    .bind(last_name.as_deref())
    .bind(company_name.as_deref())
    .bind(phone.as_deref())
    .bind(address_line1.as_deref())
    .bind(address_line2.as_deref())
    .bind(city.as_deref())
    .bind(state_st.as_deref())
    .bind(postal_code.as_deref())
    .execute(&state.db)
    .await;

    if let Err(e) = res {
        tracing::error!(error = %e, "store account patch me");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
            .into_response();
    }

    let row = match fetch_store_account_me_row(&state.db, cid).await {
        Ok(r) => r,
        Err(sqlx::Error::RowNotFound) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!(error = %e, "store account me after patch");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };
    (StatusCode::OK, Json(row)).into_response()
}

async fn post_store_account_change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StoreAccountChangePasswordBody>,
) -> impl IntoResponse {
    let cid = match bearer_customer_id(&headers, &state.store_customer_jwt_secret) {
        Ok(id) => id,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
    };
    if let Err(r) = check_authed_rate(&state, cid, "password").await {
        return r;
    }

    let Ok(Some(hash)) = fetch_online_password_hash(&state.db, cid).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "online password is not set for this account" })),
        )
            .into_response();
    };
    if !verify_customer_password(&body.current_password, &hash) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "current password is incorrect" })),
        )
            .into_response();
    }

    let new_hash = match hash_customer_password(&body.new_password) {
        Ok(h) => h,
        Err(StoreCustomerPasswordError::TooShort) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "new password must be at least 8 characters" })),
            )
                .into_response();
        }
        Err(StoreCustomerPasswordError::TooLong) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "new password is too long" })),
            )
                .into_response();
        }
        Err(StoreCustomerPasswordError::Hash) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    if let Err(e) = sqlx::query(
        r#"
        UPDATE customer_online_credential
        SET password_hash = $2, updated_at = now()
        WHERE customer_id = $1
        "#,
    )
    .bind(cid)
    .bind(&new_hash)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %e, "store account password update");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
            .into_response();
    }

    (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response()
}

async fn get_store_account_transaction_detail(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let cid = match bearer_customer_id(&headers, &state.store_customer_jwt_secret) {
        Ok(id) => id,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
    };
    if let Err(r) = check_authed_rate(&state, cid, "order_detail").await {
        return r;
    }

    let sale_channel: Option<DbSaleChannel> = match sqlx::query_scalar(
        "SELECT sale_channel FROM transactions WHERE id = $1 AND customer_id = $2",
    )
    .bind(transaction_id)
    .bind(cid)
    .fetch_optional(&state.db)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, "store account order ownership");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    let Some(sc) = sale_channel else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "order not found" })),
        )
            .into_response();
    };

    let detail = match load_transaction_detail(&state.db, transaction_id).await {
        Ok(d) => d,
        Err(TransactionError::NotFound) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "order not found" })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!(error = %e, "store account order detail load");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response();
        }
    };

    let out = map_store_transaction_detail(detail, sc);
    (StatusCode::OK, Json(out)).into_response()
}

async fn get_store_account_transactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CustomerTransactionHistoryQuery>,
) -> impl IntoResponse {
    let cid = match bearer_customer_id(&headers, &state.store_customer_jwt_secret) {
        Ok(id) => id,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
    };
    if let Err(r) = check_authed_rate(&state, cid, "orders_list").await {
        return r;
    }
    match query_customer_transaction_history(&state.db, cid, &q).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "store account orders");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(post_store_account_login))
        .route("/register", post(post_store_account_register))
        .route("/activate", post(post_store_account_activate))
        .route("/password", post(post_store_account_change_password))
        .route(
            "/me",
            get(get_store_account_me).patch(patch_store_account_me),
        )
        .route(
            "/orders/{transaction_id}",
            get(get_store_account_transaction_detail),
        )
        .route("/orders", get(get_store_account_transactions))
}
