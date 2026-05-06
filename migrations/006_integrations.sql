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

-- 006 Integrations

--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    is_clothing_footwear boolean DEFAULT false,
    parent_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    matrix_row_axis_key text,
    matrix_col_axis_key text,
    tax_rules jsonb,
    variation_axis_presets text[] DEFAULT '{}'::text[] NOT NULL
);

--
-- Name: corecard_posting_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corecard_posting_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idempotency_key text NOT NULL,
    operation_type text NOT NULL,
    posting_status text DEFAULT 'pending'::text NOT NULL,
    retryable boolean DEFAULT false NOT NULL,
    customer_id uuid,
    transaction_id uuid,
    payment_transaction_id uuid,
    pos_rms_charge_record_id uuid,
    linked_corecredit_customer_id text,
    linked_corecredit_account_id text,
    linked_corecredit_card_id text,
    program_code text,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    external_transaction_id text,
    external_auth_code text,
    external_transaction_type text,
    host_reference text,
    posting_error_code text,
    posting_error_message text,
    request_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    host_metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    posted_at timestamp with time zone,
    reversed_at timestamp with time zone,
    refunded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: corecredit_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corecredit_event_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    external_event_key text NOT NULL,
    event_type text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    processing_status text DEFAULT 'received'::text NOT NULL,
    signature_valid boolean DEFAULT false NOT NULL,
    verification_result text,
    related_customer_id uuid,
    related_account_id text,
    related_rms_record_id uuid,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text
);

--
-- Name: helcim_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.helcim_event_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text DEFAULT 'helcim'::text NOT NULL,
    webhook_id text,
    event_type text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    webhook_timestamp timestamp with time zone,
    signature_valid boolean DEFAULT false NOT NULL,
    payload_hash text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    processing_status text DEFAULT 'received'::text NOT NULL,
    error_message text,
    provider_transaction_id text,
    payment_provider_attempt_id uuid,
    payment_transaction_id uuid,
    match_type text,
    CONSTRAINT helcim_event_log_event_type_chk CHECK ((btrim(event_type) <> ''::text)),
    CONSTRAINT helcim_event_log_payload_hash_chk CHECK ((btrim(payload_hash) <> ''::text)),
    CONSTRAINT helcim_event_log_processing_status_chk CHECK ((processing_status = ANY (ARRAY['received'::text, 'processed'::text, 'failed'::text, 'ignored'::text]))),
    CONSTRAINT helcim_event_log_provider_chk CHECK ((provider = 'helcim'::text)),
    CONSTRAINT helcim_event_log_webhook_id_chk CHECK (((webhook_id IS NULL) OR (btrim(webhook_id) <> ''::text)))
);

--
-- Name: integration_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_key text NOT NULL,
    credential_key text NOT NULL,
    encrypted_value text NOT NULL,
    value_hint text,
    updated_by_staff_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_credentials_credential_key_chk CHECK ((btrim(credential_key) <> ''::text)),
    CONSTRAINT integration_credentials_encrypted_value_chk CHECK ((btrim(encrypted_value) <> ''::text)),
    CONSTRAINT integration_credentials_integration_key_chk CHECK ((btrim(integration_key) <> ''::text))
);

--
-- Name: payment_provider_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_provider_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_batch_id text NOT NULL,
    status text,
    currency text,
    opened_at timestamp with time zone,
    closed_at timestamp with time zone,
    settled_at timestamp with time zone,
    expected_deposit_at timestamp with time zone,
    gross_amount numeric(12,2),
    fee_amount numeric(12,2),
    net_amount numeric(12,2),
    transaction_count integer,
    raw_payload jsonb,
    source_event_id uuid,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_provider_batches_provider_batch_id_chk CHECK ((btrim(provider_batch_id) <> ''::text)),
    CONSTRAINT payment_provider_batches_provider_chk CHECK ((btrim(provider) <> ''::text))
);

