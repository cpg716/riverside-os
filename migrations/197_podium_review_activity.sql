-- Retain Podium review and review-response webhook activity for Operations and Inbox.

CREATE TABLE IF NOT EXISTS podium_review (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_review_uid TEXT NOT NULL,
    review_invitation_uid TEXT,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES podium_conversation(id) ON DELETE SET NULL,
    author_name TEXT,
    rating SMALLINT,
    review_body TEXT,
    review_url TEXT,
    site_name TEXT,
    site_review_id TEXT,
    is_recommendation BOOLEAN NOT NULL DEFAULT FALSE,
    needs_response BOOLEAN NOT NULL DEFAULT FALSE,
    last_event_type TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    provider_updated_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ NOT NULL,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT podium_review_provider_uid_uq UNIQUE (provider_review_uid),
    CONSTRAINT podium_review_rating_chk CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
    CONSTRAINT podium_review_event_type_chk CHECK (
        last_event_type IN (
            'review.created',
            'review.updated',
            'review.response_created',
            'review.response_updated'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_podium_review_conversation_activity
    ON podium_review (conversation_id, last_activity_at DESC)
    WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_podium_review_customer_activity
    ON podium_review (customer_id, last_activity_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_podium_review_needs_response
    ON podium_review (last_activity_at DESC)
    WHERE needs_response = TRUE;

CREATE TABLE IF NOT EXISTS podium_review_response (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES podium_review(id) ON DELETE CASCADE,
    provider_review_uid TEXT,
    provider_response_uid TEXT NOT NULL,
    body TEXT,
    author_name TEXT,
    source TEXT,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    like_count INTEGER,
    published_at TIMESTAMPTZ NOT NULL,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT podium_review_response_provider_uid_uq UNIQUE (provider_response_uid),
    CONSTRAINT podium_review_response_like_count_chk CHECK (
        like_count IS NULL OR like_count >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_podium_review_response_review_time
    ON podium_review_response (review_id, published_at DESC)
    WHERE review_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_podium_review_response_provider_review
    ON podium_review_response (provider_review_uid)
    WHERE provider_review_uid IS NOT NULL;

COMMENT ON TABLE podium_review IS
    'Current Podium review snapshot normalized from signed review lifecycle webhooks.';
COMMENT ON TABLE podium_review_response IS
    'Podium business responses normalized from signed response lifecycle webhooks.';
COMMENT ON COLUMN podium_review.raw_payload IS
    'Most recent verified provider payload retained for contract troubleshooting.';
COMMENT ON COLUMN podium_review_response.raw_payload IS
    'Most recent verified provider response payload retained for contract troubleshooting.';
