// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::{
    require_weddings_mutate, require_weddings_view, resolve_actor, spawn_meilisearch_wedding_party,
    wedding_client_sender,
};
use super::WeddingError;
use super::{
    PaginatedParties, Pagination, PartyListQuery, WeddingMemberApi, WeddingPartyWithMembers,
};
use crate::api::AppState;
use crate::logic::wedding_api_types::build_party_bundle;
use crate::logic::wedding_queries::{
    digits_only, fetch_party_row_optional, load_members_for_party, query_party_list_page,
};
use crate::logic::weddings as wedding_logic;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::QueryBuilder;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct ActorQuery {
    #[serde(default)]
    pub actor_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePartyRequest {
    pub party_name: Option<String>,
    pub groom_name: String,
    pub event_date: chrono::NaiveDate,
    pub venue: Option<String>,
    pub notes: Option<String>,
    pub party_type: Option<String>,
    pub sign_up_date: Option<chrono::NaiveDate>,
    pub salesperson: Option<String>,
    pub style_info: Option<String>,
    pub price_info: Option<String>,
    pub groom_phone: Option<String>,
    pub groom_email: Option<String>,
    pub bride_name: Option<String>,
    pub bride_phone: Option<String>,
    pub bride_email: Option<String>,
    pub accessories: Option<serde_json::Value>,
    #[serde(default)]
    pub actor_name: Option<String>,
    /// ROS customer ID for groom (if searching/linking an existing customer)
    pub groom_customer_id: Option<Uuid>,
    /// ROS customer ID for bride (if searching/linking an existing customer)
    pub bride_customer_id: Option<Uuid>,
    /// Base suit variant for the party (can be overridden per member)
    pub base_suit_variant_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePartyRequest {
    pub party_name: Option<String>,
    pub groom_name: Option<String>,
    pub event_date: Option<chrono::NaiveDate>,
    pub venue: Option<String>,
    pub notes: Option<String>,
    pub party_type: Option<String>,
    pub sign_up_date: Option<chrono::NaiveDate>,
    pub salesperson: Option<String>,
    pub style_info: Option<String>,
    pub price_info: Option<String>,
    pub groom_phone: Option<String>,
    pub groom_email: Option<String>,
    pub bride_name: Option<String>,
    pub bride_phone: Option<String>,
    pub bride_email: Option<String>,
    pub accessories: Option<serde_json::Value>,
    pub suit_variant_id: Option<Uuid>,
    #[serde(default)]
    pub actor_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AttachOrderRequest {
    pub transaction_id: Uuid,
    pub wedding_party_id: Option<Uuid>,
    pub new_party_info: Option<CreatePartyRequest>,
    pub role: String,
    #[serde(default)]
    pub actor_name: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/parties", get(list_parties).post(create_party))
        .route(
            "/parties/{party_id}/restore",
            axum::routing::post(restore_party),
        )
        .route("/parties/{party_id}/health", get(get_health))
        .route(
            "/parties/{party_id}",
            get(get_party)
                .patch(update_party)
                .delete(delete_party_handler),
        )
        .route("/attach-order", axum::routing::post(post_attach_order))
}

async fn list_parties(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PartyListQuery>,
) -> Result<Json<PaginatedParties>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let (parties, total, page, limit) =
        query_party_list_page(&state.db, &q, state.meilisearch.as_ref()).await?;
    let mut out = Vec::with_capacity(parties.len());
    for p in parties {
        let members = load_members_for_party(&state.db, p.id).await?;
        out.push(build_party_bundle(p, members));
    }
    let total_pages = if total == 0 {
        0
    } else {
        (total + limit - 1) / limit
    };
    Ok(Json(PaginatedParties {
        data: out,
        pagination: Pagination {
            page,
            limit,
            total,
            total_pages,
        },
    }))
}

pub async fn insert_party_and_respond(
    state: &AppState,
    body: CreatePartyRequest,
    sender_id: Option<&str>,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    let groom = body.groom_name.trim();
    if groom.is_empty() {
        return Err(WeddingError::BadRequest("groom_name is required".into()));
    }

    let acc = body.accessories.unwrap_or_else(|| json!({}));
    let gp = body.groom_phone.as_deref().unwrap_or("");
    let bp = body.bride_phone.as_deref().unwrap_or("");
    let gpc = if gp.is_empty() {
        None
    } else {
        Some(digits_only(gp))
    };
    let bpc = if bp.is_empty() {
        None
    } else {
        Some(digits_only(bp))
    };

    let party_type = body.party_type.as_deref().unwrap_or("Wedding").to_string();

    // Handle groom and bride customer creation/linking
    let groom_customer_id = if let Some(gcid) = body.groom_customer_id {
        // Link to existing customer
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                .bind(gcid)
                .fetch_one(&state.db)
                .await?;
        if !exists {
            return Err(WeddingError::BadRequest("groom customer not found".into()));
        }
        Some(gcid)
    } else if !gp.is_empty() || !groom.is_empty() {
        // Create/update groom customer by phone or name
        let customer_id = Uuid::new_v4();
        let first = groom.split_whitespace().next().unwrap_or(groom);
        let last = groom
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ");
        let last = if last.is_empty() {
            "Groom".to_string()
        } else {
            last
        };
        let _phone_clean = gpc.clone();

        let cid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO customers (id, first_name, last_name, phone, customer_code, created_source, created_at)
            VALUES ($1, $2, $3, $4, $5, 'wedding_import', NOW())
            ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(first)
        .bind(&last)
        .bind(gp)
        .bind(format!("Wedding-{}", &customer_id.to_string()[..8]))
        .fetch_one(&state.db)
        .await?;
        Some(cid)
    } else {
        None
    };

    let bride_customer_id = if let Some(bcid) = body.bride_customer_id {
        // Link to existing customer
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                .bind(bcid)
                .fetch_one(&state.db)
                .await?;
        if !exists {
            return Err(WeddingError::BadRequest("bride customer not found".into()));
        }
        Some(bcid)
    } else if !bp.is_empty()
        || body
            .bride_name
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    {
        // Create/update bride customer by phone or name
        let customer_id = Uuid::new_v4();
        let bride_name = body.bride_name.as_deref().unwrap_or("").trim();
        let first = bride_name.split_whitespace().next().unwrap_or("Bride");
        let last = bride_name
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ");
        let last = if last.is_empty() {
            "Bride".to_string()
        } else {
            last
        };

        let cid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO customers (id, first_name, last_name, phone, customer_code, created_source, created_at)
            VALUES ($1, $2, $3, $4, $5, 'wedding_import', NOW())
            ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(first)
        .bind(&last)
        .bind(bp)
        .bind(format!("Wedding-{}", &customer_id.to_string()[..8]))
        .fetch_one(&state.db)
        .await?;
        Some(cid)
    } else {
        None
    };

    // Create couple link if both groom and bride exist
    let _couple_id = if let (Some(gid), Some(bid)) = (groom_customer_id, bride_customer_id) {
        let couple = Uuid::new_v4();
        sqlx::query(
            r#"
            UPDATE customers SET couple_id = $1, couple_primary_id = $1, couple_linked_at = NOW()
            WHERE id IN ($2, $3)
            "#,
        )
        .bind(couple)
        .bind(gid)
        .bind(bid)
        .execute(&state.db)
        .await
        .ok();
        Some(couple)
    } else {
        None
    };

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_parties (
            party_name, groom_name, event_date, venue, notes,
            party_type, sign_up_date, salesperson, style_info, price_info,
            groom_phone, groom_email, bride_name, bride_phone, bride_email,
            accessories, groom_phone_clean, bride_phone_clean, is_deleted,
            suit_variant_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,FALSE,$19)
        RETURNING id
        "#,
    )
    .bind(&body.party_name)
    .bind(groom)
    .bind(body.event_date)
    .bind(&body.venue)
    .bind(&body.notes)
    .bind(&party_type)
    .bind(body.sign_up_date)
    .bind(&body.salesperson)
    .bind(&body.style_info)
    .bind(&body.price_info)
    .bind(&body.groom_phone)
    .bind(&body.groom_email)
    .bind(&body.bride_name)
    .bind(&body.bride_phone)
    .bind(&body.bride_email)
    .bind(acc)
    .bind(&gpc)
    .bind(&bpc)
    .bind(body.base_suit_variant_id)
    .fetch_one(&state.db)
    .await?;

    // Add groom as party member
    if let Some(gcid) = groom_customer_id {
        let max_idx: Option<i32> = sqlx::query_scalar(
            "SELECT MAX(member_index) FROM wedding_members WHERE wedding_party_id = $1",
        )
        .bind(id)
        .fetch_one(&state.db)
        .await?;
        let next_idx = max_idx.unwrap_or(0) + 1;
        let _: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO wedding_members (wedding_party_id, customer_id, role, status, member_index)
            VALUES ($1, $2, 'Groom', 'active', $3)
            RETURNING id
            "#,
        )
        .bind(id)
        .bind(gcid)
        .bind(next_idx)
        .fetch_one(&state.db)
        .await?;
    }

    let party = fetch_party_row_optional(&state.db, id)
        .await?
        .ok_or_else(|| {
            tracing::error!(party_id = %id, "party missing immediately after insert");
            WeddingError::BadRequest("Could not load party after create".into())
        })?;

    let actor = resolve_actor(body.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        id,
        None,
        &actor,
        "NOTE",
        "Wedding party created",
        json!({ "party_type": party_type }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }

    state.wedding_events.parties_updated(sender_id);
    spawn_meilisearch_wedding_party(state, id);

    Ok(Json(build_party_bundle(party, vec![])))
}

async fn create_party(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreatePartyRequest>,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let sender = wedding_client_sender(&headers);
    insert_party_and_respond(&state, body, sender.as_deref()).await
}

pub async fn fetch_party_bundle(
    state: &AppState,
    party_id: Uuid,
) -> Result<WeddingPartyWithMembers, WeddingError> {
    let party = fetch_party_row_optional(&state.db, party_id)
        .await?
        .ok_or(WeddingError::PartyNotFound)?;
    let members = load_members_for_party(&state.db, party_id).await?;
    Ok(build_party_bundle(party, members))
}

async fn get_party(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let bundle = fetch_party_bundle(&state, party_id).await?;
    Ok(Json(bundle))
}

fn party_patch_summary(body: &UpdatePartyRequest) -> Vec<String> {
    let mut k = Vec::new();
    if body.party_name.is_some() {
        k.push("party_name".into());
    }
    if body.groom_name.is_some() {
        k.push("groom_name".into());
    }
    if body.event_date.is_some() {
        k.push("event_date".into());
    }
    if body.venue.is_some() {
        k.push("venue".into());
    }
    if body.notes.is_some() {
        k.push("notes".into());
    }
    if body.party_type.is_some() {
        k.push("party_type".into());
    }
    if body.sign_up_date.is_some() {
        k.push("sign_up_date".into());
    }
    if body.salesperson.is_some() {
        k.push("salesperson".into());
    }
    if body.style_info.is_some() {
        k.push("style_info".into());
    }
    if body.price_info.is_some() {
        k.push("price_info".into());
    }
    if body.groom_phone.is_some() {
        k.push("groom_phone".into());
    }
    if body.groom_email.is_some() {
        k.push("groom_email".into());
    }
    if body.bride_name.is_some() {
        k.push("bride_name".into());
    }
    if body.bride_phone.is_some() {
        k.push("bride_phone".into());
    }
    if body.bride_email.is_some() {
        k.push("bride_email".into());
    }
    if body.accessories.is_some() {
        k.push("accessories".into());
    }
    if body.suit_variant_id.is_some() {
        k.push("suit_variant_id".into());
    }
    k
}

async fn update_party(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdatePartyRequest>,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let log_actor = body.actor_name.clone();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_parties WHERE id = $1)")
            .bind(party_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(WeddingError::PartyNotFound);
    }

    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new("UPDATE wedding_parties SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    if let Some(v) = &body.party_name {
        sep.push("party_name = ").push_bind(v.clone());
        has_updates = true;
    }
    if let Some(v) = &body.groom_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("groom_name = ").push_bind(t.to_string());
            has_updates = true;
        }
    }
    if let Some(v) = body.event_date {
        sep.push("event_date = ").push_bind(v);
        has_updates = true;
    }
    if body.venue.is_some() {
        sep.push("venue = ").push_bind(body.venue.clone());
        has_updates = true;
    }
    if body.notes.is_some() {
        sep.push("notes = ").push_bind(body.notes.clone());
        has_updates = true;
    }
    if let Some(v) = &body.party_type {
        sep.push("party_type = ").push_bind(v.clone());
        has_updates = true;
    }
    if body.sign_up_date.is_some() {
        sep.push("sign_up_date = ").push_bind(body.sign_up_date);
        has_updates = true;
    }
    if body.salesperson.is_some() {
        sep.push("salesperson = ")
            .push_bind(body.salesperson.clone());
        has_updates = true;
    }
    if body.style_info.is_some() {
        sep.push("style_info = ").push_bind(body.style_info.clone());
        has_updates = true;
    }
    if body.price_info.is_some() {
        sep.push("price_info = ").push_bind(body.price_info.clone());
        has_updates = true;
    }
    if body.groom_phone.is_some() {
        let gp = body.groom_phone.clone();
        let gpc = gp.as_deref().map(digits_only).filter(|s| !s.is_empty());
        sep.push("groom_phone = ").push_bind(gp);
        sep.push("groom_phone_clean = ").push_bind(gpc);
        has_updates = true;
    }
    if body.groom_email.is_some() {
        sep.push("groom_email = ")
            .push_bind(body.groom_email.clone());
        has_updates = true;
    }
    if body.bride_name.is_some() {
        sep.push("bride_name = ").push_bind(body.bride_name.clone());
        has_updates = true;
    }
    if body.bride_phone.is_some() {
        let bp = body.bride_phone.clone();
        let bpc = bp.as_deref().map(digits_only).filter(|s| !s.is_empty());
        sep.push("bride_phone = ").push_bind(bp);
        sep.push("bride_phone_clean = ").push_bind(bpc);
        has_updates = true;
    }
    if body.bride_email.is_some() {
        sep.push("bride_email = ")
            .push_bind(body.bride_email.clone());
        has_updates = true;
    }
    if let Some(acc) = &body.accessories {
        sep.push("accessories = ").push_bind(acc.clone());
        has_updates = true;
    }
    if body.suit_variant_id.is_some() {
        sep.push("suit_variant_id = ")
            .push_bind(body.suit_variant_id);
        has_updates = true;
    }

    if !has_updates {
        let bundle = fetch_party_bundle(&state, party_id).await?;
        return Ok(Json(bundle));
    }

    let fields_summary = party_patch_summary(&body);
    qb.push(" WHERE id = ").push_bind(party_id);
    qb.build().execute(&state.db).await?;

    if !fields_summary.is_empty() {
        let actor = resolve_actor(log_actor);
        let desc = format!("Party updated: {}", fields_summary.join(", "));
        if let Err(e) = wedding_logic::insert_wedding_activity(
            &state.db,
            party_id,
            None,
            &actor,
            "STATUS_CHANGE",
            &desc,
            json!({ "fields": fields_summary }),
        )
        .await
        {
            tracing::warn!(error = %e, "Wedding activity log failed");
        }
    }

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_wedding_party(&state, party_id);
    let bundle = fetch_party_bundle(&state, party_id).await?;
    Ok(Json(bundle))
}

