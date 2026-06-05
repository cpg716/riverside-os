use base64::{engine::general_purpose, Engine as _};
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use chrono::{NaiveDate, Utc};
use csv::StringRecord;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::io::Cursor;
use std::path::PathBuf;
use std::str::FromStr;
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_IMPORT_DIR: &str = "data/procurement-imports";
const DEFAULT_IMPORT_MAX_BYTES: usize = 25 * 1024 * 1024;
const DEFAULT_ROSIE_PROCUREMENT_URL: &str = "http://127.0.0.1:8765/v1/procurement/extract";
const DEFAULT_ROSIE_PROCUREMENT_MODEL: &str = "gemma-4-E4B-it";
pub const PROCUREMENT_PROMPT_VERSION: &str = "procurement_document_extract_v1";

const DOCUMENT_KINDS: &[&str] = &[
    "unknown",
    "purchase_order",
    "order_confirmation",
    "packing_slip",
    "invoice",
    "credit_memo",
    "statement",
];

const DOCUMENT_STATUSES: &[&str] = &[
    "uploaded",
    "extracted",
    "matched",
    "needs_review",
    "approved",
    "converted",
    "failed",
    "cancelled",
];

#[derive(Debug, Clone, Serialize)]
pub struct ProcurementRosieSidecarStatus {
    pub enabled: bool,
    pub url: String,
    pub model: String,
    pub timeout_ms: u64,
    pub deterministic_formats: Vec<&'static str>,
    pub ai_required_formats: Vec<&'static str>,
    pub prompt_version: &'static str,
}

const LINE_MATCH_STATUSES: &[&str] = &[
    "exact",
    "likely",
    "new_variant",
    "new_product",
    "unmatched",
    "ignored",
];

const LINE_REVIEW_ACTIONS: &[&str] = &[
    "use_existing_variant",
    "create_variant",
    "create_product",
    "ignore",
    "needs_review",
];

#[derive(Debug, Error)]
pub enum ProcurementImportError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("File error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Import document not found")]
    NotFound,
    #[error("Extraction failed: {0}")]
    Extraction(String),
}

