//! Machine-to-machine ingest for Counterpoint Windows bridge (`COUNTERPOINT_SYNC_TOKEN`).
//! Also provides staff-gated settings endpoints for monitoring bridge status.

use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{extract::State, Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::SETTINGS_ADMIN;
use crate::logic::counterpoint_staging;
use crate::logic::counterpoint_sync::{
    self, build_counterpoint_inventory_verification_report,
    build_counterpoint_landing_verification_summary,
    build_counterpoint_open_docs_verification_snapshot,
    build_counterpoint_transaction_reconciliation_snapshot, execute_counterpoint_catalog_batch,
    execute_counterpoint_category_masters_batch, execute_counterpoint_customer_batch,
    execute_counterpoint_customer_notes_batch, execute_counterpoint_gift_card_batch,
    execute_counterpoint_inventory_batch, execute_counterpoint_loyalty_hist_batch,
    execute_counterpoint_open_doc_batch, execute_counterpoint_sls_rep_stub_batch,
    execute_counterpoint_staff_batch, execute_counterpoint_store_credit_opening_batch,
    execute_counterpoint_ticket_batch, execute_counterpoint_vendor_batch,
    execute_counterpoint_vendor_item_batch, CounterpointCatalogPayload,
    CounterpointCategoryMastersPayload, CounterpointCustomerNotesPayload,
    CounterpointCustomersPayload, CounterpointGiftCardsPayload, CounterpointInventoryPayload,
    CounterpointLoyaltyHistPayload, CounterpointOpenDocsPayload, CounterpointSlsRepStubPayload,
    CounterpointStaffPayload, CounterpointStoreCreditOpeningPayload, CounterpointSyncError,
    CounterpointTicketsPayload, CounterpointVendorItemsPayload, CounterpointVendorsPayload,
    HeartbeatPayload,
};
use crate::middleware;

const VALID_GIFT_CARD_KINDS: [&str; 3] = ["purchased", "loyalty_reward", "donated_giveaway"];

fn validate_sync_token(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let Some(expected) = state.counterpoint_sync_token.as_deref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "counterpoint sync is not configured (set COUNTERPOINT_SYNC_TOKEN)"
            })),
        ));
    };
    let header_token = headers
        .get("x-ros-sync-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").map(str::trim));
    let ok = match header_token.or(bearer) {
        Some(p) => p == expected,
        None => false,
    };
    if !ok {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid or missing sync token" })),
        ));
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// M2M ingest endpoints (bridge → ROS)
// ────────────────────────────────────────────────────────────────────────────

async fn cp_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let counterpoint_staging_enabled =
        counterpoint_staging::counterpoint_staging_enabled(&state.db)
            .await
            .unwrap_or(false);
    Ok(Json(json!({
        "ok": true,
        "service": "counterpoint_sync",
        "counterpoint_staging_enabled": counterpoint_staging_enabled
    })))
}

#[derive(Deserialize)]
struct CpStagingIngestBody {
    entity: String,
    payload: serde_json::Value,
}

async fn cp_staging(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CpStagingIngestBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let staging_on = counterpoint_staging::counterpoint_staging_enabled(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    if !staging_on {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": "counterpoint staging is disabled — enable it in Settings → Integrations → Counterpoint" }),
            ),
        ));
    }
    let entity = body.entity.trim();
    if entity.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "entity required" })),
        ));
    }
    let ver = headers
        .get("x-bridge-version")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let host = headers
        .get("x-bridge-hostname")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let id = counterpoint_staging::insert_staging_batch(&state.db, entity, body.payload, ver, host)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!({ "ok": true, "staging_batch_id": id })))
}

async fn cp_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HeartbeatPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    match counterpoint_sync::upsert_heartbeat(&state.db, &payload).await {
        Ok(resp) => Ok(Json(serde_json::to_value(resp).unwrap_or_default())),
        Err(e) => {
            tracing::error!(error = %e, "heartbeat upsert failed");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

async fn cp_ack_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let request_id = body
        .get("request_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "request_id required" })),
            )
        })?;
    let _ = counterpoint_sync::ack_sync_request(&state.db, request_id).await;
    Ok(Json(json!({ "ok": true })))
}

