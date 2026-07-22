//! Universal operational search aggregation.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use std::future::Future;
use std::time::Duration;
use tokio::time::timeout;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, ALTERATIONS_MANAGE, CATALOG_VIEW,
    CUSTOMERS_HUB_VIEW, GIFT_CARDS_MANAGE, INSIGHTS_VIEW, LOYALTY_PROGRAM_SETTINGS,
    NOTIFICATIONS_VIEW, ORDERS_VIEW, PAYMENTS_VIEW, PHYSICAL_INVENTORY_VIEW, PROCUREMENT_VIEW,
    QBO_VIEW, REGISTER_REPORTS, SETTINGS_ADMIN, SHIPMENTS_VIEW, TASKS_VIEW_TEAM, WEDDINGS_VIEW,
};
use crate::logic::help_corpus;
use crate::logic::help_manual_policy::{self, load_all_policies};
use crate::logic::meilisearch_search::{help_search_hits, HelpSearchHit};
use crate::logic::shipment::{list_shipments, ShipmentListQuery, ShipmentListRow};
use crate::logic::transaction_list::{
    query_paged_transactions, TransactionListQuery, TransactionListResponse,
};
use crate::logic::wedding_api_types::PartyListQuery;
use crate::logic::wedding_queries::query_party_list_page;
use crate::middleware;

const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 12;
const UNIVERSAL_SOURCE_TIMEOUT: Duration = Duration::from_millis(1_100);

