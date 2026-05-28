//! Scheduled job system for customer notification queue (9:30AM, 3:00PM Mon-Sat)

use chrono::{Datelike, Duration, Timelike, Utc, Weekday};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::messaging::MessagingService;
use crate::logic::podium::PodiumTokenCache;

#[derive(Debug, Clone)]
pub struct NotificationScheduler {
    pool: PgPool,
    podium_cache: Arc<Mutex<PodiumTokenCache>>,
    http_client: reqwest::Client,
}

impl NotificationScheduler {
    pub fn new(pool: PgPool, podium_cache: Arc<Mutex<PodiumTokenCache>>) -> Self {
        Self {
            pool,
            podium_cache,
            http_client: reqwest::Client::new(),
        }
    }

    /// Calculate next scheduled batch time (9:30AM or 3:00PM, Mon-Sat only)
    pub fn next_scheduled_time() -> chrono::DateTime<Utc> {
        let now = Utc::now();
        let local_now = now.with_timezone(&chrono::Local);

        // Define scheduled times: 9:30 AM and 3:00 PM
        let scheduled_times = vec![(9, 30), (15, 0)];

        for (hour, minute) in scheduled_times {
            let scheduled = local_now
                .date_naive()
                .and_hms_opt(hour, minute, 0)
                .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
                .unwrap_or(local_now);

            // If today's scheduled time hasn't passed yet and it's Mon-Sat
            if scheduled > local_now && local_now.weekday() != Weekday::Sun {
                return scheduled.with_timezone(&Utc);
            }
        }

        // If all times have passed today, schedule for tomorrow (Mon-Sat only)
        let mut next_day = local_now.date_naive() + Duration::days(1);
        loop {
            let weekday = next_day.weekday();
            if weekday != Weekday::Sun {
                // Schedule for 9:30 AM
                let scheduled = next_day
                    .and_hms_opt(9, 30, 0)
                    .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
                    .unwrap_or(local_now);
                return scheduled.with_timezone(&Utc);
            }
            next_day += Duration::days(1);
        }
    }

    /// Schedule all pending notifications for the next batch
    pub async fn schedule_pending_for_next_batch(&self) -> Result<i64, sqlx::Error> {
        let target_time = Self::next_scheduled_time();
        let count: i64 = sqlx::query_scalar("SELECT schedule_pending_notifications($1)")
            .bind(target_time)
            .fetch_one(&self.pool)
            .await?;
        Ok(count)
    }

    /// Process notifications that are due to be sent
    pub async fn process_due_notifications(&self) -> Result<u32, sqlx::Error> {
        let now = Utc::now();

        // Get notifications due for sending
        let rows: Vec<(Uuid, String, Uuid, Uuid, String, serde_json::Value)> =
            sqlx::query_as("SELECT * FROM get_notifications_to_send($1)")
                .bind(now)
                .fetch_all(&self.pool)
                .await?;

        let mut sent_count = 0;

        for (id, entity_type, entity_id, customer_id, kind, metadata) in rows {
            tracing::info!(
                target: "notification_scheduler",
                notification_id = %id,
                entity_type = %entity_type,
                entity_id = %entity_id,
                customer_id = %customer_id,
                kind = %kind,
                "Processing scheduled notification"
            );

            let result = match kind.as_str() {
                "ready_for_pickup" => match entity_type.as_str() {
                    "order" => {
                        tracing::info!(
                            target: "notification_scheduler",
                            transaction_id = %entity_id,
                            customer_id = %customer_id,
                            "Sending order ready for pickup notification"
                        );
                        MessagingService::trigger_ready_for_pickup(
                            &self.pool,
                            &self.http_client,
                            &self.podium_cache,
                            entity_id,
                            customer_id,
                        )
                        .await
                    }
                    "alteration" => {
                        tracing::info!(
                            target: "notification_scheduler",
                            alteration_id = %entity_id,
                            customer_id = %customer_id,
                            "Sending alteration ready notification"
                        );
                        MessagingService::trigger_alteration_ready(
                            &self.pool,
                            &self.http_client,
                            &self.podium_cache,
                            customer_id,
                            entity_id,
                        )
                        .await
                    }
                    _ => {
                        tracing::warn!(
                            target: "notification_scheduler",
                            kind = %kind,
                            "Unknown notification kind"
                        );
                        Ok(())
                    }
                },
                _ => {
                    tracing::warn!(
                        target: "notification_scheduler",
                        kind = %kind,
                        "Unknown notification kind"
                    );
                    Ok(())
                }
            };

            // Mark as sent or failed
            let delivery_status = if result.is_ok() {
                "delivered"
            } else {
                "failed"
            };
            let delivery_error = result.as_ref().err().map(|e| e.to_string());
            let delivery_method = "both"; // Default to both SMS and email

            tracing::info!(
                target: "notification_scheduler",
                notification_id = %id,
                delivery_status = %delivery_status,
                delivery_error = ?delivery_error,
                "Marking notification as sent"
            );

            let _ = sqlx::query("SELECT mark_notification_sent($1, $2, $3, $4)")
                .bind(id)
                .bind(delivery_method)
                .bind(delivery_status)
                .bind(delivery_error.as_deref())
                .execute(&self.pool)
                .await;

            if result.is_ok() {
                sent_count += 1;
            }
        }

        Ok(sent_count)
    }

