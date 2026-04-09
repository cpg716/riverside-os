-- Per-product employee sale: optional markup % override + per-unit flat add-on after cost×(1+markup%).
-- Discount events (promotions): scope by selected variants, whole category, or primary vendor.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS employee_markup_percent NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS employee_extra_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_employee_extra_nonneg;

ALTER TABLE products
    ADD CONSTRAINT products_employee_extra_nonneg CHECK (employee_extra_amount >= 0);

COMMENT ON COLUMN products.employee_markup_percent IS
    'When set, overrides store_settings.employee_markup_percent for employee sale price on this template (variants inherit).';
COMMENT ON COLUMN products.employee_extra_amount IS
    'Per-unit amount added after cost × (1 + effective markup%) for employee sales; non-negative.';

ALTER TABLE discount_events
    ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'variants',
    ADD COLUMN IF NOT EXISTS scope_category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS scope_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL;

UPDATE discount_events
SET scope_type = 'variants'
WHERE scope_type IS NULL OR trim(scope_type) = '';

ALTER TABLE discount_events
    DROP CONSTRAINT IF EXISTS discount_events_scope_chk;

ALTER TABLE discount_events
    ADD CONSTRAINT discount_events_scope_chk CHECK (
        scope_type IN ('variants', 'category', 'vendor')
        AND (
            (scope_type = 'variants' AND scope_category_id IS NULL AND scope_vendor_id IS NULL)
            OR (
                scope_type = 'category'
                AND scope_category_id IS NOT NULL
                AND scope_vendor_id IS NULL
            )
            OR (
                scope_type = 'vendor'
                AND scope_vendor_id IS NOT NULL
                AND scope_category_id IS NULL
            )
        )
    );

INSERT INTO ros_schema_migrations (version) VALUES ('93_employee_pricing_per_product_promo_scope.sql')
ON CONFLICT (version) DO NOTHING;
