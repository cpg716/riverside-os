// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::{
    require_weddings_mutate, require_weddings_view, resolve_actor, spawn_meilisearch_wedding_party,
    wedding_client_sender,
};
use super::WeddingError;
use super::WeddingMemberApi;
use crate::api::AppState;
use crate::logic::customers::{insert_customer, InsertCustomerParams};
use crate::logic::wedding_queries::fetch_member_optional;
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
pub struct QuickCreateMemberBody {
    first_name: String,
    last_name: String,
    email: Option<String>,
    phone: Option<String>,
    address_line1: Option<String>,
    address_line2: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    marketing_email_opt_in: Option<bool>,
    marketing_sms_opt_in: Option<bool>,
    transactional_sms_opt_in: Option<bool>,
    #[serde(default)]
    transactional_email_opt_in: Option<bool>,
    role: Option<String>,
    notes: Option<String>,
    #[serde(default)]
    actor_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum CreateMemberRequest {
    LinkExisting {
        customer_id: Uuid,
        role: Option<String>,
        notes: Option<String>,
        #[serde(default)]
        actor_name: Option<String>,
    },
    QuickCreateCustomer(Box<QuickCreateMemberBody>),
    SimpleCreate {
        first_name: String,
        last_name: String,
        phone: Option<String>,
        role: Option<String>,
        notes: Option<String>,
        /// Original name from import (before ROS customer link)
        import_customer_name: Option<String>,
        /// Original phone from import (before ROS customer link)
        import_customer_phone: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemberRequest {
    pub role: Option<String>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub member_index: Option<i32>,
    pub oot: Option<bool>,
    pub suit: Option<String>,
    pub waist: Option<String>,
    pub vest: Option<String>,
    pub shirt: Option<String>,
    pub shoe: Option<String>,
    pub measured: Option<bool>,
    pub suit_ordered: Option<bool>,
    pub received: Option<bool>,
    pub fitting: Option<bool>,
    pub pickup_status: Option<String>,
    pub measure_date: Option<chrono::NaiveDate>,
    pub ordered_date: Option<chrono::NaiveDate>,
    pub received_date: Option<chrono::NaiveDate>,
    pub fitting_date: Option<chrono::NaiveDate>,
    pub pickup_date: Option<chrono::NaiveDate>,
    pub ordered_items: Option<serde_json::Value>,
    pub member_accessories: Option<serde_json::Value>,
    pub contact_history: Option<serde_json::Value>,
    pub pin_note: Option<bool>,
    pub ordered_po: Option<String>,
    pub stock_info: Option<serde_json::Value>,
    pub suit_variant_id: Option<Uuid>,
    pub is_free_suit_promo: Option<bool>,
    #[serde(default)]
    pub actor_name: Option<String>,
    /// When set (non-empty), used as the wedding_activity_log description instead of the default patch summary.
    #[serde(default)]
    pub activity_description: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/parties/{party_id}/members",
            axum::routing::post(add_member),
        )
        .route(
            "/members/{member_id}",
            get(get_member)
                .patch(update_member)
                .delete(delete_member_handler),
        )
}

async fn add_member(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CreateMemberRequest>,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let pew: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_parties WHERE id = $1)")
            .bind(party_id)
            .fetch_one(&state.db)
            .await?;
    if !pew {
        return Err(WeddingError::PartyNotFound);
    }

    let (customer_id, role, notes, log_actor, import_name, import_phone) = match body {
        CreateMemberRequest::LinkExisting {
            customer_id,
            role,
            notes,
            actor_name,
        } => {
            let cust: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                    .bind(customer_id)
                    .fetch_one(&state.db)
                    .await?;
            if !cust {
                return Err(WeddingError::BadRequest("customer not found".into()));
            }
            (customer_id, role, notes, actor_name, None, None)
        }
        CreateMemberRequest::SimpleCreate {
            first_name,
            last_name,
            phone,
            role,
            notes,
            import_customer_name,
            import_customer_phone,
        } => {
            let first = first_name.trim();
            let last = last_name.trim();
            if first.is_empty() || last.is_empty() {
                return Err(WeddingError::BadRequest(
                    "first_name and last_name are required".into(),
                ));
            }
            let phone = phone
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let customer_id = Uuid::new_v4();

            let existing_by_phone: Option<Uuid> = if let Some(ref p) = phone {
                sqlx::query_scalar("SELECT id FROM customers WHERE phone = $1")
                    .bind(p)
                    .fetch_optional(&state.db)
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };

            let cid = if let Some(existing_id) = existing_by_phone {
                existing_id
            } else {
                sqlx::query_scalar(
                    r#"
                    INSERT INTO customers (id, first_name, last_name, phone, customer_code, created_source, created_at)
                    VALUES ($1, $2, $3, $4, $5, 'wedding_import', NOW())
                    ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
                    RETURNING id
                    "#,
                )
                .bind(customer_id)
                .bind(first)
                .bind(last)
                .bind(&phone)
                .bind(format!("Wedding-{}", &customer_id.to_string()[..8]))
                .fetch_one(&state.db)
                .await?
            };

            let import_name = import_customer_name.or_else(|| Some(format!("{first} {last}")));
            let import_phone = import_customer_phone.or_else(|| phone.clone());

            (cid, role, notes, None, import_name, import_phone)
        }
        CreateMemberRequest::QuickCreateCustomer(boxed) => {
            let QuickCreateMemberBody {
                first_name,
                last_name,
                email,
                phone,
                address_line1,
                address_line2,
                city,
                state: region,
                postal_code,
                marketing_email_opt_in,
                marketing_sms_opt_in,
                transactional_sms_opt_in,
                transactional_email_opt_in,
                role,
                notes,
                actor_name,
            } = *boxed;
            let first = first_name.trim();
            let last = last_name.trim();
            if first.is_empty() || last.is_empty() {
                return Err(WeddingError::BadRequest(
                    "first_name and last_name are required".into(),
                ));
            }
            let email = email
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let phone = phone
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let line1 = address_line1
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let line2 = address_line2
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let city_v = city
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let state_v = region
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let postal = postal_code
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let m_sms = marketing_sms_opt_in.unwrap_or(false);
            let t_sms = transactional_sms_opt_in.unwrap_or(m_sms);
            let m_email = marketing_email_opt_in.unwrap_or(false);
            let t_email = transactional_email_opt_in.unwrap_or(m_email);
            let cid = insert_customer(
                &state.db,
                InsertCustomerParams {
                    customer_code: None,
                    first_name: first.to_string(),
                    last_name: last.to_string(),
                    company_name: None,
                    email,
                    phone,
                    address_line1: line1,
                    address_line2: line2,
                    city: city_v,
                    state: state_v,
                    postal_code: postal,
                    date_of_birth: None,
                    anniversary_date: None,
                    custom_field_1: None,
                    custom_field_2: None,
                    custom_field_3: None,
                    custom_field_4: None,
                    marketing_email_opt_in: m_email,
                    marketing_sms_opt_in: m_sms,
                    transactional_sms_opt_in: t_sms,
                    transactional_email_opt_in: t_email,
                    customer_created_source: crate::logic::customers::CustomerCreatedSource::Store,
                },
            )
            .await
            .map_err(|e| {
                if let sqlx::Error::Database(ref d) = e {
                    if d.is_unique_violation() {
                        return WeddingError::BadRequest(
                            "email or phone conflicts with an existing customer".into(),
                        );
                    }
                    if d.code().as_deref() == Some("42703") {
                        return WeddingError::BadRequest("Database schema mismatch".into());
                    }
                }
                WeddingError::Database(e)
            })?;
            (cid, role, notes, actor_name, None, None)
        }
    };

    let max_idx: Option<i32> = sqlx::query_scalar(
        "SELECT MAX(member_index) FROM wedding_members WHERE wedding_party_id = $1",
    )
    .bind(party_id)
    .fetch_one(&state.db)
    .await?;
    let next_idx = max_idx.unwrap_or(0) + 1;
    let role = role
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Member")
        .to_string();

    let is_verified = import_name.is_none() && import_phone.is_none();

    let member_id: Uuid = match sqlx::query_scalar(
        r#"
        INSERT INTO wedding_members (
            wedding_party_id, customer_id, role, status, notes, member_index,
            customer_verified, import_customer_name, import_customer_phone
        )
        VALUES ($1, $2, $3, 'prospect', $4, $5, $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(party_id)
    .bind(customer_id)
    .bind(&role)
    .bind(&notes)
    .bind(next_idx)
    .bind(is_verified)
    .bind(&import_name)
    .bind(&import_phone)
    .fetch_one(&state.db)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            if let sqlx::Error::Database(ref d) = e {
                if d.is_unique_violation() {
                    return Err(WeddingError::BadRequest(
                        "this customer is already a member of this party".into(),
                    ));
                }
            }
            return Err(WeddingError::Database(e));
        }
    };

    let actor = resolve_actor(log_actor);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        Some(member_id),
        &actor,
        "STATUS_CHANGE",
        &format!("Member added to party (role: {role})"),
        json!({ "customer_id": customer_id, "wedding_member_id": member_id }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_wedding_party(&state, party_id);

    let member = fetch_member_optional(&state.db, member_id)
        .await?
        .ok_or(WeddingError::MemberNotFound)?;
    Ok(Json(member))
}

async fn get_member(
    State(state): State<AppState>,
    Path(member_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let row = fetch_member_optional(&state.db, member_id).await?;
    match row {
        Some(member) => Ok(Json(member)),
        None => Err(WeddingError::MemberNotFound),
    }
}

fn member_patch_keys(body: &UpdateMemberRequest) -> Vec<String> {
    let mut k = Vec::new();
    macro_rules! push {
        ($field:ident, $label:literal) => {
            if body.$field.is_some() {
                k.push($label.to_string());
            }
        };
    }
    push!(role, "role");
    push!(notes, "notes");
    push!(status, "status");
    push!(member_index, "member_index");
    push!(oot, "oot");
    push!(suit, "suit");
    push!(waist, "waist");
    push!(vest, "vest");
    push!(shirt, "shirt");
    push!(shoe, "shoe");
    push!(measured, "measured");
    push!(suit_ordered, "suit_ordered");
    push!(received, "received");
    push!(fitting, "fitting");
    push!(pickup_status, "pickup_status");
    push!(measure_date, "measure_date");
    push!(ordered_date, "ordered_date");
    push!(received_date, "received_date");
    push!(fitting_date, "fitting_date");
    push!(pickup_date, "pickup_date");
    push!(ordered_items, "ordered_items");
    push!(member_accessories, "member_accessories");
    push!(contact_history, "contact_history");
    push!(pin_note, "pin_note");
    push!(ordered_po, "ordered_po");
    push!(stock_info, "stock_info");
    push!(suit_variant_id, "suit_variant_id");
    push!(is_free_suit_promo, "is_free_suit_promo");
    k
}

async fn update_member(
    State(state): State<AppState>,
    Path(member_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdateMemberRequest>,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let log_actor = body.actor_name.clone();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_members WHERE id = $1)")
            .bind(member_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(WeddingError::MemberNotFound);
    }

    let patch_keys = member_patch_keys(&body);

    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new("UPDATE wedding_members SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    macro_rules! opt {
        ($field:literal, $val:expr) => {
            if let Some(v) = $val {
                sep.push(concat!($field, " = ")).push_bind(v);
                has_updates = true;
            }
        };
    }

    opt!("role", body.role.clone());
    opt!("notes", body.notes.clone());
    opt!("status", body.status.clone());
    opt!("member_index", body.member_index);
    opt!("oot", body.oot);
    opt!("suit", body.suit.clone());
    opt!("waist", body.waist.clone());
    opt!("vest", body.vest.clone());
    opt!("shirt", body.shirt.clone());
    opt!("shoe", body.shoe.clone());
    opt!("measured", body.measured);
    opt!("suit_ordered", body.suit_ordered);
    opt!("received", body.received);
    opt!("fitting", body.fitting);
    opt!("pickup_status", body.pickup_status.clone());
    opt!("measure_date", body.measure_date);
    opt!("ordered_date", body.ordered_date);
    opt!("received_date", body.received_date);
    opt!("fitting_date", body.fitting_date);
    opt!("pickup_date", body.pickup_date);
    opt!("ordered_items", body.ordered_items.clone());
    opt!("member_accessories", body.member_accessories.clone());
    opt!("contact_history", body.contact_history.clone());
    opt!("pin_note", body.pin_note);
    opt!("ordered_po", body.ordered_po.clone());
    opt!("stock_info", body.stock_info.clone());
    opt!("suit_variant_id", body.suit_variant_id);
    opt!("is_free_suit_promo", body.is_free_suit_promo);

    if !has_updates {
        let member = fetch_member_optional(&state.db, member_id)
            .await?
            .ok_or(WeddingError::MemberNotFound)?;
        return Ok(Json(member));
    }

    qb.push(" WHERE id = ").push_bind(member_id);
    qb.build().execute(&state.db).await?;

    if patch_keys.iter().any(|k| {
        matches!(
            k.as_str(),
            "suit" | "waist" | "vest" | "shirt" | "shoe" | "measure_date" | "measured"
        )
    }) {
        if let Err(e) = crate::logic::customer_measurements::sync_retail_from_wedding_member(
            &state.db, member_id,
        )
        .await
        {
            tracing::warn!(error = %e, wedding_member_id = %member_id, "measurement sync failed");
        }
    }

    if !patch_keys.is_empty() {
        let party_id: Uuid =
            sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
                .bind(member_id)
                .fetch_one(&state.db)
                .await?;
        let actor = resolve_actor(log_actor);
        let desc = body
            .activity_description
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Member updated: {}", patch_keys.join(", ")));
        if let Err(e) = wedding_logic::insert_wedding_activity(
            &state.db,
            party_id,
            Some(member_id),
            &actor,
            "STATUS_CHANGE",
            &desc,
            json!({ "fields": patch_keys }),
        )
        .await
        {
            tracing::warn!(error = %e, "activity log failed");
        }
    }

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    let party_for_meili: Uuid =
        sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
            .bind(member_id)
            .fetch_one(&state.db)
            .await?;
    spawn_meilisearch_wedding_party(&state, party_for_meili);

    let member = fetch_member_optional(&state.db, member_id)
        .await?
        .ok_or(WeddingError::MemberNotFound)?;
    Ok(Json(member))
}

async fn delete_member_handler(
    State(state): State<AppState>,
    Path(member_id): Path<Uuid>,
    Query(q): Query<super::parties::ActorQuery>,
    headers: HeaderMap,
) -> Result<StatusCode, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let row: Option<Uuid> =
        sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
            .bind(member_id)
            .fetch_optional(&state.db)
            .await?;
    let party_id = row.ok_or(WeddingError::MemberNotFound)?;
    let actor = resolve_actor(q.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        Some(member_id),
        &actor,
        "STATUS_CHANGE",
        "Member removed from party",
        json!({ "removed_wedding_member_id": member_id }),
    )
    .await
    {
        tracing::warn!(error = %e, "activity log failed");
    }
    sqlx::query("DELETE FROM wedding_members WHERE id = $1")
        .bind(member_id)
        .execute(&state.db)
        .await?;
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    spawn_meilisearch_wedding_party(&state, party_id);
    Ok(StatusCode::NO_CONTENT)
}
