//! PostgreSQL-backed notifications: canonical `app_notification` + per-staff inbox.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::permissions::{
    self, staff_has_permission, CATALOG_EDIT, CUSTOMERS_MERGE, INSIGHTS_COMMISSION_FINALIZE,
    NUORDER_SYNC, ORDERS_VIEW, QBO_VIEW, REGISTER_REPORTS,
};
use crate::models::DbStaffRole;

#[derive(Debug, Clone, Serialize)]
pub struct NotificationListItem {
    pub staff_notification_id: Uuid,
    pub notification_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub deep_link: Value,
    pub source: String,
    pub read_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BroadcastAudience {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub staff_ids: Vec<Uuid>,
}

/// Insert a canonical row; returns `None` if `dedupe_key` conflict (already exists).
#[allow(clippy::too_many_arguments)]
pub async fn insert_app_notification_deduped(
    pool: &PgPool,
    kind: &str,
    title: &str,
    body: &str,
    deep_link: Value,
    source: &str,
    audience_json: Value,
    dedupe_key: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    if let Some(dk) = dedupe_key.filter(|s| !s.is_empty()) {
        let id: Option<Uuid> = sqlx::query_scalar(
            r#"
            INSERT INTO app_notification (kind, title, body, deep_link, source, audience_json, dedupe_key)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
            RETURNING id
            "#,
        )
        .bind(kind)
        .bind(title)
        .bind(body)
        .bind(&deep_link)
        .bind(source)
        .bind(&audience_json)
        .bind(dk)
        .fetch_optional(pool)
        .await?
        .flatten();
        return Ok(id);
    }

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO app_notification (kind, title, body, deep_link, source, audience_json, dedupe_key)
        VALUES ($1, $2, $3, $4, $5, $6, NULL)
        RETURNING id
        "#,
    )
    .bind(kind)
    .bind(title)
    .bind(body)
    .bind(&deep_link)
    .bind(source)
    .bind(&audience_json)
    .fetch_one(pool)
    .await?;
    Ok(Some(id))
}

/// Insert or refresh a canonical row keyed by `dedupe_key` (partial unique index).
#[allow(clippy::too_many_arguments)]
pub async fn upsert_app_notification_by_dedupe(
    pool: &PgPool,
    kind: &str,
    title: &str,
    body: &str,
    deep_link: Value,
    source: &str,
    audience_json: Value,
    dedupe_key: &str,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        INSERT INTO app_notification (kind, title, body, deep_link, source, audience_json, dedupe_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
        DO UPDATE SET
            kind = EXCLUDED.kind,
            title = EXCLUDED.title,
            body = EXCLUDED.body,
            deep_link = EXCLUDED.deep_link
        RETURNING id
        "#,
    )
    .bind(kind)
    .bind(title)
    .bind(body)
    .bind(&deep_link)
    .bind(source)
    .bind(&audience_json)
    .bind(dedupe_key)
    .fetch_one(pool)
    .await
}

/// Incremental bundle: if unread notification exists for `dedupe_key`, append to its `deep_link.items`.
/// Automatically sets kind="notification_bundle" and builds a "N items" title.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_bundle_item(
    pool: &PgPool,
    bundle_kind: &str,
    bundle_title_prefix: &str,
    item_title: &str,
    item_subtitle: &str,
    item_deep_link: Value,
    source: &str,
    audience: Value,
    dedupe_key: &str,
) -> Result<Uuid, sqlx::Error> {
    let existing: Option<(Uuid, Value)> = sqlx::query_as(
        r#"SELECT id, deep_link FROM app_notification WHERE dedupe_key = $1 LIMIT 1"#,
    )
    .bind(dedupe_key)
    .fetch_optional(pool)
    .await?;

    let mut items = if let Some((_, ref dl)) = existing {
        dl.get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        vec![]
    };

    items.push(json!({
        "title": item_title,
        "subtitle": item_subtitle,
        "deep_link": item_deep_link,
    }));

    let n = items.len();
    let title = if n == 1 {
        format!("{bundle_title_prefix}: {item_title}")
    } else {
        format!("{bundle_title_prefix} ({n} items)")
    };
    let body = format!("You have {n} pending updates. Expand to view all.");

    let deep = json!({
        "type": "notification_bundle",
        "bundle_kind": bundle_kind,
        "items": items,
    });

    upsert_app_notification_by_dedupe(
        pool,
        "notification_bundle",
        &title,
        &body,
        deep,
        source,
        audience,
        dedupe_key,
    )
    .await
}

