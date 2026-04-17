// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::require_weddings_view;
use super::WeddingError;
use super::{ActivityFeedRow, WeddingActions, WeddingLedgerResponse, WeddingPartyFinancialContext};
use crate::api::AppState;
use crate::logic::wedding_queries::{
    query_activity_feed, query_wedding_actions, try_load_party_financial_context,
    try_load_party_ledger,
};
use crate::logic::weddings as wedding_logic;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct ActivityFeedQuery {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ActionsQuery {
    pub days: Option<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/priority-feed-bundle", get(get_registry_priority_feed))
        .route("/activity-feed", get(get_activity_feed))
        .route("/actions", get(get_actions))
        .route("/parties/{party_id}/ledger", get(get_ledger))
        .route(
            "/parties/{party_id}/financial-context",
            get(get_party_financial_context),
        )
}

async fn get_registry_priority_feed(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<wedding_logic::RegistryPriorityFeedBundle>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    wedding_logic::get_registry_priority_feed_bundle(&state.db)
        .await
        .map(Json)
        .map_err(WeddingError::Database)
}

async fn get_activity_feed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ActivityFeedQuery>,
) -> Result<Json<Vec<ActivityFeedRow>>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let limit = q.limit.unwrap_or(40).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = query_activity_feed(&state.db, limit, offset).await?;
    Ok(Json(rows))
}

async fn get_actions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ActionsQuery>,
) -> Result<Json<WeddingActions>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let day_window = query.days.unwrap_or(90).clamp(1, 365);
    let actions = query_wedding_actions(&state.db, day_window).await?;
    Ok(Json(actions))
}

async fn get_ledger(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(party_id): Path<Uuid>,
) -> Result<Json<WeddingLedgerResponse>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let ledger = try_load_party_ledger(&state.db, party_id)
        .await?
        .ok_or(WeddingError::PartyNotFound)?;
    Ok(Json(ledger))
}

async fn get_party_financial_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(party_id): Path<Uuid>,
) -> Result<Json<WeddingPartyFinancialContext>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let ctx = try_load_party_financial_context(&state.db, party_id)
        .await?
        .ok_or(WeddingError::PartyNotFound)?;
    Ok(Json(ctx))
}
