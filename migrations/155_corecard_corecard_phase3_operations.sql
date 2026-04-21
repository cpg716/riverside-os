-- Phase 3 operational completion for unified RMS Charge / CoreCard.
-- Adds webhook event logging, exception queue, reconciliation runs, and account snapshot state.

ALTER TABLE customer_corecredit_accounts
    ADD COLUMN IF NOT EXISTS available_credit_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS current_balance_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS past_due_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS restrictions_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS last_balance_sync_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_status_sync_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_transactions_sync_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_sync_error TEXT;

COMMENT ON COLUMN customer_corecredit_accounts.available_credit_snapshot IS
    'Latest masked/minimal balance snapshot from CoreCard repair polling or webhook ingestion.';

CREATE TABLE IF NOT EXISTS corecredit_event_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_event_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    processing_status TEXT NOT NULL DEFAULT 'received',
    signature_valid BOOLEAN NOT NULL DEFAULT false,
    verification_result TEXT,
    related_customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
    related_account_id TEXT,
    related_rms_record_id UUID REFERENCES pos_rms_charge_record (id) ON DELETE SET NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_corecredit_event_log_external_event_key
    ON corecredit_event_log (external_event_key);

CREATE INDEX IF NOT EXISTS idx_corecredit_event_log_status_received
    ON corecredit_event_log (processing_status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_corecredit_event_log_related_record
    ON corecredit_event_log (related_rms_record_id, received_at DESC)
    WHERE related_rms_record_id IS NOT NULL;

COMMENT ON TABLE corecredit_event_log IS
    'Immutable inbound CoreCard webhook event log with redacted payload snapshots and idempotent processing markers.';

CREATE TABLE IF NOT EXISTS corecredit_exception_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rms_record_id UUID REFERENCES pos_rms_charge_record (id) ON DELETE SET NULL,
    account_id TEXT,
    exception_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    assigned_to_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    notes TEXT,
    resolution_notes TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_retry_at TIMESTAMPTZ,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_corecredit_exception_queue_status_opened
    ON corecredit_exception_queue (status, severity, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_corecredit_exception_queue_rms_record
    ON corecredit_exception_queue (rms_record_id, opened_at DESC)
    WHERE rms_record_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_corecredit_exception_queue_active_key
    ON corecredit_exception_queue (
        COALESCE(rms_record_id::text, ''),
        COALESCE(account_id, ''),
        exception_type
    )
    WHERE status IN ('open', 'retry_pending', 'assigned');

COMMENT ON TABLE corecredit_exception_queue IS
    'Operational exception queue for failed postings, webhook issues, stale account states, and reconciliation mismatches.';

CREATE TABLE IF NOT EXISTS corecredit_reconciliation_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_scope TEXT NOT NULL DEFAULT 'daily',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    requested_by_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    date_from DATE,
    date_to DATE,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_corecredit_reconciliation_run_started
    ON corecredit_reconciliation_run (started_at DESC, status);

CREATE TABLE IF NOT EXISTS corecredit_reconciliation_item (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES corecredit_reconciliation_run (id) ON DELETE CASCADE,
    rms_record_id UUID REFERENCES pos_rms_charge_record (id) ON DELETE SET NULL,
    account_id TEXT,
    mismatch_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    riverside_value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    host_value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    qbo_value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_corecredit_reconciliation_item_run
    ON corecredit_reconciliation_item (run_id, severity, created_at DESC);

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'pos.rms_charge.payment_collect', true),
    ('admin', 'customers.rms_charge.resolve_exceptions', true),
    ('admin', 'customers.rms_charge.reconcile', true),
    ('admin', 'customers.rms_charge.reverse', true),
    ('admin', 'customers.rms_charge.reporting', true),
    ('sales_support', 'pos.rms_charge.payment_collect', true),
    ('sales_support', 'customers.rms_charge.resolve_exceptions', true),
    ('sales_support', 'customers.rms_charge.reporting', true)
ON CONFLICT (role, permission_key) DO NOTHING;
