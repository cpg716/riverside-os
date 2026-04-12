use crate::logic::notifications;
use crate::logic::nuorder::{NuorderClient, NuorderOrder, NuorderProduct};
use crate::logic::store_media_asset;
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::PgPool;
use tracing::{error, info};
use uuid::Uuid;

pub struct SyncResult {
    pub created: i32,
    pub updated: i32,
    pub variants: i32,
    pub errors: Vec<String>,
}

pub async fn sync_catalog(
    pool: &PgPool,
    client: &NuorderClient,
    actor_staff_id: Option<Uuid>,
) -> anyhow::Result<SyncResult> {
    let sync_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO nuorder_sync_logs (id, sync_type, status) VALUES ($1, 'catalog', 'syncing')",
    )
    .bind(sync_id)
    .execute(pool)
    .await?;

    let products = client.fetch_products().await?;
    let mut stats = SyncResult {
        created: 0,
        updated: 0,
        variants: 0,
        errors: Vec::new(),
    };

    for p in products {
        match upsert_nuorder_product(pool, &p, actor_staff_id).await {
            Ok((is_new, variant_count)) => {
                if is_new {
                    stats.created += 1;
                } else {
                    stats.updated += 1;
                }
                stats.variants += variant_count;
            }
            Err(e) => {
                error!("Failed to sync product {}: {}", p.id, e);
                stats.errors.push(format!("Product {}: {}", p.id, e));
            }
        }
    }

    let status = if stats.errors.is_empty() {
        "success"
    } else if stats.created + stats.updated > 0 {
        "partial"
    } else {
        "failure"
    };

    sqlx::query(
        r#"
        UPDATE nuorder_sync_logs 
        SET status = $1, finished_at = NOW(), created_count = $2, updated_count = $3, error_message = $4
        WHERE id = $5
        "#
    )
    .bind(status)
    .bind(stats.created)
    .bind(stats.updated)
    .bind(if stats.errors.is_empty() { None } else { Some(stats.errors.join("; ")) })
    .bind(sync_id)
    .execute(pool)
    .await?;

    if status == "success" {
        let _ = notifications::emit_nuorder_sync_finished(
            pool,
            sync_id,
            "catalog",
            stats.created,
            stats.updated,
        )
        .await;
    } else {
        let _ = notifications::emit_nuorder_sync_failed(
            pool,
            sync_id,
            "catalog",
            &stats.errors.join("; "),
        )
        .await;
    }

    Ok(stats)
}

