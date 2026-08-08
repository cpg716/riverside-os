//! Daily Financial Report API — settings, generate, send, history, test send.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::logic::daily_report::{self, DailyReportConfig};
use crate::logic::email;
use crate::middleware::require_staff_with_permission;

const SETTINGS_ADMIN: &str = "settings.admin";

#[derive(Debug, Error)]
pub enum DailyReportError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Not found")]
    NotFound,
    #[error("Forbidden")]
    Forbidden,
}

impl IntoResponse for DailyReportError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            DailyReportError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m.clone()),
            DailyReportError::NotFound => (StatusCode::NOT_FOUND, "Not found".to_string()),
            DailyReportError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".to_string()),
            DailyReportError::Database(e) => {
                tracing::error!(error = %e, "DailyReport DB error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/config", get(get_config).put(update_config))
        .route("/generate", post(generate_report))
        .route("/send", post(send_report))
        .route("/test-send", post(test_send_report))
        .route("/history", get(list_reports))
        .route("/{id}", get(get_report))
        .route("/{id}/resend", post(resend_report))
}

// ── Config ───────────────────────────────────────────────────────────────────

async fn get_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DailyReportConfig>, DailyReportError> {
    require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;
    let config = daily_report::load_config(&state.db).await?;
    Ok(Json(config))
}

async fn update_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut body): Json<DailyReportConfig>,
) -> Result<Json<DailyReportConfig>, DailyReportError> {
    require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;
    body.recipient_emails = normalize_recipients(&body.recipient_emails)?;
    body.subject_template = body.subject_template.trim().to_string();
    if body.subject_template.is_empty() {
        return Err(DailyReportError::InvalidPayload(
            "Email subject template is required".to_string(),
        ));
    }
    daily_report::save_config(&state.db, &body).await?;
    Ok(Json(body))
}

// ── Generate ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GenerateRequest {
    date: NaiveDate,
}

async fn generate_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<GenerateRequest>,
) -> Result<Json<serde_json::Value>, DailyReportError> {
    let staff = require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;

    let store_name = get_store_name(&state).await;
    let report = daily_report::generate_report(&state.db, body.date).await?;
    let html = daily_report::render_html(&report, &store_name);
    let id = daily_report::store_report(&state.db, &report, &html, Some(staff.id), false).await?;

    Ok(Json(json!({
        "id": id,
        "report_date": report.report_date,
        "status": "generated"
    })))
}

// ── Send ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SendRequest {
    date: NaiveDate,
}

async fn send_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> Result<Json<serde_json::Value>, DailyReportError> {
    let staff = require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;

    let config = daily_report::load_config(&state.db).await?;
    let configured_recipients = normalize_recipients(&config.recipient_emails)?;
    if configured_recipients.is_empty() {
        return Err(DailyReportError::InvalidPayload(
            "No recipient emails configured".to_string(),
        ));
    }

    let existing_delivery = load_delivery_state(&state.db, body.date).await?;
    if existing_delivery
        .as_ref()
        .is_some_and(|delivery| delivery.sent_at.is_some() && delivery.send_error.is_none())
    {
        return Err(DailyReportError::InvalidPayload(
            "This business date was already sent; use Resend from report history".to_string(),
        ));
    }
    let previously_sent = existing_delivery
        .map(|delivery| delivery.sent_to)
        .unwrap_or_default();
    let recipients = recipients_for_resend(&configured_recipients, &previously_sent, true);
    if recipients.is_empty() {
        return Err(DailyReportError::InvalidPayload(
            "No recipients need delivery".to_string(),
        ));
    }

    let store_name = get_store_name(&state).await;
    let report = daily_report::generate_report(&state.db, body.date).await?;
    let html = daily_report::render_html(&report, &store_name);
    let id = daily_report::store_report(&state.db, &report, &html, Some(staff.id), false).await?;

    let subject = config
        .subject_template
        .replace("{date}", &body.date.to_string());

    let mut successful_recipients: Vec<String> = vec![];
    let mut send_errors: Vec<String> = vec![];
    for recipient in &recipients {
        if let Err(e) = email::send_email(
            &state.db, recipient, &subject, &html, None, None, "outbound",
        )
        .await
        {
            tracing::error!(error = %e, "Failed to send daily report to {}", recipient);
            send_errors.push(format!("{recipient}: {e}"));
        } else {
            successful_recipients.push(recipient.clone());
        }
    }

    let error_msg = if send_errors.is_empty() {
        None
    } else {
        Some(send_errors.join("; "))
    };

    daily_report::record_delivery_result(
        &state.db,
        id,
        &successful_recipients,
        error_msg.as_deref(),
    )
    .await?;

    Ok(Json(json!({
        "id": id,
        "report_date": report.report_date,
        "sent_to": successful_recipients,
        "errors": error_msg,
        "status": if error_msg.is_some() { "partial_failure" } else { "sent" }
    })))
}

