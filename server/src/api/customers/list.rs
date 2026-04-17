// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::require_customer_access;
use super::CustomerError;
use crate::api::AppState;
use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Customer {
    pub id: Uuid,
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub wedding_active: bool,
    pub wedding_party_name: Option<String>,
    pub wedding_party_id: Option<Uuid>,
    pub wedding_member_id: Option<Uuid>,
    pub couple_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CustomerBrowseQuery {
    pub q: Option<String>,
    pub vip_only: Option<bool>,
    pub balance_due_only: Option<bool>,
    pub wedding_soon_only: Option<bool>,
    pub wedding_within_days: Option<i64>,
    pub wedding_party_q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub group_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CustomerPipelineStats {
    pub total_customers: i64,
    pub vip_customers: i64,
    pub with_balance: i64,
    pub upcoming_weddings: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerBrowseRow {
    pub id: Uuid,
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub is_vip: bool,
    pub open_balance_due: rust_decimal::Decimal,
    pub lifetime_sales: rust_decimal::Decimal,
    pub open_orders_count: i64,
    pub active_shipment_status: Option<String>,
    pub wedding_soon: bool,
    pub wedding_active: bool,
    pub wedding_party_name: Option<String>,
    pub wedding_party_id: Option<Uuid>,
    pub couple_id: Option<Uuid>,
    pub couple_primary_id: Option<Uuid>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerGroupListRow {
    pub id: Uuid,
    pub code: String,
    pub label: String,
    pub member_count: i64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/search", get(search_customers))
        .route("/browse", get(browse_customers))
        .route("/pipeline-stats", get(browse_customer_pipeline_stats))
        .route("/groups", get(list_customer_groups))
}

pub async fn browse_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CustomerBrowseQuery>,
) -> Result<Json<Vec<CustomerBrowseRow>>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let limit = query.limit.unwrap_or(300).clamp(1, 1000);
    let offset = query.offset.unwrap_or(0).clamp(0, 500_000);
    let wedding_days = query.wedding_within_days.unwrap_or(30).clamp(1, 3650);

    let vip_filter = query.vip_only.unwrap_or(false);
    let bd_filter = query.balance_due_only.unwrap_or(false);
    let ws_filter = query.wedding_soon_only.unwrap_or(false);

    let search_raw = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let party_search_raw = query
        .wedding_party_q
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let group_code = query
        .group_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let meili_browse_ids: Option<Vec<uuid::Uuid>> =
        if search_raw.is_some() && party_search_raw.is_none() {
            if let (Some(qs), Some(c)) = (search_raw, state.meilisearch.as_ref()) {
                match crate::logic::meilisearch_search::customer_search_ids(c, qs).await {
                    Ok(ids) if !ids.is_empty() => Some(ids),
                    Ok(_) => None,
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "Meilisearch customer browse failed; using PostgreSQL ILIKE"
                        );
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

    let rows = if let Some(ids) = meili_browse_ids {
        sqlx::query_as::<_, CustomerBrowseRow>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                c.is_vip,
                c.couple_id,
                c.couple_primary_id,
                COALESCE(ob.balance_sum, 0)::numeric(12, 2) AS open_balance_due,
                COALESCE(ob.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales,
                COALESCE(ob.open_orders_count, 0)::bigint AS open_orders_count,
                (
                    SELECT s.status::text 
                    FROM shipment s 
                    WHERE s.customer_id = c.id 
                      AND s.status NOT IN ('delivered', 'cancelled')
                    ORDER BY s.created_at DESC 
                    LIMIT 1
                ) AS active_shipment_status,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                ) AS wedding_soon,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id
            FROM customers c
            LEFT JOIN LATERAL (
                SELECT 
                    SUM(balance_due) FILTER (WHERE status = 'open'::order_status) AS balance_sum,
                    SUM(total_price) FILTER (WHERE status = 'fulfilled'::order_status AND booked_at >= '2018-01-01') AS lifetime_sales,
                    COUNT(*) FILTER (WHERE status IN ('open'::order_status, 'pending_measurement'::order_status)) AS open_orders_count
                FROM transactions
                WHERE customer_id = c.id
            ) ob ON true
            WHERE ($2::bool = false OR c.is_vip = TRUE)
              AND ($3::bool = false OR COALESCE(ob.balance_sum, 0) > 0)
              AND (
                $4::bool = false
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                )
              )
              AND (
                $5::text IS NULL
                OR LENGTH(TRIM($5::text)) = 0
                OR c.id = ANY($8)
              )
              AND (
                $6::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND (
                        COALESCE(wp.party_name, '') ILIKE ('%' || $6::text || '%')
                        OR wp.groom_name ILIKE ('%' || $6::text || '%')
                      )
                )
              )
              AND (
                $7::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM customer_group_members cgm
                    JOIN customer_groups cg ON cg.id = cgm.group_id
                    WHERE cgm.customer_id = c.id
                      AND cg.code = $7::text
                )
              )
            ORDER BY array_position($9::uuid[], c.id)
            LIMIT $10 OFFSET $11
            "#
        ))
        .bind(wedding_days)
        .bind(vip_filter)
        .bind(bd_filter)
        .bind(ws_filter)
        .bind(search_raw)
        .bind(party_search_raw)
        .bind(group_code)
        .bind(&ids[..])
        .bind(&ids[..])
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, CustomerBrowseRow>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                c.is_vip,
                c.couple_id,
                c.couple_primary_id,
                COALESCE(ob.balance_sum, 0)::numeric(12, 2) AS open_balance_due,
                COALESCE(ob.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales,
                COALESCE(ob.open_orders_count, 0)::bigint AS open_orders_count,
                (
                    SELECT s.status::text 
                    FROM shipment s 
                    WHERE s.customer_id = c.id 
                      AND s.status NOT IN ('delivered', 'cancelled')
                    ORDER BY s.created_at DESC 
                    LIMIT 1
                ) AS active_shipment_status,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                ) AS wedding_soon,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id
            FROM customers c
            LEFT JOIN LATERAL (
                SELECT 
                    SUM(balance_due) FILTER (WHERE status = 'open'::order_status) AS balance_sum,
                    SUM(total_price) FILTER (WHERE status = 'fulfilled'::order_status AND booked_at >= '2018-01-01') AS lifetime_sales,
                    COUNT(*) FILTER (WHERE status IN ('open'::order_status, 'pending_measurement'::order_status)) AS open_orders_count
                FROM transactions
                WHERE customer_id = c.id
            ) ob ON true
            WHERE ($2::bool = false OR c.is_vip = TRUE)
              AND ($3::bool = false OR COALESCE(ob.balance_sum, 0) > 0)
              AND (
                $4::bool = false
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                )
              )
              AND (
                $5::text IS NULL
                OR LENGTH(TRIM($5::text)) = 0
                OR c.first_name ILIKE ('%' || $5::text || '%')
                OR c.last_name ILIKE ('%' || $5::text || '%')
                OR c.customer_code ILIKE ('%' || $5::text || '%')
                OR COALESCE(c.company_name, '') ILIKE ('%' || $5::text || '%')
                OR COALESCE(c.email, '') ILIKE ('%' || $5::text || '%')
                OR COALESCE(c.phone, '') ILIKE ('%' || $5::text || '%')
              )
              AND (
                $6::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND (
                        COALESCE(wp.party_name, '') ILIKE ('%' || $6::text || '%')
                        OR wp.groom_name ILIKE ('%' || $6::text || '%')
                      )
                )
              )
              AND (
                $7::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM customer_group_members cgm
                    JOIN customer_groups cg ON cg.id = cgm.group_id
                    WHERE cgm.customer_id = c.id
                      AND cg.code = $7::text
                )
              )
            ORDER BY c.last_name ASC, c.first_name ASC
            LIMIT $8 OFFSET $9
            "#
        ))
        .bind(wedding_days)
        .bind(vip_filter)
        .bind(bd_filter)
        .bind(ws_filter)
        .bind(search_raw)
        .bind(party_search_raw)
        .bind(group_code)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

