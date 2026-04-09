-- Riverside OS — dummy catalog for relational inventory engine
-- Run after migrations/01_initial_schema.sql
-- Idempotent: safe to re-run.

-- Categories
INSERT INTO categories (id, name, is_clothing_footwear)
VALUES
    ('10000000-0000-0000-0000-000000000001', 'Apparel', true),
    ('10000000-0000-0000-0000-000000000002', 'Accessories', false),
    ('10000000-0000-0000-0000-000000000003', 'Services', false),
    ('10000000-0000-0000-0000-000000000004', 'Suits', true)
ON CONFLICT (id) DO NOTHING;

UPDATE categories
SET parent_id = '10000000-0000-0000-0000-000000000001'
WHERE id = '10000000-0000-0000-0000-000000000004';

-- Products
INSERT INTO products (
    id, category_id, name, brand, description,
    base_retail_price, base_cost, spiff_amount, variation_axes
)
VALUES
    (
        'a1b2c3d4-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000004',
        'Navy Sharkskin Suit',
        'Hart Schaffner Marx',
        'Two-button notch lapel sharkskin suit',
        895.00,
        350.00,
        25.00,
        ARRAY['Model', 'Color', 'Size']
    ),
    (
        'e5f6a7b8-0000-0000-0000-000000000002',
        '10000000-0000-0000-0000-000000000002',
        'Silk Woven Tie',
        'Eton',
        'Classic woven silk tie',
        95.00,
        35.00,
        0.00,
        ARRAY['Color', 'Size']
    ),
    (
        'b1955001-0001-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000003',
        'Basic Hem',
        'Alterations',
        'Basic pant hem alteration',
        35.00,
        0.00,
        0.00,
        ARRAY['Type']
    ),
    (
        'b1955001-0002-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000003',
        'Waist Alteration',
        'Alterations',
        'Waist in/out alteration service',
        45.00,
        0.00,
        0.00,
        ARRAY['Type']
    ),
    (
        'b1955001-0003-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000003',
        'Suit Steam / Press',
        'House',
        'Steam and press service',
        25.00,
        0.00,
        0.00,
        ARRAY['Type']
    ),
    (
        'b1955001-0004-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000003',
        'Gift Card (open)',
        'House',
        'Open value gift card activation',
        25.00,
        0.00,
        0.00,
        ARRAY['Type']
    ),
    (
        'b1955001-0005-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000003',
        'Miscellaneous Fee',
        'House',
        'Generic fee item',
        10.00,
        0.00,
        0.00,
        ARRAY['Type']
    )
ON CONFLICT (id) DO NOTHING;

-- Variants
INSERT INTO product_variants (
    product_id, sku, variation_values, variation_label, stock_on_hand
)
VALUES
    (
        'a1b2c3d4-0000-0000-0000-000000000001',
        'HSM-NAVY-42R',
        '{"Model":"Slim","Color":"Navy","Size":"42R"}',
        '42R',
        3
    ),
    (
        'a1b2c3d4-0000-0000-0000-000000000001',
        'HSM-NAVY-44L',
        '{"Model":"Slim","Color":"Navy","Size":"44L"}',
        '44L',
        1
    ),
    (
        'a1b2c3d4-0000-0000-0000-000000000001',
        'HSM-NAVY-54XL',
        '{"Model":"Classic","Color":"Navy","Size":"54XL"}',
        '54XL',
        1
    ),
    (
        'e5f6a7b8-0000-0000-0000-000000000002',
        'ETON-TIE-BLU',
        '{"Color":"Blue","Size":"One Size"}',
        'Blue/One Size',
        5
    ),
    (
        'b1955001-0001-0000-0000-000000000001',
        'SVC-HEM-BASIC',
        '{"Type":"Service"}',
        'Service',
        999
    ),
    (
        'b1955001-0002-0000-0000-000000000001',
        'SVC-WAIST-ALT',
        '{"Type":"Service"}',
        'Service',
        999
    ),
    (
        'b1955001-0003-0000-0000-000000000001',
        'SVC-PRESS',
        '{"Type":"Service"}',
        'Service',
        999
    ),
    (
        'b1955001-0004-0000-0000-000000000001',
        'SVC-GIFT-CARD',
        '{"Type":"Service"}',
        'Service',
        999
    ),
    (
        'b1955001-0005-0000-0000-000000000001',
        'SVC-MISC-FEE',
        '{"Type":"Service"}',
        'Service',
        999
    )
ON CONFLICT (sku) DO NOTHING;

-- Variant override sample
UPDATE product_variants
SET retail_price_override = 995.00, cost_override = 400.00
WHERE sku = 'HSM-NAVY-54XL';

INSERT INTO vendors (name, email, phone)
VALUES ('Mainline Formalwear', 'orders@mainline.example', '716-555-1000')
ON CONFLICT (name) DO NOTHING;
