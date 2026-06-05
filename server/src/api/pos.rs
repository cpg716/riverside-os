//! POS helpers (register session): internal line metadata for client without hard-coded UUIDs.

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, CUSTOMERS_RMS_CHARGE_MANAGE_LINKS,
    CUSTOMERS_RMS_CHARGE_REVERSE, ORDERS_REFUND_PROCESS, POS_RMS_CHARGE_HISTORY_BASIC,
    POS_RMS_CHARGE_LOOKUP, POS_RMS_CHARGE_PAYMENT_COLLECT, POS_RMS_CHARGE_USE,
};
use crate::logic::pos_rms_charge;
use crate::logic::shippo::{self, ShippoError};
use crate::middleware;

#[derive(Debug, Error)]
pub enum PosMetaError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    BadRequest(String),
}

#[derive(serde::Serialize)]
struct RmsMutationResult {
    operation_type: String,
    posting_status: String,
    host_reference: Option<String>,
    metadata: Value,
}

#[derive(Debug, Clone, Serialize)]
struct RmsChargeAccountChoice {
    link_id: String,
    masked_account: String,
    status: String,
    is_primary: bool,
    program_group: Option<String>,
    available_credit: Option<String>,
    current_balance: Option<String>,
    source: String,
    linked_corecredit_customer_id: Option<String>,
    linked_corecredit_account_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct RmsChargeBlockingError {
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct RmsChargeAccountSummary {
    masked_account: String,
    account_status: String,
    available_credit: Option<String>,
    current_balance: Option<String>,
    resolution_status: String,
    source: String,
}

#[derive(Debug, Serialize)]
struct RmsChargeResolveResponse {
    resolution_status: String,
    selected_account: Option<RmsChargeAccountChoice>,
    choices: Vec<RmsChargeAccountChoice>,
    blocking_error: Option<RmsChargeBlockingError>,
    summary: Option<RmsChargeAccountSummary>,
}

#[derive(Debug, Serialize)]
struct RmsChargeProgramOption {
    program_code: String,
    program_label: String,
    eligible: bool,
    disclosure: Option<String>,
    source: String,
    warning_code: Option<String>,
}

#[derive(Debug, Serialize)]
struct RmsChargeProgramsResponse {
    programs: Vec<RmsChargeProgramOption>,
    summary: RmsChargeAccountSummary,
}

impl IntoResponse for PosMetaError {
    fn into_response(self) -> Response {
        match self {
            PosMetaError::Unauthorized(m) => {
                (axum::http::StatusCode::UNAUTHORIZED, m).into_response()
            }
            PosMetaError::NotFound(m) => (axum::http::StatusCode::NOT_FOUND, m).into_response(),
            PosMetaError::Forbidden(m) => (
                axum::http::StatusCode::FORBIDDEN,
                Json(json!({ "error": m })),
            )
                .into_response(),
            PosMetaError::BadRequest(m) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": m })),
            )
                .into_response(),
            PosMetaError::Database(e) => {
                tracing::error!(error = %e, "pos meta database error");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "database error".to_string(),
                )
                    .into_response()
            }
        }
    }
}

#[derive(Debug)]
enum PosShippingError {
    Shippo(ShippoError),
    Unauthorized(String),
}

impl IntoResponse for PosShippingError {
    fn into_response(self) -> Response {
        match self {
            PosShippingError::Unauthorized(m) => {
                (axum::http::StatusCode::UNAUTHORIZED, m).into_response()
            }
            PosShippingError::Shippo(ShippoError::InvalidAddress(m)) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            )
                .into_response(),
            PosShippingError::Shippo(ShippoError::Parse(m)) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            )
                .into_response(),
            PosShippingError::Shippo(ShippoError::Api(m)) => {
                tracing::warn!(error = %m, "pos shipping rates error");
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({ "error": "shipping provider unavailable" })),
                )
                    .into_response()
            }
            PosShippingError::Shippo(ShippoError::Database(e)) => {
                tracing::error!(error = %e, "pos shipping rates DB error");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "internal error" })),
                )
                    .into_response()
            }
        }
    }
}

