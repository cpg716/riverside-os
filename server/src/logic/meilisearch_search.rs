//! Meilisearch query helpers — return ordered UUID primary keys for hybrid SQL hydration.

use meilisearch_sdk::client::Client;
use meilisearch_sdk::search::Selectors;
use serde::Deserialize;
use sqlx::PgPool;
use std::collections::HashSet;
use std::time::Duration;
use uuid::Uuid;

use crate::logic::meilisearch_client::{
    INDEX_ALTERATIONS, INDEX_APPOINTMENTS, INDEX_CUSTOMERS, INDEX_HELP, INDEX_ORDERS, INDEX_STAFF,
    INDEX_STORE_PRODUCTS, INDEX_TASKS, INDEX_TRANSACTIONS, INDEX_VARIANTS, INDEX_VENDORS,
    INDEX_WEDDING_PARTIES,
};

const CONTROL_BOARD_MEILI_HIT_CAP: usize = 5_000;
const STORE_PRODUCT_MEILI_HIT_CAP: usize = 500;
const CUSTOMER_MEILI_HIT_CAP: usize = 1_000;
const WEDDING_MEILI_HIT_CAP: usize = 1_000;
const TRANSACTION_MEILI_HIT_CAP: usize = 2_000;
const HELP_MEILI_HIT_CAP: usize = 100;
const STAFF_MEILI_HIT_CAP: usize = 500;
const VENDOR_MEILI_HIT_CAP: usize = 500;
const TASK_MEILI_HIT_CAP: usize = 1_000;
const APPOINTMENT_MEILI_HIT_CAP: usize = 1_000;
const ALTERATION_MEILI_HIT_CAP: usize = 1_000;
const ID_ATTRIBUTES: &[&str] = &["id"];
pub const AUTHORITATIVE_INDEX_MAX_AGE_HOURS: i64 = 36;
const INDEX_STATS_TIMEOUT: Duration = Duration::from_millis(250);
const FUTURE_PROOF_CLOCK_SKEW_MINUTES: i64 = 5;

#[derive(Debug, Deserialize)]
struct IdHit {
    id: String,
}