// ── Test Send ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TestSendRequest {
    #[serde(default)]
    email_override: Option<String>,
}

async fn test_send_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<TestSendRequest>,
) -> Result<Json<serde_json::Value>, DailyReportError> {
    let staff = require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;

    let config = daily_report::load_config(&state.db).await?;
    let recipients = if let Some(ref override_email) = body.email_override {
        normalize_recipients(std::slice::from_ref(override_email))?
    } else if !config.recipient_emails.is_empty() {
        normalize_recipients(&config.recipient_emails)?
    } else {
        return Err(DailyReportError::InvalidPayload(
            "No recipient emails configured and no override provided".to_string(),
        ));
    };

    // Use the most recent completed report, or generate for today
    let latest: Option<(Uuid, NaiveDate, String)> = sqlx::query_as(
        r#"
        SELECT id, report_date, html_content
        FROM daily_financial_reports
        WHERE is_test = false AND html_content IS NOT NULL
        ORDER BY report_date DESC, generated_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await?;

    let (report_date, html) = if let Some((_, date, content)) = latest {
        (date, content)
    } else {
        // No previous report — generate for today
        let tz: String = sqlx::query_scalar("SELECT reporting.effective_store_timezone()")
            .fetch_one(&state.db)
            .await?;
        let today = chrono::Utc::now()
            .with_timezone(
                &tz.parse::<chrono_tz::Tz>()
                    .unwrap_or(chrono_tz::America::New_York),
            )
            .date_naive();
        let store_name = get_store_name(&state).await;
        let report = daily_report::generate_report(&state.db, today).await?;
        let rendered = daily_report::render_html(&report, &store_name);
        (today, rendered)
    };

    // Store as test
    let test_report = daily_report::generate_report(&state.db, report_date).await?;
    let store_name = get_store_name(&state).await;
    let test_html = daily_report::render_html(&test_report, &store_name);
    let id = daily_report::store_report(&state.db, &test_report, &test_html, Some(staff.id), true)
        .await?;

    let subject = format!(
        "[TEST] {} — {}",
        config
            .subject_template
            .replace("{date}", &report_date.to_string()),
        "Test Send"
    );

    let mut successful_recipients: Vec<String> = vec![];
    let mut send_errors: Vec<String> = vec![];
    for recipient in &recipients {
        if let Err(e) = email::send_email(
            &state.db, recipient, &subject, &html, None, None, "outbound",
        )
        .await
        {
            tracing::error!(error = %e, "Test send daily report failed to {}", recipient);
            send_errors.push(format!("{recipient}: {e}"));
        } else {
            successful_recipients.push(recipient.clone());
        }
    }

    let error_msg = if send_errors.is_empty() {
        None
    } else {
        Some(send_errors.join("; "))
    };

    daily_report::record_delivery_result(
        &state.db,
        id,
        &successful_recipients,
        error_msg.as_deref(),
    )
    .await?;

    Ok(Json(json!({
        "id": id,
        "report_date": report_date,
        "sent_to": successful_recipients,
        "is_test": true,
        "errors": error_msg,
        "status": if error_msg.is_some() { "partial_failure" } else { "sent" }
    })))
}

// ── History ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct HistoryQuery {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    limit: Option<i64>,
}

#[derive(Serialize, FromRow)]
struct ReportListRow {
    id: Uuid,
    report_date: NaiveDate,
    generated_at: Option<chrono::DateTime<chrono::Utc>>,
    sent_at: Option<chrono::DateTime<chrono::Utc>>,
    sent_to: Option<Vec<String>>,
    send_error: Option<String>,
    is_test: bool,
    sales_basis: String,
    net_sales: Option<rust_decimal::Decimal>,
    transaction_count: Option<i64>,
    total_tendered: Option<rust_decimal::Decimal>,
}

