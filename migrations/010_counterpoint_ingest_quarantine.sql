CREATE TABLE IF NOT EXISTS public.counterpoint_ingest_quarantine (
    id bigserial PRIMARY KEY,
    ingest_type text NOT NULL,
    issue_type text NOT NULL,
    severity text NOT NULL,
    message text NOT NULL,
    normalized_sku text,
    counterpoint_item_key text,
    family_key text,
    option_values jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_reference jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_row jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT counterpoint_ingest_quarantine_ingest_type_chk
        CHECK (ingest_type = ANY (ARRAY['inventory'::text, 'catalog'::text]))
);

CREATE INDEX IF NOT EXISTS counterpoint_ingest_quarantine_created_idx
    ON public.counterpoint_ingest_quarantine (created_at DESC);

CREATE INDEX IF NOT EXISTS counterpoint_ingest_quarantine_type_created_idx
    ON public.counterpoint_ingest_quarantine (ingest_type, created_at DESC);

CREATE INDEX IF NOT EXISTS counterpoint_ingest_quarantine_sku_idx
    ON public.counterpoint_ingest_quarantine (normalized_sku)
    WHERE normalized_sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS counterpoint_ingest_quarantine_family_idx
    ON public.counterpoint_ingest_quarantine (family_key)
    WHERE family_key IS NOT NULL;

COMMENT ON TABLE public.counterpoint_ingest_quarantine IS
    'Append-only review records for Counterpoint catalog/inventory rows skipped by identity preflight quarantine. Review-only; does not drive live inventory writes.';
