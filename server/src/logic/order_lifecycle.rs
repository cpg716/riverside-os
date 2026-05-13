//! Transaction-line lifecycle service for ordered garments and NTBO workflows.

use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::models::{DbFulfillmentType, DbOrderItemLifecycleStatus};

pub fn initial_status_for_line(
    fulfillment: DbFulfillmentType,
    is_fulfilled: bool,
) -> DbOrderItemLifecycleStatus {
    if is_fulfilled || fulfillment == DbFulfillmentType::Takeaway {
        DbOrderItemLifecycleStatus::PickedUp
    } else {
        DbOrderItemLifecycleStatus::Ntbo
    }
}

pub async fn initialize_line_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_line_id: Uuid,
    status: DbOrderItemLifecycleStatus,
    actor_staff_id: Option<Uuid>,
    source_workflow: &str,
) -> Result<(), sqlx::Error> {
    let old_status: String = sqlx::query_scalar(
        r#"
        WITH current_line AS (
            SELECT order_lifecycle_status::text AS old_status
            FROM transaction_lines
            WHERE id = $1
            FOR UPDATE
        ),
        updated AS (
            UPDATE transaction_lines
            SET
                order_lifecycle_status = $2::order_item_lifecycle_status,
                ordered_at = CASE WHEN $2::text = 'ordered' THEN COALESCE(ordered_at, CURRENT_TIMESTAMP) ELSE ordered_at END,
                ordered_by = CASE WHEN $2::text = 'ordered' THEN COALESCE(ordered_by, $3) ELSE ordered_by END,
                received_at = CASE WHEN $2::text = 'received' THEN COALESCE(received_at, CURRENT_TIMESTAMP) ELSE received_at END,
                received_by = CASE WHEN $2::text = 'received' THEN COALESCE(received_by, $3) ELSE received_by END,
                ready_for_pickup_at = CASE WHEN $2::text = 'ready_for_pickup' THEN COALESCE(ready_for_pickup_at, CURRENT_TIMESTAMP) ELSE ready_for_pickup_at END,
                ready_for_pickup_by = CASE WHEN $2::text = 'ready_for_pickup' THEN COALESCE(ready_for_pickup_by, $3) ELSE ready_for_pickup_by END,
                picked_up_at = CASE WHEN $2::text = 'picked_up' THEN COALESCE(picked_up_at, fulfilled_at, CURRENT_TIMESTAMP) ELSE picked_up_at END,
                picked_up_by = CASE WHEN $2::text = 'picked_up' THEN COALESCE(picked_up_by, $3) ELSE picked_up_by END
            WHERE id = $1
            RETURNING id
        )
        SELECT old_status FROM current_line
        "#,
    )
    .bind(transaction_line_id)
    .bind(status.as_str())
    .bind(actor_staff_id)
    .fetch_one(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO transaction_line_lifecycle_events (
            transaction_line_id,
            old_status,
            new_status,
            actor_staff_id,
            source_workflow,
            reason,
            metadata
        )
        VALUES (
            $1,
            $2::order_item_lifecycle_status,
            $3::order_item_lifecycle_status,
            $4,
            $5,
            $6,
            $7
        )
        "#,
    )
    .bind(transaction_line_id)
    .bind(old_status)
    .bind(status.as_str())
    .bind(actor_staff_id)
    .bind(source_workflow)
    .bind("Initial lifecycle state")
    .bind(json!({}))
    .execute(&mut **tx)
    .await?;

    apply_transition_tx(
        tx,
        &[transaction_line_id],
        status,
        actor_staff_id,
        source_workflow,
        Some("Initial lifecycle state"),
        json!({}),
    )
    .await
}

