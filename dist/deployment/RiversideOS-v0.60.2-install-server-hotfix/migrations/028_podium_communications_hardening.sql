-- Podium communications hardening for ROS Inbox evidence, triage, sync, and review visibility.

ALTER TABLE podium_conversation
    ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sync_source TEXT NOT NULL DEFAULT 'webhook',
    ADD COLUMN IF NOT EXISTS provider_status TEXT,
    ADD COLUMN IF NOT EXISTS provider_assignee_name TEXT;

COMMENT ON COLUMN podium_conversation.last_viewed_at IS 'Last time a ROS staff member opened/read this Podium conversation.';
COMMENT ON COLUMN podium_conversation.last_synced_at IS 'Last time ROS refreshed this conversation from Podium APIs.';
COMMENT ON COLUMN podium_conversation.sync_source IS 'How ROS first learned about this conversation: webhook, outbound, or api_sync.';
COMMENT ON COLUMN podium_conversation.provider_status IS 'Best-effort Podium conversation state from API sync, when returned.';
COMMENT ON COLUMN podium_conversation.provider_assignee_name IS 'Best-effort Podium assignee/team member label from API sync, when returned.';

CREATE INDEX IF NOT EXISTS idx_podium_conversation_unread
    ON podium_conversation (last_message_at DESC, last_viewed_at);

CREATE TABLE IF NOT EXISTS podium_webhook_failure (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reason TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    payload_sha256_hex TEXT NOT NULL,
    raw_excerpt TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_podium_webhook_failure_created
    ON podium_webhook_failure (created_at DESC);

COMMENT ON TABLE podium_webhook_failure IS 'Rejected Podium webhook attempts for integration diagnostics.';
COMMENT ON COLUMN podium_webhook_failure.raw_excerpt IS 'Short redacted/raw body excerpt for diagnostics; do not store full payload bodies here.';

CREATE TABLE IF NOT EXISTS podium_sync_unmatched_conversation (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_conversation_uid TEXT NOT NULL,
    channel TEXT NOT NULL,
    identifier TEXT,
    last_message_at TIMESTAMPTZ,
    snippet TEXT,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    CONSTRAINT podium_sync_unmatched_channel_chk CHECK (channel IN ('sms', 'email'))
);

CREATE UNIQUE INDEX IF NOT EXISTS podium_sync_unmatched_conversation_uid_uq
    ON podium_sync_unmatched_conversation (provider_conversation_uid);

CREATE INDEX IF NOT EXISTS idx_podium_sync_unmatched_seen
    ON podium_sync_unmatched_conversation (last_seen_at DESC)
    WHERE resolved_at IS NULL;

COMMENT ON TABLE podium_sync_unmatched_conversation IS 'Podium provider conversations seen during API sync that could not be matched to a ROS customer.';

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS podium_review_url TEXT,
    ADD COLUMN IF NOT EXISTS podium_review_invite_status TEXT;

COMMENT ON COLUMN transactions.podium_review_url IS 'Review URL returned by Podium review invite API when available.';
COMMENT ON COLUMN transactions.podium_review_invite_status IS 'ROS/provider-visible review invite status such as sent, suppressed, skipped, or failed.';
