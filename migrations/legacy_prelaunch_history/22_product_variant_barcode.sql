-- Optional retail barcode / UPC (distinct from internal SKU when used).
ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS barcode TEXT;

CREATE INDEX IF NOT EXISTS idx_product_variants_barcode_lower
    ON product_variants (lower(trim(barcode)))
    WHERE barcode IS NOT NULL AND trim(barcode) <> '';

COMMENT ON COLUMN product_variants.barcode IS
    'POS scan code (UPC/EAN); resolve alongside SKU and product name.';
