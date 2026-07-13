-- Auditable reconciliation of legacy Counterpoint open documents with the
-- duplicate ticket/payment shells created during the historical import.

CREATE TABLE IF NOT EXISTS public.counterpoint_transaction_reconciliation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    superseded_transaction_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    moved_payment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    superseded_payment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    reconciled_by_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT counterpoint_transaction_reconciliation_canonical_unique
        UNIQUE (canonical_transaction_id),
    CONSTRAINT counterpoint_transaction_reconciliation_reason_required
        CHECK (length(btrim(reason)) >= 12)
);

CREATE INDEX IF NOT EXISTS idx_counterpoint_transaction_reconciliation_created_at
    ON public.counterpoint_transaction_reconciliation(created_at DESC);

COMMENT ON TABLE public.counterpoint_transaction_reconciliation IS
    'Append-only audit record for reviewed legacy Counterpoint order/payment consolidation. Source transaction and payment snapshots are retained in snapshot before duplicate imported artifacts are superseded.';
