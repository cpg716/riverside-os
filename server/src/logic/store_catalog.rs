//! Public storefront catalog: published variants + product slug (`catalog_handle`).

use meilisearch_sdk::client::Client as MeilisearchClient;
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StoreProductSummary {
    pub product_id: Uuid,
    pub slug: String,
    pub name: String,
    pub brand: Option<String>,
    pub primary_image: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StoreVariantRow {
    pub variant_id: Uuid,
    pub sku: String,
    pub variation_values: Value,
    pub variation_label: Option<String>,
    pub stock_on_hand: i32,
    pub reserved_stock: i32,
    pub available_stock: i32,
    pub unit_price: Decimal,
    pub images: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StoreProductDetail {
    pub product_id: Uuid,
    pub slug: String,
    pub name: String,
    pub brand: Option<String>,
    pub description: Option<String>,
    pub variation_axes: Vec<String>,
    pub product_images: Vec<String>,
    pub variants: Vec<StoreVariantRow>,
}

pub async fn list_store_products(
    pool: &PgPool,
    search: Option<&str>,
    limit: i64,
    offset: i64,
    meilisearch: Option<&MeilisearchClient>,
) -> Result<Vec<StoreProductSummary>, sqlx::Error> {
    let lim = limit.clamp(1, 200);
    let off = offset.max(0);
    let trimmed_q = search.map(str::trim).filter(|s| !s.is_empty());

    if let Some(raw_q) = trimmed_q {
        if let Some(client) = meilisearch {
            match crate::logic::meilisearch_search::store_product_search_ids(client, raw_q).await {
                Ok(ids) if !ids.is_empty() => {
                    return sqlx::query_as::<_, StoreProductSummary>(
                        r#"
                        SELECT
                            p.id AS product_id,
                            btrim(p.catalog_handle) AS slug,
                            p.name,
                            p.brand,
                            CASE
                                WHEN p.images IS NOT NULL AND cardinality(p.images) > 0 THEN p.images[1]
                                ELSE NULL
                            END AS primary_image
                        FROM products p
                        WHERE p.is_active = true
                          AND p.catalog_handle IS NOT NULL
                          AND btrim(p.catalog_handle) <> ''
                          AND EXISTS (
                              SELECT 1 FROM product_variants pv
                              WHERE pv.product_id = p.id AND pv.web_published = true
                          )
                          AND p.id = ANY($1)
                        ORDER BY array_position($2::uuid[], p.id)
                        LIMIT $3 OFFSET $4
                        "#,
                    )
                    .bind(&ids[..])
                    .bind(&ids[..])
                    .bind(lim)
                    .bind(off)
                    .fetch_all(pool)
                    .await;
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Meilisearch storefront search failed; using PostgreSQL ILIKE"
                    );
                }
            }
        }

        let mut esc = String::new();
        for c in raw_q.chars() {
            match c {
                '\\' | '%' | '_' => {
                    esc.push('\\');
                    esc.push(c);
                }
                _ => esc.push(c),
            }
        }
        let pat = format!("%{esc}%");

        sqlx::query_as::<_, StoreProductSummary>(
            r#"
            SELECT
                p.id AS product_id,
                btrim(p.catalog_handle) AS slug,
                p.name,
                p.brand,
                CASE
                    WHEN p.images IS NOT NULL AND cardinality(p.images) > 0 THEN p.images[1]
                    ELSE NULL
                END AS primary_image
            FROM products p
            WHERE p.is_active = true
              AND p.catalog_handle IS NOT NULL
              AND btrim(p.catalog_handle) <> ''
              AND EXISTS (
                  SELECT 1 FROM product_variants pv
                  WHERE pv.product_id = p.id AND pv.web_published = true
              )
              AND (
                  p.name ILIKE $1 ESCAPE '\'
                  OR btrim(p.catalog_handle) ILIKE $1 ESCAPE '\'
                  OR COALESCE(p.brand, '') ILIKE $1 ESCAPE '\'
              )
            ORDER BY p.name
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(&pat)
        .bind(lim)
        .bind(off)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as::<_, StoreProductSummary>(
            r#"
            SELECT
                p.id AS product_id,
                btrim(p.catalog_handle) AS slug,
                p.name,
                p.brand,
                CASE
                    WHEN p.images IS NOT NULL AND cardinality(p.images) > 0 THEN p.images[1]
                    ELSE NULL
                END AS primary_image
            FROM products p
            WHERE p.is_active = true
              AND p.catalog_handle IS NOT NULL
              AND btrim(p.catalog_handle) <> ''
              AND EXISTS (
                  SELECT 1 FROM product_variants pv
                  WHERE pv.product_id = p.id AND pv.web_published = true
              )
            ORDER BY p.name
            LIMIT $1 OFFSET $2
            "#,
        )
        .bind(lim)
        .bind(off)
        .fetch_all(pool)
        .await
    }
}

pub async fn get_store_product_by_slug(
    pool: &PgPool,
    slug: &str,
) -> Result<Option<StoreProductDetail>, sqlx::Error> {
    let slug_norm = slug.trim().to_lowercase();
    if slug_norm.is_empty() {
        return Ok(None);
    }

    #[derive(sqlx::FromRow)]
    struct PRow {
        id: Uuid,
        catalog_handle: String,
        name: String,
        brand: Option<String>,
        description: Option<String>,
        variation_axes: Vec<String>,
        images: Vec<String>,
    }

    let product = sqlx::query_as::<_, PRow>(
        r#"
        SELECT
            p.id,
            btrim(p.catalog_handle) AS catalog_handle,
            p.name,
            p.brand,
            p.description,
            COALESCE(p.variation_axes, '{}'::text[]) AS variation_axes,
            COALESCE(p.images, '{}'::text[]) AS images
        FROM products p
        WHERE p.is_active = true
          AND p.catalog_handle IS NOT NULL
          AND btrim(p.catalog_handle) <> ''
          AND lower(btrim(p.catalog_handle)) = $1
          AND EXISTS (
              SELECT 1 FROM product_variants pv
              WHERE pv.product_id = p.id AND pv.web_published = true
          )
        "#,
    )
    .bind(&slug_norm)
    .fetch_optional(pool)
    .await?;

    let Some(p) = product else {
        return Ok(None);
    };

    let variant_rows = sqlx::query_as::<_, StoreVariantRow>(
        r#"
        SELECT
            pv.id AS variant_id,
            pv.sku,
            pv.variation_values,
            pv.variation_label,
            pv.stock_on_hand,
            pv.reserved_stock,
            GREATEST(0, pv.stock_on_hand - pv.reserved_stock)::integer AS available_stock,
            COALESCE(pv.web_price_override, pv.retail_price_override, p.base_retail_price) AS unit_price,
            COALESCE(pv.images, '{}'::text[]) AS images
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE pv.product_id = $1
          AND pv.web_published = true
        ORDER BY pv.web_gallery_order ASC, pv.sku
        "#,
    )
    .bind(p.id)
    .fetch_all(pool)
    .await?;

    Ok(Some(StoreProductDetail {
        product_id: p.id,
        slug: p.catalog_handle,
        name: p.name,
        brand: p.brand,
        description: p.description,
        variation_axes: p.variation_axes,
        product_images: p.images,
        variants: variant_rows,
    }))
}

/// Web-published variant row for cart resolution (public `/api/store/cart/lines`).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StoreWebVariantOffer {
    pub variant_id: Uuid,
    pub product_slug: String,
    pub product_name: String,
    pub sku: String,
    pub variation_label: Option<String>,
    pub available_stock: i32,
    pub unit_price: Decimal,
    pub primary_image: Option<String>,
}

pub async fn map_web_variants_by_id(
    pool: &PgPool,
    ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, StoreWebVariantOffer>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = sqlx::query_as::<_, StoreWebVariantOffer>(
        r#"
        SELECT
            pv.id AS variant_id,
            btrim(p.catalog_handle) AS product_slug,
            p.name AS product_name,
            pv.sku,
            pv.variation_label,
            GREATEST(0, pv.stock_on_hand - pv.reserved_stock)::integer AS available_stock,
            COALESCE(pv.web_price_override, pv.retail_price_override, p.base_retail_price) AS unit_price,
            CASE
                WHEN p.images IS NOT NULL AND cardinality(p.images) > 0 THEN p.images[1]
                ELSE NULL
            END AS primary_image
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE pv.id = ANY($1)
          AND p.is_active = true
          AND p.catalog_handle IS NOT NULL
          AND btrim(p.catalog_handle) <> ''
          AND pv.web_published = true
        "#,
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| (r.variant_id, r)).collect())
}
