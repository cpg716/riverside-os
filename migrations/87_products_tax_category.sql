-- products.tax_category: loyalty accrual and return clawback join on this column (see server/src/logic/loyalty.rs).
-- Inventory tax at POS still resolves from category ancestry in services/inventory.rs; this column backs catalog + loyalty rules.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tax_category') THEN
        DO $$ BEGIN CREATE TYPE tax_category AS ENUM ('clothing', 'footwear', 'accessory', 'service'); EXCEPTION WHEN duplicate_object THEN null; END $$;
    END IF;
END
$$;

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS tax_category tax_category NOT NULL DEFAULT 'clothing';

COMMENT ON COLUMN products.tax_category IS
    'NYS-style class: service excludes loyalty accrual; default clothing for legacy rows.';
