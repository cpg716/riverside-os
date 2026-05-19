-- Financial effective dates for governed backdating and QBO revisions.

ALTER TABLE public.transactions
    ADD COLUMN IF NOT EXISTS business_date date;

ALTER TABLE public.payment_transactions
    ADD COLUMN IF NOT EXISTS effective_date date;

UPDATE public.transactions
SET business_date = (booked_at AT TIME ZONE reporting.effective_store_timezone())::date
WHERE business_date IS NULL
  AND booked_at IS NOT NULL;

UPDATE public.payment_transactions
SET effective_date = (COALESCE(occurred_at, created_at) AT TIME ZONE reporting.effective_store_timezone())::date
WHERE effective_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_business_date
    ON public.transactions USING btree (business_date DESC, id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_effective_date
    ON public.payment_transactions USING btree (effective_date, status, id);

COMMENT ON COLUMN public.transactions.business_date IS
    'Store-local business date used for booked-sales reporting and QBO staging. Defaults from booked_at and changes only through governed correction workflows.';

COMMENT ON COLUMN public.payment_transactions.effective_date IS
    'Store-local payment movement date used for tender/deposit QBO staging. Defaults from payment occurrence and changes only through governed correction workflows.';