async fn cp_complete_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let request_id = body
        .get("request_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "request_id required" })),
            )
        })?;
    let error = body.get("error").and_then(|v| v.as_str());
    let _ = counterpoint_sync::complete_sync_request(&state.db, request_id, error).await;
    Ok(Json(json!({ "ok": true })))
}

async fn cp_run_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<counterpoint_sync::SyncCursorIn>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    counterpoint_sync::begin_sync_run(&state.db, payload.entity.trim(), payload.cursor.as_deref())
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!({ "ok": true })))
}

async fn cp_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointCustomersPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_customer_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "customers",
                batch_size = n,
                created = summary.created,
                updated = summary.updated,
                skipped = summary.skipped,
                email_conflicts = summary.email_conflicts,
                "counterpoint customer batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "customers", batch_size = n, "counterpoint customer batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "customers",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_inventory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointInventoryPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_inventory_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "inventory",
                batch_size = n,
                updated = summary.updated,
                skipped = summary.skipped,
                "counterpoint inventory batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "inventory", batch_size = n, "counterpoint inventory batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "inventory",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_category_masters(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointCategoryMastersPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_category_masters_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "category_masters",
                batch_size = n,
                categories_created = summary.categories_created,
                maps_upserted = summary.maps_upserted,
                skipped = summary.skipped,
                already_mapped = summary.already_mapped,
                "counterpoint category masters batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                entity = "category_masters",
                batch_size = n,
                "counterpoint category masters batch failed"
            );
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "category_masters",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointCatalogPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_catalog_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "catalog",
                batch_size = n,
                products_created = summary.products_created,
                products_updated = summary.products_updated,
                variants_created = summary.variants_created,
                variants_updated = summary.variants_updated,
                skipped = summary.skipped,
                "counterpoint catalog batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "catalog", batch_size = n, "counterpoint catalog batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "catalog",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_gift_cards(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointGiftCardsPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_gift_card_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "gift_cards",
                batch_size = n,
                created = summary.created,
                updated = summary.updated,
                events = summary.events_created,
                skipped = summary.skipped,
                "counterpoint gift card batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "gift_cards", batch_size = n, "counterpoint gift card batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "gift_cards",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_tickets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointTicketsPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_ticket_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "tickets",
                batch_size = n,
                orders_created = summary.transactions_created,
                orders_skipped = summary.transactions_skipped_existing,
                items = summary.line_items_created,
                payments = summary.payments_created,
                gift_payments = summary.gift_payments_created,
                skipped = summary.skipped,
                "counterpoint ticket batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "tickets", batch_size = n, "counterpoint ticket batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "tickets",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_store_credit_opening(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointStoreCreditOpeningPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_store_credit_opening_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "store_credit_opening",
                batch_size = n,
                applied = summary.applied,
                skipped_non_positive = summary.skipped_non_positive,
                skipped_already_imported = summary.skipped_already_imported,
                skipped_no_customer = summary.skipped_no_customer,
                "counterpoint store credit opening batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                entity = "store_credit_opening",
                batch_size = n,
                "counterpoint store credit opening batch failed"
            );
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "store_credit_opening",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_open_docs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointOpenDocsPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_open_doc_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "open_docs",
                batch_size = n,
                orders_created = summary.transactions_created,
                orders_skipped = summary.transactions_skipped_existing,
                items = summary.line_items_created,
                payments = summary.payments_created,
                skipped = summary.skipped,
                "counterpoint open doc batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                entity = "open_docs",
                batch_size = n,
                "counterpoint open doc batch failed"
            );
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "open_docs",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_vendors(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointVendorsPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_vendor_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "vendors",
                batch_size = n,
                created = summary.created,
                updated = summary.updated,
                "counterpoint vendor batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "vendors", batch_size = n, "counterpoint vendor batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "vendors",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_customer_notes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointCustomerNotesPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_customer_notes_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "customer_notes",
                batch_size = n,
                created = summary.created,
                "counterpoint customer notes batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "customer_notes", batch_size = n, "counterpoint customer notes batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "customer_notes",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_loyalty_hist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointLoyaltyHistPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_loyalty_hist_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "loyalty_hist",
                batch_size = n,
                inserted = summary.inserted,
                skipped = summary.skipped,
                "counterpoint loyalty history batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "loyalty_hist", batch_size = n, "counterpoint loyalty history batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "loyalty_hist",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_receiving_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<crate::logic::counterpoint_sync::CounterpointReceivingPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res =
        crate::logic::counterpoint_sync::execute_counterpoint_receiving_batch(&state.db, payload)
            .await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "receiving_history",
                batch_size = n,
                inserted = summary.inserted,
                skipped = summary.skipped,
                "counterpoint receiving history batch applied"
            );
            Ok(Json(json!(summary)))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "receiving_history", batch_size = n, "counterpoint receiving batch failed");
            let _ = crate::logic::counterpoint_sync::record_sync_run(
                &state.db,
                "receiving_history",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_vendor_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointVendorItemsPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_vendor_item_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "vendor_items",
                batch_size = n,
                upserted = summary.upserted,
                skipped = summary.skipped,
                "counterpoint vendor item batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "vendor_items", batch_size = n, "counterpoint vendor item batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "vendor_items",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_sales_rep_stubs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointSlsRepStubPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.codes.len();
    let res = execute_counterpoint_sls_rep_stub_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "sales_rep_stubs",
                codes = n,
                created = summary.created,
                skipped_mapped = summary.skipped_already_mapped,
                skipped_empty = summary.skipped_empty,
                skipped_cashier = summary.skipped_cashier_conflict,
                "counterpoint sales rep stub batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                entity = "sales_rep_stubs",
                codes = n,
                "counterpoint sales rep stub batch failed"
            );
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "sales_rep_stubs",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

