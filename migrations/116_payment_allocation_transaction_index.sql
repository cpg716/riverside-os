-- Add the missing lookup index for payment-centric reads. Several timeline and
-- reporting paths join payment_allocations from payment_transactions by
-- transaction_id; without this FK-side index, customer timelines can degrade
-- into long allocation scans on production data.

CREATE INDEX IF NOT EXISTS idx_payment_allocations_transaction
    ON public.payment_allocations (transaction_id);

INSERT INTO ros_schema_migrations (version) VALUES ('116_payment_allocation_transaction_index.sql')
ON CONFLICT (version) DO NOTHING;