#[derive(sqlx::FromRow)]
struct SearchHealthRow {
    index_success: bool,
    index_last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    indexed_row_count: i64,
    rebuild_success: bool,
    rebuild_last_success_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullReindexProofStatus {
    Fresh,
    Missing,
    Failed,
    Stale,
    InvalidFutureTimestamp,
}

#[derive(Debug, Clone)]
pub struct FullReindexProof {
    pub status: FullReindexProofStatus,
    pub last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_attempt_at: Option<chrono::DateTime<chrono::Utc>>,
    pub detail: String,
}

impl FullReindexProof {
    pub fn is_fresh(&self) -> bool {
        self.status == FullReindexProofStatus::Fresh
    }
}

#[derive(sqlx::FromRow)]
struct FullReindexProofRow {
    is_success: bool,
    last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    last_attempt_at: Option<chrono::DateTime<chrono::Utc>>,
    error_message: Option<String>,
    unhealthy_index_count: i64,
}

fn classify_full_reindex_proof(
    row: Option<FullReindexProofRow>,
    now: chrono::DateTime<chrono::Utc>,
) -> FullReindexProof {
    let Some(row) = row else {
        return FullReindexProof {
            status: FullReindexProofStatus::Missing,
            last_success_at: None,
            last_attempt_at: None,
            detail: "No successful full Meilisearch rebuild has been recorded.".to_string(),
        };
    };

    if !row.is_success {
        return FullReindexProof {
            status: FullReindexProofStatus::Failed,
            last_success_at: row.last_success_at,
            last_attempt_at: row.last_attempt_at,
            detail: row
                .error_message
                .as_deref()
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
                .map(|detail| format!("The latest full Meilisearch rebuild failed: {detail}"))
                .unwrap_or_else(|| "The latest full Meilisearch rebuild failed.".to_string()),
        };
    }

    if row.unhealthy_index_count > 0 {
        return FullReindexProof {
            status: FullReindexProofStatus::Failed,
            last_success_at: row.last_success_at,
            last_attempt_at: row.last_attempt_at,
            detail: format!(
                "{} Meilisearch index sync status row(s) still report an unresolved failure.",
                row.unhealthy_index_count
            ),
        };
    }

    let Some(last_success_at) = row.last_success_at else {
        return FullReindexProof {
            status: FullReindexProofStatus::Missing,
            last_success_at: None,
            last_attempt_at: row.last_attempt_at,
            detail: "Meilisearch is marked successful without a full-rebuild success timestamp."
                .to_string(),
        };
    };
    if last_success_at > now + chrono::Duration::minutes(FUTURE_PROOF_CLOCK_SKEW_MINUTES) {
        return FullReindexProof {
            status: FullReindexProofStatus::InvalidFutureTimestamp,
            last_success_at: Some(last_success_at),
            last_attempt_at: row.last_attempt_at,
            detail: "The recorded full-rebuild success timestamp is in the future and cannot prove search freshness."
                .to_string(),
        };
    }

    let cutoff = now - chrono::Duration::hours(AUTHORITATIVE_INDEX_MAX_AGE_HOURS);
    if last_success_at < cutoff {
        return FullReindexProof {
            status: FullReindexProofStatus::Stale,
            last_success_at: Some(last_success_at),
            last_attempt_at: row.last_attempt_at,
            detail: format!(
                "The last successful full Meilisearch rebuild is older than {AUTHORITATIVE_INDEX_MAX_AGE_HOURS} hours."
            ),
        };
    }

    FullReindexProof {
        status: FullReindexProofStatus::Fresh,
        last_success_at: Some(last_success_at),
        last_attempt_at: row.last_attempt_at,
        detail: format!(
            "A successful full Meilisearch rebuild is within the {AUTHORITATIVE_INDEX_MAX_AGE_HOURS}-hour freshness window."
        ),
    }
}

pub async fn full_reindex_proof(pool: &PgPool) -> Result<FullReindexProof, sqlx::Error> {
    let row = sqlx::query_as::<_, FullReindexProofRow>(
        r#"
        SELECT
            COALESCE(run.is_success, FALSE) AS is_success,
            run.last_success_at,
            run.last_attempt_at,
            run.error_message,
            COALESCE((
                SELECT COUNT(*)::bigint
                FROM meilisearch_sync_status AS index_status
                WHERE index_status.index_name <> 'ros_reindex_run'
                  AND NOT COALESCE(index_status.is_success, FALSE)
            ), 0)::bigint AS unhealthy_index_count
        FROM meilisearch_sync_status AS run
        WHERE run.index_name = 'ros_reindex_run'
        "#,
    )
    .fetch_optional(pool)
    .await?;
    Ok(classify_full_reindex_proof(row, chrono::Utc::now()))
}

struct ControlBoardMeiliFilters<'a> {
    category_id: Option<Uuid>,
    vendor_id: Option<Uuid>,
    brand: Option<&'a str>,
    web_published_only: bool,
    clothing_only: bool,
    filter_flag: Option<&'a str>,
    oos_only: Option<bool>,
    negative_stock_only: Option<bool>,
    include_hidden: bool,
}

fn parse_hit_ids(hits: &[meilisearch_sdk::search::SearchResult<IdHit>]) -> Vec<Uuid> {
    let mut out = Vec::with_capacity(hits.len());
    for h in hits {
        if let Ok(u) = Uuid::parse_str(&h.result.id) {
            out.push(u);
        }
    }
    out
}

/// Candidate IDs must be valid and unique before a Meilisearch response can constrain SQL.
/// Duplicate or malformed IDs make candidate/result parity unknowable, so callers must fall back.
pub fn candidate_ids_are_unique(ids: &[Uuid]) -> bool {
    !ids.is_empty()
        && ids.iter().all(|id| !id.is_nil())
        && ids.iter().copied().collect::<HashSet<_>>().len() == ids.len()
}

fn recorded_index_health_allows_authority(
    row: &SearchHealthRow,
    cutoff: chrono::DateTime<chrono::Utc>,
) -> bool {
    row.index_success
        && row.rebuild_success
        && row.index_last_success_at.is_some_and(|at| at >= cutoff)
        && row.rebuild_last_success_at.is_some_and(|at| at >= cutoff)
        && row.indexed_row_count >= 0
}

