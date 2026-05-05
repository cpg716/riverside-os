-- Active card terminal provider setting.

ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS active_card_provider TEXT NOT NULL DEFAULT 'helcim';

UPDATE store_settings
SET active_card_provider = 'helcim'
WHERE active_card_provider IS NULL
   OR active_card_provider <> 'helcim';

ALTER TABLE store_settings
    DROP CONSTRAINT IF EXISTS store_settings_active_card_provider_chk;

ALTER TABLE store_settings
    ADD CONSTRAINT store_settings_active_card_provider_chk
        CHECK (active_card_provider = 'helcim');

COMMENT ON COLUMN store_settings.active_card_provider IS
    'Active card terminal provider selected in Settings. Helcim is the only supported provider.';
