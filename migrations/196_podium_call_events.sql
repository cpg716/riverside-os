-- Retain Podium call webhook activity and attach it to Riverside conversations.

CREATE TABLE IF NOT EXISTS podium_call_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES podium_conversation(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    provider_event_uid TEXT NOT NULL,
    provider_call_uid TEXT NOT NULL,
    provider_conversation_uid TEXT,
    event_type TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'unknown',
    contact_phone_e164 TEXT,
    contact_name TEXT,
    duration_seconds INTEGER,
    has_voicemail BOOLEAN NOT NULL DEFAULT FALSE,
    occurred_at TIMESTAMPTZ NOT NULL,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT podium_call_event_type_chk CHECK (
        event_type IN (
            'call.received',
            'call.completed',
            'call.missed',
            'call.voicemail_left'
        )
    ),
    CONSTRAINT podium_call_event_direction_chk CHECK (
        direction IN ('inbound', 'outbound', 'unknown')
    ),
    CONSTRAINT podium_call_event_duration_chk CHECK (
        duration_seconds IS NULL OR duration_seconds >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS podium_call_event_provider_event_uq
    ON podium_call_event (provider_event_uid);

CREATE INDEX IF NOT EXISTS idx_podium_call_event_conversation_time
    ON podium_call_event (conversation_id, occurred_at DESC)
    WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_podium_call_event_customer_time
    ON podium_call_event (customer_id, occurred_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_podium_call_event_provider_call
    ON podium_call_event (provider_call_uid, occurred_at DESC);

COMMENT ON TABLE podium_call_event IS
    'Signed Podium call lifecycle webhooks retained as durable conversation activity.';
COMMENT ON COLUMN podium_call_event.provider_event_uid IS
    'Podium webhook event UID, with a deterministic payload fallback when the provider omits one.';
COMMENT ON COLUMN podium_call_event.provider_call_uid IS
    'Podium call UID used to collapse received/completed/missed/voicemail lifecycle events for display.';
COMMENT ON COLUMN podium_call_event.raw_payload IS
    'Original verified Podium event retained for provider-contract troubleshooting.';
