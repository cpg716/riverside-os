//! In-transaction gift card balance changes shared by checkout and refunds.

use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum GiftCardOpError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
}

/// Credit an active gift card (idempotent-friendly: caller runs inside order refund tx).
pub async fn credit_gift_card_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    code: &str,
    amount: Decimal,
    transaction_id: Uuid,
    session_id: Uuid,
) -> Result<(), GiftCardOpError> {
    if amount <= Decimal::ZERO {
        return Err(GiftCardOpError::BadRequest(
            "credit amount must be positive".into(),
        ));
    }
    let row: Option<(Uuid, Decimal)> = sqlx::query_as(
        r#"
        SELECT id, current_balance
        FROM gift_cards
        WHERE code = $1 AND card_status = 'active'::gift_card_status
        FOR UPDATE
        "#,
    )
    .bind(code)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((card_id, old_balance)) = row else {
        return Err(GiftCardOpError::BadRequest(
            "gift card not found or inactive".into(),
        ));
    };

    let new_balance = old_balance + amount;
    sqlx::query("UPDATE gift_cards SET current_balance = $1 WHERE id = $2")
        .bind(new_balance)
        .bind(card_id)
        .execute(&mut **tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO gift_card_events
            (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id)
        VALUES ($1, 'loaded', $2, $3, $4, $5)
        "#,
    )
    .bind(card_id)
    .bind(amount)
    .bind(new_balance)
    .bind(transaction_id)
    .bind(session_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

/// Apply purchased-card load inside a transaction. `transaction_id_for_events` is `Some` when tied to checkout.
pub async fn pos_load_purchased_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    code: &str,
    amount: Decimal,
    customer_id: Option<Uuid>,
    session_id: Option<Uuid>,
    transaction_id_for_events: Option<Uuid>,
) -> Result<Uuid, GiftCardOpError> {
    let code = code.trim();
    if code.is_empty() {
        return Err(GiftCardOpError::BadRequest("code is required".into()));
    }
    if amount <= Decimal::ZERO {
        return Err(GiftCardOpError::BadRequest(
            "amount must be positive".into(),
        ));
    }

    let expires_at = Utc::now() + Duration::days(365 * 9);

    let row: Option<(Uuid, String, String, Decimal)> = sqlx::query_as(
        r#"
        SELECT id, card_kind::text, card_status::text, current_balance
        FROM gift_cards
        WHERE code = $1
        FOR UPDATE
        "#,
    )
    .bind(code)
    .fetch_optional(&mut **tx)
    .await?;

    let card_id = if let Some((id, kind, status, balance)) = row {
        if !kind.eq_ignore_ascii_case("purchased") {
            return Err(GiftCardOpError::BadRequest(
                "this card code is not a purchased gift card — use Back Office for other card types"
                    .into(),
            ));
        }
        if status.eq_ignore_ascii_case("void") {
            return Err(GiftCardOpError::BadRequest(
                "this card is void and cannot be loaded".into(),
            ));
        }

        let depleted_like = status.eq_ignore_ascii_case("depleted") || balance == Decimal::ZERO;

        if depleted_like {
            sqlx::query(
                r#"
                UPDATE gift_cards SET
                    current_balance = $1,
                    card_status = 'active'::gift_card_status,
                    expires_at = $2,
                    is_liability = TRUE,
                    original_value = $1,
                    issued_session_id = COALESCE($3, issued_session_id),
                    customer_id = COALESCE($4, customer_id)
                WHERE id = $5
                "#,
            )
            .bind(amount)
            .bind(expires_at)
            .bind(session_id)
            .bind(customer_id)
            .bind(id)
            .execute(&mut **tx)
            .await?;

            sqlx::query(
                r#"
                INSERT INTO gift_card_events
                    (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id)
                VALUES ($1, 'issued', $2, $2, $3, $4)
                "#,
            )
            .bind(id)
            .bind(amount)
            .bind(transaction_id_for_events)
            .bind(session_id)
            .execute(&mut **tx)
            .await?;

            id
        } else {
            let new_balance = balance + amount;
            sqlx::query(
                r#"
                UPDATE gift_cards SET
                    current_balance = $1,
                    expires_at = GREATEST(expires_at, $2)
                WHERE id = $3
                "#,
            )
            .bind(new_balance)
            .bind(expires_at)
            .bind(id)
            .execute(&mut **tx)
            .await?;

            sqlx::query(
                r#"
                INSERT INTO gift_card_events
                    (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id)
                VALUES ($1, 'loaded', $2, $3, $4, $5)
                "#,
            )
            .bind(id)
            .bind(amount)
            .bind(new_balance)
            .bind(transaction_id_for_events)
            .bind(session_id)
            .execute(&mut **tx)
            .await?;

            id
        }
    } else {
        let new_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO gift_cards
                (code, card_kind, card_status, current_balance, original_value,
                 is_liability, expires_at, customer_id, issued_session_id, issued_transaction_id, notes)
            VALUES ($1, 'purchased', 'active', $2, $2, TRUE, $3, $4, $5, NULL, NULL)
            RETURNING id
            "#,
        )
        .bind(code)
        .bind(amount)
        .bind(expires_at)
        .bind(customer_id)
        .bind(session_id)
        .fetch_one(&mut **tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO gift_card_events
                (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id)
            VALUES ($1, 'issued', $2, $2, $3, $4)
            "#,
        )
        .bind(new_id)
        .bind(amount)
        .bind(transaction_id_for_events)
        .bind(session_id)
        .execute(&mut **tx)
        .await?;

        new_id
    };

    Ok(card_id)
}

