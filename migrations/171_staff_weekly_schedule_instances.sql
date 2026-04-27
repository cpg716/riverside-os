-- Migration 171: Staff weekly schedule instances for per-week publishing.
--
-- MASTER stays as the base template in `staff_weekly_availability`.
-- This migration adds per-week staff overrides used for future week planning:
-- draft/published/archived week windows and explicit weekday shifts.

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staff_weekly_schedule_status') THEN
        CREATE TYPE staff_weekly_schedule_status AS ENUM ('draft', 'published', 'archived');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS staff_weekly_schedule (
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    status staff_weekly_schedule_status NOT NULL DEFAULT 'draft',
    created_by_staff_id UUID NOT NULL REFERENCES staff(id),
    updated_by_staff_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (staff_id, week_start)
);

CREATE TABLE IF NOT EXISTS staff_weekly_schedule_day (
    staff_id UUID NOT NULL,
    week_start DATE NOT NULL,
    weekday SMALLINT NOT NULL CHECK (weekday >= 0 AND weekday <= 6),
    works BOOLEAN NOT NULL DEFAULT TRUE,
    shift_label TEXT,
    PRIMARY KEY (staff_id, week_start, weekday),
    CONSTRAINT staff_weekly_schedule_day_fk
        FOREIGN KEY (staff_id, week_start)
        REFERENCES staff_weekly_schedule (staff_id, week_start)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_staff_weekly_schedule_week
    ON staff_weekly_schedule (week_start, staff_id);

CREATE INDEX IF NOT EXISTS idx_staff_weekly_schedule_day_week
    ON staff_weekly_schedule_day (week_start, staff_id, weekday);

CREATE OR REPLACE FUNCTION staff_effective_working_day(p_staff_id uuid, p_d date)
RETURNS boolean AS $$
DECLARE
    r staff_role;
    wd int;
    ex staff_schedule_exception_kind;
    w boolean;
    ws_works boolean;
    ws_week_start date;
BEGIN
    SELECT s.role INTO r FROM staff s WHERE s.id = p_staff_id;
    
    -- If no staff or non-floor staff, treat as "always available" for system logic.
    IF r IS NULL THEN
        RETURN TRUE;
    END IF;
    
    IF r NOT IN ('salesperson', 'sales_support', 'staff_support', 'alterations') THEN
        RETURN TRUE;
    END IF;

    wd := EXTRACT(DOW FROM p_d)::int;
    ws_week_start := (p_d::date - (EXTRACT(DOW FROM p_d)::int * INTERVAL '1 day'))::date;

    -- Check for specific day exceptions (PTO, Sick, Extra Shift)
    SELECT e.kind INTO ex
    FROM staff_day_exception e
    WHERE e.staff_id = p_staff_id AND e.exception_date = p_d;

    IF FOUND THEN
        RETURN ex = 'extra_shift';
    END IF;

    -- Check for published week-level schedule overrides for this date.
    SELECT swd.works INTO ws_works
    FROM staff_weekly_schedule sws
    JOIN staff_weekly_schedule_day swd
      ON swd.staff_id = sws.staff_id
     AND swd.week_start = sws.week_start
     AND swd.weekday = wd
    WHERE sws.staff_id = p_staff_id
      AND sws.week_start = ws_week_start
      AND sws.status = 'published'
    LIMIT 1;

    IF FOUND THEN
        RETURN ws_works;
    END IF;

    -- Default to template availability.
    SELECT a.works INTO w
    FROM staff_weekly_availability a
    WHERE a.staff_id = p_staff_id AND a.weekday = wd;

    IF FOUND THEN
        RETURN w;
    END IF;

    -- Default to OFF for floor/support/alterations staff (Opt-In model).
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;
