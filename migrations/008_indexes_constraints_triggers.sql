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

-- 008 Indexes And Triggers

--
-- Name: SCHEMA reporting; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA reporting IS 'Read-only analytics views for Metabase (Phase 2). Application DML stays on public.*; Metabase should use role metabase_ro.';

--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';

--
-- Name: FUNCTION staff_effective_working_day(p_staff_id uuid, p_d date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.staff_effective_working_day(p_staff_id uuid, p_d date) IS 'True if the staff member counts as working on calendar date p_d: always true for non floor roles; for salesperson/sales_support, staff_day_exception wins (sick/pto/missed_shift = off, extra_shift = on); else staff_weekly_availability for EXTRACT(DOW FROM p_d); if no row, default is Sunday off.';

--
-- Name: FUNCTION effective_store_timezone(); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.effective_store_timezone() IS 'IANA timezone from store_settings.receipt_config (Receipt settings). SECURITY DEFINER for reporting views.';

--
-- Name: FUNCTION order_recognition_at(p_order_id uuid, p_fulfillment_method text, p_status text, p_fulfilled_at timestamp with time zone); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.order_recognition_at(p_order_id uuid, p_fulfillment_method text, p_status text, p_fulfilled_at timestamp with time zone) IS 'Completed-revenue clock: pickup mode uses fulfilled_at; ship mode uses shipment events (label purchased or manual in_transit/delivered). Pair with order status and line fulfillment for commission rules.';

--
-- Name: TABLE app_notification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.app_notification IS 'Canonical notification payload; fan-out to staff_notification per recipient.';

--
-- Name: COLUMN app_notification.dedupe_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_notification.dedupe_key IS 'Optional unique key to suppress duplicate generator emissions.';

--
-- Name: COLUMN categories.matrix_row_axis_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.matrix_row_axis_key IS 'JSON key for matrix rows (e.g. Neck, Waist, Chest)';

--
-- Name: COLUMN categories.matrix_col_axis_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.matrix_col_axis_key IS 'JSON key for matrix columns (e.g. Sleeve, Inseam, Length)';

--
-- Name: COLUMN categories.variation_axis_presets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.variation_axis_presets IS 'Ordered category default variation axis names for manual product creation, max 3 visible presets.';

--
-- Name: TABLE category_commission_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.category_commission_overrides IS 'Global retail commission rate override by category (Odoo-style); else staff.base_commission_rate.';

--
-- Name: TABLE corecard_posting_event; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.corecard_posting_event IS 'Append-style CoreCard host posting lifecycle log. Stores only redacted request/response snapshots and masked/minimal host references.';

--
-- Name: COLUMN corecard_posting_event.operation_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.corecard_posting_event.operation_type IS 'purchase, payment, refund, or reversal.';

--
-- Name: TABLE corecredit_event_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.corecredit_event_log IS 'Immutable inbound CoreCard webhook event log with redacted payload snapshots and idempotent processing markers.';

--
-- Name: TABLE helcim_event_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.helcim_event_log IS 'Durable inbound Helcim webhook event log with redacted payload snapshots, replay protection, and processing markers.';

--
-- Name: COLUMN helcim_event_log.match_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.helcim_event_log.match_type IS 'How the event was attached to local payment state: provider_transaction_id, terminal_amount, terminal, or none.';

--
-- Name: TABLE payment_provider_batches; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_provider_batches IS 'Provider-neutral processor batch headers used for Helcim settlement reconciliation and expected deposit analysis.';

--
-- Name: TABLE payment_provider_batch_transactions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_provider_batch_transactions IS 'Provider transaction membership inside processor batches, linked back to local payment_transactions when matched.';

--
-- Name: TABLE payment_settlement_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_settlement_runs IS 'Durable payment-provider settlement and reconciliation sync run history.';

--
-- Name: TABLE payment_settlement_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_settlement_items IS 'Open and historical settlement reconciliation findings for missing or mismatched provider payment activity.';

--
-- Name: TABLE payment_settlement_item_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_settlement_item_events IS 'Append-only audit history for staff review, notes, resolution, reopen, and manual payment-link actions on settlement reconciliation findings.';

--
-- Name: TABLE corecredit_exception_queue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.corecredit_exception_queue IS 'Operational exception queue for failed postings, webhook issues, stale account states, and reconciliation mismatches.';

--
-- Name: TABLE customer_corecredit_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_corecredit_accounts IS 'Authoritative Riverside-to-CoreCredit/CoreCard account links. No PAN/CVV or browser secrets are stored.';

--
-- Name: COLUMN customer_corecredit_accounts.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_corecredit_accounts.status IS 'Linked account lifecycle for RMS Charge resolution (active, inactive, restricted, suspended, closed, etc.).';

--
-- Name: COLUMN customer_corecredit_accounts.available_credit_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_corecredit_accounts.available_credit_snapshot IS 'Latest masked/minimal balance snapshot from CoreCard repair polling or webhook ingestion.';

--
-- Name: TABLE customer_duplicate_review_queue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_duplicate_review_queue IS 'Staff duplicate review queue (Pillar 5b); merge executes via existing /api/customers/merge.';

--
-- Name: TABLE customer_online_credential; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_online_credential IS 'Argon2 password for public /shop sign-in; one row per customer who activated online access.';

--
-- Name: TABLE customer_open_deposit_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_open_deposit_accounts IS 'Prepaid deposits held for a customer (e.g. wedding party split) redeemable on checkout via payment_method open_deposit.';

--
-- Name: TABLE customer_timeline_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_timeline_notes IS 'Manual CRM notes surfaced on customer timeline.';

--
-- Name: COLUMN customers.marketing_email_opt_in; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.marketing_email_opt_in IS 'Promotional email only; transactional email (receipts, appointments) unaffected.';

--
-- Name: COLUMN customers.marketing_sms_opt_in; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.marketing_sms_opt_in IS 'Promotional SMS only; transactional SMS (pickup, appts) unaffected.';

--
-- Name: COLUMN customers.is_vip; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.is_vip IS 'Staff-marked VIP for Relationship Hub header.';

--
-- Name: COLUMN customers.customer_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.customer_code IS 'Stable store-facing id; matches Lightspeed customer_code when imported; auto-assigned for new ROS customers.';

--
-- Name: COLUMN customers.company_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.company_name IS 'Organization name when different from person name.';

--
-- Name: COLUMN customers.anniversary_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.anniversary_date IS 'Wedding or anniversary date for CRM.';

--
-- Name: COLUMN customers.custom_field_1; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.custom_field_1 IS 'Imported from Lightspeed custom_field_1; general-purpose.';

--
-- Name: COLUMN customers.custom_field_2; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.custom_field_2 IS 'Imported from Lightspeed custom_field_2; general-purpose.';

--
-- Name: COLUMN customers.custom_field_3; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.custom_field_3 IS 'Imported from Lightspeed custom_field_3; general-purpose.';

--
-- Name: COLUMN customers.custom_field_4; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.custom_field_4 IS 'Imported from Lightspeed custom_field_4; general-purpose.';

--
-- Name: COLUMN customers.transactional_sms_opt_in; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.transactional_sms_opt_in IS 'Consent for operational SMS (pickup/alteration ready, etc.); OR with marketing_sms_opt_in in messaging gate.';

--
-- Name: COLUMN customers.transactional_email_opt_in; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.transactional_email_opt_in IS 'Consent for transactional email (pickup, alterations, appointments, loyalty notices) via Podium; combined with marketing_email_opt_in in messaging rules.';

--
-- Name: COLUMN customers.podium_conversation_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.podium_conversation_url IS 'Optional staff-pasted link to Podium conversation (until API thread sync).';

--
-- Name: COLUMN customers.customer_created_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.customer_created_source IS 'store = staff/POS/import default; online_store = first created via public /shop account registration.';

--
-- Name: COLUMN customers.podium_name_capture_pending; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.podium_name_capture_pending IS 'True after unknown-sender welcome SMS until first+last captured from reply.';

--
-- Name: COLUMN customers.profile_discount_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.profile_discount_percent IS 'Customer profile blanket POS discount percentage for regular-priced items.';

--
-- Name: COLUMN customers.tax_exempt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.tax_exempt IS 'When true, POS checkout starts tax-exempt for this customer profile.';

--
-- Name: COLUMN customers.tax_exempt_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.tax_exempt_id IS 'Tax exemption certificate or tax ID recorded on the customer profile.';

--
-- Name: TABLE discount_event_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.discount_event_usage IS 'One row per order line that applied a scheduled discount event at checkout.';

--
-- Name: TABLE discount_event_variants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.discount_event_variants IS 'Variants eligible for a discount event.';

--
-- Name: TABLE discount_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.discount_events IS 'Time-boxed automatic discount; POS/checkout references event id per line when price matches event percent.';

--
-- Name: TABLE gift_cards; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.gift_cards IS 'Preprinted physical gift cards. Purchased cards carry liability (is_liability=true); loyalty/donated carry no liability until redeemed.';

--
-- Name: COLUMN gift_cards.is_liability; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gift_cards.is_liability IS 'True for purchased cards (liability at issue). False for loyalty_reward/donated_giveaway (expensed at redemption).';

--
-- Name: TABLE help_manual_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.help_manual_policy IS 'Help Center manual policy: overrides and visibility. NULL permission array = use server default for manual id.';

--
-- Name: TABLE integration_alert_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.integration_alert_state IS 'Last success/failure per background integration (QBO token refresh, weather finalize) for admin notifications.';

--
-- Name: TABLE inventory_count_scan_stream; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.inventory_count_scan_stream IS 'Raw real-time scan events for collaborative counting sessions.';

--
-- Name: TABLE inventory_locations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.inventory_locations IS 'Specific zones defined on the floorplan for product mapping.';

--
-- Name: TABLE inventory_map_layouts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.inventory_map_layouts IS 'Defines the visual floorplan (SVG/JSON) for the store.';

--
-- Name: COLUMN inventory_transactions.created_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory_transactions.created_by IS 'The staff member who performed the inventory adjustment or movement.';

--
-- Name: TABLE morning_digest_ledger; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.morning_digest_ledger IS 'Prevents duplicate admin morning digest runs for the same store-local calendar day (timezone from receipt_config).';

--
-- Name: TABLE ops_action_audit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ops_action_audit IS 'Immutable guarded-action audit trail for ROS Dev Center.';

--
-- Name: TABLE ops_alert_event; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ops_alert_event IS 'Operational alerts with dedupe + ack/resolution lifecycle for ROS Dev Center.';

--
-- Name: TABLE ops_bug_incident_link; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ops_bug_incident_link IS 'Links existing ROS bug reports to Dev Center operational incidents.';

--
-- Name: TABLE ops_notification_delivery_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ops_notification_delivery_log IS 'Delivery attempts for Dev Center alert channels (inbox/email/sms).';

--
-- Name: TABLE ops_station_heartbeat; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ops_station_heartbeat IS 'Per-register heartbeat telemetry for ROS Dev Center fleet monitoring.';

--
-- Name: COLUMN payment_allocations.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_allocations.metadata IS 'Allocation-level ledger metadata (e.g., applied_deposit_amount for liability release).';

--
-- Name: COLUMN payment_allocations.check_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_allocations.check_number IS 'Recorded check number for physical check tenders (copied from transaction).';

--
-- Name: TABLE payment_provider_attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_provider_attempts IS 'Provider-neutral terminal/payment attempt audit table. Attempts track pending/approved/canceled provider control flow and are not payment ledger rows.';

--
-- Name: COLUMN payment_provider_attempts.provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_provider_attempts.provider IS 'Payment provider key for the processor adapter.';

--
-- Name: COLUMN payment_provider_attempts.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_provider_attempts.status IS 'Attempt lifecycle: pending, approved, captured, canceled, failed, or expired.';

--
-- Name: COLUMN payment_provider_attempts.amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_provider_attempts.amount_cents IS 'Requested attempt amount in minor currency units.';

--
-- Name: COLUMN payment_provider_attempts.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_provider_attempts.idempotency_key IS 'Client/server replay guard scoped uniquely per provider.';

--
-- Name: COLUMN payment_provider_attempts.raw_audit_reference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_provider_attempts.raw_audit_reference IS 'Redacted external audit/log reference only; do not store raw cardholder data or full provider payloads here.';

--
-- Name: COLUMN payment_provider_attempts.provider_client_secret; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_provider_attempts.provider_client_secret IS 'Short-lived hosted payment validation secret kept server-side only; never return to clients or logs.';

--
-- Name: COLUMN payment_transactions.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.metadata IS 'POS/QBO ledger metadata signals (gift card subtype, deposit release hints, etc.).';

--
-- Name: COLUMN payment_transactions.check_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.check_number IS 'Recorded check number for physical check tenders.';

--
-- Name: COLUMN payment_transactions.payment_provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.payment_provider IS 'Nullable provider identifier for processor-backed tenders.';

--
-- Name: COLUMN payment_transactions.provider_payment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.provider_payment_id IS 'Provider-neutral payment reference.';

--
-- Name: COLUMN payment_transactions.provider_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.provider_status IS 'Provider-neutral processor status captured at tender recording time.';

--
-- Name: COLUMN payment_transactions.provider_terminal_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.provider_terminal_id IS 'Provider-neutral reader, device, or terminal identifier when available.';

--
-- Name: COLUMN payment_transactions.provider_transaction_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.provider_transaction_id IS 'Provider transaction identifier when different from the primary payment id.';

--
-- Name: COLUMN payment_transactions.provider_auth_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.provider_auth_code IS 'Provider authorization code when supplied by the processor.';

--
-- Name: COLUMN payment_transactions.provider_card_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_transactions.provider_card_type IS 'Provider card type such as credit or debit when supplied by the processor.';

--
-- Name: TABLE physical_inventory_audit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.physical_inventory_audit IS 'Full event audit trail for every scan, adjustment, and lifecycle event within a session.';

--
-- Name: TABLE physical_inventory_counts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.physical_inventory_counts IS 'Running count log per (session, variant). Scans increment counted_qty. adjusted_qty overrides at publish.';

--
-- Name: COLUMN physical_inventory_counts.adjusted_qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_inventory_counts.adjusted_qty IS 'Staff override set during the Review phase. NULL means counted_qty is used at publish.';

--
-- Name: TABLE physical_inventory_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.physical_inventory_sessions IS 'Physical inventory counting sessions. Only one open/reviewing session may exist at a time.';

--
-- Name: COLUMN physical_inventory_sessions.exclude_reserved; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_inventory_sessions.exclude_reserved IS 'If true, inventory counts on floor should match (stock_on_hand - reserved_stock).';

--
-- Name: COLUMN physical_inventory_sessions.exclude_layaway; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_inventory_sessions.exclude_layaway IS 'If true, inventory counts on floor should match (stock_on_hand - on_layaway).';

--
-- Name: TABLE podium_conversation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.podium_conversation IS 'Per-customer Podium thread (SMS or email); links CRM to inbound/outbound messages.';

--
-- Name: TABLE podium_message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.podium_message IS 'Podium SMS/email message line; inbound from webhook, outbound from staff reply or automations.';

--
-- Name: COLUMN podium_message.podium_sender_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.podium_message.podium_sender_name IS 'Sender display name from Podium (webhook or future API sync). When set with direction outbound, use instead of ROS staff.';

--
-- Name: TABLE podium_webhook_delivery; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.podium_webhook_delivery IS 'Inbound Podium webhook deliveries; idempotency_key prevents duplicate processing on retries.';

--
-- Name: TABLE pos_parked_sale; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pos_parked_sale IS 'Register parked cart snapshots; scoped to open register_session_id.';

--
-- Name: TABLE pos_parked_sale_audit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pos_parked_sale_audit IS 'Append-style audit for park / recall / delete; register_session_id retained if parked row is removed.';

--
-- Name: TABLE pos_rms_charge_record; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pos_rms_charge_record IS 'RMS and RMS90 tender lines for R2S charge workflow and insights reporting.';

--
-- Name: COLUMN pos_rms_charge_record.record_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pos_rms_charge_record.record_kind IS 'charge = sale tender on_account_rms / on_account_rms90; payment = cash/check R2S payment collection.';

--
-- Name: COLUMN pos_rms_charge_record.tender_family; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pos_rms_charge_record.tender_family IS 'Normalized tender family for financing flows. Charge rows use rms_charge; legacy payment collections may remain NULL.';

--
-- Name: COLUMN pos_rms_charge_record.metadata_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pos_rms_charge_record.metadata_json IS 'Redacted financing metadata captured at checkout for receipts, audit, and future CoreCard posting workflows.';

--
-- Name: COLUMN pos_rms_charge_record.posting_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pos_rms_charge_record.posting_status IS 'Live CoreCard host lifecycle for RMS Charge rows: legacy, pending, posted, failed, reversed, refunded.';

--
-- Name: COLUMN pos_rms_charge_record.host_metadata_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pos_rms_charge_record.host_metadata_json IS 'Redacted host reference/status metadata suitable for UI, receipt rendering, and QBO-safe audit review.';

--
-- Name: TABLE product_catalog_audit_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.product_catalog_audit_log IS 'Append-only audit trail for manual and ROSIE-assisted catalog normalization changes.';

--
-- Name: COLUMN product_variants.shelf_labeled_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.shelf_labeled_at IS 'When the shelf/thermal label was last marked printed; NULL on new rows until labeled.';

--
-- Name: COLUMN product_variants.barcode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.barcode IS 'POS scan code (UPC/EAN); resolve alongside SKU and product name.';

--
-- Name: COLUMN product_variants.reserved_stock; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.reserved_stock IS 'Units physically in store but promised to an open special or custom order.
     available_on_hand = stock_on_hand - reserved_stock.';

--
-- Name: COLUMN product_variants.track_low_stock; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.track_low_stock IS 'When true with products.track_low_stock, variant is eligible for low-stock alerts when at/below reorder_point.';

--
-- Name: COLUMN product_variants.web_published; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.web_published IS 'When true, variant eligible for public storefront (requires product catalog_handle and active template).';

--
-- Name: COLUMN product_variants.web_price_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.web_price_override IS 'Optional web-only unit price; falls back to COALESCE(retail_price_override, base_retail_price).';

--
-- Name: COLUMN product_variants.web_gallery_order; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.web_gallery_order IS 'Sort order for variant images on PDP (ascending).';

--
-- Name: COLUMN product_variants.counterpoint_prc_2; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.counterpoint_prc_2 IS 'Counterpoint IM_PRC.PRC_2 when synced (optional retail tier reference). Independent of ROS employee sale pricing (cost-plus).';

--
-- Name: COLUMN product_variants.counterpoint_prc_3; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_variants.counterpoint_prc_3 IS 'Counterpoint IM_PRC.PRC_3 when synced (optional retail tier reference).';

--
-- Name: COLUMN products.excludes_from_loyalty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.excludes_from_loyalty IS 'When true, order lines for this product do NOT earn loyalty points (gift card SKUs, fees).';

--
-- Name: COLUMN products.track_low_stock; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.track_low_stock IS 'When true, template may participate in low-stock notifications; effective only if variant.track_low_stock is also true.';

--
-- Name: COLUMN products.pos_line_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.pos_line_kind IS 'POS-only line semantics. rms_charge_payment = R2S payment collection; pos_gift_card_load = purchased card value; alteration_service = register alteration work-order service line.';

--
-- Name: COLUMN products.data_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.data_source IS 'NULL = created in ROS; ''counterpoint'' = imported from Counterpoint; ''csv'' = bulk CSV import.';

--
-- Name: COLUMN products.tax_category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.tax_category IS 'NYS-style class: service excludes loyalty accrual; default clothing for legacy rows.';

--
-- Name: COLUMN products.employee_markup_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.employee_markup_percent IS 'When set, overrides store_settings.employee_markup_percent for employee sale price on this template (variants inherit).';

--
-- Name: COLUMN products.employee_extra_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.employee_extra_amount IS 'Per-unit amount added after cost × (1 + effective markup%) for employee sales; non-negative.';

--
-- Name: COLUMN products.tax_category_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.tax_category_override IS 'Optional POS tax classification override for this parent product. NULL inherits from category ancestry.';

--
-- Name: COLUMN qbo_integration.client_secret; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.qbo_integration.client_secret IS 'Store in vault in production; MVP plaintext for single-tenant dev.';

--
-- Name: COLUMN qbo_integration.realm_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.qbo_integration.realm_id IS 'QuickBooks company (realm) id from Intuit; falls back to company_id when null.';

--
-- Name: TABLE qbo_mappings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.qbo_mappings IS 'Mapping-first COA: category revenue/inventory/cogs, tenders, tax, gift card, holding accounts.';

--
-- Name: COLUMN qbo_mappings.source_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.qbo_mappings.source_type IS 'category_revenue | category_inventory | category_cogs | tender | tax | liability_deposit | liability_gift_card | expense_loyalty | clearing_invoice_holding | expense_shipping | income_forfeited_deposit | income_shipping';

--
-- Name: TABLE qbo_sync_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.qbo_sync_logs IS 'Proposed QBO journal entries: pending → approved → synced | failed.';

--
-- Name: COLUMN register_sessions.pos_api_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.register_sessions.pos_api_token IS 'Opaque secret for POS customer/checkout API auth while session is open; cleared on close.';

--
-- Name: COLUMN register_sessions.shift_primary_staff_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.register_sessions.shift_primary_staff_id IS 'When set, POS/register primary display and task context use this staff; NULL means use opened_by.';

--
-- Name: COLUMN register_sessions.register_lane; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.register_sessions.register_lane IS 'Physical register number (1–99). Unique among open sessions (is_open=true).';

--
-- Name: COLUMN register_sessions.till_close_group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.register_sessions.till_close_group_id IS 'All open lanes in one physical till shift share this UUID. Register lane 1 owns the cash drawer; satellites use opening_float=0 and join via primary_session_id at open.';

--
-- Name: TABLE ros_schema_migrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ros_schema_migrations IS 'One row per applied migrations/NN_name.sql file (basename = version). Not used by sqlx; ops/CI only.';

--
-- Name: TABLE shipment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.shipment IS 'Shipments from POS orders, web orders, or manual CRM creation; timeline in shipment_event.';

--
-- Name: COLUMN shipment.shippo_rate_object_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shipment.shippo_rate_object_id IS 'Shippo Rate object_id for POST /transactions/ label purchase; set from quote row when quote is applied or at POS checkout.';

--
-- Name: TABLE shipment_event; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.shipment_event IS 'Append-only shipment audit log (status, rates, staff notes).';

--
-- Name: COLUMN staff.pin_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.pin_hash IS 'Argon2 hash of numeric PIN; NULL = legacy plaintext match on cashier_code only.';

--
-- Name: COLUMN staff.phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.phone IS 'Work phone for SMS notifications (optional).';

--
-- Name: COLUMN staff.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.email IS 'Work email for notifications (optional).';

--
-- Name: COLUMN staff.avatar_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.avatar_key IS 'Stable key for bundled staff avatar SVG; validated server-side.';

--
-- Name: COLUMN staff.data_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.data_source IS 'NULL = created in ROS; ''counterpoint'' = imported from Counterpoint sync.';

--
-- Name: COLUMN staff.max_discount_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.max_discount_percent IS 'POS max line discount % vs retail for this staff member; seeded from role template.';

--
-- Name: COLUMN staff.employment_start_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.employment_start_date IS 'Optional HR start date.';

--
-- Name: COLUMN staff.employment_end_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.employment_end_date IS 'Optional end date; often set when archiving.';

--
-- Name: COLUMN staff.employee_customer_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.employee_customer_id IS 'CRM profile used for employee-cost checkout and is_employee_purchase; unique across staff.';

--
-- Name: COLUMN staff.notification_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.notification_preferences IS 'Per-staff notification inbox preferences. Configurable categories default to enabled; critical system/admin alerts remain mandatory in application logic.';

--
-- Name: TABLE staff_access_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_access_log IS 'Successful PIN / authority events for audit (checkout, register open, etc.).';

--
-- Name: TABLE staff_auth_failure_event; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_auth_failure_event IS 'Failed PIN verification attempts (staff_id known) for security digest notifications.';

--
-- Name: TABLE staff_bug_report; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_bug_report IS 'In-app bug submissions with screenshot and client diagnostics; triage under Settings → Bug reports (settings.admin).';

--
-- Name: COLUMN staff_bug_report.server_log_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff_bug_report.server_log_snapshot IS 'Recent in-process tracing lines from the API server when the report was submitted; not a full log file.';

--
-- Name: COLUMN staff_bug_report.correlation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff_bug_report.correlation_id IS 'Stable id for log correlation and support reference (returned on submit).';

--
-- Name: COLUMN staff_bug_report.resolver_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff_bug_report.resolver_notes IS 'Internal triage notes from settings.admin.';

--
-- Name: COLUMN staff_bug_report.external_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff_bug_report.external_url IS 'Optional tracker URL (Linear, GitHub issue, etc.).';

--
-- Name: TABLE staff_commission_rate_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_commission_rate_history IS 'Effective-dated commission base rate history for fulfillment-based payroll recalculation.';

--
-- Name: TABLE staff_day_exception; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_day_exception IS 'Per-date override: sick, pto, missed_shift (not working), or extra_shift (working when template says off).';

--
-- Name: TABLE staff_error_event; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_error_event IS 'Automated lightweight operational error events, primarily client error toasts, shown beside staff bug reports.';

--
-- Name: COLUMN staff_error_event.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff_error_event.status IS 'Automated error-event triage state used by staff reporting workflows.';

--
-- Name: TABLE staff_notification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_notification IS 'Per-staff inbox row; archived_at set by retention job (~30d).';

--
-- Name: TABLE staff_permission; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_permission IS 'Effective Back Office permissions per staff (non-admin); Admin role bypasses in application code.';

--
-- Name: TABLE staff_permission_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_permission_override IS 'Per-staff allow/deny deltas applied after role defaults.';

--
-- Name: TABLE staff_role_permission; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_role_permission IS 'Settings templates: default permission rows per staff_role for new hires / apply-role-defaults; not read at auth time for non-admin.';

--
-- Name: TABLE staff_role_pricing_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_role_pricing_limits IS 'Settings templates: default max discount % per staff_role; runtime reads staff.max_discount_percent.';

--
-- Name: TABLE staff_weekly_availability; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_weekly_availability IS 'Template work week for salesperson/sales_support: weekday 0=Sunday … 6=Saturday, works boolean.';

--
-- Name: TABLE store_backup_health; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_backup_health IS 'Singleton row (id=1): last backup success/failure timestamps for notification generators.';

--
-- Name: TABLE store_checkout_payment_attempt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_checkout_payment_attempt IS 'Provider-neutral web checkout payment attempt table for Helcim adapters.';

--
-- Name: TABLE store_checkout_session; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_checkout_session IS 'Public storefront checkout session. ROS owns pricing, tax, shipping, coupon snapshots, provider choice, and finalization.';

--
-- Name: TABLE store_guest_cart; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_guest_cart IS 'Anonymous storefront cart session; lines in store_guest_cart_line.';

--
-- Name: TABLE store_guest_cart_line; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_guest_cart_line IS 'Guest cart lines; priced via public store catalog rules.';

--
-- Name: TABLE store_media_asset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_media_asset IS 'Staff-uploaded images for GrapesJS Studio; public GET /api/store/media/{id}.';

--
-- Name: TABLE store_register_eod_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_register_eod_snapshot IS 'Frozen Register day summary captured at Z-close; used for historical single-day register reports.';

--
-- Name: COLUMN store_register_eod_snapshot.summary_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_register_eod_snapshot.summary_json IS 'Serialized RegisterDaySummary (store-wide, no lane filter).';

--
-- Name: COLUMN store_settings.employee_markup_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.employee_markup_percent IS 'Default whole percent added to cost for employee sale unit price (cost × (1 + pct/100)); per-product may override.';

--
-- Name: COLUMN store_settings.loyalty_point_threshold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.loyalty_point_threshold IS '5000 points = 1 reward';

--
-- Name: COLUMN store_settings.loyalty_reward_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.loyalty_reward_amount IS '$50.00 reward per threshold';

--
-- Name: COLUMN store_settings.weather_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.weather_config IS 'Visual Crossing Timeline API: enabled, location, unit_group, timezone, api_key (server-only).';

--
-- Name: COLUMN store_settings.staff_sop_markdown; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.staff_sop_markdown IS 'Per-store operating notes for staff training and AI help (Markdown). Edited in Back Office Settings → General. Empty means no custom SOP is stored.';

--
-- Name: COLUMN store_settings.podium_sms_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.podium_sms_config IS 'Podium: sms_send_enabled, location_uid, widget_embed_enabled, widget_snippet_html, sms_templates (ready_for_pickup, alteration_ready, unknown_sender_welcome). OAuth client id/secret/refresh token live in env only.';

--
-- Name: COLUMN store_settings.shippo_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.shippo_config IS 'Shippo: from address, default parcel, live_rates_enabled — see logic/shippo.rs.';

--
-- Name: COLUMN store_settings.insights_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.insights_config IS 'Insights: data_access_mode, staff_note_markdown, metabase_jwt_sso_enabled, jwt_email_domain — see GET/PATCH /api/settings/insights.';

--
-- Name: COLUMN store_settings.counterpoint_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.counterpoint_config IS 'Counterpoint integration: e.g. {"staging_enabled": true} — when true, bridge POSTs to /api/sync/counterpoint/staging for staff Apply.';

--
-- Name: COLUMN store_settings.review_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.review_policy IS 'Podium post-sale review invites: review_invites_enabled, send_review_invite_by_default. See docs/PLAN_PODIUM_REVIEWS.md.';

--
-- Name: COLUMN store_settings.rosie_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.rosie_config IS 'ROSIE assistant defaults: enabled, direct_mode_enabled, verbosity, show_citations. Local workstation overrides stay client-side.';

--
-- Name: COLUMN store_settings.active_card_provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_settings.active_card_provider IS 'Active card terminal provider selected in Settings. Helcim is the only supported provider.';

--
-- Name: TABLE storefront_campaign; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storefront_campaign IS 'Online Store campaign records for landing pages, coupons, and UTM-style attribution.';

--
-- Name: TABLE storefront_navigation_item; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storefront_navigation_item IS 'Ordered public storefront navigation links controlled by ROS.';

--
-- Name: TABLE storefront_navigation_menu; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storefront_navigation_menu IS 'Public storefront navigation menu headers such as header and footer.';

--
-- Name: TABLE storefront_publish_revision; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storefront_publish_revision IS 'Published page snapshots for preview/history/restore workflows.';

--
-- Name: TABLE suit_component_swap_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.suit_component_swap_events IS 'Audited in/out variant replacements on an order line (3pc suit swaps); see logic/suit_component_swap.rs';

--
-- Name: COLUMN task_instance.assignment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_instance.assignment_id IS 'NULL for ad-hoc tasks (e.g. R2S payment follow-up); otherwise recurring assignment.';

--
-- Name: TABLE transaction_attribution_audit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transaction_attribution_audit IS 'Append-only log when manager corrects order_items.salesperson_id after checkout.';

--
-- Name: TABLE transaction_return_lines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transaction_return_lines IS 'Append-only return events; effective line qty = order_items.quantity minus SUM(quantity_returned) per item.';

--
-- Name: COLUMN transactions.exchange_group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.exchange_group_id IS 'Links paired orders for an exchange (same UUID on both legs).';

--
-- Name: COLUMN transactions.checkout_client_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.checkout_client_id IS 'Optional idempotency key from POS offline queue / retries; duplicate POST returns same order.';

--
-- Name: COLUMN transactions.sale_channel; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.sale_channel IS 'register = in-store/POS checkout; web = first-party storefront (reporting).';

--
-- Name: COLUMN transactions.fulfillment_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.fulfillment_method IS 'Customer delivery mode: pickup vs ship (Shippo). Distinct from order_items.fulfillment (stock/special-order path).';

--
-- Name: COLUMN transactions.ship_to; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.ship_to IS 'Structured ship-to address (JSON) when fulfillment_method = ship.';

--
-- Name: COLUMN transactions.shipping_amount_usd; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.shipping_amount_usd IS 'Customer-charged shipping (may differ from label cost).';

--
-- Name: COLUMN transactions.processed_by_staff_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.processed_by_staff_id IS 'Staff who processed/rang up the sale (Counterpoint USR_ID or ROS cashier).';

--
-- Name: COLUMN transactions.counterpoint_doc_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.counterpoint_doc_ref IS 'Counterpoint PS_DOC document id (one-time import). Mutually exclusive with counterpoint_ticket_ref for a given order row.';

--
-- Name: COLUMN transactions.review_invite_suppressed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.review_invite_suppressed_at IS 'Cashier opted out of Podium review invite for this order.';

--
-- Name: COLUMN transactions.review_invite_sent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.review_invite_sent_at IS 'When ROS successfully requested a Podium review invite.';

--
-- Name: COLUMN transactions.podium_review_invite_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.podium_review_invite_id IS 'Provider id for the invite when returned by Podium API.';

--
-- Name: COLUMN transactions.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.metadata IS 'Transaction-scoped financing metadata (e.g. RMS Charge program/account selection), distinct from tender button identity.';

--
-- Name: TABLE vendor_supplier_item; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_supplier_item IS 'Counterpoint PO_VEND_ITEM (vendor SKU cross-ref). Links VEND_NO → vendors.id and ITEM_NO → product_variants when resolvable.';

--
-- Name: COLUMN vendors.account_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vendors.account_number IS 'AP / supplier account number when known; not for payment terms (see payment_terms).';

--
-- Name: COLUMN vendors.payment_terms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vendors.payment_terms IS 'Supplier payment terms code or label (e.g. Counterpoint TERMS_COD). Distinct from account_number (AP account #).';

--
-- Name: TABLE wedding_activity_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.wedding_activity_log IS 'Append-only operational feed: status, measurements, payments, notes (actor attribution).';

--
-- Name: COLUMN wedding_members.customer_verified; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wedding_members.customer_verified IS 'TRUE when this member has been matched to an existing ROS customer';

--
-- Name: COLUMN wedding_members.import_customer_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wedding_members.import_customer_name IS 'Original customer name from import (before ROS link)';

--
-- Name: COLUMN wedding_members.import_customer_phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wedding_members.import_customer_phone IS 'Original customer phone from import (before ROS link)';

--
-- Name: VIEW alterations_active; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.alterations_active IS 'Active alterations with readable transaction, fulfillment, and customer labels. Keeps raw ids for drill-through.';

--
-- Name: VIEW transactions_core; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.transactions_core IS 'Financial transaction grain with readable customer and staff display labels. Use transaction_display_id for staff-facing transaction numbers.';

--
-- Name: VIEW daily_order_totals_fulfilled; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.daily_order_totals_fulfilled IS 'FULFILLED-revenue aggregates by business day (takeaway now, or pickup later).';

--
-- Name: VIEW fulfillment_orders_core; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.fulfillment_orders_core IS 'Fulfillment-order grain with readable customer identity and party labels. Use fulfillment_order_display_id for staff-facing order numbers.';

--
-- Name: VIEW layaway_snapshot; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.layaway_snapshot IS 'Operational view for tracking layaways. Aggregates status based on forfeiture and payment balance.';

--
-- Name: VIEW loyalty_customer_snapshot; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.loyalty_customer_snapshot IS 'Customer loyalty snapshot with a unified customer_display_name for easy reporting.';

--
-- Name: VIEW loyalty_point_ledger; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.loyalty_point_ledger IS 'Loyalty point movements with readable customer and transaction display labels.';

--
-- Name: VIEW loyalty_reward_issuances; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.loyalty_reward_issuances IS 'Reward issuance ledger with readable customer and linked transaction display ids.';

--
-- Name: VIEW merchant_reconciliation; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.merchant_reconciliation IS 'High-fidelity merchant processing summary by business date, provider, and payment method. Detail drill-down belongs in reporting.payment_ledger.';

--
-- Name: VIEW order_lines; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.order_lines IS 'Line grain with staff-facing transaction/order numbers, customer names, product/category/vendor labels, SKU/barcode, and margin fields. Hide UUID keys in Metabase browse.';

--
-- Name: VIEW order_loyalty_accrual; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.order_loyalty_accrual IS 'Loyalty earn snapshots with readable transaction and customer fields for staff-friendly reporting.';

--
-- Name: VIEW payment_ledger; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.payment_ledger IS 'Readable payment audit log with payer names and linked transaction display numbers. Hide UUID and provider raw ids in normal staff Metabase browse.';

--
-- Name: VIEW shipments_active; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.shipments_active IS 'Shipment activity with readable transaction and fulfillment display ids plus customer labels.';

--
-- Name: VIEW wedding_party_economics; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.wedding_party_economics IS 'Wedding economics with readable party identity, event date, and coordinator labels.';

--
-- Name: app_notification_dedupe_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_notification_dedupe_key_uq ON public.app_notification USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);

