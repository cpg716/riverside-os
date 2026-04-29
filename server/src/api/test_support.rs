use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::corecard::{self, LinkCustomerCoreCreditAccountRequest};
use crate::logic::customers::{insert_customer, CustomerCreatedSource, InsertCustomerParams};
use crate::logic::meilisearch_sync;
use crate::middleware;
use crate::models::DbStaffRole;

const E2E_CATEGORY_ID: &str = "90000000-0000-0000-0000-000000000001";
const E2E_PRODUCT_ID: &str = "90000000-0000-0000-0000-000000000010";
const E2E_VARIANT_ID: &str = "90000000-0000-0000-0000-000000000011";
const E2E_PRODUCT_SKU: &str = "E2E-RMS-TAILOR";

#[derive(Debug, Error)]
enum TestSupportError {
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{message}")]
    Internal {
        code: &'static str,
        message: String,
        details: Value,
    },
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

impl IntoResponse for TestSupportError {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized(message) => {
                (StatusCode::UNAUTHORIZED, Json(json!({ "error": message }))).into_response()
            }
            Self::Forbidden(message) => {
                (StatusCode::FORBIDDEN, Json(json!({ "error": message }))).into_response()
            }
            Self::BadRequest(message) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
            }
            Self::Internal {
                code,
                message,
                details,
            } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": message,
                    "code": code,
                    "details": details,
                })),
            )
                .into_response(),
            Self::Database(error) => {
                tracing::error!(error = %error, "test support database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "error": "database error",
                        "code": "test_support_database_error",
                        "details": {
                            "message": error.to_string(),
                        }
                    })),
                )
                    .into_response()
            }
        }
    }
}

