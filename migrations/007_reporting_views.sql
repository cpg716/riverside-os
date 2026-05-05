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

-- 007 Reporting Views
-- Primary and foreign-key constraints are applied first because PostgreSQL
-- reporting views may rely on primary-key functional dependencies.

--
-- Name: counterpoint_category_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_category_map_id_seq OWNED BY public.counterpoint_category_map.id;

--
-- Name: counterpoint_gift_reason_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_gift_reason_map_id_seq OWNED BY public.counterpoint_gift_reason_map.id;

--
-- Name: counterpoint_payment_method_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_payment_method_map_id_seq OWNED BY public.counterpoint_payment_method_map.id;

--
-- Name: counterpoint_staff_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_staff_map_id_seq OWNED BY public.counterpoint_staff_map.id;

--
-- Name: counterpoint_staging_batch_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_staging_batch_id_seq OWNED BY public.counterpoint_staging_batch.id;

--
-- Name: counterpoint_sync_issue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_sync_issue_id_seq OWNED BY public.counterpoint_sync_issue.id;

--
-- Name: counterpoint_sync_request_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_sync_request_id_seq OWNED BY public.counterpoint_sync_request.id;

--
-- Name: counterpoint_sync_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterpoint_sync_runs_id_seq OWNED BY public.counterpoint_sync_runs.id;

--
-- Name: notification_delivery_suppression_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_delivery_suppression_id_seq OWNED BY public.notification_delivery_suppression.id;

--
-- Name: register_sessions_session_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.register_sessions_session_ordinal_seq OWNED BY public.register_sessions.session_ordinal;

--
-- Name: staff_auth_failure_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_auth_failure_event_id_seq OWNED BY public.staff_auth_failure_event.id;

--
-- Name: counterpoint_category_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_category_map ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_category_map_id_seq'::regclass);

--
-- Name: counterpoint_gift_reason_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_gift_reason_map ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_gift_reason_map_id_seq'::regclass);

--
-- Name: counterpoint_payment_method_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_payment_method_map ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_payment_method_map_id_seq'::regclass);

--
-- Name: counterpoint_staff_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_staff_map ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_staff_map_id_seq'::regclass);

--
-- Name: counterpoint_staging_batch id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_staging_batch ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_staging_batch_id_seq'::regclass);

--
-- Name: counterpoint_sync_issue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_sync_issue ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_sync_issue_id_seq'::regclass);

--
-- Name: counterpoint_sync_request id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_sync_request ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_sync_request_id_seq'::regclass);

--
-- Name: counterpoint_sync_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_sync_runs ALTER COLUMN id SET DEFAULT nextval('public.counterpoint_sync_runs_id_seq'::regclass);

--
-- Name: notification_delivery_suppression id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_delivery_suppression ALTER COLUMN id SET DEFAULT nextval('public.notification_delivery_suppression_id_seq'::regclass);

--
-- Name: register_sessions session_ordinal; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_sessions ALTER COLUMN session_ordinal SET DEFAULT nextval('public.register_sessions_session_ordinal_seq'::regclass);

--
-- Name: staff_auth_failure_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_auth_failure_event ALTER COLUMN id SET DEFAULT nextval('public.staff_auth_failure_event_id_seq'::regclass);

--
-- Name: alteration_activity alteration_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_activity
    ADD CONSTRAINT alteration_activity_pkey PRIMARY KEY (id);

--
-- Name: alteration_order_items alteration_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_order_items
    ADD CONSTRAINT alteration_order_items_pkey PRIMARY KEY (id);

--
-- Name: alteration_orders alteration_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_pkey PRIMARY KEY (id);

--
-- Name: app_notification app_notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_notification
    ADD CONSTRAINT app_notification_pkey PRIMARY KEY (id);

--
-- Name: categories categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_name_key UNIQUE (name);

--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

--
-- Name: category_audit_log category_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_audit_log
    ADD CONSTRAINT category_audit_log_pkey PRIMARY KEY (id);

--
-- Name: category_commission_overrides category_commission_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_commission_overrides
    ADD CONSTRAINT category_commission_overrides_pkey PRIMARY KEY (category_id);

--
-- Name: commission_combo_rule_items commission_combo_rule_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_combo_rule_items
    ADD CONSTRAINT commission_combo_rule_items_pkey PRIMARY KEY (id);

--
-- Name: commission_combo_rules commission_combo_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_combo_rules
    ADD CONSTRAINT commission_combo_rules_pkey PRIMARY KEY (id);

--
-- Name: commission_events commission_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_events
    ADD CONSTRAINT commission_events_pkey PRIMARY KEY (id);

--
-- Name: commission_rules commission_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_pkey PRIMARY KEY (id);

--
-- Name: corecard_posting_event corecard_posting_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecard_posting_event
    ADD CONSTRAINT corecard_posting_event_pkey PRIMARY KEY (id);

--
-- Name: corecredit_event_log corecredit_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_event_log
    ADD CONSTRAINT corecredit_event_log_pkey PRIMARY KEY (id);

--
-- Name: helcim_event_log helcim_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.helcim_event_log
    ADD CONSTRAINT helcim_event_log_pkey PRIMARY KEY (id);

--
-- Name: payment_provider_batches payment_provider_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_batches
    ADD CONSTRAINT payment_provider_batches_pkey PRIMARY KEY (id);

--
-- Name: payment_provider_batch_transactions payment_provider_batch_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_batch_transactions
    ADD CONSTRAINT payment_provider_batch_transactions_pkey PRIMARY KEY (id);

--
-- Name: payment_settlement_runs payment_settlement_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settlement_runs
    ADD CONSTRAINT payment_settlement_runs_pkey PRIMARY KEY (id);

--
-- Name: payment_settlement_items payment_settlement_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settlement_items
    ADD CONSTRAINT payment_settlement_items_pkey PRIMARY KEY (id);

--
-- Name: corecredit_exception_queue corecredit_exception_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_exception_queue
    ADD CONSTRAINT corecredit_exception_queue_pkey PRIMARY KEY (id);

--
-- Name: corecredit_reconciliation_item corecredit_reconciliation_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_reconciliation_item
    ADD CONSTRAINT corecredit_reconciliation_item_pkey PRIMARY KEY (id);

--
-- Name: corecredit_reconciliation_run corecredit_reconciliation_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_reconciliation_run
    ADD CONSTRAINT corecredit_reconciliation_run_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_bridge_heartbeat counterpoint_bridge_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_bridge_heartbeat
    ADD CONSTRAINT counterpoint_bridge_heartbeat_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_category_map counterpoint_category_map_cp_category_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_category_map
    ADD CONSTRAINT counterpoint_category_map_cp_category_key UNIQUE (cp_category);

--
-- Name: counterpoint_category_map counterpoint_category_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_category_map
    ADD CONSTRAINT counterpoint_category_map_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_gift_reason_map counterpoint_gift_reason_map_cp_reason_cod_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_gift_reason_map
    ADD CONSTRAINT counterpoint_gift_reason_map_cp_reason_cod_key UNIQUE (cp_reason_cod);

--
-- Name: counterpoint_gift_reason_map counterpoint_gift_reason_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_gift_reason_map
    ADD CONSTRAINT counterpoint_gift_reason_map_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_payment_method_map counterpoint_payment_method_map_cp_pmt_typ_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_payment_method_map
    ADD CONSTRAINT counterpoint_payment_method_map_cp_pmt_typ_key UNIQUE (cp_pmt_typ);

--
-- Name: counterpoint_payment_method_map counterpoint_payment_method_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_payment_method_map
    ADD CONSTRAINT counterpoint_payment_method_map_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_receiving_history counterpoint_receiving_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_receiving_history
    ADD CONSTRAINT counterpoint_receiving_history_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_staff_map counterpoint_staff_map_cp_code_cp_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_staff_map
    ADD CONSTRAINT counterpoint_staff_map_cp_code_cp_source_key UNIQUE (cp_code, cp_source);

--
-- Name: counterpoint_staff_map counterpoint_staff_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_staff_map
    ADD CONSTRAINT counterpoint_staff_map_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_staging_batch counterpoint_staging_batch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_staging_batch
    ADD CONSTRAINT counterpoint_staging_batch_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_sync_issue counterpoint_sync_issue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_sync_issue
    ADD CONSTRAINT counterpoint_sync_issue_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_sync_request counterpoint_sync_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_sync_request
    ADD CONSTRAINT counterpoint_sync_request_pkey PRIMARY KEY (id);

--
-- Name: counterpoint_sync_runs counterpoint_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_sync_runs
    ADD CONSTRAINT counterpoint_sync_runs_pkey PRIMARY KEY (id);

--
-- Name: customer_corecredit_accounts customer_corecredit_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_corecredit_accounts
    ADD CONSTRAINT customer_corecredit_accounts_pkey PRIMARY KEY (id);

--
-- Name: customer_duplicate_review_queue customer_duplicate_review_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_duplicate_review_queue
    ADD CONSTRAINT customer_duplicate_review_queue_pkey PRIMARY KEY (id);

--
-- Name: customer_group_members customer_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_group_members
    ADD CONSTRAINT customer_group_members_pkey PRIMARY KEY (customer_id, group_id);

--
-- Name: customer_groups customer_groups_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_groups
    ADD CONSTRAINT customer_groups_code_key UNIQUE (code);

--
-- Name: customer_groups customer_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_groups
    ADD CONSTRAINT customer_groups_pkey PRIMARY KEY (id);

--
-- Name: customer_measurements customer_measurements_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_measurements
    ADD CONSTRAINT customer_measurements_customer_id_key UNIQUE (customer_id);

--
-- Name: customer_measurements customer_measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_measurements
    ADD CONSTRAINT customer_measurements_pkey PRIMARY KEY (id);

--
-- Name: customer_online_credential customer_online_credential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_online_credential
    ADD CONSTRAINT customer_online_credential_pkey PRIMARY KEY (customer_id);

--
-- Name: customer_open_deposit_accounts customer_open_deposit_accounts_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_accounts
    ADD CONSTRAINT customer_open_deposit_accounts_customer_id_key UNIQUE (customer_id);

--
-- Name: customer_open_deposit_accounts customer_open_deposit_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_accounts
    ADD CONSTRAINT customer_open_deposit_accounts_pkey PRIMARY KEY (id);

--
-- Name: customer_open_deposit_ledger customer_open_deposit_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_ledger
    ADD CONSTRAINT customer_open_deposit_ledger_pkey PRIMARY KEY (id);

--
-- Name: customer_relationship_periods customer_relationship_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_relationship_periods
    ADD CONSTRAINT customer_relationship_periods_pkey PRIMARY KEY (id);

--
-- Name: customer_timeline_notes customer_timeline_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_timeline_notes
    ADD CONSTRAINT customer_timeline_notes_pkey PRIMARY KEY (id);

--
-- Name: customers customers_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_email_key UNIQUE (email);

--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

--
-- Name: discount_event_usage discount_event_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_usage
    ADD CONSTRAINT discount_event_usage_pkey PRIMARY KEY (id);

--
-- Name: discount_event_variants discount_event_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_variants
    ADD CONSTRAINT discount_event_variants_pkey PRIMARY KEY (event_id, variant_id);

--
-- Name: discount_events discount_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_events
    ADD CONSTRAINT discount_events_pkey PRIMARY KEY (id);

--
-- Name: fulfillment_orders fulfillment_orders_display_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_display_id_key UNIQUE (display_id);

--
-- Name: fulfillment_orders fulfillment_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_pkey PRIMARY KEY (id);

--
-- Name: gift_card_events gift_card_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_card_events
    ADD CONSTRAINT gift_card_events_pkey PRIMARY KEY (id);

--
-- Name: gift_cards gift_cards_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_cards
    ADD CONSTRAINT gift_cards_code_key UNIQUE (code);

--
-- Name: gift_cards gift_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_cards
    ADD CONSTRAINT gift_cards_pkey PRIMARY KEY (id);

--
-- Name: help_manual_policy help_manual_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.help_manual_policy
    ADD CONSTRAINT help_manual_policy_pkey PRIMARY KEY (manual_id);

--
-- Name: integration_alert_state integration_alert_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_alert_state
    ADD CONSTRAINT integration_alert_state_pkey PRIMARY KEY (source);

--
-- Name: inventory_count_scan_stream inventory_count_scan_stream_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_count_scan_stream
    ADD CONSTRAINT inventory_count_scan_stream_pkey PRIMARY KEY (id);

--
-- Name: inventory_locations inventory_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_pkey PRIMARY KEY (id);

--
-- Name: inventory_map_layouts inventory_map_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_map_layouts
    ADD CONSTRAINT inventory_map_layouts_pkey PRIMARY KEY (id);