--
-- Name: commission_events_reporting_staff_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commission_events_reporting_staff_idx ON public.commission_events USING btree (reporting_date, staff_id, event_type);

--
-- Name: commission_events_source_type_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commission_events_source_type_uidx ON public.commission_events USING btree (source_event_id, event_type) WHERE (source_event_id IS NOT NULL);

--
-- Name: commission_events_transaction_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commission_events_transaction_line_idx ON public.commission_events USING btree (transaction_line_id);

--
-- Name: counterpoint_receiving_history_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX counterpoint_receiving_history_date_idx ON public.counterpoint_receiving_history USING btree (recv_dat DESC);

--
-- Name: counterpoint_receiving_history_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX counterpoint_receiving_history_item_idx ON public.counterpoint_receiving_history USING btree (item_no);

--
-- Name: counterpoint_staff_map_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX counterpoint_staff_map_code_idx ON public.counterpoint_staff_map USING btree (cp_code);

--
-- Name: counterpoint_staging_batch_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX counterpoint_staging_batch_status_created_idx ON public.counterpoint_staging_batch USING btree (status, created_at DESC);

--
-- Name: counterpoint_sync_issue_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX counterpoint_sync_issue_unresolved_idx ON public.counterpoint_sync_issue USING btree (entity, created_at DESC) WHERE (NOT resolved);

