-- Add highlight support for non-standard shifts
ALTER TABLE staff_weekly_schedule_day ADD COLUMN is_highlighted BOOLEAN DEFAULT FALSE;
ALTER TABLE staff_weekly_availability ADD COLUMN is_highlighted BOOLEAN DEFAULT FALSE;