--
-- Name: inventory_transactions inventory_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_pkey PRIMARY KEY (id);

--
-- Name: layaway_activity_log layaway_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layaway_activity_log
    ADD CONSTRAINT layaway_activity_log_pkey PRIMARY KEY (id);

--
-- Name: ledger_mappings ledger_mappings_internal_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_mappings
    ADD CONSTRAINT ledger_mappings_internal_key_key UNIQUE (internal_key);

--
-- Name: ledger_mappings ledger_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_mappings
    ADD CONSTRAINT ledger_mappings_pkey PRIMARY KEY (id);

--
-- Name: loyalty_point_ledger loyalty_point_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_point_ledger
    ADD CONSTRAINT loyalty_point_ledger_pkey PRIMARY KEY (id);

--
-- Name: loyalty_reward_issuances loyalty_reward_issuances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_reward_issuances
    ADD CONSTRAINT loyalty_reward_issuances_pkey PRIMARY KEY (id);

--
-- Name: measurements measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurements
    ADD CONSTRAINT measurements_pkey PRIMARY KEY (id);

--
-- Name: meilisearch_sync_status meilisearch_sync_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meilisearch_sync_status
    ADD CONSTRAINT meilisearch_sync_status_pkey PRIMARY KEY (index_name);

--
-- Name: morning_digest_ledger morning_digest_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_digest_ledger
    ADD CONSTRAINT morning_digest_ledger_pkey PRIMARY KEY (store_day);

--
-- Name: notification_delivery_suppression notification_delivery_suppression_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_delivery_suppression
    ADD CONSTRAINT notification_delivery_suppression_pkey PRIMARY KEY (id);

--
-- Name: notification_generator_run notification_generator_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_generator_run
    ADD CONSTRAINT notification_generator_run_pkey PRIMARY KEY (generator_key);

--
-- Name: nuorder_entity_map_log nuorder_entity_map_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nuorder_entity_map_log
    ADD CONSTRAINT nuorder_entity_map_log_pkey PRIMARY KEY (id);

--
-- Name: nuorder_sync_logs nuorder_sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nuorder_sync_logs
    ADD CONSTRAINT nuorder_sync_logs_pkey PRIMARY KEY (id);

--
-- Name: nuorder_sync_state nuorder_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nuorder_sync_state
    ADD CONSTRAINT nuorder_sync_state_pkey PRIMARY KEY (id);

--
-- Name: ops_action_audit ops_action_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_action_audit
    ADD CONSTRAINT ops_action_audit_pkey PRIMARY KEY (id);

--
-- Name: ops_alert_event ops_alert_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_alert_event
    ADD CONSTRAINT ops_alert_event_pkey PRIMARY KEY (id);

--
-- Name: ops_alert_rule ops_alert_rule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_alert_rule
    ADD CONSTRAINT ops_alert_rule_pkey PRIMARY KEY (id);

--
-- Name: ops_alert_rule ops_alert_rule_rule_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_alert_rule
    ADD CONSTRAINT ops_alert_rule_rule_key_key UNIQUE (rule_key);

--
-- Name: ops_bug_incident_link ops_bug_incident_link_bug_report_id_alert_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_bug_incident_link
    ADD CONSTRAINT ops_bug_incident_link_bug_report_id_alert_event_id_key UNIQUE (bug_report_id, alert_event_id);

--
-- Name: ops_bug_incident_link ops_bug_incident_link_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_bug_incident_link
    ADD CONSTRAINT ops_bug_incident_link_pkey PRIMARY KEY (id);

--
-- Name: ops_notification_delivery_log ops_notification_delivery_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_notification_delivery_log
    ADD CONSTRAINT ops_notification_delivery_log_pkey PRIMARY KEY (id);

--
-- Name: ops_station_heartbeat ops_station_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_station_heartbeat
    ADD CONSTRAINT ops_station_heartbeat_pkey PRIMARY KEY (id);

--
-- Name: ops_station_heartbeat ops_station_heartbeat_station_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_station_heartbeat
    ADD CONSTRAINT ops_station_heartbeat_station_key_key UNIQUE (station_key);

--
-- Name: transaction_activity_log order_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_activity_log
    ADD CONSTRAINT order_activity_log_pkey PRIMARY KEY (id);

--
-- Name: transaction_attribution_audit order_attribution_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_attribution_audit
    ADD CONSTRAINT order_attribution_audit_pkey PRIMARY KEY (id);

--
-- Name: transaction_coupon_redemptions order_coupon_redemptions_order_coupon_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_coupon_redemptions
    ADD CONSTRAINT order_coupon_redemptions_order_coupon_uidx UNIQUE (transaction_id, coupon_id);

--
-- Name: transaction_coupon_redemptions order_coupon_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_coupon_redemptions
    ADD CONSTRAINT order_coupon_redemptions_pkey PRIMARY KEY (id);

--
-- Name: transaction_lines order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_lines
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);

--
-- Name: transaction_loyalty_accrual order_loyalty_accrual_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_loyalty_accrual
    ADD CONSTRAINT order_loyalty_accrual_pkey PRIMARY KEY (transaction_id);

--
-- Name: transaction_refund_queue order_refund_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_refund_queue
    ADD CONSTRAINT order_refund_queue_pkey PRIMARY KEY (id);

--
-- Name: transaction_return_lines order_return_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_return_lines
    ADD CONSTRAINT order_return_lines_pkey PRIMARY KEY (id);

--
-- Name: transactions orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

--
-- Name: payment_allocations payment_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_pkey PRIMARY KEY (id);

--
-- Name: payment_provider_attempts payment_provider_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_attempts
    ADD CONSTRAINT payment_provider_attempts_pkey PRIMARY KEY (id);

--
-- Name: payment_transactions payment_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_pkey PRIMARY KEY (id);

--
-- Name: physical_inventory_audit physical_inventory_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_audit
    ADD CONSTRAINT physical_inventory_audit_pkey PRIMARY KEY (id);

--
-- Name: physical_inventory_counts physical_inventory_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_counts
    ADD CONSTRAINT physical_inventory_counts_pkey PRIMARY KEY (id);

--
-- Name: physical_inventory_counts physical_inventory_counts_session_id_variant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_counts
    ADD CONSTRAINT physical_inventory_counts_session_id_variant_id_key UNIQUE (session_id, variant_id);

--
-- Name: physical_inventory_sessions physical_inventory_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_sessions
    ADD CONSTRAINT physical_inventory_sessions_pkey PRIMARY KEY (id);

--
-- Name: physical_inventory_sessions physical_inventory_sessions_session_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_sessions
    ADD CONSTRAINT physical_inventory_sessions_session_number_key UNIQUE (session_number);

--
-- Name: physical_inventory_snapshots physical_inventory_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_snapshots
    ADD CONSTRAINT physical_inventory_snapshots_pkey PRIMARY KEY (session_id, variant_id);

--
-- Name: podium_conversation podium_conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podium_conversation
    ADD CONSTRAINT podium_conversation_pkey PRIMARY KEY (id);

--
-- Name: podium_message podium_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podium_message
    ADD CONSTRAINT podium_message_pkey PRIMARY KEY (id);

--
-- Name: podium_webhook_delivery podium_webhook_delivery_idem_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podium_webhook_delivery
    ADD CONSTRAINT podium_webhook_delivery_idem_uq UNIQUE (idempotency_key);

--
-- Name: podium_webhook_delivery podium_webhook_delivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podium_webhook_delivery
    ADD CONSTRAINT podium_webhook_delivery_pkey PRIMARY KEY (id);

--
-- Name: pos_parked_sale_audit pos_parked_sale_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale_audit
    ADD CONSTRAINT pos_parked_sale_audit_pkey PRIMARY KEY (id);

--
-- Name: pos_parked_sale pos_parked_sale_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale
    ADD CONSTRAINT pos_parked_sale_pkey PRIMARY KEY (id);

--
-- Name: pos_rms_charge_record pos_rms_charge_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_rms_charge_record
    ADD CONSTRAINT pos_rms_charge_record_pkey PRIMARY KEY (id);

--
-- Name: product_bundle_components product_bundle_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bundle_components
    ADD CONSTRAINT product_bundle_components_pkey PRIMARY KEY (bundle_product_id, component_variant_id);

--
-- Name: product_catalog_audit_log product_catalog_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog_audit_log
    ADD CONSTRAINT product_catalog_audit_log_pkey PRIMARY KEY (id);

--
-- Name: product_variants product_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);

--
-- Name: product_variants product_variants_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_sku_key UNIQUE (sku);

--
-- Name: products products_catalog_handle_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_catalog_handle_key UNIQUE (catalog_handle);

--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

--
-- Name: purchase_order_lines purchase_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_pkey PRIMARY KEY (id);

--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);

--
-- Name: purchase_orders purchase_orders_po_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_po_number_key UNIQUE (po_number);

--
-- Name: qbo_accounts_cache qbo_accounts_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qbo_accounts_cache
    ADD CONSTRAINT qbo_accounts_cache_pkey PRIMARY KEY (id);

--
-- Name: qbo_integration qbo_integration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qbo_integration
    ADD CONSTRAINT qbo_integration_pkey PRIMARY KEY (id);

--
-- Name: qbo_mappings qbo_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qbo_mappings
    ADD CONSTRAINT qbo_mappings_pkey PRIMARY KEY (id);

--
-- Name: qbo_mappings qbo_mappings_source_type_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qbo_mappings
    ADD CONSTRAINT qbo_mappings_source_type_source_id_key UNIQUE (source_type, source_id);

--
-- Name: qbo_sync_logs qbo_sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qbo_sync_logs
    ADD CONSTRAINT qbo_sync_logs_pkey PRIMARY KEY (id);

--
-- Name: receiving_events receiving_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_events
    ADD CONSTRAINT receiving_events_pkey PRIMARY KEY (id);

--
-- Name: register_cash_adjustments register_cash_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_cash_adjustments
    ADD CONSTRAINT register_cash_adjustments_pkey PRIMARY KEY (id);

--
-- Name: register_sessions register_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_sessions
    ADD CONSTRAINT register_sessions_pkey PRIMARY KEY (id);

--
-- Name: ros_schema_migrations ros_schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ros_schema_migrations
    ADD CONSTRAINT ros_schema_migrations_pkey PRIMARY KEY (version);

--
-- Name: shipment_event shipment_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_event
    ADD CONSTRAINT shipment_event_pkey PRIMARY KEY (id);

--
-- Name: shipment shipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_pkey PRIMARY KEY (id);

--
-- Name: staff_access_log staff_access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_access_log
    ADD CONSTRAINT staff_access_log_pkey PRIMARY KEY (id);

--
-- Name: staff_auth_failure_event staff_auth_failure_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_auth_failure_event
    ADD CONSTRAINT staff_auth_failure_event_pkey PRIMARY KEY (id);

--
-- Name: staff_bug_report staff_bug_report_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_bug_report
    ADD CONSTRAINT staff_bug_report_pkey PRIMARY KEY (id);

--
-- Name: staff staff_cashier_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_cashier_code_key UNIQUE (cashier_code);

--
-- Name: staff_commission_rate_history staff_commission_rate_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_commission_rate_history
    ADD CONSTRAINT staff_commission_rate_history_pkey PRIMARY KEY (id);

--
-- Name: staff_day_exception staff_day_exception_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_day_exception
    ADD CONSTRAINT staff_day_exception_pkey PRIMARY KEY (id);

--
-- Name: staff_day_exception staff_day_exception_staff_id_exception_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_day_exception
    ADD CONSTRAINT staff_day_exception_staff_id_exception_date_key UNIQUE (staff_id, exception_date);

--
-- Name: staff_error_event staff_error_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_error_event
    ADD CONSTRAINT staff_error_event_pkey PRIMARY KEY (id);

--
-- Name: staff_notification_action staff_notification_action_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notification_action
    ADD CONSTRAINT staff_notification_action_pkey PRIMARY KEY (id);

--
-- Name: staff_notification staff_notification_notification_id_staff_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notification
    ADD CONSTRAINT staff_notification_notification_id_staff_id_key UNIQUE (notification_id, staff_id);

--
-- Name: staff_notification staff_notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notification
    ADD CONSTRAINT staff_notification_pkey PRIMARY KEY (id);

--
-- Name: staff_permission_override staff_permission_override_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_permission_override
    ADD CONSTRAINT staff_permission_override_pkey PRIMARY KEY (staff_id, permission_key);

--
-- Name: staff_permission staff_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_permission
    ADD CONSTRAINT staff_permission_pkey PRIMARY KEY (staff_id, permission_key);

--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);