--
-- Name: counterpoint_sync_runs_entity_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX counterpoint_sync_runs_entity_uidx ON public.counterpoint_sync_runs USING btree (entity);

--
-- Name: customer_duplicate_review_queue_pair_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_duplicate_review_queue_pair_uq ON public.customer_duplicate_review_queue USING btree (customer_a_id, customer_b_id) WHERE (status = 'pending'::text);

--
-- Name: customer_duplicate_review_queue_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_duplicate_review_queue_pending ON public.customer_duplicate_review_queue USING btree (created_at DESC) WHERE (status = 'pending'::text);

--
-- Name: help_manual_policy_hidden_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX help_manual_policy_hidden_idx ON public.help_manual_policy USING btree (hidden) WHERE (hidden = true);

--
-- Name: idx_alteration_activity_alt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_activity_alt ON public.alteration_activity USING btree (alteration_id, created_at DESC);

--
-- Name: idx_alteration_order_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_order_items_order_id ON public.alteration_order_items USING btree (alteration_order_id);

--
-- Name: idx_alteration_orders_appointment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_orders_appointment_id ON public.alteration_orders USING btree (appointment_id);

--
-- Name: idx_alteration_orders_charge_transaction_line_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_orders_charge_transaction_line_id ON public.alteration_orders USING btree (charge_transaction_line_id);

