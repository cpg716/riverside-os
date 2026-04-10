//! Meilisearch query helpers — return ordered UUID primary keys for hybrid SQL hydration.

use meilisearch_sdk::client::Client;
use serde::Deserialize;
use uuid::Uuid;

use crate::logic::meilisearch_client::{
    INDEX_CUSTOMERS, INDEX_HELP, INDEX_ORDERS, INDEX_STORE_PRODUCTS, INDEX_VARIANTS,
    INDEX_WEDDING_PARTIES, INDEX_STAFF, INDEX_TASKS, INDEX_VENDORS, INDEX_APPOINTMENTS,
};

const CONTROL_BOARD_MEILI_HIT_CAP: usize = 50_000;
const STORE_PRODUCT_MEILI_HIT_CAP: usize = 2_000;
const CUSTOMER_MEILI_HIT_CAP: usize = 5_000;
const WEDDING_MEILI_HIT_CAP: usize = 10_000;
const ORDER_MEILI_HIT_CAP: usize = 10_000;
const HELP_MEILI_HIT_CAP: usize = 40;
const STAFF_MEILI_HIT_CAP: usize = 1_000;
const VENDOR_MEILI_HIT_CAP: usize = 2_000;
const TASK_MEILI_HIT_CAP: usize = 20_000;
const APPOINTMENT_MEILI_HIT_CAP: usize = 10_000;

#[derive(Debug, Deserialize)]
struct IdHit {
    id: String,
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

/// Build Meilisearch filter for control-board flags we can express exactly.
pub fn control_board_meili_filter_parts(
    category_id: Option<Uuid>,
    vendor_id: Option<Uuid>,
    web_published_only: bool,
    clothing_only: bool,
    filter_flag: Option<&str>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(cid) = category_id {
        parts.push(format!("category_id = \"{cid}\""));
    }
    if let Some(vid) = vendor_id {
        parts.push(format!("primary_vendor_id = \"{vid}\""));
    }
    if web_published_only {
        parts.push("web_published = true".to_string());
    }
    if clothing_only || filter_flag == Some("clothing") {
        parts.push("is_clothing_footwear = true".to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" AND "))
    }
}

/// Returns variant IDs matching the text query and Meilisearch-expressible filters (cap applied server-side).
pub async fn control_board_search_variant_ids(
    client: &Client,
    query_text: &str,
    category_id: Option<Uuid>,
    vendor_id: Option<Uuid>,
    web_published_only: bool,
    clothing_only: bool,
    filter_flag: Option<&str>,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_VARIANTS);
    let filter = control_board_meili_filter_parts(
        category_id,
        vendor_id,
        web_published_only,
        clothing_only,
        filter_flag,
    );
    let mut sq = index.search();
    sq.with_query(query_text)
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
        .with_limit(WEDDING_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}

pub async fn order_search_ids(
    client: &Client,
    query_text: &str,
    open_only: bool,
) -> Result<Vec<Uuid>, meilisearch_sdk::errors::Error> {
    let index = client.index(INDEX_ORDERS);
    let mut sq = index.search();
    sq.with_query(query_text).with_limit(ORDER_MEILI_HIT_CAP);
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
        .with_limit(APPOINTMENT_MEILI_HIT_CAP)
        .execute::<IdHit>()
        .await?;
    Ok(parse_hit_ids(&res.hits))
}
