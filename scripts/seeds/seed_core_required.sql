-- Riverside OS core required seeds
-- Idempotent seed data. Run after schema-contract migrations.

\set ON_ERROR_STOP on

--
--



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

--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.categories (id, name, is_clothing_footwear, parent_id, created_at, matrix_row_axis_key, matrix_col_axis_key, tax_rules, variation_axis_presets) VALUES ('b7c0a001-0001-4001-8001-000000000001', 'Internal / POS', false, NULL, '2026-05-05 00:15:59.78318+00', NULL, NULL, NULL, '{}') ON CONFLICT DO NOTHING;


--
-- Data for Name: category_commission_overrides; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.category_commission_overrides (category_id, commission_rate, updated_at) VALUES ('b7c0a001-0001-4001-8001-000000000001', 0.0000, '2026-05-05 00:15:59.784563+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: counterpoint_bridge_heartbeat; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.counterpoint_bridge_heartbeat (id, last_seen_at, bridge_phase, current_entity, bridge_version, bridge_hostname, updated_at) VALUES (1, '2026-05-05 00:16:02.964244+00', 'idle', NULL, NULL, NULL, '2026-05-05 00:16:02.964244+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: counterpoint_payment_method_map; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.counterpoint_payment_method_map (id, cp_pmt_typ, ros_method, created_at) VALUES (1, 'CASH', 'cash', '2026-05-05 00:16:03.017745+00') ON CONFLICT DO NOTHING;
INSERT INTO public.counterpoint_payment_method_map (id, cp_pmt_typ, ros_method, created_at) VALUES (2, 'CHECK', 'check', '2026-05-05 00:16:03.017745+00') ON CONFLICT DO NOTHING;
INSERT INTO public.counterpoint_payment_method_map (id, cp_pmt_typ, ros_method, created_at) VALUES (3, 'CREDIT CARD', 'credit_card', '2026-05-05 00:16:03.017745+00') ON CONFLICT DO NOTHING;
INSERT INTO public.counterpoint_payment_method_map (id, cp_pmt_typ, ros_method, created_at) VALUES (4, 'DEBIT', 'credit_card', '2026-05-05 00:16:03.017745+00') ON CONFLICT DO NOTHING;
INSERT INTO public.counterpoint_payment_method_map (id, cp_pmt_typ, ros_method, created_at) VALUES (5, 'GIFT CERT', 'gift_card', '2026-05-05 00:16:03.017745+00') ON CONFLICT DO NOTHING;
INSERT INTO public.counterpoint_payment_method_map (id, cp_pmt_typ, ros_method, created_at) VALUES (6, 'ON ACCOUNT', 'on_account', '2026-05-05 00:16:03.017745+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: customer_groups; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.customer_groups (id, code, label) VALUES ('4488f3e2-888b-4eb9-9216-db331ca4672c', 'vip', 'VIP') ON CONFLICT DO NOTHING;
INSERT INTO public.customer_groups (id, code, label) VALUES ('8d8587dc-2cb2-433f-b930-66b10089bfdb', 'corporate', 'Corporate') ON CONFLICT DO NOTHING;
INSERT INTO public.customer_groups (id, code, label) VALUES ('6fdc536f-764b-4da8-afd7-bb91861c07ef', 'groomsmen', 'Groomsmen') ON CONFLICT DO NOTHING;


--
-- Data for Name: integration_alert_state; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.integration_alert_state (source, last_failure_at, last_success_at, detail, updated_at) VALUES ('qbo_token_refresh', NULL, NULL, NULL, '2026-05-05 00:15:58.040917+00') ON CONFLICT DO NOTHING;
INSERT INTO public.integration_alert_state (source, last_failure_at, last_success_at, detail, updated_at) VALUES ('weather_finalize', NULL, NULL, NULL, '2026-05-05 00:15:58.040917+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: qbo_accounts_cache; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.qbo_accounts_cache (id, name, account_type, account_number, is_active, refreshed_at) VALUES ('shipping_revenue_default', 'Shipping Revenue', 'Income', NULL, true, '2026-05-05 00:16:12.64039+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: ledger_mappings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('87270437-b1ab-49b3-ba87-ed9dc4e3fada', 'RMS_R2S_PAYMENT_CLEARING', 'R2S payment pass-through — credit offset to cash/check tenders (Due to R2S / clearing)', NULL, '2026-05-05 00:15:59.808894+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('da0381c1-3bed-4acc-89bc-3c737c14a1c2', 'INV_SHRINKAGE', 'Expense account for damaged or lost inventory (Shrinkage)', NULL, '2026-05-05 00:16:10.399852+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('c384bfdf-2c17-43e4-82c3-21f84f5fbe5b', 'INV_RTV_CLEARING', 'Clearing account for Return to Vendor items (awaiting credit/refund)', NULL, '2026-05-05 00:16:10.399852+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('59b344bf-2d51-41da-b444-3f258b9de985', 'CASH_ROUNDING', 'Rounding adjustment for cash transactions (Swedish Rounding)', NULL, '2026-05-05 00:16:14.392707+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('3d080eb0-8032-4e42-96db-c933ff8f36ea', 'RMS_CHARGE_FINANCING_CLEARING', 'Unified RMS Charge financed purchase clearing account for live CoreCard posting.', NULL, '2026-05-05 00:16:17.408258+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('855f5728-fa5d-40d9-a3b1-1de869668f99', 'REVENUE_ALTERATIONS', 'Alterations Income for charged register alteration service lines', NULL, '2026-05-05 00:16:19.861251+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('a1b2c3d4-1111-4aaa-bbbb-000000000001', 'INV_ASSET', 'Inventory asset account (merchandise on hand)', NULL, '2026-05-27 22:27:00+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('a1b2c3d4-2222-4aaa-bbbb-000000000002', 'COGS_DEFAULT', 'Default cost of goods sold account (fallback when category COGS is not mapped)', NULL, '2026-05-27 22:27:00+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('a1b2c3d4-3333-4aaa-bbbb-000000000003', 'COGS_FREIGHT', 'Inbound freight / shipping cost expense (not part of COGS — separate QBO account)', NULL, '2026-05-27 22:27:00+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ledger_mappings (id, internal_key, internal_description, qbo_account_id, updated_at) VALUES ('a1b2c3d4-4444-4aaa-bbbb-000000000004', 'INV_RECEIVING_CLEARING', 'Clearing account for received inventory before vendor bill/AP posting', NULL, '2026-05-27 22:27:00+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: meilisearch_sync_status; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_variants', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_store_products', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_customers', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_wedding_parties', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_help', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_staff', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_vendors', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_categories', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_appointments', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_tasks', NULL, '2026-05-05 00:16:09.996193+00', 0, false, NULL, '2026-05-05 00:16:09.996193+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_transactions', NULL, '2026-05-05 00:16:20.328422+00', 0, false, NULL, '2026-05-05 00:16:20.328422+00') ON CONFLICT DO NOTHING;
INSERT INTO public.meilisearch_sync_status (index_name, last_success_at, last_attempt_at, row_count, is_success, error_message, updated_at) VALUES ('ros_orders', NULL, '2026-05-05 00:16:20.523334+00', 0, false, NULL, '2026-05-05 00:16:20.523334+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: nuorder_sync_state; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.nuorder_sync_state (id, last_catalog_sync_at, last_order_sync_at, last_inventory_sync_at) VALUES (1, NULL, NULL, NULL) ON CONFLICT DO NOTHING;


--
-- Data for Name: ops_alert_rule; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ops_alert_rule (id, rule_key, title, severity, enabled, suppress_minutes, channel_inbox, channel_email, channel_sms, created_at, updated_at) VALUES ('e9451e30-a37e-4d77-8b55-f0c4c378ee88', 'integration_qbo_failure', 'QBO integration failure', 'critical', true, 60, true, true, true, '2026-05-05 00:16:16.442686+00', '2026-05-05 00:16:16.442686+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ops_alert_rule (id, rule_key, title, severity, enabled, suppress_minutes, channel_inbox, channel_email, channel_sms, created_at, updated_at) VALUES ('55d5c975-017f-4bd2-ac9b-1b8580672e30', 'integration_weather_failure', 'Weather integration failure', 'warning', true, 120, true, true, false, '2026-05-05 00:16:16.442686+00', '2026-05-05 00:16:16.442686+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ops_alert_rule (id, rule_key, title, severity, enabled, suppress_minutes, channel_inbox, channel_email, channel_sms, created_at, updated_at) VALUES ('27905ec8-903e-4343-b82d-6bac79005b68', 'backup_overdue', 'Database backup overdue', 'critical', true, 180, true, true, true, '2026-05-05 00:16:16.442686+00', '2026-05-05 00:16:16.442686+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ops_alert_rule (id, rule_key, title, severity, enabled, suppress_minutes, channel_inbox, channel_email, channel_sms, created_at, updated_at) VALUES ('dcd0e99a-5398-45d7-aa54-dec18eb77397', 'counterpoint_sync_stale', 'Counterpoint sync stale', 'warning', true, 180, true, true, false, '2026-05-05 00:16:16.442686+00', '2026-05-05 00:16:16.442686+00') ON CONFLICT DO NOTHING;
INSERT INTO public.ops_alert_rule (id, rule_key, title, severity, enabled, suppress_minutes, channel_inbox, channel_email, channel_sms, created_at, updated_at) VALUES ('b6a10a3b-aa21-4f2b-9caa-3f5f58f914db', 'station_offline', 'Register workstation offline', 'warning', true, 30, true, false, false, '2026-05-05 00:16:16.442686+00', '2026-05-05 00:16:16.442686+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.products (id, category_id, catalog_handle, name, brand, description, base_retail_price, base_cost, spiff_amount, variation_axes, images, is_active, created_at, primary_vendor_id, excludes_from_loyalty, is_bundle, track_low_stock, pos_line_kind, data_source, tax_category, employee_markup_percent, employee_extra_amount, nuorder_last_image_sync_at, tax_category_override) VALUES ('b7c0a002-0002-4002-8002-000000000002', 'b7c0a001-0001-4001-8001-000000000001', 'ros-rms-charge-payment', 'RMS CHARGE PAYMENT', 'Riverside OS', 'R2S payment collection — add via Register search PAYMENT; enter amount on keypad.', 0.00, 0.00, 0.00, '{}', '{}', true, '2026-05-05 00:15:59.786011+00', NULL, true, false, false, 'rms_charge_payment', NULL, 'clothing', NULL, 0.00, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.products (id, category_id, catalog_handle, name, brand, description, base_retail_price, base_cost, spiff_amount, variation_axes, images, is_active, created_at, primary_vendor_id, excludes_from_loyalty, is_bundle, track_low_stock, pos_line_kind, data_source, tax_category, employee_markup_percent, employee_extra_amount, nuorder_last_image_sync_at, tax_category_override) VALUES ('b7c0a004-0004-4004-8004-000000000004', 'b7c0a001-0001-4001-8001-000000000001', 'ros-pos-gift-card-load', 'POS GIFT CARD LOAD', 'Riverside OS', 'Register gift card value — add from Gift Card button; credit applies when the sale is fully paid.', 0.00, 0.00, 0.00, '{}', '{}', true, '2026-05-05 00:16:02.132765+00', NULL, true, false, false, 'pos_gift_card_load', NULL, 'clothing', NULL, 0.00, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.products (id, category_id, catalog_handle, name, brand, description, base_retail_price, base_cost, spiff_amount, variation_axes, images, is_active, created_at, primary_vendor_id, excludes_from_loyalty, is_bundle, track_low_stock, pos_line_kind, data_source, tax_category, employee_markup_percent, employee_extra_amount, nuorder_last_image_sync_at, tax_category_override) VALUES ('b7c0a006-0006-4006-8006-000000000006', 'b7c0a001-0001-4001-8001-000000000001', 'ros-alteration-service', 'ALTERATION SERVICE', 'Riverside OS', 'Register alteration work-order service line. The source garment is tracked separately and is not sold again.', 0.00, 0.00, 0.00, '{}', '{}', true, '2026-05-05 00:16:19.856558+00', NULL, true, false, false, 'alteration_service', NULL, 'clothing', NULL, 0.00, NULL, NULL) ON CONFLICT DO NOTHING;


--
-- Data for Name: product_variants; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.product_variants (id, product_id, sku, variation_values, variation_label, stock_on_hand, reorder_point, images, retail_price_override, cost_override, created_at, shelf_labeled_at, barcode, reserved_stock, vendor_upc, counterpoint_item_key, track_low_stock, web_published, web_price_override, web_gallery_order, counterpoint_prc_2, counterpoint_prc_3, nuorder_id, on_layaway, default_location_id) VALUES ('b7c0a003-0003-4003-8003-000000000003', 'b7c0a002-0002-4002-8002-000000000002', 'ROS-RMS-CHARGE-PAYMENT', '{}', NULL, 0, 0, '{}', NULL, NULL, '2026-05-05 00:15:59.788059+00', NULL, NULL, 0, NULL, NULL, false, false, NULL, 0, NULL, NULL, NULL, 0, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.product_variants (id, product_id, sku, variation_values, variation_label, stock_on_hand, reorder_point, images, retail_price_override, cost_override, created_at, shelf_labeled_at, barcode, reserved_stock, vendor_upc, counterpoint_item_key, track_low_stock, web_published, web_price_override, web_gallery_order, counterpoint_prc_2, counterpoint_prc_3, nuorder_id, on_layaway, default_location_id) VALUES ('b7c0a005-0005-4005-8005-000000000005', 'b7c0a004-0004-4004-8004-000000000004', 'ROS-POS-GIFT-CARD-LOAD', '{}', NULL, 0, 0, '{}', NULL, NULL, '2026-05-05 00:16:02.134647+00', NULL, NULL, 0, NULL, NULL, false, false, NULL, 0, NULL, NULL, NULL, 0, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.product_variants (id, product_id, sku, variation_values, variation_label, stock_on_hand, reorder_point, images, retail_price_override, cost_override, created_at, shelf_labeled_at, barcode, reserved_stock, vendor_upc, counterpoint_item_key, track_low_stock, web_published, web_price_override, web_gallery_order, counterpoint_prc_2, counterpoint_prc_3, nuorder_id, on_layaway, default_location_id) VALUES ('b7c0a007-0007-4007-8007-000000000007', 'b7c0a006-0006-4006-8006-000000000006', 'ROS-ALTERATION-SERVICE', '{}', NULL, 0, 0, '{}', NULL, NULL, '2026-05-05 00:16:19.858813+00', NULL, NULL, 0, NULL, NULL, false, false, NULL, 0, NULL, NULL, NULL, 0, NULL) ON CONFLICT DO NOTHING;


--
-- Data for Name: qbo_mappings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.qbo_mappings (id, source_type, source_id, qbo_account_id, qbo_account_name, updated_at) VALUES ('cae2e799-7e47-4c69-a566-fa9d8d693b32', 'income_shipping', 'default', 'shipping_revenue_default', 'Shipping Revenue', '2026-05-05 00:16:12.648492+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: store_backup_health; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.store_backup_health (id, last_local_success_at, last_local_failure_at, last_local_failure_detail, last_cloud_success_at, last_cloud_failure_at, last_cloud_failure_detail, updated_at) VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, '2026-05-05 00:15:57.840852+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: store_pages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.store_pages (id, slug, title, seo_title, published, project_json, published_html, updated_at, created_at) VALUES ('82e80d8a-92d6-4cc7-bf9e-44c17817a967', 'home', 'Home', 'Welcome', true, '{}', '<section class="ros-store-page"><h1>Welcome</h1><p>Browse our catalog online.</p><p><a href="/shop/products">View products</a></p></section>', '2026-05-05 00:16:00.637637+00', '2026-05-05 00:16:00.637637+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: store_settings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.store_settings (id, employee_markup_percent, loyalty_point_threshold, loyalty_reward_amount, receipt_config, backup_settings, weather_config, staff_sop_markdown, podium_sms_config, shippo_config, insights_config, counterpoint_config, review_policy, nuorder_config, loyalty_letter_template, rosie_config, environment_mode, active_card_provider, storefront_home_layout) VALUES (1, 15.00, 5000, 50.00, '{"show_email": false, "show_phone": true, "store_name": "Riverside OS", "footer_lines": ["Thank you for shopping with us!", "Visit us again soon."], "header_lines": [], "show_address": true, "show_barcode": false, "show_loyalty_earned": true, "show_loyalty_balance": true}', '{"cloud_region": "us-east-1", "schedule_cron": "0 2 * * *", "cloud_endpoint": "", "auto_cleanup_days": 30, "cloud_bucket_name": "", "cloud_storage_enabled": false}', '{}', '', '{}', '{}', '{}', '{}', '{"review_invites_enabled": true, "send_review_invite_by_default": true}', '{}', 'Dear {{first_name}},

Congratulations! Your loyalty to Riverside has earned you a ${{reward_amount}} reward.

We have loaded this reward onto a personalized gift card for you:
CODE: {{card_code}}

Thank you for being part of our community. We look ahead to seeing you again soon!

Best regards,
The Riverside Team', '{}', 'development', 'helcim', '[]')
ON CONFLICT DO NOTHING;


--
-- Data for Name: store_tax_state_rate; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.store_tax_state_rate (state_code, combined_rate, updated_at) VALUES ('NY', 0.087500, '2026-05-05 00:16:00.635508+00') ON CONFLICT DO NOTHING;
INSERT INTO public.store_tax_state_rate (state_code, combined_rate, updated_at) VALUES ('PA', 0.060000, '2026-05-05 00:16:00.635508+00') ON CONFLICT DO NOTHING;
INSERT INTO public.store_tax_state_rate (state_code, combined_rate, updated_at) VALUES ('OH', 0.057500, '2026-05-05 00:16:00.635508+00') ON CONFLICT DO NOTHING;
INSERT INTO public.store_tax_state_rate (state_code, combined_rate, updated_at) VALUES ('CA', 0.072500, '2026-05-05 00:16:00.635508+00') ON CONFLICT DO NOTHING;
INSERT INTO public.store_tax_state_rate (state_code, combined_rate, updated_at) VALUES ('TX', 0.062500, '2026-05-05 00:16:00.635508+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: storefront_navigation_menu; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.storefront_navigation_menu (id, handle, title, created_at, updated_at) VALUES ('0f2e609a-cab4-422b-a8a9-c7592f8c18e8', 'header', 'Header', '2026-05-05 00:16:25.539629+00', '2026-05-05 00:16:25.539629+00') ON CONFLICT DO NOTHING;
INSERT INTO public.storefront_navigation_menu (id, handle, title, created_at, updated_at) VALUES ('762c1598-721e-42c8-90d5-34e44023162a', 'footer', 'Footer', '2026-05-05 00:16:25.539629+00', '2026-05-05 00:16:25.539629+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: storefront_navigation_item; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.storefront_navigation_item (id, menu_id, label, url, item_kind, sort_order, is_active, created_at, updated_at) VALUES ('8999c763-c6f9-4165-9850-c6a03729aa32', '0f2e609a-cab4-422b-a8a9-c7592f8c18e8', 'Cart', '/shop/cart', 'custom', 20, true, '2026-05-05 00:16:25.54155+00', '2026-05-05 00:16:25.54155+00') ON CONFLICT DO NOTHING;
INSERT INTO public.storefront_navigation_item (id, menu_id, label, url, item_kind, sort_order, is_active, created_at, updated_at) VALUES ('5196c3d2-ace3-47e6-b868-8c13f2722b30', '0f2e609a-cab4-422b-a8a9-c7592f8c18e8', 'Products', '/shop/products', 'custom', 10, true, '2026-05-05 00:16:25.54155+00', '2026-05-05 00:16:25.54155+00') ON CONFLICT DO NOTHING;
INSERT INTO public.storefront_navigation_item (id, menu_id, label, url, item_kind, sort_order, is_active, created_at, updated_at) VALUES ('0f6365a0-3eeb-47cd-81c8-6c09d9cc16e4', '762c1598-721e-42c8-90d5-34e44023162a', 'Account', '/shop/account', 'custom', 10, true, '2026-05-05 00:16:25.54155+00', '2026-05-05 00:16:25.54155+00') ON CONFLICT DO NOTHING;


--
-- Data for Name: weather_snapshot_finalize_ledger; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.weather_snapshot_finalize_ledger (id, last_completed_store_date) VALUES (1, '1970-01-01') ON CONFLICT DO NOTHING;


--
-- Name: counterpoint_payment_method_map_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.counterpoint_payment_method_map_id_seq', 6, true);


--
--