impl From<ShippoError> for PosShippingError {
    fn from(e: ShippoError) -> Self {
        PosShippingError::Shippo(e)
    }
}

async fn require_pos_rms_permission(
    state: &AppState,
    headers: &HeaderMap,
    permissions: &[&str],
) -> Result<crate::auth::pins::AuthenticatedStaff, PosMetaError> {
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;
    let effective = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(PosMetaError::Database)?;
    if permissions
        .iter()
        .any(|permission| staff_has_permission(&effective, permission))
    {
        Ok(staff)
    } else {
        Err(PosMetaError::Forbidden("missing permission".to_string()))
    }
}

async fn require_staff_rms_sensitive_permission(
    state: &AppState,
    headers: &HeaderMap,
    permissions: &[&str],
) -> Result<crate::auth::pins::AuthenticatedStaff, PosMetaError> {
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;
    let effective = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(PosMetaError::Database)?;
    if permissions
        .iter()
        .any(|permission| staff_has_permission(&effective, permission))
    {
        Ok(staff)
    } else {
        Err(PosMetaError::Forbidden("missing permission".to_string()))
    }
}

fn mask_account_identifier(value: &str) -> String {
    let trimmed = value.trim();
    let last4: String = trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if last4.is_empty() {
        "Linked account".to_string()
    } else {
        format!("••••{last4}")
    }
}

fn decimal_snapshot(value: Option<Decimal>) -> Option<String> {
    value.map(|amount| format!("{amount:.2}"))
}

fn snapshot_status(open_to_buy: Option<Decimal>, past_due: Option<Decimal>) -> String {
    if past_due.unwrap_or(Decimal::ZERO) > Decimal::ZERO {
        "past_due".to_string()
    } else if open_to_buy.unwrap_or(Decimal::ZERO) <= Decimal::ZERO {
        "no_open_to_buy".to_string()
    } else {
        "active".to_string()
    }
}

fn account_summary(
    account: &RmsChargeAccountChoice,
    resolution_status: &str,
) -> RmsChargeAccountSummary {
    RmsChargeAccountSummary {
        masked_account: account.masked_account.clone(),
        account_status: account.status.clone(),
        available_credit: account.available_credit.clone(),
        current_balance: account.current_balance.clone(),
        resolution_status: resolution_status.to_string(),
        source: account.source.clone(),
    }
}

