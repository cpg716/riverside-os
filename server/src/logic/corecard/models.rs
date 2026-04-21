use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CustomerCoreCreditAccount {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub corecredit_customer_id: String,
    pub corecredit_account_id: String,
    pub corecredit_card_id: Option<String>,
    pub status: String,
    pub is_primary: bool,
    pub program_group: Option<String>,
    pub last_verified_at: Option<DateTime<Utc>>,
    pub verified_by_staff_id: Option<Uuid>,
    pub verification_source: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CustomerCoreCreditAccountSnapshot {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub corecredit_customer_id: String,
    pub corecredit_account_id: String,
    pub corecredit_card_id: Option<String>,
    pub status: String,
    pub is_primary: bool,
    pub program_group: Option<String>,
    pub last_verified_at: Option<DateTime<Utc>>,
    pub verified_by_staff_id: Option<Uuid>,
    pub verification_source: Option<String>,
    pub notes: Option<String>,
    pub available_credit_snapshot: Option<String>,
    pub current_balance_snapshot: Option<String>,
    pub past_due_snapshot: Option<String>,
    pub restrictions_snapshot_json: Value,
    pub last_balance_sync_at: Option<DateTime<Utc>>,
    pub last_status_sync_at: Option<DateTime<Utc>>,
    pub last_transactions_sync_at: Option<DateTime<Utc>>,
    pub last_sync_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkedCoreCreditAccountView {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub corecredit_customer_id: String,
    pub corecredit_account_id: String,
    pub corecredit_card_id: Option<String>,
    pub masked_account: String,
    pub status: String,
    pub is_primary: bool,
    pub program_group: Option<String>,
    pub last_verified_at: Option<DateTime<Utc>>,
    pub verified_by_staff_id: Option<Uuid>,
    pub verification_source: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LinkCustomerCoreCreditAccountRequest {
    pub customer_id: Uuid,
    pub corecredit_customer_id: String,
    pub corecredit_account_id: String,
    #[serde(default)]
    pub corecredit_card_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub program_group: Option<String>,
    #[serde(default)]
    pub verification_source: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnlinkCustomerCoreCreditAccountRequest {
    pub customer_id: Uuid,
    #[serde(default)]
    pub link_id: Option<Uuid>,
    #[serde(default)]
    pub corecredit_account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PosResolveAccountRequest {
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub preferred_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RmsChargeAccountChoice {
    pub link_id: Uuid,
    pub corecredit_customer_id: String,
    pub corecredit_account_id: String,
    pub masked_account: String,
    pub status: String,
    pub is_primary: bool,
    pub program_group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RmsChargeBlockingError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PosResolveAccountResponse {
    pub resolution_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_account: Option<RmsChargeAccountChoice>,
    #[serde(default)]
    pub choices: Vec<RmsChargeAccountChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_error: Option<RmsChargeBlockingError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardProgramOption {
    pub program_code: String,
    pub program_label: String,
    pub eligible: bool,
    #[serde(default)]
    pub disclosure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardAccountSummary {
    pub corecredit_customer_id: String,
    pub corecredit_account_id: String,
    pub masked_account: String,
    pub account_status: String,
    #[serde(default)]
    pub available_credit: Option<String>,
    #[serde(default)]
    pub current_balance: Option<String>,
    #[serde(default)]
    pub resolution_status: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub recent_history: Vec<RmsChargeHistorySummaryRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, Default)]
pub struct RmsChargeHistorySummaryRow {
    pub created_at: DateTime<Utc>,
    pub record_kind: String,
    pub amount: rust_decimal::Decimal,
    pub payment_method: String,
    pub program_label: Option<String>,
    pub masked_account: Option<String>,
    pub order_short_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardLiveSummaryResponse {
    #[serde(default)]
    pub masked_account: Option<String>,
    #[serde(default)]
    pub available_credit: Option<String>,
    #[serde(default)]
    pub current_balance: Option<String>,
    #[serde(default)]
    pub account_status: Option<String>,
    #[serde(default)]
    pub resolution_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardLiveProgramsResponse {
    #[serde(default)]
    pub programs: Vec<CoreCardProgramOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardPayloadEnvelope {
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreCardOperationType {
    Purchase,
    Payment,
    Refund,
    Reversal,
}

impl CoreCardOperationType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Purchase => "purchase",
            Self::Payment => "payment",
            Self::Refund => "refund",
            Self::Reversal => "reversal",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreCardFailureCode {
    HostTimeout,
    DuplicateSubmission,
    InsufficientAvailableCredit,
    AccountInactiveOrRestricted,
    InvalidProgram,
    AccountProgramMismatch,
    HostUnavailable,
    InvalidRequest,
    UnknownHostFailure,
}

impl CoreCardFailureCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::HostTimeout => "host_timeout",
            Self::DuplicateSubmission => "duplicate_submission",
            Self::InsufficientAvailableCredit => "insufficient_available_credit",
            Self::AccountInactiveOrRestricted => "account_inactive_or_restricted",
            Self::InvalidProgram => "invalid_program",
            Self::AccountProgramMismatch => "account_program_mismatch",
            Self::HostUnavailable => "host_unavailable",
            Self::InvalidRequest => "invalid_request",
            Self::UnknownHostFailure => "unknown_host_failure",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreCardHostFailure {
    pub code: CoreCardFailureCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardHostMutationResult {
    pub operation_type: String,
    pub posting_status: String,
    #[serde(default)]
    pub external_transaction_id: Option<String>,
    #[serde(default)]
    pub external_auth_code: Option<String>,
    #[serde(default)]
    pub external_transaction_type: Option<String>,
    #[serde(default)]
    pub host_reference: Option<String>,
    #[serde(default)]
    pub posted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub reversed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub refunded_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardMutationRequest {
    pub customer_id: Option<Uuid>,
    pub linked_corecredit_customer_id: String,
    pub linked_corecredit_account_id: String,
    #[serde(default)]
    pub linked_corecredit_card_id: Option<String>,
    #[serde(default)]
    pub program_code: Option<String>,
    pub amount: Decimal,
    pub idempotency_key: String,
    #[serde(default)]
    pub transaction_id: Option<Uuid>,
    #[serde(default)]
    pub payment_transaction_id: Option<Uuid>,
    #[serde(default)]
    pub pos_rms_charge_record_id: Option<Uuid>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub reference_hint: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardPosPostPurchaseRequest {
    pub customer_id: Uuid,
    pub linked_corecredit_customer_id: String,
    pub linked_corecredit_account_id: String,
    #[serde(default)]
    pub linked_corecredit_card_id: Option<String>,
    pub program_code: String,
    pub amount: Decimal,
    pub checkout_client_id: Uuid,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardPosPostPaymentRequest {
    pub customer_id: Uuid,
    #[serde(default)]
    pub linked_corecredit_customer_id: Option<String>,
    pub linked_corecredit_account_id: String,
    pub amount: Decimal,
    pub checkout_client_id: Uuid,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardReverseActionRequest {
    #[serde(default)]
    pub transaction_id: Option<Uuid>,
    #[serde(default)]
    pub pos_rms_charge_record_id: Option<Uuid>,
    #[serde(default)]
    pub external_transaction_id: Option<String>,
    #[serde(default)]
    pub amount: Option<Decimal>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CoreCardPostingEvent {
    pub id: Uuid,
    pub idempotency_key: String,
    pub operation_type: String,
    pub posting_status: String,
    pub retryable: bool,
    pub customer_id: Option<Uuid>,
    pub transaction_id: Option<Uuid>,
    pub payment_transaction_id: Option<Uuid>,
    pub pos_rms_charge_record_id: Option<Uuid>,
    pub linked_corecredit_customer_id: Option<String>,
    pub linked_corecredit_account_id: Option<String>,
    pub linked_corecredit_card_id: Option<String>,
    pub program_code: Option<String>,
    pub amount: Decimal,
    pub external_transaction_id: Option<String>,
    pub external_auth_code: Option<String>,
    pub external_transaction_type: Option<String>,
    pub host_reference: Option<String>,
    pub posting_error_code: Option<String>,
    pub posting_error_message: Option<String>,
    pub request_snapshot_json: Value,
    pub response_snapshot_json: Value,
    pub host_metadata_json: Value,
    pub posted_at: Option<DateTime<Utc>>,
    pub reversed_at: Option<DateTime<Utc>>,
    pub refunded_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardPostingAttemptDraft {
    pub idempotency_key: String,
    pub operation_type: CoreCardOperationType,
    pub customer_id: Option<Uuid>,
    pub linked_corecredit_customer_id: Option<String>,
    pub linked_corecredit_account_id: Option<String>,
    pub linked_corecredit_card_id: Option<String>,
    pub program_code: Option<String>,
    pub amount: Decimal,
    #[serde(default)]
    pub request_snapshot_json: Value,
    #[serde(default)]
    pub host_metadata_json: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CoreCardUiAccountTransactionRow {
    pub occurred_at: DateTime<Utc>,
    pub kind: String,
    pub amount: Decimal,
    pub status: String,
    pub program_label: Option<String>,
    pub masked_account: Option<String>,
    pub order_short_ref: Option<String>,
    pub external_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardAccountBalancesResponse {
    pub account_id: String,
    pub masked_account: String,
    pub account_status: String,
    #[serde(default)]
    pub available_credit: Option<String>,
    #[serde(default)]
    pub current_balance: Option<String>,
    #[serde(default)]
    pub last_host_reference: Option<String>,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardAccountTransactionsResponse {
    pub account_id: String,
    pub masked_account: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub rows: Vec<CoreCardUiAccountTransactionRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct RmsChargeRecordDetail {
    pub id: Uuid,
    pub record_kind: String,
    pub created_at: DateTime<Utc>,
    pub transaction_id: Uuid,
    pub register_session_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub payment_method: String,
    pub amount: Decimal,
    pub operator_staff_id: Option<Uuid>,
    pub payment_transaction_id: Option<Uuid>,
    pub customer_display: Option<String>,
    pub order_short_ref: Option<String>,
    pub tender_family: Option<String>,
    pub program_code: Option<String>,
    pub program_label: Option<String>,
    pub masked_account: Option<String>,
    pub linked_corecredit_customer_id: Option<String>,
    pub linked_corecredit_account_id: Option<String>,
    pub resolution_status: Option<String>,
    pub external_transaction_id: Option<String>,
    pub external_auth_code: Option<String>,
    pub posting_status: String,
    pub posting_error_code: Option<String>,
    pub posting_error_message: Option<String>,
    pub posted_at: Option<DateTime<Utc>>,
    pub reversed_at: Option<DateTime<Utc>>,
    pub refunded_at: Option<DateTime<Utc>>,
    pub idempotency_key: Option<String>,
    pub external_transaction_type: Option<String>,
    pub host_reference: Option<String>,
    pub metadata_json: Value,
    pub host_metadata_json: Value,
    pub request_snapshot_json: Value,
    pub response_snapshot_json: Value,
    pub customer_name: Option<String>,
    pub customer_code: Option<String>,
    pub operator_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CoreCardEventLogRow {
    pub id: Uuid,
    pub external_event_key: String,
    pub event_type: String,
    pub received_at: DateTime<Utc>,
    pub processed_at: Option<DateTime<Utc>>,
    pub processing_status: String,
    pub signature_valid: bool,
    pub verification_result: Option<String>,
    pub related_customer_id: Option<Uuid>,
    pub related_account_id: Option<String>,
    pub related_rms_record_id: Option<Uuid>,
    pub payload_json: Value,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardWebhookOutcome {
    pub event_id: String,
    pub processing_status: String,
    pub duplicate: bool,
    #[serde(default)]
    pub related_rms_record_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CoreCardExceptionQueueRow {
    pub id: Uuid,
    pub rms_record_id: Option<Uuid>,
    pub account_id: Option<String>,
    pub exception_type: String,
    pub severity: String,
    pub status: String,
    pub assigned_to_staff_id: Option<Uuid>,
    pub opened_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
    pub resolution_notes: Option<String>,
    pub retry_count: i32,
    pub last_retry_at: Option<DateTime<Utc>>,
    pub metadata_json: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCardExceptionActionRequest {
    #[serde(default)]
    pub assigned_to_staff_id: Option<Uuid>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub resolution_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CoreCardReconciliationRunRow {
    pub id: Uuid,
    pub run_scope: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub requested_by_staff_id: Option<Uuid>,
    pub date_from: Option<NaiveDate>,
    pub date_to: Option<NaiveDate>,
    pub summary_json: Value,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CoreCardReconciliationItemRow {
    pub id: Uuid,
    pub run_id: Uuid,
    pub rms_record_id: Option<Uuid>,
    pub account_id: Option<String>,
    pub mismatch_type: String,
    pub severity: String,
    pub status: String,
    pub riverside_value_json: Value,
    pub host_value_json: Value,
    pub qbo_value_json: Value,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardOverviewResponse {
    pub totals: Value,
    #[serde(default)]
    pub recent_activity: Vec<RmsChargeRecordDetail>,
    #[serde(default)]
    pub failed_host_actions: Vec<CoreCardExceptionQueueRow>,
    #[serde(default)]
    pub pending_exceptions: Vec<CoreCardExceptionQueueRow>,
    #[serde(default)]
    pub program_mix: Vec<Value>,
    #[serde(default)]
    pub accounts: Vec<CustomerCoreCreditAccountSnapshot>,
    #[serde(default)]
    pub sync_health: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardReconciliationResponse {
    #[serde(default)]
    pub runs: Vec<CoreCardReconciliationRunRow>,
    #[serde(default)]
    pub items: Vec<CoreCardReconciliationItemRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoreCardSyncHealthResponse {
    #[serde(default)]
    pub last_repair_poll_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub active_exception_count: i64,
    #[serde(default)]
    pub pending_webhook_count: i64,
    #[serde(default)]
    pub failed_webhook_count: i64,
    #[serde(default)]
    pub stale_account_count: i64,
}
