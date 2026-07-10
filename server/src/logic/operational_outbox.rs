use crate::logic::{commission_events, loyalty, notifications, pos_rms_charge, tasks, weddings};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

const CHECKOUT_POST_COMMIT: &str = "checkout_post_commit";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutWeddingActivity {
    pub party_id: Uuid,
    pub member_id: Option<Uuid>,
    pub actor: String,
    pub description: String,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutPostCommitPayload {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
    pub operator_staff_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub customer_display_rms: Option<String>,
    pub order_short_ref: String,
    pub register_session_id: Uuid,
    pub amount_paid: Decimal,
    pub total_price: Decimal,
    pub price_override_audit: Vec<Value>,
    pub payment_activity_label: String,
    pub is_rms_payment_collection: bool,
    pub has_rms_charge: bool,
    pub transaction_financing_metadata: Value,
    pub negative_stock_alerts: Vec<String>,
    pub checkout_recovery_alerts: Vec<String>,
    pub wedding_activities: Vec<CheckoutWeddingActivity>,
    pub rms_notifications: Vec<pos_rms_charge::RmsChargeNotify>,
}

#[derive(sqlx::FromRow)]
struct ClaimedJob {
    id: Uuid,
    job_type: String,
    payload: Value,
    attempts: i32,
    max_attempts: i32,
}

pub async fn enqueue_checkout_post_commit(
    tx: &mut Transaction<'_, Postgres>,
    payload: &CheckoutPostCommitPayload,
) -> Result<(), sqlx::Error> {
    let idempotency_key = format!("{CHECKOUT_POST_COMMIT}:{}", payload.transaction_id);
    sqlx::query(
        r#"
        INSERT INTO operational_outbox (job_type, idempotency_key, payload)
        VALUES ($1, $2, $3)
        ON CONFLICT (idempotency_key) DO NOTHING
        "#,
    )
    .bind(CHECKOUT_POST_COMMIT)
    .bind(idempotency_key)
    .bind(json!(payload))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn claim_next(pool: &PgPool) -> Result<Option<ClaimedJob>, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH next_job AS (
            SELECT id
            FROM operational_outbox
            WHERE (
                    status = 'pending'
                    AND available_at <= now()
                ) OR (
                    status = 'processing'
                    AND locked_at < now() - interval '5 minutes'
                )
            ORDER BY available_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE operational_outbox AS job
        SET status = 'processing',
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = $1,
            updated_at = now()
        FROM next_job
        WHERE job.id = next_job.id
        RETURNING job.id, job.job_type, job.payload, job.attempts, job.max_attempts
        "#,
    )
    .bind(format!("{}:{}", hostname(), std::process::id()))
    .fetch_optional(pool)
    .await
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "riverside-server".to_string())
}

