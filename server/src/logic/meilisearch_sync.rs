//! Push PostgreSQL rows into Meilisearch (best-effort; failures are logged).

use meilisearch_sdk::client::Client;
use meilisearch_sdk::client::SwapIndexes;
use meilisearch_sdk::indexes::Index;
use meilisearch_sdk::task_info::TaskInfo;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::logic::meilisearch_client::{
    INDEX_ALTERATIONS, INDEX_APPOINTMENTS, INDEX_CATEGORIES, INDEX_CUSTOMERS, INDEX_HELP,
    INDEX_ORDERS, INDEX_STAFF, INDEX_STORE_PRODUCTS, INDEX_TASKS, INDEX_TRANSACTIONS,
    INDEX_VARIANTS, INDEX_VENDORS, INDEX_WEDDING_PARTIES,
};
use crate::logic::meilisearch_documents::{
    augment_search_with_phone_digits, build_alteration_search_text, build_customer_search_text,
    variant_doc_from_row, AlterationDoc, AppointmentDoc, CategoryDoc, CustomerDoc, OrderDoc,
    StaffDoc, StoreProductDoc, TaskDoc, TransactionDoc, VendorDoc, WeddingPartyDoc,
};
use futures_util::StreamExt;

#[derive(sqlx::FromRow)]
struct VariantRow {
    variant_id: Uuid,
    product_id: Uuid,
    category_id: Option<Uuid>,
    primary_vendor_id: Option<Uuid>,
    web_published: bool,
    is_clothing_footwear: Option<bool>,
    stock_on_hand: i32,
    reserved_stock: i32,
    sku: String,
    barcode: Option<String>,
    vendor_upc: Option<String>,
    product_name: String,
    brand: Option<String>,
    variation_label: Option<String>,
    catalog_handle: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    variant_id: Uuid,
    product_id: Uuid,
    category_id: Option<Uuid>,
    primary_vendor_id: Option<Uuid>,
    web_published: bool,
    is_clothing_footwear: Option<bool>,
    stock_on_hand: i32,
    reserved_stock: i32,
    sku: String,
    barcode: Option<String>,
    vendor_upc: Option<String>,
    product_name: String,
    brand: Option<String>,
    variation_label: Option<String>,
    catalog_handle: Option<String>,
    is_active: bool,
}

fn customer_full_name(first_name: Option<&str>, last_name: Option<&str>) -> Option<String> {
    let value = format!(
        "{} {}",
        first_name.unwrap_or("").trim(),
        last_name.unwrap_or("").trim()
    )
    .trim()
    .to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn optional_trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn log_meili_add_err(context: &'static str, e: &meilisearch_sdk::errors::Error) {
    tracing::warn!(error = %e, context, "Meilisearch add_documents failed; will rely on SQL search until reindex");
}

async fn record_incremental_sync_status(
    pool: &PgPool,
    index_name: &str,
    is_success: bool,
    error_message: Option<&str>,
) {
    let now = chrono::Utc::now();
    let res = sqlx::query(
        r#"
        INSERT INTO meilisearch_sync_status
            (index_name, last_success_at, last_attempt_at, is_success, row_count, error_message, updated_at)
        VALUES
            ($1, CASE WHEN $2 THEN $3 ELSE NULL END, $3, $2, 0, $4, $3)
        ON CONFLICT (index_name) DO UPDATE SET
            last_success_at = CASE WHEN $2 THEN EXCLUDED.last_attempt_at ELSE meilisearch_sync_status.last_success_at END,
            last_attempt_at = EXCLUDED.last_attempt_at,
            is_success = EXCLUDED.is_success,
            error_message = EXCLUDED.error_message,
            updated_at = EXCLUDED.updated_at
        "#
    )
    .bind(index_name)
    .bind(is_success)
    .bind(now)
    .bind(error_message)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::error!(error = %e, index = index_name, "Failed to record incremental meilisearch sync status");
    }
}

/// Remove a variant document (e.g. inactive product or deleted variant).
pub async fn delete_variant_document(client: &Client, variant_id: Uuid) {
    let index = client.index(INDEX_VARIANTS);
    if let Err(e) = index.delete_document(variant_id.to_string()).await {
        tracing::warn!(error = %e, %variant_id, "Meilisearch delete_document variant failed");
    }
}

pub async fn upsert_variant_document(client: &Client, pool: &PgPool, variant_id: Uuid) {
    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            pv.id AS variant_id,
            p.id AS product_id,
            p.category_id,
            p.primary_vendor_id,
            COALESCE(pv.web_published, false) AS web_published,
            c.is_clothing_footwear,
            COALESCE(pv.stock_on_hand, 0)::integer AS stock_on_hand,
            COALESCE(pv.reserved_stock, 0)::integer AS reserved_stock,
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
        row.is_active,
        row.stock_on_hand,
        row.reserved_stock,
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
        record_incremental_sync_status(pool, INDEX_VARIANTS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_VARIANTS, true, None).await;
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
        record_incremental_sync_status(pool, INDEX_STORE_PRODUCTS, false, Some(&e.to_string()))
            .await;
    } else {
        record_incremental_sync_status(pool, INDEX_STORE_PRODUCTS, true, None).await;
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
        first_name: optional_trimmed(row.first_name.clone()),
        last_name: optional_trimmed(row.last_name.clone()),
        full_name: customer_full_name(row.first_name.as_deref(), row.last_name.as_deref()),
        company_name: optional_trimmed(row.company_name.clone()),
        email: optional_trimmed(row.email.clone()),
        phone_digits: row
            .phone
            .as_deref()
            .map(crate::logic::meilisearch_documents::digits_only)
            .filter(|s| !s.is_empty()),
        search_text,
        customer_code: Some(row.customer_code),
    };

    let index = client.index(INDEX_CUSTOMERS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("customer upsert", &e);
        record_incremental_sync_status(pool, INDEX_CUSTOMERS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_CUSTOMERS, true, None).await;
    }
}

pub async fn delete_customer_document(client: &Client, customer_id: Uuid) {
    let index = client.index(INDEX_CUSTOMERS);
    let _ = index.delete_document(customer_id.to_string()).await;
}

