//! Background QBO sync job handler
//!
//! Handles:
//! - Auto-proposing daily journals for a given business date
//! - Syncing approved staging entries to QBO
//! - Token health pre-refresh before expiry

use crate::api::qbo::{integration_row, qbo_base_url, refresh_access_token, QBO_MINOR_VERSION};
use crate::jobs::{JobContext, JobHandler};
use chrono::{NaiveDate, Utc};
use serde_json::json;
use sqlx::PgPool;

pub struct QboSyncHandler {
    pool: PgPool,
    http_client: reqwest::Client,
}

impl QboSyncHandler {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            http_client: reqwest::Client::new(),
        }
    }

    async fn handle_propose(
        &self,
        date: NaiveDate,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        tracing::info!(activity_date = %date, "QBO job: proposing daily journal");
        let id = crate::logic::qbo_journal::ensure_pending_daily_journal(&self.pool, date).await?;
        tracing::info!(staging_id = %id, "QBO job: daily journal proposed");
        Ok(())
    }

    async fn handle_sync_approved(
        &self,
        staging_id: sqlx::types::Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        tracing::info!(staging_id = %staging_id, "QBO job: syncing approved staging");

        let row: Option<(String, serde_json::Value)> =
            sqlx::query_as("SELECT status, payload FROM qbo_sync_logs WHERE id = $1")
                .bind(staging_id)
                .fetch_optional(&self.pool)
                .await?;

        let Some((status, payload)) = row else {
            return Err("staging row not found".into());
        };
        if status != "approved" {
            return Err("only approved entries can be synced".into());
        }

        let integ = integration_row(&self.pool)
            .await
            .map_err(|e| format!("integration lookup failed: {e}"))?
            .ok_or("no active QBO integration")?;

        let realm_id = integ
            .realm_id
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or("missing realm_id")?;

        let access_token = match integ
            .access_token
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            Some(t) => t.to_string(),
            None => refresh_access_token(&self.pool, &integ)
                .await
                .map_err(|e| format!("token refresh failed: {e}"))?,
        };

        let sync_date = payload
            .get("activity_date")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mut line_payloads: Vec<serde_json::Value> = Vec::new();
        if let Some(lines) = payload.get("lines").and_then(|v| v.as_array()) {
            for l in lines {
                let debit = l.get("debit").and_then(to_amount);
                let credit = l.get("credit").and_then(to_amount);
                let (posting_type, amount) =
                    if let Some(d) = debit.as_ref().filter(|d| *d != "0.00") {
                        ("Debit", d.clone())
                    } else if let Some(c) = credit.as_ref().filter(|c| *c != "0.00") {
                        ("Credit", c.clone())
                    } else {
                        continue;
                    };
                let account_id = l
                    .get("qbo_account_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if account_id.is_empty() {
                    continue;
                }
                let account_name = l
                    .get("qbo_account_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(account_id);
                let memo = l
                    .get("memo")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ROS journal line");
                line_payloads.push(json!({
                    "Description": memo,
                    "Amount": amount,
                    "DetailType": "JournalEntryLineDetail",
                    "JournalEntryLineDetail": {
                        "PostingType": posting_type,
                        "AccountRef": { "value": account_id, "name": account_name }
                    }
                }));
            }
        }

        if line_payloads.is_empty() {
            return Err("staging payload has no journal lines".into());
        }

        let je_body = json!({
            "TxnDate": sync_date,
            "Line": line_payloads
        });
        let request_id = format!("ros-qbo-journal-{staging_id}");
        let url = format!(
            "{}/v3/company/{}/journalentry?minorversion={}&requestid={}",
            qbo_base_url(integ.use_sandbox),
            realm_id,
            QBO_MINOR_VERSION,
            request_id
        );

        // Lock the staging row to syncing so retries after a crash do not re-post to QBO.
        let locked = sqlx::query(
            r#"
            UPDATE qbo_sync_logs
            SET status = 'syncing', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'approved'
            "#,
        )
        .bind(staging_id)
        .execute(&self.pool)
        .await?;
        if locked.rows_affected() == 0 {
            return Err(
                "staging entry is not in approved state; another worker may have claimed it".into(),
            );
        }

        let resp = match self
            .http_client
            .post(&url)
            .bearer_auth(access_token)
            .header("Accept", "application/json")
            .json(&je_body)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(error) => {
                let err_msg = format!("QBO JournalEntry request failed: {error}");
                sqlx::query(
                    r#"
                    UPDATE qbo_sync_logs
                    SET status = 'failed', error_message = $2, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND status = 'syncing'
                    "#,
                )
                .bind(staging_id)
                .bind(&err_msg)
                .execute(&self.pool)
                .await?;
                let _ = crate::logic::notifications::emit_qbo_sync_failed(
                    &self.pool, staging_id, &err_msg,
                )
                .await;
                return Err(err_msg.into());
            }
        };

        let status_code = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .unwrap_or_else(|_| json!({ "fault": "invalid response from qbo" }));

        if !status_code.is_success() {
            let err_msg = body
                .get("Fault")
                .and_then(|f| f.get("Error"))
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("Detail"))
                .and_then(|d| d.as_str())
                .or_else(|| body.get("fault").and_then(|v| v.as_str()))
                .unwrap_or("QBO sync failed")
                .to_string();
            sqlx::query(
                r#"
                UPDATE qbo_sync_logs
                SET status = 'failed', error_message = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND status = 'syncing'
                "#,
            )
            .bind(staging_id)
            .bind(&err_msg)
            .execute(&self.pool)
            .await?;
            let _ =
                crate::logic::notifications::emit_qbo_sync_failed(&self.pool, staging_id, &err_msg)
                    .await;
            return Err(format!("QBO sync failed: {err_msg}").into());
        }

        let je_id = body
            .get("JournalEntry")
            .and_then(|j| j.get("Id"))
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN")
            .to_string();

        sqlx::query(
            r#"
            UPDATE qbo_sync_logs
            SET
                status = 'synced',
                journal_entry_id = $2,
                updated_at = CURRENT_TIMESTAMP,
                error_message = NULL
            WHERE id = $1 AND status = 'syncing'
            "#,
        )
        .bind(staging_id)
        .bind(&je_id)
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            UPDATE qbo_integration
            SET last_sync_at = CURRENT_TIMESTAMP
            WHERE is_active = true
            "#,
        )
        .execute(&self.pool)
        .await?;

        tracing::info!(staging_id = %staging_id, journal_entry_id = %je_id, "QBO job: sync succeeded");
        Ok(())
    }

    async fn handle_token_refresh(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        tracing::info!("QBO job: checking token health");
        let integ = match integration_row(&self.pool).await? {
            Some(i) => i,
            None => {
                tracing::info!("QBO job: no active integration");
                return Ok(());
            }
        };

        let has_refresh = integ
            .refresh_token
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_refresh {
            tracing::warn!("QBO job: no refresh token available");
            return Ok(());
        }

        let now = Utc::now();
        let should_refresh = integ
            .token_expires_at
            .map(|e| e.signed_duration_since(now).num_minutes() < 30)
            .unwrap_or(true);

        if should_refresh {
            match refresh_access_token(&self.pool, &integ).await {
                Ok(_) => tracing::info!("QBO job: token refreshed proactively"),
                Err(e) => tracing::error!(error = %e, "QBO job: proactive token refresh failed"),
            }
        } else {
            tracing::info!("QBO job: token still healthy");
        }
        Ok(())
    }
}
fn to_amount(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = v.as_f64() {
        return Some(format!("{:.2}", n.abs()));
    }
    None
}

#[async_trait::async_trait]
impl JobHandler for QboSyncHandler {
    async fn handle(
        &self,
        ctx: JobContext,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let action = ctx
            .payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        match action {
            "propose" => {
                let default_date = chrono::Local::now().naive_local().to_string();
                let date_str = ctx
                    .payload
                    .get("activity_date")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&default_date);
                let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
                    .or_else(|_| NaiveDate::parse_from_str(&date_str[..10], "%Y-%m-%d"))
                    .unwrap_or_else(|_| Utc::now().naive_utc().date());
                self.handle_propose(date).await
            }
            "sync_approved" => {
                let staging_id = ctx
                    .payload
                    .get("staging_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| sqlx::types::Uuid::parse_str(s).ok())
                    .ok_or("missing staging_id")?;
                self.handle_sync_approved(staging_id).await
            }
            "token_refresh" => self.handle_token_refresh().await,
            other => {
                tracing::warn!(action = %other, "QBO job: unknown action");
                Err(format!("unknown QBO sync action: {other}").into())
            }
        }
    }

    fn job_type(&self) -> &'static str {
        "sync_qbo"
    }

    fn max_attempts(&self) -> u32 {
        3
    }
}
