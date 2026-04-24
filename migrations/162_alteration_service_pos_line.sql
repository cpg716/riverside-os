-- Phase 4: Register alteration service cart lines.
-- Alteration work orders are attached to garments. This internal product exists only so
-- free and charged alteration work can travel through checkout as visible service lines.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pos_line_kind_chk;

ALTER TABLE products
    ADD CONSTRAINT products_pos_line_kind_chk CHECK (
        pos_line_kind IS NULL
        OR pos_line_kind IN ('rms_charge_payment', 'pos_gift_card_load', 'alteration_service')
    );

COMMENT ON COLUMN products.pos_line_kind IS
    'POS-only line semantics. rms_charge_payment = R2S payment collection; pos_gift_card_load = purchased card value; alteration_service = register alteration work-order service line.';

INSERT INTO categories (id, name, is_clothing_footwear)
VALUES ('b7c0a001-0001-4001-8001-000000000001'::uuid, 'Internal / POS', false)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    is_clothing_footwear = EXCLUDED.is_clothing_footwear;

INSERT INTO products (
    id,
    category_id,
    catalog_handle,
    name,
    brand,
    description,
    base_retail_price,
    base_cost,
    spiff_amount,
    variation_axes,
    images,
    is_active,
    is_bundle,
    excludes_from_loyalty,
    pos_line_kind
)
VALUES (
    'b7c0a006-0006-4006-8006-000000000006'::uuid,
    (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1),
    'ros-alteration-service',
    'ALTERATION SERVICE',
    'Riverside OS',
    'Register alteration work-order service line. The source garment is tracked separately and is not sold again.',
    0.00,
    0.00,
    0.00,
    '{}'::text[],
    '{}'::text[],
    true,
    false,
    true,
    'alteration_service'
)
ON CONFLICT (catalog_handle) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    category_id = (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1),
    pos_line_kind = 'alteration_service',
    excludes_from_loyalty = true;

INSERT INTO product_variants (
    id,
    product_id,
    sku,
    variation_values,
    variation_label,
    stock_on_hand,
    reorder_point,
    reserved_stock,
    track_low_stock
)
VALUES (
    'b7c0a007-0007-4007-8007-000000000007'::uuid,
    'b7c0a006-0006-4006-8006-000000000006'::uuid,
    'ROS-ALTERATION-SERVICE',
    '{}'::jsonb,
    NULL,
    0,
    0,
    0,
    false
)
ON CONFLICT (sku) DO UPDATE SET
    product_id = 'b7c0a006-0006-4006-8006-000000000006'::uuid;

INSERT INTO ledger_mappings (internal_key, internal_description)
VALUES (
    'REVENUE_ALTERATIONS',
    'Alterations Income for charged register alteration service lines'
)
ON CONFLICT (internal_key) DO NOTHING;
