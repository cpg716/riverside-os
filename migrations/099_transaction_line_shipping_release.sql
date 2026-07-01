-- Line-level shipping release tracking for partial order fulfillment.

ALTER TABLE public.transaction_lines
    ADD COLUMN IF NOT EXISTS shipped_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS shipped_by uuid,
    ADD COLUMN IF NOT EXISTS shipment_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'transaction_lines_shipped_by_fkey'
    ) THEN
        ALTER TABLE public.transaction_lines
            ADD CONSTRAINT transaction_lines_shipped_by_fkey
            FOREIGN KEY (shipped_by) REFERENCES public.staff(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'transaction_lines_shipment_id_fkey'
    ) THEN
        ALTER TABLE public.transaction_lines
            ADD CONSTRAINT transaction_lines_shipment_id_fkey
            FOREIGN KEY (shipment_id) REFERENCES public.shipment(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transaction_lines_shipped_at
    ON public.transaction_lines (shipped_at)
    WHERE shipped_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_lines_shipment_id
    ON public.transaction_lines (shipment_id)
    WHERE shipment_id IS NOT NULL;