async fn list_reports(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Vec<ReportListRow>>, DailyReportError> {
    require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;

    let limit = q.limit.unwrap_or(100).min(500);
    let rows: Vec<ReportListRow> = sqlx::query_as(
        r#"
        SELECT
            id,
            report_date,
            generated_at,
            sent_at,
            sent_to,
            send_error,
            is_test,
            CASE
                WHEN report_payload ? 'booked_sales' THEN 'booked'
                ELSE 'recognized'
            END AS sales_basis,
            COALESCE(
                (report_payload->'booked_sales'->>'net_sales')::numeric(14,2),
                (report_payload->>'net_sales')::numeric(14,2)
            ) AS net_sales,
            COALESCE(
                (report_payload->'booked_sales'->>'sales_count')::bigint,
                (report_payload->>'transaction_count')::bigint
            ) AS transaction_count,
            (report_payload->>'total_tendered')::numeric(14,2) AS total_tendered
        FROM daily_financial_reports
        WHERE ($1::date IS NULL OR report_date >= $1)
          AND ($2::date IS NULL OR report_date <= $2)
        ORDER BY report_date DESC, generated_at DESC
        LIMIT $3
        "#,
    )
    .bind(q.from)
    .bind(q.to)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

// ── Get single report ────────────────────────────────────────────────────────

#[derive(Serialize, FromRow)]
struct ReportDetailRow {
    id: Uuid,
    report_date: NaiveDate,
    generated_at: Option<chrono::DateTime<chrono::Utc>>,
    report_payload: serde_json::Value,
    html_content: Option<String>,
    sent_at: Option<chrono::DateTime<chrono::Utc>>,
    sent_to: Option<Vec<String>>,
    send_error: Option<String>,
    is_test: bool,
}

#[derive(FromRow)]
struct DeliveryState {
    sent_at: Option<chrono::DateTime<chrono::Utc>>,
    sent_to: Vec<String>,
    send_error: Option<String>,
}

async fn get_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<ReportDetailRow>, DailyReportError> {
    require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;

    let row: ReportDetailRow = sqlx::query_as(
        r#"
        SELECT id, report_date, generated_at, report_payload, html_content,
               sent_at, sent_to, send_error, is_test
        FROM daily_financial_reports
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(DailyReportError::NotFound)?;

    Ok(Json(row))
}

// ── Resend ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ResendRequest {
    #[serde(default)]
    email_override: Option<Vec<String>>,
}

async fn resend_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ResendRequest>,
) -> Result<Json<serde_json::Value>, DailyReportError> {
    require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(|_| DailyReportError::Forbidden)?;

    let row: ReportDetailRow = sqlx::query_as(
        r#"
        SELECT id, report_date, generated_at, report_payload, html_content,
               sent_at, sent_to, send_error, is_test
        FROM daily_financial_reports
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(DailyReportError::NotFound)?;

    let html = row.html_content.ok_or(DailyReportError::InvalidPayload(
        "No HTML content".to_string(),
    ))?;

    let config = daily_report::load_config(&state.db).await?;
    let retrying_failed_delivery = body.email_override.is_none() && row.send_error.is_some();
    let requested_recipients = body
        .email_override
        .unwrap_or(config.recipient_emails.clone());
    let requested_recipients = normalize_recipients(&requested_recipients)?;
    let previously_sent = row.sent_to.clone().unwrap_or_default();
    let recipients = recipients_for_resend(
        &requested_recipients,
        &previously_sent,
        retrying_failed_delivery,
    );

    if recipients.is_empty() {
        return Err(DailyReportError::InvalidPayload(
            "No recipients need delivery".to_string(),
        ));
    }

    let subject = format!(
        "{} (resent)",
        config
            .subject_template
            .replace("{date}", &row.report_date.to_string())
    );

    let mut successful_recipients: Vec<String> = vec![];
    let mut send_errors: Vec<String> = vec![];
    for recipient in &recipients {
        if let Err(e) = email::send_email(
            &state.db, recipient, &subject, &html, None, None, "outbound",
        )
        .await
        {
            send_errors.push(format!("{recipient}: {e}"));
        } else {
            successful_recipients.push(recipient.clone());
        }
    }

    let error_msg = if send_errors.is_empty() {
        None
    } else {
        Some(send_errors.join("; "))
    };

    daily_report::record_delivery_result(
        &state.db,
        id,
        &successful_recipients,
        error_msg.as_deref(),
    )
    .await?;

    Ok(Json(json!({
        "id": id,
        "sent_to": successful_recipients,
        "errors": error_msg,
        "status": if error_msg.is_some() { "partial_failure" } else { "resent" }
    })))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async fn get_store_name(state: &AppState) -> String {
    sqlx::query_scalar::<_, String>(
        "SELECT COALESCE(receipt_config->>'store_name', 'Riverside') FROM store_settings WHERE id = 1",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| "Riverside".to_string())
}

fn normalize_recipients(recipients: &[String]) -> Result<Vec<String>, DailyReportError> {
    email::normalize_email_recipients(recipients).map_err(|error| match error {
        email::EmailError::InvalidPayload(message) => DailyReportError::InvalidPayload(message),
        other => DailyReportError::InvalidPayload(other.to_string()),
    })
}

fn recipients_for_resend(
    requested: &[String],
    previously_sent: &[String],
    retrying_failed_delivery: bool,
) -> Vec<String> {
    if !retrying_failed_delivery {
        return requested.to_vec();
    }

    requested
        .iter()
        .filter(|recipient| {
            !previously_sent
                .iter()
                .any(|sent| sent.eq_ignore_ascii_case(recipient))
        })
        .cloned()
        .collect()
}

async fn load_delivery_state(
    pool: &PgPool,
    business_date: NaiveDate,
) -> Result<Option<DeliveryState>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT sent_at, COALESCE(sent_to, ARRAY[]::text[]) AS sent_to, send_error
        FROM daily_financial_reports
        WHERE report_date = $1 AND is_test = false
        "#,
    )
    .bind(business_date)
    .fetch_optional(pool)
    .await
}

// ── Auto-send after close (called from register close logic) ─────────────────

pub async fn auto_send_daily_report(pool: &PgPool, business_date: chrono::NaiveDate) {
    let config = match daily_report::load_config(pool).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "Failed to load daily report config for auto-send");
            return;
        }
    };

    if !config.enabled {
        return;
    }

    // Preserve successful recipients from a partial attempt so retries only
    // target addresses that have not received this business date.
    let existing_delivery = match load_delivery_state(pool, business_date).await {
        Ok(delivery) => delivery,
        Err(error) => {
            tracing::error!(%error, %business_date, "Failed to load daily report delivery state");
            return;
        }
    };

    if existing_delivery
        .as_ref()
        .is_some_and(|delivery| delivery.sent_at.is_some() && delivery.send_error.is_none())
    {
        tracing::info!("Daily report already sent for {business_date}; skipping auto-send.");
        return;
    }

    let previously_sent = existing_delivery
        .map(|delivery| delivery.sent_to)
        .unwrap_or_default();

    let store_name = sqlx::query_scalar::<_, String>(
        "SELECT COALESCE(receipt_config->>'store_name', 'Riverside') FROM store_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| "Riverside".to_string());

    let report = match daily_report::generate_report(pool, business_date).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "Failed to generate daily report for auto-send");
            return;
        }
    };

    let html = daily_report::render_html(&report, &store_name);

    let id = match daily_report::store_report(pool, &report, &html, None, false).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(error = %e, "Failed to store daily report for auto-send");
            return;
        }
    };

    if !config.auto_send_after_close || config.recipient_emails.is_empty() {
        tracing::info!(%business_date, "Daily financial report generated and stored without email delivery");
        return;
    }

    let configured_recipients = match normalize_recipients(&config.recipient_emails) {
        Ok(recipients) => recipients,
        Err(error) => {
            tracing::error!(%error, %business_date, "Daily report recipients are invalid");
            return;
        }
    };
    let pending_recipients = recipients_for_resend(&configured_recipients, &previously_sent, true);

    let subject = config
        .subject_template
        .replace("{date}", &business_date.to_string());

    let mut successful_recipients: Vec<String> = vec![];
    let mut errors: Vec<String> = vec![];
    for recipient in &pending_recipients {
        if let Err(e) =
            email::send_email(pool, recipient, &subject, &html, None, None, "outbound").await
        {
            tracing::error!(error = %e, "Auto daily report failed to send to {}", recipient);
            errors.push(format!("{recipient}: {e}"));
        } else {
            successful_recipients.push(recipient.clone());
        }
    }

    let error_msg = if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    };

    if let Err(error) =
        daily_report::record_delivery_result(pool, id, &successful_recipients, error_msg.as_deref())
            .await
    {
        tracing::error!(%error, %business_date, "Failed to record daily report delivery result");
        return;
    }

    if errors.is_empty() {
        tracing::info!(
            "Daily financial report auto-sent for {business_date} to {:?}",
            pending_recipients
        );
    } else {
        tracing::warn!(
            "Daily financial report auto-send partial failure for {business_date}: {error_msg:?}"
        );
        let _ = crate::logic::notifications::broadcast_system_alert(
            pool,
            &format!(
                "Daily Financial Report email failed for {business_date}. Open Settings → Daily Financial Report to review the error and retry failed recipients."
            ),
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_recipients, recipients_for_resend};

    #[test]
    fn recipient_normalization_trims_deduplicates_and_lowercases() {
        let recipients = normalize_recipients(&[
            " Owner@Example.com ".to_string(),
            "owner@example.com; accountant@example.com".to_string(),
        ])
        .expect("valid recipients");

        assert_eq!(
            recipients,
            vec!["owner@example.com", "accountant@example.com"]
        );
    }

    #[test]
    fn failed_delivery_retry_skips_successful_recipients() {
        let requested = vec![
            "owner@example.com".to_string(),
            "accountant@example.com".to_string(),
        ];
        let previously_sent = vec!["OWNER@example.com".to_string()];

        assert_eq!(
            recipients_for_resend(&requested, &previously_sent, true),
            vec!["accountant@example.com"]
        );
        assert_eq!(
            recipients_for_resend(&requested, &previously_sent, false),
            requested
        );
    }
}