#[derive(Debug, Deserialize)]
struct UniversalSearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct UniversalSearchResponse {
    query: String,
    sources_failed: Vec<String>,
    customers: Vec<UniversalCustomerHit>,
    sku_hit: Option<UniversalSkuHit>,
    products: Vec<UniversalProductHit>,
    orders: Vec<TransactionListResponse>,
    shipments: Vec<ShipmentListRow>,
    weddings: Vec<UniversalWeddingHit>,
    alterations: Vec<UniversalAlterationHit>,
    help_hits: Vec<UniversalHelpHit>,
    operational_hits: Vec<UniversalOperationalHit>,
    shortcuts: Vec<UniversalShortcutHit>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct UniversalCustomerHit {
    id: Uuid,
    customer_code: Option<String>,
    first_name: String,
    last_name: String,
    company_name: Option<String>,
    email: Option<String>,
    phone: Option<String>,
    profile_discount_percent: Option<String>,
    tax_exempt: Option<bool>,
    tax_exempt_id: Option<String>,
    wedding_active: bool,
    couple_id: Option<Uuid>,
    wedding_party_name: Option<String>,
    wedding_party_id: Option<Uuid>,
    wedding_member_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct UniversalSkuHit {
    sku: String,
    name: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct UniversalProductHit {
    variant_id: Uuid,
    product_id: Uuid,
    sku: String,
    product_name: String,
    variation_label: Option<String>,
}

#[derive(Debug, Serialize)]
struct UniversalWeddingHit {
    id: Uuid,
    party_name: String,
    groom_name: Option<String>,
    event_date: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct UniversalAlterationHit {
    id: Uuid,
    customer_first_name: Option<String>,
    customer_last_name: Option<String>,
    customer_code: Option<String>,
    customer_phone: Option<String>,
    customer_email: Option<String>,
    item_description: Option<String>,
    work_requested: Option<String>,
    status: String,
    due_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
struct UniversalHelpHit {
    id: String,
    manual_id: String,
    manual_title: String,
    section_slug: String,
    section_heading: String,
    excerpt: String,
}

#[derive(Debug, Serialize)]
struct UniversalShortcutHit {
    intent: String,
}

#[derive(Debug, Serialize)]
struct UniversalOperationalHit {
    id: String,
    domain: String,
    title: String,
    subtitle: String,
    route_tab: String,
    route_section: Option<String>,
    transaction_id: Option<Uuid>,
    occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
enum SearchError {
    Auth(StatusCode, serde_json::Value),
    BadRequest(String),
    Database(sqlx::Error),
}

impl IntoResponse for SearchError {
    fn into_response(self) -> Response {
        match self {
            SearchError::Auth(status, body) => (status, Json(body)).into_response(),
            SearchError::BadRequest(message) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
            }
            SearchError::Database(error) => {
                tracing::error!(error = %error, "universal search database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "universal search failed" })),
                )
                    .into_response()
            }
        }
    }
}

impl From<sqlx::Error> for SearchError {
    fn from(error: sqlx::Error) -> Self {
        SearchError::Database(error)
    }
}

fn map_auth_error(error: (StatusCode, axum::Json<serde_json::Value>)) -> SearchError {
    let (status, Json(body)) = error;
    SearchError::Auth(status, body)
}

fn has_permission(perms: &HashSet<String>, key: &str) -> bool {
    staff_has_permission(perms, key)
}

fn has_searchable_term(value: &str) -> bool {
    value.chars().any(char::is_alphanumeric)
}

fn like_query(q: &str) -> String {
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn phone_like_pattern(value: &str) -> Option<String> {
    let phone_like = value.chars().all(|c| {
        c.is_ascii_digit()
            || c.is_ascii_whitespace()
            || matches!(c, '+' | '-' | '(' | ')' | '.' | '/')
    });
    let digits = value
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>();
    (phone_like && digits.len() >= 7).then(|| format!("%{digits}%"))
}

async fn within_source_deadline<T>(future: impl Future<Output = T>) -> Option<T> {
    timeout(UNIVERSAL_SOURCE_TIMEOUT, future).await.ok()
}

async fn validated_meili_candidate_ids(
    pool: &PgPool,
    client: &meilisearch_sdk::client::Client,
    index_name: &str,
    query: &str,
    ids: Vec<Uuid>,
) -> Option<Vec<Uuid>> {
    if crate::logic::meilisearch_search::candidate_ids_may_be_truncated(index_name, ids.len()) {
        tracing::warn!(
            index = index_name,
            candidate_count = ids.len(),
            query,
            "universal Meilisearch candidate cap reached; using PostgreSQL"
        );
        return None;
    }
    if !crate::logic::meilisearch_search::index_results_are_authoritative(pool, client, index_name)
        .await
    {
        tracing::warn!(
            index = index_name,
            query,
            "universal Meilisearch index health is not authoritative; using PostgreSQL"
        );
        return None;
    }
    if !ids.is_empty() && !crate::logic::meilisearch_search::candidate_ids_are_unique(&ids) {
        tracing::warn!(
            index = index_name,
            query,
            "universal Meilisearch candidate IDs are invalid or duplicated; using PostgreSQL"
        );
        return None;
    }
    Some(ids)
}

async fn ids_hydrate_completely(
    pool: &PgPool,
    table: &'static str,
    ids: &[Uuid],
) -> Result<bool, sqlx::Error> {
    if ids.is_empty() {
        return Ok(false);
    }
    let sql = match table {
        "customers" => "SELECT COUNT(*)::bigint FROM customers WHERE id = ANY($1)",
        "product_variants" => {
            "SELECT COUNT(*)::bigint FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = ANY($1) AND p.is_active = true"
        }
        "alteration_orders" => "SELECT COUNT(*)::bigint FROM alteration_orders WHERE id = ANY($1)",
        "wedding_appointments" => {
            "SELECT COUNT(*)::bigint FROM wedding_appointments WHERE id = ANY($1)"
        }
        "task_instance" => "SELECT COUNT(*)::bigint FROM task_instance WHERE id = ANY($1)",
        _ => return Ok(false),
    };
    let valid = sqlx::query_scalar::<_, i64>(sql)
        .bind(ids)
        .fetch_one(pool)
        .await?;
    Ok(valid == ids.len() as i64)
}

fn hydrated_candidate_page_is_complete(
    candidate_ids: &[Uuid],
    hydrated_ids: impl IntoIterator<Item = Uuid>,
    limit: usize,
) -> bool {
    if !crate::logic::meilisearch_search::candidate_ids_are_unique(candidate_ids) {
        return false;
    }
    let candidate_set = candidate_ids.iter().copied().collect::<HashSet<_>>();
    let mut hydrated_set = HashSet::new();
    for id in hydrated_ids {
        if !candidate_set.contains(&id) || !hydrated_set.insert(id) {
            return false;
        }
    }
    hydrated_set.len() == candidate_ids.len().min(limit)
}

fn help_hits_are_unique(rows: &[HelpSearchHit]) -> bool {
    !rows.is_empty()
        && rows.iter().all(|row| !row.id.trim().is_empty())
        && rows
            .iter()
            .map(|row| row.id.as_str())
            .collect::<HashSet<_>>()
            .len()
            == rows.len()
}

fn excerpt_from_body(text: &str, max: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max {
        return normalized;
    }
    format!(
        "{}...",
        normalized
            .chars()
            .take(max.saturating_sub(3))
            .collect::<String>()
    )
}

fn local_help_search_hits(query: &str, limit: usize) -> Vec<HelpSearchHit> {
    let terms = query
        .split_whitespace()
        .map(|term| {
            term.trim_matches(|c: char| !c.is_ascii_alphanumeric())
                .to_ascii_lowercase()
        })
        .filter(|term| term.len() >= 2)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Vec::new();
    }

    let Ok(chunks) = help_corpus::load_help_chunk_docs() else {
        return Vec::new();
    };

    let mut scored = chunks
        .into_iter()
        .filter_map(|chunk| {
            let title = chunk.manual_title.to_ascii_lowercase();
            let heading = chunk.section_heading.to_ascii_lowercase();
            let body = chunk.body.to_ascii_lowercase();
            let haystack = format!("{title} {heading} {body}");
            let matched_terms = terms
                .iter()
                .filter(|term| haystack.contains(term.as_str()))
                .count();
            if matched_terms == 0 {
                return None;
            }

            let mut score = matched_terms * 10;
            for term in &terms {
                if title.contains(term) {
                    score += 12;
                }
                if heading.contains(term) {
                    score += 8;
                }
            }
            Some((score, chunk.rank.unwrap_or(u32::MAX), chunk))
        })
        .collect::<Vec<_>>();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(limit.clamp(1, 40))
        .map(|(_, _, chunk)| HelpSearchHit {
            id: chunk.id,
            manual_id: chunk.manual_id,
            manual_title: chunk.manual_title,
            section_slug: chunk.section_slug,
            section_heading: chunk.section_heading,
            body: chunk.body,
        })
        .collect()
}

async fn search_customers(
    pool: &PgPool,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalCustomerHit>, sqlx::Error> {
    let meili_ids = if let Some(client) = meilisearch {
        match crate::logic::meilisearch_search::customer_search_ids(client, q).await {
            Ok(ids) => {
                match validated_meili_candidate_ids(
                    pool,
                    client,
                    crate::logic::meilisearch_client::INDEX_CUSTOMERS,
                    q,
                    ids,
                )
                .await
                {
                    Some(ids) if ids.is_empty() => return Ok(Vec::new()),
                    ids => ids,
                }
            }
            Err(error) => {
                tracing::warn!(%error, "universal customer Meilisearch failed; using SQL");
                None
            }
        }
    } else {
        None
    };

    if let Some(ids) = meili_ids {
        if !ids_hydrate_completely(pool, "customers", &ids).await? {
            tracing::warn!(
                query = q,
                "universal customer Meilisearch hydration is incomplete; using PostgreSQL"
            );
        } else {
            let rows = sqlx::query_as::<_, UniversalCustomerHit>(
                r#"
            SELECT
                c.id,
                NULLIF(TRIM(c.customer_code), '') AS customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                c.profile_discount_percent::text AS profile_discount_percent,
                c.tax_exempt,
                c.tax_exempt_id,
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
                    SELECT COALESCE(NULLIF(TRIM(wp.party_name), ''), wp.groom_name)
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
            LIMIT $3
            "#,
            )
            .bind(&ids)
            .bind(&ids)
            .bind(limit as i64)
            .fetch_all(pool)
            .await?;
            if hydrated_candidate_page_is_complete(&ids, rows.iter().map(|row| row.id), limit) {
                return Ok(rows);
            }
            tracing::warn!(
                query = q,
                "universal customer Meilisearch page did not hydrate completely; using PostgreSQL"
            );
        }
    }

    let like = like_query(q);
    let phone_like = phone_like_pattern(q);
    sqlx::query_as::<_, UniversalCustomerHit>(
        r#"
        SELECT
            c.id,
            NULLIF(TRIM(c.customer_code), '') AS customer_code,
            COALESCE(c.first_name, '') AS first_name,
            COALESCE(c.last_name, '') AS last_name,
            c.company_name,
            c.email,
            c.phone,
            c.profile_discount_percent::text AS profile_discount_percent,
            c.tax_exempt,
            c.tax_exempt_id,
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
                SELECT COALESCE(NULLIF(TRIM(wp.party_name), ''), wp.groom_name)
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
        WHERE c.first_name ILIKE $1
           OR c.last_name ILIKE $1
           OR CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE $1
           OR COALESCE(c.customer_code, '') ILIKE $1
           OR COALESCE(c.email, '') ILIKE $1
           OR COALESCE(c.phone, '') ILIKE $1
           OR ($2::text IS NOT NULL AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $2)
           OR COALESCE(c.company_name, '') ILIKE $1
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $3
        "#,
    )
    .bind(like)
    .bind(phone_like)
    .bind(limit as i64)
    .fetch_all(pool)
    .await
}

async fn search_products(
    pool: &PgPool,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalProductHit>, sqlx::Error> {
    let meili_ids = if let Some(client) = meilisearch {
        match crate::logic::meilisearch_search::control_board_search_variant_ids(
            client, q, None, None, None, false, false, None, None, None, false,
        )
        .await
        {
            Ok(ids) => {
                match validated_meili_candidate_ids(
                    pool,
                    client,
                    crate::logic::meilisearch_client::INDEX_VARIANTS,
                    q,
                    ids,
                )
                .await
                {
                    Some(ids) if ids.is_empty() => return Ok(Vec::new()),
                    ids => ids,
                }
            }
            Err(error) => {
                tracing::warn!(%error, "universal product Meilisearch failed; using SQL");
                None
            }
        }
    } else {
        None
    };

    if let Some(ids) = meili_ids {
        if !ids_hydrate_completely(pool, "product_variants", &ids).await? {
            tracing::warn!(
                query = q,
                "universal product Meilisearch hydration is incomplete; using PostgreSQL"
            );
        } else {
            let rows = sqlx::query_as::<_, UniversalProductHit>(
                r#"
            SELECT
                pv.id AS variant_id,
                p.id AS product_id,
                pv.sku,
                p.name AS product_name,
                pv.variation_label
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE p.is_active = true
              AND pv.id = ANY($1)
            ORDER BY array_position($2::uuid[], pv.id)
            LIMIT $3
            "#,
            )
            .bind(&ids)
            .bind(&ids)
            .bind(limit as i64)
            .fetch_all(pool)
            .await?;
            if hydrated_candidate_page_is_complete(
                &ids,
                rows.iter().map(|row| row.variant_id),
                limit,
            ) {
                return Ok(rows);
            }
            tracing::warn!(
                query = q,
                "universal product Meilisearch page did not hydrate completely; using PostgreSQL"
            );
        }
    }

    let like = like_query(q);
    sqlx::query_as::<_, UniversalProductHit>(
        r#"
        SELECT
            pv.id AS variant_id,
            p.id AS product_id,
            pv.sku,
            p.name AS product_name,
            pv.variation_label
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE p.is_active = true
          AND (
            pv.sku ILIKE $1
            OR COALESCE(pv.barcode, '') ILIKE $1
            OR COALESCE(pv.vendor_upc, '') ILIKE $1
            OR p.name ILIKE $1
            OR COALESCE(p.brand, '') ILIKE $1
            OR COALESCE(pv.variation_label, '') ILIKE $1
          )
        ORDER BY p.name ASC, pv.sku ASC, pv.id ASC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .fetch_all(pool)
    .await
}

async fn search_exact_sku(pool: &PgPool, q: &str) -> Result<Option<UniversalSkuHit>, sqlx::Error> {
    sqlx::query(
        r#"
        SELECT pv.sku, p.name
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE p.is_active = true
          AND LOWER(pv.sku) = LOWER($1)
        LIMIT 1
        "#,
    )
    .bind(q)
    .fetch_optional(pool)
    .await
    .map(|row| {
        row.map(|row| UniversalSkuHit {
            sku: row.get("sku"),
            name: row.get("name"),
        })
    })
}

async fn search_alterations(
    pool: &PgPool,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalAlterationHit>, sqlx::Error> {
    let meili_ids = if let Some(client) = meilisearch {
        match crate::logic::meilisearch_search::alteration_search_ids(client, q, false).await {
            Ok(ids) => {
                match validated_meili_candidate_ids(
                    pool,
                    client,
                    crate::logic::meilisearch_client::INDEX_ALTERATIONS,
                    q,
                    ids,
                )
                .await
                {
                    Some(ids) if ids.is_empty() => return Ok(Vec::new()),
                    ids => ids,
                }
            }
            Err(error) => {
                tracing::warn!(%error, "universal alteration Meilisearch failed; using SQL");
                None
            }
        }
    } else {
        None
    };
    let like = like_query(q);
    let meili_ids = if let Some(ids) = meili_ids {
        if ids_hydrate_completely(pool, "alteration_orders", &ids).await? {
            Some(ids)
        } else {
            tracing::warn!(
                query = q,
                "universal alteration Meilisearch hydration is incomplete; using PostgreSQL"
            );
            None
        }
    } else {
        None
    };
    let phone_like = phone_like_pattern(q);
    let rows = query_alteration_rows(
        pool,
        meili_ids.as_deref(),
        &like,
        phone_like.as_deref(),
        limit,
    )
    .await?;
    if let Some(ids) = meili_ids.as_ref() {
        if hydrated_candidate_page_is_complete(ids, rows.iter().map(|row| row.id), limit) {
            return Ok(rows);
        }
        tracing::warn!(
            query = q,
            "universal alteration Meilisearch page did not hydrate completely; using PostgreSQL"
        );
        return query_alteration_rows(pool, None, &like, phone_like.as_deref(), limit).await;
    }
    Ok(rows)
}

async fn query_alteration_rows(
    pool: &PgPool,
    meili_ids: Option<&[Uuid]>,
    like: &str,
    phone_like: Option<&str>,
    limit: usize,
) -> Result<Vec<UniversalAlterationHit>, sqlx::Error> {
    sqlx::query_as::<_, UniversalAlterationHit>(
        r#"
        SELECT
            a.id,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            c.customer_code,
            c.phone AS customer_phone,
            c.email AS customer_email,
            a.item_description,
            a.work_requested,
            a.status::text AS status,
            a.due_at
        FROM alteration_orders a
        LEFT JOIN customers c ON c.id = a.customer_id
        LEFT JOIN transactions t ON t.id = COALESCE(a.transaction_id, a.source_transaction_id)
        WHERE ($1::uuid[] IS NULL OR a.id = ANY($1))
          AND (
            $1::uuid[] IS NOT NULL
            OR a.id::text ILIKE $2
            OR COALESCE(c.first_name, '') ILIKE $2
            OR COALESCE(c.last_name, '') ILIKE $2
            OR CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE $2
            OR COALESCE(c.customer_code, '') ILIKE $2
            OR COALESCE(c.phone, '') ILIKE $2
            OR ($4::text IS NOT NULL AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $4)
            OR COALESCE(c.email, '') ILIKE $2
            OR COALESCE(t.display_id, '') ILIKE $2
            OR COALESCE(a.item_description, '') ILIKE $2
            OR COALESCE(a.work_requested, '') ILIKE $2
            OR COALESCE(a.source_sku, '') ILIKE $2
          )
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $3
        "#,
    )
    .bind(meili_ids)
    .bind(like)
    .bind(limit as i64)
    .bind(phone_like)
    .fetch_all(pool)
    .await
}

async fn search_help(
    state: &AppState,
    q: &str,
    limit: usize,
    perms: &HashSet<String>,
) -> Result<Vec<UniversalHelpHit>, sqlx::Error> {
    let policies = load_all_policies(&state.db).await?;
    let rows = if let Some(client) = state.meilisearch.as_ref() {
        match help_search_hits(client, q, limit).await {
            Ok(rows) => {
                if !crate::logic::meilisearch_search::index_results_are_authoritative(
                    &state.db,
                    client,
                    crate::logic::meilisearch_client::INDEX_HELP,
                )
                .await
                {
                    tracing::warn!(
                        query = q,
                        "universal Help Meilisearch health is not authoritative; using local corpus"
                    );
                    local_help_search_hits(q, limit)
                } else if rows.is_empty() {
                    Vec::new()
                } else if help_hits_are_unique(&rows) {
                    rows
                } else {
                    tracing::warn!(
                        query = q,
                        "universal Help Meilisearch IDs are missing or duplicated; using local corpus"
                    );
                    local_help_search_hits(q, limit)
                }
            }
            Err(error) => {
                tracing::warn!(%error, "universal help Meilisearch failed; using local corpus");
                local_help_search_hits(q, limit)
            }
        }
    } else {
        local_help_search_hits(q, limit)
    };

    Ok(rows
        .into_iter()
        .filter(|hit| {
            help_manual_policy::viewer_can_see_manual(
                &hit.manual_id,
                policies.get(&hit.manual_id),
                false,
                perms,
            )
        })
        .map(|hit| UniversalHelpHit {
            id: hit.id,
            manual_id: hit.manual_id,
            manual_title: hit.manual_title,
            section_slug: hit.section_slug,
            section_heading: hit.section_heading,
            excerpt: excerpt_from_body(&hit.body, 220),
        })
        .collect())
}

fn op_hit(
    id: impl Into<String>,
    domain: impl Into<String>,
    title: impl Into<String>,
    subtitle: impl Into<String>,
    route: (&str, Option<&str>),
    transaction_id: Option<Uuid>,
    occurred_at: Option<DateTime<Utc>>,
) -> UniversalOperationalHit {
    UniversalOperationalHit {
        id: id.into(),
        domain: domain.into(),
        title: title.into(),
        subtitle: subtitle.into(),
        route_tab: route.0.to_string(),
        route_section: route.1.map(str::to_string),
        transaction_id,
        occurred_at,
    }
}

fn has_domain_word(q: &str, words: &[&str]) -> bool {
    let normalized = q
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>();
    let query_words = normalized.split_whitespace().collect::<HashSet<_>>();
    words.iter().any(|word| query_words.contains(word))
}

async fn search_appointments(
    pool: &PgPool,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let mut meili_ids = if let Some(client) = meilisearch {
        match crate::logic::meilisearch_search::appointment_search_ids(client, q).await {
            Ok(ids) => {
                match validated_meili_candidate_ids(
                    pool,
                    client,
                    crate::logic::meilisearch_client::INDEX_APPOINTMENTS,
                    q,
                    ids,
                )
                .await
                {
                    Some(ids) if ids.is_empty() => return Ok(Vec::new()),
                    ids => ids,
                }
            }
            Err(error) => {
                tracing::warn!(%error, "universal appointment Meilisearch failed; using SQL");
                None
            }
        }
    } else {
        None
    };
    if let Some(ids) = meili_ids.as_ref() {
        let hydrates = ids_hydrate_completely(pool, "wedding_appointments", ids).await?;
        if !hydrates {
            tracing::warn!(
                query = q,
                "universal appointment Meilisearch hits did not hydrate; using PostgreSQL"
            );
            meili_ids = None;
        }
    }
    let like = like_query(q);
    let phone_like = phone_like_pattern(q);
    let broad = has_domain_word(q, &["appointment", "appointments", "scheduler", "calendar"]);
    const APPOINTMENT_SEARCH_SQL: &str = r#"
        SELECT
            a.id,
            a.customer_display_name,
            a.appointment_type,
            a.status,
            a.starts_at,
            a.salesperson,
            wp.party_name
        FROM wedding_appointments a
        LEFT JOIN wedding_parties wp ON wp.id = a.wedding_party_id
        WHERE ($1::uuid[] IS NULL OR a.id = ANY($1))
          AND (
            $1::uuid[] IS NOT NULL
            OR $4
            OR COALESCE(a.customer_display_name, '') ILIKE $2
            OR COALESCE(a.phone, '') ILIKE $2
            OR ($5::text IS NOT NULL AND regexp_replace(COALESCE(a.phone, ''), '[^0-9]', '', 'g') LIKE $5)
            OR COALESCE(a.appointment_type, '') ILIKE $2
            OR COALESCE(a.notes, '') ILIKE $2
            OR COALESCE(a.salesperson, '') ILIKE $2
            OR COALESCE(wp.party_name, '') ILIKE $2
          )
        ORDER BY
          CASE WHEN a.starts_at >= now() THEN 0 ELSE 1 END,
          a.starts_at ASC,
          a.id ASC
        LIMIT $3
        "#;
    let mut rows = sqlx::query(APPOINTMENT_SEARCH_SQL)
        .bind(meili_ids.as_deref())
        .bind(&like)
        .bind(limit as i64)
        .bind(broad)
        .bind(phone_like.as_deref())
        .fetch_all(pool)
        .await?;

    if let Some(ids) = meili_ids.as_ref() {
        if !hydrated_candidate_page_is_complete(
            ids,
            rows.iter().map(|row| row.get::<Uuid, _>("id")),
            limit,
        ) {
            tracing::warn!(
                query = q,
                "universal appointment Meilisearch page did not hydrate completely; using PostgreSQL"
            );
            rows = sqlx::query(APPOINTMENT_SEARCH_SQL)
                .bind(Option::<&[Uuid]>::None)
                .bind(&like)
                .bind(limit as i64)
                .bind(broad)
                .bind(phone_like.as_deref())
                .fetch_all(pool)
                .await?;
        }
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let starts_at = row.get::<Option<DateTime<Utc>>, _>("starts_at");
            let title = row
                .get::<Option<String>, _>("customer_display_name")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "Appointment".to_string());
            let appointment_type = row
                .get::<Option<String>, _>("appointment_type")
                .unwrap_or_else(|| "appointment".to_string());
            let status = row
                .get::<Option<String>, _>("status")
                .unwrap_or_else(|| "scheduled".to_string());
            let party = row
                .get::<Option<String>, _>("party_name")
                .unwrap_or_default();
            let subtitle = [appointment_type, status, party]
                .into_iter()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            op_hit(
                id.to_string(),
                "Scheduler",
                title,
                subtitle,
                ("appointments", Some("scheduler")),
                None,
                starts_at,
            )
        })
        .collect())
}

async fn search_tasks(
    pool: &PgPool,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let mut meili_ids = if let Some(client) = meilisearch {
        match crate::logic::meilisearch_search::task_search_ids(client, q).await {
            Ok(ids) => {
                match validated_meili_candidate_ids(
                    pool,
                    client,
                    crate::logic::meilisearch_client::INDEX_TASKS,
                    q,
                    ids,
                )
                .await
                {
                    Some(ids) if ids.is_empty() => return Ok(Vec::new()),
                    ids => ids,
                }
            }
            Err(error) => {
                tracing::warn!(%error, "universal task Meilisearch failed; using SQL");
                None
            }
        }
    } else {
        None
    };
    if let Some(ids) = meili_ids.as_ref() {
        let hydrates = ids_hydrate_completely(pool, "task_instance", ids).await?;
        if !hydrates {
            tracing::warn!(
                query = q,
                "universal task Meilisearch hits did not hydrate; using PostgreSQL"
            );
            meili_ids = None;
        }
    }
    let like = like_query(q);
    let broad = has_domain_word(q, &["task", "tasks", "todo", "todos"]);
    const TASK_SEARCH_SQL: &str = r#"
        SELECT
            ti.id,
            ti.title_snapshot,
            ti.status::text AS status,
            ti.due_date,
            s.full_name AS assignee_name,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name
        FROM task_instance ti
        LEFT JOIN staff s ON s.id = ti.assignee_staff_id
        LEFT JOIN customers c ON c.id = ti.customer_id
        WHERE ($1::uuid[] IS NULL OR ti.id = ANY($1))
          AND (
            $1::uuid[] IS NOT NULL
            OR $4
            OR COALESCE(ti.title_snapshot, '') ILIKE $2
            OR COALESCE(ti.period_key, '') ILIKE $2
            OR COALESCE(s.full_name, '') ILIKE $2
            OR COALESCE(c.first_name, '') ILIKE $2
            OR COALESCE(c.last_name, '') ILIKE $2
          )
        ORDER BY ti.due_date ASC NULLS LAST, ti.materialized_at DESC, ti.id ASC
        LIMIT $3
        "#;
    let mut rows = sqlx::query(TASK_SEARCH_SQL)
        .bind(meili_ids.as_deref())
        .bind(&like)
        .bind(limit as i64)
        .bind(broad)
        .fetch_all(pool)
        .await?;

    if let Some(ids) = meili_ids.as_ref() {
        if !hydrated_candidate_page_is_complete(
            ids,
            rows.iter().map(|row| row.get::<Uuid, _>("id")),
            limit,
        ) {
            tracing::warn!(
                query = q,
                "universal task Meilisearch page did not hydrate completely; using PostgreSQL"
            );
            rows = sqlx::query(TASK_SEARCH_SQL)
                .bind(Option::<&[Uuid]>::None)
                .bind(&like)
                .bind(limit as i64)
                .bind(broad)
                .fetch_all(pool)
                .await?;
        }
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let title = row
                .get::<Option<String>, _>("title_snapshot")
                .unwrap_or_else(|| "Task".to_string());
            let status = row
                .get::<Option<String>, _>("status")
                .unwrap_or_else(|| "open".to_string());
            let assignee = row.get::<Option<String>, _>("assignee_name");
            let customer = [
                row.get::<Option<String>, _>("customer_first_name"),
                row.get::<Option<String>, _>("customer_last_name"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            let subtitle = [Some(status), assignee, Some(customer)]
                .into_iter()
                .flatten()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            op_hit(
                id.to_string(),
                "Tasks",
                title,
                subtitle,
                ("tasks", None),
                None,
                None,
            )
        })
        .collect())
}

async fn search_qbo_logs(
    pool: &PgPool,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let like = like_query(q);
    let rows = sqlx::query(
        r#"
        SELECT id, sync_date, journal_entry_id, status, error_message, updated_at
        FROM qbo_sync_logs
        WHERE COALESCE(journal_entry_id, '') ILIKE $1
           OR COALESCE(status, '') ILIKE $1
           OR COALESCE(error_message, '') ILIKE $1
           OR sync_date::text ILIKE $1
        ORDER BY updated_at DESC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let status = row.get::<String, _>("status");
            let sync_date = row.get::<NaiveDate, _>("sync_date");
            let journal = row.get::<Option<String>, _>("journal_entry_id");
            let error = row.get::<Option<String>, _>("error_message");
            op_hit(
                id.to_string(),
                "QBO",
                format!("QBO {status} journal"),
                [Some(sync_date.to_string()), journal, error]
                    .into_iter()
                    .flatten()
                    .filter(|part| !part.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" · "),
                ("qbo", Some("history")),
                None,
                row.get::<Option<DateTime<Utc>>, _>("updated_at"),
            )
        })
        .collect())
}

async fn search_receiving_events(
    pool: &PgPool,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let like = like_query(q);
    let broad = has_domain_word(q, &["receiving", "receive", "received", "receipt"]);
    let rows = sqlx::query(
        r#"
        SELECT
            re.id,
            re.received_at,
            re.invoice_number,
            re.notes,
            po.po_number
        FROM receiving_events re
        LEFT JOIN purchase_orders po ON po.id = re.purchase_order_id
        WHERE $3
           OR COALESCE(re.invoice_number, '') ILIKE $1
           OR COALESCE(re.notes, '') ILIKE $1
           OR COALESCE(po.po_number, '') ILIKE $1
        ORDER BY re.received_at DESC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .bind(broad)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let po = row.get::<Option<String>, _>("po_number");
            let invoice = row.get::<Option<String>, _>("invoice_number");
            op_hit(
                id.to_string(),
                "Receiving",
                po.clone().unwrap_or_else(|| "Receiving Event".to_string()),
                [invoice, row.get::<Option<String>, _>("notes")]
                    .into_iter()
                    .flatten()
                    .filter(|part| !part.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" · "),
                ("inventory", Some("receiving")),
                None,
                row.get::<Option<DateTime<Utc>>, _>("received_at"),
            )
        })
        .collect())
}

async fn search_physical_inventory_sessions(
    pool: &PgPool,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let like = like_query(q);
    let broad = has_domain_word(
        q,
        &["inventory", "count", "counts", "reconcile", "mismatch"],
    );
    let rows = sqlx::query(
        r#"
        SELECT id, session_number, status, scope, notes, last_saved_at
        FROM physical_inventory_sessions
        WHERE $3
           OR COALESCE(session_number, '') ILIKE $1
           OR COALESCE(status, '') ILIKE $1
           OR COALESCE(scope, '') ILIKE $1
           OR COALESCE(notes, '') ILIKE $1
        ORDER BY last_saved_at DESC NULLS LAST, started_at DESC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .bind(broad)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let session_number = row
                .get::<Option<String>, _>("session_number")
                .unwrap_or_else(|| "Inventory Count".to_string());
            let status = row.get::<Option<String>, _>("status").unwrap_or_default();
            let scope = row.get::<Option<String>, _>("scope").unwrap_or_default();
            op_hit(
                id.to_string(),
                "Physical Inventory",
                session_number,
                [
                    status,
                    scope,
                    row.get::<Option<String>, _>("notes").unwrap_or_default(),
                ]
                .into_iter()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
                ("inventory", Some("physical")),
                None,
                row.get::<Option<DateTime<Utc>>, _>("last_saved_at"),
            )
        })
        .collect())
}