pub async fn browse_customer_pipeline_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CustomerPipelineStats>, CustomerError> {
    require_customer_access(&state, &headers).await?;

    let stats = sqlx::query!(
        r#"
        SELECT
            COUNT(*)::bigint AS total_customers,
            COUNT(*) FILTER (WHERE is_vip = TRUE)::bigint AS vip_customers,
            (
                SELECT COUNT(DISTINCT customer_id)::bigint
                FROM transactions
                WHERE status = 'open' AND balance_due > 0
            ) AS with_balance,
            (
                SELECT COUNT(DISTINCT wm.customer_id)::bigint
                FROM wedding_members wm
                JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                  AND wp.event_date >= CURRENT_DATE
                  AND wp.event_date <= CURRENT_DATE + INTERVAL '30 days'
            ) AS upcoming_weddings
        FROM customers
        "#
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(CustomerPipelineStats {
        total_customers: stats.total_customers.unwrap_or(0),
        vip_customers: stats.vip_customers.unwrap_or(0),
        with_balance: stats.with_balance.unwrap_or(0),
        upcoming_weddings: stats.upcoming_weddings.unwrap_or(0),
    }))
}

pub async fn search_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<Customer>>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let q = query.q.trim();
    if q.len() < 2 {
        return Err(CustomerError::QueryTooShort);
    }

    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).clamp(0, 500_000);

    let meili_ids: Option<Vec<uuid::Uuid>> = if let Some(c) = state.meilisearch.as_ref() {
        match crate::logic::meilisearch_search::customer_search_ids(c, q).await {
            Ok(ids) if !ids.is_empty() => Some(ids),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "Meilisearch customer search failed; using PostgreSQL ILIKE"
                );
                None
            }
        }
    } else {
        None
    };

    let results = if let Some(ids) = meili_ids {
        sqlx::query_as::<_, Customer>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                c.couple_id,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id,
                (
                    SELECT wm.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_member_id
            FROM customers c
            WHERE c.id = ANY($1)
            ORDER BY array_position($2::uuid[], c.id)
            LIMIT $3 OFFSET $4
            "#
        ))
        .bind(&ids[..])
        .bind(&ids[..])
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        let search_term = format!("%{q}%");
        sqlx::query_as::<_, Customer>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                c.couple_id,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id,
                (
                    SELECT wm.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_member_id
            FROM customers c
            WHERE
                c.first_name ILIKE $1 OR
                c.last_name ILIKE $1 OR
                c.customer_code ILIKE $1 OR
                COALESCE(c.company_name, '') ILIKE $1 OR
                c.email ILIKE $1 OR
                c.phone ILIKE $1 OR
                c.city ILIKE $1 OR
                c.state ILIKE $1 OR
                c.postal_code ILIKE $1 OR
                COALESCE(c.address_line1, '') ILIKE $1 OR
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND (
                        COALESCE(wp.party_name, '') ILIKE $1
                        OR wp.groom_name ILIKE $1
                      )
                )
            ORDER BY c.created_at DESC
            LIMIT $2 OFFSET $3
            "#
        ))
        .bind(search_term)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(results))
}

pub async fn list_customer_groups(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CustomerGroupListRow>>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let rows = sqlx::query_as::<_, CustomerGroupListRow>(
        r#"
        SELECT g.id, g.code, g.label, COUNT(cgm.customer_id)::bigint AS member_count
        FROM customer_groups g
        LEFT JOIN customer_group_members cgm ON cgm.group_id = g.id
        GROUP BY g.id, g.code, g.label
        ORDER BY g.label ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}