pub async fn spawn_meilisearch_customer_upsert(
    client: &Client,
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<(), meilisearch_sdk::errors::Error> {
    upsert_customer_document(client, pool, customer_id).await;
    Ok(())
}

pub async fn spawn_meilisearch_transaction_upsert(
    client: &Client,
    pool: &PgPool,
    transaction_id: Uuid,
) -> Result<(), meilisearch_sdk::errors::Error> {
    upsert_transaction_document(client, pool, transaction_id).await;
    Ok(())
}

pub async fn spawn_meilisearch_customer_delete(
    client: &Client,
    customer_id: Uuid,
) -> Result<(), meilisearch_sdk::errors::Error> {
    delete_customer_document(client, customer_id).await;
    Ok(())
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
        record_incremental_sync_status(pool, INDEX_WEDDING_PARTIES, false, Some(&e.to_string()))
            .await;
    } else {
        record_incremental_sync_status(pool, INDEX_WEDDING_PARTIES, true, None).await;
    }
}

pub async fn upsert_transaction_document(client: &Client, pool: &PgPool, transaction_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        display_id: String,
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
            o.display_id,
            o.status::text AS status,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            NULLIF(TRIM(COALESCE(wp.party_name, '')), '') AS party_name,
            ps.full_name AS salesperson
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        WHERE o.id = $1
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_TRANSACTIONS);
        let _ = index.delete_document(transaction_id.to_string()).await;
        return;
    };

    let s = row.status.to_lowercase();
    let status_open = s == "open" || s == "pending_measurement";
    let cust = format!(
        "{} {}",
        row.customer_first.as_deref().unwrap_or(""),
        row.customer_last.as_deref().unwrap_or("")
    );
    let customer_name =
        customer_full_name(row.customer_first.as_deref(), row.customer_last.as_deref());
    let search_text = format!(
        "{} {} {} {} {}",
        row.id,
        row.display_id,
        cust.trim(),
        row.party_name.as_deref().unwrap_or(""),
        row.salesperson.as_deref().unwrap_or("")
    );

    let doc = TransactionDoc {
        id: row.id.to_string(),
        display_id: row.display_id,
        customer_name,
        party_name: optional_trimmed(row.party_name),
        status_open,
        search_text,
    };

    let index = client.index(INDEX_TRANSACTIONS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("transaction upsert", &e);
        record_incremental_sync_status(pool, INDEX_TRANSACTIONS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_TRANSACTIONS, true, None).await;
    }
}

pub async fn upsert_order_document(client: &Client, pool: &PgPool, transaction_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        display_id: String,
        status: String,
        customer_first: Option<String>,
        customer_last: Option<String>,
        customer_code: Option<String>,
        party_name: Option<String>,
        transaction_display_ids: Option<String>,
        item_blob: Option<String>,
        is_order: bool,
        status_open: bool,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            o.id,
            COALESCE(o.display_id, o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS display_id,
            o.status::text AS status,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            c.customer_code,
            NULLIF(TRIM(COALESCE(wp.party_name, '')), '') AS party_name,
            string_agg(DISTINCT o.display_id, ' ') AS transaction_display_ids,
            string_agg(DISTINCT TRIM(CONCAT_WS(' ', p.name, pv.sku, pv.variation_label)), ' ') AS item_blob
            ,(o.counterpoint_doc_ref IS NOT NULL OR COALESCE(BOOL_OR(tl.fulfillment::text <> 'takeaway'), false)) AS is_order
            ,(o.counterpoint_doc_ref IS NOT NULL OR COALESCE(BOOL_OR(tl.is_fulfilled = false), false)) AS status_open
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN transaction_lines tl ON tl.transaction_id = o.id
        LEFT JOIN products p ON p.id = tl.product_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        WHERE o.id = $1
        GROUP BY o.id, c.id, wp.id
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_ORDERS);
        let _ = index.delete_document(transaction_id.to_string()).await;
        return;
    };

    let index = client.index(INDEX_ORDERS);
    if !row.is_order {
        let _ = index.delete_document(transaction_id.to_string()).await;
        return;
    }

    let search_text = format!(
        "{} {} {} {} {} {} {} {}",
        row.id,
        row.display_id,
        row.status,
        row.customer_first.as_deref().unwrap_or(""),
        row.customer_last.as_deref().unwrap_or(""),
        row.customer_code.as_deref().unwrap_or(""),
        row.party_name.as_deref().unwrap_or(""),
        row.transaction_display_ids.as_deref().unwrap_or("")
    ) + " "
        + row.item_blob.as_deref().unwrap_or("");

    let doc = OrderDoc {
        id: row.id.to_string(),
        display_id: row.display_id,
        customer_name: customer_full_name(
            row.customer_first.as_deref(),
            row.customer_last.as_deref(),
        ),
        party_name: optional_trimmed(row.party_name),
        status_open: row.status_open,
        search_text,
    };

    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("order upsert", &e);
        record_incremental_sync_status(pool, INDEX_ORDERS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_ORDERS, true, None).await;
    }
}

pub async fn upsert_staff_document(client: &Client, pool: &PgPool, staff_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        full_name: String,
        cashier_code: Option<String>,
        role: String,
        is_active: bool,
    }

    let row = sqlx::query_as::<_, Row>(
        "SELECT id, full_name, cashier_code, role::text, is_active FROM staff WHERE id = $1",
    )
    .bind(staff_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_STAFF);
        let _ = index.delete_document(staff_id.to_string()).await;
        return;
    };

    let search_text = format!(
        "{} {}",
        row.full_name,
        row.cashier_code.as_deref().unwrap_or("")
    );
    let doc = StaffDoc {
        id: row.id.to_string(),
        is_active: row.is_active,
        role: row.role,
        search_text,
    };

    let index = client.index(INDEX_STAFF);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("staff upsert", &e);
        record_incremental_sync_status(pool, INDEX_STAFF, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_STAFF, true, None).await;
    }
}

pub async fn upsert_vendor_document(client: &Client, pool: &PgPool, vendor_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        name: String,
        vendor_code: Option<String>,
        is_active: bool,
    }

    let row = sqlx::query_as::<_, Row>(
        "SELECT id, name, vendor_code, is_active FROM vendors WHERE id = $1",
    )
    .bind(vendor_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_VENDORS);
        let _ = index.delete_document(vendor_id.to_string()).await;
        return;
    };

    let search_text = format!("{} {}", row.name, row.vendor_code.as_deref().unwrap_or(""));
    let doc = VendorDoc {
        id: row.id.to_string(),
        is_active: row.is_active,
        search_text,
    };

    let index = client.index(INDEX_VENDORS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("vendor upsert", &e);
        record_incremental_sync_status(pool, INDEX_VENDORS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_VENDORS, true, None).await;
    }
}

