-- Store-level Podium review invite policy (Settings → General).

ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS review_policy JSONB NOT NULL DEFAULT '{"review_invites_enabled": true, "send_review_invite_by_default": true}'::jsonb;

COMMENT ON COLUMN store_settings.review_policy IS 'Podium post-sale review invites: review_invites_enabled, send_review_invite_by_default. See docs/PLAN_PODIUM_REVIEWS.md.';
