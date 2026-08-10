-- Make the ROS-owned appointment calendar durable, conflict-aware, and auditable.

CREATE TABLE IF NOT EXISTS appointment_service_type (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 480),
    buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
    buffer_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (BTRIM(code) <> ''),
    CHECK (BTRIM(display_name) <> '')
);

INSERT INTO appointment_service_type (code, display_name, duration_minutes)
VALUES
    ('measurement', 'Measurement', 60),
    ('fitting', 'Fitting', 60),
    ('pickup', 'Pickup', 30),
    ('consultation', 'Consultation', 60),
    ('other', 'Other', 60)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS appointment_resource (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 50),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (BTRIM(name) <> '')
);

ALTER TABLE wedding_appointments
    ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS service_type_id UUID REFERENCES appointment_service_type(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
    ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

UPDATE wedding_appointments wa
SET customer_id = wm.customer_id
FROM wedding_members wm
WHERE wa.customer_id IS NULL
  AND wa.wedding_member_id = wm.id;

UPDATE wedding_appointments wa
SET service_type_id = ast.id
FROM appointment_service_type ast
WHERE wa.service_type_id IS NULL
  AND ast.code = CASE lower(BTRIM(wa.appointment_type))
      WHEN 'measurement' THEN 'measurement'
      WHEN 'fitting' THEN 'fitting'
      WHEN 'pickup' THEN 'pickup'
      WHEN 'consultation' THEN 'consultation'
      ELSE 'other'
  END;

UPDATE wedding_appointments wa
SET ends_at = wa.starts_at + make_interval(mins => COALESCE(ast.duration_minutes, 60))
FROM appointment_service_type ast
WHERE wa.ends_at IS NULL
  AND ast.id = wa.service_type_id;

UPDATE wedding_appointments
SET ends_at = starts_at + INTERVAL '1 hour'
WHERE ends_at IS NULL;

ALTER TABLE wedding_appointments
    ALTER COLUMN ends_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS appointment_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id UUID REFERENCES wedding_appointments(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN (
        'created', 'updated', 'status_changed', 'cancelled', 'restored',
        'reassigned', 'unassigned', 'migration_status_normalized'
    )),
    actor_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    before_state JSONB,
    after_state JSONB,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO appointment_audit (appointment_id, action, before_state, reason)
SELECT id, 'migration_status_normalized', to_jsonb(wa), 'Normalized legacy appointment status'
FROM wedding_appointments wa
WHERE lower(BTRIM(COALESCE(status, ''))) NOT IN (
    'scheduled', 'attended', 'missed', 'cancelled', 'canceled'
);

UPDATE wedding_appointments
SET status = CASE
    WHEN lower(BTRIM(COALESCE(status, ''))) IN ('attended', 'complete', 'completed', 'checked_in', 'showed', 'done') THEN 'Attended'
    WHEN lower(BTRIM(COALESCE(status, ''))) IN ('missed', 'no_show', 'noshow') THEN 'Missed'
    WHEN lower(BTRIM(COALESCE(status, ''))) IN ('cancelled', 'canceled') THEN 'Cancelled'
    ELSE 'Scheduled'
END;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wedding_appointments_status_check'
          AND conrelid = 'wedding_appointments'::regclass
    ) THEN
        ALTER TABLE wedding_appointments
            ADD CONSTRAINT wedding_appointments_status_check
            CHECK (status IN ('Scheduled', 'Attended', 'Missed', 'Cancelled'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wedding_appointments_time_range_check'
          AND conrelid = 'wedding_appointments'::regclass
    ) THEN
        ALTER TABLE wedding_appointments
            ADD CONSTRAINT wedding_appointments_time_range_check
            CHECK (ends_at > starts_at);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wedding_appointments_type_nonempty_check'
          AND conrelid = 'wedding_appointments'::regclass
    ) THEN
        ALTER TABLE wedding_appointments
            ADD CONSTRAINT wedding_appointments_type_nonempty_check
            CHECK (BTRIM(appointment_type) <> '');
    END IF;
END $$;

ALTER TABLE wedding_appointments
    DROP CONSTRAINT IF EXISTS wedding_appointments_wedding_member_id_fkey,
    DROP CONSTRAINT IF EXISTS wedding_appointments_wedding_party_id_fkey;

ALTER TABLE wedding_appointments
    ADD CONSTRAINT wedding_appointments_wedding_member_id_fkey
        FOREIGN KEY (wedding_member_id) REFERENCES wedding_members(id) ON DELETE SET NULL,
    ADD CONSTRAINT wedding_appointments_wedding_party_id_fkey
        FOREIGN KEY (wedding_party_id) REFERENCES wedding_parties(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS appointment_resource_assignment (
    appointment_id UUID NOT NULL REFERENCES wedding_appointments(id) ON DELETE CASCADE,
    resource_id UUID NOT NULL REFERENCES appointment_resource(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (appointment_id, resource_id)
);

CREATE OR REPLACE FUNCTION touch_wedding_appointment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    NEW.revision = OLD.revision + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_touch_wedding_appointment_updated_at ON wedding_appointments;
CREATE TRIGGER trigger_touch_wedding_appointment_updated_at
    BEFORE UPDATE ON wedding_appointments
    FOR EACH ROW
    EXECUTE FUNCTION touch_wedding_appointment_updated_at();

CREATE INDEX IF NOT EXISTS idx_wedding_appointments_open_range
    ON wedding_appointments(starts_at, ends_at)
    WHERE status = 'Scheduled';

CREATE INDEX IF NOT EXISTS idx_wedding_appointments_staff_open_range
    ON wedding_appointments(salesperson_staff_id, starts_at, ends_at)
    WHERE salesperson_staff_id IS NOT NULL AND status = 'Scheduled';

CREATE INDEX IF NOT EXISTS idx_appointment_resource_assignment_resource
    ON appointment_resource_assignment(resource_id, appointment_id);

CREATE INDEX IF NOT EXISTS idx_appointment_audit_appointment_created
    ON appointment_audit(appointment_id, created_at DESC);

DROP INDEX IF EXISTS idx_customer_notification_appointment_attempt;
CREATE INDEX idx_customer_notification_appointment_attempt
    ON customer_notification_queue(
        entity_id,
        kind,
        delivery_method,
        ((metadata->>'appointment_starts_at')),
        created_at DESC
    )
    WHERE entity_type = 'appointment';

ALTER TABLE customer_notification_queue
    DROP CONSTRAINT IF EXISTS customer_notification_queue_kind_check;

ALTER TABLE customer_notification_queue
    ADD CONSTRAINT customer_notification_queue_kind_check
        CHECK (kind IN (
            'ready_for_pickup',
            'alteration_ready',
            'appointment_confirmation',
            'appointment_reminder',
            'appointment_cancellation',
            'receipt',
            'unknown_sender_welcome',
            'review_invite'
        ));
