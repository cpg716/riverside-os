//! Scheduled notification generators + retention (archive / purge).

use std::collections::{HashMap, HashSet};

use crate::auth::permissions::{
    staff_has_permission, ALTERATIONS_MANAGE, CATALOG_EDIT, GIFT_CARDS_MANAGE, NOTIFICATIONS_VIEW,
    ORDERS_VIEW, PROCUREMENT_VIEW, WEDDINGS_VIEW,
};
use crate::logic::backups::BackupSettings;
use crate::logic::notifications::{
    admin_staff_ids, archive_stale_staff_notifications, delete_app_notification_by_dedupe,
    emit_qbo_sync_failed, fan_out_to_staff_ids, insert_app_notification_deduped,
    purge_archived_staff_notifications, staff_ids_with_permission,
    upsert_app_notification_by_dedupe,
};
use crate::logic::tasks;
use crate::models::DbStaffRole;
use chrono::{Duration as ChronoDuration, NaiveDate, Timelike, Utc};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

fn env_archive_hours() -> i64 {
    std::env::var("RIVERSIDE_NOTIFICATION_ARCHIVE_HOURS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(24 * 30)
}

fn env_purge_hours() -> i64 {
    std::env::var("RIVERSIDE_NOTIFICATION_PURGE_HOURS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(24 * 400)
}

pub async fn run_notification_maintenance(pool: &PgPool) {
    let arch = env_archive_hours();
    match archive_stale_staff_notifications(pool, arch).await {
        Ok(n) if n > 0 => tracing::info!(rows = n, "notification archive pass"),
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "notification archive failed"),
    }
    let pur = env_purge_hours();
    match purge_archived_staff_notifications(pool, pur).await {
        Ok(n) if n > 0 => tracing::info!(rows = n, "notification purge pass"),
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "notification purge failed"),
    }
}

