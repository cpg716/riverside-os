-- Staff schedule request workflow, appointment staff identity, and audit hardening.

CREATE TABLE IF NOT EXISTS staff_time_off_request (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    requested_by_staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    kind staff_schedule_exception_kind NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    partial_start_time TIME,
    partial_end_time TIME,
    staff_note TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied', 'withdrawn')),
    reviewed_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    manager_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_date <= end_date),
    CHECK (
        (partial_start_time IS NULL AND partial_end_time IS NULL)
        OR (partial_start_time IS NOT NULL AND partial_end_time IS NOT NULL AND partial_start_time < partial_end_time)
    )
);

CREATE INDEX IF NOT EXISTS idx_staff_time_off_request_staff_dates
    ON staff_time_off_request (staff_id, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_staff_time_off_request_status
    ON staff_time_off_request (status, start_date);

ALTER TABLE staff_day_exception
    ADD COLUMN IF NOT EXISTS source_request_id UUID REFERENCES staff_time_off_request(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staff_day_exception_source_request
    ON staff_day_exception (source_request_id);

ALTER TABLE wedding_appointments
    ADD COLUMN IF NOT EXISTS salesperson_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wedding_appointments_salesperson_staff_id
    ON wedding_appointments (salesperson_staff_id);

WITH unique_staff_names AS (
    SELECT lower(trim(full_name)) AS normalized_name, (array_agg(id ORDER BY id))[1] AS staff_id, count(*) AS match_count
    FROM staff
    WHERE is_active = TRUE
      AND role IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations')
    GROUP BY lower(trim(full_name))
)
UPDATE wedding_appointments wa
SET salesperson_staff_id = usn.staff_id
FROM unique_staff_names usn
WHERE wa.salesperson_staff_id IS NULL
  AND wa.salesperson IS NOT NULL
  AND lower(trim(wa.salesperson)) = usn.normalized_name
  AND usn.match_count = 1;

CREATE TABLE IF NOT EXISTS appointment_schedule_override_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id UUID REFERENCES wedding_appointments(id) ON DELETE SET NULL,
    salesperson_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    salesperson_name TEXT,
    override_reason TEXT NOT NULL,
    validation_message TEXT NOT NULL,
    overridden_by_staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    overridden_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointment_schedule_override_audit_appt
    ON appointment_schedule_override_audit (appointment_id);

CREATE TABLE IF NOT EXISTS appointment_assignment_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id UUID REFERENCES wedding_appointments(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('unassigned_for_absence', 'reassigned_for_absence')),
    old_salesperson_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    old_salesperson_name TEXT,
    new_salesperson_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    new_salesperson_name TEXT,
    reason TEXT,
    acted_by_staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    acted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointment_assignment_audit_appt
    ON appointment_assignment_audit (appointment_id);
