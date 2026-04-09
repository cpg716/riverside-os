//! Push PostgreSQL rows into Meilisearch (best-effort; failures are logged).

use meilisearch_sdk::client::Client;
use sqlx::PgPool;
use uuid::Uuid;

use crate::logic::meilisearch_client::{
    INDEX_CUSTOMERS, INDEX_ORDERS, INDEX_STORE_PRODUCTS, INDEX_VARIANTS, INDEX_WEDDING_PARTIES,
};
use crate::logic::meilisearch_documents::{
    augment_search_with_phone_digits, build_customer_search_text, variant_doc_from_row,
    CustomerDoc, OrderDoc, StoreProductDoc, WeddingPartyDoc,
};

fn log_meili_add_err(context: &'static str, e: &meilisearch_sdk::errors::Error) {
    tracing::warn!(error = %e, context, "Meilisearch add_documents failed; will rely on SQL search until reindex");
}

/// Remove a variant document (e.g. inactive product or deleted variant).
pub async fn delete_variant_document(client: &Client, variant_id: Uuid) {
    let index = client.index(INDEX_VARIANTS);
    if let Err(e) = index.delete_document(variant_id.to_string()).await {
        tracing::warn!(error = %e, %variant_id, "Meilisearch delete_document variant failed");
    }
}

pub async fn upsert_variant_document(client: &Client, pool: &PgPool, variant_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        variant_id: Uuid,
        product_id: Uuid,
        category_id: Option<Uuid>,
        primary_vendor_id: Option<Uuid>,
        web_published: bool,
        is_clothing_footwear: Option<bool>,
        sku: String,
        barcode: Option<String>,
        vendor_upc: Option<String>,
        product_name: String,
        brand: Option<String>,
        variation_label: Option<String>,
        catalog_handle: Option<String>,
        is_active: bool,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            pv.id AS variant_id,
            p.id AS product_id,
            p.category_id,
            p.primary_vendor_id,
            COALESCE(pv.web_published, false) AS web_published,
            c.is_clothing_footwear,
            pv.sku,
            pv.barcode,
            pv.vendor_upc,
            p.name AS product_name,
            p.brand,
            pv.variation_label,
            NULLIF(btrim(p.catalog_handle::text), '') AS catalog_handle,
            p.is_active
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE pv.id = $1
        "#,
    )
    .bind(variant_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        delete_variant_document(client, variant_id).await;
        return;
    };

    if !row.is_active {
        delete_variant_document(client, variant_id).await;
        return;
    }

    let doc = variant_doc_from_row(
        row.variant_id,
        row.product_id,
        row.category_id,
        row.primary_vendor_id,
        row.web_published,
        row.is_clothing_footwear.unwrap_or(false),
        &row.sku,
        row.barcode.as_deref(),
        row.vendor_upc.as_deref(),
        &row.product_name,
        row.brand.as_deref(),
        row.variation_label.as_deref(),
        row.catalog_handle.as_deref(),
    );

    let index = client.index(INDEX_VARIANTS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("variant upsert", &e);
    }
}

/// Re-sync every variant for a product (and storefront product row).
pub async fn sync_product_variants_and_store(client: &Client, pool: &PgPool, product_id: Uuid) {
    let ids: Vec<Uuid> = match sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM product_variants WHERE product_id = $1",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, %product_id, "meilisearch sync list variants failed");
            return;
        }
    };

    for vid in ids {
        upsert_variant_document(client, pool, vid).await;
    }
    upsert_store_product_document(client, pool, product_id).await;
}

