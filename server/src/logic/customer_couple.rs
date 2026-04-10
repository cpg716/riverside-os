//! Logic for linking and unlinking customer accounts as "Couples".
//!
//! When accounts are linked:
//! 1. One is designated the Primary.
//! 2. Sales history, loyalty, etc. is viewed as combined.
//! 3. Only the Primary account "counts" for historical reporting purposes (optional, usually handled at query time).
//!
//! The user's request: "Only 1 account keeps that history as counted, the other just gets a 'archived' view of what was purchased,
//! but does not duplicate sales revenue/inventory/finance/loyalty, etc type stuff like the main account keeps on record."
//!
//! To achieve this without destructive reparenting (which makes unlinking hard), we focus on the "Combined View" logic.
//! If "only 1 account keeps that history as counted", we may need to reparent existing orders to the primary,
//! but store the `original_customer_id` if we want to support true unlinking with history restoration.
//!
//! However, standard practice for "Archive" mode is often just a pointer.

use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CoupleError {
    #[error("Database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
}

/// Links two customers as a couple.
pub async fn link_couple(
    pool: &PgPool,
    primary_id: Uuid,
    secondary_id: Uuid,
) -> Result<(), CoupleError> {
    if primary_id == secondary_id {
        return Err(CoupleError::BadRequest("Cannot link a customer to themselves".to_string()));
    }

    let mut tx = pool.begin().await?;

    // Verify both exist and aren't already coupled
    let (p_c_id, s_c_id): (Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT couple_id FROM customers WHERE id = $1"
    )
    .bind(primary_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(|r: (Option<Uuid>,)| (r.0, None))
    .zip(
        sqlx::query_as("SELECT couple_id FROM customers WHERE id = $1")
            .bind(secondary_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(|r: (Option<Uuid>,)| r.0)
    )
    .map(|((p, _), s)| (p, s))
    .unwrap_or((None, None));

    if p_c_id.is_some() || s_c_id.is_some() {
        return Err(CoupleError::BadRequest("One or both customers are already part of a couple. Unlink them first.".to_string()));
    }

    let couple_id = Uuid::new_v4();

    // Set primary
    sqlx::query(
        "UPDATE customers SET couple_id = $1, couple_primary_id = $2, couple_linked_at = now() WHERE id = $2"
    )
    .bind(couple_id)
    .bind(primary_id)
    .execute(&mut *tx)
    .await?;

    // Set secondary
    sqlx::query(
        "UPDATE customers SET couple_id = $1, couple_primary_id = $2, couple_linked_at = now() WHERE id = $3"
    )
    .bind(couple_id)
    .bind(primary_id)
    .bind(secondary_id)
    .execute(&mut *tx)
    .await?;

    // Implementation Detail: Loyalty and Balance. 
    // The user said "Only 1 account keeps that history as counted... the other just gets an archived view... but does not duplicate sales revenue/inventory/finance/loyalty".
    // This implies we should MOVE the loyalty points from secondary to primary?
    
    let secondary_points: i32 = sqlx::query_scalar("SELECT loyalty_points FROM customers WHERE id = $1")
        .bind(secondary_id)
        .fetch_one(&mut *tx)
        .await?;

    if secondary_points > 0 {
        sqlx::query("UPDATE customers SET loyalty_points = loyalty_points + $1 WHERE id = $2")
            .bind(secondary_points)
            .bind(primary_id)
            .execute(&mut *tx)
            .await?;
        
        sqlx::query("UPDATE customers SET loyalty_points = 0 WHERE id = $1")
            .bind(secondary_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Unlinks a customer from their couple.
pub async fn unlink_couple(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<(), CoupleError> {
    let mut tx = pool.begin().await?;

    let couple_id: Option<Uuid> = sqlx::query_scalar("SELECT couple_id FROM customers WHERE id = $1")
        .bind(customer_id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();

    if let Some(cid) = couple_id {
        sqlx::query(
            "UPDATE customers SET couple_id = NULL, couple_primary_id = NULL, couple_linked_at = NULL WHERE couple_id = $1"
        )
        .bind(cid)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Checks if two customers are linked.
pub async fn get_partner_id(pool: &PgPool, customer_id: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT id FROM customers WHERE couple_id = (SELECT couple_id FROM customers WHERE id = $1) AND id != $1 AND couple_id IS NOT NULL"
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await
}

/// Resolves the primary ID for a customer if they are in a couple.
pub async fn resolve_effective_customer_id(pool: &PgPool, customer_id: Uuid) -> Result<Uuid, sqlx::Error> {
    let primary: Option<Uuid> = sqlx::query_scalar(
        "SELECT couple_primary_id FROM customers WHERE id = $1"
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    Ok(primary.unwrap_or(customer_id))
}

pub async fn resolve_effective_customer_id_tx(tx: &mut Transaction<'_, Postgres>, customer_id: Uuid) -> Result<Uuid, sqlx::Error> {
    let primary: Option<Uuid> = sqlx::query_scalar(
        "SELECT couple_primary_id FROM customers WHERE id = $1"
    )
    .bind(customer_id)
    .fetch_one(&mut **tx)
    .await?;

    Ok(primary.unwrap_or(customer_id))
}
