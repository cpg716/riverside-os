//! Inbound Counterpoint batches queued for staff Apply (GUI), plus `store_settings.counterpoint_config`.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use super::counterpoint_sync::{
    execute_counterpoint_catalog_batch, execute_counterpoint_category_masters_batch,
    execute_counterpoint_customer_batch, execute_counterpoint_customer_notes_batch,
    execute_counterpoint_gift_card_batch, execute_counterpoint_inventory_batch,
    execute_counterpoint_loyalty_hist_batch, execute_counterpoint_open_doc_batch,
    execute_counterpoint_sls_rep_stub_batch, execute_counterpoint_staff_batch,
    execute_counterpoint_store_credit_opening_batch, execute_counterpoint_ticket_batch,
    execute_counterpoint_vendor_batch, execute_counterpoint_vendor_item_batch,
    CounterpointCatalogPayload, CounterpointCategoryMastersPayload,
    CounterpointCustomerNotesPayload, CounterpointCustomersPayload, CounterpointGiftCardsPayload,
    CounterpointInventoryPayload, CounterpointLoyaltyHistPayload, CounterpointOpenDocsPayload,
    CounterpointSlsRepStubPayload, CounterpointStaffPayload, CounterpointStoreCreditOpeningPayload,
    CounterpointSyncError, CounterpointTicketsPayload, CounterpointVendorItemsPayload,
    CounterpointVendorsPayload,
};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CounterpointStagingBatchRow {
    pub id: i64,
    pub entity: String,
    pub row_count: i32,
    pub status: String,
    pub apply_error: Option<String>,
    pub bridge_version: Option<String>,
    pub bridge_hostname: Option<String>,
    pub created_at: DateTime<Utc>,
    pub applied_at: Option<DateTime<Utc>>,
    pub applied_by_staff_id: Option<Uuid>,
    pub applied_by_staff_name: Option<String>,
    pub apply_started_at: Option<DateTime<Utc>>,
    pub apply_claimed_by_staff_id: Option<Uuid>,
    pub apply_claimed_by_staff_name: Option<String>,
    pub replay_count: i32,
    pub last_replayed_at: Option<DateTime<Utc>>,
    pub payload_fingerprint: Option<String>,
    pub recovered_at: Option<DateTime<Utc>>,
    pub recovered_by_staff_id: Option<Uuid>,
    pub recovered_by_staff_name: Option<String>,
    pub recovery_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointStagingInsertResult {
    pub id: i64,
    pub replayed: bool,
}

pub async fn counterpoint_staging_enabled(pool: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COALESCE((counterpoint_config->>'staging_enabled')::boolean, false)
           FROM store_settings WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await
}

pub async fn set_counterpoint_staging_enabled(
    pool: &PgPool,
    enabled: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE store_settings
           SET counterpoint_config = counterpoint_config || $1::jsonb
           WHERE id = 1"#,
    )
    .bind(serde_json::json!({ "staging_enabled": enabled }))
    .execute(pool)
    .await?;
    Ok(())
}

/// M2M: insert staged batch. `payload` is the same JSON body the bridge would POST to the direct entity route.
pub async fn insert_staging_batch(
    pool: &PgPool,
    entity: &str,
    payload: Value,
    bridge_version: Option<&str>,
    bridge_hostname: Option<&str>,
) -> Result<CounterpointStagingInsertResult, sqlx::Error> {
    let row_count = payload
        .get("rows")
        .and_then(|r| r.as_array())
        .map(|a| a.len() as i32)
        .or_else(|| {
            payload
                .get("codes")
                .and_then(|c| c.as_array())
                .map(|a| a.len() as i32)
        })
        .unwrap_or(0);

    let mut tx = pool.begin().await?;
    let replay_identity = format!("{entity}\n{}", payload);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&replay_identity)
        .execute(&mut *tx)
        .await?;

    let existing_id: Option<i64> = sqlx::query_scalar(
        r#"SELECT id
           FROM counterpoint_staging_batch
           WHERE entity = $1
             AND payload = $2
             AND status IN ('pending', 'applying', 'applied')
           ORDER BY created_at ASC
           LIMIT 1"#,
    )
    .bind(entity)
    .bind(&payload)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(id) = existing_id {
        sqlx::query(
            r#"UPDATE counterpoint_staging_batch
               SET replay_count = replay_count + 1,
                   last_replayed_at = NOW(),
                   payload_fingerprint = COALESCE(payload_fingerprint, md5(payload::text))
               WHERE id = $1"#,
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(CounterpointStagingInsertResult { id, replayed: true });
    }

    let id: i64 = sqlx::query_scalar(
        r#"INSERT INTO counterpoint_staging_batch
           (entity, payload, row_count, bridge_version, bridge_hostname, payload_fingerprint)
           VALUES ($1, $2, $3, $4, $5, md5($2::jsonb::text))
           RETURNING id"#,
    )
    .bind(entity)
    .bind(&payload)
    .bind(row_count)
    .bind(bridge_version)
    .bind(bridge_hostname)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(CounterpointStagingInsertResult {
        id,
        replayed: false,
    })
}