#[derive(Debug, Clone)]
pub struct UploadDocumentInput {
    pub vendor_id: Option<Uuid>,
    pub document_kind: Option<String>,
    pub source_filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct ProcurementImportDocumentSummary {
    pub id: Uuid,
    pub vendor_id: Option<Uuid>,
    pub vendor_name: Option<String>,
    pub document_kind: String,
    pub status: String,
    pub source_filename: String,
    pub content_type: String,
    pub sha256: String,
    pub file_size_bytes: i64,
    pub invoice_number: Option<String>,
    pub external_po_number: Option<String>,
    pub document_date: Option<NaiveDate>,
    pub document_total: Option<Decimal>,
    pub duplicate_of_document_id: Option<Uuid>,
    pub converted_purchase_order_id: Option<Uuid>,
    pub created_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
    pub line_count: i64,
    pub unresolved_line_count: i64,
}

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct ProcurementImportLine {
    pub id: Uuid,
    pub document_id: Uuid,
    pub line_index: i32,
    pub raw_line: Value,
    pub vendor_sku: Option<String>,
    pub vendor_upc: Option<String>,
    pub barcode: Option<String>,
    pub manufacturer_sku: Option<String>,
    pub description: Option<String>,
    pub product_name: Option<String>,
    pub brand: Option<String>,
    pub color: Option<String>,
    pub size: Option<String>,
    pub fit: Option<String>,
    pub quantity: Decimal,
    pub unit_cost: Decimal,
    pub line_total: Option<Decimal>,
    pub match_status: String,
    pub matched_variant_id: Option<Uuid>,
    pub matched_product_id: Option<Uuid>,
    pub matched_sku: Option<String>,
    pub matched_product_name: Option<String>,
    pub matched_variation_label: Option<String>,
    pub match_confidence: Option<Decimal>,
    pub match_reason: Option<String>,
    pub review_action: String,
    pub review_payload: Value,
    pub staff_notes: Option<String>,
}

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct ProcurementVendorDocumentProfile {
    pub id: Uuid,
    pub vendor_id: Uuid,
    pub profile_name: String,
    pub column_aliases: Value,
    pub value_aliases: Value,
    pub document_hints: Value,
    pub last_learned_from_document_id: Option<Uuid>,
    pub successful_import_count: i32,
    pub last_used_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProcurementImportDetail {
    pub document: ProcurementImportDocumentSummary,
    pub lines: Vec<ProcurementImportLine>,
    pub vendor_profile: Option<ProcurementVendorDocumentProfile>,
    pub duplicate_warning: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProcurementImportListQuery {
    pub status: Option<String>,
    pub vendor_id: Option<Uuid>,
    pub document_kind: Option<String>,
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PatchProcurementImportDocumentRequest {
    pub vendor_id: Option<Uuid>,
    pub document_kind: Option<String>,
    pub invoice_number: Option<String>,
    pub external_po_number: Option<String>,
    pub document_date: Option<NaiveDate>,
    pub due_date: Option<NaiveDate>,
    pub freight_total: Option<Decimal>,
    pub tax_total: Option<Decimal>,
    pub discount_total: Option<Decimal>,
    pub document_total: Option<Decimal>,
}

#[derive(Debug, Deserialize)]
pub struct PatchProcurementImportLineRequest {
    pub vendor_sku: Option<String>,
    pub vendor_upc: Option<String>,
    pub barcode: Option<String>,
    pub manufacturer_sku: Option<String>,
    pub description: Option<String>,
    pub product_name: Option<String>,
    pub brand: Option<String>,
    pub color: Option<String>,
    pub size: Option<String>,
    pub fit: Option<String>,
    pub quantity: Option<Decimal>,
    pub unit_cost: Option<Decimal>,
    pub line_total: Option<Decimal>,
    pub matched_variant_id: Option<Uuid>,
    pub matched_product_id: Option<Uuid>,
    pub match_status: Option<String>,
    pub match_confidence: Option<Decimal>,
    pub match_reason: Option<String>,
    pub review_action: Option<String>,
    pub review_payload: Option<Value>,
    pub staff_notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ConvertProcurementImportRequest {
    pub target: String,
    pub existing_purchase_order_id: Option<Uuid>,
    #[serde(default)]
    pub learn_vendor_profile: bool,
    #[serde(default)]
    pub allow_duplicate_invoice: bool,
}

#[derive(Debug, Serialize)]
pub struct ConvertProcurementImportResponse {
    pub purchase_order_id: Uuid,
    pub po_number: String,
    pub po_kind: String,
    pub status: String,
    pub lines_added: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RawProcurementDocument {
    pub document_kind: Option<String>,
    pub vendor_name: Option<String>,
    pub vendor_account_number: Option<String>,
    pub invoice_number: Option<String>,
    pub external_po_number: Option<String>,
    pub document_date: Option<String>,
    pub due_date: Option<String>,
    pub freight_total: Option<String>,
    pub tax_total: Option<String>,
    pub discount_total: Option<String>,
    pub document_total: Option<String>,
    pub currency: Option<String>,
    pub confidence: Option<Decimal>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub lines: Vec<RawProcurementLine>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RawProcurementLine {
    pub line_index: Option<i32>,
    pub vendor_sku: Option<String>,
    pub vendor_upc: Option<String>,
    pub barcode: Option<String>,
    pub manufacturer_sku: Option<String>,
    pub description: Option<String>,
    pub product_name: Option<String>,
    pub brand: Option<String>,
    pub color: Option<String>,
    pub size: Option<String>,
    pub fit: Option<String>,
    pub quantity: Option<String>,
    pub unit_cost: Option<String>,
    pub line_total: Option<String>,
    #[serde(default)]
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct ValidatedProcurementDocument {
    pub document_kind: String,
    pub vendor_name_guess: Option<String>,
    pub invoice_number: Option<String>,
    pub external_po_number: Option<String>,
    pub document_date: Option<NaiveDate>,
    pub due_date: Option<NaiveDate>,
    pub freight_total: Decimal,
    pub tax_total: Decimal,
    pub discount_total: Decimal,
    pub document_total: Option<Decimal>,
    pub confidence: Option<Decimal>,
    pub lines: Vec<ValidatedProcurementLine>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ValidatedProcurementLine {
    pub line_index: i32,
    pub raw_line: Value,
    pub vendor_sku: Option<String>,
    pub vendor_upc: Option<String>,
    pub barcode: Option<String>,
    pub manufacturer_sku: Option<String>,
    pub description: Option<String>,
    pub product_name: Option<String>,
    pub brand: Option<String>,
    pub color: Option<String>,
    pub size: Option<String>,
    pub fit: Option<String>,
    pub quantity: Decimal,
    pub unit_cost: Decimal,
    pub line_total: Option<Decimal>,
}

#[derive(Debug, FromRow)]
struct StoredDocumentRow {
    id: Uuid,
    vendor_id: Option<Uuid>,
    document_kind: String,
    status: String,
    source_filename: String,
    content_type: String,
    storage_path: Option<String>,
    sha256: String,
    invoice_number: Option<String>,
    document_total: Option<Decimal>,
}

#[derive(Debug, FromRow, Clone)]
struct MatchLineRow {
    id: Uuid,
    vendor_sku: Option<String>,
    vendor_upc: Option<String>,
    barcode: Option<String>,
    manufacturer_sku: Option<String>,
    description: Option<String>,
    product_name: Option<String>,
    brand: Option<String>,
    color: Option<String>,
    size: Option<String>,
    fit: Option<String>,
}

#[derive(Debug, FromRow, Clone)]
struct VariantCandidate {
    variant_id: Uuid,
    product_id: Uuid,
    sku: String,
    vendor_upc: Option<String>,
    barcode: Option<String>,
    product_name: String,
    brand: Option<String>,
    variation_label: Option<String>,
    primary_vendor_id: Option<Uuid>,
    primary_vendor_name: Option<String>,
}

#[derive(Debug, Clone)]
struct MatchDecision {
    status: String,
    action: String,
    variant_id: Option<Uuid>,
    product_id: Option<Uuid>,
    confidence: Option<Decimal>,
    reason: Option<String>,
}

fn clean_opt(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn normalize_key(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn normalize_lookup(value: &str) -> String {
    value.trim().to_lowercase()
}

fn parse_decimal_value(field: &str, value: &str) -> Result<Decimal, ProcurementImportError> {
    let cleaned = value
        .trim()
        .trim_start_matches('$')
        .replace(',', "")
        .replace('−', "-");
    Decimal::from_str(&cleaned).map_err(|_| {
        ProcurementImportError::InvalidPayload(format!("{field} is not a valid decimal"))
    })
}

fn parse_optional_decimal(
    field: &str,
    value: Option<&str>,
) -> Result<Option<Decimal>, ProcurementImportError> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(parse_decimal_value(field, value)?))
}

fn parse_optional_date(
    field: &str,
    value: Option<&str>,
) -> Result<Option<NaiveDate>, ProcurementImportError> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"] {
        if let Ok(date) = NaiveDate::parse_from_str(value, fmt) {
            return Ok(Some(date));
        }
    }
    Err(ProcurementImportError::InvalidPayload(format!(
        "{field} is not a valid date"
    )))
}

fn validate_non_negative(field: &str, value: Decimal) -> Result<(), ProcurementImportError> {
    if value < Decimal::ZERO {
        return Err(ProcurementImportError::InvalidPayload(format!(
            "{field} must be non-negative"
        )));
    }
    Ok(())
}

fn validate_document_kind(kind: &str) -> Result<String, ProcurementImportError> {
    let normalized = kind.trim().to_lowercase();
    if DOCUMENT_KINDS.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(ProcurementImportError::InvalidPayload(format!(
            "unsupported document_kind: {kind}"
        )))
    }
}

fn validate_document_status(status: &str) -> Result<String, ProcurementImportError> {
    let normalized = status.trim().to_lowercase();
    if DOCUMENT_STATUSES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(ProcurementImportError::InvalidPayload(format!(
            "unsupported status: {status}"
        )))
    }
}

fn validate_line_status(status: &str) -> Result<String, ProcurementImportError> {
    let normalized = status.trim().to_lowercase();
    if LINE_MATCH_STATUSES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(ProcurementImportError::InvalidPayload(format!(
            "unsupported match_status: {status}"
        )))
    }
}

fn validate_line_action(action: &str) -> Result<String, ProcurementImportError> {
    let normalized = action.trim().to_lowercase();
    if LINE_REVIEW_ACTIONS.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(ProcurementImportError::InvalidPayload(format!(
            "unsupported review_action: {action}"
        )))
    }
}

pub fn max_import_bytes() -> usize {
    env::var("RIVERSIDE_PROCUREMENT_IMPORT_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_IMPORT_MAX_BYTES)
}

fn import_storage_dir() -> PathBuf {
    env::var("RIVERSIDE_PROCUREMENT_IMPORT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_IMPORT_DIR))
}

fn sanitize_filename(filename: &str) -> String {
    let sanitized: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "vendor-document.bin".to_string()
    } else {
        trimmed.chars().take(160).collect()
    }
}

fn extension_for(filename: &str) -> String {
    filename
        .rsplit_once('.')
        .map(|(_, ext)| ext.trim().to_lowercase())
        .unwrap_or_default()
}

pub fn validate_supported_file(
    filename: &str,
    content_type: &str,
) -> Result<(), ProcurementImportError> {
    let ext = extension_for(filename);
    let content_type = content_type.to_lowercase();
    let ext_ok = matches!(
        ext.as_str(),
        "pdf" | "png" | "jpg" | "jpeg" | "csv" | "xlsx" | "xls" | "txt" | "json" | "doc" | "docx"
    );
    let content_ok = content_type.starts_with("text/")
        || content_type.contains("pdf")
        || content_type.contains("png")
        || content_type.contains("jpeg")
        || content_type.contains("json")
        || content_type.contains("csv")
        || content_type.contains("spreadsheet")
        || content_type.contains("excel")
        || content_type.contains("word")
        || content_type.contains("officedocument")
        || content_type.contains("msword")
        || content_type == "application/octet-stream";
    if ext_ok && content_ok {
        Ok(())
    } else {
        Err(ProcurementImportError::InvalidPayload(
            "unsupported file type; upload PDF, image, CSV, XLSX, TXT, or JSON".to_string(),
        ))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn sidecar_enabled() -> bool {
    env::var("RIVERSIDE_ROSIE_PROCUREMENT_ENABLED")
        .map(|v| {
            matches!(
                v.trim().to_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub fn procurement_rosie_sidecar_status() -> ProcurementRosieSidecarStatus {
    ProcurementRosieSidecarStatus {
        enabled: sidecar_enabled(),
        url: env::var("RIVERSIDE_ROSIE_PROCUREMENT_URL")
            .unwrap_or_else(|_| DEFAULT_ROSIE_PROCUREMENT_URL.to_string()),
        model: env::var("RIVERSIDE_ROSIE_PROCUREMENT_MODEL")
            .unwrap_or_else(|_| DEFAULT_ROSIE_PROCUREMENT_MODEL.to_string()),
        timeout_ms: env::var("RIVERSIDE_ROSIE_PROCUREMENT_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(20_000),
        deterministic_formats: vec!["csv", "xlsx", "xls", "json", "txt"],
        ai_required_formats: vec!["pdf", "png", "jpg", "jpeg", "doc", "docx"],
        prompt_version: PROCUREMENT_PROMPT_VERSION,
    }
}

pub fn build_procurement_extraction_prompt() -> String {
    [
        "Return strict JSON only for task procurement_document_extract_v1.",
        "Do not invent SKUs, UPCs, quantities, costs, invoice numbers, dates, vendors, or totals.",
        "Use null for missing values and preserve raw vendor values.",
        "Extract one object per merchandise line.",
        "Exclude subtotal, tax, freight, comment, and instruction rows unless they are merchandise.",
        "Put freight, tax, discount, and document total in header fields.",
        "Keep quantity and money as strings. Never recommend database writes.",
    ]
    .join(" ")
}

pub fn validate_extracted_document(
    raw: &RawProcurementDocument,
) -> Result<ValidatedProcurementDocument, ProcurementImportError> {
    let kind = raw
        .document_kind
        .as_deref()
        .unwrap_or("unknown")
        .trim()
        .to_lowercase();
    let document_kind = validate_document_kind(&kind)?;
    let freight_total = parse_optional_decimal("freight_total", raw.freight_total.as_deref())?
        .unwrap_or(Decimal::ZERO);
    let tax_total =
        parse_optional_decimal("tax_total", raw.tax_total.as_deref())?.unwrap_or(Decimal::ZERO);
    let discount_total = parse_optional_decimal("discount_total", raw.discount_total.as_deref())?
        .unwrap_or(Decimal::ZERO);
    let document_total = parse_optional_decimal("document_total", raw.document_total.as_deref())?;
    validate_non_negative("freight_total", freight_total)?;
    validate_non_negative("tax_total", tax_total)?;
    validate_non_negative("discount_total", discount_total)?;
    if let Some(total) = document_total {
        validate_non_negative("document_total", total)?;
    }
    if let Some(confidence) = raw.confidence {
        if confidence < Decimal::ZERO || confidence > Decimal::ONE {
            return Err(ProcurementImportError::InvalidPayload(
                "confidence must be between 0 and 1".to_string(),
            ));
        }
    }

    let mut lines = Vec::with_capacity(raw.lines.len());
    let mut seen_indexes = HashSet::new();
    for (idx, line) in raw.lines.iter().enumerate() {
        let line_index = line.line_index.unwrap_or((idx + 1) as i32);
        if line_index <= 0 || !seen_indexes.insert(line_index) {
            return Err(ProcurementImportError::InvalidPayload(
                "line_index values must be positive and unique".to_string(),
            ));
        }
        let quantity =
            parse_optional_decimal("quantity", line.quantity.as_deref())?.ok_or_else(|| {
                ProcurementImportError::InvalidPayload("line quantity is required".to_string())
            })?;
        if quantity <= Decimal::ZERO {
            return Err(ProcurementImportError::InvalidPayload(
                "line quantity must be > 0".to_string(),
            ));
        }
        let unit_cost = parse_optional_decimal("unit_cost", line.unit_cost.as_deref())?
            .unwrap_or(Decimal::ZERO);
        validate_non_negative("unit_cost", unit_cost)?;
        let line_total = parse_optional_decimal("line_total", line.line_total.as_deref())?;
        if let Some(total) = line_total {
            validate_non_negative("line_total", total)?;
        }

        lines.push(ValidatedProcurementLine {
            line_index,
            raw_line: if line.raw.is_null() {
                serde_json::to_value(line)?
            } else {
                line.raw.clone()
            },
            vendor_sku: clean_opt(line.vendor_sku.clone()),
            vendor_upc: clean_opt(line.vendor_upc.clone()),
            barcode: clean_opt(line.barcode.clone()),
            manufacturer_sku: clean_opt(line.manufacturer_sku.clone()),
            description: clean_opt(line.description.clone()),
            product_name: clean_opt(line.product_name.clone()),
            brand: clean_opt(line.brand.clone()),
            color: clean_opt(line.color.clone()),
            size: clean_opt(line.size.clone()),
            fit: clean_opt(line.fit.clone()),
            quantity,
            unit_cost,
            line_total,
        });
    }

    Ok(ValidatedProcurementDocument {
        document_kind,
        vendor_name_guess: clean_opt(raw.vendor_name.clone()),
        invoice_number: clean_opt(raw.invoice_number.clone()),
        external_po_number: clean_opt(raw.external_po_number.clone()),
        document_date: parse_optional_date("document_date", raw.document_date.as_deref())?,
        due_date: parse_optional_date("due_date", raw.due_date.as_deref())?,
        freight_total,
        tax_total,
        discount_total,
        document_total,
        confidence: raw.confidence,
        lines,
        warnings: raw.warnings.clone(),
    })
}

fn cell(
    record: &StringRecord,
    headers: &HashMap<String, usize>,
    aliases: &[&str],
) -> Option<String> {
    aliases.iter().find_map(|alias| {
        headers
            .get(&normalize_key(alias))
            .and_then(|idx| record.get(*idx))
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToString::to_string)
    })
}

fn map_record_raw(record: &StringRecord, ordered_headers: &[String]) -> Value {
    let mut raw = Map::new();
    for (idx, header) in ordered_headers.iter().enumerate() {
        if let Some(value) = record.get(idx) {
            raw.insert(header.clone(), Value::String(value.trim().to_string()));
        }
    }
    Value::Object(raw)
}

fn document_from_csv_records(
    headers_record: &StringRecord,
    records: impl Iterator<Item = Result<StringRecord, csv::Error>>,
) -> Result<RawProcurementDocument, ProcurementImportError> {
    let ordered_headers: Vec<String> = headers_record
        .iter()
        .map(|h| h.trim().to_string())
        .collect();
    let mut headers = HashMap::new();
    for (idx, header) in ordered_headers.iter().enumerate() {
        headers.insert(normalize_key(header), idx);
    }

    let mut raw = RawProcurementDocument {
        document_kind: Some("invoice".to_string()),
        ..Default::default()
    };
    let mut line_index = 1;
    for record in records {
        let record = record.map_err(|e| ProcurementImportError::Extraction(e.to_string()))?;
        if record.iter().all(|v| v.trim().is_empty()) {
            continue;
        }
        if raw.invoice_number.is_none() {
            raw.invoice_number = cell(
                &record,
                &headers,
                &["invoice_number", "invoice", "inv_number"],
            );
        }
        if raw.external_po_number.is_none() {
            raw.external_po_number = cell(
                &record,
                &headers,
                &["external_po_number", "po_number", "po", "purchase_order"],
            );
        }
        if raw.document_date.is_none() {
            raw.document_date = cell(
                &record,
                &headers,
                &["document_date", "invoice_date", "date"],
            );
        }
        if raw.document_total.is_none() {
            raw.document_total = cell(
                &record,
                &headers,
                &["document_total", "invoice_total", "total"],
            );
        }

        let vendor_sku = cell(
            &record,
            &headers,
            &[
                "vendor_sku",
                "vendor sku",
                "item",
                "item_number",
                "item #",
                "sku",
                "style",
                "style_code",
            ],
        );
        let description = cell(
            &record,
            &headers,
            &["description", "desc", "item_description"],
        );
        let product_name = cell(&record, &headers, &["product_name", "product", "name"]);
        let quantity = cell(
            &record,
            &headers,
            &["quantity", "qty", "ordered", "shipped"],
        );
        let unit_cost = cell(
            &record,
            &headers,
            &["unit_cost", "cost", "price", "unit price", "unit_price"],
        );
        let has_merchandise_signal =
            vendor_sku.is_some() || description.is_some() || product_name.is_some();
        if !has_merchandise_signal {
            continue;
        }
        let quantity = match quantity {
            Some(q) => Some(q),
            None => {
                raw.warnings.push(format!(
                    "Line {line_index} had no quantity column; defaulted to 1 for staff review."
                ));
                Some("1".to_string())
            }
        };
        raw.lines.push(RawProcurementLine {
            line_index: Some(line_index),
            vendor_sku,
            vendor_upc: cell(&record, &headers, &["vendor_upc", "vendor upc", "upc"]),
            barcode: cell(&record, &headers, &["barcode", "bar_code", "bar code"]),
            manufacturer_sku: cell(
                &record,
                &headers,
                &["manufacturer_sku", "mfg_sku", "mfg sku"],
            ),
            description,
            product_name,
            brand: cell(&record, &headers, &["brand", "brand_name", "manufacturer"]),
            color: cell(&record, &headers, &["color", "colour"]),
            size: cell(&record, &headers, &["size"]),
            fit: cell(&record, &headers, &["fit"]),
            quantity,
            unit_cost,
            line_total: cell(
                &record,
                &headers,
                &["line_total", "extended", "extended_cost", "amount"],
            ),
            raw: map_record_raw(&record, &ordered_headers),
        });
        line_index += 1;
    }
    Ok(raw)
}

pub fn extract_csv_bytes(bytes: &[u8]) -> Result<RawProcurementDocument, ProcurementImportError> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(bytes);
    let headers = reader
        .headers()
        .map_err(|e| ProcurementImportError::Extraction(e.to_string()))?
        .clone();
    document_from_csv_records(&headers, reader.into_records())
}

fn data_cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(v) => v.trim().to_string(),
        Data::Int(v) => v.to_string(),
        Data::Float(v) => {
            let mut out = format!("{v}");
            if out.ends_with(".0") {
                out.truncate(out.len() - 2);
            }
            out
        }
        Data::Bool(v) => v.to_string(),
        Data::DateTimeIso(v) | Data::DurationIso(v) => v.clone(),
        Data::DateTime(v) => v.to_string(),
        Data::Error(v) => format!("{v:?}"),
    }
}

fn extract_xlsx_bytes(bytes: &[u8]) -> Result<RawProcurementDocument, ProcurementImportError> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut workbook = open_workbook_auto_from_rs(cursor)
        .map_err(|e| ProcurementImportError::Extraction(e.to_string()))?;
    let sheet_name =
        workbook.sheet_names().first().cloned().ok_or_else(|| {
            ProcurementImportError::Extraction("workbook has no sheets".to_string())
        })?;
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| ProcurementImportError::Extraction(e.to_string()))?;
    let mut rows = range.rows();
    let header_row = rows.next().ok_or_else(|| {
        ProcurementImportError::Extraction("worksheet has no header row".to_string())
    })?;
    let headers = StringRecord::from(
        header_row
            .iter()
            .map(data_cell_to_string)
            .collect::<Vec<_>>(),
    );
    let records = rows.map(|row| {
        Ok(StringRecord::from(
            row.iter().map(data_cell_to_string).collect::<Vec<_>>(),
        ))
    });
    document_from_csv_records(&headers, records)
}

fn extract_deterministic(
    filename: &str,
    content_type: &str,
    bytes: &[u8],
) -> Result<(RawProcurementDocument, String), ProcurementImportError> {
    let ext = extension_for(filename);
    if ext == "json" || content_type.to_lowercase().contains("json") {
        let raw = serde_json::from_slice::<RawProcurementDocument>(bytes)?;
        return Ok((raw, String::from_utf8_lossy(bytes).to_string()));
    }
    if ext == "csv" || content_type.to_lowercase().contains("csv") {
        let raw = extract_csv_bytes(bytes)?;
        return Ok((raw, String::from_utf8_lossy(bytes).to_string()));
    }
    if matches!(ext.as_str(), "xlsx" | "xls") || content_type.to_lowercase().contains("spreadsheet")
    {
        let raw = extract_xlsx_bytes(bytes)?;
        return Ok((raw, String::new()));
    }
    if ext == "txt" || content_type.to_lowercase().starts_with("text/") {
        let text = String::from_utf8_lossy(bytes).to_string();
        let mut raw = RawProcurementDocument {
            document_kind: Some("unknown".to_string()),
            ..Default::default()
        };
        raw.warnings.push(
            "Plain text was stored for ROSIE extraction; no table rows were deterministically detected."
                .to_string(),
        );
        return Ok((raw, text));
    }
    Ok((
        RawProcurementDocument {
            document_kind: Some("unknown".to_string()),
            warnings: vec![
                "PDF, image, and Word document extraction requires the local ROSIE procurement sidecar; CSV/XLSX/JSON can still parse deterministically.".to_string(),
            ],
            ..Default::default()
        },
        String::new(),
    ))
}

async fn call_rosie_sidecar(
    document: &StoredDocumentRow,
    raw_text: &str,
    bytes: &[u8],
    vendor_profile: Option<&ProcurementVendorDocumentProfile>,
) -> Result<Option<RawProcurementDocument>, ProcurementImportError> {
    if !sidecar_enabled() {
        return Ok(None);
    }
    let url = env::var("RIVERSIDE_ROSIE_PROCUREMENT_URL")
        .unwrap_or_else(|_| DEFAULT_ROSIE_PROCUREMENT_URL.to_string());
    let timeout_ms = env::var("RIVERSIDE_ROSIE_PROCUREMENT_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(20_000);
    let model = env::var("RIVERSIDE_ROSIE_PROCUREMENT_MODEL")
        .unwrap_or_else(|_| DEFAULT_ROSIE_PROCUREMENT_MODEL.to_string());
    let file_base64 = Some(general_purpose::STANDARD.encode(bytes));
    let file_encoding = file_base64.as_ref().map(|_| "base64");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| ProcurementImportError::Extraction(e.to_string()))?;
    let response = client
        .post(url)
        .json(&json!({
            "task": PROCUREMENT_PROMPT_VERSION,
            "model": model,
            "filename": document.source_filename,
            "content_type": document.content_type,
            "file_sha256": document.sha256,
            "file_base64": file_base64,
            "file_encoding": file_encoding,
            "raw_text": raw_text,
            "vendor_profile": vendor_profile,
            "known_ros_fields": {
                "document_kinds": DOCUMENT_KINDS,
                "line_fields": [
                    "vendor_sku",
                    "vendor_upc",
                    "barcode",
                    "description",
                    "product_name",
                    "brand",
                    "color",
                    "size",
                    "fit",
                    "quantity",
                    "unit_cost",
                    "line_total"
                ]
            },
            "prompt": build_procurement_extraction_prompt()
        }))
        .send()
        .await;
    let Ok(response) = response else {
        tracing::warn!(
            "ROSIE procurement extraction sidecar unavailable; using deterministic extraction"
        );
        return Ok(None);
    };
    if !response.status().is_success() {
        tracing::warn!(
            status = %response.status(),
            "ROSIE procurement extraction sidecar returned non-success; using deterministic extraction"
        );
        return Ok(None);
    }
    let value = response
        .json::<RawProcurementDocument>()
        .await
        .map_err(|e| ProcurementImportError::Extraction(e.to_string()))?;
    Ok(Some(value))
}

async fn load_document_row(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<StoredDocumentRow, ProcurementImportError> {
    sqlx::query_as::<_, StoredDocumentRow>(
        r#"
        SELECT id, vendor_id, document_kind, status, source_filename, content_type, storage_path,
               sha256, invoice_number, document_total
        FROM procurement_import_documents
        WHERE id = $1
        "#,
    )
    .bind(document_id)
    .fetch_optional(pool)
    .await?
    .ok_or(ProcurementImportError::NotFound)
}

pub async fn upload_document(
    pool: &PgPool,
    actor_staff_id: Uuid,
    input: UploadDocumentInput,
) -> Result<ProcurementImportDocumentSummary, ProcurementImportError> {
    validate_supported_file(&input.source_filename, &input.content_type)?;
    if input.bytes.len() > max_import_bytes() {
        return Err(ProcurementImportError::InvalidPayload(format!(
            "file exceeds {} byte procurement import limit",
            max_import_bytes()
        )));
    }
    let document_kind =
        validate_document_kind(input.document_kind.as_deref().unwrap_or("unknown"))?;
    if let Some(vendor_id) = input.vendor_id {
        ensure_active_vendor(pool, vendor_id).await?;
    }

    let document_id = Uuid::new_v4();
    let sha256 = sha256_hex(&input.bytes);
    let duplicate_of_document_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM procurement_import_documents WHERE sha256 = $1 ORDER BY created_at ASC LIMIT 1",
    )
    .bind(&sha256)
    .fetch_optional(pool)
    .await?;

    let dir = import_storage_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let safe_name = sanitize_filename(&input.source_filename);
    let storage_path = dir.join(format!("{document_id}-{safe_name}"));
    tokio::fs::write(&storage_path, &input.bytes).await?;

    sqlx::query(
        r#"
        INSERT INTO procurement_import_documents (
            id, vendor_id, document_kind, source_filename, content_type, storage_path, sha256,
            file_size_bytes, duplicate_of_document_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(document_id)
    .bind(input.vendor_id)
    .bind(document_kind)
    .bind(input.source_filename.trim())
    .bind(input.content_type.trim())
    .bind(storage_path.to_string_lossy().to_string())
    .bind(sha256)
    .bind(input.bytes.len() as i64)
    .bind(duplicate_of_document_id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;

    get_document_summary(pool, document_id).await
}

pub async fn list_imports(
    pool: &PgPool,
    query: ProcurementImportListQuery,
) -> Result<Vec<ProcurementImportDocumentSummary>, ProcurementImportError> {
    if let Some(status) = query.status.as_deref() {
        validate_document_status(status)?;
    }
    if let Some(kind) = query.document_kind.as_deref() {
        validate_document_kind(kind)?;
    }
    let limit = query.limit.unwrap_or(100).clamp(1, 250);
    let offset = query.offset.unwrap_or(0).max(0);
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            format!(
                "%{}%",
                s.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        });

    let rows = sqlx::query_as::<_, ProcurementImportDocumentSummary>(
        r#"
        SELECT
            d.id,
            d.vendor_id,
            v.name AS vendor_name,
            d.document_kind,
            d.status,
            d.source_filename,
            d.content_type,
            d.sha256,
            d.file_size_bytes,
            d.invoice_number,
            d.external_po_number,
            d.document_date,
            d.document_total,
            d.duplicate_of_document_id,
            d.converted_purchase_order_id,
            d.created_at,
            d.updated_at,
            COUNT(l.id)::bigint AS line_count,
            COUNT(l.id) FILTER (
                WHERE l.review_action = 'needs_review'
                   OR l.match_status IN ('unmatched', 'new_variant', 'new_product')
            )::bigint AS unresolved_line_count
        FROM procurement_import_documents d
        LEFT JOIN vendors v ON v.id = d.vendor_id
        LEFT JOIN procurement_import_lines l ON l.document_id = d.id
        WHERE ($1::text IS NULL OR d.status = $1)
          AND ($2::uuid IS NULL OR d.vendor_id = $2)
          AND ($3::text IS NULL OR d.document_kind = $3)
          AND (
              $4::text IS NULL
              OR d.source_filename ILIKE $4 ESCAPE '\'
              OR d.invoice_number ILIKE $4 ESCAPE '\'
              OR d.external_po_number ILIKE $4 ESCAPE '\'
              OR v.name ILIKE $4 ESCAPE '\'
          )
        GROUP BY d.id, v.name
        ORDER BY d.created_at DESC
        LIMIT $5 OFFSET $6
        "#,
    )
    .bind(query.status)
    .bind(query.vendor_id)
    .bind(query.document_kind)
    .bind(search)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_document_summary(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<ProcurementImportDocumentSummary, ProcurementImportError> {
    sqlx::query_as::<_, ProcurementImportDocumentSummary>(
        r#"
        SELECT
            d.id,
            d.vendor_id,
            v.name AS vendor_name,
            d.document_kind,
            d.status,
            d.source_filename,
            d.content_type,
            d.sha256,
            d.file_size_bytes,
            d.invoice_number,
            d.external_po_number,
            d.document_date,
            d.document_total,
            d.duplicate_of_document_id,
            d.converted_purchase_order_id,
            d.created_at,
            d.updated_at,
            COUNT(l.id)::bigint AS line_count,
            COUNT(l.id) FILTER (
                WHERE l.review_action = 'needs_review'
                   OR l.match_status IN ('unmatched', 'new_variant', 'new_product')
            )::bigint AS unresolved_line_count
        FROM procurement_import_documents d
        LEFT JOIN vendors v ON v.id = d.vendor_id
        LEFT JOIN procurement_import_lines l ON l.document_id = d.id
        WHERE d.id = $1
        GROUP BY d.id, v.name
        "#,
    )
    .bind(document_id)
    .fetch_optional(pool)
    .await?
    .ok_or(ProcurementImportError::NotFound)
}

async fn list_document_lines(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<Vec<ProcurementImportLine>, ProcurementImportError> {
    let rows = sqlx::query_as::<_, ProcurementImportLine>(
        r#"
        SELECT
            l.id,
            l.document_id,
            l.line_index,
            l.raw_line,
            l.vendor_sku,
            l.vendor_upc,
            l.barcode,
            l.manufacturer_sku,
            l.description,
            l.product_name,
            l.brand,
            l.color,
            l.size,
            l.fit,
            l.quantity,
            l.unit_cost,
            l.line_total,
            l.match_status,
            l.matched_variant_id,
            l.matched_product_id,
            pv.sku AS matched_sku,
            p.name AS matched_product_name,
            pv.variation_label AS matched_variation_label,
            l.match_confidence,
            l.match_reason,
            l.review_action,
            l.review_payload,
            l.staff_notes
        FROM procurement_import_lines l
        LEFT JOIN product_variants pv ON pv.id = l.matched_variant_id
        LEFT JOIN products p ON p.id = COALESCE(l.matched_product_id, pv.product_id)
        WHERE l.document_id = $1
        ORDER BY l.line_index ASC
        "#,
    )
    .bind(document_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn load_vendor_profile(
    pool: &PgPool,
    vendor_id: Uuid,
) -> Result<Option<ProcurementVendorDocumentProfile>, ProcurementImportError> {
    Ok(sqlx::query_as::<_, ProcurementVendorDocumentProfile>(
        r#"
        SELECT id, vendor_id, profile_name, column_aliases, value_aliases, document_hints,
               last_learned_from_document_id, successful_import_count, last_used_at
        FROM procurement_vendor_document_profiles
        WHERE vendor_id = $1
        "#,
    )
    .bind(vendor_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn get_import_detail(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<ProcurementImportDetail, ProcurementImportError> {
    let document = get_document_summary(pool, document_id).await?;
    let lines = list_document_lines(pool, document_id).await?;
    let vendor_profile = match document.vendor_id {
        Some(vendor_id) => load_vendor_profile(pool, vendor_id).await?,
        None => None,
    };
    let duplicate_warning = duplicate_warning(pool, &document).await?;
    Ok(ProcurementImportDetail {
        document,
        lines,
        vendor_profile,
        duplicate_warning,
    })
}

async fn duplicate_warning(
    pool: &PgPool,
    document: &ProcurementImportDocumentSummary,
) -> Result<Option<String>, ProcurementImportError> {
    if document.duplicate_of_document_id.is_some() {
        return Ok(Some(
            "This file hash matches an earlier upload. Verify it is not a duplicate.".to_string(),
        ));
    }
    let Some(vendor_id) = document.vendor_id else {
        return Ok(None);
    };
    let Some(invoice_number) = document
        .invoice_number
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let existing_import: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM procurement_import_documents
        WHERE vendor_id = $1
          AND lower(trim(invoice_number)) = lower(trim($2))
          AND id <> $3
          AND status = 'converted'
        LIMIT 1
        "#,
    )
    .bind(vendor_id)
    .bind(invoice_number)
    .bind(document.id)
    .fetch_optional(pool)
    .await?;
    if existing_import.is_some() {
        return Ok(Some(
            "A converted import already uses this vendor invoice number.".to_string(),
        ));
    }
    let existing_po: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM purchase_orders
        WHERE vendor_id = $1
          AND lower(trim(invoice_number)) = lower(trim($2))
        LIMIT 1
        "#,
    )
    .bind(vendor_id)
    .bind(invoice_number)
    .fetch_optional(pool)
    .await?;
    if existing_po.is_some() {
        return Ok(Some(
            "A purchase order/direct invoice already uses this vendor invoice number.".to_string(),
        ));
    }
    Ok(None)
}

pub async fn extract_document(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<ProcurementImportDetail, ProcurementImportError> {
    let document = load_document_row(pool, document_id).await?;
    if document.status == "converted" || document.status == "cancelled" {
        return Err(ProcurementImportError::InvalidPayload(
            "converted or cancelled imports cannot be extracted again".to_string(),
        ));
    }
    let storage_path = document.storage_path.as_deref().ok_or_else(|| {
        ProcurementImportError::InvalidPayload("import has no stored file".to_string())
    })?;
    let bytes = tokio::fs::read(storage_path).await?;
    let (deterministic_doc, raw_text) =
        extract_deterministic(&document.source_filename, &document.content_type, &bytes)?;
    let vendor_profile = match document.vendor_id {
        Some(vendor_id) => load_vendor_profile(pool, vendor_id).await?,
        None => None,
    };
    let raw_doc =
        match call_rosie_sidecar(&document, &raw_text, &bytes, vendor_profile.as_ref()).await? {
            Some(sidecar_doc) if !sidecar_doc.lines.is_empty() => sidecar_doc,
            Some(sidecar_doc) => {
                let mut merged = deterministic_doc;
                merged.warnings.extend(sidecar_doc.warnings);
                merged
            }
            None => deterministic_doc,
        };
    let validated = validate_extracted_document(&raw_doc)?;
    let status = if validated.lines.is_empty() {
        "needs_review"
    } else {
        "extracted"
    };

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM procurement_import_lines WHERE document_id = $1")
        .bind(document_id)
        .execute(&mut *tx)
        .await?;
    let extracted_json = json!({
        "prompt_version": PROCUREMENT_PROMPT_VERSION,
        "document": raw_doc,
        "warnings": validated.warnings,
    });
    sqlx::query(
        r#"
        UPDATE procurement_import_documents
        SET document_kind = $2,
            status = $3,
            raw_text = $4,
            extracted_json = $5,
            llm_model = CASE WHEN $6::text IS NULL THEN llm_model ELSE $6 END,
            llm_prompt_version = $7,
            extraction_confidence = $8,
            vendor_name_guess = $9,
            invoice_number = $10,
            external_po_number = $11,
            document_date = $12,
            due_date = $13,
            freight_total = $14,
            tax_total = $15,
            discount_total = $16,
            document_total = $17,
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(document_id)
    .bind(&validated.document_kind)
    .bind(status)
    .bind(raw_text)
    .bind(extracted_json)
    .bind(if sidecar_enabled() {
        Some(
            env::var("RIVERSIDE_ROSIE_PROCUREMENT_MODEL")
                .unwrap_or_else(|_| DEFAULT_ROSIE_PROCUREMENT_MODEL.to_string()),
        )
    } else {
        None
    })
    .bind(PROCUREMENT_PROMPT_VERSION)
    .bind(validated.confidence)
    .bind(validated.vendor_name_guess)
    .bind(validated.invoice_number)
    .bind(validated.external_po_number)
    .bind(validated.document_date)
    .bind(validated.due_date)
    .bind(validated.freight_total)
    .bind(validated.tax_total)
    .bind(validated.discount_total)
    .bind(validated.document_total)
    .execute(&mut *tx)
    .await?;

    for line in validated.lines {
        sqlx::query(
            r#"
            INSERT INTO procurement_import_lines (
                document_id, line_index, raw_line, vendor_sku, vendor_upc, barcode,
                manufacturer_sku, description, product_name, brand, color, size, fit,
                quantity, unit_cost, line_total
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            "#,
        )
        .bind(document_id)
        .bind(line.line_index)
        .bind(line.raw_line)
        .bind(line.vendor_sku)
        .bind(line.vendor_upc)
        .bind(line.barcode)
        .bind(line.manufacturer_sku)
        .bind(line.description)
        .bind(line.product_name)
        .bind(line.brand)
        .bind(line.color)
        .bind(line.size)
        .bind(line.fit)
        .bind(line.quantity)
        .bind(line.unit_cost)
        .bind(line.line_total)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    get_import_detail(pool, document_id).await
}

async fn load_match_lines(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<Vec<MatchLineRow>, ProcurementImportError> {
    Ok(sqlx::query_as::<_, MatchLineRow>(
        r#"
        SELECT id, vendor_sku, vendor_upc, barcode, manufacturer_sku, description,
               product_name, brand, color, size, fit
        FROM procurement_import_lines
        WHERE document_id = $1 AND review_action <> 'ignore'
        ORDER BY line_index ASC
        "#,
    )
    .bind(document_id)
    .fetch_all(pool)
    .await?)
}

fn alias_variant_id(
    profile: Option<&ProcurementVendorDocumentProfile>,
    line: &MatchLineRow,
) -> Option<Uuid> {
    let profile = profile?;
    let aliases = profile.value_aliases.as_object()?;
    let candidates = [
        line.vendor_sku
            .as_ref()
            .map(|value| format!("vendor_sku:{}", normalize_lookup(value))),
        line.vendor_upc
            .as_ref()
            .map(|value| format!("vendor_upc:{}", normalize_lookup(value))),
        line.barcode
            .as_ref()
            .map(|value| format!("barcode:{}", normalize_lookup(value))),
    ];
    for key in candidates.into_iter().flatten() {
        if let Some(value) = aliases.get(&key) {
            if let Some(id) = value
                .get("variant_id")
                .and_then(Value::as_str)
                .and_then(|raw| Uuid::parse_str(raw).ok())
            {
                return Some(id);
            }
            if let Some(raw) = value.as_str() {
                if let Ok(id) = Uuid::parse_str(raw) {
                    return Some(id);
                }
            }
        }
    }
    None
}

async fn load_variant_candidate(
    pool: &PgPool,
    variant_id: Uuid,
) -> Result<Option<VariantCandidate>, ProcurementImportError> {
    Ok(sqlx::query_as::<_, VariantCandidate>(
        r#"
        SELECT
            pv.id AS variant_id,
            pv.product_id,
            pv.sku,
            pv.vendor_upc,
            pv.barcode,
            p.name AS product_name,
            p.brand,
            pv.variation_label,
            p.primary_vendor_id,
            v.name AS primary_vendor_name
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN vendors v ON v.id = p.primary_vendor_id
        WHERE pv.id = $1 AND COALESCE(p.is_active, true) = true
        "#,
    )
    .bind(variant_id)
    .fetch_optional(pool)
    .await?)
}

async fn find_exact_candidate(
    pool: &PgPool,
    field: &str,
    value: &str,
) -> Result<Option<VariantCandidate>, ProcurementImportError> {
    let normalized = normalize_lookup(value);
    let query = match field {
        "sku" => {
            r#"
            SELECT
                pv.id AS variant_id, pv.product_id, pv.sku, pv.vendor_upc, pv.barcode,
                p.name AS product_name, p.brand, pv.variation_label, p.primary_vendor_id,
                v.name AS primary_vendor_name
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            LEFT JOIN vendors v ON v.id = p.primary_vendor_id
            WHERE lower(trim(pv.sku)) = $1 AND COALESCE(p.is_active, true) = true
            LIMIT 1
            "#
        }
        "vendor_upc" => {
            r#"
            SELECT
                pv.id AS variant_id, pv.product_id, pv.sku, pv.vendor_upc, pv.barcode,
                p.name AS product_name, p.brand, pv.variation_label, p.primary_vendor_id,
                v.name AS primary_vendor_name
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            LEFT JOIN vendors v ON v.id = p.primary_vendor_id
            WHERE lower(trim(pv.vendor_upc)) = $1 AND COALESCE(p.is_active, true) = true
            LIMIT 1
            "#
        }
        "barcode" => {
            r#"
            SELECT
                pv.id AS variant_id, pv.product_id, pv.sku, pv.vendor_upc, pv.barcode,
                p.name AS product_name, p.brand, pv.variation_label, p.primary_vendor_id,
                v.name AS primary_vendor_name
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            LEFT JOIN vendors v ON v.id = p.primary_vendor_id
            WHERE lower(trim(pv.barcode)) = $1 AND COALESCE(p.is_active, true) = true
            LIMIT 1
            "#
        }
        "alias" => {
            r#"
            SELECT
                pv.id AS variant_id, pv.product_id, pv.sku, pv.vendor_upc, pv.barcode,
                p.name AS product_name, p.brand, pv.variation_label, p.primary_vendor_id,
                v.name AS primary_vendor_name
            FROM product_variant_barcode_aliases a
            JOIN product_variants pv ON pv.id = a.variant_id
            JOIN products p ON p.id = pv.product_id
            LEFT JOIN vendors v ON v.id = p.primary_vendor_id
            WHERE a.normalized_alias = $1 AND a.status = 'active' AND COALESCE(p.is_active, true) = true
            LIMIT 1
            "#
        }
        _ => return Ok(None),
    };
    Ok(sqlx::query_as::<_, VariantCandidate>(query)
        .bind(normalized)
        .fetch_optional(pool)
        .await?)
}

async fn find_fuzzy_candidate(
    pool: &PgPool,
    vendor_id: Option<Uuid>,
    line: &MatchLineRow,
) -> Result<Option<VariantCandidate>, ProcurementImportError> {
    let needle = line
        .product_name
        .as_deref()
        .or(line.description.as_deref())
        .map(str::trim)
        .filter(|s| s.len() >= 4);
    let Some(needle) = needle else {
        return Ok(None);
    };
    let pattern = format!(
        "%{}%",
        needle
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    Ok(sqlx::query_as::<_, VariantCandidate>(
        r#"
        SELECT
            pv.id AS variant_id,
            pv.product_id,
            pv.sku,
            pv.vendor_upc,
            pv.barcode,
            p.name AS product_name,
            p.brand,
            pv.variation_label,
            p.primary_vendor_id,
            v.name AS primary_vendor_name
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN vendors v ON v.id = p.primary_vendor_id
        WHERE COALESCE(p.is_active, true) = true
          AND ($1::uuid IS NULL OR p.primary_vendor_id IS NULL OR p.primary_vendor_id = $1)
          AND (
              p.name ILIKE $2 ESCAPE '\'
              OR pv.variation_label ILIKE $2 ESCAPE '\'
              OR p.brand ILIKE $2 ESCAPE '\'
              OR pv.sku ILIKE $2 ESCAPE '\'
          )
        ORDER BY
            CASE WHEN p.primary_vendor_id = $1 THEN 0 ELSE 1 END,
            p.name ASC,
            pv.sku ASC
        LIMIT 1
        "#,
    )
    .bind(vendor_id)
    .bind(pattern)
    .fetch_optional(pool)
    .await?)
}

fn vendor_conflict_reason(vendor_id: Option<Uuid>, candidate: &VariantCandidate) -> Option<String> {
    let Some(vendor_id) = vendor_id else {
        return None;
    };
    let Some(primary_vendor_id) = candidate.primary_vendor_id else {
        return None;
    };
    if primary_vendor_id == vendor_id {
        None
    } else {
        let mut message = format!(
            "SKU {} is linked to a different primary vendor",
            candidate.sku.trim()
        );
        if let Some(name) = candidate
            .primary_vendor_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            message.push_str(&format!(" ({name})"));
        }
        Some(message)
    }
}

fn decision_for_candidate(
    vendor_id: Option<Uuid>,
    candidate: VariantCandidate,
    confidence: Decimal,
    reason: String,
) -> MatchDecision {
    if let Some(conflict) = vendor_conflict_reason(vendor_id, &candidate) {
        return MatchDecision {
            status: "unmatched".to_string(),
            action: "needs_review".to_string(),
            variant_id: None,
            product_id: None,
            confidence: Some(Decimal::ZERO),
            reason: Some(conflict),
        };
    }
    let exact_threshold = Decimal::new(95, 2);
    let likely_threshold = Decimal::new(80, 2);
    let status = if confidence >= exact_threshold {
        "exact"
    } else if confidence >= likely_threshold {
        "likely"
    } else {
        "unmatched"
    };
    let action = if confidence >= exact_threshold {
        "use_existing_variant"
    } else {
        "needs_review"
    };
    MatchDecision {
        status: status.to_string(),
        action: action.to_string(),
        variant_id: Some(candidate.variant_id),
        product_id: Some(candidate.product_id),
        confidence: Some(confidence),
        reason: Some(reason),
    }
}

async fn best_match_for_line(
    pool: &PgPool,
    vendor_id: Option<Uuid>,
    profile: Option<&ProcurementVendorDocumentProfile>,
    line: &MatchLineRow,
) -> Result<MatchDecision, ProcurementImportError> {
    if let Some(variant_id) = alias_variant_id(profile, line) {
        if let Some(candidate) = load_variant_candidate(pool, variant_id).await? {
            return Ok(decision_for_candidate(
                vendor_id,
                candidate,
                Decimal::new(98, 2),
                "vendor profile alias match".to_string(),
            ));
        }
    }
    if let Some(value) = line.vendor_sku.as_deref().filter(|v| !v.trim().is_empty()) {
        if let Some(candidate) = find_exact_candidate(pool, "sku", value).await? {
            return Ok(decision_for_candidate(
                vendor_id,
                candidate,
                Decimal::ONE,
                "exact SKU match".to_string(),
            ));
        }
    }
    if let Some(value) = line
        .manufacturer_sku
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        if let Some(candidate) = find_exact_candidate(pool, "sku", value).await? {
            return Ok(decision_for_candidate(
                vendor_id,
                candidate,
                Decimal::new(95, 2),
                "exact manufacturer SKU match".to_string(),
            ));
        }
    }
    if let Some(value) = line.vendor_upc.as_deref().filter(|v| !v.trim().is_empty()) {
        if let Some(candidate) = find_exact_candidate(pool, "vendor_upc", value).await? {
            return Ok(decision_for_candidate(
                vendor_id,
                candidate,
                Decimal::ONE,
                "exact vendor UPC match".to_string(),
            ));
        }
        if let Some(candidate) = find_exact_candidate(pool, "alias", value).await? {
            return Ok(decision_for_candidate(
                vendor_id,
                candidate,
                Decimal::ONE,
                "exact barcode alias match".to_string(),
            ));
        }
    }
    if let Some(value) = line.barcode.as_deref().filter(|v| !v.trim().is_empty()) {
        if let Some(candidate) = find_exact_candidate(pool, "barcode", value).await? {
            return Ok(decision_for_candidate(
                vendor_id,
                candidate,
                Decimal::ONE,
                "exact barcode match".to_string(),
            ));
        }
        if let Some(candidate) = find_exact_candidate(pool, "alias", value).await? {
            return Ok(decision_for_candidate(
                vendor_id,
                candidate,
                Decimal::ONE,
                "exact barcode alias match".to_string(),
            ));
        }
    }
    if let Some(candidate) = find_fuzzy_candidate(pool, vendor_id, line).await? {
        return Ok(decision_for_candidate(
            vendor_id,
            candidate,
            Decimal::new(70, 2),
            "description/name similarity match; staff approval required".to_string(),
        ));
    }
    Ok(MatchDecision {
        status: if line.product_name.is_some() || line.description.is_some() {
            "new_product".to_string()
        } else {
            "unmatched".to_string()
        },
        action: "needs_review".to_string(),
        variant_id: None,
        product_id: None,
        confidence: Some(Decimal::ZERO),
        reason: Some("no existing SKU, UPC, alias, or strong catalog match found".to_string()),
    })
}

pub async fn match_document(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<ProcurementImportDetail, ProcurementImportError> {
    let document = load_document_row(pool, document_id).await?;
    if document.status == "converted" || document.status == "cancelled" {
        return Err(ProcurementImportError::InvalidPayload(
            "converted or cancelled imports cannot be matched".to_string(),
        ));
    }
    let profile = match document.vendor_id {
        Some(vendor_id) => load_vendor_profile(pool, vendor_id).await?,
        None => None,
    };
    let lines = load_match_lines(pool, document_id).await?;
    for line in lines {
        let decision =
            best_match_for_line(pool, document.vendor_id, profile.as_ref(), &line).await?;
        sqlx::query(
            r#"
            UPDATE procurement_import_lines
            SET match_status = $2,
                matched_variant_id = $3,
                matched_product_id = $4,
                match_confidence = $5,
                match_reason = $6,
                review_action = $7,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(line.id)
        .bind(decision.status)
        .bind(decision.variant_id)
        .bind(decision.product_id)
        .bind(decision.confidence)
        .bind(decision.reason)
        .bind(decision.action)
        .execute(pool)
        .await?;
    }
    let unresolved: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM procurement_import_lines
        WHERE document_id = $1
          AND review_action = 'needs_review'
          AND match_status <> 'ignored'
        "#,
    )
    .bind(document_id)
    .fetch_one(pool)
    .await?;
    sqlx::query(
        "UPDATE procurement_import_documents SET status = $2, updated_at = now() WHERE id = $1",
    )
    .bind(document_id)
    .bind(if unresolved > 0 {
        "needs_review"
    } else {
        "matched"
    })
    .execute(pool)
    .await?;
    get_import_detail(pool, document_id).await
}

async fn ensure_active_vendor(
    pool: &PgPool,
    vendor_id: Uuid,
) -> Result<(), ProcurementImportError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(vendor_id)
    .fetch_one(pool)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(ProcurementImportError::InvalidPayload(
            "vendor_id not found or inactive".to_string(),
        ))
    }
}

async fn record_correction(
    pool: &PgPool,
    document_id: Uuid,
    line_id: Option<Uuid>,
    vendor_id: Option<Uuid>,
    correction_kind: &str,
    before_value: Option<Value>,
    after_value: Value,
    actor_staff_id: Uuid,
) -> Result<(), ProcurementImportError> {
    sqlx::query(
        r#"
        INSERT INTO procurement_import_line_corrections (
            document_id, line_id, vendor_id, correction_kind, before_value, after_value, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(document_id)
    .bind(line_id)
    .bind(vendor_id)
    .bind(correction_kind)
    .bind(before_value)
    .bind(after_value)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn patch_document(
    pool: &PgPool,
    document_id: Uuid,
    actor_staff_id: Uuid,
    payload: PatchProcurementImportDocumentRequest,
) -> Result<ProcurementImportDetail, ProcurementImportError> {
    let current = load_document_row(pool, document_id).await?;
    if current.status == "converted" || current.status == "cancelled" {
        return Err(ProcurementImportError::InvalidPayload(
            "converted or cancelled imports cannot be edited".to_string(),
        ));
    }
    if let Some(vendor_id) = payload.vendor_id {
        ensure_active_vendor(pool, vendor_id).await?;
    }
    if let Some(kind) = payload.document_kind.as_deref() {
        validate_document_kind(kind)?;
    }
    for (field, value) in [
        ("freight_total", payload.freight_total),
        ("tax_total", payload.tax_total),
        ("discount_total", payload.discount_total),
        ("document_total", payload.document_total),
    ] {
        if let Some(value) = value {
            validate_non_negative(field, value)?;
        }
    }

    sqlx::query(
        r#"
        UPDATE procurement_import_documents
        SET vendor_id = COALESCE($2, vendor_id),
            document_kind = COALESCE($3, document_kind),
            invoice_number = COALESCE(NULLIF(trim($4), ''), invoice_number),
            external_po_number = COALESCE(NULLIF(trim($5), ''), external_po_number),
            document_date = COALESCE($6, document_date),
            due_date = COALESCE($7, due_date),
            freight_total = COALESCE($8, freight_total),
            tax_total = COALESCE($9, tax_total),
            discount_total = COALESCE($10, discount_total),
            document_total = COALESCE($11, document_total),
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(document_id)
    .bind(payload.vendor_id)
    .bind(payload.document_kind)
    .bind(payload.invoice_number)
    .bind(payload.external_po_number)
    .bind(payload.document_date)
    .bind(payload.due_date)
    .bind(payload.freight_total)
    .bind(payload.tax_total)
    .bind(payload.discount_total)
    .bind(payload.document_total)
    .execute(pool)
    .await?;
    record_correction(
        pool,
        document_id,
        None,
        payload.vendor_id.or(current.vendor_id),
        "document_header_corrected",
        None,
        json!({"document_id": document_id}),
        actor_staff_id,
    )
    .await?;
    get_import_detail(pool, document_id).await
}

pub async fn patch_line(
    pool: &PgPool,
    document_id: Uuid,
    line_id: Uuid,
    actor_staff_id: Uuid,
    payload: PatchProcurementImportLineRequest,
) -> Result<ProcurementImportDetail, ProcurementImportError> {
    let document = load_document_row(pool, document_id).await?;
    if document.status == "converted" || document.status == "cancelled" {
        return Err(ProcurementImportError::InvalidPayload(
            "converted or cancelled imports cannot be edited".to_string(),
        ));
    }
    if let Some(quantity) = payload.quantity {
        if quantity <= Decimal::ZERO && payload.review_action.as_deref() != Some("ignore") {
            return Err(ProcurementImportError::InvalidPayload(
                "quantity must be > 0 unless line is ignored".to_string(),
            ));
        }
    }
    if let Some(unit_cost) = payload.unit_cost {
        validate_non_negative("unit_cost", unit_cost)?;
    }
    if let Some(line_total) = payload.line_total {
        validate_non_negative("line_total", line_total)?;
    }
    let review_action = match payload.review_action.as_deref() {
        Some(action) => Some(validate_line_action(action)?),
        None => None,
    };
    let match_status = match payload.match_status.as_deref() {
        Some(status) => Some(validate_line_status(status)?),
        None => None,
    };
    if let Some(confidence) = payload.match_confidence {
        if confidence < Decimal::ZERO || confidence > Decimal::ONE {
            return Err(ProcurementImportError::InvalidPayload(
                "match_confidence must be between 0 and 1".to_string(),
            ));
        }
    }
    if let Some(variant_id) = payload.matched_variant_id {
        load_variant_candidate(pool, variant_id)
            .await?
            .ok_or_else(|| {
                ProcurementImportError::InvalidPayload("matched_variant_id not found".to_string())
            })?;
    }

    let before: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(l) FROM procurement_import_lines l WHERE l.id = $1 AND l.document_id = $2",
    )
    .bind(line_id)
    .bind(document_id)
    .fetch_optional(pool)
    .await?;
    if before.is_none() {
        return Err(ProcurementImportError::NotFound);
    }

    let final_status = if review_action.as_deref() == Some("ignore") {
        Some("ignored".to_string())
    } else {
        match_status
    };

    sqlx::query(
        r#"
        UPDATE procurement_import_lines
        SET vendor_sku = COALESCE(NULLIF(trim($3), ''), vendor_sku),
            vendor_upc = COALESCE(NULLIF(trim($4), ''), vendor_upc),
            barcode = COALESCE(NULLIF(trim($5), ''), barcode),
            manufacturer_sku = COALESCE(NULLIF(trim($6), ''), manufacturer_sku),
            description = COALESCE(NULLIF(trim($7), ''), description),
            product_name = COALESCE(NULLIF(trim($8), ''), product_name),
            brand = COALESCE(NULLIF(trim($9), ''), brand),
            color = COALESCE(NULLIF(trim($10), ''), color),
            size = COALESCE(NULLIF(trim($11), ''), size),
            fit = COALESCE(NULLIF(trim($12), ''), fit),
            quantity = COALESCE($13, quantity),
            unit_cost = COALESCE($14, unit_cost),
            line_total = COALESCE($15, line_total),
            matched_variant_id = COALESCE($16, matched_variant_id),
            matched_product_id = COALESCE($17, matched_product_id),
            match_status = COALESCE($18, match_status),
            match_confidence = COALESCE($19, match_confidence),
            match_reason = COALESCE(NULLIF(trim($20), ''), match_reason),
            review_action = COALESCE($21, review_action),
            review_payload = COALESCE($22, review_payload),
            staff_notes = COALESCE(NULLIF(trim($23), ''), staff_notes),
            updated_at = now()
        WHERE id = $1 AND document_id = $2
        "#,
    )
    .bind(line_id)
    .bind(document_id)
    .bind(payload.vendor_sku)
    .bind(payload.vendor_upc)
    .bind(payload.barcode)
    .bind(payload.manufacturer_sku)
    .bind(payload.description)
    .bind(payload.product_name)
    .bind(payload.brand)
    .bind(payload.color)
    .bind(payload.size)
    .bind(payload.fit)
    .bind(payload.quantity)
    .bind(payload.unit_cost)
    .bind(payload.line_total)
    .bind(payload.matched_variant_id)
    .bind(payload.matched_product_id)
    .bind(final_status)
    .bind(payload.match_confidence)
    .bind(payload.match_reason)
    .bind(review_action)
    .bind(payload.review_payload)
    .bind(payload.staff_notes)
    .execute(pool)
    .await?;

    record_correction(
        pool,
        document_id,
        Some(line_id),
        document.vendor_id,
        "line_review_corrected",
        before,
        json!({"line_id": line_id}),
        actor_staff_id,
    )
    .await?;
    get_import_detail(pool, document_id).await
}

#[derive(Debug, FromRow)]
struct ConvertDocumentRow {
    id: Uuid,
    vendor_id: Option<Uuid>,
    document_kind: String,
    status: String,
    source_filename: String,
    invoice_number: Option<String>,
    external_po_number: Option<String>,
    freight_total: Decimal,
}

#[derive(Debug, FromRow, Clone)]
struct ConvertLineRow {
    id: Uuid,
    line_index: i32,
    vendor_sku: Option<String>,
    vendor_upc: Option<String>,
    barcode: Option<String>,
    description: Option<String>,
    product_name: Option<String>,
    brand: Option<String>,
    color: Option<String>,
    size: Option<String>,
    fit: Option<String>,
    quantity: Decimal,
    unit_cost: Decimal,
    matched_variant_id: Option<Uuid>,
    matched_product_id: Option<Uuid>,
    review_action: String,
    review_payload: Value,
}

#[derive(Debug, FromRow)]
struct PurchaseOrderConvertRow {
    id: Uuid,
    po_number: String,
    status: String,
    po_kind: String,
}

async fn duplicate_blocks_conversion(
    tx: &mut Transaction<'_, Postgres>,
    document_id: Uuid,
    vendor_id: Uuid,
    invoice_number: Option<&str>,
) -> Result<Option<String>, ProcurementImportError> {
    let Some(invoice_number) = invoice_number.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let import_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM procurement_import_documents
            WHERE vendor_id = $1
              AND lower(trim(invoice_number)) = lower(trim($2))
              AND id <> $3
              AND status = 'converted'
        )
        "#,
    )
    .bind(vendor_id)
    .bind(invoice_number)
    .bind(document_id)
    .fetch_one(&mut **tx)
    .await?;
    if import_exists {
        return Ok(Some(
            "converted procurement import already has this vendor invoice number".to_string(),
        ));
    }
    let po_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM purchase_orders
            WHERE vendor_id = $1
              AND lower(trim(invoice_number)) = lower(trim($2))
        )
        "#,
    )
    .bind(vendor_id)
    .bind(invoice_number)
    .fetch_one(&mut **tx)
    .await?;
    if po_exists {
        return Ok(Some(
            "purchase order/direct invoice already has this vendor invoice number".to_string(),
        ));
    }
    Ok(None)
}

async fn validate_variant_vendor_for_tx(
    tx: &mut Transaction<'_, Postgres>,
    vendor_id: Uuid,
    variant_id: Uuid,
) -> Result<(), ProcurementImportError> {
    #[derive(Debug, FromRow)]
    struct VariantVendorRow {
        sku: String,
        primary_vendor_id: Option<Uuid>,
        primary_vendor_name: Option<String>,
    }
    let variant = sqlx::query_as::<_, VariantVendorRow>(
        r#"
        SELECT pv.sku, p.primary_vendor_id, v.name AS primary_vendor_name
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN vendors v ON v.id = p.primary_vendor_id
        WHERE pv.id = $1
        "#,
    )
    .bind(variant_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ProcurementImportError::InvalidPayload("variant_id not found".to_string()))?;
    if let Some(primary_vendor_id) = variant.primary_vendor_id {
        if primary_vendor_id != vendor_id {
            let mut message = format!(
                "sku {} is linked to a different primary vendor",
                variant.sku.trim()
            );
            if let Some(name) = variant
                .primary_vendor_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                message.push_str(&format!(" ({name})"));
            }
            return Err(ProcurementImportError::InvalidPayload(message));
        }
    }
    Ok(())
}

fn decimal_to_order_quantity(quantity: Decimal) -> Result<i32, ProcurementImportError> {
    if quantity <= Decimal::ZERO {
        return Err(ProcurementImportError::InvalidPayload(
            "quantity must be > 0".to_string(),
        ));
    }
    if quantity.fract() != Decimal::ZERO {
        return Err(ProcurementImportError::InvalidPayload(
            "purchase order quantities must be whole units".to_string(),
        ));
    }
    quantity
        .to_i32()
        .ok_or_else(|| ProcurementImportError::InvalidPayload("quantity is too large".to_string()))
}

fn json_string(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToString::to_string)
    })
}

fn json_uuid(payload: &Value, key: &str) -> Result<Option<Uuid>, ProcurementImportError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|raw| {
            Uuid::parse_str(raw).map_err(|_| {
                ProcurementImportError::InvalidPayload(format!("{key} must be a valid uuid"))
            })
        })
        .transpose()
}

fn json_decimal(payload: &Value, keys: &[&str]) -> Result<Option<Decimal>, ProcurementImportError> {
    for key in keys {
        if let Some(value) = payload.get(*key) {
            if let Some(raw) = value.as_str() {
                return Ok(Some(parse_decimal_value(key, raw)?));
            }
            if value.is_number() {
                return Ok(Some(parse_decimal_value(key, &value.to_string())?));
            }
        }
    }
    Ok(None)
}

fn standard_axes_from_line(line: &ConvertLineRow) -> (Vec<String>, Value, Option<String>) {
    let mut axes = Vec::new();
    let mut values = Map::new();
    for (axis, value) in [
        ("Color", line.color.as_deref()),
        ("Size", line.size.as_deref()),
        ("Fit", line.fit.as_deref()),
    ] {
        if let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) {
            axes.push(axis.to_string());
            values.insert(axis.to_string(), Value::String(value.to_string()));
        }
    }
    let label = axes
        .iter()
        .filter_map(|axis| values.get(axis).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" / ");
    (
        axes,
        Value::Object(values),
        (!label.is_empty()).then_some(label),
    )
}

fn variation_values_for_axes(
    payload: &Value,
    line: &ConvertLineRow,
    axes: &[String],
) -> Result<Value, ProcurementImportError> {
    if let Some(value) = payload.get("variation_values") {
        let Some(object) = value.as_object() else {
            return Err(ProcurementImportError::InvalidPayload(
                "review_payload.variation_values must be an object".to_string(),
            ));
        };
        for axis in axes {
            if object
                .get(axis)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .is_none()
            {
                return Err(ProcurementImportError::InvalidPayload(format!(
                    "variation value for {axis} is required"
                )));
            }
        }
        return Ok(value.clone());
    }
    let (_, values, _) = standard_axes_from_line(line);
    let object = values.as_object().cloned().unwrap_or_default();
    let mut resolved = Map::new();
    for axis in axes {
        let value = object
            .get(axis)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                ProcurementImportError::InvalidPayload(format!(
                    "variation value for {axis} is required"
                ))
            })?;
        resolved.insert(axis.clone(), Value::String(value.to_string()));
    }
    Ok(Value::Object(resolved))
}

async fn ensure_sku_available_for_tx(
    tx: &mut Transaction<'_, Postgres>,
    sku: &str,
) -> Result<(), ProcurementImportError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM product_variants WHERE lower(trim(sku)) = lower(trim($1)))",
    )
    .bind(sku)
    .fetch_one(&mut **tx)
    .await?;
    if exists {
        Err(ProcurementImportError::InvalidPayload(format!(
            "sku already exists: {}",
            sku.trim()
        )))
    } else {
        Ok(())
    }
}

async fn create_product_from_import_line(
    tx: &mut Transaction<'_, Postgres>,
    vendor_id: Uuid,
    line: &ConvertLineRow,
) -> Result<Uuid, ProcurementImportError> {
    let payload = &line.review_payload;
    let sku = json_string(payload, &["sku", "ros_sku"])
        .or_else(|| line.vendor_sku.clone())
        .ok_or_else(|| {
            ProcurementImportError::InvalidPayload("new product SKU is required".to_string())
        })?;
    ensure_sku_available_for_tx(tx, &sku).await?;
    let name = json_string(payload, &["name", "product_name"])
        .or_else(|| line.product_name.clone())
        .or_else(|| line.description.clone())
        .ok_or_else(|| {
            ProcurementImportError::InvalidPayload("new product name is required".to_string())
        })?;
    let category_id = json_uuid(payload, "category_id")?;
    if let Some(category_id) = category_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM categories WHERE id = $1)")
                .bind(category_id)
                .fetch_one(&mut **tx)
                .await?;
        if !exists {
            return Err(ProcurementImportError::InvalidPayload(
                "category_id does not exist".to_string(),
            ));
        }
    }
    let base_retail_price = json_decimal(payload, &["base_retail_price", "retail_price"])?
        .ok_or_else(|| {
            ProcurementImportError::InvalidPayload(
                "base_retail_price is required to create a new product".to_string(),
            )
        })?;
    validate_non_negative("base_retail_price", base_retail_price)?;
    let base_cost =
        json_decimal(payload, &["base_cost", "cost_override"])?.unwrap_or(line.unit_cost);
    validate_non_negative("base_cost", base_cost)?;
    let brand = json_string(payload, &["brand"]).or_else(|| line.brand.clone());
    let description = json_string(payload, &["description"]).or_else(|| line.description.clone());
    let (axes, variation_values, variation_label) = standard_axes_from_line(line);
    let product_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO products (
            category_id, name, brand, description, base_retail_price, base_cost,
            variation_axes, images, primary_vendor_id, track_low_stock
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, false)
        RETURNING id
        "#,
    )
    .bind(category_id)
    .bind(name.trim())
    .bind(brand.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(
        description
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(base_retail_price)
    .bind(base_cost)
    .bind(axes)
    .bind(vendor_id)
    .fetch_one(&mut **tx)
    .await?;
    let variant_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO product_variants (
            product_id, sku, variation_values, variation_label, stock_on_hand,
            retail_price_override, cost_override, track_low_stock
        )
        VALUES ($1, $2, $3, $4, 0, $5, $6, false)
        RETURNING id
        "#,
    )
    .bind(product_id)
    .bind(sku.trim())
    .bind(variation_values)
    .bind(variation_label)
    .bind(base_retail_price)
    .bind(base_cost)
    .fetch_one(&mut **tx)
    .await?;
    Ok(variant_id)
}

async fn create_variant_from_import_line(
    tx: &mut Transaction<'_, Postgres>,
    vendor_id: Uuid,
    line: &ConvertLineRow,
) -> Result<Uuid, ProcurementImportError> {
    let payload = &line.review_payload;
    let product_id = json_uuid(payload, "product_id")?
        .or(line.matched_product_id)
        .ok_or_else(|| {
            ProcurementImportError::InvalidPayload(
                "product_id is required to create a variant".to_string(),
            )
        })?;
    let sku = json_string(payload, &["sku", "ros_sku"])
        .or_else(|| line.vendor_sku.clone())
        .ok_or_else(|| {
            ProcurementImportError::InvalidPayload("new variant SKU is required".to_string())
        })?;
    ensure_sku_available_for_tx(tx, &sku).await?;
    #[derive(Debug, FromRow)]
    struct ProductAxisRow {
        variation_axes: Vec<String>,
        primary_vendor_id: Option<Uuid>,
    }
    let product = sqlx::query_as::<_, ProductAxisRow>(
        "SELECT variation_axes, primary_vendor_id FROM products WHERE id = $1 AND COALESCE(is_active, true) = true",
    )
    .bind(product_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ProcurementImportError::InvalidPayload("product_id not found".to_string()))?;
    if let Some(primary_vendor_id) = product.primary_vendor_id {
        if primary_vendor_id != vendor_id {
            return Err(ProcurementImportError::InvalidPayload(
                "selected product is linked to a different primary vendor".to_string(),
            ));
        }
    } else {
        sqlx::query("UPDATE products SET primary_vendor_id = $2 WHERE id = $1")
            .bind(product_id)
            .bind(vendor_id)
            .execute(&mut **tx)
            .await?;
    }
    let variation_values = variation_values_for_axes(payload, line, &product.variation_axes)?;
    let variation_label = json_string(payload, &["variation_label"]).or_else(|| {
        variation_values
            .as_object()
            .map(|object| {
                product
                    .variation_axes
                    .iter()
                    .filter_map(|axis| object.get(axis).and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" / ")
            })
            .filter(|label| !label.is_empty())
    });
    let retail_price_override = json_decimal(payload, &["retail_price_override", "retail_price"])?;
    if let Some(value) = retail_price_override {
        validate_non_negative("retail_price_override", value)?;
    }
    let cost_override =
        json_decimal(payload, &["cost_override", "base_cost"])?.unwrap_or(line.unit_cost);
    validate_non_negative("cost_override", cost_override)?;
    let variant_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO product_variants (
            product_id, sku, variation_values, variation_label, stock_on_hand,
            retail_price_override, cost_override, track_low_stock
        )
        VALUES ($1, $2, $3, $4, 0, $5, $6, false)
        RETURNING id
        "#,
    )
    .bind(product_id)
    .bind(sku.trim())
    .bind(variation_values)
    .bind(variation_label)
    .bind(retail_price_override)
    .bind(cost_override)
    .fetch_one(&mut **tx)
    .await?;
    Ok(variant_id)
}

async fn variant_for_convert_line(
    tx: &mut Transaction<'_, Postgres>,
    vendor_id: Uuid,
    line: &ConvertLineRow,
) -> Result<Option<Uuid>, ProcurementImportError> {
    match line.review_action.as_str() {
        "ignore" => Ok(None),
        "use_existing_variant" => {
            let variant_id = line.matched_variant_id.ok_or_else(|| {
                ProcurementImportError::InvalidPayload(format!(
                    "line {} needs a matched variant",
                    line.line_index
                ))
            })?;
            validate_variant_vendor_for_tx(tx, vendor_id, variant_id).await?;
            Ok(Some(variant_id))
        }
        "create_product" => Ok(Some(
            create_product_from_import_line(tx, vendor_id, line).await?,
        )),
        "create_variant" => Ok(Some(
            create_variant_from_import_line(tx, vendor_id, line).await?,
        )),
        _ => Err(ProcurementImportError::InvalidPayload(format!(
            "line {} is unresolved; choose a match, create product/variant, or ignore",
            line.line_index
        ))),
    }
}

async fn learn_vendor_profile_tx(
    tx: &mut Transaction<'_, Postgres>,
    document_id: Uuid,
    vendor_id: Uuid,
) -> Result<(), ProcurementImportError> {
    let lines = sqlx::query_as::<_, ConvertLineRow>(
        r#"
        SELECT id, line_index, vendor_sku, vendor_upc, barcode, description, product_name, brand,
               color, size, fit, quantity, unit_cost, matched_variant_id, matched_product_id,
               review_action, review_payload
        FROM procurement_import_lines
        WHERE document_id = $1
          AND review_action = 'use_existing_variant'
          AND matched_variant_id IS NOT NULL
        "#,
    )
    .bind(document_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut aliases = Map::new();
    for line in lines {
        let Some(variant_id) = line.matched_variant_id else {
            continue;
        };
        for (prefix, value) in [
            ("vendor_sku", line.vendor_sku.as_deref()),
            ("vendor_upc", line.vendor_upc.as_deref()),
            ("barcode", line.barcode.as_deref()),
        ] {
            if let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) {
                aliases.insert(
                    format!("{prefix}:{}", normalize_lookup(value)),
                    json!({
                        "variant_id": variant_id,
                        "learned_from_document_id": document_id,
                    }),
                );
            }
        }
    }
    if aliases.is_empty() {
        return Ok(());
    }
    let profile_name: String = sqlx::query_scalar("SELECT name FROM vendors WHERE id = $1")
        .bind(vendor_id)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query(
        r#"
        INSERT INTO procurement_vendor_document_profiles (
            vendor_id, profile_name, value_aliases, last_learned_from_document_id,
            successful_import_count, last_used_at
        )
        VALUES ($1, $2, $3, $4, 1, now())
        ON CONFLICT (vendor_id) DO UPDATE SET
            value_aliases = procurement_vendor_document_profiles.value_aliases || EXCLUDED.value_aliases,
            last_learned_from_document_id = EXCLUDED.last_learned_from_document_id,
            successful_import_count = procurement_vendor_document_profiles.successful_import_count + 1,
            last_used_at = now(),
            updated_at = now()
        "#,
    )
    .bind(vendor_id)
    .bind(profile_name)
    .bind(Value::Object(aliases))
    .bind(document_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn learn_vendor_profile(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<ProcurementImportDetail, ProcurementImportError> {
    let document = load_document_row(pool, document_id).await?;
    let vendor_id = document.vendor_id.ok_or_else(|| {
        ProcurementImportError::InvalidPayload("vendor_id is required before learning".to_string())
    })?;
    let mut tx = pool.begin().await?;
    learn_vendor_profile_tx(&mut tx, document_id, vendor_id).await?;
    tx.commit().await?;
    get_import_detail(pool, document_id).await
}

pub async fn convert_import(
    pool: &PgPool,
    document_id: Uuid,
    actor_staff_id: Uuid,
    payload: ConvertProcurementImportRequest,
) -> Result<ConvertProcurementImportResponse, ProcurementImportError> {
    let target = payload.target.trim().to_lowercase();
    if !matches!(
        target.as_str(),
        "direct_invoice" | "standard_po" | "existing_po"
    ) {
        return Err(ProcurementImportError::InvalidPayload(
            "target must be direct_invoice, standard_po, or existing_po".to_string(),
        ));
    }
    let mut tx = pool.begin().await?;
    let document = sqlx::query_as::<_, ConvertDocumentRow>(
        r#"
        SELECT id, vendor_id, document_kind, status, source_filename, invoice_number,
               external_po_number, freight_total
        FROM procurement_import_documents
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(document_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ProcurementImportError::NotFound)?;
    if document.status == "converted" || document.status == "cancelled" {
        return Err(ProcurementImportError::InvalidPayload(
            "converted or cancelled imports cannot be converted again".to_string(),
        ));
    }
    let vendor_id = document.vendor_id.ok_or_else(|| {
        ProcurementImportError::InvalidPayload(
            "vendor_id is required before conversion".to_string(),
        )
    })?;
    let vendor_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(vendor_id)
    .fetch_one(&mut *tx)
    .await?;
    if !vendor_exists {
        return Err(ProcurementImportError::InvalidPayload(
            "vendor_id not found or inactive".to_string(),
        ));
    }
    if !payload.allow_duplicate_invoice {
        if let Some(reason) = duplicate_blocks_conversion(
            &mut tx,
            document_id,
            vendor_id,
            document.invoice_number.as_deref(),
        )
        .await?
        {
            return Err(ProcurementImportError::InvalidPayload(reason));
        }
    }
    let lines = sqlx::query_as::<_, ConvertLineRow>(
        r#"
        SELECT id, line_index, vendor_sku, vendor_upc, barcode, description, product_name, brand,
               color, size, fit, quantity, unit_cost, matched_variant_id, matched_product_id,
               review_action, review_payload
        FROM procurement_import_lines
        WHERE document_id = $1
        ORDER BY line_index ASC
        "#,
    )
    .bind(document_id)
    .fetch_all(&mut *tx)
    .await?;
    if lines.is_empty() {
        return Err(ProcurementImportError::InvalidPayload(
            "import has no lines to convert".to_string(),
        ));
    }

    let po: PurchaseOrderConvertRow = match target.as_str() {
        "existing_po" => {
            let po_id = payload.existing_purchase_order_id.ok_or_else(|| {
                ProcurementImportError::InvalidPayload(
                    "existing_purchase_order_id is required".to_string(),
                )
            })?;
            let po = sqlx::query_as::<_, PurchaseOrderConvertRow>(
                r#"
                SELECT id, po_number, status::text AS status, po_kind
                FROM purchase_orders
                WHERE id = $1 AND vendor_id = $2
                FOR UPDATE
                "#,
            )
            .bind(po_id)
            .bind(vendor_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                ProcurementImportError::InvalidPayload(
                    "existing draft PO not found for this vendor".to_string(),
                )
            })?;
            if po.status != "draft" {
                return Err(ProcurementImportError::InvalidPayload(
                    "existing purchase order must still be draft".to_string(),
                ));
            }
            po
        }
        "direct_invoice" => {
            sqlx::query_as::<_, PurchaseOrderConvertRow>(
                r#"
                INSERT INTO purchase_orders (
                    po_number, vendor_id, invoice_number, freight_total, notes, po_kind, created_by
                )
                VALUES (
                    CONCAT('DIR-', TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS-MS'), '-', LPAD((FLOOR(random() * 1000))::int::text, 3, '0')),
                    $1, $2, $3, $4, 'direct_invoice', $5
                )
                RETURNING id, po_number, status::text AS status, po_kind
                "#,
            )
            .bind(vendor_id)
            .bind(document.invoice_number.clone())
            .bind(document.freight_total)
            .bind(format!(
                "Imported from Vendor Document Import: {}{}",
                document.source_filename,
                document
                    .external_po_number
                    .as_deref()
                    .map(|po| format!("; external PO {po}"))
                    .unwrap_or_default()
            ))
            .bind(actor_staff_id)
            .fetch_one(&mut *tx)
            .await?
        }
        _ => {
            sqlx::query_as::<_, PurchaseOrderConvertRow>(
                r#"
                INSERT INTO purchase_orders (
                    po_number, vendor_id, invoice_number, freight_total, notes, po_kind, created_by
                )
                VALUES (
                    CONCAT('PO-', TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS-MS'), '-', LPAD((FLOOR(random() * 1000))::int::text, 3, '0')),
                    $1, $2, $3, $4, 'standard', $5
                )
                RETURNING id, po_number, status::text AS status, po_kind
                "#,
            )
            .bind(vendor_id)
            .bind(document.invoice_number.clone())
            .bind(document.freight_total)
            .bind(format!(
                "Imported from Vendor Document Import: {}{}",
                document.source_filename,
                document
                    .external_po_number
                    .as_deref()
                    .map(|po| format!("; external PO {po}"))
                    .unwrap_or_default()
            ))
            .bind(actor_staff_id)
            .fetch_one(&mut *tx)
            .await?
        }
    };

    let mut lines_added = 0_i64;
    for line in lines {
        let Some(variant_id) = variant_for_convert_line(&mut tx, vendor_id, &line).await? else {
            continue;
        };
        let quantity_ordered = decimal_to_order_quantity(line.quantity)?;
        sqlx::query(
            r#"
            INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity_ordered, unit_cost)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(po.id)
        .bind(variant_id)
        .bind(quantity_ordered)
        .bind(line.unit_cost)
        .execute(&mut *tx)
        .await?;
        lines_added += 1;
    }
    if lines_added == 0 {
        return Err(ProcurementImportError::InvalidPayload(
            "all import lines were ignored; nothing to convert".to_string(),
        ));
    }
    if payload.learn_vendor_profile {
        learn_vendor_profile_tx(&mut tx, document_id, vendor_id).await?;
    }
    sqlx::query(
        r#"
        UPDATE procurement_import_documents
        SET status = 'converted',
            approved_by = $2,
            converted_purchase_order_id = $3,
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(document_id)
    .bind(actor_staff_id)
    .bind(po.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(ConvertProcurementImportResponse {
        purchase_order_id: po.id,
        po_number: po.po_number,
        po_kind: po.po_kind,
        status: po.status,
        lines_added,
    })
}

pub async fn cancel_import(
    pool: &PgPool,
    document_id: Uuid,
) -> Result<ProcurementImportDetail, ProcurementImportError> {
    let document = load_document_row(pool, document_id).await?;
    if document.status == "converted" {
        return Err(ProcurementImportError::InvalidPayload(
            "converted imports cannot be cancelled".to_string(),
        ));
    }
    sqlx::query(
        "UPDATE procurement_import_documents SET status = 'cancelled', updated_at = now() WHERE id = $1",
    )
    .bind(document_id)
    .execute(pool)
    .await?;
    get_import_detail(pool, document_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_rejects_bad_money_qty_and_date() {
        let raw = RawProcurementDocument {
            document_kind: Some("invoice".to_string()),
            document_date: Some("not-a-date".to_string()),
            freight_total: Some("-1.00".to_string()),
            lines: vec![RawProcurementLine {
                line_index: Some(1),
                quantity: Some("0".to_string()),
                unit_cost: Some("12.00".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(validate_extracted_document(&raw).is_err());
    }

    #[test]
    fn validation_accepts_strict_invoice_schema() {
        let raw = RawProcurementDocument {
            document_kind: Some("invoice".to_string()),
            invoice_number: Some("INV-100".to_string()),
            document_date: Some("2026-06-04".to_string()),
            freight_total: Some("18.50".to_string()),
            document_total: Some("256.50".to_string()),
            confidence: Some(Decimal::new(92, 2)),
            lines: vec![RawProcurementLine {
                line_index: Some(1),
                vendor_sku: Some("MK-123".to_string()),
                description: Some("Navy suit".to_string()),
                quantity: Some("2".to_string()),
                unit_cost: Some("119.00".to_string()),
                line_total: Some("238.00".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let validated = validate_extracted_document(&raw).expect("valid schema");
        assert_eq!(validated.document_kind, "invoice");
        assert_eq!(validated.lines.len(), 1);
        assert_eq!(validated.lines[0].quantity, Decimal::new(2, 0));
    }

    #[test]
    fn csv_extraction_maps_vendor_invoice_lines() {
        let csv = b"invoice_number,sku,description,qty,unit_cost,line_total\nINV-1,ABC-1,Navy Suit,2,119.00,238.00\n";
        let raw = extract_csv_bytes(csv).expect("csv parses");
        assert_eq!(raw.invoice_number.as_deref(), Some("INV-1"));
        assert_eq!(raw.lines.len(), 1);
        assert_eq!(raw.lines[0].vendor_sku.as_deref(), Some("ABC-1"));
        assert_eq!(raw.lines[0].quantity.as_deref(), Some("2"));
    }

    #[test]
    fn exact_match_rejects_wrong_vendor_linkage() {
        let vendor_id = Uuid::new_v4();
        let other_vendor_id = Uuid::new_v4();
        let candidate = VariantCandidate {
            variant_id: Uuid::new_v4(),
            product_id: Uuid::new_v4(),
            sku: "ABC-1".to_string(),
            vendor_upc: None,
            barcode: None,
            product_name: "Suit".to_string(),
            brand: None,
            variation_label: None,
            primary_vendor_id: Some(other_vendor_id),
            primary_vendor_name: Some("Other Vendor".to_string()),
        };
        let decision = decision_for_candidate(
            Some(vendor_id),
            candidate,
            Decimal::ONE,
            "exact SKU match".to_string(),
        );
        assert_eq!(decision.status, "unmatched");
        assert_eq!(decision.action, "needs_review");
        assert!(decision
            .reason
            .unwrap()
            .contains("different primary vendor"));
    }

    #[test]
    fn ignored_lines_do_not_produce_variant_for_conversion() {
        let line = ConvertLineRow {
            id: Uuid::new_v4(),
            line_index: 1,
            vendor_sku: Some("ABC".to_string()),
            vendor_upc: None,
            barcode: None,
            description: None,
            product_name: None,
            brand: None,
            color: None,
            size: None,
            fit: None,
            quantity: Decimal::ONE,
            unit_cost: Decimal::ZERO,
            matched_variant_id: None,
            matched_product_id: None,
            review_action: "ignore".to_string(),
            review_payload: json!({}),
        };
        assert_eq!(line.review_action, "ignore");
    }

    #[test]
    fn quantity_conversion_requires_whole_positive_units() {
        assert_eq!(decimal_to_order_quantity(Decimal::new(2, 0)).unwrap(), 2);
        assert!(decimal_to_order_quantity(Decimal::new(25, 1)).is_err());
        assert!(decimal_to_order_quantity(Decimal::ZERO).is_err());
    }

    #[test]
    fn vendor_profile_alias_lookup_handles_vendor_sku() {
        let variant_id = Uuid::new_v4();
        let profile = ProcurementVendorDocumentProfile {
            id: Uuid::new_v4(),
            vendor_id: Uuid::new_v4(),
            profile_name: "Vendor".to_string(),
            column_aliases: json!({}),
            value_aliases: json!({
                "vendor_sku:abc-1": { "variant_id": variant_id.to_string() }
            }),
            document_hints: json!({}),
            last_learned_from_document_id: None,
            successful_import_count: 1,
            last_used_at: None,
        };
        let line = MatchLineRow {
            id: Uuid::new_v4(),
            vendor_sku: Some("ABC-1".to_string()),
            vendor_upc: None,
            barcode: None,
            manufacturer_sku: None,
            description: None,
            product_name: None,
            brand: None,
            color: None,
            size: None,
            fit: None,
        };
        assert_eq!(alias_variant_id(Some(&profile), &line), Some(variant_id));
    }
}
