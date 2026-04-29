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
//! To avoid destructive transaction reparenting, linked profiles use combined views for purchase history.
//! Loyalty points and store credit move to the primary profile when the link is created.

use rust_decimal::Decimal;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CoupleError {
    #[error("Database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
}

#[derive(Debug, FromRow)]
struct CoupleCustomerSnapshot {
    id: Uuid,
    customer_code: String,
    first_name: String,
    last_name: String,
}

impl CoupleCustomerSnapshot {
    fn label(&self) -> String {
        let name = format!("{} {}", self.first_name.trim(), self.last_name.trim())
            .trim()
            .to_string();
        if name.is_empty() {
            self.customer_code.clone()
        } else {
            format!("{name} ({})", self.customer_code)
        }
    }
}

async fn load_customer_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
) -> Result<CoupleCustomerSnapshot, CoupleError> {
    sqlx::query_as::<_, CoupleCustomerSnapshot>(
        r#"
        SELECT id, customer_code, COALESCE(first_name, '') AS first_name, COALESCE(last_name, '') AS last_name
        FROM customers
        WHERE id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| CoupleError::BadRequest("Customer not found".to_string()))
}

async fn insert_couple_timeline_note(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
    body: String,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO customer_timeline_notes (customer_id, body, created_by)
        VALUES ($1, $2, NULL)
        "#,
    )
    .bind(customer_id)
    .bind(body)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn move_store_credit_to_primary(
    tx: &mut Transaction<'_, Postgres>,
    primary_id: Uuid,
    secondary_id: Uuid,
) -> Result<(), sqlx::Error> {
    let secondary_account: Option<(Uuid, Decimal)> = sqlx::query_as(
        "SELECT id, balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE",
    )
    .bind(secondary_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((secondary_account_id, secondary_balance)) = secondary_account else {
        return Ok(());
    };

    let primary_account: Option<(Uuid, Decimal)> = sqlx::query_as(
        "SELECT id, balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE",
    )
    .bind(primary_id)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some((primary_account_id, primary_balance)) = primary_account {
        let combined = primary_balance + secondary_balance;
        sqlx::query(
            "UPDATE store_credit_accounts SET balance = $1, updated_at = now() WHERE id = $2",
        )
        .bind(combined)
        .bind(primary_account_id)
        .execute(&mut **tx)
        .await?;

        sqlx::query("UPDATE store_credit_ledger SET account_id = $1 WHERE account_id = $2")
            .bind(primary_account_id)
            .bind(secondary_account_id)
            .execute(&mut **tx)
            .await?;

        sqlx::query("DELETE FROM store_credit_accounts WHERE id = $1")
            .bind(secondary_account_id)
            .execute(&mut **tx)
            .await?;
    } else {
        sqlx::query("UPDATE store_credit_accounts SET customer_id = $1 WHERE id = $2")
            .bind(primary_id)
            .bind(secondary_account_id)
            .execute(&mut **tx)
            .await?;
    }

    Ok(())
}

/// Links two customers as a couple.
pub async fn link_couple(
    pool: &PgPool,
    primary_id: Uuid,
    secondary_id: Uuid,
) -> Result<(), CoupleError> {
    if primary_id == secondary_id {
        return Err(CoupleError::BadRequest(
            "Cannot link a customer to themselves".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    let primary = load_customer_snapshot(&mut tx, primary_id).await?;
    let secondary = load_customer_snapshot(&mut tx, secondary_id).await?;

    // Verify both exist and aren't already coupled
    let (p_c_id, s_c_id): (Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT couple_id FROM customers WHERE id = $1")
            .bind(primary_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(|r: (Option<Uuid>,)| (r.0, None::<Uuid>))
            .zip(
                sqlx::query_as("SELECT couple_id FROM customers WHERE id = $1")
                    .bind(secondary_id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .map(|r: (Option<Uuid>,)| r.0),
            )
            .map(|((p, _), s)| (p, s))
            .unwrap_or((None, None));

    if p_c_id.is_some() || s_c_id.is_some() {
        return Err(CoupleError::BadRequest(
            "One or both customers are already part of a couple. Unlink them first.".to_string(),
        ));
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

    sqlx::query(
        r#"
        INSERT INTO customer_relationship_periods (parent_customer_id, child_customer_id, linked_at)
        VALUES ($1, $2, now())
        "#,
    )
    .bind(primary_id)
    .bind(secondary_id)
    .execute(&mut *tx)
    .await?;

    let secondary_points: i32 =
        sqlx::query_scalar("SELECT loyalty_points FROM customers WHERE id = $1")
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

    move_store_credit_to_primary(&mut tx, primary_id, secondary_id).await?;
    insert_couple_timeline_note(
        &mut tx,
        primary_id,
        format!("Linked profile with {}", secondary.label()),
    )
    .await?;
    insert_couple_timeline_note(
        &mut tx,
        secondary_id,
        format!("Linked profile with {}", primary.label()),
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Unlinks a customer from their couple.
pub async fn unlink_couple(pool: &PgPool, customer_id: Uuid) -> Result<(), CoupleError> {
    let mut tx = pool.begin().await?;

    let couple_id: Option<Uuid> =
        sqlx::query_scalar("SELECT couple_id FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();

    if let Some(cid) = couple_id {
        let members = sqlx::query_as::<_, CoupleCustomerSnapshot>(
            r#"
            SELECT id, customer_code, COALESCE(first_name, '') AS first_name, COALESCE(last_name, '') AS last_name
            FROM customers
            WHERE couple_id = $1
            "#,
        )
        .bind(cid)
        .fetch_all(&mut *tx)
        .await?;

        let member_ids: Vec<Uuid> = members.iter().map(|member| member.id).collect();

        sqlx::query(
            "UPDATE customers SET couple_id = NULL, couple_primary_id = NULL, couple_linked_at = NULL WHERE couple_id = $1"
        )
        .bind(cid)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE customer_relationship_periods
            SET unlinked_at = now(), updated_at = now()
            WHERE unlinked_at IS NULL
              AND parent_customer_id = ANY($1)
              AND child_customer_id = ANY($1)
            "#,
        )
        .bind(&member_ids)
        .execute(&mut *tx)
        .await?;

        for member in &members {
            let other_labels: Vec<String> = members
                .iter()
                .filter(|other| other.id != member.id)
                .map(CoupleCustomerSnapshot::label)
                .collect();
            if !other_labels.is_empty() {
                insert_couple_timeline_note(
                    &mut tx,
                    member.id,
                    format!("Unlinked profile from {}", other_labels.join(", ")),
                )
                .await?;
            }
        }
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
pub async fn resolve_effective_customer_id(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    let primary: Option<Uuid> =
        sqlx::query_scalar("SELECT couple_primary_id FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(pool)
            .await?;

    Ok(primary.unwrap_or(customer_id))
}

pub async fn resolve_effective_customer_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    let primary: Option<Uuid> =
        sqlx::query_scalar("SELECT couple_primary_id FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(&mut **tx)
            .await?;

    Ok(primary.unwrap_or(customer_id))
}