/// Remove a canonical notification (inbox rows cascade).
pub async fn delete_app_notification_by_dedupe(
    pool: &PgPool,
    dedupe_key: &str,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(r#"DELETE FROM app_notification WHERE dedupe_key = $1"#)
        .bind(dedupe_key)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn fan_out_to_staff_ids(
    pool: &PgPool,
    notification_id: Uuid,
    staff_ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    for sid in staff_ids {
        sqlx::query(
            r#"
            INSERT INTO staff_notification (notification_id, staff_id)
            VALUES ($1, $2)
            ON CONFLICT (notification_id, staff_id) DO NOTHING
            "#,
        )
        .bind(notification_id)
        .bind(sid)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn staff_ids_with_permission(pool: &PgPool, key: &str) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid, DbStaffRole)> =
        sqlx::query_as(r#"SELECT id, role FROM staff WHERE is_active = TRUE"#)
            .fetch_all(pool)
            .await?;
    let mut out = Vec::new();
    for (id, role) in rows {
        let eff = permissions::effective_permissions_for_staff(pool, id, role).await?;
        if staff_has_permission(&eff, key) {
            out.push(id);
        }
    }
    Ok(out)
}

pub async fn all_active_staff_ids(pool: &PgPool) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(r#"SELECT id FROM staff WHERE is_active = TRUE"#)
        .fetch_all(pool)
        .await
}

pub async fn admin_staff_ids(pool: &PgPool) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        r#"SELECT id FROM staff WHERE is_active = TRUE AND role = 'admin'"#,
    )
    .fetch_all(pool)
    .await
}

fn dedupe_sorted(mut ids: Vec<Uuid>) -> Vec<Uuid> {
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Admin + staff tied to an order (same rules as notification generators).
pub async fn staff_ids_for_order_scoped(
    pool: &PgPool,
    transaction_id: Uuid,
) -> Result<Vec<Uuid>, sqlx::Error> {
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
        let eff = permissions::effective_permissions_for_staff(pool, id, role).await?;
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
    Ok(dedupe_sorted(out))
}

/// Resolve broadcast audience to staff UUIDs (must still have `notifications.view` to use the API).
pub async fn resolve_broadcast_audience(
    pool: &PgPool,
    audience: &BroadcastAudience,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let mode = audience.mode.trim();
    let mode = if mode.is_empty() { "all_staff" } else { mode };
    match mode {
        "all_staff" => all_active_staff_ids(pool).await,
        "roles" => {
            if audience.roles.is_empty() {
                return Ok(vec![]);
            }
            let mut set = std::collections::HashSet::new();
            for r in &audience.roles {
                let role_db = match r.as_str() {
                    "admin" => Some(DbStaffRole::Admin),
                    "salesperson" => Some(DbStaffRole::Salesperson),
                    "sales_support" => Some(DbStaffRole::SalesSupport),
                    _ => None,
                };
                let Some(role_db) = role_db else {
                    continue;
                };
                let ids: Vec<Uuid> = sqlx::query_scalar(
                    r#"SELECT id FROM staff WHERE is_active = TRUE AND role = $1"#,
                )
                .bind(role_db)
                .fetch_all(pool)
                .await?;
                for id in ids {
                    set.insert(id);
                }
            }
            Ok(set.into_iter().collect())
        }
        "staff_ids" => Ok(audience.staff_ids.clone()),
        _ => Ok(vec![]),
    }
}

pub async fn list_inbox_for_staff(
    pool: &PgPool,
    staff_id: Uuid,
    include_archived: bool,
    kinds: Option<&str>,
    limit: i64,
) -> Result<Vec<NotificationListItem>, sqlx::Error> {
    let limit = limit.clamp(1, 200);
    let kind_filter = kinds
        .map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty());

    type InboxListSqlRow = (
        Uuid,
        Uuid,
        DateTime<Utc>,
        String,
        String,
        String,
        Value,
        String,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
    );
    let rows: Vec<InboxListSqlRow> = if let Some(ref ks) = kind_filter {
        sqlx::query_as(
            r#"
            SELECT
                sn.id,
                an.id,
                an.created_at,
                an.kind,
                an.title,
                an.body,
                an.deep_link,
                an.source,
                sn.read_at,
                sn.completed_at,
                sn.archived_at
            FROM staff_notification sn
            JOIN app_notification an ON an.id = sn.notification_id
            WHERE sn.staff_id = $1
              AND ($2::bool OR sn.archived_at IS NULL)
              AND an.kind = ANY($3)
            ORDER BY an.created_at DESC
            LIMIT $4
            "#,
        )
        .bind(staff_id)
        .bind(include_archived)
        .bind(ks)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            r#"
            SELECT
                sn.id,
                an.id,
                an.created_at,
                an.kind,
                an.title,
                an.body,
                an.deep_link,
                an.source,
                sn.read_at,
                sn.completed_at,
                sn.archived_at
            FROM staff_notification sn
            JOIN app_notification an ON an.id = sn.notification_id
            WHERE sn.staff_id = $1
              AND ($2::bool OR sn.archived_at IS NULL)
            ORDER BY an.created_at DESC
            LIMIT $3
            "#,
        )
        .bind(staff_id)
        .bind(include_archived)
        .bind(limit)
        .fetch_all(pool)
        .await?
    };

    Ok(rows
        .into_iter()
        .map(
            |(
                staff_notification_id,
                notification_id,
                created_at,
                kind,
                title,
                body,
                deep_link,
                source,
                read_at,
                completed_at,
                archived_at,
            )| NotificationListItem {
                staff_notification_id,
                notification_id,
                created_at,
                kind,
                title,
                body,
                deep_link,
                source,
                read_at,
                completed_at,
                archived_at,
            },
        )
        .collect())
}

