-- Keep QBO tender staging on indexed date predicates while retaining the
-- actual-processing-date fallback for payment rows without an effective date.

CREATE INDEX IF NOT EXISTS idx_payment_transactions_effective_date_qbo
    ON public.payment_transactions (effective_date, created_at, id)
    WHERE effective_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_created_at_without_effective_date_qbo
    ON public.payment_transactions (created_at, id)
    WHERE effective_date IS NULL;
