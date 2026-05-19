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

-- 005 Operations Workflows

--
-- Name: alteration_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alteration_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alteration_id uuid NOT NULL,
    staff_id uuid,
    action text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: alteration_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alteration_order_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    alteration_order_id uuid NOT NULL,
    label text NOT NULL,
    capacity_bucket public.alteration_bucket DEFAULT 'other'::public.alteration_bucket NOT NULL,
    units integer DEFAULT 1 NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: alteration_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alteration_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    wedding_member_id uuid,
    status public.alteration_status DEFAULT 'intake'::public.alteration_status NOT NULL,
    due_at timestamp with time zone,
    notes text,
    transaction_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fulfillment_order_id uuid,
    source_type public.alteration_source_type,
    item_description text,
    work_requested text,
    source_product_id uuid,
    source_variant_id uuid,
    source_sku text,
    source_transaction_id uuid,
    source_transaction_line_id uuid,
    charge_amount numeric(14,2),
    charge_transaction_line_id uuid,
    intake_channel public.alteration_intake_channel DEFAULT 'standalone'::public.alteration_intake_channel NOT NULL,
    source_snapshot jsonb,
    fitting_at timestamp with time zone,
    appointment_id uuid,
    total_units_jacket integer DEFAULT 0,
    total_units_pant integer DEFAULT 0,
    CONSTRAINT alteration_orders_charge_amount_non_negative CHECK (((charge_amount IS NULL) OR (charge_amount >= (0)::numeric)))
);

--
-- Name: app_notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_notification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    deep_link jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'system'::text NOT NULL,
    audience_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedupe_key text
);

--
-- Name: commission_combo_rule_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_combo_rule_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid,
    match_type text NOT NULL,
    match_id uuid NOT NULL,
    qty_required integer DEFAULT 1 NOT NULL,
    CONSTRAINT commission_combo_rule_items_match_type_check CHECK ((match_type = ANY (ARRAY['category'::text, 'product'::text])))
);

--
-- Name: commission_combo_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_combo_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    label text NOT NULL,
    reward_amount numeric(14,2) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: commission_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id uuid,
    transaction_id uuid,
    transaction_line_id uuid,
    source_event_id uuid,
    event_type text NOT NULL,
    event_at timestamp with time zone NOT NULL,
    reporting_date date NOT NULL,
    commissionable_amount numeric(14,2) DEFAULT 0 NOT NULL,
    base_rate_used numeric(8,4) DEFAULT 0 NOT NULL,
    base_commission_amount numeric(14,2) DEFAULT 0 NOT NULL,
    incentive_amount numeric(14,2) DEFAULT 0 NOT NULL,
    adjustment_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_commission_amount numeric(14,2) DEFAULT 0 NOT NULL,
    snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    note text,
    created_by_staff_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT commission_events_event_type_check CHECK ((event_type = ANY (ARRAY['sale_commission'::text, 'spiff'::text, 'combo_incentive'::text, 'return_adjustment'::text, 'exchange_adjustment'::text, 'manual_adjustment'::text])))
);

--
-- Name: commission_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_type text NOT NULL,
    match_id uuid NOT NULL,
    override_rate numeric(14,4),
    fixed_spiff_amount numeric(14,2) DEFAULT 0,
    label text,
    is_active boolean DEFAULT true,
    start_date timestamp with time zone,
    end_date timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT commission_rules_match_type_check CHECK ((match_type = ANY (ARRAY['category'::text, 'product'::text, 'variant'::text])))
);

--
-- Name: help_manual_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.help_manual_policy (
    manual_id text NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    title_override text,
    summary_override text,
    markdown_override text,
    order_override integer,
    required_permissions text[],
    allow_register_session boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by_staff_id uuid
);