pub async fn apply_transition_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_line_ids: &[Uuid],
    next_status: DbOrderItemLifecycleStatus,
    actor_staff_id: Option<Uuid>,
    source_workflow: &str,
    reason: Option<&str>,
    metadata: Value,
) -> Result<(), sqlx::Error> {
    if transaction_line_ids.is_empty() {
        return Ok(());
    }

    let current_rows: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT id, order_lifecycle_status::text
        FROM transaction_lines
        WHERE id = ANY($1)
        FOR UPDATE
        "#,
    )
    .bind(transaction_line_ids)
    .fetch_all(&mut **tx)
    .await?;

    for (line_id, old_status) in current_rows {
        if old_status == next_status.as_str() {
            continue;
        }

        sqlx::query(
            r#"
            UPDATE transaction_lines
            SET
                order_lifecycle_status = $2::order_item_lifecycle_status,
                ordered_at = CASE WHEN $2::text = 'ordered' THEN COALESCE(ordered_at, CURRENT_TIMESTAMP) ELSE ordered_at END,
                ordered_by = CASE WHEN $2::text = 'ordered' THEN COALESCE(ordered_by, $3) ELSE ordered_by END,
                received_at = CASE WHEN $2::text = 'received' THEN COALESCE(received_at, CURRENT_TIMESTAMP) ELSE received_at END,
                received_by = CASE WHEN $2::text = 'received' THEN COALESCE(received_by, $3) ELSE received_by END,
                ready_for_pickup_at = CASE WHEN $2::text = 'ready_for_pickup' THEN COALESCE(ready_for_pickup_at, CURRENT_TIMESTAMP) ELSE ready_for_pickup_at END,
                ready_for_pickup_by = CASE WHEN $2::text = 'ready_for_pickup' THEN COALESCE(ready_for_pickup_by, $3) ELSE ready_for_pickup_by END,
                picked_up_at = CASE WHEN $2::text = 'picked_up' THEN COALESCE(picked_up_at, fulfilled_at, CURRENT_TIMESTAMP) ELSE picked_up_at END,
                picked_up_by = CASE WHEN $2::text = 'picked_up' THEN COALESCE(picked_up_by, $3) ELSE picked_up_by END
            WHERE id = $1
            "#,
        )
        .bind(line_id)
        .bind(next_status.as_str())
        .bind(actor_staff_id)
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO transaction_line_lifecycle_events (
                transaction_line_id,
                old_status,
                new_status,
                actor_staff_id,
                source_workflow,
                reason,
                metadata
            )
            VALUES (
                $1,
                $2::order_item_lifecycle_status,
                $3::order_item_lifecycle_status,
                $4,
                $5,
                $6,
                $7
            )
            "#,
        )
        .bind(line_id)
        .bind(old_status)
        .bind(next_status.as_str())
        .bind(actor_staff_id)
        .bind(source_workflow)
        .bind(reason)
        .bind(metadata.clone())
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

pub async fn link_lines_to_po_tx(
    tx: &mut Transaction<'_, Postgres>,
    links: &[(Uuid, Uuid)],
    po_id: Uuid,
    vendor_id: Uuid,
    actor_staff_id: Uuid,
    source_workflow: &str,
) -> Result<(), sqlx::Error> {
    for (transaction_line_id, po_line_id) in links {
        sqlx::query(
            r#"
            UPDATE transaction_lines
            SET
                po_id = $2,
                po_line_id = $3,
                vendor_id = $4,
                ordered_at = COALESCE(ordered_at, CURRENT_TIMESTAMP),
                ordered_by = COALESCE(ordered_by, $5)
            WHERE id = $1
            "#,
        )
        .bind(transaction_line_id)
        .bind(po_id)
        .bind(po_line_id)
        .bind(vendor_id)
        .bind(actor_staff_id)
        .execute(&mut **tx)
        .await?;
    }

    let line_ids = links
        .iter()
        .map(|(transaction_line_id, _)| *transaction_line_id)
        .collect::<Vec<_>>();
    apply_transition_tx(
        tx,
        &line_ids,
        DbOrderItemLifecycleStatus::Ordered,
        Some(actor_staff_id),
        source_workflow,
        Some("Attached to vendor purchase order"),
        json!({ "po_id": po_id }),
    )
    .await
}

pub async fn mark_received_for_po_lines_tx(
    tx: &mut Transaction<'_, Postgres>,
    po_line_ids: &[Uuid],
    actor_staff_id: Option<Uuid>,
    receiving_event_id: Uuid,
) -> Result<(), sqlx::Error> {
    if po_line_ids.is_empty() {
        return Ok(());
    }

    let ready_line_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT tl.id
        FROM transaction_lines tl
        INNER JOIN purchase_order_lines pol ON pol.id = tl.po_line_id
        WHERE tl.po_line_id = ANY($1)
          AND tl.is_fulfilled = FALSE
          AND tl.order_lifecycle_status <> 'picked_up'
          AND pol.quantity_received >= tl.quantity
        ORDER BY tl.id
        "#,
    )
    .bind(po_line_ids)
    .fetch_all(&mut **tx)
    .await?;

    apply_transition_tx(
        tx,
        &ready_line_ids,
        DbOrderItemLifecycleStatus::Received,
        actor_staff_id,
        "po_receiving",
        Some("Linked purchase order line was received"),
        json!({ "receiving_event_id": receiving_event_id }),
    )
    .await
}
