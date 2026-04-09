//! Server-backed POS parked sales and audit rows.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::pins::log_staff_access;

#[derive(Debug, Serialize, FromRow)]
pub struct ParkedSaleRow {
    pub id: Uuid,
    pub register_session_id: Uuid,
    pub parked_by_staff_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub label: String,
    pub payload_json: Value,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateParkedSaleRequest {
    pub parked_by_staff_id: Uuid,
    pub label: String,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    pub payload_json: Value,
}

async fn insert_audit(
    pool: &sqlx::PgPool,
    register_session_id: Uuid,
    parked_sale_id: Uuid,
    action: &str,
    actor_staff_id: Uuid,
    metadata: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO pos_parked_sale_audit (register_session_id, parked_sale_id, action, actor_staff_id, metadata)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(register_session_id)
    .bind(parked_sale_id)
    .bind(action)
    .bind(actor_staff_id)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_parked_for_session(
    pool: &sqlx::PgPool,
    register_session_id: Uuid,
    customer_id: Option<Uuid>,
) -> Result<Vec<ParkedSaleRow>, sqlx::Error> {
    let rows: Vec<ParkedSaleRow> = if let Some(cid) = customer_id {
        sqlx::query_as::<_, ParkedSaleRow>(
            r#"
            SELECT
                p.id,
                p.register_session_id,
                p.parked_by_staff_id,
                p.customer_id,
                p.label,
                p.payload_json,
                p.status::text AS status,
                p.created_at,
                p.updated_at
            FROM pos_parked_sale p
            INNER JOIN register_sessions rs ON rs.id = p.register_session_id
            WHERE p.register_session_id = $1
              AND p.status = 'parked'
              AND rs.is_open = TRUE
              AND p.customer_id = $2
            ORDER BY p.created_at DESC
            "#,
        )
        .bind(register_session_id)
        .bind(cid)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, ParkedSaleRow>(
            r#"
            SELECT
                p.id,
                p.register_session_id,
                p.parked_by_staff_id,
                p.customer_id,
                p.label,
                p.payload_json,
                p.status::text AS status,
                p.created_at,
                p.updated_at
            FROM pos_parked_sale p
            INNER JOIN register_sessions rs ON rs.id = p.register_session_id
            WHERE p.register_session_id = $1
              AND p.status = 'parked'
              AND rs.is_open = TRUE
            ORDER BY p.created_at DESC
            "#,
        )
        .bind(register_session_id)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

pub async fn create_parked_sale(
    pool: &sqlx::PgPool,
    register_session_id: Uuid,
    body: CreateParkedSaleRequest,
) -> Result<ParkedSaleRow, sqlx::Error> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM register_sessions WHERE id = $1 AND is_open = TRUE)",
    )
    .bind(register_session_id)
    .fetch_one(pool)
    .await?;
    if !ok {
        return Err(sqlx::Error::RowNotFound);
    }

    let staff_ok: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1 AND is_active = TRUE)")
            .bind(body.parked_by_staff_id)
            .fetch_one(pool)
            .await?;
    if !staff_ok {
        return Err(sqlx::Error::RowNotFound);
    }

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO pos_parked_sale (
            register_session_id, parked_by_staff_id, customer_id, label, payload_json, status
        )
        VALUES ($1, $2, $3, $4, $5, 'parked')
        RETURNING id
        "#,
    )
    .bind(register_session_id)
    .bind(body.parked_by_staff_id)
    .bind(body.customer_id)
    .bind(body.label.trim())
    .bind(&body.payload_json)
    .fetch_one(pool)
    .await?;

    insert_audit(
        pool,
        register_session_id,
        id,
        "park",
        body.parked_by_staff_id,
        json!({ "label": body.label.trim(), "customer_id": body.customer_id }),
    )
    .await?;

    let _ = log_staff_access(
        pool,
        body.parked_by_staff_id,
        "pos_parked_sale_park",
        json!({
            "parked_sale_id": id,
            "register_session_id": register_session_id,
            "customer_id": body.customer_id,
        }),
    )
    .await;

    let row: ParkedSaleRow = sqlx::query_as::<_, ParkedSaleRow>(
        r#"
        SELECT
            id, register_session_id, parked_by_staff_id, customer_id, label, payload_json,
            status::text AS status, created_at, updated_at
        FROM pos_parked_sale WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(pool)
    .await?;

    Ok(row)
}

