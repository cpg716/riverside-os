-- Riverside OS schema contract baseline.
-- Generated from the final pre-launch schema after legacy migrations through 188.
-- Do not place seed/test data in migrations.

\set ON_ERROR_STOP on
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- 002 Catalog Inventory

--
-- Name: category_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category_audit_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    category_id uuid NOT NULL,
    changed_field text NOT NULL,
    old_value text,
    new_value text,
    changed_by uuid,
    change_note text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: category_commission_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category_commission_overrides (
    category_id uuid NOT NULL,
    commission_rate numeric(5,4) NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: inventory_count_scan_stream; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_count_scan_stream (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    location_id uuid,
    quantity integer DEFAULT 1 NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text
);

--
-- Name: inventory_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_locations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    layout_id uuid,
    name text NOT NULL,
    zone_type text DEFAULT 'sales_floor'::text NOT NULL,
    geometry jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: inventory_map_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_map_layouts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    layout_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: inventory_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    variant_id uuid NOT NULL,
    tx_type public.inventory_tx_type NOT NULL,
    quantity_delta integer NOT NULL,
    unit_cost numeric(12,4),
    landed_cost_component numeric(12,4) DEFAULT 0,
    reference_table text,
    reference_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid
);

--
-- Name: ledger_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_mappings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    internal_key text NOT NULL,
    internal_description text,
    qbo_account_id text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: physical_inventory_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_inventory_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid NOT NULL,
    variant_id uuid,
    event_type text NOT NULL,
    old_qty integer,
    new_qty integer,
    note text,
    performed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: physical_inventory_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_inventory_counts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    counted_qty integer DEFAULT 0 NOT NULL,
    last_scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    scan_source text DEFAULT 'laser'::text NOT NULL,
    counted_by uuid,
    review_status text DEFAULT 'pending'::text NOT NULL,
    adjusted_qty integer,
    review_note text,
    CONSTRAINT physical_inventory_counts_adjusted_qty_check CHECK ((adjusted_qty >= 0)),
    CONSTRAINT physical_inventory_counts_review_status_check CHECK ((review_status = ANY (ARRAY['pending'::text, 'ok'::text, 'adjusted'::text]))),
    CONSTRAINT physical_inventory_counts_scan_source_check CHECK ((scan_source = ANY (ARRAY['laser'::text, 'camera'::text, 'manual'::text])))
);

--
-- Name: physical_inventory_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_inventory_sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_number text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    scope text DEFAULT 'full'::text NOT NULL,
    category_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    started_by uuid,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_saved_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    notes text,
    exclude_reserved boolean DEFAULT false,
    exclude_layaway boolean DEFAULT false,
    CONSTRAINT physical_inventory_sessions_scope_check CHECK ((scope = ANY (ARRAY['full'::text, 'category'::text]))),
    CONSTRAINT physical_inventory_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'reviewing'::text, 'published'::text, 'cancelled'::text])))
);

--
-- Name: physical_inventory_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_inventory_snapshots (
    session_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    stock_at_start integer NOT NULL
);

--
-- Name: product_bundle_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_bundle_components (
    bundle_product_id uuid NOT NULL,
    component_variant_id uuid NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    CONSTRAINT product_bundle_components_quantity_check CHECK ((quantity > 0))
);

