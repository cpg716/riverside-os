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

-- 004 Pos Transactions Payments

--
-- Name: discount_event_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_event_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    quantity integer NOT NULL,
    line_subtotal numeric(14,2) NOT NULL,
    discount_percent numeric(5,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discount_event_usage_quantity_check CHECK ((quantity > 0))
);

--
-- Name: discount_event_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_event_variants (
    event_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: discount_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    receipt_label text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    percent_off numeric(5,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scope_type text DEFAULT 'variants'::text NOT NULL,
    scope_category_id uuid,
    scope_vendor_id uuid,
    CONSTRAINT discount_events_percent CHECK (((percent_off > (0)::numeric) AND (percent_off <= (100)::numeric))),
    CONSTRAINT discount_events_range CHECK ((ends_at >= starts_at)),
    CONSTRAINT discount_events_scope_chk CHECK (((scope_type = ANY (ARRAY['variants'::text, 'category'::text, 'vendor'::text])) AND (((scope_type = 'variants'::text) AND (scope_category_id IS NULL) AND (scope_vendor_id IS NULL)) OR ((scope_type = 'category'::text) AND (scope_category_id IS NOT NULL) AND (scope_vendor_id IS NULL)) OR ((scope_type = 'vendor'::text) AND (scope_vendor_id IS NOT NULL) AND (scope_category_id IS NULL)))))
);

--
-- Name: fulfillment_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_orders (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    display_id text NOT NULL,
    customer_id uuid,
    wedding_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    fulfilled_at timestamp with time zone
);

--
-- Name: gift_card_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gift_card_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    gift_card_id uuid NOT NULL,
    event_kind text NOT NULL,
    amount numeric(14,2) NOT NULL,
    balance_after numeric(14,2) NOT NULL,
    transaction_id uuid,
    session_id uuid,
    staff_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: gift_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gift_cards (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    code character varying(50) NOT NULL,
    current_balance numeric(12,2) NOT NULL,
    is_liability boolean NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    card_kind public.gift_card_kind DEFAULT 'purchased'::public.gift_card_kind NOT NULL,
    card_status public.gift_card_status DEFAULT 'active'::public.gift_card_status NOT NULL,
    original_value numeric(14,2),
    customer_id uuid,
    issued_order_id uuid,
    issued_session_id uuid,
    notes text,
    CONSTRAINT gift_cards_balance_non_negative CHECK ((current_balance >= (0)::numeric))
);

--
-- Name: layaway_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.layaway_activity_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    staff_id uuid,
    action text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: loyalty_point_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_point_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    delta_points integer NOT NULL,
    balance_after integer NOT NULL,
    reason text NOT NULL,
    transaction_id uuid,
    created_by_staff_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: loyalty_reward_issuances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_reward_issuances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    points_deducted integer DEFAULT 5000 NOT NULL,
    reward_amount numeric(14,2) DEFAULT 50.00 NOT NULL,
    applied_to_sale numeric(14,2) DEFAULT 0 NOT NULL,
    remainder_card_id uuid,
    transaction_id uuid,
    issued_by_staff_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: payment_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_allocations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid,
    target_transaction_id uuid,
    amount_allocated numeric(12,2) NOT NULL,
    metadata jsonb,
    check_number character varying(100)
);

--
-- Name: payment_provider_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_provider_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    amount_cents bigint NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    register_session_id uuid,
    staff_id uuid,
    device_id text,
    terminal_id text,
    idempotency_key text NOT NULL,
    provider_payment_id text,
    provider_transaction_id text,
    error_code text,
    error_message text,
    raw_audit_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    provider_client_secret text,
    CONSTRAINT payment_provider_attempts_amount_cents_chk CHECK ((amount_cents >= 0)),
    CONSTRAINT payment_provider_attempts_currency_chk CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT payment_provider_attempts_idempotency_key_chk CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT payment_provider_attempts_provider_chk CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT payment_provider_attempts_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'captured'::text, 'canceled'::text, 'failed'::text, 'expired'::text])))
);

--
-- Name: payment_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid,
    payer_id uuid,
    category public.transaction_category DEFAULT 'retail_sale'::public.transaction_category,
    payment_method character varying(50) NOT NULL,
    amount numeric(12,2) NOT NULL,
    is_posted_to_rms_portal boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    wedding_member_id uuid,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    status text DEFAULT 'success'::text,
    merchant_fee numeric(12,2) DEFAULT 0.00,
    net_amount numeric(12,2) DEFAULT 0.00,
    card_brand text,
    card_last4 text,
    check_number character varying(100),
    payment_provider character varying(50),
    provider_payment_id character varying(255),
    provider_status character varying(100),
    provider_terminal_id character varying(255),
    provider_transaction_id character varying(255),
    provider_auth_code character varying(100),
    provider_card_type character varying(50)
);

--
-- Name: register_cash_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.register_cash_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    direction text NOT NULL,
    amount numeric(12,2) NOT NULL,
    category text,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT register_cash_adjustments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT register_cash_adjustments_direction_check CHECK ((direction = ANY (ARRAY['paid_in'::text, 'paid_out'::text])))
);

