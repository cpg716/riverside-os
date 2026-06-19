-- Preserve tender-level source audit links for wedding group-pay credits held as open deposit.

CREATE TABLE IF NOT EXISTS public.customer_open_deposit_ledger_sources (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    ledger_id uuid NOT NULL REFERENCES public.customer_open_deposit_ledger(id) ON DELETE CASCADE,
    source_payment_transaction_id uuid NOT NULL REFERENCES public.payment_transactions(id),
    amount numeric(14,2) NOT NULL,
    payer_wedding_member_id uuid REFERENCES public.wedding_members(id) ON DELETE SET NULL,
    beneficiary_wedding_member_id uuid REFERENCES public.wedding_members(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_open_deposit_ledger_sources_positive_amount
        CHECK (amount > 0::numeric)
);

CREATE INDEX IF NOT EXISTS idx_customer_open_deposit_ledger_sources_ledger
    ON public.customer_open_deposit_ledger_sources (ledger_id);

CREATE INDEX IF NOT EXISTS idx_customer_open_deposit_ledger_sources_source_payment
    ON public.customer_open_deposit_ledger_sources (source_payment_transaction_id);

CREATE INDEX IF NOT EXISTS idx_customer_open_deposit_ledger_sources_beneficiary
    ON public.customer_open_deposit_ledger_sources (beneficiary_wedding_member_id, created_at DESC);

COMMENT ON TABLE public.customer_open_deposit_ledger_sources IS
    'Tender-level source links for customer open deposit credits created from wedding group-pay disbursements.';