    /// Send a specific notification immediately (override)
    pub async fn send_immediately(&self, notification_id: Uuid) -> Result<bool, sqlx::Error> {
        // Get notification details
        let row: Option<(String, Uuid, Uuid, String, serde_json::Value)> = sqlx::query_as(
            r#"
            SELECT entity_type, entity_id, customer_id, kind, metadata
            FROM customer_notification_queue
            WHERE id = $1 AND status = 'pending'
            "#,
        )
        .bind(notification_id)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((entity_type, entity_id, customer_id, kind, metadata)) = row {
            tracing::info!(
                target: "notification_scheduler",
                notification_id = %notification_id,
                entity_type = %entity_type,
                entity_id = %entity_id,
                customer_id = %customer_id,
                kind = %kind,
                "Sending notification immediately (override)"
            );

            let result = match kind.as_str() {
                "ready_for_pickup" => match entity_type.as_str() {
                    "order" => {
                        MessagingService::trigger_ready_for_pickup(
                            &self.pool,
                            &self.http_client,
                            &self.podium_cache,
                            entity_id,
                            customer_id,
                        )
                        .await
                    }
                    "alteration" => {
                        MessagingService::trigger_alteration_ready(
                            &self.pool,
                            &self.http_client,
                            &self.podium_cache,
                            customer_id,
                            entity_id,
                        )
                        .await
                    }
                    _ => Ok(()),
                },
                _ => Ok(()),
            };

            // Mark as sent
            let delivery_status = if result.is_ok() {
                "delivered"
            } else {
                "failed"
            };
            let delivery_error = result.as_ref().err().map(|e| e.to_string());
            let delivery_method = "both";

            tracing::info!(
                target: "notification_scheduler",
                notification_id = %notification_id,
                delivery_status = %delivery_status,
                delivery_error = ?delivery_error,
                "Marking immediate notification as sent"
            );

            let _ = sqlx::query("SELECT mark_notification_sent($1, $2, $3, $4)")
                .bind(notification_id)
                .bind(delivery_method)
                .bind(delivery_status)
                .bind(delivery_error.as_deref())
                .execute(&self.pool)
                .await;

            Ok(result.is_ok())
        } else {
            Ok(false)
        }
    }

    /// Start the background scheduler task
    pub fn start_background_task(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60)); // Check every minute

            loop {
                interval.tick().await;

                // Check if we're at a scheduled time (9:30AM or 3:00PM, Mon-Sat)
                let now = Utc::now();
                let local_now = now.with_timezone(&chrono::Local);
                let weekday = local_now.weekday();

                if weekday != Weekday::Sun {
                    let hour = local_now.hour();
                    let minute = local_now.minute();

                    // Check if we're at 9:30 AM or 3:00 PM (within the same minute)
                    if (hour == 9 && minute == 30) || (hour == 15 && minute == 0) {
                        tracing::info!(
                            "Running scheduled notification batch at {}:{}",
                            hour,
                            minute
                        );

                        if let Err(e) = self.process_due_notifications().await {
                            tracing::error!(error = %e, "Failed to process due notifications");
                        }
                    }
                }
            }
        })
    }
}