async fn search_gift_cards(
    pool: &PgPool,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let like = like_query(q);
    let rows = sqlx::query(
        r#"
        SELECT
            gc.id,
            gc.code,
            gc.current_balance::text AS current_balance,
            gc.card_status::text AS card_status,
            gc.notes,
            gc.created_at,
            c.first_name,
            c.last_name
        FROM gift_cards gc
        LEFT JOIN customers c ON c.id = gc.customer_id
        WHERE COALESCE(gc.code, '') ILIKE $1
           OR COALESCE(gc.notes, '') ILIKE $1
           OR COALESCE(c.first_name, '') ILIKE $1
           OR COALESCE(c.last_name, '') ILIKE $1
        ORDER BY gc.created_at DESC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let code = row.get::<String, _>("code");
            let customer = [
                row.get::<Option<String>, _>("first_name"),
                row.get::<Option<String>, _>("last_name"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            op_hit(
                id.to_string(),
                "Gift Cards",
                format!("Gift Card {code}"),
                [
                    Some(format!(
                        "Balance ${}",
                        row.get::<String, _>("current_balance")
                    )),
                    row.get::<Option<String>, _>("card_status"),
                    Some(customer),
                ]
                .into_iter()
                .flatten()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
                ("gift-cards", Some("inventory")),
                None,
                row.get::<Option<DateTime<Utc>>, _>("created_at"),
            )
        })
        .collect())
}

