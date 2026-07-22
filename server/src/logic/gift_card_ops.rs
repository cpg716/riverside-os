//! In-transaction gift card balance changes shared by checkout and refunds.

use chrono::{DateTime, Duration, Utc};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub const GIFT_CARD_SUB_TYPE_PAID_LIABILITY: &str = "paid_liability";
pub const GIFT_CARD_SUB_TYPE_LOYALTY_GIVEAWAY: &str = "loyalty_giveaway";
pub const GIFT_CARD_SUB_TYPE_DONATED_GIVEAWAY: &str = "donated_giveaway";
pub const GIFT_CARD_SUB_TYPE_PROMO_GIFT_CARD: &str = "promo_gift_card";
pub const GIFT_CARD_KIND_LOYALTY_REWARD: &str = "loyalty_reward";
pub const GIFT_CARD_KIND_DONATED_GIVEAWAY: &str = "donated_giveaway";
pub const GIFT_CARD_KIND_PROMO_GIFT_CARD: &str = "promo_gift_card";

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

pub fn normalize_gift_card_code(code: &str) -> String {
    code.trim().to_ascii_uppercase()
}

fn validate_supported_non_liability_kind(card_kind: &str) -> Result<(), GiftCardOpError> {
    match card_kind {
        GIFT_CARD_KIND_LOYALTY_REWARD
        | GIFT_CARD_KIND_DONATED_GIVEAWAY
        | GIFT_CARD_KIND_PROMO_GIFT_CARD => Ok(()),
        _ => Err(GiftCardOpError::BadRequest(
            "This gift card type cannot be issued from this workflow.".to_string(),
        )),
    }
}

