-- Counterpoint open documents (PS_DOC) idempotency — special orders / layaways not yet fulfilled as tickets.
-- Depends on: 84_counterpoint_sync_extended (counterpoint_ticket_ref pattern).

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS counterpoint_doc_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_counterpoint_doc_ref_uidx
    ON orders (counterpoint_doc_ref)
    WHERE counterpoint_doc_ref IS NOT NULL;

COMMENT ON COLUMN orders.counterpoint_doc_ref IS
    'Counterpoint PS_DOC document id (one-time import). Mutually exclusive with counterpoint_ticket_ref for a given order row.';

INSERT INTO ros_schema_migrations (version) VALUES ('91_counterpoint_open_docs.sql');
