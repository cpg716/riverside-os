use std::collections::{HashMap, HashSet};
use std::io::Cursor;

use calamine::{open_workbook_auto_from_rs, Data, Reader};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

const SHEET_NAME: &str = "AccountListReportData";
const EXPECTED_TITLE: &str = "Account List Report";
const ACCOUNT_BLOCK_START_ROW: usize = 4;
const ACCOUNT_BLOCK_ROWS: usize = 4;
const FOOTER_TOTAL_TOLERANCE_CENTS: i64 = 1;
pub const RMS_ACCOUNT_LIST_FRESH_DAYS: i64 = 7;

#[derive(Debug, Error)]
pub enum AccountListPreviewError {
    #[error("uploaded workbook is empty")]
    EmptyWorkbook,
    #[error("could not read XLSX workbook: {0}")]
    Workbook(String),
    #[error("required sheet AccountListReportData was not found")]
    SheetMissing,
    #[error("Account List Report title row was not found")]
    ReportTitleMissing,
    #[error("no account blocks were found in the report")]
    NoAccounts,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountListPreviewResponse {
    pub source: &'static str,
    pub snapshot_label: &'static str,
    pub metadata: AccountListReportMetadata,
    pub parsed_account_count: usize,
    pub footer_count: Option<usize>,
    pub total_balance: Decimal,
    pub total_minimum_due: Decimal,
    pub total_past_due: Decimal,
    pub total_open_to_buy: Decimal,
    pub warning_count: usize,
    pub warnings: Vec<String>,
    pub data_quality: AccountListDataQualitySummary,
    pub sample_accounts: Vec<AccountListPreviewAccount>,
}

#[derive(Debug, Clone)]
pub struct ParsedAccountListReport {
    pub metadata: AccountListReportMetadata,
    pub parsed_account_count: usize,
    pub footer_count: Option<usize>,
    pub total_balance: Decimal,
    pub total_minimum_due: Decimal,
    pub total_past_due: Decimal,
    pub total_open_to_buy: Decimal,
    pub warning_count: usize,
    pub warnings: Vec<String>,
    pub data_quality: AccountListDataQualitySummary,
    pub accounts: Vec<AccountListPreviewAccount>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AccountListReportMetadata {
    pub sheet_name: String,
    pub report_title: Option<String>,
    pub institution_name: Option<String>,
    pub merchant_name: Option<String>,
    pub report_run_at: Option<NaiveDateTime>,
    pub report_run_at_raw: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AccountListDataQualitySummary {
    pub missing_phones: usize,
    pub invalid_phones: usize,
    pub missing_addresses: usize,
    pub active_balance_count: usize,
    pub past_due_count: usize,
    pub zero_open_to_buy_count: usize,
    pub duplicate_account_number_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountListPreviewAccount {
    pub account_number: String,
    pub account_year: Option<String>,
    pub name: String,
    pub address: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub zip: Option<String>,
    pub phone: Option<String>,
    pub normalized_phone: Option<String>,
    pub high_balance: Decimal,
    pub previous_balance: Decimal,
    pub payments: Decimal,
    pub returns: Decimal,
    pub charges: Decimal,
    pub finance_charge: Decimal,
    pub balance: Decimal,
    pub minimum_due: Decimal,
    pub past_due: Decimal,
    pub aging_30: Decimal,
    pub aging_60: Decimal,
    pub aging_90_plus: Decimal,
    pub open_to_buy: Decimal,
    pub payment_history_codes: Vec<String>,
    pub parser_warnings: Vec<String>,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountListImportResponse {
    pub batch: AccountListBatchSummary,
    pub inserted_snapshot_count: usize,
    pub warning_count: usize,
    pub data_quality: AccountListDataQualitySummary,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AccountListBatchSummary {
    pub id: Uuid,
    pub source_filename: Option<String>,
    pub source_file_hash: String,
    pub institution_name: Option<String>,
    pub merchant_name: Option<String>,
    pub report_run_at: Option<DateTime<Utc>>,
    pub uploaded_by_staff_id: Option<Uuid>,
    pub uploaded_at: DateTime<Utc>,
    pub parsed_account_count: i32,
    pub footer_account_count: Option<i32>,
    pub total_balance: Option<Decimal>,
    pub total_minimum_due: Option<Decimal>,
    pub total_past_due: Option<Decimal>,
    pub total_open_to_buy: Option<Decimal>,
    pub warning_summary: Value,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountListLatestImportResponse {
    pub latest: Option<AccountListBatchSummary>,
    pub stale: bool,
    pub stale_after_days: i64,
    pub matched_count: i64,
    pub unmatched_count: i64,
}

#[derive(Debug, Clone, Default)]
struct FooterTotals {
    count: Option<usize>,
    balance: Option<Decimal>,
    minimum_due: Option<Decimal>,
    past_due: Option<Decimal>,
    open_to_buy: Option<Decimal>,
}

pub fn preview_account_list_xlsx(
    bytes: &[u8],
) -> Result<AccountListPreviewResponse, AccountListPreviewError> {
    let parsed = parse_account_list_xlsx(bytes)?;
    Ok(AccountListPreviewResponse {
        source: "r2s_account_list_report",
        snapshot_label: "report snapshot",
        metadata: parsed.metadata,
        parsed_account_count: parsed.parsed_account_count,
        footer_count: parsed.footer_count,
        total_balance: parsed.total_balance,
        total_minimum_due: parsed.total_minimum_due,
        total_past_due: parsed.total_past_due,
        total_open_to_buy: parsed.total_open_to_buy,
        warning_count: parsed.warning_count,
        warnings: parsed.warnings,
        data_quality: parsed.data_quality,
        sample_accounts: parsed.accounts.into_iter().take(10).collect(),
    })
}

pub fn parse_account_list_xlsx(
    bytes: &[u8],
) -> Result<ParsedAccountListReport, AccountListPreviewError> {
    if bytes.is_empty() {
        return Err(AccountListPreviewError::EmptyWorkbook);
    }

    let mut workbook = open_workbook_auto_from_rs(Cursor::new(bytes.to_vec()))
        .map_err(|error| AccountListPreviewError::Workbook(error.to_string()))?;
    let range = workbook
        .worksheet_range(SHEET_NAME)
        .map_err(|_| AccountListPreviewError::SheetMissing)?;

    let mut warnings = Vec::new();
    let metadata = parse_metadata(&range, &mut warnings)?;
    let footer = parse_footer(&range);
    let accounts = parse_accounts(&range, &mut warnings)?;

    if accounts.is_empty() {
        return Err(AccountListPreviewError::NoAccounts);
    }

    let mut seen = HashMap::<String, usize>::new();
    let mut duplicates = HashSet::<String>::new();
    for account in &accounts {
        let count = seen.entry(account.account_number.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            duplicates.insert(account.account_number.clone());
        }
    }

    if let Some(footer_count) = footer.count {
        if footer_count != accounts.len() {
            warnings.push(format!(
                "Footer count {footer_count} does not match parsed account count {}.",
                accounts.len()
            ));
        }
    } else {
        warnings.push("Footer account count was not found.".to_string());
    }

    let total_balance = sum_decimal(&accounts, |account| account.balance);
    let total_minimum_due = sum_decimal(&accounts, |account| account.minimum_due);
    let total_past_due = sum_decimal(&accounts, |account| account.past_due);
    let total_open_to_buy = sum_decimal(&accounts, |account| account.open_to_buy);

    compare_footer_total("balance", total_balance, footer.balance, &mut warnings);
    compare_footer_total(
        "minimum due",
        total_minimum_due,
        footer.minimum_due,
        &mut warnings,
    );
    compare_footer_total("past due", total_past_due, footer.past_due, &mut warnings);
    compare_footer_total(
        "open-to-buy",
        total_open_to_buy,
        footer.open_to_buy,
        &mut warnings,
    );

    let data_quality = AccountListDataQualitySummary {
        missing_phones: accounts
            .iter()
            .filter(|account| account.phone.as_deref().unwrap_or("").trim().is_empty())
            .count(),
        invalid_phones: accounts
            .iter()
            .filter(|account| {
                !account.phone.as_deref().unwrap_or("").trim().is_empty()
                    && account.normalized_phone.is_none()
            })
            .count(),
        missing_addresses: accounts
            .iter()
            .filter(|account| {
                account.address.as_deref().unwrap_or("").trim().is_empty()
                    || account.city.as_deref().unwrap_or("").trim().is_empty()
                    || account.state.as_deref().unwrap_or("").trim().is_empty()
                    || account.zip.as_deref().unwrap_or("").trim().is_empty()
            })
            .count(),
        active_balance_count: accounts
            .iter()
            .filter(|account| account.balance > Decimal::ZERO)
            .count(),
        past_due_count: accounts
            .iter()
            .filter(|account| account.past_due > Decimal::ZERO)
            .count(),
        zero_open_to_buy_count: accounts
            .iter()
            .filter(|account| account.open_to_buy == Decimal::ZERO)
            .count(),
        duplicate_account_number_count: duplicates.len(),
    };

    if !duplicates.is_empty() {
        warnings.push(format!(
            "{} duplicate account number(s) were found.",
            duplicates.len()
        ));
    }

    Ok(ParsedAccountListReport {
        metadata,
        parsed_account_count: accounts.len(),
        footer_count: footer.count,
        total_balance,
        total_minimum_due,
        total_past_due,
        total_open_to_buy,
        warning_count: warnings.len(),
        warnings,
        data_quality,
        accounts,
    })
}

fn parse_metadata(
    range: &calamine::Range<Data>,
    warnings: &mut Vec<String>,
) -> Result<AccountListReportMetadata, AccountListPreviewError> {
    let title = text_at(range, 0, 0);
    if title.as_deref() != Some(EXPECTED_TITLE) {
        return Err(AccountListPreviewError::ReportTitleMissing);
    }

    let institution_name = text_at(range, 1, 2);
    let merchant_name = text_at(range, 2, 2);
    let report_run_at_raw = text_at(range, 1, 12).or_else(|| text_at(range, 1, 10));
    let report_run_at = report_run_at_raw
        .as_deref()
        .and_then(parse_report_run_timestamp);

    if institution_name.as_deref() != Some("R2S Financial") {
        warnings.push("Institution name did not match R2S Financial.".to_string());
    }
    if merchant_name.as_deref() != Some("Riverside Men's Shop") {
        warnings.push("Merchant name did not match Riverside Men's Shop.".to_string());
    }
    if report_run_at_raw.is_none() || report_run_at.is_none() {
        warnings.push("Report run timestamp could not be parsed.".to_string());
    }

    Ok(AccountListReportMetadata {
        sheet_name: SHEET_NAME.to_string(),
        report_title: title,
        institution_name,
        merchant_name,
        report_run_at,
        report_run_at_raw,
    })
}

fn parse_accounts(
    range: &calamine::Range<Data>,
    warnings: &mut Vec<String>,
) -> Result<Vec<AccountListPreviewAccount>, AccountListPreviewError> {
    let mut accounts = Vec::new();
    let mut row = ACCOUNT_BLOCK_START_ROW;
    while row < range.height() {
        let Some(account_number) = text_at(range, row, 0) else {
            row += 1;
            continue;
        };
        if account_number.eq_ignore_ascii_case("Grand Total")
            || account_number.eq_ignore_ascii_case("Count")
        {
            break;
        }
        if !is_account_number(&account_number) {
            row += 1;
            continue;
        }
        if row + 2 >= range.height() {
            warnings.push(format!(
                "Account block starting at row {} was incomplete.",
                row + 1
            ));
            break;
        }

        let mut parser_warnings = Vec::new();
        let account_year = text_at(range, row, 1);
        let name = join_name_parts(text_at(range, row, 3), text_at(range, row, 5));
        if name.is_empty() {
            parser_warnings.push("missing name".to_string());
        }

        let address = text_at(range, row, 7);
        let city = text_at(range, row, 9);
        let state = text_at(range, row, 11);
        let zip = normalize_zip(text_at(range, row, 12).as_deref());
        let phone = text_at(range, row, 13);
        let normalized_phone = normalize_phone(phone.as_deref());
        if phone.as_deref().unwrap_or("").trim().is_empty() {
            parser_warnings.push("missing phone".to_string());
        } else if normalized_phone.is_none() {
            parser_warnings.push("invalid phone".to_string());
        }
        if address.as_deref().unwrap_or("").trim().is_empty()
            || city.as_deref().unwrap_or("").trim().is_empty()
            || state.as_deref().unwrap_or("").trim().is_empty()
            || zip.as_deref().unwrap_or("").trim().is_empty()
        {
            parser_warnings.push("missing address component".to_string());
        }

        let snapshot_row = row + 2;
        let account = AccountListPreviewAccount {
            account_number,
            account_year,
            name,
            address,
            city,
            state,
            zip,
            phone,
            normalized_phone,
            high_balance: decimal_at(range, snapshot_row, 1),
            previous_balance: decimal_at(range, snapshot_row, 2),
            payments: decimal_at(range, snapshot_row, 3),
            returns: decimal_at(range, snapshot_row, 4),
            charges: decimal_at(range, snapshot_row, 5),
            finance_charge: decimal_at(range, snapshot_row, 6),
            balance: decimal_at(range, snapshot_row, 7),
            minimum_due: decimal_at(range, snapshot_row, 8),
            past_due: decimal_at(range, snapshot_row, 9),
            aging_30: decimal_at(range, snapshot_row, 10),
            aging_60: decimal_at(range, snapshot_row, 11),
            aging_90_plus: decimal_at(range, snapshot_row, 12),
            open_to_buy: decimal_at(range, snapshot_row, 13),
            payment_history_codes: payment_history_codes(range, row + 3),
            parser_warnings,
            raw_payload: raw_account_payload(range, row),
        };
        accounts.push(account);
        row += ACCOUNT_BLOCK_ROWS;
    }
    Ok(accounts)
}

fn parse_footer(range: &calamine::Range<Data>) -> FooterTotals {
    let mut footer = FooterTotals::default();
    for row_index in 0..range.height() {
        if text_at(range, row_index, 0).as_deref() == Some("Count") {
            footer.count = decimal_at_optional(range, row_index, 1)
                .and_then(|value| value.round_dp(0).to_string().parse::<usize>().ok());
            if row_index >= 2 {
                let total_row = row_index - 2;
                footer.balance = decimal_at_optional(range, total_row, 7);
                footer.minimum_due = decimal_at_optional(range, total_row, 8);
                footer.past_due = decimal_at_optional(range, total_row, 9);
                footer.open_to_buy = decimal_at_optional(range, total_row, 13);
            }
            break;
        }
    }
    footer
}

pub fn account_list_file_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub async fn import_account_list_xlsx(
    pool: &PgPool,
    bytes: &[u8],
    source_filename: Option<&str>,
    uploaded_by_staff_id: Option<Uuid>,
) -> Result<AccountListImportResponse, AccountListPreviewError> {
    let parsed = parse_account_list_xlsx(bytes)?;
    let source_file_hash = account_list_file_hash(bytes);
    let warning_summary = json!({
        "warnings": parsed.warnings,
        "data_quality": parsed.data_quality,
        "snapshot_label": "report snapshot",
    });
    let report_run_at = parsed.metadata.report_run_at.map(report_run_at_as_utc);
    let source_filename = source_filename
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| AccountListPreviewError::Workbook(error.to_string()))?;

    let batch = insert_import_batch(
        &mut tx,
        &source_filename,
        &source_file_hash,
        &parsed,
        report_run_at,
        uploaded_by_staff_id,
        &warning_summary,
    )
    .await?;

    let mut inserted_snapshot_count = 0usize;
    for account in &parsed.accounts {
        insert_account_snapshot(&mut tx, batch.id, account).await?;
        inserted_snapshot_count += 1;
    }
    match_account_snapshots_by_unique_phone(&mut tx, batch.id).await?;

    tx.commit()
        .await
        .map_err(|error| AccountListPreviewError::Workbook(error.to_string()))?;

    Ok(AccountListImportResponse {
        batch,
        inserted_snapshot_count,
        warning_count: parsed.warning_count,
        data_quality: parsed.data_quality,
    })
}

pub async fn latest_account_list_import(
    pool: &PgPool,
) -> Result<AccountListLatestImportResponse, sqlx::Error> {
    let latest = sqlx::query_as::<_, AccountListBatchSummary>(
        r#"
        SELECT
            id,
            source_filename,
            source_file_hash,
            institution_name,
            merchant_name,
            report_run_at,
            uploaded_by_staff_id,
            uploaded_at,
            parsed_account_count,
            footer_account_count,
            total_balance,
            total_minimum_due,
            total_past_due,
            total_open_to_buy,
            warning_summary,
            status,
            created_at
        FROM rms_account_list_import_batches
        WHERE status = 'imported'
        ORDER BY uploaded_at DESC, created_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    let Some(batch) = latest else {
        return Ok(AccountListLatestImportResponse {
            latest: None,
            stale: true,
            stale_after_days: RMS_ACCOUNT_LIST_FRESH_DAYS,
            matched_count: 0,
            unmatched_count: 0,
        });
    };

    let (matched_count, unmatched_count): (i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE matched_customer_id IS NOT NULL OR match_status = 'matched')::bigint,
            COUNT(*) FILTER (WHERE matched_customer_id IS NULL AND match_status <> 'matched')::bigint
        FROM rms_account_list_snapshots
        WHERE batch_id = $1
        "#,
    )
    .bind(batch.id)
    .fetch_one(pool)
    .await?;

    let stale = batch.uploaded_at < Utc::now() - Duration::days(RMS_ACCOUNT_LIST_FRESH_DAYS);
    Ok(AccountListLatestImportResponse {
        latest: Some(batch),
        stale,
        stale_after_days: RMS_ACCOUNT_LIST_FRESH_DAYS,
        matched_count,
        unmatched_count,
    })
}

async fn match_account_snapshots_by_unique_phone(
    tx: &mut Transaction<'_, Postgres>,
    batch_id: Uuid,
) -> Result<(), AccountListPreviewError> {
    sqlx::query(
        r#"
        WITH customer_phone AS (
            SELECT
                id,
                NULLIF(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), '') AS phone_digits
            FROM customers
        ),
        unique_phone AS (
            SELECT phone_digits, MIN(id) AS customer_id
            FROM customer_phone
            WHERE phone_digits IS NOT NULL
            GROUP BY phone_digits
            HAVING COUNT(*) = 1
        )
        UPDATE rms_account_list_snapshots s
        SET
            matched_customer_id = u.customer_id,
            match_status = 'matched',
            match_confidence = 0.95,
            match_method = 'phone'
        FROM unique_phone u
        WHERE s.batch_id = $1
          AND s.normalized_phone = u.phone_digits
          AND s.matched_customer_id IS NULL
        "#,
    )
    .bind(batch_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| AccountListPreviewError::Workbook(error.to_string()))?;
    Ok(())
}

async fn insert_import_batch(
    tx: &mut Transaction<'_, Postgres>,
    source_filename: &Option<String>,
    source_file_hash: &str,
    parsed: &ParsedAccountListReport,
    report_run_at: Option<DateTime<Utc>>,
    uploaded_by_staff_id: Option<Uuid>,
    warning_summary: &Value,
) -> Result<AccountListBatchSummary, AccountListPreviewError> {
    sqlx::query_as::<_, AccountListBatchSummary>(
        r#"
        INSERT INTO rms_account_list_import_batches (
            source_filename,
            source_file_hash,
            institution_name,
            merchant_name,
            report_run_at,
            uploaded_by_staff_id,
            parsed_account_count,
            footer_account_count,
            total_balance,
            total_minimum_due,
            total_past_due,
            total_open_to_buy,
            warning_summary
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING
            id,
            source_filename,
            source_file_hash,
            institution_name,
            merchant_name,
            report_run_at,
            uploaded_by_staff_id,
            uploaded_at,
            parsed_account_count,
            footer_account_count,
            total_balance,
            total_minimum_due,
            total_past_due,
            total_open_to_buy,
            warning_summary,
            status,
            created_at
        "#,
    )
    .bind(source_filename)
    .bind(source_file_hash)
    .bind(&parsed.metadata.institution_name)
    .bind(&parsed.metadata.merchant_name)
    .bind(report_run_at)
    .bind(uploaded_by_staff_id)
    .bind(parsed.parsed_account_count as i32)
    .bind(parsed.footer_count.map(|value| value as i32))
    .bind(parsed.total_balance)
    .bind(parsed.total_minimum_due)
    .bind(parsed.total_past_due)
    .bind(parsed.total_open_to_buy)
    .bind(warning_summary)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| AccountListPreviewError::Workbook(error.to_string()))
}

async fn insert_account_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    batch_id: Uuid,
    account: &AccountListPreviewAccount,
) -> Result<(), AccountListPreviewError> {
    let parser_warnings = json!(account.parser_warnings);
    let payment_history = if account.payment_history_codes.is_empty() {
        None
    } else {
        Some(account.payment_history_codes.join(","))
    };
    let business_name = business_name_candidate(&account.name);

    sqlx::query(
        r#"
        INSERT INTO rms_account_list_snapshots (
            batch_id,
            account_number,
            account_year,
            customer_name,
            business_name,
            address_line,
            city,
            state,
            postal_code,
            phone,
            normalized_phone,
            high_balance,
            previous_balance,
            payments,
            returns_amount,
            charges,
            finance_charge,
            balance,
            minimum_due,
            past_due,
            aging_30,
            aging_60,
            aging_90,
            open_to_buy,
            payment_history,
            raw_payload,
            parser_warnings
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27
        )
        "#,
    )
    .bind(batch_id)
    .bind(&account.account_number)
    .bind(&account.account_year)
    .bind(&account.name)
    .bind(&business_name)
    .bind(&account.address)
    .bind(&account.city)
    .bind(&account.state)
    .bind(&account.zip)
    .bind(&account.phone)
    .bind(&account.normalized_phone)
    .bind(account.high_balance)
    .bind(account.previous_balance)
    .bind(account.payments)
    .bind(account.returns)
    .bind(account.charges)
    .bind(account.finance_charge)
    .bind(account.balance)
    .bind(account.minimum_due)
    .bind(account.past_due)
    .bind(account.aging_30)
    .bind(account.aging_60)
    .bind(account.aging_90_plus)
    .bind(account.open_to_buy)
    .bind(payment_history)
    .bind(&account.raw_payload)
    .bind(parser_warnings)
    .execute(&mut **tx)
    .await
    .map_err(|error| AccountListPreviewError::Workbook(error.to_string()))?;
    Ok(())
}

fn report_run_at_as_utc(value: NaiveDateTime) -> DateTime<Utc> {
    DateTime::<Utc>::from_naive_utc_and_offset(value, Utc)
}

pub fn normalize_phone(value: Option<&str>) -> Option<String> {
    let mut digits: String = value
        .unwrap_or("")
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect();
    if digits.len() == 11 && digits.starts_with('1') {
        digits.remove(0);
    }
    if digits.len() == 10 {
        Some(digits)
    } else {
        None
    }
}

pub fn normalize_zip(value: Option<&str>) -> Option<String> {
    let digits: String = value
        .unwrap_or("")
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect();
    if digits.len() >= 5 {
        Some(digits[..5].to_string())
    } else {
        let trimmed = value.unwrap_or("").trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

fn join_name_parts(left: Option<String>, right: Option<String>) -> String {
    [left, right]
        .into_iter()
        .flatten()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_report_run_timestamp(value: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value.trim(), "%m/%d/%Y %H:%M:%S").ok()
}

fn is_account_number(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit())
}

fn payment_history_codes(range: &calamine::Range<Data>, row: usize) -> Vec<String> {
    (3..=6)
        .filter_map(|col| text_at(range, row, col))
        .filter(|value| !value.trim().is_empty())
        .collect()
}

fn raw_account_payload(range: &calamine::Range<Data>, start_row: usize) -> Value {
    let rows: Vec<Value> = (0..ACCOUNT_BLOCK_ROWS)
        .map(|offset| {
            let row = start_row + offset;
            let cells: Vec<Value> = (0..14)
                .map(|col| {
                    json!({
                        "column": col + 1,
                        "value": text_at(range, row, col),
                    })
                })
                .collect();
            json!({
                "row_number": row + 1,
                "cells": cells,
            })
        })
        .collect();
    json!({
        "start_row_number": start_row + 1,
        "block_row_count": ACCOUNT_BLOCK_ROWS,
        "rows": rows,
    })
}

fn business_name_candidate(name: &str) -> Option<String> {
    let upper = name.to_ascii_uppercase();
    let business_terms = [
        " INC",
        " LLC",
        " CO",
        " COMPANY",
        " CORP",
        " CHURCH",
        " CLUB",
        " SHOP",
        " FUNERAL",
        " CONTRACT",
        " ASSOCIATION",
    ];
    if business_terms.iter().any(|term| upper.contains(term)) {
        Some(name.trim().to_string())
    } else {
        None
    }
}

fn text_at(range: &calamine::Range<Data>, row: usize, col: usize) -> Option<String> {
    match range.get((row, col)) {
        Some(Data::String(value)) => normalized_text(value),
        Some(Data::Float(value)) => {
            if value.fract() == 0.0 {
                Some(format!("{value:.0}"))
            } else {
                Some(value.to_string())
            }
        }
        Some(Data::Int(value)) => Some(value.to_string()),
        Some(Data::Bool(value)) => Some(value.to_string()),
        Some(Data::DateTimeIso(value)) => normalized_text(value),
        Some(Data::DurationIso(value)) => normalized_text(value),
        Some(Data::DateTime(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn normalized_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn decimal_at(range: &calamine::Range<Data>, row: usize, col: usize) -> Decimal {
    decimal_at_optional(range, row, col).unwrap_or(Decimal::ZERO)
}

fn decimal_at_optional(range: &calamine::Range<Data>, row: usize, col: usize) -> Option<Decimal> {
    match range.get((row, col)) {
        Some(Data::Float(value)) => Decimal::from_f64_retain(*value).map(|value| value.round_dp(2)),
        Some(Data::Int(value)) => Some(Decimal::from(*value)),
        Some(Data::String(value)) => parse_decimal(value),
        _ => None,
    }
}

fn parse_decimal(value: &str) -> Option<Decimal> {
    let cleaned = value
        .trim()
        .replace(['$', ','], "")
        .replace('(', "-")
        .replace(')', "");
    if cleaned.is_empty() {
        None
    } else {
        Decimal::from_str_exact(&cleaned)
            .ok()
            .map(|value| value.round_dp(2))
    }
}

fn sum_decimal(
    accounts: &[AccountListPreviewAccount],
    f: impl Fn(&AccountListPreviewAccount) -> Decimal,
) -> Decimal {
    accounts
        .iter()
        .fold(Decimal::ZERO, |acc, account| acc + f(account))
        .round_dp(2)
}

fn compare_footer_total(
    label: &str,
    parsed: Decimal,
    footer: Option<Decimal>,
    warnings: &mut Vec<String>,
) {
    let Some(footer) = footer else {
        warnings.push(format!("Footer {label} total was not found."));
        return;
    };
    if (parsed - footer).abs() > Decimal::new(FOOTER_TOTAL_TOLERANCE_CENTS, 2) {
        warnings.push(format!(
            "Parsed {label} total {parsed} does not match footer total {footer}."
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_phone_numbers() {
        assert_eq!(
            normalize_phone(Some("(716) 555-1212")),
            Some("7165551212".to_string())
        );
        assert_eq!(
            normalize_phone(Some("1-716-555-1212")),
            Some("7165551212".to_string())
        );
        assert_eq!(normalize_phone(Some("716-")), None);
    }

    #[test]
    fn parses_uploaded_account_list_fixture_when_available() {
        let paths = [
            ("/Volumes/NO NAME/AccountListReportData.xlsx", true),
            ("/Users/cpg/riverside-os/AccountListReportData.xlsx", false),
        ];
        let mut bytes_opt = None;
        let mut check_assertions = false;
        for (path, should_assert) in paths {
            if let Ok(bytes) = std::fs::read(path) {
                bytes_opt = Some(bytes);
                check_assertions = should_assert;
                break;
            }
        }
        let Some(bytes) = bytes_opt else {
            eprintln!("skipping local AccountListReportData.xlsx fixture test; file not found");
            return;
        };
        let preview =
            preview_account_list_xlsx(&bytes).expect("parse uploaded account list report");
        if check_assertions {
            assert_eq!(preview.parsed_account_count, 1_976);
            assert_eq!(preview.footer_count, Some(1_976));
            assert_eq!(preview.total_balance, Decimal::new(1_990_400, 2));
            assert_eq!(preview.total_minimum_due, Decimal::new(1_062_986, 2));
            assert_eq!(preview.total_past_due, Decimal::new(8_605, 2));
            assert_eq!(preview.total_open_to_buy, Decimal::new(294_981_180, 2));
            assert_eq!(preview.data_quality.duplicate_account_number_count, 0);
        } else {
            println!(
                "Successfully parsed {} accounts from weekly excel report!",
                preview.parsed_account_count
            );
            println!("Report title: {:?}", preview.metadata.report_title);
            println!("Total balance: {}", preview.total_balance);
        }
    }
}