async fn search_loyalty(
    pool: &PgPool,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let like = like_query(q);
    let rows = sqlx::query(
        r#"
        SELECT
            l.id,
            l.delta_points,
            l.balance_after,
            l.reason,
            l.transaction_id,
            l.created_at,
            c.first_name,
            c.last_name
        FROM loyalty_point_ledger l
        LEFT JOIN customers c ON c.id = l.customer_id
        WHERE COALESCE(l.reason, '') ILIKE $1
           OR COALESCE(c.first_name, '') ILIKE $1
           OR COALESCE(c.last_name, '') ILIKE $1
           OR l.transaction_id::text ILIKE $1
        ORDER BY l.created_at DESC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let customer = [
                row.get::<Option<String>, _>("first_name"),
                row.get::<Option<String>, _>("last_name"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            let delta = row.get::<i32, _>("delta_points");
            let balance = row.get::<i32, _>("balance_after");
            op_hit(
                id.to_string(),
                "Loyalty",
                if customer.trim().is_empty() {
                    "Loyalty Points".to_string()
                } else {
                    customer
                },
                [
                    Some(format!("{delta:+} pts")),
                    Some(format!("Balance {balance}")),
                    row.get::<Option<String>, _>("reason"),
                ]
                .into_iter()
                .flatten()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
                ("loyalty", Some("history")),
                row.get::<Option<Uuid>, _>("transaction_id"),
                row.get::<Option<DateTime<Utc>>, _>("created_at"),
            )
        })
        .collect())
}

