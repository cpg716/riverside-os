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

-- 003 Customers Weddings Relationships

--
-- Name: customer_corecredit_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_corecredit_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    corecredit_customer_id text NOT NULL,
    corecredit_account_id text NOT NULL,
    corecredit_card_id text,
    status text DEFAULT 'active'::text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    program_group text,
    last_verified_at timestamp with time zone,
    verified_by_staff_id uuid,
    verification_source text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    available_credit_snapshot text,
    current_balance_snapshot text,
    past_due_snapshot text,
    restrictions_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_balance_sync_at timestamp with time zone,
    last_status_sync_at timestamp with time zone,
    last_transactions_sync_at timestamp with time zone,
    last_sync_error text
);

--
-- Name: customer_duplicate_review_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_duplicate_review_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    customer_a_id uuid NOT NULL,
    customer_b_id uuid NOT NULL,
    score numeric DEFAULT 0 NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT customer_duplicate_pair_order CHECK ((customer_a_id < customer_b_id)),
    CONSTRAINT customer_duplicate_review_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'dismissed'::text, 'merged'::text])))
);

--
-- Name: customer_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_group_members (
    customer_id uuid NOT NULL,
    group_id uuid NOT NULL
);

--
-- Name: customer_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    label text NOT NULL
);

--
-- Name: customer_measurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_measurements (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    customer_id uuid NOT NULL,
    neck numeric(5,2),
    sleeve numeric(5,2),
    chest numeric(5,2),
    waist numeric(5,2),
    seat numeric(5,2),
    inseam numeric(5,2),
    outseam numeric(5,2),
    shoulder numeric(5,2),
    measured_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    measured_by uuid,
    notes text,
    retail_suit text,
    retail_waist text,
    retail_vest text,
    retail_shirt text,
    retail_shoe text
);

--
-- Name: customer_online_credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_online_credential (
    customer_id uuid NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: customer_open_deposit_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_open_deposit_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    balance numeric(14,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: customer_open_deposit_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_open_deposit_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    balance_after numeric(14,2) NOT NULL,
    reason text NOT NULL,
    transaction_id uuid,
    payer_customer_id uuid,
    payer_display_name text,
    wedding_party_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: customer_relationship_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_relationship_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_customer_id uuid NOT NULL,
    child_customer_id uuid NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    unlinked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_relationship_periods_distinct_profiles CHECK ((parent_customer_id <> child_customer_id)),
    CONSTRAINT customer_relationship_periods_valid_range CHECK (((unlinked_at IS NULL) OR (unlinked_at >= linked_at)))
);

--
-- Name: customer_timeline_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_timeline_notes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    customer_id uuid NOT NULL,
    body text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    first_name character varying(100),
    last_name character varying(100),
    email character varying(255),
    phone character varying(64),
    loyalty_points integer DEFAULT 0,
    wedding_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    address_line1 text,
    address_line2 text,
    city text,
    state text,
    postal_code text,
    marketing_email_opt_in boolean DEFAULT false NOT NULL,
    marketing_sms_opt_in boolean DEFAULT false NOT NULL,
    is_vip boolean DEFAULT false NOT NULL,
    customer_code text NOT NULL,
    company_name text,
    date_of_birth date,
    anniversary_date date,
    custom_field_1 text,
    custom_field_2 text,
    custom_field_3 text,
    custom_field_4 text,
    is_active boolean DEFAULT true NOT NULL,
    transactional_sms_opt_in boolean DEFAULT false NOT NULL,
    transactional_email_opt_in boolean DEFAULT false NOT NULL,
    podium_conversation_url text,
    customer_created_source text DEFAULT 'store'::text NOT NULL,
    preferred_salesperson_id uuid,
    podium_name_capture_pending boolean DEFAULT false NOT NULL,
    couple_id uuid,
    couple_primary_id uuid,
    couple_linked_at timestamp with time zone,
    sales_lifetime_historical numeric(12,2) DEFAULT 0,
    profile_discount_percent numeric(5,2) DEFAULT 0 NOT NULL,
    tax_exempt boolean DEFAULT false NOT NULL,
    tax_exempt_id text,
    CONSTRAINT customers_created_source_chk CHECK ((customer_created_source = ANY (ARRAY['store'::text, 'online_store'::text, 'counterpoint'::text, 'podium'::text]))),
    CONSTRAINT customers_profile_discount_percent_chk CHECK (((profile_discount_percent >= (0)::numeric) AND (profile_discount_percent <= (100)::numeric)))
);

--
-- Name: measurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.measurements (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    customer_id uuid,
    neck numeric(5,2),
    sleeve numeric(5,2),
    chest numeric(5,2),
    waist numeric(5,2),
    seat numeric(5,2),
    inseam numeric(5,2),
    outseam numeric(5,2),
    shoulder numeric(5,2),
    measured_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: wedding_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wedding_activity_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    wedding_party_id uuid NOT NULL,
    wedding_member_id uuid,
    actor_name text NOT NULL,
    action_type text NOT NULL,
    description text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: wedding_appointments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wedding_appointments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    wedding_party_id uuid,
    wedding_member_id uuid,
    customer_display_name text,
    phone text,
    appointment_type text DEFAULT 'Measurement'::text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    notes text,
    status text DEFAULT 'Scheduled'::text NOT NULL,
    salesperson text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    customer_id uuid
);

--
-- Name: wedding_insight_saved_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wedding_insight_saved_views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_id uuid NOT NULL,
    name text NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: wedding_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wedding_members (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    wedding_party_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'prospect'::text NOT NULL,
    transaction_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    member_index integer DEFAULT 0 NOT NULL,
    oot boolean DEFAULT false NOT NULL,
    suit text,
    waist text,
    vest text,
    shirt text,
    shoe text,
    measured boolean DEFAULT false NOT NULL,
    suit_ordered boolean DEFAULT false NOT NULL,
    received boolean DEFAULT false NOT NULL,
    fitting boolean DEFAULT false NOT NULL,
    pickup_status text DEFAULT 'none'::text NOT NULL,
    measure_date date,
    ordered_date date,
    received_date date,
    fitting_date date,
    pickup_date date,
    ordered_items jsonb DEFAULT '{}'::jsonb NOT NULL,
    member_accessories jsonb DEFAULT '{}'::jsonb NOT NULL,
    contact_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    pin_note boolean DEFAULT false NOT NULL,
    ordered_po text,
    stock_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    suit_variant_id uuid,
    is_free_suit_promo boolean DEFAULT false,
    customer_verified boolean DEFAULT false NOT NULL,
    import_customer_name text,
    import_customer_phone text
);

--
-- Name: wedding_non_inventory_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wedding_non_inventory_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wedding_party_id uuid NOT NULL,
    wedding_member_id uuid,
    description text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'needed'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: wedding_parties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wedding_parties (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    groom_name character varying(255) NOT NULL,
    event_date date NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    party_type text DEFAULT 'Wedding'::text NOT NULL,
    sign_up_date date,
    salesperson text,
    style_info text,
    price_info text,
    groom_phone text,
    groom_email text,
    bride_name text,
    bride_phone text,
    bride_email text,
    accessories jsonb DEFAULT '{}'::jsonb NOT NULL,
    groom_phone_clean text,
    bride_phone_clean text,
    is_deleted boolean DEFAULT false NOT NULL,
    party_name text,
    venue text,
    suit_variant_id uuid
);
