CREATE TABLE IF NOT EXISTS counterpoint_historical_booking_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key TEXT NOT NULL UNIQUE,
    source_document_type TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    source_log_sequence INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    booked_at TIMESTAMPTZ NOT NULL,
    subtotal_delta NUMERIC(14, 2) NOT NULL,
    tax_delta NUMERIC(14, 2) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT counterpoint_historical_booking_document_type_check
        CHECK (source_document_type IN ('order', 'layaway')),
    CONSTRAINT counterpoint_historical_booking_event_kind_check
        CHECK (event_kind IN ('N', 'E', 'C', 'I')),
    CONSTRAINT counterpoint_historical_booking_document_sequence_unique
        UNIQUE (source_document_type, source_document_id, source_log_sequence)
);

CREATE INDEX IF NOT EXISTS idx_counterpoint_historical_booking_events_date
    ON counterpoint_historical_booking_events (booked_at, source_document_type, source_document_id);

COMMENT ON TABLE counterpoint_historical_booking_events IS
    'Authoritative Counterpoint active and archived order/layaway booking deltas reconstructed from audit-log total snapshots. Fulfillment, deposit, print, and close activity is intentionally excluded.';