async fn search_notifications(
    pool: &PgPool,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let like = like_query(q);
    let rows = sqlx::query(
        r#"
        SELECT id, kind, title, body, source, created_at
        FROM app_notification
        WHERE COALESCE(title, '') ILIKE $1
           OR COALESCE(body, '') ILIKE $1
           OR COALESCE(kind, '') ILIKE $1
           OR COALESCE(source, '') ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let kind = row.get::<String, _>("kind");
            let title = row.get::<String, _>("title");
            op_hit(
                id.to_string(),
                "Notifications",
                title,
                [Some(kind), row.get::<Option<String>, _>("body")]
                    .into_iter()
                    .flatten()
                    .filter(|part| !part.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" · "),
                ("podium-inbox", None),
                None,
                row.get::<Option<DateTime<Utc>>, _>("created_at"),
            )
        })
        .collect())
}

async fn search_payments(
    pool: &PgPool,
    q: &str,
    limit: usize,
) -> Result<Vec<UniversalOperationalHit>, sqlx::Error> {
    let like = like_query(q);
    let rows = sqlx::query(
        r#"
        SELECT
            pt.id,
            pt.payment_method,
            pt.amount::text AS amount,
            pt.status,
            pt.provider_payment_id,
            pt.provider_transaction_id,
            pt.check_number,
            pt.card_last4,
            pt.occurred_at,
            (
                SELECT pa.target_transaction_id
                FROM payment_allocations pa
                WHERE pa.transaction_id = pt.id
                LIMIT 1
            ) AS target_transaction_id
        FROM payment_transactions pt
        WHERE COALESCE(pt.payment_method, '') ILIKE $1
           OR COALESCE(pt.status, '') ILIKE $1
           OR COALESCE(pt.provider_payment_id, '') ILIKE $1
           OR COALESCE(pt.provider_transaction_id, '') ILIKE $1
           OR COALESCE(pt.check_number, '') ILIKE $1
           OR COALESCE(pt.card_last4, '') ILIKE $1
           OR pt.id::text ILIKE $1
        ORDER BY pt.occurred_at DESC NULLS LAST, pt.created_at DESC
        LIMIT $2
        "#,
    )
    .bind(like)
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let method = row.get::<String, _>("payment_method");
            let status = row.get::<Option<String>, _>("status").unwrap_or_default();
            op_hit(
                id.to_string(),
                "Payments",
                format!("{method} payment"),
                [
                    Some(format!("${}", row.get::<String, _>("amount"))),
                    Some(status),
                    row.get::<Option<String>, _>("provider_payment_id"),
                    row.get::<Option<String>, _>("check_number"),
                ]
                .into_iter()
                .flatten()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
                ("orders", Some("all")),
                row.get::<Option<Uuid>, _>("target_transaction_id"),
                row.get::<Option<DateTime<Utc>>, _>("occurred_at"),
            )
        })
        .collect())
}

