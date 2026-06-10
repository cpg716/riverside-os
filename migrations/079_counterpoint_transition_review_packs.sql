\set ON_ERROR_STOP on

-- Counterpoint Transition Review Packs.
-- Manual export/import workflow only; no runtime AI calls and no historical data repair.

CREATE TABLE IF NOT EXISTS public.counterpoint_review_packs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pack_id text NOT NULL UNIQUE,
    scope text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    source_hash text NOT NULL,
    generated_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    generated_at timestamptz NOT NULL DEFAULT now(),
    row_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'generated',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT counterpoint_review_packs_row_count_chk CHECK (row_count >= 0),
    CONSTRAINT counterpoint_review_packs_scope_chk CHECK (
        scope = ANY (ARRAY[
            'inventory_catalog',
            'customer_dedupe',
            'ticket_financial',
            'tender_mapping',
            'gift_card_liability',
            'open_orders_layaways',
            'returns_readiness',
            'cutover_audit'
        ]::text[])
    ),
    CONSTRAINT counterpoint_review_packs_status_chk CHECK (
        status = ANY (ARRAY['generated', 'superseded', 'imported', 'archived']::text[])
    )
);

CREATE TABLE IF NOT EXISTS public.counterpoint_review_pack_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pack_id uuid NOT NULL REFERENCES public.counterpoint_review_packs(id) ON DELETE CASCADE,
    row_key text NOT NULL,
    entity_type text NOT NULL,
    entity_ref text,
    payload jsonb NOT NULL,
    source_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT counterpoint_review_pack_rows_row_key_chk CHECK (btrim(row_key) <> ''),
    CONSTRAINT counterpoint_review_pack_rows_entity_type_chk CHECK (btrim(entity_type) <> ''),
    CONSTRAINT counterpoint_review_pack_rows_unique_key UNIQUE (pack_id, row_key)
);

CREATE TABLE IF NOT EXISTS public.counterpoint_ai_review_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id text NOT NULL UNIQUE,
    source_pack_id uuid NOT NULL REFERENCES public.counterpoint_review_packs(id) ON DELETE CASCADE,
    imported_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    provider_label text NOT NULL DEFAULT 'unknown',
    schema_version integer NOT NULL DEFAULT 1,
    imported_file_name text,
    source_hash text NOT NULL,
    status text NOT NULL DEFAULT 'validated',
    validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT counterpoint_ai_review_imports_status_chk CHECK (
        status = ANY (ARRAY['validated', 'rejected', 'stored']::text[])
    )
);

CREATE TABLE IF NOT EXISTS public.counterpoint_ai_review_suggestions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id uuid NOT NULL REFERENCES public.counterpoint_ai_review_imports(id) ON DELETE CASCADE,
    pack_id uuid NOT NULL REFERENCES public.counterpoint_review_packs(id) ON DELETE CASCADE,
    row_id uuid REFERENCES public.counterpoint_review_pack_rows(id) ON DELETE SET NULL,
    row_key text NOT NULL,
    scope text NOT NULL,
    action text NOT NULL,
    field_name text,
    current_value jsonb,
    suggested_value jsonb,
    confidence numeric(5,4),
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    reviewed_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    reviewed_at timestamptz,
    applied_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    applied_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT counterpoint_ai_review_suggestions_confidence_chk CHECK (
        confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    ),
    CONSTRAINT counterpoint_ai_review_suggestions_reason_chk CHECK (btrim(reason) <> ''),
    CONSTRAINT counterpoint_ai_review_suggestions_status_chk CHECK (
        status = ANY (ARRAY['pending', 'accepted', 'rejected', 'edited', 'blocked', 'applied']::text[])
    ),
    CONSTRAINT counterpoint_ai_review_suggestions_scope_chk CHECK (
        scope = ANY (ARRAY[
            'inventory_catalog',
            'customer_dedupe',
            'ticket_financial',
            'tender_mapping',
            'gift_card_liability',
            'open_orders_layaways',
            'returns_readiness',
            'cutover_audit'
        ]::text[])
    )
);

CREATE INDEX IF NOT EXISTS idx_counterpoint_review_packs_generated
    ON public.counterpoint_review_packs (generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_counterpoint_review_packs_scope_status
    ON public.counterpoint_review_packs (scope, status, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_counterpoint_review_pack_rows_pack
    ON public.counterpoint_review_pack_rows (pack_id, row_key);

CREATE INDEX IF NOT EXISTS idx_counterpoint_ai_review_imports_pack
    ON public.counterpoint_ai_review_imports (source_pack_id, imported_at DESC);

CREATE INDEX IF NOT EXISTS idx_counterpoint_ai_review_suggestions_pack_status
    ON public.counterpoint_ai_review_suggestions (pack_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_counterpoint_ai_review_suggestions_row
    ON public.counterpoint_ai_review_suggestions (pack_id, row_key);

COMMENT ON TABLE public.counterpoint_review_packs IS
    'Manual Counterpoint transition review exports generated from ROS source data for operator-controlled ChatGPT/Codex review.';

COMMENT ON TABLE public.counterpoint_review_pack_rows IS
    'Immutable row payloads and hashes for Counterpoint transition review packs.';

COMMENT ON TABLE public.counterpoint_ai_review_imports IS
    'Audited manual imports of externally reviewed Counterpoint transition suggestion files.';

COMMENT ON TABLE public.counterpoint_ai_review_suggestions IS
    'Validated, staff-reviewed suggestions from manual Counterpoint transition review imports; high-risk scopes are review-only.';
