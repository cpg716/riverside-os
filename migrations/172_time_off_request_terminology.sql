-- Update staff schedule exception categories to support "Time Off Request" terminology.
-- Adds Vacation, Doctors Appt, and Other to the enum.

DO $$ BEGIN
    ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'vacation';
    ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'doctors_appt';
    ALTER TYPE staff_schedule_exception_kind ADD VALUE IF NOT EXISTS 'other';
END $$;