fn shortcut_ids(q: &str, perms: &HashSet<String>) -> Vec<UniversalShortcutHit> {
    let normalized = q
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>();
    let words = normalized.split_whitespace().collect::<HashSet<_>>();
    let mut out: Vec<&'static str> = Vec::new();
    let mut add = |id: &'static str, allowed: bool| {
        if allowed && !out.contains(&id) {
            out.push(id);
        }
    };

    let orders = has_permission(perms, ORDERS_VIEW);
    let inventory = has_permission(perms, CATALOG_VIEW);
    add(
        "transaction_records",
        orders
            && (words.contains("transaction")
                || words.contains("transactions")
                || normalized.contains("sales history")),
    );
    add(
        "open_orders",
        orders
            && (words.contains("order")
                || words.contains("orders")
                || normalized.contains("open order")),
    );
    add(
        "help_center",
        words.contains("help")
            || words.contains("manual")
            || words.contains("procedure")
            || words.contains("recovery"),
    );
    add(
        "rosie",
        words.contains("rosie") || words.contains("ai") || words.contains("assistant"),
    );
    add(
        "qbo_failed",
        has_permission(perms, QBO_VIEW)
            && (words.contains("qbo")
                || words.contains("quickbooks")
                || words.contains("journal")
                || normalized.contains("failed sync")),
    );
    add(
        "receiving",
        inventory
            && (words.contains("receiving")
                || words.contains("receive")
                || words.contains("interrupted")),
    );
    add(
        "physical_inventory",
        has_permission(perms, PHYSICAL_INVENTORY_VIEW)
            && ((words.contains("inventory")
                && (words.contains("mismatch") || words.contains("count")))
                || words.contains("reconcile")
                || words.contains("reconciliation")),
    );
    add(
        "gift_cards",
        has_permission(perms, GIFT_CARDS_MANAGE)
            && (words.contains("gift") || normalized.contains("gift card")),
    );
    add(
        "loyalty",
        has_permission(perms, LOYALTY_PROGRAM_SETTINGS)
            && (words.contains("loyalty") || words.contains("reward") || words.contains("points")),
    );
    add(
        "appointments",
        has_permission(perms, WEDDINGS_VIEW)
            && (words.contains("appointment")
                || words.contains("appointments")
                || words.contains("scheduler")),
    );
    add(
        "reports",
        has_permission(perms, INSIGHTS_VIEW)
            && (words.contains("report")
                || words.contains("reports")
                || words.contains("metabase")),
    );
    add(
        "register_close",
        orders
            && (normalized.contains("register close")
                || normalized.contains("cash drawer")
                || (words.contains("close") && words.contains("register"))),
    );
    add(
        "podium_inbox",
        words.contains("podium")
            || words.contains("message")
            || words.contains("messages")
            || words.contains("review"),
    );
    add(
        "meilisearch_status",
        has_permission(perms, SETTINGS_ADMIN)
            && (words.contains("meilisearch") || normalized.contains("search index")),
    );

    out.into_iter()
        .take(8)
        .map(|intent| UniversalShortcutHit {
            intent: intent.to_string(),
        })
        .collect()
}

