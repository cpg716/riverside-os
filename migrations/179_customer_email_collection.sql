ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS email_collection_declined_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_collection_declined_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS customer_email_collection_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    customer_code TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('email_added', 'customer_declined')),
    email_address TEXT,
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    staff_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT customer_email_collection_event_email_check CHECK (
        (action = 'email_added' AND email_address IS NOT NULL)
        OR (action = 'customer_declined' AND email_address IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_customer_email_collection_events_created_at
    ON customer_email_collection_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_email_collection_events_customer_id
    ON customer_email_collection_events (customer_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_email_collection_declined_once
    ON customer_email_collection_events (customer_id)
    WHERE action = 'customer_declined';
