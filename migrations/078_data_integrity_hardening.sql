-- Data integrity hardening for payment recovery, QBO staging, and web checkout attempts.
-- These indexes are intentionally strict: if historical duplicates exist, run the
-- read-only diagnostics and resolve them before applying this migration.

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_provider_transaction_uidx
    ON public.payment_transactions (payment_provider, provider_transaction_id)
    WHERE payment_provider IS NOT NULL
      AND provider_transaction_id IS NOT NULL
      AND btrim(provider_transaction_id) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS qbo_sync_logs_one_pending_per_date_uidx
    ON public.qbo_sync_logs (sync_date)
    WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS store_checkout_payment_attempt_open_session_provider_uidx
    ON public.store_checkout_payment_attempt (checkout_session_id, provider)
    WHERE status IN ('pending', 'requires_action');
