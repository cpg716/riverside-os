-- Migration 174: Enforce strict "Published Only" logic for effective working days.
--
-- Previously, the system would fall back to the Master Template (staff_weekly_availability)
-- if no weekly override was published.
-- The user now requires that only explicitly PUBLISHED schedules show in views 
-- and are considered "working" by the system.

CREATE OR REPLACE FUNCTION staff_effective_working_day(p_staff_id uuid, p_d date)
RETURNS boolean AS $$
DECLARE
    r staff_role;
    wd int;
    ex staff_schedule_exception_kind;
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

    -- 1. Check for specific day exceptions (PTO, Sick, Extra Shift)
    -- Exceptions are considered "Finalized" events.
    SELECT e.kind INTO ex
    FROM staff_day_exception e
    WHERE e.staff_id = p_staff_id AND e.exception_date = p_d;

    IF FOUND THEN
        RETURN ex = 'extra_shift';
    END IF;

    -- 2. Check for PUBLISHED week-level schedule overrides for this date.
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

    -- 3. REMOVED: Fallback to template availability.
    -- The user explicitly requested that unpublished drafts or missing schedules 
    -- should NOT show as working days.
    
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;