async fn load_rms_account_choices(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Vec<RmsChargeAccountChoice>, sqlx::Error> {
    let linked_rows: Vec<(
        String,
        String,
        String,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT
            corecredit_customer_id,
            corecredit_account_id,
            status,
            is_primary,
            program_group,
            available_credit_snapshot,
            current_balance_snapshot
        FROM customer_corecredit_accounts
        WHERE customer_id = $1
          AND lower(status) NOT IN ('closed', 'inactive')
        ORDER BY is_primary DESC, updated_at DESC
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let mut choices: Vec<RmsChargeAccountChoice> = linked_rows
        .into_iter()
        .map(
            |(
                corecredit_customer_id,
                corecredit_account_id,
                status,
                is_primary,
                program_group,
                available_credit,
                current_balance,
            )| RmsChargeAccountChoice {
                link_id: corecredit_account_id.clone(),
                masked_account: mask_account_identifier(&corecredit_account_id),
                status,
                is_primary,
                program_group,
                available_credit,
                current_balance,
                source: "linked_account".to_string(),
                linked_corecredit_customer_id: Some(corecredit_customer_id),
                linked_corecredit_account_id: Some(corecredit_account_id),
            },
        )
        .collect();

    let snapshot_rows: Vec<(
        String,
        Option<String>,
        Option<Decimal>,
        Option<Decimal>,
        Option<Decimal>,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        WITH latest_batch AS (
            SELECT id
            FROM rms_account_list_import_batches
            WHERE status = 'imported'
            ORDER BY uploaded_at DESC, created_at DESC
            LIMIT 1
        ),
        target_customer AS (
            SELECT NULLIF(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), '') AS phone_digits
            FROM customers
            WHERE id = $1
        ),
        unique_customer_phone AS (
            SELECT phone_digits
            FROM (
                SELECT NULLIF(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), '') AS phone_digits
                FROM customers
            ) normalized
            WHERE phone_digits IS NOT NULL
            GROUP BY phone_digits
            HAVING COUNT(*) = 1
        )
        SELECT
            s.account_number,
            s.account_year,
            s.open_to_buy,
            s.balance,
            s.past_due,
            s.match_method
        FROM rms_account_list_snapshots s
        JOIN latest_batch b ON b.id = s.batch_id
        LEFT JOIN target_customer c ON TRUE
        WHERE s.matched_customer_id = $1
           OR (
                s.matched_customer_id IS NULL
                AND s.normalized_phone IS NOT NULL
                AND s.normalized_phone = c.phone_digits
                AND EXISTS (
                    SELECT 1
                    FROM unique_customer_phone u
                    WHERE u.phone_digits = c.phone_digits
                )
           )
        ORDER BY
            CASE WHEN s.matched_customer_id = $1 THEN 0 ELSE 1 END,
            s.balance DESC NULLS LAST,
            s.account_number ASC
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    for (account_number, account_year, open_to_buy, balance, past_due, _match_method) in
        snapshot_rows
    {
        if choices
            .iter()
            .any(|choice| choice.link_id == account_number)
        {
            continue;
        }
        choices.push(RmsChargeAccountChoice {
            link_id: account_number.clone(),
            masked_account: mask_account_identifier(&account_number),
            status: snapshot_status(open_to_buy, past_due),
            is_primary: choices.is_empty(),
            program_group: account_year,
            available_credit: decimal_snapshot(open_to_buy),
            current_balance: decimal_snapshot(balance),
            source: "account_list_import".to_string(),
            linked_corecredit_customer_id: None,
            linked_corecredit_account_id: Some(account_number),
        });
    }

    Ok(choices)
}

fn rms_programs_for_account(account: &RmsChargeAccountChoice) -> Vec<RmsChargeProgramOption> {
    let status = account.status.to_ascii_lowercase();
    let active = status == "active" || status == "past_due";
    let has_open_to_buy = account
        .available_credit
        .as_deref()
        .and_then(|value| value.parse::<Decimal>().ok())
        .map(|value| value > Decimal::ZERO)
        .unwrap_or(true);
    let eligible = active && has_open_to_buy;
    let warning_code = if !active {
        Some("account_restricted".to_string())
    } else if !has_open_to_buy {
        Some("no_open_to_buy".to_string())
    } else {
        None
    };
    let disclosure = if eligible {
        Some("Confirm the program and enter the R2S/manual approval reference before completing checkout.".to_string())
    } else {
        Some("This account is not eligible for new RMS Charge purchases. Payment collection may still be allowed.".to_string())
    };
    let source = account.source.clone();
    let group = account
        .program_group
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let include_standard = group.is_empty() || group == "rms" || group.contains("standard");
    let include_rms90 = group.is_empty() || group == "rms" || group.contains("90");
    let mut programs = Vec::new();
    if include_standard {
        programs.push(RmsChargeProgramOption {
            program_code: "standard".to_string(),
            program_label: "Standard RMS".to_string(),
            eligible,
            disclosure: disclosure.clone(),
            source: source.clone(),
            warning_code: warning_code.clone(),
        });
    }
    if include_rms90 {
        programs.push(RmsChargeProgramOption {
            program_code: "rms90".to_string(),
            program_label: "RMS 90".to_string(),
            eligible,
            disclosure,
            source,
            warning_code,
        });
    }
    if programs.is_empty() {
        programs.push(RmsChargeProgramOption {
            program_code: "standard".to_string(),
            program_label: "Standard RMS".to_string(),
            eligible,
            disclosure: Some(
                "Program group was missing or unknown; confirm in R2S before completing checkout."
                    .to_string(),
            ),
            source: account.source.clone(),
            warning_code: Some("program_group_unknown".to_string()),
        });
    }
    programs
}

#[derive(Debug, Deserialize)]
pub struct PosShippingRatesBody {
    pub to_address: shippo::ShippingAddressInput,
    #[serde(default)]
    pub parcel: Option<shippo::ParcelInput>,
    #[serde(default)]
    pub parcels: Option<Vec<shippo::ParcelInput>>,
    #[serde(default)]
    pub customs_declaration_object_id: Option<String>,
    /// When false (default), live Shippo may run if configured in Settings + env.
    #[serde(default)]
    pub force_stub: bool,
}

async fn post_pos_shipping_rates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PosShippingRatesBody>,
) -> Result<Json<shippo::StoreShippingRatesResult>, PosShippingError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosShippingError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;

    let res = shippo::pos_shipping_rates(
        &state.db,
        &state.http_client,
        &body.to_address,
        body.parcel.as_ref(),
        body.parcels.as_deref(),
        body.customs_declaration_object_id.as_deref(),
        false,
        body.force_stub,
    )
    .await?;
    Ok(Json(res))
}