fn e2e_enabled() -> bool {
    matches!(
        std::env::var("RIVERSIDE_ENABLE_E2E_TEST_SUPPORT")
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

async fn require_admin_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedStaff, TestSupportError> {
    if !e2e_enabled() {
        return Err(TestSupportError::Forbidden(
            "E2E test support is disabled".to_string(),
        ));
    }
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(|(_, Json(value))| {
            TestSupportError::Unauthorized(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;
    if staff.role != DbStaffRole::Admin {
        return Err(TestSupportError::Forbidden(
            "admin access required".to_string(),
        ));
    }
    Ok(staff)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SeedFixtureKind {
    SingleValid,
    MultiMatch,
    NoLinked,
    StandardOnly,
    Rms90Eligible,
    Restricted,
}

#[derive(Debug, Deserialize)]
struct SeedFixtureRequest {
    fixture: SeedFixtureKind,
    #[serde(default)]
    customer_label: Option<String>,
}

#[derive(Debug, Serialize)]
struct SeedCustomerSummary {
    id: Uuid,
    display_name: String,
    search_label: String,
    customer_code: String,
}

#[derive(Debug, Serialize)]
struct SeedProductSummary {
    product_id: Uuid,
    variant_id: Uuid,
    sku: String,
    name: String,
    unit_price: String,
    unit_cost: String,
}

#[derive(Debug, Serialize)]
struct SeedFixtureResponse {
    fixture: String,
    customer: SeedCustomerSummary,
    linked_accounts: Vec<corecard::LinkedCoreCreditAccountView>,
    product: SeedProductSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PrepareRecordMode {
    FailedException,
    PendingWebhook,
    ReconciliationMismatch,
    RetryableException,
}

#[derive(Debug, Deserialize)]
struct PrepareRecordRequest {
    mode: PrepareRecordMode,
    record_id: Uuid,
}

#[derive(Debug, Serialize)]
struct PrepareRecordResponse {
    record_id: Uuid,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exception_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reconciliation_run_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct TestSupportPaymentRow {
    payment_method: String,
    #[serde(default)]
    check_number: Option<String>,
    metadata: Value,
}

#[derive(Debug, Serialize)]
struct TestSupportPaymentAllocationRow {
    payment_transaction_id: Uuid,
    target_transaction_id: Uuid,
    #[serde(default)]
    target_display_id: Option<String>,
    amount_allocated: String,
    payment_method: String,
    payment_amount: String,
    #[serde(default)]
    payment_check_number: Option<String>,
    #[serde(default)]
    allocation_check_number: Option<String>,
    allocation_metadata: Value,
}

#[derive(Debug, Serialize)]
struct TestSupportTransactionArtifacts {
    transaction_id: Uuid,
    transaction_display_id: String,
    total_price: String,
    amount_paid: String,
    balance_due: String,
    rounding_adjustment: String,
    metadata: Value,
    payment_rows: Vec<TestSupportPaymentRow>,
    allocation_rows: Vec<TestSupportPaymentAllocationRow>,
    rms_records: Vec<corecard::RmsChargeRecordDetail>,
}

#[derive(Debug, Serialize)]
struct TestSupportAlterationActivityRow {
    action: String,
    staff_id: Option<Uuid>,
    detail: Value,
}

#[derive(Debug, Deserialize)]
struct SeedQboTaxMappingRequest {
    category_id: Uuid,
    activity_date: NaiveDate,
}

#[derive(Debug, Deserialize)]
struct AssignQboTransactionDateRequest {
    transaction_id: Uuid,
    activity_date: NaiveDate,
}

#[derive(Debug, Deserialize)]
struct AssignQboTransactionTimestampRequest {
    transaction_id: Uuid,
    timestamp_utc: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct AssignQboTransactionFulfillmentTimestampRequest {
    transaction_id: Uuid,
    timestamp_utc: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct AssignQboTransactionForfeitureTimestampRequest {
    transaction_id: Uuid,
    timestamp_utc: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct AssignQboShippingRecognitionRequest {
    transaction_id: Uuid,
    label_purchased_at_utc: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct SeedShippingQuoteRequest {
    amount_usd: rust_decimal::Decimal,
}

#[derive(Debug, Serialize)]
struct TestSupportParkedSaleStatus {
    id: Uuid,
    register_session_id: Uuid,
    status: String,
    audit_actions: Vec<String>,
}

async fn ensure_e2e_catalog(state: &AppState) -> Result<SeedProductSummary, TestSupportError> {
    sqlx::query(
        "INSERT INTO categories (id, name, is_clothing_footwear) VALUES ($1::uuid, 'E2E RMS Services', false) ON CONFLICT (id) DO NOTHING",
    )
    .bind(E2E_CATEGORY_ID)
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO products (
            id, category_id, name, brand, description, base_retail_price, base_cost, spiff_amount, variation_axes, is_active
        )
        VALUES ($1::uuid, $2::uuid, 'E2E RMS Tailoring Package', 'Riverside E2E', 'Deterministic RMS E2E fixture item', 225.00, 80.00, 0.00, ARRAY['Type'], true)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(E2E_PRODUCT_ID)
    .bind(E2E_CATEGORY_ID)
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO product_variants (
            id, product_id, sku, variation_values, variation_label, stock_on_hand
        )
        VALUES ($1::uuid, $2::uuid, $3, '{"Type":"Service"}', 'Service', 999)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(E2E_VARIANT_ID)
    .bind(E2E_PRODUCT_ID)
    .bind(E2E_PRODUCT_SKU)
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO ledger_mappings (internal_key, internal_description, qbo_account_id)
        VALUES
            ('RMS_CHARGE_FINANCING_CLEARING', 'E2E RMS financing clearing', NULL),
            ('RMS_R2S_PAYMENT_CLEARING', 'E2E RMS payment clearing', NULL)
        ON CONFLICT (internal_key) DO UPDATE
        SET internal_description = EXCLUDED.internal_description
        "#,
    )
    .execute(&state.db)
    .await?;

    Ok(SeedProductSummary {
        product_id: Uuid::parse_str(E2E_PRODUCT_ID).expect("valid product uuid"),
        variant_id: Uuid::parse_str(E2E_VARIANT_ID).expect("valid variant uuid"),
        sku: E2E_PRODUCT_SKU.to_string(),
        name: "E2E RMS Tailoring Package".to_string(),
        unit_price: "225.00".to_string(),
        unit_cost: "80.00".to_string(),
    })
}

async fn create_seed_customer(
    state: &AppState,
    fixture: &SeedFixtureKind,
    customer_label: Option<&str>,
) -> Result<SeedCustomerSummary, TestSupportError> {
    let label = customer_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Fixture");
    let suffix = format!(
        "{}-{}",
        Utc::now().format("%Y%m%d%H%M%S%3f"),
        Uuid::new_v4().simple()
    );
    let fixture_name = match fixture {
        SeedFixtureKind::SingleValid => "Single",
        SeedFixtureKind::MultiMatch => "Multi",
        SeedFixtureKind::NoLinked => "NoLink",
        SeedFixtureKind::StandardOnly => "Standard",
        SeedFixtureKind::Rms90Eligible => "RMS90",
        SeedFixtureKind::Restricted => "Restricted",
    };
    let last_name = format!("RMS {fixture_name} {label} {suffix}");
    let customer_id = insert_customer(
        &state.db,
        InsertCustomerParams {
            customer_code: None,
            first_name: "E2E".to_string(),
            last_name: last_name.clone(),
            company_name: None,
            email: Some(format!("e2e+rms-{suffix}@riverside.example")),
            phone: Some("7165550101".to_string()),
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
            transactional_sms_opt_in: true,
            transactional_email_opt_in: true,
            customer_created_source: CustomerCreatedSource::Store,
        },
    )
    .await?;

    let customer_code: String =
        sqlx::query_scalar("SELECT customer_code FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(&state.db)
            .await?;

    // Keep POS and Back Office customer search deterministic for local E2E/manual RMS testing.
    if let Some(client) = state.meilisearch.as_ref() {
        if let Err(error) =
            meilisearch_sync::spawn_meilisearch_customer_upsert(client, &state.db, customer_id)
                .await
        {
            tracing::warn!(
                error = %error,
                %customer_id,
                "failed to sync seeded E2E RMS customer to Meilisearch"
            );
        }
    }

    Ok(SeedCustomerSummary {
        id: customer_id,
        display_name: format!("E2E {last_name}"),
        search_label: format!("E2E {last_name}"),
        customer_code,
    })
}

struct LinkedAccountSeed<'a> {
    corecredit_customer_id: &'a str,
    corecredit_account_id: &'a str,
    status: &'a str,
    is_primary: bool,
    program_group: Option<&'a str>,
}

async fn add_linked_account(
    state: &AppState,
    staff_id: Uuid,
    customer_id: Uuid,
    seed: LinkedAccountSeed<'_>,
) -> Result<(), TestSupportError> {
    corecard::link_customer_account(
        &state.db,
        &LinkCustomerCoreCreditAccountRequest {
            customer_id,
            corecredit_customer_id: seed.corecredit_customer_id.to_string(),
            corecredit_account_id: seed.corecredit_account_id.to_string(),
            corecredit_card_id: None,
            status: Some(seed.status.to_string()),
            is_primary: seed.is_primary,
            program_group: seed.program_group.map(str::to_string),
            verification_source: Some("e2e_fixture".to_string()),
            notes: Some("E2E deterministic fixture".to_string()),
        },
        staff_id,
    )
    .await
    .map_err(|error| TestSupportError::BadRequest(error.to_string()))?;
    Ok(())
}

async fn post_seed_fixture(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SeedFixtureRequest>,
) -> Result<Json<SeedFixtureResponse>, TestSupportError> {
    let staff = require_admin_staff(&state, &headers).await?;
    let product = ensure_e2e_catalog(&state).await?;
    let customer =
        create_seed_customer(&state, &body.fixture, body.customer_label.as_deref()).await?;

    match body.fixture {
        SeedFixtureKind::SingleValid => {
            add_linked_account(
                &state,
                staff.id,
                customer.id,
                LinkedAccountSeed {
                    corecredit_customer_id: "CC-CUST-SINGLE",
                    corecredit_account_id: "CC-E2E-STANDARD",
                    status: "active",
                    is_primary: true,
                    program_group: Some("standard"),
                },
            )
            .await?;
        }
        SeedFixtureKind::MultiMatch => {
            add_linked_account(
                &state,
                staff.id,
                customer.id,
                LinkedAccountSeed {
                    corecredit_customer_id: "CC-CUST-MULTI",
                    corecredit_account_id: "CC-E2E-MULTI-A",
                    status: "active",
                    is_primary: true,
                    program_group: Some("standard"),
                },
            )
            .await?;
            add_linked_account(
                &state,
                staff.id,
                customer.id,
                LinkedAccountSeed {
                    corecredit_customer_id: "CC-CUST-MULTI",
                    corecredit_account_id: "CC-E2E-MULTI-B",
                    status: "active",
                    is_primary: false,
                    program_group: Some("promo90"),
                },
            )
            .await?;
        }
        SeedFixtureKind::NoLinked => {}
        SeedFixtureKind::StandardOnly => {
            add_linked_account(
                &state,
                staff.id,
                customer.id,
                LinkedAccountSeed {
                    corecredit_customer_id: "CC-CUST-STANDARD",
                    corecredit_account_id: "CC-E2E-STANDARD-ONLY",
                    status: "active",
                    is_primary: true,
                    program_group: Some("standard"),
                },
            )
            .await?;
        }
        SeedFixtureKind::Rms90Eligible => {
            add_linked_account(
                &state,
                staff.id,
                customer.id,
                LinkedAccountSeed {
                    corecredit_customer_id: "CC-CUST-RMS90",
                    corecredit_account_id: "CC-E2E-RMS90",
                    status: "active",
                    is_primary: true,
                    program_group: Some("promo90"),
                },
            )
            .await?;
        }
        SeedFixtureKind::Restricted => {
            add_linked_account(
                &state,
                staff.id,
                customer.id,
                LinkedAccountSeed {
                    corecredit_customer_id: "CC-CUST-RESTRICTED",
                    corecredit_account_id: "CC-E2E-RESTRICTED",
                    status: "restricted",
                    is_primary: true,
                    program_group: Some("standard"),
                },
            )
            .await?;
        }
    }

    let linked_accounts = corecard::list_customer_account_views(&state.db, customer.id)
        .await
        .map_err(|error| TestSupportError::BadRequest(error.to_string()))?;

    Ok(Json(SeedFixtureResponse {
        fixture: match body.fixture {
            SeedFixtureKind::SingleValid => "single_valid",
            SeedFixtureKind::MultiMatch => "multi_match",
            SeedFixtureKind::NoLinked => "no_linked",
            SeedFixtureKind::StandardOnly => "standard_only",
            SeedFixtureKind::Rms90Eligible => "rms90_eligible",
            SeedFixtureKind::Restricted => "restricted",
        }
        .to_string(),
        customer,
        linked_accounts,
        product,
    }))
}

async fn post_prepare_record(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PrepareRecordRequest>,
) -> Result<Json<PrepareRecordResponse>, TestSupportError> {
    let staff = require_admin_staff(&state, &headers).await?;
    let record = corecard::get_rms_charge_record_detail(&state.db, body.record_id)
        .await
        .map_err(|error| TestSupportError::BadRequest(error.to_string()))?;
    tracing::info!(
        record_id = %body.record_id,
        mode = ?body.mode,
        record_kind = %record.record_kind,
        posting_status = %record.posting_status,
        account_id = ?record.linked_corecredit_account_id,
        "preparing RMS E2E record state"
    );

    let exception_type = match (
        record.record_kind.as_str(),
        record.external_transaction_type.as_deref(),
    ) {
        ("payment", _) | (_, Some("payment")) => "failed_payment_post",
        (_, Some("refund")) => "failed_refund",
        (_, Some("reversal")) => "failed_reversal",
        _ => "failed_purchase_post",
    };
    let error_code = if record.record_kind == "payment" {
        "host_timeout"
    } else {
        "host_unavailable"
    };

    match body.mode {
        PrepareRecordMode::FailedException | PrepareRecordMode::RetryableException => {
            sqlx::query(
                r#"
                UPDATE pos_rms_charge_record
                SET
                    posting_status = 'failed',
                    posting_error_code = $2,
                    posting_error_message = 'E2E seeded host failure',
                    external_transaction_id = NULL,
                    external_auth_code = NULL,
                    host_reference = NULL,
                    posted_at = NULL,
                    idempotency_key = NULL,
                    metadata_json = jsonb_set(
                        jsonb_set(
                            jsonb_set(COALESCE(metadata_json, '{}'::jsonb), '{posting_status}', to_jsonb('failed'::text), true),
                            '{posting_error_code}', to_jsonb($2::text), true
                        ),
                        '{posting_error_message}', to_jsonb('E2E seeded host failure'::text), true
                    )
                WHERE id = $1
                "#,
            )
            .bind(body.record_id)
            .bind(error_code)
            .execute(&state.db)
            .await?;

            let exception_id = corecard::upsert_exception(
                &state.db,
                Some(body.record_id),
                record.linked_corecredit_account_id.as_deref(),
                exception_type,
                "high",
                Some("E2E seeded RMS exception"),
                &json!({
                    "seeded": true,
                    "source": "e2e",
                    "retryable": true,
                    "record_kind": record.record_kind,
                    "external_transaction_type": record.external_transaction_type,
                }),
            )
            .await
            .map_err(|error| TestSupportError::BadRequest(error.to_string()))?;

            Ok(Json(PrepareRecordResponse {
                record_id: body.record_id,
                status: match body.mode {
                    PrepareRecordMode::RetryableException => "retryable_exception_ready",
                    _ => "failed_exception_ready",
                }
                .to_string(),
                exception_id: Some(exception_id.id),
                reconciliation_run_id: None,
            }))
        }
        PrepareRecordMode::PendingWebhook => {
            sqlx::query(
                r#"
                UPDATE pos_rms_charge_record
                SET
                    posting_status = 'pending',
                    external_transaction_id = COALESCE(external_transaction_id, $2),
                    host_reference = COALESCE(host_reference, $3),
                    metadata_json = jsonb_set(
                        jsonb_set(
                            jsonb_set(COALESCE(metadata_json, '{}'::jsonb), '{posting_status}', to_jsonb('pending'::text), true),
                            '{external_transaction_id}', to_jsonb($2::text), true
                        ),
                        '{host_reference}', to_jsonb($3::text), true
                    )
                WHERE id = $1
                "#,
            )
            .bind(body.record_id)
            .bind(format!("PENDING-{}", body.record_id))
            .bind(format!("HOST-PENDING-{}", &body.record_id.to_string()[..8]))
            .execute(&state.db)
            .await?;

            Ok(Json(PrepareRecordResponse {
                record_id: body.record_id,
                status: "pending_webhook_ready".to_string(),
                exception_id: None,
                reconciliation_run_id: None,
            }))
        }
        PrepareRecordMode::ReconciliationMismatch => {
            if record.linked_corecredit_account_id.is_none() {
                tracing::warn!(record_id = %body.record_id, "reconciliation mismatch requested without linked account");
                return Err(TestSupportError::Internal {
                    code: "missing_linked_account",
                    message: "Cannot seed reconciliation mismatch without a linked account"
                        .to_string(),
                    details: json!({
                        "record_id": body.record_id,
                        "record_kind": record.record_kind,
                    }),
                });
            }
            let run_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO corecredit_reconciliation_run (
                    run_scope, started_at, completed_at, status, requested_by_staff_id, date_from, date_to, summary_json
                )
                VALUES ('manual_e2e', now(), now(), 'completed', $1, CURRENT_DATE, CURRENT_DATE, '{"mismatch_count":1,"retryable_count":1}'::jsonb)
                RETURNING id
                "#,
            )
            .bind(staff.id)
            .fetch_one(&state.db)
            .await?;

            sqlx::query(
                r#"
                INSERT INTO corecredit_reconciliation_item (
                    run_id, rms_record_id, account_id, mismatch_type, severity, status, riverside_value_json, host_value_json, qbo_value_json, notes
                )
                VALUES ($1, $2, $3, 'posting_status_mismatch', 'high', 'open', $4, $5, $6, 'E2E seeded mismatch')
                "#,
            )
            .bind(run_id)
            .bind(body.record_id)
            .bind(record.linked_corecredit_account_id.clone())
            .bind(json!({
                "posting_status": record.posting_status,
                "host_reference": record.host_reference,
            }))
            .bind(json!({
                "posting_status": "posted",
                "host_reference": "E2E-HOST-MISMATCH",
            }))
            .bind(json!({
                    "expected_clearing_account": if record.record_kind == "payment" {
                        "RMS_R2S_PAYMENT_CLEARING"
                    } else {
                        "RMS_CHARGE_FINANCING_CLEARING"
                    },
                    "payment_method": record.payment_method,
                }))
            .execute(&state.db)
            .await?;

            Ok(Json(PrepareRecordResponse {
                record_id: body.record_id,
                status: "reconciliation_mismatch_ready".to_string(),
                exception_id: None,
                reconciliation_run_id: Some(run_id),
            }))
        }
    }
}

async fn get_transaction_artifacts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transaction_id): Path<Uuid>,
) -> Result<Json<TestSupportTransactionArtifacts>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;
    let (
        transaction_display_id,
        total_price,
        amount_paid,
        balance_due,
        rounding_adjustment,
        metadata,
    ) = sqlx::query_as::<
        _,
        (
            String,
            rust_decimal::Decimal,
            rust_decimal::Decimal,
            rust_decimal::Decimal,
            rust_decimal::Decimal,
            Value,
        ),
    >(
        r#"
        SELECT
            display_id,
            COALESCE(total_price, 0)::numeric(14, 2),
            COALESCE(amount_paid, 0)::numeric(14, 2),
            COALESCE(balance_due, 0)::numeric(14, 2),
            COALESCE(rounding_adjustment, 0)::numeric(14, 2),
            COALESCE(metadata, '{}'::jsonb)
        FROM transactions
        WHERE id = $1
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&state.db)
    .await?;

    let payment_rows = sqlx::query_as::<_, (String, Option<String>, Value)>(
        r#"
        SELECT DISTINCT pt.payment_method, pt.check_number, COALESCE(pt.metadata, '{}'::jsonb)
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
        ORDER BY pt.payment_method
        "#,
    )
    .bind(transaction_id)
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .map(
        |(payment_method, check_number, metadata)| TestSupportPaymentRow {
            payment_method,
            check_number,
            metadata,
        },
    )
    .collect();

    let allocation_rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            Option<String>,
            rust_decimal::Decimal,
            String,
            rust_decimal::Decimal,
            Option<String>,
            Option<String>,
            Value,
        ),
    >(
        r#"
        WITH related_payment_tx AS (
            SELECT DISTINCT transaction_id
            FROM payment_allocations
            WHERE target_transaction_id = $1
        )
        SELECT
            pa.transaction_id AS payment_transaction_id,
            pa.target_transaction_id,
            target.display_id AS target_display_id,
            COALESCE(pa.amount_allocated, 0)::numeric(14, 2) AS amount_allocated,
            pt.payment_method,
            COALESCE(pt.amount, 0)::numeric(14, 2) AS payment_amount,
            pt.check_number AS payment_check_number,
            pa.check_number AS allocation_check_number,
            COALESCE(pa.metadata, '{}'::jsonb) AS allocation_metadata
        FROM payment_allocations pa
        INNER JOIN related_payment_tx rpt ON rpt.transaction_id = pa.transaction_id
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        LEFT JOIN transactions target ON target.id = pa.target_transaction_id
        ORDER BY pt.created_at ASC, pt.id ASC, target.display_id ASC, pa.amount_allocated ASC
        "#,
    )
    .bind(transaction_id)
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .map(
        |(
            payment_transaction_id,
            target_transaction_id,
            target_display_id,
            amount_allocated,
            payment_method,
            payment_amount,
            payment_check_number,
            allocation_check_number,
            allocation_metadata,
        )| TestSupportPaymentAllocationRow {
            payment_transaction_id,
            target_transaction_id,
            target_display_id,
            amount_allocated: amount_allocated.to_string(),
            payment_method,
            payment_amount: payment_amount.to_string(),
            payment_check_number,
            allocation_check_number,
            allocation_metadata,
        },
    )
    .collect();

    let record_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM pos_rms_charge_record WHERE transaction_id = $1 ORDER BY created_at ASC",
    )
    .bind(transaction_id)
    .fetch_all(&state.db)
    .await?;

    let mut rms_records = Vec::new();
    for record_id in record_ids {
        rms_records.push(
            corecard::get_rms_charge_record_detail(&state.db, record_id)
                .await
                .map_err(|error| TestSupportError::BadRequest(error.to_string()))?,
        );
    }

    Ok(Json(TestSupportTransactionArtifacts {
        transaction_id,
        transaction_display_id,
        total_price: total_price.to_string(),
        amount_paid: amount_paid.to_string(),
        balance_due: balance_due.to_string(),
        rounding_adjustment: rounding_adjustment.to_string(),
        metadata,
        payment_rows,
        allocation_rows,
        rms_records,
    }))
}

async fn get_alteration_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(alteration_id): Path<Uuid>,
) -> Result<Json<Vec<TestSupportAlterationActivityRow>>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;
    let rows = sqlx::query_as::<_, (String, Option<Uuid>, Value)>(
        r#"
        SELECT action, staff_id, detail
        FROM alteration_activity
        WHERE alteration_id = $1
        ORDER BY created_at ASC
        "#,
    )
    .bind(alteration_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(
                |(action, staff_id, detail)| TestSupportAlterationActivityRow {
                    action,
                    staff_id,
                    detail,
                },
            )
            .collect(),
    ))
}

async fn post_seed_qbo_tax_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SeedQboTaxMappingRequest>,
) -> Result<Json<Value>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;

    sqlx::query(
        r#"
        INSERT INTO qbo_accounts_cache (id, name, account_type, account_number, is_active)
        VALUES
            ('E2E_CASH', 'E2E Cash Clearing', 'Bank', 'E2E-1000', true),
            ('E2E_REVENUE', 'E2E Sales Revenue', 'Income', 'E2E-4000', true),
            ('E2E_SALES_TAX', 'E2E Sales Tax Payable', 'Other Current Liability', 'E2E-2100', true),
            ('E2E_CASH_ROUNDING', 'E2E Cash Rounding', 'Income', 'E2E-4090', true),
            ('E2E_DEPOSIT_LIABILITY', 'E2E Customer Deposit Liability', 'Other Current Liability', 'E2E-2200', true),
            ('E2E_FORFEITED_DEPOSIT', 'E2E Forfeited Deposit Income', 'Income', 'E2E-4050', true)
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            account_type = EXCLUDED.account_type,
            account_number = EXCLUDED.account_number,
            is_active = true,
            refreshed_at = CURRENT_TIMESTAMP
        "#,
    )
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO qbo_mappings (source_type, source_id, qbo_account_id, qbo_account_name, updated_at)
        VALUES
            ('tender', 'cash', 'E2E_CASH', 'E2E Cash Clearing', CURRENT_TIMESTAMP),
            ('category_revenue', $1, 'E2E_REVENUE', 'E2E Sales Revenue', CURRENT_TIMESTAMP),
            ('tax', 'SALES_TAX', 'E2E_SALES_TAX', 'E2E Sales Tax Payable', CURRENT_TIMESTAMP),
            ('liability_deposit', 'default', 'E2E_DEPOSIT_LIABILITY', 'E2E Customer Deposit Liability', CURRENT_TIMESTAMP),
            ('income_forfeited_deposit', 'default', 'E2E_FORFEITED_DEPOSIT', 'E2E Forfeited Deposit Income', CURRENT_TIMESTAMP)
        ON CONFLICT (source_type, source_id) DO UPDATE
        SET qbo_account_id = EXCLUDED.qbo_account_id,
            qbo_account_name = EXCLUDED.qbo_account_name,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(payload.category_id.to_string())
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO ledger_mappings (internal_key, internal_description, qbo_account_id, updated_at)
        VALUES ('CASH_ROUNDING', 'E2E cash rounding adjustments', 'E2E_CASH_ROUNDING', CURRENT_TIMESTAMP)
        ON CONFLICT (internal_key) DO UPDATE
        SET internal_description = EXCLUDED.internal_description,
            qbo_account_id = EXCLUDED.qbo_account_id,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .execute(&state.db)
    .await?;

    sqlx::query("DELETE FROM qbo_sync_logs WHERE sync_date = $1 AND status = 'pending'")
        .bind(payload.activity_date)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({
        "ok": true,
        "category_id": payload.category_id,
        "activity_date": payload.activity_date
    })))
}