--
-- Name: payment_provider_batch_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_provider_batch_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_batch_id text NOT NULL,
    provider_transaction_id text NOT NULL,
    payment_provider_batch_id uuid,
    payment_transaction_id uuid,
    source_event_id uuid,
    transaction_type text,
    status text,
    currency text,
    occurred_at timestamp with time zone,
    settled_at timestamp with time zone,
    gross_amount numeric(12,2),
    fee_amount numeric(12,2),
    net_amount numeric(12,2),
    match_status text DEFAULT 'unmatched'::text NOT NULL,
    match_type text,
    raw_payload jsonb,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_provider_batch_transactions_batch_id_chk CHECK ((btrim(provider_batch_id) <> ''::text)),
    CONSTRAINT payment_provider_batch_transactions_match_status_chk CHECK ((match_status = ANY (ARRAY['matched'::text, 'unmatched'::text, 'mismatch'::text]))),
    CONSTRAINT payment_provider_batch_transactions_provider_chk CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT payment_provider_batch_transactions_transaction_id_chk CHECK ((btrim(provider_transaction_id) <> ''::text))
);

--
-- Name: payment_settlement_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_settlement_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    scope text DEFAULT 'batch_sync'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    date_from date,
    date_to date,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    requested_by_staff_id uuid,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    CONSTRAINT payment_settlement_runs_provider_chk CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT payment_settlement_runs_scope_chk CHECK ((btrim(scope) <> ''::text)),
    CONSTRAINT payment_settlement_runs_status_chk CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT payment_settlement_runs_window_chk CHECK (((date_from IS NULL) OR (date_to IS NULL) OR (date_from <= date_to)))
);

--
-- Name: payment_settlement_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_settlement_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    provider text NOT NULL,
    item_type text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    provider_batch_id text,
    provider_transaction_id text,
    payment_transaction_id uuid,
    payment_provider_batch_id uuid,
    processor_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    ros_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by_staff_id uuid,
    reviewed_at timestamp with time zone,
    resolved_by_staff_id uuid,
    resolved_at timestamp with time zone,
    resolution_type text,
    resolution_note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_settlement_items_item_type_chk CHECK ((btrim(item_type) <> ''::text)),
    CONSTRAINT payment_settlement_items_provider_chk CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT payment_settlement_items_severity_chk CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT payment_settlement_items_resolution_type_chk CHECK (((resolution_type IS NULL) OR (btrim(resolution_type) <> ''::text))),
    CONSTRAINT payment_settlement_items_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'ignored'::text])))
);

--
-- Name: payment_settlement_item_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_settlement_item_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    actor_staff_id uuid,
    action text NOT NULL,
    note text,
    before_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_settlement_item_events_action_chk CHECK ((action = ANY (ARRAY['reviewed'::text, 'noted'::text, 'resolved'::text, 'ignored'::text, 'reopened'::text, 'linked_payment'::text])))
);

--
-- Name: payment_actual_deposits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_actual_deposits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text DEFAULT 'helcim'::text NOT NULL,
    source_system text DEFAULT 'manual'::text NOT NULL,
    source_reference text,
    qbo_deposit_id text,
    bank_feed_transaction_id text,
    posted_at timestamp with time zone NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reviewed_by_staff_id uuid,
    reviewed_at timestamp with time zone,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_actual_deposits_amount_chk CHECK ((amount <> 0::numeric)),
    CONSTRAINT payment_actual_deposits_currency_chk CHECK ((btrim(currency) <> ''::text)),
    CONSTRAINT payment_actual_deposits_provider_chk CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT payment_actual_deposits_source_reference_chk CHECK (((source_reference IS NULL) OR (btrim(source_reference) <> ''::text))),
    CONSTRAINT payment_actual_deposits_source_system_chk CHECK ((btrim(source_system) <> ''::text)),
    CONSTRAINT payment_actual_deposits_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'reviewed'::text, 'matched'::text, 'needs_review'::text, 'reopened'::text])))
);

--
-- Name: payment_provider_attempts terminal routing audit columns; Type: ALTER TABLE; Schema: public; Owner: -
--

