\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.procurement_import_documents (
    id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
    vendor_id uuid REFERENCES public.vendors(id),
    document_kind text NOT NULL DEFAULT 'unknown',
    status text NOT NULL DEFAULT 'uploaded',
    source_filename text NOT NULL,
    content_type text NOT NULL,
    storage_path text,
    sha256 text NOT NULL,
    file_size_bytes bigint NOT NULL,
    raw_text text,
    extracted_json jsonb,
    llm_model text,
    llm_prompt_version text,
    extraction_confidence numeric(5,4),
    vendor_name_guess text,
    invoice_number text,
    external_po_number text,
    document_date date,
    due_date date,
    freight_total numeric(12,2) NOT NULL DEFAULT 0,
    tax_total numeric(12,2) NOT NULL DEFAULT 0,
    discount_total numeric(12,2) NOT NULL DEFAULT 0,
    document_total numeric(12,2),
    duplicate_of_document_id uuid REFERENCES public.procurement_import_documents(id),
    approved_by uuid REFERENCES public.staff(id),
    converted_purchase_order_id uuid REFERENCES public.purchase_orders(id),
    created_by uuid REFERENCES public.staff(id),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT procurement_import_documents_kind_chk CHECK (
        document_kind = ANY (ARRAY[
            'unknown'::text,
            'purchase_order'::text,
            'order_confirmation'::text,
            'packing_slip'::text,
            'invoice'::text,
            'credit_memo'::text,
            'statement'::text
        ])
    ),
    CONSTRAINT procurement_import_documents_status_chk CHECK (
        status = ANY (ARRAY[
            'uploaded'::text,
            'extracted'::text,
            'matched'::text,
            'needs_review'::text,
            'approved'::text,
            'converted'::text,
            'failed'::text,
            'cancelled'::text
        ])
    ),
    CONSTRAINT procurement_import_documents_file_size_chk CHECK (file_size_bytes >= 0),
    CONSTRAINT procurement_import_documents_freight_chk CHECK (freight_total >= 0),
    CONSTRAINT procurement_import_documents_tax_chk CHECK (tax_total >= 0),
    CONSTRAINT procurement_import_documents_discount_chk CHECK (discount_total >= 0),
    CONSTRAINT procurement_import_documents_total_chk CHECK (document_total IS NULL OR document_total >= 0),
    CONSTRAINT procurement_import_documents_confidence_chk CHECK (
        extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)
    )
);

CREATE INDEX IF NOT EXISTS procurement_import_documents_vendor_date_idx
    ON public.procurement_import_documents (vendor_id, document_date DESC NULLS LAST, created_at DESC);

CREATE INDEX IF NOT EXISTS procurement_import_documents_invoice_vendor_idx
    ON public.procurement_import_documents (vendor_id, lower(invoice_number))
    WHERE invoice_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS procurement_import_documents_sha256_idx
    ON public.procurement_import_documents (sha256);

CREATE INDEX IF NOT EXISTS procurement_import_documents_status_idx
    ON public.procurement_import_documents (status, created_at DESC);

CREATE INDEX IF NOT EXISTS procurement_import_documents_duplicate_idx
    ON public.procurement_import_documents (duplicate_of_document_id)
    WHERE duplicate_of_document_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.procurement_import_lines (
    id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES public.procurement_import_documents(id) ON DELETE CASCADE,
    line_index integer NOT NULL,
    raw_line jsonb NOT NULL DEFAULT '{}'::jsonb,
    vendor_sku text,
    vendor_upc text,
    barcode text,
    manufacturer_sku text,
    description text,
    product_name text,
    brand text,
    color text,
    size text,
    fit text,
    quantity numeric(12,3) NOT NULL,
    unit_cost numeric(12,4) NOT NULL DEFAULT 0,
    line_total numeric(12,2),
    match_status text NOT NULL DEFAULT 'unmatched',
    matched_variant_id uuid REFERENCES public.product_variants(id),
    matched_product_id uuid REFERENCES public.products(id),
    match_confidence numeric(5,4),
    match_reason text,
    review_action text NOT NULL DEFAULT 'needs_review',
    review_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    staff_notes text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT procurement_import_lines_quantity_chk CHECK (quantity > 0 OR review_action = 'ignore'),
    CONSTRAINT procurement_import_lines_unit_cost_chk CHECK (unit_cost >= 0),
    CONSTRAINT procurement_import_lines_total_chk CHECK (line_total IS NULL OR line_total >= 0),
    CONSTRAINT procurement_import_lines_confidence_chk CHECK (
        match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)
    ),
    CONSTRAINT procurement_import_lines_status_chk CHECK (
        match_status = ANY (ARRAY[
            'exact'::text,
            'likely'::text,
            'new_variant'::text,
            'new_product'::text,
            'unmatched'::text,
            'ignored'::text
        ])
    ),
    CONSTRAINT procurement_import_lines_action_chk CHECK (
        review_action = ANY (ARRAY[
            'use_existing_variant'::text,
            'create_variant'::text,
            'create_product'::text,
            'ignore'::text,
            'needs_review'::text
        ])
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS procurement_import_lines_document_line_uidx
    ON public.procurement_import_lines (document_id, line_index);

CREATE INDEX IF NOT EXISTS procurement_import_lines_matched_variant_idx
    ON public.procurement_import_lines (matched_variant_id)
    WHERE matched_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS procurement_import_lines_matched_product_idx
    ON public.procurement_import_lines (matched_product_id)
    WHERE matched_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS procurement_import_lines_vendor_sku_idx
    ON public.procurement_import_lines (lower(vendor_sku))
    WHERE vendor_sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS procurement_import_lines_vendor_upc_idx
    ON public.procurement_import_lines (lower(vendor_upc))
    WHERE vendor_upc IS NOT NULL;

CREATE INDEX IF NOT EXISTS procurement_import_lines_barcode_idx
    ON public.procurement_import_lines (lower(barcode))
    WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.procurement_vendor_document_profiles (
    id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
    vendor_id uuid NOT NULL UNIQUE REFERENCES public.vendors(id) ON DELETE CASCADE,
    profile_name text NOT NULL,
    column_aliases jsonb NOT NULL DEFAULT '{}'::jsonb,
    value_aliases jsonb NOT NULL DEFAULT '{}'::jsonb,
    document_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_learned_from_document_id uuid REFERENCES public.procurement_import_documents(id),
    successful_import_count integer NOT NULL DEFAULT 0,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT procurement_vendor_document_profiles_count_chk CHECK (successful_import_count >= 0)
);

CREATE TABLE IF NOT EXISTS public.procurement_import_line_corrections (
    id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES public.procurement_import_documents(id) ON DELETE CASCADE,
    line_id uuid REFERENCES public.procurement_import_lines(id) ON DELETE SET NULL,
    vendor_id uuid REFERENCES public.vendors(id),
    correction_kind text NOT NULL,
    before_value jsonb,
    after_value jsonb NOT NULL,
    created_by uuid REFERENCES public.staff(id),
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS procurement_import_line_corrections_document_idx
    ON public.procurement_import_line_corrections (document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS procurement_import_line_corrections_vendor_idx
    ON public.procurement_import_line_corrections (vendor_id, correction_kind, created_at DESC);