pub async fn upsert_category_document(client: &Client, pool: &PgPool, category_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        name: String,
    }

    let row = sqlx::query_as::<_, Row>("SELECT id, name FROM categories WHERE id = $1")
        .bind(category_id)
        .fetch_optional(pool)
        .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_CATEGORIES);
        let _ = index.delete_document(category_id.to_string()).await;
        return;
    };

    let doc = CategoryDoc {
        id: row.id.to_string(),
        search_text: row.name,
    };

    let index = client.index(INDEX_CATEGORIES);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("category upsert", &e);
        record_incremental_sync_status(pool, INDEX_CATEGORIES, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_CATEGORIES, true, None).await;
    }
}

pub async fn upsert_appointment_document(client: &Client, pool: &PgPool, appt_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        customer_first: Option<String>,
        customer_last: Option<String>,
        party_name: Option<String>,
        notes: Option<String>,
        status: String,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            a.id,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            wp.party_name,
            a.notes,
            a.status
        FROM wedding_appointments a
        LEFT JOIN customers c ON c.id = a.customer_id
        LEFT JOIN wedding_parties wp ON wp.id = a.wedding_party_id
        WHERE a.id = $1
        "#,
    )
    .bind(appt_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_APPOINTMENTS);
        let _ = index.delete_document(appt_id.to_string()).await;
        return;
    };

    let search_text = format!(
        "{} {} {} {}",
        row.customer_first.as_deref().unwrap_or(""),
        row.customer_last.as_deref().unwrap_or(""),
        row.party_name.as_deref().unwrap_or(""),
        row.notes.as_deref().unwrap_or("")
    );

    let doc = AppointmentDoc {
        id: row.id.to_string(),
        is_cancelled: row.status == "Cancelled",
        search_text,
    };

    let index = client.index(INDEX_APPOINTMENTS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("appointment upsert", &e);
        record_incremental_sync_status(pool, INDEX_APPOINTMENTS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_APPOINTMENTS, true, None).await;
    }
}

pub async fn upsert_task_document(client: &Client, pool: &PgPool, task_id: Uuid) {
    let task = sqlx::query(
        r#"
        SELECT ti.id, ti.title_snapshot AS title, ti.status::text AS status, ti.due_date,
               ti.assignee_staff_id, s.full_name AS assignee_name
        FROM task_instance ti
        LEFT JOIN staff s ON s.id = ti.assignee_staff_id
        WHERE ti.id = $1
        "#,
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = task else {
        let index = client.index(INDEX_TASKS);
        let _ = index.delete_document(task_id.to_string()).await;
        return;
    };

    use sqlx::Row;
    let doc = TaskDoc {
        id: row.get::<Uuid, _>("id").to_string(),
        status: row
            .get::<Option<String>, _>("status")
            .unwrap_or_else(|| "open".to_string()),
        assignee_id: row
            .get::<Option<Uuid>, _>("assignee_staff_id")
            .map(|id| id.to_string()),
        search_text: format!(
            "{} {}",
            row.get::<String, _>("title"),
            row.get::<Option<String>, _>("assignee_name")
                .unwrap_or_default()
        ),
    };

    let index = client.index(INDEX_TASKS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("task upsert", &e);
        record_incremental_sync_status(pool, INDEX_TASKS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_TASKS, true, None).await;
    }
}

pub async fn upsert_alteration_document(client: &Client, pool: &PgPool, alteration_id: Uuid) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        customer_id: Uuid,
        status: String,
        customer_first_name: Option<String>,
        customer_last_name: Option<String>,
        customer_code: Option<String>,
        customer_email: Option<String>,
        customer_phone: Option<String>,
        address_line1: Option<String>,
        city: Option<String>,
        state: Option<String>,
        postal_code: Option<String>,
        transaction_display_id: Option<String>,
        item_description: Option<String>,
        work_requested: Option<String>,
        notes: Option<String>,
        source_sku: Option<String>,
    }

    let row = sqlx::query_as::<_, Row>(
        r#"
        SELECT
            a.id,
            a.customer_id,
            a.status::text AS status,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            c.customer_code,
            c.email AS customer_email,
            c.phone AS customer_phone,
            c.address_line1,
            c.city,
            c.state,
            c.postal_code,
            lt.display_id AS transaction_display_id,
            a.item_description,
            a.work_requested,
            a.notes,
            a.source_sku
        FROM alteration_orders a
        LEFT JOIN customers c ON c.id = a.customer_id
        LEFT JOIN transactions lt ON lt.id = COALESCE(a.transaction_id, a.source_transaction_id)
        WHERE a.id = $1
        "#,
    )
    .bind(alteration_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        let index = client.index(INDEX_ALTERATIONS);
        let _ = index.delete_document(alteration_id.to_string()).await;
        return;
    };

    let alteration_id_text = row.id.to_string();
    let search_text = build_alteration_search_text(
        &alteration_id_text,
        row.customer_first_name.as_deref(),
        row.customer_last_name.as_deref(),
        row.customer_code.as_deref(),
        row.customer_email.as_deref(),
        row.customer_phone.as_deref(),
        row.address_line1.as_deref(),
        row.city.as_deref(),
        row.state.as_deref(),
        row.postal_code.as_deref(),
        row.transaction_display_id.as_deref(),
        row.item_description.as_deref(),
        row.work_requested.as_deref(),
        row.notes.as_deref(),
        row.source_sku.as_deref(),
    );

    let doc = AlterationDoc {
        id: alteration_id_text,
        customer_id: row.customer_id.to_string(),
        status_open: row.status != "picked_up",
        search_text,
    };

    let index = client.index(INDEX_ALTERATIONS);
    if let Err(e) = index.add_or_replace(&[doc], Some("id")).await {
        log_meili_add_err("alteration upsert", &e);
        record_incremental_sync_status(pool, INDEX_ALTERATIONS, false, Some(&e.to_string())).await;
    } else {
        record_incremental_sync_status(pool, INDEX_ALTERATIONS, true, None).await;
    }
}

/// Spawn a cheap background sync (does not block the request path).
pub fn spawn_meili<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(fut);
}