ALTER TABLE public.payment_provider_attempts
    ADD COLUMN IF NOT EXISTS selected_terminal_key text,
    ADD COLUMN IF NOT EXISTS terminal_route_source text,
    ADD COLUMN IF NOT EXISTS terminal_override_staff_id uuid,
    ADD COLUMN IF NOT EXISTS terminal_override_reason text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payment_provider_attempts_selected_terminal_key_chk'
    ) THEN
        ALTER TABLE public.payment_provider_attempts
            ADD CONSTRAINT payment_provider_attempts_selected_terminal_key_chk CHECK (((selected_terminal_key IS NULL) OR (selected_terminal_key = ANY (ARRAY['terminal_1'::text, 'terminal_2'::text]))));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payment_provider_attempts_terminal_route_source_chk'
    ) THEN
        ALTER TABLE public.payment_provider_attempts
            ADD CONSTRAINT payment_provider_attempts_terminal_route_source_chk CHECK (((terminal_route_source IS NULL) OR (terminal_route_source = ANY (ARRAY['default'::text, 'required_choice'::text, 'override'::text]))));
    END IF;
END $$;

--
-- Name: payment_actual_deposit_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_actual_deposit_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deposit_id uuid NOT NULL,
    payment_provider_batch_id uuid NOT NULL,
    provider_batch_id text NOT NULL,
    expected_net_amount numeric(12,2),
    linked_amount numeric(12,2),
    match_type text DEFAULT 'manual'::text NOT NULL,
    status text DEFAULT 'linked'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_actual_deposit_batches_batch_id_chk CHECK ((btrim(provider_batch_id) <> ''::text)),
    CONSTRAINT payment_actual_deposit_batches_match_type_chk CHECK ((btrim(match_type) <> ''::text)),
    CONSTRAINT payment_actual_deposit_batches_status_chk CHECK ((status = ANY (ARRAY['linked'::text, 'unlinked'::text])))
);

--
-- Name: payment_deposit_reconciliation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_deposit_reconciliation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text DEFAULT 'helcim'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    date_from date,
    date_to date,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    requested_by_staff_id uuid,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    CONSTRAINT payment_deposit_reconciliation_runs_provider_chk CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT payment_deposit_reconciliation_runs_status_chk CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT payment_deposit_reconciliation_runs_window_chk CHECK (((date_from IS NULL) OR (date_to IS NULL) OR (date_from <= date_to)))
);

--
-- Name: payment_deposit_reconciliation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_deposit_reconciliation_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid,
    provider text DEFAULT 'helcim'::text NOT NULL,
    item_type text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    deposit_id uuid,
    payment_provider_batch_id uuid,
    provider_batch_id text,
    processor_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    ros_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT payment_deposit_reconciliation_items_item_type_chk CHECK ((item_type = ANY (ARRAY['actual_deposit_missing_expected_batch'::text, 'expected_batch_missing_actual_deposit'::text, 'deposit_amount_mismatch'::text, 'deposit_date_outside_window'::text, 'partial_deposit'::text, 'duplicate_deposit_reference'::text]))),
    CONSTRAINT payment_deposit_reconciliation_items_provider_chk CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT payment_deposit_reconciliation_items_severity_chk CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT payment_deposit_reconciliation_items_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'ignored'::text])))
);

--
-- Name: payment_actual_deposit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_actual_deposit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deposit_id uuid NOT NULL,
    actor_staff_id uuid,
    action text NOT NULL,
    note text,
    before_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_actual_deposit_events_action_chk CHECK ((action = ANY (ARRAY['created'::text, 'linked_batch'::text, 'unlinked_batch'::text, 'reviewed'::text, 'reopened'::text, 'noted'::text, 'accepted_variance'::text])))
);

--
-- Name: corecredit_exception_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corecredit_exception_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rms_record_id uuid,
    account_id text,
    exception_type text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to_staff_id uuid,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    notes text,
    resolution_notes text,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: corecredit_reconciliation_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corecredit_reconciliation_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    rms_record_id uuid,
    account_id text,
    mismatch_type text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    riverside_value_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    host_value_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    qbo_value_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: corecredit_reconciliation_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corecredit_reconciliation_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_scope text DEFAULT 'daily'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    requested_by_staff_id uuid,
    date_from date,
    date_to date,
    summary_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text
);

