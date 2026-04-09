//! Lightspeed X-Series customer CSV import (upsert on `customer_code`).

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

type AddressLinesTuple = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Debug, Error)]
pub enum LightspeedCustomerImportError {
    #[error("invalid import payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct LightspeedCustomerImportIssue {
    /// 1-based row index in the uploaded payload (matches spreadsheet line after header).
    pub row_index: i32,
    pub customer_code: Option<String>,
    /// Machine-readable code: `missing_customer_code`, `email_conflict`, etc.
    pub issue: String,
}

#[derive(Debug, Serialize)]
pub struct LightspeedCustomerImportSummary {
    pub created: i32,
    pub updated: i32,
    pub skipped: i32,
    pub email_conflicts: i32,
    #[serde(default)]
    pub issues: Vec<LightspeedCustomerImportIssue>,
}

#[derive(Debug, Deserialize)]
pub struct LightspeedCustomerImportPayload {
    pub rows: Vec<HashMap<String, String>>,
}

fn trim_cell(row: &HashMap<String, String>, key: &str) -> Option<String> {
    row.get(key).map(|s| s.trim()).and_then(|s| {
        if s.is_empty() || s == "\" \"" || s == "\"" {
            None
        } else {
            Some(s.to_string())
        }
    })
}

fn parse_bool01(s: &str) -> bool {
    matches!(s.trim(), "1" | "true" | "TRUE" | "yes" | "Yes")
}

fn parse_dob(raw: &str) -> Option<NaiveDate> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .ok()
        .or_else(|| NaiveDate::parse_from_str(t, "%m/%d/%Y").ok())
        .or_else(|| NaiveDate::parse_from_str(t, "%m-%d-%Y").ok())
        .or_else(|| NaiveDate::parse_from_str(t, "%d-%m-%Y").ok())
}

fn pick_phone(row: &HashMap<String, String>) -> Option<String> {
    trim_cell(row, "mobile_number").or_else(|| trim_cell(row, "phone_number"))
}

fn pick_address_shipping_first(row: &HashMap<String, String>) -> AddressLinesTuple {
    let line1 = trim_cell(row, "shipping_address_street_address")
        .or_else(|| trim_cell(row, "billing_address_street_address"));
    let line2 = trim_cell(row, "shipping_address_apt_suite_etc.")
        .or_else(|| trim_cell(row, "billing_address_apt_suite_etc."));
    let city =
        trim_cell(row, "shipping_address_city").or_else(|| trim_cell(row, "billing_address_city"));
    let state = trim_cell(row, "shipping_address_province_state")
        .or_else(|| trim_cell(row, "billing_address_province_state"));
    let postal = trim_cell(row, "shipping_address_postcode_zip_code")
        .or_else(|| trim_cell(row, "billing_address_postcode_zip_code"));
    (line1, line2, city, state, postal)
}

