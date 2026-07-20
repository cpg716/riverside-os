-- Support the remaining payment, Helcim, and register-history read paths.
-- These indexes do not change payment or reporting semantics.
CREATE INDEX IF NOT EXISTS idx_payment_allocations_transaction_latest
    ON public.payment_allocations (transaction_id, id DESC)
    INCLUDE (target_transaction_id);

CREATE INDEX IF NOT EXISTS idx_payment_provider_batch_transactions_payment_link
    ON public.payment_provider_batch_transactions (
        provider,
        payment_transaction_id,
        provider_transaction_id
    )
    WHERE payment_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_settlement_items_provider_reference_open
    ON public.payment_settlement_items (provider, provider_transaction_id, status)
    WHERE provider_transaction_id IS NOT NULL
      AND status = 'open';

CREATE INDEX IF NOT EXISTS idx_register_sessions_closed_lane_group
    ON public.register_sessions (closed_at DESC, register_lane, till_close_group_id)
    WHERE closed_at IS NOT NULL;

INSERT INTO ros_schema_migrations (version) VALUES ('138_register_payment_read_path_indexes.sql')
ON CONFLICT (version) DO NOTHING;
