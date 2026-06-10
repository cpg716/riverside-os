use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub const REVIEW_PACK_SCHEMA: &str = "riverside_counterpoint_review_pack";
pub const REVIEW_RESULTS_SCHEMA: &str = "riverside_counterpoint_review_results";
pub const REVIEW_PACK_SCHEMA_VERSION: i32 = 1;

const INVENTORY_CATALOG: &str = "inventory_catalog";
const CUSTOMER_DEDUPE: &str = "customer_dedupe";
const TICKET_FINANCIAL: &str = "ticket_financial";
const TENDER_MAPPING: &str = "tender_mapping";
const GIFT_CARD_LIABILITY: &str = "gift_card_liability";
const OPEN_ORDERS_LAYAWAYS: &str = "open_orders_layaways";
const RETURNS_READINESS: &str = "returns_readiness";
const CUTOVER_AUDIT: &str = "cutover_audit";

const INVENTORY_ACTIONS: &[&str] = &[
    "suggest_product_name",
    "suggest_display_name",
    "suggest_category",
    "flag_possible_duplicate_item",
    "flag_possible_variant_group",
    "flag_needs_human_review",
    "suggest_web_description",
];
const CUSTOMER_ACTIONS: &[&str] = &[
    "flag_possible_duplicate_customer",
    "suggest_primary_customer",
    "flag_needs_human_review",
];
const TICKET_ACTIONS: &[&str] = &[
    "flag_total_mismatch",
    "flag_unmapped_tender",
    "flag_possible_refund_ticket",
    "flag_negative_line_review",
    "flag_missing_customer_link",
    "flag_needs_human_review",
];
const TENDER_ACTIONS: &[&str] = &[
    "suggest_tender_mapping",
    "flag_unknown_tender",
    "flag_needs_human_review",
];
const GIFT_CARD_ACTIONS: &[&str] = &[
    "flag_suspicious_balance",
    "flag_duplicate_card_candidate",
    "flag_missing_customer_link",
    "flag_needs_human_review",
];
const OPEN_DOC_ACTIONS: &[&str] = &[
    "flag_unresolved_open_doc",
    "flag_deposit_mismatch",
    "flag_missing_customer_link",
    "flag_needs_human_review",
];
const RETURNS_ACTIONS: &[&str] = &[
    "flag_unresolved_legacy_item",
    "suggest_legacy_item_resolution",
    "flag_non_returnable_history_line",
    "flag_missing_original_tender",
    "flag_needs_human_review",
];
const CUTOVER_ACTIONS: &[&str] = &[
    "flag_blocker",
    "flag_warning",
    "flag_ready_check_needed",
    "flag_needs_human_review",
];

const FORBIDDEN_FIELDS: &[&str] = &[
    "historical_ticket_total",
    "line_subtotal",
    "discount_amount",
    "tax_amount",
    "tender_payment_amount",
    "gift_card_balance",
    "store_credit_balance",
    "customer_balance",
    "deposit_amount",
    "quantity_on_hand",
    "inventory_unit_cost",
    "freight_cost",
    "cogs",
    "booked_at",
    "business_date",
    "fulfilled_at",
    "original_counterpoint_ticket_number",
    "original_counterpoint_item_key",
    "original_counterpoint_customer_code",
    "original_payment_tender_transaction_ids",
    "qbo_accounting_mapping",
];

#[derive(Debug, Error)]
pub enum ReviewPackError {
    #[error("invalid review pack payload: {0}")]
    InvalidPayload(String),
    #[error("review pack not found: {0}")]
    NotFound(String),
    #[error("unsafe review pack apply blocked: {0}")]
    UnsafeApply(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Serialize)]
