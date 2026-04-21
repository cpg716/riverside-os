//! RMS / RMS90 register tenders + R2S payment collection: durable rows and Sales Support follow-up.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool, Postgres};
use uuid::Uuid;

pub const RMS_TENDER_FAMILY: &str = "rms_charge";

#[derive(Debug, Clone)]
pub struct RmsChargeNotify {
    pub payment_transaction_id: Uuid,
    pub amount: Decimal,
    pub method: String,
    pub metadata: Value,
}

pub fn is_rms_method(method: &str) -> bool {
    let m = method.trim().to_ascii_lowercase();
    m == "on_account_rms" || m == "on_account_rms90"
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RmsChargeSelectionMetadata {
    pub tender_family: String,
    pub program_code: Option<String>,
    pub program_label: Option<String>,
    pub masked_account: Option<String>,
    pub linked_corecredit_customer_id: Option<String>,
    pub linked_corecredit_account_id: Option<String>,
    pub linked_corecredit_card_id: Option<String>,
    pub resolution_status: Option<String>,
    pub metadata_json: Value,
}

fn clean_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn extract_selection_from_metadata(metadata: &Value) -> Option<RmsChargeSelectionMetadata> {
    let family = clean_text(metadata.get("tender_family")).or_else(|| {
        if metadata.get("program_code").is_some()
            || metadata.get("program_label").is_some()
            || metadata.get("linked_corecredit_account_id").is_some()
        {
            Some(RMS_TENDER_FAMILY.to_string())
        } else {
            None
        }
    })?;

    Some(RmsChargeSelectionMetadata {
        tender_family: family,
        program_code: clean_text(metadata.get("program_code")),
        program_label: clean_text(metadata.get("program_label")),
        masked_account: clean_text(metadata.get("masked_account")),
        linked_corecredit_customer_id: clean_text(metadata.get("linked_corecredit_customer_id")),
        linked_corecredit_account_id: clean_text(metadata.get("linked_corecredit_account_id")),
        linked_corecredit_card_id: clean_text(metadata.get("linked_corecredit_card_id")),
        resolution_status: clean_text(metadata.get("resolution_status")),
        metadata_json: metadata.clone(),
    })
}

pub fn normalized_rms_metadata(method: &str, metadata: &Value) -> Value {
    if !is_rms_method(method) {
        return metadata.clone();
    }

    let mut obj = metadata.as_object().cloned().unwrap_or_default();
    obj.entry("tender_family".to_string())
        .or_insert_with(|| Value::String(RMS_TENDER_FAMILY.to_string()));

    if !obj.contains_key("program_code") {
        let code = if method.eq_ignore_ascii_case("on_account_rms90") {
            "rms90"
        } else {
            "standard"
        };
        obj.insert("program_code".to_string(), Value::String(code.to_string()));
    }
    if !obj.contains_key("program_label") {
        let label = if method.eq_ignore_ascii_case("on_account_rms90") {
            "RMS 90"
        } else {
            "Standard"
        };
        obj.insert(
            "program_label".to_string(),
            Value::String(label.to_string()),
        );
    }
    if !obj.contains_key("resolution_status") {
        obj.insert(
            "resolution_status".to_string(),
            Value::String("selected".to_string()),
        );
    }

    Value::Object(obj)
}

pub fn transaction_metadata_from_splits<'a, I>(splits: I) -> Value
where
    I: IntoIterator<Item = (&'a str, &'a Value)>,
{
    for (method, metadata) in splits {
        let normalized = if is_rms_method(method) {
            normalized_rms_metadata(method, metadata)
        } else {
            metadata.clone()
        };

        if is_rms_method(method) {
            if let Some(selection) = extract_selection_from_metadata(&normalized) {
                return json!({
                    "financing_tender": "RMS Charge",
                    "rms_charge": {
                        "tender_family": selection.tender_family,
                        "program_code": selection.program_code,
                        "program_label": selection.program_label,
                        "masked_account": selection.masked_account,
                        "linked_corecredit_customer_id": selection.linked_corecredit_customer_id,
                        "linked_corecredit_account_id": selection.linked_corecredit_account_id,
                        "linked_corecredit_card_id": selection.linked_corecredit_card_id,
                        "resolution_status": selection.resolution_status,
                        "posting_status": clean_text(normalized.get("posting_status")),
                        "external_transaction_id": clean_text(normalized.get("external_transaction_id")),
                        "host_reference": clean_text(normalized.get("host_reference")),
                    }
                });
            }
        }

        if normalized
            .get("rms_charge_collection")
            .and_then(Value::as_bool)
            == Some(true)
        {
            return json!({
                "rms_charge_payment_collection": {
                    "tender_family": clean_text(normalized.get("tender_family")).unwrap_or_else(|| RMS_TENDER_FAMILY.to_string()),
                    "masked_account": clean_text(normalized.get("masked_account")),
                    "linked_corecredit_customer_id": clean_text(normalized.get("linked_corecredit_customer_id")),
                    "linked_corecredit_account_id": clean_text(normalized.get("linked_corecredit_account_id")),
                    "resolution_status": clean_text(normalized.get("resolution_status")),
                    "posting_status": clean_text(normalized.get("posting_status")),
                    "external_transaction_id": clean_text(normalized.get("external_transaction_id")),
                    "host_reference": clean_text(normalized.get("host_reference")),
                }
            });
        }
    }
    json!({})
}

pub fn display_program_label(method: &str, metadata: Option<&Value>) -> Option<String> {
    clean_text(metadata.and_then(|value| value.get("program_label"))).or_else(|| {
        if method.eq_ignore_ascii_case("on_account_rms90") {
            Some("RMS 90".to_string())
        } else if method.eq_ignore_ascii_case("on_account_rms") {
            Some("Standard".to_string())
        } else {
            None
        }
    })
}

pub fn payment_method_summary(
    method: &str,
    check_number: Option<&str>,
    metadata: Option<&Value>,
) -> String {
    let trimmed_method = method.trim();
    if is_rms_method(trimmed_method) {
        let mut parts = vec!["RMS Charge".to_string()];
        if let Some(program) = display_program_label(trimmed_method, metadata) {
            parts.push(format!("Program: {program}"));
        }
        if let Some(masked_account) =
            clean_text(metadata.and_then(|value| value.get("masked_account")))
        {
            parts.push(format!("Account: {masked_account}"));
        }
        if let Some(reference) = clean_text(
            metadata
                .and_then(|value| value.get("host_reference"))
                .or_else(|| metadata.and_then(|value| value.get("external_transaction_id"))),
        ) {
            parts.push(format!("Ref: {reference}"));
        }
        return parts.join(" | ");
    }

    if trimmed_method.eq_ignore_ascii_case("card_terminal") {
        return "Stripe Card".to_string();
    }
    if trimmed_method.eq_ignore_ascii_case("card_manual") {
        return "Stripe Manual".to_string();
    }
    if trimmed_method.eq_ignore_ascii_case("card_saved") {
        return "Stripe Vault".to_string();
    }
    if trimmed_method.eq_ignore_ascii_case("card_credit") {
        return "Stripe Credit".to_string();
    }
    if trimmed_method.eq_ignore_ascii_case("gift_card") {
        return "Gift Card".to_string();
    }
    if trimmed_method.eq_ignore_ascii_case("store_credit") {
        return "Store Credit".to_string();
    }
    if trimmed_method.eq_ignore_ascii_case("cash") {
        let mut label = "Cash".to_string();
        if metadata
            .and_then(|value| value.get("rms_charge_collection"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            if let Some(reference) = clean_text(
                metadata
                    .and_then(|value| value.get("host_reference"))
                    .or_else(|| metadata.and_then(|value| value.get("external_transaction_id"))),
            ) {
                label.push_str(&format!(" | RMS Ref: {reference}"));
            }
        }
        return label;
    }
    if trimmed_method.eq_ignore_ascii_case("check") {
        let clean_check = check_number
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut label = match clean_check {
            Some(number) => format!("Check (#{number})"),
            None => "Check".to_string(),
        };
        if metadata
            .and_then(|value| value.get("rms_charge_collection"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            if let Some(reference) = clean_text(
                metadata
                    .and_then(|value| value.get("host_reference"))
                    .or_else(|| metadata.and_then(|value| value.get("external_transaction_id"))),
            ) {
                label.push_str(&format!(" | RMS Ref: {reference}"));
            }
        };
        return label;
    }

    trimmed_method.to_string()
}

pub fn transaction_compact_ref(transaction_id: Uuid) -> String {
    transaction_id
        .as_simple()
        .to_string()
        .chars()
        .take(12)
        .collect()
}

pub async fn update_record_host_result<'e, E>(
    ex: E,
    record_id: Uuid,
    metadata: &Value,
) -> Result<(), sqlx::Error>
where
    E: Executor<'e, Database = Postgres>,
{
    sqlx::query(
        r#"
        UPDATE pos_rms_charge_record
        SET
            external_transaction_id = COALESCE($2, external_transaction_id),
            external_auth_code = COALESCE($3, external_auth_code),
            posting_status = COALESCE($4, posting_status),
            posting_error_code = COALESCE($5, posting_error_code),
            posting_error_message = COALESCE($6, posting_error_message),
            posted_at = COALESCE($7, posted_at),
            reversed_at = COALESCE($8, reversed_at),
            refunded_at = COALESCE($9, refunded_at),
            idempotency_key = COALESCE($10, idempotency_key),
            external_transaction_type = COALESCE($11, external_transaction_type),
            host_reference = COALESCE($12, host_reference),
            host_metadata_json = COALESCE($13, host_metadata_json),
            request_snapshot_json = COALESCE($14, request_snapshot_json),
            response_snapshot_json = COALESCE($15, response_snapshot_json),
            metadata_json = COALESCE($16, metadata_json)
        WHERE id = $1
        "#,
    )
    .bind(record_id)
    .bind(clean_text(metadata.get("external_transaction_id")))
    .bind(clean_text(metadata.get("external_auth_code")))
    .bind(clean_text(metadata.get("posting_status")))
    .bind(clean_text(metadata.get("posting_error_code")))
    .bind(clean_text(metadata.get("posting_error_message")))
    .bind(
        clean_text(metadata.get("posted_at"))
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&chrono::Utc)),
    )
    .bind(
        clean_text(metadata.get("reversed_at"))
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&chrono::Utc)),
    )
    .bind(
        clean_text(metadata.get("refunded_at"))
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&chrono::Utc)),
    )
    .bind(clean_text(metadata.get("idempotency_key")))
    .bind(clean_text(metadata.get("external_transaction_type")))
    .bind(clean_text(metadata.get("host_reference")))
    .bind(metadata.get("host_metadata").cloned())
    .bind(metadata.get("request_snapshot").cloned())
    .bind(metadata.get("response_snapshot").cloned())
    .bind(Some(metadata.clone()))
    .execute(ex)
    .await?;
    Ok(())
}

