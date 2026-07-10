-- Durable operational recovery, checkout follow-up outbox, daily weather, and phase telemetry.

CREATE TABLE IF NOT EXISTS public.operational_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type text NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 8,
    available_at timestamp with time zone NOT NULL DEFAULT now(),
    locked_at timestamp with time zone,
    locked_by text,
    completed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT operational_outbox_status_chk
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    CONSTRAINT operational_outbox_attempts_chk
        CHECK (attempts >= 0 AND max_attempts > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS operational_outbox_idempotency_uidx
    ON public.operational_outbox (idempotency_key);

CREATE INDEX IF NOT EXISTS operational_outbox_claim_idx
    ON public.operational_outbox (available_at, created_at)
    WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS public.operational_recovery_job (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_job_key text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'blocked',
    register_session_id uuid REFERENCES public.register_sessions(id) ON DELETE SET NULL,
    transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
    checkout_client_id uuid,
    station_key text,
    label text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error text,
    attempt_count integer NOT NULL DEFAULT 0,
    first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
    last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
    resolved_at timestamp with time zone,
    resolved_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    resolution_note text,
    CONSTRAINT operational_recovery_job_kind_chk
        CHECK (kind IN ('checkout_offline', 'checkout_unconfirmed', 'pickup_after_payment', 'receipt_print')),
    CONSTRAINT operational_recovery_job_status_chk
        CHECK (status IN ('pending', 'blocked', 'resolved', 'dismissed')),
    CONSTRAINT operational_recovery_job_attempt_count_chk CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS operational_recovery_job_client_key_uidx
    ON public.operational_recovery_job (client_job_key);

CREATE INDEX IF NOT EXISTS operational_recovery_job_open_idx
    ON public.operational_recovery_job (kind, last_seen_at DESC)
    WHERE status IN ('pending', 'blocked');

CREATE TABLE IF NOT EXISTS public.store_daily_weather (
    weather_date date PRIMARY KEY,
    snapshot jsonb NOT NULL,
    source text NOT NULL,
    captured_at timestamp with time zone NOT NULL DEFAULT now(),
    finalized_at timestamp with time zone,
    CONSTRAINT store_daily_weather_snapshot_object_chk
        CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS public.operational_phase_metric (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation text NOT NULL,
    phase text NOT NULL,
    duration_ms double precision NOT NULL,
    success boolean NOT NULL,
    transaction_id uuid,
    register_session_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    recorded_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT operational_phase_metric_duration_chk
        CHECK (
            duration_ms >= 0
            AND duration_ms != 'NaN'::double precision
            AND duration_ms < 'Infinity'::double precision
        )
);

CREATE INDEX IF NOT EXISTS operational_phase_metric_lookup_idx
    ON public.operational_phase_metric (operation, phase, recorded_at DESC);

ALTER TABLE public.wedding_activity_log
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS wedding_activity_log_idempotency_uidx
    ON public.wedding_activity_log (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.staff_access_log
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS staff_access_log_idempotency_uidx
    ON public.staff_access_log (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.task_instance
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS task_instance_idempotency_uidx
    ON public.task_instance (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
