//! Counterpoint → ROS ingest (Windows bridge). One-way upserts into PostgreSQL.
//! Covers: customers, inventory, catalog (products + variants), gift cards,
//! ticket history (transactions + payments + optional PS_TKT_HIST_GFT), open docs,
//! vendor items (PO_VEND_ITEM), loyalty history (PS_LOY_PTS_HIST), and heartbeat / sync status.
//! Ticket and open-doc transactions are only inserted after **every** line resolves to a variant
//! (no partial transactions with mismatched totals).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, PgPool, Postgres, QueryBuilder, Transaction};
use thiserror::Error;
use uuid::Uuid;

use crate::logic::{integration_credentials, store_credit};

const HISTORICAL_FALLBACK_SKU: &str = "HIST-CP-FALLBACK";
const HISTORICAL_FALLBACK_NAME: &str = "Historical Counterpoint Sale (Item Unresolved)";
const COUNTERPOINT_IMPORT_HISTORY_START: &str = "2018-01-01";
const COUNTERPOINT_TICKET_SUSPICIOUS_MIN: i64 = 1_000;
const COUNTERPOINT_OPEN_DOC_SUSPICIOUS_MIN: i64 = 100;

#[derive(Debug, Error)]
pub enum CounterpointSyncError {
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SyncCursorIn {
    pub entity: String,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointSnapshotSourceMetricsPayload {
    pub snapshot: String,
    pub source_count: i64,
    #[serde(default)]
    pub source_sum: Decimal,
    #[serde(default)]
    pub source_checksum: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CounterpointImportSourceCountPayload {
    pub entity_key: String,
    pub label: String,
    #[serde(default)]
    pub source_count: i64,
    #[serde(default)]
    pub source_sum: Option<Decimal>,
    #[serde(default)]
    pub source_checksum: Option<String>,
    #[serde(default)]
    pub query_key: Option<String>,
    #[serde(default = "default_true")]
    pub required: bool,
    #[serde(default)]
    pub suspicious_min_count: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub metadata: JsonValue,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointImportPreflightPayload {
    #[serde(default)]
    pub history_start: Option<String>,
    #[serde(default)]
    pub bridge_hostname: Option<String>,
    #[serde(default)]
    pub bridge_version: Option<String>,
    #[serde(default)]
    pub ros_base_url: Option<String>,
    #[serde(default)]
    pub source_fingerprint: Option<String>,
    #[serde(default = "default_true")]
    pub import_first: bool,
    #[serde(default)]
    pub staging_enabled: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub startup_issues: Vec<String>,
    #[serde(default)]
    pub counts: Vec<CounterpointImportSourceCountPayload>,
    #[serde(default)]
    pub metadata: JsonValue,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointImportPreflightBlocker {
    pub entity_key: Option<String>,
    pub reason_code: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointImportPreflightRow {
    pub entity_key: String,
    pub label: String,
    pub source_count: i64,
    pub source_sum: Option<String>,
    pub source_checksum: Option<String>,
    pub required: bool,
    pub suspicious_min_count: Option<i64>,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointImportPreflightSummary {
    pub import_run_id: Uuid,
    pub preflight_passed: bool,
    pub history_start: String,
    pub bridge_hostname: Option<String>,
    pub bridge_version: Option<String>,
    pub ros_base_url: Option<String>,
    pub source_fingerprint: Option<String>,
    pub blockers: Vec<CounterpointImportPreflightBlocker>,
    pub counts: Vec<CounterpointImportPreflightRow>,
    pub ready_for_import: bool,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointImportRunStartPayload {
    #[serde(default)]
    pub preflight_import_run_id: Option<Uuid>,
    #[serde(default)]
    pub run_kind: Option<String>,
    #[serde(default)]
    pub bridge_hostname: Option<String>,
    #[serde(default)]
    pub bridge_version: Option<String>,
    #[serde(default)]
    pub ros_base_url: Option<String>,
    #[serde(default)]
    pub source_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointImportRunStartSummary {
    pub import_run_id: Uuid,
    pub preflight_import_run_id: Uuid,
    pub run_kind: String,
    pub status: String,
    pub history_start: String,
    pub ready_for_import: bool,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointImportRunCompletePayload {
    pub import_run_id: Uuid,
    #[serde(default)]
    pub failed: bool,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub totals: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointImportBatchProofSummary {
    pub import_run_id: Uuid,
    pub entity_key: String,
    pub raw_records: i64,
    pub landed_records: i64,
    pub provenance_records: i64,
    pub exception_records: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CounterpointCustomerRow {
    /// Becomes `customers.customer_code` (Counterpoint `CUST_NO`).
    pub cust_no: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    /// Counterpoint `NAM` when bridge does not split names.
    #[serde(default)]
    pub full_name: Option<String>,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
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
    #[serde(default)]
    pub date_of_birth: Option<String>,
    #[serde(default)]
    pub marketing_email_opt_in: Option<bool>,
    #[serde(default)]
    pub marketing_sms_opt_in: Option<bool>,
    /// Counterpoint `PTS_BAL` → `customers.loyalty_points`.
    #[serde(default)]
    pub loyalty_points: Option<i32>,
    /// Counterpoint `CUST_TYP` → `customers.custom_field_1` (customer type tag).
    #[serde(default)]
    pub customer_type: Option<String>,
    /// Counterpoint A/R `BAL` → `customers.custom_field_2` (as string for reference).
    #[serde(default, deserialize_with = "deserialize_optional_stringish")]
    pub ar_balance: Option<String>,
    /// Counterpoint `SLS_REP` → `customers.preferred_salesperson_id` (resolved via staff map).
    #[serde(default)]
    pub sls_rep: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointCustomerBatchSummary {
    pub created: i32,
    pub updated: i32,
    pub skipped: i32,
    pub email_conflicts: i32,
}

#[derive(Debug, Clone)]
struct CounterpointCustomerEmailConflict {
    customer_code: String,
    original_email: String,
    reason: String,
    source_payload: JsonValue,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCustomersPayload {
    pub rows: Vec<CounterpointCustomerRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CounterpointInventoryRow {
    pub sku: String,
    pub stock_on_hand: i32,
    #[serde(default)]
    pub counterpoint_item_key: Option<String>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointInventoryPayload {
    pub rows: Vec<CounterpointInventoryRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointInventorySummary {
    pub updated: i32,
    pub skipped: i32,
    pub quarantined: i32,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointIdentityPreflightReference {
    pub row_number: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_number: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIdentityPreflightSampleRow {
    pub reference: CounterpointIdentityPreflightReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_sku: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterpoint_item_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_key: Option<String>,
    pub option_values: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIdentityPreflightIssue {
    pub issue_type: String,
    pub severity: String,
    pub message: String,
    pub affected_row_count: usize,
    pub affects_ingest_rows: bool,
    pub should_quarantine: bool,
    pub safe_to_continue_other_rows: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_sku: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterpoint_item_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_key: Option<String>,
    pub references: Vec<CounterpointIdentityPreflightReference>,
    pub sample_rows: Vec<CounterpointIdentityPreflightSampleRow>,
    pub values: Vec<String>,
    #[serde(skip)]
    all_references: Vec<CounterpointIdentityPreflightReference>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIdentityPreflightSummary {
    pub entity: String,
    pub total_rows: usize,
    pub variant_rows_checked: usize,
    pub has_errors: bool,
    pub issue_count: usize,
    pub affected_row_count: usize,
    pub info_count: usize,
    pub warning_count: usize,
    pub quarantine_count: usize,
    pub blocking_count: usize,
    pub has_blocking_issues: bool,
    pub invalid_sku_rows: usize,
    pub duplicate_normalized_b_sku_values: usize,
    pub duplicate_counterpoint_item_key_values: usize,
    pub conflicting_sku_family_values: usize,
    pub conflicting_sku_counterpoint_item_key_values: usize,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIdentityPreflightReport {
    pub summary: CounterpointIdentityPreflightSummary,
    pub issues: Vec<CounterpointIdentityPreflightIssue>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CounterpointIngestQuarantineCount {
    pub key: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct CounterpointIngestQuarantineSummary {
    pub total_records: i64,
    pub info_records: i64,
    pub warning_records: i64,
    pub quarantine_records: i64,
    pub blocking_records: i64,
    pub latest_created_at: Option<DateTime<Utc>>,
    pub by_severity: Vec<CounterpointIngestQuarantineCount>,
    pub by_ingest_type: Vec<CounterpointIngestQuarantineCount>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CounterpointIngestQuarantineRow {
    pub id: i64,
    pub ingest_type: String,
    pub issue_type: String,
    pub severity: String,
    pub message: String,
    pub normalized_sku: Option<String>,
    pub counterpoint_item_key: Option<String>,
    pub family_key: Option<String>,
    pub option_values: serde_json::Value,
    pub source_reference: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointRegistryHealthSummary {
    pub status: String,
    pub counterpoint_products: i64,
    pub counterpoint_variants: i64,
    pub variants_with_counterpoint_item_key: i64,
    pub variants_missing_counterpoint_item_key: i64,
    pub duplicate_normalized_sku_values: i64,
    pub duplicate_counterpoint_item_key_values: i64,
    pub quarantine_record_count: i64,
    pub latest_ingest_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointBarcodeAliasHealthSummary {
    pub total_aliases: i64,
    pub active_aliases: i64,
    pub duplicate_active_alias_conflicts: i64,
    pub latest_created_at: Option<DateTime<Utc>>,
    pub by_type: Vec<CounterpointIngestQuarantineCount>,
    pub by_status: Vec<CounterpointIngestQuarantineCount>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointBarcodeAliasPreflightRow {
    pub sku: String,
    #[serde(default)]
    pub family_key: Option<String>,
    #[serde(default)]
    pub option_values: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointBarcodeAliasPreflightPayload {
    pub rows: Vec<CounterpointBarcodeAliasPreflightRow>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointBarcodeAliasPersistRow {
    pub sku: String,
    #[serde(default)]
    pub family_key: Option<String>,
    #[serde(default)]
    pub option_values: Vec<String>,
    #[serde(default)]
    pub source_row_number: Option<i32>,
    #[serde(default)]
    pub source_row_hash: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointBarcodeAliasPersistPayload {
    pub source_file_name: String,
    #[serde(default)]
    pub source_file_hash: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub replace: bool,
    pub rows: Vec<CounterpointBarcodeAliasPersistRow>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointBarcodeAliasPreflightSummary {
    pub total_rows: usize,
    pub mappable: usize,
    pub duplicate_b_sku: usize,
    pub ambiguous_variant_match: usize,
    pub no_ros_variant_match: usize,
    pub missing_family: usize,
    pub invalid_non_b_sku: usize,
    pub existing_barcode_conflict: usize,
}

#[derive(Debug, Serialize)]
pub struct CounterpointBarcodeAliasPreflightExample {
    pub row_number: usize,
    pub classification: String,
    pub b_sku: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_key: Option<String>,
    pub option_values: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_variant_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterpoint_item_key: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointBarcodeAliasPreflightReport {
    pub summary: CounterpointBarcodeAliasPreflightSummary,
    pub examples: Vec<CounterpointBarcodeAliasPreflightExample>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointBarcodeAliasPersistSummary {
    pub total_rows: usize,
    pub mappable_aliases: usize,
    pub would_insert_aliases: usize,
    pub inserted_aliases: usize,
    pub deleted_existing_counterpoint_b_sku_aliases: u64,
    pub already_existing_identical_aliases: usize,
    pub skipped_duplicate_b_sku: usize,
    pub skipped_ambiguous_variant_match: usize,
    pub skipped_no_ros_variant_match: usize,
    pub skipped_missing_family: usize,
    pub skipped_invalid_non_b_sku: usize,
    pub skipped_existing_barcode_conflict: usize,
    pub conflicts: usize,
    pub dry_run: bool,
    pub replace: bool,
}

#[derive(Debug, Serialize)]
pub struct CounterpointBarcodeAliasPersistReport {
    pub summary: CounterpointBarcodeAliasPersistSummary,
    pub preflight_summary: CounterpointBarcodeAliasPreflightSummary,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointNormalizationPreviewOption {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointNormalizationPreviewRow {
    pub sku: String,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub product_category: Option<String>,
    #[serde(default)]
    pub supplier_name: Option<String>,
    #[serde(default)]
    pub supplier_code: Option<String>,
    #[serde(default)]
    pub brand_name: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub variant_options: Vec<CounterpointNormalizationPreviewOption>,
    #[serde(default)]
    pub source_row_number: Option<i32>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointNormalizationPreviewPayload {
    #[serde(default)]
    pub source_file_name: Option<String>,
    pub rows: Vec<CounterpointNormalizationPreviewRow>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LightspeedNormalizationReferenceImportRow {
    pub sku: String,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub product_category: Option<String>,
    #[serde(default)]
    pub supplier_name: Option<String>,
    #[serde(default)]
    pub supplier_code: Option<String>,
    #[serde(default)]
    pub brand_name: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub variant_options: Vec<CounterpointNormalizationPreviewOption>,
    pub source_row_number: i32,
    pub source_row_hash: String,
    pub raw_row: serde_json::Value,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LightspeedNormalizationReferenceImportPayload {
    pub source_file_name: String,
    pub source_file_hash: String,
    #[serde(default)]
    pub replace: bool,
    pub rows: Vec<LightspeedNormalizationReferenceImportRow>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LightspeedNormalizationReferenceBatchSummary {
    pub id: Uuid,
    pub source_file_name: String,
    pub source_file_hash: String,
    pub row_count: i32,
    pub status: String,
    pub imported_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct LightspeedNormalizationReferenceHealthSummary {
    pub active_batch: Option<LightspeedNormalizationReferenceBatchSummary>,
    pub row_count: i64,
    pub b_sku_count: i64,
    pub duplicate_b_sku_groups: i64,
    pub latest_imported_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct LightspeedNormalizationReferenceImportSummary {
    pub active_batch: LightspeedNormalizationReferenceBatchSummary,
    pub inserted_rows: usize,
    pub replaced_existing_batches: bool,
    pub health: LightspeedNormalizationReferenceHealthSummary,
}

#[derive(Debug, Serialize)]
pub struct CounterpointNormalizationPreviewSummary {
    pub total_lightspeed_rows: usize,
    pub lightspeed_b_sku_rows: usize,
    pub matched_aliases: usize,
    pub clean_candidates: usize,
    pub excluded_rows: usize,
    pub duplicate_lightspeed_b_sku_rows: usize,
    pub invalid_non_b_sku_rows: usize,
    pub no_active_alias_rows: usize,
    pub duplicate_active_alias_conflict_rows: usize,
    pub name_differences: usize,
    pub category_differences: usize,
    pub supplier_differences: usize,
    pub variant_option_differences: usize,
}

#[derive(Debug, Serialize)]
pub struct CounterpointNormalizationVariantOptionOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointNormalizationDifferenceFlags {
    pub product_name: bool,
    pub category: bool,
    pub supplier: bool,
    pub variant_options: bool,
}

#[derive(Debug, Serialize)]
pub struct CounterpointNormalizationCandidateExample {
    pub row_number: Option<i32>,
    pub b_sku: String,
    pub variant_id: Uuid,
    pub product_id: Uuid,
    pub counterpoint_item_key: Option<String>,
    pub family_key: Option<String>,
    pub lightspeed_handle: Option<String>,
    pub ros_product_name: String,
    pub lightspeed_product_name: Option<String>,
    pub ros_category: Option<String>,
    pub lightspeed_category: Option<String>,
    pub ros_supplier_name: Option<String>,
    pub ros_supplier_code: Option<String>,
    pub lightspeed_supplier_name: Option<String>,
    pub lightspeed_supplier_code: Option<String>,
    pub ros_variant_options: Vec<CounterpointNormalizationVariantOptionOut>,
    pub lightspeed_variant_options: Vec<CounterpointNormalizationVariantOptionOut>,
    pub differences: CounterpointNormalizationDifferenceFlags,
}

#[derive(Debug, Serialize)]
pub struct CounterpointNormalizationExcludedExample {
    pub row_number: Option<i32>,
    pub b_sku: String,
    pub reason: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointNormalizationPreviewReport {
    pub source_file_name: Option<String>,
    pub source_authority: String,
    pub excluded_fields: Vec<String>,
    pub summary: CounterpointNormalizationPreviewSummary,
    pub candidates: Vec<CounterpointNormalizationCandidateExample>,
    pub excluded_examples: Vec<CounterpointNormalizationExcludedExample>,
}

struct CounterpointInventoryQuarantineFilter {
    payload: CounterpointInventoryPayload,
    records: Vec<CounterpointIngestQuarantineRecord>,
    total_rows: usize,
    quarantined: i32,
}

struct CounterpointCatalogQuarantineFilter {
    payload: CounterpointCatalogPayload,
    records: Vec<CounterpointIngestQuarantineRecord>,
    quarantined: i32,
}

struct CounterpointIngestQuarantineRecord {
    ingest_type: &'static str,
    issue_type: String,
    severity: String,
    message: String,
    normalized_sku: Option<String>,
    counterpoint_item_key: Option<String>,
    family_key: Option<String>,
    option_values: Vec<String>,
    source_reference: serde_json::Value,
    source_row: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointReceivingRow {
    pub vend_no: String,
    pub item_no: String,
    pub recv_dat: String,
    pub unit_cost: Decimal,
    pub qty_recv: Decimal,
    #[serde(default)]
    pub po_no: Option<String>,
    #[serde(default)]
    pub recv_no: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointReceivingPayload {
    pub rows: Vec<CounterpointReceivingRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointReceivingSummary {
    pub inserted: i32,
    pub skipped: i32,
}

fn trim_opt(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|x| x.trim())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
}

fn deserialize_optional_stringish<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(trim_str_opt(Some(&s))),
        Some(serde_json::Value::Number(n)) => Ok(Some(n.to_string())),
        Some(serde_json::Value::Bool(b)) => Ok(Some(b.to_string())),
        Some(other) => Err(de::Error::custom(format!(
            "expected string, number, boolean, or null; got {other}"
        ))),
    }
}

fn trim_str_opt(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
}

fn collapse_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn compact_upper(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

const COUNTERPOINT_IDENTITY_PREFLIGHT_EXAMPLE_LIMIT: usize = 50;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum CounterpointIdentityPreflightSeverity {
    Info,
    Warning,
    Quarantine,
    Blocking,
}

impl CounterpointIdentityPreflightSeverity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warning => "WARNING",
            Self::Quarantine => "QUARANTINE",
            Self::Blocking => "BLOCKING",
        }
    }
}

#[derive(Debug)]
struct CounterpointIdentityPreflightRow {
    reference: CounterpointIdentityPreflightReference,
    normalized_sku: Option<String>,
    counterpoint_item_key: Option<String>,
    family_key: Option<String>,
    option_values: Vec<String>,
}

fn normalize_identity_key(raw: &str) -> Option<String> {
    let normalized = collapse_whitespace(raw).to_uppercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn is_valid_counterpoint_b_sku(normalized_sku: &str) -> bool {
    let Some(rest) = normalized_sku.strip_prefix("B-") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
}

fn is_counterpoint_parent_item_sku(normalized_sku: &str) -> bool {
    let Some(rest) = normalized_sku.strip_prefix("I-") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
}

fn is_generated_or_service_sku(normalized_sku: &str) -> bool {
    normalized_sku.bytes().all(|b| b.is_ascii_digit()) || normalized_sku == "PAYMENT"
}

fn normalize_counterpoint_family_key(key: &str) -> Option<String> {
    key.split('|').next().and_then(normalize_identity_key)
}

fn option_values_from_counterpoint_item_key(counterpoint_item_key: Option<&str>) -> Vec<String> {
    counterpoint_item_key
        .into_iter()
        .flat_map(|key| key.split('|').skip(1))
        .filter_map(normalize_identity_key)
        .collect()
}

fn option_values_from_variation_label(variation_label: Option<&str>) -> Vec<String> {
    variation_label
        .into_iter()
        .flat_map(|label| label.split('/'))
        .filter_map(normalize_identity_key)
        .collect()
}

fn option_values_from_variation_values(
    variation_values: Option<&serde_json::Value>,
) -> Vec<String> {
    let Some(value) = variation_values else {
        return Vec::new();
    };

    match value {
        serde_json::Value::Array(values) => values
            .iter()
            .filter_map(|value| value.as_str().and_then(normalize_identity_key))
            .collect(),
        serde_json::Value::Object(map) => map
            .iter()
            .filter_map(|(_, value)| match value {
                serde_json::Value::String(raw) => normalize_identity_key(raw),
                serde_json::Value::Number(number) => normalize_identity_key(&number.to_string()),
                serde_json::Value::Bool(value) => normalize_identity_key(&value.to_string()),
                _ => None,
            })
            .collect(),
        serde_json::Value::String(raw) => normalize_identity_key(raw).into_iter().collect(),
        serde_json::Value::Number(number) => normalize_identity_key(&number.to_string())
            .into_iter()
            .collect(),
        serde_json::Value::Bool(value) => normalize_identity_key(&value.to_string())
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

fn normalized_alias_option_values(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| normalize_identity_key(value))
        .filter(|value| value != "_" && value != "*")
        .collect()
}

fn normalized_counterpoint_variant_option_values(
    counterpoint_item_key: Option<&str>,
    variation_values: Option<&serde_json::Value>,
    variation_label: Option<&str>,
) -> Vec<String> {
    let mut option_values = option_values_from_counterpoint_item_key(counterpoint_item_key);
    if option_values.is_empty() {
        option_values = option_values_from_variation_values(variation_values);
    }
    if option_values.is_empty() {
        option_values = option_values_from_variation_label(variation_label);
    }
    normalized_alias_option_values(&option_values)
}

fn limited_refs(
    rows: &[&CounterpointIdentityPreflightRow],
) -> Vec<CounterpointIdentityPreflightReference> {
    rows.iter()
        .take(COUNTERPOINT_IDENTITY_PREFLIGHT_EXAMPLE_LIMIT)
        .map(|row| row.reference.clone())
        .collect()
}

fn all_refs(
    rows: &[&CounterpointIdentityPreflightRow],
) -> Vec<CounterpointIdentityPreflightReference> {
    rows.iter().map(|row| row.reference.clone()).collect()
}

fn limited_sample_rows(
    rows: &[&CounterpointIdentityPreflightRow],
) -> Vec<CounterpointIdentityPreflightSampleRow> {
    rows.iter()
        .take(COUNTERPOINT_IDENTITY_PREFLIGHT_EXAMPLE_LIMIT)
        .map(|row| CounterpointIdentityPreflightSampleRow {
            reference: row.reference.clone(),
            normalized_sku: row.normalized_sku.clone(),
            counterpoint_item_key: row.counterpoint_item_key.clone(),
            family_key: row.family_key.clone(),
            option_values: row.option_values.clone(),
        })
        .collect()
}

fn limited_values(values: &BTreeSet<String>) -> Vec<String> {
    values
        .iter()
        .take(COUNTERPOINT_IDENTITY_PREFLIGHT_EXAMPLE_LIMIT)
        .cloned()
        .collect()
}

struct GroupedIssueArgs<'rows, 'row> {
    issue_type: &'static str,
    severity: CounterpointIdentityPreflightSeverity,
    message: String,
    rows: &'rows [&'row CounterpointIdentityPreflightRow],
    normalized_sku: Option<String>,
    counterpoint_item_key: Option<String>,
    family_key: Option<String>,
    values: BTreeSet<String>,
    affects_ingest_rows: bool,
    should_quarantine: bool,
    safe_to_continue_other_rows: bool,
}

fn grouped_issue(args: GroupedIssueArgs<'_, '_>) -> CounterpointIdentityPreflightIssue {
    CounterpointIdentityPreflightIssue {
        issue_type: args.issue_type.into(),
        severity: args.severity.as_str().into(),
        message: args.message,
        affected_row_count: args.rows.len(),
        affects_ingest_rows: args.affects_ingest_rows,
        should_quarantine: args.should_quarantine,
        safe_to_continue_other_rows: args.safe_to_continue_other_rows,
        normalized_sku: args.normalized_sku,
        counterpoint_item_key: args.counterpoint_item_key,
        family_key: args.family_key,
        references: limited_refs(args.rows),
        sample_rows: limited_sample_rows(args.rows),
        values: limited_values(&args.values),
        all_references: all_refs(args.rows),
    }
}

fn build_counterpoint_identity_preflight_report(
    entity: &str,
    total_rows: usize,
    rows: Vec<CounterpointIdentityPreflightRow>,
) -> CounterpointIdentityPreflightReport {
    let mut issues = Vec::new();
    let mut invalid_sku_rows = 0;
    let mut duplicate_normalized_b_sku_values = 0;
    let mut duplicate_counterpoint_item_key_values = 0;
    let mut conflicting_sku_family_values = 0;
    let mut conflicting_sku_counterpoint_item_key_values = 0;
    let mut affected_refs = BTreeSet::new();
    let mut blank_sku_rows = Vec::new();
    let mut parent_item_rows = Vec::new();
    let mut parent_item_values = BTreeSet::new();
    let mut generated_or_service_rows = Vec::new();
    let mut generated_or_service_values = BTreeSet::new();
    let mut invalid_non_b_rows = Vec::new();
    let mut invalid_non_b_values = BTreeSet::new();

    let mut rows_by_sku: BTreeMap<String, Vec<&CounterpointIdentityPreflightRow>> = BTreeMap::new();
    let mut rows_by_key: BTreeMap<String, Vec<&CounterpointIdentityPreflightRow>> = BTreeMap::new();

    for row in &rows {
        if let Some(sku) = row.normalized_sku.as_deref() {
            rows_by_sku.entry(sku.to_string()).or_default().push(row);
        }
        if let Some(key) = row.counterpoint_item_key.as_deref() {
            rows_by_key.entry(key.to_string()).or_default().push(row);
        }
    }

    for row in &rows {
        let invalid = if entity == "catalog" || entity == "inventory" {
            row.normalized_sku
                .as_deref()
                .map(|sku| sku.trim().is_empty())
                .unwrap_or(true)
        } else {
            row.normalized_sku
                .as_deref()
                .map(|sku| !is_valid_counterpoint_b_sku(sku))
                .unwrap_or(true)
        };
        if invalid {
            invalid_sku_rows += 1;
            affected_refs.insert((row.reference.row_number, row.reference.cell_number));
            match row.normalized_sku.as_deref() {
                None => blank_sku_rows.push(row),
                Some(sku) if is_counterpoint_parent_item_sku(sku) => {
                    parent_item_rows.push(row);
                    parent_item_values.insert(sku.to_string());
                }
                Some(sku) if is_generated_or_service_sku(sku) => {
                    generated_or_service_rows.push(row);
                    generated_or_service_values.insert(sku.to_string());
                }
                Some(sku) => {
                    invalid_non_b_rows.push(row);
                    invalid_non_b_values.insert(sku.to_string());
                }
            }
        }
    }
    if !blank_sku_rows.is_empty() {
        issues.push(grouped_issue(GroupedIssueArgs {
            issue_type: "blank_sku",
            severity: CounterpointIdentityPreflightSeverity::Quarantine,
            message:
                "Incoming variant rows contain blank SKUs and cannot be matched deterministically."
                    .into(),
            rows: &blank_sku_rows,
            normalized_sku: None,
            counterpoint_item_key: None,
            family_key: None,
            values: BTreeSet::new(),
            affects_ingest_rows: true,
            should_quarantine: true,
            safe_to_continue_other_rows: true,
        }));
    }
    if !generated_or_service_rows.is_empty() {
        issues.push(grouped_issue(GroupedIssueArgs {
            issue_type: "generated_or_service_non_b_sku",
            severity: CounterpointIdentityPreflightSeverity::Warning,
            message: "Incoming rows contain generated, service, or catalog non-B SKUs.".into(),
            rows: &generated_or_service_rows,
            normalized_sku: None,
            counterpoint_item_key: None,
            family_key: None,
            values: generated_or_service_values,
            affects_ingest_rows: true,
            should_quarantine: true,
            safe_to_continue_other_rows: true,
        }));
    }
    if !parent_item_rows.is_empty() {
        issues.push(grouped_issue(GroupedIssueArgs {
            issue_type: "parent_item_sku",
            severity: CounterpointIdentityPreflightSeverity::Info,
            message:
                "Incoming rows contain Counterpoint parent item numbers rather than sellable B- SKUs."
                    .into(),
            rows: &parent_item_rows,
            normalized_sku: None,
            counterpoint_item_key: None,
            family_key: None,
            values: parent_item_values,
            affects_ingest_rows: false,
            should_quarantine: false,
            safe_to_continue_other_rows: true,
        }));
    }
    if !invalid_non_b_rows.is_empty() {
        issues.push(grouped_issue(GroupedIssueArgs {
            issue_type: "invalid_non_b_sku",
            severity: CounterpointIdentityPreflightSeverity::Quarantine,
            message: "Incoming variant rows contain non-Counterpoint B- SKUs that require review."
                .into(),
            rows: &invalid_non_b_rows,
            normalized_sku: None,
            counterpoint_item_key: None,
            family_key: None,
            values: invalid_non_b_values,
            affects_ingest_rows: true,
            should_quarantine: true,
            safe_to_continue_other_rows: true,
        }));
    }

    for (sku, sku_rows) in &rows_by_sku {
        if !is_valid_counterpoint_b_sku(sku) || sku_rows.len() <= 1 {
            continue;
        }
        duplicate_normalized_b_sku_values += 1;
        for row in sku_rows {
            affected_refs.insert((row.reference.row_number, row.reference.cell_number));
        }
        let keys = sku_rows
            .iter()
            .filter_map(|row| row.counterpoint_item_key.clone())
            .collect();
        issues.push(grouped_issue(GroupedIssueArgs {
            issue_type: "duplicate_normalized_b_sku",
            severity: CounterpointIdentityPreflightSeverity::Blocking,
            message: "Multiple incoming variant rows share the same normalized B- SKU.".into(),
            rows: sku_rows,
            normalized_sku: Some(sku.clone()),
            counterpoint_item_key: None,
            family_key: None,
            values: keys,
            affects_ingest_rows: true,
            should_quarantine: true,
            safe_to_continue_other_rows: true,
        }));
    }

    for (key, key_rows) in &rows_by_key {
        if key_rows.len() <= 1 {
            continue;
        }
        duplicate_counterpoint_item_key_values += 1;
        for row in key_rows {
            affected_refs.insert((row.reference.row_number, row.reference.cell_number));
        }
        let skus = key_rows
            .iter()
            .filter_map(|row| row.normalized_sku.clone())
            .collect();
        issues.push(grouped_issue(GroupedIssueArgs {
            issue_type: "duplicate_counterpoint_item_key",
            severity: CounterpointIdentityPreflightSeverity::Blocking,
            message: "Multiple incoming variant rows share the same Counterpoint item key.".into(),
            rows: key_rows,
            normalized_sku: None,
            counterpoint_item_key: Some(key.clone()),
            family_key: None,
            values: skus,
            affects_ingest_rows: true,
            should_quarantine: true,
            safe_to_continue_other_rows: true,
        }));
    }

    for (sku, sku_rows) in &rows_by_sku {
        let families = sku_rows
            .iter()
            .filter_map(|row| row.family_key.clone())
            .collect::<BTreeSet<_>>();
        if families.len() > 1 {
            conflicting_sku_family_values += 1;
            for row in sku_rows {
                affected_refs.insert((row.reference.row_number, row.reference.cell_number));
            }
            issues.push(grouped_issue(GroupedIssueArgs {
                issue_type: "conflicting_sku_family_mapping",
                severity: CounterpointIdentityPreflightSeverity::Blocking,
                message: "One normalized SKU maps to multiple Counterpoint family/item keys."
                    .into(),
                rows: sku_rows,
                normalized_sku: Some(sku.clone()),
                counterpoint_item_key: None,
                family_key: None,
                values: families,
                affects_ingest_rows: true,
                should_quarantine: true,
                safe_to_continue_other_rows: true,
            }));
        }

        let keys = sku_rows
            .iter()
            .filter_map(|row| row.counterpoint_item_key.clone())
            .collect::<BTreeSet<_>>();
        if keys.len() > 1 {
            conflicting_sku_counterpoint_item_key_values += 1;
            for row in sku_rows {
                affected_refs.insert((row.reference.row_number, row.reference.cell_number));
            }
            issues.push(grouped_issue(GroupedIssueArgs {
                issue_type: "conflicting_sku_counterpoint_item_key_mapping",
                severity: CounterpointIdentityPreflightSeverity::Blocking,
                message: "One normalized SKU maps to multiple Counterpoint variant keys.".into(),
                rows: sku_rows,
                normalized_sku: Some(sku.clone()),
                counterpoint_item_key: None,
                family_key: None,
                values: keys,
                affects_ingest_rows: true,
                should_quarantine: true,
                safe_to_continue_other_rows: true,
            }));
        }
    }

    let info_count = issues
        .iter()
        .filter(|issue| issue.severity == CounterpointIdentityPreflightSeverity::Info.as_str())
        .count();
    let warning_count = issues
        .iter()
        .filter(|issue| issue.severity == CounterpointIdentityPreflightSeverity::Warning.as_str())
        .count();
    let quarantine_count = issues
        .iter()
        .filter(|issue| {
            issue.severity == CounterpointIdentityPreflightSeverity::Quarantine.as_str()
        })
        .count();
    let blocking_count = issues
        .iter()
        .filter(|issue| issue.severity == CounterpointIdentityPreflightSeverity::Blocking.as_str())
        .count();

    CounterpointIdentityPreflightReport {
        summary: CounterpointIdentityPreflightSummary {
            entity: entity.into(),
            total_rows,
            variant_rows_checked: rows.len(),
            has_errors: !issues.is_empty(),
            issue_count: issues.len(),
            affected_row_count: affected_refs.len(),
            info_count,
            warning_count,
            quarantine_count,
            blocking_count,
            has_blocking_issues: blocking_count > 0,
            invalid_sku_rows,
            duplicate_normalized_b_sku_values,
            duplicate_counterpoint_item_key_values,
            conflicting_sku_family_values,
            conflicting_sku_counterpoint_item_key_values,
        },
        issues,
    }
}

fn quarantined_preflight_refs(
    report: &CounterpointIdentityPreflightReport,
) -> HashSet<(usize, Option<usize>)> {
    report
        .issues
        .iter()
        .filter(|issue| issue.should_quarantine)
        .flat_map(|issue| issue.all_references.iter())
        .map(|reference| (reference.row_number, reference.cell_number))
        .collect()
}

fn reference_json(reference: &CounterpointIdentityPreflightReference) -> serde_json::Value {
    serde_json::json!({
        "row_number": reference.row_number,
        "cell_number": reference.cell_number,
    })
}

fn inventory_quarantine_record_fields(
    row: &CounterpointInventoryRow,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Vec<String>,
    serde_json::Value,
) {
    let counterpoint_item_key = trim_opt(&row.counterpoint_item_key)
        .as_deref()
        .and_then(normalize_identity_key);
    let family_key = counterpoint_item_key
        .as_deref()
        .and_then(normalize_counterpoint_family_key);
    let option_values = option_values_from_counterpoint_item_key(counterpoint_item_key.as_deref());
    (
        normalize_identity_key(&row.sku),
        counterpoint_item_key,
        family_key,
        option_values,
        serde_json::to_value(row).unwrap_or_else(|_| serde_json::json!({})),
    )
}

fn catalog_quarantine_record_fields(
    row: &CounterpointCatalogRow,
    cell_number: Option<usize>,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Vec<String>,
    serde_json::Value,
) {
    let item_no = normalize_identity_key(&row.item_no);
    if let Some(cell_number) = cell_number {
        if let Some(cell) = row.cells.get(cell_number.saturating_sub(1)) {
            let counterpoint_item_key = normalize_identity_key(&cell.counterpoint_item_key);
            let mut option_values =
                option_values_from_variation_values(cell.variation_values.as_ref());
            if option_values.is_empty() {
                option_values = option_values_from_variation_label(cell.variation_label.as_deref());
            }
            if option_values.is_empty() {
                option_values =
                    option_values_from_counterpoint_item_key(counterpoint_item_key.as_deref());
            }
            return (
                normalize_identity_key(&cell.sku),
                counterpoint_item_key,
                item_no,
                option_values,
                serde_json::json!({
                    "item_no": row.item_no,
                    "description": row.description,
                    "category": row.category,
                    "vendor_no": row.vendor_no,
                    "cell": cell,
                }),
            );
        }
    }

    let sku = trim_opt(&row.barcode).unwrap_or_else(|| row.item_no.trim().to_string());
    (
        normalize_identity_key(&sku),
        item_no.clone(),
        item_no,
        Vec::new(),
        serde_json::to_value(row).unwrap_or_else(|_| serde_json::json!({})),
    )
}

fn build_inventory_quarantine_records(
    payload: &CounterpointInventoryPayload,
    report: &CounterpointIdentityPreflightReport,
) -> Vec<CounterpointIngestQuarantineRecord> {
    let mut records = Vec::new();
    for issue in report.issues.iter().filter(|issue| issue.should_quarantine) {
        for reference in &issue.all_references {
            let Some(row) = payload.rows.get(reference.row_number.saturating_sub(1)) else {
                continue;
            };
            let (normalized_sku, counterpoint_item_key, family_key, option_values, source_row) =
                inventory_quarantine_record_fields(row);
            records.push(CounterpointIngestQuarantineRecord {
                ingest_type: "inventory",
                issue_type: issue.issue_type.clone(),
                severity: issue.severity.clone(),
                message: issue.message.clone(),
                normalized_sku,
                counterpoint_item_key,
                family_key,
                option_values,
                source_reference: reference_json(reference),
                source_row,
            });
        }
    }
    records
}

pub fn validate_counterpoint_inventory_identity_preflight(
    payload: &CounterpointInventoryPayload,
) -> Result<CounterpointIdentityPreflightReport, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let rows = payload
        .rows
        .iter()
        .enumerate()
        .map(|(idx, row)| {
            let counterpoint_item_key = trim_opt(&row.counterpoint_item_key)
                .as_deref()
                .and_then(normalize_identity_key);
            let family_key = counterpoint_item_key
                .as_deref()
                .and_then(normalize_counterpoint_family_key);
            let option_values =
                option_values_from_counterpoint_item_key(counterpoint_item_key.as_deref());
            CounterpointIdentityPreflightRow {
                reference: CounterpointIdentityPreflightReference {
                    row_number: idx + 1,
                    cell_number: None,
                },
                normalized_sku: normalize_identity_key(&row.sku),
                counterpoint_item_key,
                family_key,
                option_values,
            }
        })
        .collect();

    Ok(build_counterpoint_identity_preflight_report(
        "inventory",
        payload.rows.len(),
        rows,
    ))
}

#[derive(Debug, sqlx::FromRow)]
struct CounterpointBarcodeAliasVariantCandidate {
    variant_id: Uuid,
    catalog_handle: Option<String>,
    barcode: Option<String>,
    counterpoint_item_key: Option<String>,
    variation_label: Option<String>,
    variation_values: Option<serde_json::Value>,
}

struct CounterpointBarcodeAliasMappableRow {
    row_number: usize,
    variant_id: Uuid,
    alias_value: String,
    normalized_alias: String,
    counterpoint_item_key: Option<String>,
    family_key: String,
    match_method: &'static str,
}

struct CounterpointBarcodeAliasEvaluation {
    report: CounterpointBarcodeAliasPreflightReport,
    mappable_rows: Vec<CounterpointBarcodeAliasMappableRow>,
}

fn push_alias_preflight_example(
    examples: &mut Vec<CounterpointBarcodeAliasPreflightExample>,
    row_number: usize,
    classification: &str,
    row: &CounterpointBarcodeAliasPreflightRow,
    matched_variant: Option<&CounterpointBarcodeAliasVariantCandidate>,
    message: &str,
) {
    if examples
        .iter()
        .filter(|example| example.classification == classification)
        .count()
        >= COUNTERPOINT_IDENTITY_PREFLIGHT_EXAMPLE_LIMIT
    {
        return;
    }
    examples.push(CounterpointBarcodeAliasPreflightExample {
        row_number,
        classification: classification.into(),
        b_sku: row.sku.trim().to_string(),
        family_key: row.family_key.as_deref().and_then(normalize_identity_key),
        option_values: normalized_alias_option_values(&row.option_values),
        matched_variant_id: matched_variant.map(|variant| variant.variant_id),
        counterpoint_item_key: matched_variant
            .and_then(|variant| variant.counterpoint_item_key.clone()),
        message: message.into(),
    });
}

async fn evaluate_counterpoint_barcode_aliases(
    pool: &PgPool,
    rows: &[CounterpointBarcodeAliasPreflightRow],
) -> Result<CounterpointBarcodeAliasEvaluation, CounterpointSyncError> {
    if rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let variants: Vec<CounterpointBarcodeAliasVariantCandidate> = sqlx::query_as(
        r#"
        SELECT
            pv.id AS variant_id,
            p.catalog_handle,
            pv.barcode,
            pv.counterpoint_item_key,
            pv.variation_label,
            pv.variation_values
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE p.data_source = 'counterpoint'
           OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut variants_by_family_options: HashMap<
        (String, Vec<String>),
        Vec<CounterpointBarcodeAliasVariantCandidate>,
    > = HashMap::new();
    for variant in variants {
        let family_key = variant
            .catalog_handle
            .as_deref()
            .and_then(normalize_identity_key)
            .or_else(|| {
                variant
                    .counterpoint_item_key
                    .as_deref()
                    .and_then(normalize_counterpoint_family_key)
            });
        let Some(family_key) = family_key else {
            continue;
        };
        let option_values = normalized_counterpoint_variant_option_values(
            variant.counterpoint_item_key.as_deref(),
            variant.variation_values.as_ref(),
            variant.variation_label.as_deref(),
        );
        variants_by_family_options
            .entry((family_key, option_values))
            .or_default()
            .push(variant);
    }

    let sku_counts = rows
        .iter()
        .filter_map(|row| normalize_identity_key(&row.sku))
        .filter(|sku| is_valid_counterpoint_b_sku(sku))
        .fold(HashMap::<String, usize>::new(), |mut counts, sku| {
            *counts.entry(sku).or_default() += 1;
            counts
        });

    let mut summary = CounterpointBarcodeAliasPreflightSummary {
        total_rows: rows.len(),
        mappable: 0,
        duplicate_b_sku: 0,
        ambiguous_variant_match: 0,
        no_ros_variant_match: 0,
        missing_family: 0,
        invalid_non_b_sku: 0,
        existing_barcode_conflict: 0,
    };
    let mut examples = Vec::new();
    let mut mappable_rows = Vec::new();

    for (idx, row) in rows.iter().enumerate() {
        let row_number = idx + 1;
        let Some(normalized_sku) = normalize_identity_key(&row.sku) else {
            summary.invalid_non_b_sku += 1;
            push_alias_preflight_example(
                &mut examples,
                row_number,
                "invalid_non_b_sku",
                row,
                None,
                "CSV row has a blank SKU and cannot become a barcode alias.",
            );
            continue;
        };
        if !is_valid_counterpoint_b_sku(&normalized_sku) {
            summary.invalid_non_b_sku += 1;
            push_alias_preflight_example(
                &mut examples,
                row_number,
                "invalid_non_b_sku",
                row,
                None,
                "CSV row SKU is not a normalized Counterpoint B- barcode.",
            );
            continue;
        }
        if sku_counts.get(&normalized_sku).copied().unwrap_or_default() > 1 {
            summary.duplicate_b_sku += 1;
            push_alias_preflight_example(
                &mut examples,
                row_number,
                "duplicate_b_sku",
                row,
                None,
                "CSV B-SKU appears on multiple rows and must not be mapped automatically.",
            );
            continue;
        }
        let Some(family_key) = row.family_key.as_deref().and_then(normalize_identity_key) else {
            summary.missing_family += 1;
            push_alias_preflight_example(
                &mut examples,
                row_number,
                "missing_family",
                row,
                None,
                "CSV row is missing an I- family key in tags.",
            );
            continue;
        };
        if !is_counterpoint_parent_item_sku(&family_key) {
            summary.missing_family += 1;
            push_alias_preflight_example(
                &mut examples,
                row_number,
                "missing_family",
                row,
                None,
                "CSV row family key is not a Counterpoint I- item number.",
            );
            continue;
        }

        let option_values = normalized_alias_option_values(&row.option_values);
        let Some(candidates) = variants_by_family_options.get(&(family_key.clone(), option_values))
        else {
            summary.no_ros_variant_match += 1;
            push_alias_preflight_example(
                &mut examples,
                row_number,
                "no_ros_variant_match",
                row,
                None,
                "No ROS Counterpoint variant matches this family and option structure.",
            );
            continue;
        };
        if candidates.len() != 1 {
            summary.ambiguous_variant_match += 1;
            push_alias_preflight_example(
                &mut examples,
                row_number,
                "ambiguous_variant_match",
                row,
                candidates.first(),
                "More than one ROS variant matches this family and option structure.",
            );
            continue;
        }

        let candidate = &candidates[0];
        if let Some(existing_barcode) = candidate
            .barcode
            .as_deref()
            .and_then(normalize_identity_key)
        {
            if existing_barcode != normalized_sku {
                summary.ambiguous_variant_match += 1;
                summary.existing_barcode_conflict += 1;
                push_alias_preflight_example(
                    &mut examples,
                    row_number,
                    "ambiguous_variant_match",
                    row,
                    Some(candidate),
                    "ROS variant already has a different barcode value.",
                );
                continue;
            }
        }

        summary.mappable += 1;
        mappable_rows.push(CounterpointBarcodeAliasMappableRow {
            row_number,
            variant_id: candidate.variant_id,
            alias_value: row.sku.trim().to_string(),
            normalized_alias: normalized_sku.to_lowercase(),
            counterpoint_item_key: candidate.counterpoint_item_key.clone(),
            family_key,
            match_method: "preflight_family_options",
        });
        push_alias_preflight_example(
            &mut examples,
            row_number,
            "mappable",
            row,
            Some(candidate),
            "CSV B-SKU can be safely mapped as a read-only alias candidate.",
        );
    }

    Ok(CounterpointBarcodeAliasEvaluation {
        report: CounterpointBarcodeAliasPreflightReport { summary, examples },
        mappable_rows,
    })
}

pub async fn preflight_counterpoint_barcode_aliases(
    pool: &PgPool,
    payload: CounterpointBarcodeAliasPreflightPayload,
) -> Result<CounterpointBarcodeAliasPreflightReport, CounterpointSyncError> {
    Ok(evaluate_counterpoint_barcode_aliases(pool, &payload.rows)
        .await?
        .report)
}

#[derive(Debug, sqlx::FromRow)]
struct ExistingCounterpointBarcodeAlias {
    normalized_alias: String,
    variant_id: Uuid,
    alias_type: String,
    source_system: String,
    counterpoint_item_key: Option<String>,
    family_key: Option<String>,
    match_method: String,
}

pub async fn persist_counterpoint_barcode_aliases(
    pool: &PgPool,
    payload: CounterpointBarcodeAliasPersistPayload,
) -> Result<CounterpointBarcodeAliasPersistReport, CounterpointSyncError> {
    let source_file_name = trim_str_opt(Some(&payload.source_file_name)).ok_or_else(|| {
        CounterpointSyncError::InvalidPayload("source_file_name cannot be blank".into())
    })?;
    let source_file_hash = trim_str_opt(payload.source_file_hash.as_deref());
    let preflight_rows: Vec<CounterpointBarcodeAliasPreflightRow> = payload
        .rows
        .iter()
        .map(|row| CounterpointBarcodeAliasPreflightRow {
            sku: row.sku.clone(),
            family_key: row.family_key.clone(),
            option_values: row.option_values.clone(),
        })
        .collect();
    let evaluation = evaluate_counterpoint_barcode_aliases(pool, &preflight_rows).await?;
    let preflight_summary = evaluation.report.summary;

    let mut normalized_aliases = HashSet::new();
    for row in &evaluation.mappable_rows {
        if trim_str_opt(row.counterpoint_item_key.as_deref()).is_none() {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "alias preflight returned mappable row {} without counterpoint_item_key",
                row.row_number
            )));
        }
        if !normalized_aliases.insert(row.normalized_alias.clone()) {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "alias preflight returned duplicate mappable alias {}",
                row.normalized_alias
            )));
        }
    }

    let existing_aliases: Vec<ExistingCounterpointBarcodeAlias> = if normalized_aliases.is_empty() {
        Vec::new()
    } else {
        let mut keys: Vec<String> = normalized_aliases.iter().cloned().collect();
        keys.sort();
        sqlx::query_as(
            r#"
            SELECT
                normalized_alias,
                variant_id,
                alias_type,
                source_system,
                counterpoint_item_key,
                family_key,
                match_method
            FROM product_variant_barcode_aliases
            WHERE status = 'active'
              AND normalized_alias = ANY($1::text[])
            "#,
        )
        .bind(&keys)
        .fetch_all(pool)
        .await?
    };

    let existing_by_alias: HashMap<String, ExistingCounterpointBarcodeAlias> = existing_aliases
        .into_iter()
        .map(|alias| (alias.normalized_alias.clone(), alias))
        .collect();

    let mut already_existing_identical_aliases = 0usize;
    let mut conflicts = Vec::new();
    let mut to_insert = Vec::new();
    for row in &evaluation.mappable_rows {
        if let Some(existing) = existing_by_alias.get(&row.normalized_alias) {
            if payload.replace && existing.alias_type == "counterpoint_b_sku" {
                to_insert.push(row);
                continue;
            }
            let identical = existing.variant_id == row.variant_id
                && existing.alias_type == "counterpoint_b_sku"
                && existing.source_system == "counterpoint_csv"
                && trim_str_opt(existing.counterpoint_item_key.as_deref())
                    == trim_str_opt(row.counterpoint_item_key.as_deref())
                && trim_str_opt(existing.family_key.as_deref()).as_deref()
                    == Some(row.family_key.as_str())
                && existing.match_method == row.match_method;
            if identical {
                already_existing_identical_aliases += 1;
            } else {
                conflicts.push(format!(
                    "{} existing_variant={} incoming_variant={}",
                    row.normalized_alias, existing.variant_id, row.variant_id
                ));
            }
        } else {
            to_insert.push(row);
        }
    }

    if !conflicts.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "active barcode alias conflicts detected: {}; first conflict: {}",
            conflicts.len(),
            conflicts[0]
        )));
    }

    let would_insert_aliases = to_insert.len();
    let mut inserted_aliases = 0usize;
    let mut deleted_existing_counterpoint_b_sku_aliases = 0u64;

    if !payload.dry_run && (payload.replace || !to_insert.is_empty()) {
        let mut tx = pool.begin().await?;
        if payload.replace {
            deleted_existing_counterpoint_b_sku_aliases = sqlx::query(
                "DELETE FROM product_variant_barcode_aliases WHERE alias_type = 'counterpoint_b_sku'",
            )
            .execute(&mut *tx)
            .await?
            .rows_affected();
        }
        for chunk in to_insert.chunks(5_000) {
            let mut builder = QueryBuilder::<Postgres>::new(
                r#"
                INSERT INTO product_variant_barcode_aliases (
                    variant_id,
                    alias_value,
                    alias_type,
                    source_system,
                    source_file_name,
                    source_file_hash,
                    source_row_number,
                    source_row_hash,
                    counterpoint_item_key,
                    family_key,
                    match_method,
                    status
                )
                "#,
            );
            builder.push_values(chunk, |mut row_builder, row| {
                let source_row = &payload.rows[row.row_number - 1];
                row_builder
                    .push_bind(row.variant_id)
                    .push_bind(&row.alias_value)
                    .push_bind("counterpoint_b_sku")
                    .push_bind("counterpoint_csv")
                    .push_bind(&source_file_name)
                    .push_bind(source_file_hash.as_deref())
                    .push_bind(source_row.source_row_number)
                    .push_bind(trim_str_opt(source_row.source_row_hash.as_deref()))
                    .push_bind(trim_str_opt(row.counterpoint_item_key.as_deref()))
                    .push_bind(&row.family_key)
                    .push_bind(row.match_method)
                    .push_bind("active");
            });
            inserted_aliases += builder.build().execute(&mut *tx).await?.rows_affected() as usize;
        }
        tx.commit().await?;
    }

    Ok(CounterpointBarcodeAliasPersistReport {
        summary: CounterpointBarcodeAliasPersistSummary {
            total_rows: preflight_summary.total_rows,
            mappable_aliases: preflight_summary.mappable,
            would_insert_aliases,
            inserted_aliases,
            already_existing_identical_aliases,
            deleted_existing_counterpoint_b_sku_aliases,
            skipped_duplicate_b_sku: preflight_summary.duplicate_b_sku,
            skipped_ambiguous_variant_match: preflight_summary.ambiguous_variant_match,
            skipped_no_ros_variant_match: preflight_summary.no_ros_variant_match,
            skipped_missing_family: preflight_summary.missing_family,
            skipped_invalid_non_b_sku: preflight_summary.invalid_non_b_sku,
            skipped_existing_barcode_conflict: preflight_summary.existing_barcode_conflict,
            conflicts: 0,
            dry_run: payload.dry_run,
            replace: payload.replace,
        },
        preflight_summary,
    })
}

#[derive(Debug, sqlx::FromRow)]
struct NormalizationAliasMatchRow {
    normalized_alias: String,
    alias_count: i64,
    variant_id: Uuid,
    product_id: Uuid,
    counterpoint_item_key: Option<String>,
    family_key: Option<String>,
    product_name: String,
    catalog_handle: Option<String>,
    variation_axes: Vec<String>,
    variation_values: serde_json::Value,
    variation_label: Option<String>,
    category_name: Option<String>,
    primary_vendor_name: Option<String>,
    primary_vendor_code: Option<String>,
}

pub async fn preview_counterpoint_lightspeed_normalization_candidates(
    pool: &PgPool,
    payload: CounterpointNormalizationPreviewPayload,
) -> Result<CounterpointNormalizationPreviewReport, CounterpointSyncError> {
    const EXAMPLE_LIMIT: usize = 50;

    let mut rows_by_sku: BTreeMap<String, Vec<CounterpointNormalizationPreviewRow>> =
        BTreeMap::new();
    let mut invalid_non_b_sku_rows = 0usize;
    let mut lightspeed_b_sku_rows = 0usize;
    let mut excluded_examples = Vec::new();

    for row in payload.rows.iter().cloned() {
        let normalized_sku = normalize_identity_key(&row.sku);
        let Some(normalized_sku) = normalized_sku else {
            invalid_non_b_sku_rows += 1;
            push_normalization_excluded_example(
                &mut excluded_examples,
                EXAMPLE_LIMIT,
                row.source_row_number,
                "",
                "invalid_non_b_sku",
                "Lightspeed row SKU is blank and cannot be matched to a Counterpoint B-SKU alias.",
            );
            continue;
        };
        if !is_valid_counterpoint_b_sku(&normalized_sku) {
            invalid_non_b_sku_rows += 1;
            push_normalization_excluded_example(
                &mut excluded_examples,
                EXAMPLE_LIMIT,
                row.source_row_number,
                &normalized_sku,
                "invalid_non_b_sku",
                "Lightspeed row SKU is not a Counterpoint B-SKU; it is normalization reference only and was excluded.",
            );
            continue;
        }
        lightspeed_b_sku_rows += 1;
        rows_by_sku.entry(normalized_sku).or_default().push(row);
    }

    let duplicate_lightspeed_b_sku_rows: usize = rows_by_sku
        .values()
        .filter(|rows| rows.len() > 1)
        .map(Vec::len)
        .sum();
    for (sku, rows) in rows_by_sku.iter().filter(|(_, rows)| rows.len() > 1) {
        for row in rows {
            push_normalization_excluded_example(
                &mut excluded_examples,
                EXAMPLE_LIMIT,
                row.source_row_number,
                sku,
                "duplicate_lightspeed_b_sku",
                "Lightspeed reference has more than one row for this B-SKU, so no normalization candidate was produced.",
            );
        }
    }

    let unique_skus = rows_by_sku
        .iter()
        .filter(|(_, rows)| rows.len() == 1)
        .map(|(sku, _)| sku.to_ascii_lowercase())
        .collect::<Vec<_>>();

    let alias_rows: Vec<NormalizationAliasMatchRow> = if unique_skus.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            r#"
            WITH active_aliases AS (
                SELECT
                    a.normalized_alias,
                    COUNT(*) OVER (PARTITION BY a.normalized_alias) AS alias_count,
                    a.variant_id,
                    COALESCE(a.counterpoint_item_key, pv.counterpoint_item_key) AS counterpoint_item_key,
                    COALESCE(a.family_key, p.catalog_handle) AS family_key,
                    pv.variation_values,
                    pv.variation_label,
                    p.id AS product_id,
                    p.name AS product_name,
                    p.catalog_handle,
                    COALESCE(p.variation_axes, ARRAY[]::text[]) AS variation_axes,
                    c.name AS category_name,
                    v.name AS primary_vendor_name,
                    v.vendor_code AS primary_vendor_code
                FROM product_variant_barcode_aliases a
                INNER JOIN product_variants pv ON pv.id = a.variant_id
                INNER JOIN products p ON p.id = pv.product_id
                LEFT JOIN categories c ON c.id = p.category_id
                LEFT JOIN vendors v ON v.id = p.primary_vendor_id
                WHERE a.status = 'active'
                  AND a.alias_type = 'counterpoint_b_sku'
                  AND p.is_active = TRUE
                  AND NULLIF(TRIM(COALESCE(pv.counterpoint_item_key, '')), '') IS NOT NULL
                  AND a.normalized_alias = ANY($1::text[])
            )
            SELECT
                normalized_alias,
                alias_count,
                variant_id,
                product_id,
                counterpoint_item_key,
                family_key,
                product_name,
                catalog_handle,
                variation_axes,
                variation_values,
                variation_label,
                category_name,
                primary_vendor_name,
                primary_vendor_code
            FROM active_aliases
            ORDER BY normalized_alias
            "#,
        )
        .bind(&unique_skus)
        .fetch_all(pool)
        .await?
    };

    let mut alias_by_sku: HashMap<String, NormalizationAliasMatchRow> = HashMap::new();
    let mut duplicate_alias_skus = HashSet::new();
    for alias in alias_rows {
        let key = alias.normalized_alias.clone();
        if alias.alias_count > 1 || alias_by_sku.insert(key.clone(), alias).is_some() {
            duplicate_alias_skus.insert(key);
        }
    }

    let mut candidates = Vec::new();
    let mut matched_aliases = 0usize;
    let mut clean_candidates = 0usize;
    let mut no_active_alias_rows = 0usize;
    let mut duplicate_active_alias_conflict_rows = 0usize;
    let mut name_differences = 0usize;
    let mut category_differences = 0usize;
    let mut supplier_differences = 0usize;
    let mut variant_option_differences = 0usize;

    for (upper_sku, rows) in rows_by_sku.iter().filter(|(_, rows)| rows.len() == 1) {
        let row = &rows[0];
        let lookup_sku = upper_sku.to_ascii_lowercase();
        if duplicate_alias_skus.contains(&lookup_sku) {
            duplicate_active_alias_conflict_rows += 1;
            push_normalization_excluded_example(
                &mut excluded_examples,
                EXAMPLE_LIMIT,
                row.source_row_number,
                upper_sku,
                "duplicate_active_alias_conflict",
                "ROS has more than one active Counterpoint B-SKU alias for this value; no normalization candidate was produced.",
            );
            continue;
        }

        let Some(alias) = alias_by_sku.get(&lookup_sku) else {
            no_active_alias_rows += 1;
            push_normalization_excluded_example(
                &mut excluded_examples,
                EXAMPLE_LIMIT,
                row.source_row_number,
                upper_sku,
                "no_active_alias",
                "No active ROS Counterpoint B-SKU alias exists for this Lightspeed reference row.",
            );
            continue;
        };

        matched_aliases += 1;
        clean_candidates += 1;

        let lightspeed_options = lightspeed_normalization_options(&row.variant_options);
        let ros_options = ros_normalization_options(
            &alias.variation_axes,
            &alias.variation_values,
            alias.counterpoint_item_key.as_deref(),
            alias.variation_label.as_deref(),
        );
        let product_name_diff =
            normalization_reference_diff(Some(alias.product_name.as_str()), row.name.as_deref());
        let category_diff = normalization_reference_diff(
            alias.category_name.as_deref(),
            row.product_category.as_deref(),
        );
        let supplier_diff = normalization_reference_diff(
            alias.primary_vendor_name.as_deref(),
            row.supplier_name.as_deref(),
        ) || normalization_reference_diff(
            alias.primary_vendor_code.as_deref(),
            row.supplier_code.as_deref(),
        );
        let variant_diff = !lightspeed_options.is_empty()
            && normalized_option_values_for_comparison(&ros_options)
                != normalized_option_values_for_comparison(&lightspeed_options);

        name_differences += usize::from(product_name_diff);
        category_differences += usize::from(category_diff);
        supplier_differences += usize::from(supplier_diff);
        variant_option_differences += usize::from(variant_diff);

        if candidates.len() < EXAMPLE_LIMIT {
            candidates.push(CounterpointNormalizationCandidateExample {
                row_number: row.source_row_number,
                b_sku: upper_sku.clone(),
                variant_id: alias.variant_id,
                product_id: alias.product_id,
                counterpoint_item_key: alias.counterpoint_item_key.clone(),
                family_key: alias
                    .family_key
                    .clone()
                    .or_else(|| alias.catalog_handle.clone()),
                lightspeed_handle: trim_opt(&row.handle),
                ros_product_name: alias.product_name.clone(),
                lightspeed_product_name: trim_opt(&row.name),
                ros_category: alias.category_name.clone(),
                lightspeed_category: trim_opt(&row.product_category),
                ros_supplier_name: alias.primary_vendor_name.clone(),
                ros_supplier_code: alias.primary_vendor_code.clone(),
                lightspeed_supplier_name: trim_opt(&row.supplier_name),
                lightspeed_supplier_code: trim_opt(&row.supplier_code),
                ros_variant_options: ros_options,
                lightspeed_variant_options: lightspeed_options,
                differences: CounterpointNormalizationDifferenceFlags {
                    product_name: product_name_diff,
                    category: category_diff,
                    supplier: supplier_diff,
                    variant_options: variant_diff,
                },
            });
        }
    }

    let excluded_rows = invalid_non_b_sku_rows
        + duplicate_lightspeed_b_sku_rows
        + no_active_alias_rows
        + duplicate_active_alias_conflict_rows;

    Ok(CounterpointNormalizationPreviewReport {
        source_file_name: trim_opt(&payload.source_file_name),
        source_authority:
            "Lightspeed normalization reference only; Counterpoint/ROS identity remains authoritative."
                .to_string(),
        excluded_fields: vec![
            "quantity".to_string(),
            "cost".to_string(),
            "retail_price".to_string(),
            "tax".to_string(),
            "accounting".to_string(),
            "identity_fields".to_string(),
        ],
        summary: CounterpointNormalizationPreviewSummary {
            total_lightspeed_rows: payload.rows.len(),
            lightspeed_b_sku_rows,
            matched_aliases,
            clean_candidates,
            excluded_rows,
            duplicate_lightspeed_b_sku_rows,
            invalid_non_b_sku_rows,
            no_active_alias_rows,
            duplicate_active_alias_conflict_rows,
            name_differences,
            category_differences,
            supplier_differences,
            variant_option_differences,
        },
        candidates,
        excluded_examples,
    })
}

fn push_normalization_excluded_example(
    examples: &mut Vec<CounterpointNormalizationExcludedExample>,
    limit: usize,
    row_number: Option<i32>,
    b_sku: &str,
    reason: &str,
    message: &str,
) {
    if examples.len() >= limit {
        return;
    }
    examples.push(CounterpointNormalizationExcludedExample {
        row_number,
        b_sku: b_sku.to_string(),
        reason: reason.to_string(),
        message: message.to_string(),
    });
}

fn normalization_compare_key(raw: Option<&str>) -> Option<String> {
    raw.map(collapse_whitespace)
        .map(|value| value.trim_matches(['“', '”', '"', '\'']).trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase())
}

fn normalization_reference_diff(ros_value: Option<&str>, reference_value: Option<&str>) -> bool {
    let Some(reference) = normalization_compare_key(reference_value) else {
        return false;
    };
    normalization_compare_key(ros_value).as_deref() != Some(reference.as_str())
}

fn lightspeed_normalization_options(
    options: &[CounterpointNormalizationPreviewOption],
) -> Vec<CounterpointNormalizationVariantOptionOut> {
    options
        .iter()
        .filter_map(|option| {
            let value = trim_opt(&option.value)?;
            Some(CounterpointNormalizationVariantOptionOut {
                name: trim_opt(&option.name),
                value,
            })
        })
        .collect()
}

fn ros_normalization_options(
    variation_axes: &[String],
    variation_values: &serde_json::Value,
    counterpoint_item_key: Option<&str>,
    variation_label: Option<&str>,
) -> Vec<CounterpointNormalizationVariantOptionOut> {
    if let serde_json::Value::Object(map) = variation_values {
        let mut options = Vec::new();
        let mut seen = HashSet::new();
        for axis in variation_axes {
            if let Some(value) = map.get(axis).and_then(json_scalar_to_string) {
                seen.insert(axis.clone());
                options.push(CounterpointNormalizationVariantOptionOut {
                    name: Some(axis.clone()),
                    value,
                });
            }
        }
        for (key, value) in map {
            if seen.contains(key) {
                continue;
            }
            if let Some(value) = json_scalar_to_string(value) {
                options.push(CounterpointNormalizationVariantOptionOut {
                    name: Some(key.clone()),
                    value,
                });
            }
        }
        if !options.is_empty() {
            return options;
        }
    }

    let fallback_values = normalized_counterpoint_variant_option_values(
        counterpoint_item_key,
        Some(variation_values),
        variation_label,
    );
    fallback_values
        .into_iter()
        .enumerate()
        .map(|(idx, value)| CounterpointNormalizationVariantOptionOut {
            name: variation_axes.get(idx).cloned(),
            value,
        })
        .collect()
}

fn json_scalar_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => trim_str_opt(Some(value)),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn normalized_option_values_for_comparison(
    options: &[CounterpointNormalizationVariantOptionOut],
) -> Vec<String> {
    options
        .iter()
        .filter_map(|option| normalize_identity_key(&option.value))
        .filter(|value| value != "_" && value != "*")
        .collect()
}

fn filter_inventory_payload_for_quarantine(
    payload: CounterpointInventoryPayload,
) -> Result<CounterpointInventoryQuarantineFilter, CounterpointSyncError> {
    let report = validate_counterpoint_inventory_identity_preflight(&payload)?;
    let records = build_inventory_quarantine_records(&payload, &report);
    let quarantined_refs = quarantined_preflight_refs(&report);
    let total_rows = payload.rows.len();
    let sync = payload.sync;
    let mut quarantined = 0;
    let rows = payload
        .rows
        .into_iter()
        .enumerate()
        .filter_map(|(idx, row)| {
            if quarantined_refs.contains(&(idx + 1, None)) {
                quarantined += 1;
                None
            } else {
                Some(row)
            }
        })
        .collect();

    Ok(CounterpointInventoryQuarantineFilter {
        payload: CounterpointInventoryPayload { rows, sync },
        records,
        total_rows,
        quarantined,
    })
}

async fn persist_counterpoint_ingest_quarantine_records(
    pool: &PgPool,
    records: &[CounterpointIngestQuarantineRecord],
) -> Result<(), CounterpointSyncError> {
    if records.is_empty() {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    for record in records {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_ingest_quarantine (
                ingest_type, issue_type, severity, message,
                normalized_sku, counterpoint_item_key, family_key,
                option_values, source_reference, source_row
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            "#,
        )
        .bind(record.ingest_type)
        .bind(&record.issue_type)
        .bind(&record.severity)
        .bind(&record.message)
        .bind(&record.normalized_sku)
        .bind(&record.counterpoint_item_key)
        .bind(&record.family_key)
        .bind(serde_json::to_value(&record.option_values).unwrap_or_else(|_| serde_json::json!([])))
        .bind(&record.source_reference)
        .bind(&record.source_row)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn get_counterpoint_ingest_quarantine_summary(
    pool: &PgPool,
) -> Result<CounterpointIngestQuarantineSummary, CounterpointSyncError> {
    let totals: (i64, i64, i64, i64, i64, Option<DateTime<Utc>>) = sqlx::query_as(
        r#"
        SELECT
            COUNT(*)::bigint AS total_records,
            COUNT(*) FILTER (WHERE severity = 'INFO')::bigint AS info_records,
            COUNT(*) FILTER (WHERE severity = 'WARNING')::bigint AS warning_records,
            COUNT(*) FILTER (WHERE severity = 'QUARANTINE')::bigint AS quarantine_records,
            COUNT(*) FILTER (WHERE severity = 'BLOCKING')::bigint AS blocking_records,
            MAX(created_at) AS latest_created_at
        FROM counterpoint_ingest_quarantine
        "#,
    )
    .fetch_one(pool)
    .await?;

    let by_severity: Vec<CounterpointIngestQuarantineCount> = sqlx::query_as(
        r#"
        SELECT severity AS key, COUNT(*)::bigint AS count
        FROM counterpoint_ingest_quarantine
        GROUP BY severity
        ORDER BY
            CASE severity
                WHEN 'BLOCKING' THEN 1
                WHEN 'QUARANTINE' THEN 2
                WHEN 'WARNING' THEN 3
                WHEN 'INFO' THEN 4
                ELSE 5
            END,
            severity
        "#,
    )
    .fetch_all(pool)
    .await?;

    let by_ingest_type: Vec<CounterpointIngestQuarantineCount> = sqlx::query_as(
        r#"
        SELECT ingest_type AS key, COUNT(*)::bigint AS count
        FROM counterpoint_ingest_quarantine
        GROUP BY ingest_type
        ORDER BY ingest_type
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(CounterpointIngestQuarantineSummary {
        total_records: totals.0,
        info_records: totals.1,
        warning_records: totals.2,
        quarantine_records: totals.3,
        blocking_records: totals.4,
        latest_created_at: totals.5,
        by_severity,
        by_ingest_type,
    })
}

pub async fn list_counterpoint_ingest_quarantine_rows(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<CounterpointIngestQuarantineRow>, CounterpointSyncError> {
    let limit = limit.clamp(1, 200);
    let offset = offset.max(0);
    let rows = sqlx::query_as(
        r#"
        SELECT
            id,
            ingest_type,
            issue_type,
            severity,
            message,
            normalized_sku,
            counterpoint_item_key,
            family_key,
            option_values,
            source_reference,
            created_at
        FROM counterpoint_ingest_quarantine
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_counterpoint_registry_health_summary(
    pool: &PgPool,
) -> Result<CounterpointRegistryHealthSummary, CounterpointSyncError> {
    let counts: (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<DateTime<Utc>>,
    ) = sqlx::query_as(
        r#"
        WITH counterpoint_products AS (
            SELECT p.id
            FROM products p
            WHERE p.data_source = 'counterpoint'
        ),
        counterpoint_variants AS (
            SELECT
                pv.id,
                NULLIF(LOWER(TRIM(pv.sku)), '') AS normalized_sku,
                NULLIF(TRIM(pv.counterpoint_item_key), '') AS normalized_counterpoint_item_key
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE p.data_source = 'counterpoint'
               OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
        ),
        duplicate_normalized_skus AS (
            SELECT normalized_sku
            FROM counterpoint_variants
            WHERE normalized_sku IS NOT NULL
            GROUP BY normalized_sku
            HAVING COUNT(*) > 1
        ),
        duplicate_counterpoint_item_keys AS (
            SELECT normalized_counterpoint_item_key
            FROM counterpoint_variants
            WHERE normalized_counterpoint_item_key IS NOT NULL
            GROUP BY normalized_counterpoint_item_key
            HAVING COUNT(*) > 1
        )
        SELECT
            (SELECT COUNT(*)::bigint FROM counterpoint_products) AS counterpoint_products,
            (SELECT COUNT(*)::bigint FROM counterpoint_variants) AS counterpoint_variants,
            (
                SELECT COUNT(*)::bigint
                FROM counterpoint_variants
                WHERE normalized_counterpoint_item_key IS NOT NULL
            ) AS variants_with_counterpoint_item_key,
            (
                SELECT COUNT(*)::bigint
                FROM counterpoint_variants
                WHERE normalized_counterpoint_item_key IS NULL
            ) AS variants_missing_counterpoint_item_key,
            (SELECT COUNT(*)::bigint FROM duplicate_normalized_skus) AS duplicate_normalized_sku_values,
            (SELECT COUNT(*)::bigint FROM duplicate_counterpoint_item_keys) AS duplicate_counterpoint_item_key_values,
            (SELECT COUNT(*)::bigint FROM counterpoint_ingest_quarantine) AS quarantine_record_count,
            (
                SELECT MAX(COALESCE(last_ok_at, updated_at))
                FROM counterpoint_sync_runs
                WHERE entity IN ('catalog', 'inventory')
                  AND (last_ok_at IS NOT NULL OR records_processed IS NOT NULL)
            ) AS latest_ingest_at
        "#,
    )
    .fetch_one(pool)
    .await?;

    let status = if counts.4 > 0 || counts.5 > 0 || counts.6 > 0 {
        "needs_review"
    } else if counts.1 == 0 || counts.3 > 0 {
        "warning"
    } else {
        "healthy"
    };

    Ok(CounterpointRegistryHealthSummary {
        status: status.to_string(),
        counterpoint_products: counts.0,
        counterpoint_variants: counts.1,
        variants_with_counterpoint_item_key: counts.2,
        variants_missing_counterpoint_item_key: counts.3,
        duplicate_normalized_sku_values: counts.4,
        duplicate_counterpoint_item_key_values: counts.5,
        quarantine_record_count: counts.6,
        latest_ingest_at: counts.7,
    })
}

pub async fn get_counterpoint_barcode_alias_health_summary(
    pool: &PgPool,
) -> Result<CounterpointBarcodeAliasHealthSummary, CounterpointSyncError> {
    let totals: (i64, i64, i64, Option<DateTime<Utc>>) = sqlx::query_as(
        r#"
        WITH duplicate_active_aliases AS (
            SELECT normalized_alias
            FROM product_variant_barcode_aliases
            WHERE status = 'active'
            GROUP BY normalized_alias
            HAVING COUNT(*) > 1
        )
        SELECT
            COUNT(*)::bigint AS total_aliases,
            COUNT(*) FILTER (WHERE status = 'active')::bigint AS active_aliases,
            (SELECT COUNT(*)::bigint FROM duplicate_active_aliases) AS duplicate_active_alias_conflicts,
            MAX(created_at) AS latest_created_at
        FROM product_variant_barcode_aliases
        "#,
    )
    .fetch_one(pool)
    .await?;

    let by_type: Vec<CounterpointIngestQuarantineCount> = sqlx::query_as(
        r#"
        SELECT alias_type AS key, COUNT(*)::bigint AS count
        FROM product_variant_barcode_aliases
        GROUP BY alias_type
        ORDER BY alias_type
        "#,
    )
    .fetch_all(pool)
    .await?;

    let by_status: Vec<CounterpointIngestQuarantineCount> = sqlx::query_as(
        r#"
        SELECT status AS key, COUNT(*)::bigint AS count
        FROM product_variant_barcode_aliases
        GROUP BY status
        ORDER BY
            CASE status
                WHEN 'active' THEN 1
                WHEN 'quarantined' THEN 2
                WHEN 'replaced' THEN 3
                WHEN 'rejected' THEN 4
                ELSE 5
            END,
            status
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(CounterpointBarcodeAliasHealthSummary {
        total_aliases: totals.0,
        active_aliases: totals.1,
        duplicate_active_alias_conflicts: totals.2,
        latest_created_at: totals.3,
        by_type,
        by_status,
    })
}

pub async fn import_lightspeed_normalization_reference(
    pool: &PgPool,
    payload: LightspeedNormalizationReferenceImportPayload,
) -> Result<LightspeedNormalizationReferenceImportSummary, CounterpointSyncError> {
    let source_file_name = trim_str_opt(Some(&payload.source_file_name)).ok_or_else(|| {
        CounterpointSyncError::InvalidPayload("source_file_name cannot be blank".into())
    })?;
    let source_file_hash = trim_str_opt(Some(&payload.source_file_hash)).ok_or_else(|| {
        CounterpointSyncError::InvalidPayload("source_file_hash cannot be blank".into())
    })?;
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut seen_row_numbers = HashSet::new();
    let mut seen_row_hashes = HashSet::new();
    for row in &payload.rows {
        if row.source_row_number <= 0 {
            return Err(CounterpointSyncError::InvalidPayload(
                "source_row_number must be positive".into(),
            ));
        }
        if !seen_row_numbers.insert(row.source_row_number) {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "duplicate source_row_number {}",
                row.source_row_number
            )));
        }
        let row_hash = trim_str_opt(Some(&row.source_row_hash)).ok_or_else(|| {
            CounterpointSyncError::InvalidPayload(format!(
                "source_row_hash cannot be blank for row {}",
                row.source_row_number
            ))
        })?;
        if !seen_row_hashes.insert(row_hash) {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "duplicate source_row_hash for row {}",
                row.source_row_number
            )));
        }
        if trim_str_opt(Some(&row.sku)).is_none() {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "sku cannot be blank for row {}",
                row.source_row_number
            )));
        }
    }

    let active_batch: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, source_file_hash FROM lightspeed_normalization_batches WHERE status = 'active' ORDER BY imported_at DESC LIMIT 1"
    )
    .fetch_optional(pool)
    .await?;

    let mut tx = pool.begin().await?;

    let (batch_id, batch_name, batch_hash, batch_row_count, batch_status, batch_imported_at) =
        if let Some((id, active_hash)) = active_batch {
            if !payload.replace && active_hash == source_file_hash {
                sqlx::query("UPDATE lightspeed_normalization_batches SET row_count = row_count + $1 WHERE id = $2")
                .bind(payload.rows.len() as i32)
                .bind(id)
                .execute(&mut *tx)
                .await?;

                let b: (String, String, i32, String, DateTime<Utc>) = sqlx::query_as(
                "SELECT source_file_name, source_file_hash, row_count, status, imported_at FROM lightspeed_normalization_batches WHERE id = $1"
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;

                (id, b.0, b.1, b.2, b.3, b.4)
            } else if !payload.replace {
                return Err(CounterpointSyncError::InvalidPayload(
                "an active Lightspeed normalization reference batch already exists; rerun with --replace".into()
            ));
            } else {
                sqlx::query("DELETE FROM lightspeed_normalization_batches")
                    .execute(&mut *tx)
                    .await?;

                let b: (Uuid, String, String, i32, String, DateTime<Utc>) = sqlx::query_as(
                r#"
                INSERT INTO lightspeed_normalization_batches (source_file_name, source_file_hash, row_count, status)
                VALUES ($1, $2, $3, 'active')
                RETURNING id, source_file_name, source_file_hash, row_count, status, imported_at
                "#
            )
            .bind(&source_file_name)
            .bind(&source_file_hash)
            .bind(payload.rows.len() as i32)
            .fetch_one(&mut *tx)
            .await?;
                (b.0, b.1, b.2, b.3, b.4, b.5)
            }
        } else {
            let b: (Uuid, String, String, i32, String, DateTime<Utc>) = sqlx::query_as(
            r#"
            INSERT INTO lightspeed_normalization_batches (source_file_name, source_file_hash, row_count, status)
            VALUES ($1, $2, $3, 'active')
            RETURNING id, source_file_name, source_file_hash, row_count, status, imported_at
            "#
        )
        .bind(&source_file_name)
        .bind(&source_file_hash)
        .bind(payload.rows.len() as i32)
        .fetch_one(&mut *tx)
        .await?;
            (b.0, b.1, b.2, b.3, b.4, b.5)
        };

    let batch = LightspeedNormalizationReferenceBatchSummary {
        id: batch_id,
        source_file_name: batch_name,
        source_file_hash: batch_hash,
        row_count: batch_row_count,
        status: batch_status,
        imported_at: batch_imported_at,
    };

    let mut inserted_rows = 0usize;
    for chunk in payload.rows.chunks(3_000) {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            INSERT INTO lightspeed_normalization_reference_rows (
                batch_id,
                source_row_number,
                source_row_hash,
                sku,
                handle,
                product_name,
                product_category,
                supplier_name,
                supplier_code,
                brand_name,
                tags,
                variant_option_one_name,
                variant_option_one_value,
                variant_option_two_name,
                variant_option_two_value,
                variant_option_three_name,
                variant_option_three_value,
                raw_row
            )
            "#,
        );
        builder.push_values(chunk, |mut row_builder, row| {
            let option = |idx: usize| row.variant_options.get(idx);
            row_builder
                .push_bind(batch.id)
                .push_bind(row.source_row_number)
                .push_bind(trim_str_opt(Some(&row.source_row_hash)))
                .push_bind(row.sku.trim())
                .push_bind(trim_str_opt(row.handle.as_deref()))
                .push_bind(trim_str_opt(row.name.as_deref()))
                .push_bind(trim_str_opt(row.product_category.as_deref()))
                .push_bind(trim_str_opt(row.supplier_name.as_deref()))
                .push_bind(trim_str_opt(row.supplier_code.as_deref()))
                .push_bind(trim_str_opt(row.brand_name.as_deref()))
                .push_bind(trim_str_opt(row.tags.as_deref()))
                .push_bind(option(0).and_then(|option| trim_str_opt(option.name.as_deref())))
                .push_bind(option(0).and_then(|option| trim_str_opt(option.value.as_deref())))
                .push_bind(option(1).and_then(|option| trim_str_opt(option.name.as_deref())))
                .push_bind(option(1).and_then(|option| trim_str_opt(option.value.as_deref())))
                .push_bind(option(2).and_then(|option| trim_str_opt(option.name.as_deref())))
                .push_bind(option(2).and_then(|option| trim_str_opt(option.value.as_deref())))
                .push_bind(&row.raw_row);
        });
        inserted_rows += builder.build().execute(&mut *tx).await?.rows_affected() as usize;
    }

    tx.commit().await?;
    let health = get_lightspeed_normalization_reference_health(pool).await?;

    Ok(LightspeedNormalizationReferenceImportSummary {
        active_batch: batch,
        inserted_rows,
        replaced_existing_batches: payload.replace,
        health,
    })
}

pub async fn get_lightspeed_normalization_reference_health(
    pool: &PgPool,
) -> Result<LightspeedNormalizationReferenceHealthSummary, CounterpointSyncError> {
    let active_batch: Option<LightspeedNormalizationReferenceBatchSummary> = sqlx::query_as(
        r#"
        SELECT id, source_file_name, source_file_hash, row_count, status, imported_at
        FROM lightspeed_normalization_batches
        WHERE status = 'active'
        ORDER BY imported_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    let Some(batch) = active_batch else {
        let latest_imported_at: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT MAX(imported_at) FROM lightspeed_normalization_batches")
                .fetch_one(pool)
                .await?;
        return Ok(LightspeedNormalizationReferenceHealthSummary {
            active_batch: None,
            row_count: 0,
            b_sku_count: 0,
            duplicate_b_sku_groups: 0,
            latest_imported_at,
        });
    };

    let counts: (i64, i64, i64) = sqlx::query_as(
        r#"
        WITH active_rows AS (
            SELECT normalized_sku
            FROM lightspeed_normalization_reference_rows
            WHERE batch_id = $1
        ),
        b_sku_rows AS (
            SELECT normalized_sku
            FROM active_rows
            WHERE normalized_sku ~ '^b-[0-9]+$'
        ),
        duplicate_b_skus AS (
            SELECT normalized_sku
            FROM b_sku_rows
            GROUP BY normalized_sku
            HAVING COUNT(*) > 1
        )
        SELECT
            (SELECT COUNT(*)::bigint FROM active_rows) AS row_count,
            (SELECT COUNT(*)::bigint FROM b_sku_rows) AS b_sku_count,
            (SELECT COUNT(*)::bigint FROM duplicate_b_skus) AS duplicate_b_sku_groups
        "#,
    )
    .bind(batch.id)
    .fetch_one(pool)
    .await?;

    Ok(LightspeedNormalizationReferenceHealthSummary {
        latest_imported_at: Some(batch.imported_at),
        active_batch: Some(batch),
        row_count: counts.0,
        b_sku_count: counts.1,
        duplicate_b_sku_groups: counts.2,
    })
}

fn is_identifier_like_text(raw: &str) -> bool {
    let compact = compact_upper(raw);
    if compact.len() < 4 {
        return false;
    }

    if compact.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }

    let bytes = compact.as_bytes();
    if bytes.len() >= 5 && matches!(bytes.first(), Some(b'I' | b'B')) && bytes.get(1) == Some(&b'-')
    {
        return compact[2..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    }

    if !compact.contains('-') && !compact.contains('_') && raw.split_whitespace().count() == 1 {
        let digits = compact.chars().filter(|c| c.is_ascii_digit()).count();
        let letters = compact.chars().filter(|c| c.is_ascii_alphabetic()).count();
        return compact.len() >= 6 && digits * 2 >= compact.len() && letters <= 2;
    }

    false
}

fn matches_counterpoint_identifier(raw: &str, identifiers: &[String]) -> bool {
    let candidate = compact_upper(raw);
    !candidate.is_empty()
        && identifiers
            .iter()
            .map(|identifier| compact_upper(identifier))
            .any(|identifier| !identifier.is_empty() && identifier == candidate)
}

fn safe_counterpoint_product_name_candidate(
    raw: Option<&str>,
    identifiers: &[String],
) -> Option<String> {
    let value = collapse_whitespace(raw?.trim());
    if value.is_empty()
        || matches_counterpoint_identifier(&value, identifiers)
        || is_identifier_like_text(&value)
    {
        None
    } else {
        Some(clamp_chars(&value, 255))
    }
}

fn counterpoint_product_name_is_identifier_like(raw: &str, identifiers: &[String]) -> bool {
    matches_counterpoint_identifier(raw, identifiers) || is_identifier_like_text(raw)
}

/// Keep within `customers` varchar limits so Counterpoint-wide fields do not fail the batch.
fn clamp_chars(s: &str, max_chars: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max_chars {
        return t.to_string();
    }
    t.chars().take(max_chars).collect()
}

/// `vendors.name` is UNIQUE (exact string). Counterpoint repeats `NAM` across `VEND_NO`; suffix + retry
/// covers same-batch inserts, pre-existing `Name [code]` rows, and truncation collisions.
async fn allocate_unique_vendor_display_name(
    tx: &mut Transaction<'_, Postgres>,
    row_name: &Option<String>,
    vend_no: &str,
) -> Result<String, CounterpointSyncError> {
    let base_display = trim_opt(row_name).unwrap_or_else(|| vend_no.to_string());
    let base_trim = base_display.trim();

    let lower_clash: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM vendors
            WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
              AND (vendor_code IS NULL OR TRIM(vendor_code) <> TRIM($2))
        )
        "#,
    )
    .bind(base_trim)
    .bind(vend_no)
    .fetch_one(&mut **tx)
    .await?;

    let mut attempt: u32 = 0;
    loop {
        let candidate = if attempt == 0 && !lower_clash {
            clamp_chars(base_trim, 255)
        } else if attempt == 0 {
            let sfx = format!(" [{vend_no}]");
            let room = 255usize.saturating_sub(sfx.chars().count()).max(1);
            format!("{}{}", clamp_chars(base_trim, room), sfx)
        } else {
            let sfx = format!(" [{vend_no}]#{attempt}");
            let room = 255usize.saturating_sub(sfx.chars().count()).max(1);
            format!("{}{}", clamp_chars(base_trim, room), sfx)
        };

        let name_taken: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM vendors
                WHERE name = $1
                  AND (vendor_code IS NULL OR TRIM(vendor_code) <> TRIM($2))
            )
            "#,
        )
        .bind(&candidate)
        .bind(vend_no)
        .fetch_one(&mut **tx)
        .await?;

        if !name_taken {
            return Ok(candidate);
        }

        attempt += 1;
        if attempt > 200 {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "could not allocate unique vendor name for VEND_NO {vend_no} (base={base_trim:?})"
            )));
        }
    }
}

fn parse_dob(raw: &str) -> Option<NaiveDate> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .ok()
        .or_else(|| NaiveDate::parse_from_str(t, "%m/%d/%Y").ok())
}

fn resolve_names(row: &CounterpointCustomerRow, code: &str) -> (String, String, Option<String>) {
    let company = trim_opt(&row.company_name);
    let mut first = trim_opt(&row.first_name).unwrap_or_default();
    let mut last = trim_opt(&row.last_name).unwrap_or_default();
    if first.is_empty() && last.is_empty() {
        if let Some(ref nam) = trim_opt(&row.full_name) {
            if let Some((a, b)) = nam.split_once(',') {
                last = a.trim().to_string();
                first = b.trim().to_string();
            } else if let Some(idx) = nam.find(' ') {
                first = nam[..idx].trim().to_string();
                last = nam[idx..].trim().to_string();
            } else {
                first = nam.clone();
            }
        }
    }
    if first.is_empty() && last.is_empty() {
        if let Some(ref c) = company {
            first = "Company".to_string();
            last = c.clone();
        } else {
            first = "Imported".to_string();
            last = code.to_string();
        }
    }
    (first, last, company)
}

async fn email_taken_by_other(
    tx: &mut Transaction<'_, Postgres>,
    email: &str,
    exclude_customer_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let exists: bool = match exclude_customer_id {
        Some(id) => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM customers WHERE lower(trim(email)) = lower(trim($1)) AND id <> $2)",
        )
        .bind(email)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?,
        None => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM customers WHERE lower(trim(email)) = lower(trim($1)))",
        )
        .bind(email)
        .fetch_one(&mut **tx)
        .await?,
    };
    Ok(exists)
}

async fn upsert_customer_row(
    tx: &mut Transaction<'_, Postgres>,
    row: &CounterpointCustomerRow,
    summary: &mut CounterpointCustomerBatchSummary,
    staff_map: &HashMap<String, Uuid>,
    email_conflicts: &mut Vec<CounterpointCustomerEmailConflict>,
    force_omit_email_reason: Option<&str>,
) -> Result<(), sqlx::Error> {
    let code = row.cust_no.trim();
    if code.is_empty() {
        summary.skipped += 1;
        return Ok(());
    }
    let code = code.to_string();

    let (first_name, last_name, company_name) = resolve_names(row, &code);
    let first_name = clamp_chars(&first_name, 100);
    let last_name = clamp_chars(&last_name, 100);
    let email_raw = trim_opt(&row.email)
        .map(|e| e.to_lowercase())
        .map(|e| clamp_chars(&e, 255));
    let phone = trim_opt(&row.phone).map(|p| clamp_chars(&p, 20));
    let address_line1 = trim_opt(&row.address_line1);
    let address_line2 = trim_opt(&row.address_line2);
    let city = trim_opt(&row.city);
    let state = trim_opt(&row.state);
    let postal_code = trim_opt(&row.postal_code);

    let dob = row.date_of_birth.as_deref().and_then(parse_dob);

    // Set promotional opt-ins to ON by default for Counterpoint sync
    // Operational opt-ins always ON (pickup, alterations, appointments, etc.)
    let m_email = row.marketing_email_opt_in.unwrap_or(true);
    let m_sms = row.marketing_sms_opt_in.unwrap_or(true);
    let t_email = true; // Operational email always ON
    let t_sms = true; // Operational SMS always ON
    let loyalty_pts = row.loyalty_points;
    let cust_type = trim_opt(&row.customer_type);
    let ar_bal = trim_opt(&row.ar_balance);
    let preferred_rep = row
        .sls_rep
        .as_deref()
        .and_then(|c| staff_map.get(c.trim()))
        .copied();

    let existing_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
            .bind(&code)
            .fetch_optional(&mut **tx)
            .await?;

    let source_payload = serde_json::to_value(row).unwrap_or_else(|_| {
        serde_json::json!({
            "cust_no": &code,
            "email": email_raw,
        })
    });
    let mut email_to_set = email_raw.clone();
    if let (Some(em), Some(reason)) = (email_raw.as_ref(), force_omit_email_reason) {
        email_conflicts.push(CounterpointCustomerEmailConflict {
            customer_code: code.clone(),
            original_email: em.clone(),
            reason: reason.to_string(),
            source_payload: source_payload.clone(),
        });
        summary.email_conflicts += 1;
        email_to_set = None;
    } else if let Some(ref em) = email_to_set {
        if email_taken_by_other(tx, em, existing_id).await? {
            email_conflicts.push(CounterpointCustomerEmailConflict {
                customer_code: code.clone(),
                original_email: em.clone(),
                reason: "email_already_used_by_existing_customer".into(),
                source_payload: source_payload.clone(),
            });
            email_to_set = None;
            summary.email_conflicts += 1;
        }
    }

    if let Some(id) = existing_id {
        sqlx::query(
            r#"
            UPDATE customers SET
                first_name = $2, last_name = $3, company_name = $4,
                email = COALESCE($5, email),
                phone = $6,
                address_line1 = $7, address_line2 = $8, city = $9, state = $10, postal_code = $11,
                date_of_birth = COALESCE($12, date_of_birth),
                marketing_email_opt_in = $13, marketing_sms_opt_in = $14,
                transactional_sms_opt_in = $15,
                transactional_email_opt_in = $16,
                loyalty_points = COALESCE($17, loyalty_points),
                custom_field_1 = COALESCE($18, custom_field_1),
                custom_field_2 = COALESCE($19, custom_field_2),
                preferred_salesperson_id = COALESCE($20, preferred_salesperson_id)
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&first_name)
        .bind(&last_name)
        .bind(&company_name)
        .bind(&email_to_set)
        .bind(&phone)
        .bind(&address_line1)
        .bind(&address_line2)
        .bind(&city)
        .bind(&state)
        .bind(&postal_code)
        .bind(dob)
        .bind(m_email)
        .bind(m_sms)
        .bind(t_sms)
        .bind(t_email)
        .bind(loyalty_pts)
        .bind(&cust_type)
        .bind(&ar_bal)
        .bind(preferred_rep)
        .execute(&mut **tx)
        .await?;
        summary.updated += 1;
    } else {
        sqlx::query(
            r#"
            INSERT INTO customers (
                customer_code, first_name, last_name, company_name,
                email, phone,
                address_line1, address_line2, city, state, postal_code,
                date_of_birth, anniversary_date,
                custom_field_1, custom_field_2, custom_field_3, custom_field_4,
                marketing_email_opt_in, marketing_sms_opt_in, transactional_sms_opt_in,
                transactional_email_opt_in, customer_created_source, loyalty_points,
                preferred_salesperson_id
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,NULL,NULL,$15,$16,$17,$18,'counterpoint',COALESCE($19,0),$20)
            "#,
        )
        .bind(&code)
        .bind(&first_name)
        .bind(&last_name)
        .bind(&company_name)
        .bind(&email_to_set)
        .bind(&phone)
        .bind(&address_line1)
        .bind(&address_line2)
        .bind(&city)
        .bind(&state)
        .bind(&postal_code)
        .bind(dob)
        .bind(&cust_type)
        .bind(&ar_bal)
        .bind(m_email)
        .bind(m_sms)
        .bind(t_sms)
        .bind(t_email)
        .bind(loyalty_pts)
        .bind(preferred_rep)
        .execute(&mut **tx)
        .await?;
        summary.created += 1;
    }

    Ok(())
}

fn is_customers_email_unique_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(db_error) => {
            db_error.constraint() == Some("customers_email_key")
                || db_error.message().contains("customers_email_key")
        }
        _ => false,
    }
}

async fn record_counterpoint_customer_email_conflict_exceptions(
    pool: &PgPool,
    conflicts: Vec<CounterpointCustomerEmailConflict>,
) {
    for conflict in conflicts {
        record_counterpoint_import_exception(
            pool,
            "customers",
            Some(&conflict.customer_code),
            "warning",
            "duplicate_customer_email",
            &format!(
                "Counterpoint customer {} was imported without email {} because that email is already used by another customer.",
                conflict.customer_code, conflict.original_email
            ),
            Some("Review the customer duplicate email after import. Merge or correct the customer record before final go-live sign-off."),
            false,
            Some("customers"),
            None,
            serde_json::json!({
                "customer_code": conflict.customer_code,
                "original_email": conflict.original_email,
                "reason": conflict.reason,
                "landed_without_email": true,
                "source_row": conflict.source_payload,
            }),
        )
        .await;
    }
}

pub async fn execute_counterpoint_customer_batch(
    pool: &PgPool,
    payload: CounterpointCustomersPayload,
) -> Result<CounterpointCustomerBatchSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    // High-performance staff cache for salesperson resolution
    let staff_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT cp_code, ros_staff_id FROM counterpoint_staff_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let mut summary = CounterpointCustomerBatchSummary {
        created: 0,
        updated: 0,
        skipped: 0,
        email_conflicts: 0,
    };
    let mut email_conflicts = Vec::new();
    let mut tx = pool.begin().await?;

    for row in &payload.rows {
        sqlx::query("SAVEPOINT counterpoint_customer_row")
            .execute(&mut *tx)
            .await?;
        let result = upsert_customer_row(
            &mut tx,
            row,
            &mut summary,
            &staff_map,
            &mut email_conflicts,
            None,
        )
        .await;
        match result {
            Ok(()) => {
                sqlx::query("RELEASE SAVEPOINT counterpoint_customer_row")
                    .execute(&mut *tx)
                    .await?;
            }
            Err(error) if is_customers_email_unique_violation(&error) => {
                sqlx::query("ROLLBACK TO SAVEPOINT counterpoint_customer_row")
                    .execute(&mut *tx)
                    .await?;
                upsert_customer_row(
                    &mut tx,
                    row,
                    &mut summary,
                    &staff_map,
                    &mut email_conflicts,
                    Some("customers_email_key_retry"),
                )
                .await?;
                sqlx::query("RELEASE SAVEPOINT counterpoint_customer_row")
                    .execute(&mut *tx)
                    .await?;
            }
            Err(error) => {
                tx.rollback().await?;
                return Err(error.into());
            }
        }
    }

    tx.commit().await?;
    record_counterpoint_customer_email_conflict_exceptions(pool, email_conflicts).await;

    if let Some(ref s) = payload.sync {
        if s.entity == "customers" {
            let _ = record_sync_run(
                pool,
                "customers",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated + summary.skipped),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

pub async fn execute_counterpoint_inventory_batch(
    pool: &PgPool,
    payload: CounterpointInventoryPayload,
) -> Result<CounterpointInventorySummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let filtered = filter_inventory_payload_for_quarantine(payload)?;
    let total_rows = filtered.total_rows;
    let quarantined = filtered.quarantined;
    persist_counterpoint_ingest_quarantine_records(pool, &filtered.records).await?;
    let payload = filtered.payload;

    if payload.rows.is_empty() {
        let updated = 0;
        let skipped = total_rows as i32;
        if let Some(ref s) = payload.sync {
            if s.entity == "inventory" {
                let _ = record_sync_run(
                    pool,
                    "inventory",
                    s.cursor.as_deref(),
                    true,
                    Some(updated + skipped),
                    None,
                )
                .await;
            }
        }
        return Ok(CounterpointInventorySummary {
            updated,
            skipped,
            quarantined,
        });
    }

    let mut tx = pool.begin().await?;

    // 1. Separate items by how we resolve them (key vs sku)
    let mut keyed_keys = Vec::new();
    let mut keyed_soh = Vec::new();
    let mut keyed_cost = Vec::new();

    let mut sku_skus = Vec::new();
    let mut sku_keys = Vec::new();
    let mut sku_soh = Vec::new();
    let mut sku_cost = Vec::new();
    let mut requested_keys = Vec::new();
    let mut requested_skus = Vec::new();

    for row in &payload.rows {
        let sku = row.sku.trim();
        if sku.is_empty() {
            continue;
        }
        requested_skus.push(sku.to_lowercase());
        if let Some(ref key) = trim_opt(&row.counterpoint_item_key) {
            requested_keys.push(key.clone());
            keyed_keys.push(key.clone());
            keyed_soh.push(row.stock_on_hand);
            keyed_cost.push(row.unit_cost);
            sku_skus.push(sku.to_string());
            sku_keys.push(Some(key.clone()));
            sku_soh.push(row.stock_on_hand);
            sku_cost.push(row.unit_cost);
        } else {
            sku_skus.push(sku.to_string());
            sku_keys.push(None::<String>);
            sku_soh.push(row.stock_on_hand);
            sku_cost.push(row.unit_cost);
        }
    }

    // Bulk Update By Key
    if !keyed_keys.is_empty() {
        sqlx::query(
            r#"
            UPDATE product_variants AS v
            SET
                stock_on_hand = u.soh,
                cost_override = COALESCE(u.cost, v.cost_override)
            FROM UNNEST($1::text[], $2::int[], $3::numeric[]) AS u(key, soh, cost)
            WHERE v.counterpoint_item_key = u.key
            "#,
        )
        .bind(&keyed_keys)
        .bind(&keyed_soh)
        .bind(&keyed_cost)
        .execute(&mut *tx)
        .await?;
    }

    // Bulk Update By SKU. This also retries keyed rows whose Counterpoint key has not
    // landed yet but whose barcode/SKU already exists in ROS.
    if !sku_skus.is_empty() {
        sqlx::query(
            r#"
            UPDATE product_variants AS v
            SET
                stock_on_hand = u.soh,
                cost_override = COALESCE(u.cost, v.cost_override),
                counterpoint_item_key = COALESCE(v.counterpoint_item_key, u.key)
            FROM UNNEST($1::text[], $2::text[], $3::int[], $4::numeric[]) AS u(sku, key, soh, cost)
            WHERE lower(trim(v.sku)) = lower(trim(u.sku))
            "#,
        )
        .bind(&sku_skus)
        .bind(&sku_keys)
        .bind(&sku_soh)
        .bind(&sku_cost)
        .execute(&mut *tx)
        .await?;
    }

    let matched_keys: HashSet<String> = if requested_keys.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT counterpoint_item_key FROM product_variants WHERE counterpoint_item_key = ANY($1)",
        )
        .bind(&requested_keys)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };
    let matched_skus: HashSet<String> = if requested_skus.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT lower(trim(sku)) FROM product_variants WHERE lower(trim(sku)) = ANY($1)",
        )
        .bind(&requested_skus)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    let mut matched_issue_keys = Vec::new();
    let mut matched_row_count = 0;
    let mut unmatched_issues = Vec::new();
    for row in &payload.rows {
        let sku = row.sku.trim();
        if sku.is_empty() {
            continue;
        }
        let key = trim_opt(&row.counterpoint_item_key);
        let matched = key.as_ref().is_some_and(|k| matched_keys.contains(k))
            || matched_skus.contains(&sku.to_lowercase());
        let external_key = key.clone().unwrap_or_else(|| sku.to_string());
        if matched {
            matched_row_count += 1;
            matched_issue_keys.push(external_key.clone());
            if let Some((parent_key, _)) = external_key.split_once('|') {
                let parent_key = parent_key.trim();
                if !parent_key.is_empty() {
                    matched_issue_keys.push(parent_key.to_string());
                }
            }
        } else {
            unmatched_issues.push((
                external_key,
                format!(
                    "Inventory quantity row unresolved: sku={sku:?} counterpoint_item_key={:?}",
                    key.as_deref().unwrap_or("")
                ),
            ));
        }
    }

    let updated = matched_row_count;
    let skipped = (total_rows as i32) - updated;

    tx.commit().await?;

    for external_key in matched_issue_keys {
        resolve_sync_issue_by_key(pool, "inventory", &external_key).await;
    }
    for (external_key, message) in unmatched_issues {
        record_sync_issue(pool, "inventory", Some(&external_key), "error", &message).await;
    }

    if let Some(ref s) = payload.sync {
        if s.entity == "inventory" {
            let _ = record_sync_run(
                pool,
                "inventory",
                s.cursor.as_deref(),
                true,
                Some(updated + skipped),
                None,
            )
            .await;
        }
    }

    Ok(CounterpointInventorySummary {
        updated,
        skipped,
        quarantined,
    })
}

pub async fn execute_counterpoint_receiving_batch(
    pool: &PgPool,
    payload: CounterpointReceivingPayload,
) -> Result<CounterpointReceivingSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload("rows empty".into()));
    }
    let mut tx = pool.begin().await?;
    let mut inserted = 0;
    let mut skipped = 0;

    for row in &payload.rows {
        let recv_dat = match DateTime::parse_from_rfc3339(&row.recv_dat) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        // Try to link to a variant for easier reporting
        let variant_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM product_variants WHERE sku = $1")
                .bind(&row.item_no)
                .fetch_optional(&mut *tx)
                .await?;

        let already_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM counterpoint_receiving_history
                WHERE vend_no = $1
                  AND item_no = $2
                  AND recv_dat = $3
                  AND unit_cost = $4
                  AND qty_recv = $5
                  AND po_no IS NOT DISTINCT FROM $6
                  AND recv_no IS NOT DISTINCT FROM $7
            )
            "#,
        )
        .bind(&row.vend_no)
        .bind(&row.item_no)
        .bind(recv_dat)
        .bind(row.unit_cost)
        .bind(row.qty_recv)
        .bind(&row.po_no)
        .bind(&row.recv_no)
        .fetch_one(&mut *tx)
        .await?;

        if already_exists {
            skipped += 1;
            continue;
        }

        sqlx::query(
            r#"
            INSERT INTO counterpoint_receiving_history (
                vend_no, item_no, recv_dat, unit_cost, qty_recv, po_no, recv_no, variant_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(&row.vend_no)
        .bind(&row.item_no)
        .bind(recv_dat)
        .bind(row.unit_cost)
        .bind(row.qty_recv)
        .bind(&row.po_no)
        .bind(&row.recv_no)
        .bind(variant_id)
        .execute(&mut *tx)
        .await?;

        inserted += 1;
    }

    tx.commit().await?;
    if let Some(ref s) = payload.sync {
        let _ = record_sync_run(
            pool,
            &s.entity,
            s.cursor.as_deref(),
            true,
            Some(inserted + skipped),
            None,
        )
        .await;
    }

    Ok(CounterpointReceivingSummary { inserted, skipped })
}

pub async fn record_sync_run(
    pool: &PgPool,
    entity: &str,
    cursor: Option<&str>,
    ok: bool,
    records_processed: Option<i32>,
    err: Option<&str>,
) -> Result<(), sqlx::Error> {
    if ok {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_sync_runs (entity, cursor_value, last_ok_at, last_error, records_processed, updated_at)
            VALUES ($1, $2, NOW(), NULL, $3, NOW())
            ON CONFLICT (entity) DO UPDATE SET
                cursor_value = EXCLUDED.cursor_value,
                last_ok_at = NOW(),
                last_error = NULL,
                records_processed = COALESCE(counterpoint_sync_runs.records_processed, 0)
                    + COALESCE(EXCLUDED.records_processed, 0),
                updated_at = NOW()
            "#,
        )
        .bind(entity)
        .bind(cursor)
        .bind(records_processed)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_sync_runs (entity, cursor_value, last_ok_at, last_error, updated_at)
            VALUES ($1, $2, NULL, $3, NOW())
            ON CONFLICT (entity) DO UPDATE SET
                last_error = EXCLUDED.last_error,
                updated_at = NOW()
            "#,
        )
        .bind(entity)
        .bind(cursor)
        .bind(err)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn begin_sync_run(
    pool: &PgPool,
    entity: &str,
    cursor: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO counterpoint_sync_runs (entity, cursor_value, records_processed, updated_at)
        VALUES ($1, $2, 0, NOW())
        ON CONFLICT (entity) DO UPDATE SET
            cursor_value = EXCLUDED.cursor_value,
            records_processed = 0,
            last_error = NULL,
            updated_at = NOW()
        "#,
    )
    .bind(entity)
    .bind(cursor)
    .execute(pool)
    .await?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Heartbeat
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct HeartbeatPayload {
    pub phase: String,
    #[serde(default)]
    pub current_entity: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HeartbeatResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_request_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_request_entity: Option<String>,
}

pub async fn upsert_heartbeat(
    pool: &PgPool,
    payload: &HeartbeatPayload,
) -> Result<HeartbeatResponse, sqlx::Error> {
    let phase = payload.phase.trim();
    let phase = if phase.is_empty() { "idle" } else { phase };

    sqlx::query(
        r#"
        UPDATE counterpoint_bridge_heartbeat SET
            last_seen_at = NOW(),
            bridge_phase = $1,
            current_entity = $2,
            bridge_version = $3,
            bridge_hostname = $4,
            updated_at = NOW()
        WHERE id = 1
        "#,
    )
    .bind(phase)
    .bind(&payload.current_entity)
    .bind(&payload.version)
    .bind(&payload.hostname)
    .execute(pool)
    .await?;

    let pending: Option<(i64, Option<String>)> = sqlx::query_as(
        "SELECT id, entity FROM counterpoint_sync_request WHERE acked_at IS NULL AND completed_at IS NULL ORDER BY requested_at LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    Ok(HeartbeatResponse {
        ok: true,
        pending_request_id: pending.as_ref().map(|r| r.0),
        pending_request_entity: pending.and_then(|r| r.1),
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Sync status for Settings UI
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SyncStatusResponse {
    pub windows_sync_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_reason: Option<String>,
    pub bridge_phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<DateTime<Utc>>,
    pub entity_runs: Vec<EntityRunRow>,
    pub recent_issues: Vec<SyncIssueRow>,
    pub token_configured: bool,
    pub counterpoint_staging_enabled: bool,
    pub staging_pending_count: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct EntityRunRow {
    pub entity: String,
    pub cursor_value: Option<String>,
    pub last_ok_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub records_processed: Option<i32>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SyncIssueRow {
    pub id: i64,
    pub entity: String,
    pub external_key: Option<String>,
    pub severity: String,
    pub message: String,
    pub resolved: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone, sqlx::FromRow)]
pub struct CounterpointImportRunSnapshot {
    pub id: Uuid,
    pub run_kind: String,
    pub status: String,
    pub history_start: NaiveDate,
    pub bridge_hostname: Option<String>,
    pub bridge_version: Option<String>,
    pub ros_base_url: Option<String>,
    pub source_fingerprint: Option<String>,
    pub preflight_passed: bool,
    pub preflight_blockers: JsonValue,
    pub totals: JsonValue,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointImportCommandCenterSummary {
    pub generated_at: DateTime<Utc>,
    pub mode: String,
    pub required_history_start: String,
    pub token_configured: bool,
    pub preflight_received: bool,
    pub import_run_received: bool,
    pub proof_scope: String,
    pub proof_scope_note: String,
    pub latest_preflight: Option<CounterpointImportRunSnapshot>,
    pub latest_import_run: Option<CounterpointImportRunSnapshot>,
    pub source_counts: Vec<CounterpointImportPreflightRow>,
    pub landing_rows: Vec<CounterpointLandingVerificationRow>,
    pub snapshot_reconciliation: Vec<CounterpointSnapshotReconciliationRow>,
    pub open_exception_count: i64,
    pub fallback_landed_exception_count: i64,
    pub staging_open_count: i64,
    pub ready_for_import: bool,
    pub ready_for_go_live_review: bool,
    pub recommendation: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CounterpointImportExceptionRow {
    pub id: Uuid,
    pub entity_key: String,
    pub source_key: Option<String>,
    pub severity: String,
    pub reason_code: String,
    pub message: String,
    pub suggested_fix: Option<String>,
    pub fallback_landed: bool,
    pub ros_table: Option<String>,
    pub ros_id: Option<Uuid>,
    pub source_payload: JsonValue,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointLandingVerificationRow {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub confidence: String,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointSnapshotReconciliationRow {
    pub key: String,
    pub label: String,
    pub status: String,
    pub passed: bool,
    pub source_count: Option<i64>,
    pub landed_count: i64,
    pub count_difference: Option<i64>,
    pub source_sum: Option<String>,
    pub landed_sum: String,
    pub sum_difference: Option<String>,
    pub source_checksum: Option<String>,
    pub landed_checksum: Option<String>,
    pub checksum_matched: Option<bool>,
    pub note: String,
    pub source_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointFidelityDiagnosticPayload {
    pub group: String,
    #[serde(default)]
    pub rows: Vec<CounterpointFidelityDiagnosticSourceRow>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointFidelityDiagnosticSourceRow {
    #[serde(default)]
    pub item_no: Option<String>,
    #[serde(default)]
    pub counterpoint_item_key: Option<String>,
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub barcode: Option<String>,
    #[serde(default)]
    pub retail_price: Option<String>,
    #[serde(default)]
    pub unit_cost: Option<String>,
    #[serde(default)]
    pub prc_2: Option<String>,
    #[serde(default)]
    pub prc_3: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub vendor_no: Option<String>,
    #[serde(default)]
    pub variation_label: Option<String>,
    #[serde(default)]
    pub stock_on_hand: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CounterpointFidelityDiagnosticMismatch {
    pub group: String,
    pub item_key: Option<String>,
    pub sku: Option<String>,
    pub barcode: Option<String>,
    pub field: String,
    pub counterpoint_value: String,
    pub ros_value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CounterpointFidelityDiagnosticReport {
    pub group: String,
    pub generated_at: DateTime<Utc>,
    pub total_source_rows: i64,
    pub compared_rows: i64,
    pub mismatch_count: i64,
    pub result_limit: usize,
    pub mismatches: Vec<CounterpointFidelityDiagnosticMismatch>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointCutoverVisibilityRow {
    pub key: String,
    pub label: String,
    pub status: String,
    pub passed: bool,
    pub count: i64,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointLandingVerificationSummary {
    pub generated_at: DateTime<Utc>,
    pub disclaimer: String,
    pub rows: Vec<CounterpointLandingVerificationRow>,
    pub snapshot_reconciliation: Vec<CounterpointSnapshotReconciliationRow>,
    pub cutover_visibility: Vec<CounterpointCutoverVisibilityRow>,
    pub fidelity_diagnostics: Vec<CounterpointFidelityDiagnosticReport>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointTransactionReconciliationTotals {
    pub imported_ticket_transactions: i64,
    pub transaction_lines: i64,
    pub imported_zero_tax_lines: i64,
    pub payments: i64,
    pub transaction_total_sum: String,
    pub payment_amount_sum: String,
    pub difference: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointTransactionReconciliationByDateRow {
    pub business_day: NaiveDate,
    pub imported_ticket_transactions: i64,
    pub transaction_lines: i64,
    pub payments: i64,
    pub transaction_total_sum: String,
    pub payment_amount_sum: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointTransactionReconciliationByPaymentTypeRow {
    pub payment_type: String,
    pub payments: i64,
    pub payment_amount_sum: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointTransactionReconciliationSnapshot {
    pub generated_at: DateTime<Utc>,
    pub disclaimer: String,
    pub totals: CounterpointTransactionReconciliationTotals,
    pub by_date: Vec<CounterpointTransactionReconciliationByDateRow>,
    pub by_payment_type: Vec<CounterpointTransactionReconciliationByPaymentTypeRow>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointOpenDocsVerificationSnapshot {
    pub generated_at: DateTime<Utc>,
    pub disclaimer: String,
    pub imported_open_doc_transactions: i64,
    pub imported_open_doc_lines: i64,
    pub imported_open_doc_zero_tax_lines: i64,
    pub imported_open_doc_payments: i64,
    pub open_docs_with_customer_linked: i64,
    pub open_docs_missing_customer: i64,
    pub open_docs_with_zero_lines: i64,
    pub open_docs_with_zero_payments: i64,
    pub distinct_staff_attribution_count: i64,
}

#[derive(Debug, Serialize)]
pub struct CounterpointInventoryCatalogVerificationSnapshot {
    pub generated_at: DateTime<Utc>,
    pub disclaimer: String,
    pub counterpoint_products: i64,
    pub counterpoint_variants: i64,
    pub products_with_identifier_like_name: i64,
    pub products_name_equals_counterpoint_key: i64,
    pub variants_with_sku: i64,
    pub variants_with_barcode: i64,
    pub variants_with_cost: i64,
    pub variants_with_price: i64,
    pub variants_with_quantity_on_hand: i64,
    pub variants_missing_sku: i64,
    pub variants_missing_barcode: i64,
    pub variants_missing_cost: i64,
    pub variants_missing_price: i64,
    pub variants_zero_or_negative_quantity: i64,
    pub products_missing_category_mapping: i64,
    pub variants_missing_vendor_supplier_item_link: i64,
    pub distinct_vendors_linked_to_imported_items: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct CounterpointInventoryCatalogVerificationCounts {
    counterpoint_products: i64,
    counterpoint_variants: i64,
    products_with_identifier_like_name: i64,
    products_name_equals_counterpoint_key: i64,
    variants_with_sku: i64,
    variants_with_barcode: i64,
    variants_with_cost: i64,
    variants_with_price: i64,
    variants_with_quantity_on_hand: i64,
    variants_missing_sku: i64,
    variants_missing_barcode: i64,
    variants_missing_cost: i64,
    variants_missing_price: i64,
    variants_zero_or_negative_quantity: i64,
    products_missing_category_mapping: i64,
    variants_missing_vendor_supplier_item_link: i64,
    distinct_vendors_linked_to_imported_items: i64,
}

const HEARTBEAT_TTL_SECONDS: i64 = 120;

pub async fn get_sync_status(
    pool: &PgPool,
    token_configured: bool,
) -> Result<SyncStatusResponse, sqlx::Error> {
    let hb = sqlx::query_as::<_, (DateTime<Utc>, String, Option<String>, Option<String>, Option<String>)>(
        "SELECT last_seen_at, bridge_phase, current_entity, bridge_version, bridge_hostname FROM counterpoint_bridge_heartbeat WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    let latest_run_activity: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT updated_at FROM counterpoint_sync_runs ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    let freshest_seen =
        |heartbeat_seen: Option<DateTime<Utc>>| match (heartbeat_seen, latest_run_activity) {
            (Some(heartbeat), Some(run_activity)) => Some(heartbeat.max(run_activity)),
            (Some(heartbeat), None) => Some(heartbeat),
            (None, Some(run_activity)) => Some(run_activity),
            (None, None) => None,
        };

    let (state, offline_reason, phase, entity, version, hostname, last_seen) = match hb {
        Some((seen, phase, entity, ver, host)) => {
            let activity_seen = freshest_seen(Some(seen));
            if !token_configured {
                (
                    "offline".into(),
                    Some("Counterpoint sync token is not saved/configured on the Main Hub".into()),
                    phase,
                    entity,
                    ver,
                    host,
                    activity_seen,
                )
            } else {
                let age = activity_seen
                    .map(|last| Utc::now().signed_duration_since(last).num_seconds())
                    .unwrap_or(i64::MAX);
                if age > HEARTBEAT_TTL_SECONDS {
                    (
                        "offline".into(),
                        Some(format!(
                            "Last bridge activity {age}s ago (TTL {HEARTBEAT_TTL_SECONDS}s)"
                        )),
                        phase,
                        entity,
                        ver,
                        host,
                        activity_seen,
                    )
                } else if phase == "syncing"
                    || latest_run_activity
                        .map(|run_activity| run_activity > seen)
                        .unwrap_or(false)
                {
                    (
                        "syncing".into(),
                        None,
                        phase,
                        entity,
                        ver,
                        host,
                        activity_seen,
                    )
                } else {
                    (
                        "online".into(),
                        None,
                        phase,
                        entity,
                        ver,
                        host,
                        activity_seen,
                    )
                }
            }
        }
        None => {
            if !token_configured {
                (
                    "offline".into(),
                    Some("Counterpoint sync token is not saved/configured on the Main Hub".into()),
                    "idle".into(),
                    None,
                    None,
                    None,
                    None,
                )
            } else if let Some(activity_seen) = freshest_seen(None) {
                let age = Utc::now()
                    .signed_duration_since(activity_seen)
                    .num_seconds();
                if age > HEARTBEAT_TTL_SECONDS {
                    (
                        "offline".into(),
                        Some(format!(
                            "Last bridge activity {age}s ago (TTL {HEARTBEAT_TTL_SECONDS}s)"
                        )),
                        "idle".into(),
                        None,
                        None,
                        None,
                        Some(activity_seen),
                    )
                } else {
                    (
                        "syncing".into(),
                        None,
                        "syncing".into(),
                        None,
                        None,
                        None,
                        Some(activity_seen),
                    )
                }
            } else {
                (
                    "offline".into(),
                    Some("No heartbeat received yet".into()),
                    "idle".into(),
                    None,
                    None,
                    None,
                    None,
                )
            }
        }
    };

    let entity_runs: Vec<EntityRunRow> = sqlx::query_as(
        "SELECT entity, cursor_value, last_ok_at, last_error, records_processed, updated_at FROM counterpoint_sync_runs ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await?;

    let recent_issues: Vec<SyncIssueRow> = sqlx::query_as(
        "SELECT id, entity, external_key, severity, message, resolved, created_at FROM counterpoint_sync_issue WHERE NOT resolved ORDER BY created_at DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await?;

    let counterpoint_staging_enabled: bool = sqlx::query_scalar(
        r#"SELECT COALESCE((counterpoint_config->>'staging_enabled')::boolean, false) FROM store_settings WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(false);

    let staging_pending_count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint FROM counterpoint_staging_batch WHERE status = 'pending'"#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    Ok(SyncStatusResponse {
        windows_sync_state: state,
        offline_reason,
        bridge_phase: phase,
        current_entity: entity,
        bridge_version: version,
        bridge_hostname: hostname,
        last_seen_at: last_seen,
        entity_runs,
        recent_issues,
        token_configured,
        counterpoint_staging_enabled,
        staging_pending_count,
    })
}

fn normalize_import_entity_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn normalize_import_count_status(value: Option<&str>) -> &'static str {
    match value.unwrap_or("ok").trim().to_ascii_lowercase().as_str() {
        "ok" | "pass" | "passed" => "ok",
        "warning" | "warn" => "warning",
        "blocked" | "blocker" | "failed" | "fail" => "blocked",
        "missing_mapping" | "missing-mapping" | "missing" => "missing_mapping",
        _ => "warning",
    }
}

fn default_suspicious_min_for_import_entity(entity_key: &str) -> Option<i64> {
    match entity_key {
        "tickets" => Some(COUNTERPOINT_TICKET_SUSPICIOUS_MIN),
        "open_docs" => Some(COUNTERPOINT_OPEN_DOC_SUSPICIOUS_MIN),
        _ => None,
    }
}

fn counterpoint_preflight_required_probe_entities() -> &'static [&'static str] {
    &[
        "customers",
        "catalog_products",
        "catalog_variants",
        "inventory_quantity_rows",
        "tickets",
        "ticket_lines",
        "ticket_payments",
        "receiving_history",
        "open_docs",
        "open_doc_lines",
        "open_doc_payments",
        "gift_cards",
        "loyalty_points",
    ]
}

fn counterpoint_preflight_zero_block_entities() -> &'static [&'static str] {
    &[
        "customers",
        "catalog_products",
        "catalog_variants",
        "inventory_quantity_rows",
        "tickets",
        "ticket_lines",
        "receiving_history",
        "open_docs",
        "open_doc_lines",
        "gift_cards",
        "loyalty_points",
    ]
}

fn push_import_preflight_blocker(
    blockers: &mut Vec<CounterpointImportPreflightBlocker>,
    entity_key: Option<&str>,
    reason_code: &str,
    message: impl Into<String>,
) {
    blockers.push(CounterpointImportPreflightBlocker {
        entity_key: entity_key.map(str::to_string),
        reason_code: reason_code.to_string(),
        message: message.into(),
    });
}

pub async fn record_counterpoint_import_preflight(
    pool: &PgPool,
    payload: CounterpointImportPreflightPayload,
) -> Result<CounterpointImportPreflightSummary, CounterpointSyncError> {
    let history_start = payload
        .history_start
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(COUNTERPOINT_IMPORT_HISTORY_START)
        .to_string();

    let mut blockers = Vec::new();
    if history_start != COUNTERPOINT_IMPORT_HISTORY_START {
        push_import_preflight_blocker(
            &mut blockers,
            None,
            "history_start_mismatch",
            format!(
                "Bridge history start must be {COUNTERPOINT_IMPORT_HISTORY_START}; received {history_start}"
            ),
        );
    }
    if !payload.import_first {
        push_import_preflight_blocker(
            &mut blockers,
            None,
            "import_first_disabled",
            "Bridge is not running in import-first mode.",
        );
    }
    if payload.staging_enabled {
        push_import_preflight_blocker(
            &mut blockers,
            None,
            "staging_queue_enabled",
            "Bridge reported staging queue mode; this import workflow must post directly into ROS import endpoints.",
        );
    }
    if payload
        .ros_base_url
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        push_import_preflight_blocker(
            &mut blockers,
            None,
            "missing_ros_base_url",
            "Bridge did not report a ROS base URL.",
        );
    }
    for issue in &payload.startup_issues {
        let issue = issue.trim();
        if !issue.is_empty() {
            push_import_preflight_blocker(
                &mut blockers,
                None,
                "bridge_startup_issue",
                issue.to_string(),
            );
        }
    }
    if payload.counts.is_empty() {
        push_import_preflight_blocker(
            &mut blockers,
            None,
            "missing_source_counts",
            "Bridge did not send source-count proof rows.",
        );
    }

    let mut seen_counts: HashMap<String, i64> = HashMap::new();
    let mut count_rows = Vec::with_capacity(payload.counts.len());
    let mut insert_rows = Vec::with_capacity(payload.counts.len());

    for row in &payload.counts {
        let entity_key = normalize_import_entity_key(&row.entity_key);
        if entity_key.is_empty() {
            push_import_preflight_blocker(
                &mut blockers,
                None,
                "empty_entity_key",
                "Bridge sent a source-count row without an entity key.",
            );
            continue;
        }
        if row.source_count < 0 {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "source_count cannot be negative for {entity_key}"
            )));
        }

        let label = row.label.trim();
        let label = if label.is_empty() {
            entity_key.clone()
        } else {
            label.to_string()
        };
        let suspicious_min = row
            .suspicious_min_count
            .or_else(|| default_suspicious_min_for_import_entity(&entity_key));
        let mut status = normalize_import_count_status(row.status.as_deref()).to_string();
        let mut message = row.message.as_ref().map(|value| value.trim().to_string());

        if row.required && status == "missing_mapping" {
            push_import_preflight_blocker(
                &mut blockers,
                Some(&entity_key),
                "missing_required_mapping",
                format!("{label} has no usable Counterpoint SQL mapping."),
            );
            status = "blocked".into();
        }
        if row.required
            && row.source_count == 0
            && counterpoint_preflight_zero_block_entities().contains(&entity_key.as_str())
        {
            let msg = format!("{label} returned zero source rows.");
            push_import_preflight_blocker(
                &mut blockers,
                Some(&entity_key),
                "zero_required_source_count",
                msg.clone(),
            );
            status = "blocked".into();
            message.get_or_insert(msg);
        }
        if let Some(min_count) = suspicious_min {
            if row.source_count < min_count {
                let msg = format!(
                    "{label} returned {} source rows, below the suspicious minimum of {min_count}.",
                    row.source_count
                );
                push_import_preflight_blocker(
                    &mut blockers,
                    Some(&entity_key),
                    "suspicious_low_source_count",
                    msg.clone(),
                );
                status = "blocked".into();
                message.get_or_insert(msg);
            }
        }
        if status == "blocked" {
            push_import_preflight_blocker(
                &mut blockers,
                Some(&entity_key),
                "bridge_reported_blocked_count",
                message
                    .clone()
                    .unwrap_or_else(|| format!("{label} source-count row is blocked.")),
            );
        }

        seen_counts.insert(entity_key.clone(), row.source_count);
        count_rows.push(CounterpointImportPreflightRow {
            entity_key: entity_key.clone(),
            label: label.clone(),
            source_count: row.source_count,
            source_sum: row.source_sum.map(|value| value.to_string()),
            source_checksum: row
                .source_checksum
                .as_ref()
                .map(|value| value.trim().to_ascii_lowercase()),
            required: row.required,
            suspicious_min_count: suspicious_min,
            status: status.clone(),
            message: message.clone(),
        });
        insert_rows.push((
            entity_key,
            label,
            row.source_count,
            row.source_sum,
            row.source_checksum
                .as_ref()
                .map(|value| value.trim().to_ascii_lowercase()),
            row.query_key.as_ref().map(|value| value.trim().to_string()),
            row.required,
            suspicious_min,
            status,
            message,
            row.metadata.clone(),
        ));
    }

    for required_entity in counterpoint_preflight_required_probe_entities() {
        if !seen_counts.contains_key(*required_entity) {
            push_import_preflight_blocker(
                &mut blockers,
                Some(required_entity),
                "missing_required_source_count_probe",
                format!("Bridge did not send source-count proof for {required_entity}."),
            );
        }
    }

    if seen_counts.get("tickets").copied().unwrap_or_default() > 0
        && seen_counts.get("ticket_lines").copied().unwrap_or_default() == 0
    {
        push_import_preflight_blocker(
            &mut blockers,
            Some("ticket_lines"),
            "missing_ticket_lines",
            "Tickets exist in Counterpoint but ticket line source count is zero.",
        );
    }
    if seen_counts.get("open_docs").copied().unwrap_or_default() > 0
        && seen_counts
            .get("open_doc_lines")
            .copied()
            .unwrap_or_default()
            == 0
    {
        push_import_preflight_blocker(
            &mut blockers,
            Some("open_doc_lines"),
            "missing_open_doc_lines",
            "Open docs exist in Counterpoint but open-doc line source count is zero.",
        );
    }

    let parsed_history_start =
        NaiveDate::parse_from_str(&history_start, "%Y-%m-%d").map_err(|_| {
            CounterpointSyncError::InvalidPayload(format!(
                "history_start must be YYYY-MM-DD; received {history_start}"
            ))
        })?;
    let preflight_passed = blockers.is_empty();
    let status = if preflight_passed {
        "preflight_passed"
    } else {
        "preflight_failed"
    };
    let blockers_json = serde_json::to_value(&blockers).unwrap_or_else(|_| serde_json::json!([]));
    let totals_json = serde_json::json!({
        "source_count_rows": count_rows.len(),
        "required_probe_rows": counterpoint_preflight_required_probe_entities().len(),
        "dry_run": payload.dry_run,
    });

    let mut tx = pool.begin().await?;
    let import_run_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO counterpoint_import_runs (
            run_kind, status, history_start, bridge_hostname, bridge_version,
            ros_base_url, source_fingerprint, preflight_passed,
            preflight_blockers, totals, metadata, completed_at
        )
        VALUES (
            'preflight', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
        )
        RETURNING id
        "#,
    )
    .bind(status)
    .bind(parsed_history_start)
    .bind(payload.bridge_hostname.as_deref().map(str::trim))
    .bind(payload.bridge_version.as_deref().map(str::trim))
    .bind(payload.ros_base_url.as_deref().map(str::trim))
    .bind(payload.source_fingerprint.as_deref().map(str::trim))
    .bind(preflight_passed)
    .bind(&blockers_json)
    .bind(&totals_json)
    .bind(&payload.metadata)
    .fetch_one(&mut *tx)
    .await?;

    for (
        entity_key,
        label,
        source_count,
        source_sum,
        source_checksum,
        query_key,
        required,
        suspicious_min,
        row_status,
        message,
        metadata,
    ) in insert_rows
    {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_import_source_counts (
                import_run_id, entity_key, label, source_count, source_sum,
                source_checksum, query_key, required, suspicious_min_count,
                status, message, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            "#,
        )
        .bind(import_run_id)
        .bind(entity_key)
        .bind(label)
        .bind(source_count)
        .bind(source_sum)
        .bind(source_checksum)
        .bind(query_key)
        .bind(required)
        .bind(suspicious_min)
        .bind(row_status)
        .bind(message)
        .bind(metadata)
        .execute(&mut *tx)
        .await?;
    }

    let preflight_json = serde_json::json!({
        "import_run_id": import_run_id,
        "preflight_passed": preflight_passed,
        "history_start": history_start,
        "blocker_count": blockers.len(),
        "source_count_rows": count_rows.len(),
        "updated_at": Utc::now(),
    });
    sqlx::query(
        r#"
        UPDATE store_settings
        SET counterpoint_config = COALESCE(counterpoint_config, '{}'::jsonb)
            || jsonb_build_object('import_first_preflight', $1::jsonb)
        WHERE id = 1
        "#,
    )
    .bind(preflight_json)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(CounterpointImportPreflightSummary {
        import_run_id,
        preflight_passed,
        history_start,
        bridge_hostname: payload.bridge_hostname,
        bridge_version: payload.bridge_version,
        ros_base_url: payload.ros_base_url,
        source_fingerprint: payload.source_fingerprint,
        blockers,
        counts: count_rows,
        ready_for_import: preflight_passed,
    })
}

async fn load_latest_counterpoint_import_preflight(
    pool: &PgPool,
) -> Result<Option<CounterpointImportRunSnapshot>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            id, run_kind, status, history_start, bridge_hostname, bridge_version,
            ros_base_url, source_fingerprint, preflight_passed, preflight_blockers,
            totals, started_at, completed_at, created_at, updated_at
        FROM counterpoint_import_runs
        WHERE run_kind = 'preflight'
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
}

async fn load_counterpoint_import_source_count_rows(
    pool: &PgPool,
    import_run_id: Uuid,
) -> Result<Vec<CounterpointImportPreflightRow>, sqlx::Error> {
    let rows: Vec<(
        String,
        String,
        i64,
        Option<Decimal>,
        Option<String>,
        bool,
        Option<i64>,
        String,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT entity_key, label, source_count, source_sum, source_checksum,
               required, suspicious_min_count, status, message
        FROM counterpoint_import_source_counts
        WHERE import_run_id = $1
        ORDER BY entity_key
        "#,
    )
    .bind(import_run_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                entity_key,
                label,
                source_count,
                source_sum,
                source_checksum,
                required,
                suspicious_min_count,
                status,
                message,
            )| CounterpointImportPreflightRow {
                entity_key,
                label,
                source_count,
                source_sum: source_sum.map(|value| value.to_string()),
                source_checksum,
                required,
                suspicious_min_count,
                status,
                message,
            },
        )
        .collect())
}

async fn load_counterpoint_import_run(
    pool: &PgPool,
    import_run_id: Uuid,
) -> Result<Option<CounterpointImportRunSnapshot>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            id, run_kind, status, history_start, bridge_hostname, bridge_version,
            ros_base_url, source_fingerprint, preflight_passed, preflight_blockers,
            totals, started_at, completed_at, created_at, updated_at
        FROM counterpoint_import_runs
        WHERE id = $1
        "#,
    )
    .bind(import_run_id)
    .fetch_optional(pool)
    .await
}

async fn load_latest_counterpoint_import_run(
    pool: &PgPool,
) -> Result<Option<CounterpointImportRunSnapshot>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            id, run_kind, status, history_start, bridge_hostname, bridge_version,
            ros_base_url, source_fingerprint, preflight_passed, preflight_blockers,
            totals, started_at, completed_at, created_at, updated_at
        FROM counterpoint_import_runs
        WHERE run_kind IN ('rehearsal', 'go_live')
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
}

fn normalized_import_run_kind(value: Option<&str>) -> Result<&'static str, CounterpointSyncError> {
    match value
        .unwrap_or("rehearsal")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "rehearsal" | "test" | "dev" => Ok("rehearsal"),
        "go_live" | "go-live" | "golive" | "production" => Ok("go_live"),
        other => Err(CounterpointSyncError::InvalidPayload(format!(
            "unsupported import run kind: {other}"
        ))),
    }
}

pub async fn start_counterpoint_import_run(
    pool: &PgPool,
    payload: CounterpointImportRunStartPayload,
) -> Result<CounterpointImportRunStartSummary, CounterpointSyncError> {
    let run_kind = normalized_import_run_kind(payload.run_kind.as_deref())?;
    let preflight = if let Some(preflight_id) = payload.preflight_import_run_id {
        load_counterpoint_import_run(pool, preflight_id).await?
    } else {
        load_latest_counterpoint_import_preflight(pool).await?
    }
    .ok_or_else(|| {
        CounterpointSyncError::InvalidPayload(
            "run Bridge source-count preflight before starting Counterpoint import".into(),
        )
    })?;

    if preflight.run_kind != "preflight"
        || preflight.status != "preflight_passed"
        || !preflight.preflight_passed
    {
        return Err(CounterpointSyncError::InvalidPayload(
            "latest Counterpoint source-count preflight has blockers; import cannot start".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let import_run_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO counterpoint_import_runs (
            run_kind, status, history_start, bridge_hostname, bridge_version,
            ros_base_url, source_fingerprint, preflight_passed,
            preflight_blockers, totals, metadata
        )
        VALUES (
            $1, 'running', $2,
            COALESCE($3, $4),
            COALESCE($5, $6),
            COALESCE($7, $8),
            COALESCE($9, $10),
            TRUE, $11, '{}'::jsonb,
            jsonb_build_object('preflight_import_run_id', $12::uuid)
        )
        RETURNING id
        "#,
    )
    .bind(run_kind)
    .bind(preflight.history_start)
    .bind(payload.bridge_hostname.as_deref().map(str::trim))
    .bind(preflight.bridge_hostname.as_deref())
    .bind(payload.bridge_version.as_deref().map(str::trim))
    .bind(preflight.bridge_version.as_deref())
    .bind(payload.ros_base_url.as_deref().map(str::trim))
    .bind(preflight.ros_base_url.as_deref())
    .bind(payload.source_fingerprint.as_deref().map(str::trim))
    .bind(preflight.source_fingerprint.as_deref())
    .bind(&preflight.preflight_blockers)
    .bind(preflight.id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO counterpoint_import_source_counts (
            import_run_id, entity_key, label, source_count, source_sum,
            source_checksum, query_key, required, suspicious_min_count,
            status, message, metadata, observed_at
        )
        SELECT
            $1, entity_key, label, source_count, source_sum,
            source_checksum, query_key, required, suspicious_min_count,
            status, message, metadata, observed_at
        FROM counterpoint_import_source_counts
        WHERE import_run_id = $2
        "#,
    )
    .bind(import_run_id)
    .bind(preflight.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE store_settings
        SET counterpoint_config = COALESCE(counterpoint_config, '{}'::jsonb)
            || jsonb_build_object('import_first_active_run_id', $1::text)
        WHERE id = 1
        "#,
    )
    .bind(import_run_id.to_string())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(CounterpointImportRunStartSummary {
        import_run_id,
        preflight_import_run_id: preflight.id,
        run_kind: run_kind.into(),
        status: "running".into(),
        history_start: preflight.history_start.to_string(),
        ready_for_import: true,
    })
}

pub async fn complete_counterpoint_import_run(
    pool: &PgPool,
    payload: CounterpointImportRunCompletePayload,
) -> Result<CounterpointImportRunSnapshot, CounterpointSyncError> {
    let status = if payload.failed {
        "failed"
    } else {
        "completed"
    };
    let mut totals = payload.totals.unwrap_or_else(|| serde_json::json!({}));
    if let Some(error) = payload
        .error_message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        totals["error_message"] = JsonValue::String(error.to_string());
    }

    let mut tx = pool.begin().await?;
    let run: CounterpointImportRunSnapshot = sqlx::query_as(
        r#"
        UPDATE counterpoint_import_runs
        SET status = $2,
            completed_at = NOW(),
            updated_at = NOW(),
            totals = COALESCE(totals, '{}'::jsonb) || $3::jsonb
        WHERE id = $1
          AND run_kind IN ('rehearsal', 'go_live')
        RETURNING
            id, run_kind, status, history_start, bridge_hostname, bridge_version,
            ros_base_url, source_fingerprint, preflight_passed, preflight_blockers,
            totals, started_at, completed_at, created_at, updated_at
        "#,
    )
    .bind(payload.import_run_id)
    .bind(status)
    .bind(&totals)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        CounterpointSyncError::InvalidPayload("Counterpoint import run not found".into())
    })?;

    sqlx::query(
        r#"
        UPDATE store_settings
        SET counterpoint_config = COALESCE(counterpoint_config, '{}'::jsonb)
            - 'import_first_active_run_id'
        WHERE id = 1
          AND counterpoint_config->>'import_first_active_run_id' = $1
        "#,
    )
    .bind(payload.import_run_id.to_string())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(run)
}

pub async fn require_counterpoint_import_run_for_batch(
    pool: &PgPool,
    requested_import_run_id: Option<Uuid>,
) -> Result<Uuid, CounterpointSyncError> {
    if let Some(import_run_id) = requested_import_run_id {
        let run = load_counterpoint_import_run(pool, import_run_id)
            .await?
            .ok_or_else(|| {
                CounterpointSyncError::InvalidPayload(
                    "Counterpoint import run not found for batch".into(),
                )
            })?;
        if run.status == "running" && matches!(run.run_kind.as_str(), "rehearsal" | "go_live") {
            return Ok(import_run_id);
        }
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "Counterpoint import run {} is {}, expected running",
            run.id, run.status
        )));
    }

    let active_run_id: Option<String> = sqlx::query_scalar(
        "SELECT counterpoint_config->>'import_first_active_run_id' FROM store_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?
    .flatten();
    let Some(active_run_id) = active_run_id else {
        return Err(CounterpointSyncError::InvalidPayload(
            "Counterpoint import run has not been started; run source-count preflight first".into(),
        ));
    };
    let import_run_id = Uuid::parse_str(active_run_id.trim()).map_err(|_| {
        CounterpointSyncError::InvalidPayload(
            "Counterpoint active import run id is invalid; restart the Bridge preflight".into(),
        )
    })?;
    let run = load_counterpoint_import_run(pool, import_run_id)
        .await?
        .ok_or_else(|| {
            CounterpointSyncError::InvalidPayload(
                "Counterpoint active import run was not found; restart the Bridge preflight".into(),
            )
        })?;
    if run.status == "running" && matches!(run.run_kind.as_str(), "rehearsal" | "go_live") {
        Ok(import_run_id)
    } else {
        Err(CounterpointSyncError::InvalidPayload(format!(
            "Counterpoint active import run {} is {}, expected running",
            run.id, run.status
        )))
    }
}

#[derive(Debug, Clone)]
struct CounterpointRawProofRow {
    source_key: String,
    source_row_hash: String,
    payload: JsonValue,
}

fn counterpoint_payload_rows_for_proof(payload: &JsonValue) -> Vec<JsonValue> {
    if let Some(rows) = payload.get("rows").and_then(|value| value.as_array()) {
        return rows.clone();
    }
    if let Some(codes) = payload.get("codes").and_then(|value| value.as_array()) {
        return codes
            .iter()
            .map(|code| serde_json::json!({ "code": code }))
            .collect();
    }
    Vec::new()
}

fn counterpoint_source_row_hash(row: &JsonValue) -> String {
    let bytes = serde_json::to_vec(row).unwrap_or_else(|_| row.to_string().into_bytes());
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn value_text(row: &JsonValue, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|value| match value {
            JsonValue::String(s) => Some(s.trim().to_string()),
            JsonValue::Number(n) => Some(n.to_string()),
            JsonValue::Bool(b) => Some(b.to_string()),
            _ => None,
        })
        .filter(|value| !value.trim().is_empty())
}

fn counterpoint_source_key_for_payload_row(
    entity_key: &str,
    row: &JsonValue,
    idx: usize,
) -> String {
    let key = match entity_key {
        "customers" => value_text(row, "cust_no"),
        "inventory" => value_text(row, "counterpoint_item_key").or_else(|| value_text(row, "sku")),
        "category_masters" => value_text(row, "cp_category"),
        "catalog" => value_text(row, "item_no"),
        "gift_cards" => value_text(row, "cert_no"),
        "tickets" => value_text(row, "ticket_ref"),
        "vendors" => value_text(row, "vend_no"),
        "vendor_items" => match (value_text(row, "vend_no"), value_text(row, "item_no")) {
            (Some(vend), Some(item)) => Some(format!(
                "{}|{}|{}",
                vend,
                item,
                value_text(row, "vend_item_no").unwrap_or_default()
            )),
            _ => None,
        },
        "customer_notes" => match (value_text(row, "cust_no"), value_text(row, "note_id")) {
            (Some(cust), Some(note)) => Some(format!("{cust}|{note}")),
            _ => None,
        },
        "loyalty_hist" => match (value_text(row, "cust_no"), value_text(row, "bus_dat")) {
            (Some(cust), Some(bus_dat)) => Some(format!(
                "{}|{}|{}",
                cust,
                bus_dat,
                value_text(row, "ref_no").unwrap_or_default()
            )),
            _ => None,
        },
        "staff" => match (value_text(row, "source"), value_text(row, "code")) {
            (Some(source), Some(code)) => Some(format!("{source}|{code}")),
            (None, Some(code)) => Some(format!("user|{code}")),
            _ => None,
        },
        "sales_rep_stubs" => value_text(row, "code"),
        "store_credit_opening" => value_text(row, "cust_no"),
        "open_docs" => value_text(row, "doc_ref"),
        "receiving_history" => match (
            value_text(row, "recv_no"),
            value_text(row, "po_no"),
            value_text(row, "vend_no"),
            value_text(row, "item_no"),
            value_text(row, "recv_dat"),
        ) {
            (recv_no, po_no, Some(vend), Some(item), Some(recv_dat)) => Some(format!(
                "{}|{}|{}|{}|{}",
                recv_no.unwrap_or_default(),
                po_no.unwrap_or_default(),
                vend,
                item,
                recv_dat
            )),
            _ => None,
        },
        _ => None,
    };
    key.unwrap_or_else(|| format!("{entity_key}:row:{}", idx + 1))
}

fn counterpoint_raw_proof_rows(
    entity_key: &str,
    payload: &JsonValue,
) -> Vec<CounterpointRawProofRow> {
    counterpoint_payload_rows_for_proof(payload)
        .into_iter()
        .enumerate()
        .map(|(idx, row)| CounterpointRawProofRow {
            source_key: counterpoint_source_key_for_payload_row(entity_key, &row, idx),
            source_row_hash: counterpoint_source_row_hash(&row),
            payload: row,
        })
        .collect()
}

async fn counterpoint_landed_targets_by_source_key(
    pool: &PgPool,
    entity_key: &str,
    source_keys: &[String],
) -> Result<HashMap<String, Vec<(String, Uuid)>>, sqlx::Error> {
    if source_keys.is_empty() {
        return Ok(HashMap::new());
    }
    let mut out: HashMap<String, Vec<(String, Uuid)>> = HashMap::new();
    match entity_key {
        "customers" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                "SELECT customer_code, 'customers'::text, id FROM customers WHERE customer_code = ANY($1)",
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "inventory" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                SELECT DISTINCT k.source_key, 'product_variants'::text, pv.id
                FROM unnest($1::text[]) AS k(source_key)
                JOIN product_variants pv
                  ON pv.counterpoint_item_key = k.source_key
                  OR lower(trim(pv.sku)) = lower(trim(k.source_key))
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "category_masters" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                SELECT cp_category, 'categories'::text, ros_category_id
                FROM counterpoint_category_map
                WHERE cp_category = ANY($1)
                  AND ros_category_id IS NOT NULL
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "catalog" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                WITH matched AS (
                    SELECT DISTINCT k.source_key, pv.id AS variant_id, pv.product_id
                    FROM unnest($1::text[]) AS k(source_key)
                    JOIN product_variants pv
                      ON pv.counterpoint_item_key = k.source_key
                      OR split_part(COALESCE(pv.counterpoint_item_key, ''), '|', 1) = k.source_key
                      OR lower(trim(pv.sku)) = lower(trim(k.source_key))
                )
                SELECT source_key, 'products'::text, product_id FROM matched
                UNION
                SELECT source_key, 'product_variants'::text, variant_id FROM matched
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "gift_cards" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                "SELECT code, 'gift_cards'::text, id FROM gift_cards WHERE code = ANY($1)",
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "tickets" | "open_docs" => {
            let ref_col = if entity_key == "tickets" {
                "counterpoint_ticket_ref"
            } else {
                "counterpoint_doc_ref"
            };
            let sql = format!(
                r#"
                WITH matched_tx AS (
                    SELECT k.source_key, t.id
                    FROM unnest($1::text[]) AS k(source_key)
                    JOIN transactions t ON t.{ref_col} = k.source_key
                )
                SELECT source_key, 'transactions'::text, id FROM matched_tx
                UNION
                SELECT m.source_key, 'transaction_lines'::text, tl.id
                FROM matched_tx m
                JOIN transaction_lines tl ON tl.transaction_id = m.id
                UNION
                SELECT m.source_key, 'payment_allocations'::text, pa.id
                FROM matched_tx m
                JOIN payment_allocations pa ON pa.target_transaction_id = m.id
                "#
            );
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(&sql)
                .bind(source_keys)
                .fetch_all(pool)
                .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "vendors" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                "SELECT vendor_code, 'vendors'::text, id FROM vendors WHERE vendor_code = ANY($1)",
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "vendor_items" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                SELECT
                    concat(v.vendor_code, '|', vsi.cp_item_no, '|', vsi.vendor_item_no),
                    'vendor_supplier_item'::text,
                    vsi.id
                FROM vendor_supplier_item vsi
                JOIN vendors v ON v.id = vsi.vendor_id
                WHERE concat(v.vendor_code, '|', vsi.cp_item_no, '|', vsi.vendor_item_no) = ANY($1)
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "customer_notes" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                SELECT concat(c.customer_code, '|', substring(n.body from '^\[CP:([^\]]+)\]')),
                       'customer_timeline_notes'::text,
                       n.id
                FROM customer_timeline_notes n
                JOIN customers c ON c.id = n.customer_id
                WHERE n.body LIKE '[CP:%'
                  AND concat(c.customer_code, '|', substring(n.body from '^\[CP:([^\]]+)\]')) = ANY($1)
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "loyalty_hist" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                SELECT metadata->>'cp_ref', 'loyalty_point_ledger'::text, id
                FROM loyalty_point_ledger
                WHERE reason = 'cp_loy_pts_hist'
                  AND metadata->>'cp_ref' = ANY($1)
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "staff" | "sales_rep_stubs" => {
            let rows: Vec<(String, String, Uuid)> = if entity_key == "staff" {
                sqlx::query_as(
                    r#"
                    SELECT concat(cp_source, '|', cp_code), 'staff'::text, ros_staff_id
                    FROM counterpoint_staff_map
                    WHERE concat(cp_source, '|', cp_code) = ANY($1)
                    "#,
                )
                .bind(source_keys)
                .fetch_all(pool)
                .await?
            } else {
                sqlx::query_as(
                    r#"
                    SELECT cp_code, 'staff'::text, ros_staff_id
                    FROM counterpoint_staff_map
                    WHERE cp_code = ANY($1)
                    "#,
                )
                .bind(source_keys)
                .fetch_all(pool)
                .await?
            };
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "store_credit_opening" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                SELECT c.customer_code, 'customers'::text, c.id
                FROM customers c
                WHERE c.customer_code = ANY($1)
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        "receiving_history" => {
            let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
                r#"
                SELECT concat(COALESCE(recv_no, ''), '|', COALESCE(po_no, ''), '|', vend_no, '|', item_no, '|', recv_dat::text),
                       'counterpoint_receiving_history'::text,
                       id
                FROM counterpoint_receiving_history
                WHERE concat(COALESCE(recv_no, ''), '|', COALESCE(po_no, ''), '|', vend_no, '|', item_no, '|', recv_dat::text) = ANY($1)
                "#,
            )
            .bind(source_keys)
            .fetch_all(pool)
            .await?;
            for (key, table, id) in rows {
                out.entry(key).or_default().push((table, id));
            }
        }
        _ => {}
    }
    Ok(out)
}

pub async fn record_counterpoint_import_batch_success(
    pool: &PgPool,
    import_run_id: Uuid,
    entity_key: &str,
    payload: &JsonValue,
    summary: &JsonValue,
) -> Result<CounterpointImportBatchProofSummary, CounterpointSyncError> {
    let entity_key = normalize_import_entity_key(entity_key);
    let proof_rows = counterpoint_raw_proof_rows(&entity_key, payload);
    let source_keys: Vec<String> = proof_rows
        .iter()
        .map(|row| row.source_key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let targets =
        counterpoint_landed_targets_by_source_key(pool, &entity_key, &source_keys).await?;

    let mut raw_records = 0_i64;
    let mut landed_records = 0_i64;
    let mut provenance_records = 0_i64;
    let exception_records = 0_i64;
    let mut tx = pool.begin().await?;

    for row in &proof_rows {
        let landed_targets = targets.get(&row.source_key).cloned().unwrap_or_default();
        let primary = landed_targets.first().cloned();
        sqlx::query(
            r#"
            INSERT INTO counterpoint_import_raw_records (
                import_run_id, entity_key, source_key, source_row_hash, payload,
                landed, landed_table, landed_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (import_run_id, entity_key, source_key, source_row_hash)
            DO UPDATE SET
                payload = EXCLUDED.payload,
                landed = EXCLUDED.landed,
                landed_table = EXCLUDED.landed_table,
                landed_id = EXCLUDED.landed_id
            "#,
        )
        .bind(import_run_id)
        .bind(&entity_key)
        .bind(&row.source_key)
        .bind(&row.source_row_hash)
        .bind(&row.payload)
        .bind(primary.is_some())
        .bind(primary.as_ref().map(|(table, _)| table.as_str()))
        .bind(primary.as_ref().map(|(_, id)| *id))
        .execute(&mut *tx)
        .await?;
        raw_records += 1;
        if primary.is_some() {
            landed_records += 1;
        }

        for (ros_table, ros_id) in landed_targets {
            sqlx::query(
                r#"
                INSERT INTO counterpoint_import_provenance (
                    import_run_id, entity_key, source_key, source_row_hash,
                    ros_table, ros_id, extracted_at, metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6, NOW(), '{}'::jsonb)
                ON CONFLICT (entity_key, source_key, ros_table, ros_id)
                DO UPDATE SET
                    import_run_id = EXCLUDED.import_run_id,
                    source_row_hash = EXCLUDED.source_row_hash,
                    imported_at = NOW()
                "#,
            )
            .bind(import_run_id)
            .bind(&entity_key)
            .bind(&row.source_key)
            .bind(&row.source_row_hash)
            .bind(&ros_table)
            .bind(ros_id)
            .execute(&mut *tx)
            .await?;
            provenance_records += 1;
        }
    }

    sqlx::query(
        r#"
        UPDATE counterpoint_import_runs
        SET totals = COALESCE(totals, '{}'::jsonb)
            || jsonb_build_object(
                $2,
                jsonb_build_object(
                    'raw_records', $3::bigint,
                    'landed_records', $4::bigint,
                    'provenance_records', $5::bigint,
                    'summary', $6::jsonb,
                    'updated_at', NOW()
                )
            ),
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(import_run_id)
    .bind(&entity_key)
    .bind(raw_records)
    .bind(landed_records)
    .bind(provenance_records)
    .bind(summary)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(CounterpointImportBatchProofSummary {
        import_run_id,
        entity_key,
        raw_records,
        landed_records,
        provenance_records,
        exception_records,
    })
}

pub async fn record_counterpoint_import_batch_failure(
    pool: &PgPool,
    import_run_id: Option<Uuid>,
    entity_key: &str,
    payload: &JsonValue,
    message: &str,
) -> Result<(), sqlx::Error> {
    let entity_key = normalize_import_entity_key(entity_key);
    let source_payload = serde_json::json!({
        "batch_row_count": counterpoint_payload_rows_for_proof(payload).len(),
        "payload_excerpt": payload,
    });
    sqlx::query(
        r#"
        INSERT INTO counterpoint_import_exceptions (
            import_run_id, entity_key, severity, reason_code, message,
            suggested_fix, fallback_landed, source_payload
        )
        VALUES ($1, $2, 'blocked', 'import_batch_failed', $3, $4, FALSE, $5)
        "#,
    )
    .bind(import_run_id)
    .bind(entity_key)
    .bind(message)
    .bind("Fix the source row or mapping, then rerun the Counterpoint import batch.")
    .bind(source_payload)
    .execute(pool)
    .await?;
    Ok(())
}

fn import_provenance_target_for_source_count(
    entity_key: &str,
) -> Option<(&'static str, Option<&'static str>)> {
    let key = entity_key.trim().to_ascii_lowercase();
    match key.as_str() {
        "customers" => Some(("customers", Some("customers"))),
        "vendors" | "vendor_masters" | "counterpoint_vendor_masters" | "counterpoint_vendors" => {
            Some(("vendors", Some("vendors")))
        }
        "category_masters" | "counterpoint_category_masters" | "counterpoint_categories" => {
            Some(("category_masters", Some("categories")))
        }
        "catalog_products"
        | "catalog_items_with_resolved_categories"
        | "catalog_items_with_resolved_vendors"
        | "catalog_category_vendor_fields" => Some(("catalog", Some("products"))),
        "catalog_variants"
        | "catalog_variant_skus"
        | "catalog_variant_barcodes"
        | "catalog_price_cost_fields"
        | "catalog_variant_labels" => Some(("catalog", Some("product_variants"))),
        "inventory_quantity_rows"
        | "inventory_quantity_rows_matched"
        | "inventory_quantity_cost_fields" => Some(("inventory", Some("product_variants"))),
        "gift_cards" | "gift_card_current_balances" => Some(("gift_cards", Some("gift_cards"))),
        "tickets" | "closed_ticket_history" => Some(("tickets", Some("transactions"))),
        "ticket_lines" | "closed_ticket_lines" => Some(("tickets", Some("transaction_lines"))),
        "ticket_payments" | "closed_ticket_payments" => {
            Some(("tickets", Some("payment_allocations")))
        }
        "open_docs" | "open_docs_unfulfilled_obligations" => {
            Some(("open_docs", Some("transactions")))
        }
        "open_doc_lines" => Some(("open_docs", Some("transaction_lines"))),
        "open_doc_payments" | "open_doc_deposits_payments" => {
            Some(("open_docs", Some("payment_allocations")))
        }
        "receiving_history" => Some(("receiving_history", Some("counterpoint_receiving_history"))),
        "loyalty_points" | "loyalty_history" => Some(("customers", Some("customers"))),
        "store_credit_opening" => Some(("store_credit_opening", Some("customers"))),
        _ => None,
    }
}

async fn import_run_landed_count_for_source_count(
    pool: &PgPool,
    import_run_id: Uuid,
    entity_key: &str,
) -> Result<i64, sqlx::Error> {
    let Some((provenance_entity, ros_table)) =
        import_provenance_target_for_source_count(entity_key)
    else {
        return Ok(0);
    };

    match ros_table {
        Some(table) => {
            sqlx::query_scalar(
                r#"
                SELECT COUNT(DISTINCT ros_id)::bigint
                FROM counterpoint_import_provenance
                WHERE import_run_id = $1
                  AND entity_key = $2
                  AND ros_table = $3
                "#,
            )
            .bind(import_run_id)
            .bind(provenance_entity)
            .bind(table)
            .fetch_one(pool)
            .await
        }
        None => {
            sqlx::query_scalar(
                r#"
                SELECT COUNT(DISTINCT source_key)::bigint
                FROM counterpoint_import_raw_records
                WHERE import_run_id = $1
                  AND entity_key = $2
                  AND landed
                "#,
            )
            .bind(import_run_id)
            .bind(provenance_entity)
            .fetch_one(pool)
            .await
        }
    }
}

async fn build_counterpoint_import_run_reconciliation(
    pool: &PgPool,
    import_run_id: Uuid,
    source_counts: &[CounterpointImportPreflightRow],
) -> Result<Vec<CounterpointSnapshotReconciliationRow>, CounterpointSyncError> {
    let mut rows = Vec::with_capacity(source_counts.len());
    for source in source_counts {
        let landed_count =
            import_run_landed_count_for_source_count(pool, import_run_id, &source.entity_key)
                .await?;
        let count_difference = landed_count - source.source_count;
        let passed = count_difference == 0;
        rows.push(CounterpointSnapshotReconciliationRow {
            key: source.entity_key.clone(),
            label: source.label.clone(),
            status: if passed { "pass" } else { "fail" }.into(),
            passed,
            source_count: Some(source.source_count),
            landed_count,
            count_difference: Some(count_difference),
            source_sum: source.source_sum.clone(),
            landed_sum: Decimal::ZERO.to_string(),
            sum_difference: Some(Decimal::ZERO.to_string()),
            source_checksum: source.source_checksum.clone(),
            landed_checksum: None,
            checksum_matched: None,
            note: if passed {
                "Current import run provenance matches the Bridge source count.".into()
            } else {
                "Current import run provenance does not yet match the Bridge source count.".into()
            },
            source_updated_at: None,
        });
    }
    Ok(rows)
}

pub async fn build_counterpoint_import_command_center(
    pool: &PgPool,
    token_configured: bool,
) -> Result<CounterpointImportCommandCenterSummary, CounterpointSyncError> {
    let latest_preflight = load_latest_counterpoint_import_preflight(pool).await?;
    let latest_import_run = load_latest_counterpoint_import_run(pool).await?;
    let source_count_run_id = latest_import_run
        .as_ref()
        .map(|run| run.id)
        .or_else(|| latest_preflight.as_ref().map(|run| run.id));
    let source_counts = match source_count_run_id {
        Some(import_run_id) => {
            load_counterpoint_import_source_count_rows(pool, import_run_id).await?
        }
        None => Vec::new(),
    };
    let snapshot_reconciliation = if let Some(run) = latest_import_run.as_ref() {
        build_counterpoint_import_run_reconciliation(pool, run.id, &source_counts).await?
    } else {
        Vec::new()
    };
    let (proof_scope, proof_scope_note) = if latest_import_run.is_some() {
        (
            "current_import_run".to_string(),
            "Counts are scoped to raw/provenance rows written by the latest Counterpoint import run.".to_string(),
        )
    } else if latest_preflight.is_some() {
        (
            "preflight_only".to_string(),
            "Source counts are available, but no import run has started; landed proof remains empty by design.".to_string(),
        )
    } else {
        (
            "no_preflight".to_string(),
            "No Bridge source-count preflight has been received for the import-first workflow."
                .to_string(),
        )
    };
    let open_exception_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM counterpoint_import_exceptions WHERE status = 'open'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    let fallback_landed_exception_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM counterpoint_import_exceptions
        WHERE status = 'open' AND fallback_landed
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    let staging_open_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM counterpoint_staging_batch WHERE status IN ('pending', 'applying')",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    let latest_preflight_passed = latest_preflight
        .as_ref()
        .map(|run| run.preflight_passed && run.status == "preflight_passed")
        .unwrap_or(false);
    let ready_for_import = token_configured && latest_preflight_passed;
    let latest_import_completed = latest_import_run
        .as_ref()
        .map(|run| run.status == "completed")
        .unwrap_or(false);
    let import_proof_passed = latest_import_completed
        && !snapshot_reconciliation.is_empty()
        && snapshot_reconciliation.iter().all(|row| row.passed);
    let ready_for_go_live_review =
        ready_for_import && import_proof_passed && open_exception_count == 0;
    let recommendation = if !token_configured {
        "NO-GO: Counterpoint sync token is not configured.".to_string()
    } else if latest_preflight.is_none() {
        "NO-GO: run Bridge source-count preflight first.".to_string()
    } else if !latest_preflight_passed {
        "NO-GO: source-count preflight has blockers.".to_string()
    } else if latest_import_run.is_none() {
        "READY TO IMPORT: source counts are proved. Run Full Import next.".to_string()
    } else if !latest_import_completed {
        "IMPORT RUNNING: wait for the current import to finish, then refresh proof.".to_string()
    } else if !import_proof_passed {
        "NO-GO: import proof does not match Counterpoint source counts yet.".to_string()
    } else if open_exception_count > 0 {
        format!("CAUTION: {open_exception_count} open import exception(s) need review.")
    } else {
        "GO FOR REHEARSAL USE: import proof matches and no open import exceptions are recorded."
            .to_string()
    };

    Ok(CounterpointImportCommandCenterSummary {
        generated_at: Utc::now(),
        mode: "import_first".into(),
        required_history_start: COUNTERPOINT_IMPORT_HISTORY_START.into(),
        token_configured,
        preflight_received: latest_preflight.is_some(),
        import_run_received: latest_import_run.is_some(),
        proof_scope,
        proof_scope_note,
        latest_preflight,
        latest_import_run,
        source_counts,
        landing_rows: Vec::new(),
        snapshot_reconciliation,
        open_exception_count,
        fallback_landed_exception_count,
        staging_open_count,
        ready_for_import,
        ready_for_go_live_review,
        recommendation,
    })
}

pub async fn list_counterpoint_import_exceptions(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<CounterpointImportExceptionRow>, sqlx::Error> {
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    sqlx::query_as(
        r#"
        SELECT
            id, entity_key, source_key, severity, reason_code, message,
            suggested_fix, fallback_landed, ros_table, ros_id, source_payload,
            status, created_at, updated_at
        FROM counterpoint_import_exceptions
        ORDER BY
            CASE severity WHEN 'blocked' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
            created_at DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn resolve_counterpoint_import_exception(
    pool: &PgPool,
    exception_id: Uuid,
    staff_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE counterpoint_import_exceptions
        SET status = 'resolved',
            resolved_by_staff_id = $2,
            resolved_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND status = 'open'
        "#,
    )
    .bind(exception_id)
    .bind(staff_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

async fn record_counterpoint_import_exception(
    pool: &PgPool,
    entity_key: &str,
    source_key: Option<&str>,
    severity: &str,
    reason_code: &str,
    message: &str,
    suggested_fix: Option<&str>,
    fallback_landed: bool,
    ros_table: Option<&str>,
    ros_id: Option<Uuid>,
    source_payload: JsonValue,
) {
    let result = sqlx::query(
        r#"
        INSERT INTO counterpoint_import_exceptions (
            import_run_id, entity_key, source_key, severity, reason_code,
            message, suggested_fix, fallback_landed, ros_table, ros_id, source_payload
        )
        SELECT (
            SELECT id
            FROM (
                SELECT id, 0 AS priority, created_at
                FROM counterpoint_import_runs
                WHERE run_kind IN ('rehearsal', 'go_live')
                  AND status = 'running'
                UNION ALL
                SELECT id, 1 AS priority, created_at
                FROM counterpoint_import_runs
                WHERE run_kind IN ('rehearsal', 'go_live')
                  AND status IN ('completed', 'failed')
                UNION ALL
                SELECT id, 2 AS priority, created_at
                FROM counterpoint_import_runs
                WHERE preflight_passed
            ) candidate_runs
            ORDER BY priority, created_at DESC
            LIMIT 1
        ), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        WHERE NOT EXISTS (
            SELECT 1
            FROM counterpoint_import_exceptions
            WHERE entity_key = $1
              AND source_key IS NOT DISTINCT FROM $2
              AND reason_code = $4
              AND status = 'open'
        )
        "#,
    )
    .bind(entity_key)
    .bind(source_key)
    .bind(severity)
    .bind(reason_code)
    .bind(message)
    .bind(suggested_fix)
    .bind(fallback_landed)
    .bind(ros_table)
    .bind(ros_id)
    .bind(source_payload)
    .execute(pool)
    .await;

    if let Err(error) = result {
        tracing::warn!(
            entity = entity_key,
            source_key = source_key,
            reason_code,
            error = %error,
            "failed to record Counterpoint import exception"
        );
    }
}

#[derive(Debug, serde::Serialize)]
pub struct CounterpointHealth {
    pub configured: bool,
    pub reachable: bool,
    pub latency_ms: u64,
    pub message: String,
}

pub async fn health_check(pool: &PgPool) -> CounterpointHealth {
    let start = std::time::Instant::now();
    let saved_token_configured = integration_credentials::load_integration_credentials(
        pool,
        "counterpoint",
        &["sync_token"],
    )
    .await
    .ok()
    .and_then(|values| {
        values
            .get("sync_token")
            .map(|value| !value.trim().is_empty())
    })
    .unwrap_or(false);
    let token_configured = saved_token_configured
        || std::env::var("COUNTERPOINT_SYNC_TOKEN")
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
    if !token_configured {
        return CounterpointHealth {
            configured: false,
            reachable: false,
            latency_ms: 0,
            message: "Counterpoint not configured (no saved sync token or COUNTERPOINT_SYNC_TOKEN)"
                .to_string(),
        };
    }
    let hb = sqlx::query_as::<_, (DateTime<Utc>, String, Option<String>, Option<String>, Option<String>)>(
        "SELECT last_seen_at, bridge_phase, current_entity, bridge_version, bridge_hostname FROM counterpoint_bridge_heartbeat WHERE id = 1",
    )
    .fetch_optional(pool)
    .await;
    match hb {
        Ok(Some((seen, phase, entity, version, hostname))) => {
            let age = Utc::now().signed_duration_since(seen).num_seconds();
            if age > HEARTBEAT_TTL_SECONDS {
                CounterpointHealth {
                    configured: true,
                    reachable: false,
                    latency_ms: start.elapsed().as_millis() as u64,
                    message: format!(
                        "Counterpoint bridge offline: last activity {age}s ago (TTL {HEARTBEAT_TTL_SECONDS}s) — phase={phase} entity={entity:?} version={version:?} host={hostname:?}"
                    ),
                }
            } else {
                CounterpointHealth {
                    configured: true,
                    reachable: true,
                    latency_ms: start.elapsed().as_millis() as u64,
                    message: format!(
                        "Counterpoint bridge online — phase={phase} entity={entity:?} version={version:?} host={hostname:?}"
                    ),
                }
            }
        }
        Ok(None) => CounterpointHealth {
            configured: true,
            reachable: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: "Counterpoint bridge has never sent a heartbeat".to_string(),
        },
        Err(e) => CounterpointHealth {
            configured: true,
            reachable: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: format!("Counterpoint heartbeat query failed: {e}"),
        },
    }
}

async fn counterpoint_landing_count(pool: &PgPool, query: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(query).fetch_one(pool).await
}

fn landing_row(
    key: &str,
    label: &str,
    count: i64,
    confidence: &str,
    note: &str,
) -> CounterpointLandingVerificationRow {
    CounterpointLandingVerificationRow {
        key: key.into(),
        label: label.into(),
        count,
        confidence: confidence.into(),
        note: note.into(),
    }
}

fn supported_snapshot_key(snapshot: &str) -> Option<&'static str> {
    match snapshot.trim() {
        "customers" => Some("customers"),
        "catalog_products" => Some("catalog_products"),
        "catalog_variants" => Some("catalog_variants"),
        "catalog_variant_skus" => Some("catalog_variant_skus"),
        "catalog_variant_barcodes" => Some("catalog_variant_barcodes"),
        "counterpoint_vendors" => Some("counterpoint_vendors"),
        "counterpoint_categories" => Some("counterpoint_categories"),
        "catalog_items_with_vendor" => Some("catalog_items_with_vendor"),
        "catalog_items_with_category" => Some("catalog_items_with_category"),
        "catalog_price_cost_fields" => Some("catalog_price_cost_fields"),
        "catalog_category_vendor_fields" => Some("catalog_category_vendor_fields"),
        "catalog_variant_label_fields" => Some("catalog_variant_label_fields"),
        "inventory_quantity_cost_fields" => Some("inventory_quantity_cost_fields"),
        "inventory_quantity_rows" => Some("inventory_quantity_rows"),
        "tickets" => Some("tickets"),
        "ticket_lines" => Some("ticket_lines"),
        "ticket_payments" => Some("ticket_payments"),
        "open_docs" => Some("open_docs"),
        "open_doc_lines" => Some("open_doc_lines"),
        "open_doc_payments" => Some("open_doc_payments"),
        "receiving_history" => Some("receiving_history"),
        "gift_cards" => Some("gift_cards"),
        "loyalty_points" => Some("loyalty_points"),
        "store_credit_opening" => Some("store_credit_opening"),
        _ => None,
    }
}

pub async fn record_counterpoint_snapshot_source_metrics(
    pool: &PgPool,
    payload: CounterpointSnapshotSourceMetricsPayload,
) -> Result<(), CounterpointSyncError> {
    let Some(snapshot) = supported_snapshot_key(&payload.snapshot) else {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "unsupported snapshot reconciliation key: {}",
            payload.snapshot
        )));
    };
    if payload.source_count < 0 {
        return Err(CounterpointSyncError::InvalidPayload(
            "source_count cannot be negative".into(),
        ));
    }
    let source_checksum = payload.source_checksum.as_ref().map(|checksum| {
        checksum
            .trim()
            .to_ascii_lowercase()
            .chars()
            .take(128)
            .collect::<String>()
    });

    let body = serde_json::json!({
        "source_count": payload.source_count,
        "source_sum": payload.source_sum.to_string(),
        "source_checksum": source_checksum,
        "updated_at": Utc::now(),
    });

    sqlx::query(
        r#"
        UPDATE store_settings
        SET counterpoint_config = COALESCE(counterpoint_config, '{}'::jsonb)
            || jsonb_build_object(
                'snapshot_reconciliation',
                COALESCE(counterpoint_config->'snapshot_reconciliation', '{}'::jsonb)
                    || jsonb_build_object($1::text, $2::jsonb)
            )
        WHERE id = 1
        "#,
    )
    .bind(snapshot)
    .bind(body)
    .execute(pool)
    .await?;

    Ok(())
}

#[derive(Debug)]
struct SnapshotSourceMetric {
    source_count: i64,
    source_sum: Decimal,
    source_checksum: Option<String>,
    updated_at: Option<DateTime<Utc>>,
}

async fn load_snapshot_source_metric(
    pool: &PgPool,
    snapshot: &str,
) -> Result<Option<SnapshotSourceMetric>, CounterpointSyncError> {
    let raw: Option<serde_json::Value> = sqlx::query_scalar(
        r#"
        SELECT counterpoint_config->'snapshot_reconciliation'->$1
        FROM store_settings
        WHERE id = 1
        "#,
    )
    .bind(snapshot)
    .fetch_optional(pool)
    .await?
    .flatten();

    let Some(raw) = raw else {
        return Ok(None);
    };
    let source_count = raw
        .get("source_count")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| CounterpointSyncError::InvalidPayload("invalid source_count".into()))?;
    let source_sum_raw = raw
        .get("source_sum")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CounterpointSyncError::InvalidPayload("invalid source_sum".into()))?;
    let source_sum = source_sum_raw
        .parse::<Decimal>()
        .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
    let source_checksum = raw
        .get("source_checksum")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let updated_at = raw
        .get("updated_at")
        .and_then(|v| v.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc));

    Ok(Some(SnapshotSourceMetric {
        source_count,
        source_sum,
        source_checksum,
        updated_at,
    }))
}

fn build_snapshot_reconciliation_row(
    key: &str,
    label: &str,
    metric: Option<SnapshotSourceMetric>,
    landed_count: i64,
    landed_sum: Decimal,
) -> CounterpointSnapshotReconciliationRow {
    let Some(metric) = metric else {
        return CounterpointSnapshotReconciliationRow {
            key: key.into(),
            label: label.into(),
            status: "missing_source".into(),
            passed: false,
            source_count: None,
            landed_count,
            count_difference: None,
            source_sum: None,
            landed_sum: landed_sum.to_string(),
            sum_difference: None,
            source_checksum: None,
            landed_checksum: None,
            checksum_matched: None,
            note: "No Counterpoint source snapshot metrics have been received for this domain."
                .into(),
            source_updated_at: None,
        };
    };

    let count_difference = landed_count - metric.source_count;
    let sum_difference = landed_sum - metric.source_sum;
    let passed = count_difference == 0 && sum_difference == Decimal::ZERO;
    CounterpointSnapshotReconciliationRow {
        key: key.into(),
        label: label.into(),
        status: if passed { "pass" } else { "fail" }.into(),
        passed,
        source_count: Some(metric.source_count),
        landed_count,
        count_difference: Some(count_difference),
        source_sum: Some(metric.source_sum.to_string()),
        landed_sum: landed_sum.to_string(),
        sum_difference: Some(sum_difference.to_string()),
        source_checksum: metric.source_checksum,
        landed_checksum: None,
        checksum_matched: None,
        note: if passed {
            "Counterpoint source count and sum match landed ROS snapshot values.".into()
        } else {
            "Counterpoint source count or sum does not match landed ROS snapshot values.".into()
        },
        source_updated_at: metric.updated_at,
    }
}

fn build_checksum_reconciliation_row(
    key: &str,
    label: &str,
    metric: Option<SnapshotSourceMetric>,
    landed_count: i64,
    landed_checksum: Option<String>,
) -> CounterpointSnapshotReconciliationRow {
    let Some(metric) = metric else {
        return CounterpointSnapshotReconciliationRow {
            key: key.into(),
            label: label.into(),
            status: "missing_source".into(),
            passed: false,
            source_count: None,
            landed_count,
            count_difference: None,
            source_sum: None,
            landed_sum: Decimal::ZERO.to_string(),
            sum_difference: None,
            source_checksum: None,
            landed_checksum,
            checksum_matched: None,
            note: "No Counterpoint source checksum proof has been received for this field group."
                .into(),
            source_updated_at: None,
        };
    };

    let source_checksum = metric.source_checksum.clone();
    let checksum_matched = source_checksum.is_some()
        && landed_checksum.is_some()
        && source_checksum.as_deref() == landed_checksum.as_deref();
    let count_difference = landed_count - metric.source_count;
    let passed = count_difference == 0 && checksum_matched;
    let status = if source_checksum.is_none() {
        "missing_source"
    } else if passed {
        "pass"
    } else {
        "fail"
    };

    CounterpointSnapshotReconciliationRow {
        key: key.into(),
        label: label.into(),
        status: status.into(),
        passed,
        source_count: Some(metric.source_count),
        landed_count,
        count_difference: Some(count_difference),
        source_sum: Some(metric.source_sum.to_string()),
        landed_sum: Decimal::ZERO.to_string(),
        sum_difference: Some(Decimal::ZERO.to_string()),
        source_checksum,
        landed_checksum,
        checksum_matched: Some(checksum_matched),
        note: if status == "missing_source" {
            "No Counterpoint source checksum proof has been received for this field group.".into()
        } else if passed {
            "Counterpoint live-query checksum matches landed ROS field values.".into()
        } else {
            "Counterpoint live-query checksum does not match landed ROS field values.".into()
        },
        source_updated_at: metric.updated_at,
    }
}

async fn landed_catalog_price_cost_checksum(
    pool: &PgPool,
) -> Result<(i64, Option<String>), CounterpointSyncError> {
    sqlx::query_as(
        r#"
        WITH rows AS (
            SELECT CONCAT_WS('|',
                UPPER(TRIM(COALESCE(pv.counterpoint_item_key, ''))),
                TO_CHAR(ROUND(COALESCE(pv.retail_price_override, p.base_retail_price, 0)::numeric, 4), 'FM999999999999999999990.0000'),
                TO_CHAR(ROUND(COALESCE(pv.cost_override, p.base_cost, 0)::numeric, 4), 'FM999999999999999999990.0000'),
                TO_CHAR(ROUND(COALESCE(pv.counterpoint_prc_2, 0)::numeric, 4), 'FM999999999999999999990.0000'),
                TO_CHAR(ROUND(COALESCE(pv.counterpoint_prc_3, 0)::numeric, 4), 'FM999999999999999999990.0000')
            ) AS row_text
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
        )
        SELECT COUNT(*)::bigint, MD5(COALESCE(STRING_AGG(row_text, E'\n' ORDER BY row_text), ''))
        FROM rows
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(CounterpointSyncError::from)
}

async fn landed_catalog_category_vendor_checksum(
    pool: &PgPool,
) -> Result<(i64, Option<String>), CounterpointSyncError> {
    sqlx::query_as(
        r#"
        WITH rows AS (
            SELECT CONCAT_WS('|',
                UPPER(TRIM(COALESCE(p.catalog_handle, ''))),
                UPPER(TRIM(COALESCE(mapped_category.cp_category, c.name, ''))),
                UPPER(TRIM(COALESCE(v.vendor_code, '')))
            ) AS row_text
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN LATERAL (
                SELECT ccm.cp_category
                FROM counterpoint_category_map ccm
                WHERE ccm.ros_category_id = p.category_id
                ORDER BY ccm.cp_category
                LIMIT 1
            ) mapped_category ON TRUE
            LEFT JOIN vendors v ON v.id = p.primary_vendor_id
            WHERE p.data_source = 'counterpoint'
              AND NULLIF(TRIM(p.catalog_handle), '') IS NOT NULL
        )
        SELECT COUNT(*)::bigint, MD5(COALESCE(STRING_AGG(row_text, E'\n' ORDER BY row_text), ''))
        FROM rows
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(CounterpointSyncError::from)
}

async fn landed_catalog_variant_label_checksum(
    pool: &PgPool,
) -> Result<(i64, Option<String>), CounterpointSyncError> {
    sqlx::query_as(
        r#"
        WITH rows AS (
            SELECT CONCAT_WS('|',
                UPPER(TRIM(COALESCE(pv.counterpoint_item_key, ''))),
                TRIM(COALESCE(pv.variation_label, ''))
            ) AS row_text
            FROM product_variants pv
            WHERE NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
        )
        SELECT COUNT(*)::bigint, MD5(COALESCE(STRING_AGG(row_text, E'\n' ORDER BY row_text), ''))
        FROM rows
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(CounterpointSyncError::from)
}

async fn landed_inventory_quantity_cost_checksum(
    pool: &PgPool,
) -> Result<(i64, Option<String>), CounterpointSyncError> {
    sqlx::query_as(
        r#"
        WITH rows AS (
            SELECT CONCAT_WS('|',
                UPPER(TRIM(COALESCE(NULLIF(TRIM(pv.counterpoint_item_key), ''), pv.sku, ''))),
                COALESCE(pv.stock_on_hand, 0)::text,
                TO_CHAR(ROUND(COALESCE(pv.cost_override, 0)::numeric, 4), 'FM999999999999999999990.0000')
            ) AS row_text
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
               OR p.data_source = 'counterpoint'
        )
        SELECT COUNT(*)::bigint, MD5(COALESCE(STRING_AGG(row_text, E'\n' ORDER BY row_text), ''))
        FROM rows
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(CounterpointSyncError::from)
}

fn supported_fidelity_group(group: &str) -> Option<&'static str> {
    match group.trim() {
        "catalog_price_cost_fields" => Some("catalog_price_cost_fields"),
        "catalog_category_vendor_fields" => Some("catalog_category_vendor_fields"),
        "catalog_variant_label_fields" => Some("catalog_variant_label_fields"),
        "inventory_quantity_cost_fields" => Some("inventory_quantity_cost_fields"),
        _ => None,
    }
}

fn normalize_diag_key(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_ascii_uppercase()
}

fn normalize_diag_text(value: Option<&str>, uppercase: bool) -> String {
    let trimmed = value.unwrap_or("").trim();
    if uppercase {
        trimmed.to_ascii_uppercase()
    } else {
        trimmed.to_string()
    }
}

fn normalize_diag_decimal(value: Option<&str>) -> String {
    value
        .and_then(|v| v.trim().parse::<Decimal>().ok())
        .map(|d| {
            format!(
                "{:.4}",
                d.round_dp_with_strategy(4, RoundingStrategy::MidpointAwayFromZero)
            )
        })
        .unwrap_or_else(|| "0.0000".into())
}

fn normalize_diag_decimal_value(value: Option<Decimal>) -> String {
    value
        .map(|d| {
            format!(
                "{:.4}",
                d.round_dp_with_strategy(4, RoundingStrategy::MidpointAwayFromZero)
            )
        })
        .unwrap_or_else(|| "0.0000".into())
}

fn push_fidelity_mismatch(
    mismatches: &mut Vec<CounterpointFidelityDiagnosticMismatch>,
    mismatch_count: &mut i64,
    limit: usize,
    row: &CounterpointFidelityDiagnosticSourceRow,
    group_field: (&str, &str),
    counterpoint_value: String,
    ros_value: String,
) {
    if counterpoint_value == ros_value {
        return;
    }
    let (group, field) = group_field;
    *mismatch_count += 1;
    if mismatches.len() < limit {
        mismatches.push(CounterpointFidelityDiagnosticMismatch {
            group: group.into(),
            item_key: trim_opt(&row.counterpoint_item_key).or_else(|| trim_opt(&row.item_no)),
            sku: trim_opt(&row.sku),
            barcode: trim_opt(&row.barcode),
            field: field.into(),
            counterpoint_value,
            ros_value,
        });
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct RosFidelityVariantRow {
    counterpoint_item_key: Option<String>,
    sku: String,
    variation_label: Option<String>,
    stock_on_hand: i32,
    retail_price: Decimal,
    unit_cost: Decimal,
    prc_2: Option<Decimal>,
    prc_3: Option<Decimal>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct RosFidelityProductRow {
    catalog_handle: String,
    category: Option<String>,
    vendor_no: Option<String>,
}

async fn load_ros_fidelity_variants(
    pool: &PgPool,
) -> Result<Vec<RosFidelityVariantRow>, CounterpointSyncError> {
    sqlx::query_as(
        r#"
        SELECT
            pv.counterpoint_item_key,
            pv.sku,
            pv.variation_label,
            COALESCE(pv.stock_on_hand, 0) AS stock_on_hand,
            COALESCE(pv.retail_price_override, p.base_retail_price, 0) AS retail_price,
            COALESCE(pv.cost_override, p.base_cost, 0) AS unit_cost,
            pv.counterpoint_prc_2 AS prc_2,
            pv.counterpoint_prc_3 AS prc_3
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
           OR p.data_source = 'counterpoint'
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(CounterpointSyncError::from)
}

async fn load_ros_fidelity_products(
    pool: &PgPool,
) -> Result<Vec<RosFidelityProductRow>, CounterpointSyncError> {
    sqlx::query_as(
        r#"
        SELECT
            p.catalog_handle,
            COALESCE(mapped_category.cp_category, c.name) AS category,
            v.vendor_code AS vendor_no
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN LATERAL (
            SELECT ccm.cp_category
            FROM counterpoint_category_map ccm
            WHERE ccm.ros_category_id = p.category_id
            ORDER BY ccm.cp_category
            LIMIT 1
        ) mapped_category ON TRUE
        LEFT JOIN vendors v ON v.id = p.primary_vendor_id
        WHERE p.data_source = 'counterpoint'
          AND NULLIF(TRIM(p.catalog_handle), '') IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(CounterpointSyncError::from)
}

fn build_variant_maps(
    rows: Vec<RosFidelityVariantRow>,
) -> (
    HashMap<String, RosFidelityVariantRow>,
    HashMap<String, RosFidelityVariantRow>,
) {
    let mut by_key = HashMap::new();
    let mut by_sku = HashMap::new();
    for row in rows {
        if let Some(key) = trim_opt(&row.counterpoint_item_key) {
            by_key.insert(normalize_diag_key(Some(&key)), row.clone());
        }
        by_sku.insert(normalize_diag_key(Some(&row.sku)), row);
    }
    (by_key, by_sku)
}

fn source_row_variant_key(row: &CounterpointFidelityDiagnosticSourceRow) -> String {
    normalize_diag_key(
        row.counterpoint_item_key
            .as_deref()
            .or(row.item_no.as_deref()),
    )
}

fn compare_variant_field_group(
    group: &str,
    rows: &[CounterpointFidelityDiagnosticSourceRow],
    by_key: &HashMap<String, RosFidelityVariantRow>,
    by_sku: &HashMap<String, RosFidelityVariantRow>,
    limit: usize,
) -> (i64, i64, Vec<CounterpointFidelityDiagnosticMismatch>) {
    let mut compared_rows = 0_i64;
    let mut mismatch_count = 0_i64;
    let mut mismatches = Vec::new();

    for row in rows {
        let key = source_row_variant_key(row);
        let sku_key = normalize_diag_key(row.sku.as_deref());
        let ros = by_key.get(&key).or_else(|| by_sku.get(&sku_key));
        let Some(ros) = ros else {
            mismatch_count += 1;
            if mismatches.len() < limit {
                mismatches.push(CounterpointFidelityDiagnosticMismatch {
                    group: group.into(),
                    item_key: trim_opt(&row.counterpoint_item_key)
                        .or_else(|| trim_opt(&row.item_no)),
                    sku: trim_opt(&row.sku),
                    barcode: trim_opt(&row.barcode),
                    field: "row".into(),
                    counterpoint_value: "present".into(),
                    ros_value: "missing".into(),
                });
            }
            continue;
        };
        compared_rows += 1;

        match group {
            "catalog_price_cost_fields" => {
                push_fidelity_mismatch(
                    &mut mismatches,
                    &mut mismatch_count,
                    limit,
                    row,
                    (group, "retail_price"),
                    normalize_diag_decimal(row.retail_price.as_deref()),
                    normalize_diag_decimal_value(Some(ros.retail_price)),
                );
                push_fidelity_mismatch(
                    &mut mismatches,
                    &mut mismatch_count,
                    limit,
                    row,
                    (group, "unit_cost"),
                    normalize_diag_decimal(row.unit_cost.as_deref()),
                    normalize_diag_decimal_value(Some(ros.unit_cost)),
                );
                push_fidelity_mismatch(
                    &mut mismatches,
                    &mut mismatch_count,
                    limit,
                    row,
                    (group, "prc_2"),
                    normalize_diag_decimal(row.prc_2.as_deref()),
                    normalize_diag_decimal_value(ros.prc_2),
                );
                push_fidelity_mismatch(
                    &mut mismatches,
                    &mut mismatch_count,
                    limit,
                    row,
                    (group, "prc_3"),
                    normalize_diag_decimal(row.prc_3.as_deref()),
                    normalize_diag_decimal_value(ros.prc_3),
                );
            }
            "catalog_variant_label_fields" => {
                push_fidelity_mismatch(
                    &mut mismatches,
                    &mut mismatch_count,
                    limit,
                    row,
                    (group, "variation_label"),
                    normalize_diag_text(row.variation_label.as_deref(), false),
                    normalize_diag_text(ros.variation_label.as_deref(), false),
                );
            }
            "inventory_quantity_cost_fields" => {
                push_fidelity_mismatch(
                    &mut mismatches,
                    &mut mismatch_count,
                    limit,
                    row,
                    (group, "stock_on_hand"),
                    row.stock_on_hand.unwrap_or(0).to_string(),
                    ros.stock_on_hand.to_string(),
                );
                push_fidelity_mismatch(
                    &mut mismatches,
                    &mut mismatch_count,
                    limit,
                    row,
                    (group, "unit_cost"),
                    normalize_diag_decimal(row.unit_cost.as_deref()),
                    normalize_diag_decimal_value(Some(ros.unit_cost)),
                );
            }
            _ => {}
        }
    }

    (compared_rows, mismatch_count, mismatches)
}

fn compare_category_vendor_group(
    rows: &[CounterpointFidelityDiagnosticSourceRow],
    products: Vec<RosFidelityProductRow>,
    limit: usize,
) -> (i64, i64, Vec<CounterpointFidelityDiagnosticMismatch>) {
    let by_handle: HashMap<String, RosFidelityProductRow> = products
        .into_iter()
        .map(|row| (normalize_diag_key(Some(&row.catalog_handle)), row))
        .collect();
    let mut compared_rows = 0_i64;
    let mut mismatch_count = 0_i64;
    let mut mismatches = Vec::new();

    for row in rows {
        let item_key = normalize_diag_key(row.item_no.as_deref());
        let Some(ros) = by_handle.get(&item_key) else {
            mismatch_count += 1;
            if mismatches.len() < limit {
                mismatches.push(CounterpointFidelityDiagnosticMismatch {
                    group: "catalog_category_vendor_fields".into(),
                    item_key: trim_opt(&row.item_no),
                    sku: trim_opt(&row.sku),
                    barcode: trim_opt(&row.barcode),
                    field: "row".into(),
                    counterpoint_value: "present".into(),
                    ros_value: "missing".into(),
                });
            }
            continue;
        };
        compared_rows += 1;
        push_fidelity_mismatch(
            &mut mismatches,
            &mut mismatch_count,
            limit,
            row,
            ("catalog_category_vendor_fields", "category"),
            normalize_diag_text(row.category.as_deref(), true),
            normalize_diag_text(ros.category.as_deref(), true),
        );
        push_fidelity_mismatch(
            &mut mismatches,
            &mut mismatch_count,
            limit,
            row,
            ("catalog_category_vendor_fields", "vendor_no"),
            normalize_diag_text(row.vendor_no.as_deref(), true),
            normalize_diag_text(ros.vendor_no.as_deref(), true),
        );
    }

    (compared_rows, mismatch_count, mismatches)
}

async fn store_fidelity_diagnostic_report(
    pool: &PgPool,
    report: &CounterpointFidelityDiagnosticReport,
) -> Result<(), CounterpointSyncError> {
    let body = serde_json::to_value(report)
        .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
    sqlx::query(
        r#"
        UPDATE store_settings
        SET counterpoint_config = COALESCE(counterpoint_config, '{}'::jsonb)
            || jsonb_build_object(
                'fidelity_diagnostics',
                COALESCE(counterpoint_config->'fidelity_diagnostics', '{}'::jsonb)
                    || jsonb_build_object($1::text, $2::jsonb)
            )
        WHERE id = 1
        "#,
    )
    .bind(&report.group)
    .bind(body)
    .execute(pool)
    .await?;
    Ok(())
}

async fn resolve_sync_issue_by_message(
    pool: &PgPool,
    entity: &str,
    external_key: &str,
    message: &str,
) {
    let _ = sqlx::query(
        r#"
        UPDATE counterpoint_sync_issue
        SET resolved = TRUE, resolved_at = NOW()
        WHERE entity = $1 AND external_key = $2 AND message = $3 AND NOT resolved
        "#,
    )
    .bind(entity)
    .bind(external_key)
    .bind(message)
    .execute(pool)
    .await;
}

pub async fn record_counterpoint_fidelity_diagnostics(
    pool: &PgPool,
    payload: CounterpointFidelityDiagnosticPayload,
) -> Result<CounterpointFidelityDiagnosticReport, CounterpointSyncError> {
    let Some(group) = supported_fidelity_group(&payload.group) else {
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "unsupported fidelity diagnostic group: {}",
            payload.group
        )));
    };
    let limit = payload.limit.unwrap_or(50).clamp(1, 250);
    let rows = payload.rows;

    let (compared_rows, mismatch_count, mismatches) = if group == "catalog_category_vendor_fields" {
        compare_category_vendor_group(&rows, load_ros_fidelity_products(pool).await?, limit)
    } else {
        let (by_key, by_sku) = build_variant_maps(load_ros_fidelity_variants(pool).await?);
        compare_variant_field_group(group, &rows, &by_key, &by_sku, limit)
    };

    let report = CounterpointFidelityDiagnosticReport {
        group: group.into(),
        generated_at: Utc::now(),
        total_source_rows: rows.len() as i64,
        compared_rows,
        mismatch_count,
        result_limit: limit,
        mismatches,
    };
    store_fidelity_diagnostic_report(pool, &report).await?;

    let message = format!("Counterpoint fidelity diagnostic mismatch: {group}");
    if report.mismatch_count > 0 {
        record_sync_issue(pool, "inventory_fidelity", Some(group), "error", &message).await;
    } else {
        resolve_sync_issue_by_message(pool, "inventory_fidelity", group, &message).await;
    }

    Ok(report)
}

async fn load_fidelity_diagnostic_reports(
    pool: &PgPool,
) -> Result<Vec<CounterpointFidelityDiagnosticReport>, CounterpointSyncError> {
    let raw: Option<serde_json::Value> = sqlx::query_scalar(
        r#"
        SELECT counterpoint_config->'fidelity_diagnostics'
        FROM store_settings
        WHERE id = 1
        "#,
    )
    .fetch_optional(pool)
    .await?
    .flatten();

    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let mut reports = Vec::new();
    for group in [
        "catalog_price_cost_fields",
        "catalog_category_vendor_fields",
        "catalog_variant_label_fields",
        "inventory_quantity_cost_fields",
    ] {
        if let Some(value) = raw.get(group) {
            if let Ok(report) =
                serde_json::from_value::<CounterpointFidelityDiagnosticReport>(value.clone())
            {
                reports.push(report);
            }
        }
    }
    Ok(reports)
}

async fn build_snapshot_reconciliation_rows(
    pool: &PgPool,
) -> Result<Vec<CounterpointSnapshotReconciliationRow>, CounterpointSyncError> {
    let (customer_count, _customer_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM customers
        WHERE customer_created_source = 'counterpoint'
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (product_count, _product_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM products
        WHERE data_source = 'counterpoint'
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (variant_count, _variant_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM product_variants
        WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (variant_sku_count, _variant_sku_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM product_variants
        WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL
          AND NULLIF(TRIM(sku), '') IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (variant_barcode_count, _variant_barcode_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM product_variants
        WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL
          AND NULLIF(TRIM(barcode), '') IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (vendor_count, _vendor_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM vendors
        WHERE NULLIF(TRIM(vendor_code), '') IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (category_count, _category_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM counterpoint_category_map
        WHERE ros_category_id IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (products_with_vendor_count, _products_with_vendor_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM products
        WHERE data_source = 'counterpoint'
          AND primary_vendor_id IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (products_with_category_count, _products_with_category_sum): (i64, Decimal) =
        sqlx::query_as(
            r#"
            SELECT COUNT(*)::bigint, 0::numeric
            FROM products
            WHERE data_source = 'counterpoint'
              AND category_id IS NOT NULL
            "#,
        )
        .fetch_one(pool)
        .await?;
    let (open_doc_count, _open_doc_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM transactions
        WHERE counterpoint_doc_ref IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (open_doc_line_count, _open_doc_line_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM transaction_lines tl
        INNER JOIN transactions t ON t.id = tl.transaction_id
        WHERE t.counterpoint_doc_ref IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (ticket_count, _ticket_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM transactions
        WHERE counterpoint_ticket_ref IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (ticket_line_count, _ticket_line_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, 0::numeric
        FROM transaction_lines tl
        INNER JOIN transactions t ON t.id = tl.transaction_id
        WHERE t.counterpoint_ticket_ref IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (ticket_payment_count, ticket_payment_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, COALESCE(SUM(pa.amount_allocated), 0)::numeric
        FROM payment_allocations pa
        INNER JOIN transactions t ON t.id = pa.target_transaction_id
        WHERE t.counterpoint_ticket_ref IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (open_doc_payment_count, open_doc_payment_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, COALESCE(SUM(pa.amount_allocated), 0)::numeric
        FROM payment_allocations pa
        INNER JOIN transactions t ON t.id = pa.target_transaction_id
        WHERE t.counterpoint_doc_ref IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (receiving_history_count, _receiving_history_sum): (i64, Decimal) =
        sqlx::query_as("SELECT COUNT(*)::bigint, 0::numeric FROM counterpoint_receiving_history")
            .fetch_one(pool)
            .await?;
    let (store_credit_opening_count, store_credit_opening_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, COALESCE(SUM(amount), 0)::numeric
        FROM store_credit_ledger
        WHERE reason = 'counterpoint_opening_balance'
        "#,
    )
    .fetch_one(pool)
    .await?;
    let (gift_count, gift_sum): (i64, Decimal) = sqlx::query_as(
        "SELECT COUNT(*)::bigint, COALESCE(SUM(current_balance), 0)::numeric FROM gift_cards",
    )
    .fetch_one(pool)
    .await?;
    let (loyalty_count, loyalty_sum): (i64, Decimal) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, COALESCE(SUM(COALESCE(loyalty_points, 0)), 0)::numeric
        FROM customers
        WHERE customer_created_source = 'counterpoint'
        "#,
    )
    .fetch_one(pool)
    .await?;

    let inventory_metric = load_snapshot_source_metric(pool, "inventory_quantity_rows").await?;
    let unresolved_inventory = unresolved_sync_issue_count(pool, "inventory", None).await?;
    let inventory_landed = inventory_metric
        .as_ref()
        .map(|metric| (metric.source_count - unresolved_inventory).max(0))
        .unwrap_or(0);
    let (catalog_price_cost_count, catalog_price_cost_checksum) =
        landed_catalog_price_cost_checksum(pool).await?;
    let (catalog_category_vendor_count, catalog_category_vendor_checksum) =
        landed_catalog_category_vendor_checksum(pool).await?;
    let (catalog_variant_label_count, catalog_variant_label_checksum) =
        landed_catalog_variant_label_checksum(pool).await?;
    let (inventory_quantity_cost_count, inventory_quantity_cost_checksum) =
        landed_inventory_quantity_cost_checksum(pool).await?;

    Ok(vec![
        build_snapshot_reconciliation_row(
            "customers",
            "Counterpoint customers",
            load_snapshot_source_metric(pool, "customers").await?,
            customer_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "catalog_products",
            "Catalog parent products",
            load_snapshot_source_metric(pool, "catalog_products").await?,
            product_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "catalog_variants",
            "Catalog variants/SKUs",
            load_snapshot_source_metric(pool, "catalog_variants").await?,
            variant_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "catalog_variant_skus",
            "Catalog variant SKUs",
            load_snapshot_source_metric(pool, "catalog_variant_skus").await?,
            variant_sku_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "catalog_variant_barcodes",
            "Catalog variant barcodes",
            load_snapshot_source_metric(pool, "catalog_variant_barcodes").await?,
            variant_barcode_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "counterpoint_vendors",
            "Counterpoint vendor masters",
            load_snapshot_source_metric(pool, "counterpoint_vendors").await?,
            vendor_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "counterpoint_categories",
            "Counterpoint category masters",
            load_snapshot_source_metric(pool, "counterpoint_categories").await?,
            category_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "catalog_items_with_vendor",
            "Catalog items with resolved vendors",
            load_snapshot_source_metric(pool, "catalog_items_with_vendor").await?,
            products_with_vendor_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "catalog_items_with_category",
            "Catalog items with resolved categories",
            load_snapshot_source_metric(pool, "catalog_items_with_category").await?,
            products_with_category_count,
            Decimal::ZERO,
        ),
        build_checksum_reconciliation_row(
            "catalog_price_cost_fields",
            "Catalog price/cost fields",
            load_snapshot_source_metric(pool, "catalog_price_cost_fields").await?,
            catalog_price_cost_count,
            catalog_price_cost_checksum,
        ),
        build_checksum_reconciliation_row(
            "catalog_category_vendor_fields",
            "Catalog category/vendor fields",
            load_snapshot_source_metric(pool, "catalog_category_vendor_fields").await?,
            catalog_category_vendor_count,
            catalog_category_vendor_checksum,
        ),
        build_checksum_reconciliation_row(
            "catalog_variant_label_fields",
            "Catalog variant labels",
            load_snapshot_source_metric(pool, "catalog_variant_label_fields").await?,
            catalog_variant_label_count,
            catalog_variant_label_checksum,
        ),
        build_snapshot_reconciliation_row(
            "inventory_quantity_rows",
            "Inventory quantity rows matched",
            inventory_metric,
            inventory_landed,
            Decimal::ZERO,
        ),
        build_checksum_reconciliation_row(
            "inventory_quantity_cost_fields",
            "Inventory quantity/cost fields",
            load_snapshot_source_metric(pool, "inventory_quantity_cost_fields").await?,
            inventory_quantity_cost_count,
            inventory_quantity_cost_checksum,
        ),
        build_snapshot_reconciliation_row(
            "tickets",
            "Closed ticket history",
            load_snapshot_source_metric(pool, "tickets").await?,
            ticket_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "ticket_lines",
            "Closed ticket lines",
            load_snapshot_source_metric(pool, "ticket_lines").await?,
            ticket_line_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "ticket_payments",
            "Closed ticket payments",
            load_snapshot_source_metric(pool, "ticket_payments").await?,
            ticket_payment_count,
            ticket_payment_sum,
        ),
        build_snapshot_reconciliation_row(
            "open_docs",
            "Open docs/unfulfilled obligations",
            load_snapshot_source_metric(pool, "open_docs").await?,
            open_doc_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "open_doc_lines",
            "Open-doc lines",
            load_snapshot_source_metric(pool, "open_doc_lines").await?,
            open_doc_line_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "open_doc_payments",
            "Open-doc deposits/payments",
            load_snapshot_source_metric(pool, "open_doc_payments").await?,
            open_doc_payment_count,
            open_doc_payment_sum,
        ),
        build_snapshot_reconciliation_row(
            "receiving_history",
            "Receiving/movement history",
            load_snapshot_source_metric(pool, "receiving_history").await?,
            receiving_history_count,
            Decimal::ZERO,
        ),
        build_snapshot_reconciliation_row(
            "gift_cards",
            "Gift card current balances",
            load_snapshot_source_metric(pool, "gift_cards").await?,
            gift_count,
            gift_sum,
        ),
        build_snapshot_reconciliation_row(
            "store_credit_opening",
            "Store credit opening balances",
            load_snapshot_source_metric(pool, "store_credit_opening").await?,
            store_credit_opening_count,
            store_credit_opening_sum,
        ),
        build_snapshot_reconciliation_row(
            "loyalty_points",
            "Customer loyalty points",
            load_snapshot_source_metric(pool, "loyalty_points").await?,
            loyalty_count,
            loyalty_sum,
        ),
    ])
}

async fn unresolved_sync_issue_count(
    pool: &PgPool,
    entity: &str,
    message_prefix: Option<&str>,
) -> Result<i64, CounterpointSyncError> {
    let count = if let Some(prefix) = message_prefix {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_sync_issue
            WHERE entity = $1 AND NOT resolved AND message LIKE ($2 || '%')
            "#,
        )
        .bind(entity)
        .bind(prefix)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_sync_issue
            WHERE entity = $1 AND NOT resolved
            "#,
        )
        .bind(entity)
        .fetch_one(pool)
        .await?
    };
    Ok(count)
}

fn cutover_visibility_row(
    key: &str,
    label: &str,
    count: i64,
    zero_note: &str,
    nonzero_note: &str,
) -> CounterpointCutoverVisibilityRow {
    let passed = count == 0;
    CounterpointCutoverVisibilityRow {
        key: key.into(),
        label: label.into(),
        status: if passed { "pass" } else { "fail" }.into(),
        passed,
        count,
        note: if passed { zero_note } else { nonzero_note }.into(),
    }
}

async fn build_cutover_visibility_rows(
    pool: &PgPool,
) -> Result<Vec<CounterpointCutoverVisibilityRow>, CounterpointSyncError> {
    let ticket_customer_links =
        unresolved_sync_issue_count(pool, "tickets", Some("Customer unresolved")).await?;
    let open_doc_customer_links =
        unresolved_sync_issue_count(pool, "open_docs", Some("Customer unresolved")).await?;
    let open_doc_unresolved_lines =
        unresolved_sync_issue_count(pool, "open_docs", Some("Open doc skipped: unresolved line"))
            .await?;
    let open_doc_required_data = unresolved_sync_issue_count(
        pool,
        "open_docs",
        Some("Open doc skipped: missing required"),
    )
    .await?
        + unresolved_sync_issue_count(pool, "open_docs", Some("Open doc skipped: no line items"))
            .await?;
    let inventory_rows = unresolved_sync_issue_count(pool, "inventory", None).await?;

    Ok(vec![
        cutover_visibility_row(
            "ticket_customer_links",
            "Ticket customer links",
            ticket_customer_links,
            "No unresolved Counterpoint ticket customer links are open.",
            "Counterpoint tickets imported with unresolved customer codes. Review Open sync issues.",
        ),
        cutover_visibility_row(
            "open_doc_customer_links",
            "Open-doc customer links",
            open_doc_customer_links,
            "No unresolved Counterpoint open-doc customer links are open.",
            "Counterpoint open docs imported with unresolved customer codes. Review Open sync issues.",
        ),
        cutover_visibility_row(
            "open_doc_unresolved_lines",
            "Open-doc unresolved lines",
            open_doc_unresolved_lines,
            "No Counterpoint open docs are blocked by unresolved item lines.",
            "Counterpoint open docs were skipped because item lines could not match ROS variants. Review Open sync issues.",
        ),
        cutover_visibility_row(
            "open_doc_required_data",
            "Open-doc required data",
            open_doc_required_data,
            "No Counterpoint open docs are blocked by missing required data.",
            "Counterpoint open docs were skipped because required fields or lines were missing. Review Open sync issues.",
        ),
        cutover_visibility_row(
            "inventory_unmatched_rows",
            "Inventory unmatched rows",
            inventory_rows,
            "No unresolved Counterpoint inventory quantity rows are open.",
            "Counterpoint inventory rows could not match a ROS variant by item key or SKU. Review Open sync issues.",
        ),
    ])
}

pub async fn build_counterpoint_landing_verification_summary(
    pool: &PgPool,
) -> Result<CounterpointLandingVerificationSummary, CounterpointSyncError> {
    let customers = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint'",
    )
    .await?;
    let customer_emails = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint' AND NULLIF(TRIM(email), '') IS NOT NULL",
    )
    .await?;
    let customer_phones = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint' AND NULLIF(TRIM(phone), '') IS NOT NULL",
    )
    .await?;
    let customer_addresses = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint' AND NULLIF(TRIM(address_line1), '') IS NOT NULL",
    )
    .await?;
    let staff_records = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM staff WHERE data_source = 'counterpoint'",
    )
    .await?;
    let staff_map_rows =
        counterpoint_landing_count(pool, "SELECT COUNT(*)::bigint FROM counterpoint_staff_map")
            .await?;
    let vendors = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM vendors WHERE NULLIF(TRIM(vendor_code), '') IS NOT NULL",
    )
    .await?;
    let category_maps = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM counterpoint_category_map",
    )
    .await?;
    let products = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'",
    )
    .await?;
    let variants = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM product_variants WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL",
    )
    .await?;
    let variant_skus = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM product_variants WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL AND NULLIF(TRIM(sku), '') IS NOT NULL",
    )
    .await?;
    let variant_barcodes = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM product_variants WHERE NULLIF(TRIM(counterpoint_item_key), '') IS NOT NULL AND NULLIF(TRIM(barcode), '') IS NOT NULL",
    )
    .await?;
    let vendor_supplier_items =
        counterpoint_landing_count(pool, "SELECT COUNT(*)::bigint FROM vendor_supplier_item")
            .await?;
    let gift_cards =
        counterpoint_landing_count(pool, "SELECT COUNT(*)::bigint FROM gift_cards").await?;
    let store_credit_openings = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM store_credit_ledger WHERE reason = 'counterpoint_opening_balance'",
    )
    .await?;
    let loyalty_history = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM loyalty_point_ledger WHERE reason = 'cp_loy_pts_hist' AND metadata ? 'cp_ref'",
    )
    .await?;
    let closed_ticket_transactions = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM transactions WHERE counterpoint_ticket_ref IS NOT NULL",
    )
    .await?;
    let closed_ticket_lines = counterpoint_landing_count(
        pool,
        r#"
        SELECT COUNT(*)::bigint
        FROM transaction_lines tl
        INNER JOIN transactions t ON t.id = tl.transaction_id
        WHERE t.counterpoint_ticket_ref IS NOT NULL
        "#,
    )
    .await?;
    let closed_ticket_payments = counterpoint_landing_count(
        pool,
        r#"
        SELECT COUNT(DISTINCT pa.transaction_id)::bigint
        FROM payment_allocations pa
        INNER JOIN transactions t ON t.id = pa.target_transaction_id
        WHERE t.counterpoint_ticket_ref IS NOT NULL
        "#,
    )
    .await?;
    let open_doc_transactions = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM transactions WHERE counterpoint_doc_ref IS NOT NULL",
    )
    .await?;
    let open_doc_lines = counterpoint_landing_count(
        pool,
        r#"
        SELECT COUNT(*)::bigint
        FROM transaction_lines tl
        INNER JOIN transactions t ON t.id = tl.transaction_id
        WHERE t.counterpoint_doc_ref IS NOT NULL
        "#,
    )
    .await?;
    let receiving_history = counterpoint_landing_count(
        pool,
        "SELECT COUNT(*)::bigint FROM counterpoint_receiving_history",
    )
    .await?;

    Ok(CounterpointLandingVerificationSummary {
        generated_at: Utc::now(),
        disclaimer: "Read-only landed-row counts from ROS tables. Gift-card and loyalty snapshots compare Counterpoint source metrics to landed ROS totals.".into(),
        rows: vec![
            landing_row("customers", "Counterpoint customers", customers, "direct", "customers.customer_created_source = 'counterpoint'"),
            landing_row("customer_emails", "Customer emails", customer_emails, "direct", "Counterpoint-created customers with an email address"),
            landing_row("customer_phones", "Customer phones", customer_phones, "direct", "Counterpoint-created customers with a phone number"),
            landing_row("customer_addresses", "Customer addresses", customer_addresses, "direct", "Counterpoint-created customers with address line 1"),
            landing_row("staff_records", "Counterpoint staff records", staff_records, "direct", "staff.data_source = 'counterpoint'"),
            landing_row("staff_map_rows", "Staff map rows", staff_map_rows, "direct", "counterpoint_staff_map rows"),
            landing_row("vendors", "Vendors with CP codes", vendors, "direct", "vendors.vendor_code present"),
            landing_row("category_maps", "Category map rows", category_maps, "direct", "counterpoint_category_map rows"),
            landing_row("products", "Counterpoint products", products, "direct", "products.data_source = 'counterpoint'"),
            landing_row("variants", "Variants with CP item keys", variants, "direct", "product_variants.counterpoint_item_key present"),
            landing_row("variant_skus", "Variant SKUs", variant_skus, "direct", "Counterpoint variants with ROS SKU values"),
            landing_row("variant_barcodes", "Variant barcodes", variant_barcodes, "direct", "Counterpoint variants with ROS barcode values"),
            landing_row("vendor_supplier_items", "Vendor supplier items", vendor_supplier_items, "direct", "vendor_supplier_item rows"),
            landing_row("gift_cards", "Gift cards", gift_cards, "approximate", "gift_cards has no Counterpoint provenance marker; count is the current pre-go-live gift-card dataset"),
            landing_row("store_credit_openings", "Store credit openings", store_credit_openings, "direct", "store_credit_ledger.reason = 'counterpoint_opening_balance'"),
            landing_row("loyalty_history", "Loyalty history rows", loyalty_history, "direct", "loyalty_point_ledger reason/metadata cp_ref"),
            landing_row("closed_ticket_transactions", "Closed ticket transactions", closed_ticket_transactions, "direct", "transactions.counterpoint_ticket_ref present"),
            landing_row("closed_ticket_lines", "Closed ticket lines", closed_ticket_lines, "direct", "transaction_lines attached to CP ticket transactions"),
            landing_row("closed_ticket_payments", "Closed ticket payments", closed_ticket_payments, "approximate", "distinct payment transactions allocated to CP ticket transactions; not tender reconciliation"),
            landing_row("open_doc_transactions", "Open-doc transactions", open_doc_transactions, "direct", "transactions.counterpoint_doc_ref present"),
            landing_row("open_doc_lines", "Open-doc lines", open_doc_lines, "direct", "transaction_lines attached to CP open-doc transactions"),
            landing_row("receiving_history", "Receiving history rows", receiving_history, "direct", "counterpoint_receiving_history rows"),
        ],
        snapshot_reconciliation: build_snapshot_reconciliation_rows(pool).await?,
        cutover_visibility: build_cutover_visibility_rows(pool).await?,
        fidelity_diagnostics: load_fidelity_diagnostic_reports(pool).await?,
    })
}

pub async fn build_counterpoint_transaction_reconciliation_snapshot(
    pool: &PgPool,
) -> Result<CounterpointTransactionReconciliationSnapshot, CounterpointSyncError> {
    let (
        imported_ticket_transactions,
        transaction_lines,
        imported_zero_tax_lines,
        payments,
        transaction_total_sum,
        payment_amount_sum,
    ): (i64, i64, i64, i64, Decimal, Decimal) = sqlx::query_as(
        r#"
        WITH ticket_tx AS (
            SELECT id, total_price
            FROM transactions
            WHERE counterpoint_ticket_ref IS NOT NULL
        )
        SELECT
            (SELECT COUNT(*)::bigint FROM ticket_tx) AS imported_ticket_transactions,
            (
                SELECT COUNT(*)::bigint
                FROM transaction_lines tl
                INNER JOIN ticket_tx t ON t.id = tl.transaction_id
            ) AS transaction_lines,
            (
                SELECT COUNT(*)::bigint
                FROM transaction_lines tl
                INNER JOIN ticket_tx t ON t.id = tl.transaction_id
                WHERE COALESCE(tl.state_tax, 0) = 0
                  AND COALESCE(tl.local_tax, 0) = 0
            ) AS imported_zero_tax_lines,
            (
                SELECT COUNT(*)::bigint
                FROM payment_allocations pa
                INNER JOIN ticket_tx t ON t.id = pa.target_transaction_id
            ) AS payments,
            COALESCE((SELECT SUM(total_price) FROM ticket_tx), 0)::numeric AS transaction_total_sum,
            COALESCE((
                SELECT SUM(pa.amount_allocated)
                FROM payment_allocations pa
                INNER JOIN ticket_tx t ON t.id = pa.target_transaction_id
            ), 0)::numeric AS payment_amount_sum
        "#,
    )
    .fetch_one(pool)
    .await?;

    let by_date_raw: Vec<(NaiveDate, i64, i64, i64, Decimal, Decimal)> = sqlx::query_as(
        r#"
        WITH ticket_tx AS (
            SELECT
                id,
                (booked_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_day,
                total_price
            FROM transactions
            WHERE counterpoint_ticket_ref IS NOT NULL
        ),
        tx_totals AS (
            SELECT
                business_day,
                COUNT(*)::bigint AS imported_ticket_transactions,
                COALESCE(SUM(total_price), 0)::numeric AS transaction_total_sum
            FROM ticket_tx
            GROUP BY business_day
        ),
        line_totals AS (
            SELECT t.business_day, COUNT(*)::bigint AS transaction_lines
            FROM ticket_tx t
            INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
            GROUP BY t.business_day
        ),
        payment_totals AS (
            SELECT
                t.business_day,
                COUNT(*)::bigint AS payments,
                COALESCE(SUM(pa.amount_allocated), 0)::numeric AS payment_amount_sum
            FROM ticket_tx t
            INNER JOIN payment_allocations pa ON pa.target_transaction_id = t.id
            GROUP BY t.business_day
        )
        SELECT
            tx.business_day,
            tx.imported_ticket_transactions,
            COALESCE(lt.transaction_lines, 0)::bigint AS transaction_lines,
            COALESCE(pt.payments, 0)::bigint AS payments,
            tx.transaction_total_sum,
            COALESCE(pt.payment_amount_sum, 0)::numeric AS payment_amount_sum
        FROM tx_totals tx
        LEFT JOIN line_totals lt ON lt.business_day = tx.business_day
        LEFT JOIN payment_totals pt ON pt.business_day = tx.business_day
        ORDER BY tx.business_day DESC
        LIMIT 45
        "#,
    )
    .fetch_all(pool)
    .await?;

    let by_payment_type_raw: Vec<(String, i64, Decimal)> = sqlx::query_as(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM(pt.payment_method), ''), 'unknown') AS payment_type,
            COUNT(*)::bigint AS payments,
            COALESCE(SUM(pa.amount_allocated), 0)::numeric AS payment_amount_sum
        FROM payment_allocations pa
        INNER JOIN transactions t ON t.id = pa.target_transaction_id
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE t.counterpoint_ticket_ref IS NOT NULL
        GROUP BY 1
        ORDER BY payment_amount_sum DESC, payment_type ASC
        LIMIT 25
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(CounterpointTransactionReconciliationSnapshot {
        generated_at: Utc::now(),
        disclaimer: "Read-only Counterpoint ticket transaction sanity check. Imported tax is non-authoritative; this is not full accounting reconciliation or financial close.".into(),
        totals: CounterpointTransactionReconciliationTotals {
            imported_ticket_transactions,
            transaction_lines,
            imported_zero_tax_lines,
            payments,
            transaction_total_sum: transaction_total_sum.to_string(),
            payment_amount_sum: payment_amount_sum.to_string(),
            difference: (transaction_total_sum - payment_amount_sum).to_string(),
        },
        by_date: by_date_raw
            .into_iter()
            .map(
                |(
                    business_day,
                    imported_ticket_transactions,
                    transaction_lines,
                    payments,
                    transaction_total_sum,
                    payment_amount_sum,
                )| CounterpointTransactionReconciliationByDateRow {
                    business_day,
                    imported_ticket_transactions,
                    transaction_lines,
                    payments,
                    transaction_total_sum: transaction_total_sum.to_string(),
                    payment_amount_sum: payment_amount_sum.to_string(),
                },
            )
            .collect(),
        by_payment_type: by_payment_type_raw
            .into_iter()
            .map(
                |(payment_type, payments, payment_amount_sum)| {
                    CounterpointTransactionReconciliationByPaymentTypeRow {
                        payment_type,
                        payments,
                        payment_amount_sum: payment_amount_sum.to_string(),
                    }
                },
            )
            .collect(),
    })
}

pub async fn build_counterpoint_open_docs_verification_snapshot(
    pool: &PgPool,
) -> Result<CounterpointOpenDocsVerificationSnapshot, CounterpointSyncError> {
    let (
        imported_open_doc_transactions,
        imported_open_doc_lines,
        imported_open_doc_zero_tax_lines,
        imported_open_doc_payments,
        open_docs_with_customer_linked,
        open_docs_missing_customer,
        open_docs_with_zero_lines,
        open_docs_with_zero_payments,
        distinct_staff_attribution_count,
    ): (i64, i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        r#"
        WITH open_doc_tx AS (
            SELECT id, customer_id, processed_by_staff_id, primary_salesperson_id
            FROM transactions
            WHERE counterpoint_doc_ref IS NOT NULL
        ),
        line_counts AS (
            SELECT t.id, COUNT(tl.id)::bigint AS line_count
            FROM open_doc_tx t
            LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
            GROUP BY t.id
        ),
        payment_counts AS (
            SELECT t.id, COUNT(pa.transaction_id)::bigint AS payment_count
            FROM open_doc_tx t
            LEFT JOIN payment_allocations pa ON pa.target_transaction_id = t.id
            GROUP BY t.id
        ),
        staff_refs AS (
            SELECT processed_by_staff_id AS staff_id
            FROM open_doc_tx
            WHERE processed_by_staff_id IS NOT NULL
            UNION
            SELECT primary_salesperson_id AS staff_id
            FROM open_doc_tx
            WHERE primary_salesperson_id IS NOT NULL
        )
        SELECT
            (SELECT COUNT(*)::bigint FROM open_doc_tx) AS imported_open_doc_transactions,
            (SELECT COALESCE(SUM(line_count), 0)::bigint FROM line_counts) AS imported_open_doc_lines,
            (
                SELECT COUNT(*)::bigint
                FROM transaction_lines tl
                INNER JOIN open_doc_tx t ON t.id = tl.transaction_id
                WHERE COALESCE(tl.state_tax, 0) = 0
                  AND COALESCE(tl.local_tax, 0) = 0
            ) AS imported_open_doc_zero_tax_lines,
            (SELECT COALESCE(SUM(payment_count), 0)::bigint FROM payment_counts) AS imported_open_doc_payments,
            (SELECT COUNT(*)::bigint FROM open_doc_tx WHERE customer_id IS NOT NULL) AS open_docs_with_customer_linked,
            (SELECT COUNT(*)::bigint FROM open_doc_tx WHERE customer_id IS NULL) AS open_docs_missing_customer,
            (SELECT COUNT(*)::bigint FROM line_counts WHERE line_count = 0) AS open_docs_with_zero_lines,
            (SELECT COUNT(*)::bigint FROM payment_counts WHERE payment_count = 0) AS open_docs_with_zero_payments,
            (SELECT COUNT(*)::bigint FROM staff_refs) AS distinct_staff_attribution_count
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(CounterpointOpenDocsVerificationSnapshot {
        generated_at: Utc::now(),
        disclaimer: "Open docs represent in-progress orders. This is a structural validation, not financial reconciliation.".into(),
        imported_open_doc_transactions,
        imported_open_doc_lines,
        imported_open_doc_zero_tax_lines,
        imported_open_doc_payments,
        open_docs_with_customer_linked,
        open_docs_missing_customer,
        open_docs_with_zero_lines,
        open_docs_with_zero_payments,
        distinct_staff_attribution_count,
    })
}

pub async fn build_counterpoint_inventory_catalog_verification_snapshot(
    pool: &PgPool,
) -> Result<CounterpointInventoryCatalogVerificationSnapshot, CounterpointSyncError> {
    let counts: CounterpointInventoryCatalogVerificationCounts = sqlx::query_as(
        r#"
        WITH imported_products AS (
            SELECT id, name, catalog_handle, category_id, primary_vendor_id
            FROM products
            WHERE data_source = 'counterpoint'
        ),
        imported_variants AS (
            SELECT
                pv.id,
                pv.product_id,
                pv.sku,
                pv.barcode,
                pv.counterpoint_item_key,
                pv.stock_on_hand,
                COALESCE(pv.cost_override, p.base_cost) AS effective_cost,
                COALESCE(pv.retail_price_override, p.base_retail_price) AS effective_price,
                p.primary_vendor_id
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE p.data_source = 'counterpoint'
               OR NULLIF(TRIM(pv.counterpoint_item_key), '') IS NOT NULL
        ),
        vendor_linked_variants AS (
            SELECT DISTINCT variant_id
            FROM vendor_supplier_item
            WHERE variant_id IS NOT NULL
        ),
        linked_vendor_ids AS (
            SELECT primary_vendor_id AS vendor_id
            FROM imported_products
            WHERE primary_vendor_id IS NOT NULL
            UNION
            SELECT vsi.vendor_id
            FROM vendor_supplier_item vsi
            INNER JOIN imported_variants iv ON iv.id = vsi.variant_id
            WHERE vsi.vendor_id IS NOT NULL
        )
        SELECT
            (SELECT COUNT(*)::bigint FROM imported_products) AS counterpoint_products,
            (SELECT COUNT(*)::bigint FROM imported_variants) AS counterpoint_variants,
            (
                SELECT COUNT(*)::bigint
                FROM imported_products p
                WHERE NULLIF(TRIM(p.name), '') IS NOT NULL
                  AND (
                    UPPER(TRIM(p.name)) = UPPER(TRIM(COALESCE(p.catalog_handle, '')))
                    OR UPPER(TRIM(p.name)) ~ '^[IB]-[A-Z0-9_-]{3,}$'
                    OR TRIM(p.name) ~ '^[0-9]{4,}$'
                    OR EXISTS (
                        SELECT 1
                        FROM imported_variants iv
                        WHERE iv.product_id = p.id
                          AND (
                            UPPER(TRIM(p.name)) = UPPER(TRIM(COALESCE(iv.sku, '')))
                            OR UPPER(TRIM(p.name)) = UPPER(TRIM(COALESCE(iv.counterpoint_item_key, '')))
                          )
                    )
                  )
            ) AS products_with_identifier_like_name,
            (
                SELECT COUNT(*)::bigint
                FROM imported_products p
                WHERE NULLIF(TRIM(p.name), '') IS NOT NULL
                  AND (
                    UPPER(TRIM(p.name)) = UPPER(TRIM(COALESCE(p.catalog_handle, '')))
                    OR EXISTS (
                        SELECT 1
                        FROM imported_variants iv
                        WHERE iv.product_id = p.id
                          AND UPPER(TRIM(p.name)) = UPPER(TRIM(COALESCE(iv.counterpoint_item_key, '')))
                    )
                  )
            ) AS products_name_equals_counterpoint_key,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE NULLIF(TRIM(sku), '') IS NOT NULL) AS variants_with_sku,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE NULLIF(TRIM(barcode), '') IS NOT NULL) AS variants_with_barcode,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE COALESCE(effective_cost, 0) > 0) AS variants_with_cost,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE COALESCE(effective_price, 0) > 0) AS variants_with_price,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE COALESCE(stock_on_hand, 0) > 0) AS variants_with_quantity_on_hand,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE NULLIF(TRIM(sku), '') IS NULL) AS variants_missing_sku,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE NULLIF(TRIM(barcode), '') IS NULL) AS variants_missing_barcode,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE COALESCE(effective_cost, 0) <= 0) AS variants_missing_cost,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE COALESCE(effective_price, 0) <= 0) AS variants_missing_price,
            (SELECT COUNT(*)::bigint FROM imported_variants WHERE COALESCE(stock_on_hand, 0) <= 0) AS variants_zero_or_negative_quantity,
            (SELECT COUNT(*)::bigint FROM imported_products WHERE category_id IS NULL) AS products_missing_category_mapping,
            (
                SELECT COUNT(*)::bigint
                FROM imported_variants iv
                LEFT JOIN vendor_linked_variants vlv ON vlv.variant_id = iv.id
                WHERE vlv.variant_id IS NULL
            ) AS variants_missing_vendor_supplier_item_link,
            (SELECT COUNT(*)::bigint FROM linked_vendor_ids) AS distinct_vendors_linked_to_imported_items
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(CounterpointInventoryCatalogVerificationSnapshot {
        generated_at: Utc::now(),
        disclaimer: "Catalog completeness check only. Does not verify physical inventory accuracy."
            .into(),
        counterpoint_products: counts.counterpoint_products,
        counterpoint_variants: counts.counterpoint_variants,
        products_with_identifier_like_name: counts.products_with_identifier_like_name,
        products_name_equals_counterpoint_key: counts.products_name_equals_counterpoint_key,
        variants_with_sku: counts.variants_with_sku,
        variants_with_barcode: counts.variants_with_barcode,
        variants_with_cost: counts.variants_with_cost,
        variants_with_price: counts.variants_with_price,
        variants_with_quantity_on_hand: counts.variants_with_quantity_on_hand,
        variants_missing_sku: counts.variants_missing_sku,
        variants_missing_barcode: counts.variants_missing_barcode,
        variants_missing_cost: counts.variants_missing_cost,
        variants_missing_price: counts.variants_missing_price,
        variants_zero_or_negative_quantity: counts.variants_zero_or_negative_quantity,
        products_missing_category_mapping: counts.products_missing_category_mapping,
        variants_missing_vendor_supplier_item_link: counts
            .variants_missing_vendor_supplier_item_link,
        distinct_vendors_linked_to_imported_items: counts.distinct_vendors_linked_to_imported_items,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Pre-go-live Counterpoint baseline reset
// ────────────────────────────────────────────────────────────────────────────

const COUNTERPOINT_BASELINE_RESET_CONFIRMATION: &str = "RESET COUNTERPOINT BASELINE";

#[derive(Debug, Serialize)]
pub struct CounterpointResetCountRow {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointResetPreview {
    pub confirmation_phrase: String,
    pub pre_go_live_only_warning: String,
    pub preserve_always: Vec<String>,
    pub reset_scope: Vec<CounterpointResetCountRow>,
    pub careful_ordering: Vec<String>,
    pub excluded_for_now: Vec<String>,
    pub bridge_local_state_note: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointResetResult {
    pub confirmation_phrase: String,
    pub reset_scope: Vec<CounterpointResetCountRow>,
    pub preserve_always: Vec<String>,
    pub bridge_local_state_note: String,
}

async fn reset_preview_count(pool: &PgPool, query: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(query).fetch_one(pool).await
}

fn counterpoint_reset_preserve_always() -> Vec<String> {
    vec![
        "Bootstrap/back-office staff accounts and PIN access, including the seeded Chris G admin account.".into(),
        "store_settings and other singleton runtime/config rows required for app startup.".into(),
        "Staff role permissions, per-staff permissions, pricing limits, and other auth/bootstrap tables.".into(),
        "Counterpoint mapping configuration tables (category, payment method, gift reason) so reruns keep the reviewed mapping setup.".into(),
        "Schema/migration ledgers, help/config content, and non-business integration/runtime settings.".into(),
    ]
}

fn counterpoint_reset_excluded_for_now() -> Vec<String> {
    vec![
        "Categories and category audit history stay in place because they are shared setup, not proven migration-only rows.".into(),
        "Wedding planning records, shipping records, tasks, notifications, and other non-Counterpoint operational modules are excluded unless they block a reset directly.".into(),
        "Bridge-side local cursor files such as .counterpoint-bridge-state.json are not touched by the server reset.".into(),
    ]
}

async fn build_counterpoint_reset_scope(
    pool: &PgPool,
) -> Result<Vec<CounterpointResetCountRow>, sqlx::Error> {
    Ok(vec![
        CounterpointResetCountRow {
            key: "customers".into(),
            label: "Counterpoint customers".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint'",
            )
            .await?,
            note: "Deletes Counterpoint-created customers plus dependent notes, loyalty/store-credit accounts, and linked CRM-only child rows.".into(),
        },
        CounterpointResetCountRow {
            key: "transactions".into(),
            label: "Counterpoint transactions".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM transactions WHERE is_counterpoint_import",
            )
            .await?,
            note: "Deletes imported ticket/open-doc transactions, their lines, linked payment allocations, and any extra pre-go-live transactions still attached to Counterpoint customers.".into(),
        },
        CounterpointResetCountRow {
            key: "products".into(),
            label: "Counterpoint catalog products".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'",
            )
            .await?,
            note: "Deletes Counterpoint products/variants and clears pre-go-live operational leftovers that still point at those variants.".into(),
        },
        CounterpointResetCountRow {
            key: "vendors".into(),
            label: "Vendors".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM vendors").await?,
            note: "This pre-go-live reset clears the vendor dataset because vendor rows are treated as migration data before go-live.".into(),
        },
        CounterpointResetCountRow {
            key: "gift_cards".into(),
            label: "Gift cards".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM gift_cards").await?,
            note: "Gift cards have no separate native provenance marker today, so the reset clears the full pre-go-live gift-card dataset.".into(),
        },
        CounterpointResetCountRow {
            key: "loyalty_ledger".into(),
            label: "Loyalty ledger rows".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM loyalty_point_ledger").await?,
            note: "Counterpoint-linked and pre-go-live loyalty rows are cleared as part of restoring a fresh migration baseline.".into(),
        },
        CounterpointResetCountRow {
            key: "store_credit_accounts".into(),
            label: "Store credit accounts".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM store_credit_accounts").await?,
            note: "Customer-linked store credit accounts and ledger history are cleared with the migration customer dataset.".into(),
        },
        CounterpointResetCountRow {
            key: "counterpoint_state".into(),
            label: "Counterpoint sync state rows".into(),
            count: reset_preview_count(
                pool,
                r#"
                SELECT
                    (SELECT COUNT(*)::bigint FROM counterpoint_sync_runs)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_issue)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_request)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staging_batch)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_receiving_history)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staff_map)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_category_map)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_import_runs)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_import_raw_records)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_import_provenance)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_import_exceptions)
                "#,
            )
            .await?,
            note: "Clears Counterpoint staging, run history, source-count proof, raw import proof, provenance, exceptions, receiving history, staff maps, and category maps so ROS shows a fresh migration state.".into(),
        },
        CounterpointResetCountRow {
            key: "counterpoint_staff".into(),
            label: "Counterpoint-only staff rows".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM staff WHERE data_source = 'counterpoint' AND pin_hash IS NULL",
            )
            .await?,
            note: "Removes imported historical/stub staff without local PIN access. Preserved bootstrap staff keep access, but their Counterpoint link fields are cleared.".into(),
        },
    ])
}

pub async fn get_counterpoint_reset_preview(
    pool: &PgPool,
) -> Result<CounterpointResetPreview, sqlx::Error> {
    Ok(CounterpointResetPreview {
        confirmation_phrase: COUNTERPOINT_BASELINE_RESET_CONFIRMATION.into(),
        pre_go_live_only_warning: "Pre-go-live only. This reset is intended to clear migration/test business data before the store accepts ROS as the live system of record.".into(),
        preserve_always: counterpoint_reset_preserve_always(),
        reset_scope: build_counterpoint_reset_scope(pool).await?,
        careful_ordering: vec![
            "Imported transactions/payments are cleared before customers and gift cards so foreign-key references do not block the reset.".into(),
            "Product-linked operational leftovers are cleared before Counterpoint products/variants so the catalog can be removed safely.".into(),
            "Counterpoint-only staff rows are removed last, after customer/product/transaction references are gone.".into(),
        ],
        excluded_for_now: counterpoint_reset_excluded_for_now(),
        bridge_local_state_note: "If the bridge is using local cursor state (.counterpoint-bridge-state.json), delete or reset that file on the Counterpoint PC before the next full fresh import. This server reset does not touch bridge-local cursor files.".into(),
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Counterpoint CSV inventory verification (read-only)
// ────────────────────────────────────────────────────────────────────────────

const COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS: usize = 2000;
const COUNTERPOINT_INVENTORY_VERIFY_MAX_EXTRA_ROWS: usize = 1000;

#[derive(Debug, Deserialize)]
struct CounterpointInventoryCsvRow {
    sku: String,
    name: String,
    product_category: String,
    variant_option_one_value: String,
    variant_option_two_value: String,
    variant_option_three_value: String,
    tags: String,
    supply_price: String,
    retail_price: String,
    supplier_name: String,
    supplier_code: String,
    inventory_main_outlet: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointInventoryVerificationValues {
    pub sku: String,
    pub name: Option<String>,
    pub category: Option<String>,
    pub variant_label: Option<String>,
    pub supply_price: Option<String>,
    pub retail_price: Option<String>,
    pub inventory_quantity: Option<String>,
    pub supplier_name: Option<String>,
    pub supplier_code: Option<String>,
    pub item_key: Option<String>,
    pub catalog_handle: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointInventoryVerificationRow {
    pub sku: String,
    pub match_basis: Option<String>,
    pub status: String,
    pub mismatch_types: Vec<String>,
    pub csv: CounterpointInventoryVerificationValues,
    pub ros: Option<CounterpointInventoryVerificationValues>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointInventoryVerificationSummary {
    pub csv_path: String,
    pub total_csv_skus: i64,
    pub exact_match_count: i64,
    pub mismatched_count: i64,
    pub comparison_artifact_count: i64,
    pub csv_source_issue_count: i64,
    pub missing_in_ros_count: i64,
    pub extra_in_ros_count: i64,
    pub matched_count: i64,
    pub name_mismatch_count: i64,
    pub identifier_like_product_name_count: i64,
    pub category_mismatch_count: i64,
    pub variant_mismatch_count: i64,
    pub ros_variant_label_missing_count: i64,
    pub price_mismatch_count: i64,
    pub cost_mismatch_count: i64,
    pub inventory_mismatch_count: i64,
    pub supplier_field_suspect_count: i64,
    pub supplier_code_non_vendor_key_count: i64,
    pub variant_group_split_count: i64,
    pub parent_sku_variant_count: i64,
    pub duplicate_variant_label_count: i64,
    pub missing_vendor_count: i64,
    pub vendor_mismatch_count: i64,
    pub missing_vendor_item_link_count: i64,
    pub extra_parent_scope_artifact_count: i64,
    pub extra_key_present_scope_gap_count: i64,
    pub extra_unexplained_count: i64,
    pub detailed_row_limit: usize,
    pub detailed_rows_truncated: i64,
    pub extra_rows_truncated: i64,
    pub expected_out_of_scope_exclusion_count: i64,
}

#[derive(Debug, Serialize)]
pub struct CounterpointInventoryVerificationReport {
    pub summary: CounterpointInventoryVerificationSummary,
    pub mismatch_rows: Vec<CounterpointInventoryVerificationRow>,
    pub extra_rows: Vec<CounterpointInventoryVerificationRow>,
    pub critical_issues: Vec<String>,
}

#[derive(Debug)]
struct CounterpointInventoryCsvNormalizedRow {
    sku: String,
    name: String,
    product_category: String,
    variant_label: String,
    item_key: String,
    supply_price: Option<Decimal>,
    retail_price: Option<Decimal>,
    inventory_quantity: Option<Decimal>,
    supplier_name: String,
    supplier_code: String,
    supplier_field_suspect: bool,
    supplier_code_non_vendor_key: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct CounterpointRosInventoryRow {
    variant_id: Uuid,
    product_id: Uuid,
    sku: String,
    counterpoint_item_key: Option<String>,
    variation_label: Option<String>,
    stock_on_hand: i32,
    retail_price: Decimal,
    supply_price: Decimal,
    product_name: String,
    catalog_handle: Option<String>,
    category_name: Option<String>,
    primary_vendor_name: Option<String>,
    primary_vendor_code: Option<String>,
}

#[derive(Debug, Clone)]
struct CounterpointRosVendorLink {
    vendor_name: Option<String>,
    vendor_code: Option<String>,
}

#[derive(Debug, Default)]
struct CounterpointCsvGroupSummary {
    matched_product_ids: BTreeSet<Uuid>,
    variant_labels: HashMap<String, usize>,
    parent_sku_variant_seen: bool,
}

fn counterpoint_inventory_csv_path() -> Option<PathBuf> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)?;
    let preferred = repo_root.join("export2026-04-22.csv");
    if preferred.exists() {
        return Some(preferred);
    }
    let fallback = repo_root.join("venv").join("export2026-04-22.csv");
    if fallback.exists() {
        return Some(fallback);
    }
    None
}

fn normalize_verify_text(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_uppercase()
}

fn trim_to_opt(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_decimal_opt(raw: &str) -> Option<Decimal> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<Decimal>().ok()
}

fn format_decimal_opt(raw: Option<Decimal>) -> Option<String> {
    raw.map(|d| d.normalize().to_string())
}

fn csv_variant_label(row: &CounterpointInventoryCsvRow) -> String {
    [
        row.variant_option_one_value.as_str(),
        row.variant_option_two_value.as_str(),
        row.variant_option_three_value.as_str(),
    ]
    .into_iter()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" / ")
}

fn csv_supplier_fields_suspect(row: &CounterpointInventoryCsvRow) -> bool {
    let supplier_name = normalize_verify_text(&row.supplier_name);
    let supplier_code = normalize_verify_text(&row.supplier_code);
    if !supplier_name.is_empty() || supplier_code.is_empty() {
        return false;
    }
    let variant_values = [
        row.variant_option_one_value.as_str(),
        row.variant_option_two_value.as_str(),
        row.variant_option_three_value.as_str(),
    ]
    .into_iter()
    .map(normalize_verify_text)
    .filter(|value| !value.is_empty())
    .collect::<HashSet<_>>();
    variant_values.contains(&supplier_code)
}

fn csv_supplier_code_not_vendor_key(row: &CounterpointInventoryCsvRow) -> bool {
    let supplier_code = normalize_verify_text(&row.supplier_code);
    if supplier_code.is_empty() {
        return false;
    }
    let variant_values = [
        row.variant_option_one_value.as_str(),
        row.variant_option_two_value.as_str(),
        row.variant_option_three_value.as_str(),
    ]
    .into_iter()
    .map(normalize_verify_text)
    .filter(|value| !value.is_empty())
    .collect::<HashSet<_>>();
    variant_values.contains(&supplier_code)
}

fn normalize_csv_inventory_row(
    row: CounterpointInventoryCsvRow,
) -> CounterpointInventoryCsvNormalizedRow {
    CounterpointInventoryCsvNormalizedRow {
        sku: row.sku.trim().to_string(),
        name: row.name.trim().to_string(),
        product_category: row.product_category.trim().to_string(),
        variant_label: csv_variant_label(&row),
        item_key: row.tags.trim().to_string(),
        supply_price: parse_decimal_opt(&row.supply_price),
        retail_price: parse_decimal_opt(&row.retail_price),
        inventory_quantity: parse_decimal_opt(&row.inventory_main_outlet),
        supplier_name: row.supplier_name.trim().to_string(),
        supplier_code: row.supplier_code.trim().to_string(),
        supplier_field_suspect: csv_supplier_fields_suspect(&row),
        supplier_code_non_vendor_key: csv_supplier_code_not_vendor_key(&row),
    }
}

fn ros_currency_matches(csv_value: Option<Decimal>, ros_value: Decimal) -> bool {
    csv_value
        .map(|value| {
            value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
                == ros_value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
        })
        .unwrap_or(true)
}

fn is_parent_row_fallback_artifact(
    csv_row: &CounterpointInventoryCsvNormalizedRow,
    ros_row: &CounterpointRosInventoryRow,
    match_basis: &str,
) -> bool {
    if match_basis != "counterpoint_item_key_singleton" && match_basis != "catalog_handle_singleton"
    {
        return false;
    }
    let normalized_sku = normalize_verify_text(&csv_row.sku);
    let normalized_key = normalize_verify_text(&csv_row.item_key);
    if !normalized_sku.starts_with("B-") || !normalized_key.starts_with("I-") {
        return false;
    }
    let ros_sku = normalize_verify_text(&ros_row.sku);
    let ros_key = ros_row
        .counterpoint_item_key
        .as_deref()
        .map(normalize_verify_text)
        .unwrap_or_default();
    let ros_handle = ros_row
        .catalog_handle
        .as_deref()
        .map(normalize_verify_text)
        .unwrap_or_default();
    ros_sku == normalized_key || ros_key == normalized_key || ros_handle == normalized_key
}

fn verify_values_from_csv(
    row: &CounterpointInventoryCsvNormalizedRow,
) -> CounterpointInventoryVerificationValues {
    CounterpointInventoryVerificationValues {
        sku: row.sku.clone(),
        name: trim_to_opt(&row.name),
        category: trim_to_opt(&row.product_category),
        variant_label: trim_to_opt(&row.variant_label),
        supply_price: format_decimal_opt(row.supply_price),
        retail_price: format_decimal_opt(row.retail_price),
        inventory_quantity: format_decimal_opt(row.inventory_quantity),
        supplier_name: trim_to_opt(&row.supplier_name),
        supplier_code: trim_to_opt(&row.supplier_code),
        item_key: trim_to_opt(&row.item_key),
        catalog_handle: None,
    }
}

fn verify_values_from_ros(
    row: &CounterpointRosInventoryRow,
    vendor_links: &[CounterpointRosVendorLink],
) -> CounterpointInventoryVerificationValues {
    let vendor_name = row.primary_vendor_name.clone().or_else(|| {
        vendor_links
            .iter()
            .find_map(|link| link.vendor_name.clone())
    });
    let vendor_code = row.primary_vendor_code.clone().or_else(|| {
        vendor_links
            .iter()
            .find_map(|link| link.vendor_code.clone())
    });

    CounterpointInventoryVerificationValues {
        sku: row.sku.clone(),
        name: trim_to_opt(&row.product_name),
        category: row.category_name.clone(),
        variant_label: row.variation_label.clone(),
        supply_price: Some(row.supply_price.normalize().to_string()),
        retail_price: Some(row.retail_price.normalize().to_string()),
        inventory_quantity: Some(Decimal::from(row.stock_on_hand).normalize().to_string()),
        supplier_name: vendor_name,
        supplier_code: vendor_code,
        item_key: row.counterpoint_item_key.clone(),
        catalog_handle: row.catalog_handle.clone(),
    }
}

fn push_detail_row_limited(
    rows: &mut Vec<CounterpointInventoryVerificationRow>,
    row: CounterpointInventoryVerificationRow,
    limit: usize,
    truncated: &mut i64,
) {
    if rows.len() < limit {
        rows.push(row);
    } else {
        *truncated += 1;
    }
}

pub async fn build_counterpoint_inventory_verification_report(
    pool: &PgPool,
) -> Result<CounterpointInventoryVerificationReport, CounterpointSyncError> {
    let csv_path = counterpoint_inventory_csv_path().ok_or_else(|| {
        CounterpointSyncError::InvalidPayload(
            "Counterpoint inventory CSV export2026-04-22.csv not found in repo root".into(),
        )
    })?;

    let ros_rows: Vec<CounterpointRosInventoryRow> = sqlx::query_as(
        r#"
        SELECT
            pv.id AS variant_id,
            pv.product_id,
            pv.sku,
            pv.counterpoint_item_key,
            pv.variation_label,
            pv.stock_on_hand,
            COALESCE(pv.retail_price_override, p.base_retail_price) AS retail_price,
            COALESCE(pv.cost_override, p.base_cost) AS supply_price,
            p.name AS product_name,
            p.catalog_handle,
            c.name AS category_name,
            v.name AS primary_vendor_name,
            v.vendor_code AS primary_vendor_code
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN vendors v ON v.id = p.primary_vendor_id
        WHERE p.data_source = 'counterpoint' OR pv.counterpoint_item_key IS NOT NULL
        ORDER BY pv.sku
        "#,
    )
    .fetch_all(pool)
    .await?;

    let vendor_link_rows: Vec<(Option<Uuid>, Option<String>, Option<String>)> = sqlx::query_as(
        r#"
        SELECT
            vsi.variant_id,
            v.name,
            v.vendor_code
        FROM vendor_supplier_item vsi
        INNER JOIN vendors v ON v.id = vsi.vendor_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut vendor_links_by_variant: HashMap<Uuid, Vec<CounterpointRosVendorLink>> = HashMap::new();
    for (variant_id, vendor_name, vendor_code) in vendor_link_rows {
        let Some(variant_id) = variant_id else {
            continue;
        };
        vendor_links_by_variant
            .entry(variant_id)
            .or_default()
            .push(CounterpointRosVendorLink {
                vendor_name,
                vendor_code,
            });
    }

    let mut ros_by_sku: HashMap<String, usize> = HashMap::new();
    let mut ros_sku_counts: HashMap<String, usize> = HashMap::new();
    let mut ros_by_counterpoint_key: HashMap<String, Vec<usize>> = HashMap::new();
    let mut ros_by_catalog_handle: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, row) in ros_rows.iter().enumerate() {
        let normalized_sku = normalize_verify_text(&row.sku);
        *ros_sku_counts.entry(normalized_sku.clone()).or_insert(0) += 1;
        ros_by_sku.insert(normalized_sku, idx);
        if let Some(key) = row.counterpoint_item_key.as_deref() {
            let normalized = normalize_verify_text(key);
            if !normalized.is_empty() {
                ros_by_counterpoint_key
                    .entry(normalized)
                    .or_default()
                    .push(idx);
            }
        }
        if let Some(handle) = row.catalog_handle.as_deref() {
            let normalized = normalize_verify_text(handle);
            if !normalized.is_empty() {
                ros_by_catalog_handle
                    .entry(normalized)
                    .or_default()
                    .push(idx);
            }
        }
    }

    let file = File::open(&csv_path).map_err(|e| {
        CounterpointSyncError::InvalidPayload(format!(
            "Could not open Counterpoint inventory CSV {}: {e}",
            csv_path.display()
        ))
    })?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(file);
    let mut csv_skus = HashSet::new();
    let mut csv_key_counts: HashMap<String, i64> = HashMap::new();
    for record in reader.deserialize::<CounterpointInventoryCsvRow>() {
        let raw = record.map_err(|e| {
            CounterpointSyncError::InvalidPayload(format!(
                "Could not parse Counterpoint inventory CSV {}: {e}",
                csv_path.display()
            ))
        })?;
        let csv_row = normalize_csv_inventory_row(raw);
        if csv_row.sku.trim().is_empty() {
            continue;
        }
        csv_skus.insert(normalize_verify_text(&csv_row.sku));
        let normalized_key = normalize_verify_text(&csv_row.item_key);
        if !normalized_key.is_empty() {
            *csv_key_counts.entry(normalized_key).or_insert(0) += 1;
        }
    }

    let file = File::open(&csv_path).map_err(|e| {
        CounterpointSyncError::InvalidPayload(format!(
            "Could not reopen Counterpoint inventory CSV {}: {e}",
            csv_path.display()
        ))
    })?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(file);

    let mut total_csv_skus = 0_i64;
    let mut exact_match_count = 0_i64;
    let mut mismatched_count = 0_i64;
    let mut comparison_artifact_count = 0_i64;
    let mut csv_source_issue_count = 0_i64;
    let mut missing_in_ros_count = 0_i64;
    let mut name_mismatch_count = 0_i64;
    let mut identifier_like_product_name_count = 0_i64;
    let mut category_mismatch_count = 0_i64;
    let mut variant_mismatch_count = 0_i64;
    let mut ros_variant_label_missing_count = 0_i64;
    let mut price_mismatch_count = 0_i64;
    let mut cost_mismatch_count = 0_i64;
    let mut inventory_mismatch_count = 0_i64;
    let mut supplier_field_suspect_count = 0_i64;
    let mut supplier_code_non_vendor_key_count = 0_i64;
    let mut missing_vendor_count = 0_i64;
    let mut vendor_mismatch_count = 0_i64;
    let mut missing_vendor_item_link_count = 0_i64;

    let mut detailed_rows_truncated = 0_i64;
    let mut extra_rows_truncated = 0_i64;
    let mut expected_out_of_scope_exclusion_count = 0_i64;
    let mut mismatch_rows = Vec::new();
    let mut matched_ros_variant_ids = HashSet::new();
    let mut csv_groups: HashMap<String, CounterpointCsvGroupSummary> = HashMap::new();

    for record in reader.deserialize::<CounterpointInventoryCsvRow>() {
        let raw = record.map_err(|e| {
            CounterpointSyncError::InvalidPayload(format!(
                "Could not parse Counterpoint inventory CSV {}: {e}",
                csv_path.display()
            ))
        })?;
        let csv_row = normalize_csv_inventory_row(raw);
        if csv_row.sku.trim().is_empty() {
            continue;
        }
        total_csv_skus += 1;
        if csv_row.supplier_field_suspect {
            supplier_field_suspect_count += 1;
        }
        if csv_row.supplier_code_non_vendor_key {
            supplier_code_non_vendor_key_count += 1;
        }

        let normalized_sku = normalize_verify_text(&csv_row.sku);
        let normalized_key = normalize_verify_text(&csv_row.item_key);
        let key_row_count = csv_key_counts.get(&normalized_key).copied().unwrap_or(0);
        let matched = if ros_sku_counts.get(&normalized_sku).copied().unwrap_or(0) == 1 {
            ros_by_sku
                .get(&normalized_sku)
                .map(|idx| (*idx, "sku".to_string()))
        } else {
            None
        }
        .or_else(|| {
            if normalized_key.is_empty() || key_row_count != 1 {
                return None;
            }
            let by_key = ros_by_counterpoint_key.get(&normalized_key);
            if let Some(rows) = by_key {
                if rows.len() == 1 {
                    return Some((rows[0], "counterpoint_item_key_singleton".to_string()));
                }
            }
            let by_handle = ros_by_catalog_handle.get(&normalized_key);
            if let Some(rows) = by_handle {
                if rows.len() == 1 {
                    return Some((rows[0], "catalog_handle_singleton".to_string()));
                }
            }
            None
        });

        let csv_values = verify_values_from_csv(&csv_row);

        let Some((matched_idx, match_basis)) = matched else {
            let ros_candidate = if !normalized_key.is_empty() && key_row_count > 1 {
                ros_by_counterpoint_key
                    .get(&normalized_key)
                    .and_then(|rows| rows.first())
                    .or_else(|| {
                        ros_by_catalog_handle
                            .get(&normalized_key)
                            .and_then(|rows| rows.first())
                    })
                    .map(|idx| &ros_rows[*idx])
            } else {
                None
            };
            if let Some(ros_row) = ros_candidate {
                comparison_artifact_count += 1;
                push_detail_row_limited(
                    &mut mismatch_rows,
                    CounterpointInventoryVerificationRow {
                        sku: csv_row.sku.clone(),
                        match_basis: Some("variant_group_scope".into()),
                        status: "comparison_artifact".into(),
                        mismatch_types: vec!["multi_row_item_key_group".into()],
                        csv: csv_values,
                        ros: Some(verify_values_from_ros(
                            ros_row,
                            &vendor_links_by_variant
                                .get(&ros_row.variant_id)
                                .cloned()
                                .unwrap_or_default(),
                        )),
                    },
                    COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                    &mut detailed_rows_truncated,
                );
                continue;
            }
            let is_expected_scope_exclusion = normalized_sku.starts_with("B-")
                && normalized_key.starts_with("I-")
                && !ros_by_counterpoint_key.contains_key(&normalized_key)
                && !ros_by_catalog_handle.contains_key(&normalized_key);
            if is_expected_scope_exclusion {
                expected_out_of_scope_exclusion_count += 1;
            }
            missing_in_ros_count += 1;
            push_detail_row_limited(
                &mut mismatch_rows,
                CounterpointInventoryVerificationRow {
                    sku: csv_row.sku.clone(),
                    match_basis: None,
                    status: if is_expected_scope_exclusion {
                        "expected_out_of_scope_exclusion".into()
                    } else {
                        "missing_in_ros".into()
                    },
                    mismatch_types: vec![if is_expected_scope_exclusion {
                        "expected_out_of_scope_exclusion".into()
                    } else {
                        "missing_in_ros".into()
                    }],
                    csv: csv_values,
                    ros: None,
                },
                COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                &mut detailed_rows_truncated,
            );
            continue;
        };

        let ros_row = &ros_rows[matched_idx];
        if is_parent_row_fallback_artifact(&csv_row, ros_row, &match_basis) {
            comparison_artifact_count += 1;
            push_detail_row_limited(
                &mut mismatch_rows,
                CounterpointInventoryVerificationRow {
                    sku: csv_row.sku.clone(),
                    match_basis: Some(match_basis),
                    status: "comparison_artifact".into(),
                    mismatch_types: vec!["parent_row_fallback".into()],
                    csv: csv_values,
                    ros: Some(verify_values_from_ros(
                        ros_row,
                        &vendor_links_by_variant
                            .get(&ros_row.variant_id)
                            .cloned()
                            .unwrap_or_default(),
                    )),
                },
                COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                &mut detailed_rows_truncated,
            );
            continue;
        }
        matched_ros_variant_ids.insert(ros_row.variant_id);
        let vendor_links = vendor_links_by_variant
            .get(&ros_row.variant_id)
            .cloned()
            .unwrap_or_default();

        let group_key = if normalized_key.is_empty() {
            normalize_verify_text(&csv_row.name)
        } else {
            normalized_key.clone()
        };
        let group_entry = csv_groups.entry(group_key).or_default();
        group_entry.matched_product_ids.insert(ros_row.product_id);
        let normalized_variant_label = normalize_verify_text(&csv_row.variant_label);
        if !normalized_variant_label.is_empty() {
            *group_entry
                .variant_labels
                .entry(normalized_variant_label)
                .or_insert(0) += 1;
        }
        let ros_catalog_handle = ros_row
            .catalog_handle
            .as_deref()
            .map(normalize_verify_text)
            .unwrap_or_default();
        if !ros_catalog_handle.is_empty()
            && normalize_verify_text(&ros_row.sku) == ros_catalog_handle
            && !normalized_key.is_empty()
            && ros_catalog_handle != normalized_key
        {
            group_entry.parent_sku_variant_seen = true;
        }

        let mut mismatch_types = Vec::new();
        if normalize_verify_text(&csv_row.name) != normalize_verify_text(&ros_row.product_name) {
            mismatch_types.push("name_mismatch".into());
            name_mismatch_count += 1;
        }
        let product_name_identifiers = [
            ros_row.sku.clone(),
            ros_row.counterpoint_item_key.clone().unwrap_or_default(),
            ros_row.catalog_handle.clone().unwrap_or_default(),
            csv_row.item_key.clone(),
        ]
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
        if counterpoint_product_name_is_identifier_like(
            &ros_row.product_name,
            &product_name_identifiers,
        ) {
            mismatch_types.push("identifier_like_product_name".into());
            identifier_like_product_name_count += 1;
        }
        let ros_category = ros_row.category_name.as_deref().unwrap_or("");
        if normalize_verify_text(&csv_row.product_category) != normalize_verify_text(ros_category) {
            mismatch_types.push("category_mismatch".into());
            category_mismatch_count += 1;
        }
        let ros_variant_label = ros_row.variation_label.as_deref().unwrap_or("");
        let normalized_csv_variant_label = normalize_verify_text(&csv_row.variant_label);
        let normalized_ros_variant_label = normalize_verify_text(ros_variant_label);
        if !normalized_csv_variant_label.is_empty() && normalized_ros_variant_label.is_empty() {
            mismatch_types.push("ros_variant_label_missing".into());
            ros_variant_label_missing_count += 1;
        } else if !normalized_csv_variant_label.is_empty()
            && !normalized_ros_variant_label.is_empty()
            && normalized_csv_variant_label != normalized_ros_variant_label
        {
            mismatch_types.push("variant_mismatch".into());
            variant_mismatch_count += 1;
        }
        if !ros_currency_matches(csv_row.retail_price, ros_row.retail_price) {
            mismatch_types.push("price_mismatch".into());
            price_mismatch_count += 1;
        }
        if !ros_currency_matches(csv_row.supply_price, ros_row.supply_price) {
            mismatch_types.push("cost_mismatch".into());
            cost_mismatch_count += 1;
        }
        if csv_row
            .inventory_quantity
            .map(|quantity| {
                quantity.normalize() != Decimal::from(ros_row.stock_on_hand).normalize()
            })
            .unwrap_or(false)
        {
            mismatch_types.push("inventory_mismatch".into());
            inventory_mismatch_count += 1;
        }
        let source_issue_only = csv_row.supplier_field_suspect;
        if !csv_row.supplier_field_suspect {
            let csv_supplier_name = normalize_verify_text(&csv_row.supplier_name);
            if !csv_supplier_name.is_empty() {
                let primary_vendor_match = csv_supplier_name
                    == normalize_verify_text(ros_row.primary_vendor_name.as_deref().unwrap_or(""));
                let linked_vendor_match = vendor_links.iter().any(|link| {
                    csv_supplier_name
                        == normalize_verify_text(link.vendor_name.as_deref().unwrap_or(""))
                });

                if !primary_vendor_match && !linked_vendor_match {
                    if ros_row.primary_vendor_name.is_none()
                        && ros_row.primary_vendor_code.is_none()
                        && vendor_links.is_empty()
                    {
                        mismatch_types.push("missing_vendor".into());
                        missing_vendor_count += 1;
                    } else {
                        mismatch_types.push("vendor_mismatch".into());
                        vendor_mismatch_count += 1;
                    }
                }
            }
            if vendor_links.is_empty() && !csv_supplier_name.is_empty() {
                mismatch_types.push("missing_vendor_item_link".into());
                missing_vendor_item_link_count += 1;
            }
        }

        if mismatch_types.is_empty() {
            if source_issue_only {
                csv_source_issue_count += 1;
                push_detail_row_limited(
                    &mut mismatch_rows,
                    CounterpointInventoryVerificationRow {
                        sku: csv_row.sku.clone(),
                        match_basis: Some(match_basis),
                        status: "csv_source_issue".into(),
                        mismatch_types: vec!["supplier_field_suspect".into()],
                        csv: csv_values,
                        ros: Some(verify_values_from_ros(ros_row, &vendor_links)),
                    },
                    COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                    &mut detailed_rows_truncated,
                );
            } else {
                exact_match_count += 1;
            }
        } else {
            mismatched_count += 1;
            push_detail_row_limited(
                &mut mismatch_rows,
                CounterpointInventoryVerificationRow {
                    sku: csv_row.sku.clone(),
                    match_basis: Some(match_basis),
                    status: "mismatch".into(),
                    mismatch_types,
                    csv: csv_values,
                    ros: Some(verify_values_from_ros(ros_row, &vendor_links)),
                },
                COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                &mut detailed_rows_truncated,
            );
        }
    }

    let mut variant_group_split_count = 0_i64;
    let mut parent_sku_variant_count = 0_i64;
    let mut duplicate_variant_label_count = 0_i64;
    let mut extra_parent_scope_artifact_count = 0_i64;
    let mut extra_key_present_scope_gap_count = 0_i64;
    let mut extra_unexplained_count = 0_i64;
    let mut critical_issues = Vec::new();

    for (group_key, summary) in &csv_groups {
        if summary.matched_product_ids.len() > 1 {
            variant_group_split_count += 1;
            critical_issues.push(format!(
                "Variant group {group_key} lands under {} ROS products instead of one.",
                summary.matched_product_ids.len()
            ));
        }
        let duplicate_labels = summary
            .variant_labels
            .iter()
            .filter(|(_, count)| **count > 1)
            .count() as i64;
        if duplicate_labels > 0 {
            duplicate_variant_label_count += duplicate_labels;
        }
        if summary.parent_sku_variant_seen {
            parent_sku_variant_count += 1;
            critical_issues.push(format!(
                "Variant group {group_key} includes a ROS variant whose SKU matches the product handle, which can indicate a parent SKU treated as a sellable variant."
            ));
        }
    }

    let mut extra_rows = Vec::new();
    for ros_row in &ros_rows {
        if matched_ros_variant_ids.contains(&ros_row.variant_id) {
            continue;
        }
        let normalized_sku = normalize_verify_text(&ros_row.sku);
        let normalized_key = ros_row
            .counterpoint_item_key
            .as_deref()
            .map(normalize_verify_text)
            .filter(|value| !value.is_empty());
        let normalized_handle = ros_row
            .catalog_handle
            .as_deref()
            .map(normalize_verify_text)
            .filter(|value| !value.is_empty());
        let extra_status = if let Some(key) = normalized_key.as_deref() {
            let key_count = csv_key_counts.get(key).copied().unwrap_or(0);
            if normalized_sku == key || normalized_handle.as_deref() == Some(key) {
                extra_parent_scope_artifact_count += 1;
                "extra_parent_scope_artifact"
            } else if key_count > 0 {
                extra_key_present_scope_gap_count += 1;
                "extra_key_present_scope_gap"
            } else {
                extra_unexplained_count += 1;
                "extra_unexplained"
            }
        } else if csv_skus.contains(&normalized_sku) {
            extra_key_present_scope_gap_count += 1;
            "extra_key_present_scope_gap"
        } else {
            extra_unexplained_count += 1;
            "extra_unexplained"
        };
        push_detail_row_limited(
            &mut extra_rows,
            CounterpointInventoryVerificationRow {
                sku: ros_row.sku.clone(),
                match_basis: None,
                status: extra_status.into(),
                mismatch_types: vec![extra_status.into()],
                csv: CounterpointInventoryVerificationValues {
                    sku: ros_row.sku.clone(),
                    name: None,
                    category: None,
                    variant_label: None,
                    supply_price: None,
                    retail_price: None,
                    inventory_quantity: None,
                    supplier_name: None,
                    supplier_code: None,
                    item_key: None,
                    catalog_handle: None,
                },
                ros: Some(verify_values_from_ros(
                    ros_row,
                    &vendor_links_by_variant
                        .get(&ros_row.variant_id)
                        .cloned()
                        .unwrap_or_default(),
                )),
            },
            COUNTERPOINT_INVENTORY_VERIFY_MAX_EXTRA_ROWS,
            &mut extra_rows_truncated,
        );
    }

    if missing_in_ros_count > 0 {
        if expected_out_of_scope_exclusion_count > 0 {
            critical_issues.push(format!(
                "{expected_out_of_scope_exclusion_count} CSV SKU(s) are expected out-of-scope exclusions under the active catalog/inventory import rules."
            ));
        }
        let unexplained_missing = missing_in_ros_count - expected_out_of_scope_exclusion_count;
        if unexplained_missing > 0 {
            critical_issues.push(format!(
                "{unexplained_missing} CSV SKU(s) are missing in ROS without an obvious active-scope exclusion explanation."
            ));
        }
    }
    let extra_in_ros_count = (ros_rows.len() - matched_ros_variant_ids.len()) as i64;
    if extra_unexplained_count > 0 {
        critical_issues.push(format!(
            "{extra_unexplained_count} Counterpoint-linked ROS variant(s) are unexplained extras with no matching CSV SKU or parent product key."
        ));
    }
    if supplier_field_suspect_count > 0 {
        critical_issues.push(format!(
            "{supplier_field_suspect_count} CSV row(s) have supplier fields that appear misaligned or blank."
        ));
    }
    if missing_vendor_item_link_count > 0 {
        critical_issues.push(format!(
            "{missing_vendor_item_link_count} matched SKU row(s) have no ROS vendor item linkage."
        ));
    }
    if identifier_like_product_name_count > 0 {
        critical_issues.push(format!(
            "{identifier_like_product_name_count} matched SKU row(s) have a ROS product name that looks like a Counterpoint item number, SKU, or barcode."
        ));
    }

    Ok(CounterpointInventoryVerificationReport {
        summary: CounterpointInventoryVerificationSummary {
            csv_path: csv_path.display().to_string(),
            total_csv_skus,
            exact_match_count,
            mismatched_count,
            comparison_artifact_count,
            csv_source_issue_count,
            missing_in_ros_count,
            extra_in_ros_count,
            matched_count: exact_match_count + mismatched_count + csv_source_issue_count,
            name_mismatch_count,
            identifier_like_product_name_count,
            category_mismatch_count,
            variant_mismatch_count,
            ros_variant_label_missing_count,
            price_mismatch_count,
            cost_mismatch_count,
            inventory_mismatch_count,
            supplier_field_suspect_count,
            supplier_code_non_vendor_key_count,
            variant_group_split_count,
            parent_sku_variant_count,
            duplicate_variant_label_count,
            missing_vendor_count,
            vendor_mismatch_count,
            missing_vendor_item_link_count,
            extra_parent_scope_artifact_count,
            extra_key_present_scope_gap_count,
            extra_unexplained_count,
            detailed_row_limit: COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
            detailed_rows_truncated,
            extra_rows_truncated,
            expected_out_of_scope_exclusion_count,
        },
        mismatch_rows,
        extra_rows,
        critical_issues,
    })
}

#[derive(Debug, Default)]
struct CounterpointBaselineResetTargets {
    counterpoint_customer_ids: Vec<Uuid>,
    counterpoint_product_ids: Vec<Uuid>,
    counterpoint_variant_ids: Vec<Uuid>,
    vendor_ids: Vec<Uuid>,
    gift_card_ids: Vec<Uuid>,
    loyalty_reward_issuance_ids: Vec<Uuid>,
    loyalty_point_ledger_ids: Vec<Uuid>,
    store_credit_account_ids: Vec<Uuid>,
    counterpoint_only_staff_ids: Vec<Uuid>,
    counterpoint_transaction_ids: Vec<Uuid>,
    counterpoint_sync_run_ids: Vec<i64>,
    counterpoint_sync_issue_ids: Vec<i64>,
    counterpoint_sync_request_ids: Vec<i64>,
    counterpoint_staging_batch_ids: Vec<i64>,
    counterpoint_receiving_history_ids: Vec<Uuid>,
    counterpoint_staff_map_staff_ids: Vec<Uuid>,
    counterpoint_category_map_ids: Vec<i64>,
    counterpoint_import_run_ids: Vec<Uuid>,
    counterpoint_import_exception_ids: Vec<Uuid>,
}

async fn collect_counterpoint_baseline_reset_targets(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<CounterpointBaselineResetTargets, CounterpointSyncError> {
    let counterpoint_customer_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM customers WHERE customer_created_source = 'counterpoint'",
    )
    .fetch_all(&mut **tx)
    .await?;

    let counterpoint_product_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM products WHERE data_source = 'counterpoint'")
            .fetch_all(&mut **tx)
            .await?;

    let counterpoint_variant_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT pv.id
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE p.data_source = 'counterpoint'
        "#,
    )
    .fetch_all(&mut **tx)
    .await?;

    let vendor_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM vendors")
        .fetch_all(&mut **tx)
        .await?;

    let gift_card_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM gift_cards")
        .fetch_all(&mut **tx)
        .await?;

    let loyalty_reward_issuance_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM loyalty_reward_issuances")
            .fetch_all(&mut **tx)
            .await?;

    let loyalty_point_ledger_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM loyalty_point_ledger")
            .fetch_all(&mut **tx)
            .await?;

    let store_credit_account_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM store_credit_accounts")
            .fetch_all(&mut **tx)
            .await?;

    let counterpoint_only_staff_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM staff WHERE data_source = 'counterpoint' AND pin_hash IS NULL",
    )
    .fetch_all(&mut **tx)
    .await?;

    let counterpoint_transaction_ids: Vec<Uuid> = if counterpoint_customer_ids.is_empty() {
        sqlx::query_scalar("SELECT id FROM transactions WHERE is_counterpoint_import")
            .fetch_all(&mut **tx)
            .await?
    } else {
        sqlx::query_scalar(
            "SELECT id FROM transactions WHERE is_counterpoint_import OR customer_id = ANY($1)",
        )
        .bind(&counterpoint_customer_ids)
        .fetch_all(&mut **tx)
        .await?
    };

    Ok(CounterpointBaselineResetTargets {
        counterpoint_customer_ids,
        counterpoint_product_ids,
        counterpoint_variant_ids,
        vendor_ids,
        gift_card_ids,
        loyalty_reward_issuance_ids,
        loyalty_point_ledger_ids,
        store_credit_account_ids,
        counterpoint_only_staff_ids,
        counterpoint_transaction_ids,
        counterpoint_sync_run_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_runs")
            .fetch_all(&mut **tx)
            .await?,
        counterpoint_sync_issue_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_issue")
            .fetch_all(&mut **tx)
            .await?,
        counterpoint_sync_request_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_sync_request",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_staging_batch_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_staging_batch",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_receiving_history_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_receiving_history",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_staff_map_staff_ids: sqlx::query_scalar(
            "SELECT ros_staff_id FROM counterpoint_staff_map",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_category_map_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_category_map",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_import_run_ids: sqlx::query_scalar("SELECT id FROM counterpoint_import_runs")
            .fetch_all(&mut **tx)
            .await?,
        counterpoint_import_exception_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_import_exceptions",
        )
        .fetch_all(&mut **tx)
        .await?,
    })
}

pub async fn execute_counterpoint_baseline_reset(
    pool: &PgPool,
) -> Result<CounterpointResetResult, CounterpointSyncError> {
    let preview_scope = build_counterpoint_reset_scope(pool).await?;
    let mut tx = pool.begin().await?;
    let targets = collect_counterpoint_baseline_reset_targets(&mut tx).await?;
    perform_counterpoint_baseline_reset_targets(&mut tx, &targets).await?;
    tx.commit().await?;

    Ok(CounterpointResetResult {
        confirmation_phrase: COUNTERPOINT_BASELINE_RESET_CONFIRMATION.into(),
        reset_scope: preview_scope,
        preserve_always: counterpoint_reset_preserve_always(),
        bridge_local_state_note: "Bridge-local cursor files are not changed automatically. If you want a true full replay from the Counterpoint PC, reset or remove .counterpoint-bridge-state.json before the next import.".into(),
    })
}

async fn perform_counterpoint_baseline_reset_targets(
    tx: &mut Transaction<'_, Postgres>,
    targets: &CounterpointBaselineResetTargets,
) -> Result<(), CounterpointSyncError> {
    if !targets.counterpoint_transaction_ids.is_empty() {
        sqlx::query(
            r#"
            DELETE FROM payment_transactions pt
            WHERE EXISTS (
                SELECT 1
                FROM payment_allocations pa
                WHERE pa.transaction_id = pt.id
                  AND pa.target_transaction_id = ANY($1)
            )
            "#,
        )
        .bind(&targets.counterpoint_transaction_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&targets.counterpoint_transaction_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_customer_ids.is_empty() {
        sqlx::query(
            "UPDATE staff SET employee_customer_id = NULL WHERE employee_customer_id = ANY($1)",
        )
        .bind(&targets.counterpoint_customer_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "UPDATE customers SET couple_primary_id = NULL WHERE couple_primary_id = ANY($1)",
        )
        .bind(&targets.counterpoint_customer_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM payment_transactions WHERE payer_id = ANY($1)")
            .bind(&targets.counterpoint_customer_ids)
            .execute(&mut **tx)
            .await?;

        sqlx::query("DELETE FROM customers WHERE id = ANY($1)")
            .bind(&targets.counterpoint_customer_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.gift_card_ids.is_empty() {
        sqlx::query(
            "UPDATE loyalty_reward_issuances SET remainder_card_id = NULL WHERE remainder_card_id = ANY($1)",
        )
        .bind(&targets.gift_card_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM gift_cards WHERE id = ANY($1)")
            .bind(&targets.gift_card_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.loyalty_reward_issuance_ids.is_empty() {
        sqlx::query("DELETE FROM loyalty_reward_issuances WHERE id = ANY($1)")
            .bind(&targets.loyalty_reward_issuance_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.loyalty_point_ledger_ids.is_empty() {
        sqlx::query("DELETE FROM loyalty_point_ledger WHERE id = ANY($1)")
            .bind(&targets.loyalty_point_ledger_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.store_credit_account_ids.is_empty() {
        sqlx::query("DELETE FROM store_credit_accounts WHERE id = ANY($1)")
            .bind(&targets.store_credit_account_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_variant_ids.is_empty() {
        sqlx::query("DELETE FROM discount_event_usage WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM inventory_count_scan_stream WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM inventory_transactions WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM physical_inventory_audit WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM physical_inventory_counts WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM physical_inventory_snapshots WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM purchase_order_lines WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "UPDATE wedding_members SET suit_variant_id = NULL WHERE suit_variant_id = ANY($1)",
        )
        .bind(&targets.counterpoint_variant_ids)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE wedding_parties SET suit_variant_id = NULL WHERE suit_variant_id = ANY($1)",
        )
        .bind(&targets.counterpoint_variant_ids)
        .execute(&mut **tx)
        .await?;
    }

    if !targets.counterpoint_product_ids.is_empty() || !targets.counterpoint_variant_ids.is_empty()
    {
        sqlx::query(
            r#"
            DELETE FROM suit_component_swap_events
            WHERE old_variant_id = ANY($1)
               OR new_variant_id = ANY($1)
               OR old_product_id = ANY($2)
               OR new_product_id = ANY($2)
            "#,
        )
        .bind(&targets.counterpoint_variant_ids)
        .bind(&targets.counterpoint_product_ids)
        .execute(&mut **tx)
        .await?;
    }

    if !targets.counterpoint_receiving_history_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_receiving_history WHERE id = ANY($1)")
            .bind(&targets.counterpoint_receiving_history_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_product_ids.is_empty() {
        sqlx::query("DELETE FROM products WHERE id = ANY($1)")
            .bind(&targets.counterpoint_product_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.vendor_ids.is_empty() {
        sqlx::query(
            "DELETE FROM purchase_order_lines WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1))",
        )
        .bind(&targets.vendor_ids)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM receiving_events WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1))")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM purchase_orders WHERE vendor_id = ANY($1)")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM vendor_supplier_item WHERE vendor_id = ANY($1)")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "UPDATE products SET primary_vendor_id = NULL WHERE primary_vendor_id = ANY($1)",
        )
        .bind(&targets.vendor_ids)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM vendors WHERE id = ANY($1)")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_staging_batch_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_staging_batch WHERE id = ANY($1)")
            .bind(&targets.counterpoint_staging_batch_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_sync_request_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_sync_request WHERE id = ANY($1)")
            .bind(&targets.counterpoint_sync_request_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_sync_issue_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_sync_issue WHERE id = ANY($1)")
            .bind(&targets.counterpoint_sync_issue_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_sync_run_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_sync_runs WHERE id = ANY($1)")
            .bind(&targets.counterpoint_sync_run_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_import_exception_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_import_exceptions WHERE id = ANY($1)")
            .bind(&targets.counterpoint_import_exception_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_import_run_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_import_runs WHERE id = ANY($1)")
            .bind(&targets.counterpoint_import_run_ids)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query(
        r#"
        UPDATE store_settings
        SET counterpoint_config = COALESCE(counterpoint_config, '{}'::jsonb)
            - 'import_first_active_run_id'
            - 'import_first_preflight'
        WHERE id = 1
        "#,
    )
    .execute(&mut **tx)
    .await?;
    if !targets.counterpoint_staff_map_staff_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_staff_map WHERE ros_staff_id = ANY($1)")
            .bind(&targets.counterpoint_staff_map_staff_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_category_map_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_category_map WHERE id = ANY($1)")
            .bind(&targets.counterpoint_category_map_ids)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query(
        r#"
        UPDATE counterpoint_bridge_heartbeat
        SET last_seen_at = NOW(),
            bridge_phase = 'idle',
            current_entity = NULL,
            bridge_version = NULL,
            bridge_hostname = NULL,
            updated_at = NOW()
        WHERE id = 1
        "#,
    )
    .execute(&mut **tx)
    .await?;

    if !targets.counterpoint_only_staff_ids.is_empty() {
        sqlx::query("DELETE FROM staff WHERE id = ANY($1)")
            .bind(&targets.counterpoint_only_staff_ids)
            .execute(&mut **tx)
            .await?;
    }

    sqlx::query(
        r#"
        UPDATE staff
        SET counterpoint_user_id = NULL,
            counterpoint_sls_rep = NULL,
            data_source = CASE
                WHEN pin_hash IS NOT NULL AND data_source = 'counterpoint' THEN NULL
                ELSE data_source
            END
        WHERE counterpoint_user_id IS NOT NULL
           OR counterpoint_sls_rep IS NOT NULL
            OR (pin_hash IS NOT NULL AND data_source = 'counterpoint')
        "#,
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Sync request queue
// ────────────────────────────────────────────────────────────────────────────

pub async fn create_sync_request(
    pool: &PgPool,
    staff_id: Option<Uuid>,
    entity: Option<&str>,
) -> Result<i64, sqlx::Error> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO counterpoint_sync_request (requested_by, entity) VALUES ($1, $2) RETURNING id",
    )
    .bind(staff_id)
    .bind(entity)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn ack_sync_request(pool: &PgPool, request_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE counterpoint_sync_request SET acked_at = NOW() WHERE id = $1")
        .bind(request_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn complete_sync_request(
    pool: &PgPool,
    request_id: i64,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE counterpoint_sync_request SET completed_at = NOW(), error_message = $2 WHERE id = $1",
    )
    .bind(request_id)
    .bind(error)
    .execute(pool)
    .await?;

    if error.is_none() {
        if let Err(e) = resolve_unresolved_counterpoint_lines(pool).await {
            tracing::error!("Error running post-sync Counterpoint line resolution: {e}");
        }
    }

    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Sync issues
// ────────────────────────────────────────────────────────────────────────────

async fn record_sync_issue(
    pool: &PgPool,
    entity: &str,
    external_key: Option<&str>,
    severity: &str,
    message: &str,
) {
    let updated = sqlx::query(
        r#"
        UPDATE counterpoint_sync_issue
        SET severity = $3, created_at = NOW()
        WHERE id = (
            SELECT id
            FROM counterpoint_sync_issue
            WHERE entity = $1
              AND external_key IS NOT DISTINCT FROM $2
              AND message = $4
              AND NOT resolved
            ORDER BY created_at DESC
            LIMIT 1
        )
        "#,
    )
    .bind(entity)
    .bind(external_key)
    .bind(severity)
    .bind(message)
    .execute(pool)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);

    if updated == 0 {
        let _ = sqlx::query(
            "INSERT INTO counterpoint_sync_issue (entity, external_key, severity, message) VALUES ($1, $2, $3, $4)",
        )
        .bind(entity)
        .bind(external_key)
        .bind(severity)
        .bind(message)
        .execute(pool)
        .await;
    }
}

async fn resolve_sync_issue_by_key(pool: &PgPool, entity: &str, external_key: &str) {
    let _ = sqlx::query(
        r#"
        UPDATE counterpoint_sync_issue
        SET resolved = TRUE, resolved_at = NOW()
        WHERE entity = $1 AND external_key = $2 AND NOT resolved
        "#,
    )
    .bind(entity)
    .bind(external_key)
    .execute(pool)
    .await;
}

pub async fn resolve_sync_issue(pool: &PgPool, issue_id: i64) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        "UPDATE counterpoint_sync_issue SET resolved = TRUE, resolved_at = NOW() WHERE id = $1 AND NOT resolved",
    )
    .bind(issue_id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

// ────────────────────────────────────────────────────────────────────────────
// Category masters (IM_CATEG / IM_SUBCAT + IM_ITEM distinct keys → categories + counterpoint_category_map)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointCategoryMasterRow {
    /// Same string the bridge sends as `category` / `categ_cod` on catalog rows (CATEG + optional SUBCATEG).
    pub cp_category: String,
    /// Human-readable name; when absent, server uses `cp_category`.
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCategoryMastersPayload {
    pub rows: Vec<CounterpointCategoryMasterRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CategoryMasterSummary {
    pub categories_created: i32,
    pub maps_upserted: i32,
    pub skipped: i32,
    pub already_mapped: i32,
}

async fn get_or_create_category_id_for_cp(
    tx: &mut Transaction<'_, Postgres>,
    display_label: &str,
    summary: &mut CategoryMasterSummary,
) -> Result<Uuid, sqlx::Error> {
    let label = display_label.trim();
    if let Some(id) =
        sqlx::query_scalar("SELECT id FROM categories WHERE lower(trim(name)) = lower(trim($1))")
            .bind(label)
            .fetch_optional(&mut **tx)
            .await?
    {
        return Ok(id);
    }

    if let Some(id) = sqlx::query_scalar(
        r#"
        INSERT INTO categories (name)
        VALUES ($1)
        ON CONFLICT (name) DO NOTHING
        RETURNING id
        "#,
    )
    .bind(label)
    .fetch_optional(&mut **tx)
    .await?
    {
        summary.categories_created += 1;
        return Ok(id);
    }

    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM categories WHERE lower(trim(name)) = lower(trim($1))")
            .bind(label)
            .fetch_one(&mut **tx)
            .await?;
    Ok(id)
}

/// Upserts `categories` + `counterpoint_category_map`. Skips rows that already have a non-null `ros_category_id`
/// so manual Settings mappings are not overwritten.
pub async fn execute_counterpoint_category_masters_batch(
    pool: &PgPool,
    payload: CounterpointCategoryMastersPayload,
) -> Result<CategoryMasterSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = CategoryMasterSummary {
        categories_created: 0,
        maps_upserted: 0,
        skipped: 0,
        already_mapped: 0,
    };

    for row in &payload.rows {
        let cp = row.cp_category.trim();
        if cp.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let has_mapped: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM counterpoint_category_map WHERE cp_category = $1 AND ros_category_id IS NOT NULL)",
        )
        .bind(cp)
        .fetch_one(&mut *tx)
        .await?;

        if has_mapped {
            summary.already_mapped += 1;
            continue;
        }

        let label_src = trim_opt(&row.display_name).unwrap_or_else(|| cp.to_string());
        let label = clamp_chars(&label_src, 500);

        let cat_id = get_or_create_category_id_for_cp(&mut tx, &label, &mut summary).await?;

        sqlx::query(
            r#"
            INSERT INTO counterpoint_category_map (cp_category, ros_category_id)
            VALUES ($1, $2)
            ON CONFLICT (cp_category) DO UPDATE SET
                ros_category_id = COALESCE(counterpoint_category_map.ros_category_id, EXCLUDED.ros_category_id)
            "#,
        )
        .bind(cp)
        .bind(cat_id)
        .execute(&mut *tx)
        .await?;
        summary.maps_upserted += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "category_masters" {
            let _ = record_sync_run(
                pool,
                "category_masters",
                s.cursor.as_deref(),
                true,
                Some(summary.categories_created + summary.maps_upserted + summary.skipped),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Catalog upsert (IM_ITEM + IM_INV_CELL → products + product_variants)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CounterpointCatalogRow {
    pub item_no: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Counterpoint `LONG_DESCR` → `products.description`.
    #[serde(default)]
    pub long_description: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// Counterpoint `VEND_NO` — resolved to `vendors.id` via `vendor_code`.
    #[serde(default)]
    pub vendor_no: Option<String>,
    #[serde(default)]
    pub retail_price: Option<Decimal>,
    /// Counterpoint `IM_PRC.PRC_2` / `PRC_3` (optional reference; ROS employee sale price is cost-plus).
    #[serde(default)]
    pub prc_2: Option<Decimal>,
    #[serde(default)]
    pub prc_3: Option<Decimal>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
    #[serde(default)]
    pub is_grid: Option<bool>,
    #[serde(default)]
    pub variation_axes: Option<Vec<String>>,
    #[serde(default)]
    pub barcode: Option<String>,
    /// Grid cells: each is a variant row nested under the parent item.
    #[serde(default)]
    pub cells: Vec<CatalogCellRow>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CatalogCellRow {
    pub counterpoint_item_key: String,
    pub sku: String,
    #[serde(default)]
    pub barcode: Option<String>,
    #[serde(default)]
    pub variation_label: Option<String>,
    #[serde(default)]
    pub variation_values: Option<serde_json::Value>,
    #[serde(default)]
    pub stock_on_hand: Option<i32>,
    /// Counterpoint `MIN_QTY` → `product_variants.reorder_point`.
    #[serde(default)]
    pub reorder_point: Option<i32>,
    #[serde(default)]
    pub retail_price: Option<Decimal>,
    #[serde(default)]
    pub prc_2: Option<Decimal>,
    #[serde(default)]
    pub prc_3: Option<Decimal>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CounterpointCatalogPayload {
    pub rows: Vec<CounterpointCatalogRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CatalogUpsertSummary {
    pub products_created: i32,
    pub products_updated: i32,
    pub variants_created: i32,
    pub variants_updated: i32,
    pub skipped: i32,
    pub name_quality_warnings: i32,
    pub quarantined: i32,
}

pub fn validate_counterpoint_catalog_identity_preflight(
    payload: &CounterpointCatalogPayload,
) -> Result<CounterpointIdentityPreflightReport, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut rows = Vec::new();
    for (row_idx, row) in payload.rows.iter().enumerate() {
        let item_no = normalize_identity_key(&row.item_no);
        let is_grid = row.is_grid.unwrap_or(!row.cells.is_empty());
        if !is_grid || row.cells.is_empty() {
            let sku = trim_opt(&row.barcode).unwrap_or_else(|| row.item_no.trim().to_string());
            rows.push(CounterpointIdentityPreflightRow {
                reference: CounterpointIdentityPreflightReference {
                    row_number: row_idx + 1,
                    cell_number: None,
                },
                normalized_sku: normalize_identity_key(&sku),
                counterpoint_item_key: item_no.clone(),
                family_key: item_no.clone(),
                option_values: Vec::new(),
            });
            continue;
        }

        for (cell_idx, cell) in row.cells.iter().enumerate() {
            let counterpoint_item_key = normalize_identity_key(&cell.counterpoint_item_key);
            let mut option_values =
                option_values_from_variation_values(cell.variation_values.as_ref());
            if option_values.is_empty() {
                option_values = option_values_from_variation_label(cell.variation_label.as_deref());
            }
            if option_values.is_empty() {
                option_values =
                    option_values_from_counterpoint_item_key(counterpoint_item_key.as_deref());
            }
            rows.push(CounterpointIdentityPreflightRow {
                reference: CounterpointIdentityPreflightReference {
                    row_number: row_idx + 1,
                    cell_number: Some(cell_idx + 1),
                },
                normalized_sku: normalize_identity_key(&cell.sku),
                family_key: item_no.clone(),
                counterpoint_item_key,
                option_values,
            });
        }
    }

    Ok(build_counterpoint_identity_preflight_report(
        "catalog",
        payload.rows.len(),
        rows,
    ))
}

fn build_catalog_quarantine_records(
    payload: &CounterpointCatalogPayload,
    report: &CounterpointIdentityPreflightReport,
) -> Vec<CounterpointIngestQuarantineRecord> {
    let mut records = Vec::new();
    for issue in report.issues.iter().filter(|issue| issue.should_quarantine) {
        for reference in &issue.all_references {
            let Some(row) = payload.rows.get(reference.row_number.saturating_sub(1)) else {
                continue;
            };
            let (normalized_sku, counterpoint_item_key, family_key, option_values, source_row) =
                catalog_quarantine_record_fields(row, reference.cell_number);
            records.push(CounterpointIngestQuarantineRecord {
                ingest_type: "catalog",
                issue_type: issue.issue_type.clone(),
                severity: issue.severity.clone(),
                message: issue.message.clone(),
                normalized_sku,
                counterpoint_item_key,
                family_key,
                option_values,
                source_reference: reference_json(reference),
                source_row,
            });
        }
    }
    records
}

fn filter_catalog_payload_for_quarantine(
    payload: CounterpointCatalogPayload,
) -> Result<CounterpointCatalogQuarantineFilter, CounterpointSyncError> {
    let report = validate_counterpoint_catalog_identity_preflight(&payload)?;
    let records = build_catalog_quarantine_records(&payload, &report);
    let quarantined_refs = quarantined_preflight_refs(&report);
    let sync = payload.sync;
    let mut quarantined = 0;
    let mut rows = Vec::new();

    for (row_idx, mut row) in payload.rows.into_iter().enumerate() {
        let row_number = row_idx + 1;
        if quarantined_refs.contains(&(row_number, None)) {
            quarantined += 1;
            continue;
        }

        let is_grid = row.is_grid.unwrap_or(!row.cells.is_empty());
        if is_grid && !row.cells.is_empty() {
            let original_cell_count = row.cells.len();
            row.cells = row
                .cells
                .into_iter()
                .enumerate()
                .filter_map(|(cell_idx, cell)| {
                    if quarantined_refs.contains(&(row_number, Some(cell_idx + 1))) {
                        None
                    } else {
                        Some(cell)
                    }
                })
                .collect();
            quarantined += (original_cell_count - row.cells.len()) as i32;
            if row.cells.is_empty() {
                continue;
            }
        }

        rows.push(row);
    }

    Ok(CounterpointCatalogQuarantineFilter {
        payload: CounterpointCatalogPayload { rows, sync },
        records,
        quarantined,
    })
}

pub async fn execute_counterpoint_catalog_batch(
    pool: &PgPool,
    payload: CounterpointCatalogPayload,
) -> Result<CatalogUpsertSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let filtered = filter_catalog_payload_for_quarantine(payload)?;
    let payload = filtered.payload;
    let quarantined = filtered.quarantined;
    persist_counterpoint_ingest_quarantine_records(pool, &filtered.records).await?;
    if payload.rows.is_empty() {
        let summary = CatalogUpsertSummary {
            products_created: 0,
            products_updated: 0,
            variants_created: 0,
            variants_updated: 0,
            skipped: quarantined,
            name_quality_warnings: 0,
            quarantined,
        };
        if let Some(ref s) = payload.sync {
            if s.entity == "catalog" {
                let _ = record_sync_run(
                    pool,
                    "catalog",
                    s.cursor.as_deref(),
                    true,
                    Some(summary.skipped),
                    None,
                )
                .await;
            }
        }
        return Ok(summary);
    }

    // High-performance cache for vendor and category maps
    let vendor_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT vendor_code, id FROM vendors WHERE vendor_code IS NOT NULL",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let mut tx = pool.begin().await?;
    let mut summary = CatalogUpsertSummary {
        products_created: 0,
        products_updated: 0,
        variants_created: 0,
        variants_updated: 0,
        skipped: quarantined,
        name_quality_warnings: 0,
        quarantined,
    };
    let mut name_quality_issues = Vec::new();

    for row in &payload.rows {
        // Use a savepoint for each item so a single row failure (e.g. duplicate SKU)
        // doesn't abort the entire batch transaction.
        let mut sp = tx.begin().await?;
        if let Err(e) = upsert_catalog_item(
            &mut sp,
            row,
            &mut summary,
            &vendor_map,
            &mut name_quality_issues,
        )
        .await
        {
            let _ = sp.rollback().await;
            tracing::warn!(item_no = %row.item_no, error = %e, "catalog row upsert failed, recording issue");
            record_sync_issue(pool, "catalog", Some(&row.item_no), "error", &e.to_string()).await;
            summary.skipped += 1;
        } else {
            sp.commit().await?;
        }
    }

    tx.commit().await?;

    for (external_key, message) in name_quality_issues {
        record_sync_issue(pool, "catalog", Some(&external_key), "warning", &message).await;
    }

    if let Some(ref s) = payload.sync {
        if s.entity == "catalog" {
            let _ = record_sync_run(
                pool,
                "catalog",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.products_created
                        + summary.products_updated
                        + summary.variants_created
                        + summary.variants_updated
                        + summary.skipped,
                ),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

async fn resolve_category_id(
    tx: &mut Transaction<'_, Postgres>,
    cp_category: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let cat = match cp_category {
        Some(c) if !c.trim().is_empty() => c.trim(),
        _ => return Ok(None),
    };
    let mapped: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT ros_category_id FROM counterpoint_category_map WHERE cp_category = $1",
    )
    .bind(cat)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(id) = mapped.flatten() {
        return Ok(Some(id));
    }
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM categories WHERE lower(trim(name)) = lower(trim($1))")
            .bind(cat)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(existing)
}

fn resolve_counterpoint_product_name(
    short_description: Option<&str>,
    long_description: Option<&str>,
    existing_name: Option<&str>,
    item_no: &str,
    identifiers: &[String],
) -> (String, Option<String>) {
    if let Some(name) = safe_counterpoint_product_name_candidate(short_description, identifiers) {
        return (name, None);
    }

    if let Some(name) = safe_counterpoint_product_name_candidate(long_description, identifiers) {
        return (
            name,
            Some(format!(
                "Counterpoint catalog item {item_no} had a blank or identifier-like DESCR; used LONG_DESCR as the product name."
            )),
        );
    }

    if let Some(name) = safe_counterpoint_product_name_candidate(existing_name, identifiers) {
        return (
            name,
            Some(format!(
                "Counterpoint catalog item {item_no} had no safe incoming product name; preserved the existing ROS product name."
            )),
        );
    }

    (
        clamp_chars(&format!("Unnamed Counterpoint Item {item_no}"), 255),
        Some(format!(
            "Counterpoint catalog item {item_no} had no safe product name. DESCR/LONG_DESCR were blank or identifier-like; assigned a placeholder for operator review."
        )),
    )
}

async fn upsert_catalog_item(
    tx: &mut Transaction<'_, Postgres>,
    row: &CounterpointCatalogRow,
    summary: &mut CatalogUpsertSummary,
    vendor_map: &HashMap<String, Uuid>,
    name_quality_issues: &mut Vec<(String, String)>,
) -> Result<(), CounterpointSyncError> {
    let item_no = row.item_no.trim();
    if item_no.is_empty() {
        summary.skipped += 1;
        return Ok(());
    }

    let long_desc = trim_opt(&row.long_description);
    let barcode = trim_opt(&row.barcode);
    let mut name_identifiers = vec![item_no.to_string()];
    if let Some(ref barcode) = barcode {
        name_identifiers.push(barcode.clone());
    }
    for cell in &row.cells {
        name_identifiers.push(cell.counterpoint_item_key.trim().to_string());
        name_identifiers.push(cell.sku.trim().to_string());
        if let Some(ref barcode) = cell.barcode {
            name_identifiers.push(barcode.trim().to_string());
        }
    }
    let brand = trim_opt(&row.brand);
    let retail = row.retail_price.unwrap_or(Decimal::ZERO);
    let cost = row.unit_cost.unwrap_or(Decimal::ZERO);
    let is_grid = row.is_grid.unwrap_or(!row.cells.is_empty());
    let category_id = resolve_category_id(tx, row.category.as_deref()).await?;
    let vendor_id = row
        .vendor_no
        .as_deref()
        .and_then(|v| vendor_map.get(v.trim()))
        .copied();

    let existing_product: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, name FROM products WHERE catalog_handle = $1 LIMIT 1")
            .bind(item_no)
            .fetch_optional(&mut **tx)
            .await?;
    let existing_name = existing_product
        .as_ref()
        .map(|(_, name)| name.as_str())
        .filter(|name| !name.trim().is_empty());

    let (name, name_issue) = resolve_counterpoint_product_name(
        row.description.as_deref(),
        long_desc.as_deref(),
        existing_name,
        item_no,
        &name_identifiers,
    );
    if let Some(issue) = name_issue {
        summary.name_quality_warnings += 1;
        name_quality_issues.push((item_no.to_string(), issue));
    }

    let product_id = if let Some((pid, _)) = existing_product {
        sqlx::query(
            r#"
            UPDATE products SET
                name = $2, brand = $3,
                base_retail_price = $4, base_cost = $5,
                category_id = COALESCE($6, category_id),
                description = COALESCE($7, description),
                primary_vendor_id = COALESCE($8, primary_vendor_id)
            WHERE id = $1
            "#,
        )
        .bind(pid)
        .bind(&name)
        .bind(&brand)
        .bind(retail)
        .bind(cost)
        .bind(category_id)
        .bind(&long_desc)
        .bind(vendor_id)
        .execute(&mut **tx)
        .await?;
        summary.products_updated += 1;
        pid
    } else {
        let pid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO products (
                catalog_handle, name, description, brand, base_retail_price,
                base_cost, category_id, primary_vendor_id, spiff_amount, data_source
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'counterpoint')
            RETURNING id
            "#,
        )
        .bind(item_no)
        .bind(&name)
        .bind(&long_desc)
        .bind(&brand)
        .bind(retail)
        .bind(cost)
        .bind(category_id)
        .bind(vendor_id)
        .fetch_one(&mut **tx)
        .await?;
        summary.products_created += 1;
        pid
    };

    if !is_grid || row.cells.is_empty() {
        // PER USER RULES: B-XXXXXX is the Barcode (SKU), I-XXXXXX is the Item # (Parent)
        let sku = barcode.clone().unwrap_or_else(|| item_no.to_string());
        let key = item_no.to_string(); // Internal Counterpoint key for upserts
        upsert_variant(
            tx,
            product_id,
            &key,
            &sku,
            row.barcode.as_deref(),
            None,
            None,
            row.retail_price,
            row.unit_cost,
            row.prc_2,
            row.prc_3,
            None,
            None,
            summary,
        )
        .await?;
    } else {
        for cell in &row.cells {
            let key = cell.counterpoint_item_key.trim();
            if key.is_empty() {
                summary.skipped += 1;
                continue;
            }
            upsert_variant(
                tx,
                product_id,
                key,
                &cell.sku,
                cell.barcode.as_deref(),
                cell.variation_label.as_deref(),
                cell.variation_values.as_ref(),
                cell.retail_price,
                cell.unit_cost,
                cell.prc_2,
                cell.prc_3,
                cell.stock_on_hand,
                cell.reorder_point,
                summary,
            )
            .await?;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upsert_variant(
    tx: &mut Transaction<'_, Postgres>,
    product_id: Uuid,
    cp_key: &str,
    sku: &str,
    barcode: Option<&str>,
    variation_label: Option<&str>,
    variation_values: Option<&serde_json::Value>,
    override_retail: Option<Decimal>,
    override_cost: Option<Decimal>,
    counterpoint_prc_2: Option<Decimal>,
    counterpoint_prc_3: Option<Decimal>,
    stock: Option<i32>,
    reorder_point: Option<i32>,
    summary: &mut CatalogUpsertSummary,
) -> Result<(), sqlx::Error> {
    let sku = sku.trim();
    if sku.is_empty() {
        summary.skipped += 1;
        return Ok(());
    }

    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM product_variants WHERE counterpoint_item_key = $1")
            .bind(cp_key)
            .fetch_optional(&mut **tx)
            .await?;

    if let Some(vid) = existing {
        sqlx::query(
            r#"
            UPDATE product_variants SET
                sku = $2,
                barcode = COALESCE($3, barcode),
                variation_label = COALESCE($4, variation_label),
                retail_price_override = COALESCE($5, retail_price_override),
                cost_override = COALESCE($6, cost_override),
                counterpoint_prc_2 = COALESCE($7, counterpoint_prc_2),
                counterpoint_prc_3 = COALESCE($8, counterpoint_prc_3),
                stock_on_hand = COALESCE($9, stock_on_hand),
                reorder_point = COALESCE($10, reorder_point)
            WHERE id = $1
            "#,
        )
        .bind(vid)
        .bind(sku)
        .bind(barcode)
        .bind(variation_label)
        .bind(override_retail)
        .bind(override_cost)
        .bind(counterpoint_prc_2)
        .bind(counterpoint_prc_3)
        .bind(stock)
        .bind(reorder_point)
        .execute(&mut **tx)
        .await?;
        summary.variants_updated += 1;
    } else {
        let vv = variation_values
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                product_id, sku, barcode, counterpoint_item_key,
                variation_values, variation_label, retail_price_override, cost_override,
                counterpoint_prc_2, counterpoint_prc_3,
                stock_on_hand, reorder_point, reserved_stock
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 0), COALESCE($12, 0), 0)
            ON CONFLICT (sku) DO UPDATE SET
                product_id = EXCLUDED.product_id,
                barcode = COALESCE(EXCLUDED.barcode, product_variants.barcode),
                counterpoint_item_key = COALESCE(EXCLUDED.counterpoint_item_key, product_variants.counterpoint_item_key),
                variation_values = EXCLUDED.variation_values,
                variation_label = COALESCE(EXCLUDED.variation_label, product_variants.variation_label),
                retail_price_override = COALESCE(EXCLUDED.retail_price_override, product_variants.retail_price_override),
                cost_override = COALESCE(EXCLUDED.cost_override, product_variants.cost_override),
                counterpoint_prc_2 = COALESCE(EXCLUDED.counterpoint_prc_2, product_variants.counterpoint_prc_2),
                counterpoint_prc_3 = COALESCE(EXCLUDED.counterpoint_prc_3, product_variants.counterpoint_prc_3),
                stock_on_hand = EXCLUDED.stock_on_hand,
                reorder_point = EXCLUDED.reorder_point
            "#,
        )
        .bind(product_id)
        .bind(sku)
        .bind(barcode)
        .bind(cp_key)
        .bind(vv)
        .bind(variation_label)
        .bind(override_retail)
        .bind(override_cost)
        .bind(counterpoint_prc_2)
        .bind(counterpoint_prc_3)
        .bind(stock)
        .bind(reorder_point)
        .execute(&mut **tx)
        .await?;
        summary.variants_created += 1;
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Gift card ingest (SY_GFT_CERT → gift_cards current balance snapshots)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointGiftCardRow {
    #[serde(alias = "gft_cert_no", alias = "gift_cert_no")]
    pub cert_no: String,
    pub balance: Decimal,
    #[serde(default)]
    pub original_value: Option<Decimal>,
    #[serde(default)]
    pub reason_cod: Option<String>,
    /// Explicit expiration override; if absent, computed from `issued_at` + card kind.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// CP `ISSUE_DAT` — when the card was created/sold.
    #[serde(default)]
    pub issued_at: Option<String>,
    #[serde(default)]
    pub events: Vec<GiftCardEventRow>,
}

#[derive(Debug, Deserialize)]
pub struct GiftCardEventRow {
    pub event_kind: String,
    pub amount: Decimal,
    pub balance_after: Decimal,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointGiftCardsPayload {
    pub rows: Vec<CounterpointGiftCardRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct GiftCardSyncSummary {
    pub created: i32,
    pub updated: i32,
    pub events_created: i32,
    pub skipped: i32,
}

async fn resolve_gift_card_kind(
    tx: &mut Transaction<'_, Postgres>,
    reason_cod: Option<&str>,
) -> String {
    if let Some(code) = reason_cod {
        let mapped: Option<String> = sqlx::query_scalar(
            "SELECT ros_card_kind FROM counterpoint_gift_reason_map WHERE cp_reason_cod = $1",
        )
        .bind(code.trim())
        .fetch_optional(&mut **tx)
        .await
        .unwrap_or(None);
        if let Some(kind) = mapped {
            return kind;
        }
    }
    "purchased".to_string()
}

pub async fn execute_counterpoint_gift_card_batch(
    pool: &PgPool,
    payload: CounterpointGiftCardsPayload,
) -> Result<GiftCardSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = GiftCardSyncSummary {
        created: 0,
        updated: 0,
        events_created: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let code = row.cert_no.trim();
        if code.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let kind = resolve_gift_card_kind(&mut tx, row.reason_cod.as_deref()).await;
        let is_liability = kind == "purchased";
        let original = row.original_value.unwrap_or(row.balance);

        let issued_at = row.issued_at.as_deref().and_then(|s| {
            DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.with_timezone(&Utc))
        });

        let expiry_years: i64 = if kind == "purchased" { 9 } else { 1 };

        let expires = row
            .expires_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(|| {
                let base = issued_at.unwrap_or_else(Utc::now);
                base + chrono::Duration::days(expiry_years * 365)
            });

        let existing: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM gift_cards WHERE code = $1")
                .bind(code)
                .fetch_optional(&mut *tx)
                .await?;

        if let Some(gid) = existing {
            sqlx::query(
                r#"
                UPDATE gift_cards SET
                    current_balance = $2,
                    card_kind = $3::gift_card_kind,
                    is_liability = $4,
                    expires_at = $5,
                    created_at = COALESCE($6, created_at)
                WHERE id = $1
                "#,
            )
            .bind(gid)
            .bind(row.balance)
            .bind(&kind)
            .bind(is_liability)
            .bind(expires)
            .bind(issued_at)
            .execute(&mut *tx)
            .await?;
            summary.updated += 1;
        } else {
            sqlx::query(
                r#"
                INSERT INTO gift_cards (code, current_balance, original_value, is_liability, card_kind, card_status, expires_at, created_at)
                VALUES ($1, $2, $3, $4, $5::gift_card_kind, 'active'::gift_card_status, $6, COALESCE($7, CURRENT_TIMESTAMP))
                "#,
            )
            .bind(code)
            .bind(row.balance)
            .bind(original)
            .bind(is_liability)
            .bind(&kind)
            .bind(expires)
            .bind(issued_at)
            .execute(&mut *tx)
            .await?;
            summary.created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "gift_cards" {
            let _ = record_sync_run(
                pool,
                "gift_cards",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated + summary.skipped),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Ticket history ingest (PS_TKT_HIST → transactions / transaction_lines / payments)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointTicketRow {
    pub ticket_ref: String,
    #[serde(default)]
    pub cust_no: Option<String>,
    #[serde(default)]
    pub booked_at: Option<String>,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    /// CP `USR_ID` — who rang up / processed the sale.
    #[serde(default)]
    pub usr_id: Option<String>,
    /// CP `SLS_REP` — who earns commission.
    #[serde(default)]
    pub sls_rep: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub lines: Vec<TicketLineRow>,
    #[serde(default)]
    pub payments: Vec<TicketPaymentRow>,
    /// Counterpoint `PS_TKT_HIST_GFT` — gift certificate applications on the ticket (redemptions).
    #[serde(default)]
    pub gift_applications: Vec<TicketGiftApplicationRow>,
}

#[derive(Debug, Deserialize)]
pub struct TicketGiftApplicationRow {
    pub gift_cert_no: String,
    pub amount: Decimal,
    /// CP `ACTION` — rows that look like load/issue are skipped (redemption only here).
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TicketLineRow {
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub counterpoint_item_key: Option<String>,
    /// Ignored by ingest; bridge may send for debugging (PS_TKT_HIST_LIN.LIN_SEQ_NO).
    #[serde(default)]
    pub lin_seq_no: Option<i32>,
    pub quantity: i32,
    pub unit_price: Decimal,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub reason_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TicketPaymentRow {
    pub pmt_typ: String,
    pub amount: Decimal,
    #[serde(default)]
    pub gift_cert_no: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointTicketsPayload {
    pub rows: Vec<CounterpointTicketRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct TicketSyncSummary {
    pub transactions_created: i32,
    pub transactions_skipped_existing: i32,
    pub line_items_created: i32,
    pub payments_created: i32,
    pub gift_payments_created: i32,
    pub skipped: i32,
}

fn sum_counterpoint_ticket_tenders(
    payments: &[TicketPaymentRow],
    gift_applications: &[TicketGiftApplicationRow],
) -> Option<Decimal> {
    if payments.is_empty() && gift_applications.is_empty() {
        return None;
    }

    let payment_total: Decimal = payments.iter().map(|p| p.amount).sum();
    let gift_total: Decimal = gift_applications
        .iter()
        .filter(|ga| cp_gift_hist_row_is_redemption(ga.action.as_deref()))
        .map(|ga| ga.amount)
        .sum();

    Some(payment_total + gift_total)
}

fn sum_counterpoint_open_doc_tenders(payments: &[TicketPaymentRow]) -> Option<Decimal> {
    if payments.is_empty() {
        return None;
    }

    Some(payments.iter().map(|p| p.amount).sum())
}

fn cp_gift_hist_row_is_redemption(action: Option<&str>) -> bool {
    match action
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
    {
        None => true,
        Some(a) if a.starts_with('L') || a.contains("LOAD") || a.contains("ISSUE") => false,
        _ => true,
    }
}

fn compact_counterpoint_payment_method_code(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace() && *ch != '-' && *ch != '_')
        .collect()
}

async fn resolve_counterpoint_payment_method(
    pool: &PgPool,
    pmt_map: &HashMap<String, String>,
    entity: &str,
    external_key: &str,
    cp_pmt_typ: &str,
) -> String {
    let key = cp_pmt_typ.trim().to_uppercase();
    if let Some(method) = pmt_map.get(&key).filter(|method| !method.trim().is_empty()) {
        return method.trim().to_string();
    }

    let compact_key = compact_counterpoint_payment_method_code(&key);
    if let Some((_, method)) = pmt_map.iter().find(|(cp_method, method)| {
        !method.trim().is_empty()
            && compact_counterpoint_payment_method_code(cp_method.trim()) == compact_key
    }) {
        return method.trim().to_string();
    }

    record_sync_issue(
        pool,
        entity,
        Some(external_key),
        "error",
        &format!(
            "Unmapped Counterpoint payment method {key:?}; recorded as counterpoint_unmapped for review"
        ),
    )
    .await;
    "counterpoint_unmapped".to_string()
}

#[derive(Debug, Clone, Copy)]
struct ParentVariantCandidate {
    variant_id: Uuid,
    product_id: Uuid,
    effective_price: Decimal,
}

#[derive(Debug, Default)]
struct VariantResolutionCache {
    exact: HashMap<String, (Uuid, Uuid)>,
    parent: HashMap<String, Vec<ParentVariantCandidate>>,
}

fn normalized_lookup_keys(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let key = trimmed.to_lowercase();
    let mut keys = vec![key.clone()];
    if let Some(rest) = key.strip_prefix("b-").filter(|rest| !rest.is_empty()) {
        keys.push(format!("i-{rest}"));
    } else if let Some(rest) = key.strip_prefix("i-").filter(|rest| !rest.is_empty()) {
        keys.push(format!("b-{rest}"));
    }
    keys.sort();
    keys.dedup();
    keys
}

fn line_parent_keys(line: &TicketLineRow) -> Vec<String> {
    let mut keys = Vec::new();
    for value in [line.counterpoint_item_key.as_deref(), line.sku.as_deref()]
        .into_iter()
        .flatten()
    {
        for key in normalized_lookup_keys(value) {
            let parent = key.split('|').next().unwrap_or("").trim();
            if !parent.is_empty() {
                keys.push(parent.to_string());
            }
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

async fn build_variant_resolution_cache<'a>(
    pool: &PgPool,
    lines: impl IntoIterator<Item = &'a TicketLineRow>,
) -> Result<VariantResolutionCache, sqlx::Error> {
    let mut item_keys = HashSet::new();
    let mut skus = HashSet::new();
    let mut parent_keys = HashSet::new();

    for line in lines {
        for key in line
            .counterpoint_item_key
            .as_deref()
            .map(normalized_lookup_keys)
            .unwrap_or_default()
        {
            item_keys.insert(key);
        }
        for sku in line
            .sku
            .as_deref()
            .map(normalized_lookup_keys)
            .unwrap_or_default()
        {
            skus.insert(sku);
        }
        for parent in line_parent_keys(line) {
            parent_keys.insert(parent);
        }
    }

    let mut cache = VariantResolutionCache::default();

    if !item_keys.is_empty() {
        let keys: Vec<String> = item_keys.into_iter().collect();
        let rows: Vec<(String, Uuid, Uuid)> = sqlx::query_as(
            r#"
            SELECT lower(trim(counterpoint_item_key)), id, product_id
            FROM product_variants
            WHERE lower(trim(counterpoint_item_key)) = ANY($1)
            "#,
        )
        .bind(&keys)
        .fetch_all(pool)
        .await?;
        for (key, variant_id, product_id) in rows {
            cache.exact.insert(key, (variant_id, product_id));
        }
    }

    if !skus.is_empty() {
        let sku_values: Vec<String> = skus.into_iter().collect();
        let rows: Vec<(String, Uuid, Uuid)> = sqlx::query_as(
            r#"
            SELECT lower(trim(sku)), id, product_id
            FROM product_variants
            WHERE lower(trim(sku)) = ANY($1)
            "#,
        )
        .bind(&sku_values)
        .fetch_all(pool)
        .await?;
        for (sku, variant_id, product_id) in rows {
            cache.exact.entry(sku).or_insert((variant_id, product_id));
        }
    }

    if !parent_keys.is_empty() {
        let parents: Vec<String> = parent_keys.into_iter().collect();
        let rows: Vec<(String, Uuid, Uuid, Decimal)> = sqlx::query_as(
            r#"
            WITH parent_rows AS (
                SELECT
                    lower(trim(split_part(coalesce(pv.counterpoint_item_key, ''), '|', 1))) AS parent_key,
                    pv.id,
                    pv.product_id,
                    COALESCE(pv.retail_price_override, p.base_retail_price) AS effective_price
                FROM product_variants pv
                JOIN products p ON p.id = pv.product_id
                WHERE NULLIF(trim(pv.counterpoint_item_key), '') IS NOT NULL
                UNION ALL
                SELECT
                    lower(trim(split_part(coalesce(pv.sku, ''), '|', 1))) AS parent_key,
                    pv.id,
                    pv.product_id,
                    COALESCE(pv.retail_price_override, p.base_retail_price) AS effective_price
                FROM product_variants pv
                JOIN products p ON p.id = pv.product_id
                WHERE NULLIF(trim(pv.sku), '') IS NOT NULL
            )
            SELECT parent_key, id, product_id, effective_price
            FROM parent_rows
            WHERE parent_key = ANY($1)
            "#,
        )
        .bind(&parents)
        .fetch_all(pool)
        .await?;
        for (parent, variant_id, product_id, effective_price) in rows {
            let candidates = cache.parent.entry(parent).or_default();
            if !candidates.iter().any(|c| c.variant_id == variant_id) {
                candidates.push(ParentVariantCandidate {
                    variant_id,
                    product_id,
                    effective_price,
                });
            }
        }
    }

    Ok(cache)
}

fn resolve_variant_from_cache(
    cache: &VariantResolutionCache,
    line: &TicketLineRow,
) -> Option<(Uuid, Uuid)> {
    for key in line
        .counterpoint_item_key
        .as_deref()
        .map(normalized_lookup_keys)
        .unwrap_or_default()
    {
        if let Some(pair) = cache.exact.get(&key) {
            return Some(*pair);
        }
    }
    for sku in line
        .sku
        .as_deref()
        .map(normalized_lookup_keys)
        .unwrap_or_default()
    {
        if let Some(pair) = cache.exact.get(&sku) {
            return Some(*pair);
        }
    }
    let tol = Decimal::new(1, 2);
    for parent in line_parent_keys(line) {
        let Some(candidates) = cache.parent.get(&parent) else {
            continue;
        };
        if candidates.len() == 1 {
            let candidate = candidates[0];
            return Some((candidate.variant_id, candidate.product_id));
        }

        let mut exact = candidates
            .iter()
            .filter(|candidate| (candidate.effective_price - line.unit_price).abs() <= tol);
        let Some(first) = exact.next() else {
            continue;
        };
        if exact.next().is_none() {
            return Some((first.variant_id, first.product_id));
        }
    }
    None
}

fn resolve_ticket_lines_from_cache(
    cache: &VariantResolutionCache,
    lines: &[TicketLineRow],
) -> Result<Vec<(Uuid, Uuid)>, String> {
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        match resolve_variant_from_cache(cache, line) {
            Some(pair) => out.push(pair),
            None => {
                let sku_str = line.sku.as_deref().unwrap_or("");
                let key = line.counterpoint_item_key.as_deref().unwrap_or("");
                let desc = line.description.as_deref().unwrap_or("Unknown item");
                return Err(format!(
                    "unresolved line (sku={sku_str:?} counterpoint_item_key={key:?} descr={desc:?}); import catalog and align SKUs or cell keys"
                ));
            }
        }
    }
    Ok(out)
}

/// Resolve unresolved transaction lines that are currently mapped to the fallback variant
/// but now have a matching variant in the database (matching counterpoint_item_key or SKU).
pub async fn resolve_unresolved_counterpoint_lines(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let fallback_variant_id: Uuid = match sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM product_variants WHERE sku = $1 LIMIT 1",
    )
    .bind(HISTORICAL_FALLBACK_SKU)
    .fetch_optional(pool)
    .await?
    {
        Some(id) => id,
        None => return Ok(0),
    };

    let mut tx = pool.begin().await?;

    let updated = sqlx::query(
        r#"
        WITH fallback_lines AS (
          SELECT
            tl.id,
            lower(trim(tl.vendor_reference)) AS lookup_key,
            tl.unit_price
          FROM transaction_lines tl
          WHERE tl.variant_id = $1
            AND NULLIF(trim(tl.vendor_reference), '') IS NOT NULL
        ),
        expanded_line_keys AS (
          SELECT id, lookup_key, unit_price
          FROM fallback_lines
          UNION ALL
          SELECT id, 'i-' || substring(lookup_key from 3), unit_price
          FROM fallback_lines
          WHERE lookup_key LIKE 'b-%' AND length(lookup_key) > 2
          UNION ALL
          SELECT id, 'b-' || substring(lookup_key from 3), unit_price
          FROM fallback_lines
          WHERE lookup_key LIKE 'i-%' AND length(lookup_key) > 2
        ),
        variant_keys AS (
          SELECT
            lower(trim(pv.counterpoint_item_key)) AS lookup_key,
            pv.id,
            pv.product_id,
            COALESCE(pv.retail_price_override, p.base_retail_price) AS effective_price
          FROM product_variants pv
          JOIN products p ON p.id = pv.product_id
          WHERE pv.sku <> $2
            AND NULLIF(trim(pv.counterpoint_item_key), '') IS NOT NULL
          UNION ALL
          SELECT
            lower(trim(split_part(pv.counterpoint_item_key, '|', 1))) AS lookup_key,
            pv.id,
            pv.product_id,
            COALESCE(pv.retail_price_override, p.base_retail_price) AS effective_price
          FROM product_variants pv
          JOIN products p ON p.id = pv.product_id
          WHERE pv.sku <> $2
            AND position('|' in pv.counterpoint_item_key) > 0
          UNION ALL
          SELECT
            lower(trim(pv.sku)) AS lookup_key,
            pv.id,
            pv.product_id,
            COALESCE(pv.retail_price_override, p.base_retail_price) AS effective_price
          FROM product_variants pv
          JOIN products p ON p.id = pv.product_id
          WHERE pv.sku <> $2
            AND NULLIF(trim(pv.sku), '') IS NOT NULL
        ),
        candidate_matches AS (
          SELECT DISTINCT
            lk.id AS line_id,
            vk.id AS variant_id,
            vk.product_id,
            CASE WHEN abs(vk.effective_price - lk.unit_price) <= 0.01 THEN 0 ELSE 1 END AS price_rank
          FROM expanded_line_keys lk
          JOIN variant_keys vk ON vk.lookup_key = lk.lookup_key
        ),
        unambiguous_matches AS (
          SELECT line_id, variant_id, product_id
          FROM (
            SELECT
              line_id,
              variant_id,
              product_id,
              COUNT(*) OVER (PARTITION BY line_id) AS match_count,
              COUNT(*) FILTER (WHERE price_rank = 0) OVER (PARTITION BY line_id) AS price_match_count,
              ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY price_rank, variant_id) AS rn
            FROM candidate_matches
          ) ranked
          WHERE rn = 1
            AND (match_count = 1 OR price_match_count = 1)
        )
        UPDATE transaction_lines tl
        SET
          variant_id = m.variant_id,
          product_id = m.product_id,
          vendor_reference = NULL
        FROM unambiguous_matches m
        WHERE tl.id = m.line_id
        "#,
    )
    .bind(fallback_variant_id)
    .bind(HISTORICAL_FALLBACK_SKU)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if updated > 0 {
        // Resolve ticket sync issue warnings where there are no longer any fallback lines
        sqlx::query(
            r#"
            UPDATE counterpoint_sync_issue csi
            SET resolved = TRUE, resolved_at = NOW()
            FROM transactions t
            WHERE t.counterpoint_ticket_ref = csi.external_key
              AND csi.entity = 'tickets'
              AND csi.message LIKE '%unresolved line%'
              AND NOT csi.resolved
              AND NOT EXISTS (
                SELECT 1 FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
                  AND tl.variant_id = $1
              )
            "#,
        )
        .bind(fallback_variant_id)
        .execute(&mut *tx)
        .await?;

        // Resolve open doc sync issue warnings where there are no longer any fallback lines
        sqlx::query(
            r#"
            UPDATE counterpoint_sync_issue csi
            SET resolved = TRUE, resolved_at = NOW()
            FROM transactions t
            WHERE t.counterpoint_doc_ref = csi.external_key
              AND csi.entity = 'open_docs'
              AND csi.message LIKE '%unresolved line%'
              AND NOT csi.resolved
              AND NOT EXISTS (
                SELECT 1 FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
                  AND tl.variant_id = $1
              )
            "#,
        )
        .bind(fallback_variant_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(updated)
}

async fn resolve_variant_for_cp_item_no(
    tx: &mut Transaction<'_, Postgres>,
    item_no: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let item_no = item_no.trim();
    if item_no.is_empty() {
        return Ok(None);
    }
    let by_key: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM product_variants WHERE counterpoint_item_key = $1 LIMIT 1",
    )
    .bind(item_no)
    .fetch_optional(&mut **tx)
    .await?;
    if by_key.is_some() {
        return Ok(by_key);
    }
    sqlx::query_scalar(
        "SELECT id FROM product_variants WHERE lower(trim(sku)) = lower(trim($1)) LIMIT 1",
    )
    .bind(item_no)
    .fetch_optional(&mut **tx)
    .await
}

pub async fn execute_counterpoint_ticket_batch(
    pool: &PgPool,
    payload: CounterpointTicketsPayload,
) -> Result<TicketSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    // High-performance caches for salesperson and payment resolution
    let staff_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT cp_code, ros_staff_id FROM counterpoint_staff_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let pmt_map: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT cp_pmt_typ, ros_method FROM counterpoint_payment_method_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // Batch pre-fetch exact variants and matrix-parent fallback candidates once per payload.
    // Historical tickets may carry parent ITEM_NO only; resolving those with per-line SQL is too slow.
    let variant_cache =
        build_variant_resolution_cache(pool, payload.rows.iter().flat_map(|tkt| tkt.lines.iter()))
            .await?;

    // Batch pre-fetch customer IDs and duplicate ticket refs (Extreme Performance for 13k+ tickets)
    let cust_codes: HashSet<String> = payload
        .rows
        .iter()
        .filter_map(|t| t.cust_no.as_ref().map(|s| s.trim().to_string()))
        .collect();
    let ticket_refs: Vec<String> = payload
        .rows
        .iter()
        .map(|t| t.ticket_ref.trim().to_string())
        .collect();

    let customer_id_map: HashMap<String, Uuid> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        let mut map = HashMap::new();
        let codes: Vec<String> = cust_codes.into_iter().collect();
        // Match either exact, with C- prefix, or stripping C- prefix
        // This handles cases where tickets have C- but DB doesn't, or vice versa
        let rows: Vec<(String, Uuid)> = sqlx::query_as(
            r#"
            SELECT customer_code, id FROM customers
            WHERE customer_code = ANY($1)
               OR customer_code IN (SELECT 'C-' || c FROM unnest($1::text[]) c)
               OR customer_code IN (SELECT substring(c from 3) FROM unnest($1::text[]) c WHERE c LIKE 'C-%')
            "#
        )
        .bind(&codes)
        .fetch_all(pool)
        .await?;

        for (code, id) in rows {
            // Priority 1: Exact match (as stored in DB)
            map.insert(code.clone(), id);

            // Priority 2: If DB code has C-, also allow ticket to find it without C-
            if let Some(clean) = code.strip_prefix("C-") {
                map.entry(clean.to_string()).or_insert(id);
            }
            // Priority 3: If DB code DOES NOT have C-, also allow ticket to find it with C-
            else {
                map.entry(format!("C-{code}")).or_insert(id);
            }
        }
        map
    };

    let existing_ticket_refs: HashSet<String> = if ticket_refs.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT counterpoint_ticket_ref FROM transactions WHERE counterpoint_ticket_ref = ANY($1)",
        )
        .bind(&ticket_refs)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect()
    };

    let mut tx = pool.begin().await?;
    let mut bulk_line_txn_ids = Vec::new();
    let mut bulk_line_prod_ids = Vec::new();
    let mut bulk_line_var_ids = Vec::new();
    let mut bulk_line_sales_ids = Vec::new();
    let mut bulk_line_qtys = Vec::new();
    let mut bulk_line_prices = Vec::new();
    let mut bulk_line_costs = Vec::new();
    let mut bulk_line_reasons = Vec::new();
    let mut bulk_line_vendor_refs = Vec::new();
    let mut fallback_pair: Option<(Uuid, Uuid)> = None;
    let mut fallback_exceptions: Vec<(String, Uuid, i32)> = Vec::new();

    let mut summary = TicketSyncSummary {
        transactions_created: 0,
        transactions_skipped_existing: 0,
        line_items_created: 0,
        payments_created: 0,
        gift_payments_created: 0,
        skipped: 0,
    };

    for tkt in &payload.rows {
        let ticket_ref = tkt.ticket_ref.trim();
        if ticket_ref.is_empty() {
            summary.skipped += 1;
            continue;
        }

        if existing_ticket_refs.contains(ticket_ref) {
            summary.transactions_skipped_existing += 1;
            continue;
        }

        let synthesized_lines: Vec<TicketLineRow>;
        let ticket_lines: &[TicketLineRow] = if tkt.lines.is_empty() {
            let tender_total =
                sum_counterpoint_ticket_tenders(&tkt.payments, &tkt.gift_applications)
                    .unwrap_or(tkt.amount_paid);
            if tkt.total_price == Decimal::ZERO && tender_total == Decimal::ZERO {
                record_sync_issue(
                    pool,
                    "tickets",
                    Some(ticket_ref),
                    "warning",
                    "Ticket skipped: no line items in payload",
                )
                .await;
                summary.skipped += 1;
                continue;
            }

            sqlx::query(
                r#"
                UPDATE counterpoint_sync_issue
                SET resolved = TRUE, resolved_at = NOW()
                WHERE entity = 'tickets'
                  AND external_key = $1
                  AND NOT resolved
                  AND message = 'Ticket skipped: no line items in payload'
                "#,
            )
            .bind(ticket_ref)
            .execute(pool)
            .await?;

            record_sync_issue(
                pool,
                "tickets",
                Some(ticket_ref),
                "warning",
                "Ticket had no line items; mapped sale total to fallback",
            )
            .await;

            let fallback_amount = if tkt.total_price != Decimal::ZERO {
                tkt.total_price
            } else {
                tender_total
            };
            synthesized_lines = vec![TicketLineRow {
                sku: Some("COUNTERPOINT_NO_LINE_ITEMS".into()),
                counterpoint_item_key: Some("COUNTERPOINT_NO_LINE_ITEMS".into()),
                lin_seq_no: None,
                quantity: 1,
                unit_price: fallback_amount,
                unit_cost: Some(Decimal::ZERO),
                description: Some("Counterpoint ticket with no source line items".into()),
                reason_code: None,
            }];
            &synthesized_lines
        } else {
            &tkt.lines
        };

        let mut resolved_lines: Vec<(Uuid, Uuid)> = Vec::with_capacity(ticket_lines.len());
        let mut line_vendor_refs: Vec<Option<String>> = Vec::with_capacity(ticket_lines.len());
        let mut unresolved_count = 0;
        let mut skipped_ticket = false;

        for line in ticket_lines {
            if let Some(pair) = resolve_variant_from_cache(&variant_cache, line) {
                resolved_lines.push(pair);
                line_vendor_refs.push(None);
            } else {
                let pair = if let Some(p) = fallback_pair {
                    p
                } else {
                    match ensure_historical_fallback_variant(&mut tx).await {
                        Ok(p) => {
                            fallback_pair = Some(p);
                            p
                        }
                        Err(e) => {
                            record_sync_issue(
                                pool,
                                "tickets",
                                Some(ticket_ref),
                                "error",
                                &format!("Ticket skipped: failed to ensure fallback variant: {e}"),
                            )
                            .await;
                            skipped_ticket = true;
                            break;
                        }
                    }
                };
                resolved_lines.push(pair);

                let sku = line.sku.as_deref().unwrap_or("").trim();
                let cp_key = line.counterpoint_item_key.as_deref().unwrap_or(&sku).trim();
                let item_key = if cp_key.is_empty() { sku } else { cp_key };
                line_vendor_refs.push(Some(item_key.to_string()));
                unresolved_count += 1;
            }
        }
        if skipped_ticket {
            summary.skipped += 1;
            continue;
        }
        if unresolved_count > 0 {
            record_sync_issue(
                pool,
                "tickets",
                Some(ticket_ref),
                "warning",
                &format!("Mapped {unresolved_count} unresolved line item(s) to fallback"),
            )
            .await;
        }

        let customer_id: Option<Uuid> = tkt
            .cust_no
            .as_deref()
            .and_then(|c| customer_id_map.get(c.trim()))
            .copied();
        if let Some(cust_no) = tkt
            .cust_no
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            if customer_id.is_some() {
                resolve_sync_issue_by_key(pool, "tickets", ticket_ref).await;
            } else {
                record_sync_issue(
                    pool,
                    "tickets",
                    Some(ticket_ref),
                    "warning",
                    &format!("Customer unresolved: CUST_NO {cust_no} was not found in ROS"),
                )
                .await;
            }
        }

        let booked_at = tkt
            .booked_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        let normalized_amount_paid =
            sum_counterpoint_ticket_tenders(&tkt.payments, &tkt.gift_applications)
                .unwrap_or(tkt.amount_paid);
        let balance = tkt.total_price - normalized_amount_paid;
        let status = if balance <= Decimal::ZERO {
            "fulfilled"
        } else {
            "open"
        };

        let processed_by = tkt
            .usr_id
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();
        let salesperson = tkt
            .sls_rep
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();

        let transaction_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO transactions (
                customer_id, counterpoint_ticket_ref,
                is_counterpoint_import, status, booked_at, business_date, fulfilled_at, total_price,
                amount_paid, balance_due, processed_by_staff_id,
                primary_salesperson_id, notes
            )
            VALUES (
                $1, $2, TRUE, $3::order_status, $4,
                ($4 AT TIME ZONE reporting.effective_store_timezone())::date,
                CASE WHEN $3::order_status = 'fulfilled'::order_status THEN $4 ELSE NULL END,
                $5, $6, $7, $8, $9, $10
            )
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(ticket_ref)
        .bind(status)
        .bind(booked_at)
        .bind(tkt.total_price)
        .bind(normalized_amount_paid)
        .bind(balance)
        .bind(processed_by)
        .bind(salesperson)
        .bind(tkt.notes.as_deref())
        .fetch_one(&mut *tx)
        .await?;
        summary.transactions_created += 1;

        for (((variant_id, product_id), line), vendor_ref) in resolved_lines
            .iter()
            .zip(ticket_lines.iter())
            .zip(line_vendor_refs.iter())
        {
            let cost = line.unit_cost.unwrap_or(Decimal::ZERO);
            bulk_line_txn_ids.push(transaction_id);
            bulk_line_prod_ids.push(*product_id);
            bulk_line_var_ids.push(*variant_id);
            bulk_line_sales_ids.push(salesperson);
            bulk_line_qtys.push(line.quantity);
            bulk_line_prices.push(line.unit_price);
            bulk_line_costs.push(cost);
            bulk_line_reasons.push(line.reason_code.clone());
            bulk_line_vendor_refs.push(vendor_ref.clone());
            summary.line_items_created += 1;
        }
        if unresolved_count > 0 {
            fallback_exceptions.push((ticket_ref.to_string(), transaction_id, unresolved_count));
        }

        for pmt in &tkt.payments {
            let method = resolve_counterpoint_payment_method(
                pool,
                &pmt_map,
                "tickets",
                ticket_ref,
                &pmt.pmt_typ,
            )
            .await;

            let txn_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    payer_id, category, payment_method, amount, created_at, effective_date, metadata
                )
                VALUES (
                    $1, 'retail_sale', $2, $3, $4,
                    ($4 AT TIME ZONE reporting.effective_store_timezone())::date,
                    $5
                )
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(&method)
            .bind(pmt.amount)
            .bind(booked_at)
            .bind(serde_json::json!({
                "counterpoint_pmt_typ": pmt.pmt_typ.trim(),
                "counterpoint_ticket_ref": ticket_ref,
                "counterpoint_gift_cert_no": pmt.gift_cert_no.as_deref(),
            }))
            .fetch_one(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(transaction_id)
            .bind(pmt.amount)
            .execute(&mut *tx)
            .await?;
            summary.payments_created += 1;
        }

        for ga in &tkt.gift_applications {
            if !cp_gift_hist_row_is_redemption(ga.action.as_deref()) {
                continue;
            }
            let cert = ga.gift_cert_no.trim();
            if cert.is_empty() || ga.amount <= Decimal::ZERO {
                summary.skipped += 1;
                continue;
            }
            let gift_card_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM gift_cards WHERE code = $1)")
                    .bind(cert)
                    .fetch_one(&mut *tx)
                    .await?;
            if !gift_card_exists {
                record_sync_issue(
                    pool,
                    "tickets",
                    Some(ticket_ref),
                    "warning",
                    &format!("PS_TKT_HIST_GFT: gift card code not in ROS: {cert}"),
                )
                .await;
                summary.skipped += 1;
                continue;
            }
            let redeem = ga.amount;

            let txn_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    payer_id, category, payment_method, amount, created_at, effective_date
                )
                VALUES (
                    $1, 'retail_sale', 'gift_card', $2, $3,
                    ($3 AT TIME ZONE reporting.effective_store_timezone())::date
                )
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(redeem)
            .bind(booked_at)
            .fetch_one(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(transaction_id)
            .bind(redeem)
            .execute(&mut *tx)
            .await?;
            summary.gift_payments_created += 1;
        }
    }

    // Bulk Insert all transaction lines for the batch
    if !bulk_line_txn_ids.is_empty() {
        sqlx::query(
            r#"
            INSERT INTO transaction_lines (
                transaction_id, product_id, variant_id, salesperson_id, fulfillment,
                quantity, unit_price, unit_cost,
                state_tax, local_tax, applied_spiff, calculated_commission,
                is_fulfilled, fulfilled_at,
                counterpoint_reason_code, vendor_reference
            )
            SELECT
                u.tid, u.pid, u.vid, u.sid, 'takeaway'::fulfillment_type,
                u.qty, u.price, u.cost, 0, 0, 0, 0,
                TRUE, t.booked_at,
                u.reason, u.vref
            FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::int[], $6::numeric[], $7::numeric[], $8::text[], $9::text[])
              AS u(tid, pid, vid, sid, qty, price, cost, reason, vref)
            INNER JOIN transactions t ON t.id = u.tid
            "#,
        )
        .bind(&bulk_line_txn_ids)
        .bind(&bulk_line_prod_ids)
        .bind(&bulk_line_var_ids)
        .bind(&bulk_line_sales_ids)
        .bind(&bulk_line_qtys)
        .bind(&bulk_line_prices)
        .bind(&bulk_line_costs)
        .bind(&bulk_line_reasons)
        .bind(&bulk_line_vendor_refs)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    for (ticket_ref, transaction_id, unresolved_count) in fallback_exceptions {
        record_counterpoint_import_exception(
            pool,
            "tickets",
            Some(&ticket_ref),
            "warning",
            "fallback_item_landed",
            &format!(
                "{unresolved_count} ticket line item(s) landed with Counterpoint Import Item fallback."
            ),
            Some("Map the source item to a ROS variant or keep this Counterpoint Import Item as review-visible history proof."),
            true,
            Some("transactions"),
            Some(transaction_id),
            serde_json::json!({
                "counterpoint_ticket_ref": ticket_ref,
                "unresolved_line_count": unresolved_count,
                "fallback_sku": HISTORICAL_FALLBACK_SKU,
            }),
        )
        .await;
    }

    if let Some(ref s) = payload.sync {
        if s.entity == "tickets" {
            let _ = record_sync_run(
                pool,
                "tickets",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.transactions_created
                        + summary.transactions_skipped_existing
                        + summary.skipped,
                ),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Store credit opening (Counterpoint → store_credit_accounts + ledger)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointStoreCreditOpeningRow {
    pub cust_no: String,
    pub balance: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointStoreCreditOpeningPayload {
    pub rows: Vec<CounterpointStoreCreditOpeningRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct StoreCreditOpeningSyncSummary {
    pub applied: i32,
    pub skipped_non_positive: i32,
    pub skipped_already_imported: i32,
    pub skipped_no_customer: i32,
}

pub async fn execute_counterpoint_store_credit_opening_batch(
    pool: &PgPool,
    payload: CounterpointStoreCreditOpeningPayload,
) -> Result<StoreCreditOpeningSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = StoreCreditOpeningSyncSummary {
        applied: 0,
        skipped_non_positive: 0,
        skipped_already_imported: 0,
        skipped_no_customer: 0,
    };

    for row in &payload.rows {
        let cust = row.cust_no.trim();
        if cust.is_empty() {
            summary.skipped_no_customer += 1;
            continue;
        }
        let customer_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
                .bind(cust)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(customer_id) = customer_id else {
            summary.skipped_no_customer += 1;
            continue;
        };

        match store_credit::apply_counterpoint_opening_balance(&mut tx, customer_id, row.balance)
            .await
        {
            Ok(store_credit::CounterpointOpeningBalanceOutcome::Applied) => {
                summary.applied += 1;
            }
            Ok(store_credit::CounterpointOpeningBalanceOutcome::SkippedNonPositive) => {
                summary.skipped_non_positive += 1;
            }
            Ok(store_credit::CounterpointOpeningBalanceOutcome::SkippedAlreadyImported) => {
                summary.skipped_already_imported += 1;
            }
            Err(store_credit::StoreCreditError::Database(d)) => {
                return Err(CounterpointSyncError::Database(d));
            }
            Err(e) => return Err(CounterpointSyncError::InvalidPayload(e.to_string())),
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "store_credit_opening" {
            let _ = record_sync_run(
                pool,
                "store_credit_opening",
                s.cursor.as_deref(),
                true,
                None,
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

fn order_status_for_cp_open_doc(
    cp_status: Option<&str>,
    _total_price: Decimal,
    _amount_paid: Decimal,
) -> &'static str {
    let flag = cp_status
        .map(|s| s.trim().to_uppercase())
        .unwrap_or_default();
    if flag.contains("VOID") || flag.contains("CANCEL") || flag == "V" {
        return "cancelled";
    }
    "open"
}

fn fulfillment_type_for_cp_doc_typ(doc_typ: Option<&str>) -> &'static str {
    match doc_typ.map(|s| s.trim().to_uppercase()).as_deref() {
        Some("L") => "layaway",
        _ => "special_order",
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Open documents (PS_DOC → transactions as special_order lines; idempotent on doc ref)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointOpenDocRow {
    pub doc_ref: String,
    #[serde(default)]
    pub cust_no: Option<String>,
    #[serde(default)]
    pub booked_at: Option<String>,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    #[serde(default)]
    pub usr_id: Option<String>,
    #[serde(default)]
    pub sls_rep: Option<String>,
    #[serde(default)]
    pub cp_status: Option<String>,
    /// CP `DOC_TYP`: O=Order (Special Order), L=Layaway.
    #[serde(default)]
    pub doc_typ: Option<String>,
    #[serde(default)]
    pub lines: Vec<TicketLineRow>,
    #[serde(default)]
    pub payments: Vec<TicketPaymentRow>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointOpenDocsPayload {
    pub rows: Vec<CounterpointOpenDocRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct OpenDocSyncSummary {
    pub transactions_created: i32,
    pub transactions_skipped_existing: i32,
    pub line_items_created: i32,
    pub payments_created: i32,
    pub skipped: i32,
}

fn set_if_blank(target: &mut Option<String>, candidate: Option<String>) {
    let target_blank = target
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none();
    if target_blank {
        *target = candidate.filter(|value| !value.trim().is_empty());
    }
}

fn counterpoint_open_doc_line_key(line: &TicketLineRow) -> String {
    serde_json::json!({
        "sku": line.sku.as_deref().map(str::trim).unwrap_or(""),
        "counterpoint_item_key": line.counterpoint_item_key.as_deref().map(str::trim).unwrap_or(""),
        "lin_seq_no": line.lin_seq_no,
        "quantity": line.quantity,
        "unit_price": line.unit_price,
        "unit_cost": line.unit_cost,
        "description": line.description.as_deref().map(str::trim).unwrap_or(""),
        "reason_code": line.reason_code.as_deref().map(str::trim).unwrap_or(""),
    })
    .to_string()
}

fn counterpoint_open_doc_payment_key(payment: &TicketPaymentRow) -> String {
    serde_json::json!({
        "pmt_typ": payment.pmt_typ.trim().to_uppercase(),
        "amount": payment.amount,
        "gift_cert_no": payment.gift_cert_no.as_deref().map(str::trim).unwrap_or(""),
    })
    .to_string()
}

fn dedupe_counterpoint_open_doc_lines(lines: Vec<TicketLineRow>) -> Vec<TicketLineRow> {
    let mut seen = HashSet::new();
    lines
        .into_iter()
        .filter(|line| seen.insert(counterpoint_open_doc_line_key(line)))
        .collect()
}

fn dedupe_counterpoint_open_doc_payments(payments: Vec<TicketPaymentRow>) -> Vec<TicketPaymentRow> {
    let mut seen = HashSet::new();
    payments
        .into_iter()
        .filter(|payment| seen.insert(counterpoint_open_doc_payment_key(payment)))
        .collect()
}

fn merge_counterpoint_open_doc_rows(
    rows: Vec<CounterpointOpenDocRow>,
) -> Vec<CounterpointOpenDocRow> {
    let mut merged = Vec::new();
    let mut by_doc_ref: BTreeMap<String, CounterpointOpenDocRow> = BTreeMap::new();

    for mut row in rows {
        let doc_ref = row.doc_ref.trim().to_string();
        if doc_ref.is_empty() {
            merged.push(row);
            continue;
        }

        if let Some(existing) = by_doc_ref.get_mut(&doc_ref) {
            if row.total_price > existing.total_price {
                existing.total_price = row.total_price;
            }
            if row.amount_paid > existing.amount_paid {
                existing.amount_paid = row.amount_paid;
            }
            set_if_blank(&mut existing.cust_no, row.cust_no.take());
            set_if_blank(&mut existing.booked_at, row.booked_at.take());
            set_if_blank(&mut existing.usr_id, row.usr_id.take());
            set_if_blank(&mut existing.sls_rep, row.sls_rep.take());
            set_if_blank(&mut existing.cp_status, row.cp_status.take());
            set_if_blank(&mut existing.doc_typ, row.doc_typ.take());
            existing.lines.append(&mut row.lines);
            existing.payments.append(&mut row.payments);
        } else {
            row.doc_ref = doc_ref.clone();
            by_doc_ref.insert(doc_ref, row);
        }
    }

    merged.extend(by_doc_ref.into_values().map(|mut doc| {
        doc.lines = dedupe_counterpoint_open_doc_lines(doc.lines);
        doc.payments = dedupe_counterpoint_open_doc_payments(doc.payments);
        doc
    }));
    merged
}

pub async fn execute_counterpoint_open_doc_batch(
    pool: &PgPool,
    payload: CounterpointOpenDocsPayload,
) -> Result<OpenDocSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let docs = merge_counterpoint_open_doc_rows(payload.rows);

    // High-performance staff cache for salesperson resolution
    let staff_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT cp_code, ros_staff_id FROM counterpoint_staff_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // Batch pre-fetch customer IDs
    let cust_codes: HashSet<String> = docs
        .iter()
        .filter_map(|d| d.cust_no.as_ref().map(|s| s.trim().to_string()))
        .collect();

    let customer_id_map: HashMap<String, Uuid> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        let mut map = HashMap::new();
        let codes: Vec<String> = cust_codes.into_iter().collect();
        let rows: Vec<(String, Uuid)> = sqlx::query_as(
            r#"
            SELECT customer_code, id FROM customers
            WHERE customer_code = ANY($1)
               OR customer_code IN (SELECT 'C-' || c FROM unnest($1::text[]) c)
               OR customer_code IN (SELECT substring(c from 3) FROM unnest($1::text[]) c WHERE c LIKE 'C-%')
            "#
        )
        .bind(&codes)
        .fetch_all(pool)
        .await?;
        for (code, id) in rows {
            map.insert(code.clone(), id);
            if let Some(clean) = code.strip_prefix("C-") {
                map.entry(clean.to_string()).or_insert(id);
            } else {
                map.entry(format!("C-{code}")).or_insert(id);
            }
        }
        map
    };

    let pmt_map: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT cp_pmt_typ, ros_method FROM counterpoint_payment_method_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let variant_cache =
        build_variant_resolution_cache(pool, docs.iter().flat_map(|doc| doc.lines.iter())).await?;

    let doc_refs: Vec<String> = docs
        .iter()
        .map(|doc| doc.doc_ref.trim().to_string())
        .filter(|doc_ref| !doc_ref.is_empty())
        .collect();
    let existing_doc_refs: HashSet<String> = if doc_refs.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT counterpoint_doc_ref FROM transactions WHERE counterpoint_doc_ref = ANY($1)",
        )
        .bind(&doc_refs)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect()
    };

    let mut tx = pool.begin().await?;
    let mut fallback_pair: Option<(Uuid, Uuid)> = None;
    let mut fallback_exceptions: Vec<(String, Uuid, i32)> = Vec::new();
    let mut summary = OpenDocSyncSummary {
        transactions_created: 0,
        transactions_skipped_existing: 0,
        line_items_created: 0,
        payments_created: 0,
        skipped: 0,
    };

    for doc in &docs {
        let doc_ref = doc.doc_ref.trim();
        if doc_ref.is_empty() {
            record_sync_issue(
                pool,
                "open_docs",
                None,
                "error",
                "Open doc skipped: missing required doc_ref",
            )
            .await;
            summary.skipped += 1;
            continue;
        }

        if existing_doc_refs.contains(doc_ref) {
            summary.transactions_skipped_existing += 1;
            continue;
        }

        let customer_id: Option<Uuid> = doc
            .cust_no
            .as_deref()
            .and_then(|c| customer_id_map.get(c.trim()))
            .copied();
        if let Some(cust_no) = doc
            .cust_no
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            if customer_id.is_some() {
                resolve_sync_issue_by_key(pool, "open_docs", doc_ref).await;
            } else {
                record_sync_issue(
                    pool,
                    "open_docs",
                    Some(doc_ref),
                    "warning",
                    &format!("Customer unresolved: CUST_NO {cust_no} was not found in ROS"),
                )
                .await;
            }
        }

        let booked_at = doc
            .booked_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        let normalized_amount_paid =
            sum_counterpoint_open_doc_tenders(&doc.payments).unwrap_or(doc.amount_paid);
        let balance = doc.total_price - normalized_amount_paid;
        let status = order_status_for_cp_open_doc(
            doc.cp_status.as_deref(),
            doc.total_price,
            normalized_amount_paid,
        );

        let processed_by = doc
            .usr_id
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();
        let salesperson = doc
            .sls_rep
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();

        if doc.lines.is_empty() {
            record_sync_issue(
                pool,
                "open_docs",
                Some(doc_ref),
                "warning",
                "Open doc skipped: no line items in payload",
            )
            .await;
            summary.skipped += 1;
            continue;
        }

        let mut resolved_lines: Vec<(Uuid, Uuid)> = Vec::with_capacity(doc.lines.len());
        let mut line_vendor_refs: Vec<Option<String>> = Vec::with_capacity(doc.lines.len());
        let mut unresolved_count = 0;
        let mut skipped_doc = false;

        for line in &doc.lines {
            if let Some(pair) = resolve_variant_from_cache(&variant_cache, line) {
                resolved_lines.push(pair);
                line_vendor_refs.push(None);
            } else {
                let pair = if let Some(p) = fallback_pair {
                    p
                } else {
                    match ensure_historical_fallback_variant(&mut tx).await {
                        Ok(p) => {
                            fallback_pair = Some(p);
                            p
                        }
                        Err(e) => {
                            record_sync_issue(
                                pool,
                                "open_docs",
                                Some(doc_ref),
                                "error",
                                &format!(
                                    "Open doc skipped: failed to ensure fallback variant: {e}"
                                ),
                            )
                            .await;
                            skipped_doc = true;
                            break;
                        }
                    }
                };
                resolved_lines.push(pair);

                let sku = line.sku.as_deref().unwrap_or("").trim();
                let cp_key = line.counterpoint_item_key.as_deref().unwrap_or(sku).trim();
                let item_key = if cp_key.is_empty() { sku } else { cp_key };
                line_vendor_refs.push(Some(item_key.to_string()));
                unresolved_count += 1;
            }
        }
        if skipped_doc {
            summary.skipped += 1;
            continue;
        }
        if unresolved_count > 0 {
            sqlx::query(
                r#"
                UPDATE counterpoint_sync_issue
                SET resolved = TRUE, resolved_at = NOW()
                WHERE entity = 'open_docs'
                  AND external_key = $1
                  AND NOT resolved
                  AND message LIKE 'Open doc skipped: unresolved line item SKU%'
                "#,
            )
            .bind(doc_ref)
            .execute(pool)
            .await?;

            record_sync_issue(
                pool,
                "open_docs",
                Some(doc_ref),
                "warning",
                &format!("Mapped {unresolved_count} unresolved line item(s) to fallback"),
            )
            .await;
        }

        let transaction_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO transactions (
                customer_id, counterpoint_ticket_ref, counterpoint_doc_ref,
                is_counterpoint_import,
                status, booked_at, business_date, total_price, amount_paid, balance_due,
                processed_by_staff_id, primary_salesperson_id
            )
            VALUES (
                $1, NULL, $2, TRUE, $3::order_status, $4,
                ($4 AT TIME ZONE reporting.effective_store_timezone())::date,
                $5, $6, $7, $8, $9
            )
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(doc_ref)
        .bind(status)
        .bind(booked_at)
        .bind(doc.total_price)
        .bind(normalized_amount_paid)
        .bind(balance)
        .bind(processed_by)
        .bind(salesperson)
        .fetch_one(&mut *tx)
        .await?;
        summary.transactions_created += 1;
        if unresolved_count > 0 {
            fallback_exceptions.push((doc_ref.to_string(), transaction_id, unresolved_count));
        }

        let fulfillment = fulfillment_type_for_cp_doc_typ(doc.doc_typ.as_deref());

        for (((variant_id, product_id), line), vendor_ref) in resolved_lines
            .iter()
            .zip(doc.lines.iter())
            .zip(line_vendor_refs.iter())
        {
            let cost = line.unit_cost.unwrap_or(Decimal::ZERO);

            sqlx::query(
                r#"
                INSERT INTO transaction_lines (
                    transaction_id, product_id, variant_id, salesperson_id, fulfillment,
                    quantity, unit_price, unit_cost,
                    state_tax, local_tax, applied_spiff, calculated_commission,
                    counterpoint_reason_code, size_specs, vendor_reference,
                    order_lifecycle_status, ready_for_pickup_at, ready_for_pickup_by
                )
                VALUES (
                    $1, $2, $3, $4, $5::fulfillment_type, $6, $7, $8, 0, 0, 0, 0,
                    $9, $10, $11, 'ready_for_pickup'::order_item_lifecycle_status, $12, $13
                )
                "#,
            )
            .bind(transaction_id)
            .bind(product_id)
            .bind(variant_id)
            .bind(salesperson)
            .bind(fulfillment)
            .bind(line.quantity)
            .bind(line.unit_price)
            .bind(cost)
            .bind(line.reason_code.as_deref())
            .bind(serde_json::json!({
                "counterpoint_description": line.description.as_deref(),
                "counterpoint_sku": line.sku.as_deref(),
                "counterpoint_item_key": line.counterpoint_item_key.as_deref(),
                "counterpoint_line_sequence": line.lin_seq_no,
            }))
            .bind(vendor_ref.as_deref())
            .bind(booked_at)
            .bind(processed_by.or(salesperson))
            .execute(&mut *tx)
            .await?;
            summary.line_items_created += 1;
        }

        for pmt in &doc.payments {
            let method = resolve_counterpoint_payment_method(
                pool,
                &pmt_map,
                "open_docs",
                doc_ref,
                &pmt.pmt_typ,
            )
            .await;

            let txn_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    payer_id, category, payment_method, amount, created_at, effective_date, metadata
                )
                VALUES (
                    $1, 'retail_sale', $2, $3, $4,
                    ($4 AT TIME ZONE reporting.effective_store_timezone())::date,
                    $5
                )
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(&method)
            .bind(pmt.amount)
            .bind(booked_at)
            .bind(serde_json::json!({
                "counterpoint_pmt_typ": pmt.pmt_typ.trim(),
                "counterpoint_doc_ref": doc_ref,
                "counterpoint_gift_cert_no": pmt.gift_cert_no.as_deref(),
            }))
            .fetch_one(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(transaction_id)
            .bind(pmt.amount)
            .execute(&mut *tx)
            .await?;
            summary.payments_created += 1;
        }
    }

    tx.commit().await?;

    for (doc_ref, transaction_id, unresolved_count) in fallback_exceptions {
        record_counterpoint_import_exception(
            pool,
            "open_docs",
            Some(&doc_ref),
            "warning",
            "fallback_item_landed",
            &format!(
                "{unresolved_count} open-doc line item(s) landed with Counterpoint Import Item fallback."
            ),
            Some("Map the source item to a ROS variant or keep this Counterpoint Import Item as review-visible obligation proof."),
            true,
            Some("transactions"),
            Some(transaction_id),
            serde_json::json!({
                "counterpoint_doc_ref": doc_ref,
                "unresolved_line_count": unresolved_count,
                "fallback_sku": HISTORICAL_FALLBACK_SKU,
            }),
        )
        .await;
    }

    if let Some(ref s) = payload.sync {
        if s.entity == "open_docs" {
            let _ = record_sync_run(
                pool,
                "open_docs",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.transactions_created
                        + summary.transactions_skipped_existing
                        + summary.skipped,
                ),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Vendor ingest (Counterpoint `PO_VEND` / legacy `AP_VEND` → `vendors`)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorRow {
    pub vend_no: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub account_number: Option<String>,
    /// Counterpoint `TERMS_COD` — payment terms, not the AP account number.
    #[serde(default)]
    pub payment_terms: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorsPayload {
    pub rows: Vec<CounterpointVendorRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct VendorSyncSummary {
    pub created: i32,
    pub updated: i32,
    pub skipped: i32,
}

pub async fn execute_counterpoint_vendor_batch(
    pool: &PgPool,
    payload: CounterpointVendorsPayload,
) -> Result<VendorSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = VendorSyncSummary {
        created: 0,
        updated: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let vend_no = row.vend_no.trim();
        if vend_no.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let name = allocate_unique_vendor_display_name(&mut tx, &row.name, vend_no).await?;

        let email = trim_opt(&row.email);
        let phone = trim_opt(&row.phone);
        let account_number = trim_opt(&row.account_number);
        let payment_terms = trim_opt(&row.payment_terms).map(|p| clamp_chars(&p, 500));

        let existing: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM vendors WHERE vendor_code = $1")
                .bind(vend_no)
                .fetch_optional(&mut *tx)
                .await?;

        if let Some(vid) = existing {
            sqlx::query(
                "UPDATE vendors SET name = $2, email = COALESCE($3, email), phone = COALESCE($4, phone), account_number = COALESCE($5, account_number), payment_terms = COALESCE($6, payment_terms) WHERE id = $1",
            )
            .bind(vid)
            .bind(&name)
            .bind(&email)
            .bind(&phone)
            .bind(&account_number)
            .bind(&payment_terms)
            .execute(&mut *tx)
            .await?;
            summary.updated += 1;
        } else {
            sqlx::query(
                "INSERT INTO vendors (name, vendor_code, email, phone, account_number, payment_terms, is_active, use_vendor_upc) VALUES ($1, $2, $3, $4, $5, $6, true, false)",
            )
            .bind(&name)
            .bind(vend_no)
            .bind(&email)
            .bind(&phone)
            .bind(&account_number)
            .bind(&payment_terms)
            .execute(&mut *tx)
            .await?;
            summary.created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "vendors" {
            let _ = record_sync_run(
                pool,
                "vendors",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Customer notes ingest (AR_CUST_NOTE → customer_timeline_notes)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointCustomerNoteRow {
    pub cust_no: String,
    pub note_id: String,
    #[serde(default)]
    pub note_date: Option<String>,
    pub note_text: String,
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCustomerNotesPayload {
    pub rows: Vec<CounterpointCustomerNoteRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CustomerNotesSyncSummary {
    pub created: i32,
    pub skipped_no_customer: i32,
    pub skipped_duplicate: i32,
}

pub async fn execute_counterpoint_customer_notes_batch(
    pool: &PgPool,
    payload: CounterpointCustomerNotesPayload,
) -> Result<CustomerNotesSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = CustomerNotesSyncSummary {
        created: 0,
        skipped_no_customer: 0,
        skipped_duplicate: 0,
    };

    for row in &payload.rows {
        let cust_no = row.cust_no.trim();
        if cust_no.is_empty() || row.note_text.trim().is_empty() {
            summary.skipped_no_customer += 1;
            continue;
        }

        let customer_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
                .bind(cust_no)
                .fetch_optional(&mut *tx)
                .await?;

        let Some(cid) = customer_id else {
            summary.skipped_no_customer += 1;
            continue;
        };

        let tag = format!("[CP:{}]", row.note_id.trim());
        let body = format!(
            "{} {}\n{}",
            tag,
            row.user_id.as_deref().unwrap_or(""),
            row.note_text.trim()
        );

        let already: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM customer_timeline_notes WHERE customer_id = $1 AND body LIKE $2)",
        )
        .bind(cid)
        .bind(format!("{tag}%"))
        .fetch_one(&mut *tx)
        .await?;

        if already {
            summary.skipped_duplicate += 1;
            continue;
        }

        let ts = row
            .note_date
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        sqlx::query(
            "INSERT INTO customer_timeline_notes (customer_id, body, created_at) VALUES ($1, $2, $3)",
        )
        .bind(cid)
        .bind(&body)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
        summary.created += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "customer_notes" {
            let _ = record_sync_run(
                pool,
                "customer_notes",
                s.cursor.as_deref(),
                true,
                Some(summary.created),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Staff ingest (SY_USR + PS_SLS_REP → staff + counterpoint_staff_map)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointStaffRow {
    /// The CP identifier (USR_ID or SLS_REP code).
    pub code: String,
    /// "user", "sales_rep", or "buyer".
    #[serde(default = "default_staff_source")]
    pub source: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub commission_rate: Option<Decimal>,
    /// Counterpoint STAT: "A" = active, "I" = inactive.
    #[serde(default)]
    pub status: Option<String>,
    /// SY_USR.USR_GRP_ID — used for role hint (e.g. "MGR" → admin).
    #[serde(default)]
    pub user_group: Option<String>,
}

fn default_staff_source() -> String {
    "user".to_string()
}

#[derive(Debug, Deserialize)]
pub struct CounterpointStaffPayload {
    pub rows: Vec<CounterpointStaffRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct StaffSyncSummary {
    pub created: i32,
    pub updated: i32,
    pub merged: i32,
    pub skipped: i32,
}

fn cp_role_hint(source: &str, user_group: Option<&str>) -> &'static str {
    if let Some(g) = user_group {
        let g = g.trim().to_uppercase();
        if g.contains("MGR") || g.contains("MANAGER") || g.contains("ADMIN") || g.contains("OWNER")
        {
            return "admin";
        }
    }
    match source {
        "sales_rep" => "salesperson",
        "buyer" => "sales_support",
        _ => "sales_support",
    }
}

fn make_cashier_code(code: &str) -> String {
    let trimmed = code.trim();
    let candidate = format!("CP{trimmed}");
    if candidate.len() <= 10 {
        candidate
    } else {
        candidate[..10].to_string()
    }
}

pub async fn execute_counterpoint_staff_batch(
    pool: &PgPool,
    payload: CounterpointStaffPayload,
) -> Result<StaffSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = StaffSyncSummary {
        created: 0,
        updated: 0,
        merged: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let code = row.code.trim();
        if code.is_empty() {
            summary.skipped += 1;
            continue;
        }
        let source = row.source.trim();
        let source = if source.is_empty() { "user" } else { source };

        let name = trim_opt(&row.name).unwrap_or_else(|| code.to_string());
        let name = clamp_chars(&name, 255);
        let email = trim_opt(&row.email).map(|e| clamp_chars(&e, 255));
        let is_active = row
            .status
            .as_deref()
            .map(|s| s.trim().to_uppercase() != "I")
            .unwrap_or(true);
        let commission = row.commission_rate.unwrap_or(Decimal::ZERO);
        let role = cp_role_hint(source, row.user_group.as_deref());

        let existing_map: Option<Uuid> = sqlx::query_scalar(
            "SELECT ros_staff_id FROM counterpoint_staff_map WHERE cp_code = $1 AND cp_source = $2",
        )
        .bind(code)
        .bind(source)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(staff_id) = existing_map {
            sqlx::query(
                r#"
                UPDATE staff SET
                    full_name = $2,
                    email = COALESCE($3, email),
                    base_commission_rate = $4,
                    is_active = $5
                WHERE id = $1
                "#,
            )
            .bind(staff_id)
            .bind(&name)
            .bind(&email)
            .bind(commission)
            .bind(is_active)
            .execute(&mut *tx)
            .await?;
            summary.updated += 1;
            continue;
        }

        let name_match: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM staff WHERE lower(trim(full_name)) = lower(trim($1))",
        )
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(staff_id) = name_match {
            let cp_usr = if source == "user" { Some(code) } else { None };
            let cp_sls = if source == "sales_rep" {
                Some(code)
            } else {
                None
            };
            sqlx::query(
                r#"
                UPDATE staff SET
                    counterpoint_user_id = COALESCE($2, counterpoint_user_id),
                    counterpoint_sls_rep = COALESCE($3, counterpoint_sls_rep),
                    data_source = COALESCE(data_source, 'counterpoint'),
                    email = COALESCE($4, email),
                    base_commission_rate = CASE WHEN $5 > 0 THEN $5 ELSE base_commission_rate END,
                    is_active = $6
                WHERE id = $1
                "#,
            )
            .bind(staff_id)
            .bind(cp_usr)
            .bind(cp_sls)
            .bind(&email)
            .bind(commission)
            .bind(is_active)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id) VALUES ($1, $2, $3) ON CONFLICT (cp_code, cp_source) DO NOTHING",
            )
            .bind(code)
            .bind(source)
            .bind(staff_id)
            .execute(&mut *tx)
            .await?;
            summary.merged += 1;
            continue;
        }

        let cashier_code = make_cashier_code(code);
        let code_conflict: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                .bind(&cashier_code)
                .fetch_one(&mut *tx)
                .await?;
        if code_conflict {
            record_sync_issue(
                pool,
                "staff",
                Some(code),
                "warning",
                &format!("Cashier code '{cashier_code}' already taken; staff '{name}' skipped"),
            )
            .await;
            summary.skipped += 1;
            continue;
        }

        let cp_usr = if source == "user" {
            Some(code.to_string())
        } else {
            None
        };
        let cp_sls = if source == "sales_rep" {
            Some(code.to_string())
        } else {
            None
        };

        let insert_result: Result<Uuid, sqlx::Error> = sqlx::query_scalar(
            r#"
            INSERT INTO staff (
                full_name, cashier_code, role, base_commission_rate,
                is_active, email, data_source, counterpoint_user_id, counterpoint_sls_rep
            )
            VALUES ($1, $2, $3::staff_role, $4, $5, $6, 'counterpoint', $7, $8)
            RETURNING id
            "#,
        )
        .bind(&name)
        .bind(&cashier_code)
        .bind(role)
        .bind(commission)
        .bind(is_active)
        .bind(&email)
        .bind(&cp_usr)
        .bind(&cp_sls)
        .fetch_one(&mut *tx)
        .await;

        let staff_id: Uuid = match insert_result {
            Ok(sid) => sid,
            Err(e) => {
                record_sync_issue(pool, "staff", Some(code), "error", &e.to_string()).await;
                summary.skipped += 1;
                continue;
            }
        };

        sqlx::query(
            "INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id) VALUES ($1, $2, $3)",
        )
        .bind(code)
        .bind(source)
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;
        summary.created += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "staff" {
            let _ = record_sync_run(
                pool,
                "staff",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated + summary.merged),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// SLS_REP stubs (when PS_SLS_REP is not visible — distinct codes from AR_CUST / PS_TKT_HIST)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointSlsRepStubPayload {
    #[serde(default)]
    pub codes: Vec<String>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct SlsRepStubSummary {
    pub created: i32,
    pub skipped_already_mapped: i32,
    pub skipped_empty: i32,
    pub skipped_cashier_conflict: i32,
}

/// Creates minimal `staff` + `counterpoint_staff_map` rows for `SLS_REP` codes not present in the map.
/// Skips any `cp_code` already mapped (e.g. SY_USR) to avoid duplicate identities.
pub async fn execute_counterpoint_sls_rep_stub_batch(
    pool: &PgPool,
    payload: CounterpointSlsRepStubPayload,
) -> Result<SlsRepStubSummary, CounterpointSyncError> {
    let mut summary = SlsRepStubSummary {
        created: 0,
        skipped_already_mapped: 0,
        skipped_empty: 0,
        skipped_cashier_conflict: 0,
    };

    if payload.codes.is_empty() {
        return Ok(summary);
    }

    let mut tx = pool.begin().await?;

    for raw in &payload.codes {
        let code = raw.trim();
        if code.is_empty() {
            summary.skipped_empty += 1;
            continue;
        }

        let already: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM counterpoint_staff_map WHERE cp_code = $1)",
        )
        .bind(code)
        .fetch_one(&mut *tx)
        .await?;
        if already {
            summary.skipped_already_mapped += 1;
            continue;
        }

        let name = clamp_chars(&format!("Counterpoint rep {code}"), 255);
        let role = cp_role_hint("sales_rep", None);
        let cashier_code = make_cashier_code(code);
        let code_conflict: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                .bind(&cashier_code)
                .fetch_one(&mut *tx)
                .await?;
        if code_conflict {
            record_sync_issue(
                pool,
                "sales_rep_stubs",
                Some(code),
                "warning",
                &format!(
                    "Cashier code '{cashier_code}' already taken; SLS_REP '{code}' stub skipped"
                ),
            )
            .await;
            summary.skipped_cashier_conflict += 1;
            continue;
        }

        let insert_result: Result<Uuid, sqlx::Error> = sqlx::query_scalar(
            r#"
            INSERT INTO staff (
                full_name, cashier_code, role, base_commission_rate,
                is_active, email, data_source, counterpoint_user_id, counterpoint_sls_rep
            )
            VALUES ($1, $2, $3::staff_role, 0, TRUE, NULL, 'counterpoint', NULL, $4)
            RETURNING id
            "#,
        )
        .bind(&name)
        .bind(&cashier_code)
        .bind(role)
        .bind(code)
        .fetch_one(&mut *tx)
        .await;

        let staff_id = match insert_result {
            Ok(sid) => sid,
            Err(e) => {
                record_sync_issue(pool, "sales_rep_stubs", Some(code), "error", &e.to_string())
                    .await;
                summary.skipped_cashier_conflict += 1;
                continue;
            }
        };

        sqlx::query(
            "INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id) VALUES ($1, 'sales_rep', $2)",
        )
        .bind(code)
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;
        summary.created += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "sales_rep_stubs" {
            let _ = record_sync_run(
                pool,
                "sales_rep_stubs",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.created
                        + summary.skipped_already_mapped
                        + summary.skipped_empty
                        + summary.skipped_cashier_conflict,
                ),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Loyalty history (PS_LOY_PTS_HIST → loyalty_point_ledger)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointLoyaltyHistRow {
    pub cust_no: String,
    #[serde(default)]
    pub bus_dat: Option<String>,
    #[serde(default)]
    pub pts_earnd: Option<i32>,
    #[serde(default)]
    pub pts_redeemd: Option<i32>,
    #[serde(default)]
    pub ref_no: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointLoyaltyHistPayload {
    pub rows: Vec<CounterpointLoyaltyHistRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct LoyaltyHistSyncSummary {
    pub inserted: i32,
    pub skipped: i32,
}

fn parse_cp_loyalty_bus_dat(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(12, 0, 0))
        .map(|nd| nd.and_utc())
}

pub async fn execute_counterpoint_loyalty_hist_batch(
    pool: &PgPool,
    payload: CounterpointLoyaltyHistPayload,
) -> Result<LoyaltyHistSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut rows = payload.rows;
    rows.sort_by(|a, b| {
        a.cust_no
            .trim()
            .cmp(b.cust_no.trim())
            .then_with(|| a.bus_dat.cmp(&b.bus_dat))
            .then_with(|| a.ref_no.cmp(&b.ref_no))
    });

    let mut tx = pool.begin().await?;
    let mut summary = LoyaltyHistSyncSummary {
        inserted: 0,
        skipped: 0,
    };

    // Sum of (earned − redeemed) per customer in this batch. With `customers.loyalty_points` from AR_CUST,
    // opening = balance_now − sum(batch) so partial `PS_LOY_PTS_HIST` since CP_IMPORT_SINCE chains to CP balance.
    let mut sum_by_cust: HashMap<String, i32> = HashMap::new();
    for row in &rows {
        let cn = row.cust_no.trim();
        if cn.is_empty() {
            continue;
        }
        let earnd = row.pts_earnd.unwrap_or(0);
        let redeemd = row.pts_redeemd.unwrap_or(0);
        let delta = earnd - redeemd;
        if delta == 0 {
            continue;
        }
        *sum_by_cust.entry(cn.to_string()).or_insert(0) += delta;
    }

    let cust_codes: Vec<String> = rows
        .iter()
        .filter_map(|r| {
            let s = r.cust_no.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    // 1. Batch resolve customer IDs
    let customer_id_map: HashMap<String, Uuid> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, Uuid)>(
            "SELECT customer_code, id FROM customers WHERE customer_code = ANY($1)",
        )
        .bind(&cust_codes[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    // 1b. Batch fetch current loyalty points from customers for opening balance logic
    let loyalty_by_code: HashMap<String, i32> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, i32)>(
            "SELECT customer_code, COALESCE(loyalty_points, 0)::int FROM customers WHERE customer_code = ANY($1)",
        )
        .bind(&cust_codes[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    // 2. Batch check for duplicates in one query
    let mut cp_refs = Vec::with_capacity(rows.len());
    for row in &rows {
        let cust_no = row.cust_no.trim();
        if cust_no.is_empty() {
            continue;
        }
        let date_part = row
            .bus_dat
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("_");
        let ref_part = row.ref_no.as_deref().map(str::trim).unwrap_or("");
        cp_refs.push(format!("{cust_no}|{date_part}|{ref_part}"));
    }

    let existing_refs: HashSet<String> = if cp_refs.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT (metadata->>'cp_ref') FROM loyalty_point_ledger WHERE reason = 'cp_loy_pts_hist' AND (metadata->>'cp_ref') = ANY($1)"
        )
        .bind(&cp_refs[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    // 3. Batch fetch latest balances for all customers in this chunk
    let mut current_balances: HashMap<Uuid, i32> = if customer_id_map.is_empty() {
        HashMap::new()
    } else {
        let ids: Vec<Uuid> = customer_id_map.values().cloned().collect();
        sqlx::query_as::<_, (Uuid, i32)>(
            r#"
            SELECT DISTINCT ON (customer_id) customer_id, balance_after
            FROM loyalty_point_ledger
            WHERE customer_id = ANY($1)
            ORDER BY customer_id, created_at DESC, id DESC
            "#,
        )
        .bind(&ids[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    for row in &rows {
        let cust_no = row.cust_no.trim();
        if cust_no.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let cid = match customer_id_map.get(cust_no) {
            Some(id) => *id,
            None => {
                summary.skipped += 1;
                continue;
            }
        };

        let earnd = row.pts_earnd.unwrap_or(0);
        let redeemd = row.pts_redeemd.unwrap_or(0);
        let delta = earnd - redeemd;
        if delta == 0 {
            summary.skipped += 1;
            continue;
        }

        let date_part = row
            .bus_dat
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("_");
        let ref_part = row.ref_no.as_deref().map(str::trim).unwrap_or("");
        let cp_ref = format!("{cust_no}|{date_part}|{ref_part}");

        if existing_refs.contains(&cp_ref) {
            summary.skipped += 1;
            continue;
        }

        let prev = match current_balances.get(&cid) {
            Some(b) => *b,
            None => {
                let cp_bal = loyalty_by_code.get(cust_no).copied().unwrap_or(0);
                let sum_d = sum_by_cust.get(cust_no).copied().unwrap_or(0);
                cp_bal.checked_sub(sum_d).unwrap_or(0)
            }
        };

        let bal_after = prev + delta;
        current_balances.insert(cid, bal_after); // Update "moving" balance for next row in this batch

        let meta = serde_json::json!({
            "cp_ref": cp_ref,
            "source": "ps_loy_pts_hist",
            "pts_earnd": earnd,
            "pts_redeemd": redeemd,
        });

        sqlx::query(
            r#"
            INSERT INTO loyalty_point_ledger (
                customer_id, delta_points, balance_after, reason, metadata, created_at
            )
            VALUES ($1, $2, $3, 'cp_loy_pts_hist', $4, COALESCE($5::timestamptz, CURRENT_TIMESTAMP))
            "#,
        )
        .bind(cid)
        .bind(delta)
        .bind(bal_after)
        .bind(meta)
        .bind(parse_cp_loyalty_bus_dat(row.bus_dat.as_deref()))
        .execute(&mut *tx)
        .await?;
        summary.inserted += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "loyalty_hist" {
            let _ = record_sync_run(
                pool,
                "loyalty_hist",
                s.cursor.as_deref(),
                true,
                Some(summary.inserted + summary.skipped),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Vendor item cross-ref (PO_VEND_ITEM → vendor_supplier_item)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorItemRow {
    pub vend_no: String,
    pub item_no: String,
    #[serde(default)]
    pub vend_item_no: Option<String>,
    #[serde(default)]
    pub vend_cost: Option<Decimal>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorItemsPayload {
    pub rows: Vec<CounterpointVendorItemRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct VendorItemSyncSummary {
    pub upserted: i32,
    pub skipped: i32,
}

pub async fn execute_counterpoint_vendor_item_batch(
    pool: &PgPool,
    payload: CounterpointVendorItemsPayload,
) -> Result<VendorItemSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = VendorItemSyncSummary {
        upserted: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let vend_no = row.vend_no.trim();
        let item_no = row.item_no.trim();
        if vend_no.is_empty() || item_no.is_empty() {
            summary.skipped += 1;
            continue;
        }
        let vendor_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM vendors WHERE vendor_code = $1")
                .bind(vend_no)
                .fetch_optional(&mut *tx)
                .await?;

        let Some(vid) = vendor_id else {
            summary.skipped += 1;
            continue;
        };

        let v_item = row
            .vend_item_no
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let variant_id = resolve_variant_for_cp_item_no(&mut tx, item_no).await?;

        sqlx::query(
            r#"
            INSERT INTO vendor_supplier_item (
                vendor_id, cp_item_no, vendor_item_no, vend_cost, variant_id
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT ON CONSTRAINT vendor_supplier_item_vendor_item_uidx
            DO UPDATE SET
                vend_cost = COALESCE(EXCLUDED.vend_cost, vendor_supplier_item.vend_cost),
                variant_id = COALESCE(EXCLUDED.variant_id, vendor_supplier_item.variant_id),
                updated_at = now()
            "#,
        )
        .bind(vid)
        .bind(item_no)
        .bind(v_item)
        .bind(row.vend_cost)
        .bind(variant_id)
        .execute(&mut *tx)
        .await?;
        summary.upserted += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "vendor_items" {
            let _ = record_sync_run(
                pool,
                "vendor_items",
                s.cursor.as_deref(),
                true,
                Some(summary.upserted + summary.skipped),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

/// Resolve a Counterpoint user ID or sales rep code to a ROS `staff.id`.
pub async fn resolve_staff_id(pool: &PgPool, cp_code: Option<&str>) -> Option<Uuid> {
    let code = cp_code?.trim();
    if code.is_empty() {
        return None;
    }
    sqlx::query_scalar("SELECT ros_staff_id FROM counterpoint_staff_map WHERE cp_code = $1 LIMIT 1")
        .bind(code)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}
async fn ensure_historical_fallback_variant(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(Uuid, Uuid), sqlx::Error> {
    let existing: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT id, product_id FROM product_variants WHERE sku = $1")
            .bind(HISTORICAL_FALLBACK_SKU)
            .fetch_optional(&mut **tx)
            .await?;

    if let Some(ids) = existing {
        return Ok(ids);
    }

    // Create a special category for fallbacks
    let category_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO categories (name, is_clothing_footwear)
        VALUES ('Historical Fallbacks', false)
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .fetch_one(&mut **tx)
    .await?;

    let product_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO products (
            catalog_handle, name, brand, category_id,
            base_retail_price, base_cost, spiff_amount, is_active
        )
        VALUES ($1, $2, 'Counterpoint History', $3, 0, 0, 0, true)
        ON CONFLICT (catalog_handle) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .bind(HISTORICAL_FALLBACK_SKU)
    .bind(HISTORICAL_FALLBACK_NAME)
    .bind(category_id)
    .fetch_one(&mut **tx)
    .await?;

    let variant_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO product_variants (
            product_id, sku, variation_values, variation_label, stock_on_hand
        )
        VALUES ($1, $2, '{}'::jsonb, 'Standard', 0)
        ON CONFLICT (sku) DO UPDATE SET sku = EXCLUDED.sku
        RETURNING id
        "#,
    )
    .bind(product_id)
    .bind(HISTORICAL_FALLBACK_SKU)
    .fetch_one(&mut **tx)
    .await?;

    Ok((variant_id, product_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::pins::hash_pin;
    use chrono::{Duration, NaiveDate, Utc};
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use uuid::Uuid;

    static SNAPSHOT_RECONCILIATION_TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());
    static COUNTERPOINT_HEALTH_TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

    async fn connect_test_db() -> PgPool {
        let _ =
            dotenvy::from_filename(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for DB-backed tests");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let _ = sqlx::query(
            r#"
            SELECT setval(
                COALESCE(pg_get_serial_sequence('public.counterpoint_payment_method_map', 'id'), 'public.counterpoint_payment_method_map_id_seq'),
                COALESCE(max(id), 1)
            ) FROM public.counterpoint_payment_method_map;
            "#
        )
        .execute(&pool)
        .await;

        pool
    }

    async fn next_staff_code(pool: &PgPool) -> String {
        for _ in 0..128 {
            let candidate = format!("{:04}", (Uuid::new_v4().as_u128() % 10_000) as u16);
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                    .bind(&candidate)
                    .fetch_one(pool)
                    .await
                    .expect("check cashier_code uniqueness");
            if !exists {
                return candidate;
            }
        }
        panic!("could not allocate unique 4-digit cashier code for test staff");
    }

    #[test]
    fn customer_payload_accepts_numeric_ar_balance() {
        let payload: CounterpointCustomersPayload = serde_json::from_value(serde_json::json!({
            "rows": [{
                "cust_no": "10026",
                "first_name": "Gerald",
                "last_name": "Abelson",
                "loyalty_points": 0,
                "ar_balance": 0
            }]
        }))
        .expect("deserialize customer payload with numeric AR balance");

        assert_eq!(payload.rows[0].ar_balance.as_deref(), Some("0"));
    }

    fn realistic_import_preflight_counts() -> Vec<CounterpointImportSourceCountPayload> {
        vec![
            ("customers", "Counterpoint customers", 26_579, true, None),
            (
                "catalog_products",
                "Catalog parent products",
                3_573,
                true,
                None,
            ),
            (
                "catalog_variants",
                "Catalog variants/SKUs",
                369_295,
                true,
                None,
            ),
            (
                "inventory_quantity_rows",
                "Inventory quantity rows",
                372_433,
                true,
                None,
            ),
            (
                "tickets",
                "Closed ticket history",
                25_000,
                true,
                Some(1_000),
            ),
            ("ticket_lines", "Closed ticket lines", 80_000, true, None),
            (
                "ticket_payments",
                "Closed ticket payments",
                25_000,
                false,
                None,
            ),
            (
                "receiving_history",
                "Receiving/movement history",
                3_000,
                true,
                None,
            ),
            (
                "open_docs",
                "Open docs/unfulfilled obligations",
                325,
                true,
                Some(100),
            ),
            ("open_doc_lines", "Open-doc lines", 650, true, None),
            (
                "open_doc_payments",
                "Open-doc deposits/payments",
                280,
                false,
                None,
            ),
            (
                "gift_cards",
                "Gift card current balances",
                1_145,
                true,
                None,
            ),
            (
                "loyalty_points",
                "Customer loyalty balances",
                26_579,
                true,
                None,
            ),
        ]
        .into_iter()
        .map(
            |(entity_key, label, source_count, required, suspicious_min_count)| {
                CounterpointImportSourceCountPayload {
                    entity_key: entity_key.to_string(),
                    label: label.to_string(),
                    source_count,
                    source_sum: None,
                    source_checksum: None,
                    query_key: Some(entity_key.to_string()),
                    required,
                    suspicious_min_count,
                    status: Some("ok".into()),
                    message: None,
                    metadata: serde_json::json!({}),
                }
            },
        )
        .collect()
    }

    #[tokio::test]
    async fn counterpoint_import_preflight_blocks_suspicious_low_ticket_and_open_doc_counts() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        ensure_counterpoint_import_first_tables(&pool).await;
        let mut counts = realistic_import_preflight_counts();
        for row in &mut counts {
            if row.entity_key == "tickets" {
                row.source_count = 57;
            }
            if row.entity_key == "ticket_lines" || row.entity_key == "ticket_payments" {
                row.source_count = 0;
            }
            if row.entity_key == "open_docs" {
                row.source_count = 39;
            }
        }

        let summary = record_counterpoint_import_preflight(
            &pool,
            CounterpointImportPreflightPayload {
                history_start: Some("2018-01-01".into()),
                bridge_hostname: Some("test-bridge".into()),
                bridge_version: Some("test".into()),
                ros_base_url: Some("http://127.0.0.1:3000".into()),
                source_fingerprint: Some("test-low-counts".into()),
                import_first: true,
                staging_enabled: false,
                dry_run: false,
                startup_issues: vec![],
                counts,
                metadata: serde_json::json!({ "test": true }),
            },
        )
        .await
        .expect("record preflight");

        assert!(!summary.preflight_passed);
        assert!(summary
            .blockers
            .iter()
            .any(|blocker| blocker.entity_key.as_deref() == Some("tickets")
                && blocker.reason_code == "suspicious_low_source_count"));
        assert!(summary
            .blockers
            .iter()
            .any(|blocker| blocker.entity_key.as_deref() == Some("open_docs")
                && blocker.reason_code == "suspicious_low_source_count"));

        sqlx::query("DELETE FROM counterpoint_import_runs WHERE id = $1")
            .bind(summary.import_run_id)
            .execute(&pool)
            .await
            .expect("cleanup preflight run");
    }

    #[tokio::test]
    async fn counterpoint_import_preflight_allows_low_ticket_headers_when_details_exist() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        ensure_counterpoint_import_first_tables(&pool).await;
        let mut counts = realistic_import_preflight_counts();
        for row in &mut counts {
            match row.entity_key.as_str() {
                "tickets" => row.source_count = 103,
                "ticket_lines" => row.source_count = 109_264,
                "ticket_payments" => row.source_count = 73_822,
                "open_docs" => row.source_count = 2_111,
                _ => {}
            }
        }

        let summary = record_counterpoint_import_preflight(
            &pool,
            CounterpointImportPreflightPayload {
                history_start: Some("2018-01-01".into()),
                bridge_hostname: Some("test-bridge".into()),
                bridge_version: Some("test".into()),
                ros_base_url: Some("http://127.0.0.1:3000".into()),
                source_fingerprint: Some("test-low-ticket-headers-detail-proof".into()),
                import_first: true,
                staging_enabled: false,
                dry_run: false,
                startup_issues: vec![],
                counts,
                metadata: serde_json::json!({ "test": true }),
            },
        )
        .await
        .expect("record preflight");

        assert!(summary.preflight_passed);
        assert!(summary.blockers.is_empty());
        let ticket_row = summary
            .counts
            .iter()
            .find(|row| row.entity_key == "tickets")
            .expect("ticket count row");
        assert_eq!(ticket_row.status, "warning");

        sqlx::query("DELETE FROM counterpoint_import_runs WHERE id = $1")
            .bind(summary.import_run_id)
            .execute(&pool)
            .await
            .expect("cleanup preflight run");
    }

    #[tokio::test]
    async fn counterpoint_import_preflight_passes_realistic_source_counts() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        ensure_counterpoint_import_first_tables(&pool).await;

        let summary = record_counterpoint_import_preflight(
            &pool,
            CounterpointImportPreflightPayload {
                history_start: Some("2018-01-01".into()),
                bridge_hostname: Some("test-bridge".into()),
                bridge_version: Some("test".into()),
                ros_base_url: Some("http://127.0.0.1:3000".into()),
                source_fingerprint: Some("test-realistic-counts".into()),
                import_first: true,
                staging_enabled: false,
                dry_run: false,
                startup_issues: vec![],
                counts: realistic_import_preflight_counts(),
                metadata: serde_json::json!({ "test": true }),
            },
        )
        .await
        .expect("record preflight");

        assert!(summary.preflight_passed);
        assert!(summary.blockers.is_empty());
        assert_eq!(summary.counts.len(), 13);

        sqlx::query("DELETE FROM counterpoint_import_runs WHERE id = $1")
            .bind(summary.import_run_id)
            .execute(&pool)
            .await
            .expect("cleanup preflight run");
    }

    #[tokio::test]
    async fn counterpoint_import_run_records_customer_raw_and_provenance() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        ensure_counterpoint_import_first_tables(&pool).await;
        let original_config = load_counterpoint_config(&pool).await;
        let unique = Uuid::new_v4().to_string();
        let customer_code = format!("CP-PROOF-{}", &unique[..8]);

        let preflight = record_counterpoint_import_preflight(
            &pool,
            CounterpointImportPreflightPayload {
                history_start: Some("2018-01-01".into()),
                bridge_hostname: Some("test-bridge".into()),
                bridge_version: Some("test".into()),
                ros_base_url: Some("http://127.0.0.1:3000".into()),
                source_fingerprint: Some(format!("proof-{unique}")),
                import_first: true,
                staging_enabled: false,
                dry_run: false,
                startup_issues: vec![],
                counts: realistic_import_preflight_counts(),
                metadata: serde_json::json!({ "test": true }),
            },
        )
        .await
        .expect("record preflight");

        let import_run = start_counterpoint_import_run(
            &pool,
            CounterpointImportRunStartPayload {
                preflight_import_run_id: Some(preflight.import_run_id),
                run_kind: Some("rehearsal".into()),
                bridge_hostname: Some("test-bridge".into()),
                bridge_version: Some("test".into()),
                ros_base_url: Some("http://127.0.0.1:3000".into()),
                source_fingerprint: Some(format!("proof-{unique}")),
            },
        )
        .await
        .expect("start import run");

        let payload_json = serde_json::json!({
            "rows": [{
                "cust_no": customer_code,
                "first_name": "Proof",
                "last_name": "Customer",
                "loyalty_points": 0
            }]
        });
        let typed_payload: CounterpointCustomersPayload =
            serde_json::from_value(payload_json.clone()).expect("customer payload");
        let summary = execute_counterpoint_customer_batch(&pool, typed_payload)
            .await
            .expect("execute customer batch");
        assert_eq!(summary.created + summary.updated, 1);

        let summary_json = serde_json::to_value(&summary).expect("summary json");
        let proof = record_counterpoint_import_batch_success(
            &pool,
            import_run.import_run_id,
            "customers",
            &payload_json,
            &summary_json,
        )
        .await
        .expect("record batch proof");

        assert_eq!(proof.raw_records, 1);
        assert_eq!(proof.landed_records, 1);
        assert_eq!(proof.provenance_records, 1);

        let provenance_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_import_provenance
            WHERE import_run_id = $1
              AND entity_key = 'customers'
              AND source_key = $2
              AND ros_table = 'customers'
            "#,
        )
        .bind(import_run.import_run_id)
        .bind(&customer_code)
        .fetch_one(&pool)
        .await
        .expect("load provenance count");
        assert_eq!(provenance_count, 1);

        let completed = complete_counterpoint_import_run(
            &pool,
            CounterpointImportRunCompletePayload {
                import_run_id: import_run.import_run_id,
                failed: false,
                error_message: None,
                totals: Some(serde_json::json!({ "customers": proof.raw_records })),
            },
        )
        .await
        .expect("complete import run");
        assert_eq!(completed.status, "completed");

        let command_center = build_counterpoint_import_command_center(&pool, true)
            .await
            .expect("build import command center");
        assert!(command_center.preflight_received);
        assert!(command_center.import_run_received);
        assert_eq!(command_center.proof_scope, "current_import_run");
        let customers_reconciliation = command_center
            .snapshot_reconciliation
            .iter()
            .find(|row| row.key == "customers")
            .expect("customers command-center reconciliation row");
        assert_eq!(customers_reconciliation.source_count, Some(26_579));
        assert_eq!(customers_reconciliation.landed_count, 1);
        assert!(!customers_reconciliation.passed);

        let _ = sqlx::query("DELETE FROM customers WHERE customer_code = $1")
            .bind(&customer_code)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM counterpoint_import_runs WHERE id = ANY($1)")
            .bind(&vec![preflight.import_run_id, import_run.import_run_id])
            .execute(&pool)
            .await;
        restore_counterpoint_config(&pool, original_config).await;
    }

    #[tokio::test]
    async fn counterpoint_customer_duplicate_email_lands_without_email_exception() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        ensure_counterpoint_import_first_tables(&pool).await;
        let unique = Uuid::new_v4().to_string();
        let suffix = &unique[..8];
        let existing_code = format!("CP-EMAIL-EXIST-{suffix}");
        let duplicate_code = format!("CP-EMAIL-DUPE-{suffix}");
        let clean_code = format!("CP-EMAIL-CLEAN-{suffix}");
        let shared_email = format!("cp-shared-{suffix}@example.com");
        let clean_email = format!("cp-clean-{suffix}@example.com");

        for code in [&existing_code, &duplicate_code, &clean_code] {
            let _ = sqlx::query("DELETE FROM counterpoint_import_exceptions WHERE source_key = $1")
                .bind(code)
                .execute(&pool)
                .await;
            let _ = sqlx::query("DELETE FROM customers WHERE customer_code = $1")
                .bind(code)
                .execute(&pool)
                .await;
        }

        sqlx::query(
            r#"
            INSERT INTO customers (
                customer_code, first_name, last_name, email, customer_created_source
            )
            VALUES ($1, 'Existing', 'Email Owner', $2, 'store')
            "#,
        )
        .bind(&existing_code)
        .bind(&shared_email)
        .execute(&pool)
        .await
        .expect("seed existing customer email");

        let payload: CounterpointCustomersPayload = serde_json::from_value(serde_json::json!({
            "rows": [
                {
                    "cust_no": duplicate_code.clone(),
                    "first_name": "Duplicate",
                    "last_name": "Email",
                    "email": shared_email.clone(),
                    "loyalty_points": 0
                },
                {
                    "cust_no": clean_code.clone(),
                    "first_name": "Clean",
                    "last_name": "Email",
                    "email": clean_email.clone(),
                    "loyalty_points": 0
                }
            ]
        }))
        .expect("customer payload");

        let summary = execute_counterpoint_customer_batch(&pool, payload)
            .await
            .expect("customer import should continue after duplicate email");

        assert_eq!(summary.created, 2);
        assert_eq!(summary.updated, 0);
        assert_eq!(summary.email_conflicts, 1);

        let duplicate_email: Option<String> =
            sqlx::query_scalar("SELECT email FROM customers WHERE customer_code = $1")
                .bind(&duplicate_code)
                .fetch_one(&pool)
                .await
                .expect("load duplicate customer email");
        assert!(duplicate_email.is_none());

        let clean_landed_email: Option<String> =
            sqlx::query_scalar("SELECT email FROM customers WHERE customer_code = $1")
                .bind(&clean_code)
                .fetch_one(&pool)
                .await
                .expect("load clean customer email");
        assert_eq!(clean_landed_email.as_deref(), Some(clean_email.as_str()));

        let exception_payload: JsonValue = sqlx::query_scalar(
            r#"
            SELECT source_payload
            FROM counterpoint_import_exceptions
            WHERE entity_key = 'customers'
              AND source_key = $1
              AND reason_code = 'duplicate_customer_email'
              AND status = 'open'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(&duplicate_code)
        .fetch_one(&pool)
        .await
        .expect("load duplicate email exception");
        assert_eq!(
            exception_payload
                .get("original_email")
                .and_then(JsonValue::as_str),
            Some(shared_email.as_str())
        );
        assert_eq!(
            exception_payload
                .get("landed_without_email")
                .and_then(JsonValue::as_bool),
            Some(true)
        );

        for code in [&existing_code, &duplicate_code, &clean_code] {
            let _ = sqlx::query("DELETE FROM counterpoint_import_exceptions WHERE source_key = $1")
                .bind(code)
                .execute(&pool)
                .await;
            let _ = sqlx::query("DELETE FROM customers WHERE customer_code = $1")
                .bind(code)
                .execute(&pool)
                .await;
        }
    }

    async fn ensure_counterpoint_ingest_quarantine_table(pool: &PgPool) {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS public.counterpoint_ingest_quarantine (
                id bigserial PRIMARY KEY,
                ingest_type text NOT NULL,
                issue_type text NOT NULL,
                severity text NOT NULL,
                message text NOT NULL,
                normalized_sku text,
                counterpoint_item_key text,
                family_key text,
                option_values jsonb DEFAULT '[]'::jsonb NOT NULL,
                source_reference jsonb DEFAULT '{}'::jsonb NOT NULL,
                source_row jsonb DEFAULT '{}'::jsonb NOT NULL,
                created_at timestamp with time zone DEFAULT now() NOT NULL,
                CONSTRAINT counterpoint_ingest_quarantine_ingest_type_chk
                    CHECK (ingest_type = ANY (ARRAY['inventory'::text, 'catalog'::text]))
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure counterpoint ingest quarantine table");
    }

    async fn ensure_product_variant_barcode_aliases_table(pool: &PgPool) {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS public.product_variant_barcode_aliases (
                id bigserial PRIMARY KEY,
                variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
                alias_value text NOT NULL,
                normalized_alias text GENERATED ALWAYS AS (lower(TRIM(BOTH FROM alias_value))) STORED,
                alias_type text NOT NULL,
                source_system text NOT NULL,
                source_file_name text,
                source_file_hash text,
                source_row_number integer,
                source_row_hash text,
                counterpoint_item_key text,
                family_key text,
                match_method text NOT NULL,
                status text DEFAULT 'active'::text NOT NULL,
                created_at timestamp with time zone DEFAULT now() NOT NULL,
                CONSTRAINT product_variant_barcode_alias_value_chk CHECK (TRIM(BOTH FROM alias_value) <> ''::text),
                CONSTRAINT product_variant_barcode_alias_type_chk CHECK (
                    alias_type = ANY (ARRAY['counterpoint_b_sku'::text, 'upc'::text, 'ean'::text, 'vendor_upc'::text, 'manual'::text])
                ),
                CONSTRAINT product_variant_barcode_alias_status_chk CHECK (
                    status = ANY (ARRAY['active'::text, 'quarantined'::text, 'replaced'::text, 'rejected'::text])
                ),
                CONSTRAINT product_variant_barcode_alias_source_row_number_chk CHECK (
                    source_row_number IS NULL OR source_row_number > 0
                ),
                CONSTRAINT product_variant_barcode_alias_normalized_chk CHECK (normalized_alias <> ''::text)
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure product variant barcode aliases table");
        sqlx::query(
            r#"
            CREATE UNIQUE INDEX IF NOT EXISTS product_variant_barcode_aliases_active_alias_uidx
            ON public.product_variant_barcode_aliases (normalized_alias)
            WHERE status = 'active'::text
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure active alias unique index");
    }

    async fn load_counterpoint_config(pool: &PgPool) -> serde_json::Value {
        sqlx::query_scalar(
            "SELECT COALESCE(counterpoint_config, '{}'::jsonb) FROM store_settings WHERE id = 1",
        )
        .fetch_one(pool)
        .await
        .expect("load counterpoint config")
    }

    async fn restore_counterpoint_config(pool: &PgPool, config: serde_json::Value) {
        sqlx::query("UPDATE store_settings SET counterpoint_config = $1 WHERE id = 1")
            .bind(config)
            .execute(pool)
            .await
            .expect("restore counterpoint config");
    }

    async fn ensure_counterpoint_import_first_tables(pool: &PgPool) {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS counterpoint_import_runs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                run_kind TEXT NOT NULL DEFAULT 'rehearsal',
                status TEXT NOT NULL DEFAULT 'preflight_pending',
                history_start DATE NOT NULL DEFAULT DATE '2018-01-01',
                bridge_hostname TEXT,
                bridge_version TEXT,
                ros_base_url TEXT,
                source_fingerprint TEXT,
                preflight_passed BOOLEAN NOT NULL DEFAULT FALSE,
                preflight_blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
                totals JSONB NOT NULL DEFAULT '{}'::jsonb,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure counterpoint import runs table");
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS counterpoint_import_source_counts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                import_run_id UUID NOT NULL REFERENCES counterpoint_import_runs(id) ON DELETE CASCADE,
                entity_key TEXT NOT NULL,
                label TEXT NOT NULL,
                source_count BIGINT NOT NULL DEFAULT 0,
                source_sum NUMERIC(18, 2),
                source_checksum TEXT,
                query_key TEXT,
                required BOOLEAN NOT NULL DEFAULT TRUE,
                suspicious_min_count BIGINT,
                status TEXT NOT NULL DEFAULT 'ok',
                message TEXT,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (import_run_id, entity_key)
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure counterpoint import source counts table");
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS counterpoint_import_raw_records (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                import_run_id UUID NOT NULL REFERENCES counterpoint_import_runs(id) ON DELETE CASCADE,
                entity_key TEXT NOT NULL,
                source_key TEXT NOT NULL,
                source_row_hash TEXT NOT NULL,
                payload JSONB NOT NULL,
                extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                landed BOOLEAN NOT NULL DEFAULT FALSE,
                landed_table TEXT,
                landed_id UUID,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (import_run_id, entity_key, source_key, source_row_hash)
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure counterpoint import raw records table");
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS counterpoint_import_provenance (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                import_run_id UUID NOT NULL REFERENCES counterpoint_import_runs(id) ON DELETE CASCADE,
                entity_key TEXT NOT NULL,
                source_key TEXT NOT NULL,
                source_row_hash TEXT NOT NULL,
                ros_table TEXT NOT NULL,
                ros_id UUID NOT NULL,
                extracted_at TIMESTAMPTZ,
                imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                UNIQUE (entity_key, source_key, ros_table, ros_id)
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure counterpoint import provenance table");
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS counterpoint_import_exceptions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                import_run_id UUID REFERENCES counterpoint_import_runs(id) ON DELETE SET NULL,
                entity_key TEXT NOT NULL,
                source_key TEXT,
                severity TEXT NOT NULL DEFAULT 'warning',
                reason_code TEXT NOT NULL,
                message TEXT NOT NULL,
                suggested_fix TEXT,
                fallback_landed BOOLEAN NOT NULL DEFAULT FALSE,
                ros_table TEXT,
                ros_id UUID,
                source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                status TEXT NOT NULL DEFAULT 'open',
                resolved_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
                resolved_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure counterpoint import exceptions table");
    }

    fn snapshot_reconciliation_row<'a>(
        summary: &'a CounterpointLandingVerificationSummary,
        key: &str,
    ) -> &'a CounterpointSnapshotReconciliationRow {
        summary
            .snapshot_reconciliation
            .iter()
            .find(|row| row.key == key)
            .expect("snapshot reconciliation row")
    }

    fn cutover_visibility_row<'a>(
        summary: &'a CounterpointLandingVerificationSummary,
        key: &str,
    ) -> &'a CounterpointCutoverVisibilityRow {
        summary
            .cutover_visibility
            .iter()
            .find(|row| row.key == key)
            .expect("cutover visibility row")
    }

    fn preflight_issue_types(report: &CounterpointIdentityPreflightReport) -> HashSet<&str> {
        report
            .issues
            .iter()
            .map(|issue| issue.issue_type.as_str())
            .collect()
    }

    fn preflight_issue<'a>(
        report: &'a CounterpointIdentityPreflightReport,
        issue_type: &str,
    ) -> &'a CounterpointIdentityPreflightIssue {
        report
            .issues
            .iter()
            .find(|issue| issue.issue_type == issue_type)
            .expect("preflight issue")
    }

    #[test]
    fn counterpoint_inventory_identity_preflight_reports_collisions_without_writes() {
        let payload = CounterpointInventoryPayload {
            rows: vec![
                CounterpointInventoryRow {
                    sku: "B-100".into(),
                    stock_on_hand: 1,
                    counterpoint_item_key: Some("I-100|RED".into()),
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: " b-100 ".into(),
                    stock_on_hand: 2,
                    counterpoint_item_key: Some("I-200|BLUE".into()),
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: "12345".into(),
                    stock_on_hand: 3,
                    counterpoint_item_key: Some("I-300".into()),
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: " ".into(),
                    stock_on_hand: 4,
                    counterpoint_item_key: Some("I-301".into()),
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: "B-400".into(),
                    stock_on_hand: 5,
                    counterpoint_item_key: Some("I-400|A".into()),
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: "B-401".into(),
                    stock_on_hand: 6,
                    counterpoint_item_key: Some("I-400|A".into()),
                    unit_cost: None,
                },
            ],
            sync: None,
        };

        let report = validate_counterpoint_inventory_identity_preflight(&payload)
            .expect("inventory preflight report");
        let issue_types = preflight_issue_types(&report);

        assert_eq!(report.summary.entity, "inventory");
        assert_eq!(report.summary.total_rows, 6);
        assert_eq!(report.summary.variant_rows_checked, 6);
        assert!(report.summary.has_errors);
        assert_eq!(report.summary.invalid_sku_rows, 1);
        assert_eq!(report.summary.duplicate_normalized_b_sku_values, 1);
        assert_eq!(report.summary.duplicate_counterpoint_item_key_values, 1);
        assert_eq!(report.summary.conflicting_sku_family_values, 1);
        assert_eq!(
            report.summary.conflicting_sku_counterpoint_item_key_values,
            1
        );
        assert_eq!(report.summary.info_count, 0);
        assert_eq!(report.summary.warning_count, 0);
        assert_eq!(report.summary.quarantine_count, 1);
        assert_eq!(report.summary.blocking_count, 4);
        assert!(report.summary.has_blocking_issues);
        assert!(issue_types.contains("blank_sku"));
        assert!(issue_types.contains("duplicate_normalized_b_sku"));
        assert!(issue_types.contains("duplicate_counterpoint_item_key"));
        assert!(issue_types.contains("conflicting_sku_family_mapping"));
        assert!(issue_types.contains("conflicting_sku_counterpoint_item_key_mapping"));

        let duplicate_sku = preflight_issue(&report, "duplicate_normalized_b_sku");
        assert_eq!(duplicate_sku.severity, "BLOCKING");
        assert!(duplicate_sku.affects_ingest_rows);
        assert!(duplicate_sku.should_quarantine);
        assert!(duplicate_sku.safe_to_continue_other_rows);
        assert_eq!(duplicate_sku.normalized_sku.as_deref(), Some("B-100"));
        assert_eq!(duplicate_sku.sample_rows.len(), 2);
        assert_eq!(
            duplicate_sku.sample_rows[0].family_key.as_deref(),
            Some("I-100")
        );
        assert_eq!(duplicate_sku.sample_rows[0].option_values, vec!["RED"]);

        let blank = preflight_issue(&report, "blank_sku");
        assert_eq!(blank.severity, "QUARANTINE");
        assert!(blank.affects_ingest_rows);
        assert!(blank.should_quarantine);
        assert!(blank.safe_to_continue_other_rows);
    }

    fn catalog_cell(key: &str, sku: &str) -> CatalogCellRow {
        CatalogCellRow {
            counterpoint_item_key: key.into(),
            sku: sku.into(),
            barcode: None,
            variation_label: None,
            variation_values: None,
            stock_on_hand: None,
            reorder_point: None,
            retail_price: None,
            prc_2: None,
            prc_3: None,
            unit_cost: None,
        }
    }

    fn catalog_row(
        item_no: &str,
        barcode: Option<&str>,
        cells: Vec<CatalogCellRow>,
    ) -> CounterpointCatalogRow {
        let is_grid = !cells.is_empty();
        CounterpointCatalogRow {
            item_no: item_no.into(),
            description: None,
            long_description: None,
            brand: None,
            category: None,
            vendor_no: None,
            retail_price: None,
            prc_2: None,
            prc_3: None,
            unit_cost: None,
            is_grid: Some(is_grid),
            variation_axes: None,
            barcode: barcode.map(str::to_string),
            cells,
        }
    }

    fn numeric_identity_suffix() -> String {
        (Uuid::new_v4().as_u128() % 1_000_000_000_000u128).to_string()
    }

    #[tokio::test]
    async fn counterpoint_barcode_alias_preflight_maps_only_deterministic_variants() {
        let pool = connect_test_db().await;
        let suffix = numeric_identity_suffix();
        let item_no = format!("I-{suffix}");
        let product_id = Uuid::new_v4();
        let mappable_variant_id = Uuid::new_v4();
        let wildcard_variant_id = Uuid::new_v4();
        let different_order_variant_id = Uuid::new_v4();
        let mappable_key = format!("{item_no}|STYLE1|RED|40");
        let wildcard_key = format!("{item_no}|STYLE2|BLUE|42|*");
        let different_order_key = format!("{item_no}|BLUE|STYLE2|42");

        sqlx::query(
            r#"
            INSERT INTO products (
                id, catalog_handle, name, base_retail_price, base_cost, is_active, data_source
            )
            VALUES ($1, $2, $3, $4, $5, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(&item_no)
        .bind(format!("Counterpoint Alias Fixture {suffix}"))
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .execute(&pool)
        .await
        .expect("insert alias preflight product fixture");

        for (variant_id, key) in [
            (mappable_variant_id, &mappable_key),
            (wildcard_variant_id, &wildcard_key),
            (different_order_variant_id, &different_order_key),
        ] {
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
                )
                VALUES ($1, $2, $3, '{}'::jsonb, 0, $4)
                "#,
            )
            .bind(variant_id)
            .bind(product_id)
            .bind(key)
            .bind(key)
            .execute(&pool)
            .await
            .expect("insert alias preflight variant fixture");
        }

        let report = preflight_counterpoint_barcode_aliases(
            &pool,
            CounterpointBarcodeAliasPreflightPayload {
                rows: vec![
                    CounterpointBarcodeAliasPreflightRow {
                        sku: format!("B-{suffix}1"),
                        family_key: Some(item_no.clone()),
                        option_values: vec!["STYLE1".into(), "RED".into(), "40".into()],
                    },
                    CounterpointBarcodeAliasPreflightRow {
                        sku: format!("B-{suffix}2"),
                        family_key: Some(item_no.clone()),
                        option_values: vec!["STYLE1".into(), "RED".into(), "40".into()],
                    },
                    CounterpointBarcodeAliasPreflightRow {
                        sku: format!("B-{suffix}2"),
                        family_key: Some(item_no.clone()),
                        option_values: vec!["STYLE2".into(), "BLUE".into(), "42".into()],
                    },
                    CounterpointBarcodeAliasPreflightRow {
                        sku: format!("B-{suffix}3"),
                        family_key: Some(item_no.clone()),
                        option_values: vec!["MISSING".into()],
                    },
                    CounterpointBarcodeAliasPreflightRow {
                        sku: format!("B-{suffix}4"),
                        family_key: None,
                        option_values: vec!["STYLE1".into()],
                    },
                    CounterpointBarcodeAliasPreflightRow {
                        sku: format!("B-{suffix}5"),
                        family_key: Some(item_no.clone()),
                        option_values: vec!["STYLE2".into(), "BLUE".into(), "42".into()],
                    },
                    CounterpointBarcodeAliasPreflightRow {
                        sku: "12345".into(),
                        family_key: Some(item_no.clone()),
                        option_values: vec!["STYLE1".into()],
                    },
                ],
            },
        )
        .await
        .expect("barcode alias preflight report");

        assert_eq!(report.summary.total_rows, 7);
        assert_eq!(report.summary.mappable, 2);
        assert_eq!(report.summary.duplicate_b_sku, 2);
        assert_eq!(report.summary.no_ros_variant_match, 1);
        assert_eq!(report.summary.missing_family, 1);
        assert_eq!(report.summary.ambiguous_variant_match, 0);
        assert_eq!(report.summary.invalid_non_b_sku, 1);
        assert_eq!(report.summary.existing_barcode_conflict, 0);
        assert!(report.examples.iter().any(|example| {
            example.classification == "mappable"
                && example.matched_variant_id == Some(mappable_variant_id)
                && example.counterpoint_item_key.as_deref() == Some(mappable_key.as_str())
        }));
        assert!(report.examples.iter().any(|example| {
            example.classification == "mappable"
                && example.matched_variant_id == Some(wildcard_variant_id)
                && example.counterpoint_item_key.as_deref() == Some(wildcard_key.as_str())
        }));

        sqlx::query("DELETE FROM product_variants WHERE product_id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("delete alias preflight variants");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("delete alias preflight product");
    }

    #[tokio::test]
    async fn counterpoint_barcode_alias_health_reports_counts_without_scan_changes() {
        let pool = connect_test_db().await;
        ensure_product_variant_barcode_aliases_table(&pool).await;

        let suffix = numeric_identity_suffix();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let active_alias = format!("B-{suffix}1");
        let rejected_alias = format!("B-{suffix}2");
        let cp_key = format!("I-{suffix}|STYLE|SIZE");

        sqlx::query(
            r#"
            INSERT INTO products (
                id, catalog_handle, name, base_retail_price, base_cost, is_active, data_source
            )
            VALUES ($1, $2, $3, $4, $5, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("I-{suffix}"))
        .bind(format!("Counterpoint Alias Health Fixture {suffix}"))
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .execute(&pool)
        .await
        .expect("insert alias health product fixture");

        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, '{}'::jsonb, 0, $3)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("insert alias health variant fixture");

        sqlx::query(
            r#"
            INSERT INTO product_variant_barcode_aliases (
                variant_id, alias_value, alias_type, source_system,
                source_file_name, source_file_hash, source_row_number, source_row_hash,
                counterpoint_item_key, family_key, match_method, status
            )
            VALUES
                ($1, $2, 'counterpoint_b_sku', 'counterpoint', 'alias-test.csv', $4, 1, $5, $6, $7, 'preflight_family_options', 'active'),
                ($1, $3, 'counterpoint_b_sku', 'counterpoint', 'alias-test.csv', $4, 2, $8, $6, $7, 'preflight_family_options', 'rejected')
            "#,
        )
        .bind(variant_id)
        .bind(&active_alias)
        .bind(&rejected_alias)
        .bind(format!("alias-health-file-{suffix}"))
        .bind(format!("alias-health-row-{suffix}-1"))
        .bind(&cp_key)
        .bind(format!("I-{suffix}"))
        .bind(format!("alias-health-row-{suffix}-2"))
        .execute(&pool)
        .await
        .expect("insert alias health rows");

        let health = get_counterpoint_barcode_alias_health_summary(&pool)
            .await
            .expect("barcode alias health summary");
        assert!(health.total_aliases >= 2);
        assert!(health.active_aliases >= 1);
        assert_eq!(health.duplicate_active_alias_conflicts, 0);
        assert!(health
            .by_type
            .iter()
            .any(|row| row.key == "counterpoint_b_sku" && row.count >= 2));
        assert!(health
            .by_status
            .iter()
            .any(|row| row.key == "active" && row.count >= 1));
        assert!(health
            .by_status
            .iter()
            .any(|row| row.key == "rejected" && row.count >= 1));

        let stored_barcode: Option<String> =
            sqlx::query_scalar("SELECT barcode FROM product_variants WHERE id = $1")
                .bind(variant_id)
                .fetch_one(&pool)
                .await
                .expect("read variant barcode");
        assert_eq!(stored_barcode, None);

        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("delete alias health product cascade");
    }

    #[tokio::test]
    async fn counterpoint_barcode_alias_persist_inserts_only_mappable_aliases() {
        let pool = connect_test_db().await;
        ensure_product_variant_barcode_aliases_table(&pool).await;

        let suffix = numeric_identity_suffix();
        let item_no = format!("I-{suffix}");
        let other_item_no = format!("I-{suffix}9");
        let product_id = Uuid::new_v4();
        let other_product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let other_variant_id = Uuid::new_v4();
        let cp_key = format!("{item_no}|STYLE|BLACK|40");
        let other_cp_key = format!("{other_item_no}|STYLE|BLACK|40");
        let alias = format!("B-{suffix}1");

        for (id, handle, name) in [
            (
                product_id,
                item_no.as_str(),
                "Counterpoint Alias Persist Fixture",
            ),
            (
                other_product_id,
                other_item_no.as_str(),
                "Counterpoint Alias Persist Conflict Fixture",
            ),
        ] {
            sqlx::query(
                r#"
                INSERT INTO products (
                    id, catalog_handle, name, base_retail_price, base_cost, is_active, data_source
                )
                VALUES ($1, $2, $3, $4, $5, TRUE, 'counterpoint')
                "#,
            )
            .bind(id)
            .bind(handle)
            .bind(format!("{name} {suffix}"))
            .bind(Decimal::new(10000, 2))
            .bind(Decimal::new(4000, 2))
            .execute(&pool)
            .await
            .expect("insert alias persist product fixture");
        }

        for (id, product, key) in [
            (variant_id, product_id, cp_key.as_str()),
            (other_variant_id, other_product_id, other_cp_key.as_str()),
        ] {
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
                )
                VALUES ($1, $2, $3, '{}'::jsonb, 0, $3)
                "#,
            )
            .bind(id)
            .bind(product)
            .bind(key)
            .execute(&pool)
            .await
            .expect("insert alias persist variant fixture");
        }

        let payload = CounterpointBarcodeAliasPersistPayload {
            source_file_name: "alias-persist-test.csv".into(),
            source_file_hash: Some(format!("alias-persist-file-{suffix}")),
            dry_run: false,
            replace: false,
            rows: vec![
                CounterpointBarcodeAliasPersistRow {
                    sku: alias.clone(),
                    family_key: Some(item_no.clone()),
                    option_values: vec!["STYLE".into(), "BLACK".into(), "40".into()],
                    source_row_number: Some(2),
                    source_row_hash: Some(format!("alias-persist-row-{suffix}-1")),
                },
                CounterpointBarcodeAliasPersistRow {
                    sku: format!("B-{suffix}2"),
                    family_key: Some(item_no.clone()),
                    option_values: vec!["MISSING".into()],
                    source_row_number: Some(3),
                    source_row_hash: Some(format!("alias-persist-row-{suffix}-2")),
                },
                CounterpointBarcodeAliasPersistRow {
                    sku: "12345".into(),
                    family_key: Some(item_no.clone()),
                    option_values: vec!["STYLE".into()],
                    source_row_number: Some(4),
                    source_row_hash: Some(format!("alias-persist-row-{suffix}-3")),
                },
            ],
        };

        let report = persist_counterpoint_barcode_aliases(&pool, payload.clone())
            .await
            .expect("persist barcode aliases");
        assert_eq!(report.summary.total_rows, 3);
        assert_eq!(report.summary.mappable_aliases, 1);
        assert_eq!(report.summary.would_insert_aliases, 1);
        assert_eq!(report.summary.inserted_aliases, 1);
        assert_eq!(report.summary.skipped_no_ros_variant_match, 1);
        assert_eq!(report.summary.skipped_invalid_non_b_sku, 1);

        let stored: (Uuid, String, String, String, Option<String>, Option<i32>) = sqlx::query_as(
            r#"
            SELECT
                variant_id,
                alias_type,
                source_system,
                status,
                source_file_hash,
                source_row_number
            FROM product_variant_barcode_aliases
            WHERE normalized_alias = lower(TRIM($1))
            "#,
        )
        .bind(&alias)
        .fetch_one(&pool)
        .await
        .expect("read stored alias");
        assert_eq!(stored.0, variant_id);
        assert_eq!(stored.1, "counterpoint_b_sku");
        assert_eq!(stored.2, "counterpoint_csv");
        assert_eq!(stored.3, "active");
        let expected_source_file_hash = format!("alias-persist-file-{suffix}");
        assert_eq!(
            stored.4.as_deref(),
            Some(expected_source_file_hash.as_str())
        );
        assert_eq!(stored.5, Some(2));

        let rerun = persist_counterpoint_barcode_aliases(&pool, payload)
            .await
            .expect("rerun identical aliases");
        assert_eq!(rerun.summary.inserted_aliases, 0);
        assert_eq!(rerun.summary.already_existing_identical_aliases, 1);

        let replaced = persist_counterpoint_barcode_aliases(
            &pool,
            CounterpointBarcodeAliasPersistPayload {
                source_file_name: "alias-persist-replace-test.csv".into(),
                source_file_hash: Some(format!("alias-persist-replace-file-{suffix}")),
                dry_run: false,
                replace: true,
                rows: vec![CounterpointBarcodeAliasPersistRow {
                    sku: alias.clone(),
                    family_key: Some(item_no.clone()),
                    option_values: vec!["STYLE".into(), "BLACK".into(), "40".into()],
                    source_row_number: Some(2),
                    source_row_hash: Some(format!("alias-persist-replace-row-{suffix}")),
                }],
            },
        )
        .await
        .expect("replace counterpoint b-sku aliases");
        assert_eq!(replaced.summary.would_insert_aliases, 1);
        assert_eq!(replaced.summary.inserted_aliases, 1);
        assert!(replaced.summary.deleted_existing_counterpoint_b_sku_aliases >= 1);

        let conflict = persist_counterpoint_barcode_aliases(
            &pool,
            CounterpointBarcodeAliasPersistPayload {
                source_file_name: "alias-persist-conflict-test.csv".into(),
                source_file_hash: Some(format!("alias-persist-conflict-file-{suffix}")),
                dry_run: false,
                replace: false,
                rows: vec![CounterpointBarcodeAliasPersistRow {
                    sku: alias.clone(),
                    family_key: Some(other_item_no.clone()),
                    option_values: vec!["STYLE".into(), "BLACK".into(), "40".into()],
                    source_row_number: Some(2),
                    source_row_hash: Some(format!("alias-persist-conflict-row-{suffix}")),
                }],
            },
        )
        .await;
        assert!(matches!(
            conflict,
            Err(CounterpointSyncError::InvalidPayload(message))
                if message.contains("active barcode alias conflicts detected")
        ));

        let stored_barcode: Option<String> =
            sqlx::query_scalar("SELECT barcode FROM product_variants WHERE id = $1")
                .bind(variant_id)
                .fetch_one(&pool)
                .await
                .expect("read variant barcode after alias persist");
        assert_eq!(stored_barcode, None);

        sqlx::query("DELETE FROM products WHERE id IN ($1, $2)")
            .bind(product_id)
            .bind(other_product_id)
            .execute(&pool)
            .await
            .expect("delete alias persist products cascade");
    }

    #[tokio::test]
    async fn counterpoint_lightspeed_normalization_preview_is_read_only_and_deterministic() {
        let pool = connect_test_db().await;
        ensure_product_variant_barcode_aliases_table(&pool).await;

        let suffix = numeric_identity_suffix();
        let category_id = Uuid::new_v4();
        let vendor_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let item_no = format!("I-{suffix}");
        let counterpoint_item_key = format!("{item_no}|KIDW|36S");
        let alias = format!("B-{suffix}1");
        let duplicate_alias = format!("B-{suffix}2");
        let no_match_alias = format!("B-{suffix}3");

        sqlx::query("INSERT INTO categories (id, name) VALUES ($1, $2)")
            .bind(category_id)
            .bind(format!("ROS Suits {suffix}"))
            .execute(&pool)
            .await
            .expect("insert normalization preview category");
        sqlx::query(
            "INSERT INTO vendors (id, name, vendor_code, is_active) VALUES ($1, $2, $3, TRUE)",
        )
        .bind(vendor_id)
        .bind(format!("Peerless ROS {suffix}"))
        .bind(format!("PEER-{suffix}"))
        .execute(&pool)
        .await
        .expect("insert normalization preview vendor");
        sqlx::query(
            r#"
            INSERT INTO products (
                id, category_id, primary_vendor_id, catalog_handle, name,
                base_retail_price, base_cost, variation_axes, is_active, data_source
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY['Model', 'Size']::text[], TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(category_id)
        .bind(vendor_id)
        .bind(&item_no)
        .bind(format!("Counterpoint Suit {suffix}"))
        .bind(Decimal::new(45000, 2))
        .bind(Decimal::new(14700, 2))
        .execute(&pool)
        .await
        .expect("insert normalization preview product");
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, $4, 0, $3)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&counterpoint_item_key)
        .bind(serde_json::json!({ "Model": "KIDW", "Size": "36S" }))
        .execute(&pool)
        .await
        .expect("insert normalization preview variant");
        sqlx::query(
            r#"
            INSERT INTO product_variant_barcode_aliases (
                variant_id, alias_value, alias_type, source_system, source_file_name,
                source_row_number, counterpoint_item_key, family_key, match_method, status
            )
            VALUES ($1, $2, 'counterpoint_b_sku', 'counterpoint_csv', 'normalization-test.csv',
                2, $3, $4, 'preflight_family_options', 'active')
            "#,
        )
        .bind(variant_id)
        .bind(&alias)
        .bind(&counterpoint_item_key)
        .bind(&item_no)
        .execute(&pool)
        .await
        .expect("insert normalization preview alias");

        let report = preview_counterpoint_lightspeed_normalization_candidates(
            &pool,
            CounterpointNormalizationPreviewPayload {
                source_file_name: Some("lightspeed-test.csv".into()),
                rows: vec![
                    CounterpointNormalizationPreviewRow {
                        sku: alias.clone(),
                        handle: Some(format!("lightspeed-suit-{suffix}")),
                        name: Some(format!("Lightspeed Suit {suffix}")),
                        product_category: Some("SUIT".into()),
                        supplier_name: Some(format!("Peerless Clothing {suffix}")),
                        supplier_code: Some(format!("KIDW{suffix}")),
                        brand_name: None,
                        tags: Some(item_no.clone()),
                        variant_options: vec![
                            CounterpointNormalizationPreviewOption {
                                name: Some("Model".into()),
                                value: Some("KIDW".into()),
                            },
                            CounterpointNormalizationPreviewOption {
                                name: Some("Size".into()),
                                value: Some("36S".into()),
                            },
                        ],
                        source_row_number: Some(2),
                    },
                    CounterpointNormalizationPreviewRow {
                        sku: duplicate_alias.clone(),
                        handle: None,
                        name: None,
                        product_category: None,
                        supplier_name: None,
                        supplier_code: None,
                        brand_name: None,
                        tags: None,
                        variant_options: vec![],
                        source_row_number: Some(3),
                    },
                    CounterpointNormalizationPreviewRow {
                        sku: duplicate_alias.clone(),
                        handle: None,
                        name: None,
                        product_category: None,
                        supplier_name: None,
                        supplier_code: None,
                        brand_name: None,
                        tags: None,
                        variant_options: vec![],
                        source_row_number: Some(4),
                    },
                    CounterpointNormalizationPreviewRow {
                        sku: no_match_alias,
                        handle: None,
                        name: None,
                        product_category: None,
                        supplier_name: None,
                        supplier_code: None,
                        brand_name: None,
                        tags: None,
                        variant_options: vec![],
                        source_row_number: Some(5),
                    },
                    CounterpointNormalizationPreviewRow {
                        sku: "12345".into(),
                        handle: None,
                        name: None,
                        product_category: None,
                        supplier_name: None,
                        supplier_code: None,
                        brand_name: None,
                        tags: None,
                        variant_options: vec![],
                        source_row_number: Some(6),
                    },
                ],
            },
        )
        .await
        .expect("normalization preview report");

        assert_eq!(report.summary.total_lightspeed_rows, 5);
        assert_eq!(report.summary.lightspeed_b_sku_rows, 4);
        assert_eq!(report.summary.matched_aliases, 1);
        assert_eq!(report.summary.clean_candidates, 1);
        assert_eq!(report.summary.duplicate_lightspeed_b_sku_rows, 2);
        assert_eq!(report.summary.no_active_alias_rows, 1);
        assert_eq!(report.summary.invalid_non_b_sku_rows, 1);
        assert_eq!(report.summary.name_differences, 1);
        assert_eq!(report.summary.category_differences, 1);
        assert_eq!(report.summary.supplier_differences, 1);
        assert_eq!(report.summary.variant_option_differences, 0);
        assert_eq!(report.candidates.len(), 1);
        assert_eq!(report.candidates[0].variant_id, variant_id);
        assert!(report
            .excluded_examples
            .iter()
            .any(|example| example.reason == "duplicate_lightspeed_b_sku"));
        assert!(report
            .excluded_examples
            .iter()
            .any(|example| example.reason == "no_active_alias"));

        let stored_barcode: Option<String> =
            sqlx::query_scalar("SELECT barcode FROM product_variants WHERE id = $1")
                .bind(variant_id)
                .fetch_one(&pool)
                .await
                .expect("read variant barcode after normalization preview");
        assert_eq!(stored_barcode, None);

        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("delete normalization preview product cascade");
        sqlx::query("DELETE FROM vendors WHERE id = $1")
            .bind(vendor_id)
            .execute(&pool)
            .await
            .expect("delete normalization preview vendor");
        sqlx::query("DELETE FROM categories WHERE id = $1")
            .bind(category_id)
            .execute(&pool)
            .await
            .expect("delete normalization preview category");
    }

    #[test]
    fn counterpoint_catalog_identity_preflight_reports_variant_identity_conflicts() {
        let payload = CounterpointCatalogPayload {
            rows: vec![
                catalog_row(
                    "I-100",
                    None,
                    vec![
                        catalog_cell("I-100|RED", "B-500"),
                        catalog_cell("I-100|BLUE", "B-500"),
                    ],
                ),
                catalog_row("I-200", None, vec![catalog_cell("I-200|RED", "B-500")]),
                catalog_row("I-300", None, Vec::new()),
                catalog_row("I-400", None, vec![catalog_cell("I-100|RED", "B-501")]),
            ],
            sync: None,
        };

        let report =
            validate_counterpoint_catalog_identity_preflight(&payload).expect("catalog preflight");
        let issue_types = preflight_issue_types(&report);

        assert_eq!(report.summary.entity, "catalog");
        assert_eq!(report.summary.total_rows, 4);
        assert_eq!(report.summary.variant_rows_checked, 5);
        assert!(report.summary.has_errors);
        assert_eq!(report.summary.invalid_sku_rows, 0);
        assert_eq!(report.summary.duplicate_normalized_b_sku_values, 1);
        assert_eq!(report.summary.duplicate_counterpoint_item_key_values, 1);
        assert_eq!(report.summary.conflicting_sku_family_values, 1);
        assert_eq!(
            report.summary.conflicting_sku_counterpoint_item_key_values,
            1
        );
        assert_eq!(report.summary.info_count, 0);
        assert_eq!(report.summary.warning_count, 0);
        assert_eq!(report.summary.quarantine_count, 0);
        assert_eq!(report.summary.blocking_count, 4);
        assert!(report.summary.has_blocking_issues);
        assert!(issue_types.contains("duplicate_normalized_b_sku"));
        assert!(issue_types.contains("duplicate_counterpoint_item_key"));
        assert!(issue_types.contains("conflicting_sku_family_mapping"));
        assert!(issue_types.contains("conflicting_sku_counterpoint_item_key_mapping"));

        let duplicate_sku = preflight_issue(&report, "duplicate_normalized_b_sku");
        assert_eq!(duplicate_sku.severity, "BLOCKING");
        assert!(duplicate_sku.should_quarantine);
        assert_eq!(duplicate_sku.normalized_sku.as_deref(), Some("B-500"));
        assert_eq!(duplicate_sku.sample_rows[0].option_values, vec!["RED"]);
    }

    #[tokio::test]
    async fn counterpoint_inventory_ingest_quarantines_unsafe_rows_before_writes() {
        let pool = connect_test_db().await;
        ensure_counterpoint_ingest_quarantine_table(&pool).await;
        let suffix = numeric_identity_suffix();
        let product_id = Uuid::new_v4();
        let clean_sku = format!("B-{suffix}10");
        let duplicate_sku = format!("B-{suffix}11");
        let generated_sku = format!("9{suffix}");
        let clean_key = format!("I-{suffix}|KEEP");

        sqlx::query(
            r#"
            INSERT INTO products (id, catalog_handle, name, base_retail_price, base_cost, is_active, data_source)
            VALUES ($1, $2, $3, 0, 0, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("I-{suffix}"))
        .bind(format!("Quarantine Guard Inventory {suffix}"))
        .execute(&pool)
        .await
        .expect("insert quarantine inventory product");

        for (sku, key) in [
            (clean_sku.as_str(), Some(clean_key.as_str())),
            (duplicate_sku.as_str(), None),
            (generated_sku.as_str(), None),
        ] {
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
                )
                VALUES ($1, $2, '{}'::jsonb, 0, $3)
                "#,
            )
            .bind(product_id)
            .bind(sku)
            .bind(key)
            .execute(&pool)
            .await
            .expect("insert quarantine inventory variant");
        }

        let payload = CounterpointInventoryPayload {
            rows: vec![
                CounterpointInventoryRow {
                    sku: clean_sku.clone(),
                    stock_on_hand: 7,
                    counterpoint_item_key: Some(clean_key.clone()),
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: duplicate_sku.clone(),
                    stock_on_hand: 9,
                    counterpoint_item_key: None,
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: format!(" {} ", duplicate_sku.to_lowercase()),
                    stock_on_hand: 10,
                    counterpoint_item_key: None,
                    unit_cost: None,
                },
                CounterpointInventoryRow {
                    sku: generated_sku.clone(),
                    stock_on_hand: 11,
                    counterpoint_item_key: None,
                    unit_cost: None,
                },
            ],
            sync: None,
        };

        let summary = execute_counterpoint_inventory_batch(&pool, payload)
            .await
            .expect("quarantine guarded inventory ingest");
        let clean_stock: i32 =
            sqlx::query_scalar("SELECT stock_on_hand FROM product_variants WHERE sku = $1")
                .bind(&clean_sku)
                .fetch_one(&pool)
                .await
                .expect("load clean stock");
        let duplicate_stock: i32 =
            sqlx::query_scalar("SELECT stock_on_hand FROM product_variants WHERE sku = $1")
                .bind(&duplicate_sku)
                .fetch_one(&pool)
                .await
                .expect("load duplicate stock");
        let generated_stock: i32 =
            sqlx::query_scalar("SELECT stock_on_hand FROM product_variants WHERE sku = $1")
                .bind(&generated_sku)
                .fetch_one(&pool)
                .await
                .expect("load generated stock");
        let quarantine_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_ingest_quarantine
            WHERE ingest_type = 'inventory'
              AND normalized_sku = ANY($1)
            "#,
        )
        .bind(vec![duplicate_sku.clone(), generated_sku.clone()])
        .fetch_one(&pool)
        .await
        .expect("count inventory quarantine records");
        let duplicate_issue_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_ingest_quarantine
            WHERE ingest_type = 'inventory'
              AND issue_type = 'duplicate_normalized_b_sku'
              AND severity = 'BLOCKING'
              AND normalized_sku = $1
            "#,
        )
        .bind(&duplicate_sku)
        .fetch_one(&pool)
        .await
        .expect("count duplicate inventory quarantine records");

        sqlx::query(
            "DELETE FROM counterpoint_ingest_quarantine WHERE ingest_type = 'inventory' AND normalized_sku = ANY($1)",
        )
        .bind(vec![duplicate_sku.clone(), generated_sku.clone()])
        .execute(&pool)
        .await
        .expect("cleanup inventory quarantine records");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup quarantine inventory product");

        assert_eq!(summary.updated, 2);
        assert_eq!(summary.skipped, 2);
        assert_eq!(summary.quarantined, 2);
        assert_eq!(clean_stock, 7);
        assert_eq!(duplicate_stock, 0);
        assert_eq!(generated_stock, 11);
        assert_eq!(quarantine_count, 2);
        assert_eq!(duplicate_issue_count, 2);
    }

    #[tokio::test]
    async fn counterpoint_catalog_ingest_quarantines_unsafe_cells_before_writes() {
        let pool = connect_test_db().await;
        ensure_counterpoint_ingest_quarantine_table(&pool).await;
        let suffix = numeric_identity_suffix();
        let item_one = format!("I-{suffix}1");
        let item_two = format!("I-{suffix}2");
        let item_three = format!("I-{suffix}3");
        let clean_sku = format!("B-{suffix}10");
        let duplicate_sku = format!("B-{suffix}11");

        let mut row_one = catalog_row(
            &item_one,
            None,
            vec![
                catalog_cell(&format!("{item_one}|KEEP"), &clean_sku),
                catalog_cell(&format!("{item_one}|DUP"), &duplicate_sku),
            ],
        );
        row_one.description = Some("Quarantine Guard Catalog One".into());
        let mut row_two = catalog_row(
            &item_two,
            None,
            vec![catalog_cell(&format!("{item_two}|DUP"), &duplicate_sku)],
        );
        row_two.description = Some("Quarantine Guard Catalog Two".into());
        let mut row_three = catalog_row(&item_three, None, Vec::new());
        row_three.description = Some("Quarantine Guard Catalog Parent".into());

        let payload = CounterpointCatalogPayload {
            rows: vec![row_one, row_two, row_three],
            sync: None,
        };

        let summary = execute_counterpoint_catalog_batch(&pool, payload)
            .await
            .expect("quarantine guarded catalog ingest");
        let item_one_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE catalog_handle = $1)")
                .bind(&item_one)
                .fetch_one(&pool)
                .await
                .expect("check item one");
        let item_two_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE catalog_handle = $1)")
                .bind(&item_two)
                .fetch_one(&pool)
                .await
                .expect("check item two");
        let item_three_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE catalog_handle = $1)")
                .bind(&item_three)
                .fetch_one(&pool)
                .await
                .expect("check item three");
        let clean_variant_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM product_variants WHERE sku = $1)")
                .bind(&clean_sku)
                .fetch_one(&pool)
                .await
                .expect("check clean variant");
        let duplicate_variant_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM product_variants WHERE sku = $1)")
                .bind(&duplicate_sku)
                .fetch_one(&pool)
                .await
                .expect("check duplicate variant");
        let quarantine_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_ingest_quarantine
            WHERE ingest_type = 'catalog'
              AND normalized_sku = $1
            "#,
        )
        .bind(&duplicate_sku)
        .fetch_one(&pool)
        .await
        .expect("count catalog quarantine records");
        let source_metadata_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_ingest_quarantine
            WHERE ingest_type = 'catalog'
              AND normalized_sku = $1
              AND source_reference ? 'row_number'
              AND source_reference ? 'cell_number'
              AND source_row ? 'cell'
            "#,
        )
        .bind(&duplicate_sku)
        .fetch_one(&pool)
        .await
        .expect("count catalog quarantine metadata");

        sqlx::query(
            "DELETE FROM counterpoint_ingest_quarantine WHERE ingest_type = 'catalog' AND normalized_sku = $1",
        )
        .bind(&duplicate_sku)
        .execute(&pool)
        .await
        .expect("cleanup catalog quarantine records");
        sqlx::query("DELETE FROM products WHERE catalog_handle = ANY($1)")
            .bind(vec![item_one.clone(), item_two.clone(), item_three.clone()])
            .execute(&pool)
            .await
            .expect("cleanup quarantine catalog products");

        assert_eq!(summary.products_created, 2);
        assert_eq!(summary.variants_created, 2);
        assert_eq!(summary.skipped, 2);
        assert_eq!(summary.quarantined, 2);
        assert!(item_one_exists);
        assert!(!item_two_exists);
        assert!(item_three_exists);
        assert!(clean_variant_exists);
        assert!(!duplicate_variant_exists);
        assert_eq!(quarantine_count, 6);
        assert_eq!(source_metadata_count, 6);
    }

    #[test]
    fn counterpoint_product_name_rejects_item_numbers_and_barcodes() {
        let identifiers = vec!["I-103111".to_string(), "B-998877".to_string()];

        assert!(
            safe_counterpoint_product_name_candidate(Some("Classic Navy Suit"), &identifiers)
                .is_some()
        );
        assert!(safe_counterpoint_product_name_candidate(Some("I-103111"), &identifiers).is_none());
        assert!(safe_counterpoint_product_name_candidate(Some("B-998877"), &identifiers).is_none());
        assert!(safe_counterpoint_product_name_candidate(Some("103111"), &identifiers).is_none());
    }

    #[test]
    fn counterpoint_product_name_resolver_preserves_existing_good_name() {
        let identifiers = vec!["I-103111".to_string(), "B-998877".to_string()];
        let (name, issue) = resolve_counterpoint_product_name(
            Some("I-103111"),
            None,
            Some("Classic Navy Suit"),
            "I-103111",
            &identifiers,
        );

        assert_eq!(name, "Classic Navy Suit");
        assert!(issue
            .as_deref()
            .unwrap_or_default()
            .contains("preserved the existing ROS product name"));
    }

    #[test]
    fn counterpoint_product_name_resolver_uses_long_description_before_placeholder() {
        let identifiers = vec!["I-103111".to_string()];
        let (name, issue) = resolve_counterpoint_product_name(
            Some("I-103111"),
            Some("Classic Navy Suit"),
            None,
            "I-103111",
            &identifiers,
        );

        assert_eq!(name, "Classic Navy Suit");
        assert!(issue
            .as_deref()
            .unwrap_or_default()
            .contains("used LONG_DESCR"));
    }

    #[tokio::test]
    async fn counterpoint_reset_preview_returns_expected_structure() {
        let pool = connect_test_db().await;
        let preview = get_counterpoint_reset_preview(&pool)
            .await
            .expect("load reset preview");

        assert_eq!(preview.confirmation_phrase, "RESET COUNTERPOINT BASELINE");
        assert!(preview
            .pre_go_live_only_warning
            .contains("Pre-go-live only"));
        assert!(preview
            .preserve_always
            .iter()
            .any(|line| line.contains("seeded Chris G admin account")));

        let scope_keys = preview
            .reset_scope
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>();
        assert!(scope_keys.contains(&"customers"));
        assert!(scope_keys.contains(&"transactions"));
        assert!(scope_keys.contains(&"counterpoint_state"));
        assert!(preview
            .excluded_for_now
            .iter()
            .any(|line| line.contains(".counterpoint-bridge-state.json")));
    }

    #[tokio::test]
    async fn counterpoint_inventory_verification_report_builds_for_checked_in_csv() {
        let pool = connect_test_db().await;
        let report = build_counterpoint_inventory_verification_report(&pool)
            .await
            .expect("build inventory verification report");

        println!(
            "inventory verification summary: total_csv_skus={} matched={} exact={} mismatched={} comparison_artifact={} csv_source_issue={} missing={} expected_out_of_scope_exclusion={} extra={} name_mismatch={} category_mismatch={} variant_mismatch={} ros_variant_label_missing={} price_mismatch={} cost_mismatch={} inventory_mismatch={} supplier_field_suspect={} supplier_code_non_vendor_key={} variant_group_splits={} parent_sku_variant={} duplicate_variant_labels={} missing_vendor={} vendor_mismatch={} missing_vendor_item_link={} extra_parent_scope_artifact={} extra_key_present_scope_gap={} extra_unexplained={}",
            report.summary.total_csv_skus,
            report.summary.matched_count,
            report.summary.exact_match_count,
            report.summary.mismatched_count,
            report.summary.comparison_artifact_count,
            report.summary.csv_source_issue_count,
            report.summary.missing_in_ros_count,
            report.summary.expected_out_of_scope_exclusion_count,
            report.summary.extra_in_ros_count,
            report.summary.name_mismatch_count,
            report.summary.category_mismatch_count,
            report.summary.variant_mismatch_count,
            report.summary.ros_variant_label_missing_count,
            report.summary.price_mismatch_count,
            report.summary.cost_mismatch_count,
            report.summary.inventory_mismatch_count,
            report.summary.supplier_field_suspect_count,
            report.summary.supplier_code_non_vendor_key_count,
            report.summary.variant_group_split_count,
            report.summary.parent_sku_variant_count,
            report.summary.duplicate_variant_label_count,
            report.summary.missing_vendor_count,
            report.summary.vendor_mismatch_count,
            report.summary.missing_vendor_item_link_count,
            report.summary.extra_parent_scope_artifact_count,
            report.summary.extra_key_present_scope_gap_count,
            report.summary.extra_unexplained_count,
        );
        for issue in report.critical_issues.iter().take(10) {
            println!("inventory verification critical issue: {issue}");
        }

        assert!(report.summary.csv_path.contains("export2026-04-22.csv"));
        assert_eq!(
            report.summary.exact_match_count
                + report.summary.mismatched_count
                + report.summary.csv_source_issue_count
                + report.summary.comparison_artifact_count
                + report.summary.missing_in_ros_count,
            report.summary.total_csv_skus
        );
        assert_eq!(
            report.summary.exact_match_count
                + report.summary.mismatched_count
                + report.summary.csv_source_issue_count,
            report.summary.matched_count
        );
        assert!(report.summary.extra_in_ros_count >= report.extra_rows.len() as i64);
    }

    #[test]
    fn ticket_amount_paid_prefers_explicit_tenders_when_present() {
        let payments = vec![
            TicketPaymentRow {
                pmt_typ: "CASH".into(),
                amount: Decimal::new(4000, 2),
                gift_cert_no: None,
            },
            TicketPaymentRow {
                pmt_typ: "CHECK".into(),
                amount: Decimal::new(1500, 2),
                gift_cert_no: None,
            },
        ];
        let gift_applications = vec![
            TicketGiftApplicationRow {
                gift_cert_no: "GC-1".into(),
                amount: Decimal::new(500, 2),
                action: Some("redeem".into()),
            },
            TicketGiftApplicationRow {
                gift_cert_no: "GC-2".into(),
                amount: Decimal::new(250, 2),
                action: Some("load".into()),
            },
        ];

        let paid = sum_counterpoint_ticket_tenders(&payments, &gift_applications)
            .expect("explicit tenders should produce a paid total");

        assert_eq!(paid, Decimal::new(6000, 2));
    }

    #[test]
    fn open_doc_amount_paid_prefers_explicit_payments_when_present() {
        let payments = vec![
            TicketPaymentRow {
                pmt_typ: "CASH".into(),
                amount: Decimal::new(2000, 2),
                gift_cert_no: None,
            },
            TicketPaymentRow {
                pmt_typ: "STORE CREDIT".into(),
                amount: Decimal::new(750, 2),
                gift_cert_no: None,
            },
        ];

        let paid = sum_counterpoint_open_doc_tenders(&payments)
            .expect("explicit payments should produce a paid total");

        assert_eq!(paid, Decimal::new(2750, 2));
    }

    #[tokio::test]
    async fn counterpoint_payment_method_resolves_compact_codes() {
        let pool = connect_test_db().await;
        let external_key = format!("CP-PMT-COMPACT-{}", Uuid::new_v4().simple());
        let mut pmt_map = HashMap::new();
        pmt_map.insert("CREDIT CARD".to_string(), "credit_card".to_string());

        let method = resolve_counterpoint_payment_method(
            &pool,
            &pmt_map,
            "open_docs",
            &external_key,
            "CREDITCARD",
        )
        .await;

        let issue_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM counterpoint_sync_issue WHERE entity = 'open_docs' AND external_key = $1)",
        )
        .bind(&external_key)
        .fetch_one(&pool)
        .await
        .expect("check compact payment method issue");

        assert_eq!(method, "credit_card");
        assert!(!issue_exists);
    }

    #[test]
    fn counterpoint_open_docs_stay_open_until_cancelled() {
        assert_eq!(
            order_status_for_cp_open_doc(None, Decimal::new(4000, 2), Decimal::new(4000, 2)),
            "open"
        );
        assert_eq!(
            order_status_for_cp_open_doc(Some("VOID"), Decimal::new(4000, 2), Decimal::ZERO),
            "cancelled"
        );
    }

    #[test]
    fn ros_currency_matches_storage_precision() {
        assert!(ros_currency_matches(
            Some(Decimal::new(118450, 4)),
            Decimal::new(1185, 2)
        ));
        assert!(!ros_currency_matches(
            Some(Decimal::new(300000, 4)),
            Decimal::new(2600, 2)
        ));
    }

    #[test]
    fn parent_row_fallback_is_comparison_artifact() {
        let csv_row = CounterpointInventoryCsvNormalizedRow {
            sku: "B-1493175".into(),
            name: "Cardi Solid Twill Neck Tie".into(),
            product_category: "TIES".into(),
            variant_label: "Champagne".into(),
            item_key: "I-103111".into(),
            supply_price: Some(Decimal::new(77500, 4)),
            retail_price: Some(Decimal::new(650000, 4)),
            inventory_quantity: Some(Decimal::new(-80000, 4)),
            supplier_name: "Cardi International".into(),
            supplier_code: String::new(),
            supplier_field_suspect: false,
            supplier_code_non_vendor_key: false,
        };
        let ros_row = CounterpointRosInventoryRow {
            variant_id: Uuid::new_v4(),
            product_id: Uuid::new_v4(),
            sku: "I-103111".into(),
            counterpoint_item_key: Some("I-103111".into()),
            variation_label: None,
            stock_on_hand: 0,
            retail_price: Decimal::new(6500, 2),
            supply_price: Decimal::new(775, 2),
            product_name: "Cardi Solid Twill Neck Tie".into(),
            catalog_handle: Some("I-103111".into()),
            category_name: Some("TIES".into()),
            primary_vendor_name: Some("Cardi International [CARDI]".into()),
            primary_vendor_code: Some("CARDI".into()),
        };

        assert!(is_parent_row_fallback_artifact(
            &csv_row,
            &ros_row,
            "counterpoint_item_key_singleton",
        ));
        assert!(!is_parent_row_fallback_artifact(&csv_row, &ros_row, "sku"));
    }

    #[tokio::test]
    async fn counterpoint_sync_run_counts_accumulate_within_run_and_reset_on_new_run() {
        let pool = connect_test_db().await;
        let entity = format!("counterpoint-run-test-{}", Uuid::new_v4().simple());

        begin_sync_run(&pool, &entity, Some("batch-0"))
            .await
            .expect("begin first run");
        record_sync_run(&pool, &entity, Some("batch-1"), true, Some(217), None)
            .await
            .expect("record first batch");
        record_sync_run(&pool, &entity, Some("batch-2"), true, Some(232), None)
            .await
            .expect("record second batch");

        let first_total: i32 = sqlx::query_scalar(
            "SELECT records_processed FROM counterpoint_sync_runs WHERE entity = $1",
        )
        .bind(&entity)
        .fetch_one(&pool)
        .await
        .expect("load accumulated total");
        assert_eq!(first_total, 449);

        begin_sync_run(&pool, &entity, Some("batch-0"))
            .await
            .expect("begin second run");
        let reset_total: i32 = sqlx::query_scalar(
            "SELECT records_processed FROM counterpoint_sync_runs WHERE entity = $1",
        )
        .bind(&entity)
        .fetch_one(&pool)
        .await
        .expect("load reset total");
        assert_eq!(reset_total, 0);

        record_sync_run(&pool, &entity, Some("batch-1"), true, Some(542), None)
            .await
            .expect("record first batch of second run");
        let second_total: i32 = sqlx::query_scalar(
            "SELECT records_processed FROM counterpoint_sync_runs WHERE entity = $1",
        )
        .bind(&entity)
        .fetch_one(&pool)
        .await
        .expect("load second total");
        assert_eq!(second_total, 542);

        sqlx::query("DELETE FROM counterpoint_sync_runs WHERE entity = $1")
            .bind(&entity)
            .execute(&pool)
            .await
            .expect("cleanup sync run row");
    }

    #[tokio::test]
    async fn counterpoint_ticket_gift_application_preserves_snapshot_balance() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let gift_code = format!("CPGC-{suffix}");
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("CP-TKT-SKU-{suffix}");
        let cp_key = format!("CP-TKT-ITEM-{suffix}");
        let ticket_ref = format!("CP-TKT-{suffix}");

        execute_counterpoint_gift_card_batch(
            &pool,
            CounterpointGiftCardsPayload {
                rows: vec![CounterpointGiftCardRow {
                    cert_no: gift_code.clone(),
                    balance: Decimal::new(10000, 2),
                    original_value: Some(Decimal::new(15000, 2)),
                    reason_cod: None,
                    expires_at: None,
                    issued_at: None,
                    events: vec![GiftCardEventRow {
                        event_kind: "redeem".into(),
                        amount: Decimal::new(5000, 2),
                        balance_after: Decimal::new(10000, 2),
                        created_at: Some(Utc::now().to_rfc3339()),
                        notes: Some("historical Counterpoint event ignored for snapshot".into()),
                    }],
                }],
                sync: None,
            },
        )
        .await
        .expect("import current gift card balance");

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active, data_source)
            VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("Counterpoint Ticket Fixture {suffix}"))
        .bind(Decimal::new(4000, 2))
        .bind(Decimal::new(1000, 2))
        .execute(&pool)
        .await
        .expect("insert ticket fixture product");

        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, '{}'::jsonb, 1, $4)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("insert ticket fixture variant");

        execute_counterpoint_ticket_batch(
            &pool,
            CounterpointTicketsPayload {
                rows: vec![CounterpointTicketRow {
                    ticket_ref: ticket_ref.clone(),
                    cust_no: None,
                    booked_at: Some(Utc::now().to_rfc3339()),
                    total_price: Decimal::new(4000, 2),
                    amount_paid: Decimal::ZERO,
                    usr_id: None,
                    sls_rep: None,
                    notes: None,
                    lines: vec![TicketLineRow {
                        sku: Some(sku.clone()),
                        counterpoint_item_key: Some(cp_key.clone()),
                        lin_seq_no: Some(1),
                        quantity: 1,
                        unit_price: Decimal::new(4000, 2),
                        unit_cost: Some(Decimal::new(1000, 2)),
                        description: Some("Gift tender test item".into()),
                        reason_code: None,
                    }],
                    payments: vec![],
                    gift_applications: vec![TicketGiftApplicationRow {
                        gift_cert_no: gift_code.clone(),
                        amount: Decimal::new(2500, 2),
                        action: Some("redeem".into()),
                    }],
                }],
                sync: None,
            },
        )
        .await
        .expect("import historical ticket with gift application");

        let balance: Decimal =
            sqlx::query_scalar("SELECT current_balance FROM gift_cards WHERE code = $1")
                .bind(&gift_code)
                .fetch_one(&pool)
                .await
                .expect("load gift card balance");
        assert_eq!(balance, Decimal::new(10000, 2));

        let event_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM gift_card_events e
            INNER JOIN gift_cards g ON g.id = e.gift_card_id
            WHERE g.code = $1
            "#,
        )
        .bind(&gift_code)
        .fetch_one(&pool)
        .await
        .expect("count gift card events");
        assert_eq!(event_count, 0);

        let gift_payment_sum: Decimal = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(pa.amount_allocated), 0)::numeric
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_ticket_ref = $1
              AND pt.payment_method = 'gift_card'
            "#,
        )
        .bind(&ticket_ref)
        .fetch_one(&pool)
        .await
        .expect("sum gift card payment allocations");
        assert_eq!(gift_payment_sum, Decimal::new(2500, 2));

        let payment_ids: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_ticket_ref = $1
            "#,
        )
        .bind(&ticket_ref)
        .fetch_all(&pool)
        .await
        .expect("load payment ids for cleanup");
        let transaction_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM transactions WHERE counterpoint_ticket_ref = $1")
                .bind(&ticket_ref)
                .fetch_all(&pool)
                .await
                .expect("load transaction ids for cleanup");

        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment allocations");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transaction lines");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transactions");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment transactions");
        sqlx::query("DELETE FROM gift_cards WHERE code = $1")
            .bind(&gift_code)
            .execute(&pool)
            .await
            .expect("cleanup gift card");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(&pool)
            .await
            .expect("cleanup variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup product");
    }

    #[tokio::test]
    async fn counterpoint_ticket_payment_methods_preserve_mapping_and_unmapped_truth() {
        let pool = connect_test_db().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("CP-PMT-SKU-{suffix}");
        let cp_key = format!("CP-PMT-ITEM-{suffix}");
        let ticket_ref = format!("CP-PMT-{suffix}");
        let mapped_cp_method = format!("CPMAP{}", &suffix[..8]).to_uppercase();
        let unmapped_cp_method = format!("CPUNKNOWN{}", &suffix[..8]).to_uppercase();

        sqlx::query(
            "INSERT INTO counterpoint_payment_method_map (cp_pmt_typ, ros_method) VALUES ($1, 'check')",
        )
        .bind(&mapped_cp_method)
        .execute(&pool)
        .await
        .expect("insert payment method map");

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active, data_source)
            VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("Counterpoint Payment Fixture {suffix}"))
        .bind(Decimal::new(4000, 2))
        .bind(Decimal::new(1000, 2))
        .execute(&pool)
        .await
        .expect("insert payment fixture product");

        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, '{}'::jsonb, 1, $4)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("insert payment fixture variant");

        execute_counterpoint_ticket_batch(
            &pool,
            CounterpointTicketsPayload {
                rows: vec![CounterpointTicketRow {
                    ticket_ref: ticket_ref.clone(),
                    cust_no: None,
                    booked_at: Some(Utc::now().to_rfc3339()),
                    total_price: Decimal::new(4000, 2),
                    amount_paid: Decimal::new(4000, 2),
                    usr_id: None,
                    sls_rep: None,
                    notes: None,
                    lines: vec![TicketLineRow {
                        sku: Some(sku.clone()),
                        counterpoint_item_key: Some(cp_key.clone()),
                        lin_seq_no: Some(1),
                        quantity: 1,
                        unit_price: Decimal::new(4000, 2),
                        unit_cost: Some(Decimal::new(1000, 2)),
                        description: Some("Payment map test item".into()),
                        reason_code: None,
                    }],
                    payments: vec![
                        TicketPaymentRow {
                            pmt_typ: mapped_cp_method.clone(),
                            amount: Decimal::new(2500, 2),
                            gift_cert_no: None,
                        },
                        TicketPaymentRow {
                            pmt_typ: unmapped_cp_method.clone(),
                            amount: Decimal::new(1500, 2),
                            gift_cert_no: None,
                        },
                    ],
                    gift_applications: vec![],
                }],
                sync: None,
            },
        )
        .await
        .expect("import ticket with mapped and unmapped payments");

        let methods: Vec<(String, String)> = sqlx::query_as(
            r#"
            SELECT pt.payment_method, pt.metadata->>'counterpoint_pmt_typ'
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_ticket_ref = $1
            ORDER BY pt.amount DESC
            "#,
        )
        .bind(&ticket_ref)
        .fetch_all(&pool)
        .await
        .expect("load imported payment methods");
        assert_eq!(
            methods,
            vec![
                ("check".to_string(), mapped_cp_method.clone()),
                (
                    "counterpoint_unmapped".to_string(),
                    unmapped_cp_method.clone()
                ),
            ]
        );

        let transaction_dates_and_status: (String, bool, bool) = sqlx::query_as(
            r#"
            SELECT status::text, business_date IS NOT NULL, fulfilled_at IS NOT NULL
            FROM transactions
            WHERE counterpoint_ticket_ref = $1
            "#,
        )
        .bind(&ticket_ref)
        .fetch_one(&pool)
        .await
        .expect("load imported ticket status and dates");
        assert_eq!(
            transaction_dates_and_status,
            ("fulfilled".to_string(), true, true)
        );

        let line_lifecycle: (bool, bool) = sqlx::query_as(
            r#"
            SELECT bool_and(tl.is_fulfilled), bool_and(tl.fulfilled_at IS NOT NULL)
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            WHERE t.counterpoint_ticket_ref = $1
            "#,
        )
        .bind(&ticket_ref)
        .fetch_one(&pool)
        .await
        .expect("load imported ticket line lifecycle");
        assert_eq!(line_lifecycle, (true, true));

        let payment_dates_populated: bool = sqlx::query_scalar(
            r#"
            SELECT bool_and(pt.effective_date IS NOT NULL)
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_ticket_ref = $1
            "#,
        )
        .bind(&ticket_ref)
        .fetch_one(&pool)
        .await
        .expect("check imported payment effective dates");
        assert!(payment_dates_populated);

        let unresolved_unmapped_issue_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_sync_issue
            WHERE entity = 'tickets'
              AND external_key = $1
              AND severity = 'error'
              AND NOT resolved
              AND message LIKE '%counterpoint_unmapped%'
            "#,
        )
        .bind(&ticket_ref)
        .fetch_one(&pool)
        .await
        .expect("count unmapped payment issue");
        assert_eq!(unresolved_unmapped_issue_count, 1);

        let payment_ids: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_ticket_ref = $1
            "#,
        )
        .bind(&ticket_ref)
        .fetch_all(&pool)
        .await
        .expect("load payment ids for cleanup");
        let transaction_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM transactions WHERE counterpoint_ticket_ref = $1")
                .bind(&ticket_ref)
                .fetch_all(&pool)
                .await
                .expect("load transaction ids for cleanup");

        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment allocations");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transaction lines");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transactions");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment transactions");
        sqlx::query(
            "DELETE FROM counterpoint_sync_issue WHERE entity = 'tickets' AND external_key = $1",
        )
        .bind(&ticket_ref)
        .execute(&pool)
        .await
        .expect("cleanup sync issue");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(&pool)
            .await
            .expect("cleanup variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup product");
        sqlx::query("DELETE FROM counterpoint_payment_method_map WHERE cp_pmt_typ = $1")
            .bind(&mapped_cp_method)
            .execute(&pool)
            .await
            .expect("cleanup payment method map");
    }

    #[tokio::test]
    async fn counterpoint_ticket_with_payment_and_no_lines_imports_fallback_line() {
        let pool = connect_test_db().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let ticket_ref = format!("CP-NO-LINES-{suffix}");

        let summary = execute_counterpoint_ticket_batch(
            &pool,
            CounterpointTicketsPayload {
                rows: vec![CounterpointTicketRow {
                    ticket_ref: ticket_ref.clone(),
                    cust_no: None,
                    booked_at: Some(Utc::now().to_rfc3339()),
                    total_price: Decimal::new(12500, 2),
                    amount_paid: Decimal::new(12500, 2),
                    usr_id: None,
                    sls_rep: None,
                    notes: None,
                    lines: vec![],
                    payments: vec![TicketPaymentRow {
                        pmt_typ: "CASH".into(),
                        amount: Decimal::new(12500, 2),
                        gift_cert_no: None,
                    }],
                    gift_applications: vec![],
                }],
                sync: None,
            },
        )
        .await
        .expect("import no-line paid ticket");

        let line_data: (String, Option<String>, Decimal) = sqlx::query_as(
            r#"
            SELECT pv.sku, tl.vendor_reference, tl.unit_price
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            INNER JOIN product_variants pv ON pv.id = tl.variant_id
            WHERE t.counterpoint_ticket_ref = $1
            "#,
        )
        .bind(&ticket_ref)
        .fetch_one(&pool)
        .await
        .expect("load fallback ticket line");
        let issue_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_sync_issue
            WHERE entity = 'tickets'
              AND external_key = $1
              AND NOT resolved
              AND message = 'Ticket had no line items; mapped sale total to fallback'
            "#,
        )
        .bind(&ticket_ref)
        .fetch_one(&pool)
        .await
        .expect("count no-line ticket issue");
        let payment_ids: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_ticket_ref = $1
            "#,
        )
        .bind(&ticket_ref)
        .fetch_all(&pool)
        .await
        .expect("load payment ids for cleanup");
        let transaction_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM transactions WHERE counterpoint_ticket_ref = $1")
                .bind(&ticket_ref)
                .fetch_all(&pool)
                .await
                .expect("load transaction ids for cleanup");

        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment allocations");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transaction lines");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transactions");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment transactions");
        sqlx::query(
            "DELETE FROM counterpoint_sync_issue WHERE entity = 'tickets' AND external_key = $1",
        )
        .bind(&ticket_ref)
        .execute(&pool)
        .await
        .expect("cleanup ticket issue");

        assert_eq!(summary.transactions_created, 1);
        assert_eq!(summary.line_items_created, 1);
        assert_eq!(summary.payments_created, 1);
        assert_eq!(summary.skipped, 0);
        assert_eq!(line_data.0, HISTORICAL_FALLBACK_SKU);
        assert_eq!(line_data.1.as_deref(), Some("COUNTERPOINT_NO_LINE_ITEMS"));
        assert_eq!(line_data.2, Decimal::new(12500, 2));
        assert_eq!(issue_count, 1);
    }

    #[tokio::test]
    async fn counterpoint_customer_import_sets_current_loyalty_points_without_history() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let customer_code = format!("CP-LOY-{suffix}");

        execute_counterpoint_customer_batch(
            &pool,
            CounterpointCustomersPayload {
                rows: vec![CounterpointCustomerRow {
                    cust_no: customer_code.clone(),
                    first_name: Some("Loyalty".into()),
                    last_name: Some("Snapshot".into()),
                    full_name: None,
                    company_name: None,
                    email: Some(format!("cp-loy-{suffix}@example.com")),
                    phone: None,
                    address_line1: None,
                    address_line2: None,
                    city: None,
                    state: None,
                    postal_code: None,
                    date_of_birth: None,
                    marketing_email_opt_in: None,
                    marketing_sms_opt_in: None,
                    loyalty_points: Some(1234),
                    customer_type: None,
                    ar_balance: None,
                    sls_rep: None,
                }],
                sync: None,
            },
        )
        .await
        .expect("import customer current loyalty balance");

        let (customer_id, loyalty_points): (Uuid, i32) = sqlx::query_as(
            "SELECT id, COALESCE(loyalty_points, 0)::int FROM customers WHERE customer_code = $1",
        )
        .bind(&customer_code)
        .fetch_one(&pool)
        .await
        .expect("load imported customer loyalty balance");
        assert_eq!(loyalty_points, 1234);

        let ledger_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM loyalty_point_ledger WHERE customer_id = $1",
        )
        .bind(customer_id)
        .fetch_one(&pool)
        .await
        .expect("count loyalty ledger rows");
        assert_eq!(ledger_rows, 0);

        sqlx::query("DELETE FROM customers WHERE id = $1")
            .bind(customer_id)
            .execute(&pool)
            .await
            .expect("cleanup loyalty snapshot customer");
    }

    #[tokio::test]
    async fn counterpoint_gift_card_snapshot_reconciliation_passes_when_totals_match() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let (landed_count, landed_sum): (i64, Decimal) = sqlx::query_as(
            "SELECT COUNT(*)::bigint, COALESCE(SUM(current_balance), 0)::numeric FROM gift_cards",
        )
        .fetch_one(&pool)
        .await
        .expect("load landed gift card totals");

        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "gift_cards".into(),
                source_count: landed_count,
                source_sum: landed_sum,
                source_checksum: None,
            },
        )
        .await
        .expect("record source gift card metrics");

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let row = snapshot_reconciliation_row(&summary, "gift_cards");
        let passed = row.passed;
        let status = row.status.clone();
        let count_difference = row.count_difference;
        let sum_difference = row
            .sum_difference
            .as_deref()
            .expect("sum difference")
            .parse::<Decimal>()
            .expect("parse sum difference");
        restore_counterpoint_config(&pool, original_config).await;

        assert!(passed);
        assert_eq!(status, "pass");
        assert_eq!(count_difference, Some(0));
        assert_eq!(sum_difference, Decimal::ZERO);
    }

    #[tokio::test]
    async fn counterpoint_gift_card_snapshot_reconciliation_fails_when_balance_sum_differs() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let (landed_count, landed_sum): (i64, Decimal) = sqlx::query_as(
            "SELECT COUNT(*)::bigint, COALESCE(SUM(current_balance), 0)::numeric FROM gift_cards",
        )
        .fetch_one(&pool)
        .await
        .expect("load landed gift card totals");

        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "gift_cards".into(),
                source_count: landed_count,
                source_sum: landed_sum + Decimal::ONE,
                source_checksum: None,
            },
        )
        .await
        .expect("record mismatched source gift card metrics");

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let row = snapshot_reconciliation_row(&summary, "gift_cards");
        let passed = row.passed;
        let status = row.status.clone();
        let count_difference = row.count_difference;
        let sum_difference = row
            .sum_difference
            .as_deref()
            .expect("sum difference")
            .parse::<Decimal>()
            .expect("parse sum difference");
        restore_counterpoint_config(&pool, original_config).await;

        assert!(!passed);
        assert_eq!(status, "fail");
        assert_eq!(count_difference, Some(0));
        assert_eq!(sum_difference, -Decimal::ONE);
    }

    #[tokio::test]
    async fn counterpoint_loyalty_snapshot_reconciliation_passes_when_totals_match() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let (landed_count, landed_sum): (i64, Decimal) = sqlx::query_as(
            r#"
            SELECT COUNT(*)::bigint, COALESCE(SUM(COALESCE(loyalty_points, 0)), 0)::numeric
            FROM customers
            WHERE customer_created_source = 'counterpoint'
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("load landed loyalty totals");

        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "loyalty_points".into(),
                source_count: landed_count,
                source_sum: landed_sum,
                source_checksum: None,
            },
        )
        .await
        .expect("record source loyalty metrics");

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let row = snapshot_reconciliation_row(&summary, "loyalty_points");
        let passed = row.passed;
        let status = row.status.clone();
        let count_difference = row.count_difference;
        let sum_difference = row
            .sum_difference
            .as_deref()
            .expect("sum difference")
            .parse::<Decimal>()
            .expect("parse sum difference");
        restore_counterpoint_config(&pool, original_config).await;

        assert!(passed);
        assert_eq!(status, "pass");
        assert_eq!(count_difference, Some(0));
        assert_eq!(sum_difference, Decimal::ZERO);
    }

    #[tokio::test]
    async fn counterpoint_loyalty_snapshot_reconciliation_fails_when_point_sum_differs() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let (landed_count, landed_sum): (i64, Decimal) = sqlx::query_as(
            r#"
            SELECT COUNT(*)::bigint, COALESCE(SUM(COALESCE(loyalty_points, 0)), 0)::numeric
            FROM customers
            WHERE customer_created_source = 'counterpoint'
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("load landed loyalty totals");

        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "loyalty_points".into(),
                source_count: landed_count,
                source_sum: landed_sum + Decimal::ONE,
                source_checksum: None,
            },
        )
        .await
        .expect("record mismatched source loyalty metrics");

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let row = snapshot_reconciliation_row(&summary, "loyalty_points");
        let passed = row.passed;
        let status = row.status.clone();
        let count_difference = row.count_difference;
        let sum_difference = row
            .sum_difference
            .as_deref()
            .expect("sum difference")
            .parse::<Decimal>()
            .expect("parse sum difference");
        restore_counterpoint_config(&pool, original_config).await;

        assert!(!passed);
        assert_eq!(status, "fail");
        assert_eq!(count_difference, Some(0));
        assert_eq!(sum_difference, -Decimal::ONE);
    }

    #[tokio::test]
    async fn counterpoint_customer_reconciliation_count_passes_when_totals_match() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let landed_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint'",
        )
        .fetch_one(&pool)
        .await
        .expect("load landed customer count");

        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "customers".into(),
                source_count: landed_count,
                source_sum: Decimal::ZERO,
                source_checksum: None,
            },
        )
        .await
        .expect("record source customer count");

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let row = snapshot_reconciliation_row(&summary, "customers");
        let passed = row.passed;
        let status = row.status.clone();
        let source_count = row.source_count;
        let count_difference = row.count_difference;
        restore_counterpoint_config(&pool, original_config).await;

        assert!(passed);
        assert_eq!(status, "pass");
        assert_eq!(source_count, Some(landed_count));
        assert_eq!(count_difference, Some(0));
    }

    #[test]
    fn counterpoint_live_catalog_sku_barcode_count_rows_reconcile() {
        for key in [
            "catalog_products",
            "catalog_variants",
            "catalog_variant_skus",
            "catalog_variant_barcodes",
        ] {
            let row = build_snapshot_reconciliation_row(
                key,
                "Catalog count",
                Some(SnapshotSourceMetric {
                    source_count: 12,
                    source_sum: Decimal::ZERO,
                    source_checksum: None,
                    updated_at: None,
                }),
                12,
                Decimal::ZERO,
            );

            assert!(row.passed);
            assert_eq!(row.status, "pass");
            assert_eq!(row.source_count, Some(12));
            assert_eq!(row.landed_count, 12);
            assert_eq!(row.count_difference, Some(0));
        }
    }

    #[test]
    fn counterpoint_field_checksum_reconciliation_passes_when_matching() {
        for (key, label) in [
            ("catalog_price_cost_fields", "Catalog price/cost fields"),
            (
                "catalog_category_vendor_fields",
                "Catalog category/vendor fields",
            ),
            ("catalog_variant_label_fields", "Catalog variant labels"),
            (
                "inventory_quantity_cost_fields",
                "Inventory quantity/cost fields",
            ),
        ] {
            let row = build_checksum_reconciliation_row(
                key,
                label,
                Some(SnapshotSourceMetric {
                    source_count: 4,
                    source_sum: Decimal::ZERO,
                    source_checksum: Some("abc123".into()),
                    updated_at: None,
                }),
                4,
                Some("abc123".into()),
            );

            assert!(row.passed);
            assert_eq!(row.status, "pass");
            assert_eq!(row.count_difference, Some(0));
            assert_eq!(row.checksum_matched, Some(true));
        }
    }

    #[test]
    fn counterpoint_field_checksum_reconciliation_fails_when_mismatched() {
        for (key, label) in [
            ("catalog_price_cost_fields", "Catalog price/cost fields"),
            (
                "catalog_category_vendor_fields",
                "Catalog category/vendor fields",
            ),
            ("catalog_variant_label_fields", "Catalog variant labels"),
            (
                "inventory_quantity_cost_fields",
                "Inventory quantity/cost fields",
            ),
        ] {
            let row = build_checksum_reconciliation_row(
                key,
                label,
                Some(SnapshotSourceMetric {
                    source_count: 4,
                    source_sum: Decimal::ZERO,
                    source_checksum: Some("abc123".into()),
                    updated_at: None,
                }),
                4,
                Some("def456".into()),
            );

            assert!(!row.passed);
            assert_eq!(row.status, "fail");
            assert_eq!(row.count_difference, Some(0));
            assert_eq!(row.checksum_matched, Some(false));
        }
    }

    #[test]
    fn counterpoint_field_checksum_reconciliation_requires_source_proof() {
        let row = build_checksum_reconciliation_row(
            "catalog_price_cost_fields",
            "Catalog price/cost fields",
            None,
            4,
            Some("abc123".into()),
        );

        assert!(!row.passed);
        assert_eq!(row.status, "missing_source");
        assert_eq!(row.source_count, None);
        assert_eq!(row.landed_checksum.as_deref(), Some("abc123"));

        let legacy_metric_row = build_checksum_reconciliation_row(
            "catalog_price_cost_fields",
            "Catalog price/cost fields",
            Some(SnapshotSourceMetric {
                source_count: 4,
                source_sum: Decimal::ZERO,
                source_checksum: None,
                updated_at: None,
            }),
            4,
            Some("abc123".into()),
        );

        assert!(!legacy_metric_row.passed);
        assert_eq!(legacy_metric_row.status, "missing_source");
        assert_eq!(legacy_metric_row.source_count, Some(4));
    }

    #[tokio::test]
    async fn counterpoint_checksum_source_metrics_rerun_updates_json() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;

        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "catalog_price_cost_fields".into(),
                source_count: 1,
                source_sum: Decimal::ZERO,
                source_checksum: Some("aaa111".into()),
            },
        )
        .await
        .expect("record first checksum metric");
        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "catalog_price_cost_fields".into(),
                source_count: 2,
                source_sum: Decimal::ZERO,
                source_checksum: Some("bbb222".into()),
            },
        )
        .await
        .expect("record replacement checksum metric");

        let config = load_counterpoint_config(&pool).await;
        let metric = &config["snapshot_reconciliation"]["catalog_price_cost_fields"];
        let source_count = metric["source_count"].as_i64();
        let source_checksum = metric["source_checksum"].as_str().map(str::to_string);
        restore_counterpoint_config(&pool, original_config).await;

        assert_eq!(source_count, Some(2));
        assert_eq!(source_checksum.as_deref(), Some("bbb222"));
    }

    #[tokio::test]
    async fn counterpoint_vendor_category_master_counts_reconcile() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let vendor_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM vendors WHERE NULLIF(TRIM(vendor_code), '') IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .expect("load landed vendor count");
        let category_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM counterpoint_category_map WHERE ros_category_id IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .expect("load landed category count");

        for (snapshot, count) in [
            ("counterpoint_vendors", vendor_count),
            ("counterpoint_categories", category_count),
        ] {
            record_counterpoint_snapshot_source_metrics(
                &pool,
                CounterpointSnapshotSourceMetricsPayload {
                    snapshot: snapshot.into(),
                    source_count: count,
                    source_sum: Decimal::ZERO,
                    source_checksum: None,
                },
            )
            .await
            .expect("record source metric");
        }

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let vendor_row = snapshot_reconciliation_row(&summary, "counterpoint_vendors");
        let category_row = snapshot_reconciliation_row(&summary, "counterpoint_categories");
        restore_counterpoint_config(&pool, original_config).await;

        assert!(vendor_row.passed);
        assert_eq!(vendor_row.source_count, Some(vendor_count));
        assert!(category_row.passed);
        assert_eq!(category_row.source_count, Some(category_count));
    }

    #[tokio::test]
    async fn counterpoint_catalog_unresolved_vendor_and_category_are_visible() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let product_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO products (
                id, catalog_handle, name, base_retail_price, base_cost, is_active, data_source
            )
            VALUES ($1, $2, $3, 0, 0, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("CP-MAP-MISS-{}", Uuid::new_v4().simple()))
        .bind("Counterpoint Mapping Missing Fixture")
        .execute(&pool)
        .await
        .expect("insert unmapped product fixture");
        let products_with_vendor: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint' AND primary_vendor_id IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .expect("load products with vendor count");
        let products_with_category: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint' AND category_id IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .expect("load products with category count");

        for (snapshot, count) in [
            ("catalog_items_with_vendor", products_with_vendor + 1),
            ("catalog_items_with_category", products_with_category + 1),
        ] {
            record_counterpoint_snapshot_source_metrics(
                &pool,
                CounterpointSnapshotSourceMetricsPayload {
                    snapshot: snapshot.into(),
                    source_count: count,
                    source_sum: Decimal::ZERO,
                    source_checksum: None,
                },
            )
            .await
            .expect("record source metric");
        }

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let vendor_row = snapshot_reconciliation_row(&summary, "catalog_items_with_vendor");
        let category_row = snapshot_reconciliation_row(&summary, "catalog_items_with_category");
        let vendor_status = vendor_row.status.clone();
        let category_status = category_row.status.clone();
        let vendor_diff = vendor_row.count_difference;
        let category_diff = category_row.count_difference;

        restore_counterpoint_config(&pool, original_config).await;
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup unmapped product fixture");

        assert_eq!(vendor_status, "fail");
        assert_eq!(vendor_diff, Some(-1));
        assert_eq!(category_status, "fail");
        assert_eq!(category_diff, Some(-1));
    }

    #[tokio::test]
    async fn counterpoint_vendor_category_missing_source_metrics_show_no_source_proof() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        restore_counterpoint_config(&pool, serde_json::json!({})).await;

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let vendor_row = snapshot_reconciliation_row(&summary, "counterpoint_vendors");
        let category_row = snapshot_reconciliation_row(&summary, "catalog_items_with_category");
        let vendor_status = vendor_row.status.clone();
        let category_status = category_row.status.clone();
        restore_counterpoint_config(&pool, original_config).await;

        assert_eq!(vendor_status, "missing_source");
        assert_eq!(category_status, "missing_source");
    }

    struct FidelityFixture {
        product_id: Uuid,
        variant_id: Uuid,
        category_id: Uuid,
        vendor_id: Uuid,
        item_no: String,
        sku: String,
        barcode: String,
        category: String,
        vendor_no: String,
    }

    async fn insert_fidelity_fixture(pool: &PgPool) -> FidelityFixture {
        let suffix = Uuid::new_v4().simple().to_string();
        let category_id = Uuid::new_v4();
        let vendor_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let item_no = format!("CP-FID-{suffix}");
        let sku = format!("CP-FID-SKU-{suffix}");
        let barcode = format!("CP-FID-BC-{suffix}");
        let category = format!("CP-FID-CAT-{suffix}");
        let vendor_no = format!("CP-FID-VEND-{suffix}");

        sqlx::query("INSERT INTO categories (id, name) VALUES ($1, $2)")
            .bind(category_id)
            .bind(format!("Counterpoint Fidelity Category {suffix}"))
            .execute(pool)
            .await
            .expect("insert fidelity category");
        sqlx::query(
            "INSERT INTO counterpoint_category_map (cp_category, ros_category_id) VALUES ($1, $2)",
        )
        .bind(&category)
        .bind(category_id)
        .execute(pool)
        .await
        .expect("insert fidelity category map");
        sqlx::query(
            "INSERT INTO vendors (id, name, vendor_code, is_active) VALUES ($1, $2, $3, TRUE)",
        )
        .bind(vendor_id)
        .bind(format!("Counterpoint Fidelity Vendor {suffix}"))
        .bind(&vendor_no)
        .execute(pool)
        .await
        .expect("insert fidelity vendor");
        sqlx::query(
            r#"
            INSERT INTO products (
                id, catalog_handle, name, base_retail_price, base_cost,
                is_active, data_source, category_id, primary_vendor_id
            )
            VALUES ($1, $2, $3, $4, $5, TRUE, 'counterpoint', $6, $7)
            "#,
        )
        .bind(product_id)
        .bind(&item_no)
        .bind(format!("Counterpoint Fidelity Product {suffix}"))
        .bind(Decimal::new(12000, 2))
        .bind(Decimal::new(4500, 2))
        .bind(category_id)
        .bind(vendor_id)
        .execute(pool)
        .await
        .expect("insert fidelity product");
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, barcode, variation_values, variation_label,
                stock_on_hand, counterpoint_item_key, retail_price_override, cost_override,
                counterpoint_prc_2, counterpoint_prc_3
            )
            VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8, $9, $10, $11)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .bind(&barcode)
        .bind("40R / Navy")
        .bind(7_i32)
        .bind(&item_no)
        .bind(Decimal::new(12000, 2))
        .bind(Decimal::new(4500, 2))
        .bind(Decimal::new(9500, 2))
        .bind(Decimal::new(8000, 2))
        .execute(pool)
        .await
        .expect("insert fidelity variant");

        FidelityFixture {
            product_id,
            variant_id,
            category_id,
            vendor_id,
            item_no,
            sku,
            barcode,
            category,
            vendor_no,
        }
    }

    async fn cleanup_fidelity_fixture(pool: &PgPool, fixture: &FidelityFixture) {
        sqlx::query(
            r#"
            DELETE FROM counterpoint_sync_issue
            WHERE entity = 'inventory_fidelity'
              AND external_key = ANY($1)
            "#,
        )
        .bind(vec![
            "catalog_price_cost_fields",
            "catalog_category_vendor_fields",
            "catalog_variant_label_fields",
            "inventory_quantity_cost_fields",
        ])
        .execute(pool)
        .await
        .expect("cleanup fidelity issues");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(fixture.variant_id)
            .execute(pool)
            .await
            .expect("cleanup fidelity variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(fixture.product_id)
            .execute(pool)
            .await
            .expect("cleanup fidelity product");
        sqlx::query("DELETE FROM counterpoint_category_map WHERE cp_category = $1")
            .bind(&fixture.category)
            .execute(pool)
            .await
            .expect("cleanup fidelity category map");
        sqlx::query("DELETE FROM categories WHERE id = $1")
            .bind(fixture.category_id)
            .execute(pool)
            .await
            .expect("cleanup fidelity category");
        sqlx::query("DELETE FROM vendors WHERE id = $1")
            .bind(fixture.vendor_id)
            .execute(pool)
            .await
            .expect("cleanup fidelity vendor");
    }

    fn fidelity_source_row(fixture: &FidelityFixture) -> CounterpointFidelityDiagnosticSourceRow {
        CounterpointFidelityDiagnosticSourceRow {
            item_no: Some(fixture.item_no.clone()),
            counterpoint_item_key: Some(fixture.item_no.clone()),
            sku: Some(fixture.sku.clone()),
            barcode: Some(fixture.barcode.clone()),
            retail_price: Some("120.00".into()),
            unit_cost: Some("45.00".into()),
            prc_2: Some("95.00".into()),
            prc_3: Some("80.00".into()),
            category: Some(fixture.category.clone()),
            vendor_no: Some(fixture.vendor_no.clone()),
            variation_label: Some("40R / Navy".into()),
            stock_on_hand: Some(7),
        }
    }

    async fn run_fidelity_diagnostic(
        pool: &PgPool,
        group: &str,
        rows: Vec<CounterpointFidelityDiagnosticSourceRow>,
        limit: Option<usize>,
    ) -> CounterpointFidelityDiagnosticReport {
        record_counterpoint_fidelity_diagnostics(
            pool,
            CounterpointFidelityDiagnosticPayload {
                group: group.into(),
                rows,
                limit,
            },
        )
        .await
        .expect("record fidelity diagnostic")
    }

    #[tokio::test]
    async fn counterpoint_fidelity_diagnostics_return_no_mismatches_when_fields_match() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let fixture = insert_fidelity_fixture(&pool).await;
        let row = fidelity_source_row(&fixture);

        for group in [
            "catalog_price_cost_fields",
            "catalog_category_vendor_fields",
            "catalog_variant_label_fields",
            "inventory_quantity_cost_fields",
        ] {
            let report = run_fidelity_diagnostic(&pool, group, vec![row.clone()], Some(50)).await;
            assert_eq!(report.mismatch_count, 0, "{group}");
            assert!(report.mismatches.is_empty(), "{group}");
        }

        restore_counterpoint_config(&pool, original_config).await;
        cleanup_fidelity_fixture(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn counterpoint_fidelity_diagnostics_return_field_mismatches() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let fixture = insert_fidelity_fixture(&pool).await;

        let mut price_row = fidelity_source_row(&fixture);
        price_row.retail_price = Some("121.00".into());
        let price_report = run_fidelity_diagnostic(
            &pool,
            "catalog_price_cost_fields",
            vec![price_row],
            Some(50),
        )
        .await;
        assert!(price_report
            .mismatches
            .iter()
            .any(|row| row.field == "retail_price"));

        let mut category_row = fidelity_source_row(&fixture);
        category_row.vendor_no = Some("WRONG-VENDOR".into());
        let category_report = run_fidelity_diagnostic(
            &pool,
            "catalog_category_vendor_fields",
            vec![category_row],
            Some(50),
        )
        .await;
        assert!(category_report
            .mismatches
            .iter()
            .any(|row| row.field == "vendor_no"));

        let mut label_row = fidelity_source_row(&fixture);
        label_row.variation_label = Some("42L / Black".into());
        let label_report = run_fidelity_diagnostic(
            &pool,
            "catalog_variant_label_fields",
            vec![label_row],
            Some(50),
        )
        .await;
        assert!(label_report
            .mismatches
            .iter()
            .any(|row| row.field == "variation_label"));

        let mut inventory_row = fidelity_source_row(&fixture);
        inventory_row.stock_on_hand = Some(9);
        let inventory_report = run_fidelity_diagnostic(
            &pool,
            "inventory_quantity_cost_fields",
            vec![inventory_row],
            Some(50),
        )
        .await;
        assert!(inventory_report
            .mismatches
            .iter()
            .any(|row| row.field == "stock_on_hand"));

        restore_counterpoint_config(&pool, original_config).await;
        cleanup_fidelity_fixture(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn counterpoint_fidelity_diagnostics_respect_result_limit() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let fixture = insert_fidelity_fixture(&pool).await;
        let mut row = fidelity_source_row(&fixture);
        row.retail_price = Some("121.00".into());
        row.unit_cost = Some("46.00".into());
        row.prc_2 = Some("96.00".into());

        let report =
            run_fidelity_diagnostic(&pool, "catalog_price_cost_fields", vec![row], Some(2)).await;

        restore_counterpoint_config(&pool, original_config).await;
        cleanup_fidelity_fixture(&pool, &fixture).await;

        assert_eq!(report.mismatch_count, 3);
        assert_eq!(report.mismatches.len(), 2);
        assert_eq!(report.result_limit, 2);
    }

    #[tokio::test]
    async fn counterpoint_open_doc_missing_customer_link_is_visible() {
        let pool = connect_test_db().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("CP-OPEN-CUST-SKU-{suffix}");
        let cp_key = format!("CP-OPEN-CUST-ITEM-{suffix}");
        let doc_ref = format!("CP-OPEN-CUST-{suffix}");
        let missing_customer = format!("CP-MISSING-{suffix}");

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active, data_source)
            VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("Counterpoint Open Doc Customer Fixture {suffix}"))
        .bind(Decimal::new(4000, 2))
        .bind(Decimal::new(1000, 2))
        .execute(&pool)
        .await
        .expect("insert product fixture");

        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, '{}'::jsonb, 1, $4)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("insert variant fixture");

        execute_counterpoint_open_doc_batch(
            &pool,
            CounterpointOpenDocsPayload {
                rows: vec![CounterpointOpenDocRow {
                    doc_ref: doc_ref.clone(),
                    cust_no: Some(missing_customer.clone()),
                    booked_at: Some(Utc::now().to_rfc3339()),
                    total_price: Decimal::new(4000, 2),
                    amount_paid: Decimal::ZERO,
                    usr_id: None,
                    sls_rep: None,
                    cp_status: None,
                    doc_typ: Some("O".into()),
                    lines: vec![TicketLineRow {
                        sku: Some(sku.clone()),
                        counterpoint_item_key: Some(cp_key.clone()),
                        lin_seq_no: Some(1),
                        quantity: 1,
                        unit_price: Decimal::new(4000, 2),
                        unit_cost: Some(Decimal::new(1000, 2)),
                        description: Some("Missing customer link test".into()),
                        reason_code: None,
                    }],
                    payments: vec![],
                }],
                sync: None,
            },
        )
        .await
        .expect("import open doc with missing customer");

        let issue_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_sync_issue
            WHERE entity = 'open_docs'
              AND external_key = $1
              AND NOT resolved
              AND message LIKE 'Customer unresolved:%'
            "#,
        )
        .bind(&doc_ref)
        .fetch_one(&pool)
        .await
        .expect("count unresolved customer issue");
        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let visibility = cutover_visibility_row(&summary, "open_doc_customer_links");
        assert_eq!(issue_count, 1);
        assert!(!visibility.passed);
        assert!(visibility.count >= 1);

        let payment_ids: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_doc_ref = $1
            "#,
        )
        .bind(&doc_ref)
        .fetch_all(&pool)
        .await
        .expect("load payment ids for cleanup");
        let transaction_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM transactions WHERE counterpoint_doc_ref = $1")
                .bind(&doc_ref)
                .fetch_all(&pool)
                .await
                .expect("load transaction ids for cleanup");
        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment allocations");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transaction lines");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transactions");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment transactions");
        sqlx::query(
            "DELETE FROM counterpoint_sync_issue WHERE entity = 'open_docs' AND external_key = $1",
        )
        .bind(&doc_ref)
        .execute(&pool)
        .await
        .expect("cleanup open doc issue");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(&pool)
            .await
            .expect("cleanup variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup product");
    }

    #[tokio::test]
    async fn counterpoint_open_doc_source_doc_and_line_counts_reconcile() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let suffix = Uuid::new_v4().simple().to_string();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("CP-OPEN-RECON-SKU-{suffix}");
        let cp_key = format!("CP-OPEN-RECON-ITEM-{suffix}");
        let doc_ref = format!("CP-OPEN-RECON-{suffix}");

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active, data_source)
            VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!(
            "Counterpoint Open Doc Reconciliation Fixture {suffix}"
        ))
        .bind(Decimal::new(4000, 2))
        .bind(Decimal::new(1000, 2))
        .execute(&pool)
        .await
        .expect("insert product fixture");

        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, '{}'::jsonb, 1, $4)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("insert variant fixture");

        execute_counterpoint_open_doc_batch(
            &pool,
            CounterpointOpenDocsPayload {
                rows: vec![CounterpointOpenDocRow {
                    doc_ref: doc_ref.clone(),
                    cust_no: None,
                    booked_at: Some(Utc::now().to_rfc3339()),
                    total_price: Decimal::new(8000, 2),
                    amount_paid: Decimal::ZERO,
                    usr_id: None,
                    sls_rep: None,
                    cp_status: None,
                    doc_typ: Some("O".into()),
                    lines: vec![
                        TicketLineRow {
                            sku: Some(sku.clone()),
                            counterpoint_item_key: Some(cp_key.clone()),
                            lin_seq_no: Some(1),
                            quantity: 1,
                            unit_price: Decimal::new(4000, 2),
                            unit_cost: Some(Decimal::new(1000, 2)),
                            description: Some("Open doc reconciliation item 1".into()),
                            reason_code: None,
                        },
                        TicketLineRow {
                            sku: Some(sku.clone()),
                            counterpoint_item_key: Some(cp_key.clone()),
                            lin_seq_no: Some(2),
                            quantity: 1,
                            unit_price: Decimal::new(4000, 2),
                            unit_cost: Some(Decimal::new(1000, 2)),
                            description: Some("Open doc reconciliation item 2".into()),
                            reason_code: None,
                        },
                    ],
                    payments: vec![],
                }],
                sync: None,
            },
        )
        .await
        .expect("import open doc");

        let landed_docs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM transactions WHERE counterpoint_doc_ref IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .expect("load landed open doc count");
        let landed_lines: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            WHERE t.counterpoint_doc_ref IS NOT NULL
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("load landed open doc line count");

        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "open_docs".into(),
                source_count: landed_docs,
                source_sum: Decimal::ZERO,
                source_checksum: None,
            },
        )
        .await
        .expect("record source open doc count");
        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "open_doc_lines".into(),
                source_count: landed_lines,
                source_sum: Decimal::ZERO,
                source_checksum: None,
            },
        )
        .await
        .expect("record source open doc line count");

        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let doc_row = snapshot_reconciliation_row(&summary, "open_docs");
        let line_row = snapshot_reconciliation_row(&summary, "open_doc_lines");
        let doc_passed = doc_row.passed;
        let doc_difference = doc_row.count_difference;
        let line_passed = line_row.passed;
        let line_difference = line_row.count_difference;

        let payment_ids: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_doc_ref = $1
            "#,
        )
        .bind(&doc_ref)
        .fetch_all(&pool)
        .await
        .expect("load payment ids for cleanup");
        let transaction_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM transactions WHERE counterpoint_doc_ref = $1")
                .bind(&doc_ref)
                .fetch_all(&pool)
                .await
                .expect("load transaction ids for cleanup");
        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment allocations");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transaction lines");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transactions");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment transactions");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(&pool)
            .await
            .expect("cleanup variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup product");
        restore_counterpoint_config(&pool, original_config).await;

        assert!(doc_passed);
        assert_eq!(doc_difference, Some(0));
        assert!(line_passed);
        assert_eq!(line_difference, Some(0));
    }

    #[tokio::test]
    async fn counterpoint_open_doc_duplicate_rows_merge_before_insert() {
        let pool = connect_test_db().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("CP-OPEN-DUPE-SKU-{suffix}");
        let cp_key = format!("CP-OPEN-DUPE-ITEM-{suffix}");
        let doc_ref = format!("CP-OPEN-DUPE-{suffix}");
        let booked_at = Utc::now().to_rfc3339();

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active, data_source)
            VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("Counterpoint Open Doc Duplicate Fixture {suffix}"))
        .bind(Decimal::new(4000, 2))
        .bind(Decimal::new(1000, 2))
        .execute(&pool)
        .await
        .expect("insert product fixture");

        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, '{}'::jsonb, 1, $4)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("insert variant fixture");

        let repeated_line = || TicketLineRow {
            sku: Some(sku.clone()),
            counterpoint_item_key: Some(cp_key.clone()),
            lin_seq_no: Some(1),
            quantity: 1,
            unit_price: Decimal::new(4000, 2),
            unit_cost: Some(Decimal::new(1000, 2)),
            description: Some("Duplicate open doc line".into()),
            reason_code: None,
        };
        let repeated_payment = || TicketPaymentRow {
            pmt_typ: "CREDITCARD".into(),
            amount: Decimal::new(2000, 2),
            gift_cert_no: None,
        };

        let summary = execute_counterpoint_open_doc_batch(
            &pool,
            CounterpointOpenDocsPayload {
                rows: vec![
                    CounterpointOpenDocRow {
                        doc_ref: doc_ref.clone(),
                        cust_no: None,
                        booked_at: Some(booked_at.clone()),
                        total_price: Decimal::new(4590, 2),
                        amount_paid: Decimal::new(2000, 2),
                        usr_id: None,
                        sls_rep: None,
                        cp_status: None,
                        doc_typ: Some("O".into()),
                        lines: vec![repeated_line()],
                        payments: vec![repeated_payment()],
                    },
                    CounterpointOpenDocRow {
                        doc_ref: doc_ref.clone(),
                        cust_no: None,
                        booked_at: Some(booked_at.clone()),
                        total_price: Decimal::new(4000, 2),
                        amount_paid: Decimal::ZERO,
                        usr_id: None,
                        sls_rep: None,
                        cp_status: None,
                        doc_typ: Some("O".into()),
                        lines: vec![repeated_line()],
                        payments: vec![repeated_payment()],
                    },
                    CounterpointOpenDocRow {
                        doc_ref: doc_ref.clone(),
                        cust_no: None,
                        booked_at: Some(booked_at),
                        total_price: Decimal::ZERO,
                        amount_paid: Decimal::ZERO,
                        usr_id: None,
                        sls_rep: None,
                        cp_status: None,
                        doc_typ: Some("O".into()),
                        lines: vec![repeated_line()],
                        payments: vec![repeated_payment()],
                    },
                ],
                sync: None,
            },
        )
        .await
        .expect("import duplicate open doc rows");

        let transaction: (Uuid, Decimal, Decimal, Decimal) = sqlx::query_as(
            "SELECT id, total_price, amount_paid, balance_due FROM transactions WHERE counterpoint_doc_ref = $1",
        )
        .bind(&doc_ref)
        .fetch_one(&pool)
        .await
        .expect("load imported transaction");
        let line_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM transaction_lines WHERE transaction_id = $1",
        )
        .bind(transaction.0)
        .fetch_one(&pool)
        .await
        .expect("count imported lines");
        let payment_summary: (i64, Decimal) = sqlx::query_as(
            "SELECT COUNT(*)::bigint, COALESCE(SUM(amount_allocated), 0)::numeric FROM payment_allocations WHERE target_transaction_id = $1",
        )
        .bind(transaction.0)
        .fetch_one(&pool)
        .await
        .expect("summarize imported payments");
        let payment_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT transaction_id FROM payment_allocations WHERE target_transaction_id = $1",
        )
        .bind(transaction.0)
        .fetch_all(&pool)
        .await
        .expect("load payment ids for cleanup");

        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = $1")
            .bind(transaction.0)
            .execute(&pool)
            .await
            .expect("cleanup payment allocations");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = $1")
            .bind(transaction.0)
            .execute(&pool)
            .await
            .expect("cleanup transaction lines");
        sqlx::query("DELETE FROM transactions WHERE id = $1")
            .bind(transaction.0)
            .execute(&pool)
            .await
            .expect("cleanup transaction");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment transactions");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(&pool)
            .await
            .expect("cleanup variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup product");

        assert_eq!(summary.transactions_created, 1);
        assert_eq!(summary.line_items_created, 1);
        assert_eq!(summary.payments_created, 1);
        assert_eq!(line_count, 1);
        assert_eq!(payment_summary.0, 1);
        assert_eq!(payment_summary.1, Decimal::new(2000, 2));
        assert_eq!(transaction.1, Decimal::new(4590, 2));
        assert_eq!(transaction.2, Decimal::new(2000, 2));
        assert_eq!(transaction.3, Decimal::new(2590, 2));
    }

    #[tokio::test]
    async fn counterpoint_open_doc_unresolved_lines_are_visible_and_deduped() {
        let pool = connect_test_db().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let doc_ref = format!("CP-OPEN-LINE-MISS-{suffix}");
        let missing_sku = format!("CP-OPEN-MISSING-SKU-{suffix}");
        let missing_key = format!("CP-OPEN-MISSING-ITEM-{suffix}");
        let payload = || CounterpointOpenDocsPayload {
            rows: vec![CounterpointOpenDocRow {
                doc_ref: doc_ref.clone(),
                cust_no: None,
                booked_at: Some(Utc::now().to_rfc3339()),
                total_price: Decimal::new(4000, 2),
                amount_paid: Decimal::ZERO,
                usr_id: None,
                sls_rep: None,
                cp_status: None,
                doc_typ: Some("O".into()),
                lines: vec![TicketLineRow {
                    sku: Some(missing_sku.clone()),
                    counterpoint_item_key: Some(missing_key.clone()),
                    lin_seq_no: Some(1),
                    quantity: 1,
                    unit_price: Decimal::new(4000, 2),
                    unit_cost: Some(Decimal::new(1000, 2)),
                    description: Some("Unresolved line test".into()),
                    reason_code: None,
                }],
                payments: vec![],
            }],
            sync: None,
        };

        let first = execute_counterpoint_open_doc_batch(&pool, payload())
            .await
            .expect("first unresolved open doc import");
        let second = execute_counterpoint_open_doc_batch(&pool, payload())
            .await
            .expect("rerun unresolved open doc import");

        let issue_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM counterpoint_sync_issue
            WHERE entity = 'open_docs'
              AND external_key = $1
              AND NOT resolved
              AND message LIKE 'Mapped % unresolved line item(s) to fallback'
            "#,
        )
        .bind(&doc_ref)
        .fetch_one(&pool)
        .await
        .expect("count unresolved line issues");

        let fallback_line: (Uuid, Option<String>, String) = sqlx::query_as(
            r#"
            SELECT tl.variant_id, tl.vendor_reference, tl.order_lifecycle_status::text
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            WHERE t.counterpoint_doc_ref = $1
            "#,
        )
        .bind(&doc_ref)
        .fetch_one(&pool)
        .await
        .expect("fetch fallback open doc line");
        let fallback_variant_id: Uuid =
            sqlx::query_scalar("SELECT id FROM product_variants WHERE sku = $1")
                .bind(HISTORICAL_FALLBACK_SKU)
                .fetch_one(&pool)
                .await
                .expect("load fallback variant");

        // Create the missing catalog item and variant
        let category_id: Uuid = sqlx::query_scalar(
            "INSERT INTO categories (name, is_clothing_footwear) VALUES ($1, false) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id"
        )
        .bind(format!("Cat-{suffix}"))
        .fetch_one(&pool)
        .await
        .expect("insert category");

        let product_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO products (catalog_handle, name, base_retail_price, base_cost, is_active, data_source, category_id)
            VALUES ($1, $2, 40.00, 10.00, true, 'counterpoint', $3)
            RETURNING id
            "#
        )
        .bind(format!("prod-{suffix}"))
        .bind(format!("Unresolved Line Test Product {suffix}"))
        .bind(category_id)
        .fetch_one(&pool)
        .await
        .expect("insert product");

        let variant_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO product_variants (product_id, sku, counterpoint_item_key, variation_values, variation_label, stock_on_hand)
            VALUES ($1, $2, $3, '{}'::jsonb, 'Standard', 0)
            RETURNING id
            "#
        )
        .bind(product_id)
        .bind(&missing_sku)
        .bind(&missing_key)
        .fetch_one(&pool)
        .await
        .expect("insert variant");

        let resolved_count = resolve_unresolved_counterpoint_lines(&pool)
            .await
            .expect("resolve fallback open doc line");

        // Verify the line has been updated and vendor_reference is NULL
        let line_data: (Uuid, Option<String>) = sqlx::query_as(
            "SELECT variant_id, vendor_reference FROM transaction_lines tl
             INNER JOIN transactions t ON t.id = tl.transaction_id
             WHERE t.counterpoint_doc_ref = $1",
        )
        .bind(&doc_ref)
        .fetch_one(&pool)
        .await
        .expect("fetch transaction line data");
        assert_eq!(line_data.0, variant_id);
        assert_eq!(line_data.1, None);

        // Clean up
        let payment_ids: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.counterpoint_doc_ref = $1
            "#,
        )
        .bind(&doc_ref)
        .fetch_all(&pool)
        .await
        .expect("load payment ids for cleanup");
        let transaction_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM transactions WHERE counterpoint_doc_ref = $1")
                .bind(&doc_ref)
                .fetch_all(&pool)
                .await
                .expect("load transaction ids for cleanup");
        sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment allocations");
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transaction lines");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&transaction_ids)
            .execute(&pool)
            .await
            .expect("cleanup transactions");
        sqlx::query("DELETE FROM payment_transactions WHERE id = ANY($1)")
            .bind(&payment_ids)
            .execute(&pool)
            .await
            .expect("cleanup payment transactions");
        sqlx::query(
            "DELETE FROM counterpoint_sync_issue WHERE entity = 'open_docs' AND external_key = $1",
        )
        .bind(&doc_ref)
        .execute(&pool)
        .await
        .expect("cleanup open doc issue");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(&pool)
            .await
            .expect("cleanup variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup product");

        assert_eq!(first.transactions_created, 1);
        assert_eq!(first.line_items_created, 1);
        assert_eq!(first.skipped, 0);
        assert_eq!(second.transactions_created, 0);
        assert_eq!(second.transactions_skipped_existing, 1);
        assert_eq!(second.skipped, 0);
        assert_eq!(issue_count, 1);
        assert_eq!(fallback_line.0, fallback_variant_id);
        assert_eq!(fallback_line.1.as_deref(), Some(missing_key.as_str()));
        assert_eq!(fallback_line.2, "ready_for_pickup");
        assert_eq!(resolved_count, 1);
    }

    #[tokio::test]
    async fn counterpoint_inventory_unmatched_rows_are_visible_and_deduped() {
        let _guard = SNAPSHOT_RECONCILIATION_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let original_config = load_counterpoint_config(&pool).await;
        let preexisting_inventory_issues: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM counterpoint_sync_issue WHERE entity = 'inventory' AND NOT resolved",
        )
        .fetch_all(&pool)
        .await
        .expect("load preexisting inventory issues");
        if !preexisting_inventory_issues.is_empty() {
            sqlx::query(
                "UPDATE counterpoint_sync_issue SET resolved = TRUE, resolved_at = NOW() WHERE id = ANY($1)",
            )
            .bind(&preexisting_inventory_issues)
            .execute(&pool)
            .await
            .expect("temporarily resolve preexisting inventory issues");
        }

        let suffix = numeric_identity_suffix();
        let sku = format!("B-{suffix}90");
        let cp_parent_key = format!("I-{suffix}90");
        let cp_key = format!("{cp_parent_key}|RED|42");
        let payload = || CounterpointInventoryPayload {
            rows: vec![CounterpointInventoryRow {
                sku: sku.clone(),
                stock_on_hand: 7,
                counterpoint_item_key: Some(cp_key.clone()),
                unit_cost: Some(Decimal::new(1200, 2)),
            }],
            sync: None,
        };

        let first = execute_counterpoint_inventory_batch(&pool, payload())
            .await
            .expect("first unmatched inventory import");
        let second = execute_counterpoint_inventory_batch(&pool, payload())
            .await
            .expect("rerun unmatched inventory import");
        let issue_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM counterpoint_sync_issue WHERE entity = 'inventory' AND external_key = $1 AND NOT resolved",
        )
        .bind(&cp_key)
        .fetch_one(&pool)
        .await
        .expect("count inventory issue");

        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active, data_source)
            VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
            "#,
        )
        .bind(product_id)
        .bind(format!("Counterpoint Inventory Fixture {suffix}"))
        .bind(Decimal::new(4000, 2))
        .bind(Decimal::new(1000, 2))
        .execute(&pool)
        .await
        .expect("insert inventory product fixture");
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
            )
            VALUES ($1, $2, $3, '{}'::jsonb, 0, $4)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("insert inventory variant fixture");

        let matched = execute_counterpoint_inventory_batch(&pool, payload())
            .await
            .expect("matched inventory import");
        record_counterpoint_snapshot_source_metrics(
            &pool,
            CounterpointSnapshotSourceMetricsPayload {
                snapshot: "inventory_quantity_rows".into(),
                source_count: 1,
                source_sum: Decimal::ZERO,
                source_checksum: None,
            },
        )
        .await
        .expect("record inventory source count");
        let summary = build_counterpoint_landing_verification_summary(&pool)
            .await
            .expect("build landing verification");
        let row = snapshot_reconciliation_row(&summary, "inventory_quantity_rows");
        let row_passed = row.passed;
        let row_source_count = row.source_count;
        let row_landed_count = row.landed_count;
        let unresolved_after_match: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM counterpoint_sync_issue WHERE entity = 'inventory' AND external_key = $1 AND NOT resolved",
        )
        .bind(&cp_key)
        .fetch_one(&pool)
        .await
        .expect("count resolved inventory issue");

        restore_counterpoint_config(&pool, original_config).await;
        sqlx::query(
            "DELETE FROM counterpoint_sync_issue WHERE entity = 'inventory' AND external_key = $1",
        )
        .bind(&cp_key)
        .execute(&pool)
        .await
        .expect("cleanup inventory issue");
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(&pool)
            .await
            .expect("cleanup inventory variant");
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(&pool)
            .await
            .expect("cleanup inventory product");
        if !preexisting_inventory_issues.is_empty() {
            sqlx::query(
                "UPDATE counterpoint_sync_issue SET resolved = FALSE, resolved_at = NULL WHERE id = ANY($1)",
            )
            .bind(&preexisting_inventory_issues)
            .execute(&pool)
            .await
            .expect("restore preexisting inventory issues");
        }

        assert_eq!(first.updated, 0);
        assert_eq!(first.skipped, 1);
        assert_eq!(second.updated, 0);
        assert_eq!(issue_count, 1);
        assert_eq!(matched.updated, 1);
        assert_eq!(matched.skipped, 0);
        assert_eq!(unresolved_after_match, 0);
        assert!(row_passed);
        assert_eq!(row_source_count, Some(1));
        assert_eq!(row_landed_count, 1);
    }

    #[tokio::test]
    async fn counterpoint_baseline_reset_preserves_bootstrap_and_clears_migration_state() {
        let pool = connect_test_db().await;
        let preserved_code = next_staff_code(&pool).await;
        let mut imported_code = next_staff_code(&pool).await;
        while imported_code == preserved_code {
            imported_code = next_staff_code(&pool).await;
        }

        let result = async {
            let mut tx = pool.begin().await.expect("begin reset test transaction");
            sqlx::query("INSERT INTO counterpoint_bridge_heartbeat (id) VALUES (1) ON CONFLICT DO NOTHING")
                .execute(&mut *tx)
                .await
                .expect("insert heartbeat row if missing");
            let category_id = Uuid::new_v4();
            sqlx::query("INSERT INTO categories (id, name) VALUES ($1, $2)")
                .bind(category_id)
                .bind(format!("Counterpoint Reset Category {}", Uuid::new_v4().simple()))
                .execute(&mut *tx)
                .await
                .expect("insert category");

            sqlx::query(
                "INSERT INTO counterpoint_category_map (cp_category, ros_category_id) VALUES ($1, $2)",
            )
            .bind(format!("CP-CAT-{}", Uuid::new_v4().simple()))
            .bind(category_id)
            .execute(&mut *tx)
            .await
            .expect("insert category map");
            sqlx::query(
                "INSERT INTO counterpoint_payment_method_map (cp_pmt_typ, ros_method) VALUES ($1, 'cash')",
            )
            .bind(format!("CP-PMT-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert payment map");
            sqlx::query(
                "INSERT INTO counterpoint_gift_reason_map (cp_reason_cod, ros_card_kind) VALUES ($1, 'purchased')",
            )
            .bind(format!("CP-GIFT-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert gift reason map");

            let preserved_staff_id = Uuid::new_v4();
            let preserved_pin = hash_pin(&preserved_code).expect("hash preserved staff pin");
            sqlx::query(
                r#"
                INSERT INTO staff (
                    id, full_name, cashier_code, pin_hash, role, is_active, avatar_key,
                    data_source, counterpoint_user_id, counterpoint_sls_rep
                )
                VALUES ($1, $2, $3, $4, 'admin', TRUE, 'ros_default', 'counterpoint', $5, $6)
                "#,
            )
            .bind(preserved_staff_id)
            .bind(format!(
                "Counterpoint Reset Keeper {}",
                Uuid::new_v4().simple()
            ))
            .bind(&preserved_code)
            .bind(preserved_pin)
            .bind(format!("USR-{}", Uuid::new_v4().simple()))
            .bind(format!("REP-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert preserved staff");

            let imported_staff_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO staff (
                    id, full_name, cashier_code, role, is_active, avatar_key,
                    data_source, counterpoint_user_id
                )
                VALUES ($1, $2, $3, 'sales_support', TRUE, 'ros_default', 'counterpoint', $4)
                "#,
            )
            .bind(imported_staff_id)
            .bind(format!(
                "Counterpoint Reset Imported Staff {}",
                Uuid::new_v4().simple()
            ))
            .bind(&imported_code)
            .bind(format!("USR-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert imported staff");

            let imported_customer_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO customers (
                    id, customer_code, first_name, last_name, email, customer_created_source
                )
                VALUES ($1, $2, $3, $4, $5, 'counterpoint')
                "#,
            )
            .bind(imported_customer_id)
            .bind(format!("CP-CUST-{}", Uuid::new_v4().simple()))
            .bind("Counterpoint")
            .bind("Customer")
            .bind(format!(
                "counterpoint-reset-{}@example.com",
                Uuid::new_v4().simple()
            ))
            .execute(&mut *tx)
            .await
            .expect("insert imported customer");

            let imported_product_id = Uuid::new_v4();
            let imported_variant_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO products (
                    id, name, base_retail_price, base_cost, is_active, data_source
                )
                VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
                "#,
            )
            .bind(imported_product_id)
            .bind("Counterpoint Reset Product")
            .bind(Decimal::new(12999, 2))
            .bind(Decimal::new(4599, 2))
            .execute(&mut *tx)
            .await
            .expect("insert imported product");
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
                )
                VALUES ($1, $2, $3, '{}'::jsonb, 5, $4)
                "#,
            )
            .bind(imported_variant_id)
            .bind(imported_product_id)
            .bind(format!("CP-RESET-{}", Uuid::new_v4().simple()))
            .bind(format!("CP-ITEM-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert imported variant");

            let vendor_id = Uuid::new_v4();
            sqlx::query("INSERT INTO vendors (id, name, is_active) VALUES ($1, $2, TRUE)")
                .bind(vendor_id)
                .bind(format!("Counterpoint Reset Vendor {}", Uuid::new_v4().simple()))
                .execute(&mut *tx)
                .await
                .expect("insert vendor");

            let imported_transaction_id = Uuid::new_v4();
            let manual_transaction_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO transactions (
                    id, customer_id, status, total_price, balance_due, is_counterpoint_import
                )
                VALUES ($1, $2, 'open', $3, $4, TRUE)
                "#,
            )
            .bind(imported_transaction_id)
            .bind(imported_customer_id)
            .bind(Decimal::new(25000, 2))
            .bind(Decimal::new(0, 2))
            .execute(&mut *tx)
            .await
            .expect("insert imported transaction");
            sqlx::query(
                r#"
                INSERT INTO transactions (
                    id, customer_id, status, total_price, balance_due, is_counterpoint_import
                )
                VALUES ($1, $2, 'open', $3, $4, FALSE)
                "#,
            )
            .bind(manual_transaction_id)
            .bind(imported_customer_id)
            .bind(Decimal::new(5000, 2))
            .bind(Decimal::new(5000, 2))
            .execute(&mut *tx)
            .await
            .expect("insert customer-linked manual transaction");

            let payment_transaction_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO payment_transactions (
                    id, payer_id, payment_method, amount
                )
                VALUES ($1, $2, 'cash', $3)
                "#,
            )
            .bind(payment_transaction_id)
            .bind(imported_customer_id)
            .bind(Decimal::new(25000, 2))
            .execute(&mut *tx)
            .await
            .expect("insert payment transaction");
            sqlx::query(
                r#"
                INSERT INTO payment_allocations (
                    id, transaction_id, target_transaction_id, amount_allocated
                )
                VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(payment_transaction_id)
            .bind(imported_transaction_id)
            .bind(Decimal::new(25000, 2))
            .execute(&mut *tx)
            .await
            .expect("insert payment allocation");

            let gift_card_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO gift_cards (
                    id, code, current_balance, is_liability, expires_at, card_kind, card_status,
                    original_value, customer_id
                )
                VALUES ($1, $2, $3, TRUE, $4, 'purchased', 'active', $5, $6)
                "#,
            )
            .bind(gift_card_id)
            .bind(format!("CPRESET{}", Uuid::new_v4().simple()))
            .bind(Decimal::new(5000, 2))
            .bind(Utc::now() + Duration::days(30))
            .bind(Decimal::new(5000, 2))
            .bind(imported_customer_id)
            .execute(&mut *tx)
            .await
            .expect("insert gift card");
            sqlx::query(
                r#"
                INSERT INTO gift_card_events (
                    gift_card_id, event_kind, amount, balance_after, staff_id
                )
                VALUES ($1, 'issued', $2, $3, $4)
                "#,
            )
            .bind(gift_card_id)
            .bind(Decimal::new(5000, 2))
            .bind(Decimal::new(5000, 2))
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert gift card event");

            sqlx::query(
                r#"
                INSERT INTO loyalty_point_ledger (
                    customer_id, delta_points, balance_after, reason, created_by_staff_id
                )
                VALUES ($1, 10, 10, 'manual_adjust', $2)
                "#,
            )
            .bind(imported_customer_id)
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert loyalty ledger");
            sqlx::query(
                r#"
                INSERT INTO loyalty_reward_issuances (
                    customer_id, points_deducted, reward_amount, applied_to_sale, remainder_card_id,
                    issued_by_staff_id
                )
                VALUES ($1, 5000, 50.00, 0, $2, $3)
                "#,
            )
            .bind(imported_customer_id)
            .bind(gift_card_id)
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert loyalty issuance");
            sqlx::query(
                "INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, $2)",
            )
            .bind(imported_customer_id)
            .bind(Decimal::new(1500, 2))
            .execute(&mut *tx)
            .await
            .expect("insert store credit account");

            sqlx::query(
                r#"
                INSERT INTO counterpoint_sync_runs (
                    entity, cursor_value, last_ok_at, records_processed
                )
                VALUES ($1, $2, NOW(), 7)
                "#,
            )
            .bind(format!("reset-test-entity-{}", Uuid::new_v4().simple()))
            .bind("cursor-1")
            .execute(&mut *tx)
            .await
            .expect("insert sync run");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_sync_issue (entity, external_key, severity, message)
                VALUES ('customers', $1, 'warning', 'test issue')
                "#,
            )
            .bind(format!("ext-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert sync issue");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_sync_request (requested_by, entity)
                VALUES ($1, 'customers')
                "#,
            )
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert sync request");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_staging_batch (
                    entity, payload, row_count, status, applied_by_staff_id
                )
                VALUES ('customers', '{}'::jsonb, 1, 'pending', $1)
                "#,
            )
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert staging batch");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_receiving_history (
                    vend_no, item_no, recv_dat, unit_cost, qty_recv, recv_no
                )
                VALUES ('V1', 'ITEM1', $1, $2, $3, 'RCV1')
                "#,
            )
            .bind(
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .expect("valid date")
                    .and_hms_opt(10, 0, 0)
                    .expect("valid time")
                    .and_utc(),
            )
            .bind(Decimal::new(2500, 2))
            .bind(Decimal::new(2, 0))
            .execute(&mut *tx)
            .await
            .expect("insert receiving history");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id)
                VALUES ($1, 'user', $2)
                "#,
            )
            .bind(format!("USRMAP-{}", Uuid::new_v4().simple()))
            .bind(imported_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert staff map");
            sqlx::query(
                r#"
                UPDATE counterpoint_bridge_heartbeat
                SET bridge_phase = 'running',
                    current_entity = 'customers',
                    bridge_version = 'test-version',
                    bridge_hostname = 'test-host'
                WHERE id = 1
                "#,
            )
            .execute(&mut *tx)
            .await
            .expect("update heartbeat");

            let targets = CounterpointBaselineResetTargets {
                counterpoint_customer_ids: vec![imported_customer_id],
                counterpoint_product_ids: vec![imported_product_id],
                counterpoint_variant_ids: vec![imported_variant_id],
                vendor_ids: vec![vendor_id],
                gift_card_ids: vec![gift_card_id],
                loyalty_reward_issuance_ids: sqlx::query_scalar(
                    "SELECT id FROM loyalty_reward_issuances WHERE customer_id = $1",
                )
                .bind(imported_customer_id)
                .fetch_all(&mut *tx)
                .await
                .expect("load loyalty issuance ids"),
                loyalty_point_ledger_ids: sqlx::query_scalar(
                    "SELECT id FROM loyalty_point_ledger WHERE customer_id = $1",
                )
                .bind(imported_customer_id)
                .fetch_all(&mut *tx)
                .await
                .expect("load loyalty ledger ids"),
                store_credit_account_ids: sqlx::query_scalar(
                    "SELECT id FROM store_credit_accounts WHERE customer_id = $1",
                )
                .bind(imported_customer_id)
                .fetch_all(&mut *tx)
                .await
                .expect("load store credit ids"),
                counterpoint_only_staff_ids: vec![imported_staff_id],
                counterpoint_transaction_ids: vec![imported_transaction_id, manual_transaction_id],
                counterpoint_sync_run_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_runs")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load sync run ids"),
                counterpoint_sync_issue_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_issue")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load sync issue ids"),
                counterpoint_sync_request_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_request")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load sync request ids"),
                counterpoint_staging_batch_ids: sqlx::query_scalar("SELECT id FROM counterpoint_staging_batch")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load staging batch ids"),
                counterpoint_receiving_history_ids: sqlx::query_scalar("SELECT id FROM counterpoint_receiving_history")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load receiving history ids"),
                counterpoint_staff_map_staff_ids: vec![imported_staff_id],
                counterpoint_category_map_ids: sqlx::query_scalar("SELECT id FROM counterpoint_category_map")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load category map ids"),
                counterpoint_import_run_ids: Vec::new(),
                counterpoint_import_exception_ids: Vec::new(),
            };

            perform_counterpoint_baseline_reset_targets(&mut tx, &targets)
                .await
                .expect("execute baseline reset");

            let store_settings_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*)::bigint FROM store_settings")
                    .fetch_one(&mut *tx)
                    .await
                    .expect("count store_settings");
            assert_eq!(store_settings_count, 1);

            let preserved_staff: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
                "SELECT pin_hash, counterpoint_user_id, counterpoint_sls_rep FROM staff WHERE id = $1",
            )
            .bind(preserved_staff_id)
            .fetch_one(&mut *tx)
            .await
            .expect("load preserved staff");
            assert!(preserved_staff.0.is_some());
            assert!(preserved_staff.1.is_none());
            assert!(preserved_staff.2.is_none());

            let preserved_maps_count: i64 = sqlx::query_scalar(
                r#"
                SELECT
                    (SELECT COUNT(*)::bigint FROM counterpoint_payment_method_map)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_gift_reason_map)
                "#,
            )
            .fetch_one(&mut *tx)
            .await
            .expect("count preserved maps");
            assert!(preserved_maps_count >= 2);

            let category_map_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*)::bigint FROM counterpoint_category_map")
                    .fetch_one(&mut *tx)
                    .await
                    .expect("count category maps");
            assert_eq!(category_map_count, 0);

            let imported_customer_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                    .bind(imported_customer_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check imported customer");
            assert!(!imported_customer_exists);

            let imported_transactions_remaining: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM transactions WHERE id = ANY($1)",
            )
            .bind(vec![imported_transaction_id, manual_transaction_id])
            .fetch_one(&mut *tx)
            .await
            .expect("count transactions after reset");
            assert_eq!(imported_transactions_remaining, 0);

            let payment_transaction_exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM payment_transactions WHERE id = $1)",
            )
            .bind(payment_transaction_id)
            .fetch_one(&mut *tx)
            .await
            .expect("check payment transaction");
            assert!(!payment_transaction_exists);

            let imported_product_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE id = $1)")
                    .bind(imported_product_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check imported product");
            assert!(!imported_product_exists);

            let vendor_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1)")
                    .bind(vendor_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check vendor");
            assert!(!vendor_exists);

            let gift_card_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM gift_cards WHERE id = $1)")
                    .bind(gift_card_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check gift card");
            assert!(!gift_card_exists);

            let loyalty_rows: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM loyalty_point_ledger WHERE customer_id = $1",
            )
                    .bind(imported_customer_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("count loyalty rows");
            assert_eq!(loyalty_rows, 0);

            let store_credit_rows: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM store_credit_accounts WHERE customer_id = $1",
            )
                    .bind(imported_customer_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("count store credit rows");
            assert_eq!(store_credit_rows, 0);

            let counterpoint_state_rows: i64 = sqlx::query_scalar(
                r#"
                SELECT
                    (SELECT COUNT(*)::bigint FROM counterpoint_sync_runs WHERE id = ANY($1))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_issue WHERE id = ANY($2))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_request WHERE id = ANY($3))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staging_batch WHERE id = ANY($4))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_receiving_history WHERE id = ANY($5))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staff_map WHERE ros_staff_id = ANY($6))
                "#,
            )
            .bind(&targets.counterpoint_sync_run_ids)
            .bind(&targets.counterpoint_sync_issue_ids)
            .bind(&targets.counterpoint_sync_request_ids)
            .bind(&targets.counterpoint_staging_batch_ids)
            .bind(&targets.counterpoint_receiving_history_ids)
            .bind(&targets.counterpoint_staff_map_staff_ids)
            .fetch_one(&mut *tx)
            .await
            .expect("count counterpoint state rows");
            assert_eq!(counterpoint_state_rows, 0);

            let imported_staff_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1)")
                    .bind(imported_staff_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check imported staff");
            assert!(!imported_staff_exists);

            let heartbeat: (String, Option<String>, Option<String>) = sqlx::query_as(
                "SELECT bridge_phase, bridge_version, bridge_hostname FROM counterpoint_bridge_heartbeat WHERE id = 1",
            )
            .fetch_one(&mut *tx)
            .await
            .expect("load heartbeat");
            assert_eq!(heartbeat.0, "idle");
            assert!(heartbeat.1.is_none());
            assert!(heartbeat.2.is_none());

            tx.rollback().await.expect("rollback reset test transaction");
            Ok::<(), sqlx::Error>(())
        }
        .await;

        result.expect("counterpoint baseline reset assertions");
    }

    #[tokio::test]
    async fn health_check_returns_not_configured_when_token_missing() {
        let _guard = COUNTERPOINT_HEALTH_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let previous = std::env::var("COUNTERPOINT_SYNC_TOKEN").ok();
        std::env::remove_var("COUNTERPOINT_SYNC_TOKEN");
        let health = health_check(&pool).await;
        assert!(!health.configured);
        assert!(!health.reachable);
        assert_eq!(health.latency_ms, 0);
        assert!(health.message.contains("COUNTERPOINT_SYNC_TOKEN"));
        if let Some(v) = previous {
            std::env::set_var("COUNTERPOINT_SYNC_TOKEN", v);
        }
    }

    #[tokio::test]
    async fn health_check_returns_offline_when_token_set_but_no_heartbeat() {
        let _guard = COUNTERPOINT_HEALTH_TEST_LOCK.lock().await;
        let pool = connect_test_db().await;
        let previous = std::env::var("COUNTERPOINT_SYNC_TOKEN").ok();
        std::env::set_var("COUNTERPOINT_SYNC_TOKEN", "test-token-for-health-check");
        // Ensure no heartbeat row exists by deleting it if present
        let _ = sqlx::query("DELETE FROM counterpoint_bridge_heartbeat WHERE id = 1")
            .execute(&pool)
            .await;
        let health = health_check(&pool).await;
        assert!(health.configured);
        assert!(!health.reachable);
        assert!(
            health.message.contains("never sent a heartbeat")
                || health.message.contains("heartbeat query failed")
        );
        if let Some(v) = previous {
            std::env::set_var("COUNTERPOINT_SYNC_TOKEN", v);
        } else {
            std::env::remove_var("COUNTERPOINT_SYNC_TOKEN");
        }
    }
}
