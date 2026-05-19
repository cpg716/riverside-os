-- First-party store email channel (IONOS IMAP/SMTP) for automated email and Operations Mailbox.

ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS email_config JSONB NOT NULL DEFAULT '{
        "enabled": false,
        "from_email": "info@riversidemens.com",
        "from_name": "Riverside Men''s Shop",
        "reply_to_email": "info@riversidemens.com",
        "imap_host": "imap.ionos.com",
        "imap_port": 993,
        "imap_tls": true,
        "imap_folder": "INBOX",
        "smtp_host": "smtp.ionos.com",
        "smtp_port": 465,
        "smtp_tls": "ssl_tls",
        "sync_enabled": true,
        "sync_limit": 50
    }'::jsonb;

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS email_signature TEXT;

CREATE TABLE IF NOT EXISTS mailbox_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_uid TEXT,
    message_id TEXT,
    thread_key TEXT,
    direction TEXT NOT NULL DEFAULT 'inbound',
    channel TEXT NOT NULL DEFAULT 'email',
    folder TEXT NOT NULL DEFAULT 'INBOX',
    subject TEXT,
    from_email TEXT,
    from_name TEXT,
    to_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
    cc_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
    body_text TEXT,
    body_html TEXT,
    received_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'received',
    raw_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mailbox_messages_direction_chk CHECK (direction IN ('inbound', 'outbound', 'automated')),
    CONSTRAINT mailbox_messages_status_chk CHECK (status IN ('received', 'sent', 'draft', 'failed', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_provider_uid
    ON mailbox_messages(provider_uid)
    WHERE provider_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mailbox_received_at
    ON mailbox_messages(COALESCE(received_at, sent_at, created_at) DESC);

CREATE INDEX IF NOT EXISTS idx_mailbox_customer_id
    ON mailbox_messages(customer_id)
    WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mailbox_from_email_lower
    ON mailbox_messages(LOWER(from_email))
    WHERE from_email IS NOT NULL;
