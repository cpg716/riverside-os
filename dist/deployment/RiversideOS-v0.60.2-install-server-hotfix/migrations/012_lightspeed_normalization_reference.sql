CREATE TABLE IF NOT EXISTS public.lightspeed_normalization_batches (
    id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
    source_file_name text NOT NULL,
    source_file_hash text NOT NULL,
    row_count integer NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lightspeed_normalization_batches_file_name_chk CHECK (TRIM(BOTH FROM source_file_name) <> ''::text),
    CONSTRAINT lightspeed_normalization_batches_file_hash_chk CHECK (TRIM(BOTH FROM source_file_hash) <> ''::text),
    CONSTRAINT lightspeed_normalization_batches_row_count_chk CHECK (row_count >= 0),
    CONSTRAINT lightspeed_normalization_batches_status_chk CHECK (
        status = ANY (ARRAY[
            'active'::text,
            'archived'::text
        ])
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS lightspeed_normalization_batches_active_uidx
    ON public.lightspeed_normalization_batches ((status))
    WHERE status = 'active'::text;

CREATE INDEX IF NOT EXISTS lightspeed_normalization_batches_imported_idx
    ON public.lightspeed_normalization_batches (imported_at DESC);

CREATE TABLE IF NOT EXISTS public.lightspeed_normalization_reference_rows (
    id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
    batch_id uuid NOT NULL REFERENCES public.lightspeed_normalization_batches(id) ON DELETE CASCADE,
    source_row_number integer NOT NULL,
    source_row_hash text NOT NULL,
    sku text NOT NULL,
    normalized_sku text GENERATED ALWAYS AS (lower(TRIM(BOTH FROM sku))) STORED,
    handle text,
    product_name text,
    product_category text,
    supplier_name text,
    supplier_code text,
    brand_name text,
    tags text,
    variant_option_one_name text,
    variant_option_one_value text,
    variant_option_two_name text,
    variant_option_two_value text,
    variant_option_three_name text,
    variant_option_three_value text,
    raw_row jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lightspeed_normalization_reference_rows_row_number_chk CHECK (source_row_number > 0),
    CONSTRAINT lightspeed_normalization_reference_rows_row_hash_chk CHECK (TRIM(BOTH FROM source_row_hash) <> ''::text),
    CONSTRAINT lightspeed_normalization_reference_rows_sku_chk CHECK (TRIM(BOTH FROM sku) <> ''::text),
    CONSTRAINT lightspeed_normalization_reference_rows_normalized_sku_chk CHECK (normalized_sku <> ''::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS lightspeed_normalization_reference_rows_batch_row_uidx
    ON public.lightspeed_normalization_reference_rows (batch_id, source_row_number);

CREATE UNIQUE INDEX IF NOT EXISTS lightspeed_normalization_reference_rows_batch_hash_uidx
    ON public.lightspeed_normalization_reference_rows (batch_id, source_row_hash);

CREATE INDEX IF NOT EXISTS lightspeed_normalization_reference_rows_batch_sku_idx
    ON public.lightspeed_normalization_reference_rows (batch_id, normalized_sku);

CREATE INDEX IF NOT EXISTS lightspeed_normalization_reference_rows_handle_idx
    ON public.lightspeed_normalization_reference_rows (batch_id, handle)
    WHERE handle IS NOT NULL AND TRIM(BOTH FROM handle) <> ''::text;

CREATE INDEX IF NOT EXISTS lightspeed_normalization_reference_rows_supplier_code_idx
    ON public.lightspeed_normalization_reference_rows (batch_id, supplier_code)
    WHERE supplier_code IS NOT NULL AND TRIM(BOTH FROM supplier_code) <> ''::text;

COMMENT ON TABLE public.lightspeed_normalization_batches IS
    'Reference-only Lightspeed normalization export batches for Product Cleanup Studio. These rows do not own inventory, cost, price, tax, or accounting truth.';

COMMENT ON TABLE public.lightspeed_normalization_reference_rows IS
    'Reference-only Lightspeed product rows matched later through Counterpoint B-SKU aliases. Data here must not mutate live products or variants directly.';