/// Staff IDs that should receive an order-scoped operational ping (admin or tied to the order).
async fn staff_for_order(pool: &PgPool, transaction_id: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid, DbStaffRole)> =
        sqlx::query_as(r#"SELECT id, role FROM staff WHERE is_active = TRUE"#)
            .fetch_all(pool)
            .await?;
    let mut out = Vec::new();
    let primary: Option<Uuid> =
        sqlx::query_scalar(r#"SELECT primary_salesperson_id FROM transactions WHERE id = $1"#)
            .bind(transaction_id)
            .fetch_optional(pool)
            .await?;

    for (id, role) in rows {
        let eff = crate::auth::permissions::effective_permissions_for_staff(pool, id, role).await?;
        if role == DbStaffRole::Admin || staff_has_permission(&eff, ORDERS_VIEW) {
            if role == DbStaffRole::Admin {
                out.push(id);
                continue;
            }
            if primary == Some(id) {
                out.push(id);
                continue;
            }
            let attributed: bool = sqlx::query_scalar(
                r#"SELECT EXISTS(SELECT 1 FROM transaction_lines WHERE transaction_id = $1 AND salesperson_id = $2)"#,
            )
            .bind(transaction_id)
            .bind(id)
            .fetch_one(pool)
            .await?;
            if attributed {
                out.push(id);
            }
        }
    }
    Ok(out)
}

async fn staff_for_alteration_order(
    pool: &PgPool,
    _alteration_id: Uuid,
    linked_transaction_id: Option<Uuid>,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid, DbStaffRole)> =
        sqlx::query_as(r#"SELECT id, role FROM staff WHERE is_active = TRUE"#)
            .fetch_all(pool)
            .await?;
    let mut out = Vec::new();
    for (id, role) in rows {
        let eff = crate::auth::permissions::effective_permissions_for_staff(pool, id, role).await?;
        if role == DbStaffRole::Admin || staff_has_permission(&eff, ALTERATIONS_MANAGE) {
            out.push(id);
            continue;
        }
        if let Some(oid) = linked_transaction_id {
            let attributed: bool = sqlx::query_scalar(
                r#"SELECT EXISTS(SELECT 1 FROM transaction_lines WHERE transaction_id = $1 AND salesperson_id = $2)"#,
            )
            .bind(oid)
            .bind(id)
            .fetch_one(pool)
            .await?;
            if attributed {
                out.push(id);
            }
        }
    }
    // Dedupe
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

pub async fn run_notification_generators(pool: &PgPool) -> Result<(), sqlx::Error> {
    run_morning_admin_digest(pool).await?;
    run_task_due_reminders(pool).await?;
    run_wedding_soon(pool).await?;
    run_stale_open_orders(pool).await?;
    run_pickup_stale(pool).await?;
    run_alteration_due(pool).await?;
    run_po_overdue_receive(pool).await?;
    run_po_direct_invoice_overdue(pool).await?;
    run_po_received_unlabeled(pool).await?;
    run_po_partial_receive_stale(pool).await?;
    run_po_draft_stale(pool).await?;
    run_po_submitted_no_expected_date(pool).await?;
    run_qbo_failed_reminder_sweep(pool).await?;
    run_backup_admin_notifications(pool).await?;
    run_integration_health_admin_notifications(pool).await?;
    run_counterpoint_sync_admin_notifications(pool).await?;
    run_appointment_soon_reminders(pool).await?;
    run_negative_available_stock_admin(pool).await?;
    run_pin_failure_security_digest(pool).await?;
    run_after_hours_access_digest(pool).await?;
    run_gift_card_expiring_reminders(pool).await?;
    run_special_order_ready_to_stage(pool).await?;
    run_messaging_and_reviews_unread_nudges(pool).await?;
    Ok(())
}

/// One reminder per stale Podium / review notification still unread after 18h (`dedupe_key` `unread_nudge:{source id}`).
pub async fn run_messaging_and_reviews_unread_nudges(pool: &PgPool) -> Result<(), sqlx::Error> {
    #[derive(sqlx::FromRow)]
    struct StaleUnread {
        id: Uuid,
        title: String,
        body: String,
        deep_link: Value,
    }
    let rows: Vec<StaleUnread> = sqlx::query_as(
        r#"
        SELECT an.id, an.title, an.body, an.deep_link
        FROM app_notification an
        WHERE an.created_at <= NOW() - INTERVAL '18 hours'
          AND (
            an.kind IN ('podium_sms_inbound', 'podium_email_inbound')
            OR an.kind LIKE 'review\_%' ESCAPE '\'
          )
          AND EXISTS (
            SELECT 1 FROM staff_notification sn
            WHERE sn.notification_id = an.id
              AND sn.read_at IS NULL
              AND sn.archived_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM app_notification an2
            WHERE an2.dedupe_key = ('unread_nudge:' || an.id::text)
          )
        LIMIT 40
        "#,
    )
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(());
    }

    let staff = staff_ids_with_permission(pool, NOTIFICATIONS_VIEW).await?;
    if staff.is_empty() {
        return Ok(());
    }

    for r in rows {
        let dedupe = format!("unread_nudge:{}", r.id);
        let title = format!("Still unread: {}", r.title);
        let body = if r.body.len() > 200 {
            format!("{}…", &r.body[..200])
        } else {
            r.body.clone()
        };
        if let Some(nid) = insert_app_notification_deduped(
            pool,
            "messaging_unread_nudge",
            &title,
            &body,
            r.deep_link.clone(),
            "notification_unread_sweep",
            json!({}),
            Some(dedupe.as_str()),
        )
        .await?
        {
            let _ = fan_out_to_staff_ids(pool, nid, &staff).await;
        }
    }
    Ok(())
}

fn env_backup_overdue_hours() -> i64 {
    std::env::var("RIVERSIDE_BACKUP_OVERDUE_HOURS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&h: &i64| h > 0 && h <= 720)
        .unwrap_or(30)
}

/// Admin-only: failed local backup, failed cloud export, or no successful local backup within threshold.
pub async fn run_backup_admin_notifications(pool: &PgPool) -> Result<(), sqlx::Error> {
    type HealthRow = (
        Option<chrono::DateTime<Utc>>,
        Option<chrono::DateTime<Utc>>,
        Option<String>,
        Option<chrono::DateTime<Utc>>,
        Option<chrono::DateTime<Utc>>,
        Option<String>,
    );
    let row: Option<HealthRow> = sqlx::query_as(
        r#"
        SELECT last_local_success_at, last_local_failure_at, last_local_failure_detail,
               last_cloud_success_at, last_cloud_failure_at, last_cloud_failure_detail
        FROM store_backup_health
        WHERE id = 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    let Some((loc_succ, loc_fail, loc_detail, cloud_succ, cloud_fail, cloud_detail)) = row else {
        return Ok(());
    };

    let settings_raw: Value =
        sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or(json!({}));
    let backup_cfg: BackupSettings = serde_json::from_value(settings_raw).unwrap_or_default();
    let cloud_enabled = backup_cfg.cloud_storage_enabled;

    let admins = admin_staff_ids(pool).await?;
    if admins.is_empty() {
        return Ok(());
    }
    let aud = morning_audience_json(&admins);

    let deep = json!({ "type": "settings", "section": "backups" });

    let local_in_bad_state = match (loc_fail, loc_succ) {
        (Some(f), Some(s)) => f > s,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if local_in_bad_state {
        if let Some(fail_at) = loc_fail {
            let dedupe = format!("backup_admin_local_failed:{}", fail_at.format("%Y-%m-%d"));
            let detail = loc_detail
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("Scheduled or manual backup failed.");
            let body = if detail.len() > 280 {
                format!("{}…", &detail[..279])
            } else {
                detail.to_string()
            };
            if let Some(nid) = insert_app_notification_deduped(
                pool,
                "backup_admin_local_failed",
                "Database backup failed",
                &body,
                deep.clone(),
                "generator",
                aud.clone(),
                Some(&dedupe),
            )
            .await?
            {
                fan_out_to_staff_ids(pool, nid, &admins).await?;
            }
        }
    }

    if cloud_enabled {
        let cloud_in_bad_state = match (cloud_fail, cloud_succ) {
            (Some(f), Some(s)) => f > s,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if cloud_in_bad_state {
            if let Some(fail_at) = cloud_fail {
                let dedupe = format!("backup_admin_cloud_failed:{}", fail_at.format("%Y-%m-%d"));
                let detail = cloud_detail
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Cloud upload after a successful local backup failed.");
                let body = if detail.len() > 280 {
                    format!("{}…", &detail[..279])
                } else {
                    detail.to_string()
                };
                if let Some(nid) = insert_app_notification_deduped(
                    pool,
                    "backup_admin_cloud_failed",
                    "Backup cloud export failed",
                    &body,
                    deep.clone(),
                    "generator",
                    aud.clone(),
                    Some(&dedupe),
                )
                .await?
                {
                    fan_out_to_staff_ids(pool, nid, &admins).await?;
                }
            }
        }
    }

    if let Some(succ) = loc_succ {
        if !local_in_bad_state {
            let threshold = ChronoDuration::hours(env_backup_overdue_hours());
            if succ < Utc::now() - threshold {
                let tz_name = load_store_timezone_name(pool).await?;
                let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
                let store_day_s = Utc::now()
                    .with_timezone(&tz)
                    .date_naive()
                    .format("%Y-%m-%d")
                    .to_string();
                let dedupe = format!("backup_admin_past_due:{store_day_s}");
                let hours = env_backup_overdue_hours();
                let title = "Backup overdue";
                let body = format!(
                    "Last successful local backup was more than {hours} hours ago. Open Data & Backups to run or inspect backups."
                );
                if let Some(nid) = insert_app_notification_deduped(
                    pool,
                    "backup_admin_past_due",
                    title,
                    &body,
                    deep,
                    "generator",
                    aud,
                    Some(&dedupe),
                )
                .await?
                {
                    fan_out_to_staff_ids(pool, nid, &admins).await?;
                }
            }
        }
    }

    Ok(())
}

fn env_morning_digest_hour_local() -> u32 {
    std::env::var("RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&h: &u32| h < 24)
        .unwrap_or(7)
}

async fn load_store_timezone_name(pool: &PgPool) -> Result<String, sqlx::Error> {
    let raw: Option<Value> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1 LIMIT 1")
            .fetch_optional(pool)
            .await?;

    let tz = raw
        .as_ref()
        .and_then(|v| v.get("timezone"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("America/New_York")
        .to_string();

    Ok(tz)
}

/// Claim the store-local calendar day for the admin morning digest (at most once per day).
async fn try_claim_morning_digest_day(
    pool: &PgPool,
    store_day: NaiveDate,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        r#"
        INSERT INTO morning_digest_ledger (store_day)
        VALUES ($1)
        ON CONFLICT (store_day) DO NOTHING
        "#,
    )
    .bind(store_day)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

fn morning_audience_json(admin_ids: &[Uuid]) -> Value {
    json!({
        "mode": "staff_ids",
        "staff_ids": admin_ids.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    })
}

/// One row inside `deep_link.items` for bundled notifications (client renders + navigates via `deep_link`).
fn bundle_row(title: String, subtitle: String, deep_link: Value) -> Value {
    json!({
        "title": title,
        "subtitle": subtitle,
        "deep_link": deep_link,
    })
}

async fn store_local_day_key(pool: &PgPool) -> Result<String, sqlx::Error> {
    let tz_name = load_store_timezone_name(pool).await?;
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
    Ok(Utc::now()
        .with_timezone(&tz)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string())
}

/// Admin-only digest: low stock (per tracked variant), weddings today, POs expected today,
/// alterations due today, refund queue summary. Runs once per store-local day after the configured hour.
pub async fn run_morning_admin_digest(pool: &PgPool) -> Result<(), sqlx::Error> {
    let tz_name = load_store_timezone_name(pool).await?;
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
    let local = Utc::now().with_timezone(&tz);
    let hour = local.hour();
    if hour < env_morning_digest_hour_local() {
        return Ok(());
    }

    let store_day = local.date_naive();
    if !try_claim_morning_digest_day(pool, store_day).await? {
        return Ok(());
    }

    let admins = admin_staff_ids(pool).await?;
    if admins.is_empty() {
        return Ok(());
    }

    let aud = morning_audience_json(&admins);
    let day_key = store_day.format("%Y-%m-%d").to_string();

    // --- Low stock: single bundled notification (expand for SKU list).
    let low_rows: Vec<(Uuid, Uuid, String, String, i32, i32)> = sqlx::query_as(
        r#"
        SELECT
            pv.id,
            p.id,
            pv.sku,
            p.name,
            (pv.stock_on_hand - pv.reserved_stock),
            pv.reorder_point
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE COALESCE(p.is_active, TRUE)
          AND p.track_low_stock = TRUE
          AND pv.track_low_stock = TRUE
          AND pv.reorder_point > 0
          AND (pv.stock_on_hand - pv.reserved_stock) <= pv.reorder_point
        ORDER BY p.name, pv.sku
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await?;

    let low_bundle_dedupe = format!("morning_low_stock_bundle:{day_key}");
    if low_rows.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &low_bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_low_stock'"#)
            .execute(pool)
            .await?;
    } else {
        let n = low_rows.len();
        let items: Vec<Value> = low_rows
            .into_iter()
            .map(|(_vid, pid, sku, pname, avail, rp)| {
                bundle_row(
                    sku.clone(),
                    format!("{pname} — {avail} available (reorder point {rp})"),
                    json!({
                        "type": "inventory",
                        "section": "list",
                        "product_id": pid.to_string(),
                    }),
                )
            })
            .collect();
        let title = format!("Low stock ({n} SKUs)");
        let body = format!(
            "{n} tracked variant(s) at or below reorder point. Expand to open each SKU in Inventory."
        );
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "morning_low_stock",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "morning_low_stock_bundle",
            &title,
            &body,
            deep,
            "generator",
            aud.clone(),
            &low_bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &admins).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_low_stock'"#)
            .execute(pool)
            .await?;
    }

    // --- Weddings with event date today
    let weddings: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT id, COALESCE(NULLIF(trim(party_name), ''), groom_name)
        FROM wedding_parties
        WHERE is_deleted = FALSE
          AND event_date IS NOT NULL
          AND event_date = $1::date
        LIMIT 100
        "#,
    )
    .bind(store_day)
    .fetch_all(pool)
    .await?;

    let wed_bundle_dedupe = format!("morning_wedding_today_bundle:{day_key}");
    if weddings.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &wed_bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_wedding_today'"#)
            .execute(pool)
            .await?;
    } else {
        let n = weddings.len();
        let items: Vec<Value> = weddings
            .into_iter()
            .map(|(pid, name)| {
                bundle_row(
                    name.clone(),
                    "Event today — open party".to_string(),
                    json!({ "type": "wedding_party", "party_id": pid.to_string() }),
                )
            })
            .collect();
        let title = format!("Weddings today ({n})");
        let body = format!("{n} wedding party(ies) on the calendar for today.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "morning_wedding_today",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "morning_wedding_today_bundle",
            &title,
            &body,
            deep,
            "generator",
            aud.clone(),
            &wed_bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &admins).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_wedding_today'"#)
            .execute(pool)
            .await?;
    }

    // --- POs with expected arrival date today (store-local)
    let pos: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT id, po_number
        FROM purchase_orders
        WHERE expected_at IS NOT NULL
          AND status NOT IN ('closed', 'cancelled')
          AND (expected_at AT TIME ZONE $1)::date = $2::date
        LIMIT 100
        "#,
    )
    .bind(&tz_name)
    .bind(store_day)
    .fetch_all(pool)
    .await?;

    let po_bundle_dedupe = format!("morning_po_expected_bundle:{day_key}");
    if pos.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &po_bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_po_expected'"#)
            .execute(pool)
            .await?;
    } else {
        let n = pos.len();
        let items: Vec<Value> = pos
            .into_iter()
            .map(|(poid, po_num)| {
                bundle_row(
                    format!("PO {po_num}"),
                    "Expected today — open receiving".to_string(),
                    json!({ "type": "purchase_order", "po_id": poid.to_string() }),
                )
            })
            .collect();
        let title = format!("POs expected today ({n})");
        let body = format!("{n} purchase order(s) scheduled to arrive today.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "morning_po_expected",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "morning_po_expected_bundle",
            &title,
            &body,
            deep,
            "generator",
            aud.clone(),
            &po_bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &admins).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_po_expected'"#)
            .execute(pool)
            .await?;
    }

    // --- Alterations due today
    let alts: Vec<(Uuid,)> = sqlx::query_as(
        r#"
        SELECT id
        FROM alteration_orders
        WHERE due_at IS NOT NULL
          AND status IN ('intake', 'in_work')
          AND (due_at AT TIME ZONE $1)::date = $2::date
        LIMIT 100
        "#,
    )
    .bind(&tz_name)
    .bind(store_day)
    .fetch_all(pool)
    .await?;

    let alt_bundle_dedupe = format!("morning_alteration_due_bundle:{day_key}");
    if alts.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &alt_bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_alteration_due'"#)
                .execute(pool)
                .await?;
    } else {
        let n = alts.len();
        let items: Vec<Value> = alts
            .into_iter()
            .map(|(aid,)| {
                bundle_row(
                    {
                        let s = aid.to_string();
                        format!("Alteration {}", s.chars().take(8).collect::<String>())
                    },
                    "Due today — open in Alterations".to_string(),
                    json!({ "type": "alteration", "alteration_id": aid.to_string() }),
                )
            })
            .collect();
        let title = format!("Alterations due today ({n})");
        let body = format!("{n} alteration(s) marked due today.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "morning_alteration_due",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "morning_alteration_due_bundle",
            &title,
            &body,
            deep,
            "generator",
            aud.clone(),
            &alt_bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &admins).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'morning_alteration_due'"#)
                .execute(pool)
                .await?;
    }

    // --- Refund queue summary (admin)
    let row: Option<(i64, rust_decimal::Decimal)> = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint, COALESCE(SUM(amount_due - amount_refunded), 0)::numeric
        FROM transaction_refund_queue
        WHERE is_open = TRUE
        "#,
    )
    .fetch_optional(pool)
    .await?;

    if let Some((cnt, amt)) = row {
        if cnt > 0 {
            let dedupe = format!("morning_refund_queue:{day_key}");
            let title = format!("Refund queue: {cnt} open");
            let body = format!(
                "Open refund queue rows totaling ${} still need processing.",
                amt.round_dp(2)
            );
            let deep = json!({ "type": "orders", "subsection": "open" });
            if let Some(nid) = insert_app_notification_deduped(
                pool,
                "morning_refund_queue",
                &title,
                &body,
                deep,
                "generator",
                aud.clone(),
                Some(&dedupe),
            )
            .await?
            {
                fan_out_to_staff_ids(pool, nid, &admins).await?;
            }
        }
    }

    Ok(())
}

async fn run_task_due_reminders(pool: &PgPool) -> Result<(), sqlx::Error> {
    let tz_name = load_store_timezone_name(pool).await?;
    let today = tasks::store_local_date(&tz_name);
    let tomorrow = today + ChronoDuration::days(1);
    let rows = tasks::open_instances_due_between(pool, today, tomorrow).await?;
    let day_key = store_local_day_key(pool).await?;
    let mut by_assignee: HashMap<Uuid, Vec<tasks::DueInstanceRow>> = HashMap::new();
    for r in rows {
        by_assignee.entry(r.assignee_staff_id).or_default().push(r);
    }

    let like_pat = format!("%:{day_key}");
    let _ = sqlx::query(
        r#"DELETE FROM app_notification WHERE kind = 'task_due_soon_bundle' AND dedupe_key LIKE $1"#,
    )
    .bind(&like_pat)
    .execute(pool)
    .await?;

    for (assignee_id, list) in by_assignee {
        let dedupe = format!("task_due_soon_bundle:{assignee_id}:{day_key}");
        let n = list.len();
        let items: Vec<Value> = list
            .into_iter()
            .map(|r| {
                let when = if r.due_date == today {
                    "today"
                } else {
                    "tomorrow"
                };
                bundle_row(
                    r.title_snapshot.clone(),
                    format!("Due {} ({})", when, r.due_date.format("%Y-%m-%d")),
                    json!({ "type": "staff_tasks", "instance_id": r.id.to_string() }),
                )
            })
            .collect();
        let title = format!("Tasks due soon ({n})");
        let body = format!("{n} open checklist item(s) due today or tomorrow.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "task_due_soon",
            "items": items,
        });
        let aud = json!({ "mode": "staff_ids", "staff_ids": [assignee_id.to_string()] });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "task_due_soon_bundle",
            &title,
            &body,
            deep,
            "generator",
            aud,
            &dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &[assignee_id]).await?;
    }
    let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'task_due_soon'"#)
        .execute(pool)
        .await?;
    Ok(())
}

