-- Keep schedule-eligible Admin staff under the same published-schedule rules as other operational roles.

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

    IF r IS NULL THEN
        RETURN TRUE;
    END IF;

    IF r NOT IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations') THEN
        RETURN TRUE;
    END IF;

    wd := EXTRACT(DOW FROM p_d)::int;
    ws_week_start := (p_d::date - (EXTRACT(DOW FROM p_d)::int * INTERVAL '1 day'))::date;

    SELECT e.kind INTO ex
    FROM staff_day_exception e
    WHERE e.staff_id = p_staff_id AND e.exception_date = p_d;

    IF FOUND THEN
        RETURN ex = 'extra_shift';
    END IF;

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

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION staff_effective_working_day(uuid, date) IS
    'True if an operational staff member counts as working on calendar date p_d: admin/salesperson/sales_support/staff_support/alterations use staff_day_exception first (extra_shift = on; all other exception kinds = off), then a published staff_weekly_schedule day; missing published schedule = off. Unknown/non-operational roles fail open.';
