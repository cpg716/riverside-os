-- Physical inventory readiness controls: first-inventory classification,
-- discovered scan capture, explicit Manager Access signoff, and accounting impact rows.

ALTER TABLE public.physical_inventory_sessions
    ADD COLUMN IF NOT EXISTS baseline_type text NOT NULL DEFAULT 'normal';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'physical_inventory_sessions_baseline_type_check'
    ) THEN
        ALTER TABLE public.physical_inventory_sessions
            ADD CONSTRAINT physical_inventory_sessions_baseline_type_check
            CHECK (baseline_type = ANY (ARRAY['normal'::text, 'first_inventory'::text, 'baseline_correction'::text]));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.physical_inventory_discovered_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid NOT NULL REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE,
    scanned_code text NOT NULL,
    scan_source text NOT NULL DEFAULT 'laser',
    first_scanned_by uuid REFERENCES public.staff(id),
    last_scanned_by uuid REFERENCES public.staff(id),
    first_scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    last_scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    scan_count integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    resolved_variant_id uuid REFERENCES public.product_variants(id),
    resolution_note text,
    resolved_by uuid REFERENCES public.staff(id),
    resolved_at timestamp with time zone,
    CONSTRAINT physical_inventory_discovered_items_pkey PRIMARY KEY (id),
    CONSTRAINT physical_inventory_discovered_items_scan_count_check CHECK (scan_count > 0),
    CONSTRAINT physical_inventory_discovered_items_scan_source_check CHECK (scan_source = ANY (ARRAY['laser'::text, 'camera'::text, 'manual'::text])),
    CONSTRAINT physical_inventory_discovered_items_status_check CHECK (status = ANY (ARRAY['pending'::text, 'resolved'::text, 'ignored'::text])),
    CONSTRAINT physical_inventory_discovered_items_session_code_key UNIQUE (session_id, scanned_code)
);

CREATE INDEX IF NOT EXISTS idx_pi_discovered_session_status
    ON public.physical_inventory_discovered_items (session_id, status);

CREATE INDEX IF NOT EXISTS idx_pi_discovered_code
    ON public.physical_inventory_discovered_items (scanned_code);

CREATE TABLE IF NOT EXISTS public.physical_inventory_approvals (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid NOT NULL REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE,
    approval_kind text DEFAULT 'publish' NOT NULL,
    approved_by uuid NOT NULL REFERENCES public.staff(id),
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    approval_note text,
    variance_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT physical_inventory_approvals_pkey PRIMARY KEY (id),
    CONSTRAINT physical_inventory_approvals_kind_check CHECK (approval_kind = ANY (ARRAY['publish'::text, 'baseline'::text]))
);

CREATE INDEX IF NOT EXISTS idx_pi_approvals_session
    ON public.physical_inventory_approvals (session_id, approved_at DESC);

CREATE TABLE IF NOT EXISTS public.physical_inventory_accounting_impacts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid NOT NULL REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE,
    variant_id uuid NOT NULL REFERENCES public.product_variants(id),
    quantity_delta integer NOT NULL,
    unit_cost numeric(12,4) NOT NULL,
    extended_cost numeric(14,4) NOT NULL,
    impact_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT physical_inventory_accounting_impacts_pkey PRIMARY KEY (id),
    CONSTRAINT physical_inventory_accounting_impacts_type_check CHECK (impact_type = ANY (ARRAY['shrinkage'::text, 'surplus'::text, 'no_change'::text])),
    CONSTRAINT physical_inventory_accounting_impacts_session_variant_key UNIQUE (session_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_pi_accounting_session
    ON public.physical_inventory_accounting_impacts (session_id);

CREATE INDEX IF NOT EXISTS idx_pi_accounting_variant
    ON public.physical_inventory_accounting_impacts (variant_id);

CREATE INDEX IF NOT EXISTS idx_pi_counts_session_last_scanned
    ON public.physical_inventory_counts (session_id, last_scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_lines_variant_transaction
    ON public.transaction_lines (variant_id, transaction_id);

COMMENT ON COLUMN public.physical_inventory_sessions.baseline_type IS
    'Classifies the count as normal operations, first inventory cleanup, or baseline correction.';
COMMENT ON TABLE public.physical_inventory_discovered_items IS
    'Unknown barcode/SKU scans captured during physical inventory for catalog setup or manager resolution before publish.';
COMMENT ON TABLE public.physical_inventory_approvals IS
    'Explicit Manager Access signoff records for physical inventory publish and baseline approvals.';
COMMENT ON TABLE public.physical_inventory_accounting_impacts IS
    'Materialized physical inventory value impact rows used by the workspace reports and accounting review.';