async fn run_wedding_soon(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, WEDDINGS_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }
    let parties: Vec<(Uuid, String, chrono::NaiveDate)> = sqlx::query_as(
        r#"
        SELECT id, COALESCE(NULLIF(trim(party_name), ''), groom_name), event_date
        FROM wedding_parties
        WHERE is_deleted = FALSE
          AND event_date IS NOT NULL
          AND event_date >= CURRENT_DATE
          AND event_date <= (CURRENT_DATE + interval '14 days')::date
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("wedding_soon_bundle:{day_key}");
    if parties.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'wedding_soon'"#)
            .execute(pool)
            .await?;
    } else {
        let n = parties.len();
        let items: Vec<Value> = parties
            .into_iter()
            .map(|(pid, name, ed)| {
                bundle_row(
                    name,
                    format!("Event {ed}"),
                    json!({ "type": "wedding_party", "party_id": pid.to_string() }),
                )
            })
            .collect();
        let title = format!("Weddings in the next 14 days ({n})");
        let body = format!("{n} upcoming wedding party(ies) — expand to open each.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "wedding_soon",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "wedding_soon_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "weddings.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'wedding_soon'"#)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn run_stale_open_orders(pool: &PgPool) -> Result<(), sqlx::Error> {
    let orders: Vec<(Uuid,)> = sqlx::query_as(
        r#"
        SELECT id FROM transactions
        WHERE status = 'open'
          AND balance_due > 0
          AND created_at < (now() - interval '14 days')
        LIMIT 80
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("order_due_stale_bundle:{day_key}");
    if orders.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'order_due'"#)
            .execute(pool)
            .await?;
        return Ok(());
    }

    let mut staff_set: HashSet<Uuid> = HashSet::new();
    let mut items: Vec<Value> = Vec::with_capacity(orders.len());
    for (oid,) in orders {
        let staff = staff_for_order(pool, oid).await?;
        for s in staff {
            staff_set.insert(s);
        }
        let s = oid.to_string();
        let short = s.chars().take(8).collect::<String>();
        items.push(bundle_row(
            format!("Order …{short}"),
            "Open 14+ days with balance — open order".to_string(),
            json!({ "type": "order", "transaction_id": oid.to_string() }),
        ));
    }

    let n = items.len();
    let title = format!("Stale open orders with balance ({n})");
    let body = format!("{n} order(s) open over 14 days with balance due.");
    let deep = json!({
        "type": "notification_bundle",
        "bundle_kind": "order_due_stale",
        "items": items,
    });
    let mut targets: Vec<Uuid> = staff_set.into_iter().collect();
    targets.sort_unstable();
    if targets.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let nid = upsert_app_notification_by_dedupe(
        pool,
        "order_due_stale_bundle",
        &title,
        &body,
        deep,
        "generator",
        aud,
        &bundle_dedupe,
    )
    .await?;
    fan_out_to_staff_ids(pool, nid, &targets).await?;
    let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'order_due'"#)
        .execute(pool)
        .await?;
    Ok(())
}

async fn run_alteration_due(pool: &PgPool) -> Result<(), sqlx::Error> {
    let rows: Vec<(Uuid, Option<Uuid>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        r#"
        SELECT id, linked_transaction_id, due_at
        FROM alteration_orders
        WHERE status IN ('intake', 'in_work')
          AND due_at IS NOT NULL
          AND due_at <= (now() + interval '7 days')
        LIMIT 120
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("alteration_due_bundle:{day_key}");
    if rows.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'alteration_due'"#)
            .execute(pool)
            .await?;
        return Ok(());
    }

    let mut staff_set: HashSet<Uuid> = HashSet::new();
    let mut items: Vec<Value> = Vec::with_capacity(rows.len());
    for (aid, linked_transaction_id, due_at) in rows {
        let staff = staff_for_alteration_order(pool, aid, linked_transaction_id).await?;
        for s in staff {
            staff_set.insert(s);
        }
        let overdue = due_at < chrono::Utc::now();
        let label = if overdue { "Overdue" } else { "Due soon" };
        let aid_s = aid.to_string();
        let short = aid_s.chars().take(8).collect::<String>();
        items.push(bundle_row(
            format!("{label} · …{short}"),
            format!("Due {}", due_at.format("%Y-%m-%d")),
            json!({ "type": "alteration", "alteration_id": aid.to_string() }),
        ));
    }

    let n = items.len();
    let title = format!("Alterations due within 7 days ({n})");
    let body = format!("{n} open alteration(s) with an upcoming or past due date.");
    let deep = json!({
        "type": "notification_bundle",
        "bundle_kind": "alteration_due",
        "items": items,
    });
    let mut targets: Vec<Uuid> = staff_set.into_iter().collect();
    targets.sort_unstable();
    if targets.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let nid = upsert_app_notification_by_dedupe(
        pool,
        "alteration_due_bundle",
        &title,
        &body,
        deep,
        "generator",
        aud,
        &bundle_dedupe,
    )
    .await?;
    fan_out_to_staff_ids(pool, nid, &targets).await?;
    let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'alteration_due'"#)
        .execute(pool)
        .await?;
    Ok(())
}

/// Paid (or zero balance) open orders with unfulfilled lines sitting 7+ days (pickup follow-up).
async fn run_pickup_stale(pool: &PgPool) -> Result<(), sqlx::Error> {
    let orders: Vec<(Uuid,)> = sqlx::query_as(
        r#"
        SELECT o.id
        FROM transactions o
        WHERE o.status = 'open'
          AND o.balance_due < 0.01
          AND o.created_at < (now() - interval '7 days')
          AND EXISTS (
            SELECT 1
            FROM transaction_lines oi
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = o.id
              AND oi.is_fulfilled = FALSE
              AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
          )
        LIMIT 80
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("pickup_stale_bundle:{day_key}");
    if orders.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'pickup_stale'"#)
            .execute(pool)
            .await?;
        return Ok(());
    }

    let mut staff_set: HashSet<Uuid> = HashSet::new();
    let mut items: Vec<Value> = Vec::with_capacity(orders.len());
    for (oid,) in orders {
        let staff = staff_for_order(pool, oid).await?;
        for s in staff {
            staff_set.insert(s);
        }
        let s = oid.to_string();
        let short = s.chars().take(8).collect::<String>();
        items.push(bundle_row(
            format!("Pickup follow-up · …{short}"),
            "Paid/zero balance, unfulfilled 7+ days".to_string(),
            json!({ "type": "order", "transaction_id": oid.to_string() }),
        ));
    }

    let n = items.len();
    let title = format!("Pickup follow-up ({n})");
    let body =
        format!("{n} paid/zero-balance order(s) still have unfulfilled lines after 7+ days.");
    let deep = json!({
        "type": "notification_bundle",
        "bundle_kind": "pickup_stale",
        "items": items,
    });
    let mut targets: Vec<Uuid> = staff_set.into_iter().collect();
    targets.sort_unstable();
    if targets.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let nid = upsert_app_notification_by_dedupe(
        pool,
        "pickup_stale_bundle",
        &title,
        &body,
        deep,
        "generator",
        aud,
        &bundle_dedupe,
    )
    .await?;
    fan_out_to_staff_ids(pool, nid, &targets).await?;
    let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'pickup_stale'"#)
        .execute(pool)
        .await?;
    Ok(())
}

async fn run_po_overdue_receive(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, PROCUREMENT_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }

    let pos: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT po.id, po.po_number
        FROM purchase_orders po
        WHERE po.status NOT IN ('closed', 'cancelled', 'draft')
          AND po.po_kind = 'standard'
          AND po.expected_at IS NOT NULL
          AND po.expected_at < (now() - interval '3 days')
          AND po.fully_received_at IS NULL
        LIMIT 60
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("po_overdue_receive_bundle:{day_key}");
    if pos.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_overdue_receive'"#)
            .execute(pool)
            .await?;
    } else {
        let n = pos.len();
        let items: Vec<Value> = pos
            .into_iter()
            .map(|(po_id, po_number)| {
                bundle_row(
                    format!("PO {po_number}"),
                    "Overdue to receive (3+ days past expected)".to_string(),
                    json!({ "type": "purchase_order", "po_id": po_id.to_string() }),
                )
            })
            .collect();
        let title = format!("POs overdue to receive ({n})");
        let body = format!("{n} standard PO(s) past expected receipt by 3+ days.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "po_overdue_receive",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "po_overdue_receive_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "procurement.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_overdue_receive'"#)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn run_po_direct_invoice_overdue(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, PROCUREMENT_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }

    let pos: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT po.id, po.po_number
        FROM purchase_orders po
        WHERE po.status NOT IN ('closed', 'cancelled', 'draft')
          AND po.po_kind = 'direct_invoice'
          AND po.expected_at IS NOT NULL
          AND po.expected_at < (now() - interval '3 days')
          AND po.fully_received_at IS NULL
        LIMIT 40
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("po_direct_invoice_overdue_bundle:{day_key}");
    if pos.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_direct_invoice_overdue'"#)
                .execute(pool)
                .await?;
    } else {
        let n = pos.len();
        let items: Vec<Value> = pos
            .into_iter()
            .map(|(po_id, po_number)| {
                bundle_row(
                    format!("Direct invoice {po_number}"),
                    "Overdue — reconcile receipt".to_string(),
                    json!({ "type": "purchase_order", "po_id": po_id.to_string() }),
                )
            })
            .collect();
        let title = format!("Direct invoices overdue ({n})");
        let body = format!("{n} direct-invoice PO(s) past expected date by 3+ days.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "po_direct_invoice_overdue",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "po_direct_invoice_overdue_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "procurement.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_direct_invoice_overdue'"#)
                .execute(pool)
                .await?;
    }
    Ok(())
}

async fn run_po_received_unlabeled(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, PROCUREMENT_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }

    let rows: Vec<(Uuid, String, i64)> = sqlx::query_as(
        r#"
        SELECT po.id, po.po_number, COUNT(DISTINCT pv.id)::bigint
        FROM purchase_orders po
        INNER JOIN receiving_events re ON re.purchase_order_id = po.id
        INNER JOIN inventory_transactions it
            ON it.reference_table = 'receiving_events'
           AND it.reference_id = re.id
           AND it.tx_type = 'po_receipt'
        INNER JOIN product_variants pv ON pv.id = it.variant_id
        WHERE po.status NOT IN ('closed', 'cancelled')
          AND it.created_at >= (now() - interval '14 days')
          AND pv.shelf_labeled_at IS NULL
        GROUP BY po.id, po.po_number
        HAVING COUNT(DISTINCT pv.id) > 0
        LIMIT 40
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("po_received_unlabeled_bundle:{day_key}");
    if rows.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_received_unlabeled'"#)
            .execute(pool)
            .await?;
    } else {
        let n = rows.len();
        let items: Vec<Value> = rows
            .into_iter()
            .map(|(po_id, po_number, sku_n)| {
                bundle_row(
                    format!("Labels · PO {po_number}"),
                    format!("{sku_n} SKU(s) need shelf labels"),
                    json!({ "type": "purchase_order", "po_id": po_id.to_string() }),
                )
            })
            .collect();
        let title = format!("Shelf labels needed ({n} POs)");
        let body = format!("{n} PO(s) with unlabeled SKUs from recent receipts.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "po_received_unlabeled",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "po_received_unlabeled_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "procurement.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_received_unlabeled'"#)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn run_po_partial_receive_stale(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, PROCUREMENT_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }

    let pos: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT po.id, po.po_number
        FROM purchase_orders po
        WHERE po.status = 'partially_received'
          AND po.fully_received_at IS NULL
          AND (
            SELECT MAX(re.received_at)
            FROM receiving_events re
            WHERE re.purchase_order_id = po.id
          ) < (now() - interval '14 days')
        LIMIT 40
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("po_partial_receive_stale_bundle:{day_key}");
    if pos.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_partial_receive_stale'"#)
                .execute(pool)
                .await?;
    } else {
        let n = pos.len();
        let items: Vec<Value> = pos
            .into_iter()
            .map(|(po_id, po_number)| {
                bundle_row(
                    format!("Partial stalled · {po_number}"),
                    "No receiving activity 14+ days".to_string(),
                    json!({ "type": "purchase_order", "po_id": po_id.to_string() }),
                )
            })
            .collect();
        let title = format!("PO partial receive stalled ({n})");
        let body = format!("{n} partially received PO(s) idle 14+ days.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "po_partial_receive_stale",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "po_partial_receive_stale_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "procurement.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_partial_receive_stale'"#)
                .execute(pool)
                .await?;
    }
    Ok(())
}

async fn run_po_draft_stale(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, PROCUREMENT_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }

    let pos: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT id, po_number
        FROM purchase_orders
        WHERE status = 'draft'
          AND ordered_at < (now() - interval '21 days')
        LIMIT 40
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("po_draft_stale_bundle:{day_key}");
    if pos.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_draft_stale'"#)
            .execute(pool)
            .await?;
    } else {
        let n = pos.len();
        let items: Vec<Value> = pos
            .into_iter()
            .map(|(po_id, po_number)| {
                bundle_row(
                    format!("Stale draft · {po_number}"),
                    "Draft older than 21 days".to_string(),
                    json!({ "type": "purchase_order", "po_id": po_id.to_string() }),
                )
            })
            .collect();
        let title = format!("Stale PO drafts ({n})");
        let body = format!("{n} draft PO(s) over three weeks old.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "po_draft_stale",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "po_draft_stale_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "procurement.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'po_draft_stale'"#)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn run_po_submitted_no_expected_date(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, PROCUREMENT_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }

    let pos: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT id, po_number
        FROM purchase_orders
        WHERE status = 'submitted'
          AND expected_at IS NULL
          AND submitted_at IS NOT NULL
          AND submitted_at < (now() - interval '7 days')
        LIMIT 40
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("po_submitted_no_expected_bundle:{day_key}");
    if pos.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(
            r#"DELETE FROM app_notification WHERE kind = 'po_submitted_no_expected_date'"#,
        )
        .execute(pool)
        .await?;
    } else {
        let n = pos.len();
        let items: Vec<Value> = pos
            .into_iter()
            .map(|(po_id, po_number)| {
                bundle_row(
                    format!("Missing expected date · {po_number}"),
                    "Submitted 7+ days ago".to_string(),
                    json!({ "type": "purchase_order", "po_id": po_id.to_string() }),
                )
            })
            .collect();
        let title = format!("Submitted POs missing expected date ({n})");
        let body = format!("{n} submitted PO(s) still without expected_at after a week.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "po_submitted_no_expected_date",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "po_submitted_no_expected_date_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "procurement.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ = sqlx::query(
            r#"DELETE FROM app_notification WHERE kind = 'po_submitted_no_expected_date'"#,
        )
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn env_pin_failure_digest_threshold() -> i64 {
    std::env::var("RIVERSIDE_PIN_FAILURE_DIGEST_THRESHOLD")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n: &i64| (1..=1000).contains(&n))
        .unwrap_or(5)
}

fn counterpoint_bridge_configured() -> bool {
    std::env::var("COUNTERPOINT_SYNC_TOKEN")
        .ok()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Admin-only: QBO token refresh or weather finalize in a failed state (last failure newer than last success).
async fn run_integration_health_admin_notifications(pool: &PgPool) -> Result<(), sqlx::Error> {
    let admins = admin_staff_ids(pool).await?;
    if admins.is_empty() {
        return Ok(());
    }
    let aud = morning_audience_json(&admins);
    type Row = (
        String,
        Option<chrono::DateTime<Utc>>,
        Option<chrono::DateTime<Utc>>,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        r#"
        SELECT source, last_failure_at, last_success_at, detail
        FROM integration_alert_state
        WHERE last_failure_at IS NOT NULL
          AND (last_success_at IS NULL OR last_failure_at > last_success_at)
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("integration_health_failed_bundle:{day_key}");
    if rows.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'integration_health_failed'"#)
                .execute(pool)
                .await?;
        return Ok(());
    }

    let mut items: Vec<Value> = Vec::new();
    for (source, fail_at, _succ, detail) in rows {
        let Some(fail_at) = fail_at else {
            continue;
        };
        let (label, deep) = match source.as_str() {
            "qbo_token_refresh" => (
                "QuickBooks token refresh".to_string(),
                json!({ "type": "qbo", "section": "staging" }),
            ),
            "weather_finalize" => (
                "Weather snapshot finalize".to_string(),
                json!({ "type": "settings", "section": "general" }),
            ),
            _ => (
                format!("Integration: {source}"),
                json!({ "type": "settings", "section": "general" }),
            ),
        };
        let subtitle = detail
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                if s.len() > 160 {
                    format!("{}…", &s[..159])
                } else {
                    s.to_string()
                }
            })
            .unwrap_or_else(|| format!("Failed {}", fail_at.format("%Y-%m-%d %H:%M UTC")));
        items.push(bundle_row(label, subtitle, deep));
    }

    if items.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'integration_health_failed'"#)
                .execute(pool)
                .await?;
        return Ok(());
    }

    let n = items.len();
    let title = format!("Integration health alerts ({n})");
    let body = format!("{n} integration source(s) reporting failure. Expand to open each area.");
    let deep = json!({
        "type": "notification_bundle",
        "bundle_kind": "integration_health_failed",
        "items": items,
    });
    let nid = upsert_app_notification_by_dedupe(
        pool,
        "integration_health_failed_bundle",
        &title,
        &body,
        deep,
        "generator",
        aud,
        &bundle_dedupe,
    )
    .await?;
    fan_out_to_staff_ids(pool, nid, &admins).await?;
    let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'integration_health_failed'"#)
        .execute(pool)
        .await?;
    Ok(())
}

