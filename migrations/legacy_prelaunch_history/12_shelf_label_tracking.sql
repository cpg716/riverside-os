-- Barcode-first ops: distinguish variants that have never been marked as shelf-labeled
-- (existing rows are treated as already labeled).

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS shelf_labeled_at TIMESTAMPTZ;

UPDATE product_variants
SET shelf_labeled_at = COALESCE(shelf_labeled_at, NOW())
WHERE shelf_labeled_at IS NULL;

COMMENT ON COLUMN product_variants.shelf_labeled_at IS
    'When the shelf/thermal label was last marked printed; NULL on new rows until labeled.';
