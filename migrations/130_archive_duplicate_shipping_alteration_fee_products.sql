-- Keep the canonical, non-stock ALTERATION SERVICE product and retire legacy
-- fee pseudo-products. Historical transaction lines keep their product/variant
-- references; only future catalog/search use is disabled.
WITH duplicate_fee_products AS (
    SELECT DISTINCT p.id
    FROM products p
    LEFT JOIN product_variants pv ON pv.product_id = p.id
    WHERE p.id <> 'b7c0a006-0006-4006-8006-000000000006'::uuid
      AND (
          p.name ILIKE '%ALTERATION%'
          OR p.name ILIKE '%SHIPPING%'
          OR p.catalog_handle ILIKE '%ALTERATION%'
          OR p.catalog_handle ILIKE '%SHIPPING%'
          OR pv.sku ILIKE '%ALTERATION%'
          OR pv.sku ILIKE '%SHIPPING%'
          OR pv.variation_label ILIKE '%ALTERATION%'
          OR pv.variation_label ILIKE '%SHIPPING%'
      )
)
UPDATE product_variants pv
SET hidden_from_inventory = TRUE,
    web_published = FALSE
FROM duplicate_fee_products duplicate
WHERE pv.product_id = duplicate.id;

UPDATE products p
SET is_active = FALSE
WHERE p.id <> 'b7c0a006-0006-4006-8006-000000000006'::uuid
  AND (
      p.name ILIKE '%ALTERATION%'
      OR p.name ILIKE '%SHIPPING%'
      OR p.catalog_handle ILIKE '%ALTERATION%'
      OR p.catalog_handle ILIKE '%SHIPPING%'
      OR EXISTS (
          SELECT 1
          FROM product_variants pv
          WHERE pv.product_id = p.id
            AND (
                pv.sku ILIKE '%ALTERATION%'
                OR pv.sku ILIKE '%SHIPPING%'
                OR pv.variation_label ILIKE '%ALTERATION%'
                OR pv.variation_label ILIKE '%SHIPPING%'
            )
      )
  );

-- Reassert the canonical fee product in case a prior manual cleanup hid it.
UPDATE products
SET is_active = TRUE,
    pos_line_kind = 'alteration_service',
    tax_category_override = 'service'
WHERE id = 'b7c0a006-0006-4006-8006-000000000006'::uuid;

UPDATE product_variants
SET hidden_from_inventory = FALSE,
    web_published = FALSE,
    track_low_stock = FALSE
WHERE id = 'b7c0a007-0007-4007-8007-000000000007'::uuid;
