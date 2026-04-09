-- POS gift card load: ledger credit only after paid checkout (cart line + order_id on events).
-- Standalone POST /api/gift-cards/pos-load-purchased remains for emergencies; register UI uses this line.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pos_line_kind_chk;

ALTER TABLE products
    ADD CONSTRAINT products_pos_line_kind_chk CHECK (
        pos_line_kind IS NULL
        OR pos_line_kind IN ('rms_charge_payment', 'pos_gift_card_load')
    );

COMMENT ON COLUMN products.pos_line_kind IS
    'POS-only line semantics. rms_charge_payment = R2S payment collection; pos_gift_card_load = purchased card value (credit on paid checkout).';

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
    'b7c0a004-0004-4004-8004-000000000004'::uuid,
    (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1),
    'ros-pos-gift-card-load',
    'POS GIFT CARD LOAD',
    'Riverside OS',
    'Register gift card value — add from Gift Card button; credit applies when the sale is fully paid.',
    0.00,
    0.00,
    0.00,
    '{}'::text[],
    '{}'::text[],
    true,
    false,
    true,
    'pos_gift_card_load'
)
ON CONFLICT (catalog_handle) DO UPDATE SET
    pos_line_kind = 'pos_gift_card_load',
    excludes_from_loyalty = true,
    name = EXCLUDED.name,
    category_id = (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1);

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
    'b7c0a005-0005-4005-8005-000000000005'::uuid,
    'b7c0a004-0004-4004-8004-000000000004'::uuid,
    'ROS-POS-GIFT-CARD-LOAD',
    '{}'::jsonb,
    NULL,
    0,
    0,
    0,
    false
)
ON CONFLICT (sku) DO UPDATE SET
    product_id = 'b7c0a004-0004-4004-8004-000000000004'::uuid;