pub async fn upsert_store_product_document(client: &Client, pool: &PgPool, product_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        product_id: Uuid,
        slug: String,
        name: String,
        brand: Option<String>,
        is_active: bool,
        web_count: i64,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            p.id AS product_id,
            btrim(p.catalog_handle::text) AS slug,
            p.name,
            p.brand,
            p.is_active,
            (
                SELECT COUNT(*)::bigint FROM product_variants pv
                WHERE pv.product_id = p.id AND COALESCE(pv.web_published, false) = true
            ) AS web_count
        FROM products p
        WHERE p.id = $1
        "#,
    )
    .bind(product_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_STORE_PRODUCTS);
        let _ = index.delete_document(product_id.to_string()).await;
        return;
    };

    let slug_ok = !row.slug.is_empty();
    let catalog_ok = row.is_active && slug_ok && row.web_count > 0;
    let search_text = format!(
        "{} {} {}",
        row.name,
        row.slug,
        row.brand.as_deref().unwrap_or("")
    );

    let doc = StoreProductDoc {
        id: row.product_id.to_string(),
        catalog_ok,
        search_text,
    };

    let index = client.index(INDEX_STORE_PRODUCTS);
    if !catalog_ok {
        let _ = index.delete_document(product_id.to_string()).await;
        return;
    }
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("store product upsert", &e);
    }
}

pub async fn upsert_customer_document(client: &Client, pool: &PgPool, customer_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        customer_code: String,
        first_name: Option<String>,
        last_name: Option<String>,
        company_name: Option<String>,
        email: Option<String>,
        phone: Option<String>,
        city: Option<String>,
        state: Option<String>,
        postal_code: Option<String>,
        address_line1: Option<String>,
        wedding_names: Option<String>,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            c.id,
            c.customer_code,
            c.first_name,
            c.last_name,
            c.company_name,
            c.email,
            c.phone,
            c.city,
            c.state,
            c.postal_code,
            c.address_line1,
            (
                SELECT string_agg(DISTINCT COALESCE(wp.party_name, '') || ' ' || COALESCE(wp.groom_name, ''), ' ')
                FROM wedding_members wm
                JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                WHERE wm.customer_id = c.id
                  AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                  AND wp.event_date >= CURRENT_DATE
            ) AS wedding_names
        FROM customers c
        WHERE c.id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_CUSTOMERS);
        let _ = index.delete_document(customer_id.to_string()).await;
        return;
    };

    let search_text = build_customer_search_text(
        row.first_name.as_deref(),
        row.last_name.as_deref(),
        Some(&row.customer_code),
        row.company_name.as_deref(),
        row.email.as_deref(),
        row.phone.as_deref(),
        row.city.as_deref(),
        row.state.as_deref(),
        row.postal_code.as_deref(),
        row.address_line1.as_deref(),
        row.wedding_names.as_deref(),
    );

    let doc = CustomerDoc {
        id: row.id.to_string(),
        search_text,
        customer_code: Some(row.customer_code),
    };

    let index = client.index(INDEX_CUSTOMERS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("customer upsert", &e);
    }
}

pub async fn upsert_wedding_party_document(client: &Client, pool: &PgPool, party_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        is_deleted: Option<bool>,
        party_name: Option<String>,
        groom_name: Option<String>,
        notes: Option<String>,
        groom_email: Option<String>,
        bride_name: Option<String>,
        bride_email: Option<String>,
        groom_phone: Option<String>,
        bride_phone: Option<String>,
        member_blob: Option<String>,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            wp.id,
            wp.is_deleted,
            wp.party_name,
            wp.groom_name,
            wp.notes,
            wp.groom_email,
            wp.bride_name,
            wp.bride_email,
            wp.groom_phone,
            wp.bride_phone,
            (
                SELECT string_agg(
                    TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')),
                    ' '
                )
                FROM wedding_members wm
                JOIN customers c ON c.id = wm.customer_id
                WHERE wm.wedding_party_id = wp.id
            ) AS member_blob
        FROM wedding_parties wp
        WHERE wp.id = $1
        "#,
    )
    .bind(party_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_WEDDING_PARTIES);
        let _ = index.delete_document(party_id.to_string()).await;
        return;
    };

    let mut base = String::new();
    for p in [
        row.party_name.as_deref(),
        row.groom_name.as_deref(),
        row.notes.as_deref(),
        row.groom_email.as_deref(),
        row.bride_name.as_deref(),
        row.bride_email.as_deref(),
        row.member_blob.as_deref(),
    ] {
        if let Some(s) = p.filter(|x| !x.trim().is_empty()) {
            if !base.is_empty() {
                base.push(' ');
            }
            base.push_str(s);
        }
    }
    let search_text = augment_search_with_phone_digits(
        &base,
        &[row.groom_phone.clone(), row.bride_phone.clone()],
    );

    let doc = WeddingPartyDoc {
        id: row.id.to_string(),
        is_deleted: row.is_deleted.unwrap_or(false),
        search_text,
    };

    let index = client.index(INDEX_WEDDING_PARTIES);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("wedding party upsert", &e);
    }
}