/// Admin-only: Counterpoint bridge errors or stale successful sync (when token is configured).
async fn run_counterpoint_sync_admin_notifications(pool: &PgPool) -> Result<(), sqlx::Error> {
    let admins = admin_staff_ids(pool).await?;
    if admins.is_empty() {
        return Ok(());
    }
    let aud = morning_audience_json(&admins);
    let cp_on = counterpoint_bridge_configured();
    let tz_name = load_store_timezone_name(pool).await?;
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
    let store_day = Utc::now()
        .with_timezone(&tz)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();

    type CounterpointSyncRunRow = (
        String,
        Option<chrono::DateTime<Utc>>,
        Option<String>,
        chrono::DateTime<Utc>,
    );
    let rows: Vec<CounterpointSyncRunRow> = sqlx::query_as(
        r#"
        SELECT entity, last_ok_at, last_error, updated_at
        FROM counterpoint_sync_runs
        "#,
    )
    .fetch_all(pool)
    .await?;

    let bundle_dedupe = format!("counterpoint_alerts_bundle:{store_day}");
    let mut items: Vec<Value> = Vec::new();
    for (entity, last_ok, last_error, _updated_at) in rows {
        if let Some(ref err) = last_error {
            if !err.trim().is_empty() {
                let sub = if err.len() > 160 {
                    format!("{}…", &err[..159])
                } else {
                    err.clone()
                };
                items.push(bundle_row(
                    format!("Counterpoint error · {entity}"),
                    sub,
                    json!({ "type": "inventory", "section": "list" }),
                ));
            }
        } else if cp_on {
            if let Some(ok) = last_ok {
                if ok < Utc::now() - ChronoDuration::hours(72) {
                    items.push(bundle_row(
                        format!("Counterpoint stale · {entity}"),
                        "No successful sync in 72+ hours".to_string(),
                        json!({ "type": "inventory", "section": "list" }),
                    ));
                }
            }
        }
    }

    if items.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(
            r#"DELETE FROM app_notification WHERE kind IN ('counterpoint_sync_error', 'counterpoint_sync_stale')"#,
        )
        .execute(pool)
        .await?;
    } else {
        let n = items.len();
        let title = format!("Counterpoint alerts ({n})");
        let body = format!("{n} Counterpoint entity alert(s). Expand for detail.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "counterpoint_alerts",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "counterpoint_alerts_bundle",
            &title,
            &body,
            deep,
            "generator",
            aud,
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &admins).await?;
        let _ = sqlx::query(
            r#"DELETE FROM app_notification WHERE kind IN ('counterpoint_sync_error', 'counterpoint_sync_stale')"#,
        )
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Store appointments starting within 48h (`weddings.view`).
async fn run_appointment_soon_reminders(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, WEDDINGS_VIEW).await?;
    if recipients.is_empty() {
        return Ok(());
    }
    let appts: Vec<(Uuid, chrono::DateTime<Utc>, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT id, starts_at, appointment_type, COALESCE(NULLIF(trim(customer_display_name), ''), NULLIF(trim(phone), ''))
        FROM wedding_appointments
        WHERE starts_at > NOW()
          AND starts_at <= NOW() + INTERVAL '48 hours'
          AND lower(trim(status)) NOT IN ('cancelled', 'canceled', 'no_show')
        ORDER BY starts_at
        LIMIT 200
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("appointment_soon_bundle:{day_key}");
    if appts.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'appointment_soon'"#)
            .execute(pool)
            .await?;
    } else {
        let n = appts.len();
        let items: Vec<Value> = appts
            .into_iter()
            .map(|(_id, starts_at, appt_type, who)| {
                let label = who.unwrap_or_else(|| "Walk-in / unnamed".to_string());
                bundle_row(
                    appt_type,
                    format!("{} — {}", label, starts_at.format("%Y-%m-%d %H:%M UTC")),
                    json!({ "type": "appointments", "section": "scheduler" }),
                )
            })
            .collect();
        let title = format!("Appointments in the next 48h ({n})");
        let body = format!("{n} upcoming store appointment(s).");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "appointment_soon",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "appointment_soon_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "weddings.view" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'appointment_soon'"#)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Negative available stock (admin + catalog editors) — one bundled inbox row per store day.
async fn run_negative_available_stock_admin(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut admins = admin_staff_ids(pool).await?;
    let mut editors = staff_ids_with_permission(pool, CATALOG_EDIT).await?;
    admins.append(&mut editors);
    admins.sort_unstable();
    admins.dedup();
    let tz_name = load_store_timezone_name(pool).await?;
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
    let day_key = Utc::now()
        .with_timezone(&tz)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let bundle_dedupe = format!("negative_available_stock_bundle:{day_key}");

    if admins.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'negative_available_stock'"#)
                .execute(pool)
                .await?;
        return Ok(());
    }

    let rows: Vec<(Uuid, Uuid, String, String, i32, i32)> = sqlx::query_as(
        r#"
        SELECT pv.id, p.id, pv.sku, p.name,
               (pv.stock_on_hand - COALESCE(pv.reserved_stock, 0)),
               pv.stock_on_hand
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE COALESCE(p.is_active, TRUE)
          AND (pv.stock_on_hand - COALESCE(pv.reserved_stock, 0)) < 0
        ORDER BY p.name, pv.sku
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'negative_available_stock'"#)
                .execute(pool)
                .await?;
        return Ok(());
    }

    let aud = morning_audience_json(&admins);
    let n = rows.len();
    let items: Vec<Value> = rows
        .into_iter()
        .map(
            |(_variant_id, product_id, sku, product_name, available, on_hand)| {
                bundle_row(
                    sku.clone(),
                    format!("{product_name} — available {available} (on hand {on_hand})"),
                    json!({
                        "type": "inventory",
                        "section": "list",
                        "product_id": product_id.to_string(),
                    }),
                )
            },
        )
        .collect();

    let title = format!("Negative available stock ({n} SKUs)");
    let body = format!(
        "{n} active variant(s) have available quantity below zero (reservations exceed on-hand). Expand the notification to open each SKU in Inventory, or go to Inventory to reconcile."
    );
    let deep = json!({
        "type": "notification_bundle",
        "bundle_kind": "negative_available_stock",
        "items": items,
    });

    let nid = upsert_app_notification_by_dedupe(
        pool,
        "negative_available_stock_bundle",
        &title,
        &body,
        deep,
        "generator",
        aud,
        &bundle_dedupe,
    )
    .await?;
    fan_out_to_staff_ids(pool, nid, &admins).await?;
    // Legacy: one row per SKU (pre-bundle). Remove so inboxes keep a single bundle.
    let _ = sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'negative_available_stock'"#)
        .execute(pool)
        .await?;
    Ok(())
}

/// Admin digest when PIN mismatches spike in the rolling hour.
async fn run_pin_failure_security_digest(pool: &PgPool) -> Result<(), sqlx::Error> {
    let admins = admin_staff_ids(pool).await?;
    if admins.is_empty() {
        return Ok(());
    }
    let n: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM staff_auth_failure_event
        WHERE created_at > NOW() - INTERVAL '1 hour'
        "#,
    )
    .fetch_one(pool)
    .await?;

    let th = env_pin_failure_digest_threshold();
    if n < th {
        return Ok(());
    }

    let tz_name = load_store_timezone_name(pool).await?;
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
    let hour_bucket = Utc::now()
        .with_timezone(&tz)
        .format("%Y-%m-%d-%H")
        .to_string();
    let dedupe = format!("pin_failure_digest:{hour_bucket}");
    let title = "PIN verification failures (1h)";
    let body = format!(
        "{n} failed PIN attempt(s) in the last hour. Review staff devices and PIN hygiene."
    );
    let deep = json!({ "type": "staff", "section": "audit" });
    let aud = morning_audience_json(&admins);
    if let Some(nid) = insert_app_notification_deduped(
        pool,
        "pin_failure_digest",
        title,
        &body,
        deep,
        "generator",
        aud,
        Some(&dedupe),
    )
    .await?
    {
        fan_out_to_staff_ids(pool, nid, &admins).await?;
    }
    Ok(())
}