pub async fn unread_count_for_staff(pool: &PgPool, staff_id: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM staff_notification sn
        WHERE sn.staff_id = $1
          AND sn.read_at IS NULL
          AND sn.archived_at IS NULL
        "#,
    )
    .bind(staff_id)
    .fetch_one(pool)
    .await
}

/// Unread rows for Podium inbound SMS/email (Operations → Inbox), excluding other notification kinds.
pub async fn unread_podium_inbox_count_for_staff(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM staff_notification sn
        JOIN app_notification an ON an.id = sn.notification_id
        WHERE sn.staff_id = $1
          AND sn.read_at IS NULL
          AND sn.archived_at IS NULL
          AND an.kind IN ('podium_sms_inbound', 'podium_email_inbound')
        "#,
    )
    .bind(staff_id)
    .fetch_one(pool)
    .await
}

async fn log_action(
    pool: &PgPool,
    staff_notification_id: Uuid,
    actor_staff_id: Uuid,
    action: &str,
    metadata: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO staff_notification_action (staff_notification_id, actor_staff_id, action, metadata)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(staff_notification_id)
    .bind(actor_staff_id)
    .bind(action)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark every non-archived inbox row for this canonical notification as read (shared dismiss).
pub async fn mark_read_for_all_recipients(
    pool: &PgPool,
    notification_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        r#"
        UPDATE staff_notification
        SET read_at = COALESCE(read_at, NOW())
        WHERE notification_id = $1 AND archived_at IS NULL AND read_at IS NULL
        "#,
    )
    .bind(notification_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

pub async fn mark_read(
    pool: &PgPool,
    staff_notification_id: Uuid,
    actor_staff_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        r#"
        UPDATE staff_notification
        SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND staff_id = $2 AND archived_at IS NULL
        "#,
    )
    .bind(staff_notification_id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(false);
    }
    log_action(
        pool,
        staff_notification_id,
        actor_staff_id,
        "read",
        json!({}),
    )
    .await?;
    Ok(true)
}

pub async fn mark_complete(
    pool: &PgPool,
    staff_notification_id: Uuid,
    actor_staff_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        r#"
        UPDATE staff_notification
        SET
            completed_at = COALESCE(completed_at, now()),
            read_at = COALESCE(read_at, now())
        WHERE id = $1 AND staff_id = $2 AND archived_at IS NULL
        "#,
    )
    .bind(staff_notification_id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(false);
    }
    log_action(
        pool,
        staff_notification_id,
        actor_staff_id,
        "completed",
        json!({}),
    )
    .await?;
    Ok(true)
}

pub async fn archive_for_staff(
    pool: &PgPool,
    staff_notification_id: Uuid,
    actor_staff_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        r#"
        UPDATE staff_notification sn
        SET
            archived_at = now(),
            compact_summary = LEFT(an.title, 240)
        FROM app_notification an
        WHERE sn.notification_id = an.id
          AND sn.id = $1
          AND sn.staff_id = $2
          AND sn.archived_at IS NULL
        "#,
    )
    .bind(staff_notification_id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(false);
    }
    log_action(
        pool,
        staff_notification_id,
        actor_staff_id,
        "archived",
        json!({}),
    )
    .await?;
    Ok(true)
}

