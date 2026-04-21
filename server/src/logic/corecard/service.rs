use crate::logic::corecard::auth::ensure_access_token;
use chrono::{Duration, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::{Executor, PgPool, Row};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::models::{
    CoreCardAccountBalancesResponse, CoreCardAccountSummary, CoreCardAccountTransactionsResponse,
    CoreCardEventLogRow, CoreCardExceptionQueueRow, CoreCardFailureCode,
    CoreCardHostMutationResult, CoreCardLiveProgramsResponse, CoreCardLiveSummaryResponse,
    CoreCardMutationRequest, CoreCardOperationType, CoreCardOverviewResponse,
    CoreCardPostingAttemptDraft, CoreCardPostingEvent, CoreCardProgramOption,
    CoreCardReconciliationItemRow, CoreCardReconciliationResponse, CoreCardReconciliationRunRow,
    CoreCardSyncHealthResponse, CoreCardUiAccountTransactionRow, CoreCardWebhookOutcome,
    CustomerCoreCreditAccount, CustomerCoreCreditAccountSnapshot,
    LinkCustomerCoreCreditAccountRequest, LinkedCoreCreditAccountView, PosResolveAccountRequest,
    PosResolveAccountResponse, RmsChargeAccountChoice, RmsChargeBlockingError,
    RmsChargeHistorySummaryRow, RmsChargeRecordDetail, UnlinkCustomerCoreCreditAccountRequest,
};
use super::redaction::{log_corecard_payload, mask_account_identifier};
use super::{CoreCardConfig, CoreCardError, CoreCardTokenCache};

fn normalized_status(status: &str) -> String {
    let trimmed = status.trim();
    if trimmed.is_empty() {
        "active".to_string()
    } else {
        trimmed.to_ascii_lowercase()
    }
}

pub fn account_is_selectable(status: &str) -> bool {
    matches!(
        normalized_status(status).as_str(),
        "active" | "open" | "eligible" | "current"
    )
}

pub fn account_is_blocked(status: &str) -> bool {
    matches!(
        normalized_status(status).as_str(),
        "inactive" | "restricted" | "suspended" | "closed" | "blocked"
    )
}

fn account_choice(record: &CustomerCoreCreditAccount) -> RmsChargeAccountChoice {
    RmsChargeAccountChoice {
        link_id: record.id,
        corecredit_customer_id: record.corecredit_customer_id.clone(),
        corecredit_account_id: record.corecredit_account_id.clone(),
        masked_account: mask_account_identifier(&record.corecredit_account_id),
        status: normalized_status(&record.status),
        is_primary: record.is_primary,
        program_group: record.program_group.clone(),
    }
}

fn metadata_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn metadata_bool(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn parse_host_datetime(value: &Value, key: &str) -> Option<chrono::DateTime<Utc>> {
    metadata_text(value, key)
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(&text).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
}

pub fn build_idempotency_key(
    operation_type: CoreCardOperationType,
    stable_reference: &str,
    account_id: &str,
    amount: Decimal,
    program_code: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};

    let seed = format!(
        "{}|{}|{}|{}|{}",
        operation_type.as_str(),
        stable_reference.trim(),
        account_id.trim(),
        amount.round_dp(2),
        program_code.unwrap_or("").trim(),
    );
    let digest = Sha256::digest(seed.as_bytes());
    hex::encode(digest)
}

fn classify_host_failure(status: Option<reqwest::StatusCode>, payload: &Value) -> CoreCardError {
    let raw_code = metadata_text(payload, "error_code")
        .or_else(|| metadata_text(payload, "code"))
        .or_else(|| metadata_text(payload, "error"))
        .unwrap_or_else(|| "unknown_host_failure".to_string());
    let message = metadata_text(payload, "message")
        .or_else(|| metadata_text(payload, "error_description"))
        .or_else(|| metadata_text(payload, "detail"))
        .unwrap_or_else(|| "CoreCard host request failed".to_string());
    let normalized = raw_code.to_ascii_lowercase();

    if status == Some(reqwest::StatusCode::CONFLICT)
        || normalized.contains("duplicate")
        || normalized.contains("already_exists")
    {
        return CoreCardError::host_failure(
            CoreCardFailureCode::DuplicateSubmission,
            message,
            false,
        );
    }
    if status == Some(reqwest::StatusCode::REQUEST_TIMEOUT)
        || status == Some(reqwest::StatusCode::GATEWAY_TIMEOUT)
        || normalized.contains("timeout")
    {
        return CoreCardError::host_failure(CoreCardFailureCode::HostTimeout, message, true);
    }
    if normalized.contains("insufficient") || normalized.contains("credit") {
        return CoreCardError::host_failure(
            CoreCardFailureCode::InsufficientAvailableCredit,
            message,
            false,
        );
    }
    if normalized.contains("inactive")
        || normalized.contains("restricted")
        || normalized.contains("closed")
        || normalized.contains("blocked")
        || status == Some(reqwest::StatusCode::FORBIDDEN)
        || status == Some(reqwest::StatusCode::LOCKED)
    {
        return CoreCardError::host_failure(
            CoreCardFailureCode::AccountInactiveOrRestricted,
            message,
            false,
        );
    }
    if normalized.contains("invalid_program") || normalized.contains("program_invalid") {
        return CoreCardError::host_failure(CoreCardFailureCode::InvalidProgram, message, false);
    }
    if normalized.contains("mismatch")
        || normalized.contains("account_program")
        || normalized.contains("program_account")
    {
        return CoreCardError::host_failure(
            CoreCardFailureCode::AccountProgramMismatch,
            message,
            false,
        );
    }
    if status
        .map(|value| value.is_server_error() || value == reqwest::StatusCode::BAD_GATEWAY)
        .unwrap_or(false)
        || normalized.contains("unavailable")
        || normalized.contains("retry")
    {
        return CoreCardError::host_failure(CoreCardFailureCode::HostUnavailable, message, true);
    }
    if status.map(|value| value.is_client_error()).unwrap_or(false) {
        return CoreCardError::host_failure(CoreCardFailureCode::InvalidRequest, message, false);
    }
    CoreCardError::host_failure(CoreCardFailureCode::UnknownHostFailure, message, false)
}

fn parse_host_mutation_result(
    operation_type: CoreCardOperationType,
    payload: &Value,
) -> CoreCardHostMutationResult {
    CoreCardHostMutationResult {
        operation_type: operation_type.as_str().to_string(),
        posting_status: metadata_text(payload, "posting_status")
            .or_else(|| metadata_text(payload, "status"))
            .unwrap_or_else(|| "posted".to_string()),
        external_transaction_id: metadata_text(payload, "external_transaction_id")
            .or_else(|| metadata_text(payload, "transaction_id"))
            .or_else(|| metadata_text(payload, "host_transaction_id")),
        external_auth_code: metadata_text(payload, "external_auth_code")
            .or_else(|| metadata_text(payload, "auth_code"))
            .or_else(|| metadata_text(payload, "authorization_code")),
        external_transaction_type: metadata_text(payload, "external_transaction_type")
            .or_else(|| Some(operation_type.as_str().to_string())),
        host_reference: metadata_text(payload, "host_reference")
            .or_else(|| metadata_text(payload, "reference"))
            .or_else(|| metadata_text(payload, "reference_number")),
        posted_at: parse_host_datetime(payload, "posted_at").or_else(|| Some(Utc::now())),
        reversed_at: parse_host_datetime(payload, "reversed_at"),
        refunded_at: parse_host_datetime(payload, "refunded_at"),
        metadata: payload.clone(),
    }
}

pub fn resolve_accounts_from_links(
    request: &PosResolveAccountRequest,
    linked_accounts: &[CustomerCoreCreditAccount],
) -> PosResolveAccountResponse {
    let Some(_customer_id) = request.customer_id else {
        return PosResolveAccountResponse {
            resolution_status: "blocked".to_string(),
            selected_account: None,
            choices: Vec::new(),
            blocking_error: Some(RmsChargeBlockingError {
                code: "customer_required".to_string(),
                message: "RMS Charge requires an active customer on the sale.".to_string(),
            }),
        };
    };

    let valid: Vec<&CustomerCoreCreditAccount> = linked_accounts
        .iter()
        .filter(|account| account_is_selectable(&account.status))
        .collect();

    if valid.is_empty() {
        let code = if linked_accounts
            .iter()
            .any(|account| account_is_blocked(&account.status))
        {
            "account_unavailable"
        } else {
            "no_linked_account"
        };
        let message = if code == "account_unavailable" {
            "The linked RMS Charge account is inactive or restricted.".to_string()
        } else {
            "No linked CoreCredit/CoreCard account was found for this customer.".to_string()
        };
        return PosResolveAccountResponse {
            resolution_status: "blocked".to_string(),
            selected_account: None,
            choices: Vec::new(),
            blocking_error: Some(RmsChargeBlockingError {
                code: code.to_string(),
                message,
            }),
        };
    }

    if let Some(preferred) = request
        .preferred_account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(selected) = valid
            .iter()
            .find(|account| account.corecredit_account_id == preferred)
        {
            return PosResolveAccountResponse {
                resolution_status: "selected".to_string(),
                selected_account: Some(account_choice(selected)),
                choices: Vec::new(),
                blocking_error: None,
            };
        }
    }

    if valid.len() == 1 {
        return PosResolveAccountResponse {
            resolution_status: "selected".to_string(),
            selected_account: Some(account_choice(valid[0])),
            choices: Vec::new(),
            blocking_error: None,
        };
    }

    PosResolveAccountResponse {
        resolution_status: "multiple".to_string(),
        selected_account: None,
        choices: valid.into_iter().map(account_choice).collect(),
        blocking_error: None,
    }
}

