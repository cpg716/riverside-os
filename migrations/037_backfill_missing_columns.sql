-- 037: Backfill columns that were added to earlier migration files but not yet in the live schema.
-- store_media_asset: alt_text, usage_note, deleted_at
ALTER TABLE store_media_asset ADD COLUMN IF NOT EXISTS alt_text text;
ALTER TABLE store_media_asset ADD COLUMN IF NOT EXISTS usage_note text;
ALTER TABLE store_media_asset ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- categories: variation_axis_presets
ALTER TABLE categories ADD COLUMN IF NOT EXISTS variation_axis_presets text[] NOT NULL DEFAULT '{}'::text[];

-- Backfill variation_axis_presets from the legacy matrix row/col keys where empty.
UPDATE categories
SET variation_axis_presets = ARRAY_REMOVE(ARRAY[matrix_row_axis_key, matrix_col_axis_key], NULL)
WHERE variation_axis_presets = '{}'::text[]
  AND (matrix_row_axis_key IS NOT NULL OR matrix_col_axis_key IS NOT NULL);
