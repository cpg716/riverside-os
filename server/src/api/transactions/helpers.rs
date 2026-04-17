use super::TransactionError;
use crate::api::AppState;
use crate::auth::permissions::{ORDERS_MODIFY, ORDERS_VIEW};
use crate::middleware;
use axum::http::{HeaderMap, StatusCode};
use uuid::Uuid;

pub fn spawn_meilisearch_transaction_upsert(state: &AppState, transaction_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        tokio::spawn(async move {
            crate::logic::meilisearch_sync::upsert_transaction_document(&c, &pool, transaction_id)
                .await;
        });
    }
}

pub fn map_perm_err(e: (StatusCode, axum::Json<serde_json::Value>)) -> TransactionError {
    let (status, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => TransactionError::Unauthorized(msg),
        StatusCode::FORBIDDEN => TransactionError::Forbidden(msg),
        _ => TransactionError::Forbidden(msg),
    }
}

pub async fn register_session_is_open(
    pool: &sqlx::PgPool,
    sid: Uuid,
) -> Result<bool, TransactionError> {
    let ok: Option<bool> = sqlx::query_scalar(
        r#"SELECT (lifecycle_status = 'open') FROM register_sessions WHERE id = $1"#,
    )
    .bind(sid)
    .fetch_optional(pool)
    .await?;
    Ok(ok.unwrap_or(false))
}

pub async fn order_has_positive_payment_in_session(
    pool: &sqlx::PgPool,
    transaction_id: Uuid,
    session_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pa.target_transaction_id = $1
              AND pt.session_id = $2
              AND pa.amount_allocated > 0
        )
        "#,
    )
    .bind(transaction_id)
    .bind(session_id)
    .fetch_one(pool)
    .await
}

pub async fn authorize_transaction_read_bo_or_register(
    state: &AppState,
    headers: &HeaderMap,
    transaction_id: Uuid,
    register_session_id: Option<Uuid>,
) -> Result<(), TransactionError> {
    if let Some(sid) = register_session_id {
        if !register_session_is_open(&state.db, sid).await? {
            return Err(TransactionError::Forbidden(
                "register session is not open".to_string(),
            ));
        }
        let ok = order_has_positive_payment_in_session(&state.db, transaction_id, sid)
            .await
            .map_err(TransactionError::Database)?;
        if !ok {
            return Err(TransactionError::Forbidden(
                "order is not linked to this register session".to_string(),
            ));
        }
        return Ok(());
    }
    middleware::require_staff_with_permission(state, headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    Ok(())
}

pub async fn authorize_transaction_modify_bo_or_register(
    state: &AppState,
    headers: &HeaderMap,
    transaction_id: Uuid,
    register_session_id: Option<Uuid>,
) -> Result<Option<Uuid>, TransactionError> {
    if let Some(sid) = register_session_id {
        if !register_session_is_open(&state.db, sid).await? {
            return Err(TransactionError::Forbidden(
                "register session is not open".to_string(),
            ));
        }
        let ok = order_has_positive_payment_in_session(&state.db, transaction_id, sid)
            .await
            .map_err(TransactionError::Database)?;
        if !ok {
            return Err(TransactionError::Forbidden(
                "order is not linked to this register session".to_string(),
            ));
        }
        return Ok(None);
    }
    let s = middleware::require_staff_with_permission(state, headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    Ok(Some(s.id))
}

pub async fn log_order_activity(
    db: &sqlx::PgPool,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    event_kind: &str,
    summary: &str,
    metadata: serde_json::Value,
) -> Result<(), TransactionError> {
    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (transaction_id, customer_id, event_kind, summary, metadata)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(event_kind)
    .bind(summary)
    .bind(metadata)
    .execute(db)
    .await?;

    let is_customer_milestone = matches!(event_kind, "checkout" | "pickup" | "refund_processed");
    if is_customer_milestone {
        if let Some(cid) = customer_id {
            sqlx::query(
                r#"
                INSERT INTO customer_timeline_notes (customer_id, body, created_by)
                VALUES ($1, $2, NULL)
                "#,
            )
            .bind(cid)
            .bind(format!("Order {transaction_id}: {summary}"))
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

pub async fn insert_transaction_activity_log_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    event_kind: &str,
    summary: &str,
    metadata: serde_json::Value,
) -> Result<(), TransactionError> {
    use std::ops::DerefMut;
    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (transaction_id, customer_id, event_kind, summary, metadata)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(event_kind)
    .bind(summary)
    .bind(metadata)
    .execute(tx.deref_mut())
    .await?;
    Ok(())
}