/// Candidate-ID searches are an optimization, not an authoritative result set, when the fixed
/// retrieval cap is reached. Callers that expose paging or totals must fall back to PostgreSQL in
/// that case so records beyond the cap cannot disappear from later pages.
pub fn candidate_ids_may_be_truncated(index_name: &str, candidate_count: usize) -> bool {
    let cap = match index_name {
        INDEX_VARIANTS => CONTROL_BOARD_MEILI_HIT_CAP,
        INDEX_STORE_PRODUCTS => STORE_PRODUCT_MEILI_HIT_CAP,
        INDEX_CUSTOMERS => CUSTOMER_MEILI_HIT_CAP,
        INDEX_WEDDING_PARTIES => WEDDING_MEILI_HIT_CAP,
        INDEX_TRANSACTIONS | INDEX_ORDERS => TRANSACTION_MEILI_HIT_CAP,
        INDEX_STAFF => STAFF_MEILI_HIT_CAP,
        INDEX_VENDORS => VENDOR_MEILI_HIT_CAP,
        INDEX_TASKS => TASK_MEILI_HIT_CAP,
        INDEX_APPOINTMENTS => APPOINTMENT_MEILI_HIT_CAP,
        INDEX_ALTERATIONS => ALTERATION_MEILI_HIT_CAP,
        _ => return false,
    };
    candidate_count >= cap
}

/// A Meilisearch response is authoritative only when the live index still matches the SQL
/// row-count snapshot from a recent successful full rebuild and no sticky incremental failure is
/// recorded. This gate applies to empty and nonempty candidate sets: otherwise PostgreSQL must be
/// queried so a stale, mis-bound, or partially rebuilt index cannot hide valid records.
pub async fn index_results_are_authoritative(
    pool: &PgPool,
    client: &Client,
    index_name: &str,
) -> bool {
    let row = sqlx::query_as::<_, SearchHealthRow>(
        r#"
        SELECT
            COALESCE(idx.is_success, false) AS index_success,
            idx.last_success_at AS index_last_success_at,
            COALESCE(idx.row_count, -1) AS indexed_row_count,
            COALESCE(run.is_success, false) AS rebuild_success,
            run.last_success_at AS rebuild_last_success_at
        FROM (SELECT 1) seed
        LEFT JOIN meilisearch_sync_status idx ON idx.index_name = $1
        LEFT JOIN meilisearch_sync_status run ON run.index_name = 'ros_reindex_run'
        "#,
    )
    .bind(index_name)
    .fetch_one(pool)
    .await;

    let Ok(row) = row else {
        return false;
    };
    let cutoff = chrono::Utc::now() - chrono::Duration::hours(AUTHORITATIVE_INDEX_MAX_AGE_HOURS);
    if !recorded_index_health_allows_authority(&row, cutoff) {
        return false;
    }

    let stats =
        tokio::time::timeout(INDEX_STATS_TIMEOUT, client.index(index_name).get_stats()).await;
    matches!(
        stats,
        Ok(Ok(stats))
            if !stats.is_indexing && stats.number_of_documents == row.indexed_row_count as usize
    )
}

/// Build Meilisearch filter for control-board flags we can express exactly.
fn control_board_meili_filter_parts(filters: &ControlBoardMeiliFilters<'_>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(cid) = filters.category_id {
        parts.push(format!("category_id = \"{cid}\""));
    }
    if let Some(vid) = filters.vendor_id {
        parts.push(format!("primary_vendor_id = \"{vid}\""));
    }
    if let Some(brand) = filters.brand.map(str::trim).filter(|s| !s.is_empty()) {
        let brand = brand.replace('\\', "\\\\").replace('"', "\\\"");
        parts.push(format!("brand = \"{brand}\""));
    }
    if filters.web_published_only {
        parts.push("web_published = true".to_string());
    }
    if filters.clothing_only || filters.filter_flag == Some("clothing") {
        parts.push("is_clothing_footwear = true".to_string());
    }
    if filters.oos_only == Some(true) {
        parts.push("stock_status = \"out_of_stock\"".to_string());
    }
    if filters.negative_stock_only == Some(true) {
        parts.push("stock_status = \"negative\"".to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" AND "))
    }
}