--
-- Name: counterpoint_bridge_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_bridge_heartbeat (
    id integer DEFAULT 1 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    bridge_phase text DEFAULT 'idle'::text NOT NULL,
    current_entity text,
    bridge_version text,
    bridge_hostname text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT counterpoint_bridge_heartbeat_id_check CHECK ((id = 1))
);

--
-- Name: counterpoint_category_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_category_map (
    id bigint NOT NULL,
    cp_category text NOT NULL,
    ros_category_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: counterpoint_gift_reason_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_gift_reason_map (
    id bigint NOT NULL,
    cp_reason_cod text NOT NULL,
    ros_card_kind text DEFAULT 'purchased'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: counterpoint_payment_method_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_payment_method_map (
    id bigint NOT NULL,
    cp_pmt_typ text NOT NULL,
    ros_method text DEFAULT 'cash'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: counterpoint_receiving_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_receiving_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vend_no text NOT NULL,
    item_no text NOT NULL,
    recv_dat timestamp with time zone NOT NULL,
    unit_cost numeric(14,4) NOT NULL,
    qty_recv numeric(14,4) NOT NULL,
    po_no text,
    recv_no text,
    variant_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: counterpoint_staff_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_staff_map (
    id bigint NOT NULL,
    cp_code text NOT NULL,
    cp_source text DEFAULT 'user'::text NOT NULL,
    ros_staff_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: counterpoint_staging_batch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_staging_batch (
    id bigint NOT NULL,
    entity text NOT NULL,
    payload jsonb NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    apply_error text,
    bridge_version text,
    bridge_hostname text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    applied_by_staff_id uuid,
    CONSTRAINT counterpoint_staging_batch_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'discarded'::text, 'failed'::text])))
);

--
-- Name: counterpoint_sync_issue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_sync_issue (
    id bigint NOT NULL,
    entity text NOT NULL,
    external_key text,
    severity text DEFAULT 'warning'::text NOT NULL,
    message text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);

--
-- Name: counterpoint_sync_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_sync_request (
    id bigint NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_by uuid,
    entity text,
    acked_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_message text
);

--
-- Name: counterpoint_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterpoint_sync_runs (
    id bigint NOT NULL,
    entity text NOT NULL,
    cursor_value text,
    last_ok_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    records_processed integer
);

--
-- Name: meilisearch_sync_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meilisearch_sync_status (
    index_name text NOT NULL,
    last_success_at timestamp with time zone,
    last_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    row_count bigint DEFAULT 0,
    is_success boolean DEFAULT false NOT NULL,
    error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: nuorder_entity_map_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nuorder_entity_map_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    entity_type text NOT NULL,
    ros_entity_id uuid NOT NULL,
    nuorder_entity_id text NOT NULL,
    mapped_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: nuorder_sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nuorder_sync_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sync_type text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp with time zone,
    result_count integer DEFAULT 0,
    error_message text,
    payload jsonb,
    created_count integer DEFAULT 0,
    updated_count integer DEFAULT 0,
    skipped_count integer DEFAULT 0
);

--
-- Name: nuorder_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nuorder_sync_state (
    id integer DEFAULT 1 NOT NULL,
    last_catalog_sync_at timestamp with time zone,
    last_order_sync_at timestamp with time zone,
    last_inventory_sync_at timestamp with time zone,
    CONSTRAINT single_row CHECK ((id = 1))
);

--
-- Name: podium_conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podium_conversation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid,
    channel text NOT NULL,
    podium_conversation_uid text,
    contact_phone_e164 text,
    contact_email text,
    last_message_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT podium_conversation_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text])))
);

--
-- Name: podium_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podium_message (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    direction text NOT NULL,
    channel text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    staff_id uuid,
    podium_message_uid text,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    podium_sender_name text,
    CONSTRAINT podium_message_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'automated'::text])))
);

