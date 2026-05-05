-- Persist full-store register day summary at Z-close (one row per store-local calendar day, upsert).
CREATE TABLE IF NOT EXISTS store_register_eod_snapshot (
    store_local_date date PRIMARY KEY,
    timezone text NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now(),
    till_close_group_id uuid NOT NULL,
    primary_register_session_id uuid REFERENCES register_sessions (id) ON DELETE SET NULL,
    summary_json jsonb NOT NULL
);

COMMENT ON TABLE store_register_eod_snapshot IS 'Frozen Register day summary captured at Z-close; used for historical single-day register reports.';
COMMENT ON COLUMN store_register_eod_snapshot.summary_json IS 'Serialized RegisterDaySummary (store-wide, no lane filter).';
