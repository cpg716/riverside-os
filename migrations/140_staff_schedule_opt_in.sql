-- Transition staff schedule to opt-in mode.
-- By default, staff members should NOT be treated as working unless explicitly scheduled.
-- This fixes the "everyone is listed" issue on the Operations Dashboard.

-- 1. Reset existing floor staff schedules to "Off" by default.
-- Users will need to re-enable them in the Staff Workspace Schedule tab.
UPDATE staff_weekly_availability
SET works = FALSE
WHERE staff_id IN (
    SELECT id FROM staff WHERE role IN ('salesperson', 'sales_support')
);

-- 2. Update the helper function to fallback to FALSE instead of Mon-Sat ON.
CREATE OR REPLACE FUNCTION staff_effective_working_day(p_staff_id uuid, p_d date)
RETURNS boolean AS $$
DECLARE
    r staff_role;
    wd int;
    ex staff_schedule_exception_kind;
    w boolean;
BEGIN
    SELECT s.role INTO r FROM staff s WHERE s.id = p_staff_id;
    
    -- If no staff or non-floor staff, treat as "always available" for system logic
    -- (but these aren't listed in the Floor Team UI due to role filters).
    IF r IS NULL THEN
        RETURN TRUE;
    END IF;
    IF r NOT IN ('salesperson', 'sales_support') THEN
        RETURN TRUE;
    END IF;

    wd := EXTRACT(DOW FROM p_d)::int;

    -- Check for specific day exceptions (PTO, Sick, Extra Shift)
    SELECT e.kind INTO ex
    FROM staff_day_exception e
    WHERE e.staff_id = p_staff_id AND e.exception_date = p_d;

    IF FOUND THEN
        RETURN ex = 'extra_shift';
    END IF;

    -- Check for weekly availability
    SELECT a.works INTO w
    FROM staff_weekly_availability a
    WHERE a.staff_id = p_staff_id AND a.weekday = wd;

    IF FOUND THEN
        RETURN w;
    END IF;

    -- FALLBACK: Previously returned wd <> 0 (Mon-Sat). 
    -- Now returns FALSE to ensure system is "Opt-In".
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;
