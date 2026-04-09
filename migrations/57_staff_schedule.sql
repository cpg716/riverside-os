-- Staff weekly availability + day exceptions (sick/PTO/etc.) for salesperson & sales_support.
-- Drives task materialization skips, appointment booking checks, and absence workflows.

CREATE TYPE staff_schedule_exception_kind AS ENUM (
    'sick',
    'pto',
    'missed_shift',
    'extra_shift'
);

CREATE TABLE staff_weekly_availability (
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    weekday SMALLINT NOT NULL CHECK (weekday >= 0 AND weekday <= 6),
    works BOOLEAN NOT NULL,
    PRIMARY KEY (staff_id, weekday)
);

CREATE TABLE staff_day_exception (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    exception_date DATE NOT NULL,
    kind staff_schedule_exception_kind NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    UNIQUE (staff_id, exception_date)
);

CREATE INDEX idx_staff_day_exception_date ON staff_day_exception (exception_date);

-- Default template: Sunday off, Mon–Sat on (US DOW: 0 = Sunday).
INSERT INTO staff_weekly_availability (staff_id, weekday, works)
SELECT s.id, gs.w, (gs.w <> 0)
FROM staff s
CROSS JOIN generate_series(0, 6) AS gs(w)
WHERE s.role IN ('salesperson', 'sales_support')
  AND s.is_active = TRUE
ON CONFLICT (staff_id, weekday) DO NOTHING;

-- Single source of truth for “should this staff be treated as working on date?”
CREATE OR REPLACE FUNCTION staff_effective_working_day(p_staff_id uuid, p_d date)
RETURNS boolean AS $$
DECLARE
    r staff_role;
    wd int;
    ex staff_schedule_exception_kind;
    w boolean;
BEGIN
    SELECT s.role INTO r FROM staff s WHERE s.id = p_staff_id;
    IF r IS NULL THEN
        RETURN TRUE;
    END IF;
    IF r NOT IN ('salesperson', 'sales_support') THEN
        RETURN TRUE;
    END IF;

    wd := EXTRACT(DOW FROM p_d)::int;

    SELECT e.kind INTO ex
    FROM staff_day_exception e
    WHERE e.staff_id = p_staff_id AND e.exception_date = p_d;

    IF FOUND THEN
        RETURN ex = 'extra_shift';
    END IF;

    SELECT a.works INTO w
    FROM staff_weekly_availability a
    WHERE a.staff_id = p_staff_id AND a.weekday = wd;

    IF FOUND THEN
        RETURN w;
    END IF;

    -- No row: same default as seed (Sun off).
    RETURN wd <> 0;
END;
$$ LANGUAGE plpgsql STABLE;