/// Register / API: load outside checkout (no `transaction_id` on events). Prefer cart line + checkout.
pub async fn pos_load_purchased_card(
    pool: &PgPool,
    code: &str,
    amount: Decimal,
    customer_id: Option<Uuid>,
    session_id: Option<Uuid>,
) -> Result<Uuid, GiftCardOpError> {
    let mut tx = pool.begin().await?;
    let id = pos_load_purchased_in_tx(&mut tx, code.trim(), amount, customer_id, session_id, None)
        .await?;
    tx.commit().await?;
    Ok(id)
}

/// Sales Support heads-up when the legacy direct POS load API credits a card outside cart checkout.
pub async fn notify_sales_support_direct_pos_load(
    pool: &PgPool,
    code: &str,
    amount: Decimal,
    register_session_id: Option<Uuid>,
    operator_staff_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    let staff_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM staff
        WHERE is_active = TRUE AND role = 'sales_support'::staff_role
        "#,
    )
    .fetch_all(pool)
    .await?;

    if staff_ids.is_empty() {
        tracing::warn!("no active sales_support staff for gift card direct-load notifications");
        return Ok(());
    }

    let sess = register_session_id
        .map(|u| u.to_string())
        .unwrap_or_else(|| "n/a".to_string());
    let body = format!(
        "Gift card credited via direct POS load API (bypasses cart-paid flow). Code: {}. Amount: ${}. Register session: {}. Prefer the Gift card button so credit only applies when the sale is fully paid.",
        code.trim().to_ascii_uppercase(),
        amount,
        sess
    );
    let deep = json!({
        "kind": "gift_card_direct_pos_load",
        "code": code.trim().to_ascii_uppercase(),
        "amount": amount.to_string(),
        "register_session_id": register_session_id,
        "operator_staff_id": operator_staff_id,
    });
    let dedupe = format!(
        "gc_direct_load:{}:{}:{}",
        code.trim().to_ascii_uppercase(),
        amount,
        chrono::Utc::now().timestamp_subsec_millis()
    );
    let audience = json!({ "roles": ["sales_support"] });

    let nid = match crate::logic::notifications::insert_app_notification_deduped(
        pool,
        "gift_card_direct_pos_load",
        "Gift card: direct POS load API",
        &body,
        deep,
        "pos_gift_card",
        audience,
        Some(&dedupe),
    )
    .await?
    {
        Some(id) => id,
        None => return Ok(()),
    };

    crate::logic::notifications::fan_out_to_staff_ids(pool, nid, &staff_ids).await?;

    if let Some(sid) = operator_staff_id {
        let _ = crate::auth::pins::log_staff_access(
            pool,
            sid,
            "gift_card_direct_pos_load_notified",
            json!({
                "code": code.trim().to_ascii_uppercase(),
                "amount": amount.to_string(),
                "register_session_id": register_session_id,
            }),
        )
        .await;
    }

    Ok(())
}
