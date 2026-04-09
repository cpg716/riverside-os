-- Optional keys into product_variants.variation_values JSON for Matrix Hub row/column axes.
-- When set, the Product Hub uses these exact keys instead of name-based heuristics (shirts/pants/suits).
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS matrix_row_axis_key TEXT,
    ADD COLUMN IF NOT EXISTS matrix_col_axis_key TEXT;

COMMENT ON COLUMN categories.matrix_row_axis_key IS 'JSON key for matrix rows (e.g. Neck, Waist, Chest)';
COMMENT ON COLUMN categories.matrix_col_axis_key IS 'JSON key for matrix columns (e.g. Sleeve, Inseam, Length)';
