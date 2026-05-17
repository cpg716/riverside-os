-- POS transaction void audit and reversal tracking.
-- A void is not a delete: original transaction/payment rows remain intact, and
-- the void record links manager approval, refund queue state, and restock impact.

CREATE TABLE IF NOT EXISTS public.transaction_void_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    original_status public.order_status NOT NULL,
    original_total_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
    original_amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
    original_balance_due NUMERIC(14, 2) NOT NULL DEFAULT 0,
    register_session_id UUID REFERENCES public.register_sessions(id) ON DELETE SET NULL,
    voided_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    manager_staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    reversal_status TEXT NOT NULL DEFAULT 'pending_refund',
    refundable_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    refund_queue_id UUID REFERENCES public.transaction_refund_queue(id) ON DELETE SET NULL,
    tender_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
    inventory_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT transaction_void_records_one_per_transaction UNIQUE (transaction_id),
    CONSTRAINT transaction_void_records_reversal_status_chk CHECK (
        reversal_status IN ('pending_refund', 'completed', 'no_refund_due', 'provider_action_required')
    ),
    CONSTRAINT transaction_void_records_refundable_non_negative CHECK (refundable_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_transaction_void_records_created_at
    ON public.transaction_void_records(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_void_records_register_session
    ON public.transaction_void_records(register_session_id, created_at DESC);

COMMENT ON TABLE public.transaction_void_records IS
    'Append-only POS void records. Transactions remain preserved; this table records manager approval, refund/reversal status, tender summary, and inventory impact.';

COMMENT ON COLUMN public.transaction_void_records.reversal_status IS
    'pending_refund until the refund queue is fully settled; no_refund_due for unpaid/already-refunded voids; completed once reversal is settled.';