async fn post_assign_qbo_transaction_date(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AssignQboTransactionDateRequest>,
) -> Result<Json<Value>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;
    let timestamp = payload
        .activity_date
        .and_hms_opt(15, 0, 0)
        .ok_or_else(|| TestSupportError::BadRequest("invalid activity_date".to_string()))?
        .and_utc();

    let mut tx = state.db.begin().await?;

    let updated_orders = sqlx::query(
        r#"
        UPDATE transactions
        SET booked_at = $2,
            fulfilled_at = CASE WHEN fulfilled_at IS NOT NULL THEN $2 ELSE fulfilled_at END
        WHERE id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated_orders == 0 {
        return Err(TestSupportError::BadRequest(
            "transaction_id not found".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE transaction_lines
        SET fulfilled_at = CASE WHEN is_fulfilled THEN $2 ELSE fulfilled_at END
        WHERE transaction_id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE payment_transactions pt
        SET created_at = $2
        WHERE pt.metadata->>'checkout_transaction_id' = $1::text
           OR EXISTS (
              SELECT 1
              FROM payment_allocations pa
              WHERE pa.transaction_id = pt.id
                AND pa.target_transaction_id = $1
           )
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "ok": true,
        "transaction_id": payload.transaction_id,
        "activity_date": payload.activity_date
    })))
}