/// Returns variant IDs matching the text query and Meilisearch-expressible filters (cap applied server-side).
#[allow(clippy::too_many_arguments)]
pub async fn control_board_search_variant_ids(
    client: &Client,
    query_text: &str,
    category_id: Option<Uuid>,
    vendor_id: Option<Uuid>,
    brand: Option<&str>,
    web_published_only: bool,
    clothing_only: bool,
    filter_flag: Option<&str>,
    oos_only: Option<bool>,
    negative_stock_only: Option<bool>,
    include_hidden: bool,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_VARIANTS);
    let filter = control_board_meili_filter_parts(&ControlBoardMeiliFilters {
        category_id,
        vendor_id,
        brand,
        web_published_only,
        clothing_only,
        filter_flag,
        oos_only,
        negative_stock_only,
        include_hidden,
    });
    let mut sq = index.search();
    sq.with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(CONTROL_BOARD_MEILI_HIT_CAP);
    if let Some(ref f) = filter {
        sq.with_filter(f);
    }
    let res = sq.execute::<IdHit>().await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn store_product_search_ids(
    client: &Client,
    query_text: &str,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_STORE_PRODUCTS);
    let res = index
        .search()
        .with_query(query_text)
        .with_filter("catalog_ok = true")
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(STORE_PRODUCT_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn customer_search_ids(
    client: &Client,
    query_text: &str,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_CUSTOMERS);
    let res = index
        .search()
        .with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(CUSTOMER_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn wedding_party_search_ids(
    client: &Client,
    query_text: &str,
    show_deleted: bool,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_WEDDING_PARTIES);
    let filter = if show_deleted {
        "is_deleted = true".to_string()
    } else {
        "is_deleted = false".to_string()
    };
    let res = index
        .search()
        .with_query(query_text)
        .with_filter(&filter)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(WEDDING_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn transaction_search_ids(
    client: &Client,
    query_text: &str,
    open_only: bool,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_TRANSACTIONS);
    let mut sq = index.search();
    sq.with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(TRANSACTION_MEILI_HIT_CAP);
    if open_only {
        sq.with_filter("status_open = true");
    }
    let res = sq.execute::<IdHit>().await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn order_search_ids(
    client: &Client,
    query_text: &str,
    open_only: bool,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_ORDERS);
    let mut sq = index.search();
    sq.with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(TRANSACTION_MEILI_HIT_CAP);
    if open_only {
        sq.with_filter("status_open = true");
    }
    let res = sq.execute::<IdHit>().await?;
    Ok(parse_hit_ids(&res.hits))
}

#[derive(Debug, Deserialize, Clone)]
pub struct HelpSearchHit {
    pub id: String,
    pub manual_id: String,
    pub manual_title: String,
    pub section_slug: String,
    pub section_heading: String,
    pub body: String,
}

pub async fn help_search_hits(
    client: &Client,
    query_text: &str,
    limit: usize,
) -> Result<Vec<HelpSearchHit>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_HELP);
    let cap = limit.clamp(1, HELP_MEILI_HIT_CAP);
    let res = index
        .search()
        .with_query(query_text)
        .with_limit(cap)
        .execute::<HelpSearchHit>()
        .await?;
    Ok(res.hits.into_iter().map(|h| h.result).collect())
}

