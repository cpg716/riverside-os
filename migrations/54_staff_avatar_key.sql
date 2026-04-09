-- Per-staff portrait slug for bundled SVGs (client public/staff-avatars/{key}.svg). Server validates against allowlist.
ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS avatar_key TEXT NOT NULL DEFAULT 'ros_default';

COMMENT ON COLUMN staff.avatar_key IS 'Stable key for bundled staff avatar SVG; validated server-side.';