pub async fn list_staging_batches(
    pool: &PgPool,
    limit: i64,
    status_filter: Option<&str>,
) -> Result<Vec<CounterpointStagingBatchRow>, sqlx::Error> {
    let limit = limit.clamp(1, 500);
    if let Some(st) = status_filter {
        sqlx::query_as::<_, CounterpointStagingBatchRow>(
            r#"SELECT b.id, b.entity, b.row_count, b.status, b.apply_error,
                      b.bridge_version, b.bridge_hostname, b.created_at, b.applied_at,
                      b.applied_by_staff_id, applied_staff.full_name::text AS applied_by_staff_name,
                      b.apply_started_at, b.apply_claimed_by_staff_id,
                      claimed_staff.full_name::text AS apply_claimed_by_staff_name,
                      b.replay_count, b.last_replayed_at, b.payload_fingerprint,
                      b.recovered_at, b.recovered_by_staff_id,
                      recovered_staff.full_name::text AS recovered_by_staff_name,
                      b.recovery_reason
               FROM counterpoint_staging_batch b
               LEFT JOIN staff claimed_staff ON claimed_staff.id = b.apply_claimed_by_staff_id
               LEFT JOIN staff recovered_staff ON recovered_staff.id = b.recovered_by_staff_id
               LEFT JOIN staff applied_staff ON applied_staff.id = b.applied_by_staff_id
               WHERE b.status = $1
               ORDER BY b.created_at DESC
               LIMIT $2"#,
        )
        .bind(st)
        .bind(limit)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as::<_, CounterpointStagingBatchRow>(
            r#"SELECT b.id, b.entity, b.row_count, b.status, b.apply_error,
                      b.bridge_version, b.bridge_hostname, b.created_at, b.applied_at,
                      b.applied_by_staff_id, applied_staff.full_name::text AS applied_by_staff_name,
                      b.apply_started_at, b.apply_claimed_by_staff_id,
                      claimed_staff.full_name::text AS apply_claimed_by_staff_name,
                      b.replay_count, b.last_replayed_at, b.payload_fingerprint,
                      b.recovered_at, b.recovered_by_staff_id,
                      recovered_staff.full_name::text AS recovered_by_staff_name,
                      b.recovery_reason
               FROM counterpoint_staging_batch b
               LEFT JOIN staff claimed_staff ON claimed_staff.id = b.apply_claimed_by_staff_id
               LEFT JOIN staff recovered_staff ON recovered_staff.id = b.recovered_by_staff_id
               LEFT JOIN staff applied_staff ON applied_staff.id = b.applied_by_staff_id
               ORDER BY b.created_at DESC
               LIMIT $1"#,
        )
        .bind(limit)
        .fetch_all(pool)
        .await
    }
}