--
-- Name: register_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.register_sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    opened_by uuid,
    closed_by uuid,
    opening_float numeric(12,2) NOT NULL,
    expected_cash numeric(12,2),
    actual_cash numeric(12,2),
    cash_over_short numeric(12,2),
    discrepancy numeric(12,2),
    closing_notes text,
    is_open boolean DEFAULT true,
    opened_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    closed_at timestamp with time zone,
    lifecycle_status text DEFAULT 'open'::text NOT NULL,
    z_report_json jsonb,
    session_ordinal bigint NOT NULL,
    weather_snapshot jsonb,
    closing_comments text,
    pos_api_token text,
    shift_primary_staff_id uuid,
    register_lane smallint DEFAULT 1 NOT NULL,
    till_close_group_id uuid NOT NULL,
    CONSTRAINT register_sessions_lifecycle_status_check CHECK ((lifecycle_status = ANY (ARRAY['open'::text, 'reconciling'::text, 'closed'::text]))),
    CONSTRAINT register_sessions_register_lane_check CHECK (((register_lane >= 1) AND (register_lane <= 99)))
);

--
-- Name: store_credit_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_credit_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    balance numeric(14,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: store_credit_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_credit_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    balance_after numeric(14,2) NOT NULL,
    reason text NOT NULL,
    transaction_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: transaction_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    customer_id uuid,
    event_kind text NOT NULL,
    summary text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: transaction_attribution_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_attribution_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    order_item_id uuid,
    prior_salesperson_id uuid,
    new_salesperson_id uuid,
    corrected_by_staff_id uuid NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: transaction_coupon_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_coupon_redemptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    discount_amount numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: transaction_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_lines (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid,
    product_id uuid,
    variant_id uuid,
    salesperson_id uuid,
    fulfillment public.fulfillment_type NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    unit_cost numeric(12,2) NOT NULL,
    state_tax numeric(12,2) DEFAULT 0,
    local_tax numeric(12,2) DEFAULT 0,
    applied_spiff numeric(12,2) DEFAULT 0,
    calculated_commission numeric(12,2) DEFAULT 0,
    size_specs jsonb,
    is_fulfilled boolean DEFAULT false,
    commission_payout_finalized_at timestamp with time zone,
    counterpoint_reason_code text,
    custom_item_type text,
    is_rush boolean DEFAULT false,
    need_by_date date,
    needs_gift_wrap boolean DEFAULT false,
    is_internal boolean DEFAULT false,
    fulfillment_order_id uuid,
    line_display_id text,
    fulfilled_at timestamp with time zone
);

--
-- Name: transaction_loyalty_accrual; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_loyalty_accrual (
    transaction_id uuid NOT NULL,
    points_earned integer NOT NULL,
    product_subtotal numeric(14,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: transaction_refund_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_refund_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    customer_id uuid,
    amount_due numeric(14,2) NOT NULL,
    amount_refunded numeric(14,2) DEFAULT 0 NOT NULL,
    is_open boolean DEFAULT true NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone
);

--
-- Name: transaction_return_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_return_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    transaction_line_id uuid NOT NULL,
    quantity_returned integer NOT NULL,
    reason text,
    restocked boolean DEFAULT false NOT NULL,
    staff_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_return_lines_quantity_returned_check CHECK ((quantity_returned > 0))
);

--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    customer_id uuid,
    wedding_id uuid,
    operator_id uuid,
    primary_salesperson_id uuid,
    is_employee_purchase boolean DEFAULT false,
    status public.order_status DEFAULT 'open'::public.order_status,
    booked_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    fulfilled_at timestamp with time zone,
    total_price numeric(12,2) NOT NULL,
    amount_paid numeric(12,2) DEFAULT 0,
    balance_due numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    wedding_member_id uuid,
    weather_snapshot jsonb,
    exchange_group_id uuid,
    checkout_client_id uuid,
    sale_channel public.sale_channel DEFAULT 'register'::public.sale_channel NOT NULL,
    fulfillment_method public.order_fulfillment_method DEFAULT 'pickup'::public.order_fulfillment_method NOT NULL,
    ship_to jsonb,
    shipping_amount_usd numeric(12,2),
    shippo_shipment_object_id text,
    shippo_transaction_object_id text,
    tracking_number text,
    tracking_url_provider text,
    shipping_label_url text,
    counterpoint_ticket_ref text,
    is_counterpoint_import boolean DEFAULT false NOT NULL,
    processed_by_staff_id uuid,
    counterpoint_doc_ref text,
    review_invite_suppressed_at timestamp with time zone,
    review_invite_sent_at timestamp with time zone,
    podium_review_invite_id text,
    is_forfeited boolean DEFAULT false NOT NULL,
    forfeited_at timestamp with time zone,
    forfeiture_reason text,
    notes text,
    is_rush boolean DEFAULT false,
    need_by_date date,
    short_id text,
    is_tax_exempt boolean DEFAULT false NOT NULL,
    tax_exempt_reason text,
    register_session_id uuid,
    rounding_adjustment numeric(12,2) DEFAULT 0.00 NOT NULL,
    final_cash_due numeric(12,2),
    display_id text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);