async fn upsert_nuorder_product(
    pool: &PgPool,
    p: &NuorderProduct,
    _mapped_by: Option<Uuid>,
) -> anyhow::Result<(bool, i32)> {
    let mut tx = pool.begin().await?;

    // 1. Resolve or create vendor
    let brand_name = p.brand_name.as_deref().unwrap_or("NuORDER Brand");

    let vendor_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM vendors WHERE nuorder_brand_id = $1")
            .bind(&p.brand_name)
            .fetch_optional(&mut *tx)
            .await?;

    let vendor_id: Uuid = if let Some(id) = vendor_id {
        info!("NuORDER brand {} resolved to vendor_id {}", brand_name, id);
        id
    } else {
        info!(
            "NuORDER brand {} search by ID {} failed; upserting by name",
            brand_name,
            p.brand_name.as_deref().unwrap_or("none")
        );
        sqlx::query_scalar(
            r#"
            INSERT INTO vendors (name, nuorder_brand_id)
            VALUES ($1, $2)
            ON CONFLICT (name) DO UPDATE SET nuorder_brand_id = EXCLUDED.nuorder_brand_id
            RETURNING id
            "#,
        )
        .bind(brand_name)
        .bind(&p.brand_name)
        .fetch_one(&mut *tx)
        .await?
    };

    // 2. Download and insert images (top 3)
    let mut image_ids = Vec::new();
    for url in p.image_urls.iter().take(3) {
        if let Ok(id) = download_and_insert_image(pool, url).await {
            image_ids.push(id.to_string());
        }
    }

    // 3. Upsert parent product
    let catalog_handle = p.style_number.as_deref().unwrap_or(&p.id);
    
    // We use a simpler approach to detect if it's new: check existence before insert/update
    let existing_product: Option<(Uuid, bool)> = sqlx::query_as(
        r#"
        SELECT id, true FROM products WHERE catalog_handle = $1
        "#
    )
    .bind(catalog_handle)
    .fetch_optional(&mut *tx)
    .await?;

    let (product_id, is_new, last_img_sync): (Uuid, bool, Option<DateTime<Utc>>) = if let Some((id, was_there)) = existing_product {
        // It exists, we will update it
        sqlx::query_as(
            r#"
            INSERT INTO products (catalog_handle, name, brand, base_retail_price, base_cost, images, vendor_id, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, true)
            ON CONFLICT (catalog_handle) DO UPDATE SET
                name = EXCLUDED.name,
                brand = EXCLUDED.brand,
                base_retail_price = EXCLUDED.base_retail_price,
                base_cost = EXCLUDED.base_cost,
                vendor_id = EXCLUDED.vendor_id,
                images = EXCLUDED.images
            RETURNING id, (xmax = 0) AS is_new, nuorder_last_image_sync_at
            "#,
        )
        .bind(catalog_handle)
        .bind(&p.name)
        .bind(brand_name)
        .bind(p.retail_price.unwrap_or(Decimal::ZERO))
        .bind(p.wholesale_price.unwrap_or(Decimal::ZERO))
        .bind(&image_ids)
        .bind(vendor_id)
        .fetch_one(&mut *tx)
        .await?
    } else {
        // It's new
        sqlx::query_as(
            r#"
            INSERT INTO products (catalog_handle, name, brand, base_retail_price, base_cost, images, vendor_id, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, true)
            ON CONFLICT (catalog_handle) DO UPDATE SET
                name = EXCLUDED.name,
                brand = EXCLUDED.brand,
                base_retail_price = EXCLUDED.base_retail_price,
                base_cost = EXCLUDED.base_cost,
                vendor_id = EXCLUDED.vendor_id,
                images = EXCLUDED.images
            RETURNING id, (xmax = 0) AS is_new, nuorder_last_image_sync_at
            "#,
        )
        .bind(catalog_handle)
        .bind(&p.name)
        .bind(brand_name)
        .bind(p.retail_price.unwrap_or(Decimal::ZERO))
        .bind(p.wholesale_price.unwrap_or(Decimal::ZERO))
        .bind(&image_ids)
        .bind(vendor_id)
        .fetch_one(&mut *tx)
        .await?
    };

    // Image refresh logic: if never synced or images was empty
    if last_img_sync.is_none() && !image_ids.is_empty() {
        sqlx::query("UPDATE products SET nuorder_last_image_sync_at = NOW() WHERE id = $1")
            .bind(product_id)
            .execute(&mut *tx)
            .await?;
    }

    // 4. Upsert variants
    let mut variant_count = 0;
    for v in &p.variants {
        let sku = v.upc.as_deref().unwrap_or(&v.id);
        let variation_values = json!({
            "color": v.color,
            "size": v.size
        });
        let label = format!(
            "{} / {}",
            v.color.as_deref().unwrap_or("?"),
            v.size.as_deref().unwrap_or("?")
        );

        sqlx::query(
            r#"
            INSERT INTO product_variants (product_id, sku, variation_values, variation_label, stock_on_hand, nuorder_id, vendor_upc)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (sku) DO UPDATE SET
                variation_values = EXCLUDED.variation_values,
                variation_label = EXCLUDED.variation_label,
                nuorder_id = COALESCE(product_variants.nuorder_id, EXCLUDED.nuorder_id),
                vendor_upc = COALESCE(product_variants.vendor_upc, EXCLUDED.vendor_upc)
            "#,
        )
        .bind(product_id)
        .bind(sku)
        .bind(variation_values)
        .bind(label)
        .bind(v.available_to_sell.unwrap_or(0))
        .bind(&v.id)
        .bind(&v.upc)
        .execute(&mut *tx)
        .await?;

        variant_count += 1;
    }

    tx.commit().await?;
    Ok((is_new, variant_count))
}