#[derive(Debug, Serialize)]
pub struct RmsPaymentLineMeta {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct GiftCardLoadLineMeta {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct ReverseRmsChargeBody {
    #[serde(default)]
    record_id: Option<Uuid>,
    #[serde(default)]
    transaction_id: Option<Uuid>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    amount: Option<rust_decimal::Decimal>,
}

#[derive(Debug, Deserialize)]
struct RmsCustomerQuery {
    customer_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct RmsProgramsQuery {
    customer_id: Uuid,
    #[serde(default)]
    account_id: Option<String>,
}

async fn rms_payment_line_meta(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Option<RmsPaymentLineMeta>>, PosMetaError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;

    let row: Option<(Uuid, Uuid, String, String)> = sqlx::query_as(
        r#"
        SELECT p.id, v.id, v.sku, p.name
        FROM products p
        INNER JOIN product_variants v ON v.product_id = p.id
        WHERE p.pos_line_kind = 'rms_charge_payment'
        ORDER BY p.created_at ASC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.map(|(product_id, variant_id, sku, name)| {
        RmsPaymentLineMeta {
            product_id,
            variant_id,
            sku,
            name,
        }
    })))
}

async fn gift_card_load_line_meta(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Option<GiftCardLoadLineMeta>>, PosMetaError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;

    let row: Option<(Uuid, Uuid, String, String)> = sqlx::query_as(
        r#"
        SELECT p.id, v.id, v.sku, p.name
        FROM products p
        INNER JOIN product_variants v ON v.product_id = p.id
        WHERE p.pos_line_kind = 'pos_gift_card_load'
        ORDER BY p.created_at ASC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.map(|(product_id, variant_id, sku, name)| {
        GiftCardLoadLineMeta {
            product_id,
            variant_id,
            sku,
            name,
        }
    })))
}

async fn resolve_rms_charge_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RmsCustomerQuery>,
) -> Result<Json<RmsChargeResolveResponse>, PosMetaError> {
    require_pos_rms_permission(
        &state,
        &headers,
        &[
            POS_RMS_CHARGE_USE,
            POS_RMS_CHARGE_LOOKUP,
            POS_RMS_CHARGE_PAYMENT_COLLECT,
        ],
    )
    .await?;

    let choices = load_rms_account_choices(&state.db, q.customer_id).await?;
    if choices.is_empty() {
        return Ok(Json(RmsChargeResolveResponse {
            resolution_status: "blocked".to_string(),
            selected_account: None,
            choices,
            blocking_error: Some(RmsChargeBlockingError {
                code: "account_not_found".to_string(),
                message: "No RMS Charge account is linked or matched from the latest account-list import for this customer.".to_string(),
            }),
            summary: None,
        }));
    }

    if choices.len() == 1 {
        let account = choices[0].clone();
        return Ok(Json(RmsChargeResolveResponse {
            resolution_status: "selected".to_string(),
            selected_account: Some(account.clone()),
            choices,
            blocking_error: None,
            summary: Some(account_summary(&account, "selected")),
        }));
    }

    Ok(Json(RmsChargeResolveResponse {
        resolution_status: "multiple".to_string(),
        selected_account: None,
        choices,
        blocking_error: None,
        summary: None,
    }))
}

