ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS variation_axis_presets TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

UPDATE categories
SET variation_axis_presets = ARRAY_REMOVE(ARRAY[matrix_row_axis_key, matrix_col_axis_key], NULL)
WHERE variation_axis_presets = '{}'::TEXT[]
  AND (matrix_row_axis_key IS NOT NULL OR matrix_col_axis_key IS NOT NULL);

COMMENT ON COLUMN categories.variation_axis_presets IS
    'Ordered category default variation axis names for manual product creation, max 3 visible presets.';
