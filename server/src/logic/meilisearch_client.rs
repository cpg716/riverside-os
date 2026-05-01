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
pub const INDEX_TRANSACTIONS: &str = "ros_transactions";
/// In-app help manuals (markdown chunks).
pub const INDEX_HELP: &str = "ros_help";
pub const INDEX_STAFF: &str = "ros_staff";
pub const INDEX_VENDORS: &str = "ros_vendors";
pub const INDEX_CATEGORIES: &str = "ros_categories";
pub const INDEX_APPOINTMENTS: &str = "ros_appointments";
pub const INDEX_TASKS: &str = "ros_tasks";
pub const INDEX_ALTERATIONS: &str = "ros_alterations";

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

async fn ensure_variant_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
    wait_task_ok(
        client,
        index
            .set_searchable_attributes([
                "sku",
                "barcode",
                "vendor_upc",
                "product_name",
                "brand",
                "variation_label",
                "catalog_handle",
                "search_text",
            ])
            .await?,
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
                "is_active",
                "stock_status",
                "stock_on_hand",
                "available_stock",
                "brand",
            ])
            .await?,
    )
    .await?;
    wait_task_ok(
        client,
        index
            .set_sortable_attributes(["stock_on_hand", "available_stock"])
            .await?,
    )
    .await?;
    Ok(())
}

/// Apply index settings and wait for tasks (used by reindex / admin).
pub async fn ensure_variant_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_variant_index_settings_for_uid(client, INDEX_VARIANTS).await
}

async fn ensure_store_products_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
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

pub async fn ensure_store_products_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_store_products_index_settings_for_uid(client, INDEX_STORE_PRODUCTS).await
}

async fn ensure_customers_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
    wait_task_ok(
        client,
        index
            .set_searchable_attributes([
                "customer_code",
                "email",
                "phone_digits",
                "full_name",
                "first_name",
                "last_name",
                "company_name",
                "search_text",
            ])
            .await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_customers_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_customers_index_settings_for_uid(client, INDEX_CUSTOMERS).await
}

async fn ensure_wedding_parties_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
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

pub async fn ensure_wedding_parties_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_wedding_parties_index_settings_for_uid(client, INDEX_WEDDING_PARTIES).await
}

async fn ensure_transactions_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
    wait_task_ok(
        client,
        index
            .set_searchable_attributes([
                "display_id",
                "id",
                "customer_name",
                "party_name",
                "search_text",
            ])
            .await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["status_open"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_transactions_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_transactions_index_settings_for_uid(client, INDEX_TRANSACTIONS).await
}

async fn ensure_orders_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
    wait_task_ok(
        client,
        index
            .set_searchable_attributes([
                "display_id",
                "id",
                "customer_name",
                "party_name",
                "search_text",
            ])
            .await?,
    )
    .await?;
    wait_task_ok(
        client,
        index.set_filterable_attributes(["status_open"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_orders_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_orders_index_settings_for_uid(client, INDEX_ORDERS).await
}

async fn ensure_help_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
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

pub async fn ensure_help_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_help_index_settings_for_uid(client, INDEX_HELP).await
}

async fn ensure_staff_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
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

pub async fn ensure_staff_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_staff_index_settings_for_uid(client, INDEX_STAFF).await
}

async fn ensure_vendors_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
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

pub async fn ensure_vendors_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_vendors_index_settings_for_uid(client, INDEX_VENDORS).await
}

async fn ensure_categories_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_categories_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_categories_index_settings_for_uid(client, INDEX_CATEGORIES).await
}

async fn ensure_appointments_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
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

pub async fn ensure_appointments_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_appointments_index_settings_for_uid(client, INDEX_APPOINTMENTS).await
}

async fn ensure_tasks_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
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

pub async fn ensure_tasks_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_tasks_index_settings_for_uid(client, INDEX_TASKS).await
}

async fn ensure_alterations_index_settings_for_uid(
    client: &Client,
    index_uid: &str,
) -> Result<(), MeiliError> {
    let index = client.index(index_uid);
    wait_task_ok(
        client,
        index.set_searchable_attributes(["search_text"]).await?,
    )
    .await?;
    wait_task_ok(
        client,
        index
            .set_filterable_attributes(["customer_id", "status_open"])
            .await?,
    )
    .await?;
    Ok(())
}

pub async fn ensure_alterations_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_alterations_index_settings_for_uid(client, INDEX_ALTERATIONS).await
}

pub async fn ensure_index_settings_for_uid(
    client: &Client,
    settings_source_uid: &str,
    target_uid: &str,
) -> Result<(), MeiliError> {
    match settings_source_uid {
        INDEX_VARIANTS => ensure_variant_index_settings_for_uid(client, target_uid).await,
        INDEX_STORE_PRODUCTS => {
            ensure_store_products_index_settings_for_uid(client, target_uid).await
        }
        INDEX_CUSTOMERS => ensure_customers_index_settings_for_uid(client, target_uid).await,
        INDEX_WEDDING_PARTIES => {
            ensure_wedding_parties_index_settings_for_uid(client, target_uid).await
        }
        INDEX_ORDERS => ensure_orders_index_settings_for_uid(client, target_uid).await,
        INDEX_TRANSACTIONS => ensure_transactions_index_settings_for_uid(client, target_uid).await,
        INDEX_HELP => ensure_help_index_settings_for_uid(client, target_uid).await,
        INDEX_STAFF => ensure_staff_index_settings_for_uid(client, target_uid).await,
        INDEX_VENDORS => ensure_vendors_index_settings_for_uid(client, target_uid).await,
        INDEX_CATEGORIES => ensure_categories_index_settings_for_uid(client, target_uid).await,
        INDEX_APPOINTMENTS => ensure_appointments_index_settings_for_uid(client, target_uid).await,
        INDEX_TASKS => ensure_tasks_index_settings_for_uid(client, target_uid).await,
        INDEX_ALTERATIONS => ensure_alterations_index_settings_for_uid(client, target_uid).await,
        _ => Ok(()),
    }
}

pub async fn ensure_all_meilisearch_index_settings(client: &Client) -> Result<(), MeiliError> {
    ensure_variant_index_settings(client).await?;
    ensure_store_products_index_settings(client).await?;
    ensure_customers_index_settings(client).await?;
    ensure_wedding_parties_index_settings(client).await?;
    ensure_orders_index_settings(client).await?;
    ensure_transactions_index_settings(client).await?;
    ensure_help_index_settings(client).await?;
    ensure_staff_index_settings(client).await?;
    ensure_vendors_index_settings(client).await?;
    ensure_categories_index_settings(client).await?;
    ensure_appointments_index_settings(client).await?;
    ensure_tasks_index_settings(client).await?;
    ensure_alterations_index_settings(client).await?;
    Ok(())
}

/// Check if any tasks are currently processing or enqueued in Meilisearch.
pub async fn is_indexing(client: &Client) -> bool {
    // Get the most recent tasks from the client.
    // By default, it returns the last few tasks which is enough to detect active indexing.
    match client.get_tasks().await {
        Ok(tasks) => tasks
            .results
            .iter()
            .any(|t| matches!(t, Task::Enqueued { .. } | Task::Processing { .. })),
        Err(e) => {
            tracing::error!(error = %e, "Failed to check Meilisearch indexing status");
            false
        }
    }
}