async fn rms_charge_programs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RmsProgramsQuery>,
) -> Result<Json<RmsChargeProgramsResponse>, PosMetaError> {
    require_pos_rms_permission(
        &state,
        &headers,
        &[
            POS_RMS_CHARGE_USE,
            POS_RMS_CHARGE_LOOKUP,
            POS_RMS_CHARGE_PAYMENT_COLLECT,
        ],
    )
    .await?;

    let choices = load_rms_account_choices(&state.db, q.customer_id).await?;
    let account = if let Some(account_id) = q
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        choices
            .iter()
            .find(|choice| choice.link_id == account_id)
            .cloned()
            .ok_or_else(|| {
                PosMetaError::BadRequest(
                    "RMS Charge account was not found for this customer.".to_string(),
                )
            })?
    } else if choices.len() == 1 {
        choices[0].clone()
    } else {
        return Err(PosMetaError::BadRequest(
            "account_id is required when the customer has multiple RMS Charge accounts."
                .to_string(),
        ));
    };

    Ok(Json(RmsChargeProgramsResponse {
        programs: rms_programs_for_account(&account),
        summary: account_summary(&account, "selected"),
    }))
}

async fn reverse_rms_record_manual(
    state: &AppState,
    record_id: Uuid,
    status: &str,
    reason: Option<String>,
    amount: rust_decimal::Decimal,
) -> Result<RmsMutationResult, PosMetaError> {
    let now = chrono::Utc::now();
    let (metadata_row, current_resolution): (Option<Value>, String) = sqlx::query_as(
        "SELECT metadata_json, COALESCE(resolution_status, '') FROM pos_rms_charge_record WHERE id = $1"
    )
        .bind(record_id)
        .fetch_optional(&state.db)
        .await
        .map_err(PosMetaError::Database)?
        .ok_or(PosMetaError::BadRequest(
            "RMS charge record not found".to_string(),
        ))?;
    if current_resolution == "refunded" || current_resolution == "reversed" {
        return Err(PosMetaError::BadRequest(
            "Record has already been reversed or refunded".to_string(),
        ));
    }
    let mut metadata = metadata_row.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }
    let obj = metadata.as_object_mut().expect("object just assigned");
    obj.insert(
        "source_mode".to_string(),
        Value::String("manual".to_string()),
    );
    obj.insert(
        "rms_charge_source".to_string(),
        Value::String("manual".to_string()),
    );
    obj.insert(
        "posting_status".to_string(),
        Value::String(status.to_string()),
    );
    obj.insert(
        "manual_tracking_status".to_string(),
        Value::String(format!("{status}_manually")),
    );
    obj.insert("not_host_posted".to_string(), Value::Bool(true));
    obj.insert(
        "manual_follow_on_amount".to_string(),
        Value::String(amount.to_string()),
    );
    if let Some(reason) = reason.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        obj.insert(
            "manual_follow_on_reason".to_string(),
            Value::String(reason.to_string()),
        );
    }
    let timestamp_field = if status == "refunded" {
        "refunded_at"
    } else {
        "reversed_at"
    };
    obj.insert(timestamp_field.to_string(), Value::String(now.to_rfc3339()));

    let mut tx = state.db.begin().await.map_err(PosMetaError::Database)?;
    pos_rms_charge::update_record_host_result(&mut *tx, record_id, &metadata)
        .await
        .map_err(PosMetaError::Database)?;

    let host_reference: Option<String> =
        sqlx::query_scalar("SELECT host_reference FROM pos_rms_charge_record WHERE id = $1")
            .bind(record_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(PosMetaError::Database)?;

    tx.commit().await.map_err(PosMetaError::Database)?;

    Ok(RmsMutationResult {
        operation_type: if status == "refunded" {
            "refund".to_string()
        } else {
            "reversal".to_string()
        },
        posting_status: status.to_string(),
        host_reference,
        metadata,
    })
}