--
-- Name: podium_webhook_delivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podium_webhook_delivery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text NOT NULL,
    payload_sha256_hex text NOT NULL
);

--
-- Name: qbo_accounts_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qbo_accounts_cache (
    id text NOT NULL,
    name text NOT NULL,
    account_type text,
    account_number text,
    is_active boolean DEFAULT true,
    refreshed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: qbo_integration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qbo_integration (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    company_id text NOT NULL,
    access_token text,
    refresh_token text,
    last_sync_at timestamp with time zone,
    is_active boolean DEFAULT true,
    client_id text,
    client_secret text,
    realm_id text,
    use_sandbox boolean DEFAULT true NOT NULL,
    token_expires_at timestamp with time zone
);

--
-- Name: qbo_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qbo_mappings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    qbo_account_id text NOT NULL,
    qbo_account_name text NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: qbo_sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qbo_sync_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sync_date date NOT NULL,
    journal_entry_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: shipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    source public.shipment_source NOT NULL,
    transaction_id uuid,
    customer_id uuid,
    created_by_staff_id uuid,
    status public.shipment_status DEFAULT 'draft'::public.shipment_status NOT NULL,
    ship_to jsonb DEFAULT '{}'::jsonb NOT NULL,
    parcel jsonb,
    quoted_amount_usd numeric(12,2),
    shipping_charged_usd numeric(12,2),
    label_cost_usd numeric(12,2),
    carrier text,
    service_name text,
    shippo_shipment_object_id text,
    shippo_transaction_object_id text,
    tracking_number text,
    tracking_url_provider text,
    shipping_label_url text,
    internal_notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    shippo_rate_object_id text,
    fulfillment_order_id uuid
);

--
-- Name: shipment_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_event (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    shipment_id uuid NOT NULL,
    at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    kind text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    staff_id uuid
);

--
-- Name: store_checkout_payment_attempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_checkout_payment_attempt (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    checkout_session_id uuid NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    amount_cents bigint NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    provider_payment_id text,
    provider_transaction_id text,
    provider_status text,
    client_secret text,
    hosted_payment_url text,
    error_code text,
    error_message text,
    raw_audit_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT store_checkout_payment_attempt_amount_chk CHECK ((amount_cents >= 0)),
    CONSTRAINT store_checkout_payment_attempt_currency_chk CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT store_checkout_payment_attempt_provider_chk CHECK ((provider = 'helcim'::text)),
    CONSTRAINT store_checkout_payment_attempt_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'requires_action'::text, 'approved'::text, 'captured'::text, 'canceled'::text, 'failed'::text, 'expired'::text])))
);

