-- Per-staff notification category preferences for the in-app inbox.

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN staff.notification_preferences IS
    'Per-staff notification inbox preferences. Configurable categories default to enabled; critical system/admin alerts remain mandatory in application logic.';