--
-- Name: integration_alert_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_alert_state (
    source text NOT NULL,
    last_failure_at timestamp with time zone,
    last_success_at timestamp with time zone,
    detail text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: morning_digest_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.morning_digest_ledger (
    store_day date NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: notification_delivery_suppression; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_delivery_suppression (
    id bigint NOT NULL,
    notification_id uuid,
    staff_id uuid,
    kind text NOT NULL,
    semantic_kind text NOT NULL,
    category text,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: notification_generator_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_generator_run (
    generator_key text NOT NULL,
    last_started_at timestamp with time zone NOT NULL,
    last_finished_at timestamp with time zone NOT NULL,
    last_success_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_status text NOT NULL,
    last_error text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_generator_run_last_status_check CHECK ((last_status = ANY (ARRAY['ok'::text, 'failed'::text])))
);

--
-- Name: ops_action_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_action_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    actor_staff_id uuid NOT NULL,
    action_key text NOT NULL,
    reason text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_hash_sha256 text NOT NULL,
    correlation_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    result_ok boolean NOT NULL,
    result_message text NOT NULL,
    result_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ops_alert_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_alert_event (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rule_key text NOT NULL,
    dedupe_key text,
    title text NOT NULL,
    body text NOT NULL,
    severity text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    acked_at timestamp with time zone,
    acked_by_staff_id uuid,
    resolved_at timestamp with time zone,
    resolved_by_staff_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_alert_event_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT ops_alert_event_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acked'::text, 'resolved'::text])))
);

--
-- Name: ops_alert_rule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_alert_rule (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rule_key text NOT NULL,
    title text NOT NULL,
    severity text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    suppress_minutes integer DEFAULT 60 NOT NULL,
    channel_inbox boolean DEFAULT true NOT NULL,
    channel_email boolean DEFAULT true NOT NULL,
    channel_sms boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_alert_rule_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);

--
-- Name: ops_bug_incident_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_bug_incident_link (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    bug_report_id uuid NOT NULL,
    alert_event_id uuid NOT NULL,
    linked_by_staff_id uuid,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ops_notification_delivery_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_notification_delivery_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    alert_event_id uuid NOT NULL,
    channel text NOT NULL,
    destination text,
    delivery_status text NOT NULL,
    provider_message_id text,
    error_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_notification_delivery_log_channel_check CHECK ((channel = ANY (ARRAY['inbox'::text, 'email'::text, 'sms'::text]))),
    CONSTRAINT ops_notification_delivery_log_delivery_status_check CHECK ((delivery_status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text])))
);

--
-- Name: ops_station_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_station_heartbeat (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    station_key text NOT NULL,
    station_label text NOT NULL,
    app_version text NOT NULL,
    git_sha text,
    tailscale_node text,
    lan_ip text,
    last_sync_at timestamp with time zone,
    last_update_check_at timestamp with time zone,
    last_update_install_at timestamp with time zone,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: pos_parked_sale; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_parked_sale (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    register_session_id uuid NOT NULL,
    parked_by_staff_id uuid NOT NULL,
    customer_id uuid,
    label text DEFAULT ''::text NOT NULL,
    payload_json jsonb NOT NULL,
    status public.pos_parked_sale_status DEFAULT 'parked'::public.pos_parked_sale_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recalled_at timestamp with time zone,
    recalled_by_staff_id uuid,
    deleted_at timestamp with time zone,
    deleted_by_staff_id uuid
);

--
-- Name: pos_parked_sale_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_parked_sale_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    register_session_id uuid NOT NULL,
    parked_sale_id uuid,
    action text NOT NULL,
    actor_staff_id uuid NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: pos_rms_charge_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_rms_charge_record (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    register_session_id uuid NOT NULL,
    customer_id uuid,
    payment_method text NOT NULL,
    amount numeric(14,2) NOT NULL,
    operator_staff_id uuid,
    payment_transaction_id uuid,
    customer_display text,
    order_short_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    record_kind text DEFAULT 'charge'::text NOT NULL,
    tender_family text,
    program_code text,
    program_label text,
    masked_account text,
    linked_corecredit_customer_id text,
    linked_corecredit_account_id text,
    resolution_status text,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    external_transaction_id text,
    external_auth_code text,
    posting_status text DEFAULT 'legacy'::text NOT NULL,
    posting_error_code text,
    posting_error_message text,
    posted_at timestamp with time zone,
    reversed_at timestamp with time zone,
    refunded_at timestamp with time zone,
    idempotency_key text,
    external_transaction_type text,
    host_reference text,
    host_metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    request_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT pos_rms_charge_record_kind_chk CHECK ((record_kind = ANY (ARRAY['charge'::text, 'payment'::text])))
);

--
-- Name: staff_auth_failure_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_auth_failure_event (
    id bigint NOT NULL,
    staff_id uuid NOT NULL,
    failure_kind text DEFAULT 'pin_mismatch'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: staff_bug_report; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_bug_report (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_id uuid NOT NULL,
    summary text NOT NULL,
    steps_context text NOT NULL,
    client_console_log text DEFAULT ''::text NOT NULL,
    client_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    screenshot_png bytea NOT NULL,
    status public.bug_report_status DEFAULT 'pending'::public.bug_report_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by_staff_id uuid,
    server_log_snapshot text DEFAULT ''::text NOT NULL,
    correlation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    resolver_notes text DEFAULT ''::text NOT NULL,
    external_url text DEFAULT ''::text NOT NULL
);

--
-- Name: staff_day_exception; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_day_exception (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_id uuid NOT NULL,
    exception_date date NOT NULL,
    kind public.staff_schedule_exception_kind NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_staff_id uuid,
    shift_label text
);

--
-- Name: staff_error_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_error_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    staff_id uuid,
    message text NOT NULL,
    event_source text DEFAULT 'client_toast'::text NOT NULL,
    severity text DEFAULT 'error'::text NOT NULL,
    route text,
    client_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    server_log_snapshot text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT staff_error_event_status_check CHECK ((lower(status) = ANY (ARRAY['pending'::text, 'complete'::text, 'archived'::text])))
);

--
-- Name: staff_notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_notification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    completed_at timestamp with time zone,
    archived_at timestamp with time zone,
    compact_summary text
);

--
-- Name: staff_notification_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_notification_action (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_notification_id uuid NOT NULL,
    actor_staff_id uuid NOT NULL,
    action text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: staff_schedule_event_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_schedule_event_attendees (
    event_id uuid NOT NULL,
    staff_id uuid NOT NULL
);

--
-- Name: staff_schedule_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_schedule_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_date date NOT NULL,
    label text NOT NULL,
    notes text,
    is_all_staff boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'meeting'::text NOT NULL
);

--
-- Name: staff_weekly_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_weekly_availability (
    staff_id uuid NOT NULL,
    weekday smallint NOT NULL,
    works boolean NOT NULL,
    shift_label text,
    is_highlighted boolean DEFAULT false,
    CONSTRAINT staff_weekly_availability_weekday_check CHECK (((weekday >= 0) AND (weekday <= 6)))
);

--
-- Name: staff_weekly_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_weekly_schedule (
    staff_id uuid NOT NULL,
    week_start date NOT NULL,
    status public.staff_weekly_schedule_status DEFAULT 'draft'::public.staff_weekly_schedule_status NOT NULL,
    created_by_staff_id uuid NOT NULL,
    updated_by_staff_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: staff_weekly_schedule_day; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_weekly_schedule_day (
    staff_id uuid NOT NULL,
    week_start date NOT NULL,
    weekday smallint NOT NULL,
    works boolean DEFAULT true NOT NULL,
    shift_label text,
    is_highlighted boolean DEFAULT false,
    CONSTRAINT staff_weekly_schedule_day_weekday_check CHECK (((weekday >= 0) AND (weekday <= 6)))
);

--
-- Name: store_backup_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_backup_health (
    id smallint DEFAULT 1 NOT NULL,
    last_local_success_at timestamp with time zone,
    last_local_failure_at timestamp with time zone,
    last_local_failure_detail text,
    last_cloud_success_at timestamp with time zone,
    last_cloud_failure_at timestamp with time zone,
    last_cloud_failure_detail text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT store_backup_health_singleton CHECK ((id = 1))
);

--
-- Name: store_register_eod_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_register_eod_snapshot (
    store_local_date date NOT NULL,
    timezone text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    till_close_group_id uuid NOT NULL,
    primary_register_session_id uuid,
    summary_json jsonb NOT NULL
);

--
-- Name: suit_component_swap_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suit_component_swap_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    staff_id uuid,
    old_variant_id uuid NOT NULL,
    new_variant_id uuid NOT NULL,
    old_product_id uuid NOT NULL,
    new_product_id uuid NOT NULL,
    effective_quantity integer NOT NULL,
    old_unit_cost numeric(12,2) NOT NULL,
    new_unit_cost numeric(12,2) NOT NULL,
    old_unit_price numeric(12,2) NOT NULL,
    new_unit_price numeric(12,2) NOT NULL,
    inventory_adjusted boolean DEFAULT false NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suit_component_swap_events_effective_quantity_check CHECK ((effective_quantity > 0))
);

--
-- Name: task_assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_assignment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    recurrence public.task_recurrence NOT NULL,
    recurrence_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    assignee_kind public.task_assignee_kind NOT NULL,
    assignee_staff_id uuid,
    assignee_role public.staff_role,
    customer_id uuid,
    active boolean DEFAULT true NOT NULL,
    starts_on date,
    ends_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_assignment_assignee_chk CHECK ((((assignee_kind = 'staff'::public.task_assignee_kind) AND (assignee_staff_id IS NOT NULL) AND (assignee_role IS NULL)) OR ((assignee_kind = 'role'::public.task_assignee_kind) AND (assignee_role IS NOT NULL) AND (assignee_staff_id IS NULL))))
);

--
-- Name: task_checklist_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_checklist_template (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_staff_id uuid
);

--
-- Name: task_checklist_template_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_checklist_template_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    label text NOT NULL,
    required boolean DEFAULT true NOT NULL
);

--
-- Name: task_instance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_instance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    assignment_id uuid,
    assignee_staff_id uuid NOT NULL,
    period_key text NOT NULL,
    due_date date,
    status public.task_instance_status DEFAULT 'open'::public.task_instance_status NOT NULL,
    customer_id uuid,
    title_snapshot text DEFAULT ''::text NOT NULL,
    materialized_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    completed_by_staff_id uuid
);

--
-- Name: task_instance_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_instance_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_instance_id uuid NOT NULL,
    template_item_id uuid,
    sort_order integer NOT NULL,
    label text NOT NULL,
    required boolean DEFAULT true NOT NULL,
    done_at timestamp with time zone,
    done_by_staff_id uuid
);
