-- Durable, collision-safe Podium contact synchronization and reconciliation evidence.

ALTER TABLE podium_sync_unmatched_conversation
    ADD COLUMN IF NOT EXISTS match_status TEXT NOT NULL DEFAULT 'unmatched',
    ADD COLUMN IF NOT EXISTS candidate_customer_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
    ADD COLUMN IF NOT EXISTS resolution_note TEXT,
    ADD COLUMN IF NOT EXISTS resolved_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE podium_sync_unmatched_conversation
    DROP CONSTRAINT IF EXISTS podium_sync_unmatched_match_status_chk;

ALTER TABLE podium_sync_unmatched_conversation
    ADD CONSTRAINT podium_sync_unmatched_match_status_chk
    CHECK (match_status IN ('unmatched', 'ambiguous', 'resolved'));

CREATE TABLE IF NOT EXISTS podium_contact_sync_state (
    customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    provider_contact_uid TEXT,
    provider_match_identifier TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    pending_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    last_provider_payload JSONB,
    provider_updated_at TIMESTAMPTZ,
    sync_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT podium_contact_sync_state_status_chk
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'conflict', 'provider_deleted', 'merged')),
    CONSTRAINT podium_contact_sync_state_attempts_chk CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS podium_contact_sync_provider_uid_uq
    ON podium_contact_sync_state (provider_contact_uid)
    WHERE provider_contact_uid IS NOT NULL AND TRIM(provider_contact_uid) <> '';

CREATE INDEX IF NOT EXISTS podium_contact_sync_pending_idx
    ON podium_contact_sync_state (next_attempt_at, updated_at)
    WHERE status IN ('pending', 'processing') AND sync_suppressed = FALSE;

CREATE INDEX IF NOT EXISTS podium_contact_sync_failed_idx
    ON podium_contact_sync_state (updated_at DESC)
    WHERE status IN ('failed', 'conflict', 'provider_deleted');

COMMENT ON TABLE podium_contact_sync_state IS 'Durable per-customer Podium contact mapping, retry lifecycle, provider identity, and last-success evidence.';
COMMENT ON COLUMN podium_contact_sync_state.sync_suppressed IS 'Prevents an automatic ROS push from silently recreating a contact deleted in Podium; a manual sync may clear it.';

CREATE TABLE IF NOT EXISTS podium_contact_sync_event (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    provider_contact_uid TEXT,
    direction TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    candidate_customer_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
    payload JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT podium_contact_sync_event_direction_chk
        CHECK (direction IN ('ros_to_podium', 'podium_to_ros')),
    CONSTRAINT podium_contact_sync_event_status_chk
        CHECK (status IN ('succeeded', 'skipped', 'conflict', 'failed'))
);

CREATE INDEX IF NOT EXISTS podium_contact_sync_event_customer_idx
    ON podium_contact_sync_event (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS podium_contact_sync_event_provider_idx
    ON podium_contact_sync_event (provider_contact_uid, created_at DESC);

COMMENT ON TABLE podium_contact_sync_event IS 'Append-only audit evidence for outbound contact pushes, inbound contact webhooks, reconciliation, merges, deletes, and SMS opt-outs.';

CREATE TABLE IF NOT EXISTS podium_contact_reconciliation_issue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_contact_uid TEXT NOT NULL,
    provider_name TEXT,
    phone_e164 TEXT,
    email TEXT,
    reason TEXT NOT NULL,
    candidate_customer_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS podium_contact_reconciliation_issue_uid_uq
    ON podium_contact_reconciliation_issue (provider_contact_uid);

CREATE INDEX IF NOT EXISTS podium_contact_reconciliation_issue_open_idx
    ON podium_contact_reconciliation_issue (last_seen_at DESC)
    WHERE resolved_at IS NULL;

COMMENT ON TABLE podium_contact_reconciliation_issue IS 'Provider contacts that cannot be safely matched because identifiers are missing, duplicated, or point to different ROS customers.';

CREATE TABLE IF NOT EXISTS podium_contact_reconciliation_run (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    contacts_seen INTEGER NOT NULL DEFAULT 0,
    contacts_matched INTEGER NOT NULL DEFAULT 0,
    customers_created INTEGER NOT NULL DEFAULT 0,
    customers_updated INTEGER NOT NULL DEFAULT 0,
    conflicts INTEGER NOT NULL DEFAULT 0,
    outbound_queued INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    CONSTRAINT podium_contact_reconciliation_run_status_chk
        CHECK (status IN ('running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS podium_contact_reconciliation_run_started_idx
    ON podium_contact_reconciliation_run (started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS podium_contact_reconciliation_single_running_uq
    ON podium_contact_reconciliation_run ((1))
    WHERE status = 'running';

COMMENT ON TABLE podium_contact_reconciliation_run IS 'Auditable full-list Podium contact reconciliation runs and their exact completion outcome.';