async fn cp_staff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CounterpointStaffPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_sync_token(&state, &headers)?;
    let n = payload.rows.len();
    let res = execute_counterpoint_staff_batch(&state.db, payload).await;
    match res {
        Ok(summary) => {
            tracing::info!(
                entity = "staff",
                batch_size = n,
                created = summary.created,
                updated = summary.updated,
                merged = summary.merged,
                "counterpoint staff batch applied"
            );
            Ok(Json(serde_json::to_value(summary).unwrap_or_default()))
        }
        Err(e) => {
            tracing::warn!(error = %e, entity = "staff", batch_size = n, "counterpoint staff batch failed");
            let _ = counterpoint_sync::record_sync_run(
                &state.db,
                "staff",
                None,
                false,
                None,
                Some(&e.to_string()),
            )
            .await;
            Err(cp_err(e))
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Staff-gated settings endpoints (/api/settings/counterpoint-sync/*)
// ────────────────────────────────────────────────────────────────────────────

async fn settings_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let token_configured = state.counterpoint_sync_token.is_some();
    match counterpoint_sync::get_sync_status(&state.db, token_configured).await {
        Ok(resp) => Ok(Json(serde_json::to_value(resp).unwrap_or_default())),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )),
    }
}

async fn settings_request_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let entity = body.get("entity").and_then(|v| v.as_str());
    match counterpoint_sync::create_sync_request(&state.db, Some(staff.id), entity).await {
        Ok(id) => Ok(Json(json!({ "request_id": id }))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )),
    }
}

async fn settings_resolve_issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(issue_id): axum::extract::Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    match counterpoint_sync::resolve_sync_issue(&state.db, issue_id).await {
        Ok(true) => Ok(Json(json!({ "resolved": true }))),
        Ok(false) => Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "issue not found or already resolved" })),
        )),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )),
    }
}

#[derive(Deserialize)]
struct StagingListQuery {
    status: Option<String>,
    limit: Option<i64>,
}

async fn settings_staging_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<StagingListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let limit = q.limit.unwrap_or(100);
    let st = q.status.as_deref().filter(|s| !s.is_empty());
    let rows = counterpoint_staging::list_staging_batches(&state.db, limit, st)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!(rows)))
}

async fn settings_staging_payload(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let payload = counterpoint_staging::get_staging_payload(&state.db, id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    let Some(p) = payload else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "batch not found" })),
        ));
    };
    Ok(Json(p))
}

async fn settings_staging_apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    match counterpoint_staging::apply_staging_batch(&state.db, id, staff.id).await {
        Ok(()) => Ok(Json(json!({ "applied": true }))),
        Err(e) => Err(cp_err(e)),
    }
}

async fn settings_staging_discard(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    match counterpoint_staging::discard_staging_batch(&state.db, id).await {
        Ok(true) => Ok(Json(json!({ "discarded": true }))),
        Ok(false) => Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "batch not pending" })),
        )),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )),
    }
}

#[derive(Deserialize)]
struct StagingEnabledBody {
    staging_enabled: bool,
}

async fn settings_staging_enabled_patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StagingEnabledBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    counterpoint_staging::set_counterpoint_staging_enabled(&state.db, body.staging_enabled)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!({ "staging_enabled": body.staging_enabled })))
}

async fn settings_maps_category_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let rows = counterpoint_staging::list_category_map(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct CategoryMapPatchBody {
    ros_category_id: Option<Uuid>,
}

async fn settings_maps_category_patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Json(body): Json<CategoryMapPatchBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let ok = counterpoint_staging::patch_category_map_ros(&state.db, id, body.ros_category_id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    if !ok {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "row not found" })),
        ));
    }
    Ok(Json(json!({ "updated": true })))
}

async fn settings_maps_payment_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let rows = counterpoint_staging::list_payment_method_map(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct PaymentMapPatchBody {
    ros_method: String,
}

async fn settings_maps_payment_patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Json(body): Json<PaymentMapPatchBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let meth = body.ros_method.trim();
    if meth.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "ros_method required" })),
        ));
    }
    let ok = counterpoint_staging::patch_payment_method_map(&state.db, id, meth)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    if !ok {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "row not found" })),
        ));
    }
    Ok(Json(json!({ "updated": true })))
}

async fn settings_maps_gift_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let rows = counterpoint_staging::list_gift_reason_map(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct GiftReasonPatchBody {
    ros_card_kind: String,
}

async fn settings_maps_gift_patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Json(body): Json<GiftReasonPatchBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let k = body.ros_card_kind.trim();
    if k.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "ros_card_kind required" })),
        ));
    }
    if !VALID_GIFT_CARD_KINDS.contains(&k) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!(
                    "ros_card_kind must be one of: {}",
                    VALID_GIFT_CARD_KINDS.join(", ")
                )
            })),
        ));
    }
    let ok = counterpoint_staging::patch_gift_reason_map(&state.db, id, k)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    if !ok {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "row not found" })),
        ));
    }
    Ok(Json(json!({ "updated": true })))
}

async fn settings_maps_staff_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let rows = counterpoint_staging::list_staff_map(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!(rows)))
}

async fn settings_reset_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let preview = counterpoint_sync::get_counterpoint_reset_preview(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    Ok(Json(json!(preview)))
}

async fn settings_inventory_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let report = build_counterpoint_inventory_verification_report(&state.db)
        .await
        .map_err(cp_err)?;
    Ok(Json(json!(report)))
}

async fn settings_landing_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let summary = build_counterpoint_landing_verification_summary(&state.db)
        .await
        .map_err(cp_err)?;
    Ok(Json(json!(summary)))
}

async fn settings_transaction_reconciliation(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let snapshot = build_counterpoint_transaction_reconciliation_snapshot(&state.db)
        .await
        .map_err(cp_err)?;
    Ok(Json(json!(snapshot)))
}

async fn settings_open_docs_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let snapshot = build_counterpoint_open_docs_verification_snapshot(&state.db)
        .await
        .map_err(cp_err)?;
    Ok(Json(json!(snapshot)))
}

#[derive(Deserialize)]
struct CounterpointResetBody {
    confirmation_phrase: String,
}

async fn settings_reset_execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CounterpointResetBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let provided = body.confirmation_phrase.trim();
    let preview = counterpoint_sync::get_counterpoint_reset_preview(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
    if provided != preview.confirmation_phrase {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!(
                    "confirmation_phrase must exactly match: {}",
                    preview.confirmation_phrase
                )
            })),
        ));
    }

    let result = counterpoint_sync::execute_counterpoint_baseline_reset(&state.db)
        .await
        .map_err(cp_err)?;

    tracing::warn!(
        staff_id = %staff.id,
        action = "counterpoint_baseline_reset",
        "pre-go-live Counterpoint baseline reset executed"
    );

    Ok(Json(json!(result)))
}

fn map_perm(e: (StatusCode, Json<serde_json::Value>)) -> (StatusCode, Json<serde_json::Value>) {
    e
}

fn cp_err(e: CounterpointSyncError) -> (StatusCode, Json<serde_json::Value>) {
    match e {
        CounterpointSyncError::InvalidPayload(m) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": m })))
        }
        CounterpointSyncError::Database(d) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": d.to_string() })),
        ),
    }
}

/// M2M bridge routes under `/api/sync/counterpoint`.
pub fn router() -> Router<AppState> {
    Router::new().nest(
        "/counterpoint",
        Router::new()
            .route("/health", get(cp_health))
            .route("/heartbeat", post(cp_heartbeat))
            .route("/run-start", post(cp_run_start))
            .route("/request/ack", post(cp_ack_request))
            .route("/ack-request", post(cp_ack_request))
            .route("/request/complete", post(cp_complete_request))
            .route("/customers", post(cp_customers))
            .route("/inventory", post(cp_inventory))
            .route("/category-masters", post(cp_category_masters))
            .route("/catalog", post(cp_catalog))
            .route("/gift-cards", post(cp_gift_cards))
            .route("/tickets", post(cp_tickets))
            .route("/store-credit-opening", post(cp_store_credit_opening))
            .route("/open-docs", post(cp_open_docs))
            .route("/vendors", post(cp_vendors))
            .route("/vendor-items", post(cp_vendor_items))
            .route("/loyalty-hist", post(cp_loyalty_hist))
            .route("/customer-notes", post(cp_customer_notes))
            .route("/sales-rep-stubs", post(cp_sales_rep_stubs))
            .route("/staff", post(cp_staff))
            .route("/receiving-history", post(cp_receiving_history))
            .route("/staging", post(cp_staging)),
    )
}

/// Staff-gated settings routes under `/api/settings/counterpoint-sync`.
pub fn settings_router() -> Router<AppState> {
    Router::new()
        .route("/status", get(settings_status))
        .route(
            "/inventory-verification",
            get(settings_inventory_verification),
        )
        .route("/landing-verification", get(settings_landing_verification))
        .route(
            "/transaction-reconciliation",
            get(settings_transaction_reconciliation),
        )
        .route(
            "/open-docs-verification",
            get(settings_open_docs_verification),
        )
        .route("/reset-preview", get(settings_reset_preview))
        .route("/reset-baseline", post(settings_reset_execute))
        .route("/request-run", post(settings_request_run))
        .route("/issues/{issue_id}/resolve", patch(settings_resolve_issue))
        .route("/staging/enabled", patch(settings_staging_enabled_patch))
        .route("/staging/batches", get(settings_staging_list))
        .route(
            "/staging/batches/{id}/payload",
            get(settings_staging_payload),
        )
        .route("/staging/batches/{id}/apply", post(settings_staging_apply))
        .route(
            "/staging/batches/{id}/discard",
            post(settings_staging_discard),
        )
        .route("/maps/category", get(settings_maps_category_list))
        .route("/maps/category/{id}", patch(settings_maps_category_patch))
        .route("/maps/payment", get(settings_maps_payment_list))
        .route("/maps/payment/{id}", patch(settings_maps_payment_patch))
        .route("/maps/gift-reason", get(settings_maps_gift_list))
        .route("/maps/gift-reason/{id}", patch(settings_maps_gift_patch))
        .route("/maps/staff", get(settings_maps_staff_list))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::store_account_rate::StoreAccountRateState;
    use crate::api::PaymentIntentMinuteWindow;
    use crate::auth::pins::hash_pin;
    use crate::logic::corecard::{CoreCardConfig, CoreCardTokenCache};
    use crate::logic::podium::PodiumTokenCache;
    use crate::logic::wedding_push::WeddingEventBus;
    use crate::observability::ServerLogRing;
    use axum::extract::State;
    use axum::http::HeaderValue;
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::sync::Mutex;
    use uuid::Uuid;

    async fn connect_test_db() -> PgPool {
        let _ =
            dotenvy::from_filename(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for DB-backed tests");
        PgPool::connect(&database_url)
            .await
            .expect("connect test database")
    }

    async fn next_staff_code(pool: &PgPool) -> String {
        for _ in 0..128 {
            let candidate = format!("{:04}", (Uuid::new_v4().as_u128() % 10_000) as u16);
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                    .bind(&candidate)
                    .fetch_one(pool)
                    .await
                    .expect("check cashier_code uniqueness");
            if !exists {
                return candidate;
            }
        }
        panic!("could not allocate unique 4-digit cashier code for test staff");
    }

    async fn insert_staff_with_role(pool: &PgPool, role: &str, name_prefix: &str) -> String {
        let code = next_staff_code(pool).await;
        let pin_hash = hash_pin(&code).expect("hash test staff pin");
        sqlx::query(
            r#"
            INSERT INTO staff (
                id, full_name, cashier_code, pin_hash, role, is_active, avatar_key
            )
            VALUES ($1, $2, $3, $4, $5::staff_role, TRUE, 'ros_default')
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(format!("{name_prefix} {}", Uuid::new_v4().simple()))
        .bind(&code)
        .bind(pin_hash)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert test staff");
        code
    }

    fn build_test_state(pool: PgPool) -> AppState {
        AppState {
            db: pool,
            global_employee_markup: Decimal::new(15, 0),
            stripe_client: stripe::Client::new("sk_test_counterpoint_reset"),
            http_client: reqwest::Client::new(),
            podium_token_cache: Arc::new(Mutex::new(PodiumTokenCache::default())),
            database_url: "postgres://test".to_string(),
            counterpoint_sync_token: None,
            wedding_events: WeddingEventBus::new(),
            payment_intent_minute: Arc::new(Mutex::new(PaymentIntentMinuteWindow {
                window_start: Instant::now(),
                count: 0,
            })),
            payment_intent_max_per_minute: 0,
            store_customer_jwt_secret: Arc::<[u8]>::from(b"counterpoint-reset-test".as_slice()),
            store_account_rate: Arc::new(Mutex::new(StoreAccountRateState::default())),
            store_account_unauth_post_per_minute_ip: 0,
            store_account_authed_per_minute: 0,
            meilisearch: None,
            corecard_config: CoreCardConfig::from_env(),
            corecard_token_cache: Arc::new(Mutex::new(CoreCardTokenCache::default())),
            rosie_speech_state: Arc::new(Mutex::new(None)),
            server_log_ring: ServerLogRing::new(32, 512),
        }
    }

    fn auth_headers(code: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-riverside-staff-code",
            HeaderValue::from_str(code).expect("staff code header"),
        );
        headers.insert(
            "x-riverside-staff-pin",
            HeaderValue::from_str(code).expect("staff pin header"),
        );
        headers
    }

    #[tokio::test]
    async fn settings_reset_execute_rejects_non_admin_callers() {
        let pool = connect_test_db().await;
        let salesperson_code =
            insert_staff_with_role(&pool, "salesperson", "Counterpoint Reset Salesperson").await;
        let state = build_test_state(pool);

        let err = settings_reset_execute(
            State(state),
            auth_headers(&salesperson_code),
            Json(CounterpointResetBody {
                confirmation_phrase: "RESET COUNTERPOINT BASELINE".to_string(),
            }),
        )
        .await
        .expect_err("salesperson should not reach baseline reset");

        assert_eq!(err.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn settings_reset_execute_rejects_incorrect_confirmation_phrase() {
        let pool = connect_test_db().await;
        let admin_code = insert_staff_with_role(&pool, "admin", "Counterpoint Reset Admin").await;
        let state = build_test_state(pool);

        let err = settings_reset_execute(
            State(state),
            auth_headers(&admin_code),
            Json(CounterpointResetBody {
                confirmation_phrase: "RESET THE WRONG THING".to_string(),
            }),
        )
        .await
        .expect_err("wrong confirmation phrase should be rejected");

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        let body = err.1 .0;
        assert_eq!(
            body.get("error").and_then(|value| value.as_str()),
            Some("confirmation_phrase must exactly match: RESET COUNTERPOINT BASELINE")
        );
    }
}
