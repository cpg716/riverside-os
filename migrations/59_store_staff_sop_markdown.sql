-- Migration 59: Store-specific staff SOP / playbook (markdown), editable by settings.admin in-app.

ALTER TABLE store_settings
ADD COLUMN IF NOT EXISTS staff_sop_markdown TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN store_settings.staff_sop_markdown IS 'Per-store operating notes for staff training and AI help (Markdown). Edited in Back Office Settings → General. Empty means no custom SOP is stored.';