--
-- Name: idx_alteration_orders_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_orders_customer ON public.alteration_orders USING btree (customer_id, created_at DESC);

--
-- Name: idx_alteration_orders_fitting_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_orders_fitting_at ON public.alteration_orders USING btree (fitting_at);

--
-- Name: idx_alteration_orders_source_transaction_line_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_orders_source_transaction_line_id ON public.alteration_orders USING btree (source_transaction_line_id);

--
-- Name: idx_alteration_orders_source_type_due_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_orders_source_type_due_at ON public.alteration_orders USING btree (source_type, due_at);

--
-- Name: idx_alteration_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alteration_orders_status ON public.alteration_orders USING btree (status, due_at);

--
-- Name: idx_app_notification_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_notification_created ON public.app_notification USING btree (created_at DESC);

--
-- Name: idx_commission_rules_match; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_rules_match ON public.commission_rules USING btree (match_type, match_id) WHERE (is_active = true);

--
-- Name: idx_corecard_posting_event_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecard_posting_event_account ON public.corecard_posting_event USING btree (linked_corecredit_account_id, created_at DESC) WHERE (linked_corecredit_account_id IS NOT NULL);

--
-- Name: idx_corecard_posting_event_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecard_posting_event_status ON public.corecard_posting_event USING btree (posting_status, operation_type, created_at DESC);

