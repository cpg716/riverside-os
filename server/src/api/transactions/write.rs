use super::helpers::{
    authorize_transaction_modify_bo_or_register, insert_transaction_activity_log_tx,
    log_order_activity, map_perm_err, spawn_meilisearch_transaction_upsert,
};
use super::TransactionError;
use super::{
    read::{load_transaction_detail, TransactionDetailResponse},
    CheckoutRequest, CheckoutResponse,
};
use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, ORDERS_CANCEL, ORDERS_EDIT_ATTRIBUTION,
    ORDERS_MODIFY, ORDERS_SUIT_COMPONENT_SWAP, ORDERS_VOID_SALE,
};
use crate::auth::pins::{self, log_staff_access};
use crate::logic::loyalty as loyalty_logic;
use crate::logic::suit_component_swap::{self, SuitSwapInput, SuitSwapOutcome};
use crate::logic::transaction_recalc;
use crate::middleware;
use crate::models::{DbFulfillmentType, DbOrderStatus};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json, Router,
};
use chrono::Utc;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Postgres};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct PatchTransactionRequest {
    pub status: Option<DbOrderStatus>,
    pub forfeiture_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PickupTransactionRequest {
    #[serde(default)]
    pub delivered_item_ids: Vec<Uuid>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct AddTransactionLineRequest {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub fulfillment: DbFulfillmentType,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub unit_cost: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    #[serde(default)]
    pub salesperson_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchTransactionLineRequest {
    pub quantity: Option<i32>,
    pub unit_price: Option<Decimal>,
    pub fulfillment: Option<DbFulfillmentType>,
}

#[derive(Debug, Deserialize)]
pub struct SuitComponentSwapRequest {
    pub in_variant_id: Uuid,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub unit_price: Option<Decimal>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchOrderAttributionRequest {
    pub manager_cashier_code: String,
    #[serde(default)]
    pub manager_pin: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub primary_salesperson_id: Option<Uuid>,
    #[serde(default)]
    pub line_attribution: Vec<LineAttributionUpdate>,
}

#[derive(Debug, Deserialize)]
pub struct LineAttributionUpdate {
    pub transaction_line_id: Uuid,
    #[serde(default)]
    pub salesperson_id: Option<Uuid>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/checkout", axum::routing::post(checkout))
        .route("/{transaction_id}", axum::routing::patch(patch_transaction))
        .route(
            "/{transaction_id}/pickup",
            axum::routing::post(mark_transaction_pickup),
        )
        .route(
            "/{transaction_id}/attribution",
            axum::routing::patch(patch_transaction_attribution),
        )
        .route(
            "/{transaction_id}/items",
            axum::routing::post(add_transaction_line),
        )
        .route(
            "/{transaction_id}/items/{transaction_line_id}",
            axum::routing::patch(update_transaction_line).delete(delete_transaction_line),
        )
        .route(
            "/{transaction_id}/items/{transaction_line_id}/suit-swap",
            axum::routing::post(post_suit_component_swap),
        )
}

async fn staff_id_active(pool: &PgPool, id: Uuid) -> Result<bool, TransactionError> {
    let ok: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1 AND is_active = TRUE)")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(ok)
}

pub async fn checkout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CheckoutRequest>,
) -> Result<Json<CheckoutResponse>, TransactionError> {
    middleware::require_pos_register_session_for_checkout(&state, &headers, payload.session_id)
        .await
        .map_err(|(status, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            if status == StatusCode::UNAUTHORIZED {
                TransactionError::Unauthorized(msg)
            } else {
                TransactionError::InvalidPayload(msg)
            }
        })?;

    use crate::logic::transaction_checkout::{execute_checkout, CheckoutDone};
    let outcome = execute_checkout(
        &state.db,
        &state.http_client,
        state.global_employee_markup,
        payload,
    )
    .await?;

    match outcome {
        CheckoutDone::Idempotent {
            transaction_id,
            display_id,
        } => {
            spawn_meilisearch_transaction_upsert(&state, transaction_id);
            Ok(Json(CheckoutResponse {
                transaction_id,
                transaction_display_id: display_id,
                status: "success".to_string(),
                loyalty_points_earned: 0,
                loyalty_points_balance: None,
            }))
        }
        CheckoutDone::Completed {
            transaction_id,
            display_id,
            operator_staff_id,
            customer_id: _,
            price_override_audit,
            amount_paid,
            total_price,
        } => {
            for detail in price_override_audit {
                let _ = log_staff_access(
                    &state.db,
                    operator_staff_id,
                    "price_override",
                    json!({ "transaction_id": transaction_id, "detail": detail }),
                )
                .await;
            }
            let _ = log_staff_access(&state.db, operator_staff_id, "checkout_auth", json!({ "transaction_id": transaction_id, "amount_paid": amount_paid, "total_price": total_price })).await;

            let accrual_res = loyalty_logic::try_accrue_for_order(&state.db, transaction_id).await;
            let (earned, balance) = match accrual_res {
                Ok(Some(o)) => (o.points_earned, Some(o.balance_after)),
                _ => (0, None),
            };

            spawn_meilisearch_transaction_upsert(&state, transaction_id);

            if let Ok(url_raw) = std::env::var("RIVERSIDE_WEBHOOK_URL") {
                let target_url = url_raw.trim().to_string();
                if !target_url.is_empty() {
                    let d_id = display_id.clone();
                    let ap = amount_paid.to_string();
                    let tp = total_price.to_string();
                    tokio::spawn(async move {
                        let client = reqwest::Client::new();
                        let _ = client.post(&target_url).json(&json!({ "event": "transaction.finalized", "transaction_id": transaction_id, "transaction_display_id": d_id, "amount_paid": ap, "total_price": tp, "loyalty_points_earned": earned })).send().await;
                    });
                }
            }

            Ok(Json(CheckoutResponse {
                transaction_id,
                transaction_display_id: display_id,
                status: "success".to_string(),
                loyalty_points_earned: earned,
                loyalty_points_balance: balance,
            }))
        }
    }
}

async fn patch_transaction(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchTransactionRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    if let Some(status) = body.status {
        if status == DbOrderStatus::Cancelled {
            let refundable: Decimal = sqlx::query_scalar("SELECT COALESCE(SUM(amount_allocated), 0) FROM payment_allocations WHERE target_transaction_id = $1").bind(transaction_id).fetch_one(&state.db).await?;
            if refundable > Decimal::ZERO {
                middleware::require_staff_with_permission(&state, &headers, ORDERS_CANCEL)
                    .await
                    .map_err(map_perm_err)?;
            } else {
                let staff = middleware::require_authenticated_staff_headers(&state, &headers)
                    .await
                    .map_err(map_perm_err)?;
                let eff = effective_permissions_for_staff(&state.db, staff.id, staff.role).await?;
                if !staff_has_permission(&eff, ORDERS_CANCEL)
                    && !staff_has_permission(&eff, ORDERS_VOID_SALE)
                {
                    return Err(TransactionError::Forbidden(
                        "cancel or void_sale permission required".into(),
                    ));
                }
            }
        } else {
            middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
                .await
                .map_err(map_perm_err)?;
        }
    }

    let mut qb = sqlx::QueryBuilder::<Postgres>::new("UPDATE transactions SET ");
    let mut sep = qb.separated(", ");
    let mut touched = false;
    if let Some(s) = body.status {
        sep.push("status = ").push_bind(s);
        touched = true;
    }
    if let Some(f) = body.forfeiture_reason {
        sep.push("forfeiture_reason = ").push_bind(f);
        if touched {
            sep.push("forfeited_at = ").push_bind(Utc::now());
        } else {
            touched = true;
        }
    }
    if touched {
        qb.push(" WHERE id = ").push_bind(transaction_id);
        qb.build().execute(&state.db).await?;
        spawn_meilisearch_transaction_upsert(&state, transaction_id);
    }

    Ok(Json(
        load_transaction_detail(&state.db, transaction_id).await?,
    ))
}

async fn mark_transaction_pickup(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PickupTransactionRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    let _staff_id = authorize_transaction_modify_bo_or_register(
        &state,
        &headers,
        transaction_id,
        body.register_session_id,
    )
    .await?;
    let mut tx = state.db.begin().await?;

    let rows_affected = if body.delivered_item_ids.is_empty() {
        sqlx::query("UPDATE transaction_lines SET is_fulfilled = true, fulfilled_at = NOW() WHERE transaction_id = $1 AND is_fulfilled = false AND is_internal = false")
            .bind(transaction_id).execute(&mut *tx).await?.rows_affected()
    } else {
        sqlx::query("UPDATE transaction_lines SET is_fulfilled = true, fulfilled_at = NOW() WHERE transaction_id = $1 AND id = ANY($2) AND is_fulfilled = false")
            .bind(transaction_id).bind(&body.delivered_item_ids).execute(&mut *tx).await?.rows_affected()
    };

    if rows_affected > 0 {
        let all_fulfilled: bool = sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM transaction_lines WHERE transaction_id = $1 AND is_fulfilled = false AND is_internal = false)")
            .bind(transaction_id).fetch_one(&mut *tx).await?;
        if all_fulfilled {
            sqlx::query(
                "UPDATE transactions SET status = 'fulfilled' WHERE id = $1 AND status = 'booked'",
            )
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;

    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    log_order_activity(
        &state.db,
        transaction_id,
        detail.customer.as_ref().map(|c| c.id),
        "pickup",
        &format!(
            "Items picked up by {}",
            body.actor.as_deref().unwrap_or("customer")
        ),
        json!({ "item_ids": body.delivered_item_ids }),
    )
    .await?;
    spawn_meilisearch_transaction_upsert(&state, transaction_id);

    Ok(Json(detail))
}

async fn patch_transaction_attribution(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Json(body): Json<PatchOrderAttributionRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    let admin = pins::authenticate_pos_staff(
        &state.db,
        body.manager_cashier_code.trim(),
        body.manager_pin.as_deref(),
    )
    .await
    .map_err(|_| TransactionError::Unauthorized("valid manager credentials required".into()))?;
    let eff = effective_permissions_for_staff(&state.db, admin.id, admin.role).await?;
    if !staff_has_permission(&eff, ORDERS_EDIT_ATTRIBUTION) {
        return Err(TransactionError::Forbidden(
            "missing transactions.edit_attribution".into(),
        ));
    }

    if let Some(pid) = body.primary_salesperson_id {
        if !staff_id_active(&state.db, pid).await? {
            return Err(TransactionError::InvalidPayload(
                "invalid primary_salesperson_id".into(),
            ));
        }
    }

    let mut tx = state.db.begin().await?;
    if let Some(pid) = body.primary_salesperson_id {
        sqlx::query("UPDATE transactions SET primary_salesperson_id = $1 WHERE id = $2")
            .bind(pid)
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;
    }

    for line in &body.line_attribution {
        if let Some(sid) = line.salesperson_id {
            if !staff_id_active(&state.db, sid).await? {
                return Err(TransactionError::InvalidPayload(format!(
                    "invalid salesperson for line {}",
                    line.transaction_line_id
                )));
            }
        }
        sqlx::query("UPDATE transaction_lines SET salesperson_id = $1 WHERE id = $2 AND transaction_id = $3")
            .bind(line.salesperson_id).bind(line.transaction_line_id).bind(transaction_id).execute(&mut *tx).await?;
    }

    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn add_transaction_line(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<AddTransactionLineRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    let mut tx = state.db.begin().await?;
    let wedding_member_id: Option<Uuid> =
        sqlx::query_scalar("SELECT wedding_member_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;
    let fulfillment = crate::logic::transaction_fulfillment::persist_fulfillment(
        wedding_member_id,
        body.fulfillment,
    )
    .map_err(|e| TransactionError::InvalidPayload(e.to_string()))?;

    sqlx::query("INSERT INTO transaction_lines (transaction_id, product_id, variant_id, fulfillment, quantity, unit_price, unit_cost, state_tax, local_tax, is_fulfilled, salesperson_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(transaction_id).bind(body.product_id).bind(body.variant_id).bind(fulfillment).bind(body.quantity).bind(body.unit_price).bind(body.unit_cost).bind(body.state_tax).bind(body.local_tax).bind(false).bind(body.salesperson_id).execute(&mut *tx).await?;

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id).await?;
    tx.commit().await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    log_order_activity(
        &state.db,
        transaction_id,
        detail.customer.as_ref().map(|c| c.id),
        "item_added",
        "Item added",
        json!({ "product_id": body.product_id, "variant_id": body.variant_id }),
    )
    .await?;
    Ok(Json(detail))
}

pub async fn update_transaction_line(
    State(state): State<AppState>,
    Path((transaction_id, transaction_line_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<PatchTransactionLineRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    let mut tx = state.db.begin().await?;
    let wedding_member_id: Option<Uuid> =
        sqlx::query_scalar("SELECT wedding_member_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;

    let mut qb = sqlx::QueryBuilder::<Postgres>::new("UPDATE transaction_lines SET ");
    let mut sep = qb.separated(", ");
    let mut touched = false;
    if let Some(q) = body.quantity {
        sep.push("quantity = ").push_bind(q);
        touched = true;
    }
    if let Some(p) = body.unit_price {
        sep.push("unit_price = ").push_bind(p);
        touched = true;
    }
    if let Some(f) = body.fulfillment {
        let nf = crate::logic::transaction_fulfillment::persist_fulfillment(wedding_member_id, f)
            .map_err(|e| TransactionError::InvalidPayload(e.to_string()))?;
        sep.push("fulfillment = ").push_bind(nf);
        touched = true;
    }
    if touched {
        qb.push(" WHERE id = ")
            .push_bind(transaction_line_id)
            .push(" AND transaction_id = ")
            .push_bind(transaction_id);
        qb.build().execute(&mut *tx).await?;
    }

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id).await?;
    tx.commit().await?;
    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    log_order_activity(
        &state.db,
        transaction_id,
        detail.customer.as_ref().map(|c| c.id),
        "item_updated",
        "Line updated",
        json!({ "line_id": transaction_line_id }),
    )
    .await?;
    Ok(Json(detail))
}

pub async fn delete_transaction_line(
    State(state): State<AppState>,
    Path((transaction_id, transaction_line_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
        .await
        .map_err(map_perm_err)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM transaction_lines WHERE id = $1 AND transaction_id = $2")
        .bind(transaction_line_id)
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id).await?;
    tx.commit().await?;
    let cid: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_one(&state.db)
            .await?;
    log_order_activity(
        &state.db,
        transaction_id,
        cid,
        "item_deleted",
        "Line removed",
        json!({ "line_id": transaction_line_id }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn post_suit_component_swap(
    State(state): State<AppState>,
    Path((transaction_id, transaction_line_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<SuitComponentSwapRequest>,
) -> Result<Json<SuitSwapOutcome>, TransactionError> {
    let staff_id = if let Some(reg_sid) = body.register_session_id {
        authorize_transaction_modify_bo_or_register(
            &state,
            &headers,
            transaction_id,
            Some(reg_sid),
        )
        .await?;
        sqlx::query_scalar(
            "SELECT opened_by FROM register_sessions WHERE id = $1 AND lifecycle_status = 'open'",
        )
        .bind(reg_sid)
        .fetch_one(&state.db)
        .await?
    } else {
        let staff = middleware::require_authenticated_staff_headers(&state, &headers)
            .await
            .map_err(map_perm_err)?;
        let eff = effective_permissions_for_staff(&state.db, staff.id, staff.role).await?;
        if !staff_has_permission(&eff, ORDERS_MODIFY)
            || !staff_has_permission(&eff, ORDERS_SUIT_COMPONENT_SWAP)
        {
            return Err(TransactionError::Forbidden(
                "missing swap permissions".into(),
            ));
        }
        Some(staff.id)
    };

    let mut tx = state.db.begin().await?;
    let outcome = suit_component_swap::execute_suit_component_swap(
        &mut tx,
        transaction_id,
        transaction_line_id,
        staff_id,
        state.global_employee_markup,
        SuitSwapInput {
            in_variant_id: body.in_variant_id,
            note: body.note,
            unit_price: body.unit_price,
            unit_cost: body.unit_cost,
        },
    )
    .await?;

    let cid: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    insert_transaction_activity_log_tx(
        &mut tx,
        transaction_id,
        cid,
        "suit_component_swap",
        &format!("Swapped {} -> {}", outcome.old_sku, outcome.new_sku),
        json!({ "event_id": outcome.event_id }),
    )
    .await?;
    tx.commit().await?;

    if let Some(sid) = staff_id {
        let _ = log_staff_access(
            &state.db,
            sid,
            "suit_component_swap",
            json!({ "transaction_id": transaction_id }),
        )
        .await;
    }
    Ok(Json(outcome))
}
