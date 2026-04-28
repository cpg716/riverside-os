-- Add highlight support for non-standard shifts
ALTER TABLE staff_weekly_schedule_day ADD COLUMN IF NOT EXISTS is_highlighted BOOLEAN DEFAULT FALSE;
ALTER TABLE staff_weekly_availability ADD COLUMN IF NOT EXISTS is_highlighted BOOLEAN DEFAULT FALSE;