pub async fn list_customer_accounts(
    db: &PgPool,
    customer_id: Uuid,
) -> Result<Vec<CustomerCoreCreditAccount>, CoreCardError> {
    let rows = sqlx::query_as::<_, CustomerCoreCreditAccount>(
        r#"
        SELECT
            id,
            customer_id,
            corecredit_customer_id,
            corecredit_account_id,
            corecredit_card_id,
            status,
            is_primary,
            program_group,
            last_verified_at,
            verified_by_staff_id,
            verification_source,
            notes,
            created_at,
            updated_at
        FROM customer_corecredit_accounts
        WHERE customer_id = $1
        ORDER BY is_primary DESC, updated_at DESC, created_at DESC
        "#,
    )
    .bind(customer_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

pub async fn list_customer_account_views(
    db: &PgPool,
    customer_id: Uuid,
) -> Result<Vec<LinkedCoreCreditAccountView>, CoreCardError> {
    Ok(list_customer_accounts(db, customer_id)
        .await?
        .into_iter()
        .map(|row| LinkedCoreCreditAccountView {
            masked_account: mask_account_identifier(&row.corecredit_account_id),
            id: row.id,
            customer_id: row.customer_id,
            corecredit_customer_id: row.corecredit_customer_id,
            corecredit_account_id: row.corecredit_account_id,
            corecredit_card_id: row.corecredit_card_id,
            status: normalized_status(&row.status),
            is_primary: row.is_primary,
            program_group: row.program_group,
            last_verified_at: row.last_verified_at,
            verified_by_staff_id: row.verified_by_staff_id,
            verification_source: row.verification_source,
            notes: row.notes,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn find_customer_account_link(
    db: &PgPool,
    customer_id: Uuid,
    account_id: &str,
) -> Result<CustomerCoreCreditAccount, CoreCardError> {
    list_customer_accounts(db, customer_id)
        .await?
        .into_iter()
        .find(|row| row.corecredit_account_id == account_id.trim())
        .ok_or(CoreCardError::AccountNotFound)
}

pub async fn link_customer_account(
    db: &PgPool,
    request: &LinkCustomerCoreCreditAccountRequest,
    verified_by_staff_id: Uuid,
) -> Result<CustomerCoreCreditAccount, CoreCardError> {
    let corecredit_customer_id = request.corecredit_customer_id.trim();
    let corecredit_account_id = request.corecredit_account_id.trim();
    if corecredit_customer_id.is_empty() || corecredit_account_id.is_empty() {
        return Err(CoreCardError::InvalidRequest(
            "customer and account identifiers are required".to_string(),
        ));
    }

    let mut tx = db.begin().await?;
    if request.is_primary {
        sqlx::query(
            "UPDATE customer_corecredit_accounts SET is_primary = FALSE, updated_at = now() WHERE customer_id = $1",
        )
        .bind(request.customer_id)
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query_as::<_, CustomerCoreCreditAccount>(
        r#"
        INSERT INTO customer_corecredit_accounts (
            customer_id,
            corecredit_customer_id,
            corecredit_account_id,
            corecredit_card_id,
            status,
            is_primary,
            program_group,
            last_verified_at,
            verified_by_staff_id,
            verification_source,
            notes,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, now())
        ON CONFLICT (customer_id, corecredit_account_id) DO UPDATE
        SET
            corecredit_customer_id = EXCLUDED.corecredit_customer_id,
            corecredit_card_id = EXCLUDED.corecredit_card_id,
            status = EXCLUDED.status,
            is_primary = EXCLUDED.is_primary,
            program_group = EXCLUDED.program_group,
            last_verified_at = now(),
            verified_by_staff_id = EXCLUDED.verified_by_staff_id,
            verification_source = EXCLUDED.verification_source,
            notes = EXCLUDED.notes,
            updated_at = now()
        RETURNING
            id,
            customer_id,
            corecredit_customer_id,
            corecredit_account_id,
            corecredit_card_id,
            status,
            is_primary,
            program_group,
            last_verified_at,
            verified_by_staff_id,
            verification_source,
            notes,
            created_at,
            updated_at
        "#,
    )
    .bind(request.customer_id)
    .bind(corecredit_customer_id)
    .bind(corecredit_account_id)
    .bind(
        request
            .corecredit_card_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        request
            .status
            .as_deref()
            .map(normalized_status)
            .unwrap_or_else(|| "active".to_string()),
    )
    .bind(request.is_primary)
    .bind(
        request
            .program_group
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(verified_by_staff_id)
    .bind(
        request
            .verification_source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        request
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(row)
}

pub async fn unlink_customer_account(
    db: &PgPool,
    request: &UnlinkCustomerCoreCreditAccountRequest,
) -> Result<CustomerCoreCreditAccount, CoreCardError> {
    let row = if let Some(link_id) = request.link_id {
        sqlx::query_as::<_, CustomerCoreCreditAccount>(
            r#"
            DELETE FROM customer_corecredit_accounts
            WHERE id = $1 AND customer_id = $2
            RETURNING
                id,
                customer_id,
                corecredit_customer_id,
                corecredit_account_id,
                corecredit_card_id,
                status,
                is_primary,
                program_group,
                last_verified_at,
                verified_by_staff_id,
                verification_source,
                notes,
                created_at,
                updated_at
            "#,
        )
        .bind(link_id)
        .bind(request.customer_id)
        .fetch_optional(db)
        .await?
    } else if let Some(account_id) = request
        .corecredit_account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sqlx::query_as::<_, CustomerCoreCreditAccount>(
            r#"
            DELETE FROM customer_corecredit_accounts
            WHERE customer_id = $1 AND corecredit_account_id = $2
            RETURNING
                id,
                customer_id,
                corecredit_customer_id,
                corecredit_account_id,
                corecredit_card_id,
                status,
                is_primary,
                program_group,
                last_verified_at,
                verified_by_staff_id,
                verification_source,
                notes,
                created_at,
                updated_at
            "#,
        )
        .bind(request.customer_id)
        .bind(account_id)
        .fetch_optional(db)
        .await?
    } else {
        return Err(CoreCardError::InvalidRequest(
            "link_id or corecredit_account_id is required".to_string(),
        ));
    };

    row.ok_or(CoreCardError::AccountNotFound)
}

pub async fn resolve_customer_account(
    db: &PgPool,
    request: &PosResolveAccountRequest,
) -> Result<PosResolveAccountResponse, CoreCardError> {
    let Some(customer_id) = request.customer_id else {
        return Ok(resolve_accounts_from_links(request, &[]));
    };
    let linked = list_customer_accounts(db, customer_id).await?;
    Ok(resolve_accounts_from_links(request, &linked))
}

pub async fn programs_for_account(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    customer_id: Uuid,
    account_id: &str,
) -> Result<Vec<CoreCardProgramOption>, CoreCardError> {
    let linked = list_customer_accounts(db, customer_id).await?;
    let Some(link) = linked
        .iter()
        .find(|row| row.corecredit_account_id == account_id)
    else {
        return Err(CoreCardError::AccountNotFound);
    };

    if let (Some(token), Some(url)) = (
        ensure_access_token(http_client, config, token_cache).await?,
        config.account_programs_url(account_id),
    ) {
        let response = http_client
            .get(url)
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .bearer_auth(token)
            .header("x-riverside-corecard-region", &config.region)
            .header("x-riverside-corecard-environment", &config.environment)
            .send()
            .await;

        if let Ok(response) = response {
            if response.status().is_success() {
                let body: Value = response.json().await.unwrap_or(Value::Null);
                log_corecard_payload(config, "inbound", "accounts.programs", &body);
                if let Ok(parsed) = serde_json::from_value::<CoreCardLiveProgramsResponse>(body) {
                    if !parsed.programs.is_empty() {
                        return Ok(parsed.programs);
                    }
                }
            }
        }
    }

    let mut programs = vec![CoreCardProgramOption {
        program_code: "standard".to_string(),
        program_label: "Standard".to_string(),
        eligible: account_is_selectable(&link.status),
        disclosure: Some("Primary revolving RMS Charge program.".to_string()),
    }];

    let group = link
        .program_group
        .as_deref()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if group.is_empty() || group.contains("90") || group.contains("promo") {
        programs.push(CoreCardProgramOption {
            program_code: "rms90".to_string(),
            program_label: "RMS 90".to_string(),
            eligible: account_is_selectable(&link.status),
            disclosure: Some(
                "Promotional 90-day financing selection captured for later posting.".to_string(),
            ),
        });
    }

    Ok(programs)
}

pub async fn recent_history_for_customer(
    db: &PgPool,
    customer_id: Uuid,
    account_id: Option<&str>,
    limit: i64,
) -> Result<Vec<RmsChargeHistorySummaryRow>, CoreCardError> {
    let rows = sqlx::query_as::<_, RmsChargeHistorySummaryRow>(
        r#"
        SELECT
            created_at,
            record_kind,
            amount,
            payment_method,
            program_label,
            masked_account,
            order_short_ref
        FROM pos_rms_charge_record
        WHERE customer_id = $1
          AND ($2::text IS NULL OR linked_corecredit_account_id = $2)
        ORDER BY created_at DESC
        LIMIT $3
        "#,
    )
    .bind(customer_id)
    .bind(account_id)
    .bind(limit.max(1))
    .fetch_all(db)
    .await?;
    Ok(rows)
}

pub async fn account_summary_for_customer(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    customer_id: Uuid,
    account_id: &str,
) -> Result<CoreCardAccountSummary, CoreCardError> {
    let linked = list_customer_accounts(db, customer_id).await?;
    let Some(link) = linked
        .iter()
        .find(|row| row.corecredit_account_id == account_id)
    else {
        return Err(CoreCardError::AccountNotFound);
    };

    let mut summary = CoreCardAccountSummary {
        corecredit_customer_id: link.corecredit_customer_id.clone(),
        corecredit_account_id: link.corecredit_account_id.clone(),
        masked_account: mask_account_identifier(&link.corecredit_account_id),
        account_status: normalized_status(&link.status),
        available_credit: None,
        current_balance: None,
        resolution_status: Some("linked_account".to_string()),
        source: "linked_account".to_string(),
        recent_history: Vec::new(),
    };

    if let (Some(token), Some(url)) = (
        ensure_access_token(http_client, config, token_cache).await?,
        config.account_summary_url(account_id),
    ) {
        let response = http_client
            .get(url)
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .bearer_auth(token)
            .header("x-riverside-corecard-region", &config.region)
            .header("x-riverside-corecard-environment", &config.environment)
            .send()
            .await;

        if let Ok(response) = response {
            if response.status().is_success() {
                let body: Value = response.json().await.unwrap_or(Value::Null);
                log_corecard_payload(config, "inbound", "accounts.summary", &body);
                if let Ok(parsed) = serde_json::from_value::<CoreCardLiveSummaryResponse>(body) {
                    if let Some(masked) = parsed.masked_account {
                        summary.masked_account = masked;
                    }
                    summary.available_credit = parsed.available_credit;
                    summary.current_balance = parsed.current_balance;
                    if let Some(status) = parsed.account_status {
                        summary.account_status = normalized_status(&status);
                    }
                    summary.resolution_status =
                        parsed.resolution_status.or(summary.resolution_status);
                    summary.source = "corecard_live".to_string();
                }
            } else {
                tracing::warn!(
                    status = %response.status(),
                    account_id,
                    "corecard summary request returned non-success; falling back to linked account data"
                );
            }
        }
    }

    Ok(summary)
}

pub async fn account_balances_for_customer(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    customer_id: Uuid,
    account_id: &str,
) -> Result<CoreCardAccountBalancesResponse, CoreCardError> {
    let summary = account_summary_for_customer(
        db,
        http_client,
        config,
        token_cache,
        customer_id,
        account_id,
    )
    .await?;
    let last_host_reference: Option<String> = sqlx::query_scalar(
        r#"
        SELECT host_reference
        FROM pos_rms_charge_record
        WHERE customer_id = $1
          AND linked_corecredit_account_id = $2
          AND host_reference IS NOT NULL
          AND btrim(host_reference) <> ''
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(customer_id)
    .bind(account_id)
    .fetch_optional(db)
    .await?
    .flatten();

    Ok(CoreCardAccountBalancesResponse {
        account_id: summary.corecredit_account_id,
        masked_account: summary.masked_account,
        account_status: summary.account_status,
        available_credit: summary.available_credit,
        current_balance: summary.current_balance,
        last_host_reference,
        source: summary.source,
    })
}

pub async fn account_transactions_for_customer(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    customer_id: Uuid,
    account_id: &str,
) -> Result<CoreCardAccountTransactionsResponse, CoreCardError> {
    let linked = list_customer_accounts(db, customer_id).await?;
    let Some(link) = linked
        .iter()
        .find(|row| row.corecredit_account_id == account_id)
    else {
        return Err(CoreCardError::AccountNotFound);
    };

    if let (Some(token), Some(url)) = (
        ensure_access_token(http_client, config, token_cache).await?,
        config.account_transactions_url(account_id),
    ) {
        let response = http_client
            .get(url)
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .bearer_auth(token)
            .header("x-riverside-corecard-region", &config.region)
            .header("x-riverside-corecard-environment", &config.environment)
            .send()
            .await;

        if let Ok(response) = response {
            if response.status().is_success() {
                let body: Value = response.json().await.unwrap_or(Value::Null);
                log_corecard_payload(config, "inbound", "accounts.transactions", &body);
                if let Some(rows) = body.get("rows").and_then(Value::as_array) {
                    let mapped = rows
                        .iter()
                        .map(|row| CoreCardUiAccountTransactionRow {
                            occurred_at: parse_host_datetime(row, "occurred_at")
                                .or_else(|| parse_host_datetime(row, "created_at"))
                                .unwrap_or_else(Utc::now),
                            kind: metadata_text(row, "kind")
                                .or_else(|| metadata_text(row, "type"))
                                .unwrap_or_else(|| "host".to_string()),
                            amount: metadata_text(row, "amount")
                                .and_then(|value| value.parse::<Decimal>().ok())
                                .unwrap_or(Decimal::ZERO),
                            status: metadata_text(row, "status")
                                .unwrap_or_else(|| "posted".to_string()),
                            program_label: metadata_text(row, "program_label"),
                            masked_account: metadata_text(row, "masked_account"),
                            order_short_ref: metadata_text(row, "order_short_ref"),
                            external_reference: metadata_text(row, "external_reference")
                                .or_else(|| metadata_text(row, "host_reference")),
                        })
                        .collect();
                    return Ok(CoreCardAccountTransactionsResponse {
                        account_id: link.corecredit_account_id.clone(),
                        masked_account: mask_account_identifier(&link.corecredit_account_id),
                        source: "corecard_live".to_string(),
                        rows: mapped,
                    });
                }
            }
        }
    }

    let rows = sqlx::query_as::<_, CoreCardUiAccountTransactionRow>(
        r#"
        SELECT
            r.created_at AS occurred_at,
            r.record_kind AS kind,
            r.amount,
            COALESCE(r.posting_status, 'legacy') AS status,
            r.program_label,
            r.masked_account,
            r.order_short_ref,
            COALESCE(r.host_reference, r.external_transaction_id) AS external_reference
        FROM pos_rms_charge_record r
        WHERE r.customer_id = $1
          AND r.linked_corecredit_account_id = $2
        ORDER BY r.created_at DESC
        LIMIT 25
        "#,
    )
    .bind(customer_id)
    .bind(account_id)
    .fetch_all(db)
    .await?;

    Ok(CoreCardAccountTransactionsResponse {
        account_id: link.corecredit_account_id.clone(),
        masked_account: mask_account_identifier(&link.corecredit_account_id),
        source: "riverside_history".to_string(),
        rows,
    })
}

pub async fn get_rms_charge_record_detail(
    db: &PgPool,
    record_id: Uuid,
) -> Result<RmsChargeRecordDetail, CoreCardError> {
    let row = sqlx::query_as::<_, RmsChargeRecordDetail>(
        r#"
        SELECT
            r.id,
            r.record_kind,
            r.created_at,
            r.transaction_id,
            r.register_session_id,
            r.customer_id,
            r.payment_method,
            r.amount,
            r.operator_staff_id,
            r.payment_transaction_id,
            r.customer_display,
            r.order_short_ref,
            r.tender_family,
            r.program_code,
            r.program_label,
            r.masked_account,
            r.linked_corecredit_customer_id,
            r.linked_corecredit_account_id,
            r.resolution_status,
            r.external_transaction_id,
            r.external_auth_code,
            r.posting_status,
            r.posting_error_code,
            r.posting_error_message,
            r.posted_at,
            r.reversed_at,
            r.refunded_at,
            r.idempotency_key,
            r.external_transaction_type,
            r.host_reference,
            r.metadata_json,
            r.host_metadata_json,
            r.request_snapshot_json,
            r.response_snapshot_json,
            NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
            c.customer_code,
            s.full_name AS operator_name
        FROM pos_rms_charge_record r
        LEFT JOIN customers c ON c.id = r.customer_id
        LEFT JOIN staff s ON s.id = r.operator_staff_id
        WHERE r.id = $1
        "#,
    )
    .bind(record_id)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn persist_posting_attempt_start(
    db: &PgPool,
    draft: &CoreCardPostingAttemptDraft,
) -> Result<CoreCardPostingEvent, CoreCardError> {
    let row = sqlx::query_as::<_, CoreCardPostingEvent>(
        r#"
        INSERT INTO corecard_posting_event (
            idempotency_key,
            operation_type,
            posting_status,
            retryable,
            customer_id,
            linked_corecredit_customer_id,
            linked_corecredit_account_id,
            linked_corecredit_card_id,
            program_code,
            amount,
            request_snapshot_json,
            host_metadata_json,
            updated_at
        )
        VALUES ($1, $2, 'pending', FALSE, $3, $4, $5, $6, $7, $8, $9, $10, now())
        ON CONFLICT (idempotency_key) DO UPDATE
        SET updated_at = now()
        RETURNING
            id,
            idempotency_key,
            operation_type,
            posting_status,
            retryable,
            customer_id,
            transaction_id,
            payment_transaction_id,
            pos_rms_charge_record_id,
            linked_corecredit_customer_id,
            linked_corecredit_account_id,
            linked_corecredit_card_id,
            program_code,
            amount,
            external_transaction_id,
            external_auth_code,
            external_transaction_type,
            host_reference,
            posting_error_code,
            posting_error_message,
            request_snapshot_json,
            response_snapshot_json,
            host_metadata_json,
            posted_at,
            reversed_at,
            refunded_at,
            created_at,
            updated_at
        "#,
    )
    .bind(&draft.idempotency_key)
    .bind(draft.operation_type.as_str())
    .bind(draft.customer_id)
    .bind(draft.linked_corecredit_customer_id.as_deref())
    .bind(draft.linked_corecredit_account_id.as_deref())
    .bind(draft.linked_corecredit_card_id.as_deref())
    .bind(draft.program_code.as_deref())
    .bind(draft.amount)
    .bind(&draft.request_snapshot_json)
    .bind(&draft.host_metadata_json)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn find_posting_event_by_idempotency_key(
    db: &PgPool,
    idempotency_key: &str,
) -> Result<Option<CoreCardPostingEvent>, CoreCardError> {
    let row = sqlx::query_as::<_, CoreCardPostingEvent>(
        r#"
        SELECT
            id,
            idempotency_key,
            operation_type,
            posting_status,
            retryable,
            customer_id,
            transaction_id,
            payment_transaction_id,
            pos_rms_charge_record_id,
            linked_corecredit_customer_id,
            linked_corecredit_account_id,
            linked_corecredit_card_id,
            program_code,
            amount,
            external_transaction_id,
            external_auth_code,
            external_transaction_type,
            host_reference,
            posting_error_code,
            posting_error_message,
            request_snapshot_json,
            response_snapshot_json,
            host_metadata_json,
            posted_at,
            reversed_at,
            refunded_at,
            created_at,
            updated_at
        FROM corecard_posting_event
        WHERE idempotency_key = $1
        "#,
    )
    .bind(idempotency_key.trim())
    .fetch_optional(db)
    .await?;
    Ok(row)
}

pub async fn persist_posting_success(
    db: &PgPool,
    idempotency_key: &str,
    result: &CoreCardHostMutationResult,
) -> Result<CoreCardPostingEvent, CoreCardError> {
    let row = sqlx::query_as::<_, CoreCardPostingEvent>(
        r#"
        UPDATE corecard_posting_event
        SET
            posting_status = $2,
            retryable = FALSE,
            external_transaction_id = $3,
            external_auth_code = $4,
            external_transaction_type = $5,
            host_reference = $6,
            response_snapshot_json = $7,
            host_metadata_json = $8,
            posted_at = COALESCE($9, posted_at, now()),
            reversed_at = COALESCE($10, reversed_at),
            refunded_at = COALESCE($11, refunded_at),
            posting_error_code = NULL,
            posting_error_message = NULL,
            updated_at = now()
        WHERE idempotency_key = $1
        RETURNING
            id,
            idempotency_key,
            operation_type,
            posting_status,
            retryable,
            customer_id,
            transaction_id,
            payment_transaction_id,
            pos_rms_charge_record_id,
            linked_corecredit_customer_id,
            linked_corecredit_account_id,
            linked_corecredit_card_id,
            program_code,
            amount,
            external_transaction_id,
            external_auth_code,
            external_transaction_type,
            host_reference,
            posting_error_code,
            posting_error_message,
            request_snapshot_json,
            response_snapshot_json,
            host_metadata_json,
            posted_at,
            reversed_at,
            refunded_at,
            created_at,
            updated_at
        "#,
    )
    .bind(idempotency_key.trim())
    .bind(&result.posting_status)
    .bind(result.external_transaction_id.as_deref())
    .bind(result.external_auth_code.as_deref())
    .bind(result.external_transaction_type.as_deref())
    .bind(result.host_reference.as_deref())
    .bind(&result.metadata)
    .bind(&result.metadata)
    .bind(result.posted_at)
    .bind(result.reversed_at)
    .bind(result.refunded_at)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn persist_posting_failure(
    db: &PgPool,
    idempotency_key: &str,
    error: &CoreCardError,
    response_snapshot: &Value,
) -> Result<CoreCardPostingEvent, CoreCardError> {
    let failure = error
        .as_host_failure()
        .unwrap_or_else(|| super::CoreCardHostFailure {
            code: CoreCardFailureCode::UnknownHostFailure,
            message: error.to_string(),
            retryable: false,
        });

    let row = sqlx::query_as::<_, CoreCardPostingEvent>(
        r#"
        UPDATE corecard_posting_event
        SET
            posting_status = 'failed',
            retryable = $2,
            posting_error_code = $3,
            posting_error_message = $4,
            response_snapshot_json = $5,
            host_metadata_json = $5,
            updated_at = now()
        WHERE idempotency_key = $1
        RETURNING
            id,
            idempotency_key,
            operation_type,
            posting_status,
            retryable,
            customer_id,
            transaction_id,
            payment_transaction_id,
            pos_rms_charge_record_id,
            linked_corecredit_customer_id,
            linked_corecredit_account_id,
            linked_corecredit_card_id,
            program_code,
            amount,
            external_transaction_id,
            external_auth_code,
            external_transaction_type,
            host_reference,
            posting_error_code,
            posting_error_message,
            request_snapshot_json,
            response_snapshot_json,
            host_metadata_json,
            posted_at,
            reversed_at,
            refunded_at,
            created_at,
            updated_at
        "#,
    )
    .bind(idempotency_key.trim())
    .bind(failure.retryable)
    .bind(failure.code.as_str())
    .bind(&failure.message)
    .bind(response_snapshot)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn attach_posting_event_refs<'e, E>(
    ex: E,
    idempotency_key: &str,
    transaction_id: Option<Uuid>,
    payment_transaction_id: Option<Uuid>,
    pos_rms_charge_record_id: Option<Uuid>,
) -> Result<(), CoreCardError>
where
    E: Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query(
        r#"
        UPDATE corecard_posting_event
        SET
            transaction_id = COALESCE($2, transaction_id),
            payment_transaction_id = COALESCE($3, payment_transaction_id),
            pos_rms_charge_record_id = COALESCE($4, pos_rms_charge_record_id),
            updated_at = now()
        WHERE idempotency_key = $1
        "#,
    )
    .bind(idempotency_key.trim())
    .bind(transaction_id)
    .bind(payment_transaction_id)
    .bind(pos_rms_charge_record_id)
    .execute(ex)
    .await?;
    Ok(())
}

async fn post_host_mutation(
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    operation_type: CoreCardOperationType,
    endpoint: &str,
    payload: &Value,
    idempotency_key: &str,
) -> Result<CoreCardHostMutationResult, CoreCardError> {
    let token = ensure_access_token(http_client, config, token_cache)
        .await?
        .ok_or(CoreCardError::NotConfigured)?;
    log_corecard_payload(config, "outbound", endpoint, payload);

    let response = http_client
        .post(
            match operation_type {
                CoreCardOperationType::Purchase => config.purchase_url(),
                CoreCardOperationType::Payment => config.payment_url(),
                CoreCardOperationType::Refund => config.refund_url(),
                CoreCardOperationType::Reversal => config.reversal_url(),
            }
            .ok_or(CoreCardError::NotConfigured)?,
        )
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .bearer_auth(token)
        .header("x-riverside-corecard-region", &config.region)
        .header("x-riverside-corecard-environment", &config.environment)
        .header("x-riverside-idempotency-key", idempotency_key)
        .json(payload)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return Err(CoreCardError::host_failure(
                CoreCardFailureCode::HostTimeout,
                "CoreCard host timed out before confirming the request.",
                true,
            ));
        }
        Err(error) => return Err(CoreCardError::Http(error)),
    };

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .unwrap_or_else(|_| json!({ "message": "invalid host response" }));
    log_corecard_payload(config, "inbound", endpoint, &body);

    if !status.is_success() || metadata_bool(&body, "success") == Some(false) {
        return Err(classify_host_failure(Some(status), &body));
    }

    Ok(parse_host_mutation_result(operation_type, &body))
}

fn mutation_payload(request: &CoreCardMutationRequest) -> Value {
    let mut metadata = request.metadata.clone();
    if let Value::Object(ref mut obj) = metadata {
        obj.insert(
            "riverside_customer_id".to_string(),
            request
                .customer_id
                .map(|id| Value::String(id.to_string()))
                .unwrap_or(Value::Null),
        );
        obj.insert(
            "payment_transaction_id".to_string(),
            request
                .payment_transaction_id
                .map(|id| Value::String(id.to_string()))
                .unwrap_or(Value::Null),
        );
        obj.insert(
            "transaction_id".to_string(),
            request
                .transaction_id
                .map(|id| Value::String(id.to_string()))
                .unwrap_or(Value::Null),
        );
    }

    json!({
        "corecredit_customer_id": request.linked_corecredit_customer_id,
        "corecredit_account_id": request.linked_corecredit_account_id,
        "corecredit_card_id": request.linked_corecredit_card_id,
        "program_code": request.program_code,
        "amount": request.amount.round_dp(2).to_string(),
        "reason": request.reason,
        "reference_hint": request.reference_hint,
        "metadata": metadata,
    })
}

async fn post_mutation_with_persistence(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    operation_type: CoreCardOperationType,
    request: &CoreCardMutationRequest,
) -> Result<CoreCardHostMutationResult, CoreCardError> {
    if !config.is_configured() {
        return Err(CoreCardError::NotConfigured);
    }
    if request.linked_corecredit_account_id.trim().is_empty() {
        return Err(CoreCardError::InvalidRequest(
            "linked_corecredit_account_id is required".to_string(),
        ));
    }
    if request.amount <= Decimal::ZERO {
        return Err(CoreCardError::InvalidRequest(
            "amount must be positive".to_string(),
        ));
    }

    let draft = CoreCardPostingAttemptDraft {
        idempotency_key: request.idempotency_key.clone(),
        operation_type: operation_type.clone(),
        customer_id: request.customer_id,
        linked_corecredit_customer_id: Some(request.linked_corecredit_customer_id.clone()),
        linked_corecredit_account_id: Some(request.linked_corecredit_account_id.clone()),
        linked_corecredit_card_id: request.linked_corecredit_card_id.clone(),
        program_code: request.program_code.clone(),
        amount: request.amount,
        request_snapshot_json: mutation_payload(request),
        host_metadata_json: json!({
            "account": mask_account_identifier(&request.linked_corecredit_account_id),
            "operation_type": operation_type.as_str(),
        }),
    };
    let existing = persist_posting_attempt_start(db, &draft).await?;
    if existing.posting_status == "posted"
        || existing.posting_status == "reversed"
        || existing.posting_status == "refunded"
    {
        return Ok(CoreCardHostMutationResult {
            operation_type: existing.operation_type,
            posting_status: existing.posting_status,
            external_transaction_id: existing.external_transaction_id,
            external_auth_code: existing.external_auth_code,
            external_transaction_type: existing.external_transaction_type,
            host_reference: existing.host_reference,
            posted_at: existing.posted_at,
            reversed_at: existing.reversed_at,
            refunded_at: existing.refunded_at,
            metadata: existing.host_metadata_json,
        });
    }

    let endpoint = format!("transactions.{}", operation_type.as_str());
    match post_host_mutation(
        http_client,
        config,
        token_cache,
        operation_type,
        &endpoint,
        &draft.request_snapshot_json,
        &request.idempotency_key,
    )
    .await
    {
        Ok(result) => {
            let _ = persist_posting_success(db, &request.idempotency_key, &result).await?;
            Ok(result)
        }
        Err(error) => {
            let response_snapshot = json!({
                "error": error.to_string(),
                "retryable": error.as_host_failure().map(|failure| failure.retryable),
                "code": error.as_host_failure().map(|failure| failure.code.as_str()),
            });
            let _ =
                persist_posting_failure(db, &request.idempotency_key, &error, &response_snapshot)
                    .await?;
            Err(error)
        }
    }
}

pub async fn post_purchase(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    request: &CoreCardMutationRequest,
) -> Result<CoreCardHostMutationResult, CoreCardError> {
    if request
        .program_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(CoreCardError::host_failure(
            CoreCardFailureCode::InvalidProgram,
            "A financing program must be selected before RMS Charge checkout can continue.",
            false,
        ));
    }
    post_mutation_with_persistence(
        db,
        http_client,
        config,
        token_cache,
        CoreCardOperationType::Purchase,
        request,
    )
    .await
}

pub async fn post_payment(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    request: &CoreCardMutationRequest,
) -> Result<CoreCardHostMutationResult, CoreCardError> {
    post_mutation_with_persistence(
        db,
        http_client,
        config,
        token_cache,
        CoreCardOperationType::Payment,
        request,
    )
    .await
}

pub async fn post_refund(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    request: &CoreCardMutationRequest,
) -> Result<CoreCardHostMutationResult, CoreCardError> {
    post_mutation_with_persistence(
        db,
        http_client,
        config,
        token_cache,
        CoreCardOperationType::Refund,
        request,
    )
    .await
}

pub async fn post_reversal(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
    request: &CoreCardMutationRequest,
) -> Result<CoreCardHostMutationResult, CoreCardError> {
    post_mutation_with_persistence(
        db,
        http_client,
        config,
        token_cache,
        CoreCardOperationType::Reversal,
        request,
    )
    .await
}

fn clipped_text(input: &str, limit: usize) -> String {
    let trimmed = input.trim();
    if trimmed.len() <= limit {
        trimmed.to_string()
    } else {
        format!("{}…", &trimmed[..limit.saturating_sub(1)])
    }
}

fn webhook_event_key(payload: &Value) -> String {
    use sha2::Digest;

    metadata_text(payload, "event_id")
        .or_else(|| metadata_text(payload, "id"))
        .or_else(|| metadata_text(payload, "external_event_key"))
        .unwrap_or_else(|| {
            let digest = sha2::Sha256::digest(payload.to_string().as_bytes());
            hex::encode(digest)
        })
}

fn webhook_event_type(payload: &Value) -> String {
    metadata_text(payload, "event_type")
        .or_else(|| metadata_text(payload, "type"))
        .unwrap_or_else(|| "unknown".to_string())
}

fn webhook_processing_status(payload: &Value) -> String {
    metadata_text(payload, "processing_status")
        .or_else(|| metadata_text(payload, "posting_status"))
        .or_else(|| metadata_text(payload, "status"))
        .unwrap_or_else(|| "received".to_string())
        .to_ascii_lowercase()
}

async fn find_rms_record_for_host_refs(
    db: &PgPool,
    external_transaction_id: Option<&str>,
    host_reference: Option<&str>,
    idempotency_key: Option<&str>,
) -> Result<Option<Uuid>, CoreCardError> {
    let row: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM pos_rms_charge_record
        WHERE ($1::text IS NOT NULL AND external_transaction_id = $1)
           OR ($2::text IS NOT NULL AND host_reference = $2)
           OR ($3::text IS NOT NULL AND idempotency_key = $3)
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(external_transaction_id)
    .bind(host_reference)
    .bind(idempotency_key)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

async fn list_account_snapshots(
    db: &PgPool,
    customer_id: Option<Uuid>,
) -> Result<Vec<CustomerCoreCreditAccountSnapshot>, CoreCardError> {
    let rows = sqlx::query_as::<_, CustomerCoreCreditAccountSnapshot>(
        r#"
        SELECT
            id,
            customer_id,
            corecredit_customer_id,
            corecredit_account_id,
            corecredit_card_id,
            status,
            is_primary,
            program_group,
            last_verified_at,
            verified_by_staff_id,
            verification_source,
            notes,
            available_credit_snapshot,
            current_balance_snapshot,
            past_due_snapshot,
            COALESCE(restrictions_snapshot_json, '{}'::jsonb) AS restrictions_snapshot_json,
            last_balance_sync_at,
            last_status_sync_at,
            last_transactions_sync_at,
            last_sync_error,
            created_at,
            updated_at
        FROM customer_corecredit_accounts
        WHERE ($1::uuid IS NULL OR customer_id = $1)
        ORDER BY is_primary DESC, updated_at DESC, created_at DESC
        LIMIT 100
        "#,
    )
    .bind(customer_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

pub async fn upsert_exception(
    db: &PgPool,
    rms_record_id: Option<Uuid>,
    account_id: Option<&str>,
    exception_type: &str,
    severity: &str,
    notes: Option<&str>,
    metadata_json: &Value,
) -> Result<CoreCardExceptionQueueRow, CoreCardError> {
    let row = sqlx::query_as::<_, CoreCardExceptionQueueRow>(
        r#"
        INSERT INTO corecredit_exception_queue (
            rms_record_id,
            account_id,
            exception_type,
            severity,
            status,
            notes,
            metadata_json
        )
        VALUES ($1, $2, $3, $4, 'open', $5, $6)
        ON CONFLICT (
            COALESCE(rms_record_id::text, ''),
            COALESCE(account_id, ''),
            exception_type
        )
        WHERE status IN ('open', 'retry_pending', 'assigned')
        DO UPDATE SET
            severity = EXCLUDED.severity,
            notes = COALESCE(EXCLUDED.notes, corecredit_exception_queue.notes),
            metadata_json = EXCLUDED.metadata_json
        RETURNING
            id,
            rms_record_id,
            account_id,
            exception_type,
            severity,
            status,
            assigned_to_staff_id,
            opened_at,
            resolved_at,
            notes,
            resolution_notes,
            retry_count,
            last_retry_at,
            metadata_json
        "#,
    )
    .bind(rms_record_id)
    .bind(account_id.map(str::trim).filter(|s| !s.is_empty()))
    .bind(exception_type.trim())
    .bind(severity.trim())
    .bind(notes.map(|value| clipped_text(value, 500)))
    .bind(metadata_json)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn list_exceptions(
    db: &PgPool,
    status: Option<&str>,
    customer_id: Option<Uuid>,
    limit: i64,
) -> Result<Vec<CoreCardExceptionQueueRow>, CoreCardError> {
    let rows = sqlx::query_as::<_, CoreCardExceptionQueueRow>(
        r#"
        SELECT
            e.id,
            e.rms_record_id,
            e.account_id,
            e.exception_type,
            e.severity,
            e.status,
            e.assigned_to_staff_id,
            e.opened_at,
            e.resolved_at,
            e.notes,
            e.resolution_notes,
            e.retry_count,
            e.last_retry_at,
            e.metadata_json
        FROM corecredit_exception_queue e
        LEFT JOIN pos_rms_charge_record r ON r.id = e.rms_record_id
        WHERE ($1::text IS NULL OR e.status = $1)
          AND ($2::uuid IS NULL OR r.customer_id = $2)
        ORDER BY
            CASE e.status
                WHEN 'open' THEN 0
                WHEN 'assigned' THEN 1
                WHEN 'retry_pending' THEN 2
                ELSE 3
            END,
            e.opened_at DESC
        LIMIT $3
        "#,
    )
    .bind(status.map(str::trim).filter(|s| !s.is_empty()))
    .bind(customer_id)
    .bind(limit.clamp(1, 200))
    .fetch_all(db)
    .await?;
    Ok(rows)
}

pub async fn assign_exception(
    db: &PgPool,
    exception_id: Uuid,
    assigned_to_staff_id: Option<Uuid>,
    notes: Option<&str>,
) -> Result<CoreCardExceptionQueueRow, CoreCardError> {
    let row = sqlx::query_as::<_, CoreCardExceptionQueueRow>(
        r#"
        UPDATE corecredit_exception_queue
        SET
            assigned_to_staff_id = $2,
            status = CASE
                WHEN $2::uuid IS NULL THEN 'open'
                ELSE 'assigned'
            END,
            notes = COALESCE($3, notes)
        WHERE id = $1
        RETURNING
            id,
            rms_record_id,
            account_id,
            exception_type,
            severity,
            status,
            assigned_to_staff_id,
            opened_at,
            resolved_at,
            notes,
            resolution_notes,
            retry_count,
            last_retry_at,
            metadata_json
        "#,
    )
    .bind(exception_id)
    .bind(assigned_to_staff_id)
    .bind(notes.map(|value| clipped_text(value, 500)))
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn resolve_exception(
    db: &PgPool,
    exception_id: Uuid,
    resolution_notes: Option<&str>,
) -> Result<CoreCardExceptionQueueRow, CoreCardError> {
    let row = sqlx::query_as::<_, CoreCardExceptionQueueRow>(
        r#"
        UPDATE corecredit_exception_queue
        SET
            status = 'resolved',
            resolved_at = now(),
            resolution_notes = COALESCE($2, resolution_notes)
        WHERE id = $1
        RETURNING
            id,
            rms_record_id,
            account_id,
            exception_type,
            severity,
            status,
            assigned_to_staff_id,
            opened_at,
            resolved_at,
            notes,
            resolution_notes,
            retry_count,
            last_retry_at,
            metadata_json
        "#,
    )
    .bind(exception_id)
    .bind(resolution_notes.map(|value| clipped_text(value, 500)))
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn list_program_catalog(
    db: &PgPool,
    customer_id: Option<Uuid>,
) -> Result<Vec<CoreCardProgramOption>, CoreCardError> {
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        r#"
        SELECT DISTINCT program_code, program_label
        FROM pos_rms_charge_record
        WHERE ($1::uuid IS NULL OR customer_id = $1)
          AND program_code IS NOT NULL
        ORDER BY program_label NULLS LAST, program_code NULLS LAST
        "#,
    )
    .bind(customer_id)
    .fetch_all(db)
    .await?;

    let mut options = vec![
        CoreCardProgramOption {
            program_code: "standard".to_string(),
            program_label: "Standard".to_string(),
            eligible: true,
            disclosure: Some("Primary RMS Charge financing program.".to_string()),
        },
        CoreCardProgramOption {
            program_code: "rms90".to_string(),
            program_label: "RMS 90".to_string(),
            eligible: true,
            disclosure: Some("Promotional 90-day financing program.".to_string()),
        },
    ];
    for (program_code, program_label) in rows {
        if let Some(code) = program_code.filter(|value| !value.trim().is_empty()) {
            if options.iter().all(|row| row.program_code != code) {
                options.push(CoreCardProgramOption {
                    program_code: code,
                    program_label: program_label.unwrap_or_else(|| "Program".to_string()),
                    eligible: true,
                    disclosure: None,
                });
            }
        }
    }
    Ok(options)
}

pub async fn collect_sync_health(db: &PgPool) -> Result<CoreCardSyncHealthResponse, CoreCardError> {
    let last_repair_poll_at: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
        r#"
        SELECT MAX(updated_at)
        FROM customer_corecredit_accounts
        WHERE last_balance_sync_at IS NOT NULL
           OR last_status_sync_at IS NOT NULL
           OR last_transactions_sync_at IS NOT NULL
        "#,
    )
    .fetch_optional(db)
    .await?
    .flatten();
    let active_exception_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM corecredit_exception_queue WHERE status IN ('open', 'assigned', 'retry_pending')",
    )
    .fetch_one(db)
    .await?;
    let pending_webhook_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM corecredit_event_log WHERE processing_status IN ('received', 'pending')",
    )
    .fetch_one(db)
    .await?;
    let failed_webhook_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM corecredit_event_log WHERE processing_status = 'failed'",
    )
    .fetch_one(db)
    .await?;
    let stale_account_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM customer_corecredit_accounts
        WHERE COALESCE(last_balance_sync_at, last_status_sync_at, last_transactions_sync_at) < now() - interval '1 day'
           OR last_sync_error IS NOT NULL
        "#,
    )
    .fetch_one(db)
    .await?;

    Ok(CoreCardSyncHealthResponse {
        last_repair_poll_at,
        active_exception_count,
        pending_webhook_count,
        failed_webhook_count,
        stale_account_count,
    })
}

pub async fn fetch_overview(
    db: &PgPool,
    customer_id: Option<Uuid>,
) -> Result<CoreCardOverviewResponse, CoreCardError> {
    let totals = sqlx::query(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE record_kind = 'charge') AS charge_count,
            COUNT(*) FILTER (WHERE record_kind = 'payment') AS payment_count,
            COUNT(*) FILTER (WHERE COALESCE(posting_status, 'legacy') = 'failed') AS failed_count,
            COUNT(*) FILTER (WHERE COALESCE(posting_status, 'legacy') IN ('pending', 'received')) AS pending_count,
            COALESCE(SUM(amount) FILTER (WHERE record_kind = 'charge'), 0) AS charge_amount,
            COALESCE(SUM(amount) FILTER (WHERE record_kind = 'payment'), 0) AS payment_amount
        FROM pos_rms_charge_record
        WHERE ($1::uuid IS NULL OR customer_id = $1)
        "#,
    )
    .bind(customer_id)
    .fetch_one(db)
    .await?;
    let totals_json = json!({
        "charge_count": totals.get::<i64, _>("charge_count"),
        "payment_count": totals.get::<i64, _>("payment_count"),
        "failed_count": totals.get::<i64, _>("failed_count"),
        "pending_count": totals.get::<i64, _>("pending_count"),
        "charge_amount": totals.get::<Decimal, _>("charge_amount").to_string(),
        "payment_amount": totals.get::<Decimal, _>("payment_amount").to_string(),
    });

    let recent_activity = sqlx::query_as::<_, RmsChargeRecordDetail>(
        r#"
        SELECT
            r.id,
            r.record_kind,
            r.created_at,
            r.transaction_id,
            r.register_session_id,
            r.customer_id,
            r.payment_method,
            r.amount,
            r.operator_staff_id,
            r.payment_transaction_id,
            r.customer_display,
            r.order_short_ref,
            r.tender_family,
            r.program_code,
            r.program_label,
            r.masked_account,
            r.linked_corecredit_customer_id,
            r.linked_corecredit_account_id,
            r.resolution_status,
            r.external_transaction_id,
            r.external_auth_code,
            COALESCE(r.posting_status, 'legacy') AS posting_status,
            r.posting_error_code,
            r.posting_error_message,
            r.posted_at,
            r.reversed_at,
            r.refunded_at,
            r.idempotency_key,
            r.external_transaction_type,
            r.host_reference,
            COALESCE(r.metadata_json, '{}'::jsonb) AS metadata_json,
            COALESCE(r.host_metadata_json, '{}'::jsonb) AS host_metadata_json,
            COALESCE(r.request_snapshot_json, '{}'::jsonb) AS request_snapshot_json,
            COALESCE(r.response_snapshot_json, '{}'::jsonb) AS response_snapshot_json,
            NULL::text AS customer_name,
            NULL::text AS customer_code,
            NULL::text AS operator_name
        FROM pos_rms_charge_record r
        WHERE ($1::uuid IS NULL OR r.customer_id = $1)
        ORDER BY r.created_at DESC
        LIMIT 12
        "#,
    )
    .bind(customer_id)
    .fetch_all(db)
    .await?;

    let failed_host_actions = list_exceptions(db, Some("open"), customer_id, 12).await?;
    let pending_exceptions = list_exceptions(db, Some("retry_pending"), customer_id, 12).await?;
    let program_mix_rows = sqlx::query(
        r#"
        SELECT
            COALESCE(program_code, 'legacy') AS program_code,
            COALESCE(program_label, 'Legacy / Manual') AS program_label,
            COUNT(*) AS row_count,
            COALESCE(SUM(amount), 0) AS total_amount
        FROM pos_rms_charge_record
        WHERE ($1::uuid IS NULL OR customer_id = $1)
        GROUP BY COALESCE(program_code, 'legacy'), COALESCE(program_label, 'Legacy / Manual')
        ORDER BY total_amount DESC, row_count DESC
        LIMIT 12
        "#,
    )
    .bind(customer_id)
    .fetch_all(db)
    .await?;
    let program_mix = program_mix_rows
        .into_iter()
        .map(|row| {
            json!({
                "program_code": row.get::<String, _>("program_code"),
                "program_label": row.get::<String, _>("program_label"),
                "row_count": row.get::<i64, _>("row_count"),
                "total_amount": row.get::<Decimal, _>("total_amount").to_string(),
            })
        })
        .collect();

    Ok(CoreCardOverviewResponse {
        totals: totals_json,
        recent_activity,
        failed_host_actions,
        pending_exceptions,
        program_mix,
        accounts: list_account_snapshots(db, customer_id).await?,
        sync_health: serde_json::to_value(collect_sync_health(db).await?).unwrap_or(Value::Null),
    })
}

pub async fn log_and_process_webhook_event(
    db: &PgPool,
    config: &CoreCardConfig,
    payload: &Value,
    signature_valid: bool,
    verification_result: Option<&str>,
) -> Result<CoreCardWebhookOutcome, CoreCardError> {
    let event_id = webhook_event_key(payload);
    let event_type = webhook_event_type(payload);
    let redacted_payload = super::redact_corecard_json(payload, config.redaction_mode);
    let external_transaction_id = metadata_text(payload, "external_transaction_id")
        .or_else(|| metadata_text(payload, "transaction_id"));
    let host_reference =
        metadata_text(payload, "host_reference").or_else(|| metadata_text(payload, "reference"));
    let idempotency_key = metadata_text(payload, "idempotency_key");
    let account_id = metadata_text(payload, "corecredit_account_id")
        .or_else(|| metadata_text(payload, "account_id"));
    let customer_id = metadata_text(payload, "riverside_customer_id")
        .and_then(|value| Uuid::parse_str(&value).ok());
    let rms_record_id = if let Some(id) =
        metadata_text(payload, "rms_record_id").and_then(|value| Uuid::parse_str(&value).ok())
    {
        Some(id)
    } else {
        find_rms_record_for_host_refs(
            db,
            external_transaction_id.as_deref(),
            host_reference.as_deref(),
            idempotency_key.as_deref(),
        )
        .await?
    };

    let insert = sqlx::query_as::<_, CoreCardEventLogRow>(
        r#"
        INSERT INTO corecredit_event_log (
            external_event_key,
            event_type,
            processing_status,
            signature_valid,
            verification_result,
            related_customer_id,
            related_account_id,
            related_rms_record_id,
            payload_json
        )
        VALUES ($1, $2, 'received', $3, $4, $5, $6, $7, $8)
        ON CONFLICT (external_event_key) DO UPDATE
        SET verification_result = COALESCE(corecredit_event_log.verification_result, EXCLUDED.verification_result)
        RETURNING
            id,
            external_event_key,
            event_type,
            received_at,
            processed_at,
            processing_status,
            signature_valid,
            verification_result,
            related_customer_id,
            related_account_id,
            related_rms_record_id,
            payload_json,
            error_message
        "#,
    )
    .bind(&event_id)
    .bind(&event_type)
    .bind(signature_valid)
    .bind(verification_result)
    .bind(customer_id)
    .bind(account_id.as_deref())
    .bind(rms_record_id)
    .bind(&redacted_payload)
    .fetch_one(db)
    .await?;

    if insert.processed_at.is_some() && insert.processing_status == "processed" {
        return Ok(CoreCardWebhookOutcome {
            event_id,
            processing_status: "processed".to_string(),
            duplicate: true,
            related_rms_record_id: insert.related_rms_record_id,
        });
    }

    let status = webhook_processing_status(payload);
    let mut final_status = "processed".to_string();
    let mut error_message: Option<String> = None;
    let posting_status: Option<&str> =
        if status.contains("fail") || status.contains("declin") || status.contains("error") {
            final_status = "failed".to_string();
            error_message = metadata_text(payload, "message")
                .or_else(|| metadata_text(payload, "error_message"))
                .or_else(|| metadata_text(payload, "detail"));
            Some("failed")
        } else if event_type.contains("refund") {
            Some("refunded")
        } else if event_type.contains("reversal") {
            Some("reversed")
        } else if status.contains("pending") || status.contains("received") {
            Some("pending")
        } else {
            Some("posted")
        };

    if let Some(record_id) = rms_record_id {
        sqlx::query(
            r#"
            UPDATE pos_rms_charge_record
            SET
                external_transaction_id = COALESCE($2, external_transaction_id),
                posting_status = COALESCE($3, posting_status),
                posting_error_message = COALESCE($4, posting_error_message),
                host_reference = COALESCE($5, host_reference),
                host_metadata_json = $6,
                response_snapshot_json = $6,
                posted_at = CASE WHEN $3 = 'posted' THEN COALESCE(posted_at, now()) ELSE posted_at END,
                reversed_at = CASE WHEN $3 = 'reversed' THEN COALESCE(reversed_at, now()) ELSE reversed_at END,
                refunded_at = CASE WHEN $3 = 'refunded' THEN COALESCE(refunded_at, now()) ELSE refunded_at END
            WHERE id = $1
            "#,
        )
        .bind(record_id)
        .bind(external_transaction_id.as_deref())
        .bind(posting_status)
        .bind(error_message.as_deref())
        .bind(host_reference.as_deref())
        .bind(&redacted_payload)
        .execute(db)
        .await?;
    }

    if let Some(account_id) = account_id.as_deref() {
        sqlx::query(
            r#"
            UPDATE customer_corecredit_accounts
            SET
                status = COALESCE($3, status),
                available_credit_snapshot = COALESCE($4, available_credit_snapshot),
                current_balance_snapshot = COALESCE($5, current_balance_snapshot),
                past_due_snapshot = COALESCE($6, past_due_snapshot),
                restrictions_snapshot_json = COALESCE($7, restrictions_snapshot_json),
                last_balance_sync_at = now(),
                last_status_sync_at = now(),
                updated_at = now()
            WHERE corecredit_account_id = $1
              AND ($2::uuid IS NULL OR customer_id = $2)
            "#,
        )
        .bind(account_id)
        .bind(customer_id)
        .bind(metadata_text(payload, "account_status").as_deref())
        .bind(metadata_text(payload, "available_credit").as_deref())
        .bind(metadata_text(payload, "current_balance").as_deref())
        .bind(metadata_text(payload, "past_due").as_deref())
        .bind(
            payload
                .get("restrictions")
                .cloned()
                .unwrap_or_else(|| json!({})),
        )
        .execute(db)
        .await?;
    }

    if final_status == "failed" {
        let exception_type = if event_type.contains("payment") {
            "failed_payment_post"
        } else if event_type.contains("refund") {
            "failed_refund"
        } else if event_type.contains("reversal") {
            "failed_reversal"
        } else {
            "failed_purchase_post"
        };
        let _ = upsert_exception(
            db,
            rms_record_id,
            account_id.as_deref(),
            exception_type,
            "high",
            error_message
                .as_deref()
                .or(Some("CoreCard webhook reported a failed host action.")),
            &json!({
                "event_id": event_id,
                "event_type": event_type,
                "status": status,
            }),
        )
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE corecredit_event_log
        SET
            processed_at = now(),
            processing_status = $2,
            error_message = $3
        WHERE external_event_key = $1
        "#,
    )
    .bind(&event_id)
    .bind(&final_status)
    .bind(error_message.as_deref())
    .execute(db)
    .await?;

    Ok(CoreCardWebhookOutcome {
        event_id,
        processing_status: final_status,
        duplicate: false,
        related_rms_record_id: rms_record_id,
    })
}

fn qbo_support_value_for_record(
    record_kind: &str,
    tender_family: Option<&str>,
    payment_method: &str,
) -> Value {
    if record_kind == "payment" {
        json!({
            "expected_clearing_account": "RMS_R2S_PAYMENT_CLEARING",
            "accounting_treatment": "pass_through_payment_collection",
            "payment_method": payment_method,
        })
    } else if tender_family == Some("rms_charge") {
        json!({
            "expected_clearing_account": "RMS_CHARGE_FINANCING_CLEARING",
            "accounting_treatment": "financed_sale_tender",
            "payment_method": payment_method,
        })
    } else {
        json!({
            "expected_clearing_account": null,
            "accounting_treatment": "legacy_or_manual",
            "payment_method": payment_method,
        })
    }
}

pub async fn run_reconciliation(
    db: &PgPool,
    requested_by_staff_id: Option<Uuid>,
    run_scope: &str,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
) -> Result<CoreCardReconciliationRunRow, CoreCardError> {
    let run = sqlx::query_as::<_, CoreCardReconciliationRunRow>(
        r#"
        INSERT INTO corecredit_reconciliation_run (
            run_scope,
            requested_by_staff_id,
            date_from,
            date_to,
            status
        )
        VALUES ($1, $2, $3, $4, 'running')
        RETURNING
            id,
            run_scope,
            status,
            started_at,
            completed_at,
            requested_by_staff_id,
            date_from,
            date_to,
            summary_json,
            error_message
        "#,
    )
    .bind(run_scope.trim())
    .bind(requested_by_staff_id)
    .bind(date_from)
    .bind(date_to)
    .fetch_one(db)
    .await?;

    let from_dt = date_from
        .and_then(|value| value.and_hms_opt(0, 0, 0))
        .map(|value| chrono::DateTime::<Utc>::from_naive_utc_and_offset(value, Utc))
        .unwrap_or_else(|| Utc::now() - Duration::days(1));
    let to_dt = date_to
        .and_then(|value| value.succ_opt())
        .and_then(|value| value.and_hms_opt(0, 0, 0))
        .map(|value| chrono::DateTime::<Utc>::from_naive_utc_and_offset(value, Utc))
        .unwrap_or_else(Utc::now);

    let rows = sqlx::query(
        r#"
        SELECT
            id,
            record_kind,
            amount,
            payment_method,
            tender_family,
            COALESCE(posting_status, 'legacy') AS posting_status,
            external_transaction_id,
            host_reference,
            linked_corecredit_account_id
        FROM pos_rms_charge_record
        WHERE created_at >= $1 AND created_at < $2
        ORDER BY created_at DESC
        "#,
    )
    .bind(from_dt)
    .bind(to_dt)
    .fetch_all(db)
    .await?;

    let mut mismatch_count = 0usize;
    let mut retryable_count = 0usize;
    for row in rows {
        let record_id = row.get::<Uuid, _>("id");
        let posting_status = row.get::<String, _>("posting_status");
        let external_transaction_id = row.get::<Option<String>, _>("external_transaction_id");
        let host_reference = row.get::<Option<String>, _>("host_reference");
        let payment_method = row.get::<String, _>("payment_method");
        let record_kind = row.get::<String, _>("record_kind");
        let tender_family = row.get::<Option<String>, _>("tender_family");
        let account_id = row.get::<Option<String>, _>("linked_corecredit_account_id");

        let mismatch_type = if posting_status == "failed" {
            Some(("posting_failed", "high", true))
        } else if posting_status == "pending" {
            Some(("posting_pending", "medium", true))
        } else if posting_status == "posted"
            && external_transaction_id
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            && host_reference.as_deref().unwrap_or("").trim().is_empty()
        {
            Some(("missing_host_reference", "medium", false))
        } else if posting_status == "legacy" && tender_family.as_deref() == Some("rms_charge") {
            Some(("legacy_record_review", "low", false))
        } else {
            None
        };

        if let Some((kind, severity, retryable)) = mismatch_type {
            mismatch_count += 1;
            if retryable {
                retryable_count += 1;
            }
            sqlx::query(
                r#"
                INSERT INTO corecredit_reconciliation_item (
                    run_id,
                    rms_record_id,
                    account_id,
                    mismatch_type,
                    severity,
                    status,
                    riverside_value_json,
                    host_value_json,
                    qbo_value_json,
                    notes
                )
                VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9)
                "#,
            )
            .bind(run.id)
            .bind(record_id)
            .bind(account_id.as_deref())
            .bind(kind)
            .bind(severity)
            .bind(json!({
                "posting_status": posting_status,
                "external_transaction_id": external_transaction_id,
                "host_reference": host_reference,
                "record_kind": record_kind,
                "amount": row.get::<Decimal, _>("amount").to_string(),
            }))
            .bind(json!({
                "host_reference": host_reference,
                "external_transaction_id": external_transaction_id,
            }))
            .bind(qbo_support_value_for_record(
                &record_kind,
                tender_family.as_deref(),
                &payment_method,
            ))
            .bind(format!(
                "Detected during RMS reconciliation run ({run_scope})."
            ))
            .execute(db)
            .await?;

            let _ = upsert_exception(
                db,
                Some(record_id),
                account_id.as_deref(),
                "reconciliation_mismatch",
                severity,
                Some("RMS reconciliation detected a mismatch that needs review."),
                &json!({
                    "run_id": run.id,
                    "mismatch_type": kind,
                }),
            )
            .await?;
        }
    }

    let summary_json = json!({
        "mismatch_count": mismatch_count,
        "retryable_count": retryable_count,
        "date_from": date_from,
        "date_to": date_to,
    });
    let completed = sqlx::query_as::<_, CoreCardReconciliationRunRow>(
        r#"
        UPDATE corecredit_reconciliation_run
        SET
            status = 'completed',
            completed_at = now(),
            summary_json = $2
        WHERE id = $1
        RETURNING
            id,
            run_scope,
            status,
            started_at,
            completed_at,
            requested_by_staff_id,
            date_from,
            date_to,
            summary_json,
            error_message
        "#,
    )
    .bind(run.id)
    .bind(summary_json)
    .fetch_one(db)
    .await?;
    Ok(completed)
}

pub async fn list_reconciliation(
    db: &PgPool,
    limit: i64,
) -> Result<CoreCardReconciliationResponse, CoreCardError> {
    let runs = sqlx::query_as::<_, CoreCardReconciliationRunRow>(
        r#"
        SELECT
            id,
            run_scope,
            status,
            started_at,
            completed_at,
            requested_by_staff_id,
            date_from,
            date_to,
            summary_json,
            error_message
        FROM corecredit_reconciliation_run
        ORDER BY started_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit.clamp(1, 30))
    .fetch_all(db)
    .await?;
    let latest_run_ids: Vec<Uuid> = runs.iter().map(|row| row.id).collect();
    let items = if latest_run_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, CoreCardReconciliationItemRow>(
            r#"
            SELECT
                id,
                run_id,
                rms_record_id,
                account_id,
                mismatch_type,
                severity,
                status,
                riverside_value_json,
                host_value_json,
                qbo_value_json,
                notes,
                created_at
            FROM corecredit_reconciliation_item
            WHERE run_id = ANY($1)
            ORDER BY created_at DESC
            LIMIT 200
            "#,
        )
        .bind(&latest_run_ids)
        .fetch_all(db)
        .await?
    };
    Ok(CoreCardReconciliationResponse { runs, items })
}

pub async fn apply_snapshot_retention(
    db: &PgPool,
    retention_days: u32,
) -> Result<(), CoreCardError> {
    let note = json!({ "retained_summary_only": true });
    sqlx::query(
        r#"
        UPDATE pos_rms_charge_record
        SET
            request_snapshot_json = $1,
            response_snapshot_json = $1
        WHERE created_at < now() - make_interval(days => $2::int)
          AND (request_snapshot_json <> $1::jsonb OR response_snapshot_json <> $1::jsonb)
        "#,
    )
    .bind(&note)
    .bind(retention_days as i32)
    .execute(db)
    .await?;
    sqlx::query(
        r#"
        UPDATE corecard_posting_event
        SET
            request_snapshot_json = $1,
            response_snapshot_json = $1
        WHERE created_at < now() - make_interval(days => $2::int)
          AND (request_snapshot_json <> $1::jsonb OR response_snapshot_json <> $1::jsonb)
        "#,
    )
    .bind(&note)
    .bind(retention_days as i32)
    .execute(db)
    .await?;
    sqlx::query(
        r#"
        UPDATE corecredit_event_log
        SET payload_json = $1
        WHERE received_at < now() - make_interval(days => $2::int)
          AND payload_json <> $1::jsonb
        "#,
    )
    .bind(&note)
    .bind(retention_days as i32)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn run_repair_poll(
    db: &PgPool,
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
) -> Result<CoreCardSyncHealthResponse, CoreCardError> {
    let accounts = list_account_snapshots(db, None).await?;
    for account in accounts {
        let summary = account_summary_for_customer(
            db,
            http_client,
            config,
            token_cache,
            account.customer_id,
            &account.corecredit_account_id,
        )
        .await;
        match summary {
            Ok(summary) => {
                let summary_status = summary.account_status.clone();
                let transactions = account_transactions_for_customer(
                    db,
                    http_client,
                    config,
                    token_cache,
                    account.customer_id,
                    &account.corecredit_account_id,
                )
                .await?;
                sqlx::query(
                    r#"
                    UPDATE customer_corecredit_accounts
                    SET
                        status = $3,
                        available_credit_snapshot = $4,
                        current_balance_snapshot = $5,
                        last_balance_sync_at = now(),
                        last_status_sync_at = now(),
                        last_transactions_sync_at = now(),
                        last_sync_error = NULL,
                        updated_at = now()
                    WHERE id = $1 AND customer_id = $2
                    "#,
                )
                .bind(account.id)
                .bind(account.customer_id)
                .bind(&summary_status)
                .bind(summary.available_credit)
                .bind(summary.current_balance)
                .execute(db)
                .await?;

                let stale_restricted = transactions
                    .rows
                    .first()
                    .map(|row| row.status.to_ascii_lowercase().contains("failed"))
                    .unwrap_or(false)
                    || account_is_blocked(&summary_status);
                if stale_restricted {
                    let _ = upsert_exception(
                        db,
                        None,
                        Some(&account.corecredit_account_id),
                        "stale_account_state",
                        "medium",
                        Some("Repair polling found a restricted or failed RMS account state."),
                        &json!({
                            "account_status": summary_status,
                            "source": summary.source,
                        }),
                    )
                    .await?;
                }
            }
            Err(error) => {
                sqlx::query(
                    r#"
                    UPDATE customer_corecredit_accounts
                    SET last_sync_error = $2, updated_at = now()
                    WHERE id = $1
                    "#,
                )
                .bind(account.id)
                .bind(clipped_text(&error.to_string(), 500))
                .execute(db)
                .await?;
                let _ = upsert_exception(
                    db,
                    None,
                    Some(&account.corecredit_account_id),
                    "stale_account_state",
                    "medium",
                    Some("Repair polling could not refresh the account snapshot."),
                    &json!({ "error": error.to_string() }),
                )
                .await?;
            }
        }
    }
    apply_snapshot_retention(db, config.snapshot_retention_days).await?;
    collect_sync_health(db).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn linked(id: &str, status: &str, is_primary: bool) -> CustomerCoreCreditAccount {
        CustomerCoreCreditAccount {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            corecredit_customer_id: "cust-1".to_string(),
            corecredit_account_id: id.to_string(),
            corecredit_card_id: None,
            status: status.to_string(),
            is_primary,
            program_group: Some("promo-90".to_string()),
            last_verified_at: None,
            verified_by_staff_id: None,
            verification_source: None,
            notes: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn resolve_blocks_without_customer() {
        let response = resolve_accounts_from_links(
            &PosResolveAccountRequest {
                customer_id: None,
                preferred_account_id: None,
            },
            &[],
        );
        assert_eq!(response.resolution_status, "blocked");
        assert_eq!(
            response
                .blocking_error
                .as_ref()
                .map(|err| err.code.as_str()),
            Some("customer_required")
        );
    }

    #[test]
    fn resolve_auto_selects_single_valid_account() {
        let customer_id = Uuid::new_v4();
        let response = resolve_accounts_from_links(
            &PosResolveAccountRequest {
                customer_id: Some(customer_id),
                preferred_account_id: None,
            },
            &[linked("ACC-1001", "active", true)],
        );
        assert_eq!(response.resolution_status, "selected");
        assert_eq!(
            response
                .selected_account
                .as_ref()
                .map(|row| row.corecredit_account_id.as_str()),
            Some("ACC-1001")
        );
    }

    #[test]
    fn resolve_returns_multiple_masked_choices() {
        let customer_id = Uuid::new_v4();
        let response = resolve_accounts_from_links(
            &PosResolveAccountRequest {
                customer_id: Some(customer_id),
                preferred_account_id: None,
            },
            &[
                linked("ACC-1001", "active", true),
                linked("ACC-2002", "open", false),
            ],
        );
        assert_eq!(response.resolution_status, "multiple");
        assert_eq!(response.choices.len(), 2);
        assert!(response
            .choices
            .iter()
            .all(|choice| choice.masked_account.starts_with("••••")));
    }

    #[test]
    fn idempotency_key_is_stable_for_same_inputs() {
        let left = build_idempotency_key(
            CoreCardOperationType::Purchase,
            "abc",
            "acct-1",
            Decimal::new(12500, 2),
            Some("rms90"),
        );
        let right = build_idempotency_key(
            CoreCardOperationType::Purchase,
            "abc",
            "acct-1",
            Decimal::new(12500, 2),
            Some("rms90"),
        );
        assert_eq!(left, right);
    }

    #[test]
    fn webhook_event_key_prefers_explicit_identifier() {
        let payload = json!({
            "event_id": "evt-123",
            "type": "purchase_posted",
        });
        assert_eq!(webhook_event_key(&payload), "evt-123");
    }

    #[test]
    fn webhook_processing_status_defaults_to_received() {
        assert_eq!(webhook_processing_status(&json!({})), "received");
        assert_eq!(
            webhook_processing_status(&json!({ "status": "FAILED" })),
            "failed"
        );
    }

    #[test]
    fn qbo_support_value_uses_rms_clearing_accounts() {
        let purchase = qbo_support_value_for_record("charge", Some("rms_charge"), "rms_charge");
        let payment = qbo_support_value_for_record("payment", None, "cash");
        assert_eq!(
            purchase
                .get("expected_clearing_account")
                .and_then(Value::as_str),
            Some("RMS_CHARGE_FINANCING_CLEARING")
        );
        assert_eq!(
            payment
                .get("expected_clearing_account")
                .and_then(Value::as_str),
            Some("RMS_R2S_PAYMENT_CLEARING")
        );
    }

    #[tokio::test]
    async fn host_mutation_parses_successful_purchase_result() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "tok-1",
                "expires_in": 900
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/transactions/purchase"))
            .and(body_partial_json(json!({
                "corecredit_account_id": "acct-1001",
                "program_code": "rms90"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "posted",
                "external_transaction_id": "host-tx-1",
                "authorization_code": "AUTH123",
                "host_reference": "REF-9001"
            })))
            .mount(&server)
            .await;

        let config = CoreCardConfig {
            base_url: server.uri(),
            client_id: Some("client".to_string()),
            client_secret: Some("secret".to_string()),
            region: "us".to_string(),
            environment: "sandbox".to_string(),
            timeout_secs: 5,
            log_payloads: false,
            redaction_mode: super::super::CoreCardRedactionMode::Standard,
            webhook_secret: None,
            webhook_allow_unsigned: true,
            repair_poll_secs: 900,
            snapshot_retention_days: 30,
        };
        let cache = Arc::new(Mutex::new(CoreCardTokenCache::default()));
        let client = reqwest::Client::new();
        let result = post_host_mutation(
            &client,
            &config,
            &cache,
            CoreCardOperationType::Purchase,
            "transactions.purchase",
            &json!({
                "corecredit_customer_id": "cust-1",
                "corecredit_account_id": "acct-1001",
                "program_code": "rms90",
                "amount": "125.00"
            }),
            "idem-1",
        )
        .await
        .expect("host purchase succeeds");

        assert_eq!(result.posting_status, "posted");
        assert_eq!(result.external_transaction_id.as_deref(), Some("host-tx-1"));
        assert_eq!(result.host_reference.as_deref(), Some("REF-9001"));
    }

    #[tokio::test]
    async fn host_mutation_classifies_insufficient_credit() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "tok-1",
                "expires_in": 900
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/transactions/purchase"))
            .respond_with(ResponseTemplate::new(402).set_body_json(json!({
                "error_code": "INSUFFICIENT_CREDIT",
                "message": "Available credit is insufficient"
            })))
            .mount(&server)
            .await;

        let config = CoreCardConfig {
            base_url: server.uri(),
            client_id: Some("client".to_string()),
            client_secret: Some("secret".to_string()),
            region: "us".to_string(),
            environment: "sandbox".to_string(),
            timeout_secs: 5,
            log_payloads: false,
            redaction_mode: super::super::CoreCardRedactionMode::Standard,
            webhook_secret: None,
            webhook_allow_unsigned: true,
            repair_poll_secs: 900,
            snapshot_retention_days: 30,
        };
        let cache = Arc::new(Mutex::new(CoreCardTokenCache::default()));
        let client = reqwest::Client::new();
        let error = post_host_mutation(
            &client,
            &config,
            &cache,
            CoreCardOperationType::Purchase,
            "transactions.purchase",
            &json!({
                "corecredit_customer_id": "cust-1",
                "corecredit_account_id": "acct-1001",
                "program_code": "rms90",
                "amount": "125.00"
            }),
            "idem-2",
        )
        .await
        .expect_err("host purchase should fail");

        let failure = error.as_host_failure().expect("normalized host failure");
        assert_eq!(
            failure.code,
            CoreCardFailureCode::InsufficientAvailableCredit
        );
        assert!(!failure.retryable);
    }
}
