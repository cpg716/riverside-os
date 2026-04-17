// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::CustomerError;
use crate::api::AppState;
use crate::auth::permissions::CUSTOMERS_RMS_CHARGE;
use crate::middleware;
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct RmsChargeRecordsQuery {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    pub kind: Option<String>,
    pub customer_id: Option<Uuid>,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RmsChargeRecordApiRow {
    pub id: Uuid,
    pub record_kind: String,
    pub created_at: DateTime<Utc>,
    pub transaction_id: Uuid,
    pub register_session_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub payment_method: String,
    pub amount: Decimal,
    pub operator_staff_id: Option<Uuid>,
    pub payment_transaction_id: Option<Uuid>,
    pub customer_display: Option<String>,
    pub order_short_ref: Option<String>,
    pub customer_name: Option<String>,
    pub customer_code: Option<String>,
    pub operator_name: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/rms-charge/records", get(list_rms_charge_records))
}

pub async fn list_rms_charge_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RmsChargeRecordsQuery>,
) -> Result<Json<Vec<RmsChargeRecordApiRow>>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_RMS_CHARGE)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;

    let mut qb = sqlx::QueryBuilder::new(
        r#"
        SELECT
            r.id, r.record_kind, r.created_at, r.transaction_id, r.register_session_id,
            r.customer_id, r.payment_method, r.amount, r.operator_staff_id,
            r.payment_transaction_id,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
              NULLIF(TRIM(c.company_name), ''),
              c.customer_code
            ) AS customer_display,
            SUBSTRING(r.transaction_id::text FROM 1 FOR 8) AS order_short_ref,
            (c.first_name || ' ' || c.last_name) AS customer_name,
            c.customer_code,
            s.name AS operator_name
        FROM rms_charge_records r
        LEFT JOIN customers c ON c.id = r.customer_id
        LEFT JOIN staff s ON s.id = r.operator_staff_id
        WHERE 1=1
        "#,
    );

    if let Some(f) = q.from {
        qb.push(" AND r.created_at >= ").push_bind(f);
    }
    if let Some(t) = q.to {
        qb.push(" AND r.created_at <= ").push_bind(t);
    }
    if let Some(k) = q.kind {
        qb.push(" AND r.record_kind = ").push_bind(k);
    }
    if let Some(cid) = q.customer_id {
        qb.push(" AND r.customer_id = ").push_bind(cid);
    }
    if let Some(qs) = q.q {
        let t = format!("%{}%", qs.trim());
        qb.push(" AND (c.first_name ILIKE ")
            .push_bind(t.clone())
            .push(" OR c.last_name ILIKE ")
            .push_bind(t.clone())
            .push(" OR c.customer_code ILIKE ")
            .push_bind(t.clone())
            .push(" OR r.payment_method ILIKE ")
            .push_bind(t)
            .push(")");
    }

    qb.push(" ORDER BY r.created_at DESC");
    qb.push(" LIMIT ")
        .push_bind(q.limit.unwrap_or(100).clamp(1, 1000));
    qb.push(" OFFSET ").push_bind(q.offset.unwrap_or(0));

    let rows = qb
        .build_query_as::<RmsChargeRecordApiRow>()
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}