async fn post_assign_qbo_transaction_timestamp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AssignQboTransactionTimestampRequest>,
) -> Result<Json<Value>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;
    let timestamp = payload.timestamp_utc;

    let mut tx = state.db.begin().await?;

    let updated_orders = sqlx::query(
        r#"
        UPDATE transactions
        SET booked_at = $2,
            fulfilled_at = CASE WHEN fulfilled_at IS NOT NULL THEN $2 ELSE fulfilled_at END
        WHERE id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated_orders == 0 {
        return Err(TestSupportError::BadRequest(
            "transaction_id not found".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE transaction_lines
        SET fulfilled_at = CASE WHEN is_fulfilled THEN $2 ELSE fulfilled_at END
        WHERE transaction_id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE payment_transactions pt
        SET created_at = $2
        WHERE pt.metadata->>'checkout_transaction_id' = $1::text
           OR EXISTS (
              SELECT 1
              FROM payment_allocations pa
              WHERE pa.transaction_id = pt.id
                AND pa.target_transaction_id = $1
           )
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "ok": true,
        "transaction_id": payload.transaction_id,
        "timestamp_utc": timestamp
    })))
}

async fn post_assign_qbo_transaction_fulfillment_timestamp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AssignQboTransactionFulfillmentTimestampRequest>,
) -> Result<Json<Value>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;
    let timestamp = payload.timestamp_utc;

    let mut tx = state.db.begin().await?;

    let updated = sqlx::query(
        r#"
        UPDATE transactions
        SET fulfilled_at = $2
        WHERE id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        return Err(TestSupportError::BadRequest(
            "transaction_id not found".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE transaction_lines
        SET fulfilled_at = $2
        WHERE transaction_id = $1
          AND is_fulfilled = TRUE
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "ok": true,
        "transaction_id": payload.transaction_id,
        "timestamp_utc": timestamp
    })))
}