async fn reverse_rms_charge_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReverseRmsChargeBody>,
) -> Result<Json<RmsMutationResult>, PosMetaError> {
    let staff =
        require_staff_rms_sensitive_permission(&state, &headers, &[CUSTOMERS_RMS_CHARGE_REVERSE])
            .await?;
    let record_id = if let Some(id) = body.record_id {
        id
    } else if let Some(transaction_id) = body.transaction_id {
        sqlx::query_scalar(
            r#"
            SELECT id
            FROM pos_rms_charge_record
            WHERE transaction_id = $1 AND record_kind = 'charge'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&state.db)
        .await
        .map_err(PosMetaError::Database)?
    } else {
        return Err(PosMetaError::BadRequest(
            "record_id or transaction_id is required".to_string(),
        ));
    };
    let result = reverse_rms_record_manual(
        &state,
        record_id,
        "refunded",
        body.reason.clone(),
        body.amount.unwrap_or_else(|| rust_decimal::Decimal::ZERO),
    )
    .await?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_purchase_refund",
        json!({
            "record_id": record_id,
            "amount": body.amount,
            "host_reference": result.host_reference,
        }),
    )
    .await;
    Ok(Json(result))
}

async fn reverse_rms_charge_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReverseRmsChargeBody>,
) -> Result<Json<RmsMutationResult>, PosMetaError> {
    let staff =
        require_staff_rms_sensitive_permission(&state, &headers, &[CUSTOMERS_RMS_CHARGE_REVERSE])
            .await?;
    let record_id = if let Some(id) = body.record_id {
        id
    } else if let Some(transaction_id) = body.transaction_id {
        sqlx::query_scalar(
            r#"
            SELECT id
            FROM pos_rms_charge_record
            WHERE transaction_id = $1 AND record_kind = 'payment'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&state.db)
        .await
        .map_err(PosMetaError::Database)?
    } else {
        return Err(PosMetaError::BadRequest(
            "record_id or transaction_id is required".to_string(),
        ));
    };
    let result = reverse_rms_record_manual(
        &state,
        record_id,
        "reversed",
        body.reason.clone(),
        body.amount.unwrap_or_else(|| rust_decimal::Decimal::ZERO),
    )
    .await?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_payment_reversal",
        json!({
            "record_id": record_id,
            "amount": body.amount,
            "host_reference": result.host_reference,
        }),
    )
    .await;
    Ok(Json(result))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rms-payment-line-meta", get(rms_payment_line_meta))
        .route("/gift-card-load-line-meta", get(gift_card_load_line_meta))
        .route(
            "/rms-charge/resolve-account",
            get(resolve_rms_charge_account),
        )
        .route("/rms-charge/programs", get(rms_charge_programs))
        .route(
            "/rms-charge/reverse-purchase",
            post(reverse_rms_charge_purchase),
        )
        .route(
            "/rms-charge/reverse-payment",
            post(reverse_rms_charge_payment),
        )
        .route("/shipping/rates", post(post_pos_shipping_rates))
}