/// Admin digest: audit events logged between 22:00–06:00 store-local (rolling 18h window).
async fn run_after_hours_access_digest(pool: &PgPool) -> Result<(), sqlx::Error> {
    let admins = admin_staff_ids(pool).await?;
    if admins.is_empty() {
        return Ok(());
    }
    let tz_name = load_store_timezone_name(pool).await?;
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);

    let rows: Vec<(chrono::DateTime<Utc>,)> = sqlx::query_as(
        r#"
        SELECT created_at FROM staff_access_log
        WHERE created_at > NOW() - INTERVAL '18 hours'
        ORDER BY created_at DESC
        LIMIT 2000
        "#,
    )
    .fetch_all(pool)
    .await?;

    let after_hours_n = rows
        .iter()
        .filter(|(at,)| {
            let h = at.with_timezone(&tz).hour();
            !(6..22).contains(&h)
        })
        .count();

    if after_hours_n == 0 {
        return Ok(());
    }

    let store_day = Utc::now()
        .with_timezone(&tz)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let dedupe = format!("after_hours_access_digest:{store_day}");
    let title = "After-hours staff activity";
    let body = format!(
        "{after_hours_n} staff audit event(s) between 10pm–6am local in the last 18 hours."
    );
    let deep = json!({ "type": "staff", "section": "audit" });
    let aud = morning_audience_json(&admins);
    if let Some(nid) = insert_app_notification_deduped(
        pool,
        "after_hours_access_digest",
        title,
        &body,
        deep,
        "generator",
        aud,
        Some(&dedupe),
    )
    .await?
    {
        fan_out_to_staff_ids(pool, nid, &admins).await?;
    }
    Ok(())
}