--
-- Name: product_catalog_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_catalog_audit_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    product_id uuid NOT NULL,
    changed_by uuid,
    change_source text DEFAULT 'manual'::text NOT NULL,
    before_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    change_note text,
    suggestion_confidence double precision,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: product_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variants (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    product_id uuid NOT NULL,
    sku text NOT NULL,
    variation_values jsonb NOT NULL,
    variation_label text,
    stock_on_hand integer DEFAULT 0,
    reorder_point integer DEFAULT 2,
    images text[] DEFAULT '{}'::text[],
    retail_price_override numeric(12,2),
    cost_override numeric(12,2),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    shelf_labeled_at timestamp with time zone,
    barcode text,
    reserved_stock integer DEFAULT 0 NOT NULL,
    vendor_upc text,
    counterpoint_item_key text,
    track_low_stock boolean DEFAULT false NOT NULL,
    web_published boolean DEFAULT false NOT NULL,
    web_price_override numeric(12,2),
    web_gallery_order integer DEFAULT 0 NOT NULL,
    counterpoint_prc_2 numeric(12,2),
    counterpoint_prc_3 numeric(12,2),
    nuorder_id text,
    on_layaway integer DEFAULT 0 NOT NULL,
    default_location_id uuid,
    CONSTRAINT on_layaway_non_negative CHECK ((on_layaway >= 0)),
    CONSTRAINT reserved_stock_non_negative CHECK ((reserved_stock >= 0)),
    CONSTRAINT stock_reasonable_lower_bound CHECK ((stock_on_hand >= '-999'::integer))
);

--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    category_id uuid,
    catalog_handle text,
    name text NOT NULL,
    brand text,
    description text,
    base_retail_price numeric(12,2) NOT NULL,
    base_cost numeric(12,2) NOT NULL,
    spiff_amount numeric(12,2) DEFAULT 0.00,
    variation_axes text[] DEFAULT '{}'::text[],
    images text[] DEFAULT '{}'::text[],
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    primary_vendor_id uuid,
    excludes_from_loyalty boolean DEFAULT false NOT NULL,
    is_bundle boolean DEFAULT false NOT NULL,
    track_low_stock boolean DEFAULT false NOT NULL,
    pos_line_kind text,
    data_source text,
    tax_category public.tax_category DEFAULT 'clothing'::public.tax_category NOT NULL,
    employee_markup_percent numeric(5,2),
    employee_extra_amount numeric(12,2) DEFAULT 0 NOT NULL,
    nuorder_last_image_sync_at timestamp with time zone,
    tax_category_override public.tax_category,
    CONSTRAINT products_employee_extra_nonneg CHECK ((employee_extra_amount >= (0)::numeric)),
    CONSTRAINT products_pos_line_kind_chk CHECK (((pos_line_kind IS NULL) OR (pos_line_kind = ANY (ARRAY['rms_charge_payment'::text, 'pos_gift_card_load'::text, 'alteration_service'::text]))))
);

--
-- Name: purchase_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_order_lines (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    purchase_order_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    quantity_ordered integer NOT NULL,
    quantity_received integer DEFAULT 0 NOT NULL,
    unit_cost numeric(12,2) NOT NULL,
    landed_cost_per_unit numeric(12,4) DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT purchase_order_lines_quantity_ordered_check CHECK ((quantity_ordered > 0))
);

--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    po_number text NOT NULL,
    vendor_id uuid NOT NULL,
    status public.purchase_order_status DEFAULT 'draft'::public.purchase_order_status NOT NULL,
    ordered_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    expected_at timestamp with time zone,
    invoice_number text,
    freight_total numeric(12,2) DEFAULT 0,
    notes text,
    created_by uuid,
    po_kind text DEFAULT 'standard'::text NOT NULL,
    submitted_at timestamp with time zone,
    fully_received_at timestamp with time zone,
    split_from_po_id uuid,
    CONSTRAINT purchase_orders_po_kind_check CHECK ((po_kind = ANY (ARRAY['standard'::text, 'direct_invoice'::text])))
);

--
-- Name: receiving_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receiving_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    purchase_order_id uuid NOT NULL,
    received_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    invoice_number text,
    freight_total numeric(12,2) DEFAULT 0,
    received_by uuid,
    notes text
);

--
-- Name: vendor_brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_brands (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    vendor_id uuid NOT NULL,
    brand text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: vendor_supplier_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_supplier_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    cp_item_no text NOT NULL,
    vendor_item_no text DEFAULT ''::text NOT NULL,
    vend_cost numeric(14,4),
    variant_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    email text,
    phone text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    account_number text,
    is_active boolean DEFAULT true NOT NULL,
    use_vendor_upc boolean DEFAULT false NOT NULL,
    vendor_code text,
    payment_terms text,
    nuorder_brand_id text
);
