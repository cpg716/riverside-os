-- Online store Phase 4/5: growth tools, storefront control, media metadata, and publish history.

ALTER TABLE store_checkout_session
    ADD COLUMN IF NOT EXISTS source TEXT,
    ADD COLUMN IF NOT EXISTS medium TEXT,
    ADD COLUMN IF NOT EXISTS campaign_slug TEXT,
    ADD COLUMN IF NOT EXISTS checkout_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS abandoned_reason TEXT,
    ADD COLUMN IF NOT EXISTS account_conversion_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS store_checkout_session_campaign_idx
    ON store_checkout_session(campaign_slug)
    WHERE campaign_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS store_checkout_session_paid_at_idx
    ON store_checkout_session(paid_at DESC)
    WHERE paid_at IS NOT NULL;

ALTER TABLE store_media_asset
    ADD COLUMN IF NOT EXISTS alt_text TEXT,
    ADD COLUMN IF NOT EXISTS usage_note TEXT,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS store_media_asset_active_created_idx
    ON store_media_asset(created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS storefront_campaign (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    coupon_id UUID REFERENCES store_coupons(id) ON DELETE SET NULL,
    landing_page_slug TEXT,
    source TEXT,
    medium TEXT,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT storefront_campaign_slug_chk CHECK (btrim(slug) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS storefront_campaign_slug_lower_uidx
    ON storefront_campaign(lower(btrim(slug)));

DROP TRIGGER IF EXISTS trigger_storefront_campaign_updated_at
    ON storefront_campaign;
CREATE TRIGGER trigger_storefront_campaign_updated_at
BEFORE UPDATE ON storefront_campaign
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TABLE IF NOT EXISTS storefront_navigation_menu (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    handle TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT storefront_navigation_menu_handle_chk CHECK (btrim(handle) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS storefront_navigation_menu_handle_lower_uidx
    ON storefront_navigation_menu(lower(btrim(handle)));

CREATE TABLE IF NOT EXISTS storefront_navigation_item (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    menu_id UUID NOT NULL REFERENCES storefront_navigation_menu(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    item_kind TEXT NOT NULL DEFAULT 'custom',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT storefront_navigation_item_label_chk CHECK (btrim(label) <> ''),
    CONSTRAINT storefront_navigation_item_url_chk CHECK (btrim(url) <> ''),
    CONSTRAINT storefront_navigation_item_kind_chk CHECK (item_kind IN ('custom', 'page', 'product', 'collection', 'campaign'))
);

CREATE INDEX IF NOT EXISTS storefront_navigation_item_menu_order_idx
    ON storefront_navigation_item(menu_id, sort_order, created_at);

DROP TRIGGER IF EXISTS trigger_storefront_navigation_menu_updated_at
    ON storefront_navigation_menu;
CREATE TRIGGER trigger_storefront_navigation_menu_updated_at
BEFORE UPDATE ON storefront_navigation_menu
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

DROP TRIGGER IF EXISTS trigger_storefront_navigation_item_updated_at
    ON storefront_navigation_item;
CREATE TRIGGER trigger_storefront_navigation_item_updated_at
BEFORE UPDATE ON storefront_navigation_item
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

INSERT INTO storefront_navigation_menu (handle, title)
SELECT seed.handle, seed.title
FROM (
    VALUES
        ('header', 'Header'),
        ('footer', 'Footer')
) AS seed(handle, title)
WHERE NOT EXISTS (
    SELECT 1
    FROM storefront_navigation_menu m
    WHERE lower(btrim(m.handle)) = lower(btrim(seed.handle))
);

INSERT INTO storefront_navigation_item (menu_id, label, url, item_kind, sort_order)
SELECT m.id, seed.label, seed.url, seed.item_kind, seed.sort_order
FROM storefront_navigation_menu m
JOIN (
    VALUES
        ('header', 'Products', '/shop/products', 'custom', 10),
        ('header', 'Cart', '/shop/cart', 'custom', 20),
        ('footer', 'Account', '/shop/account', 'custom', 10)
) AS seed(handle, label, url, item_kind, sort_order)
    ON seed.handle = m.handle
WHERE NOT EXISTS (
    SELECT 1
    FROM storefront_navigation_item i
    WHERE i.menu_id = m.id
      AND i.url = seed.url
);

CREATE TABLE IF NOT EXISTS storefront_publish_revision (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    page_id UUID NOT NULL REFERENCES store_pages(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    project_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    published_html TEXT NOT NULL DEFAULT '',
    published_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storefront_publish_revision_page_idx
    ON storefront_publish_revision(page_id, published_at DESC);

ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS storefront_home_layout JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON TABLE storefront_campaign IS
    'Online Store campaign records for landing pages, coupons, and UTM-style attribution.';
COMMENT ON TABLE storefront_navigation_menu IS
    'Public storefront navigation menu headers such as header and footer.';
COMMENT ON TABLE storefront_navigation_item IS
    'Ordered public storefront navigation links controlled by ROS.';
COMMENT ON TABLE storefront_publish_revision IS
    'Published page snapshots for preview/history/restore workflows.';