/// Gift cards expiring within 30 days with balance (`gift_cards.manage`).
async fn run_gift_card_expiring_reminders(pool: &PgPool) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, GIFT_CARDS_MANAGE).await?;
    if recipients.is_empty() {
        return Ok(());
    }

    let rows: Vec<(Uuid, chrono::DateTime<Utc>, Decimal)> = sqlx::query_as(
        r#"
        SELECT id, expires_at, current_balance
        FROM gift_cards
        WHERE card_status = 'active'
          AND current_balance > 0
          AND expires_at > NOW()
          AND expires_at <= NOW() + INTERVAL '30 days'
        ORDER BY expires_at
        LIMIT 200
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("gift_card_expiring_bundle:{day_key}");
    if rows.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'gift_card_expiring_soon'"#)
                .execute(pool)
                .await?;
    } else {
        let n = rows.len();
        let items: Vec<Value> = rows
            .into_iter()
            .map(|(gid, exp, bal)| {
                let exp_s = exp.format("%Y-%m-%d").to_string();
                bundle_row(
                    format!(
                        "Card {}",
                        gid.to_string().chars().take(8).collect::<String>()
                    ),
                    format!("Expires {exp_s} — balance ${}", bal.round_dp(2)),
                    json!({ "type": "gift-cards", "section": "inventory" }),
                )
            })
            .collect();
        let title = format!("Gift cards expiring within 30 days ({n})");
        let body = format!("{n} active card(s) with balance expiring soon.");
        let deep = json!({
            "type": "notification_bundle",
            "bundle_kind": "gift_card_expiring_soon",
            "items": items,
        });
        let nid = upsert_app_notification_by_dedupe(
            pool,
            "gift_card_expiring_soon_bundle",
            &title,
            &body,
            deep,
            "generator",
            json!({ "mode": "permission", "key": "gift_cards.manage" }),
            &bundle_dedupe,
        )
        .await?;
        fan_out_to_staff_ids(pool, nid, &recipients).await?;
        let _ =
            sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'gift_card_expiring_soon'"#)
                .execute(pool)
                .await?;
    }
    Ok(())
}

