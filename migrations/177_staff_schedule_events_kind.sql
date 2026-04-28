-- Migration 177: Add kind to staff schedule events
-- 
-- Allows distinguishing between meetings, store events, and holidays.

ALTER TABLE staff_schedule_events ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'meeting';
