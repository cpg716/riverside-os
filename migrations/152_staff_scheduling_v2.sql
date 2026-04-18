-- Migration 152: Staff scheduling V2
-- Adds staff_support and alterations roles, and supports shift labels for display/printing and future appointment granularity.

-- 1. Expand the staff_role enum
-- Note: value additions to enums cannot be done in a transaction block in some Postgres versions, 
-- but our DO blocks or separate statements usually handle it fine in migrations.
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'staff_support';
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'alterations';

-- 2. Add shift_label to availability and exceptions
ALTER TABLE staff_weekly_availability ADD COLUMN IF NOT EXISTS shift_label TEXT;
ALTER TABLE staff_day_exception ADD COLUMN IF NOT EXISTS shift_label TEXT;

-- 3. Update visibility function to include new roles
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
    
    -- Now including staff_support and alterations in the scheduling constraints
    IF r NOT IN ('salesperson', 'sales_support', 'staff_support', 'alterations') THEN
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

    -- Default to OFF for floor/support/alterations staff (Opt-In model)
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;