/// Special / wedding / custom order lines with enough on-hand to stage pickup.
async fn run_special_order_ready_to_stage(pool: &PgPool) -> Result<(), sqlx::Error> {
    let transaction_ids: Vec<(Uuid, i64)> = sqlx::query_as(
        r#"
        SELECT o.id, COUNT(*)::bigint
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        WHERE oi.is_fulfilled = FALSE
          AND o.status IN ('open', 'pending_measurement')
          AND oi.fulfillment IN ('special_order', 'wedding_order', 'custom')
          AND (pv.stock_on_hand - COALESCE(pv.reserved_stock, 0)) >= oi.quantity
        GROUP BY o.id
        ORDER BY o.booked_at DESC
        LIMIT 60
        "#,
    )
    .fetch_all(pool)
    .await?;

    let day_key = store_local_day_key(pool).await?;
    let bundle_dedupe = format!("special_order_ready_to_stage_bundle:{day_key}");
    if transaction_ids.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        let _ = sqlx::query(
            r#"DELETE FROM app_notification WHERE kind = 'special_order_ready_to_stage'"#,
        )
        .execute(pool)
        .await?;
        return Ok(());
    }

    let mut staff_set: HashSet<Uuid> = HashSet::new();
    let mut items: Vec<Value> = Vec::with_capacity(transaction_ids.len());
    for (oid, nlines) in transaction_ids {
        let staff = staff_for_order(pool, oid).await?;
        for s in staff {
            staff_set.insert(s);
        }
        let s = oid.to_string();
        let short = s.chars().take(8).collect::<String>();
        items.push(bundle_row(
            format!("Order …{short}"),
            format!("{nlines} special line(s) ready to stage"),
            json!({ "type": "order", "transaction_id": oid.to_string() }),
        ));
    }

    let n = items.len();
    let title = format!("Orders ready to stage ({n})");
    let body = format!("{n} order(s) have in-stock special/wedding lines to fulfill.");
    let deep = json!({
        "type": "notification_bundle",
        "bundle_kind": "special_order_ready_to_stage",
        "items": items,
    });
    let mut targets: Vec<Uuid> = staff_set.into_iter().collect();
    targets.sort_unstable();
    if targets.is_empty() {
        let _ = delete_app_notification_by_dedupe(pool, &bundle_dedupe).await?;
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let nid = upsert_app_notification_by_dedupe(
        pool,
        "special_order_ready_to_stage_bundle",
        &title,
        &body,
        deep,
        "generator",
        aud,
        &bundle_dedupe,
    )
    .await?;
    fan_out_to_staff_ids(pool, nid, &targets).await?;
    let _ =
        sqlx::query(r#"DELETE FROM app_notification WHERE kind = 'special_order_ready_to_stage'"#)
            .execute(pool)
            .await?;
    Ok(())
}

/// Re-emit QBO failure notifications; `dedupe_key` skips rows already in the inbox pipeline.
async fn run_qbo_failed_reminder_sweep(pool: &PgPool) -> Result<(), sqlx::Error> {
    let rows: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        r#"
        SELECT id, error_message
        FROM qbo_sync_logs
        WHERE status = 'failed'
          AND updated_at > (now() - interval '30 days')
        ORDER BY updated_at DESC
        LIMIT 40
        "#,
    )
    .fetch_all(pool)
    .await?;

    for (id, err) in rows {
        let msg = err
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("QBO sync failed");
        if let Err(e) = emit_qbo_sync_failed(pool, id, msg).await {
            tracing::error!(error = %e, sync_log_id = %id, "emit_qbo_sync_failed sweep");
        }
    }
    Ok(())
}