--
-- Name: idx_corecard_posting_event_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecard_posting_event_transaction ON public.corecard_posting_event USING btree (transaction_id, created_at DESC);

--
-- Name: idx_corecredit_event_log_related_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecredit_event_log_related_record ON public.corecredit_event_log USING btree (related_rms_record_id, received_at DESC) WHERE (related_rms_record_id IS NOT NULL);

--
-- Name: idx_corecredit_event_log_status_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecredit_event_log_status_received ON public.corecredit_event_log USING btree (processing_status, received_at DESC);

--
-- Name: idx_helcim_event_log_provider_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_helcim_event_log_provider_event ON public.helcim_event_log USING btree (provider, event_type, received_at DESC);

--
-- Name: idx_helcim_event_log_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_helcim_event_log_status ON public.helcim_event_log USING btree (processing_status, received_at DESC);

--
-- Name: idx_helcim_event_log_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_helcim_event_log_attempt ON public.helcim_event_log USING btree (payment_provider_attempt_id, received_at DESC) WHERE (payment_provider_attempt_id IS NOT NULL);

--
-- Name: idx_helcim_event_log_payment_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_helcim_event_log_payment_transaction ON public.helcim_event_log USING btree (payment_transaction_id, received_at DESC) WHERE (payment_transaction_id IS NOT NULL);

--
-- Name: idx_payment_provider_batches_provider_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_batches_provider_status ON public.payment_provider_batches USING btree (provider, status, last_synced_at DESC);

--
-- Name: idx_payment_provider_batches_closed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_batches_closed_at ON public.payment_provider_batches USING btree (provider, closed_at DESC) WHERE (closed_at IS NOT NULL);

--
-- Name: idx_payment_provider_batches_settled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_batches_settled_at ON public.payment_provider_batches USING btree (provider, settled_at DESC) WHERE (settled_at IS NOT NULL);

--
-- Name: idx_payment_provider_batch_transactions_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_batch_transactions_batch ON public.payment_provider_batch_transactions USING btree (provider_batch_id, provider_transaction_id);

--
-- Name: idx_payment_provider_batch_transactions_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_batch_transactions_payment ON public.payment_provider_batch_transactions USING btree (payment_transaction_id) WHERE (payment_transaction_id IS NOT NULL);

--
-- Name: idx_payment_provider_batch_transactions_match; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_batch_transactions_match ON public.payment_provider_batch_transactions USING btree (provider, match_status, last_synced_at DESC);

--
-- Name: idx_payment_settlement_runs_provider_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_runs_provider_status ON public.payment_settlement_runs USING btree (provider, status, started_at DESC);

--
-- Name: idx_payment_settlement_runs_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_runs_window ON public.payment_settlement_runs USING btree (provider, date_from, date_to);

--
-- Name: idx_payment_settlement_items_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_items_run ON public.payment_settlement_items USING btree (run_id, severity, created_at DESC);

--
-- Name: idx_payment_settlement_items_provider_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_items_provider_status ON public.payment_settlement_items USING btree (provider, status, item_type, created_at DESC);

--
-- Name: idx_payment_settlement_item_events_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_item_events_item ON public.payment_settlement_item_events USING btree (item_id, created_at DESC);

--
-- Name: idx_payment_settlement_item_events_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_item_events_actor ON public.payment_settlement_item_events USING btree (actor_staff_id, created_at DESC) WHERE (actor_staff_id IS NOT NULL);

--
-- Name: idx_payment_settlement_item_events_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_item_events_action ON public.payment_settlement_item_events USING btree (action, created_at DESC);

--
-- Name: idx_payment_settlement_item_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_settlement_item_events_created ON public.payment_settlement_item_events USING btree (created_at DESC);

--
-- Name: idx_corecredit_exception_queue_rms_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecredit_exception_queue_rms_record ON public.corecredit_exception_queue USING btree (rms_record_id, opened_at DESC) WHERE (rms_record_id IS NOT NULL);

--
-- Name: idx_corecredit_exception_queue_status_opened; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecredit_exception_queue_status_opened ON public.corecredit_exception_queue USING btree (status, severity, opened_at DESC);

--
-- Name: idx_corecredit_reconciliation_item_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecredit_reconciliation_item_run ON public.corecredit_reconciliation_item USING btree (run_id, severity, created_at DESC);

--
-- Name: idx_corecredit_reconciliation_run_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corecredit_reconciliation_run_started ON public.corecredit_reconciliation_run USING btree (started_at DESC, status);

--
-- Name: idx_customer_corecredit_accounts_customer_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_corecredit_accounts_customer_status ON public.customer_corecredit_accounts USING btree (customer_id, status, is_primary DESC, updated_at DESC);

--
-- Name: idx_customer_group_members_cid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_group_members_cid ON public.customer_group_members USING btree (customer_id);

--
-- Name: idx_customer_group_members_gid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_group_members_gid ON public.customer_group_members USING btree (group_id);

--
-- Name: idx_customer_group_members_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_group_members_group ON public.customer_group_members USING btree (group_id);

--
-- Name: idx_customer_measurements_customer_measured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_measurements_customer_measured ON public.customer_measurements USING btree (customer_id, measured_at DESC);

--
-- Name: idx_customer_online_credential_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_online_credential_updated ON public.customer_online_credential USING btree (updated_at DESC);

--
-- Name: idx_customer_open_deposit_ledger_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_open_deposit_ledger_account ON public.customer_open_deposit_ledger USING btree (account_id, created_at DESC);

--
-- Name: idx_customer_relationship_child_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_relationship_child_range ON public.customer_relationship_periods USING btree (child_customer_id, linked_at DESC, unlinked_at);

--
-- Name: idx_customer_relationship_parent_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_relationship_parent_range ON public.customer_relationship_periods USING btree (parent_customer_id, linked_at DESC, unlinked_at);

--
-- Name: idx_customer_timeline_notes_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_timeline_notes_customer ON public.customer_timeline_notes USING btree (customer_id, created_at DESC);

--
-- Name: idx_customers_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_company ON public.customers USING btree (company_name);

--
-- Name: idx_customers_couple_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_couple_id ON public.customers USING btree (couple_id) WHERE (couple_id IS NOT NULL);

--
-- Name: idx_customers_customer_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_customers_customer_code ON public.customers USING btree (customer_code);

--
-- Name: idx_customers_names; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_names ON public.customers USING btree (last_name, first_name);

--
-- Name: idx_customers_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_phone ON public.customers USING btree (phone);

--
-- Name: idx_discount_event_usage_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_event_usage_event ON public.discount_event_usage USING btree (event_id, created_at DESC);

--
-- Name: idx_discount_event_usage_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_event_usage_order ON public.discount_event_usage USING btree (transaction_id);

--
-- Name: idx_discount_event_variants_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_event_variants_variant ON public.discount_event_variants USING btree (variant_id);

--
-- Name: idx_fulfillment_orders_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fulfillment_orders_status_created ON public.fulfillment_orders USING btree (status, created_at, id);

--
-- Name: idx_gc_events_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gc_events_card ON public.gift_card_events USING btree (gift_card_id, created_at DESC);

--
-- Name: idx_gc_events_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gc_events_order ON public.gift_card_events USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);

--
-- Name: idx_gift_cards_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_cards_customer ON public.gift_cards USING btree (customer_id) WHERE (customer_id IS NOT NULL);

--
-- Name: idx_gift_cards_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_cards_expires ON public.gift_cards USING btree (expires_at);

--
-- Name: idx_gift_cards_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_cards_kind ON public.gift_cards USING btree (card_kind);

--
-- Name: idx_gift_cards_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_cards_status ON public.gift_cards USING btree (card_status);

--
-- Name: idx_inv_count_stream_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_count_stream_session ON public.inventory_count_scan_stream USING btree (session_id, scanned_at DESC);

--
-- Name: idx_inv_count_stream_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_count_stream_staff ON public.inventory_count_scan_stream USING btree (staff_id);

--
-- Name: idx_inv_loc_layout; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_loc_layout ON public.inventory_locations USING btree (layout_id);

--
-- Name: idx_layaway_activity_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_layaway_activity_order_id ON public.layaway_activity_log USING btree (transaction_id);

--
-- Name: idx_lpl_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lpl_customer ON public.loyalty_point_ledger USING btree (customer_id, created_at DESC);

--
-- Name: idx_lpl_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lpl_order ON public.loyalty_point_ledger USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);

--
-- Name: idx_lri_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lri_customer ON public.loyalty_reward_issuances USING btree (customer_id, created_at DESC);

--
-- Name: idx_measurements_customer_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_measurements_customer_created ON public.measurements USING btree (customer_id, created_at DESC) WHERE (customer_id IS NOT NULL);

--
-- Name: idx_notification_delivery_suppression_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_delivery_suppression_created ON public.notification_delivery_suppression USING btree (created_at DESC);

--
-- Name: idx_notification_delivery_suppression_kind_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_delivery_suppression_kind_created ON public.notification_delivery_suppression USING btree (semantic_kind, created_at DESC);

--
-- Name: idx_notification_generator_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_generator_run_status ON public.notification_generator_run USING btree (last_status, last_finished_at DESC);

--
-- Name: idx_one_active_inventory_session; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_one_active_inventory_session ON public.physical_inventory_sessions USING btree (status) WHERE (status = ANY (ARRAY['open'::text, 'reviewing'::text]));

--
-- Name: idx_ops_action_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_action_audit_actor ON public.ops_action_audit USING btree (actor_staff_id, created_at DESC);

--
-- Name: idx_ops_action_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_action_audit_created ON public.ops_action_audit USING btree (created_at DESC);

--
-- Name: idx_ops_alert_event_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ops_alert_event_dedupe ON public.ops_alert_event USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);

--
-- Name: idx_ops_alert_event_resolved_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_alert_event_resolved_retention ON public.ops_alert_event USING btree (resolved_at, updated_at, last_seen_at) WHERE (status = 'resolved'::text);

