-- Keep Helcim/payment dashboard reads bounded as provider history grows.
-- These indexes support provider/date filters and reconciliation joins without
-- changing payment or ledger semantics.
CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider_created
    ON public.payment_transactions (payment_provider, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_payment_provider_batch_transactions_provider_reference
    ON public.payment_provider_batch_transactions (provider, provider_transaction_id, payment_transaction_id);

CREATE INDEX IF NOT EXISTS idx_payment_settlement_items_provider_payment
    ON public.payment_settlement_items (provider, payment_transaction_id, status)
    WHERE payment_transaction_id IS NOT NULL;

INSERT INTO ros_schema_migrations (version) VALUES ('137_payment_dashboard_read_path_indexes.sql')
ON CONFLICT (version) DO NOTHING;
