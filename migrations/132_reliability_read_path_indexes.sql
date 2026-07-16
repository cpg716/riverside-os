-- Keep payment/history and wedding cutover reads from scanning large tables.
CREATE INDEX IF NOT EXISTS idx_payment_transactions_effective_status_session
    ON public.payment_transactions (effective_date, status, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment_target
    ON public.payment_allocations (transaction_id, target_transaction_id, id);

CREATE INDEX IF NOT EXISTS idx_transactions_unlinked_customer_status
    ON public.transactions (customer_id, status, id)
    WHERE wedding_member_id IS NULL;

INSERT INTO ros_schema_migrations (version) VALUES ('132_reliability_read_path_indexes.sql')
ON CONFLICT (version) DO NOTHING;