--
-- Name: idx_ops_alert_event_station_offline_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_alert_event_station_offline_dedupe ON public.ops_alert_event USING btree (dedupe_key) WHERE ((rule_key = 'station_offline'::text) AND (status = ANY (ARRAY['open'::text, 'acked'::text])));

--
-- Name: idx_ops_alert_event_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_alert_event_status ON public.ops_alert_event USING btree (status, severity, last_seen_at DESC);

--
-- Name: idx_ops_bug_incident_link_alert; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_bug_incident_link_alert ON public.ops_bug_incident_link USING btree (alert_event_id, created_at DESC);

--
-- Name: idx_ops_bug_incident_link_bug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_bug_incident_link_bug ON public.ops_bug_incident_link USING btree (bug_report_id, created_at DESC);

--
-- Name: idx_ops_notification_delivery_alert; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_notification_delivery_alert ON public.ops_notification_delivery_log USING btree (alert_event_id, created_at DESC);

--
-- Name: idx_ops_station_heartbeat_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ops_station_heartbeat_last_seen ON public.ops_station_heartbeat USING btree (last_seen_at DESC);

--
-- Name: idx_order_activity_log_customer_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_activity_log_customer_created ON public.transaction_activity_log USING btree (customer_id, created_at DESC);

--
-- Name: idx_order_activity_log_order_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_activity_log_order_created ON public.transaction_activity_log USING btree (transaction_id, created_at DESC);

--
-- Name: idx_order_attr_audit_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_attr_audit_order ON public.transaction_attribution_audit USING btree (transaction_id);

--
-- Name: idx_order_items_is_fulfilled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_is_fulfilled ON public.transaction_lines USING btree (is_fulfilled);

--
-- Name: idx_order_items_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_product_id ON public.transaction_lines USING btree (product_id);

--
-- Name: INDEX idx_order_items_product_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_order_items_product_id IS 'Supports trailing-window units-sold GROUP BY product_id for search ranking.';

--
-- Name: idx_order_items_salesperson; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_salesperson ON public.transaction_lines USING btree (salesperson_id) WHERE (salesperson_id IS NOT NULL);

--
-- Name: idx_order_items_variant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_variant_id ON public.transaction_lines USING btree (variant_id);

--
-- Name: INDEX idx_order_items_variant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_order_items_variant_id IS 'Supports trailing-window units-sold subqueries for control-board search ranking.';

--
-- Name: idx_order_refund_queue_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_refund_queue_open ON public.transaction_refund_queue USING btree (is_open, created_at DESC);

--
-- Name: idx_order_return_lines_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_return_lines_item ON public.transaction_return_lines USING btree (transaction_line_id);

--
-- Name: idx_order_return_lines_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_return_lines_order ON public.transaction_return_lines USING btree (transaction_id, created_at DESC);

--
-- Name: idx_orders_booked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_booked_at ON public.transactions USING btree (booked_at DESC);

--
-- Name: idx_orders_customer_id_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_customer_id_status ON public.transactions USING btree (customer_id, status);

--
-- Name: idx_orders_fulfilled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_fulfilled_at ON public.transactions USING btree (fulfilled_at DESC) WHERE (fulfilled_at IS NOT NULL);

--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.transactions USING btree (status);

--
-- Name: idx_orders_wedding_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_wedding_member_id ON public.transactions USING btree (wedding_member_id);

--
-- Name: idx_payment_allocations_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_allocations_order ON public.payment_allocations USING btree (target_transaction_id);

--
-- Name: idx_payment_allocations_target_transaction_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_allocations_target_transaction_payment ON public.payment_allocations USING btree (target_transaction_id, transaction_id) WHERE (amount_allocated > (0)::numeric);

--
-- Name: idx_payment_provider_attempts_device_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_attempts_device_created ON public.payment_provider_attempts USING btree (provider, device_id, created_at DESC) WHERE (device_id IS NOT NULL);

--
-- Name: idx_payment_provider_attempts_provider_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_attempts_provider_payment ON public.payment_provider_attempts USING btree (provider, provider_payment_id) WHERE (provider_payment_id IS NOT NULL);

--
-- Name: idx_payment_provider_attempts_provider_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_attempts_provider_status_created ON public.payment_provider_attempts USING btree (provider, status, created_at DESC);

--
-- Name: idx_payment_provider_attempts_register_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_attempts_register_created ON public.payment_provider_attempts USING btree (register_session_id, created_at DESC) WHERE (register_session_id IS NOT NULL);

--
-- Name: idx_payment_provider_attempts_staff_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_attempts_staff_created ON public.payment_provider_attempts USING btree (staff_id, created_at DESC) WHERE (staff_id IS NOT NULL);

--
-- Name: idx_payment_provider_attempts_terminal_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_provider_attempts_terminal_created ON public.payment_provider_attempts USING btree (provider, terminal_id, created_at DESC) WHERE (terminal_id IS NOT NULL);

--
-- Name: idx_payment_transactions_payer_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_transactions_payer_created ON public.payment_transactions USING btree (payer_id, created_at DESC) WHERE (payer_id IS NOT NULL);

--
-- Name: idx_payment_transactions_provider_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_transactions_provider_payment_id ON public.payment_transactions USING btree (payment_provider, provider_payment_id) WHERE (provider_payment_id IS NOT NULL);

--
-- Name: uq_payment_transactions_provider_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payment_transactions_provider_transaction_id ON public.payment_transactions USING btree (payment_provider, provider_transaction_id) WHERE ((payment_provider IS NOT NULL) AND (NULLIF(TRIM(BOTH FROM provider_transaction_id), ''::text) IS NOT NULL));

--
-- Name: idx_payment_transactions_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_transactions_session ON public.payment_transactions USING btree (session_id);

--
-- Name: idx_payment_transactions_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_transactions_status_created ON public.payment_transactions USING btree (status, created_at, id);

--
-- Name: idx_payment_tx_wedding_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_tx_wedding_member_id ON public.payment_transactions USING btree (wedding_member_id);

--
-- Name: idx_pi_audit_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_audit_session ON public.physical_inventory_audit USING btree (session_id, created_at DESC);

--
-- Name: idx_pi_counts_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_counts_session ON public.physical_inventory_counts USING btree (session_id);

--
-- Name: idx_pi_counts_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_counts_variant ON public.physical_inventory_counts USING btree (variant_id);

--
-- Name: idx_pi_snapshots_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_snapshots_session ON public.physical_inventory_snapshots USING btree (session_id);

--
-- Name: idx_podium_conversation_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_podium_conversation_customer ON public.podium_conversation USING btree (customer_id);

--
-- Name: idx_podium_conversation_last_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_podium_conversation_last_msg ON public.podium_conversation USING btree (last_message_at DESC);

--
-- Name: idx_podium_message_conv_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_podium_message_conv_created ON public.podium_message USING btree (conversation_id, created_at DESC);

--
-- Name: idx_podium_webhook_delivery_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_podium_webhook_delivery_received ON public.podium_webhook_delivery USING btree (received_at DESC);

--
-- Name: idx_pos_parked_sale_audit_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_parked_sale_audit_sale ON public.pos_parked_sale_audit USING btree (parked_sale_id, created_at DESC);

--
-- Name: idx_pos_parked_sale_audit_session_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_parked_sale_audit_session_created ON public.pos_parked_sale_audit USING btree (register_session_id, created_at DESC);

--
-- Name: idx_pos_parked_sale_customer_parked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_parked_sale_customer_parked ON public.pos_parked_sale USING btree (customer_id) WHERE (status = 'parked'::public.pos_parked_sale_status);

--
-- Name: idx_pos_parked_sale_session_parked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_parked_sale_session_parked ON public.pos_parked_sale USING btree (register_session_id, status) WHERE (status = 'parked'::public.pos_parked_sale_status);

--
-- Name: idx_pos_rms_charge_record_corecredit_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_corecredit_account ON public.pos_rms_charge_record USING btree (linked_corecredit_account_id, created_at DESC) WHERE (linked_corecredit_account_id IS NOT NULL);

--
-- Name: idx_pos_rms_charge_record_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_created ON public.pos_rms_charge_record USING btree (created_at DESC);

--
-- Name: idx_pos_rms_charge_record_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_customer ON public.pos_rms_charge_record USING btree (customer_id);

--
-- Name: idx_pos_rms_charge_record_external_tx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_external_tx ON public.pos_rms_charge_record USING btree (external_transaction_id) WHERE (external_transaction_id IS NOT NULL);

--
-- Name: idx_pos_rms_charge_record_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_idempotency_key ON public.pos_rms_charge_record USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

--
-- Name: idx_pos_rms_charge_record_kind_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_kind_created ON public.pos_rms_charge_record USING btree (record_kind, created_at DESC);

--
-- Name: idx_pos_rms_charge_record_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_method ON public.pos_rms_charge_record USING btree (payment_method);

--
-- Name: idx_pos_rms_charge_record_posting_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_rms_charge_record_posting_status_created ON public.pos_rms_charge_record USING btree (posting_status, created_at DESC);

--
-- Name: idx_product_catalog_audit_product_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_catalog_audit_product_created ON public.product_catalog_audit_log USING btree (product_id, created_at DESC);

--
-- Name: idx_product_variants_barcode_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_variants_barcode_lower ON public.product_variants USING btree (lower(TRIM(BOTH FROM barcode))) WHERE ((barcode IS NOT NULL) AND (TRIM(BOTH FROM barcode) <> ''::text));

--
-- Name: idx_product_variants_nuorder_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_variants_nuorder_id ON public.product_variants USING btree (nuorder_id);

--
-- Name: idx_product_variants_oos_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_variants_oos_variant ON public.product_variants USING btree (id) WHERE (stock_on_hand <= 0);

--
-- Name: idx_product_variants_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_variants_product_id ON public.product_variants USING btree (product_id);

--
-- Name: idx_purchase_order_lines_variant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_order_lines_variant_id ON public.purchase_order_lines USING btree (variant_id);

--
-- Name: idx_pv_vendor_upc_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pv_vendor_upc_lower ON public.product_variants USING btree (lower(vendor_upc)) WHERE ((vendor_upc IS NOT NULL) AND (vendor_upc <> ''::text));

--
-- Name: idx_refund_queue_order_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_refund_queue_order_open ON public.transaction_refund_queue USING btree (transaction_id) WHERE (is_open = true);