pub async fn recall_parked_sale(
    pool: &sqlx::PgPool,
    register_session_id: Uuid,
    parked_sale_id: Uuid,
    actor_staff_id: Uuid,
) -> Result<(), sqlx::Error> {
    // Do not join register_sessions here: POS routes already verified the session token while open.
    // A join on rs.is_open caused zero-row updates (race or snapshot mismatch) so recall/delete appeared to no-op.
    let updated = sqlx::query(
        r#"
        UPDATE pos_parked_sale
        SET
            status = 'recalled',
            updated_at = now(),
            recalled_at = now(),
            recalled_by_staff_id = $3
        WHERE id = $1
          AND register_session_id = $2
          AND status = 'parked'
        "#,
    )
    .bind(parked_sale_id)
    .bind(register_session_id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?
    .rows_affected();

    if updated == 0 {
        return Err(sqlx::Error::RowNotFound);
    }

    insert_audit(
        pool,
        register_session_id,
        parked_sale_id,
        "recall",
        actor_staff_id,
        json!({}),
    )
    .await?;

    let _ = log_staff_access(
        pool,
        actor_staff_id,
        "pos_parked_sale_recall",
        json!({
            "parked_sale_id": parked_sale_id,
            "register_session_id": register_session_id,
        }),
    )
    .await;

    Ok(())
}

pub async fn delete_parked_sale(
    pool: &sqlx::PgPool,
    register_session_id: Uuid,
    parked_sale_id: Uuid,
    actor_staff_id: Uuid,
) -> Result<(), sqlx::Error> {
    let updated = sqlx::query(
        r#"
        UPDATE pos_parked_sale
        SET
            status = 'deleted',
            updated_at = now(),
            deleted_at = now(),
            deleted_by_staff_id = $3
        WHERE id = $1
          AND register_session_id = $2
          AND status = 'parked'
        "#,
    )
    .bind(parked_sale_id)
    .bind(register_session_id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?
    .rows_affected();

    if updated == 0 {
        return Err(sqlx::Error::RowNotFound);
    }

    insert_audit(
        pool,
        register_session_id,
        parked_sale_id,
        "delete",
        actor_staff_id,
        json!({}),
    )
    .await?;

    let _ = log_staff_access(
        pool,
        actor_staff_id,
        "pos_parked_sale_delete",
        json!({
            "parked_sale_id": parked_sale_id,
            "register_session_id": register_session_id,
        }),
    )
    .await;

    Ok(())
}

/// Mark any still-parked rows for these sessions deleted when the till group Z-closes.
pub async fn purge_open_parked_for_sessions(
    pool: &sqlx::PgPool,
    session_ids: &[Uuid],
    actor_staff_id: Option<Uuid>,
) -> Result<u64, sqlx::Error> {
    if session_ids.is_empty() {
        return Ok(0);
    }

    let res = sqlx::query(
        r#"
        UPDATE pos_parked_sale
        SET
            status = 'deleted',
            updated_at = now(),
            deleted_at = now(),
            deleted_by_staff_id = COALESCE($2, parked_by_staff_id)
        WHERE register_session_id = ANY($1)
          AND status = 'parked'
        "#,
    )
    .bind(session_ids)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;

    let n = res.rows_affected();
    if n > 0 {
        if let Some(actor) = actor_staff_id {
            let _ = log_staff_access(
                pool,
                actor,
                "pos_parked_sale_purge_on_close",
                json!({
                    "session_ids": session_ids,
                    "purged_count": n,
                }),
            )
            .await;
        }
    }

    Ok(n)
}