async fn universal_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<UniversalSearchQuery>,
) -> Result<Json<UniversalSearchResponse>, SearchError> {
    let q = query.q.trim().to_string();
    if q.len() < 2 {
        return Err(SearchError::BadRequest(
            "query must be at least 2 characters".to_string(),
        ));
    }
    if !has_searchable_term(&q) {
        return Err(SearchError::BadRequest(
            "query must include at least one letter or number".to_string(),
        ));
    }

    let staff = middleware::require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(map_auth_error)?;
    let perms = effective_permissions_for_staff(&state.db, staff.id, staff.role).await?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let customers_fut = async {
        if !has_permission(&perms, CUSTOMERS_HUB_VIEW) {
            return (Vec::new(), None);
        }
        match search_customers(&state.db, state.meilisearch.as_ref(), &q, limit).await {
            Ok(rows) => (rows, None),
            Err(error) => {
                tracing::warn!(%error, "universal customer source failed");
                (Vec::new(), Some("Customers".to_string()))
            }
        }
    };

    let product_fut = async {
        if !has_permission(&perms, CATALOG_VIEW) {
            return (None, Vec::new(), Vec::new());
        }
        let mut failed = Vec::new();
        let sku_hit = match search_exact_sku(&state.db, &q).await {
            Ok(hit) => hit,
            Err(error) => {
                tracing::warn!(%error, "universal exact SKU source failed");
                failed.push("Exact SKU".to_string());
                None
            }
        };
        let products =
            match search_products(&state.db, state.meilisearch.as_ref(), &q, limit * 6).await {
                Ok(rows) => rows,
                Err(error) => {
                    tracing::warn!(%error, "universal inventory source failed");
                    failed.push("Inventory".to_string());
                    Vec::new()
                }
            };
        (sku_hit, products, failed)
    };

    let orders_fut = async {
        if !has_permission(&perms, ORDERS_VIEW) {
            return (Vec::new(), None);
        }
        match query_paged_transactions(
            &state.db,
            &TransactionListQuery {
                search: Some(q.clone()),
                show_closed: true,
                customer_id: None,
                register_session_id: None,
                date_from: None,
                date_to: None,
                payment_filter: None,
                kind_filter: None,
                salesperson_filter: None,
                lifecycle_filter: None,
                status_scope: None,
                record_scope: None,
                limit: Some(limit as i64),
                offset: Some(0),
            },
            state.meilisearch.as_ref(),
        )
        .await
        {
            Ok(page) => (page.items, None),
            Err(error) => {
                tracing::warn!(%error, "universal transaction source failed");
                (Vec::new(), Some("Transaction Records".to_string()))
            }
        }
    };

    let shipments_fut = async {
        if !has_permission(&perms, SHIPMENTS_VIEW) {
            return (Vec::new(), None);
        }
        match list_shipments(
            &state.db,
            &ShipmentListQuery {
                customer_id: None,
                status: None,
                source: None,
                search: Some(q.clone()),
                open_only: false,
                limit: Some(limit as i64),
                offset: Some(0),
            },
        )
        .await
        {
            Ok(rows) => (rows, None),
            Err(error) => {
                tracing::warn!(%error, "universal shipping source failed");
                (Vec::new(), Some("Shipping".to_string()))
            }
        }
    };

    let weddings_fut = async {
        if !has_permission(&perms, WEDDINGS_VIEW) {
            return (Vec::new(), None);
        }
        match query_party_list_page(
            &state.db,
            &PartyListQuery {
                page: Some(1),
                limit: Some(limit as i64),
                search: Some(q.clone()),
                start_date: None,
                end_date: None,
                salesperson: None,
                show_deleted: false,
            },
            state.meilisearch.as_ref(),
        )
        .await
        {
            Ok((rows, _, _, _)) => {
                let rows = rows
                    .into_iter()
                    .map(|row| UniversalWeddingHit {
                        id: row.id,
                        party_name: row
                            .party_name
                            .filter(|name| !name.trim().is_empty())
                            .unwrap_or_else(|| row.groom_name.clone()),
                        groom_name: Some(row.groom_name),
                        event_date: Some(row.event_date.to_string()),
                    })
                    .collect::<Vec<_>>();
                (rows, None)
            }
            Err(error) => {
                tracing::warn!(%error, "universal wedding source failed");
                (Vec::new(), Some("Weddings".to_string()))
            }
        }
    };

    let alterations_fut = async {
        if !has_permission(&perms, ALTERATIONS_MANAGE) {
            return (Vec::new(), None);
        }
        match search_alterations(&state.db, state.meilisearch.as_ref(), &q, limit).await {
            Ok(rows) => (rows, None),
            Err(error) => {
                tracing::warn!(%error, "universal alterations source failed");
                (Vec::new(), Some("Alterations".to_string()))
            }
        }
    };

    let help_fut = async {
        match search_help(&state, &q, limit.min(6), &perms).await {
            Ok(rows) => (rows, None),
            Err(error) => {
                tracing::warn!(%error, "universal help source failed");
                (Vec::new(), Some("Help Center".to_string()))
            }
        }
    };

    let operational_fut = async {
        let mut hits = Vec::new();
        let mut failed = Vec::new();
        let qbo_intent = has_domain_word(&q, &["qbo", "quickbooks", "journal", "sync"]);
        let receiving_intent = has_domain_word(
            &q,
            &[
                "receiving",
                "receive",
                "received",
                "invoice",
                "purchase",
                "po",
            ],
        ) || q.to_ascii_lowercase().starts_with("po-");
        let physical_inventory_intent = has_domain_word(
            &q,
            &[
                "physical",
                "inventory",
                "count",
                "counts",
                "reconcile",
                "mismatch",
            ],
        );
        let gift_card_intent = has_domain_word(&q, &["gift", "card", "cards"]);
        let loyalty_intent = has_domain_word(&q, &["loyalty", "points", "reward", "rewards"]);
        let notification_intent = has_domain_word(
            &q,
            &[
                "notification",
                "notifications",
                "podium",
                "message",
                "messages",
            ],
        );
        let payment_intent = has_domain_word(
            &q,
            &[
                "payment", "payments", "helcim", "check", "card", "tender", "refund",
            ],
        );

        let (
            appointments,
            tasks,
            qbo,
            receiving,
            physical_inventory,
            gift_cards,
            loyalty,
            notifications,
            payments,
        ) = tokio::join!(
            async {
                if has_permission(&perms, WEDDINGS_VIEW) {
                    Some(
                        within_source_deadline(search_appointments(
                            &state.db,
                            state.meilisearch.as_ref(),
                            &q,
                            limit.min(4),
                        ))
                        .await,
                    )
                } else {
                    None
                }
            },
            async {
                if has_permission(&perms, TASKS_VIEW_TEAM) {
                    Some(
                        within_source_deadline(search_tasks(
                            &state.db,
                            state.meilisearch.as_ref(),
                            &q,
                            limit.min(4),
                        ))
                        .await,
                    )
                } else {
                    None
                }
            },
            async {
                if has_permission(&perms, QBO_VIEW) && qbo_intent {
                    Some(within_source_deadline(search_qbo_logs(&state.db, &q, limit.min(4))).await)
                } else {
                    None
                }
            },
            async {
                if has_permission(&perms, PROCUREMENT_VIEW) && receiving_intent {
                    Some(
                        within_source_deadline(search_receiving_events(
                            &state.db,
                            &q,
                            limit.min(4),
                        ))
                        .await,
                    )
                } else {
                    None
                }
            },
            async {
                if has_permission(&perms, PHYSICAL_INVENTORY_VIEW) && physical_inventory_intent {
                    Some(
                        within_source_deadline(search_physical_inventory_sessions(
                            &state.db,
                            &q,
                            limit.min(4),
                        ))
                        .await,
                    )
                } else {
                    None
                }
            },
            async {
                if has_permission(&perms, GIFT_CARDS_MANAGE) && gift_card_intent {
                    Some(
                        within_source_deadline(search_gift_cards(&state.db, &q, limit.min(4)))
                            .await,
                    )
                } else {
                    None
                }
            },
            async {
                if has_permission(&perms, LOYALTY_PROGRAM_SETTINGS) && loyalty_intent {
                    Some(within_source_deadline(search_loyalty(&state.db, &q, limit.min(4))).await)
                } else {
                    None
                }
            },
            async {
                if has_permission(&perms, NOTIFICATIONS_VIEW) && notification_intent {
                    Some(
                        within_source_deadline(search_notifications(&state.db, &q, limit.min(4)))
                            .await,
                    )
                } else {
                    None
                }
            },
            async {
                if payment_intent
                    && (has_permission(&perms, PAYMENTS_VIEW)
                        || has_permission(&perms, REGISTER_REPORTS))
                {
                    Some(within_source_deadline(search_payments(&state.db, &q, limit.min(4))).await)
                } else {
                    None
                }
            },
        );

        macro_rules! collect_source {
            ($result:expr, $label:literal, $message:literal) => {
                if let Some(result) = $result {
                    match result {
                        Some(Ok(rows)) => hits.extend(rows),
                        Some(Err(error)) => {
                            tracing::warn!(%error, $message);
                            failed.push($label.to_string());
                        }
                        None => failed.push(format!("{} (timed out)", $label)),
                    }
                }
            };
        }

        collect_source!(
            appointments,
            "Appointments",
            "universal appointment source failed"
        );
        collect_source!(tasks, "Tasks", "universal task source failed");
        collect_source!(qbo, "QBO", "universal QBO source failed");
        collect_source!(receiving, "Receiving", "universal receiving source failed");
        collect_source!(
            physical_inventory,
            "Physical Inventory",
            "universal physical inventory source failed"
        );
        collect_source!(
            gift_cards,
            "Gift Cards",
            "universal gift card source failed"
        );
        collect_source!(loyalty, "Loyalty", "universal loyalty source failed");
        collect_source!(
            notifications,
            "Notifications",
            "universal notification source failed"
        );
        collect_source!(payments, "Payments", "universal payment source failed");

        hits.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at));
        hits.truncate(limit);
        (hits, failed)
    };

    let (
        customers_result,
        products_result,
        orders_result,
        shipments_result,
        weddings_result,
        alterations_result,
        help_result,
        operational_result,
    ) = tokio::join!(
        within_source_deadline(customers_fut),
        within_source_deadline(product_fut),
        within_source_deadline(orders_fut),
        within_source_deadline(shipments_fut),
        within_source_deadline(weddings_fut),
        within_source_deadline(alterations_fut),
        within_source_deadline(help_fut),
        operational_fut
    );

    let (customers, customers_failed) =
        customers_result.unwrap_or_else(|| (Vec::new(), Some("Customers (timed out)".to_string())));
    let (sku_hit, products, product_failures) = products_result
        .unwrap_or_else(|| (None, Vec::new(), vec!["Inventory (timed out)".to_string()]));
    let (orders, orders_failed) = orders_result.unwrap_or_else(|| {
        (
            Vec::new(),
            Some("Transaction Records (timed out)".to_string()),
        )
    });
    let (shipments, shipments_failed) =
        shipments_result.unwrap_or_else(|| (Vec::new(), Some("Shipping (timed out)".to_string())));
    let (weddings, weddings_failed) =
        weddings_result.unwrap_or_else(|| (Vec::new(), Some("Weddings (timed out)".to_string())));
    let (alterations, alterations_failed) = alterations_result
        .unwrap_or_else(|| (Vec::new(), Some("Alterations (timed out)".to_string())));
    let (help_hits, help_failed) =
        help_result.unwrap_or_else(|| (Vec::new(), Some("Help Center (timed out)".to_string())));
    let (operational_hits, operational_failures) = operational_result;

    let mut sources_failed = Vec::<String>::new();
    sources_failed.extend(customers_failed);
    sources_failed.extend(product_failures);
    sources_failed.extend(orders_failed);
    sources_failed.extend(shipments_failed);
    sources_failed.extend(weddings_failed);
    sources_failed.extend(alterations_failed);
    sources_failed.extend(help_failed);
    sources_failed.extend(operational_failures);

    let shortcuts = shortcut_ids(&q, &perms);

    Ok(Json(UniversalSearchResponse {
        query: q,
        sources_failed,
        customers,
        sku_hit,
        products,
        orders,
        shipments,
        weddings,
        alterations,
        help_hits,
        operational_hits,
        shortcuts,
    }))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/universal", get(universal_search))
}

