-- ROSIE runtime / UI preference defaults (store-level, optional).
ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS rosie_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN store_settings.rosie_config IS
    'ROSIE assistant defaults: enabled, direct_mode_enabled, verbosity, show_citations. Local workstation overrides stay client-side.';