--
-- Name: staff_role_permission staff_role_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_role_permission
    ADD CONSTRAINT staff_role_permission_pkey PRIMARY KEY (role, permission_key);

--
-- Name: staff_role_pricing_limits staff_role_pricing_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_role_pricing_limits
    ADD CONSTRAINT staff_role_pricing_limits_pkey PRIMARY KEY (role);

--
-- Name: staff_schedule_event_attendees staff_schedule_event_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_schedule_event_attendees
    ADD CONSTRAINT staff_schedule_event_attendees_pkey PRIMARY KEY (event_id, staff_id);

--
-- Name: staff_schedule_events staff_schedule_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_schedule_events
    ADD CONSTRAINT staff_schedule_events_pkey PRIMARY KEY (id);

--
-- Name: staff_weekly_availability staff_weekly_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_weekly_availability
    ADD CONSTRAINT staff_weekly_availability_pkey PRIMARY KEY (staff_id, weekday);

--
-- Name: staff_weekly_schedule_day staff_weekly_schedule_day_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_weekly_schedule_day
    ADD CONSTRAINT staff_weekly_schedule_day_pkey PRIMARY KEY (staff_id, week_start, weekday);

--
-- Name: staff_weekly_schedule staff_weekly_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_weekly_schedule
    ADD CONSTRAINT staff_weekly_schedule_pkey PRIMARY KEY (staff_id, week_start);

--
-- Name: store_backup_health store_backup_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_backup_health
    ADD CONSTRAINT store_backup_health_pkey PRIMARY KEY (id);

--
-- Name: store_checkout_payment_attempt store_checkout_payment_attempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_payment_attempt
    ADD CONSTRAINT store_checkout_payment_attempt_pkey PRIMARY KEY (id);

--
-- Name: store_checkout_session store_checkout_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_session
    ADD CONSTRAINT store_checkout_session_pkey PRIMARY KEY (id);

--
-- Name: store_coupons store_coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_coupons
    ADD CONSTRAINT store_coupons_pkey PRIMARY KEY (id);

--
-- Name: store_credit_accounts store_credit_accounts_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credit_accounts
    ADD CONSTRAINT store_credit_accounts_customer_id_key UNIQUE (customer_id);

--
-- Name: store_credit_accounts store_credit_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credit_accounts
    ADD CONSTRAINT store_credit_accounts_pkey PRIMARY KEY (id);

--
-- Name: store_credit_ledger store_credit_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credit_ledger
    ADD CONSTRAINT store_credit_ledger_pkey PRIMARY KEY (id);

--
-- Name: store_guest_cart_line store_guest_cart_line_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_guest_cart_line
    ADD CONSTRAINT store_guest_cart_line_pkey PRIMARY KEY (cart_id, variant_id);

--
-- Name: store_guest_cart store_guest_cart_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_guest_cart
    ADD CONSTRAINT store_guest_cart_pkey PRIMARY KEY (id);

--
-- Name: store_media_asset store_media_asset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_media_asset
    ADD CONSTRAINT store_media_asset_pkey PRIMARY KEY (id);

--
-- Name: store_pages store_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_pages
    ADD CONSTRAINT store_pages_pkey PRIMARY KEY (id);

--
-- Name: store_register_eod_snapshot store_register_eod_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_register_eod_snapshot
    ADD CONSTRAINT store_register_eod_snapshot_pkey PRIMARY KEY (store_local_date);

--
-- Name: store_settings store_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_settings
    ADD CONSTRAINT store_settings_pkey PRIMARY KEY (id);

--
-- Name: store_shipping_rate_quote store_shipping_rate_quote_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_shipping_rate_quote
    ADD CONSTRAINT store_shipping_rate_quote_pkey PRIMARY KEY (id);

--
-- Name: store_tax_state_rate store_tax_state_rate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tax_state_rate
    ADD CONSTRAINT store_tax_state_rate_pkey PRIMARY KEY (state_code);

--
-- Name: storefront_campaign storefront_campaign_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_campaign
    ADD CONSTRAINT storefront_campaign_pkey PRIMARY KEY (id);

--
-- Name: storefront_navigation_item storefront_navigation_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_navigation_item
    ADD CONSTRAINT storefront_navigation_item_pkey PRIMARY KEY (id);

--
-- Name: storefront_navigation_menu storefront_navigation_menu_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_navigation_menu
    ADD CONSTRAINT storefront_navigation_menu_pkey PRIMARY KEY (id);

--
-- Name: storefront_publish_revision storefront_publish_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_publish_revision
    ADD CONSTRAINT storefront_publish_revision_pkey PRIMARY KEY (id);

--
-- Name: suit_component_swap_events suit_component_swap_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_pkey PRIMARY KEY (id);

--
-- Name: task_assignment task_assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_pkey PRIMARY KEY (id);

--
-- Name: task_checklist_template_item task_checklist_template_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_checklist_template_item
    ADD CONSTRAINT task_checklist_template_item_pkey PRIMARY KEY (id);

--
-- Name: task_checklist_template task_checklist_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_checklist_template
    ADD CONSTRAINT task_checklist_template_pkey PRIMARY KEY (id);

--
-- Name: task_instance task_instance_assignment_id_assignee_staff_id_period_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance
    ADD CONSTRAINT task_instance_assignment_id_assignee_staff_id_period_key_key UNIQUE (assignment_id, assignee_staff_id, period_key);

--
-- Name: task_instance_item task_instance_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance_item
    ADD CONSTRAINT task_instance_item_pkey PRIMARY KEY (id);

--
-- Name: task_instance_item task_instance_item_task_instance_id_sort_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance_item
    ADD CONSTRAINT task_instance_item_task_instance_id_sort_order_key UNIQUE (task_instance_id, sort_order);

--
-- Name: task_instance task_instance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance
    ADD CONSTRAINT task_instance_pkey PRIMARY KEY (id);

--
-- Name: transactions transactions_display_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_display_id_key UNIQUE (display_id);

--
-- Name: vendor_brands vendor_brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_brands
    ADD CONSTRAINT vendor_brands_pkey PRIMARY KEY (id);

--
-- Name: vendor_supplier_item vendor_supplier_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_supplier_item
    ADD CONSTRAINT vendor_supplier_item_pkey PRIMARY KEY (id);

--
-- Name: vendor_supplier_item vendor_supplier_item_vendor_item_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_supplier_item
    ADD CONSTRAINT vendor_supplier_item_vendor_item_uidx UNIQUE (vendor_id, cp_item_no, vendor_item_no);

--
-- Name: vendors vendors_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_name_key UNIQUE (name);

--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);

--
-- Name: weather_snapshot_finalize_ledger weather_snapshot_finalize_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weather_snapshot_finalize_ledger
    ADD CONSTRAINT weather_snapshot_finalize_ledger_pkey PRIMARY KEY (id);

--
-- Name: weather_vc_daily_usage weather_vc_daily_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weather_vc_daily_usage
    ADD CONSTRAINT weather_vc_daily_usage_pkey PRIMARY KEY (usage_date);

--
-- Name: wedding_activity_log wedding_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_activity_log
    ADD CONSTRAINT wedding_activity_log_pkey PRIMARY KEY (id);

--
-- Name: wedding_appointments wedding_appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_appointments
    ADD CONSTRAINT wedding_appointments_pkey PRIMARY KEY (id);

--
-- Name: wedding_insight_saved_views wedding_insight_saved_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_insight_saved_views
    ADD CONSTRAINT wedding_insight_saved_views_pkey PRIMARY KEY (id);

--
-- Name: wedding_insight_saved_views wedding_insight_saved_views_staff_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_insight_saved_views
    ADD CONSTRAINT wedding_insight_saved_views_staff_id_name_key UNIQUE (staff_id, name);

--
-- Name: wedding_members wedding_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_members
    ADD CONSTRAINT wedding_members_pkey PRIMARY KEY (id);

--
-- Name: wedding_members wedding_members_wedding_party_id_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_members
    ADD CONSTRAINT wedding_members_wedding_party_id_customer_id_key UNIQUE (wedding_party_id, customer_id);

--
-- Name: wedding_non_inventory_items wedding_non_inventory_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_non_inventory_items
    ADD CONSTRAINT wedding_non_inventory_items_pkey PRIMARY KEY (id);

--
-- Name: wedding_parties wedding_parties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_parties
    ADD CONSTRAINT wedding_parties_pkey PRIMARY KEY (id);

--
-- Name: alteration_activity alteration_activity_alteration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_activity
    ADD CONSTRAINT alteration_activity_alteration_id_fkey FOREIGN KEY (alteration_id) REFERENCES public.alteration_orders(id) ON DELETE CASCADE;

--
-- Name: alteration_activity alteration_activity_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_activity
    ADD CONSTRAINT alteration_activity_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: alteration_order_items alteration_order_items_alteration_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_order_items
    ADD CONSTRAINT alteration_order_items_alteration_order_id_fkey FOREIGN KEY (alteration_order_id) REFERENCES public.alteration_orders(id) ON DELETE CASCADE;

--
-- Name: alteration_orders alteration_orders_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.wedding_appointments(id) ON DELETE SET NULL;

--
-- Name: alteration_orders alteration_orders_charge_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_charge_transaction_line_id_fkey FOREIGN KEY (charge_transaction_line_id) REFERENCES public.transaction_lines(id) ON DELETE SET NULL;

--
-- Name: alteration_orders alteration_orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: alteration_orders alteration_orders_fulfillment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_fulfillment_order_id_fkey FOREIGN KEY (fulfillment_order_id) REFERENCES public.fulfillment_orders(id);

--
-- Name: alteration_orders alteration_orders_linked_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_linked_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: alteration_orders alteration_orders_source_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_source_product_id_fkey FOREIGN KEY (source_product_id) REFERENCES public.products(id) ON DELETE SET NULL;

