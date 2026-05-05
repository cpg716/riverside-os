-- Podium SMS / storefront widget settings (non-secret fields). OAuth secrets use server env — see logic/podium.rs.
ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS podium_sms_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN store_settings.podium_sms_config IS 'Podium: sms_send_enabled, location_uid, widget_embed_enabled, widget_snippet_html, sms_templates (ready_for_pickup, alteration_ready, unknown_sender_welcome). OAuth client id/secret/refresh token live in env only.';
