-- Counterpoint import-first proof ledger.
-- This migration adds audit/provenance tables only. Historical financial data
-- repair remains operator-reviewed and must not happen automatically here.

CREATE TABLE IF NOT EXISTS counterpoint_import_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_kind TEXT NOT NULL DEFAULT 'rehearsal'
        CHECK (run_kind IN ('preflight', 'rehearsal', 'go_live')),
    status TEXT NOT NULL DEFAULT 'preflight_pending'
        CHECK (status IN (
            'preflight_pending',
            'preflight_failed',
            'preflight_passed',
            'running',
            'completed',
            'failed',
            'reset'
        )),
    history_start DATE NOT NULL DEFAULT DATE '2018-01-01',
    bridge_hostname TEXT,
    bridge_version TEXT,
    ros_base_url TEXT,
    source_fingerprint TEXT,
    preflight_passed BOOLEAN NOT NULL DEFAULT FALSE,
    preflight_blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
    totals JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS counterpoint_import_source_counts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_run_id UUID NOT NULL REFERENCES counterpoint_import_runs(id) ON DELETE CASCADE,
    entity_key TEXT NOT NULL,
    label TEXT NOT NULL,
    source_count BIGINT NOT NULL DEFAULT 0 CHECK (source_count >= 0),
    source_sum NUMERIC(18, 2),
    source_checksum TEXT,
    query_key TEXT,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    suspicious_min_count BIGINT,
    status TEXT NOT NULL DEFAULT 'ok'
        CHECK (status IN ('ok', 'warning', 'blocked', 'missing_mapping')),
    message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (import_run_id, entity_key)
);

CREATE INDEX IF NOT EXISTS counterpoint_import_source_counts_entity_idx
    ON counterpoint_import_source_counts(entity_key);

CREATE TABLE IF NOT EXISTS counterpoint_import_raw_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_run_id UUID NOT NULL REFERENCES counterpoint_import_runs(id) ON DELETE CASCADE,
    entity_key TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_row_hash TEXT NOT NULL,
    payload JSONB NOT NULL,
    extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    landed BOOLEAN NOT NULL DEFAULT FALSE,
    landed_table TEXT,
    landed_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (import_run_id, entity_key, source_key, source_row_hash)
);

CREATE INDEX IF NOT EXISTS counterpoint_import_raw_records_source_idx
    ON counterpoint_import_raw_records(entity_key, source_key);

CREATE INDEX IF NOT EXISTS counterpoint_import_raw_records_landed_idx
    ON counterpoint_import_raw_records(landed_table, landed_id)
    WHERE landed_table IS NOT NULL AND landed_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS counterpoint_import_provenance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_run_id UUID NOT NULL REFERENCES counterpoint_import_runs(id) ON DELETE CASCADE,
    entity_key TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_row_hash TEXT NOT NULL,
    ros_table TEXT NOT NULL,
    ros_id UUID NOT NULL,
    extracted_at TIMESTAMPTZ,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (entity_key, source_key, ros_table, ros_id)
);

CREATE INDEX IF NOT EXISTS counterpoint_import_provenance_run_idx
    ON counterpoint_import_provenance(import_run_id);

CREATE INDEX IF NOT EXISTS counterpoint_import_provenance_ros_idx
    ON counterpoint_import_provenance(ros_table, ros_id);

CREATE TABLE IF NOT EXISTS counterpoint_import_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_run_id UUID REFERENCES counterpoint_import_runs(id) ON DELETE SET NULL,
    entity_key TEXT NOT NULL,
    source_key TEXT,
    severity TEXT NOT NULL DEFAULT 'warning'
        CHECK (severity IN ('info', 'warning', 'blocked')),
    reason_code TEXT NOT NULL,
    message TEXT NOT NULL,
    suggested_fix TEXT,
    fallback_landed BOOLEAN NOT NULL DEFAULT FALSE,
    ros_table TEXT,
    ros_id UUID,
    source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved', 'ignored')),
    resolved_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS counterpoint_import_exceptions_status_idx
    ON counterpoint_import_exceptions(status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS counterpoint_import_exceptions_source_idx
    ON counterpoint_import_exceptions(entity_key, source_key);

CREATE INDEX IF NOT EXISTS counterpoint_import_exceptions_ros_idx
    ON counterpoint_import_exceptions(ros_table, ros_id)
    WHERE ros_table IS NOT NULL AND ros_id IS NOT NULL;

COMMENT ON TABLE counterpoint_import_runs IS
    'Import-first Counterpoint rehearsal/go-live run ledger and preflight outcome.';
COMMENT ON TABLE counterpoint_import_source_counts IS
    'Bridge source-truth counts captured before import. Suspicious rows block import.';
COMMENT ON TABLE counterpoint_import_raw_records IS
    'Raw Counterpoint records retained for import replay/proof.';
COMMENT ON TABLE counterpoint_import_provenance IS
    'Counterpoint source entity/key/hash to landed ROS row provenance.';
COMMENT ON TABLE counterpoint_import_exceptions IS
    'Rows that failed, were fallback-landed, or require operator cleanup after import.';