pub fn canonical_gift_card_sub_type_for_kind(
    card_kind: &str,
) -> Result<&'static str, GiftCardOpError> {
    let normalized = card_kind.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "purchased" => Ok(GIFT_CARD_SUB_TYPE_PAID_LIABILITY),
        "loyalty_reward" => Ok(GIFT_CARD_SUB_TYPE_LOYALTY_GIVEAWAY),
        "donated_giveaway" => Ok(GIFT_CARD_SUB_TYPE_DONATED_GIVEAWAY),
        "promo_gift_card" => Ok(GIFT_CARD_SUB_TYPE_PROMO_GIFT_CARD),
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
        GIFT_CARD_SUB_TYPE_PROMO_GIFT_CARD => "Promo",
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

    let normalized_code = normalize_gift_card_code(code);
    let card: Option<(Uuid, Decimal, String)> = sqlx::query_as(
        r#"
        SELECT id, current_balance, card_kind::text
        FROM gift_cards
        WHERE UPPER(BTRIM(code::text)) = $1
          AND card_status = 'active'::gift_card_status
          AND (expires_at IS NULL OR expires_at > now())
        FOR UPDATE
        "#,
    )
    .bind(&normalized_code)
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
    let normalized_code = normalize_gift_card_code(code);
    let row: Option<(Uuid, Decimal, String)> = sqlx::query_as(
        r#"
        SELECT id, current_balance, card_kind::text
        FROM gift_cards
        WHERE UPPER(BTRIM(code::text)) = $1
          AND card_status = 'active'::gift_card_status
          AND (expires_at IS NULL OR expires_at > now())
        FOR UPDATE
        "#,
    )
    .bind(&normalized_code)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((card_id, old_balance, card_kind)) = row else {
        return Err(GiftCardOpError::BadRequest(
            "gift card not found, inactive, or expired".into(),
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
    let normalized_code = normalize_gift_card_code(code);
    if normalized_code.is_empty() {
        return Err(GiftCardOpError::BadRequest("code is required".into()));
    }
    if amount <= Decimal::ZERO {
        return Err(GiftCardOpError::BadRequest(
            "amount must be positive".into(),
        ));
    }

    let expires_at = Utc::now() + Duration::days(365 * 9);

    let row: Option<(Uuid, String, String, Decimal, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT id, card_kind::text, card_status::text, current_balance, expires_at
        FROM gift_cards
        WHERE UPPER(BTRIM(code::text)) = $1
        FOR UPDATE
        "#,
    )
    .bind(&normalized_code)
    .fetch_optional(&mut **tx)
    .await?;

    let card_id = if let Some((id, kind, status, balance, existing_expires_at)) = row {
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

        if status.eq_ignore_ascii_case("active")
            && balance > Decimal::ZERO
            && existing_expires_at <= Utc::now()
        {
            return Err(GiftCardOpError::BadRequest(
                "this purchased gift card is expired with remaining balance; run gift card expiration/breakage review before reloading".into(),
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
                    original_value = original_value + $1,
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
        .bind(&normalized_code)
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

pub struct NonLiabilityGiftCardLoad<'a> {
    pub card_kind: &'a str,
    pub code: &'a str,
    pub amount: Decimal,
    pub customer_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub transaction_id: Option<Uuid>,
    pub notes: Option<&'a str>,
    pub promo_event_name: Option<&'a str>,
}

pub async fn load_non_liability_gift_card_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    input: NonLiabilityGiftCardLoad<'_>,
) -> Result<Uuid, GiftCardOpError> {
    validate_supported_non_liability_kind(input.card_kind)?;
    let normalized_code = normalize_gift_card_code(input.code);
    if normalized_code.is_empty() {
        return Err(GiftCardOpError::BadRequest("code is required".into()));
    }
    if input.amount <= Decimal::ZERO {
        return Err(GiftCardOpError::BadRequest(
            "amount must be positive".into(),
        ));
    }

    let expires_at = Utc::now() + Duration::days(365);
    let existing: Option<(Uuid, String, String, Decimal, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT id, card_kind::text, card_status::text, current_balance, expires_at
        FROM gift_cards
        WHERE UPPER(BTRIM(code::text)) = $1
        FOR UPDATE
        "#,
    )
    .bind(&normalized_code)
    .fetch_optional(&mut **tx)
    .await?;

    let card_id = if let Some((id, existing_kind, status, balance, existing_expires_at)) = existing
    {
        if !existing_kind.eq_ignore_ascii_case(input.card_kind) {
            return Err(GiftCardOpError::BadRequest(
                "This code belongs to a different gift card type. Use the matching card workflow instead."
                    .to_string(),
            ));
        }
        if status.eq_ignore_ascii_case("void") {
            return Err(GiftCardOpError::BadRequest(
                "this card is void and cannot be loaded".into(),
            ));
        }

        let expired = existing_expires_at <= Utc::now();
        if status.eq_ignore_ascii_case("active") && balance > Decimal::ZERO && !expired {
            let new_balance = balance + input.amount;
            sqlx::query(
                r#"
                UPDATE gift_cards
                SET current_balance = $1,
                    expires_at = GREATEST(expires_at, $2),
                    customer_id = COALESCE($3, customer_id),
                    notes = COALESCE($4, notes),
                    promo_event_name = COALESCE($5, promo_event_name)
                WHERE id = $6
                "#,
            )
            .bind(new_balance)
            .bind(expires_at)
            .bind(input.customer_id)
            .bind(input.notes)
            .bind(input.promo_event_name)
            .bind(id)
            .execute(&mut **tx)
            .await?;

            sqlx::query(
                r#"
                INSERT INTO gift_card_events
                    (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id, notes)
                VALUES ($1, 'loaded', $2, $3, $4, $5, $6)
                "#,
            )
            .bind(id)
            .bind(input.amount)
            .bind(new_balance)
            .bind(input.transaction_id)
            .bind(input.session_id)
            .bind(input.notes)
            .execute(&mut **tx)
            .await?;

            id
        } else {
            if expired && balance > Decimal::ZERO {
                sqlx::query(
                    r#"
                    INSERT INTO gift_card_events
                        (gift_card_id, event_kind, amount, balance_after, notes)
                    VALUES ($1, 'expired', $2, 0.00, $3)
                    "#,
                )
                .bind(id)
                .bind(-balance)
                .bind("Expired non-liability card balance closed before reassignment.")
                .execute(&mut **tx)
                .await?;
            }

            sqlx::query(
                r#"
                UPDATE gift_cards
                SET current_balance = $1,
                    card_status = 'active'::gift_card_status,
                    expires_at = $2,
                    original_value = COALESCE(original_value, 0) + $1,
                    customer_id = COALESCE($3, customer_id),
                    notes = COALESCE($4, notes),
                    promo_event_name = COALESCE($5, promo_event_name)
                WHERE id = $6
                "#,
            )
            .bind(input.amount)
            .bind(expires_at)
            .bind(input.customer_id)
            .bind(input.notes)
            .bind(input.promo_event_name)
            .bind(id)
            .execute(&mut **tx)
            .await?;

            sqlx::query(
                r#"
                INSERT INTO gift_card_events
                    (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id, notes)
                VALUES ($1, 'issued', $2, $2, $3, $4, $5)
                "#,
            )
            .bind(id)
            .bind(input.amount)
            .bind(input.transaction_id)
            .bind(input.session_id)
            .bind(input.notes)
            .execute(&mut **tx)
            .await?;

            id
        }
    } else {
        let new_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO gift_cards
                (code, card_kind, card_status, current_balance, original_value,
                 is_liability, expires_at, customer_id, issued_session_id, issued_order_id, promo_event_name, notes)
            VALUES ($1, $2::gift_card_kind, 'active', $3, $3, FALSE, $4, $5, $6, $7, $8, $9)
            RETURNING id
            "#,
        )
        .bind(&normalized_code)
        .bind(input.card_kind)
        .bind(input.amount)
        .bind(expires_at)
        .bind(input.customer_id)
        .bind(input.session_id)
        .bind(input.transaction_id)
        .bind(input.promo_event_name)
        .bind(input.notes)
        .fetch_one(&mut **tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO gift_card_events
                (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id, notes)
            VALUES ($1, 'issued', $2, $2, $3, $4, $5)
            "#,
        )
        .bind(new_id)
        .bind(input.amount)
        .bind(input.transaction_id)
        .bind(input.session_id)
        .bind(input.notes)
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
        assert_eq!(
            canonical_gift_card_sub_type_for_kind("promo_gift_card").unwrap(),
            GIFT_CARD_SUB_TYPE_PROMO_GIFT_CARD
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
    async fn redemption_matches_scanned_codes_case_insensitively() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let card_id = Uuid::new_v4();
        let code = format!("gc-scan-{}", Uuid::new_v4().simple());
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
            &code.to_ascii_uppercase(),
            Some(GIFT_CARD_SUB_TYPE_PAID_LIABILITY),
            Decimal::new(1000, 2),
        )
        .await
        .expect("scanner-normalized code should match stored code");

        assert_eq!(plan.card_id, card_id);
        assert_eq!(plan.new_balance, Decimal::new(1500, 2));

        tx.rollback().await.expect("rollback transaction");
    }

    #[tokio::test]
    async fn purchased_reload_reactivates_depleted_card_but_rejects_expired_positive_balance() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let depleted_id = Uuid::new_v4();
        let depleted_code = format!("GC-REUSE-{}", Uuid::new_v4().simple());
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'purchased', 'depleted', 0.00, $3, TRUE, $4)
            "#,
        )
        .bind(depleted_id)
        .bind(&depleted_code)
        .bind(Decimal::new(5000, 2))
        .bind(Utc::now() - Duration::days(1))
        .execute(&mut *tx)
        .await
        .expect("insert depleted card");

        let reused_id = pos_load_purchased_in_tx(
            &mut tx,
            &depleted_code,
            Decimal::new(3000, 2),
            None,
            None,
            None,
        )
        .await
        .expect("depleted purchased card can be reused");
        assert_eq!(reused_id, depleted_id);

        let (balance, status): (Decimal, String) = sqlx::query_as(
            "SELECT current_balance, card_status::text FROM gift_cards WHERE id = $1",
        )
        .bind(depleted_id)
        .fetch_one(&mut *tx)
        .await
        .expect("load reused card");
        assert_eq!(balance, Decimal::new(3000, 2));
        assert_eq!(status, "active");

        let expired_id = Uuid::new_v4();
        let expired_code = format!("GC-EXPIRED-{}", Uuid::new_v4().simple());
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'purchased', 'active', $3, $3, TRUE, $4)
            "#,
        )
        .bind(expired_id)
        .bind(&expired_code)
        .bind(Decimal::new(1200, 2))
        .bind(Utc::now() - Duration::days(1))
        .execute(&mut *tx)
        .await
        .expect("insert expired card");

        let error = pos_load_purchased_in_tx(
            &mut tx,
            &expired_code,
            Decimal::new(1000, 2),
            None,
            None,
            None,
        )
        .await
        .expect_err("expired purchased balance must not be resurrected");
        assert!(error.to_string().contains("breakage review"));

        tx.rollback().await.expect("rollback transaction");
    }

    #[tokio::test]
    async fn non_liability_load_reuses_depleted_card_and_closes_expired_balance() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let depleted_id = Uuid::new_v4();
        let depleted_code = format!("LOY-REUSE-{}", Uuid::new_v4().simple());
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'loyalty_reward', 'depleted', 0.00, $3, FALSE, $4)
            "#,
        )
        .bind(depleted_id)
        .bind(&depleted_code)
        .bind(Decimal::new(1000, 2))
        .bind(Utc::now() - Duration::days(1))
        .execute(&mut *tx)
        .await
        .expect("insert depleted loyalty card");

        let reused_id = load_non_liability_gift_card_in_tx(
            &mut tx,
            NonLiabilityGiftCardLoad {
                card_kind: GIFT_CARD_KIND_LOYALTY_REWARD,
                code: &depleted_code,
                amount: Decimal::new(1500, 2),
                customer_id: None,
                session_id: None,
                transaction_id: None,
                notes: None,
                promo_event_name: None,
            },
        )
        .await
        .expect("depleted loyalty card can be reused");
        assert_eq!(reused_id, depleted_id);

        let expired_id = Uuid::new_v4();
        let expired_code = format!("DON-EXPIRED-{}", Uuid::new_v4().simple());
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'donated_giveaway', 'active', $3, $3, FALSE, $4)
            "#,
        )
        .bind(expired_id)
        .bind(&expired_code)
        .bind(Decimal::new(2000, 2))
        .bind(Utc::now() - Duration::days(1))
        .execute(&mut *tx)
        .await
        .expect("insert expired donated card");

        let reassigned_id = load_non_liability_gift_card_in_tx(
            &mut tx,
            NonLiabilityGiftCardLoad {
                card_kind: GIFT_CARD_KIND_DONATED_GIVEAWAY,
                code: &expired_code,
                amount: Decimal::new(500, 2),
                customer_id: None,
                session_id: None,
                transaction_id: None,
                notes: Some("new donation"),
                promo_event_name: None,
            },
        )
        .await
        .expect("expired non-liability card can be reassigned without resurrecting old balance");
        assert_eq!(reassigned_id, expired_id);

        let balance: Decimal =
            sqlx::query_scalar("SELECT current_balance FROM gift_cards WHERE id = $1")
                .bind(expired_id)
                .fetch_one(&mut *tx)
                .await
                .expect("load reassigned card balance");
        assert_eq!(balance, Decimal::new(500, 2));

        let expired_event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM gift_card_events WHERE gift_card_id = $1 AND event_kind = 'expired'",
        )
        .bind(expired_id)
        .fetch_one(&mut *tx)
        .await
        .expect("load expired event count");
        assert_eq!(expired_event_count, 1);

        tx.rollback().await.expect("rollback transaction");
    }

    #[tokio::test]
    async fn refund_credit_records_refunded_event_and_returns_visibility_details() {
        let Ok(database_url) =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"))
        else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let card_id = Uuid::new_v4();
        let code = format!("GC-REFUND-{}", Uuid::new_v4().simple());
        let session_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO register_sessions (
                id, opening_float, is_open, lifecycle_status, register_lane, till_close_group_id
            )
            VALUES ($1, 0.00, FALSE, 'closed', 99, $2)
            "#,
        )
        .bind(session_id)
        .bind(Uuid::new_v4())
        .execute(&mut *tx)
        .await
        .expect("insert gift card refund test register session");

        let transaction_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO transactions (
                id, display_id, total_price, amount_paid, balance_due, register_session_id
            )
            VALUES ($1, $2, 0.00, 0.00, 0.00, $3)
            "#,
        )
        .bind(transaction_id)
        .bind(format!("TXN-GC-REFUND-{}", transaction_id.simple()))
        .bind(session_id)
        .execute(&mut *tx)
        .await
        .expect("insert gift card refund test transaction");
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
