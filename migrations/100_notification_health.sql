-- Notification generator health and delivery suppression telemetry.

CREATE TABLE IF NOT EXISTS notification_generator_run (
    generator_key text PRIMARY KEY,
    last_started_at timestamptz NOT NULL,
    last_finished_at timestamptz NOT NULL,
    last_success_at timestamptz,
    last_error_at timestamptz,
    last_status text NOT NULL CHECK (last_status IN ('ok', 'failed')),
    last_error text,
    consecutive_failures integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_generator_run_status
    ON notification_generator_run (last_status, last_finished_at DESC);

CREATE TABLE IF NOT EXISTS notification_delivery_suppression (
    id bigserial PRIMARY KEY,
    notification_id uuid REFERENCES app_notification(id) ON DELETE CASCADE,
    staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
    kind text NOT NULL,
    semantic_kind text NOT NULL,
    category text,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_suppression_created
    ON notification_delivery_suppression (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_suppression_kind_created
    ON notification_delivery_suppression (semantic_kind, created_at DESC);
