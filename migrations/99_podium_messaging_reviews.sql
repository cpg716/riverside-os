-- Podium CRM threads, customer provenance, order review invite fields, reviews RBAC.

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_created_source_chk;
ALTER TABLE customers
    ADD CONSTRAINT customers_created_source_chk
        CHECK (customer_created_source IN ('store', 'online_store', 'counterpoint', 'podium'));

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS podium_name_capture_pending BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN customers.podium_name_capture_pending IS 'True after unknown-sender welcome SMS until first+last captured from reply.';

CREATE TABLE podium_conversation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
    podium_conversation_uid TEXT,
    contact_phone_e164 TEXT,
    contact_email TEXT,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX podium_conversation_uid_uq
    ON podium_conversation (podium_conversation_uid)
    WHERE podium_conversation_uid IS NOT NULL AND trim(podium_conversation_uid) <> '';

CREATE INDEX idx_podium_conversation_customer ON podium_conversation (customer_id);
CREATE INDEX idx_podium_conversation_last_msg ON podium_conversation (last_message_at DESC);

COMMENT ON TABLE podium_conversation IS 'Per-customer Podium thread (SMS or email); links CRM to inbound/outbound messages.';

CREATE TABLE podium_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES podium_conversation (id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'automated')),
    channel TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    podium_message_uid TEXT,
    raw_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX podium_message_uid_uq
    ON podium_message (podium_message_uid)
    WHERE podium_message_uid IS NOT NULL AND trim(podium_message_uid) <> '';

CREATE INDEX idx_podium_message_conv_created ON podium_message (conversation_id, created_at DESC);

COMMENT ON TABLE podium_message IS 'Podium SMS/email message line; inbound from webhook, outbound from staff reply or automations.';

-- Review invites (Operations + Receipt modal): see docs/PLAN_PODIUM_REVIEWS.md
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS review_invite_suppressed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_invite_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS podium_review_invite_id TEXT;

COMMENT ON COLUMN orders.review_invite_suppressed_at IS 'Cashier opted out of Podium review invite for this order.';
COMMENT ON COLUMN orders.review_invite_sent_at IS 'When ROS successfully requested a Podium review invite.';
COMMENT ON COLUMN orders.podium_review_invite_id IS 'Provider id for the invite when returned by Podium API.';

-- Reviews hub (Operations primary triage)
INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'reviews.view', true),
    ('admin', 'reviews.manage', true),
    ('salesperson', 'reviews.view', true),
    ('salesperson', 'reviews.manage', false),
    ('sales_support', 'reviews.view', true),
    ('sales_support', 'reviews.manage', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