async fn delete_party_handler(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    Query(q): Query<ActorQuery>,
    headers: HeaderMap,
) -> Result<StatusCode, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let r = sqlx::query("UPDATE wedding_parties SET is_deleted = TRUE WHERE id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)")
        .bind(party_id)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(WeddingError::PartyNotFound);
    }
    let actor = resolve_actor(q.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        None,
        &actor,
        "STATUS_CHANGE",
        "Party archived",
        json!({}),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    spawn_meilisearch_wedding_party(&state, party_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn restore_party(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    Query(q): Query<ActorQuery>,
    headers: HeaderMap,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let r = sqlx::query("UPDATE wedding_parties SET is_deleted = FALSE WHERE id = $1")
        .bind(party_id)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(WeddingError::PartyNotFound);
    }
    let actor = resolve_actor(q.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        None,
        &actor,
        "STATUS_CHANGE",
        "Party restored from archive",
        json!({}),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    spawn_meilisearch_wedding_party(&state, party_id);
    let bundle = fetch_party_bundle(&state, party_id).await?;
    Ok(Json(bundle))
}

async fn post_attach_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AttachOrderRequest>,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let mut tx = state.db.begin().await?;

    let order_info: Option<(Option<Uuid>, Option<Uuid>)> =
        sqlx::query_as("SELECT customer_id, wedding_member_id FROM transactions WHERE id = $1")
            .bind(body.transaction_id)
            .fetch_optional(&mut *tx)
            .await?;

    let (customer_id, existing_member_id) =
        order_info.ok_or(WeddingError::BadRequest("Order not found".into()))?;
    let customer_id = customer_id.ok_or(WeddingError::BadRequest(
        "Order has no customer attached".into(),
    ))?;

    if existing_member_id.is_some() {
        return Err(WeddingError::BadRequest(
            "Order is already attached to a wedding member".into(),
        ));
    }

    let party_id = if let Some(pid) = body.wedding_party_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_parties WHERE id = $1)")
                .bind(pid)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(WeddingError::PartyNotFound);
        }
        pid
    } else if let Some(new_party) = body.new_party_info {
        // Simple internal shim for party creation within txn
        let groom = new_party.groom_name.trim();
        if groom.is_empty() {
            return Err(WeddingError::BadRequest("groom_name is required".into()));
        }
        let acc = new_party.accessories.unwrap_or_else(|| json!({}));
        let gp = new_party.groom_phone.as_deref().unwrap_or("");
        let bp = new_party.bride_phone.as_deref().unwrap_or("");
        let gpc = if gp.is_empty() {
            None
        } else {
            Some(digits_only(gp))
        };
        let bpc = if bp.is_empty() {
            None
        } else {
            Some(digits_only(bp))
        };
        let party_type = new_party
            .party_type
            .as_deref()
            .unwrap_or("Wedding")
            .to_string();

        let pid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO wedding_parties (
                party_name, groom_name, event_date, venue, notes,
                party_type, sign_up_date, salesperson, style_info, price_info,
                groom_phone, groom_email, bride_name, bride_phone, bride_email,
                accessories, groom_phone_clean, bride_phone_clean, is_deleted
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,FALSE)
            RETURNING id
            "#,
        )
        .bind(&new_party.party_name)
        .bind(groom)
        .bind(new_party.event_date)
        .bind(&new_party.venue)
        .bind(&new_party.notes)
        .bind(&party_type)
        .bind(new_party.sign_up_date)
        .bind(&new_party.salesperson)
        .bind(&new_party.style_info)
        .bind(&new_party.price_info)
        .bind(&new_party.groom_phone)
        .bind(&new_party.groom_email)
        .bind(&new_party.bride_name)
        .bind(&new_party.bride_phone)
        .bind(&new_party.bride_email)
        .bind(acc)
        .bind(&gpc)
        .bind(&bpc)
        .fetch_one(&mut *tx)
        .await?;
        pid
    } else {
        return Err(WeddingError::BadRequest(
            "Either wedding_party_id or new_party_info must be provided".into(),
        ));
    };

    let max_idx: Option<i32> = sqlx::query_scalar(
        "SELECT MAX(member_index) FROM wedding_members WHERE wedding_party_id = $1",
    )
    .bind(party_id)
    .fetch_one(&mut *tx)
    .await?;
    let next_idx = max_idx.unwrap_or(0) + 1;
    let role = body.role.trim();
    if role.is_empty() {
        return Err(WeddingError::BadRequest("role is required".into()));
    }

    let member_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_members (
            wedding_party_id, customer_id, role, status, member_index, transaction_id
        )
        VALUES ($1, $2, $3, 'prospect', $4, $5)
        RETURNING id
        "#,
    )
    .bind(party_id)
    .bind(customer_id)
    .bind(role)
    .bind(next_idx)
    .bind(body.transaction_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("UPDATE transactions SET wedding_member_id = $1 WHERE id = $2")
        .bind(member_id)
        .bind(body.transaction_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        UPDATE transaction_lines 
        SET fulfillment = 'wedding_order'
        WHERE transaction_id = $1 AND fulfillment = 'special_order'
        "#,
    )
    .bind(body.transaction_id)
    .execute(&mut *tx)
    .await?;

    let actor = resolve_actor(body.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &mut *tx,
        party_id,
        Some(member_id),
        &actor,
        "STATUS_CHANGE",
        &format!("Order attached to wedding party (role: {role})"),
        json!({ "transaction_id": body.transaction_id, "wedding_member_id": member_id }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }

    tx.commit().await?;

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_wedding_party(&state, party_id);
    crate::logic::meilisearch_sync::spawn_meili({
        let state = state.clone();
        let oid = body.transaction_id;
        async move {
            if let Some(c) = &state.meilisearch {
                crate::logic::meilisearch_sync::upsert_transaction_document(c, &state.db, oid)
                    .await;
            }
        }
    });

    let member = crate::logic::wedding_queries::fetch_member_optional(&state.db, member_id)
        .await?
        .ok_or(WeddingError::MemberNotFound)?;
    Ok(Json(member))
}

async fn get_health(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<crate::logic::wedding_health::WeddingHealthScore>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let score = crate::logic::wedding_health::calculate_wedding_health(&state.db, party_id)
        .await
        .map_err(WeddingError::Database)?;
    Ok(Json(score))
}