#[cfg(test)]
mod tests {
    use super::{
        has_domain_word, has_searchable_term, hydrated_candidate_page_is_complete, like_query,
    };
    use uuid::Uuid;

    #[test]
    fn punctuation_only_query_is_not_searchable() {
        assert!(!has_searchable_term("%_"));
        assert!(!has_searchable_term("-- /"));
        assert!(has_searchable_term("TXN-123"));
        assert!(has_searchable_term("Élodie"));
    }

    #[test]
    fn sql_fallback_treats_wildcards_as_literal_text() {
        assert_eq!(like_query(r"A%_B\C"), r"%A\%\_B\\C%");
    }

    #[test]
    fn operational_intent_requires_a_complete_domain_word() {
        assert!(has_domain_word("failed QBO sync", &["qbo", "sync"]));
        assert!(!has_domain_word("synchrony customer", &["sync"]));
    }

    #[test]
    fn meili_candidate_page_requires_unique_complete_hydration() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let third = Uuid::new_v4();
        let candidates = [first, second, third];

        assert!(hydrated_candidate_page_is_complete(
            &candidates,
            [first, second],
            2
        ));
        assert!(!hydrated_candidate_page_is_complete(
            &candidates,
            [first],
            2
        ));
        assert!(!hydrated_candidate_page_is_complete(
            &candidates,
            [first, first],
            2
        ));
        assert!(!hydrated_candidate_page_is_complete(
            &candidates,
            [first, Uuid::new_v4()],
            2
        ));
    }
}