async fn post_assign_qbo_transaction_forfeiture_timestamp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AssignQboTransactionForfeitureTimestampRequest>,
) -> Result<Json<Value>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;
    let timestamp = payload.timestamp_utc;

    let updated = sqlx::query(
        r#"
        UPDATE transactions
        SET forfeited_at = $2
        WHERE id = $1
          AND is_forfeited = TRUE
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&state.db)
    .await?
    .rows_affected();
    if updated == 0 {
        return Err(TestSupportError::BadRequest(
            "forfeited transaction_id not found".to_string(),
        ));
    }

    Ok(Json(json!({
        "ok": true,
        "transaction_id": payload.transaction_id,
        "timestamp_utc": timestamp
    })))
}

async fn post_assign_qbo_shipping_recognition(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AssignQboShippingRecognitionRequest>,
) -> Result<Json<Value>, TestSupportError> {
    let staff = require_admin_staff(&state, &headers).await?;
    let timestamp = payload.label_purchased_at_utc;

    let mut tx = state.db.begin().await?;

    let updated_orders = sqlx::query(
        r#"
        UPDATE transactions
        SET booked_at = $2,
            fulfillment_method = 'ship'::order_fulfillment_method,
            fulfilled_at = NULL
        WHERE id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated_orders == 0 {
        return Err(TestSupportError::BadRequest(
            "transaction_id not found".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE transaction_lines
        SET fulfilled_at = NULL
        WHERE transaction_id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE payment_transactions pt
        SET created_at = $2
        FROM payment_allocations pa
        WHERE pa.transaction_id = pt.id
          AND pa.target_transaction_id = $1
        "#,
    )
    .bind(payload.transaction_id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM shipment WHERE transaction_id = $1")
        .bind(payload.transaction_id)
        .execute(&mut *tx)
        .await?;

    let shipment_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO shipment (
            source, transaction_id, created_by_staff_id, status, ship_to, created_at, updated_at
        )
        VALUES (
            'pos_order'::shipment_source,
            $1,
            $2,
            'label_purchased'::shipment_status,
            '{}'::jsonb,
            $3,
            $3
        )
        RETURNING id
        "#,
    )
    .bind(payload.transaction_id)
    .bind(staff.id)
    .bind(timestamp)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO shipment_event (shipment_id, at, kind, message, metadata, staff_id)
        VALUES (
            $1,
            $2,
            'label_purchased',
            'E2E shipping recognition marker for QBO audit.',
            jsonb_build_object('transaction_id', $3::text, 'source', 'qbo_audit_contract'),
            $4
        )
        "#,
    )
    .bind(shipment_id)
    .bind(timestamp)
    .bind(payload.transaction_id)
    .bind(staff.id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "ok": true,
        "transaction_id": payload.transaction_id,
        "shipment_id": shipment_id,
        "label_purchased_at_utc": timestamp
    })))
}