--
-- Name: alteration_orders alteration_orders_source_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_source_transaction_id_fkey FOREIGN KEY (source_transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: alteration_orders alteration_orders_source_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_source_transaction_line_id_fkey FOREIGN KEY (source_transaction_line_id) REFERENCES public.transaction_lines(id) ON DELETE SET NULL;

--
-- Name: alteration_orders alteration_orders_source_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_source_variant_id_fkey FOREIGN KEY (source_variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;

--
-- Name: alteration_orders alteration_orders_wedding_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alteration_orders
    ADD CONSTRAINT alteration_orders_wedding_member_id_fkey FOREIGN KEY (wedding_member_id) REFERENCES public.wedding_members(id) ON DELETE SET NULL;

--
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id);

--
-- Name: category_audit_log category_audit_log_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_audit_log
    ADD CONSTRAINT category_audit_log_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;

--
-- Name: category_audit_log category_audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_audit_log
    ADD CONSTRAINT category_audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.staff(id);

--
-- Name: category_commission_overrides category_commission_overrides_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_commission_overrides
    ADD CONSTRAINT category_commission_overrides_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;

--
-- Name: commission_combo_rule_items commission_combo_rule_items_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_combo_rule_items
    ADD CONSTRAINT commission_combo_rule_items_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.commission_combo_rules(id) ON DELETE CASCADE;

--
-- Name: commission_events commission_events_created_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_events
    ADD CONSTRAINT commission_events_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: commission_events commission_events_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_events
    ADD CONSTRAINT commission_events_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: commission_events commission_events_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_events
    ADD CONSTRAINT commission_events_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: commission_events commission_events_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_events
    ADD CONSTRAINT commission_events_transaction_line_id_fkey FOREIGN KEY (transaction_line_id) REFERENCES public.transaction_lines(id) ON DELETE SET NULL;

--
-- Name: corecard_posting_event corecard_posting_event_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecard_posting_event
    ADD CONSTRAINT corecard_posting_event_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: corecard_posting_event corecard_posting_event_payment_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecard_posting_event
    ADD CONSTRAINT corecard_posting_event_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES public.payment_transactions(id) ON DELETE SET NULL;

--
-- Name: corecard_posting_event corecard_posting_event_pos_rms_charge_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecard_posting_event
    ADD CONSTRAINT corecard_posting_event_pos_rms_charge_record_id_fkey FOREIGN KEY (pos_rms_charge_record_id) REFERENCES public.pos_rms_charge_record(id) ON DELETE SET NULL;

--
-- Name: corecard_posting_event corecard_posting_event_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecard_posting_event
    ADD CONSTRAINT corecard_posting_event_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: corecredit_event_log corecredit_event_log_related_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_event_log
    ADD CONSTRAINT corecredit_event_log_related_customer_id_fkey FOREIGN KEY (related_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: corecredit_event_log corecredit_event_log_related_rms_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_event_log
    ADD CONSTRAINT corecredit_event_log_related_rms_record_id_fkey FOREIGN KEY (related_rms_record_id) REFERENCES public.pos_rms_charge_record(id) ON DELETE SET NULL;

--
-- Name: corecredit_exception_queue corecredit_exception_queue_assigned_to_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_exception_queue
    ADD CONSTRAINT corecredit_exception_queue_assigned_to_staff_id_fkey FOREIGN KEY (assigned_to_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: corecredit_exception_queue corecredit_exception_queue_rms_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_exception_queue
    ADD CONSTRAINT corecredit_exception_queue_rms_record_id_fkey FOREIGN KEY (rms_record_id) REFERENCES public.pos_rms_charge_record(id) ON DELETE SET NULL;

--
-- Name: corecredit_reconciliation_item corecredit_reconciliation_item_rms_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_reconciliation_item
    ADD CONSTRAINT corecredit_reconciliation_item_rms_record_id_fkey FOREIGN KEY (rms_record_id) REFERENCES public.pos_rms_charge_record(id) ON DELETE SET NULL;

--
-- Name: corecredit_reconciliation_item corecredit_reconciliation_item_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_reconciliation_item
    ADD CONSTRAINT corecredit_reconciliation_item_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.corecredit_reconciliation_run(id) ON DELETE CASCADE;

--
-- Name: corecredit_reconciliation_run corecredit_reconciliation_run_requested_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corecredit_reconciliation_run
    ADD CONSTRAINT corecredit_reconciliation_run_requested_by_staff_id_fkey FOREIGN KEY (requested_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: counterpoint_category_map counterpoint_category_map_ros_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_category_map
    ADD CONSTRAINT counterpoint_category_map_ros_category_id_fkey FOREIGN KEY (ros_category_id) REFERENCES public.categories(id) ON DELETE SET NULL;

--
-- Name: counterpoint_receiving_history counterpoint_receiving_history_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_receiving_history
    ADD CONSTRAINT counterpoint_receiving_history_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;

--
-- Name: counterpoint_staff_map counterpoint_staff_map_ros_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_staff_map
    ADD CONSTRAINT counterpoint_staff_map_ros_staff_id_fkey FOREIGN KEY (ros_staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: counterpoint_staging_batch counterpoint_staging_batch_applied_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_staging_batch
    ADD CONSTRAINT counterpoint_staging_batch_applied_by_staff_id_fkey FOREIGN KEY (applied_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: counterpoint_sync_request counterpoint_sync_request_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterpoint_sync_request
    ADD CONSTRAINT counterpoint_sync_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: customer_corecredit_accounts customer_corecredit_accounts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_corecredit_accounts
    ADD CONSTRAINT customer_corecredit_accounts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_corecredit_accounts customer_corecredit_accounts_verified_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_corecredit_accounts
    ADD CONSTRAINT customer_corecredit_accounts_verified_by_staff_id_fkey FOREIGN KEY (verified_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: customer_duplicate_review_queue customer_duplicate_review_queue_customer_a_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_duplicate_review_queue
    ADD CONSTRAINT customer_duplicate_review_queue_customer_a_id_fkey FOREIGN KEY (customer_a_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_duplicate_review_queue customer_duplicate_review_queue_customer_b_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_duplicate_review_queue
    ADD CONSTRAINT customer_duplicate_review_queue_customer_b_id_fkey FOREIGN KEY (customer_b_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_group_members customer_group_members_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_group_members
    ADD CONSTRAINT customer_group_members_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_group_members customer_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_group_members
    ADD CONSTRAINT customer_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.customer_groups(id) ON DELETE CASCADE;

--
-- Name: customer_measurements customer_measurements_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_measurements
    ADD CONSTRAINT customer_measurements_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_measurements customer_measurements_measured_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_measurements
    ADD CONSTRAINT customer_measurements_measured_by_fkey FOREIGN KEY (measured_by) REFERENCES public.staff(id);

--
-- Name: customer_online_credential customer_online_credential_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_online_credential
    ADD CONSTRAINT customer_online_credential_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_open_deposit_accounts customer_open_deposit_accounts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_accounts
    ADD CONSTRAINT customer_open_deposit_accounts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_open_deposit_ledger customer_open_deposit_ledger_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_ledger
    ADD CONSTRAINT customer_open_deposit_ledger_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.customer_open_deposit_accounts(id) ON DELETE CASCADE;

--
-- Name: customer_open_deposit_ledger customer_open_deposit_ledger_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_ledger
    ADD CONSTRAINT customer_open_deposit_ledger_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: customer_open_deposit_ledger customer_open_deposit_ledger_payer_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_ledger
    ADD CONSTRAINT customer_open_deposit_ledger_payer_customer_id_fkey FOREIGN KEY (payer_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: customer_open_deposit_ledger customer_open_deposit_ledger_wedding_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_open_deposit_ledger
    ADD CONSTRAINT customer_open_deposit_ledger_wedding_party_id_fkey FOREIGN KEY (wedding_party_id) REFERENCES public.wedding_parties(id) ON DELETE SET NULL;

--
-- Name: customer_relationship_periods customer_relationship_periods_child_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_relationship_periods
    ADD CONSTRAINT customer_relationship_periods_child_customer_id_fkey FOREIGN KEY (child_customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_relationship_periods customer_relationship_periods_parent_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_relationship_periods
    ADD CONSTRAINT customer_relationship_periods_parent_customer_id_fkey FOREIGN KEY (parent_customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customer_timeline_notes customer_timeline_notes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_timeline_notes
    ADD CONSTRAINT customer_timeline_notes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.staff(id);

--
-- Name: customer_timeline_notes customer_timeline_notes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_timeline_notes
    ADD CONSTRAINT customer_timeline_notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: customers customers_couple_primary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_couple_primary_id_fkey FOREIGN KEY (couple_primary_id) REFERENCES public.customers(id);

--
-- Name: customers customers_preferred_salesperson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_preferred_salesperson_id_fkey FOREIGN KEY (preferred_salesperson_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: customers customers_wedding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_wedding_id_fkey FOREIGN KEY (wedding_id) REFERENCES public.wedding_parties(id) ON DELETE SET NULL;

--
-- Name: discount_event_usage discount_event_usage_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_usage
    ADD CONSTRAINT discount_event_usage_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.discount_events(id) ON DELETE CASCADE;

--
-- Name: discount_event_usage discount_event_usage_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_usage
    ADD CONSTRAINT discount_event_usage_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: discount_event_usage discount_event_usage_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_usage
    ADD CONSTRAINT discount_event_usage_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.transaction_lines(id) ON DELETE CASCADE;

--
-- Name: discount_event_usage discount_event_usage_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_usage
    ADD CONSTRAINT discount_event_usage_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE RESTRICT;

--
-- Name: discount_event_variants discount_event_variants_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_variants
    ADD CONSTRAINT discount_event_variants_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.discount_events(id) ON DELETE CASCADE;

--
-- Name: discount_event_variants discount_event_variants_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_event_variants
    ADD CONSTRAINT discount_event_variants_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: discount_events discount_events_scope_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_events
    ADD CONSTRAINT discount_events_scope_category_id_fkey FOREIGN KEY (scope_category_id) REFERENCES public.categories(id) ON DELETE SET NULL;

--
-- Name: discount_events discount_events_scope_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_events
    ADD CONSTRAINT discount_events_scope_vendor_id_fkey FOREIGN KEY (scope_vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;

--
-- Name: fulfillment_orders fulfillment_orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: fulfillment_orders fulfillment_orders_wedding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_wedding_id_fkey FOREIGN KEY (wedding_id) REFERENCES public.wedding_parties(id) ON DELETE SET NULL;

--
-- Name: gift_card_events gift_card_events_gift_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_card_events
    ADD CONSTRAINT gift_card_events_gift_card_id_fkey FOREIGN KEY (gift_card_id) REFERENCES public.gift_cards(id) ON DELETE CASCADE;

--
-- Name: gift_card_events gift_card_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_card_events
    ADD CONSTRAINT gift_card_events_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: gift_card_events gift_card_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_card_events
    ADD CONSTRAINT gift_card_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.register_sessions(id) ON DELETE SET NULL;

--
-- Name: gift_card_events gift_card_events_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_card_events
    ADD CONSTRAINT gift_card_events_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: gift_cards gift_cards_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_cards
    ADD CONSTRAINT gift_cards_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: gift_cards gift_cards_issued_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_cards
    ADD CONSTRAINT gift_cards_issued_order_id_fkey FOREIGN KEY (issued_order_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: gift_cards gift_cards_issued_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_cards
    ADD CONSTRAINT gift_cards_issued_session_id_fkey FOREIGN KEY (issued_session_id) REFERENCES public.register_sessions(id) ON DELETE SET NULL;

--
-- Name: help_manual_policy help_manual_policy_updated_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.help_manual_policy
    ADD CONSTRAINT help_manual_policy_updated_by_staff_id_fkey FOREIGN KEY (updated_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: inventory_count_scan_stream inventory_count_scan_stream_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_count_scan_stream
    ADD CONSTRAINT inventory_count_scan_stream_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.inventory_locations(id);

--
-- Name: inventory_count_scan_stream inventory_count_scan_stream_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_count_scan_stream
    ADD CONSTRAINT inventory_count_scan_stream_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE;

--
-- Name: inventory_count_scan_stream inventory_count_scan_stream_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_count_scan_stream
    ADD CONSTRAINT inventory_count_scan_stream_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id);

--
-- Name: inventory_count_scan_stream inventory_count_scan_stream_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_count_scan_stream
    ADD CONSTRAINT inventory_count_scan_stream_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

--
-- Name: inventory_locations inventory_locations_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_layout_id_fkey FOREIGN KEY (layout_id) REFERENCES public.inventory_map_layouts(id) ON DELETE CASCADE;

--
-- Name: inventory_transactions inventory_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.staff(id);

--
-- Name: inventory_transactions inventory_transactions_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

--
-- Name: layaway_activity_log layaway_activity_log_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layaway_activity_log
    ADD CONSTRAINT layaway_activity_log_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: layaway_activity_log layaway_activity_log_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layaway_activity_log
    ADD CONSTRAINT layaway_activity_log_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id);

--
-- Name: ledger_mappings ledger_mappings_qbo_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_mappings
    ADD CONSTRAINT ledger_mappings_qbo_account_id_fkey FOREIGN KEY (qbo_account_id) REFERENCES public.qbo_accounts_cache(id);

--
-- Name: loyalty_point_ledger loyalty_point_ledger_created_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_point_ledger
    ADD CONSTRAINT loyalty_point_ledger_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: loyalty_point_ledger loyalty_point_ledger_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_point_ledger
    ADD CONSTRAINT loyalty_point_ledger_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: loyalty_point_ledger loyalty_point_ledger_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_point_ledger
    ADD CONSTRAINT loyalty_point_ledger_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: loyalty_reward_issuances loyalty_reward_issuances_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_reward_issuances
    ADD CONSTRAINT loyalty_reward_issuances_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: loyalty_reward_issuances loyalty_reward_issuances_issued_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_reward_issuances
    ADD CONSTRAINT loyalty_reward_issuances_issued_by_staff_id_fkey FOREIGN KEY (issued_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: loyalty_reward_issuances loyalty_reward_issuances_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_reward_issuances
    ADD CONSTRAINT loyalty_reward_issuances_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: loyalty_reward_issuances loyalty_reward_issuances_remainder_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_reward_issuances
    ADD CONSTRAINT loyalty_reward_issuances_remainder_card_id_fkey FOREIGN KEY (remainder_card_id) REFERENCES public.gift_cards(id);

--
-- Name: measurements measurements_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurements
    ADD CONSTRAINT measurements_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: measurements measurements_measured_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurements
    ADD CONSTRAINT measurements_measured_by_fkey FOREIGN KEY (measured_by) REFERENCES public.staff(id);

--
-- Name: notification_delivery_suppression notification_delivery_suppression_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_delivery_suppression
    ADD CONSTRAINT notification_delivery_suppression_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.app_notification(id) ON DELETE CASCADE;

--
-- Name: notification_delivery_suppression notification_delivery_suppression_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_delivery_suppression
    ADD CONSTRAINT notification_delivery_suppression_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: nuorder_entity_map_log nuorder_entity_map_log_mapped_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nuorder_entity_map_log
    ADD CONSTRAINT nuorder_entity_map_log_mapped_by_fkey FOREIGN KEY (mapped_by) REFERENCES public.staff(id);

--
-- Name: ops_action_audit ops_action_audit_actor_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_action_audit
    ADD CONSTRAINT ops_action_audit_actor_staff_id_fkey FOREIGN KEY (actor_staff_id) REFERENCES public.staff(id) ON DELETE RESTRICT;

--
-- Name: ops_alert_event ops_alert_event_acked_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_alert_event
    ADD CONSTRAINT ops_alert_event_acked_by_staff_id_fkey FOREIGN KEY (acked_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: ops_alert_event ops_alert_event_resolved_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_alert_event
    ADD CONSTRAINT ops_alert_event_resolved_by_staff_id_fkey FOREIGN KEY (resolved_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: ops_bug_incident_link ops_bug_incident_link_alert_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_bug_incident_link
    ADD CONSTRAINT ops_bug_incident_link_alert_event_id_fkey FOREIGN KEY (alert_event_id) REFERENCES public.ops_alert_event(id) ON DELETE CASCADE;

--
-- Name: ops_bug_incident_link ops_bug_incident_link_bug_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_bug_incident_link
    ADD CONSTRAINT ops_bug_incident_link_bug_report_id_fkey FOREIGN KEY (bug_report_id) REFERENCES public.staff_bug_report(id) ON DELETE CASCADE;

--
-- Name: ops_bug_incident_link ops_bug_incident_link_linked_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_bug_incident_link
    ADD CONSTRAINT ops_bug_incident_link_linked_by_staff_id_fkey FOREIGN KEY (linked_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: ops_notification_delivery_log ops_notification_delivery_log_alert_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_notification_delivery_log
    ADD CONSTRAINT ops_notification_delivery_log_alert_event_id_fkey FOREIGN KEY (alert_event_id) REFERENCES public.ops_alert_event(id) ON DELETE CASCADE;

--
-- Name: transaction_activity_log order_activity_log_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_activity_log
    ADD CONSTRAINT order_activity_log_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: transaction_activity_log order_activity_log_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_activity_log
    ADD CONSTRAINT order_activity_log_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: transaction_attribution_audit order_attribution_audit_corrected_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_attribution_audit
    ADD CONSTRAINT order_attribution_audit_corrected_by_staff_id_fkey FOREIGN KEY (corrected_by_staff_id) REFERENCES public.staff(id);

--
-- Name: transaction_attribution_audit order_attribution_audit_new_salesperson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_attribution_audit
    ADD CONSTRAINT order_attribution_audit_new_salesperson_id_fkey FOREIGN KEY (new_salesperson_id) REFERENCES public.staff(id);

--
-- Name: transaction_attribution_audit order_attribution_audit_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_attribution_audit
    ADD CONSTRAINT order_attribution_audit_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: transaction_attribution_audit order_attribution_audit_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_attribution_audit
    ADD CONSTRAINT order_attribution_audit_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.transaction_lines(id) ON DELETE SET NULL;

--
-- Name: transaction_attribution_audit order_attribution_audit_prior_salesperson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_attribution_audit
    ADD CONSTRAINT order_attribution_audit_prior_salesperson_id_fkey FOREIGN KEY (prior_salesperson_id) REFERENCES public.staff(id);

--
-- Name: transaction_coupon_redemptions order_coupon_redemptions_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_coupon_redemptions
    ADD CONSTRAINT order_coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.store_coupons(id) ON DELETE RESTRICT;

--
-- Name: transaction_coupon_redemptions order_coupon_redemptions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_coupon_redemptions
    ADD CONSTRAINT order_coupon_redemptions_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: transaction_lines order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_lines
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: transaction_lines order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_lines
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

--
-- Name: transaction_lines order_items_salesperson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_lines
    ADD CONSTRAINT order_items_salesperson_id_fkey FOREIGN KEY (salesperson_id) REFERENCES public.staff(id);

--
-- Name: transaction_lines order_items_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_lines
    ADD CONSTRAINT order_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

--
-- Name: transaction_loyalty_accrual order_loyalty_accrual_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_loyalty_accrual
    ADD CONSTRAINT order_loyalty_accrual_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: transaction_refund_queue order_refund_queue_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_refund_queue
    ADD CONSTRAINT order_refund_queue_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: transaction_refund_queue order_refund_queue_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_refund_queue
    ADD CONSTRAINT order_refund_queue_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: transaction_return_lines order_return_lines_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_return_lines
    ADD CONSTRAINT order_return_lines_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: transaction_return_lines order_return_lines_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_return_lines
    ADD CONSTRAINT order_return_lines_order_item_id_fkey FOREIGN KEY (transaction_line_id) REFERENCES public.transaction_lines(id) ON DELETE CASCADE;

--
-- Name: transaction_return_lines order_return_lines_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_return_lines
    ADD CONSTRAINT order_return_lines_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: transactions orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

--
-- Name: transactions orders_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.staff(id);

--
-- Name: transactions orders_primary_salesperson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_primary_salesperson_id_fkey FOREIGN KEY (primary_salesperson_id) REFERENCES public.staff(id);

--
-- Name: transactions orders_processed_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_processed_by_staff_id_fkey FOREIGN KEY (processed_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: transactions orders_register_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_register_session_id_fkey FOREIGN KEY (register_session_id) REFERENCES public.register_sessions(id) ON DELETE SET NULL;

--
-- Name: transactions orders_wedding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_wedding_id_fkey FOREIGN KEY (wedding_id) REFERENCES public.wedding_parties(id);

--
-- Name: transactions orders_wedding_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT orders_wedding_member_id_fkey FOREIGN KEY (wedding_member_id) REFERENCES public.wedding_members(id) ON DELETE SET NULL;

--
-- Name: payment_allocations payment_allocations_target_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_target_order_id_fkey FOREIGN KEY (target_transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: payment_allocations payment_allocations_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.payment_transactions(id) ON DELETE CASCADE;

--
-- Name: payment_provider_attempts payment_provider_attempts_register_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_attempts
    ADD CONSTRAINT payment_provider_attempts_register_session_id_fkey FOREIGN KEY (register_session_id) REFERENCES public.register_sessions(id) ON DELETE SET NULL;

--
-- Name: payment_provider_attempts payment_provider_attempts_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_attempts
    ADD CONSTRAINT payment_provider_attempts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: payment_provider_batches payment_provider_batches_source_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_batches
    ADD CONSTRAINT payment_provider_batches_source_event_id_fkey FOREIGN KEY (source_event_id) REFERENCES public.helcim_event_log(id) ON DELETE SET NULL;

--
-- Name: payment_provider_batch_transactions payment_provider_batch_transactions_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_batch_transactions
    ADD CONSTRAINT payment_provider_batch_transactions_batch_id_fkey FOREIGN KEY (payment_provider_batch_id) REFERENCES public.payment_provider_batches(id) ON DELETE SET NULL;

--
-- Name: payment_provider_batch_transactions payment_provider_batch_transactions_payment_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_batch_transactions
    ADD CONSTRAINT payment_provider_batch_transactions_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES public.payment_transactions(id) ON DELETE SET NULL;

--
-- Name: payment_provider_batch_transactions payment_provider_batch_transactions_source_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_batch_transactions
    ADD CONSTRAINT payment_provider_batch_transactions_source_event_id_fkey FOREIGN KEY (source_event_id) REFERENCES public.helcim_event_log(id) ON DELETE SET NULL;

--
-- Name: payment_settlement_runs payment_settlement_runs_requested_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settlement_runs
    ADD CONSTRAINT payment_settlement_runs_requested_by_staff_id_fkey FOREIGN KEY (requested_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: payment_settlement_items payment_settlement_items_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settlement_items
    ADD CONSTRAINT payment_settlement_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payment_settlement_runs(id) ON DELETE CASCADE;

--
-- Name: payment_settlement_items payment_settlement_items_payment_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settlement_items
    ADD CONSTRAINT payment_settlement_items_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES public.payment_transactions(id) ON DELETE SET NULL;

--
-- Name: payment_settlement_items payment_settlement_items_provider_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settlement_items
    ADD CONSTRAINT payment_settlement_items_provider_batch_id_fkey FOREIGN KEY (payment_provider_batch_id) REFERENCES public.payment_provider_batches(id) ON DELETE SET NULL;

--
-- Name: payment_transactions payment_transactions_payer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_payer_id_fkey FOREIGN KEY (payer_id) REFERENCES public.customers(id);

--
-- Name: payment_transactions payment_transactions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.register_sessions(id);

--
-- Name: payment_transactions payment_transactions_wedding_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_wedding_member_id_fkey FOREIGN KEY (wedding_member_id) REFERENCES public.wedding_members(id) ON DELETE SET NULL;

--
-- Name: physical_inventory_audit physical_inventory_audit_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_audit
    ADD CONSTRAINT physical_inventory_audit_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.staff(id);

--
-- Name: physical_inventory_audit physical_inventory_audit_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_audit
    ADD CONSTRAINT physical_inventory_audit_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE;

--
-- Name: physical_inventory_audit physical_inventory_audit_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_audit
    ADD CONSTRAINT physical_inventory_audit_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

--
-- Name: physical_inventory_counts physical_inventory_counts_counted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_counts
    ADD CONSTRAINT physical_inventory_counts_counted_by_fkey FOREIGN KEY (counted_by) REFERENCES public.staff(id);

--
-- Name: physical_inventory_counts physical_inventory_counts_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_counts
    ADD CONSTRAINT physical_inventory_counts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE;

--
-- Name: physical_inventory_counts physical_inventory_counts_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_counts
    ADD CONSTRAINT physical_inventory_counts_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

--
-- Name: physical_inventory_sessions physical_inventory_sessions_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_sessions
    ADD CONSTRAINT physical_inventory_sessions_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.staff(id);

--
-- Name: physical_inventory_sessions physical_inventory_sessions_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_sessions
    ADD CONSTRAINT physical_inventory_sessions_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.staff(id);

--
-- Name: physical_inventory_snapshots physical_inventory_snapshots_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_snapshots
    ADD CONSTRAINT physical_inventory_snapshots_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE;

--
-- Name: physical_inventory_snapshots physical_inventory_snapshots_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_inventory_snapshots
    ADD CONSTRAINT physical_inventory_snapshots_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

--
-- Name: podium_conversation podium_conversation_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podium_conversation
    ADD CONSTRAINT podium_conversation_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: podium_message podium_message_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podium_message
    ADD CONSTRAINT podium_message_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.podium_conversation(id) ON DELETE CASCADE;

--
-- Name: podium_message podium_message_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podium_message
    ADD CONSTRAINT podium_message_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: pos_parked_sale_audit pos_parked_sale_audit_actor_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale_audit
    ADD CONSTRAINT pos_parked_sale_audit_actor_staff_id_fkey FOREIGN KEY (actor_staff_id) REFERENCES public.staff(id);

--
-- Name: pos_parked_sale_audit pos_parked_sale_audit_parked_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale_audit
    ADD CONSTRAINT pos_parked_sale_audit_parked_sale_id_fkey FOREIGN KEY (parked_sale_id) REFERENCES public.pos_parked_sale(id) ON DELETE SET NULL;

--
-- Name: pos_parked_sale pos_parked_sale_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale
    ADD CONSTRAINT pos_parked_sale_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: pos_parked_sale pos_parked_sale_deleted_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale
    ADD CONSTRAINT pos_parked_sale_deleted_by_staff_id_fkey FOREIGN KEY (deleted_by_staff_id) REFERENCES public.staff(id);

--
-- Name: pos_parked_sale pos_parked_sale_parked_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale
    ADD CONSTRAINT pos_parked_sale_parked_by_staff_id_fkey FOREIGN KEY (parked_by_staff_id) REFERENCES public.staff(id);

--
-- Name: pos_parked_sale pos_parked_sale_recalled_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale
    ADD CONSTRAINT pos_parked_sale_recalled_by_staff_id_fkey FOREIGN KEY (recalled_by_staff_id) REFERENCES public.staff(id);

--
-- Name: pos_parked_sale pos_parked_sale_register_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_parked_sale
    ADD CONSTRAINT pos_parked_sale_register_session_id_fkey FOREIGN KEY (register_session_id) REFERENCES public.register_sessions(id) ON DELETE CASCADE;

--
-- Name: pos_rms_charge_record pos_rms_charge_record_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_rms_charge_record
    ADD CONSTRAINT pos_rms_charge_record_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: pos_rms_charge_record pos_rms_charge_record_operator_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_rms_charge_record
    ADD CONSTRAINT pos_rms_charge_record_operator_staff_id_fkey FOREIGN KEY (operator_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: pos_rms_charge_record pos_rms_charge_record_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_rms_charge_record
    ADD CONSTRAINT pos_rms_charge_record_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: pos_rms_charge_record pos_rms_charge_record_payment_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_rms_charge_record
    ADD CONSTRAINT pos_rms_charge_record_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES public.payment_transactions(id) ON DELETE SET NULL;

--
-- Name: pos_rms_charge_record pos_rms_charge_record_register_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_rms_charge_record
    ADD CONSTRAINT pos_rms_charge_record_register_session_id_fkey FOREIGN KEY (register_session_id) REFERENCES public.register_sessions(id);

--
-- Name: product_bundle_components product_bundle_components_bundle_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bundle_components
    ADD CONSTRAINT product_bundle_components_bundle_product_id_fkey FOREIGN KEY (bundle_product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: product_bundle_components product_bundle_components_component_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bundle_components
    ADD CONSTRAINT product_bundle_components_component_variant_id_fkey FOREIGN KEY (component_variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: product_catalog_audit_log product_catalog_audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog_audit_log
    ADD CONSTRAINT product_catalog_audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.staff(id);

--
-- Name: product_catalog_audit_log product_catalog_audit_log_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog_audit_log
    ADD CONSTRAINT product_catalog_audit_log_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: product_variants product_variants_default_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_default_location_id_fkey FOREIGN KEY (default_location_id) REFERENCES public.inventory_locations(id) ON DELETE SET NULL;

--
-- Name: product_variants product_variants_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

--
-- Name: products products_primary_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_primary_vendor_id_fkey FOREIGN KEY (primary_vendor_id) REFERENCES public.vendors(id);

--
-- Name: purchase_order_lines purchase_order_lines_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;

--
-- Name: purchase_order_lines purchase_order_lines_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

--
-- Name: purchase_orders purchase_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.staff(id);

--
-- Name: purchase_orders purchase_orders_split_from_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_split_from_po_id_fkey FOREIGN KEY (split_from_po_id) REFERENCES public.purchase_orders(id);

--
-- Name: purchase_orders purchase_orders_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);

--
-- Name: qbo_mappings qbo_mappings_qbo_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qbo_mappings
    ADD CONSTRAINT qbo_mappings_qbo_account_id_fkey FOREIGN KEY (qbo_account_id) REFERENCES public.qbo_accounts_cache(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: receiving_events receiving_events_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_events
    ADD CONSTRAINT receiving_events_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;

--
-- Name: receiving_events receiving_events_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_events
    ADD CONSTRAINT receiving_events_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.staff(id);

--
-- Name: register_cash_adjustments register_cash_adjustments_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_cash_adjustments
    ADD CONSTRAINT register_cash_adjustments_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.register_sessions(id) ON DELETE CASCADE;

--
-- Name: register_sessions register_sessions_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_sessions
    ADD CONSTRAINT register_sessions_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.staff(id);

--
-- Name: register_sessions register_sessions_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_sessions
    ADD CONSTRAINT register_sessions_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public.staff(id);

--
-- Name: register_sessions register_sessions_shift_primary_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_sessions
    ADD CONSTRAINT register_sessions_shift_primary_staff_id_fkey FOREIGN KEY (shift_primary_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: shipment shipment_created_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: shipment shipment_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: shipment_event shipment_event_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_event
    ADD CONSTRAINT shipment_event_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipment(id) ON DELETE CASCADE;

--
-- Name: shipment_event shipment_event_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_event
    ADD CONSTRAINT shipment_event_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: shipment shipment_fulfillment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_fulfillment_order_id_fkey FOREIGN KEY (fulfillment_order_id) REFERENCES public.fulfillment_orders(id);

--
-- Name: shipment shipment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: staff_access_log staff_access_log_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_access_log
    ADD CONSTRAINT staff_access_log_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_auth_failure_event staff_auth_failure_event_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_auth_failure_event
    ADD CONSTRAINT staff_auth_failure_event_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_bug_report staff_bug_report_resolved_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_bug_report
    ADD CONSTRAINT staff_bug_report_resolved_by_staff_id_fkey FOREIGN KEY (resolved_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: staff_bug_report staff_bug_report_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_bug_report
    ADD CONSTRAINT staff_bug_report_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_commission_rate_history staff_commission_rate_history_changed_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_commission_rate_history
    ADD CONSTRAINT staff_commission_rate_history_changed_by_staff_id_fkey FOREIGN KEY (changed_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: staff_commission_rate_history staff_commission_rate_history_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_commission_rate_history
    ADD CONSTRAINT staff_commission_rate_history_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_day_exception staff_day_exception_created_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_day_exception
    ADD CONSTRAINT staff_day_exception_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: staff_day_exception staff_day_exception_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_day_exception
    ADD CONSTRAINT staff_day_exception_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff staff_employee_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_employee_customer_id_fkey FOREIGN KEY (employee_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: staff_error_event staff_error_event_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_error_event
    ADD CONSTRAINT staff_error_event_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: staff_notification_action staff_notification_action_actor_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notification_action
    ADD CONSTRAINT staff_notification_action_actor_staff_id_fkey FOREIGN KEY (actor_staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_notification_action staff_notification_action_staff_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notification_action
    ADD CONSTRAINT staff_notification_action_staff_notification_id_fkey FOREIGN KEY (staff_notification_id) REFERENCES public.staff_notification(id) ON DELETE CASCADE;

--
-- Name: staff_notification staff_notification_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notification
    ADD CONSTRAINT staff_notification_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.app_notification(id) ON DELETE CASCADE;

--
-- Name: staff_notification staff_notification_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notification
    ADD CONSTRAINT staff_notification_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_permission_override staff_permission_override_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_permission_override
    ADD CONSTRAINT staff_permission_override_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_permission staff_permission_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_permission
    ADD CONSTRAINT staff_permission_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_schedule_event_attendees staff_schedule_event_attendees_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_schedule_event_attendees
    ADD CONSTRAINT staff_schedule_event_attendees_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.staff_schedule_events(id) ON DELETE CASCADE;

--
-- Name: staff_schedule_event_attendees staff_schedule_event_attendees_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_schedule_event_attendees
    ADD CONSTRAINT staff_schedule_event_attendees_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_weekly_availability staff_weekly_availability_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_weekly_availability
    ADD CONSTRAINT staff_weekly_availability_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: staff_weekly_schedule staff_weekly_schedule_created_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_weekly_schedule
    ADD CONSTRAINT staff_weekly_schedule_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES public.staff(id);

--
-- Name: staff_weekly_schedule_day staff_weekly_schedule_day_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_weekly_schedule_day
    ADD CONSTRAINT staff_weekly_schedule_day_fk FOREIGN KEY (staff_id, week_start) REFERENCES public.staff_weekly_schedule(staff_id, week_start) ON DELETE CASCADE;

--
-- Name: staff_weekly_schedule staff_weekly_schedule_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_weekly_schedule
    ADD CONSTRAINT staff_weekly_schedule_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: store_checkout_payment_attempt store_checkout_payment_attempt_checkout_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_payment_attempt
    ADD CONSTRAINT store_checkout_payment_attempt_checkout_session_id_fkey FOREIGN KEY (checkout_session_id) REFERENCES public.store_checkout_session(id) ON DELETE CASCADE;

--
-- Name: store_checkout_session store_checkout_session_account_conversion_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_session
    ADD CONSTRAINT store_checkout_session_account_conversion_customer_id_fkey FOREIGN KEY (account_conversion_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: store_checkout_session store_checkout_session_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_session
    ADD CONSTRAINT store_checkout_session_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.store_coupons(id) ON DELETE SET NULL;

--
-- Name: store_checkout_session store_checkout_session_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_session
    ADD CONSTRAINT store_checkout_session_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: store_checkout_session store_checkout_session_finalized_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_session
    ADD CONSTRAINT store_checkout_session_finalized_transaction_id_fkey FOREIGN KEY (finalized_transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: store_checkout_session store_checkout_session_guest_cart_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_checkout_session
    ADD CONSTRAINT store_checkout_session_guest_cart_id_fkey FOREIGN KEY (guest_cart_id) REFERENCES public.store_guest_cart(id) ON DELETE SET NULL;

--
-- Name: store_credit_accounts store_credit_accounts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credit_accounts
    ADD CONSTRAINT store_credit_accounts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: store_credit_ledger store_credit_ledger_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credit_ledger
    ADD CONSTRAINT store_credit_ledger_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.store_credit_accounts(id) ON DELETE CASCADE;

--
-- Name: store_credit_ledger store_credit_ledger_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credit_ledger
    ADD CONSTRAINT store_credit_ledger_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: store_guest_cart_line store_guest_cart_line_cart_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_guest_cart_line
    ADD CONSTRAINT store_guest_cart_line_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES public.store_guest_cart(id) ON DELETE CASCADE;

--
-- Name: store_guest_cart_line store_guest_cart_line_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_guest_cart_line
    ADD CONSTRAINT store_guest_cart_line_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: store_media_asset store_media_asset_created_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_media_asset
    ADD CONSTRAINT store_media_asset_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: store_register_eod_snapshot store_register_eod_snapshot_primary_register_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_register_eod_snapshot
    ADD CONSTRAINT store_register_eod_snapshot_primary_register_session_id_fkey FOREIGN KEY (primary_register_session_id) REFERENCES public.register_sessions(id) ON DELETE SET NULL;

--
-- Name: storefront_campaign storefront_campaign_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_campaign
    ADD CONSTRAINT storefront_campaign_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.store_coupons(id) ON DELETE SET NULL;

--
-- Name: storefront_navigation_item storefront_navigation_item_menu_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_navigation_item
    ADD CONSTRAINT storefront_navigation_item_menu_id_fkey FOREIGN KEY (menu_id) REFERENCES public.storefront_navigation_menu(id) ON DELETE CASCADE;

--
-- Name: storefront_publish_revision storefront_publish_revision_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_publish_revision
    ADD CONSTRAINT storefront_publish_revision_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.store_pages(id) ON DELETE CASCADE;

--
-- Name: storefront_publish_revision storefront_publish_revision_published_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_publish_revision
    ADD CONSTRAINT storefront_publish_revision_published_by_staff_id_fkey FOREIGN KEY (published_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: suit_component_swap_events suit_component_swap_events_new_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_new_product_id_fkey FOREIGN KEY (new_product_id) REFERENCES public.products(id);

--
-- Name: suit_component_swap_events suit_component_swap_events_new_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_new_variant_id_fkey FOREIGN KEY (new_variant_id) REFERENCES public.product_variants(id);

--
-- Name: suit_component_swap_events suit_component_swap_events_old_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_old_product_id_fkey FOREIGN KEY (old_product_id) REFERENCES public.products(id);

--
-- Name: suit_component_swap_events suit_component_swap_events_old_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_old_variant_id_fkey FOREIGN KEY (old_variant_id) REFERENCES public.product_variants(id);

--
-- Name: suit_component_swap_events suit_component_swap_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

--
-- Name: suit_component_swap_events suit_component_swap_events_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.transaction_lines(id) ON DELETE CASCADE;

--
-- Name: suit_component_swap_events suit_component_swap_events_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suit_component_swap_events
    ADD CONSTRAINT suit_component_swap_events_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id);

--
-- Name: task_assignment task_assignment_assignee_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_assignee_staff_id_fkey FOREIGN KEY (assignee_staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: task_assignment task_assignment_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: task_assignment task_assignment_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.task_checklist_template(id) ON DELETE CASCADE;

--
-- Name: task_checklist_template task_checklist_template_created_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_checklist_template
    ADD CONSTRAINT task_checklist_template_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: task_checklist_template_item task_checklist_template_item_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_checklist_template_item
    ADD CONSTRAINT task_checklist_template_item_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.task_checklist_template(id) ON DELETE CASCADE;

--
-- Name: task_instance task_instance_assignee_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance
    ADD CONSTRAINT task_instance_assignee_staff_id_fkey FOREIGN KEY (assignee_staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: task_instance task_instance_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance
    ADD CONSTRAINT task_instance_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.task_assignment(id) ON DELETE SET NULL;

--
-- Name: task_instance task_instance_completed_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance
    ADD CONSTRAINT task_instance_completed_by_staff_id_fkey FOREIGN KEY (completed_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: task_instance task_instance_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance
    ADD CONSTRAINT task_instance_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: task_instance_item task_instance_item_done_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance_item
    ADD CONSTRAINT task_instance_item_done_by_staff_id_fkey FOREIGN KEY (done_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

--
-- Name: task_instance_item task_instance_item_task_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance_item
    ADD CONSTRAINT task_instance_item_task_instance_id_fkey FOREIGN KEY (task_instance_id) REFERENCES public.task_instance(id) ON DELETE CASCADE;

--
-- Name: task_instance_item task_instance_item_template_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_instance_item
    ADD CONSTRAINT task_instance_item_template_item_id_fkey FOREIGN KEY (template_item_id) REFERENCES public.task_checklist_template_item(id) ON DELETE SET NULL;

--
-- Name: transaction_lines transaction_lines_fulfillment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_lines
    ADD CONSTRAINT transaction_lines_fulfillment_order_id_fkey FOREIGN KEY (fulfillment_order_id) REFERENCES public.fulfillment_orders(id) ON DELETE SET NULL;

--
-- Name: vendor_brands vendor_brands_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_brands
    ADD CONSTRAINT vendor_brands_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: vendor_supplier_item vendor_supplier_item_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_supplier_item
    ADD CONSTRAINT vendor_supplier_item_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;

--
-- Name: vendor_supplier_item vendor_supplier_item_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_supplier_item
    ADD CONSTRAINT vendor_supplier_item_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: wedding_activity_log wedding_activity_log_wedding_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_activity_log
    ADD CONSTRAINT wedding_activity_log_wedding_member_id_fkey FOREIGN KEY (wedding_member_id) REFERENCES public.wedding_members(id) ON DELETE SET NULL;

--
-- Name: wedding_activity_log wedding_activity_log_wedding_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_activity_log
    ADD CONSTRAINT wedding_activity_log_wedding_party_id_fkey FOREIGN KEY (wedding_party_id) REFERENCES public.wedding_parties(id) ON DELETE CASCADE;

--
-- Name: wedding_appointments wedding_appointments_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_appointments
    ADD CONSTRAINT wedding_appointments_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

--
-- Name: wedding_appointments wedding_appointments_wedding_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_appointments
    ADD CONSTRAINT wedding_appointments_wedding_member_id_fkey FOREIGN KEY (wedding_member_id) REFERENCES public.wedding_members(id) ON DELETE CASCADE;

--
-- Name: wedding_appointments wedding_appointments_wedding_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_appointments
    ADD CONSTRAINT wedding_appointments_wedding_party_id_fkey FOREIGN KEY (wedding_party_id) REFERENCES public.wedding_parties(id) ON DELETE CASCADE;

--
-- Name: wedding_insight_saved_views wedding_insight_saved_views_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_insight_saved_views
    ADD CONSTRAINT wedding_insight_saved_views_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

--
-- Name: wedding_members wedding_members_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_members
    ADD CONSTRAINT wedding_members_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

--
-- Name: wedding_members wedding_members_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_members
    ADD CONSTRAINT wedding_members_order_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

--
-- Name: wedding_members wedding_members_suit_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_members
    ADD CONSTRAINT wedding_members_suit_variant_id_fkey FOREIGN KEY (suit_variant_id) REFERENCES public.product_variants(id);

--
-- Name: wedding_members wedding_members_wedding_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_members
    ADD CONSTRAINT wedding_members_wedding_party_id_fkey FOREIGN KEY (wedding_party_id) REFERENCES public.wedding_parties(id) ON DELETE CASCADE;

--
-- Name: wedding_non_inventory_items wedding_non_inventory_items_wedding_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_non_inventory_items
    ADD CONSTRAINT wedding_non_inventory_items_wedding_member_id_fkey FOREIGN KEY (wedding_member_id) REFERENCES public.wedding_members(id) ON DELETE SET NULL;

--
-- Name: wedding_non_inventory_items wedding_non_inventory_items_wedding_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_non_inventory_items
    ADD CONSTRAINT wedding_non_inventory_items_wedding_party_id_fkey FOREIGN KEY (wedding_party_id) REFERENCES public.wedding_parties(id) ON DELETE CASCADE;

--
-- Name: wedding_parties wedding_parties_suit_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wedding_parties
    ADD CONSTRAINT wedding_parties_suit_variant_id_fkey FOREIGN KEY (suit_variant_id) REFERENCES public.product_variants(id);


--
-- PostgreSQL database dump complete
--

--
-- Name: alterations_active; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.alterations_active AS
 SELECT ao.id AS alteration_id,
    ao.transaction_id AS order_id,
    COALESCE(t.display_id, t.short_id, "left"((ao.transaction_id)::text, 8)) AS order_short_id,
    ao.transaction_id,
    t.display_id AS transaction_display_id,
    ao.fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    ao.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    (ao.status)::text AS status,
    ao.due_at,
    ao.created_at,
    ao.updated_at,
        CASE
            WHEN (((ao.status)::text <> 'picked_up'::text) AND (ao.due_at < CURRENT_DATE)) THEN true
            ELSE false
        END AS is_overdue
   FROM (((public.alteration_orders ao
     LEFT JOIN public.transactions t ON ((t.id = ao.transaction_id)))
     LEFT JOIN public.fulfillment_orders fo ON ((fo.id = ao.fulfillment_order_id)))
     LEFT JOIN public.customers c ON ((c.id = ao.customer_id)))
  WHERE ((ao.status)::text <> 'picked_up'::text);

--
-- Name: transactions_core; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.transactions_core AS
 SELECT t.id AS transaction_id,
    t.display_id AS transaction_display_id,
    t.booked_at,
    ((t.booked_at AT TIME ZONE reporting.effective_store_timezone()))::date AS booked_business_date,
    rec.rec_at AS recognition_at,
    ((rec.rec_at AT TIME ZONE reporting.effective_store_timezone()))::date AS recognition_business_date,
    (t.status)::text AS status,
    t.total_price,
    t.amount_paid,
    t.balance_due,
    t.is_tax_exempt,
    t.tax_exempt_reason,
    t.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_name,
    c.email AS customer_email,
    c.phone AS customer_phone,
    op.full_name AS operator_name,
    sp.full_name AS primary_salesperson_name,
    t.created_at,
    t.fulfilled_at,
    (t.sale_channel)::text AS sale_channel,
    (t.fulfillment_method)::text AS fulfillment_method,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.company_name AS customer_company_name,
    op.full_name AS operator_display_name,
    sp.full_name AS primary_salesperson_display_name
   FROM ((((public.transactions t
     CROSS JOIN LATERAL ( SELECT reporting.order_recognition_at(t.id, (t.fulfillment_method)::text, (t.status)::text, t.fulfilled_at) AS rec_at) rec)
     LEFT JOIN public.customers c ON ((c.id = t.customer_id)))
     LEFT JOIN public.staff op ON ((op.id = t.operator_id)))
     LEFT JOIN public.staff sp ON ((sp.id = t.primary_salesperson_id)));

--
-- Name: daily_order_totals; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.daily_order_totals AS
 SELECT booked_business_date AS order_business_date,
    count(*) AS order_count,
    sum(total_price) AS gross_total,
    sum(amount_paid) AS amount_paid_total
   FROM reporting.transactions_core
  GROUP BY booked_business_date;

--
-- Name: daily_order_totals_fulfilled; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.daily_order_totals_fulfilled AS
 SELECT ((r.rec_at AT TIME ZONE reporting.effective_store_timezone()))::date AS business_date,
    count(*) AS fulfilled_order_count,
    sum(o.total_price) AS gross_total,
    sum(o.amount_paid) AS amount_paid_total
   FROM (public.transactions o
     CROSS JOIN LATERAL ( SELECT reporting.order_recognition_at(o.id, (o.fulfillment_method)::text, (o.status)::text, o.fulfilled_at) AS rec_at) r)
  WHERE (((o.status)::text <> 'cancelled'::text) AND (r.rec_at IS NOT NULL))
  GROUP BY (((r.rec_at AT TIME ZONE reporting.effective_store_timezone()))::date);

--
-- Name: daily_order_totals_recognized; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.daily_order_totals_recognized AS
 SELECT recognition_business_date AS order_recognition_business_date,
    count(*) AS completed_order_count,
    sum(total_price) AS gross_total,
    sum(amount_paid) AS amount_paid_total
   FROM reporting.transactions_core
  WHERE ((status <> 'cancelled'::text) AND (recognition_at IS NOT NULL))
  GROUP BY recognition_business_date;

--
-- Name: fulfillment_orders_core; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.fulfillment_orders_core AS
 SELECT fo.id AS fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    fo.created_at,
    fo.status AS fulfillment_status,
    fo.customer_id,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_name,
    wp.party_name AS wedding_party_name,
    fo.fulfilled_at,
    fo.notes,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email
   FROM ((public.fulfillment_orders fo
     LEFT JOIN public.customers c ON ((c.id = fo.customer_id)))
     LEFT JOIN public.wedding_parties wp ON ((wp.id = fo.wedding_id)));

--
-- Name: layaway_snapshot; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.layaway_snapshot AS
SELECT
    NULL::uuid AS order_id,
    NULL::text AS order_short_id,
    NULL::text AS customer_code,
    NULL::text AS customer_name,
    NULL::character varying(64) AS customer_phone,
    NULL::timestamp with time zone AS booked_at,
    NULL::numeric(12,2) AS total_price,
    NULL::numeric(12,2) AS amount_paid,
    NULL::numeric(12,2) AS balance_due,
    NULL::text AS order_status,
    NULL::text AS layaway_status,
    NULL::bigint AS layaway_item_count;

--
-- Name: loyalty_customer_snapshot; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.loyalty_customer_snapshot AS
 SELECT c.id AS customer_id,
    c.customer_code,
    c.first_name,
    c.last_name,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone,
    c.email,
    c.loyalty_points AS current_balance,
    COALESCE(sum(lpl.delta_points) FILTER (WHERE ((lpl.delta_points > 0) AND (lpl.reason = 'order_earn'::text))), (0)::bigint) AS lifetime_earned_from_orders,
    (COALESCE(sum(lpl.delta_points) FILTER (WHERE ((lpl.delta_points < 0) AND (lpl.reason = 'reward_redemption'::text))), (0)::bigint) * '-1'::integer) AS lifetime_points_redeemed,
    COALESCE(sum(lpl.delta_points) FILTER (WHERE (lpl.reason = 'manual_adjust'::text)), (0)::bigint) AS net_manual_adjustments,
    COALESCE(count(lri.id), (0)::bigint) AS rewards_issued_count,
    COALESCE(sum(lri.reward_amount), (0)::numeric) AS total_reward_dollars_issued
   FROM ((public.customers c
     LEFT JOIN public.loyalty_point_ledger lpl ON ((c.id = lpl.customer_id)))
     LEFT JOIN public.loyalty_reward_issuances lri ON ((c.id = lri.customer_id)))
  GROUP BY c.id, c.customer_code, c.first_name, c.last_name, c.phone, c.email, c.loyalty_points;

--
-- Name: loyalty_daily_velocity; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.loyalty_daily_velocity AS
 WITH daily_earn AS (
         SELECT ((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date AS event_date,
            sum(loyalty_point_ledger.delta_points) AS points_earned
           FROM public.loyalty_point_ledger
          WHERE (loyalty_point_ledger.delta_points > 0)
          GROUP BY (((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date)
        ), daily_burn AS (
         SELECT ((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date AS event_date,
            (sum(loyalty_point_ledger.delta_points) * '-1'::integer) AS points_burned
           FROM public.loyalty_point_ledger
          WHERE (loyalty_point_ledger.delta_points < 0)
          GROUP BY (((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date)
        ), all_dates AS (
         SELECT daily_earn.event_date
           FROM daily_earn
        UNION
         SELECT daily_burn.event_date
           FROM daily_burn
        )
 SELECT ad.event_date,
    COALESCE(de.points_earned, (0)::bigint) AS points_earned,
    COALESCE(db.points_burned, (0)::bigint) AS points_burned,
    (COALESCE(de.points_earned, (0)::bigint) - COALESCE(db.points_burned, (0)::bigint)) AS net_velocity
   FROM ((all_dates ad
     LEFT JOIN daily_earn de ON ((ad.event_date = de.event_date)))
     LEFT JOIN daily_burn db ON ((ad.event_date = db.event_date)))
  ORDER BY ad.event_date DESC;

--
-- Name: loyalty_point_ledger; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.loyalty_point_ledger AS
 SELECT l.id,
    l.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    l.delta_points,
    l.balance_after,
    l.reason,
    l.transaction_id AS order_id,
    l.transaction_id,
    t.display_id AS transaction_display_id,
    l.created_by_staff_id,
    s.full_name AS created_by_staff_name,
    l.metadata,
    l.created_at
   FROM (((public.loyalty_point_ledger l
     JOIN public.customers c ON ((c.id = l.customer_id)))
     LEFT JOIN public.transactions t ON ((t.id = l.transaction_id)))
     LEFT JOIN public.staff s ON ((s.id = l.created_by_staff_id)));

--
-- Name: loyalty_reward_issuances; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.loyalty_reward_issuances AS
 SELECT lri.id,
    lri.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    lri.points_deducted,
    lri.reward_amount,
    lri.applied_to_sale,
    lri.remainder_card_id,
    lri.transaction_id AS order_id,
    lri.transaction_id,
    t.display_id AS transaction_display_id,
    lri.issued_by_staff_id,
    s.full_name AS issued_by_staff_name,
    lri.created_at
   FROM (((public.loyalty_reward_issuances lri
     JOIN public.customers c ON ((c.id = lri.customer_id)))
     LEFT JOIN public.transactions t ON ((t.id = lri.transaction_id)))
     LEFT JOIN public.staff s ON ((s.id = lri.issued_by_staff_id)));

--
-- Name: merchant_reconciliation; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.merchant_reconciliation AS
 SELECT ((created_at AT TIME ZONE reporting.effective_store_timezone()))::date AS business_date,
    payment_provider,
    payment_method,
    count(id) AS transaction_count,
    sum(amount) AS gross_amount,
    sum(merchant_fee) AS total_merchant_fee,
    sum(net_amount) AS net_amount,
    (0)::numeric AS avg_basis_points
   FROM public.payment_transactions pt
  WHERE (payment_provider IS NOT NULL)
  GROUP BY (((created_at AT TIME ZONE reporting.effective_store_timezone()))::date), payment_provider, payment_method
  ORDER BY (((created_at AT TIME ZONE reporting.effective_store_timezone()))::date) DESC, payment_provider, payment_method;

--
-- Name: order_lines; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.order_lines AS
 SELECT tl.id AS line_id,
    tl.line_display_id,
    tl.transaction_id,
    t.transaction_display_id,
    tl.transaction_id AS order_id,
    t.transaction_display_id AS order_short_id,
    t.booked_at AS order_booked_at,
    t.booked_business_date AS order_business_date,
    t.recognition_at AS order_recognition_at,
    t.recognition_business_date AS order_recognition_business_date,
    t.status AS order_status,
    tl.quantity,
    tl.unit_price,
    (tl.unit_price * (tl.quantity)::numeric) AS line_extended_price,
    tl.unit_cost,
    (tl.unit_cost * (tl.quantity)::numeric) AS line_extended_cost,
    ((tl.unit_price * (tl.quantity)::numeric) - (tl.unit_cost * (tl.quantity)::numeric)) AS line_gross_margin_pre_tax,
    (tl.fulfillment)::text AS fulfillment,
    tl.is_fulfilled,
    tl.fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    tl.product_id,
    tl.variant_id,
    p.name AS product_name,
    p.name AS product_display_name,
    pv.variation_label AS variant_display_name,
        CASE
            WHEN (NULLIF(btrim(pv.variation_label), ''::text) IS NULL) THEN p.name
            ELSE concat_ws(' - '::text, p.name, pv.variation_label)
        END AS item_display_name,
    pv.sku,
    pv.barcode,
    c.name AS category_name,
    v.name AS vendor_display_name,
    t.customer_id,
    t.customer_display_name,
    t.customer_phone,
    t.customer_email,
    tls.full_name AS line_salesperson_display_name,
    t.primary_salesperson_display_name,
    t.operator_display_name
   FROM (((((((public.transaction_lines tl
     JOIN reporting.transactions_core t ON ((t.transaction_id = tl.transaction_id)))
     LEFT JOIN public.fulfillment_orders fo ON ((fo.id = tl.fulfillment_order_id)))
     LEFT JOIN public.products p ON ((p.id = tl.product_id)))
     LEFT JOIN public.product_variants pv ON ((pv.id = tl.variant_id)))
     LEFT JOIN public.categories c ON ((c.id = p.category_id)))
     LEFT JOIN public.vendors v ON ((v.id = p.primary_vendor_id)))
     LEFT JOIN public.staff tls ON ((tls.id = tl.salesperson_id)));

--
-- Name: order_loyalty_accrual; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.order_loyalty_accrual AS
 SELECT ola.transaction_id AS order_id,
    ola.transaction_id,
    t.display_id AS transaction_display_id,
    ola.points_earned,
    ola.product_subtotal,
    ola.created_at AS accrual_recorded_at,
    t.booked_at AS order_booked_at,
    ((t.booked_at AT TIME ZONE reporting.effective_store_timezone()))::date AS order_business_date,
    (t.status)::text AS order_status,
    t.total_price,
    t.amount_paid,
    t.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state
   FROM ((public.transaction_loyalty_accrual ola
     JOIN public.transactions t ON ((t.id = ola.transaction_id)))
     LEFT JOIN public.customers c ON ((c.id = t.customer_id)));

--
-- Name: orders_core; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.orders_core AS
 SELECT transaction_id,
    transaction_display_id,
    booked_at,
    booked_business_date,
    recognition_at,
    recognition_business_date,
    status,
    total_price,
    amount_paid,
    balance_due,
    is_tax_exempt,
    tax_exempt_reason,
    customer_id,
    customer_code,
    customer_name,
    customer_email,
    customer_phone,
    operator_name,
    primary_salesperson_name,
    created_at,
    fulfilled_at,
    sale_channel,
    fulfillment_method,
    customer_display_name,
    customer_company_name,
    operator_display_name,
    primary_salesperson_display_name
   FROM reporting.transactions_core;

--
-- Name: orders_v1; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.orders_v1 AS
 SELECT transaction_id,
    transaction_display_id,
    booked_at,
    booked_business_date,
    recognition_at,
    recognition_business_date,
    status,
    total_price,
    amount_paid,
    balance_due,
    is_tax_exempt,
    tax_exempt_reason,
    customer_id,
    customer_code,
    customer_name,
    customer_email,
    customer_phone,
    operator_name,
    primary_salesperson_name,
    created_at,
    fulfilled_at,
    sale_channel,
    fulfillment_method,
    customer_display_name,
    customer_company_name,
    operator_display_name,
    primary_salesperson_display_name
   FROM reporting.transactions_core;

--
-- Name: payment_ledger; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.payment_ledger AS
 WITH allocation_rollup AS (
         SELECT pa.transaction_id AS payment_transaction_id,
            count(DISTINCT pa.target_transaction_id) AS linked_transaction_count,
            min((pa.target_transaction_id)::text) FILTER (WHERE (pa.target_transaction_id IS NOT NULL)) AS primary_transaction_id_text,
            min(tc.transaction_display_id) FILTER (WHERE (tc.transaction_display_id IS NOT NULL)) AS primary_transaction_display_id,
            string_agg(DISTINCT tc.transaction_display_id, ', '::text ORDER BY tc.transaction_display_id) FILTER (WHERE (tc.transaction_display_id IS NOT NULL)) AS linked_transaction_display_ids,
            string_agg(DISTINCT COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown'::text), ', '::text ORDER BY COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown'::text)) FILTER (WHERE (tc.transaction_id IS NOT NULL)) AS linked_customer_names
           FROM (public.payment_allocations pa
             LEFT JOIN reporting.transactions_core tc ON ((tc.transaction_id = pa.target_transaction_id)))
          GROUP BY pa.transaction_id
        )
 SELECT pt.id,
    pt.id AS payment_transaction_id,
    pt.created_at,
    pt.occurred_at,
    ((pt.created_at AT TIME ZONE reporting.effective_store_timezone()))::date AS business_date,
    (pt.category)::text AS category,
    pt.status,
    pt.payment_method,
    pt.check_number,
    pt.payment_provider,
    pt.provider_payment_id,
    pt.provider_status,
    pt.provider_terminal_id,
    pt.provider_transaction_id,
    pt.provider_auth_code,
    pt.provider_card_type,
    pt.amount AS gross_amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.card_brand,
    pt.card_last4,
    pt.payer_id,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS payer_name,
    c.customer_code AS payer_code,
    c.phone AS payer_phone,
    c.email AS payer_email,
    (NULLIF(ar.primary_transaction_id_text, ''::text))::uuid AS linked_transaction_id,
    ar.linked_transaction_count,
    ar.primary_transaction_display_id,
    ar.linked_transaction_display_ids,
    ar.linked_customer_names
   FROM ((public.payment_transactions pt
     LEFT JOIN public.customers c ON ((c.id = pt.payer_id)))
     LEFT JOIN allocation_rollup ar ON ((ar.payment_transaction_id = pt.id)));

--
-- Name: shipments_active; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.shipments_active AS
 SELECT s.id AS shipment_id,
    (s.source)::text AS source,
    (s.status)::text AS status,
    COALESCE(t.display_id, "left"((s.transaction_id)::text, 8)) AS order_short_id,
    s.transaction_id AS order_id,
    s.transaction_id,
    t.display_id AS transaction_display_id,
    s.fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    s.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_name,
    c.phone AS customer_phone,
    s.tracking_number,
    s.carrier,
    s.service_name,
    s.shipping_charged_usd,
    s.quoted_amount_usd,
    s.label_cost_usd,
    s.created_at,
    s.updated_at
   FROM (((public.shipment s
     LEFT JOIN public.transactions t ON ((t.id = s.transaction_id)))
     LEFT JOIN public.fulfillment_orders fo ON ((fo.id = s.fulfillment_order_id)))
     LEFT JOIN public.customers c ON ((c.id = s.customer_id)))
  ORDER BY s.created_at DESC;

--
-- Name: transaction_fulfillment_status; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.transaction_fulfillment_status AS
 SELECT id AS transaction_id,
    display_id AS transaction_display_id,
        CASE
            WHEN (NOT (EXISTS ( SELECT 1
               FROM public.transaction_lines
              WHERE ((transaction_lines.transaction_id = t.id) AND (transaction_lines.fulfilled_at IS NULL))))) THEN 'fulfilled'::text
            WHEN (NOT (EXISTS ( SELECT 1
               FROM public.transaction_lines
              WHERE ((transaction_lines.transaction_id = t.id) AND (transaction_lines.fulfilled_at IS NOT NULL))))) THEN 'open'::text
            ELSE 'partially_fulfilled'::text
        END AS fulfillment_status
   FROM public.transactions t;

--
-- Name: wedding_party_economics; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.wedding_party_economics AS
 SELECT wp.id AS wedding_party_id,
    wp.party_name AS wedding_party_name,
    wp.event_date,
    wp.groom_name,
    wp.bride_name,
    wp.salesperson AS wedding_salesperson_name,
    count(DISTINCT wm.id) AS member_count,
    count(DISTINCT o.id) AS order_count,
    sum(((oi.quantity)::numeric * oi.unit_price)) AS total_revenue,
    sum(((oi.quantity)::numeric * oi.unit_cost)) AS total_cost,
    sum(((oi.quantity)::numeric * (oi.unit_price - oi.unit_cost))) AS total_profit,
    sum(
        CASE
            WHEN wm.is_free_suit_promo THEN 1
            ELSE 0
        END) AS free_suits_marked,
        CASE
            WHEN (sum(((oi.quantity)::numeric * oi.unit_price)) > (0)::numeric) THEN ((sum(((oi.quantity)::numeric * (oi.unit_price - oi.unit_cost))) / sum(((oi.quantity)::numeric * oi.unit_price))) * (100)::numeric)
            ELSE (0)::numeric
        END AS margin_percent
   FROM (((public.wedding_parties wp
     LEFT JOIN public.wedding_members wm ON ((wm.wedding_party_id = wp.id)))
     LEFT JOIN public.transactions o ON (((o.wedding_member_id = wm.id) AND (o.status <> 'cancelled'::public.order_status))))
     LEFT JOIN public.transaction_lines oi ON ((oi.transaction_id = o.id)))
  GROUP BY wp.id, wp.party_name, wp.event_date, wp.groom_name, wp.bride_name, wp.salesperson;

--
-- Name: layaway_snapshot _RETURN; Type: RULE; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.layaway_snapshot AS
 SELECT o.id AS order_id,
    "left"((o.id)::text, 8) AS order_short_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_name,
    c.phone AS customer_phone,
    o.booked_at,
    o.total_price,
    o.amount_paid,
    o.balance_due,
    (o.status)::text AS order_status,
        CASE
            WHEN o.is_forfeited THEN 'Forfeited'::text
            WHEN (o.status = 'fulfilled'::public.order_status) THEN 'Picked Up'::text
            WHEN (o.status = 'cancelled'::public.order_status) THEN 'Cancelled'::text
            WHEN (o.balance_due <= (0)::numeric) THEN 'Paid - Wait Collection'::text
            ELSE 'Active'::text
        END AS layaway_status,
    count(oi.id) AS layaway_item_count
   FROM ((public.transactions o
     JOIN public.transaction_lines oi ON ((oi.transaction_id = o.id)))
     LEFT JOIN public.customers c ON ((c.id = o.customer_id)))
  WHERE (oi.fulfillment = 'layaway'::public.fulfillment_type)
  GROUP BY o.id, c.id, c.customer_code, c.first_name, c.last_name, c.phone;
