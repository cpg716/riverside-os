-- Preserve the exact original tender behind every held wedding-deposit
-- redemption/restoration so member-level refunds can return card funds to the
-- original payer's Helcim transaction rather than the member.

CREATE TABLE IF NOT EXISTS public.wedding_deposit_workflow_allocation_payments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    allocation_id uuid NOT NULL
        REFERENCES public.wedding_deposit_workflow_allocations(id) ON DELETE RESTRICT,
    source_payment_transaction_id uuid NOT NULL
        REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
    amount numeric(14,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wedding_deposit_allocation_payments_positive_amount
        CHECK (amount > 0::numeric),
    CONSTRAINT wedding_deposit_allocation_payments_allocation_payment_key
        UNIQUE (allocation_id, source_payment_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_wedding_deposit_allocation_payments_payment
    ON public.wedding_deposit_workflow_allocation_payments
        (source_payment_transaction_id, allocation_id);

COMMENT ON TABLE public.wedding_deposit_workflow_allocation_payments IS
    'Exact original tender chunks assigned to each wedding deposit member allocation.';

CREATE TABLE IF NOT EXISTS public.customer_open_deposit_source_event_payments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    source_event_id uuid NOT NULL
        REFERENCES public.customer_open_deposit_source_events(id) ON DELETE RESTRICT,
    source_payment_transaction_id uuid NOT NULL
        REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
    amount numeric(14,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_open_deposit_source_event_payments_positive_amount
        CHECK (amount > 0::numeric),
    CONSTRAINT customer_open_deposit_source_event_payments_event_payment_key
        UNIQUE (source_event_id, source_payment_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_open_deposit_source_event_payments_payment
    ON public.customer_open_deposit_source_event_payments
        (source_payment_transaction_id, source_event_id);

COMMENT ON TABLE public.customer_open_deposit_source_event_payments IS
    'Exact original tender chunks consumed or restored by a held wedding-deposit source event.';

-- Backfill held allocations from their already exact open-deposit source rows.
INSERT INTO public.wedding_deposit_workflow_allocation_payments (
    allocation_id,
    source_payment_transaction_id,
    amount
)
SELECT
    allocation.id,
    source.source_payment_transaction_id,
    source.amount
FROM public.wedding_deposit_workflow_allocations allocation
INNER JOIN public.customer_open_deposit_ledger_sources source
    ON source.ledger_id = allocation.held_credit_ledger_id
WHERE allocation.destination_kind = 'held_for_future_order'
ON CONFLICT (allocation_id, source_payment_transaction_id) DO NOTHING;

-- Direct allocations written by migration 174 identify their exact member in
-- payment_allocations metadata. Preserve those payment chunks as well.
INSERT INTO public.wedding_deposit_workflow_allocation_payments (
    allocation_id,
    source_payment_transaction_id,
    amount
)
SELECT
    allocation.id,
    payment_allocation.transaction_id,
    payment_allocation.amount_allocated
FROM public.wedding_deposit_workflow_allocations allocation
INNER JOIN public.wedding_deposit_workflows workflow
    ON workflow.id = allocation.workflow_id
INNER JOIN public.payment_allocations payment_allocation
    ON payment_allocation.target_transaction_id = allocation.target_transaction_id
   AND payment_allocation.metadata->>'kind' = 'wedding_group_disbursement'
   AND payment_allocation.metadata->>'wedding_member_id' = allocation.wedding_member_id::text
INNER JOIN public.payment_transactions payment
    ON payment.id = payment_allocation.transaction_id
   AND payment.payer_id = workflow.payer_customer_id
WHERE allocation.destination_kind = 'existing_transaction'
  AND payment_allocation.amount_allocated > 0
ON CONFLICT (allocation_id, source_payment_transaction_id) DO NOTHING;

-- Migration 174 was not yet released with production workflow rows, but retain
-- an unambiguous compatibility backfill for any local/test redemption whose
-- held credit came from exactly one payment transaction.
WITH single_payment_sources AS (
    SELECT
        sources.ledger_id,
        (ARRAY_AGG(sources.source_payment_transaction_id ORDER BY sources.id))[1]
            AS source_payment_transaction_id
    FROM public.customer_open_deposit_ledger_sources sources
    GROUP BY sources.ledger_id
    HAVING COUNT(DISTINCT sources.source_payment_transaction_id) = 1
)
INSERT INTO public.customer_open_deposit_source_event_payments (
    source_event_id,
    source_payment_transaction_id,
    amount
)
SELECT
    source_event.id,
    single_source.source_payment_transaction_id,
    source_event.amount
FROM public.customer_open_deposit_source_events source_event
INNER JOIN single_payment_sources single_source
    ON single_source.ledger_id = source_event.source_credit_ledger_id
ON CONFLICT (source_event_id, source_payment_transaction_id) DO NOTHING;

INSERT INTO public.ros_schema_migrations (version, file_sha256)
VALUES ('175_wedding_deposit_refund_sources.sql', NULL)
ON CONFLICT (version) DO NOTHING;
