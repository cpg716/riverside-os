//! Meilisearch client bootstrap from environment.

use meilisearch_sdk::client::Client;
use meilisearch_sdk::errors::Error as MeiliError;
use meilisearch_sdk::task_info::TaskInfo;
use meilisearch_sdk::tasks::Task;
use std::time::Duration;

/// Variant-level inventory / control-board index.
pub const INDEX_VARIANTS: &str = "ros_variants";
/// Product-level public storefront catalog (no raw SKUs in dedicated fields).
pub const INDEX_STORE_PRODUCTS: &str = "ros_store_products";
pub const INDEX_CUSTOMERS: &str = "ros_customers";
pub const INDEX_WEDDING_PARTIES: &str = "ros_wedding_parties";
pub const INDEX_ORDERS: &str = "ros_orders";
/// In-app help manuals (markdown chunks).
pub const INDEX_HELP: &str = "ros_help";
pub const INDEX_STAFF: &str = "ros_staff";
pub const INDEX_VENDORS: &str = "ros_vendors";
pub const INDEX_CATEGORIES: &str = "ros_categories";
pub const INDEX_APPOINTMENTS: &str = "ros_appointments";
pub const INDEX_TASKS: &str = "ros_tasks";

/// When `RIVERSIDE_MEILISEARCH_URL` is empty or client creation fails, search stays on PostgreSQL.
pub fn meilisearch_from_env() -> Option<Client> {
    let url = std::env::var("RIVERSIDE_MEILISEARCH_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let key = std::env::var("RIVERSIDE_MEILISEARCH_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match Client::new(url.trim_end_matches('/'), key.as_deref()) {
        Ok(c) => {
            tracing::info!(
                index_variant = INDEX_VARIANTS,
                "Meilisearch client configured"
            );
            Some(c)
        }
        Err(e) => {
            tracing::error!(error = %e, "Meilisearch client init failed; search will use PostgreSQL only");
            None
        }
    }
}

pub(crate) async fn wait_task_ok(client: &Client, t: TaskInfo) -> Result<(), MeiliError> {
    let done = t
        .wait_for_completion(
            client,
            Some(Duration::from_millis(100)),
            Some(Duration::from_secs(120)),
        )
        .await?;
    if let Task::Failed { content } = done {
        tracing::error!(error = %content.error, "Meilisearch task failed");
        return Err(MeiliError::Meilisearch(content.error));
    }
    Ok(())
}

/// Apply index settings and wait for tasks (used by reindex / admin).
pub async fn ensure_variant_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_VARIANTS);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index
            .set_filterable_attributes([
                "product_id",
                "category_id",
                "primary_vendor_id",
                "web_published",
                "is_clothing_footwear",
            ])
            .await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_store_products_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_STORE_PRODUCTS);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["catalog_ok"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_customers_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_CUSTOMERS);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_wedding_parties_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_WEDDING_PARTIES);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["is_deleted"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_orders_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_ORDERS);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["status_open"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_help_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_HELP);
    wait_task_ok(
        client,
        index
            .set_searchable_attributes(["manual_title", "section_heading", "body"])
            .await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["manual_id"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_staff_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_STAFF);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index
            .set_filterable_attributes(["is_active", "role"])
            .await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_vendors_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_VENDORS);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["is_active"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_categories_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_CATEGORIES);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_appointments_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_APPOINTMENTS);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["is_cancelled"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_tasks_index_settings(client: &Client) -> Result<(), MeiliError> {
    let index = client.index(INDEX_TASKS);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index
            .set_filterable_attributes(["status", "assignee_id"])
            .await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_all_meilisearch_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_variant_index_settings(client).await?;
    ensure_store_products_index_settings(client).await?;
    ensure_customers_index_settings(client).await?;
    ensure_wedding_parties_index_settings(client).await?;
    ensure_orders_index_settings(client).await?;
    ensure_help_index_settings(client).await?;
    ensure_staff_index_settings(client).await?;
    ensure_vendors_index_settings(client).await?;
    ensure_categories_index_settings(client).await?;
    ensure_appointments_index_settings(client).await?;
    ensure_tasks_index_settings(client).await?;
    Ok(())
}
