-- Online store: web catalog flags, sale channel, CMS pages, coupons, destination tax v1.

CREATE TYPE sale_channel AS ENUM ('register', 'web');

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS sale_channel sale_channel NOT NULL DEFAULT 'register';

COMMENT ON COLUMN orders.sale_channel IS 'register = in-store/POS checkout; web = first-party storefront (reporting).';

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS web_published BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS web_price_override NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS web_gallery_order INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN product_variants.web_published IS 'When true, variant eligible for public storefront (requires product catalog_handle and active template).';
COMMENT ON COLUMN product_variants.web_price_override IS 'Optional web-only unit price; falls back to COALESCE(retail_price_override, base_retail_price).';
COMMENT ON COLUMN product_variants.web_gallery_order IS 'Sort order for variant images on PDP (ascending).';

CREATE TABLE store_pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    seo_title TEXT,
    published BOOLEAN NOT NULL DEFAULT false,
    project_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    published_html TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX store_pages_slug_lower_uidx ON store_pages (lower(slug));

CREATE TYPE store_coupon_kind AS ENUM ('percent', 'fixed_amount', 'free_shipping');

CREATE TABLE store_coupons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT NOT NULL,
    kind store_coupon_kind NOT NULL,
    value NUMERIC(12, 4) NOT NULL DEFAULT 0,
    max_discount_usd NUMERIC(12, 2),
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    min_subtotal_usd NUMERIC(12, 2),
    max_uses INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    allow_stack BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX store_coupons_code_lower_uidx ON store_coupons (lower(trim(code)));

CREATE TABLE order_coupon_redemptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    coupon_id UUID NOT NULL REFERENCES store_coupons (id) ON DELETE RESTRICT,
    discount_amount NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_coupon_redemptions_order_coupon_uidx UNIQUE (order_id, coupon_id)
);

CREATE TABLE store_tax_state_rate (
    state_code CHAR(2) PRIMARY KEY,
    combined_rate NUMERIC(9, 6) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO store_tax_state_rate (state_code, combined_rate)
VALUES
    ('NY', 0.087500),
    ('PA', 0.060000),
    ('OH', 0.057500),
    ('CA', 0.072500),
    ('TX', 0.062500)
ON CONFLICT (state_code) DO NOTHING;

INSERT INTO staff_role_permission (role, permission_key, allowed)
VALUES
    ('admin', 'online_store.manage', true),
    ('sales_support', 'online_store.manage', true),
    ('salesperson', 'online_store.manage', false)
ON CONFLICT (role, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;

INSERT INTO store_pages (slug, title, seo_title, published, published_html)
SELECT
    'home',
    'Home',
    'Welcome',
    true,
    '<section class="ros-store-page"><h1>Welcome</h1><p>Browse our catalog online.</p><p><a href="/shop/products">View products</a></p></section>'
WHERE NOT EXISTS (SELECT 1 FROM store_pages WHERE lower(slug) = 'home');