async fn download_and_insert_image(pool: &PgPool, url: &str) -> anyhow::Result<Uuid> {
    let resp = reqwest::get(url).await?;
    let bytes = resp.bytes().await?;
    let mime = "image/jpeg"; // Default or detect
    let id = store_media_asset::insert_image(pool, mime, None, &bytes, None)
        .await
        .map_err(|e| anyhow::anyhow!("Image store error: {e:?}"))?;
    Ok(id)
}

pub async fn sync_approved_orders(pool: &PgPool, client: &NuorderClient) -> anyhow::Result<i32> {
    let sync_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO nuorder_sync_logs (id, sync_type, status) VALUES ($1, 'orders', 'syncing')",
    )
    .bind(sync_id)
    .execute(pool)
    .await?;

    let orders = client.fetch_approved_orders().await?;
    let mut count = 0;
    let mut errors = Vec::new();

    for o in orders {
        match transform_nuorder_to_po(pool, &o).await {
            Ok(_) => count += 1,
            Err(e) => {
                error!("Failed to transform NuORDER order {}: {}", o.id, e);
                errors.push(format!("Order {}: {}", o.id, e));
            }
        }
    }

    let status = if errors.is_empty() {
        "success"
    } else if count > 0 {
        "partial"
    } else {
        "failure"
    };
    sqlx::query(
        "UPDATE nuorder_sync_logs SET status = $1, finished_at = NOW(), created_count = $2, error_message = $3 WHERE id = $4"
    )
    .bind(status)
    .bind(count)
    .bind(if errors.is_empty() { None } else { Some(errors.join("; ")) })
    .bind(sync_id)
    .execute(pool)
    .await?;

    if status == "success" {
        let _ = notifications::emit_nuorder_sync_finished(pool, sync_id, "orders", count, 0).await;
    } else {
        let _ =
            notifications::emit_nuorder_sync_failed(pool, sync_id, "orders", &errors.join("; "))
                .await;
    }

    Ok(count)
}

async fn transform_nuorder_to_po(pool: &PgPool, o: &NuorderOrder) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    // 1. Check if PO already exists
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM purchase_orders WHERE po_number = $1)")
            .bind(&o.order_number)
            .fetch_one(&mut *tx)
            .await?;

    if exists {
        return Ok(());
    }

    // 2. Resolve vendor (this integration assumes brand is configured)
    let vendor_id: Uuid =
        sqlx::query_scalar("SELECT id FROM vendors WHERE name = 'NuORDER Brand' LIMIT 1")
            .fetch_one(&mut *tx)
            .await?;

    // 3. Create PO
    let po_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO purchase_orders (po_number, vendor_id, status, notes)
        VALUES ($1, $2, 'submitted', $3)
        RETURNING id
        "#,
    )
    .bind(&o.order_number)
    .bind(vendor_id)
    .bind(format!("Imported from NuORDER. ID: {}", o.id))
    .fetch_one(&mut *tx)
    .await?;

    // 4. Add lines
    for item in &o.items {
        // Match by NuORDER ID, then SKU, then UPC
        let variant_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT id FROM product_variants 
            WHERE nuorder_id = $1 
               OR sku = $2 
               OR vendor_upc = $2
            LIMIT 1
            "#,
        )
        .bind(&item.variant_id)
        .bind(&item.sku)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(vid) = variant_id {
            sqlx::query(
                r#"
                INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity_ordered, unit_cost)
                VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(po_id)
            .bind(vid)
            .bind(item.quantity)
            .bind(item.wholesale_price)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}

pub async fn sync_inventory_ats(pool: &PgPool, client: &NuorderClient) -> anyhow::Result<i32> {
    // Only sync variants that were originally from NuORDER (or all with SKUs)
    let variants: Vec<(String, i32)> =
        sqlx::query_as("SELECT sku, stock_on_hand FROM product_variants WHERE sku IS NOT NULL")
            .fetch_all(pool)
            .await?;

    let mut count = 0;
    for (sku, stock) in variants {
        if client.update_inventory(&sku, stock).await.is_ok() {
            count += 1;
        }
    }

    Ok(count)
}