async fn process_checkout_post_commit(
    pool: &PgPool,
    payload: CheckoutPostCommitPayload,
) -> Result<(), anyhow::Error> {
    let transaction_id = payload.transaction_id;
    let transaction_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM transactions WHERE id = $1)")
            .bind(transaction_id)
            .fetch_one(pool)
            .await?;
    if !transaction_exists {
        tracing::warn!(%transaction_id, "Discarding orphaned checkout outbox job");
        return Ok(());
    }

    for (index, message) in payload.negative_stock_alerts.iter().enumerate() {
        notifications::broadcast_system_alert_with_key(
            pool,
            message,
            &format!("checkout_negative_stock:{transaction_id}:{index}"),
        )
        .await?;
    }
    for (index, message) in payload.checkout_recovery_alerts.iter().enumerate() {
        notifications::broadcast_system_alert_with_key(
            pool,
            message,
            &format!("checkout_recovery:{transaction_id}:{index}"),
        )
        .await?;
    }

    commission_events::upsert_fulfilled_transaction_events_pool(pool, transaction_id, &[]).await?;

    for (index, detail) in payload.price_override_audit.iter().enumerate() {
        crate::auth::pins::log_staff_access_once(
            pool,
            payload.operator_staff_id,
            "price_override",
            json!({ "transaction_id": transaction_id, "detail": detail }),
            &format!("checkout_price_override:{transaction_id}:{index}"),
        )
        .await?;
    }
    crate::auth::pins::log_staff_access_once(
        pool,
        payload.operator_staff_id,
        "checkout_auth",
        json!({
            "transaction_id": transaction_id,
            "amount_paid": payload.amount_paid,
            "total_price": payload.total_price,
        }),
        &format!("checkout_auth:{transaction_id}"),
    )
    .await?;

    let loyalty_outcome = loyalty::try_accrue_for_order(pool, transaction_id).await?;

    for (index, activity) in payload.wedding_activities.iter().enumerate() {
        weddings::insert_wedding_activity_once(
            pool,
            activity.party_id,
            activity.member_id,
            &activity.actor,
            "PAYMENT",
            &activity.description,
            activity.metadata.clone(),
            &format!("checkout_wedding_activity:{transaction_id}:{index}"),
        )
        .await?;
    }

    pos_rms_charge::notify_sales_support_after_checkout(
        pool,
        transaction_id,
        payload.register_session_id,
        payload.customer_id,
        payload.customer_display_rms.as_deref(),
        &payload.order_short_ref,
        payload.operator_staff_id,
        &payload.rms_notifications,
    )
    .await?;

    if payload.is_rms_payment_collection && payload.amount_paid > Decimal::ZERO {
        if let Some(customer_id) = payload.customer_id {
            tasks::create_adhoc_rms_payment_followup_tasks(
                pool,
                transaction_id,
                customer_id,
                payload.customer_display_rms.as_deref(),
                &payload.order_short_ref,
                payload.amount_paid,
                &payload.payment_activity_label,
                payload.operator_staff_id,
            )
            .await?;
        }
    }

    crate::auth::pins::log_staff_access_once(
        pool,
        payload.operator_staff_id,
        "sale_checkout",
        json!({
            "transaction_id": transaction_id,
            "register_session_id": payload.register_session_id,
        }),
        &format!("sale_checkout:{transaction_id}"),
    )
    .await?;

    if payload.has_rms_charge && payload.transaction_financing_metadata != json!({}) {
        crate::auth::pins::log_staff_access_once(
            pool,
            payload.operator_staff_id,
            "rms_charge_program_selected",
            json!({
                "transaction_id": transaction_id,
                "register_session_id": payload.register_session_id,
                "metadata": payload.transaction_financing_metadata,
            }),
            &format!("rms_charge_program_selected:{transaction_id}"),
        )
        .await?;
    }

    if let Ok(url_raw) = std::env::var("RIVERSIDE_WEBHOOK_URL") {
        let target_url = url_raw.trim();
        if !target_url.is_empty() {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()?
                .post(target_url)
                .header("Idempotency-Key", format!("transaction.finalized:{transaction_id}"))
                .json(&json!({
                    "event": "transaction.finalized",
                    "transaction_id": transaction_id,
                    "transaction_display_id": payload.transaction_display_id,
                    "amount_paid": payload.amount_paid.to_string(),
                    "total_price": payload.total_price.to_string(),
                    "loyalty_points_earned": loyalty_outcome.map(|value| value.points_earned).unwrap_or(0),
                }))
                .send()
                .await?
                .error_for_status()?;
        }
    }

    Ok(())
}

async fn process_job(pool: &PgPool, job: &ClaimedJob) -> Result<(), anyhow::Error> {
    match job.job_type.as_str() {
        CHECKOUT_POST_COMMIT => {
            let payload: CheckoutPostCommitPayload = serde_json::from_value(job.payload.clone())?;
            process_checkout_post_commit(pool, payload).await
        }
        other => anyhow::bail!("unsupported operational outbox job type: {other}"),
    }
}

