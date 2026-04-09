-- Visual Crossing (or mock) weather integration settings (JSONB).
ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS weather_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN store_settings.weather_config IS 'Visual Crossing Timeline API: enabled, location, unit_group, timezone, api_key (server-only).';
