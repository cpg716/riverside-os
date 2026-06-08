ALTER TABLE public.register_sessions
    ADD COLUMN IF NOT EXISTS cash_deposit_date DATE,
    ADD COLUMN IF NOT EXISTS cash_deposit_amount NUMERIC(12, 2);

CREATE INDEX IF NOT EXISTS idx_register_sessions_cash_deposit_date
    ON public.register_sessions (cash_deposit_date)
    WHERE cash_deposit_date IS NOT NULL;

COMMENT ON COLUMN public.register_sessions.cash_deposit_date IS
    'Store-local date the counted physical cash is expected to be deposited at the bank from a Z-close.';

COMMENT ON COLUMN public.register_sessions.cash_deposit_amount IS
    'Confirmed physical cash deposit amount from Z-close, normally actual counted cash minus retained opening float.';
