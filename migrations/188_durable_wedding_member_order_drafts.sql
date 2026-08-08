-- Preserve Collect & Build member drafts on the funded wedding-deposit
-- workflow and bind each required member Transaction to one stable checkout
-- identity. Financial posting remains in the normal atomic checkout path.

ALTER TABLE public.wedding_deposit_workflow_allocations
    ADD COLUMN IF NOT EXISTS member_order_required boolean NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS member_checkout_client_id uuid,
    ADD COLUMN IF NOT EXISTS member_order_draft jsonb,
    ADD COLUMN IF NOT EXISTS member_order_draft_saved_at timestamptz,
    ADD COLUMN IF NOT EXISTS member_order_draft_saved_by_staff_id uuid
        REFERENCES public.staff(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wedding_deposit_member_checkout_identity
    ON public.wedding_deposit_workflow_allocations (member_checkout_client_id)
    WHERE member_checkout_client_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'wedding_deposit_member_order_draft_shape'
          AND conrelid = 'public.wedding_deposit_workflow_allocations'::regclass
    ) THEN
        ALTER TABLE public.wedding_deposit_workflow_allocations
            ADD CONSTRAINT wedding_deposit_member_order_draft_shape CHECK (
                member_order_required = FALSE
                OR (
                    destination_kind = 'held_for_future_order'
                    AND member_checkout_client_id IS NOT NULL
                    AND member_order_draft IS NOT NULL
                    AND jsonb_typeof(member_order_draft) = 'object'
                    AND member_order_draft_saved_at IS NOT NULL
                )
            );
    END IF;
END
$$;

COMMENT ON COLUMN public.wedding_deposit_workflow_allocations.member_order_required IS
    'True when Collect & Build requires one exact member Transaction before the Builder may report completion.';

COMMENT ON COLUMN public.wedding_deposit_workflow_allocations.member_checkout_client_id IS
    'Stable idempotency identity required for the reviewed member-order draft checkout.';

COMMENT ON COLUMN public.wedding_deposit_workflow_allocations.member_order_draft IS
    'Nonfinancial reviewed member-order draft; normal server-validated checkout remains authoritative.';
