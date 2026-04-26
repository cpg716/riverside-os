//! In-transaction gift card balance changes shared by checkout and refunds.

use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub const GIFT_CARD_SUB_TYPE_PAID_LIABILITY: &str = "paid_liability";
pub const GIFT_CARD_SUB_TYPE_LOYALTY_GIVEAWAY: &str = "loyalty_giveaway";
pub const GIFT_CARD_SUB_TYPE_DONATED_GIVEAWAY: &str = "donated_giveaway";

#[derive(Debug, thiserror::Error)]
pub enum GiftCardOpError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiftCardRedemptionPlan {
    pub card_id: Uuid,
    pub card_kind: String,
    pub canonical_sub_type: String,
    pub current_balance: Decimal,
    pub new_balance: Decimal,
    pub new_status: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiftCardCreditPlan {
    pub card_id: Uuid,
    pub card_kind: String,
    pub normalized_code: String,
    pub new_balance: Decimal,
}

pub fn canonical_gift_card_sub_type_for_kind(
    card_kind: &str,
) -> Result<&'static str, GiftCardOpError> {
    let normalized = card_kind.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "purchased" => Ok(GIFT_CARD_SUB_TYPE_PAID_LIABILITY),
        "loyalty_reward" => Ok(GIFT_CARD_SUB_TYPE_LOYALTY_GIVEAWAY),
        "donated_giveaway" => Ok(GIFT_CARD_SUB_TYPE_DONATED_GIVEAWAY),
        _ => Err(GiftCardOpError::BadRequest(
            "This gift card type is not supported at checkout. Please ask a manager for help."
                .to_string(),
        )),
    }
}

fn gift_card_sub_type_label(sub_type: &str) -> &'static str {
    match sub_type.trim() {
        GIFT_CARD_SUB_TYPE_PAID_LIABILITY => "Paid",
        GIFT_CARD_SUB_TYPE_LOYALTY_GIVEAWAY => "Loyalty",
        GIFT_CARD_SUB_TYPE_DONATED_GIVEAWAY => "Donated",
        _ => "Gift Card",
    }
}

pub async fn prepare_redemption_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    code: &str,
    requested_sub_type: Option<&str>,
    amount: Decimal,
) -> Result<GiftCardRedemptionPlan, GiftCardOpError> {
    if amount <= Decimal::ZERO {
        return Err(GiftCardOpError::BadRequest(
            "Gift card payment amount must be greater than zero.".to_string(),
        ));
    }

    let card: Option<(Uuid, Decimal, String)> = sqlx::query_as(
        r#"
        SELECT id, current_balance, card_kind::text
        FROM gift_cards
        WHERE code = $1
          AND card_status = 'active'::gift_card_status
          AND (expires_at IS NULL OR expires_at > now())
        FOR UPDATE
        "#,
    )
    .bind(code)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((card_id, current_balance, card_kind)) = card else {
        return Err(GiftCardOpError::BadRequest(
            "This gift card could not be used. Check the code and try again.".to_string(),
        ));
    };

    let canonical_sub_type = canonical_gift_card_sub_type_for_kind(&card_kind)?.to_string();
    if let Some(requested) = requested_sub_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !requested.eq_ignore_ascii_case(&canonical_sub_type) {
            return Err(GiftCardOpError::BadRequest(format!(
                "This card must be used as {}. Choose the matching gift card type and try again.",
                gift_card_sub_type_label(&canonical_sub_type)
            )));
        }
    }

    if current_balance < amount {
        return Err(GiftCardOpError::BadRequest(format!(
            "This gift card only has ${current_balance} available."
        )));
    }

    let new_balance = current_balance - amount;
    let new_status = if new_balance == Decimal::ZERO {
        "depleted"
    } else {
        "active"
    };

    Ok(GiftCardRedemptionPlan {
        card_id,
        card_kind,
        canonical_sub_type,
        current_balance,
        new_balance,
        new_status,
    })
}

