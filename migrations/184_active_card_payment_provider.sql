-- Active card terminal provider setting.
-- Stripe remains the default for compatibility; Helcim can be selected before go-live.

ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS active_card_provider TEXT NOT NULL DEFAULT 'stripe';

UPDATE store_settings
SET active_card_provider = 'stripe'
WHERE active_card_provider IS NULL
   OR active_card_provider NOT IN ('stripe', 'helcim');

ALTER TABLE store_settings
    DROP CONSTRAINT IF EXISTS store_settings_active_card_provider_chk;

ALTER TABLE store_settings
    ADD CONSTRAINT store_settings_active_card_provider_chk
        CHECK (active_card_provider IN ('stripe', 'helcim'));

COMMENT ON COLUMN store_settings.active_card_provider IS
    'Active card terminal provider selected in Settings. Allowed values: stripe, helcim. Stripe remains the default compatibility provider.';