async fn post_seed_shipping_quote(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SeedShippingQuoteRequest>,
) -> Result<Json<Value>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;
    if payload.amount_usd < rust_decimal::Decimal::ZERO {
        return Err(TestSupportError::BadRequest(
            "amount_usd must be non-negative".to_string(),
        ));
    }

    let quote_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO store_shipping_rate_quote (
            expires_at, amount_usd, carrier, service_name, shippo_rate_object_id, metadata
        )
        VALUES (
            NOW() + INTERVAL '30 minutes',
            $1,
            'E2E Carrier',
            'Tax Audit Ground',
            'e2e_tax_shipping_rate',
            jsonb_build_object(
                'stub', true,
                'ship_to', jsonb_build_object(
                    'name', 'Tax Audit Customer',
                    'street1', '1 Main St',
                    'city', 'Buffalo',
                    'state', 'NY',
                    'zip', '14202',
                    'country', 'US'
                )
            )
        )
        RETURNING id
        "#,
    )
    .bind(payload.amount_usd)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "quote_id": quote_id,
        "amount_usd": payload.amount_usd
    })))
}

async fn get_parked_sale_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(parked_sale_id): Path<Uuid>,
) -> Result<Json<TestSupportParkedSaleStatus>, TestSupportError> {
    let _staff = require_admin_staff(&state, &headers).await?;

    let (id, register_session_id, status) = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        r#"
        SELECT id, register_session_id, status::text
        FROM pos_parked_sale
        WHERE id = $1
        "#,
    )
    .bind(parked_sale_id)
    .fetch_one(&state.db)
    .await?;

    let audit_actions = sqlx::query_scalar::<_, String>(
        r#"
        SELECT action
        FROM pos_parked_sale_audit
        WHERE parked_sale_id = $1
        ORDER BY created_at ASC
        "#,
    )
    .bind(parked_sale_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(TestSupportParkedSaleStatus {
        id,
        register_session_id,
        status,
        audit_actions,
    }))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rms/seed-fixture", post(post_seed_fixture))
        .route("/rms/prepare-record", post(post_prepare_record))
        .route(
            "/rms/transaction/{transaction_id}",
            get(get_transaction_artifacts),
        )
        .route(
            "/alterations/{alteration_id}/activity",
            get(get_alteration_activity),
        )
        .route("/qbo/seed-tax-mapping", post(post_seed_qbo_tax_mapping))
        .route(
            "/qbo/assign-transaction-date",
            post(post_assign_qbo_transaction_date),
        )
        .route(
            "/qbo/assign-transaction-timestamp",
            post(post_assign_qbo_transaction_timestamp),
        )
        .route(
            "/qbo/assign-transaction-fulfillment-timestamp",
            post(post_assign_qbo_transaction_fulfillment_timestamp),
        )
        .route(
            "/qbo/assign-transaction-forfeiture-timestamp",
            post(post_assign_qbo_transaction_forfeiture_timestamp),
        )
        .route(
            "/qbo/assign-shipping-recognition",
            post(post_assign_qbo_shipping_recognition),
        )
        .route("/shipping/seed-quote", post(post_seed_shipping_quote))
        .route(
            "/parked-sales/{parked_sale_id}",
            get(get_parked_sale_status),
        )
}