pub async fn upsert_order_document(client: &Client, pool: &PgPool, order_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        status: String,
        customer_first: Option<String>,
        customer_last: Option<String>,
        party_name: Option<String>,
        salesperson: Option<String>,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            o.id,
            o.status::text AS status,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            NULLIF(TRIM(COALESCE(wp.party_name, '')), '') AS party_name,
            ps.full_name AS salesperson
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        WHERE o.id = $1
        "#,
    )
    .bind(order_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_ORDERS);
        let _ = index.delete_document(order_id.to_string()).await;
        return;
    };

    let s = row.status.to_lowercase();
    let status_open = s == "open" || s == "pending_measurement";
    let cust = format!(
        "{} {}",
        row.customer_first.as_deref().unwrap_or(""),
        row.customer_last.as_deref().unwrap_or("")
    );
    let search_text = format!(
        "{} {} {} {}",
        row.id,
        cust.trim(),
        row.party_name.as_deref().unwrap_or(""),
        row.salesperson.as_deref().unwrap_or("")
    );

    let doc = OrderDoc {
        id: row.id.to_string(),
        status_open,
        search_text,
    };

    let index = client.index(INDEX_ORDERS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("order upsert", &e);
    }
}

/// Spawn a cheap background sync (does not block the request path).
pub fn spawn_meili<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(fut);
}

/// Full rebuild: settings + all documents (admin / script).
pub async fn reindex_all_meilisearch(
    client: &Client,
    pool: &PgPool,
) -> Result<(), meilisearch_sdk::errors::Error> {
    use meilisearch_sdk::errors::Error as MeiliError;

    crate::logic::meilisearch_client::ensure_all_meilisearch_index_settings(client).await?;

    let vids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT pv.id
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE p.is_active = true
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| MeiliError::Other(Box::new(e)))?;
    let n_variants = vids.len();

    for vid in vids {
        upsert_variant_document(client, pool, vid).await;
    }

    let pids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM products")
        .fetch_all(pool)
        .await
        .map_err(|e| MeiliError::Other(Box::new(e)))?;
    let n_products = pids.len();
    for pid in pids {
        upsert_store_product_document(client, pool, pid).await;
    }

    let cids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM customers")
        .fetch_all(pool)
        .await
        .map_err(|e| MeiliError::Other(Box::new(e)))?;
    let n_customers = cids.len();
    for cid in cids {
        upsert_customer_document(client, pool, cid).await;
    }

    let wpids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM wedding_parties")
        .fetch_all(pool)
        .await
        .map_err(|e| MeiliError::Other(Box::new(e)))?;
    let n_parties = wpids.len();
    for wpid in wpids {
        upsert_wedding_party_document(client, pool, wpid).await;
    }

    let oids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM orders")
        .fetch_all(pool)
        .await
        .map_err(|e| MeiliError::Other(Box::new(e)))?;
    let n_orders = oids.len();
    for oid in oids {
        upsert_order_document(client, pool, oid).await;
    }

    if let Err(e) = crate::logic::help_corpus::reindex_help_meilisearch(client).await {
        tracing::warn!(error = %e, "Meilisearch help reindex failed (other indexes succeeded)");
    }

    tracing::info!(
        variants = n_variants,
        products = n_products,
        customers = n_customers,
        wedding_parties = n_parties,
        orders = n_orders,
        "Meilisearch reindex completed"
    );

    Ok(())
}
