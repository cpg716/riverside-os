-- Product-level tax override for parent product templates.
-- NULL means "inherit from category ancestry"; non-NULL lets a parent product
-- explicitly classify itself for tax when category inheritance is too broad.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS tax_category_override tax_category DEFAULT NULL;

COMMENT ON COLUMN products.tax_category_override IS
    'Optional POS tax classification override for this parent product. NULL inherits from category ancestry.';