fn resolve_names(row: &HashMap<String, String>, code: &str) -> (String, String, Option<String>) {
    let company = trim_cell(row, "company_name");
    let mut first = trim_cell(row, "first_name").unwrap_or_default();
    let mut last = trim_cell(row, "last_name").unwrap_or_default();
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

async fn upsert_row(
    tx: &mut Transaction<'_, Postgres>,
    row: &HashMap<String, String>,
    row_index: i32,
    summary: &mut LightspeedCustomerImportSummary,
) -> Result<(), sqlx::Error> {
    let code = match trim_cell(row, "customer_code") {
        Some(c) => c,
        None => {
            summary.skipped += 1;
            summary.issues.push(LightspeedCustomerImportIssue {
                row_index,
                customer_code: None,
                issue: "missing_customer_code".to_string(),
            });
            return Ok(());
        }
    };

    let (first_name, last_name, company_name) = resolve_names(row, &code);
    let email_raw = trim_cell(row, "email").map(|e| e.to_lowercase());
    let phone = pick_phone(row);
    let (address_line1, address_line2, city, state, postal_code) = pick_address_shipping_first(row);

    let dob = row
        .get("date_of_birth")
        .map(|s| s.as_str())
        .and_then(parse_dob);

    let cf1 = trim_cell(row, "custom_field_1");
    let cf2 = trim_cell(row, "custom_field_2");
    let cf3 = trim_cell(row, "custom_field_3");
    let cf4 = trim_cell(row, "custom_field_4");

    let m_email = row
        .get("enable_promotional_emails")
        .map(|s| parse_bool01(s))
        .unwrap_or(false);
    let m_sms = row
        .get("enable_promotional_sms")
        .map(|s| parse_bool01(s))
        .unwrap_or(false);

    let existing_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
            .bind(&code)
            .fetch_optional(&mut **tx)
            .await?;

    let mut email_to_set = email_raw.clone();
    if let Some(ref em) = email_to_set {
        if email_taken_by_other(tx, em, existing_id).await? {
            email_to_set = None;
            summary.email_conflicts += 1;
            summary.issues.push(LightspeedCustomerImportIssue {
                row_index,
                customer_code: Some(code.clone()),
                issue: "email_conflict".to_string(),
            });
        }
    }

    let notes = trim_cell(row, "notes");

    if let Some(id) = existing_id {
        sqlx::query(
            r#"
            UPDATE customers SET
                first_name = $2, last_name = $3, company_name = $4,
                email = COALESCE($5, email),
                phone = $6,
                address_line1 = $7, address_line2 = $8, city = $9, state = $10, postal_code = $11,
                date_of_birth = $12, anniversary_date = $13,
                custom_field_1 = $14, custom_field_2 = $15, custom_field_3 = $16, custom_field_4 = $17,
                marketing_email_opt_in = $18, marketing_sms_opt_in = $19,
                transactional_sms_opt_in = $20,
                transactional_email_opt_in = $21
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
        .bind(None::<NaiveDate>)
        .bind(&cf1)
        .bind(&cf2)
        .bind(&cf3)
        .bind(&cf4)
        .bind(m_email)
        .bind(m_sms)
        .bind(m_sms)
        .bind(m_email)
        .execute(&mut **tx)
        .await?;
        summary.updated += 1;
        if let Some(body) = notes {
            let _ = sqlx::query(
                r#"INSERT INTO customer_timeline_notes (customer_id, body, created_by)
                   SELECT $1, $2, NULL
                   WHERE NOT EXISTS (
                     SELECT 1 FROM customer_timeline_notes
                     WHERE customer_id = $1 AND body = $2
                   )"#,
            )
            .bind(id)
            .bind(format!("Lightspeed import note: {body}"))
            .execute(&mut **tx)
            .await;
        }
    } else {
        let new_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO customers (
                customer_code, first_name, last_name, company_name,
                email, phone,
                address_line1, address_line2, city, state, postal_code,
                date_of_birth, anniversary_date,
                custom_field_1, custom_field_2, custom_field_3, custom_field_4,
                marketing_email_opt_in, marketing_sms_opt_in, transactional_sms_opt_in,
                transactional_email_opt_in
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
            RETURNING id
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
        .bind(None::<NaiveDate>)
        .bind(&cf1)
        .bind(&cf2)
        .bind(&cf3)
        .bind(&cf4)
        .bind(m_email)
        .bind(m_sms)
        .bind(m_sms)
        .bind(m_email)
        .fetch_one(&mut **tx)
        .await?;

        summary.created += 1;
        if let Some(body) = notes {
            sqlx::query(
                r#"INSERT INTO customer_timeline_notes (customer_id, body, created_by)
                   VALUES ($1, $2, NULL)"#,
            )
            .bind(new_id)
            .bind(format!("Lightspeed import note: {body}"))
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(())
}

pub async fn execute_lightspeed_customer_import(
    pool: &PgPool,
    payload: LightspeedCustomerImportPayload,
) -> Result<LightspeedCustomerImportSummary, LightspeedCustomerImportError> {
    if payload.rows.is_empty() {
        return Err(LightspeedCustomerImportError::InvalidPayload(
            "at least one CSV row is required".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = LightspeedCustomerImportSummary {
        created: 0,
        updated: 0,
        skipped: 0,
        email_conflicts: 0,
        issues: Vec::new(),
    };

    for (idx, row) in payload.rows.iter().enumerate() {
        upsert_row(&mut tx, row, (idx + 1) as i32, &mut summary).await?;
    }

    tx.commit().await?;
    Ok(summary)
}
