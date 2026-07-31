-- Resumable, source-tracked wedding deposit workflows.
-- Existing payment, allocation, transaction, and open-deposit ledgers remain
-- the financial authorities; these tables preserve the operator workflow and
-- exact source-to-redemption audit chain.

CREATE TABLE IF NOT EXISTS public.wedding_deposit_workflows (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    payer_transaction_id uuid NOT NULL REFERENCES public.transactions(id),
    payer_customer_id uuid NOT NULL REFERENCES public.customers(id),
    payer_wedding_member_id uuid REFERENCES public.wedding_members(id) ON DELETE SET NULL,
    wedding_party_id uuid NOT NULL REFERENCES public.wedding_parties(id),
    register_session_id uuid NOT NULL REFERENCES public.register_sessions(id),
    operator_staff_id uuid NOT NULL REFERENCES public.staff(id),
    primary_salesperson_id uuid REFERENCES public.staff(id),
    total_amount numeric(14,2) NOT NULL,
    status text NOT NULL DEFAULT 'funded',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wedding_deposit_workflows_positive_total CHECK (total_amount > 0::numeric),
    CONSTRAINT wedding_deposit_workflows_status_check
        CHECK (status IN ('funded', 'partially_ordered', 'complete', 'voided')),
    CONSTRAINT wedding_deposit_workflows_payer_transaction_key UNIQUE (payer_transaction_id)
);

CREATE TABLE IF NOT EXISTS public.wedding_deposit_workflow_allocations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    workflow_id uuid NOT NULL REFERENCES public.wedding_deposit_workflows(id) ON DELETE RESTRICT,
    wedding_member_id uuid NOT NULL REFERENCES public.wedding_members(id),
    beneficiary_customer_id uuid NOT NULL REFERENCES public.customers(id),
    amount numeric(14,2) NOT NULL,
    destination_kind text NOT NULL,
    target_transaction_id uuid REFERENCES public.transactions(id),
    held_credit_ledger_id uuid REFERENCES public.customer_open_deposit_ledger(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wedding_deposit_workflow_allocations_positive_amount CHECK (amount > 0::numeric),
    CONSTRAINT wedding_deposit_workflow_allocations_destination_check
        CHECK (destination_kind IN ('held_for_future_order', 'existing_transaction')),
    CONSTRAINT wedding_deposit_workflow_allocations_destination_shape CHECK (
        (destination_kind = 'held_for_future_order' AND target_transaction_id IS NULL AND held_credit_ledger_id IS NOT NULL)
        OR
        (destination_kind = 'existing_transaction' AND target_transaction_id IS NOT NULL AND held_credit_ledger_id IS NULL)
    ),
    CONSTRAINT wedding_deposit_workflow_allocations_member_key UNIQUE (workflow_id, wedding_member_id)
);

CREATE TABLE IF NOT EXISTS public.customer_open_deposit_source_events (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    source_credit_ledger_id uuid NOT NULL REFERENCES public.customer_open_deposit_ledger(id) ON DELETE RESTRICT,
    ledger_event_id uuid NOT NULL REFERENCES public.customer_open_deposit_ledger(id) ON DELETE RESTRICT,
    event_kind text NOT NULL,
    amount numeric(14,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_open_deposit_source_events_kind_check
        CHECK (event_kind IN ('redemption', 'restoration')),
    CONSTRAINT customer_open_deposit_source_events_positive_amount CHECK (amount > 0::numeric),
    CONSTRAINT customer_open_deposit_source_events_event_key
        UNIQUE (ledger_event_id, source_credit_ledger_id, event_kind)
);

CREATE INDEX IF NOT EXISTS idx_wedding_deposit_workflows_payer
    ON public.wedding_deposit_workflows (payer_customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wedding_deposit_workflows_party
    ON public.wedding_deposit_workflows (wedding_party_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wedding_deposit_allocations_workflow
    ON public.wedding_deposit_workflow_allocations (workflow_id, created_at);

CREATE INDEX IF NOT EXISTS idx_wedding_deposit_allocations_customer
    ON public.wedding_deposit_workflow_allocations (beneficiary_customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_open_deposit_source_events_credit
    ON public.customer_open_deposit_source_events (source_credit_ledger_id, created_at);

COMMENT ON TABLE public.wedding_deposit_workflows IS
    'Funded wedding deposit batches anchored to one payer Transaction and one physical tender event.';

COMMENT ON TABLE public.wedding_deposit_workflow_allocations IS
    'Per-member destinations for a funded wedding deposit batch; financial values remain authoritative in payment allocations and open-deposit ledgers.';

COMMENT ON TABLE public.customer_open_deposit_source_events IS
    'Exact credit-source attribution for open-deposit redemption and restoration ledger events.';

-- A Register-started party may intentionally begin with only Party Name and
-- Wedding Date. Keep its public tracking number meaningful until a groom is
-- identified, while preserving the existing collision suffix behavior.
CREATE OR REPLACE FUNCTION assign_wedding_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    base_number TEXT;
    candidate TEXT;
    ordinal INTEGER := 0;
BEGIN
    base_number := wedding_number_base(
        COALESCE(NULLIF(TRIM(NEW.groom_name), ''), NULLIF(TRIM(NEW.party_name), ''), 'WEDDING'),
        NEW.event_date
    );

    LOOP
        candidate := base_number || wedding_number_suffix(ordinal);
        EXIT WHEN NOT EXISTS (
            SELECT 1
            FROM wedding_parties existing
            WHERE existing.wedding_number = candidate
              AND existing.id IS DISTINCT FROM NEW.id
        );
        ordinal := ordinal + 1;
    END LOOP;

    NEW.wedding_number := candidate;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wedding_parties_assign_wedding_number ON wedding_parties;

CREATE TRIGGER wedding_parties_assign_wedding_number
BEFORE INSERT OR UPDATE OF groom_name, party_name, event_date, wedding_number
ON wedding_parties
FOR EACH ROW
EXECUTE FUNCTION assign_wedding_number();
