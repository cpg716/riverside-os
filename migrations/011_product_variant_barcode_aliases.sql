CREATE TABLE IF NOT EXISTS public.product_variant_barcode_aliases (
    id bigserial PRIMARY KEY,
    variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
    alias_value text NOT NULL,
    normalized_alias text GENERATED ALWAYS AS (lower(TRIM(BOTH FROM alias_value))) STORED,
    alias_type text NOT NULL,
    source_system text NOT NULL,
    source_file_name text,
    source_file_hash text,
    source_row_number integer,
    source_row_hash text,
    counterpoint_item_key text,
    family_key text,
    match_method text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_variant_barcode_alias_value_chk CHECK (TRIM(BOTH FROM alias_value) <> ''::text),
    CONSTRAINT product_variant_barcode_alias_type_chk CHECK (
        alias_type = ANY (ARRAY[
            'counterpoint_b_sku'::text,
            'upc'::text,
            'ean'::text,
            'vendor_upc'::text,
            'manual'::text
        ])
    ),
    CONSTRAINT product_variant_barcode_alias_status_chk CHECK (
        status = ANY (ARRAY[
            'active'::text,
            'quarantined'::text,
            'replaced'::text,
            'rejected'::text
        ])
    ),
    CONSTRAINT product_variant_barcode_alias_source_row_number_chk CHECK (
        source_row_number IS NULL OR source_row_number > 0
    ),
    CONSTRAINT product_variant_barcode_alias_normalized_chk CHECK (normalized_alias <> ''::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS product_variant_barcode_aliases_active_alias_uidx
    ON public.product_variant_barcode_aliases (normalized_alias)
    WHERE status = 'active'::text;

CREATE INDEX IF NOT EXISTS product_variant_barcode_aliases_variant_idx
    ON public.product_variant_barcode_aliases (variant_id);

CREATE INDEX IF NOT EXISTS product_variant_barcode_aliases_source_file_idx
    ON public.product_variant_barcode_aliases (
        source_system,
        source_file_hash,
        source_row_number
    )
    WHERE source_file_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_variant_barcode_aliases_source_row_hash_idx
    ON public.product_variant_barcode_aliases (source_system, source_row_hash)
    WHERE source_row_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_variant_barcode_aliases_status_idx
    ON public.product_variant_barcode_aliases (status, created_at DESC);

COMMENT ON TABLE public.product_variant_barcode_aliases IS
    'Reviewable scan aliases for product variants. Counterpoint B-SKUs live here instead of product_variants.barcode so aliases can remain source-attributed and many-to-one.';

COMMENT ON COLUMN public.product_variant_barcode_aliases.normalized_alias IS
    'Generated lower(trim(alias_value)) value used for deterministic alias conflict checks.';
