-- Document staff schedule objects in the catalog (no behavior change).
-- Requires migration 57 (staff_effective_working_day, staff_weekly_availability, staff_day_exception).

COMMENT ON FUNCTION staff_effective_working_day(uuid, date) IS
    'True if the staff member counts as working on calendar date p_d: always true for non floor roles; '
    'for salesperson/sales_support, staff_day_exception wins (sick/pto/missed_shift = off, extra_shift = on); '
    'else staff_weekly_availability for EXTRACT(DOW FROM p_d); if no row, default is Sunday off.';

COMMENT ON TABLE staff_weekly_availability IS
    'Template work week for salesperson/sales_support: weekday 0=Sunday … 6=Saturday, works boolean.';

COMMENT ON TABLE staff_day_exception IS
    'Per-date override: sick, pto, missed_shift (not working), or extra_shift (working when template says off).';