pub async fn get_staging_payload(pool: &PgPool, id: i64) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar("SELECT payload FROM counterpoint_staging_batch WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn discard_staging_batch(pool: &PgPool, id: i64) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        r#"UPDATE counterpoint_staging_batch
           SET status = 'discarded', applied_at = NOW()
           WHERE id = $1 AND status = 'pending'"#,
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn apply_staging_batch(
    pool: &PgPool,
    id: i64,
    staff_id: Uuid,
) -> Result<(), CounterpointSyncError> {
    let row: Option<(String, Value)> = sqlx::query_as(
        r#"
        UPDATE counterpoint_staging_batch
        SET status = 'applying',
            apply_error = NULL,
            apply_started_at = NOW(),
            apply_claimed_by_staff_id = $2
        WHERE id = $1
          AND status = 'pending'
        RETURNING entity, payload
        "#,
    )
    .bind(id)
    .bind(staff_id)
    .fetch_optional(pool)
    .await?;

    let Some((entity, payload)) = row else {
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM counterpoint_staging_batch WHERE id = $1")
                .bind(id)
                .fetch_optional(pool)
                .await?;
        let Some(status) = status else {
            return Err(CounterpointSyncError::InvalidPayload(
                "batch not found".into(),
            ));
        };
        return Err(CounterpointSyncError::InvalidPayload(format!(
            "batch status is {status}, expected pending"
        )));
    };

    let apply_res: Result<(), CounterpointSyncError> = async {
        match entity.as_str() {
            "customers" => {
                let p: CounterpointCustomersPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_customer_batch(pool, p).await?;
            }
            "inventory" => {
                let p: CounterpointInventoryPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_inventory_batch(pool, p).await?;
            }
            "category_masters" => {
                let p: CounterpointCategoryMastersPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_category_masters_batch(pool, p).await?;
            }
            "catalog" => {
                let p: CounterpointCatalogPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_catalog_batch(pool, p).await?;
            }
            "gift_cards" => {
                let p: CounterpointGiftCardsPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_gift_card_batch(pool, p).await?;
            }
            "tickets" => {
                let p: CounterpointTicketsPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_ticket_batch(pool, p).await?;
            }
            "vendors" => {
                let p: CounterpointVendorsPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_vendor_batch(pool, p).await?;
            }
            "vendor_items" => {
                let p: CounterpointVendorItemsPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_vendor_item_batch(pool, p).await?;
            }
            "customer_notes" => {
                let p: CounterpointCustomerNotesPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_customer_notes_batch(pool, p).await?;
            }
            "loyalty_hist" => {
                let p: CounterpointLoyaltyHistPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_loyalty_hist_batch(pool, p).await?;
            }
            "staff" => {
                let p: CounterpointStaffPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_staff_batch(pool, p).await?;
            }
            "sales_rep_stubs" => {
                let p: CounterpointSlsRepStubPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_sls_rep_stub_batch(pool, p).await?;
            }
            "store_credit_opening" => {
                let p: CounterpointStoreCreditOpeningPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_store_credit_opening_batch(pool, p).await?;
            }
            "open_docs" => {
                let p: CounterpointOpenDocsPayload = serde_json::from_value(payload)
                    .map_err(|e| CounterpointSyncError::InvalidPayload(e.to_string()))?;
                execute_counterpoint_open_doc_batch(pool, p).await?;
            }
            _ => {
                return Err(CounterpointSyncError::InvalidPayload(format!(
                    "unknown entity: {entity}"
                )));
            }
        }
        Ok(())
    }
    .await;

    match apply_res {
        Ok(()) => {
            sqlx::query(
                r#"UPDATE counterpoint_staging_batch
                   SET status = 'applied', applied_at = NOW(), applied_by_staff_id = $2, apply_error = NULL
                   WHERE id = $1 AND status = 'applying'"#,
            )
            .bind(id)
            .bind(staff_id)
            .execute(pool)
            .await?;
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            sqlx::query(
                r#"UPDATE counterpoint_staging_batch
                   SET status = 'failed', apply_error = $2
                   WHERE id = $1 AND status = 'applying'"#,
            )
            .bind(id)
            .bind(&msg)
            .execute(pool)
            .await?;
            Err(e)
        }
    }
}

pub async fn count_pending_staging(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint FROM counterpoint_staging_batch WHERE status = 'pending'"#,
    )
    .fetch_one(pool)
    .await
}

pub async fn count_pending_or_applying_staging(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint
           FROM counterpoint_staging_batch
           WHERE status IN ('pending', 'applying')"#,
    )
    .fetch_one(pool)
    .await
}