/// `record_kind`: `charge` (sale tender) or `payment` (cash/check R2S collection).
#[allow(clippy::too_many_arguments)]
pub async fn insert_rms_record<'e, E>(
    ex: E,
    record_kind: &str,
    transaction_id: Uuid,
    register_session_id: Uuid,
    customer_id: Option<Uuid>,
    payment_method: &str,
    amount: Decimal,
    operator_staff_id: Uuid,
    payment_transaction_id: Uuid,
    customer_display: Option<&str>,
    order_short_ref: &str,
    metadata: Option<&Value>,
) -> Result<Uuid, sqlx::Error>
where
    E: Executor<'e, Database = Postgres>,
{
    let metadata_json = metadata.cloned().unwrap_or_else(|| json!({}));
    let selection = extract_selection_from_metadata(&metadata_json);
    let tender_family = selection.as_ref().map(|value| value.tender_family.clone());
    let program_code = selection
        .as_ref()
        .and_then(|value| value.program_code.clone());
    let program_label = selection
        .as_ref()
        .and_then(|value| value.program_label.clone());
    let masked_account = selection
        .as_ref()
        .and_then(|value| value.masked_account.clone());
    let linked_corecredit_customer_id = selection
        .as_ref()
        .and_then(|value| value.linked_corecredit_customer_id.clone());
    let linked_corecredit_account_id = selection
        .as_ref()
        .and_then(|value| value.linked_corecredit_account_id.clone());
    let resolution_status = selection
        .as_ref()
        .and_then(|value| value.resolution_status.clone());
    let record_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO pos_rms_charge_record (
            transaction_id, register_session_id, customer_id, payment_method, amount,
            operator_staff_id, payment_transaction_id, customer_display, order_short_ref,
            record_kind, tender_family, program_code, program_label, masked_account,
            linked_corecredit_customer_id, linked_corecredit_account_id, resolution_status,
            metadata_json, external_transaction_id, external_auth_code, posting_status,
            posting_error_code, posting_error_message, posted_at, reversed_at, refunded_at,
            idempotency_key, external_transaction_type, host_reference, host_metadata_json,
            request_snapshot_json, response_snapshot_json
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26,
            $27, $28, $29, $30, $31, $32
        )
        RETURNING id
        "#,
    )
    .bind(transaction_id)
    .bind(register_session_id)
    .bind(customer_id)
    .bind(payment_method)
    .bind(amount)
    .bind(operator_staff_id)
    .bind(payment_transaction_id)
    .bind(customer_display)
    .bind(order_short_ref)
    .bind(record_kind)
    .bind(tender_family)
    .bind(program_code)
    .bind(program_label)
    .bind(masked_account)
    .bind(linked_corecredit_customer_id)
    .bind(linked_corecredit_account_id)
    .bind(resolution_status)
    .bind(metadata_json.clone())
    .bind(clean_text(metadata_json.get("external_transaction_id")))
    .bind(clean_text(metadata_json.get("external_auth_code")))
    .bind(clean_text(metadata_json.get("posting_status")).unwrap_or_else(|| "legacy".to_string()))
    .bind(clean_text(metadata_json.get("posting_error_code")))
    .bind(clean_text(metadata_json.get("posting_error_message")))
    .bind(
        clean_text(metadata_json.get("posted_at"))
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&chrono::Utc)),
    )
    .bind(
        clean_text(metadata_json.get("reversed_at"))
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&chrono::Utc)),
    )
    .bind(
        clean_text(metadata_json.get("refunded_at"))
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&chrono::Utc)),
    )
    .bind(clean_text(metadata_json.get("idempotency_key")))
    .bind(clean_text(metadata_json.get("external_transaction_type")))
    .bind(clean_text(metadata_json.get("host_reference")))
    .bind(
        metadata_json
            .get("host_metadata")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .bind(
        metadata_json
            .get("request_snapshot")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .bind(
        metadata_json
            .get("response_snapshot")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .fetch_one(ex)
    .await?;
    Ok(record_id)
}

/// Fan-out one inbox notification per Sales Support staff member per RMS split (deduped per payment tx).
#[allow(clippy::too_many_arguments)]
pub async fn notify_sales_support_after_checkout(
    pool: &PgPool,
    transaction_id: Uuid,
    register_session_id: Uuid,
    customer_id: Option<Uuid>,
    customer_display: Option<&str>,
    order_short_ref: &str,
    operator_staff_id: Uuid,
    charges: &[RmsChargeNotify],
) -> Result<(), sqlx::Error> {
    if charges.is_empty() {
        return Ok(());
    }

    let staff_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM staff
        WHERE is_active = TRUE AND role = 'sales_support'::staff_role
        "#,
    )
    .fetch_all(pool)
    .await?;

    if staff_ids.is_empty() {
        tracing::warn!("no active sales_support staff for RMS charge notifications");
        return Ok(());
    }

    let cust_label = customer_display
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Walk-in / no customer".to_string());

    for c in charges {
        let method_label = display_program_label(&c.method, Some(&c.metadata))
            .map(|label| format!("RMS Charge ({label})"))
            .unwrap_or_else(|| "RMS Charge".to_string());
        let body = format!(
            "Submit R2S charge in portal. Order ref: {}. Method: {}. Amount: ${}. Customer: {}. Transaction: {}.",
            order_short_ref,
            method_label,
            c.amount,
            cust_label,
            c.payment_transaction_id
        );
        let deep = json!({
            "kind": "rms_r2s_charge",
            "transaction_id": transaction_id,
            "register_session_id": register_session_id,
            "customer_id": customer_id,
            "payment_transaction_id": c.payment_transaction_id,
            "payment_method": c.method,
            "amount": c.amount.to_string(),
            "program_label": clean_text(c.metadata.get("program_label")),
            "masked_account": clean_text(c.metadata.get("masked_account")),
            "posting_status": clean_text(c.metadata.get("posting_status")),
            "host_reference": clean_text(c.metadata.get("host_reference")),
        });
        let dedupe = format!("rms_r2s:{}:{}", transaction_id, c.payment_transaction_id);
        let audience = json!({ "roles": ["sales_support"] });

        let nid = match crate::logic::notifications::insert_app_notification_deduped(
            pool,
            "rms_r2s_charge",
            "Submit R2S charge",
            &body,
            deep,
            "pos_checkout",
            audience,
            Some(&dedupe),
        )
        .await?
        {
            Some(id) => id,
            None => continue,
        };

        crate::logic::notifications::fan_out_to_staff_ids(pool, nid, &staff_ids).await?;
    }

    let _ = crate::auth::pins::log_staff_access(
        pool,
        operator_staff_id,
        "rms_charge_notified",
        json!({
            "transaction_id": transaction_id,
            "register_session_id": register_session_id,
            "charge_count": charges.len(),
        }),
    )
    .await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_summary_prefers_metadata_program_and_masked_account() {
        let summary = payment_method_summary(
            "on_account_rms",
            None,
            Some(&json!({
                "tender_family": "rms_charge",
                "program_label": "RMS 90",
                "masked_account": "••••4455"
            })),
        );
        assert_eq!(summary, "RMS Charge | Program: RMS 90 | Account: ••••4455");
    }

    #[test]
    fn transaction_metadata_extracts_rms_selection() {
        let metadata = transaction_metadata_from_splits([(
            "on_account_rms",
            &json!({
                "program_code": "rms90",
                "program_label": "RMS 90",
                "masked_account": "••••4455",
                "linked_corecredit_customer_id": "cust-1",
                "linked_corecredit_account_id": "acct-2",
                "resolution_status": "selected"
            }),
        )]);
        assert_eq!(
            metadata
                .get("rms_charge")
                .and_then(|value| value.get("program_code"))
                .and_then(Value::as_str),
            Some("rms90")
        );
    }

    #[test]
    fn payment_summary_includes_rms_collection_reference() {
        let summary = payment_method_summary(
            "cash",
            None,
            Some(&json!({
                "rms_charge_collection": true,
                "masked_account": "••••4455",
                "host_reference": "REF-22"
            })),
        );
        assert_eq!(summary, "Cash | RMS Ref: REF-22");
    }
}