--
-- Name: store_checkout_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_checkout_session (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    guest_cart_id uuid,
    customer_id uuid,
    contact jsonb DEFAULT '{}'::jsonb NOT NULL,
    fulfillment_method public.order_fulfillment_method DEFAULT 'pickup'::public.order_fulfillment_method NOT NULL,
    ship_to jsonb,
    shipping_rate_quote_id uuid,
    lines_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    coupon_id uuid,
    coupon_code text,
    coupon_snapshot jsonb,
    subtotal_usd numeric(12,2) DEFAULT 0 NOT NULL,
    discount_usd numeric(12,2) DEFAULT 0 NOT NULL,
    tax_usd numeric(12,2) DEFAULT 0 NOT NULL,
    shipping_usd numeric(12,2) DEFAULT 0 NOT NULL,
    total_usd numeric(12,2) DEFAULT 0 NOT NULL,
    selected_provider text,
    status text DEFAULT 'draft'::text NOT NULL,
    idempotency_key text NOT NULL,
    finalized_transaction_id uuid,
    expires_at timestamp with time zone DEFAULT (now() + '00:45:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text,
    medium text,
    campaign_slug text,
    checkout_started_at timestamp with time zone,
    payment_started_at timestamp with time zone,
    paid_at timestamp with time zone,
    abandoned_reason text,
    account_conversion_customer_id uuid,
    CONSTRAINT store_checkout_session_idempotency_key_chk CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT store_checkout_session_provider_chk CHECK (((selected_provider IS NULL) OR (selected_provider = 'helcim'::text))),
    CONSTRAINT store_checkout_session_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'payment_pending'::text, 'paid'::text, 'failed'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT store_checkout_session_totals_chk CHECK (((subtotal_usd >= (0)::numeric) AND (discount_usd >= (0)::numeric) AND (tax_usd >= (0)::numeric) AND (shipping_usd >= (0)::numeric) AND (total_usd >= (0)::numeric)))
);

--
-- Name: store_coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_coupons (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    code text NOT NULL,
    kind public.store_coupon_kind NOT NULL,
    value numeric(12,4) DEFAULT 0 NOT NULL,
    max_discount_usd numeric(12,2),
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    min_subtotal_usd numeric(12,2),
    max_uses integer,
    uses_count integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    allow_stack boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: store_guest_cart; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_guest_cart (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '90 days'::interval) NOT NULL
);

--
-- Name: store_guest_cart_line; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_guest_cart_line (
    cart_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    qty integer NOT NULL,
    CONSTRAINT store_guest_cart_line_qty_chk CHECK (((qty >= 1) AND (qty <= 9999)))
);

--
-- Name: store_media_asset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_media_asset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mime_type text NOT NULL,
    original_filename text,
    byte_size integer NOT NULL,
    bytes bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_staff_id uuid,
    alt_text text,
    usage_note text,
    deleted_at timestamp with time zone,
    CONSTRAINT store_media_asset_mime_chk CHECK ((mime_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text, 'image/gif'::text]))),
    CONSTRAINT store_media_asset_size_chk CHECK (((byte_size > 0) AND (byte_size <= 3145728)))
);

--
-- Name: store_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_pages (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    seo_title text,
    published boolean DEFAULT false NOT NULL,
    project_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_html text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: store_shipping_rate_quote; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_shipping_rate_quote (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    amount_usd numeric(12,2) NOT NULL,
    carrier text NOT NULL,
    service_name text NOT NULL,
    shippo_rate_object_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: store_tax_state_rate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_tax_state_rate (
    state_code character(2) NOT NULL,
    combined_rate numeric(9,6) NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: storefront_campaign; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storefront_campaign (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    coupon_id uuid,
    landing_page_slug text,
    source text,
    medium text,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storefront_campaign_slug_chk CHECK ((btrim(slug) <> ''::text))
);

--
-- Name: storefront_navigation_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storefront_navigation_item (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    menu_id uuid NOT NULL,
    label text NOT NULL,
    url text NOT NULL,
    item_kind text DEFAULT 'custom'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storefront_navigation_item_kind_chk CHECK ((item_kind = ANY (ARRAY['custom'::text, 'page'::text, 'product'::text, 'collection'::text, 'campaign'::text]))),
    CONSTRAINT storefront_navigation_item_label_chk CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT storefront_navigation_item_url_chk CHECK ((btrim(url) <> ''::text))
);

--
-- Name: storefront_navigation_menu; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storefront_navigation_menu (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    handle text NOT NULL,
    title text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storefront_navigation_menu_handle_chk CHECK ((btrim(handle) <> ''::text))
);

--
-- Name: storefront_publish_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storefront_publish_revision (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    page_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    project_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_html text DEFAULT ''::text NOT NULL,
    published_by_staff_id uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: weather_snapshot_finalize_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weather_snapshot_finalize_ledger (
    id smallint DEFAULT 1 NOT NULL,
    last_completed_store_date date DEFAULT '1970-01-01'::date NOT NULL,
    CONSTRAINT weather_snapshot_finalize_ledger_id_check CHECK ((id = 1))
);

--
-- Name: weather_vc_daily_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weather_vc_daily_usage (
    usage_date date NOT NULL,
    pull_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT weather_vc_daily_usage_pull_count_check CHECK ((pull_count >= 0))
);