pub struct ReviewPackScopeInfo {
    pub scope: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub fully_functional: bool,
    pub apply_supported: bool,
    pub allowed_actions: &'static [&'static str],
}

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
pub struct ReviewPackSummary {
    pub id: Uuid,
    pub pack_id: String,
    pub scope: String,
    pub schema_version: i32,
    pub source_hash: String,
    pub generated_by_staff_id: Option<Uuid>,
    pub generated_at: DateTime<Utc>,
    pub row_count: i32,
    pub status: String,
    pub metadata: Value,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReviewPackRowSummary {
    pub id: Uuid,
    pub row_key: String,
    pub entity_type: String,
    pub entity_ref: Option<String>,
    pub source_hash: String,
    pub created_at: DateTime<Utc>,
    pub detected_issues: Value,
}

#[derive(Debug, Serialize)]
pub struct ReviewPackDetail {
    pub pack: ReviewPackSummary,
    pub rows: Vec<ReviewPackRowSummary>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReviewSuggestionSummary {
    pub id: Uuid,
    pub import_id: Uuid,
    pub pack_id: Uuid,
    pub row_id: Option<Uuid>,
    pub row_key: String,
    pub scope: String,
    pub action: String,
    pub field_name: Option<String>,
    pub current_value: Option<Value>,
    pub suggested_value: Option<Value>,
    pub confidence: Option<Decimal>,
    pub reason: String,
    pub status: String,
    pub validation_errors: Value,
    pub reviewed_by_staff_id: Option<Uuid>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub applied_by_staff_id: Option<Uuid>,
    pub applied_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct GenerateReviewPackPayload {
    pub scope: String,
    pub limit: Option<i64>,
    pub issue_filter: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ImportedSuggestionPayload {
    pub row_key: String,
    pub scope: String,
    pub action: String,
    pub field_name: Option<String>,
    pub current_value: Option<Value>,
    pub suggested_value: Option<Value>,
    pub confidence: Option<Decimal>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ImportReviewResultsPayload {
    pub schema: String,
    pub schema_version: i32,
    pub source_pack_id: String,
    pub source_hash: String,
    pub provider_label: Option<String>,
    pub imported_file_name: Option<String>,
    pub suggestions: Vec<ImportedSuggestionPayload>,
}

#[derive(Debug, Serialize)]
pub struct ImportReviewResultsResponse {
    pub import_id: String,
    pub source_pack_id: String,
    pub stored_suggestions: usize,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct ReviewSuggestionUpdatePayload {
    pub status: String,
    pub field_name: Option<String>,
    pub suggested_value: Option<Value>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApplyApprovedResponse {
    pub pack_id: String,
    pub applied: usize,
    pub blocked: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Debug)]
struct PackRowDraft {
    row_key: String,
    entity_type: String,
    entity_ref: Option<String>,
    payload: Value,
    source_hash: String,
}

#[derive(Debug)]
struct RowValidationContext {
    row_key: String,
    scope: String,
    allowed_actions: Vec<String>,
    forbidden_fields: Vec<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct InventoryCatalogSourceRow {
    product_id: Uuid,
    catalog_handle: Option<String>,
    product_name: String,
    description: Option<String>,
    category_id: Option<Uuid>,
    category_name: Option<String>,
    variant_count: i64,
    sample_sku: Option<String>,
    sample_barcode: Option<String>,
    sample_counterpoint_item_key: Option<String>,
    counterpoint_description: Option<String>,
    counterpoint_long_description: Option<String>,
    counterpoint_category_code: Option<String>,
    lightspeed_name: Option<String>,
    lightspeed_category: Option<String>,
    quarantine_count: i64,
    duplicate_name_count: i64,
    sku_gap_count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct TicketFinancialSourceRow {
    transaction_id: Uuid,
    ticket_ref: String,
    booked_at: DateTime<Utc>,
    business_date: Option<NaiveDate>,
    customer_id: Option<Uuid>,
    status: String,
    processed_by_staff_id: Option<Uuid>,
    primary_salesperson_id: Option<Uuid>,
    total_price: Decimal,
    amount_paid: Decimal,
    balance_due: Decimal,
    line_total: Decimal,
    payment_total: Decimal,
    line_count: i64,
    payment_count: i64,
    unmapped_tender_count: i64,
    negative_line_count: i64,
    gift_card_payment_count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct ReturnsReadinessSourceRow {
    line_id: Uuid,
    transaction_id: Uuid,
    ticket_ref: String,
    booked_at: DateTime<Utc>,
    business_date: Option<NaiveDate>,
    customer_id: Option<Uuid>,
    product_id: Option<Uuid>,
    variant_id: Option<Uuid>,
    sku: Option<String>,
    barcode: Option<String>,
    counterpoint_item_key: Option<String>,
    vendor_reference: Option<String>,
    counterpoint_description: Option<String>,
    counterpoint_line_sequence: Option<String>,
    quantity_purchased: i32,
    unit_price: Decimal,
    tax_total: Decimal,
    discount_amount: Decimal,
    quantity_returned: i64,
    tender_summary: Value,
}

pub fn supported_scopes() -> Vec<ReviewPackScopeInfo> {
    vec![
        ReviewPackScopeInfo {
            scope: INVENTORY_CATALOG,
            label: "Inventory Catalog",
            description: "Product names, categories, duplicate-item flags, variant grouping flags, and catalog readability.",
            fully_functional: true,
            apply_supported: true,
            allowed_actions: INVENTORY_ACTIONS,
        },
        ReviewPackScopeInfo {
            scope: CUSTOMER_DEDUPE,
            label: "Customer Dedupe",
            description: "Customer duplicate candidates and primary-profile suggestions. First pass is review-only.",
            fully_functional: false,
            apply_supported: false,
            allowed_actions: CUSTOMER_ACTIONS,
        },
        ReviewPackScopeInfo {
            scope: TICKET_FINANCIAL,
            label: "Ticket Financial",
            description: "Historical ticket reconciliation flags. Financial values are immutable and review-only.",
            fully_functional: true,
            apply_supported: false,
            allowed_actions: TICKET_ACTIONS,
        },
        ReviewPackScopeInfo {
            scope: TENDER_MAPPING,
            label: "Tender Mapping",
            description: "Counterpoint payment method mapping review. First pass is review-only.",
            fully_functional: false,
            apply_supported: false,
            allowed_actions: TENDER_ACTIONS,
        },
        ReviewPackScopeInfo {
            scope: GIFT_CARD_LIABILITY,
            label: "Gift Card Liability",
            description: "Gift card balance and ownership review flags. Liability values are immutable and review-only.",
            fully_functional: false,
            apply_supported: false,
            allowed_actions: GIFT_CARD_ACTIONS,
        },
        ReviewPackScopeInfo {
            scope: OPEN_ORDERS_LAYAWAYS,
            label: "Open Orders & Layaways",
            description: "Imported open document and layaway readiness checks. First pass is review-only.",
            fully_functional: false,
            apply_supported: false,
            allowed_actions: OPEN_DOC_ACTIONS,
        },
        ReviewPackScopeInfo {
            scope: RETURNS_READINESS,
            label: "Returns Readiness",
            description: "Historical Counterpoint purchase lines used to find and validate return/exchange candidates.",
            fully_functional: true,
            apply_supported: false,
            allowed_actions: RETURNS_ACTIONS,
        },
        ReviewPackScopeInfo {
            scope: CUTOVER_AUDIT,
            label: "Cutover Audit",
            description: "Final migration blocker/warning readiness checks. First pass is review-only.",
            fully_functional: false,
            apply_supported: false,
            allowed_actions: CUTOVER_ACTIONS,
        },
    ]
}

pub async fn generate_review_pack(
    pool: &PgPool,
    payload: GenerateReviewPackPayload,
    generated_by_staff_id: Option<Uuid>,
) -> Result<ReviewPackSummary, ReviewPackError> {
    let scope = normalize_scope(&payload.scope)?;
    let limit = payload.limit.unwrap_or(500).clamp(1, 1000);
    let issue_filter = payload
        .issue_filter
        .as_deref()
        .unwrap_or("all")
        .trim()
        .to_ascii_lowercase();

    let rows = match scope {
        INVENTORY_CATALOG => build_inventory_catalog_rows(pool, limit, &issue_filter).await?,
        TICKET_FINANCIAL => build_ticket_financial_rows(pool, limit, &issue_filter).await?,
        RETURNS_READINESS => build_returns_readiness_rows(pool, limit, &issue_filter).await?,
        CUSTOMER_DEDUPE | TENDER_MAPPING | GIFT_CARD_LIABILITY | OPEN_ORDERS_LAYAWAYS
        | CUTOVER_AUDIT => build_scaffold_scope_rows(pool, scope, &issue_filter).await?,
        _ => {
            return Err(ReviewPackError::InvalidPayload(format!(
                "unknown scope {scope}"
            )))
        }
    };

    let pack_id = Uuid::new_v4().to_string();
    let source_hash = hash_json(&json!({
        "scope": scope,
        "schema_version": REVIEW_PACK_SCHEMA_VERSION,
        "rows": rows.iter().map(|r| &r.payload).collect::<Vec<_>>()
    }))?;
    let metadata = json!({
        "issue_filter": issue_filter,
        "limit": limit,
        "manual_review_only": true,
        "runtime_ai_calls": false,
        "safe_apply_supported": scope == INVENTORY_CATALOG
    });

    let mut tx = pool.begin().await?;
    let pack: ReviewPackSummary = sqlx::query_as(
        r#"
        INSERT INTO counterpoint_review_packs (
            pack_id, scope, schema_version, source_hash, generated_by_staff_id,
            row_count, status, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'generated', $7)
        RETURNING
            id, pack_id, scope, schema_version, source_hash, generated_by_staff_id,
            generated_at, row_count, status, metadata
        "#,
    )
    .bind(&pack_id)
    .bind(scope)
    .bind(REVIEW_PACK_SCHEMA_VERSION)
    .bind(&source_hash)
    .bind(generated_by_staff_id)
    .bind(rows.len() as i32)
    .bind(metadata)
    .fetch_one(&mut *tx)
    .await?;

    for row in rows {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_review_pack_rows (
                pack_id, row_key, entity_type, entity_ref, payload, source_hash
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(pack.id)
        .bind(row.row_key)
        .bind(row.entity_type)
        .bind(row.entity_ref)
        .bind(row.payload)
        .bind(row.source_hash)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(pack)
}

pub async fn list_review_packs(pool: &PgPool) -> Result<Vec<ReviewPackSummary>, ReviewPackError> {
    sqlx::query_as(
        r#"
        SELECT
            id, pack_id, scope, schema_version, source_hash, generated_by_staff_id,
            generated_at, row_count, status, metadata
        FROM counterpoint_review_packs
        ORDER BY generated_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(ReviewPackError::Database)
}

pub async fn get_review_pack_detail(
    pool: &PgPool,
    external_pack_id: &str,
) -> Result<ReviewPackDetail, ReviewPackError> {
    let pack = get_review_pack(pool, external_pack_id).await?;
    let rows: Vec<ReviewPackRowSummary> = sqlx::query_as(
        r#"
        SELECT
            id,
            row_key,
            entity_type,
            entity_ref,
            source_hash,
            created_at,
            COALESCE(payload->'detected_issues', '[]'::jsonb) AS detected_issues
        FROM counterpoint_review_pack_rows
        WHERE pack_id = $1
        ORDER BY created_at, row_key
        LIMIT 200
        "#,
    )
    .bind(pack.id)
    .fetch_all(pool)
    .await?;

    Ok(ReviewPackDetail { pack, rows })
}

pub async fn build_review_pack_document(
    pool: &PgPool,
    external_pack_id: &str,
) -> Result<Value, ReviewPackError> {
    let pack = get_review_pack(pool, external_pack_id).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        r#"
        SELECT payload
        FROM counterpoint_review_pack_rows
        WHERE pack_id = $1
        ORDER BY created_at, row_key
        "#,
    )
    .bind(pack.id)
    .fetch_all(pool)
    .await?;

    Ok(review_pack_document_value(
        &pack.pack_id,
        &pack.scope,
        pack.generated_at,
        &pack.source_hash,
        rows,
    ))
}

pub async fn build_review_pack_prompt(
    pool: &PgPool,
    external_pack_id: &str,
) -> Result<String, ReviewPackError> {
    let pack = get_review_pack(pool, external_pack_id).await?;
    let actions = allowed_actions_for_scope(&pack.scope).unwrap_or(&[]);
    Ok(format!(
        "You are reviewing a Riverside OS Counterpoint transition review pack.\n\nPack ID: {}\nScope: {}\nSource hash: {}\n\nReturn only valid JSON matching the result_schema in the attached file. Do not invent rows. Do not change financial totals, tax, tender amounts, gift card balances, store credit balances, customer balances, quantities, costs, dates, original Counterpoint IDs, original ticket numbers, original customer codes, or accounting mappings. Only suggest actions listed in allowed_actions for each row. Every suggestion must include row_key, scope, action, confidence, reason, and suggested_value when applicable. If uncertain, use flag_needs_human_review. Base every suggestion only on source_evidence in the pack.\n\nAllowed actions for this scope: {}\n\nThe exported file may contain Riverside OS business/customer migration data. Handle it as confidential store data and return only the JSON result body.",
        pack.pack_id,
        pack.scope,
        pack.source_hash,
        actions.join(", ")
    ))
}

pub async fn import_review_results(
    pool: &PgPool,
    payload: ImportReviewResultsPayload,
    imported_by_staff_id: Option<Uuid>,
) -> Result<ImportReviewResultsResponse, ReviewPackError> {
    let source_pack_id = payload.source_pack_id.trim().to_string();
    let pack = get_review_pack(pool, &source_pack_id).await?;

    let mut errors = Vec::new();
    if payload.schema.trim() != REVIEW_RESULTS_SCHEMA {
        errors.push("schema must be riverside_counterpoint_review_results".to_string());
    }
    if payload.schema_version != REVIEW_PACK_SCHEMA_VERSION {
        errors.push(format!(
            "schema_version must be {}",
            REVIEW_PACK_SCHEMA_VERSION
        ));
    }
    if payload.source_hash.trim() != pack.source_hash {
        errors.push("source_hash does not match the generated review pack".to_string());
    }

    let row_contexts = load_row_validation_contexts(pool, pack.id).await?;
    if payload.suggestions.is_empty() {
        errors.push("suggestions must contain at least one item".to_string());
    }

    for (idx, suggestion) in payload.suggestions.iter().enumerate() {
        let row_ctx = row_contexts.get(suggestion.row_key.trim());
        let error_count_before = errors.len();
        errors.extend(validate_suggestion_basic(
            suggestion,
            row_ctx,
            &pack.scope,
            idx + 1,
        ));
        if errors.len() == error_count_before {
            if let Err(err) = validate_suggestion_references(pool, suggestion).await {
                errors.push(format!("suggestion {}: {err}", idx + 1));
            }
        }
    }

    if !errors.is_empty() {
        insert_import_audit(
            pool,
            &pack,
            imported_by_staff_id,
            &payload,
            "rejected",
            &errors,
        )
        .await?;
        return Err(ReviewPackError::InvalidPayload(errors.join("; ")));
    }

    let import_uuid =
        insert_import_audit(pool, &pack, imported_by_staff_id, &payload, "stored", &[]).await?;
    let import_id = Uuid::new_v4().to_string();

    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE counterpoint_ai_review_imports SET import_id = $1 WHERE id = $2")
        .bind(&import_id)
        .bind(import_uuid)
        .execute(&mut *tx)
        .await?;

    for suggestion in &payload.suggestions {
        let row = row_contexts
            .get(suggestion.row_key.trim())
            .ok_or_else(|| ReviewPackError::InvalidPayload("row_key not found".to_string()))?;
        let row_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM counterpoint_review_pack_rows WHERE pack_id = $1 AND row_key = $2",
        )
        .bind(pack.id)
        .bind(&row.row_key)
        .fetch_one(&mut *tx)
        .await?;
        let current_value = if suggestion.current_value.is_some() {
            suggestion.current_value.clone()
        } else {
            load_current_value_for_field(&mut tx, row_id, suggestion.field_name.as_deref()).await?
        };

        sqlx::query(
            r#"
            INSERT INTO counterpoint_ai_review_suggestions (
                import_id, pack_id, row_id, row_key, scope, action, field_name,
                current_value, suggested_value, confidence, reason, status, validation_errors
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', '[]'::jsonb)
            "#,
        )
        .bind(import_uuid)
        .bind(pack.id)
        .bind(row_id)
        .bind(suggestion.row_key.trim())
        .bind(suggestion.scope.trim())
        .bind(suggestion.action.trim())
        .bind(suggestion.field_name.as_deref().map(str::trim))
        .bind(current_value)
        .bind(suggestion.suggested_value.clone())
        .bind(suggestion.confidence)
        .bind(suggestion.reason.as_deref().unwrap_or("").trim())
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("UPDATE counterpoint_review_packs SET status = 'imported' WHERE id = $1")
        .bind(pack.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(ImportReviewResultsResponse {
        import_id,
        source_pack_id,
        stored_suggestions: payload.suggestions.len(),
        status: "stored".to_string(),
    })
}

pub async fn list_suggestions(
    pool: &PgPool,
    external_pack_id: &str,
) -> Result<Vec<ReviewSuggestionSummary>, ReviewPackError> {
    let pack = get_review_pack(pool, external_pack_id).await?;
    sqlx::query_as(
        r#"
        SELECT
            id, import_id, pack_id, row_id, row_key, scope, action, field_name,
            current_value, suggested_value, confidence, reason, status, validation_errors,
            reviewed_by_staff_id, reviewed_at, applied_by_staff_id, applied_at,
            created_at, updated_at
        FROM counterpoint_ai_review_suggestions
        WHERE pack_id = $1
        ORDER BY created_at DESC, id
        "#,
    )
    .bind(pack.id)
    .fetch_all(pool)
    .await
    .map_err(ReviewPackError::Database)
}

pub async fn update_suggestion_status(
    pool: &PgPool,
    suggestion_id: Uuid,
    payload: ReviewSuggestionUpdatePayload,
    reviewed_by_staff_id: Option<Uuid>,
) -> Result<ReviewSuggestionSummary, ReviewPackError> {
    let status = normalize_review_status(&payload.status)?;
    let existing: Option<ReviewSuggestionSummary> = sqlx::query_as(
        r#"
        SELECT
            id, import_id, pack_id, row_id, row_key, scope, action, field_name,
            current_value, suggested_value, confidence, reason, status, validation_errors,
            reviewed_by_staff_id, reviewed_at, applied_by_staff_id, applied_at,
            created_at, updated_at
        FROM counterpoint_ai_review_suggestions
        WHERE id = $1
        "#,
    )
    .bind(suggestion_id)
    .fetch_optional(pool)
    .await?;
    let Some(existing) = existing else {
        return Err(ReviewPackError::NotFound(suggestion_id.to_string()));
    };

    let field_name = payload.field_name.or(existing.field_name);
    if is_forbidden_field(field_name.as_deref()) {
        return Err(ReviewPackError::InvalidPayload(
            "suggestion field is forbidden for AI control".to_string(),
        ));
    }
    let reason = payload.reason.unwrap_or(existing.reason);
    if reason.trim().is_empty() {
        return Err(ReviewPackError::InvalidPayload(
            "reason must not be empty".to_string(),
        ));
    }
    let suggested_value = payload.suggested_value.or(existing.suggested_value);

    sqlx::query_as(
        r#"
        UPDATE counterpoint_ai_review_suggestions
        SET
            status = $1,
            field_name = $2,
            suggested_value = $3,
            reason = $4,
            reviewed_by_staff_id = $5,
            reviewed_at = now(),
            updated_at = now()
        WHERE id = $6
        RETURNING
            id, import_id, pack_id, row_id, row_key, scope, action, field_name,
            current_value, suggested_value, confidence, reason, status, validation_errors,
            reviewed_by_staff_id, reviewed_at, applied_by_staff_id, applied_at,
            created_at, updated_at
        "#,
    )
    .bind(status)
    .bind(field_name)
    .bind(suggested_value)
    .bind(reason.trim())
    .bind(reviewed_by_staff_id)
    .bind(suggestion_id)
    .fetch_one(pool)
    .await
    .map_err(ReviewPackError::Database)
}

pub async fn apply_approved_suggestions(
    pool: &PgPool,
    external_pack_id: &str,
    applied_by_staff_id: Option<Uuid>,
) -> Result<ApplyApprovedResponse, ReviewPackError> {
    let pack = get_review_pack(pool, external_pack_id).await?;
    if pack.scope != INVENTORY_CATALOG {
        let blocked = sqlx::query(
            r#"
            UPDATE counterpoint_ai_review_suggestions
            SET
                status = 'blocked',
                validation_errors = $1,
                reviewed_by_staff_id = COALESCE(reviewed_by_staff_id, $2),
                reviewed_at = COALESCE(reviewed_at, now()),
                updated_at = now()
            WHERE pack_id = $3 AND status = 'accepted'
            "#,
        )
        .bind(json!([
            "apply-approved is review-only for this high-risk scope"
        ]))
        .bind(applied_by_staff_id)
        .bind(pack.id)
        .execute(pool)
        .await?
        .rows_affected() as usize;
        return Ok(ApplyApprovedResponse {
            pack_id: pack.pack_id,
            applied: 0,
            blocked,
            skipped: 0,
            errors: Vec::new(),
        });
    }

    let rows: Vec<(
        Uuid,
        String,
        Option<String>,
        Option<Value>,
        Option<Decimal>,
        Value,
    )> = sqlx::query_as(
        r#"
            SELECT
                s.id,
                s.action,
                s.field_name,
                s.suggested_value,
                s.confidence,
                r.payload
            FROM counterpoint_ai_review_suggestions s
            INNER JOIN counterpoint_review_pack_rows r ON r.id = s.row_id
            WHERE s.pack_id = $1 AND s.status = 'accepted'
            ORDER BY s.created_at, s.id
            "#,
    )
    .bind(pack.id)
    .fetch_all(pool)
    .await?;

    let mut applied = 0usize;
    let mut blocked = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();
    let mut tx = pool.begin().await?;

    for (suggestion_id, action, field_name, suggested_value, confidence, row_payload) in rows {
        let product_id = row_payload
            .pointer("/current_ros_values/product_id")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok());
        let Some(product_id) = product_id else {
            blocked += 1;
            mark_suggestion_blocked(
                &mut tx,
                suggestion_id,
                applied_by_staff_id,
                "review row does not resolve to a ROS product_id",
            )
            .await?;
            continue;
        };

        match action.as_str() {
            "suggest_product_name" | "suggest_display_name" => {
                if !matches!(
                    field_name.as_deref(),
                    Some("product_name") | Some("display_name") | Some("name") | None
                ) {
                    blocked += 1;
                    mark_suggestion_blocked(
                        &mut tx,
                        suggestion_id,
                        applied_by_staff_id,
                        "inventory text apply only supports product_name/display_name",
                    )
                    .await?;
                    continue;
                }
                let Some(new_name) = string_suggested_value(suggested_value.as_ref()) else {
                    blocked += 1;
                    mark_suggestion_blocked(
                        &mut tx,
                        suggestion_id,
                        applied_by_staff_id,
                        "suggested product name must be a non-empty string",
                    )
                    .await?;
                    continue;
                };
                if new_name.len() > 255 {
                    blocked += 1;
                    mark_suggestion_blocked(
                        &mut tx,
                        suggestion_id,
                        applied_by_staff_id,
                        "suggested product name is too long",
                    )
                    .await?;
                    continue;
                }
                let prior: Option<String> =
                    sqlx::query_scalar("SELECT name FROM products WHERE id = $1 FOR UPDATE")
                        .bind(product_id)
                        .fetch_optional(&mut *tx)
                        .await?;
                let Some(prior_name) = prior else {
                    blocked += 1;
                    mark_suggestion_blocked(
                        &mut tx,
                        suggestion_id,
                        applied_by_staff_id,
                        "ROS product no longer exists",
                    )
                    .await?;
                    continue;
                };
                if prior_name == new_name {
                    skipped += 1;
                    mark_suggestion_applied(&mut tx, suggestion_id, applied_by_staff_id).await?;
                    continue;
                }
                sqlx::query("UPDATE products SET name = $1 WHERE id = $2")
                    .bind(&new_name)
                    .bind(product_id)
                    .execute(&mut *tx)
                    .await?;
                insert_product_audit(
                    &mut tx,
                    product_id,
                    applied_by_staff_id,
                    json!({ "name": prior_name }),
                    json!({ "name": new_name }),
                    "Counterpoint Transition Review Pack accepted product name suggestion",
                    confidence,
                )
                .await?;
                mark_suggestion_applied(&mut tx, suggestion_id, applied_by_staff_id).await?;
                applied += 1;
            }
            "suggest_category" => {
                let Some(category_id) =
                    resolve_category_id_from_value_tx(&mut tx, suggested_value.as_ref()).await?
                else {
                    blocked += 1;
                    mark_suggestion_blocked(
                        &mut tx,
                        suggestion_id,
                        applied_by_staff_id,
                        "suggested category does not exist in Riverside OS",
                    )
                    .await?;
                    continue;
                };
                let prior: Option<Option<Uuid>> =
                    sqlx::query_scalar("SELECT category_id FROM products WHERE id = $1 FOR UPDATE")
                        .bind(product_id)
                        .fetch_optional(&mut *tx)
                        .await?;
                let Some(prior_category_id) = prior else {
                    blocked += 1;
                    mark_suggestion_blocked(
                        &mut tx,
                        suggestion_id,
                        applied_by_staff_id,
                        "ROS product no longer exists",
                    )
                    .await?;
                    continue;
                };
                if prior_category_id == Some(category_id) {
                    skipped += 1;
                    mark_suggestion_applied(&mut tx, suggestion_id, applied_by_staff_id).await?;
                    continue;
                }
                sqlx::query("UPDATE products SET category_id = $1 WHERE id = $2")
                    .bind(category_id)
                    .bind(product_id)
                    .execute(&mut *tx)
                    .await?;
                insert_product_audit(
                    &mut tx,
                    product_id,
                    applied_by_staff_id,
                    json!({ "category_id": prior_category_id }),
                    json!({ "category_id": category_id }),
                    "Counterpoint Transition Review Pack accepted category suggestion",
                    confidence,
                )
                .await?;
                mark_suggestion_applied(&mut tx, suggestion_id, applied_by_staff_id).await?;
                applied += 1;
            }
            _ => {
                blocked += 1;
                errors.push(format!("{action} is review-only and was blocked"));
                mark_suggestion_blocked(
                    &mut tx,
                    suggestion_id,
                    applied_by_staff_id,
                    "action is review-only for safe apply",
                )
                .await?;
            }
        }
    }

    tx.commit().await?;
    Ok(ApplyApprovedResponse {
        pack_id: pack.pack_id,
        applied,
        blocked,
        skipped,
        errors,
    })
}

async fn build_inventory_catalog_rows(
    pool: &PgPool,
    limit: i64,
    issue_filter: &str,
) -> Result<Vec<PackRowDraft>, ReviewPackError> {
    let rows: Vec<InventoryCatalogSourceRow> = sqlx::query_as(
        r#"
        SELECT
            p.id AS product_id,
            p.catalog_handle AS catalog_handle,
            p.name AS product_name,
            p.description AS description,
            p.category_id AS category_id,
            c.name AS category_name,
            (SELECT COUNT(*)::bigint FROM product_variants pv WHERE pv.product_id = p.id) AS variant_count,
            (SELECT pv.sku FROM product_variants pv WHERE pv.product_id = p.id ORDER BY pv.created_at NULLS LAST, pv.id LIMIT 1) AS sample_sku,
            (SELECT pv.barcode FROM product_variants pv WHERE pv.product_id = p.id AND NULLIF(btrim(pv.barcode), '') IS NOT NULL ORDER BY pv.created_at NULLS LAST, pv.id LIMIT 1) AS sample_barcode,
            (SELECT pv.counterpoint_item_key FROM product_variants pv WHERE pv.product_id = p.id AND NULLIF(btrim(pv.counterpoint_item_key), '') IS NOT NULL ORDER BY pv.created_at NULLS LAST, pv.id LIMIT 1) AS sample_counterpoint_item_key,
            (
                SELECT r.description
                FROM counterpoint_csv_reference_rows r
                INNER JOIN counterpoint_csv_reference_batches b ON b.id = r.batch_id AND b.status = 'active'
                WHERE lower(btrim(r.item_no)) = lower(btrim(COALESCE(p.catalog_handle, '')))
                ORDER BY r.source_row_number
                LIMIT 1
            ) AS counterpoint_description,
            (
                SELECT r.long_description
                FROM counterpoint_csv_reference_rows r
                INNER JOIN counterpoint_csv_reference_batches b ON b.id = r.batch_id AND b.status = 'active'
                WHERE lower(btrim(r.item_no)) = lower(btrim(COALESCE(p.catalog_handle, '')))
                ORDER BY r.source_row_number
                LIMIT 1
            ) AS counterpoint_long_description,
            (
                SELECT r.category_code
                FROM counterpoint_csv_reference_rows r
                INNER JOIN counterpoint_csv_reference_batches b ON b.id = r.batch_id AND b.status = 'active'
                WHERE lower(btrim(r.item_no)) = lower(btrim(COALESCE(p.catalog_handle, '')))
                ORDER BY r.source_row_number
                LIMIT 1
            ) AS counterpoint_category_code,
            (
                SELECT lr.product_name
                FROM lightspeed_normalization_reference_rows lr
                INNER JOIN product_variants pv ON pv.product_id = p.id
                WHERE lower(btrim(lr.normalized_sku)) = lower(btrim(pv.sku))
                ORDER BY lr.source_row_number
                LIMIT 1
            ) AS lightspeed_name,
            (
                SELECT lr.product_category
                FROM lightspeed_normalization_reference_rows lr
                INNER JOIN product_variants pv ON pv.product_id = p.id
                WHERE lower(btrim(lr.normalized_sku)) = lower(btrim(pv.sku))
                ORDER BY lr.source_row_number
                LIMIT 1
            ) AS lightspeed_category,
            (
                SELECT COUNT(*)::bigint
                FROM counterpoint_ingest_quarantine q
                WHERE lower(btrim(COALESCE(q.family_key, ''))) = lower(btrim(COALESCE(p.catalog_handle, '')))
                   OR EXISTS (
                        SELECT 1 FROM product_variants pv
                        WHERE pv.product_id = p.id
                          AND lower(btrim(COALESCE(q.counterpoint_item_key, ''))) = lower(btrim(COALESCE(pv.counterpoint_item_key, '')))
                   )
            ) AS quarantine_count,
            (
                SELECT COUNT(*)::bigint
                FROM products dup
                WHERE dup.id <> p.id
                  AND lower(btrim(dup.name)) = lower(btrim(p.name))
            ) AS duplicate_name_count,
            (
                SELECT COUNT(*)::bigint
                FROM product_variants pv
                WHERE pv.product_id = p.id
                  AND NULLIF(btrim(pv.counterpoint_item_key), '') IS NOT NULL
                  AND (NULLIF(btrim(pv.barcode), '') IS NULL OR NULLIF(btrim(pv.sku), '') IS NULL)
            ) AS sku_gap_count
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.data_source = 'counterpoint'
           OR NULLIF(btrim(p.catalog_handle), '') IS NOT NULL
           OR EXISTS (
                SELECT 1 FROM product_variants pv
                WHERE pv.product_id = p.id AND NULLIF(btrim(pv.counterpoint_item_key), '') IS NOT NULL
           )
        ORDER BY
            CASE
                WHEN p.category_id IS NULL THEN 0
                WHEN p.name ~* '^[A-Z]?-?[0-9]{4,}$' THEN 0
                WHEN p.catalog_handle IS NOT NULL AND lower(btrim(p.name)) = lower(btrim(p.catalog_handle)) THEN 0
                ELSE 1
            END,
            p.created_at DESC NULLS LAST,
            p.id
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut drafts = Vec::new();
    for row in rows {
        let mut issues = Vec::new();
        if row.category_id.is_none() {
            issues.push("missing_category");
        }
        if identifier_like(&row.product_name)
            || row
                .catalog_handle
                .as_deref()
                .is_some_and(|handle| handle.eq_ignore_ascii_case(row.product_name.trim()))
        {
            issues.push("identifier_like_name");
        }
        if row.quarantine_count > 0 {
            issues.push("quarantined_counterpoint_rows");
        }
        if row.duplicate_name_count > 0 {
            issues.push("possible_duplicate_product_name");
        }
        if row.sku_gap_count > 0 {
            issues.push("sku_or_barcode_gap");
        }
        if should_skip_for_issue_filter(issue_filter, &issues) {
            continue;
        }

        drafts.push(make_pack_row(
            INVENTORY_CATALOG,
            format!("inventory_catalog:{}", row.product_id),
            "product",
            Some(row.product_id.to_string()),
            json!({
                "ros_product_id": row.product_id,
                "catalog_handle": &row.catalog_handle,
                "sample_sku": &row.sample_sku,
                "sample_barcode": &row.sample_barcode,
                "sample_counterpoint_item_key": &row.sample_counterpoint_item_key
            }),
            json!({
                "product_id": row.product_id,
                "product_name": &row.product_name,
                "description": &row.description,
                "category_id": row.category_id,
                "category_name": &row.category_name,
                "variant_count": row.variant_count
            }),
            json!({
                "item_no": &row.catalog_handle,
                "description": &row.counterpoint_description,
                "long_description": &row.counterpoint_long_description,
                "category_code": &row.counterpoint_category_code
            }),
            json!({
                "lightspeed_name": &row.lightspeed_name,
                "lightspeed_category": &row.lightspeed_category
            }),
            issues,
        )?);
    }

    Ok(drafts)
}

async fn build_ticket_financial_rows(
    pool: &PgPool,
    limit: i64,
    issue_filter: &str,
) -> Result<Vec<PackRowDraft>, ReviewPackError> {
    let rows: Vec<TicketFinancialSourceRow> = sqlx::query_as(
        r#"
        SELECT
            t.id AS transaction_id,
            t.counterpoint_ticket_ref AS ticket_ref,
            t.booked_at AS booked_at,
            t.business_date AS business_date,
            t.customer_id AS customer_id,
            t.status::text AS status,
            t.processed_by_staff_id AS processed_by_staff_id,
            t.primary_salesperson_id AS primary_salesperson_id,
            t.total_price AS total_price,
            t.amount_paid AS amount_paid,
            t.balance_due AS balance_due,
            COALESCE((
                SELECT ROUND(SUM((tl.quantity::numeric * tl.unit_price) + COALESCE(tl.state_tax, 0) + COALESCE(tl.local_tax, 0)), 2)
                FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
            ), 0)::numeric AS line_total,
            COALESCE((
                SELECT ROUND(SUM(pa.amount_allocated), 2)
                FROM payment_allocations pa
                WHERE pa.target_transaction_id = t.id
            ), 0)::numeric AS payment_total,
            (SELECT COUNT(*)::bigint FROM transaction_lines tl WHERE tl.transaction_id = t.id) AS line_count,
            (SELECT COUNT(*)::bigint FROM payment_allocations pa WHERE pa.target_transaction_id = t.id) AS payment_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                LEFT JOIN counterpoint_payment_method_map cpm
                    ON cpm.cp_pmt_typ = NULLIF(btrim(pt.metadata->>'counterpoint_pmt_typ'), '')
                WHERE pa.target_transaction_id = t.id
                  AND NULLIF(btrim(pt.metadata->>'counterpoint_pmt_typ'), '') IS NOT NULL
                  AND cpm.id IS NULL
            ) AS unmapped_tender_count,
            (
                SELECT COUNT(*)::bigint
                FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
                  AND (tl.quantity < 0 OR tl.unit_price < 0)
            ) AS negative_line_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = t.id
                  AND pt.payment_method = 'gift_card'
            ) AS gift_card_payment_count
        FROM transactions t
        WHERE t.counterpoint_ticket_ref IS NOT NULL
        ORDER BY t.booked_at DESC, t.id
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let penny = Decimal::new(1, 2);
    let mut drafts = Vec::new();
    for row in rows {
        let mut issues = Vec::new();
        if decimal_diff(row.total_price, row.line_total) > penny {
            issues.push("header_total_vs_line_total_mismatch");
        }
        if decimal_diff(row.amount_paid, row.payment_total) > penny {
            issues.push("tender_total_vs_amount_paid_mismatch");
        }
        if row.unmapped_tender_count > 0 {
            issues.push("unmapped_counterpoint_tender");
        }
        if row.negative_line_count > 0 || row.total_price < Decimal::ZERO {
            issues.push("possible_refund_or_negative_line_ticket");
        }
        if row.customer_id.is_none() {
            issues.push("missing_customer_link");
        }
        if row.processed_by_staff_id.is_none() && row.primary_salesperson_id.is_none() {
            issues.push("missing_staff_attribution");
        }
        if should_skip_for_issue_filter(issue_filter, &issues) {
            continue;
        }

        drafts.push(make_pack_row(
            TICKET_FINANCIAL,
            format!("ticket_financial:{}", row.ticket_ref),
            "counterpoint_ticket",
            Some(row.transaction_id.to_string()),
            json!({
                "transaction_id": row.transaction_id,
                "original_counterpoint_ticket_number": &row.ticket_ref,
                "booked_at": row.booked_at,
                "business_date": row.business_date,
                "line_count": row.line_count,
                "payment_count": row.payment_count,
                "gift_card_payment_count": row.gift_card_payment_count
            }),
            json!({
                "status": row.status,
                "customer_id": row.customer_id,
                "processed_by_staff_id": row.processed_by_staff_id,
                "primary_salesperson_id": row.primary_salesperson_id,
                "historical_ticket_total": row.total_price,
                "amount_paid": row.amount_paid,
                "balance_due": row.balance_due,
                "computed_line_total": row.line_total,
                "computed_payment_total": row.payment_total
            }),
            json!({
                "ticket_ref": &row.ticket_ref,
                "immutable_financial_fields": [
                    "historical_ticket_total",
                    "computed_line_total",
                    "computed_payment_total",
                    "amount_paid",
                    "balance_due"
                ]
            }),
            Value::Null,
            issues,
        )?);
    }

    Ok(drafts)
}

async fn build_returns_readiness_rows(
    pool: &PgPool,
    limit: i64,
    issue_filter: &str,
) -> Result<Vec<PackRowDraft>, ReviewPackError> {
    let rows: Vec<ReturnsReadinessSourceRow> = sqlx::query_as(
        r#"
        SELECT
            tl.id AS line_id,
            t.id AS transaction_id,
            t.counterpoint_ticket_ref AS ticket_ref,
            t.booked_at AS booked_at,
            t.business_date AS business_date,
            t.customer_id AS customer_id,
            tl.product_id AS product_id,
            tl.variant_id AS variant_id,
            pv.sku AS sku,
            pv.barcode AS barcode,
            pv.counterpoint_item_key AS counterpoint_item_key,
            tl.vendor_reference AS vendor_reference,
            tl.size_specs->>'counterpoint_description' AS counterpoint_description,
            tl.size_specs->>'counterpoint_line_sequence' AS counterpoint_line_sequence,
            tl.quantity AS quantity_purchased,
            tl.unit_price AS unit_price,
            COALESCE(tl.state_tax, 0) + COALESCE(tl.local_tax, 0) AS tax_total,
            COALESCE(tl.applied_spiff, 0) AS discount_amount,
            COALESCE((
                SELECT SUM(trl.quantity_returned)::bigint
                FROM transaction_return_lines trl
                WHERE trl.transaction_line_id = tl.id
            ), 0)::bigint AS quantity_returned,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'payment_method', pt.payment_method,
                    'amount', pa.amount_allocated,
                    'counterpoint_pmt_typ', pt.metadata->>'counterpoint_pmt_typ'
                ))
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = t.id
            ), '[]'::jsonb) AS tender_summary
        FROM transactions t
        INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        WHERE t.counterpoint_ticket_ref IS NOT NULL
        ORDER BY t.booked_at DESC, tl.id
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut drafts = Vec::new();
    for row in rows {
        let mut issues = Vec::new();
        if row.product_id.is_none() || row.variant_id.is_none() || row.vendor_reference.is_some() {
            issues.push("unresolved_legacy_item");
        }
        if i64::from(row.quantity_purchased) - row.quantity_returned <= 0 {
            issues.push("fully_returned_or_non_returnable_history_line");
        }
        if row
            .tender_summary
            .as_array()
            .map(Vec::is_empty)
            .unwrap_or(true)
        {
            issues.push("missing_original_tender");
        }
        if row.customer_id.is_none() {
            issues.push("missing_customer_link");
        }
        if should_skip_for_issue_filter(issue_filter, &issues) {
            continue;
        }

        drafts.push(make_pack_row(
            RETURNS_READINESS,
            format!("returns_readiness:{}:{}", row.ticket_ref, row.line_id),
            "counterpoint_ticket_line",
            Some(row.line_id.to_string()),
            json!({
                "transaction_id": row.transaction_id,
                "transaction_line_id": row.line_id,
                "original_counterpoint_ticket_number": &row.ticket_ref,
                "booked_at": row.booked_at,
                "business_date": row.business_date,
                "original_counterpoint_line_id": &row.counterpoint_line_sequence,
                "original_counterpoint_item_key": &row.counterpoint_item_key,
                "original_sku": &row.sku,
                "original_barcode": &row.barcode
            }),
            json!({
                "customer_id": row.customer_id,
                "product_id": row.product_id,
                "variant_id": row.variant_id,
                "current_ros_item_status": if row.variant_id.is_some() { "resolved" } else { "unresolved" },
                "quantity_purchased": row.quantity_purchased,
                "quantity_already_returned": row.quantity_returned
            }),
            json!({
                "original_item_description": &row.counterpoint_description,
                "original_unit_price": row.unit_price,
                "original_discount": row.discount_amount,
                "original_tax": row.tax_total,
                "original_tender_summary": row.tender_summary
            }),
            Value::Null,
            issues,
        )?);
    }

    Ok(drafts)
}

async fn build_scaffold_scope_rows(
    pool: &PgPool,
    scope: &str,
    issue_filter: &str,
) -> Result<Vec<PackRowDraft>, ReviewPackError> {
    let row = match scope {
        CUSTOMER_DEDUPE => {
            let duplicate_email_groups: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::bigint
                FROM (
                    SELECT lower(btrim(email))
                    FROM customers
                    WHERE NULLIF(btrim(email), '') IS NOT NULL
                    GROUP BY lower(btrim(email))
                    HAVING COUNT(*) > 1
                ) dup
                "#,
            )
            .fetch_one(pool)
            .await?;
            make_pack_row(
                CUSTOMER_DEDUPE,
                "customer_dedupe:summary".to_string(),
                "customer_dedupe_summary",
                None,
                json!({ "source": "customers", "pii_policy": "summary-only first pass" }),
                json!({ "duplicate_email_groups": duplicate_email_groups }),
                Value::Null,
                Value::Null,
                if duplicate_email_groups > 0 {
                    vec!["possible_duplicate_customer_groups"]
                } else {
                    vec!["summary_only_scope"]
                },
            )?
        }
        TENDER_MAPPING => {
            let (mapped_tenders, unmapped_cp_tenders): (i64, i64) = sqlx::query_as(
                r#"
                SELECT
                    (SELECT COUNT(*)::bigint FROM counterpoint_payment_method_map),
                    (
                        SELECT COUNT(DISTINCT NULLIF(btrim(pt.metadata->>'counterpoint_pmt_typ'), ''))::bigint
                        FROM payment_transactions pt
                        LEFT JOIN counterpoint_payment_method_map cpm
                            ON cpm.cp_pmt_typ = NULLIF(btrim(pt.metadata->>'counterpoint_pmt_typ'), '')
                        WHERE NULLIF(btrim(pt.metadata->>'counterpoint_pmt_typ'), '') IS NOT NULL
                          AND cpm.id IS NULL
                    )
                "#,
            )
            .fetch_one(pool)
            .await?;
            make_pack_row(
                TENDER_MAPPING,
                "tender_mapping:summary".to_string(),
                "tender_mapping_summary",
                None,
                json!({ "source": "counterpoint_payment_method_map + payment_transactions.metadata" }),
                json!({ "mapped_tenders": mapped_tenders, "unmapped_cp_tenders": unmapped_cp_tenders }),
                Value::Null,
                Value::Null,
                if unmapped_cp_tenders > 0 {
                    vec!["unknown_counterpoint_tenders"]
                } else {
                    vec!["summary_only_scope"]
                },
            )?
        }
        GIFT_CARD_LIABILITY => {
            let (card_count, open_balance): (i64, Decimal) = sqlx::query_as(
                "SELECT COUNT(*)::bigint, COALESCE(SUM(current_balance), 0)::numeric FROM gift_cards",
            )
            .fetch_one(pool)
            .await?;
            make_pack_row(
                GIFT_CARD_LIABILITY,
                "gift_card_liability:summary".to_string(),
                "gift_card_liability_summary",
                None,
                json!({ "source": "gift_cards", "liability_policy": "balances are forbidden AI-controlled fields" }),
                json!({ "gift_card_count": card_count, "open_balance_total": open_balance }),
                Value::Null,
                Value::Null,
                vec!["summary_only_scope"],
            )?
        }
        OPEN_ORDERS_LAYAWAYS => {
            let (open_docs, missing_customer): (i64, i64) = sqlx::query_as(
                r#"
                SELECT
                    COUNT(*)::bigint,
                    COUNT(*) FILTER (WHERE customer_id IS NULL)::bigint
                FROM transactions
                WHERE counterpoint_doc_ref IS NOT NULL
                "#,
            )
            .fetch_one(pool)
            .await?;
            make_pack_row(
                OPEN_ORDERS_LAYAWAYS,
                "open_orders_layaways:summary".to_string(),
                "open_docs_summary",
                None,
                json!({ "source": "transactions.counterpoint_doc_ref" }),
                json!({ "open_doc_transactions": open_docs, "missing_customer_links": missing_customer }),
                Value::Null,
                Value::Null,
                if missing_customer > 0 {
                    vec!["missing_customer_link"]
                } else {
                    vec!["summary_only_scope"]
                },
            )?
        }
        CUTOVER_AUDIT => {
            let (staging_pending, open_issues, imported_tickets, imported_docs): (i64, i64, i64, i64) =
                sqlx::query_as(
                    r#"
                    SELECT
                        (SELECT COUNT(*)::bigint FROM counterpoint_staging_batch WHERE status IN ('pending', 'applying')),
                        (SELECT COUNT(*)::bigint FROM counterpoint_sync_issue WHERE resolved = false),
                        (SELECT COUNT(*)::bigint FROM transactions WHERE counterpoint_ticket_ref IS NOT NULL),
                        (SELECT COUNT(*)::bigint FROM transactions WHERE counterpoint_doc_ref IS NOT NULL)
                    "#,
                )
                .fetch_one(pool)
                .await?;
            let mut issues = Vec::new();
            if staging_pending > 0 {
                issues.push("pending_staging_batches");
            }
            if open_issues > 0 {
                issues.push("unresolved_counterpoint_sync_issues");
            }
            if imported_tickets == 0 {
                issues.push("no_imported_ticket_history");
            }
            make_pack_row(
                CUTOVER_AUDIT,
                "cutover_audit:summary".to_string(),
                "cutover_audit_summary",
                None,
                json!({ "source": "counterpoint staging, issues, imported transaction proof" }),
                json!({
                    "pending_or_applying_staging_batches": staging_pending,
                    "unresolved_sync_issues": open_issues,
                    "imported_ticket_transactions": imported_tickets,
                    "imported_open_doc_transactions": imported_docs
                }),
                Value::Null,
                Value::Null,
                if issues.is_empty() {
                    vec!["ready_check_needed"]
                } else {
                    issues
                },
            )?
        }
        _ => {
            return Err(ReviewPackError::InvalidPayload(format!(
                "unknown scope {scope}"
            )))
        }
    };

    if should_skip_for_issue_filter(
        issue_filter,
        row.payload
            .get("detected_issues")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<&str>>()
            })
            .as_deref()
            .unwrap_or(&[]),
    ) {
        Ok(Vec::new())
    } else {
        Ok(vec![row])
    }
}

fn make_pack_row(
    scope: &str,
    row_key: String,
    entity_type: &str,
    entity_ref: Option<String>,
    source_evidence: Value,
    current_ros_values: Value,
    counterpoint_values: Value,
    imported_reference_values: Value,
    detected_issues: Vec<&str>,
) -> Result<PackRowDraft, ReviewPackError> {
    let payload = json!({
        "row_key": row_key,
        "entity_type": entity_type,
        "entity_ref": entity_ref,
        "source_evidence": source_evidence,
        "current_ros_values": current_ros_values,
        "counterpoint_values": counterpoint_values,
        "imported_reference_values": imported_reference_values,
        "detected_issues": detected_issues,
        "allowed_actions": allowed_actions_for_scope(scope).unwrap_or(&[]),
        "forbidden_fields": FORBIDDEN_FIELDS
    });
    let source_hash = hash_json(&payload)?;
    Ok(PackRowDraft {
        row_key,
        entity_type: entity_type.to_string(),
        entity_ref,
        payload,
        source_hash,
    })
}

fn review_pack_document_value(
    pack_id: &str,
    scope: &str,
    generated_at: DateTime<Utc>,
    source_hash: &str,
    rows: Vec<Value>,
) -> Value {
    json!({
        "schema": REVIEW_PACK_SCHEMA,
        "schema_version": REVIEW_PACK_SCHEMA_VERSION,
        "pack_id": pack_id,
        "scope": scope,
        "generated_at": generated_at,
        "source_hash": source_hash,
        "allowed_actions": allowed_actions_for_scope(scope).unwrap_or(&[]),
        "forbidden_fields": FORBIDDEN_FIELDS,
        "instructions": scope_instructions(scope),
        "result_schema": result_schema_value(),
        "rows": rows
    })
}

fn result_schema_value() -> Value {
    json!({
        "schema": REVIEW_RESULTS_SCHEMA,
        "schema_version": REVIEW_PACK_SCHEMA_VERSION,
        "source_pack_id": "pack_id from review pack",
        "source_hash": "source_hash from review pack",
        "provider_label": "manual_chatgpt | manual_codex | unknown",
        "suggestions": [
            {
                "row_key": "must match a row in rows[]",
                "scope": "must match the review pack scope",
                "action": "must be listed in row.allowed_actions",
                "field_name": "optional; must not be a forbidden field",
                "suggested_value": "required for suggest_* actions",
                "confidence": "number from 0 to 1",
                "reason": "short explanation based only on source_evidence"
            }
        ]
    })
}

fn scope_instructions(scope: &str) -> String {
    let scope_detail = match scope {
        INVENTORY_CATALOG => "You may suggest readable product names, display names, existing Riverside OS categories, and human-review flags. Do not suggest price, cost, stock, SKU, barcode, or Counterpoint ID changes.",
        TICKET_FINANCIAL => "Flag reconciliation, tender, refund, negative-line, customer-link, and staff-attribution concerns only. Do not change any historical financial number.",
        RETURNS_READINESS => "Flag whether historical Counterpoint purchase lines are ready for returns/exchanges. You may suggest legacy item resolution IDs only when the evidence supports them, but ROS will stage them for staff review.",
        CUSTOMER_DEDUPE => "First-pass scaffold. Flag duplicate candidates only; customer merges are not applied by this workflow.",
        TENDER_MAPPING => "First-pass scaffold. Tender suggestions are review-only and do not alter payment ledgers.",
        GIFT_CARD_LIABILITY => "First-pass scaffold. Gift-card balances and liability values are forbidden AI-controlled fields.",
        OPEN_ORDERS_LAYAWAYS => "First-pass scaffold. Open document and layaway deposit values are review-only.",
        CUTOVER_AUDIT => "First-pass scaffold. Flag blockers or warnings; do not approve cutover.",
        _ => "Use only row-level allowed_actions and never alter forbidden fields.",
    };
    format!(
        "{scope_detail} Return only JSON matching result_schema. Every suggestion must use a row_key present in this pack and must be based only on source_evidence."
    )
}

async fn get_review_pack(
    pool: &PgPool,
    external_pack_id: &str,
) -> Result<ReviewPackSummary, ReviewPackError> {
    let pack = sqlx::query_as(
        r#"
        SELECT
            id, pack_id, scope, schema_version, source_hash, generated_by_staff_id,
            generated_at, row_count, status, metadata
        FROM counterpoint_review_packs
        WHERE pack_id = $1
        "#,
    )
    .bind(external_pack_id.trim())
    .fetch_optional(pool)
    .await?;
    pack.ok_or_else(|| ReviewPackError::NotFound(external_pack_id.to_string()))
}

async fn load_row_validation_contexts(
    pool: &PgPool,
    pack_uuid: Uuid,
) -> Result<HashMap<String, RowValidationContext>, ReviewPackError> {
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT row_key, payload FROM counterpoint_review_pack_rows WHERE pack_id = $1",
    )
    .bind(pack_uuid)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(row_key, payload)| {
            let scope = payload
                .get("row_key")
                .and_then(Value::as_str)
                .and_then(|key| key.split(':').next())
                .unwrap_or("")
                .to_string();
            let allowed_actions = extract_string_array(payload.get("allowed_actions"));
            let forbidden_fields = extract_string_array(payload.get("forbidden_fields"));
            (
                row_key.clone(),
                RowValidationContext {
                    row_key,
                    scope,
                    allowed_actions,
                    forbidden_fields,
                },
            )
        })
        .collect())
}

fn validate_suggestion_basic(
    suggestion: &ImportedSuggestionPayload,
    row_ctx: Option<&RowValidationContext>,
    pack_scope: &str,
    index: usize,
) -> Vec<String> {
    let mut errors = Vec::new();
    let row_key = suggestion.row_key.trim();
    if row_key.is_empty() {
        errors.push(format!("suggestion {index}: row_key is required"));
    }
    let Some(row) = row_ctx else {
        errors.push(format!(
            "suggestion {index}: row_key was not in original pack"
        ));
        return errors;
    };
    if suggestion.scope.trim() != pack_scope {
        errors.push(format!(
            "suggestion {index}: scope must match source pack scope {pack_scope}"
        ));
    }
    if !row.scope.is_empty() && row.scope != pack_scope {
        errors.push(format!(
            "suggestion {index}: row scope {} does not match pack scope {pack_scope}",
            row.scope
        ));
    }
    if !row
        .allowed_actions
        .iter()
        .any(|action| action == suggestion.action.trim())
    {
        errors.push(format!(
            "suggestion {index}: action {} is not allowed for row {}",
            suggestion.action.trim(),
            row.row_key
        ));
    }
    if suggestion
        .field_name
        .as_deref()
        .is_some_and(|field| is_forbidden_field_with_row(field, &row.forbidden_fields))
    {
        errors.push(format!(
            "suggestion {index}: field_name is forbidden for AI control"
        ));
    }
    if suggestion.action.trim().starts_with("suggest_") && suggestion.suggested_value.is_none() {
        errors.push(format!(
            "suggestion {index}: suggested_value is required for suggest_* actions"
        ));
    }
    match suggestion.confidence {
        Some(conf) if conf >= Decimal::ZERO && conf <= Decimal::ONE => {}
        _ => errors.push(format!(
            "suggestion {index}: confidence must be present and between 0 and 1"
        )),
    }
    if suggestion.reason.as_deref().unwrap_or("").trim().is_empty() {
        errors.push(format!("suggestion {index}: reason is required"));
    }
    errors
}

async fn validate_suggestion_references(
    pool: &PgPool,
    suggestion: &ImportedSuggestionPayload,
) -> Result<(), ReviewPackError> {
    match suggestion.action.trim() {
        "suggest_category" => {
            let exists = resolve_category_id_from_value(pool, suggestion.suggested_value.as_ref())
                .await?
                .is_some();
            if !exists {
                return Err(ReviewPackError::InvalidPayload(
                    "suggested category does not exist".to_string(),
                ));
            }
        }
        "suggest_primary_customer" => {
            if let Some(customer_id) =
                uuid_from_suggested_value(suggestion.suggested_value.as_ref())
            {
                let exists: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                        .bind(customer_id)
                        .fetch_one(pool)
                        .await?;
                if !exists {
                    return Err(ReviewPackError::InvalidPayload(
                        "suggested primary customer does not exist".to_string(),
                    ));
                }
            }
        }
        "suggest_legacy_item_resolution" => {
            if let Some(variant_id) = uuid_field_from_suggested_value(
                suggestion.suggested_value.as_ref(),
                &["variant_id", "ros_variant_id"],
            ) {
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM product_variants WHERE id = $1)",
                )
                .bind(variant_id)
                .fetch_one(pool)
                .await?;
                if !exists {
                    return Err(ReviewPackError::InvalidPayload(
                        "suggested legacy variant target does not exist".to_string(),
                    ));
                }
            }
            if let Some(product_id) = uuid_field_from_suggested_value(
                suggestion.suggested_value.as_ref(),
                &["product_id", "ros_product_id"],
            ) {
                let exists: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE id = $1)")
                        .bind(product_id)
                        .fetch_one(pool)
                        .await?;
                if !exists {
                    return Err(ReviewPackError::InvalidPayload(
                        "suggested legacy product target does not exist".to_string(),
                    ));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

async fn insert_import_audit(
    pool: &PgPool,
    pack: &ReviewPackSummary,
    imported_by_staff_id: Option<Uuid>,
    payload: &ImportReviewResultsPayload,
    status: &str,
    validation_errors: &[String],
) -> Result<Uuid, ReviewPackError> {
    let import_id = Uuid::new_v4().to_string();
    sqlx::query_scalar(
        r#"
        INSERT INTO counterpoint_ai_review_imports (
            import_id, source_pack_id, imported_by_staff_id, provider_label,
            schema_version, imported_file_name, source_hash, status, validation_errors
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        "#,
    )
    .bind(import_id)
    .bind(pack.id)
    .bind(imported_by_staff_id)
    .bind(
        payload
            .provider_label
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown"),
    )
    .bind(payload.schema_version)
    .bind(payload.imported_file_name.as_deref())
    .bind(payload.source_hash.trim())
    .bind(status)
    .bind(json!(validation_errors))
    .fetch_one(pool)
    .await
    .map_err(ReviewPackError::Database)
}

async fn load_current_value_for_field(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    row_id: Uuid,
    field_name: Option<&str>,
) -> Result<Option<Value>, ReviewPackError> {
    let Some(field_name) = field_name.map(str::trim).filter(|field| !field.is_empty()) else {
        return Ok(None);
    };
    let payload: Value =
        sqlx::query_scalar("SELECT payload FROM counterpoint_review_pack_rows WHERE id = $1")
            .bind(row_id)
            .fetch_one(&mut **tx)
            .await?;
    Ok(payload
        .get("current_ros_values")
        .and_then(|current| current.get(field_name))
        .cloned())
}

async fn mark_suggestion_applied(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    suggestion_id: Uuid,
    staff_id: Option<Uuid>,
) -> Result<(), ReviewPackError> {
    sqlx::query(
        r#"
        UPDATE counterpoint_ai_review_suggestions
        SET status = 'applied', applied_by_staff_id = $1, applied_at = now(), updated_at = now()
        WHERE id = $2
        "#,
    )
    .bind(staff_id)
    .bind(suggestion_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn mark_suggestion_blocked(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    suggestion_id: Uuid,
    staff_id: Option<Uuid>,
    reason: &str,
) -> Result<(), ReviewPackError> {
    sqlx::query(
        r#"
        UPDATE counterpoint_ai_review_suggestions
        SET
            status = 'blocked',
            validation_errors = $1,
            reviewed_by_staff_id = COALESCE(reviewed_by_staff_id, $2),
            reviewed_at = COALESCE(reviewed_at, now()),
            updated_at = now()
        WHERE id = $3
        "#,
    )
    .bind(json!([reason]))
    .bind(staff_id)
    .bind(suggestion_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_product_audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    product_id: Uuid,
    staff_id: Option<Uuid>,
    before_values: Value,
    after_values: Value,
    note: &str,
    confidence: Option<Decimal>,
) -> Result<(), ReviewPackError> {
    sqlx::query(
        r#"
        INSERT INTO product_catalog_audit_log (
            product_id, changed_by, change_source, before_values, after_values,
            change_note, suggestion_confidence
        )
        VALUES ($1, $2, 'counterpoint_review_pack', $3, $4, $5, $6)
        "#,
    )
    .bind(product_id)
    .bind(staff_id)
    .bind(before_values)
    .bind(after_values)
    .bind(note)
    .bind(confidence.and_then(|value| value.to_f64()))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn resolve_category_id_from_value(
    pool: &PgPool,
    value: Option<&Value>,
) -> Result<Option<Uuid>, ReviewPackError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if let Some(id) = uuid_from_suggested_value(Some(value)) {
        let found: Option<Uuid> = sqlx::query_scalar("SELECT id FROM categories WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        return Ok(found);
    }
    let Some(name) = string_suggested_value(Some(value)) else {
        return Ok(None);
    };
    sqlx::query_scalar("SELECT id FROM categories WHERE lower(btrim(name)) = lower(btrim($1))")
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(ReviewPackError::Database)
}

async fn resolve_category_id_from_value_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    value: Option<&Value>,
) -> Result<Option<Uuid>, ReviewPackError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if let Some(id) = uuid_from_suggested_value(Some(value)) {
        let found: Option<Uuid> = sqlx::query_scalar("SELECT id FROM categories WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
        return Ok(found);
    }
    let Some(name) = string_suggested_value(Some(value)) else {
        return Ok(None);
    };
    sqlx::query_scalar("SELECT id FROM categories WHERE lower(btrim(name)) = lower(btrim($1))")
        .bind(name)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ReviewPackError::Database)
}

fn normalize_scope(scope: &str) -> Result<&'static str, ReviewPackError> {
    match scope.trim() {
        INVENTORY_CATALOG => Ok(INVENTORY_CATALOG),
        CUSTOMER_DEDUPE => Ok(CUSTOMER_DEDUPE),
        TICKET_FINANCIAL => Ok(TICKET_FINANCIAL),
        TENDER_MAPPING => Ok(TENDER_MAPPING),
        GIFT_CARD_LIABILITY => Ok(GIFT_CARD_LIABILITY),
        OPEN_ORDERS_LAYAWAYS => Ok(OPEN_ORDERS_LAYAWAYS),
        RETURNS_READINESS => Ok(RETURNS_READINESS),
        CUTOVER_AUDIT => Ok(CUTOVER_AUDIT),
        other => Err(ReviewPackError::InvalidPayload(format!(
            "unknown review pack scope {other}"
        ))),
    }
}

fn allowed_actions_for_scope(scope: &str) -> Option<&'static [&'static str]> {
    match scope {
        INVENTORY_CATALOG => Some(INVENTORY_ACTIONS),
        CUSTOMER_DEDUPE => Some(CUSTOMER_ACTIONS),
        TICKET_FINANCIAL => Some(TICKET_ACTIONS),
        TENDER_MAPPING => Some(TENDER_ACTIONS),
        GIFT_CARD_LIABILITY => Some(GIFT_CARD_ACTIONS),
        OPEN_ORDERS_LAYAWAYS => Some(OPEN_DOC_ACTIONS),
        RETURNS_READINESS => Some(RETURNS_ACTIONS),
        CUTOVER_AUDIT => Some(CUTOVER_ACTIONS),
        _ => None,
    }
}

fn normalize_review_status(input: &str) -> Result<&'static str, ReviewPackError> {
    match input.trim() {
        "accept" | "accepted" => Ok("accepted"),
        "reject" | "rejected" => Ok("rejected"),
        "edit" | "edited" => Ok("edited"),
        "block" | "blocked" => Ok("blocked"),
        other => Err(ReviewPackError::InvalidPayload(format!(
            "unsupported suggestion status {other}"
        ))),
    }
}

fn hash_json(value: &Value) -> Result<String, ReviewPackError> {
    let bytes = serde_json::to_vec(value).map_err(|e| {
        ReviewPackError::InvalidPayload(format!("could not serialize hash payload: {e}"))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(hex::encode(hasher.finalize()))
}

fn extract_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn normalized_field_name(field: &str) -> String {
    field
        .trim()
        .to_ascii_lowercase()
        .replace([' ', '/', '-'], "_")
}

fn is_forbidden_field(field: Option<&str>) -> bool {
    field.is_some_and(|field| {
        let normalized = normalized_field_name(field);
        FORBIDDEN_FIELDS
            .iter()
            .map(|field| normalized_field_name(field))
            .any(|forbidden| normalized == forbidden || normalized.contains(&forbidden))
    })
}

fn is_forbidden_field_with_row(field: &str, row_forbidden_fields: &[String]) -> bool {
    if is_forbidden_field(Some(field)) {
        return true;
    }
    let normalized = normalized_field_name(field);
    row_forbidden_fields
        .iter()
        .map(|field| normalized_field_name(field))
        .any(|forbidden| normalized == forbidden || normalized.contains(&forbidden))
}

fn should_skip_for_issue_filter(issue_filter: &str, issues: &[&str]) -> bool {
    matches!(issue_filter, "issues" | "issues_only" | "needs_review") && issues.is_empty()
}

fn identifier_like(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() < 4 {
        return false;
    }
    let compact = trimmed.replace(['-', '_', ' '], "");
    compact.chars().all(|ch| ch.is_ascii_digit())
        || (compact.len() >= 5
            && compact
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic())
            && compact.chars().skip(1).all(|ch| ch.is_ascii_digit()))
}

fn decimal_diff(left: Decimal, right: Decimal) -> Decimal {
    if left >= right {
        left - right
    } else {
        right - left
    }
}

fn string_suggested_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    for key in [
        "value",
        "name",
        "product_name",
        "display_name",
        "category_name",
    ] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn uuid_from_suggested_value(value: Option<&Value>) -> Option<Uuid> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Uuid::parse_str(text.trim()).ok();
    }
    for key in [
        "id",
        "value",
        "category_id",
        "customer_id",
        "product_id",
        "variant_id",
    ] {
        if let Some(id) = value
            .get(key)
            .and_then(Value::as_str)
            .and_then(|text| Uuid::parse_str(text.trim()).ok())
        {
            return Some(id);
        }
    }
    None
}

fn uuid_field_from_suggested_value(value: Option<&Value>, keys: &[&str]) -> Option<Uuid> {
    let value = value?;
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .and_then(|text| Uuid::parse_str(text.trim()).ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    fn sample_row_ctx() -> RowValidationContext {
        RowValidationContext {
            row_key: "inventory_catalog:abc".to_string(),
            scope: INVENTORY_CATALOG.to_string(),
            allowed_actions: INVENTORY_ACTIONS.iter().map(|s| s.to_string()).collect(),
            forbidden_fields: FORBIDDEN_FIELDS.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn pack_document_contains_stable_schema_fields() {
        let document = review_pack_document_value(
            "pack-1",
            INVENTORY_CATALOG,
            DateTime::<Utc>::from_timestamp(1_700_000_000, 0).unwrap(),
            "abc123",
            vec![json!({
                "row_key": "inventory_catalog:abc",
                "allowed_actions": INVENTORY_ACTIONS,
                "forbidden_fields": FORBIDDEN_FIELDS
            })],
        );

        assert_eq!(document["schema"], REVIEW_PACK_SCHEMA);
        assert_eq!(document["schema_version"], REVIEW_PACK_SCHEMA_VERSION);
        assert_eq!(document["pack_id"], "pack-1");
        assert_eq!(document["scope"], INVENTORY_CATALOG);
        assert!(document["result_schema"].is_object());
        assert!(document["rows"].as_array().unwrap().len() == 1);
    }

    #[test]
    fn import_validation_rejects_unknown_row_key() {
        let suggestion = ImportedSuggestionPayload {
            row_key: "inventory_catalog:missing".to_string(),
            scope: INVENTORY_CATALOG.to_string(),
            action: "suggest_product_name".to_string(),
            field_name: Some("product_name".to_string()),
            current_value: None,
            suggested_value: Some(json!("Readable Name")),
            confidence: Some(Decimal::new(91, 2)),
            reason: Some("Provided source evidence supports a readable name.".to_string()),
        };
        let errors = validate_suggestion_basic(&suggestion, None, INVENTORY_CATALOG, 1);
        assert!(errors.iter().any(|e| e.contains("row_key")));
    }

    #[test]
    fn import_validation_rejects_forbidden_field_change() {
        let row = sample_row_ctx();
        let suggestion = ImportedSuggestionPayload {
            row_key: row.row_key.clone(),
            scope: INVENTORY_CATALOG.to_string(),
            action: "suggest_product_name".to_string(),
            field_name: Some("quantity_on_hand".to_string()),
            current_value: None,
            suggested_value: Some(json!("Readable Name")),
            confidence: Some(Decimal::new(91, 2)),
            reason: Some("Provided source evidence supports a readable name.".to_string()),
        };
        let errors = validate_suggestion_basic(&suggestion, Some(&row), INVENTORY_CATALOG, 1);
        assert!(errors.iter().any(|e| e.contains("forbidden")));
    }

    #[test]
    fn import_validation_rejects_unknown_action() {
        let row = sample_row_ctx();
        let suggestion = ImportedSuggestionPayload {
            row_key: row.row_key.clone(),
            scope: INVENTORY_CATALOG.to_string(),
            action: "change_price".to_string(),
            field_name: Some("product_name".to_string()),
            current_value: None,
            suggested_value: Some(json!("Readable Name")),
            confidence: Some(Decimal::new(91, 2)),
            reason: Some("Provided source evidence supports a readable name.".to_string()),
        };
        let errors = validate_suggestion_basic(&suggestion, Some(&row), INVENTORY_CATALOG, 1);
        assert!(errors.iter().any(|e| e.contains("not allowed")));
    }

    #[test]
    fn import_validation_accepts_valid_pending_candidate() {
        let row = sample_row_ctx();
        let suggestion = ImportedSuggestionPayload {
            row_key: row.row_key.clone(),
            scope: INVENTORY_CATALOG.to_string(),
            action: "suggest_product_name".to_string(),
            field_name: Some("product_name".to_string()),
            current_value: None,
            suggested_value: Some(json!("Readable Name")),
            confidence: Some(Decimal::new(91, 2)),
            reason: Some("Provided source evidence supports a readable name.".to_string()),
        };
        let errors = validate_suggestion_basic(&suggestion, Some(&row), INVENTORY_CATALOG, 1);
        assert!(errors.is_empty(), "{errors:?}");
    }

    async fn optional_test_pool() -> Option<PgPool> {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .ok()?;
        let pool = PgPool::connect(&database_url).await.ok()?;
        let has_tables: bool = sqlx::query_scalar(
            "SELECT to_regclass('public.counterpoint_review_packs') IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .ok()?;
        has_tables.then_some(pool)
    }

    async fn insert_test_pack(pool: &PgPool, source_hash: &str) -> (Uuid, String, String) {
        let external_pack_id = Uuid::new_v4().to_string();
        let row_key = format!("ticket_financial:{}", Uuid::new_v4());
        let pack_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO counterpoint_review_packs (
                pack_id, scope, schema_version, source_hash, row_count, status, metadata
            )
            VALUES ($1, 'ticket_financial', 1, $2, 1, 'generated', '{}'::jsonb)
            RETURNING id
            "#,
        )
        .bind(&external_pack_id)
        .bind(source_hash)
        .fetch_one(pool)
        .await
        .expect("insert review pack");

        let payload = json!({
            "row_key": row_key,
            "entity_type": "counterpoint_ticket",
            "entity_ref": null,
            "source_evidence": {},
            "current_ros_values": {},
            "counterpoint_values": {},
            "imported_reference_values": null,
            "detected_issues": ["test"],
            "allowed_actions": TICKET_ACTIONS,
            "forbidden_fields": FORBIDDEN_FIELDS
        });
        sqlx::query(
            r#"
            INSERT INTO counterpoint_review_pack_rows (
                pack_id, row_key, entity_type, entity_ref, payload, source_hash
            )
            VALUES ($1, $2, 'counterpoint_ticket', NULL, $3, 'row-hash')
            "#,
        )
        .bind(pack_id)
        .bind(&row_key)
        .bind(payload)
        .execute(pool)
        .await
        .expect("insert review pack row");
        (pack_id, external_pack_id, row_key)
    }

    #[tokio::test]
    async fn import_stores_valid_suggestions_as_pending_when_database_available() {
        let Some(pool) = optional_test_pool().await else {
            return;
        };
        let source_hash = format!("source-hash-{}", Uuid::new_v4());
        let (pack_uuid, external_pack_id, row_key) = insert_test_pack(&pool, &source_hash).await;

        let result = import_review_results(
            &pool,
            ImportReviewResultsPayload {
                schema: REVIEW_RESULTS_SCHEMA.to_string(),
                schema_version: REVIEW_PACK_SCHEMA_VERSION,
                source_pack_id: external_pack_id.clone(),
                source_hash,
                provider_label: Some("manual_codex".to_string()),
                imported_file_name: Some("test.json".to_string()),
                suggestions: vec![ImportedSuggestionPayload {
                    row_key,
                    scope: TICKET_FINANCIAL.to_string(),
                    action: "flag_total_mismatch".to_string(),
                    field_name: None,
                    current_value: None,
                    suggested_value: None,
                    confidence: Some(Decimal::new(88, 2)),
                    reason: Some("Test import stages valid flag suggestions.".to_string()),
                }],
            },
            None,
        )
        .await
        .expect("valid import should store");
        assert_eq!(result.stored_suggestions, 1);

        let stored: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM counterpoint_ai_review_suggestions WHERE pack_id = $1 AND status = 'pending'",
        )
        .bind(pack_uuid)
        .fetch_one(&pool)
        .await
        .expect("count staged suggestions");
        assert_eq!(stored, 1);

        sqlx::query("DELETE FROM counterpoint_review_packs WHERE id = $1")
            .bind(pack_uuid)
            .execute(&pool)
            .await
            .expect("cleanup pack");
    }

    #[tokio::test]
    async fn import_rejects_wrong_source_hash_when_database_available() {
        let Some(pool) = optional_test_pool().await else {
            return;
        };
        let (pack_uuid, external_pack_id, row_key) =
            insert_test_pack(&pool, "expected-source-hash").await;

        let result = import_review_results(
            &pool,
            ImportReviewResultsPayload {
                schema: REVIEW_RESULTS_SCHEMA.to_string(),
                schema_version: REVIEW_PACK_SCHEMA_VERSION,
                source_pack_id: external_pack_id,
                source_hash: "wrong-source-hash".to_string(),
                provider_label: Some("manual_codex".to_string()),
                imported_file_name: Some("test.json".to_string()),
                suggestions: vec![ImportedSuggestionPayload {
                    row_key,
                    scope: TICKET_FINANCIAL.to_string(),
                    action: "flag_total_mismatch".to_string(),
                    field_name: None,
                    current_value: None,
                    suggested_value: None,
                    confidence: Some(Decimal::new(88, 2)),
                    reason: Some("Test import rejects hash mismatch.".to_string()),
                }],
            },
            None,
        )
        .await;
        assert!(matches!(result, Err(ReviewPackError::InvalidPayload(_))));

        let rejected: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM counterpoint_ai_review_imports WHERE source_pack_id = $1 AND status = 'rejected'",
        )
        .bind(pack_uuid)
        .fetch_one(&pool)
        .await
        .expect("count rejected imports");
        assert_eq!(rejected, 1);

        sqlx::query("DELETE FROM counterpoint_review_packs WHERE id = $1")
            .bind(pack_uuid)
            .execute(&pool)
            .await
            .expect("cleanup pack");
    }
}