/// Credit an active gift card (idempotent-friendly: caller runs inside order refund tx).
pub async fn credit_gift_card_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    code: &str,
    amount: Decimal,
    transaction_id: Uuid,
    session_id: Uuid,
) -> Result<GiftCardCreditPlan, GiftCardOpError> {
    if amount <= Decimal::ZERO {
        return Err(GiftCardOpError::BadRequest(
            "credit amount must be positive".into(),
        ));
    }
    let trimmed_code = code.trim().to_string();
    let normalized_code = trimmed_code.to_ascii_uppercase();
    let row: Option<(Uuid, Decimal, String)> = sqlx::query_as(
        r#"
        SELECT id, current_balance, card_kind::text
        FROM gift_cards
        WHERE code = $1 AND card_status = 'active'::gift_card_status
        FOR UPDATE
        "#,
    )
    .bind(&trimmed_code)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((card_id, old_balance, card_kind)) = row else {
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
        VALUES ($1, 'refunded', $2, $3, $4, $5)
        "#,
    )
    .bind(card_id)
    .bind(amount)
    .bind(new_balance)
    .bind(transaction_id)
    .bind(session_id)
    .execute(&mut **tx)
    .await?;

    Ok(GiftCardCreditPlan {
        card_id,
        card_kind,
        normalized_code,
        new_balance,
    })
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
                 is_liability, expires_at, customer_id, issued_session_id, issued_order_id, notes)
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
    let normalized_code = code.trim().to_ascii_uppercase();
    let body = format!(
        "Gift card {normalized_code} was loaded for ${amount} outside checkout on register session {sess}. Review the sale flow if this credit should have waited for full payment."
    );
    let deep = json!({
        "kind": "gift_card_direct_pos_load",
        "code": normalized_code,
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
        "Gift card loaded outside checkout",
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

    crate::logic::notifications::fan_out_notification_to_staff_ids(pool, nid, &staff_ids).await?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use rust_decimal::Decimal;
    use sqlx::Connection;

    #[test]
    fn canonical_sub_type_follows_card_kind() {
        assert_eq!(
            canonical_gift_card_sub_type_for_kind("purchased").unwrap(),
            GIFT_CARD_SUB_TYPE_PAID_LIABILITY
        );
        assert_eq!(
            canonical_gift_card_sub_type_for_kind("loyalty_reward").unwrap(),
            GIFT_CARD_SUB_TYPE_LOYALTY_GIVEAWAY
        );
        assert_eq!(
            canonical_gift_card_sub_type_for_kind("donated_giveaway").unwrap(),
            GIFT_CARD_SUB_TYPE_DONATED_GIVEAWAY
        );
    }

    #[tokio::test]
    async fn redemption_blocks_sub_type_mismatch() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let card_id = Uuid::new_v4();
        let code = format!("GC-MISMATCH-{}", Uuid::new_v4().simple());
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'donated_giveaway', 'active', $3, $3, FALSE, $4)
            "#,
        )
        .bind(card_id)
        .bind(&code)
        .bind(Decimal::new(5000, 2))
        .bind(Utc::now() + Duration::days(30))
        .execute(&mut *tx)
        .await
        .expect("insert card");

        let error = prepare_redemption_in_tx(
            &mut tx,
            &code,
            Some(GIFT_CARD_SUB_TYPE_PAID_LIABILITY),
            Decimal::new(1000, 2),
        )
        .await
        .expect_err("mismatched subtype should fail");

        match error {
            GiftCardOpError::BadRequest(message) => {
                assert!(message.contains("must be used as Donated"));
            }
            other => panic!("expected bad request, got {other:?}"),
        }

        tx.rollback().await.expect("rollback transaction");
    }

    #[tokio::test]
    async fn redemption_reports_insufficient_balance() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let card_id = Uuid::new_v4();
        let code = format!("GC-LOWBAL-{}", Uuid::new_v4().simple());
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'purchased', 'active', $3, $3, TRUE, $4)
            "#,
        )
        .bind(card_id)
        .bind(&code)
        .bind(Decimal::new(500, 2))
        .bind(Utc::now() + Duration::days(30))
        .execute(&mut *tx)
        .await
        .expect("insert card");

        let error = prepare_redemption_in_tx(
            &mut tx,
            &code,
            Some(GIFT_CARD_SUB_TYPE_PAID_LIABILITY),
            Decimal::new(1000, 2),
        )
        .await
        .expect_err("insufficient balance should fail");

        match error {
            GiftCardOpError::BadRequest(message) => {
                assert!(message.contains("only has $5.00 available"));
            }
            other => panic!("expected bad request, got {other:?}"),
        }

        tx.rollback().await.expect("rollback transaction");
    }

    #[tokio::test]
    async fn redemption_accepts_matching_purchased_card_sub_type() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let card_id = Uuid::new_v4();
        let code = format!("GC-PAID-{}", Uuid::new_v4().simple());
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'purchased', 'active', $3, $3, TRUE, $4)
            "#,
        )
        .bind(card_id)
        .bind(&code)
        .bind(Decimal::new(2500, 2))
        .bind(Utc::now() + Duration::days(30))
        .execute(&mut *tx)
        .await
        .expect("insert card");

        let plan = prepare_redemption_in_tx(
            &mut tx,
            &code,
            Some(GIFT_CARD_SUB_TYPE_PAID_LIABILITY),
            Decimal::new(1000, 2),
        )
        .await
        .expect("matching subtype should succeed");

        assert_eq!(plan.card_kind, "purchased");
        assert_eq!(plan.canonical_sub_type, GIFT_CARD_SUB_TYPE_PAID_LIABILITY);
        assert_eq!(plan.new_balance, Decimal::new(1500, 2));
        assert_eq!(plan.new_status, "active");

        tx.rollback().await.expect("rollback transaction");
    }

    #[tokio::test]
    async fn refund_credit_records_refunded_event_and_returns_visibility_details() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let card_id = Uuid::new_v4();
        let code = format!("GC-REFUND-{}", Uuid::new_v4().simple());
        let transaction_id: Uuid = sqlx::query_scalar("SELECT id FROM transactions LIMIT 1")
            .fetch_one(&mut *tx)
            .await
            .expect("existing transaction");
        let session_id: Uuid = sqlx::query_scalar("SELECT id FROM register_sessions LIMIT 1")
            .fetch_one(&mut *tx)
            .await
            .expect("existing register session");
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'purchased', 'active', $3, $3, TRUE, $4)
            "#,
        )
        .bind(card_id)
        .bind(&code)
        .bind(Decimal::new(1200, 2))
        .bind(Utc::now() + Duration::days(30))
        .execute(&mut *tx)
        .await
        .expect("insert card");

        let plan = credit_gift_card_in_tx(
            &mut tx,
            &code,
            Decimal::new(500, 2),
            transaction_id,
            session_id,
        )
        .await
        .expect("refund credit should succeed");

        assert_eq!(plan.card_kind, "purchased");
        assert_eq!(plan.normalized_code, code.to_ascii_uppercase());
        assert_eq!(plan.new_balance, Decimal::new(1700, 2));

        let event_kind: Option<String> = sqlx::query_scalar(
            "SELECT event_kind FROM gift_card_events WHERE gift_card_id = $1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(card_id)
        .fetch_optional(&mut *tx)
        .await
        .expect("load latest event");
        assert_eq!(event_kind.as_deref(), Some("refunded"));

        tx.rollback().await.expect("rollback transaction");
    }
}