pub async fn record_sync_status(
    pool: &PgPool,
    index_name: &str,
    is_success: bool,
    row_count: i64,
    error_message: Option<&str>,
) {
    let now = chrono::Utc::now();
    let res = sqlx::query(
        r#"
        INSERT INTO meilisearch_sync_status (index_name, last_success_at, last_attempt_at, is_success, row_count, error_message, updated_at)
        VALUES ($1, CASE WHEN $2 THEN $3 ELSE NULL END, $3, $2, $4, $5, $3)
        ON CONFLICT (index_name) DO UPDATE SET
            last_success_at = CASE WHEN $2 THEN EXCLUDED.last_success_at ELSE meilisearch_sync_status.last_success_at END,
            last_attempt_at = EXCLUDED.last_attempt_at,
            is_success = EXCLUDED.is_success,
            row_count = EXCLUDED.row_count,
            error_message = EXCLUDED.error_message,
            updated_at = EXCLUDED.updated_at
        "#
    )
    .bind(index_name)
    .bind(is_success)
    .bind(now)
    .bind(row_count)
    .bind(error_message)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::error!(error = %e, index = index_name, "Failed to record meilisearch sync status");
    }
}

fn reindex_temp_uid(index_name: &str) -> String {
    format!("{index_name}__rebuild__{}", Uuid::new_v4().simple())
}

async fn ensure_live_index_exists_for_swap(
    client: &Client,
    live_uid: &str,
) -> Result<(), meilisearch_sdk::errors::Error> {
    if client.get_raw_index(live_uid).await.is_ok() {
        return Ok(());
    }
    let task = client.create_index(live_uid, Some("id")).await?;
    crate::logic::meilisearch_client::wait_task_ok(client, task).await
}

async fn prepare_temp_index(
    client: &Client,
    live_uid: &str,
    temp_uid: &str,
) -> Result<Index, meilisearch_sdk::errors::Error> {
    let task = client.create_index(temp_uid, Some("id")).await?;
    crate::logic::meilisearch_client::wait_task_ok(client, task).await?;
    crate::logic::meilisearch_client::ensure_index_settings_for_uid(client, live_uid, temp_uid)
        .await?;
    Ok(client.index(temp_uid))
}

async fn enqueue_documents<T: Serialize + Send + Sync>(
    index: &Index,
    documents: &[T],
    pending_tasks: &mut Vec<TaskInfo>,
) -> Result<(), meilisearch_sdk::errors::Error> {
    if documents.is_empty() {
        return Ok(());
    }
    pending_tasks.push(index.add_documents(documents, Some("id")).await?);
    Ok(())
}

async fn wait_pending_tasks(
    client: &Client,
    pending_tasks: Vec<TaskInfo>,
) -> Result<(), meilisearch_sdk::errors::Error> {
    for task in pending_tasks {
        crate::logic::meilisearch_client::wait_task_ok(client, task).await?;
    }
    Ok(())
}

async fn swap_temp_into_live(
    client: &Client,
    live_uid: &str,
    temp_uid: &str,
) -> Result<(), meilisearch_sdk::errors::Error> {
    ensure_live_index_exists_for_swap(client, live_uid).await?;
    let swap = SwapIndexes {
        indexes: (live_uid.to_string(), temp_uid.to_string()),
        rename: None,
    };
    let task = client.swap_indexes([&swap]).await?;
    crate::logic::meilisearch_client::wait_task_ok(client, task).await?;
    match client.delete_index(temp_uid).await {
        Ok(task) => {
            if let Err(e) = crate::logic::meilisearch_client::wait_task_ok(client, task).await {
                tracing::warn!(error = %e, index = temp_uid, "Meilisearch old-index cleanup task failed after successful swap");
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, index = temp_uid, "Meilisearch old-index cleanup enqueue failed after successful swap");
        }
    }
    Ok(())
}

pub async fn reindex_all_meilisearch(client: &Client, pool: &PgPool) -> anyhow::Result<()> {
    let result = reindex_all_meilisearch_inner(client, pool).await;
    match &result {
        Ok(()) => record_sync_status(pool, "ros_reindex_run", true, 0, None).await,
        Err(e) => record_sync_status(pool, "ros_reindex_run", false, 0, Some(&e.to_string())).await,
    }
    result
}