--
-- Name: idx_register_sessions_closed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_register_sessions_closed_at ON public.register_sessions USING btree (closed_at) WHERE (closed_at IS NOT NULL);

--
-- Name: idx_register_sessions_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_register_sessions_ordinal ON public.register_sessions USING btree (session_ordinal);

--
-- Name: idx_ros_schema_migrations_applied_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ros_schema_migrations_applied_at ON public.ros_schema_migrations USING btree (applied_at DESC);

--
-- Name: idx_shipment_customer_active_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_customer_active_created ON public.shipment USING btree (customer_id, created_at DESC) WHERE (status <> ALL (ARRAY['delivered'::public.shipment_status, 'cancelled'::public.shipment_status]));

--
-- Name: idx_staff_access_log_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_access_log_event ON public.staff_access_log USING btree (event_kind, created_at DESC);

--
-- Name: idx_staff_access_log_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_access_log_staff ON public.staff_access_log USING btree (staff_id, created_at DESC);

--
-- Name: idx_staff_auth_failure_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_auth_failure_created ON public.staff_auth_failure_event USING btree (created_at DESC);

--
-- Name: idx_staff_auth_failure_staff_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_auth_failure_staff_time ON public.staff_auth_failure_event USING btree (staff_id, created_at DESC);

--
-- Name: idx_staff_bug_report_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_staff_bug_report_correlation_id ON public.staff_bug_report USING btree (correlation_id);

--
-- Name: idx_staff_bug_report_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_bug_report_created_at ON public.staff_bug_report USING btree (created_at DESC);

--
-- Name: idx_staff_bug_report_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_bug_report_retention ON public.staff_bug_report USING btree (created_at);

--
-- Name: idx_staff_bug_report_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_bug_report_status ON public.staff_bug_report USING btree (status);

--
-- Name: idx_staff_day_exception_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_day_exception_date ON public.staff_day_exception USING btree (exception_date);

--
-- Name: idx_staff_error_event_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_error_event_created_at ON public.staff_error_event USING btree (created_at DESC);

--
-- Name: idx_staff_error_event_staff_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_error_event_staff_created_at ON public.staff_error_event USING btree (staff_id, created_at DESC);

--
-- Name: idx_staff_error_event_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_error_event_status ON public.staff_error_event USING btree (status);

--
-- Name: idx_staff_error_event_status_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_error_event_status_created_at ON public.staff_error_event USING btree (status, created_at DESC);

--
-- Name: idx_staff_notification_action_sn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_notification_action_sn ON public.staff_notification_action USING btree (staff_notification_id, created_at DESC);

--
-- Name: idx_staff_notification_staff_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_notification_staff_created ON public.staff_notification USING btree (staff_id, created_at DESC);

--
-- Name: idx_staff_notification_staff_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_notification_staff_inbox ON public.staff_notification USING btree (staff_id) WHERE (archived_at IS NULL);

--
-- Name: idx_staff_permission_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_permission_staff ON public.staff_permission USING btree (staff_id);

--
-- Name: idx_staff_schedule_events_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_schedule_events_date ON public.staff_schedule_events USING btree (event_date);

--
-- Name: idx_staff_weekly_schedule_day_week; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_weekly_schedule_day_week ON public.staff_weekly_schedule_day USING btree (week_start, staff_id, weekday);

--
-- Name: idx_staff_weekly_schedule_week; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_weekly_schedule_week ON public.staff_weekly_schedule USING btree (week_start, staff_id);

--
-- Name: idx_store_credit_ledger_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_credit_ledger_account ON public.store_credit_ledger USING btree (account_id, created_at DESC);

--
-- Name: idx_store_guest_cart_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_guest_cart_expires ON public.store_guest_cart USING btree (expires_at);

--
-- Name: idx_store_guest_cart_line_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_guest_cart_line_variant ON public.store_guest_cart_line USING btree (variant_id);

--
-- Name: idx_store_media_asset_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_media_asset_created ON public.store_media_asset USING btree (created_at DESC);

--
-- Name: idx_suit_component_swap_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suit_component_swap_events_created ON public.suit_component_swap_events USING btree ((created_at AT TIME ZONE 'UTC'::text));

--
-- Name: idx_suit_component_swap_events_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suit_component_swap_events_order ON public.suit_component_swap_events USING btree (transaction_id);

--
-- Name: idx_task_assignment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_assignment_active ON public.task_assignment USING btree (active) WHERE (active = true);

--
-- Name: idx_task_instance_assignee_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_instance_assignee_open ON public.task_instance USING btree (assignee_staff_id, status) WHERE (status = 'open'::public.task_instance_status);

--
-- Name: idx_task_instance_item_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_instance_item_instance ON public.task_instance_item USING btree (task_instance_id);

--
-- Name: idx_transaction_lines_fulfillment_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_lines_fulfillment_order ON public.transaction_lines USING btree (fulfillment_order_id) WHERE (fulfillment_order_id IS NOT NULL);

--
-- Name: idx_transaction_lines_fulfillment_order_rush; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_lines_fulfillment_order_rush ON public.transaction_lines USING btree (fulfillment_order_id) WHERE ((fulfillment_order_id IS NOT NULL) AND (is_rush = true));

--
-- Name: idx_transaction_lines_fulfillment_order_unfulfilled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_lines_fulfillment_order_unfulfilled ON public.transaction_lines USING btree (fulfillment_order_id) WHERE ((fulfillment_order_id IS NOT NULL) AND (is_fulfilled = false));

--
-- Name: idx_transaction_lines_product_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_lines_product_transaction ON public.transaction_lines USING btree (product_id, transaction_id) WHERE (product_id IS NOT NULL);

--
-- Name: idx_transaction_lines_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_lines_transaction ON public.transaction_lines USING btree (transaction_id);

--
-- Name: idx_transactions_booked_status_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_booked_status_id ON public.transactions USING btree (booked_at DESC, status, id);

--
-- Name: idx_transactions_customer_booked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_customer_booked ON public.transactions USING btree (customer_id, booked_at DESC) WHERE (customer_id IS NOT NULL);

--
-- Name: idx_wedding_activity_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_activity_log_created ON public.wedding_activity_log USING btree (created_at DESC);

--
-- Name: idx_wedding_activity_log_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_activity_log_member ON public.wedding_activity_log USING btree (wedding_member_id);

--
-- Name: idx_wedding_activity_log_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_activity_log_party ON public.wedding_activity_log USING btree (wedding_party_id);

--
-- Name: idx_wedding_appts_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_appts_customer ON public.wedding_appointments USING btree (customer_id) WHERE (customer_id IS NOT NULL);

--
-- Name: idx_wedding_appts_party_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_appts_party_member ON public.wedding_appointments USING btree (wedding_party_id, wedding_member_id);

--
-- Name: idx_wedding_appts_starts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_appts_starts ON public.wedding_appointments USING btree (starts_at);

--
-- Name: idx_wedding_members_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_members_customer ON public.wedding_members USING btree (customer_id);

--
-- Name: idx_wedding_members_customer_party_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_members_customer_party_member ON public.wedding_members USING btree (customer_id, wedding_party_id, id);

--
-- Name: idx_wedding_members_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_members_party ON public.wedding_members USING btree (wedding_party_id);

--
-- Name: idx_wedding_members_party_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_members_party_index ON public.wedding_members USING btree (wedding_party_id, member_index);

--
-- Name: idx_wedding_members_suit_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_members_suit_variant ON public.wedding_members USING btree (suit_variant_id);

--
-- Name: idx_wedding_non_inv_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_non_inv_party ON public.wedding_non_inventory_items USING btree (wedding_party_id);

--
-- Name: idx_wedding_parties_active_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_parties_active_event ON public.wedding_parties USING btree (event_date, id) WHERE ((is_deleted IS NULL) OR (is_deleted = false));

--
-- Name: idx_wedding_parties_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_parties_deleted ON public.wedding_parties USING btree (is_deleted);

--
-- Name: idx_wedding_parties_event_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_parties_event_date ON public.wedding_parties USING btree (event_date);

--
-- Name: idx_wedding_parties_salesperson; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wedding_parties_salesperson ON public.wedding_parties USING btree (salesperson);

--
-- Name: loyalty_point_ledger_cp_ps_loy_ref_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX loyalty_point_ledger_cp_ps_loy_ref_uidx ON public.loyalty_point_ledger USING btree (((metadata ->> 'cp_ref'::text))) WHERE (reason = 'cp_loy_pts_hist'::text);

--
-- Name: order_items_commission_payout_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_items_commission_payout_open_idx ON public.transaction_lines USING btree (transaction_id) WHERE ((is_fulfilled = true) AND (commission_payout_finalized_at IS NULL) AND (calculated_commission > (0)::numeric));

--
-- Name: orders_checkout_client_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX orders_checkout_client_id_uidx ON public.transactions USING btree (checkout_client_id) WHERE (checkout_client_id IS NOT NULL);

--
-- Name: orders_counterpoint_doc_ref_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX orders_counterpoint_doc_ref_uidx ON public.transactions USING btree (counterpoint_doc_ref) WHERE (counterpoint_doc_ref IS NOT NULL);

--
-- Name: orders_counterpoint_ticket_ref_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX orders_counterpoint_ticket_ref_uidx ON public.transactions USING btree (counterpoint_ticket_ref) WHERE (counterpoint_ticket_ref IS NOT NULL);

--
-- Name: podium_conversation_uid_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX podium_conversation_uid_uq ON public.podium_conversation USING btree (podium_conversation_uid) WHERE ((podium_conversation_uid IS NOT NULL) AND (TRIM(BOTH FROM podium_conversation_uid) <> ''::text));

--
-- Name: podium_message_uid_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX podium_message_uid_uq ON public.podium_message USING btree (podium_message_uid) WHERE ((podium_message_uid IS NOT NULL) AND (TRIM(BOTH FROM podium_message_uid) <> ''::text));

--
-- Name: pos_rms_charge_record_pay_tx_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pos_rms_charge_record_pay_tx_uq ON public.pos_rms_charge_record USING btree (payment_transaction_id) WHERE (payment_transaction_id IS NOT NULL);