pub async fn count_applying_staging(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint
           FROM counterpoint_staging_batch
           WHERE status = 'applying'"#,
    )
    .fetch_one(pool)
    .await
}

pub async fn recover_stale_applying_batch(
    pool: &PgPool,
    id: i64,
    stale_after_minutes: i32,
    recovered_by_staff_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let recovery_reason =
        "Stale Counterpoint apply claim recovered by admin; payload was not replayed.";
    let r = sqlx::query(
        r#"
        UPDATE counterpoint_staging_batch
        SET status = 'failed',
            apply_error = $4,
            recovered_at = NOW(),
            recovered_by_staff_id = $3,
            recovery_reason = $4
        WHERE id = $1
          AND status = 'applying'
          AND apply_started_at IS NOT NULL
          AND apply_started_at < NOW() - ($2::int * INTERVAL '1 minute')
        "#,
    )
    .bind(id)
    .bind(stale_after_minutes)
    .bind(recovered_by_staff_id)
    .bind(recovery_reason)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

// ── Mapping tables (GUI CRUD) ───────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CategoryMapRow {
    pub id: i64,
    pub cp_category: String,
    pub ros_category_id: Option<Uuid>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PaymentMethodMapRow {
    pub id: i64,
    pub cp_pmt_typ: String,
    pub ros_method: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct GiftReasonMapRow {
    pub id: i64,
    pub cp_reason_cod: String,
    pub ros_card_kind: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StaffMapRow {
    pub id: i64,
    pub cp_code: String,
    pub cp_source: String,
    pub ros_staff_id: Uuid,
    pub staff_display_name: Option<String>,
}

pub async fn list_category_map(pool: &PgPool) -> Result<Vec<CategoryMapRow>, sqlx::Error> {
    sqlx::query_as::<_, CategoryMapRow>(
        r#"SELECT id, cp_category, ros_category_id FROM counterpoint_category_map ORDER BY cp_category"#,
    )
    .fetch_all(pool)
    .await
}

pub async fn patch_category_map_ros(
    pool: &PgPool,
    id: i64,
    ros_category_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let r = sqlx::query("UPDATE counterpoint_category_map SET ros_category_id = $2 WHERE id = $1")
        .bind(id)
        .bind(ros_category_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn list_payment_method_map(
    pool: &PgPool,
) -> Result<Vec<PaymentMethodMapRow>, sqlx::Error> {
    sqlx::query_as::<_, PaymentMethodMapRow>(
        r#"SELECT id, cp_pmt_typ, ros_method FROM counterpoint_payment_method_map ORDER BY cp_pmt_typ"#,
    )
    .fetch_all(pool)
    .await
}

pub async fn patch_payment_method_map(
    pool: &PgPool,
    id: i64,
    ros_method: &str,
) -> Result<bool, sqlx::Error> {
    let r = sqlx::query("UPDATE counterpoint_payment_method_map SET ros_method = $2 WHERE id = $1")
        .bind(id)
        .bind(ros_method)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn list_gift_reason_map(pool: &PgPool) -> Result<Vec<GiftReasonMapRow>, sqlx::Error> {
    sqlx::query_as::<_, GiftReasonMapRow>(
        r#"SELECT id, cp_reason_cod, ros_card_kind FROM counterpoint_gift_reason_map ORDER BY cp_reason_cod"#,
    )
    .fetch_all(pool)
    .await
}

pub async fn patch_gift_reason_map(
    pool: &PgPool,
    id: i64,
    ros_card_kind: &str,
) -> Result<bool, sqlx::Error> {
    let r = sqlx::query("UPDATE counterpoint_gift_reason_map SET ros_card_kind = $2 WHERE id = $1")
        .bind(id)
        .bind(ros_card_kind)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn list_staff_map(pool: &PgPool) -> Result<Vec<StaffMapRow>, sqlx::Error> {
    sqlx::query_as::<_, StaffMapRow>(
        r#"SELECT m.id, m.cp_code, m.cp_source, m.ros_staff_id,
                  s.full_name::text AS staff_display_name
           FROM counterpoint_staff_map m
           INNER JOIN staff s ON s.id = m.ros_staff_id
           ORDER BY m.cp_source, m.cp_code"#,
    )
    .fetch_all(pool)
    .await
}
