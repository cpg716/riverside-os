-- Fail-closed protection for imported Counterpoint transactions whose exact
-- paid-price, tax, quantity, payment, or historical-refund evidence still
-- requires review. Staging a block changes no transaction, line, payment,
-- allocation, fulfillment, or inventory value.

CREATE TABLE IF NOT EXISTS public.counterpoint_return_review_blocks (
    manifest_key TEXT PRIMARY KEY,
    transaction_id UUID NOT NULL
        REFERENCES public.transactions(id) ON DELETE RESTRICT,
    display_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    reasons JSONB NOT NULL,
    review_manifest_digest TEXT NOT NULL,
    source_snapshot JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    blocked_by_staff_id UUID NOT NULL
        REFERENCES public.staff(id) ON DELETE RESTRICT,
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_by_staff_id UUID
        REFERENCES public.staff(id) ON DELETE RESTRICT,
    resolved_at TIMESTAMPTZ,
    resolution_reason TEXT,
    CONSTRAINT counterpoint_return_review_reasons_array_chk
        CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) > 0),
    CONSTRAINT counterpoint_return_review_snapshot_object_chk
        CHECK (jsonb_typeof(source_snapshot) = 'object'),
    CONSTRAINT counterpoint_return_review_digest_chk
        CHECK (review_manifest_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT counterpoint_return_review_resolution_chk
        CHECK (
            (active AND resolved_at IS NULL AND resolved_by_staff_id IS NULL
                AND resolution_reason IS NULL)
            OR
            (
                NOT active
                AND resolved_at IS NOT NULL
                AND resolved_by_staff_id IS NOT NULL
                AND length(btrim(resolution_reason)) >= 12
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS counterpoint_return_review_active_transaction_uidx
    ON public.counterpoint_return_review_blocks (transaction_id)
    WHERE active;

CREATE INDEX IF NOT EXISTS counterpoint_return_review_transaction_idx
    ON public.counterpoint_return_review_blocks (transaction_id, blocked_at DESC);

COMMENT ON TABLE public.counterpoint_return_review_blocks IS
    'Reviewed fail-closed return/refund blocks for imported Counterpoint transactions whose exact source financial or lifecycle evidence remains ambiguous. The table is safety metadata only and never changes money, quantities, fulfillment, payments, or inventory.';