/// Archive inbox rows whose canonical notification is older than `archive_hours` (default 30d via caller).
pub async fn archive_stale_staff_notifications(
    pool: &PgPool,
    archive_hours: i64,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        r#"
        UPDATE staff_notification sn
        SET
            archived_at = now(),
            compact_summary = LEFT(an.title, 240)
        FROM app_notification an
        WHERE sn.notification_id = an.id
          AND sn.archived_at IS NULL
          AND an.created_at < (now() - ($1::bigint * interval '1 hour'))
        "#,
    )
    .bind(archive_hours)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Purge very old archived rows (default 365d+ slack via caller).
pub async fn purge_archived_staff_notifications(
    pool: &PgPool,
    purge_hours: i64,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        r#"
        DELETE FROM staff_notification sn
        WHERE sn.archived_at IS NOT NULL
          AND sn.archived_at < (now() - ($1::bigint * interval '1 hour'))
        "#,
    )
    .bind(purge_hours)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

// --- Event emitters (generators / hooks) ---

pub async fn emit_qbo_sync_failed(
    pool: &PgPool,
    sync_log_id: Uuid,
    error_message: &str,
) -> Result<(), sqlx::Error> {
    let title = "QuickBooks sync failed";
    let body = if error_message.len() > 500 {
        format!("{}…", &error_message[..497])
    } else {
        error_message.to_string()
    };
    let dedupe = format!("qbo_failed:{sync_log_id}");
    let deep = json!({ "type": "qbo_staging", "sync_log_id": sync_log_id.to_string() });
    let Some(nid) = insert_app_notification_deduped(
        pool,
        "qbo_sync_failed",
        title,
        &body,
        deep,
        "system",
        json!({ "mode": "permission", "key": "qbo.view" }),
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    let staff = staff_ids_with_permission(pool, QBO_VIEW).await?;
    fan_out_to_staff_ids(pool, nid, &staff).await
}

pub async fn emit_register_cash_discrepancy(
    pool: &PgPool,
    session_id: Uuid,
    discrepancy_cents_display: &str,
) -> Result<(), sqlx::Error> {
    let dedupe = format!("register_cash_discrepancy:{session_id}");
    let title = "Register cash over/short";
    let body = format!(
        "A register session closed with a non-zero cash discrepancy ({discrepancy_cents_display}). Review Z-report / session history."
    );
    let deep = json!({ "type": "register" });
    let mut admins = admin_staff_ids(pool).await?;
    let mut reports = staff_ids_with_permission(pool, REGISTER_REPORTS).await?;
    admins.append(&mut reports);
    let targets = dedupe_sorted(admins);
    if targets.is_empty() {
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let Some(nid) = insert_app_notification_deduped(
        pool,
        "register_cash_discrepancy",
        title,
        &body,
        deep,
        "system",
        aud,
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    fan_out_to_staff_ids(pool, nid, &targets).await
}

pub async fn emit_catalog_import_rows_skipped(
    pool: &PgPool,
    actor_staff_id: Uuid,
    rows_skipped: i32,
    products_created: i32,
    products_updated: i32,
    variants_synced: i32,
) -> Result<(), sqlx::Error> {
    let dedupe = format!(
        "catalog_import_skipped:{}:{}",
        actor_staff_id,
        Utc::now().format("%Y-%m-%d-%H")
    );
    let title = "Catalog import finished with skipped rows";
    let body = format!(
        "Import completed with {rows_skipped} row(s) skipped. Created {products_created}, updated {products_updated}, variants synced {variants_synced}. Review the import file and catalog."
    );
    let deep = json!({ "type": "inventory", "section": "import" });
    let mut admins = admin_staff_ids(pool).await?;
    let mut editors = staff_ids_with_permission(pool, CATALOG_EDIT).await?;
    admins.append(&mut editors);
    let targets = dedupe_sorted(admins);
    if targets.is_empty() {
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let Some(nid) = insert_app_notification_deduped(
        pool,
        "catalog_import_rows_skipped",
        title,
        &body,
        deep,
        "system",
        aud,
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    fan_out_to_staff_ids(pool, nid, &targets).await
}

pub async fn emit_customer_merge_completed(
    pool: &PgPool,
    actor_staff_id: Uuid,
    master_id: Uuid,
    slave_id: Uuid,
) -> Result<(), sqlx::Error> {
    let dedupe = format!("customer_merge_done:{master_id}:{slave_id}");
    let title = "Customer merge completed";
    let body = format!(
        "Customers were merged (master {master_id}, merged {slave_id}). Actor staff {actor_staff_id}."
    );
    let deep = json!({ "type": "customers", "subsection": "all" });
    let mut admins = admin_staff_ids(pool).await?;
    let mut merge_perm = staff_ids_with_permission(pool, CUSTOMERS_MERGE).await?;
    admins.append(&mut merge_perm);
    let targets = dedupe_sorted(admins);
    if targets.is_empty() {
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let Some(nid) = insert_app_notification_deduped(
        pool,
        "customer_merge_completed",
        title,
        &body,
        deep,
        "system",
        aud,
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    fan_out_to_staff_ids(pool, nid, &targets).await
}

pub async fn emit_order_fully_fulfilled(
    pool: &PgPool,
    transaction_id: Uuid,
    order_ref: &str,
) -> Result<(), sqlx::Error> {
    let dedupe = format!("order_fully_fulfilled:{transaction_id}");
    let title = format!("Order fully fulfilled: {order_ref}");
    let body = "All lines are fulfilled — pickup/fulfillment is complete for this order.";
    let deep = json!({ "type": "order", "transaction_id": transaction_id.to_string() });
    let staff = staff_ids_for_order_scoped(pool, transaction_id).await?;
    if staff.is_empty() {
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": staff.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let Some(nid) = insert_app_notification_deduped(
        pool,
        "order_fully_fulfilled",
        &title,
        body,
        deep,
        "system",
        aud,
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    fan_out_to_staff_ids(pool, nid, &staff).await
}

pub async fn emit_commission_finalize_failed(
    pool: &PgPool,
    detail: &str,
) -> Result<(), sqlx::Error> {
    let d = if detail.len() > 400 {
        format!("{}…", &detail[..397])
    } else {
        detail.to_string()
    };
    let dedupe = format!(
        "commission_finalize_failed:{}",
        Utc::now().format("%Y-%m-%d-%H")
    );
    let title = "Commission finalize failed";
    let body = format!("Insights commission finalize encountered an error: {d}");
    let deep = json!({ "type": "dashboard", "subsection": "payouts" });
    let mut admins = admin_staff_ids(pool).await?;
    let mut fin = staff_ids_with_permission(pool, INSIGHTS_COMMISSION_FINALIZE).await?;
    admins.append(&mut fin);
    let targets = dedupe_sorted(admins);
    if targets.is_empty() {
        return Ok(());
    }
    let aud = json!({
        "mode": "staff_ids",
        "staff_ids": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>()
    });
    let Some(nid) = insert_app_notification_deduped(
        pool,
        "commission_finalize_failed",
        title,
        &body,
        deep,
        "system",
        aud,
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    fan_out_to_staff_ids(pool, nid, &targets).await
}

pub async fn emit_nuorder_sync_finished(
    pool: &PgPool,
    sync_log_id: Uuid,
    sync_type: &str,
    created: i32,
    updated: i32,
) -> Result<(), sqlx::Error> {
    let title = format!("NuORDER {sync_type} sync finished");
    let body = format!("Sync completed successfully. Created: {created}, Updated: {updated}.");
    let dedupe = format!("nuorder_sync_done:{sync_log_id}");
    let deep = json!({ "type": "settings", "section": "nuorder" });

    let Some(nid) = insert_app_notification_deduped(
        pool,
        "nuorder_sync_success",
        &title,
        &body,
        deep,
        "system",
        json!({ "mode": "permission", "key": "nuorder.sync" }),
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    let staff = staff_ids_with_permission(pool, NUORDER_SYNC).await?;
    fan_out_to_staff_ids(pool, nid, &staff).await
}

pub async fn emit_nuorder_sync_failed(
    pool: &PgPool,
    sync_log_id: Uuid,
    sync_type: &str,
    error: &str,
) -> Result<(), sqlx::Error> {
    let title = format!("NuORDER {sync_type} sync failed");
    let body = format!("Error: {error}");
    let dedupe = format!("nuorder_sync_failed:{sync_log_id}");
    let deep = json!({ "type": "settings", "section": "nuorder" });

    let Some(nid) = insert_app_notification_deduped(
        pool,
        "nuorder_sync_failed",
        &title,
        &body,
        deep,
        "system",
        json!({ "mode": "permission", "key": "nuorder.sync" }),
        Some(&dedupe),
    )
    .await?
    else {
        return Ok(());
    };
    let staff = staff_ids_with_permission(pool, NUORDER_SYNC).await?;
    fan_out_to_staff_ids(pool, nid, &staff).await
}
