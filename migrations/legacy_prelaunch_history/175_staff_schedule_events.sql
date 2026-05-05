-- Migration 175: Staff Meetings and Store Events
--
-- Adds support for store-wide or group events and meetings.

-- 1. Sync and extend the exception kind enum
ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'vacation';
ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'doctors_appt';
ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'other';
ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'meeting';
ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'store_event';

-- 2. Create the events table
CREATE TABLE IF NOT EXISTS staff_schedule_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_date DATE NOT NULL,
    label TEXT NOT NULL,
    notes TEXT,
    is_all_staff BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create the attendees table
CREATE TABLE IF NOT EXISTS staff_schedule_event_attendees (
    event_id UUID NOT NULL REFERENCES staff_schedule_events(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_schedule_events_date ON staff_schedule_events(event_date);
