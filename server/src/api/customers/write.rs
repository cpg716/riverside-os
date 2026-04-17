// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::{
    require_customer_access, require_customer_perm_or_pos, spawn_meilisearch_customer_hooks,
    staff_id_from_customer_perm_or_pos,
};
use super::read::{
    get_customer_hub, load_customer_profile_row, CustomerHubResponse, CustomerProfileRow,
    MeasurementVaultResponse,
};
use super::CustomerError;
use crate::api::AppState;
use crate::auth::permissions::{
    CUSTOMERS_COUPLE_MANAGE, CUSTOMERS_HUB_EDIT, CUSTOMERS_MEASUREMENTS, CUSTOMERS_MERGE,
    CUSTOMERS_TIMELINE, CUSTOMER_GROUPS_MANAGE, STORE_CREDIT_MANAGE,
};
use crate::logic::customer_measurements;
use crate::logic::customer_merge;
use crate::logic::customers::{insert_customer, InsertCustomerParams};
use crate::logic::lightspeed_customers::{
    execute_lightspeed_customer_import, LightspeedCustomerImportPayload,
    LightspeedCustomerImportSummary,
};
use crate::logic::podium;
use crate::logic::podium_messaging;
use crate::logic::store_credit;
use crate::middleware;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json, Router,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CreateCustomerRequest {
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address_line1: Option<String>,
    pub address_line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub date_of_birth: Option<NaiveDate>,
    pub anniversary_date: Option<NaiveDate>,
    pub custom_field_1: Option<String>,
    pub custom_field_2: Option<String>,
    pub custom_field_3: Option<String>,
    pub custom_field_4: Option<String>,
    pub marketing_email_opt_in: Option<bool>,
    pub marketing_sms_opt_in: Option<bool>,
    pub transactional_sms_opt_in: Option<bool>,
    #[serde(default)]
    pub transactional_email_opt_in: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCustomerRequest {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address_line1: Option<String>,
    pub address_line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub date_of_birth: Option<NaiveDate>,
    pub anniversary_date: Option<NaiveDate>,
    pub custom_field_1: Option<String>,
    pub custom_field_2: Option<String>,
    pub custom_field_3: Option<String>,
    pub custom_field_4: Option<String>,
    pub marketing_email_opt_in: Option<bool>,
    pub marketing_sms_opt_in: Option<bool>,
    pub transactional_sms_opt_in: Option<bool>,
    #[serde(default)]
    pub transactional_email_opt_in: Option<bool>,
    #[serde(default)]
    pub podium_conversation_url: Option<String>,
    pub is_vip: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct BulkCustomerVipRequest {
    pub customer_ids: Vec<Uuid>,
    pub is_vip: bool,
}

#[derive(Debug, Deserialize)]
pub struct MergeCustomersBody {
    pub master_customer_id: Uuid,
    pub slave_customer_id: Uuid,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize)]
pub struct PatchCustomerMeasurementsBody {
    pub neck: Option<Decimal>,
    pub sleeve: Option<Decimal>,
    pub chest: Option<Decimal>,
    pub waist: Option<Decimal>,
    pub seat: Option<Decimal>,
    pub inseam: Option<Decimal>,
    pub outseam: Option<Decimal>,
    pub shoulder: Option<Decimal>,
    pub retail_suit: Option<String>,
    pub retail_waist: Option<String>,
    pub retail_vest: Option<String>,
    pub retail_shirt: Option<String>,
    pub retail_shoe: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CustomerGroupMemberBody {
    pub customer_id: Uuid,
    pub group_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct RemoveCustomerGroupQuery {
    pub customer_id: Uuid,
    pub group_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct StoreCreditAdjustBody {
    pub amount: Decimal,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct PostCustomerNoteRequest {
    pub body: String,
    pub created_by_staff_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct PostCustomerPodiumEmailBody {
    subject: String,
    html_body: String,
}

#[derive(Debug, Deserialize)]
struct PostCustomerPodiumReplyBody {
    channel: String,
    body: String,
    #[serde(default)]
    subject: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CoupleLinkRequest {
    pub partner_id: Uuid,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", axum::routing::post(create_customer))
        .route(
            "/group-members",
            axum::routing::post(add_customer_group_member).delete(remove_customer_group_member),
        )
        .route("/merge", axum::routing::post(post_merge_customers))
        .route("/bulk-vip", axum::routing::post(bulk_set_customer_vip))
        .route(
            "/import/lightspeed",
            axum::routing::post(import_lightspeed_customers),
        )
        .route(
            "/{customer_id}/measurements",
            axum::routing::patch(patch_customer_measurements),
        )
        .route(
            "/{customer_id}/store-credit/adjust",
            axum::routing::post(post_customer_store_credit_adjust),
        )
        .route(
            "/{customer_id}/notes",
            axum::routing::post(post_customer_timeline_note),
        )
        .route(
            "/{customer_id}/podium/email",
            axum::routing::post(post_customer_podium_email),
        )
        .route(
            "/{customer_id}/podium/messages",
            axum::routing::post(post_customer_podium_reply),
        )
        .route(
            "/{customer_id}/couple-link",
            axum::routing::post(post_couple_link).delete(delete_couple_link),
        )
        .route(
            "/{customer_id}/couple-link-new",
            axum::routing::post(post_couple_create),
        )
        .route("/{customer_id}", axum::routing::patch(update_customer))
}

type NormalizedCustomerInput = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    bool,
    bool,
    bool,
);

fn normalize_customer_input(
    payload: &CreateCustomerRequest,
) -> Result<NormalizedCustomerInput, CustomerError> {
    let first = payload.first_name.trim();
    let last = payload.last_name.trim();
    if first.is_empty() || last.is_empty() {
        return Err(CustomerError::NameRequired);
    }

    let email = payload
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let phone = payload
        .phone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let line1 = payload
        .address_line1
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let line2 = payload
        .address_line2
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let city = payload
        .city
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let state_st = payload
        .state
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let postal = payload
        .postal_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let m_email = payload.marketing_email_opt_in.unwrap_or(false);
    let m_sms = payload.marketing_sms_opt_in.unwrap_or(false);
    let t_sms = payload.transactional_sms_opt_in.unwrap_or(m_sms);
    let t_email = payload.transactional_email_opt_in.unwrap_or(m_email);

    Ok((
        first.to_string(),
        last.to_string(),
        email,
        phone,
        line1,
        line2,
        city,
        state_st,
        postal,
        m_email,
        m_sms,
        t_sms,
        t_email,
    ))
}

pub async fn create_customer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateCustomerRequest>,
) -> Result<Json<CustomerProfileRow>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let (
        first,
        last,
        email,
        phone,
        line1,
        line2,
        city,
        state_st,
        postal,
        m_email,
        m_sms,
        t_sms,
        t_email,
    ) = normalize_customer_input(&payload)?;

    let trim_opt = |o: &Option<String>| {
        o.as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    let id = insert_customer(
        &state.db,
        InsertCustomerParams {
            customer_code: None,
            first_name: first,
            last_name: last,
            company_name: trim_opt(&payload.company_name),
            email,
            phone,
            address_line1: line1,
            address_line2: line2,
            city,
            state: state_st,
            postal_code: postal,
            date_of_birth: payload.date_of_birth,
            anniversary_date: payload.anniversary_date,
            custom_field_1: trim_opt(&payload.custom_field_1),
            custom_field_2: trim_opt(&payload.custom_field_2),
            custom_field_3: trim_opt(&payload.custom_field_3),
            custom_field_4: trim_opt(&payload.custom_field_4),
            marketing_email_opt_in: m_email,
            marketing_sms_opt_in: m_sms,
            transactional_sms_opt_in: t_sms,
            transactional_email_opt_in: t_email,
            customer_created_source: crate::logic::customers::CustomerCreatedSource::Store,
        },
    )
    .await?;

    let row = load_customer_profile_row(&state.db, id).await?;
    spawn_meilisearch_customer_hooks(&state, id);
    Ok(Json(row))
}

pub async fn update_customer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<UpdateCustomerRequest>,
) -> Result<Json<CustomerProfileRow>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let mut qb: sqlx::QueryBuilder<'_, sqlx::Postgres> =
        sqlx::QueryBuilder::new("UPDATE customers SET ");
    let mut sep = qb.separated(", ");
    let mut n = 0u8;

    if let Some(ref v) = body.first_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("first_name = ").push_bind(t.to_string());
            n += 1;
        }
    }
    if let Some(ref v) = body.last_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("last_name = ").push_bind(t.to_string());
            n += 1;
        }
    }

    if let Some(ref v) = body.company_name {
        let t = v.trim();
        sep.push("company_name = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }

    if let Some(email_raw) = body.email {
        let t = email_raw.trim();
        let bind: Option<String> = if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
        sep.push("email = ").push_bind(bind);
        n += 1;
    }
    if let Some(phone_raw) = body.phone {
        let t = phone_raw.trim();
        let bind: Option<String> = if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
        sep.push("phone = ").push_bind(bind);
        n += 1;
    }

    if let Some(v) = body.address_line1 {
        let t = v.trim();
        sep.push("address_line1 = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.address_line2 {
        let t = v.trim();
        sep.push("address_line2 = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.city {
        let t = v.trim();
        sep.push("city = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.state {
        let t = v.trim();
        sep.push("state = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.postal_code {
        let t = v.trim();
        sep.push("postal_code = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }

    if let Some(v) = body.date_of_birth {
        sep.push("date_of_birth = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.anniversary_date {
        sep.push("anniversary_date = ").push_bind(v);
        n += 1;
    }

    if let Some(ref v) = body.custom_field_1 {
        let t = v.trim();
        sep.push("custom_field_1 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_2 {
        let t = v.trim();
        sep.push("custom_field_2 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_3 {
        let t = v.trim();
        sep.push("custom_field_3 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_4 {
        let t = v.trim();
        sep.push("custom_field_4 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }

    if let Some(v) = body.marketing_email_opt_in {
        sep.push("marketing_email_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.marketing_sms_opt_in {
        sep.push("marketing_sms_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.transactional_sms_opt_in {
        sep.push("transactional_sms_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.transactional_email_opt_in {
        sep.push("transactional_email_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(ref v) = body.podium_conversation_url {
        let t = v.trim();
        sep.push("podium_conversation_url = ")
            .push_bind(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(v) = body.is_vip {
        sep.push("is_vip = ").push_bind(v);
        n += 1;
    }

    if n == 0 {
        let row = load_customer_profile_row(&state.db, customer_id).await?;
        return Ok(Json(row));
    }

    qb.push(" WHERE id = ").push_bind(customer_id);
    qb.build().execute(&state.db).await?;

    let row = load_customer_profile_row(&state.db, customer_id).await?;
    spawn_meilisearch_customer_hooks(&state, customer_id);
    Ok(Json(row))
}

pub async fn bulk_set_customer_vip(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkCustomerVipRequest>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    if body.customer_ids.is_empty() {
        return Err(CustomerError::BadRequest(
            "customer_ids cannot be empty".to_string(),
        ));
    }

    sqlx::query("UPDATE customers SET is_vip = $1 WHERE id = ANY($2)")
        .bind(body.is_vip)
        .bind(&body.customer_ids[..])
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "status": "updated" })))
}

pub async fn import_lightspeed_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LightspeedCustomerImportPayload>,
) -> Result<Json<LightspeedCustomerImportSummary>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let summary = execute_lightspeed_customer_import(&state.db, payload)
        .await
        .map_err(|e| match e {
            crate::logic::lightspeed_customers::LightspeedCustomerImportError::InvalidPayload(
                m,
            ) => CustomerError::BadRequest(m),
            crate::logic::lightspeed_customers::LightspeedCustomerImportError::Database(d) => {
                CustomerError::Database(d)
            }
        })?;
    if let Some(c) = state.meilisearch.clone() {
        let pool = state.db.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::logic::meilisearch_sync::reindex_all_meilisearch(&c, &pool).await
            {
                tracing::error!(error = %e, "Meilisearch reindex after Lightspeed customer import failed");
            }
        });
    }
    Ok(Json(summary))
}

pub async fn post_merge_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MergeCustomersBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_MERGE)
        .await
        .map_err(|(_code, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;

    if body.dry_run {
        let preview = customer_merge::merge_preview(
            &state.db,
            body.master_customer_id,
            body.slave_customer_id,
        )
        .await
        .map_err(|e| match e {
            customer_merge::CustomerMergeError::Db(d) => CustomerError::Database(d),
            customer_merge::CustomerMergeError::BadRequest(m) => CustomerError::BadRequest(m),
        })?;
        return Ok(Json(json!({ "dry_run": true, "preview": preview })));
    }

    customer_merge::merge_customers(&state.db, body.master_customer_id, body.slave_customer_id)
        .await
        .map_err(|e| match e {
            customer_merge::CustomerMergeError::Db(d) => CustomerError::Database(d),
            customer_merge::CustomerMergeError::BadRequest(m) => CustomerError::BadRequest(m),
        })?;

    let pool = state.db.clone();
    let actor_id = staff.id;
    let master_id = body.master_customer_id;
    let slave_id = body.slave_customer_id;
    tokio::spawn(async move {
        if let Err(e) = crate::logic::notifications::emit_customer_merge_completed(
            &pool, actor_id, master_id, slave_id,
        )
        .await
        {
            tracing::error!(error = %e, "emit_customer_merge_completed");
        }
    });

    if let Some(c) = state.meilisearch.clone() {
        let pool = state.db.clone();
        tokio::spawn(async move {
            // Delete slave from Meilisearch
            if let Err(e) =
                crate::logic::meilisearch_sync::spawn_meilisearch_customer_delete(&c, slave_id)
                    .await
            {
                tracing::error!(error = %e, slave_id = %slave_id, "Meilisearch customer delete after merge failed");
            }
            // Upsert master to ensure latest metrics/status are reflected
            if let Err(e) = crate::logic::meilisearch_sync::spawn_meilisearch_customer_upsert(
                &c, &pool, master_id,
            )
            .await
            {
                tracing::error!(error = %e, master_id = %master_id, "Meilisearch customer upsert after merge failed");
            }
        });
    }

    Ok(Json(json!({ "status": "merged" })))
}

pub async fn patch_customer_measurements(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PatchCustomerMeasurementsBody>,
) -> Result<Json<MeasurementVaultResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_MEASUREMENTS).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let patch = customer_measurements::PatchMeasurementBlock {
        neck: body.neck,
        sleeve: body.sleeve,
        chest: body.chest,
        waist: body.waist,
        seat: body.seat,
        inseam: body.inseam,
        outseam: body.outseam,
        shoulder: body.shoulder,
        retail_suit: body.retail_suit,
        retail_waist: body.retail_waist,
        retail_vest: body.retail_vest,
        retail_shirt: body.retail_shirt,
        retail_shoe: body.retail_shoe,
    };

    customer_measurements::patch_measurement_block(&state.db, customer_id, &patch)
        .await
        .map_err(CustomerError::Database)?;

    super::read::get_customer_measurement_vault(
        State(state.clone()),
        headers.clone(),
        Path(customer_id),
    )
    .await
}

pub async fn add_customer_group_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CustomerGroupMemberBody>,
) -> Result<StatusCode, CustomerError> {
    let _staff =
        middleware::require_staff_with_permission(&state, &headers, CUSTOMER_GROUPS_MANAGE)
            .await
            .map_err(|(_code, axum::Json(v))| {
                CustomerError::Unauthorized(
                    v.get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("not authorized")
                        .to_string(),
                )
            })?;

    sqlx::query(
        r#"
        INSERT INTO customer_group_members (customer_id, group_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(body.customer_id)
    .bind(body.group_id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_customer_group_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RemoveCustomerGroupQuery>,
) -> Result<StatusCode, CustomerError> {
    let _staff =
        middleware::require_staff_with_permission(&state, &headers, CUSTOMER_GROUPS_MANAGE)
            .await
            .map_err(|(_code, axum::Json(v))| {
                CustomerError::Unauthorized(
                    v.get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("not authorized")
                        .to_string(),
                )
            })?;

    sqlx::query("DELETE FROM customer_group_members WHERE customer_id = $1 AND group_id = $2")
        .bind(q.customer_id)
        .bind(q.group_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn post_customer_store_credit_adjust(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<StoreCreditAdjustBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, STORE_CREDIT_MANAGE)
        .await
        .map_err(|(_code, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let new_bal = store_credit::adjust_balance(&state.db, customer_id, body.amount, &body.reason)
        .await
        .map_err(|e| match e {
            store_credit::StoreCreditError::InsufficientBalance => CustomerError::BadRequest(
                "Insufficient store credit balance for this adjustment".to_string(),
            ),
            store_credit::StoreCreditError::ReasonRequired => {
                CustomerError::BadRequest("Adjustment reason is required".to_string())
            }
            store_credit::StoreCreditError::NotFound => CustomerError::NotFound,
            store_credit::StoreCreditError::Database(d) => CustomerError::Database(d),
        })?;

    Ok(Json(json!({ "balance": new_bal })))
}

pub async fn post_customer_timeline_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerNoteRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_TIMELINE).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let text = body.body.trim();
    if text.is_empty() {
        return Err(CustomerError::BadRequest(
            "Note body cannot be empty".to_string(),
        ));
    }

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO customer_timeline_notes (customer_id, body, created_by)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(text)
    .bind(body.created_by_staff_id)
    .fetch_one(&state.db)
    .await
    .map_err(CustomerError::Database)?;

    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

async fn post_customer_podium_email(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerPodiumEmailBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let staff_id = staff_id_from_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let sub = body.subject.trim();
    let html = body.html_body.trim();
    if sub.is_empty() || html.is_empty() {
        return Err(CustomerError::BadRequest(
            "subject and html_body are required".to_string(),
        ));
    }
    let row = load_customer_profile_row(&state.db, customer_id).await?;
    let Some(ref em) = row.email else {
        return Err(CustomerError::BadRequest(
            "Customer has no email on file".to_string(),
        ));
    };
    if !podium::looks_like_email(em) {
        return Err(CustomerError::BadRequest(
            "Customer email is missing or invalid".to_string(),
        ));
    }
    match podium::send_podium_email_message(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        em,
        sub,
        html,
    )
    .await
    {
        Ok(()) => {
            let em_t = em.trim();
            if let Err(e) = podium_messaging::record_outbound_message(
                &state.db,
                customer_id,
                "email",
                html,
                staff_id,
                None,
                Some(em_t),
                "outbound",
            )
            .await
            {
                tracing::error!(error = %e, "record podium outbound email");
            }
            Ok(Json(json!({ "status": "sent" })))
        }
        Err(e) => Err(CustomerError::PodiumUnavailable(format!(
            "Could not send via Podium ({e}). Enable operational email in Integrations, set location UID, and verify Podium env credentials."
        ))),
    }
}

async fn post_customer_podium_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerPodiumReplyBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let id_for_insert =
        staff_id_from_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let ch = body.channel.trim().to_ascii_lowercase();
    let text = body.body.trim();
    if text.is_empty() {
        return Err(CustomerError::BadRequest("body is required".to_string()));
    }
    let row = load_customer_profile_row(&state.db, customer_id).await?;
    match ch.as_str() {
        "sms" | "phone" => {
            let Some(ref ph) = row.phone else {
                return Err(CustomerError::BadRequest(
                    "Customer has no phone on file".to_string(),
                ));
            };
            podium::send_podium_sms_message(
                &state.db,
                &state.http_client,
                &state.podium_token_cache,
                ph,
                text,
            )
            .await
            .map_err(|e| {
                CustomerError::PodiumUnavailable(format!(
                    "Could not send SMS via Podium ({e}). Check Integrations and env credentials."
                ))
            })?;
            let e164 = podium::normalize_phone_e164(ph.as_str());
            podium_messaging::record_outbound_message(
                &state.db,
                customer_id,
                "sms",
                text,
                id_for_insert,
                e164.as_deref(),
                None,
                "outbound",
            )
            .await
            .map_err(CustomerError::Database)?;
        }
        "email" | "e-mail" => {
            let sub = body.subject.as_deref().unwrap_or("").trim();
            if sub.is_empty() {
                return Err(CustomerError::BadRequest(
                    "subject is required for email".to_string(),
                ));
            }
            let Some(ref em) = row.email else {
                return Err(CustomerError::BadRequest(
                    "Customer has no email on file".to_string(),
                ));
            };
            if !podium::looks_like_email(em) {
                return Err(CustomerError::BadRequest(
                    "Customer email is invalid".to_string(),
                ));
            }
            podium::send_podium_email_message(
                &state.db,
                &state.http_client,
                &state.podium_token_cache,
                em,
                sub,
                text,
            )
            .await
            .map_err(|e| {
                CustomerError::PodiumUnavailable(format!(
                    "Could not send email via Podium ({e}). Check Integrations and env credentials."
                ))
            })?;
            let em_t = em.trim();
            podium_messaging::record_outbound_message(
                &state.db,
                customer_id,
                "email",
                text,
                id_for_insert,
                None,
                Some(em_t),
                "outbound",
            )
            .await
            .map_err(CustomerError::Database)?;
        }
        _ => {
            return Err(CustomerError::BadRequest(
                "channel must be sms or email".to_string(),
            ));
        }
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn post_couple_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<CoupleLinkRequest>,
) -> Result<Json<CustomerHubResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_COUPLE_MANAGE).await?;
    crate::logic::customer_couple::link_couple(&state.db, customer_id, body.partner_id)
        .await
        .map_err(|e| CustomerError::Logic(e.to_string()))?;

    get_customer_hub(State(state), headers, Path(customer_id)).await
}

pub async fn post_couple_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(payload): Json<CreateCustomerRequest>,
) -> Result<Json<CustomerHubResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_COUPLE_MANAGE).await?;

    let (
        first,
        last,
        email,
        phone,
        line1,
        line2,
        city,
        state_st,
        postal,
        m_email,
        m_sms,
        t_sms,
        t_email,
    ) = normalize_customer_input(&payload)?;

    let trim_opt = |o: &Option<String>| {
        o.as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    let partner_id = insert_customer(
        &state.db,
        InsertCustomerParams {
            customer_code: None,
            first_name: first,
            last_name: last,
            company_name: trim_opt(&payload.company_name),
            email,
            phone,
            address_line1: line1,
            address_line2: line2,
            city,
            state: state_st,
            postal_code: postal,
            date_of_birth: payload.date_of_birth,
            anniversary_date: payload.anniversary_date,
            custom_field_1: trim_opt(&payload.custom_field_1),
            custom_field_2: trim_opt(&payload.custom_field_2),
            custom_field_3: trim_opt(&payload.custom_field_3),
            custom_field_4: trim_opt(&payload.custom_field_4),
            marketing_email_opt_in: m_email,
            marketing_sms_opt_in: m_sms,
            transactional_sms_opt_in: t_sms,
            transactional_email_opt_in: t_email,
            customer_created_source: crate::logic::customers::CustomerCreatedSource::Store,
        },
    )
    .await
    .map_err(CustomerError::Database)?;

    crate::logic::customer_couple::link_couple(&state.db, customer_id, partner_id)
        .await
        .map_err(|e| CustomerError::Logic(e.to_string()))?;

    get_customer_hub(State(state), headers, Path(customer_id)).await
}

pub async fn delete_couple_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_COUPLE_MANAGE).await?;
    crate::logic::customer_couple::unlink_couple(&state.db, customer_id)
        .await
        .map_err(|e| CustomerError::BadRequest(e.to_string()))?;

    Ok(Json(json!({ "status": "unlinked" })))
}
