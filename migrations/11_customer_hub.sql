-- Customer Relationship Hub: VIP flag, manual timeline notes.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS is_vip BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS customer_timeline_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_by UUID REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_timeline_notes_customer
    ON customer_timeline_notes (customer_id, created_at DESC);

COMMENT ON COLUMN customers.is_vip IS 'Staff-marked VIP for Relationship Hub header.';
COMMENT ON TABLE customer_timeline_notes IS 'Manual CRM notes surfaced on customer timeline.';
