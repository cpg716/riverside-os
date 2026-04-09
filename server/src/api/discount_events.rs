//! Discount events (merchandising) — CRUD + variant membership.

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{CATALOG_EDIT, CATALOG_VIEW};
use crate::middleware::require_staff_with_permission;

#[derive(Debug, Error)]
pub enum DiscountEventError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Not found")]
    NotFound,
    #[error("Forbidden")]
    Forbidden,
}

impl IntoResponse for DiscountEventError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            DiscountEventError::InvalidPayload(m) => {
                (axum::http::StatusCode::BAD_REQUEST, m.clone())
            }
            DiscountEventError::NotFound => (axum::http::StatusCode::NOT_FOUND, self.to_string()),
            DiscountEventError::Forbidden => (axum::http::StatusCode::FORBIDDEN, self.to_string()),
            DiscountEventError::Database(e) => {
                tracing::error!(error = %e, "discount_events db");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct DiscountEventRow {
    pub id: Uuid,
    pub name: String,
    pub receipt_label: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub percent_off: Decimal,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub scope_type: String,
    pub scope_category_id: Option<Uuid>,
    pub scope_vendor_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDiscountEventBody {
    pub name: String,
    pub receipt_label: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub percent_off: Decimal,
    /// `variants` (pick SKUs), `category`, or `vendor` (primary vendor on product).
    #[serde(default)]
    pub scope_type: Option<String>,
    #[serde(default)]
    pub scope_category_id: Option<Uuid>,
    #[serde(default)]
    pub scope_vendor_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchDiscountEventBody {
    pub name: Option<String>,
    pub receipt_label: Option<String>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub percent_off: Option<Decimal>,
    pub is_active: Option<bool>,
    #[serde(default)]
    pub scope_type: Option<String>,
    #[serde(default)]
    pub scope_category_id: Option<Uuid>,
    #[serde(default)]
    pub scope_vendor_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct AddVariantBody {
    pub variant_id: Uuid,
}

#[derive(Debug, Serialize, FromRow)]
pub struct EventVariantRow {
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
}

#[derive(Debug, Deserialize)]
pub struct UsageReportQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct DiscountUsageReportRow {
    pub event_id: Uuid,
    pub event_name: String,
    pub line_count: i64,
    pub units_sold: i64,
    pub subtotal_sum: Decimal,
}

fn naive_day_start_utc(d: NaiveDate) -> DateTime<Utc> {
    match d.and_hms_opt(0, 0, 0) {
        Some(naive_dt) => DateTime::from_naive_utc_and_offset(naive_dt, Utc),
        None => Utc::now(),
    }
}

fn usage_report_range(q: &UsageReportQuery) -> (DateTime<Utc>, DateTime<Utc>) {
    let end =
        q.to.map(|d| naive_day_start_utc(d) + Duration::days(1))
            .unwrap_or_else(|| Utc::now() + Duration::days(1));
    let start = q
        .from
        .map(naive_day_start_utc)
        .unwrap_or_else(|| end - Duration::days(90));
    (start, end)
}

fn validate_discount_scope(
    scope_type: &str,
    cat: Option<Uuid>,
    vend: Option<Uuid>,
) -> Result<(), DiscountEventError> {
    match scope_type {
        "variants" => {
            if cat.is_some() || vend.is_some() {
                return Err(DiscountEventError::InvalidPayload(
                    "variants scope must not include category or vendor targets".to_string(),
                ));
            }
        }
        "category" => {
            if cat.is_none() {
                return Err(DiscountEventError::InvalidPayload(
                    "category scope requires scope_category_id".to_string(),
                ));
            }
            if vend.is_some() {
                return Err(DiscountEventError::InvalidPayload(
                    "category scope must not set scope_vendor_id".to_string(),
                ));
            }
        }
        "vendor" => {
            if vend.is_none() {
                return Err(DiscountEventError::InvalidPayload(
                    "vendor scope requires scope_vendor_id".to_string(),
                ));
            }
            if cat.is_some() {
                return Err(DiscountEventError::InvalidPayload(
                    "vendor scope must not set scope_category_id".to_string(),
                ));
            }
        }
        _ => {
            return Err(DiscountEventError::InvalidPayload(
                "scope_type must be variants, category, or vendor".to_string(),
            ));
        }
    }
    Ok(())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_events).post(create_event))
        .route("/active", get(list_active_events))
        .route("/usage-report", get(usage_report))
        .route(
            "/{id}",
            get(get_event).patch(patch_event).delete(delete_event),
        )
        .route("/{id}/variants", get(list_variants).post(add_variant))
        .route("/{id}/variants/{variant_id}", delete(remove_variant))
}

async fn list_events(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DiscountEventRow>>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_VIEW)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let rows = sqlx::query_as::<_, DiscountEventRow>(
        r#"
        SELECT id, name, receipt_label, starts_at, ends_at, percent_off, is_active, created_at,
               scope_type, scope_category_id, scope_vendor_id
        FROM discount_events
        ORDER BY starts_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn usage_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<UsageReportQuery>,
) -> Result<Json<Vec<DiscountUsageReportRow>>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_VIEW)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let (start, end) = usage_report_range(&q);
    let rows = sqlx::query_as::<_, DiscountUsageReportRow>(
        r#"
        SELECT
            u.event_id,
            de.name AS event_name,
            COUNT(*)::bigint AS line_count,
            COALESCE(SUM(u.quantity), 0)::bigint AS units_sold,
            COALESCE(SUM(u.line_subtotal), 0)::numeric AS subtotal_sum
        FROM discount_event_usage u
        INNER JOIN discount_events de ON de.id = u.event_id
        WHERE u.created_at >= $1 AND u.created_at < $2
        GROUP BY u.event_id, de.name
        ORDER BY subtotal_sum DESC NULLS LAST
        LIMIT 200
        "#,
    )
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn list_active_events(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DiscountEventRow>>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_VIEW)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let rows = sqlx::query_as::<_, DiscountEventRow>(
        r#"
        SELECT id, name, receipt_label, starts_at, ends_at, percent_off, is_active, created_at,
               scope_type, scope_category_id, scope_vendor_id
        FROM discount_events
        WHERE is_active = true
          AND starts_at <= now()
          AND ends_at >= now()
        ORDER BY name ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_event(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<DiscountEventRow>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_VIEW)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let row = sqlx::query_as::<_, DiscountEventRow>(
        r#"
        SELECT id, name, receipt_label, starts_at, ends_at, percent_off, is_active, created_at,
               scope_type, scope_category_id, scope_vendor_id
        FROM discount_events WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(DiscountEventError::NotFound)?;
    Ok(Json(row))
}

async fn create_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateDiscountEventBody>,
) -> Result<Json<DiscountEventRow>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let name = body.name.trim();
    let rl = body.receipt_label.trim();
    if name.is_empty() || rl.is_empty() {
        return Err(DiscountEventError::InvalidPayload(
            "name and receipt_label required".to_string(),
        ));
    }
    if body.percent_off <= Decimal::ZERO || body.percent_off > Decimal::from(100) {
        return Err(DiscountEventError::InvalidPayload(
            "percent_off must be between 0 and 100".to_string(),
        ));
    }
    if body.ends_at < body.starts_at {
        return Err(DiscountEventError::InvalidPayload(
            "ends_at must be >= starts_at".to_string(),
        ));
    }
    let st = body
        .scope_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("variants");
    let (cat, vend) = if st == "variants" {
        (None, None)
    } else if st == "category" {
        (body.scope_category_id, None)
    } else if st == "vendor" {
        (None, body.scope_vendor_id)
    } else {
        return Err(DiscountEventError::InvalidPayload(
            "scope_type must be variants, category, or vendor".to_string(),
        ));
    };
    validate_discount_scope(st, cat, vend)?;
    let row = sqlx::query_as::<_, DiscountEventRow>(
        r#"
        INSERT INTO discount_events (
            name, receipt_label, starts_at, ends_at, percent_off,
            scope_type, scope_category_id, scope_vendor_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, name, receipt_label, starts_at, ends_at, percent_off, is_active, created_at,
                  scope_type, scope_category_id, scope_vendor_id
        "#,
    )
    .bind(name)
    .bind(rl)
    .bind(body.starts_at)
    .bind(body.ends_at)
    .bind(body.percent_off)
    .bind(st)
    .bind(cat)
    .bind(vend)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

async fn patch_event(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchDiscountEventBody>,
) -> Result<Json<DiscountEventRow>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let mut cur = sqlx::query_as::<_, DiscountEventRow>(
        r#"
        SELECT id, name, receipt_label, starts_at, ends_at, percent_off, is_active, created_at,
               scope_type, scope_category_id, scope_vendor_id
        FROM discount_events WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(DiscountEventError::NotFound)?;

    if let Some(ref n) = body.name {
        let t = n.trim();
        if !t.is_empty() {
            cur.name = t.to_string();
        }
    }
    if let Some(ref r) = body.receipt_label {
        let t = r.trim();
        if !t.is_empty() {
            cur.receipt_label = t.to_string();
        }
    }
    if let Some(s) = body.starts_at {
        cur.starts_at = s;
    }
    if let Some(e) = body.ends_at {
        cur.ends_at = e;
    }
    if let Some(p) = body.percent_off {
        cur.percent_off = p;
    }
    if let Some(a) = body.is_active {
        cur.is_active = a;
    }

    if cur.percent_off <= Decimal::ZERO || cur.percent_off > Decimal::from(100) {
        return Err(DiscountEventError::InvalidPayload(
            "percent_off must be between 0 and 100".to_string(),
        ));
    }
    if cur.ends_at < cur.starts_at {
        return Err(DiscountEventError::InvalidPayload(
            "ends_at must be >= starts_at".to_string(),
        ));
    }

    let st = body
        .scope_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cur.scope_type.as_str())
        .to_string();
    let cat = if st == "variants" {
        None
    } else if st == "category" {
        body.scope_category_id.or(cur.scope_category_id)
    } else {
        None
    };
    let vend = if st == "variants" {
        None
    } else if st == "vendor" {
        body.scope_vendor_id.or(cur.scope_vendor_id)
    } else {
        None
    };
    validate_discount_scope(&st, cat, vend)?;

    if st != "variants" {
        sqlx::query("DELETE FROM discount_event_variants WHERE event_id = $1")
            .bind(id)
            .execute(&state.db)
            .await?;
    }

    let row = sqlx::query_as::<_, DiscountEventRow>(
        r#"
        UPDATE discount_events SET
            name = $2,
            receipt_label = $3,
            starts_at = $4,
            ends_at = $5,
            percent_off = $6,
            is_active = $7,
            scope_type = $8,
            scope_category_id = $9,
            scope_vendor_id = $10
        WHERE id = $1
        RETURNING id, name, receipt_label, starts_at, ends_at, percent_off, is_active, created_at,
                  scope_type, scope_category_id, scope_vendor_id
        "#,
    )
    .bind(id)
    .bind(&cur.name)
    .bind(&cur.receipt_label)
    .bind(cur.starts_at)
    .bind(cur.ends_at)
    .bind(cur.percent_off)
    .bind(cur.is_active)
    .bind(&st)
    .bind(cat)
    .bind(vend)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

async fn delete_event(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let n = sqlx::query("DELETE FROM discount_events WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(DiscountEventError::NotFound);
    }
    Ok(Json(json!({ "status": "deleted" })))
}

async fn list_variants(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<EventVariantRow>>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_VIEW)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let rows = sqlx::query_as::<_, EventVariantRow>(
        r#"
        SELECT dv.variant_id, pv.sku, p.name AS product_name
        FROM discount_event_variants dv
        INNER JOIN product_variants pv ON pv.id = dv.variant_id
        INNER JOIN products p ON p.id = pv.product_id
        WHERE dv.event_id = $1
        ORDER BY pv.sku ASC
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn add_variant(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<AddVariantBody>,
) -> Result<Json<serde_json::Value>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    let ev = sqlx::query_as::<_, DiscountEventRow>(
        r#"
        SELECT id, name, receipt_label, starts_at, ends_at, percent_off, is_active, created_at,
               scope_type, scope_category_id, scope_vendor_id
        FROM discount_events WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(DiscountEventError::NotFound)?;
    if ev.scope_type != "variants" {
        return Err(DiscountEventError::InvalidPayload(
            "manual SKU list applies only when promotion scope is 'Selected products'".to_string(),
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO discount_event_variants (event_id, variant_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(id)
    .bind(body.variant_id)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn remove_variant(
    State(state): State<AppState>,
    Path((id, variant_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, DiscountEventError> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT)
        .await
        .map_err(|_| DiscountEventError::Forbidden)?;
    sqlx::query(r#"DELETE FROM discount_event_variants WHERE event_id = $1 AND variant_id = $2"#)
        .bind(id)
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "status": "ok" })))
}