/// Full rebuild: settings + all documents (admin / script).
/// Optimized with bulk additions to avoid 500k sequential HTTP calls.
async fn reindex_all_meilisearch_inner(client: &Client, pool: &PgPool) -> anyhow::Result<()> {
    tracing::info!("Starting full Meilisearch reindex...");

    // 1. Variants (the largest index)
    let temp_variants = reindex_temp_uid(INDEX_VARIANTS);
    let index_v = prepare_temp_index(client, INDEX_VARIANTS, &temp_variants).await?;
    let mut variant_tasks = Vec::new();

    let mut variant_stream = sqlx::query_as::<_, VariantRow>(
        r#"
        SELECT
            pv.id AS variant_id,
            p.id AS product_id,
            p.category_id,
            p.primary_vendor_id,
            COALESCE(pv.web_published, false) AS web_published,
            c.is_clothing_footwear,
            COALESCE(pv.stock_on_hand, 0)::integer AS stock_on_hand,
            COALESCE(pv.reserved_stock, 0)::integer AS reserved_stock,
            pv.sku,
            pv.barcode,
            pv.vendor_upc,
            p.name AS product_name,
            p.brand,
            pv.variation_label,
            NULLIF(btrim(p.catalog_handle::text), '') AS catalog_handle
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = true
        "#,
    )
    .fetch(pool);

    let mut v_batch = Vec::with_capacity(1000);
    let mut n_variants = 0usize;
    while let Some(res) = variant_stream.next().await {
        if let Ok(row) = res {
            v_batch.push(variant_doc_from_row(
                row.variant_id,
                row.product_id,
                row.category_id,
                row.primary_vendor_id,
                row.web_published,
                row.is_clothing_footwear.unwrap_or(false),
                true,
                row.stock_on_hand,
                row.reserved_stock,
                &row.sku,
                row.barcode.as_deref(),
                row.vendor_upc.as_deref(),
                &row.product_name,
                row.brand.as_deref(),
                row.variation_label.as_deref(),
                row.catalog_handle.as_deref(),
            ));
            if v_batch.len() >= 1000 {
                n_variants += v_batch.len();
                enqueue_documents(&index_v, &v_batch, &mut variant_tasks).await?;
                v_batch.clear();
            }
        }
    }
    if !v_batch.is_empty() {
        n_variants += v_batch.len();
        enqueue_documents(&index_v, &v_batch, &mut variant_tasks).await?;
    }
    wait_pending_tasks(client, variant_tasks).await?;
    swap_temp_into_live(client, INDEX_VARIANTS, &temp_variants).await?;
    record_sync_status(pool, INDEX_VARIANTS, true, n_variants as i64, None).await;

    // 2. Store Products
    let temp_products = reindex_temp_uid(INDEX_STORE_PRODUCTS);
    let index_p = prepare_temp_index(client, INDEX_STORE_PRODUCTS, &temp_products).await?;
    let mut product_tasks = Vec::new();
    let mut product_stream = sqlx::query(
        r#"
        SELECT
            p.id,
            btrim(p.catalog_handle::text) AS slug,
            p.name,
            p.brand,
            p.is_active,
            (
                SELECT COUNT(*)::bigint FROM product_variants pv
                WHERE pv.product_id = p.id AND COALESCE(pv.web_published, false) = true
            ) AS web_count
        FROM products p
        WHERE p.is_active = true
        "#,
    )
    .fetch(pool);

    let mut p_batch = Vec::with_capacity(500);
    let mut n_products = 0usize;
    while let Some(res) = product_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let slug = row.get::<Option<String>, _>("slug").unwrap_or_default();
            let name = row.get::<String, _>("name");
            let brand = row.get::<Option<String>, _>("brand");
            let is_active = row.get::<Option<bool>, _>("is_active").unwrap_or(true);
            let web_count = row.get::<Option<i64>, _>("web_count").unwrap_or(0);

            let slug_ok = !slug.is_empty();
            let catalog_ok = is_active && slug_ok && web_count > 0;
            if catalog_ok {
                p_batch.push(StoreProductDoc {
                    id: row.get::<Uuid, _>("id").to_string(),
                    catalog_ok,
                    search_text: format!("{} {} {}", name, slug, brand.as_deref().unwrap_or("")),
                });
            }
            if p_batch.len() >= 500 {
                n_products += p_batch.len();
                enqueue_documents(&index_p, &p_batch, &mut product_tasks).await?;
                p_batch.clear();
            }
        }
    }
    if !p_batch.is_empty() {
        n_products += p_batch.len();
        enqueue_documents(&index_p, &p_batch, &mut product_tasks).await?;
    }
    wait_pending_tasks(client, product_tasks).await?;
    swap_temp_into_live(client, INDEX_STORE_PRODUCTS, &temp_products).await?;
    record_sync_status(pool, INDEX_STORE_PRODUCTS, true, n_products as i64, None).await;

    // 3. Customers
    let temp_customers = reindex_temp_uid(INDEX_CUSTOMERS);
    let index_c = prepare_temp_index(client, INDEX_CUSTOMERS, &temp_customers).await?;
    let mut customer_tasks = Vec::new();
    let mut customer_stream = sqlx::query(
        r#"
        SELECT
            id, customer_code, first_name, last_name, company_name, email, phone,
            city, state, postal_code, address_line1,
            (
                SELECT string_agg(DISTINCT COALESCE(wp.party_name, '') || ' ' || COALESCE(wp.groom_name, ''), ' ')
                FROM wedding_members wm
                JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                WHERE wm.customer_id = customers.id
                  AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                  AND wp.event_date >= CURRENT_DATE
            ) AS wedding_names
        FROM customers
        "#
    ).fetch(pool);

    let mut c_batch = Vec::with_capacity(1000);
    let mut n_customers = 0usize;
    while let Some(res) = customer_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let first_name = row.get::<Option<String>, _>("first_name");
            let last_name = row.get::<Option<String>, _>("last_name");
            let customer_code = row.get::<String, _>("customer_code");
            let company_name = row.get::<Option<String>, _>("company_name");
            let email = row.get::<Option<String>, _>("email");
            let phone = row.get::<Option<String>, _>("phone");
            let city = row.get::<Option<String>, _>("city");
            let state = row.get::<Option<String>, _>("state");
            let postal_code = row.get::<Option<String>, _>("postal_code");
            let address_line1 = row.get::<Option<String>, _>("address_line1");
            let wedding_names = row.get::<Option<String>, _>("wedding_names");

            let search_text = build_customer_search_text(
                first_name.as_deref(),
                last_name.as_deref(),
                Some(&customer_code),
                company_name.as_deref(),
                email.as_deref(),
                phone.as_deref(),
                city.as_deref(),
                state.as_deref(),
                postal_code.as_deref(),
                address_line1.as_deref(),
                wedding_names.as_deref(),
            );
            c_batch.push(CustomerDoc {
                id: row.get::<Uuid, _>("id").to_string(),
                first_name: optional_trimmed(first_name.clone()),
                last_name: optional_trimmed(last_name.clone()),
                full_name: customer_full_name(first_name.as_deref(), last_name.as_deref()),
                company_name: optional_trimmed(company_name.clone()),
                email: optional_trimmed(email.clone()),
                phone_digits: phone
                    .as_deref()
                    .map(crate::logic::meilisearch_documents::digits_only)
                    .filter(|s| !s.is_empty()),
                search_text,
                customer_code: Some(customer_code),
            });
            if c_batch.len() >= 1000 {
                n_customers += c_batch.len();
                enqueue_documents(&index_c, &c_batch, &mut customer_tasks).await?;
                c_batch.clear();
            }
        }
    }
    if !c_batch.is_empty() {
        n_customers += c_batch.len();
        enqueue_documents(&index_c, &c_batch, &mut customer_tasks).await?;
    }
    wait_pending_tasks(client, customer_tasks).await?;
    swap_temp_into_live(client, INDEX_CUSTOMERS, &temp_customers).await?;
    record_sync_status(pool, INDEX_CUSTOMERS, true, n_customers as i64, None).await;

    // 4. Wedding Parties
    let temp_weddings = reindex_temp_uid(INDEX_WEDDING_PARTIES);
    let index_w = prepare_temp_index(client, INDEX_WEDDING_PARTIES, &temp_weddings).await?;
    let mut wedding_tasks = Vec::new();
    let mut party_stream = sqlx::query(
        r#"
        SELECT
            wp.id, wp.is_deleted, wp.party_name, wp.groom_name, wp.notes,
            wp.groom_email, wp.bride_name, wp.bride_email, wp.groom_phone, wp.bride_phone,
            (
                SELECT string_agg(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ' ')
                FROM wedding_members wm
                JOIN customers c ON c.id = wm.customer_id
                WHERE wm.wedding_party_id = wp.id
            ) AS member_blob
        FROM wedding_parties wp
        "#
    ).fetch(pool);
    let mut w_batch = Vec::with_capacity(500);
    let mut n_weddings = 0usize;
    while let Some(res) = party_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let mut base = String::new();
            for p in [
                row.get::<Option<String>, _>("party_name").as_deref(),
                Some(row.get::<String, _>("groom_name")).as_deref(),
                row.get::<Option<String>, _>("notes").as_deref(),
                row.get::<Option<String>, _>("groom_email").as_deref(),
                row.get::<Option<String>, _>("bride_name").as_deref(),
                row.get::<Option<String>, _>("bride_email").as_deref(),
                row.get::<Option<String>, _>("member_blob").as_deref(),
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
                &[
                    row.get::<Option<String>, _>("groom_phone"),
                    row.get::<Option<String>, _>("bride_phone"),
                ],
            );
            w_batch.push(WeddingPartyDoc {
                id: row.get::<Uuid, _>("id").to_string(),
                is_deleted: row.get::<Option<bool>, _>("is_deleted").unwrap_or(false),
                search_text,
            });
            if w_batch.len() >= 500 {
                n_weddings += w_batch.len();
                enqueue_documents(&index_w, &w_batch, &mut wedding_tasks).await?;
                w_batch.clear();
            }
        }
    }
    if !w_batch.is_empty() {
        n_weddings += w_batch.len();
        enqueue_documents(&index_w, &w_batch, &mut wedding_tasks).await?;
    }
    wait_pending_tasks(client, wedding_tasks).await?;
    swap_temp_into_live(client, INDEX_WEDDING_PARTIES, &temp_weddings).await?;
    record_sync_status(pool, INDEX_WEDDING_PARTIES, true, n_weddings as i64, None).await;

    // 5. Transactions
    let temp_txns = reindex_temp_uid(INDEX_TRANSACTIONS);
    let index_txns = prepare_temp_index(client, INDEX_TRANSACTIONS, &temp_txns).await?;
    let mut txn_tasks = Vec::new();
    let mut txn_stream = sqlx::query(
        r#"
        SELECT
            o.id,
            o.display_id,
            o.status::text AS status,
            c.first_name AS customer_first, c.last_name AS customer_last,
            NULLIF(TRIM(COALESCE(wp.party_name, '')), '') AS party_name,
            ps.full_name AS salesperson
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN staff ps ON ps.id = o.primary_salesperson_id
        "#,
    )
    .fetch(pool);
    let mut txn_batch = Vec::with_capacity(1000);
    let mut n_txns = 0usize;
    while let Some(res) = txn_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let status = row.get::<Option<String>, _>("status");
            let s = status.as_deref().unwrap_or_default().to_lowercase();
            let status_open = s == "open" || s == "pending_measurement";
            let transaction_id = row.get::<Uuid, _>("id");
            let display_id = row
                .get::<Option<String>, _>("display_id")
                .unwrap_or_else(|| transaction_id.to_string());
            let transaction_id_str = transaction_id.to_string();
            let search_text = format!(
                "{} {} {} {} {} {}",
                transaction_id_str,
                display_id,
                row.get::<Option<String>, _>("customer_first")
                    .as_deref()
                    .unwrap_or(""),
                row.get::<Option<String>, _>("customer_last")
                    .as_deref()
                    .unwrap_or(""),
                row.get::<Option<String>, _>("party_name")
                    .as_deref()
                    .unwrap_or(""),
                row.get::<Option<String>, _>("salesperson")
                    .as_deref()
                    .unwrap_or("")
            );
            txn_batch.push(TransactionDoc {
                id: transaction_id_str,
                display_id,
                customer_name: customer_full_name(
                    row.get::<Option<String>, _>("customer_first").as_deref(),
                    row.get::<Option<String>, _>("customer_last").as_deref(),
                ),
                party_name: optional_trimmed(row.get::<Option<String>, _>("party_name")),
                status_open,
                search_text,
            });
            if txn_batch.len() >= 1000 {
                n_txns += txn_batch.len();
                enqueue_documents(&index_txns, &txn_batch, &mut txn_tasks).await?;
                txn_batch.clear();
            }
        }
    }
    if !txn_batch.is_empty() {
        n_txns += txn_batch.len();
        enqueue_documents(&index_txns, &txn_batch, &mut txn_tasks).await?;
    }
    wait_pending_tasks(client, txn_tasks).await?;
    swap_temp_into_live(client, INDEX_TRANSACTIONS, &temp_txns).await?;
    record_sync_status(pool, INDEX_TRANSACTIONS, true, n_txns as i64, None).await;

    // 6. Orders workspace records (transaction-backed order work, not every checkout)
    #[derive(sqlx::FromRow)]
    struct OrderReindexRow {
        id: Uuid,
        display_id: String,
        status: String,
        customer_first: Option<String>,
        customer_last: Option<String>,
        customer_code: Option<String>,
        party_name: Option<String>,
        transaction_display_ids: Option<String>,
        item_blob: Option<String>,
        status_open: bool,
    }

    let temp_orders = reindex_temp_uid(INDEX_ORDERS);
    let index_orders = prepare_temp_index(client, INDEX_ORDERS, &temp_orders).await?;
    let mut order_tasks = Vec::new();
    let mut order_stream = sqlx::query_as::<_, OrderReindexRow>(
        r#"
        SELECT
            o.id,
            COALESCE(o.display_id, o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS display_id,
            o.status::text AS status,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            c.customer_code,
            wp.party_name,
            string_agg(DISTINCT o.display_id, ' ') AS transaction_display_ids,
            string_agg(DISTINCT TRIM(CONCAT_WS(' ', p.name, pv.sku, pv.variation_label)), ' ') AS item_blob,
            (o.counterpoint_doc_ref IS NOT NULL OR COALESCE(BOOL_OR(tl.is_fulfilled = false), false)) AS status_open
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN transaction_lines tl ON tl.transaction_id = o.id
        LEFT JOIN products p ON p.id = tl.product_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        WHERE o.counterpoint_doc_ref IS NOT NULL
           OR EXISTS (
                SELECT 1
                FROM transaction_lines tl_order
                WHERE tl_order.transaction_id = o.id
                  AND tl_order.fulfillment::text <> 'takeaway'
           )
        GROUP BY o.id, c.id, wp.id
        "#
    )
    .fetch(pool);
    let mut order_batch = Vec::with_capacity(1000);
    let mut n_orders = 0usize;
    while let Some(res) = order_stream.next().await {
        let row = res?;
        let order_id_str = row.id.to_string();
        let search_text = format!(
            "{} {} {} {} {} {} {} {} {}",
            order_id_str,
            row.display_id,
            row.status,
            row.customer_first.as_deref().unwrap_or(""),
            row.customer_last.as_deref().unwrap_or(""),
            row.customer_code.as_deref().unwrap_or(""),
            row.party_name.as_deref().unwrap_or(""),
            row.transaction_display_ids.as_deref().unwrap_or(""),
            row.item_blob.as_deref().unwrap_or("")
        );
        order_batch.push(OrderDoc {
            id: order_id_str,
            display_id: row.display_id,
            customer_name: customer_full_name(
                row.customer_first.as_deref(),
                row.customer_last.as_deref(),
            ),
            party_name: optional_trimmed(row.party_name),
            status_open: row.status_open,
            search_text,
        });
        if order_batch.len() >= 1000 {
            n_orders += order_batch.len();
            enqueue_documents(&index_orders, &order_batch, &mut order_tasks).await?;
            order_batch.clear();
        }
    }
    if !order_batch.is_empty() {
        n_orders += order_batch.len();
        enqueue_documents(&index_orders, &order_batch, &mut order_tasks).await?;
    }
    wait_pending_tasks(client, order_tasks).await?;
    swap_temp_into_live(client, INDEX_ORDERS, &temp_orders).await?;
    record_sync_status(pool, INDEX_ORDERS, true, n_orders as i64, None).await;

    // 7. Help
    if let Err(e) = crate::logic::help_corpus::reindex_help_meilisearch(client).await {
        tracing::warn!(error = %e, "Meilisearch help reindex failed (other indexes succeeded)");
        record_sync_status(pool, INDEX_HELP, false, 0, Some(&e.to_string())).await;
    } else {
        record_sync_status(pool, INDEX_HELP, true, 0, None).await;
    }

    // 8. Staff
    let temp_staff = reindex_temp_uid(INDEX_STAFF);
    let index_staff = prepare_temp_index(client, INDEX_STAFF, &temp_staff).await?;
    let mut staff_tasks = Vec::new();
    let mut staff_stream =
        sqlx::query("SELECT id, full_name, cashier_code, role::text, is_active FROM staff")
            .fetch(pool);
    let mut staff_batch = Vec::new();
    while let Some(res) = staff_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let full_name = row.get::<String, _>("full_name");
            let cashier_code = row.get::<String, _>("cashier_code");
            let search_text = format!("{full_name} {cashier_code}");
            staff_batch.push(StaffDoc {
                id: row.get::<Uuid, _>("id").to_string(),
                is_active: row.get::<Option<bool>, _>("is_active").unwrap_or(true),
                role: row
                    .get::<Option<String>, _>("role")
                    .unwrap_or_else(|| "cashier".to_string()),
                search_text,
            });
        }
    }
    if !staff_batch.is_empty() {
        enqueue_documents(&index_staff, &staff_batch, &mut staff_tasks).await?;
    }
    wait_pending_tasks(client, staff_tasks).await?;
    swap_temp_into_live(client, INDEX_STAFF, &temp_staff).await?;
    record_sync_status(pool, INDEX_STAFF, true, staff_batch.len() as i64, None).await;

    // 9. Vendors
    let temp_vendors = reindex_temp_uid(INDEX_VENDORS);
    let index_vendors = prepare_temp_index(client, INDEX_VENDORS, &temp_vendors).await?;
    let mut vendor_tasks = Vec::new();
    let mut vendor_stream =
        sqlx::query("SELECT id, name, vendor_code, is_active FROM vendors").fetch(pool);
    let mut vendor_batch = Vec::new();
    while let Some(res) = vendor_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let name = row.get::<String, _>("name");
            let vendor_code = row.get::<Option<String>, _>("vendor_code");
            vendor_batch.push(VendorDoc {
                id: row.get::<Uuid, _>("id").to_string(),
                is_active: row.get::<bool, _>("is_active"),
                search_text: format!("{} {}", name, vendor_code.as_deref().unwrap_or("")),
            });
        }
    }
    if !vendor_batch.is_empty() {
        enqueue_documents(&index_vendors, &vendor_batch, &mut vendor_tasks).await?;
    }
    wait_pending_tasks(client, vendor_tasks).await?;
    swap_temp_into_live(client, INDEX_VENDORS, &temp_vendors).await?;
    record_sync_status(pool, INDEX_VENDORS, true, vendor_batch.len() as i64, None).await;

    // 10. Categories
    let temp_categories = reindex_temp_uid(INDEX_CATEGORIES);
    let index_categories = prepare_temp_index(client, INDEX_CATEGORIES, &temp_categories).await?;
    let mut category_tasks = Vec::new();
    let mut category_stream = sqlx::query("SELECT id, name FROM categories").fetch(pool);
    let mut category_batch = Vec::new();
    while let Some(res) = category_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            category_batch.push(CategoryDoc {
                id: row.get::<Uuid, _>("id").to_string(),
                search_text: row.get::<String, _>("name"),
            });
        }
    }
    if !category_batch.is_empty() {
        enqueue_documents(&index_categories, &category_batch, &mut category_tasks).await?;
    }
    wait_pending_tasks(client, category_tasks).await?;
    swap_temp_into_live(client, INDEX_CATEGORIES, &temp_categories).await?;
    record_sync_status(
        pool,
        INDEX_CATEGORIES,
        true,
        category_batch.len() as i64,
        None,
    )
    .await;

    // 11. Appointments
    let temp_appointments = reindex_temp_uid(INDEX_APPOINTMENTS);
    let index_appointments =
        prepare_temp_index(client, INDEX_APPOINTMENTS, &temp_appointments).await?;
    let mut appointment_tasks = Vec::new();
    let mut appt_stream = sqlx::query(
        r#"
        SELECT a.id, c.first_name, c.last_name, wp.party_name, a.notes, a.status::text as status
        FROM wedding_appointments a
        LEFT JOIN customers c ON c.id = a.customer_id
        LEFT JOIN wedding_parties wp ON wp.id = a.wedding_party_id
        "#,
    )
    .fetch(pool);
    let mut appt_batch = Vec::new();
    while let Some(res) = appt_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let status = row.get::<Option<String>, _>("status");
            let is_cancelled = status.as_deref() == Some("Cancelled");
            let search_text = format!(
                "{} {} {} {}",
                row.get::<Option<String>, _>("first_name")
                    .as_deref()
                    .unwrap_or(""),
                row.get::<Option<String>, _>("last_name")
                    .as_deref()
                    .unwrap_or(""),
                row.get::<Option<String>, _>("party_name")
                    .as_deref()
                    .unwrap_or(""),
                row.get::<Option<String>, _>("notes")
                    .as_deref()
                    .unwrap_or("")
            );
            appt_batch.push(AppointmentDoc {
                id: row.get::<Uuid, _>("id").to_string(),
                is_cancelled,
                search_text,
            });
        }
    }
    if !appt_batch.is_empty() {
        enqueue_documents(&index_appointments, &appt_batch, &mut appointment_tasks).await?;
    }
    wait_pending_tasks(client, appointment_tasks).await?;
    swap_temp_into_live(client, INDEX_APPOINTMENTS, &temp_appointments).await?;
    record_sync_status(
        pool,
        INDEX_APPOINTMENTS,
        true,
        appt_batch.len() as i64,
        None,
    )
    .await;

    // 12. Tasks
    let temp_tasks = reindex_temp_uid(INDEX_TASKS);
    let index_tasks = prepare_temp_index(client, INDEX_TASKS, &temp_tasks).await?;
    let mut task_tasks = Vec::new();
    let mut task_stream = sqlx::query(
        r#"
        SELECT ti.id, ti.title_snapshot AS title, ti.status::text AS status,
               ti.assignee_staff_id, s.full_name AS assignee_name
        FROM task_instance ti
        LEFT JOIN staff s ON s.id = ti.assignee_staff_id
        "#,
    )
    .fetch(pool);
    let mut task_batch = Vec::new();
    while let Some(res) = task_stream.next().await {
        if let Ok(row) = res {
            use sqlx::Row;
            let status = row.get::<Option<String>, _>("status");
            let title = row.get::<String, _>("title");
            let assignee_name = row.get::<Option<String>, _>("assignee_name");
            let search_text = format!("{} {}", title, assignee_name.as_deref().unwrap_or(""));
            task_batch.push(TaskDoc {
                id: row.get::<Uuid, _>("id").to_string(),
                status: status.unwrap_or_else(|| "open".to_string()),
                assignee_id: row
                    .get::<Option<Uuid>, _>("assignee_staff_id")
                    .map(|id| id.to_string()),
                search_text,
            });
        }
    }
    if !task_batch.is_empty() {
        enqueue_documents(&index_tasks, &task_batch, &mut task_tasks).await?;
    }
    wait_pending_tasks(client, task_tasks).await?;
    swap_temp_into_live(client, INDEX_TASKS, &temp_tasks).await?;
    record_sync_status(pool, INDEX_TASKS, true, task_batch.len() as i64, None).await;

    // 13. Alterations
    #[derive(sqlx::FromRow)]
    struct AlterationReindexRow {
        id: Uuid,
        customer_id: Uuid,
        status: String,
        customer_first_name: Option<String>,
        customer_last_name: Option<String>,
        customer_code: Option<String>,
        customer_email: Option<String>,
        customer_phone: Option<String>,
        address_line1: Option<String>,
        city: Option<String>,
        state: Option<String>,
        postal_code: Option<String>,
        transaction_display_id: Option<String>,
        item_description: Option<String>,
        work_requested: Option<String>,
        notes: Option<String>,
        source_sku: Option<String>,
    }

    let temp_alterations = reindex_temp_uid(INDEX_ALTERATIONS);
    let index_alterations =
        prepare_temp_index(client, INDEX_ALTERATIONS, &temp_alterations).await?;
    let mut alteration_tasks = Vec::new();
    let mut alteration_stream = sqlx::query_as::<_, AlterationReindexRow>(
        r#"
        SELECT
            a.id,
            a.customer_id,
            a.status::text AS status,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            c.customer_code,
            c.email AS customer_email,
            c.phone AS customer_phone,
            c.address_line1,
            c.city,
            c.state,
            c.postal_code,
            lt.display_id AS transaction_display_id,
            a.item_description,
            a.work_requested,
            a.notes,
            a.source_sku
        FROM alteration_orders a
        LEFT JOIN customers c ON c.id = a.customer_id
        LEFT JOIN transactions lt ON lt.id = COALESCE(a.transaction_id, a.source_transaction_id)
        "#,
    )
    .fetch(pool);
    let mut alteration_batch = Vec::new();
    while let Some(res) = alteration_stream.next().await {
        if let Ok(row) = res {
            let alteration_id_text = row.id.to_string();
            let search_text = build_alteration_search_text(
                &alteration_id_text,
                row.customer_first_name.as_deref(),
                row.customer_last_name.as_deref(),
                row.customer_code.as_deref(),
                row.customer_email.as_deref(),
                row.customer_phone.as_deref(),
                row.address_line1.as_deref(),
                row.city.as_deref(),
                row.state.as_deref(),
                row.postal_code.as_deref(),
                row.transaction_display_id.as_deref(),
                row.item_description.as_deref(),
                row.work_requested.as_deref(),
                row.notes.as_deref(),
                row.source_sku.as_deref(),
            );
            alteration_batch.push(AlterationDoc {
                id: alteration_id_text,
                customer_id: row.customer_id.to_string(),
                status_open: row.status != "picked_up",
                search_text,
            });
        }
    }
    if !alteration_batch.is_empty() {
        enqueue_documents(&index_alterations, &alteration_batch, &mut alteration_tasks).await?;
    }
    wait_pending_tasks(client, alteration_tasks).await?;
    swap_temp_into_live(client, INDEX_ALTERATIONS, &temp_alterations).await?;
    record_sync_status(
        pool,
        INDEX_ALTERATIONS,
        true,
        alteration_batch.len() as i64,
        None,
    )
    .await;

    tracing::info!(variants = n_variants, "Meilisearch reindex completed");
    Ok(())
}