pub async fn staff_search_ids(
    client: &Client,
    query_text: &str,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_STAFF);
    let res = index
        .search()
        .with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(STAFF_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn vendor_search_ids(
    client: &Client,
    query_text: &str,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_VENDORS);
    let res = index
        .search()
        .with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(VENDOR_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn task_search_ids(
    client: &Client,
    query_text: &str,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_TASKS);
    let res = index
        .search()
        .with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(TASK_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn appointment_search_ids(
    client: &Client,
    query_text: &str,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_APPOINTMENTS);
    let res = index
        .search()
        .with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(APPOINTMENT_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn alteration_search_ids(
    client: &Client,
    query_text: &str,
    open_only: bool,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_ALTERATIONS);
    let mut sq = index.search();
    sq.with_query(query_text)
        .with_attributes_to_retrieve(Selectors::Some(ID_ATTRIBUTES))
        .with_limit(ALTERATION_MEILI_HIT_CAP);
    if open_only {
        sq.with_filter("status_open = true");
    }
    let res = sq.execute::<IdHit>().await?;
    Ok(parse_hit_ids(&res.hits))
}

#[cfg(test)]
mod tests {
    use super::{
        candidate_ids_are_unique, candidate_ids_may_be_truncated, classify_full_reindex_proof,
        recorded_index_health_allows_authority, FullReindexProofRow, FullReindexProofStatus,
        SearchHealthRow, CUSTOMER_MEILI_HIT_CAP,
    };
    use crate::logic::meilisearch_client::{INDEX_CUSTOMERS, INDEX_HELP};
    use chrono::{Duration, Utc};
    use uuid::Uuid;

    #[test]
    fn candidate_cap_is_not_authoritative_for_paging() {
        assert!(!candidate_ids_may_be_truncated(
            INDEX_CUSTOMERS,
            CUSTOMER_MEILI_HIT_CAP - 1
        ));
        assert!(candidate_ids_may_be_truncated(
            INDEX_CUSTOMERS,
            CUSTOMER_MEILI_HIT_CAP
        ));
        assert!(!candidate_ids_may_be_truncated(INDEX_HELP, 10_000));
    }

    #[test]
    fn candidate_ids_must_be_valid_and_unique() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        assert!(candidate_ids_are_unique(&[first, second]));
        assert!(!candidate_ids_are_unique(&[first, first]));
        assert!(!candidate_ids_are_unique(&[first, Uuid::nil()]));
        assert!(!candidate_ids_are_unique(&[]));
    }

    #[test]
    fn unresolved_incremental_failure_revokes_index_authority() {
        let now = Utc::now();
        let cutoff = now - Duration::hours(36);
        let mut health = SearchHealthRow {
            index_success: true,
            index_last_success_at: Some(now),
            indexed_row_count: 25,
            rebuild_success: true,
            rebuild_last_success_at: Some(now),
        };
        assert!(recorded_index_health_allows_authority(&health, cutoff));

        health.index_success = false;
        assert!(!recorded_index_health_allows_authority(&health, cutoff));
    }

    #[test]
    fn full_reindex_proof_requires_a_fresh_success() {
        let now = Utc::now();
        assert_eq!(
            classify_full_reindex_proof(None, now).status,
            FullReindexProofStatus::Missing
        );

        let stale = classify_full_reindex_proof(
            Some(FullReindexProofRow {
                is_success: true,
                last_success_at: Some(now - Duration::hours(37)),
                last_attempt_at: Some(now - Duration::hours(37)),
                error_message: None,
                unhealthy_index_count: 0,
            }),
            now,
        );
        assert_eq!(stale.status, FullReindexProofStatus::Stale);

        let failed = classify_full_reindex_proof(
            Some(FullReindexProofRow {
                is_success: false,
                last_success_at: Some(now - Duration::hours(1)),
                last_attempt_at: Some(now),
                error_message: Some("task failed".to_string()),
                unhealthy_index_count: 0,
            }),
            now,
        );
        assert_eq!(failed.status, FullReindexProofStatus::Failed);

        let unresolved_index_failure = classify_full_reindex_proof(
            Some(FullReindexProofRow {
                is_success: true,
                last_success_at: Some(now - Duration::hours(1)),
                last_attempt_at: Some(now - Duration::hours(1)),
                error_message: None,
                unhealthy_index_count: 1,
            }),
            now,
        );
        assert_eq!(
            unresolved_index_failure.status,
            FullReindexProofStatus::Failed
        );
        assert!(unresolved_index_failure
            .detail
            .contains("unresolved failure"));

        let fresh = classify_full_reindex_proof(
            Some(FullReindexProofRow {
                is_success: true,
                last_success_at: Some(now - Duration::hours(1)),
                last_attempt_at: Some(now - Duration::hours(1)),
                error_message: None,
                unhealthy_index_count: 0,
            }),
            now,
        );
        assert!(fresh.is_fresh());
    }
}