async fn finish_job(pool: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE operational_outbox
        SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
            last_error = NULL, updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn retry_or_fail(pool: &PgPool, job: &ClaimedJob, error: &str) -> Result<(), sqlx::Error> {
    let failed = job.attempts >= job.max_attempts;
    let retry_seconds = 2_i64.pow(job.attempts.clamp(1, 8) as u32).min(300);
    sqlx::query(
        r#"
        UPDATE operational_outbox
        SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
            available_at = CASE WHEN $2 THEN available_at ELSE now() + ($3 * interval '1 second') END,
            locked_at = NULL,
            locked_by = NULL,
            last_error = left($4, 4000),
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(job.id)
    .bind(failed)
    .bind(retry_seconds)
    .bind(error)
    .execute(pool)
    .await?;

    if failed {
        let message = format!(
            "Checkout follow-up job failed after {} attempts. Job {} requires review.",
            job.attempts, job.id
        );
        if let Err(alert_error) = notifications::broadcast_system_alert_with_key(
            pool,
            &message,
            &format!("operational_outbox_failed:{}", job.id),
        )
        .await
        {
            tracing::error!(error = %alert_error, job_id = %job.id, "Could not broadcast failed outbox alert");
        }
    }
    Ok(())
}

async fn run_worker(pool: PgPool) {
    let mut ticker = tokio::time::interval(Duration::from_secs(2));
    loop {
        ticker.tick().await;
        crate::api::health::WorkerHealth::mark_heartbeat("operational_outbox").await;
        match claim_next(&pool).await {
            Ok(Some(job)) => match process_job(&pool, &job).await {
                Ok(()) => {
                    if let Err(error) = finish_job(&pool, job.id).await {
                        tracing::error!(error = %error, job_id = %job.id, "Could not complete operational outbox job");
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, job_id = %job.id, attempt = job.attempts, "Operational outbox job failed");
                    if let Err(update_error) = retry_or_fail(&pool, &job, &error.to_string()).await
                    {
                        tracing::error!(error = %update_error, job_id = %job.id, "Could not reschedule operational outbox job");
                    }
                }
            },
            Ok(None) => {}
            Err(error) => tracing::error!(error = %error, "Operational outbox claim failed"),
        }
    }
}

async fn run_cleanup(pool: PgPool) {
    let mut ticker = tokio::time::interval(Duration::from_secs(6 * 60 * 60));
    loop {
        ticker.tick().await;
        let cleanup = sqlx::query_as::<_, (i64, i64, i64)>(
            r#"
            WITH deleted_outbox AS (
                DELETE FROM operational_outbox
                WHERE (status = 'completed' AND completed_at < now() - interval '30 days')
                   OR (status = 'failed' AND updated_at < now() - interval '90 days')
                RETURNING 1
            ), deleted_recovery AS (
                DELETE FROM operational_recovery_job
                WHERE status IN ('resolved', 'dismissed')
                  AND resolved_at < now() - interval '90 days'
                RETURNING 1
            ), deleted_metrics AS (
                DELETE FROM operational_phase_metric
                WHERE recorded_at < now() - interval '30 days'
                RETURNING 1
            )
            SELECT
                (SELECT COUNT(*) FROM deleted_outbox)::bigint,
                (SELECT COUNT(*) FROM deleted_recovery)::bigint,
                (SELECT COUNT(*) FROM deleted_metrics)::bigint
            "#,
        )
        .fetch_one(&pool)
        .await;
        match cleanup {
            Ok((outbox, recovery, metrics)) => {
                if outbox > 0 || recovery > 0 || metrics > 0 {
                    tracing::info!(
                        outbox,
                        recovery,
                        metrics,
                        "Operational retention cleanup completed"
                    );
                }
            }
            Err(error) => tracing::warn!(%error, "Operational retention cleanup failed"),
        }
    }
}

pub fn start_worker(pool: PgPool) {
    tokio::spawn(run_worker(pool.clone()));
    tokio::spawn(run_cleanup(pool));
}
