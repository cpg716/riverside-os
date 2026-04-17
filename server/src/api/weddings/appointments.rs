// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::{
    parse_datetime, require_weddings_mutate, require_weddings_view,
    spawn_meilisearch_appointment_upsert, wedding_client_sender,
};
use super::AppointmentRow;
use super::WeddingError;
use crate::api::AppState;
use crate::logic::messaging::MessagingService;
use crate::logic::staff_schedule;
use crate::logic::wedding_queries::list_appointments_filtered;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use sqlx::QueryBuilder;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CreateAppointmentRequest {
    #[serde(default)]
    pub wedding_member_id: Option<Uuid>,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    pub customer_display_name: Option<String>,
    pub phone: Option<String>,
    pub appointment_type: Option<String>,
    pub starts_at: chrono::DateTime<chrono::Utc>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub salesperson: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAppointmentRequest {
    pub customer_display_name: Option<String>,
    pub phone: Option<String>,
    pub appointment_type: Option<String>,
    pub starts_at: Option<chrono::DateTime<chrono::Utc>>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub salesperson: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppointmentsQuery {
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/appointments",
            get(list_appointments).post(create_appointment),
        )
        .route("/appointments/search", get(search_appointments))
        .route(
            "/appointments/{appointment_id}",
            axum::routing::patch(update_appointment).delete(delete_appointment),
        )
}

async fn list_appointments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AppointmentsQuery>,
) -> Result<Json<Vec<AppointmentRow>>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let from_dt = q.from.as_ref().map(|s| parse_datetime(s)).transpose()?;
    let to_dt = q.to.as_ref().map(|s| parse_datetime(s)).transpose()?;
    let rows = list_appointments_filtered(&state.db, from_dt, to_dt).await?;
    Ok(Json(rows))
}

async fn create_appointment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateAppointmentRequest>,
) -> Result<Json<AppointmentRow>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let name_ok = body
        .customer_display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let phone_ok = body
        .phone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (party_id, member_id, customer_id) = if let Some(mid) = body.wedding_member_id {
        let row: Option<(Uuid, Uuid)> =
            sqlx::query_as("SELECT wedding_party_id, id FROM wedding_members WHERE id = $1")
                .bind(mid)
                .fetch_optional(&state.db)
                .await?;
        let (pid, real_mid) = row.ok_or(WeddingError::MemberNotFound)?;
        (Some(pid), Some(real_mid), body.customer_id)
    } else {
        if name_ok.is_none() && phone_ok.is_none() {
            return Err(WeddingError::BadRequest(
                "Provide a wedding member, or a customer name or phone for this appointment."
                    .to_string(),
            ));
        }
        (None, None, body.customer_id)
    };

    let appt_type = body
        .appointment_type
        .as_deref()
        .unwrap_or("Measurement")
        .to_string();
    let status = body.status.as_deref().unwrap_or("Scheduled").to_string();

    staff_schedule::ensure_salesperson_booking_allowed(
        &state.db,
        body.salesperson.as_deref(),
        body.starts_at,
    )
    .await
    .map_err(|e| match e {
        staff_schedule::StaffScheduleError::BadRequest(m) => WeddingError::BadRequest(m),
        staff_schedule::StaffScheduleError::Database(e) => WeddingError::Database(e),
        staff_schedule::StaffScheduleError::NotFound => {
            WeddingError::BadRequest("Schedule check failed".to_string())
        }
    })?;

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_appointments (
            wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
            appointment_type, starts_at, notes, status, salesperson
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
        "#,
    )
    .bind(party_id)
    .bind(member_id)
    .bind(customer_id)
    .bind(&body.customer_display_name)
    .bind(&body.phone)
    .bind(&appt_type)
    .bind(body.starts_at)
    .bind(&body.notes)
    .bind(&status)
    .bind(&body.salesperson)
    .fetch_one(&state.db)
    .await?;

    let appt: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    let appt_email = appt.clone();
    let pool = state.db.clone();
    let http = state.http_client.clone();
    let cache = Arc::clone(&state.podium_token_cache);
    tokio::spawn(async move {
        if let Err(e) =
            MessagingService::trigger_appointment_confirmation(&pool, &http, &cache, &appt_email)
                .await
        {
            tracing::error!(error = %e, "appointment confirmation email hook failed");
        }
    });

    state
        .wedding_events
        .appointments_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_appointment_upsert(&state, id);

    Ok(Json(appt))
}

async fn update_appointment(
    State(state): State<AppState>,
    Path(appointment_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdateAppointmentRequest>,
) -> Result<Json<AppointmentRow>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;

    let current: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(appointment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| WeddingError::BadRequest("Appointment not found".to_string()))?;

    let merged_starts = body.starts_at.unwrap_or(current.starts_at);
    let merged_salesperson = body
        .salesperson
        .clone()
        .or_else(|| current.salesperson.clone());
    staff_schedule::ensure_salesperson_booking_allowed(
        &state.db,
        merged_salesperson.as_deref(),
        merged_starts,
    )
    .await
    .map_err(|e| match e {
        staff_schedule::StaffScheduleError::BadRequest(m) => WeddingError::BadRequest(m),
        staff_schedule::StaffScheduleError::Database(e) => WeddingError::Database(e),
        staff_schedule::StaffScheduleError::NotFound => {
            WeddingError::BadRequest("Schedule check failed".to_string())
        }
    })?;

    let mut qb: QueryBuilder<'_, sqlx::Postgres> =
        QueryBuilder::new("UPDATE wedding_appointments SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    macro_rules! set_opt {
        ($field:literal, $value:expr) => {
            if let Some(v) = $value {
                sep.push(concat!($field, " = ")).push_bind(v);
                has_updates = true;
            }
        };
    }

    set_opt!("customer_display_name", body.customer_display_name);
    set_opt!("phone", body.phone);
    set_opt!("appointment_type", body.appointment_type);
    set_opt!("starts_at", body.starts_at);
    set_opt!("notes", body.notes);
    set_opt!("status", body.status);
    set_opt!("salesperson", body.salesperson);

    if has_updates {
        qb.push(" WHERE id = ").push_bind(appointment_id);
        let result = qb.build().execute(&state.db).await?;
        if result.rows_affected() == 0 {
            return Err(WeddingError::BadRequest(
                "Appointment not found".to_string(),
            ));
        }
        state
            .wedding_events
            .appointments_updated(wedding_client_sender(&headers).as_deref());

        spawn_meilisearch_appointment_upsert(&state, appointment_id);
    }

    let appt: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(appointment_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(appt))
}

async fn delete_appointment(
    State(state): State<AppState>,
    Path(appointment_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let result = sqlx::query("DELETE FROM wedding_appointments WHERE id = $1")
        .bind(appointment_id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(WeddingError::BadRequest(
            "Appointment not found".to_string(),
        ));
    }
    state
        .wedding_events
        .appointments_updated(wedding_client_sender(&headers).as_deref());
    Ok(StatusCode::NO_CONTENT)
}

async fn search_appointments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Vec<AppointmentRow>>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let rows = crate::logic::wedding_queries::search_appointments_hybrid(
        &state.db,
        state.meilisearch.as_ref(),
        q.q.as_deref().unwrap_or(""),
        40,
    )
    .await?;
    Ok(Json(rows))
}
