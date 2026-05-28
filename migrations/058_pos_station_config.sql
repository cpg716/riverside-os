-- Add POS station configuration JSONB column for register lane limits and per-station printer config
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS pos_station_config JSONB DEFAULT '{}'::jsonb NOT NULL;