--
-- Name: product_variants_counterpoint_item_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_variants_counterpoint_item_key_uidx ON public.product_variants USING btree (counterpoint_item_key) WHERE (counterpoint_item_key IS NOT NULL);

--
-- Name: products_catalog_handle_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_catalog_handle_uq ON public.products USING btree (catalog_handle);

--
-- Name: qbo_sync_logs_date_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qbo_sync_logs_date_status_idx ON public.qbo_sync_logs USING btree (sync_date DESC, status);

--
-- Name: register_cash_adjustments_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX register_cash_adjustments_session_idx ON public.register_cash_adjustments USING btree (session_id);

--
-- Name: register_sessions_open_lane_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX register_sessions_open_lane_uidx ON public.register_sessions USING btree (register_lane) WHERE (is_open = true);

--
-- Name: register_sessions_open_till_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX register_sessions_open_till_group_idx ON public.register_sessions USING btree (till_close_group_id) WHERE (is_open = true);

--
-- Name: register_sessions_pos_api_token_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX register_sessions_pos_api_token_uidx ON public.register_sessions USING btree (pos_api_token) WHERE (pos_api_token IS NOT NULL);

--
-- Name: shipment_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_created_at_idx ON public.shipment USING btree (created_at DESC);

--
-- Name: shipment_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_customer_idx ON public.shipment USING btree (customer_id);

--
-- Name: shipment_event_shipment_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_event_shipment_at_idx ON public.shipment_event USING btree (shipment_id, at DESC);

--
-- Name: shipment_one_order_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shipment_one_order_uidx ON public.shipment USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);

--
-- Name: shipment_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_source_idx ON public.shipment USING btree (source);

--
-- Name: shipment_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_status_idx ON public.shipment USING btree (status);

--
-- Name: staff_access_log_staff_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_access_log_staff_created ON public.staff_access_log USING btree (staff_id, created_at DESC);

--
-- Name: staff_commission_rate_history_staff_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_commission_rate_history_staff_created_idx ON public.staff_commission_rate_history USING btree (staff_id, created_at DESC);

--
-- Name: staff_commission_rate_history_staff_effective_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX staff_commission_rate_history_staff_effective_uidx ON public.staff_commission_rate_history USING btree (staff_id, effective_start_date);

--
-- Name: staff_employee_customer_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX staff_employee_customer_uidx ON public.staff USING btree (employee_customer_id) WHERE (employee_customer_id IS NOT NULL);

--
-- Name: staff_permission_override_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_permission_override_staff ON public.staff_permission_override USING btree (staff_id);

--
-- Name: store_checkout_payment_attempt_provider_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_checkout_payment_attempt_provider_payment_idx ON public.store_checkout_payment_attempt USING btree (provider, provider_payment_id) WHERE (provider_payment_id IS NOT NULL);

--
-- Name: store_checkout_payment_attempt_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_checkout_payment_attempt_session_idx ON public.store_checkout_payment_attempt USING btree (checkout_session_id, created_at DESC);

--
-- Name: store_checkout_session_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_checkout_session_campaign_idx ON public.store_checkout_session USING btree (campaign_slug) WHERE (campaign_slug IS NOT NULL);

--
-- Name: store_checkout_session_finalized_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_checkout_session_finalized_idx ON public.store_checkout_session USING btree (finalized_transaction_id) WHERE (finalized_transaction_id IS NOT NULL);

--
-- Name: store_checkout_session_idempotency_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_checkout_session_idempotency_uidx ON public.store_checkout_session USING btree (idempotency_key);

--
-- Name: store_checkout_session_paid_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_checkout_session_paid_at_idx ON public.store_checkout_session USING btree (paid_at DESC) WHERE (paid_at IS NOT NULL);

--
-- Name: store_checkout_session_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_checkout_session_status_created_idx ON public.store_checkout_session USING btree (status, created_at DESC);

--
-- Name: store_coupons_code_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_coupons_code_lower_uidx ON public.store_coupons USING btree (lower(TRIM(BOTH FROM code)));

--
-- Name: store_media_asset_active_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_media_asset_active_created_idx ON public.store_media_asset USING btree (created_at DESC) WHERE (deleted_at IS NULL);

--
-- Name: store_pages_slug_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_pages_slug_lower_uidx ON public.store_pages USING btree (lower(slug));

--
-- Name: store_shipping_rate_quote_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_shipping_rate_quote_expires_idx ON public.store_shipping_rate_quote USING btree (expires_at);

--
-- Name: storefront_campaign_slug_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX storefront_campaign_slug_lower_uidx ON public.storefront_campaign USING btree (lower(btrim(slug)));

--
-- Name: storefront_navigation_item_menu_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storefront_navigation_item_menu_order_idx ON public.storefront_navigation_item USING btree (menu_id, sort_order, created_at);

--
-- Name: storefront_navigation_menu_handle_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX storefront_navigation_menu_handle_lower_uidx ON public.storefront_navigation_menu USING btree (lower(btrim(handle)));

--
-- Name: storefront_publish_revision_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storefront_publish_revision_page_idx ON public.storefront_publish_revision USING btree (page_id, published_at DESC);

--
-- Name: task_checklist_template_item_order_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_checklist_template_item_order_uidx ON public.task_checklist_template_item USING btree (template_id, sort_order);

--
-- Name: uq_corecard_posting_event_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_corecard_posting_event_idempotency_key ON public.corecard_posting_event USING btree (idempotency_key);

--
-- Name: uq_corecredit_event_log_external_event_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_corecredit_event_log_external_event_key ON public.corecredit_event_log USING btree (external_event_key);

--
-- Name: uq_helcim_event_log_webhook_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_helcim_event_log_webhook_id ON public.helcim_event_log USING btree (webhook_id) WHERE (webhook_id IS NOT NULL);

--
-- Name: uq_payment_provider_batches_provider_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payment_provider_batches_provider_batch ON public.payment_provider_batches USING btree (provider, provider_batch_id);

--
-- Name: uq_payment_provider_batch_transactions_provider_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payment_provider_batch_transactions_provider_transaction ON public.payment_provider_batch_transactions USING btree (provider, provider_transaction_id);

--
-- Name: uq_payment_settlement_items_active_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payment_settlement_items_active_identity ON public.payment_settlement_items USING btree (provider, item_type, COALESCE(provider_transaction_id, ''::text), COALESCE(payment_transaction_id::text, ''::text), COALESCE(provider_batch_id, ''::text)) WHERE (status = 'open'::text);

--
-- Name: uq_corecredit_exception_queue_active_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_corecredit_exception_queue_active_key ON public.corecredit_exception_queue USING btree (COALESCE((rms_record_id)::text, ''::text), COALESCE(account_id, ''::text), exception_type) WHERE (status = ANY (ARRAY['open'::text, 'retry_pending'::text, 'assigned'::text]));

--
-- Name: uq_customer_corecredit_accounts_customer_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_customer_corecredit_accounts_customer_account ON public.customer_corecredit_accounts USING btree (customer_id, corecredit_account_id);

--
-- Name: uq_customer_corecredit_accounts_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_customer_corecredit_accounts_primary ON public.customer_corecredit_accounts USING btree (customer_id) WHERE (is_primary = true);

--
-- Name: uq_payment_provider_attempts_active_device; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payment_provider_attempts_active_device ON public.payment_provider_attempts USING btree (provider, COALESCE(terminal_id, device_id)) WHERE ((status = 'pending'::text) AND (COALESCE(terminal_id, device_id) IS NOT NULL));

--
-- Name: uq_payment_provider_attempts_provider_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payment_provider_attempts_provider_idempotency ON public.payment_provider_attempts USING btree (provider, idempotency_key);

--
-- Name: ux_customer_relationship_open_child; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_customer_relationship_open_child ON public.customer_relationship_periods USING btree (child_customer_id) WHERE (unlinked_at IS NULL);

--
-- Name: ux_customer_relationship_open_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_customer_relationship_open_parent ON public.customer_relationship_periods USING btree (parent_customer_id) WHERE (unlinked_at IS NULL);

--
-- Name: vendor_brands_vendor_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vendor_brands_vendor_lower_idx ON public.vendor_brands USING btree (vendor_id, lower(brand));

--
-- Name: vendor_supplier_item_variant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_supplier_item_variant_idx ON public.vendor_supplier_item USING btree (variant_id) WHERE (variant_id IS NOT NULL);

--
-- Name: fulfillment_orders trigger_generate_ord_display_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_generate_ord_display_id BEFORE INSERT ON public.fulfillment_orders FOR EACH ROW EXECUTE FUNCTION public.generate_ord_display_id();

--
-- Name: transactions trigger_generate_txn_display_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_generate_txn_display_id BEFORE INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.generate_txn_display_id();

--
-- Name: payment_provider_attempts trigger_payment_provider_attempts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_payment_provider_attempts_updated_at BEFORE UPDATE ON public.payment_provider_attempts FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: payment_provider_batches trigger_payment_provider_batches_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_payment_provider_batches_updated_at BEFORE UPDATE ON public.payment_provider_batches FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: payment_provider_batch_transactions trigger_payment_provider_batch_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_payment_provider_batch_transactions_updated_at BEFORE UPDATE ON public.payment_provider_batch_transactions FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: payment_settlement_items trigger_payment_settlement_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_payment_settlement_items_updated_at BEFORE UPDATE ON public.payment_settlement_items FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: store_checkout_payment_attempt trigger_store_checkout_payment_attempt_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_store_checkout_payment_attempt_updated_at BEFORE UPDATE ON public.store_checkout_payment_attempt FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: store_checkout_session trigger_store_checkout_session_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_store_checkout_session_updated_at BEFORE UPDATE ON public.store_checkout_session FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: storefront_campaign trigger_storefront_campaign_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_storefront_campaign_updated_at BEFORE UPDATE ON public.storefront_campaign FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: storefront_navigation_item trigger_storefront_navigation_item_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_storefront_navigation_item_updated_at BEFORE UPDATE ON public.storefront_navigation_item FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: storefront_navigation_menu trigger_storefront_navigation_menu_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_storefront_navigation_menu_updated_at BEFORE UPDATE ON public.storefront_navigation_menu FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();

--
-- Name: wedding_non_inventory_items update_wedding_non_inventory_items_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_wedding_non_inventory_items_modtime BEFORE UPDATE ON public.wedding_non_inventory_items FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();
