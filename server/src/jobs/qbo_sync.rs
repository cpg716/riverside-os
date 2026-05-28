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

        let resp = self
            .http_client
            .post(&url)
            .bearer_auth(access_token)
            .header("Accept", "application/json")
            .json(&je_body)
            .send()
            .await
            .map_err(|e| format!("QBO JournalEntry request failed: {e}"))?;

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
                WHERE id = $1
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
            WHERE id = $1
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

    pub async fn sync_outbox(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        let row: Option<(sqlx::types::Uuid, sqlx::types::Uuid, serde_json::Value, i32)> =
            sqlx::query_as(
                r#"
            SELECT id, transaction_id, payload, attempts
            FROM qbo_sync_outbox
            WHERE status IN ('pending', 'failed')
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            "#,
            )
            .fetch_optional(&mut *tx)
            .await?;

        let Some((outbox_id, transaction_id, payload, attempts)) = row else {
            tx.commit().await?;
            return Ok(());
        };

        sqlx::query(
            "UPDATE qbo_sync_outbox SET status = 'processing', updated_at = NOW() WHERE id = $1",
        )
        .bind(outbox_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        match self.process_outbox_item(transaction_id, &payload).await {
            Ok(je_id) => {
                sqlx::query(
                    r#"
                    UPDATE qbo_sync_outbox
                    SET status = 'synced',
                        attempts = $2 + 1,
                        last_error = NULL,
                        updated_at = NOW()
                    WHERE id = $1
                    "#,
                )
                .bind(outbox_id)
                .bind(attempts)
                .execute(&self.pool)
                .await?;
                tracing::info!(transaction_id = %transaction_id, journal_entry_id = %je_id, "QBO outbox sync succeeded");
                Ok(())
            }
            Err(e) => {
                let err_str = e.to_string();
                tracing::error!(transaction_id = %transaction_id, error = %err_str, "QBO outbox sync failed");

                let is_transient = err_str.contains("rate limit")
                    || err_str.contains("429")
                    || err_str.contains("401")
                    || err_str.contains("expired")
                    || err_str.contains("timeout")
                    || err_str.contains("network")
                    || err_str.contains("connection");

                sqlx::query(
                    r#"
                    UPDATE qbo_sync_outbox
                    SET status = 'failed',
                        attempts = $2 + 1,
                        last_error = $3,
                        updated_at = NOW()
                    WHERE id = $1
                    "#,
                )
                .bind(outbox_id)
                .bind(attempts)
                .bind(&err_str)
                .execute(&self.pool)
                .await?;

                let _ = crate::logic::notifications::emit_qbo_sync_failed(
                    &self.pool, outbox_id, &err_str,
                )
                .await;

                if is_transient {
                    return Err(e);
                }

                Ok(())
            }
        }
    }

    async fn process_outbox_item(
        &self,
        transaction_id: sqlx::types::Uuid,
        payload: &serde_json::Value,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        use crate::logic::qbo_journal::qbo_map_with_misc_fallback;
        use rust_decimal::Decimal;

        let display_id = payload
            .get("display_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let booked_at = payload
            .get("booked_at")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let sync_date = if booked_at.len() >= 10 {
            &booked_at[..10]
        } else {
            booked_at
        };

        let total_price = payload
            .get("total_price")
            .and_then(|v| v.as_str())
            .ok_or("outbox payload missing total_price")?
            .parse::<Decimal>()
            .map_err(|e| format!("outbox payload invalid total_price: {e}"))?;
        let amount_paid = payload
            .get("amount_paid")
            .and_then(|v| v.as_str())
            .ok_or("outbox payload missing amount_paid")?
            .parse::<Decimal>()
            .map_err(|e| format!("outbox payload invalid amount_paid: {e}"))?;
        let balance_due = payload
            .get("balance_due")
            .and_then(|v| v.as_str())
            .ok_or("outbox payload missing balance_due")?
            .parse::<Decimal>()
            .map_err(|e| format!("outbox payload invalid balance_due: {e}"))?;
        let rounding_adjustment = payload
            .get("rounding_adjustment")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<Decimal>().ok())
            .unwrap_or(Decimal::ZERO);
        let shipping_amount = payload
            .get("shipping_amount")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<Decimal>().ok());

        let mut lines: Vec<serde_json::Value> = Vec::new();

        if let Some(items) = payload.get("items").and_then(|v| v.as_array()) {
            for item in items {
                let product_id = item
                    .get("product_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| sqlx::types::Uuid::parse_str(s).ok());
                let quantity = item.get("quantity").and_then(|v| v.as_i64()).unwrap_or(1);
                let unit_price = item
                    .get("unit_price")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<Decimal>().ok())
                    .unwrap_or(Decimal::ZERO);
                let line_type = item
                    .get("line_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("merchandise");

                let qty_dec = Decimal::from(quantity);
                let revenue_amount = (unit_price * qty_dec).round_dp(2);
                if revenue_amount.is_zero() {
                    continue;
                }

                let cat_label: String = if let Some(pid) = product_id {
                    sqlx::query_scalar(
                        r#"
                        SELECT COALESCE(cat.name, 'default')
                        FROM products p
                        LEFT JOIN product_categories cat ON cat.id = p.category_id
                        WHERE p.id = $1
                        "#,
                    )
                    .bind(pid)
                    .fetch_optional(&self.pool)
                    .await?
                    .unwrap_or_else(|| "default".to_string())
                } else {
                    "default".to_string()
                };

                let (rev_id, rev_name) = if line_type == "alteration_service" {
                    qbo_map_with_misc_fallback(
                        &self.pool,
                        "custom_revenue",
                        "alteration_service",
                        Some("REVENUE_ALTERATIONS"),
                    )
                    .await?
                    .unwrap_or_else(|| {
                        (
                            "REVENUE_ALTERATIONS".to_string(),
                            "Alteration Revenue".to_string(),
                        )
                    })
                } else {
                    qbo_map_with_misc_fallback(
                        &self.pool,
                        "category_revenue",
                        &cat_label,
                        Some("REVENUE_DEFAULT"),
                    )
                    .await?
                    .unwrap_or_else(|| {
                        (
                            "REVENUE_DEFAULT".to_string(),
                            "Merchandise Revenue".to_string(),
                        )
                    })
                };

                let memo = format!("ROS Line Rev - {} x {}", quantity, display_id);
                lines.push(json!({
                    "Description": memo,
                    "Amount": format!("{:.2}", revenue_amount.abs()),
                    "DetailType": "JournalEntryLineDetail",
                    "JournalEntryLineDetail": {
                        "PostingType": if revenue_amount > Decimal::ZERO { "Credit" } else { "Debit" },
                        "AccountRef": { "value": rev_id, "name": rev_name }
                    }
                }));
            }
        }

        let mut total_tax = Decimal::ZERO;
        if let Some(items) = payload.get("items").and_then(|v| v.as_array()) {
            for item in items {
                let quantity = item.get("quantity").and_then(|v| v.as_i64()).unwrap_or(1);
                let state_tax = item
                    .get("state_tax")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<Decimal>().ok())
                    .unwrap_or(Decimal::ZERO);
                let local_tax = item
                    .get("local_tax")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<Decimal>().ok())
                    .unwrap_or(Decimal::ZERO);
                let qty_dec = Decimal::from(quantity);
                total_tax += (state_tax + local_tax) * qty_dec;
            }
        }
        total_tax = total_tax.round_dp(2);
        if !total_tax.is_zero() {
            let (tax_id, tax_name) =
                qbo_map_with_misc_fallback(&self.pool, "tax", "SALES_TAX", None)
                    .await?
                    .unwrap_or_else(|| ("SALES_TAX".to_string(), "Sales Tax Payable".to_string()));
            let memo = format!("ROS Sales Tax - {}", display_id);
            lines.push(json!({
                "Description": memo,
                "Amount": format!("{:.2}", total_tax.abs()),
                "DetailType": "JournalEntryLineDetail",
                "JournalEntryLineDetail": {
                    "PostingType": if total_tax > Decimal::ZERO { "Credit" } else { "Debit" },
                    "AccountRef": { "value": tax_id, "name": tax_name }
                }
            }));
        }

        if let Some(ship_amt) = shipping_amount {
            let ship_amt = ship_amt.round_dp(2);
            if !ship_amt.is_zero() {
                let (ship_id, ship_name) = qbo_map_with_misc_fallback(
                    &self.pool,
                    "income_shipping",
                    "default",
                    Some("REVENUE_SHIPPING"),
                )
                .await?
                .unwrap_or_else(|| {
                    (
                        "REVENUE_SHIPPING".to_string(),
                        "Shipping Revenue".to_string(),
                    )
                });
                let memo = format!("ROS Shipping Rev - {}", display_id);
                lines.push(json!({
                    "Description": memo,
                    "Amount": format!("{:.2}", ship_amt.abs()),
                    "DetailType": "JournalEntryLineDetail",
                    "JournalEntryLineDetail": {
                        "PostingType": if ship_amt > Decimal::ZERO { "Credit" } else { "Debit" },
                        "AccountRef": { "value": ship_id, "name": ship_name }
                    }
                }));
            }
        }

        if let Some(payments) = payload.get("payments").and_then(|v| v.as_array()) {
            for payment in payments {
                let method = payment
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("cash");
                let amount = payment
                    .get("amount")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<Decimal>().ok())
                    .unwrap_or(Decimal::ZERO)
                    .round_dp(2);
                if amount.is_zero() {
                    continue;
                }

                let (tend_id, tend_name) =
                    qbo_map_with_misc_fallback(&self.pool, "tender", method, None)
                        .await?
                        .unwrap_or_else(|| {
                            ("TENDER_DEFAULT".to_string(), format!("Tender - {}", method))
                        });
                let memo = format!("ROS Payment - {} - {}", method, display_id);
                lines.push(json!({
                    "Description": memo,
                    "Amount": format!("{:.2}", amount.abs()),
                    "DetailType": "JournalEntryLineDetail",
                    "JournalEntryLineDetail": {
                        "PostingType": if amount > Decimal::ZERO { "Debit" } else { "Credit" },
                        "AccountRef": { "value": tend_id, "name": tend_name }
                    }
                }));
            }
        }

        if !balance_due.is_zero() {
            let (rec_id, rec_name) = match qbo_map_with_misc_fallback(
                &self.pool,
                "receivable",
                "default",
                None,
            )
            .await?
            {
                Some(m) => m,
                None => match qbo_map_with_misc_fallback(
                    &self.pool,
                    "liability_deposit",
                    "default",
                    None,
                )
                .await?
                {
                    Some(m) => m,
                    None => (
                        "accounts_receivable".to_string(),
                        "Accounts Receivable".to_string(),
                    ),
                },
            };
            let memo = format!("ROS Unpaid Balance - {}", display_id);
            lines.push(json!({
                "Description": memo,
                "Amount": format!("{:.2}", balance_due.abs()),
                "DetailType": "JournalEntryLineDetail",
                "JournalEntryLineDetail": {
                    "PostingType": if balance_due > Decimal::ZERO { "Debit" } else { "Credit" },
                    "AccountRef": { "value": rec_id, "name": rec_name }
                }
            }));
        }

        if !rounding_adjustment.is_zero() {
            let (rnd_id, rnd_name) = qbo_map_with_misc_fallback(
                &self.pool,
                "cash_rounding",
                "default",
                Some("CASH_ROUNDING"),
            )
            .await?
            .unwrap_or_else(|| {
                (
                    "CASH_ROUNDING".to_string(),
                    "Swedish Rounding Adjustments".to_string(),
                )
            });
            let memo = format!("ROS Swedish Rounding - {}", display_id);
            let abs_rnd = rounding_adjustment.abs().round_dp(2);
            let posting_type = if rounding_adjustment > Decimal::ZERO {
                "Credit"
            } else {
                "Debit"
            };
            lines.push(json!({
                "Description": memo,
                "Amount": format!("{:.2}", abs_rnd),
                "DetailType": "JournalEntryLineDetail",
                "JournalEntryLineDetail": {
                    "PostingType": posting_type,
                    "AccountRef": { "value": rnd_id, "name": rnd_name }
                }
            }));
        }

        if lines.is_empty() {
            return Err("No lines generated for journal entry".into());
        }

        let integ = integration_row(&self.pool)
            .await
            .map_err(|e| format!("integration lookup failed: {e}"))?
            .ok_or("no active QBO integration")?;

        let realm_id = integ.realm_id.as_ref().ok_or("missing realm_id")?;
        let access_token = match integ
            .access_token
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            Some(t) => t.to_string(),
            None => refresh_access_token(&self.pool, &integ).await?,
        };

        let je_body = json!({
            "TxnDate": sync_date,
            "Line": lines
        });
        let request_id = format!("ros-qbo-outbox-{transaction_id}");
        let url = format!(
            "{}/v3/company/{}/journalentry?minorversion={}&requestid={}",
            qbo_base_url(integ.use_sandbox),
            realm_id,
            QBO_MINOR_VERSION,
            request_id
        );

        let resp = self
            .http_client
            .post(&url)
            .bearer_auth(access_token)
            .header("Accept", "application/json")
            .json(&je_body)
            .send()
            .await
            .map_err(|e| format!("QBO JournalEntry request failed: {e}"))?;

        let status_code = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| json!({}));

        if !status_code.is_success() {
            let err_msg = body
                .get("Fault")
                .and_then(|f| f.get("Error"))
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("Detail"))
                .and_then(|d| d.as_str())
                .unwrap_or("QBO API Error");
            return Err(format!("QBO API Error ({}): {}", status_code, err_msg).into());
        }

        let je_id = body
            .get("JournalEntry")
            .and_then(|j| j.get("Id"))
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN")
            .to_string();

        Ok(je_id)
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
