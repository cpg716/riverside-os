-- Builds tmp_ros_migration_probes. Chained before status_select or backfill_insert in same psql session.
-- Extend the VALUES list when adding migrations/NN_*.sql; latest probe must match the highest NN in migrations/.

\set ON_ERROR_STOP on

DROP TABLE IF EXISTS tmp_ros_migration_probes;
CREATE TEMP TABLE tmp_ros_migration_probes (
    migration_version TEXT PRIMARY KEY,
    probe_ok          BOOLEAN NOT NULL,
    probe_hint        TEXT NOT NULL
);

INSERT INTO tmp_ros_migration_probes
SELECT *
FROM (
    SELECT * FROM (VALUES
        ('00_ros_migration_ledger.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations')),
         'table ros_schema_migrations'),
        ('01_initial_schema.sql',
         (SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fulfillment_type')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'orders')),
         'enum fulfillment_type + table orders'),
        ('02_z_report_register_sessions.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'register_sessions' AND column_name = 'discrepancy')),
         'column register_sessions.discrepancy'),
        ('03_qbo_ledger_mappings.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'qbo_integration')),
         'table qbo_integration'),
        ('04_category_audit_log.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'category_audit_log')),
         'table category_audit_log'),
        ('05_product_catalog_handle.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'catalog_handle')),
         'column products.catalog_handle'),
        ('06_wedding_manager_integration.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wedding_members')),
         'table wedding_members'),
        ('07_wedding_manager_full_parity.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wedding_appointments')),
         'table wedding_appointments'),
        ('08_customer_profile_marketing.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'marketing_email_opt_in')),
         'column customers.marketing_email_opt_in'),
        ('09_global_action_log.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wedding_activity_log')),
         'table wedding_activity_log'),
        ('10_category_matrix_axes.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'matrix_row_axis_key')),
         'column categories.matrix_row_axis_key'),
        ('11_customer_hub.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_timeline_notes')),
         'table customer_timeline_notes'),
        ('12_shelf_label_tracking.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'shelf_labeled_at')),
         'column product_variants.shelf_labeled_at'),
        ('13_procurement_engine.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'is_active')),
         'column vendors.is_active'),
        ('14_commission_payout.sql',
         (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('order_items', 'transaction_lines')
              AND column_name = 'commission_payout_finalized_at'
         )),
         'column order_items|transaction_lines.commission_payout_finalized_at'),
        ('15_register_session_lifecycle.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'register_cash_adjustments')),
         'table register_cash_adjustments'),
        ('16_order_attribution_audit.sql',
         (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('order_attribution_audit', 'transaction_attribution_audit')
         )),
         'table order_attribution_audit|transaction_attribution_audit'),
        ('17_staff_authority.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_access_log')),
         'table staff_access_log'),
        ('18_qbo_financial_bridge.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'qbo_mappings')),
         'table qbo_mappings'),
        ('19_checkout_ledger_signals.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_transactions' AND column_name = 'metadata')),
         'column payment_transactions.metadata'),
        ('20_compat_schema_backfill.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wedding_parties' AND column_name = 'party_name')),
         'column wedding_parties.party_name'),
        ('21_orders_audit_and_refund_queue.sql',
         (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('order_refund_queue', 'transaction_refund_queue')
         )),
         'table order_refund_queue|transaction_refund_queue'),
        ('22_product_variant_barcode.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'barcode')),
         'column product_variants.barcode'),
        ('23_gift_cards_and_loyalty.sql',
         (SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gift_card_kind')),
         'enum gift_card_kind'),
        ('24_performance_and_integrity.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'reserved_stock')),
         'column product_variants.reserved_stock'),
        ('25_backup_settings.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_settings' AND column_name = 'backup_settings')),
         'column store_settings.backup_settings'),
        ('26_physical_inventory_and_scanning.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'physical_inventory_sessions')),
         'table physical_inventory_sessions'),
        ('27_golden_rule_accounting.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'register_sessions' AND column_name = 'weather_snapshot')),
         'column register_sessions.weather_snapshot'),
        ('28_customer_profile_and_code.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_code')),
         'column customers.customer_code'),
        ('29_counterpoint_sync.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'counterpoint_sync_runs')),
         'table counterpoint_sync_runs'),
        ('30_fulfillment_wedding_order.sql',
         (SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'fulfillment_type' AND e.enumlabel = 'wedding_order')),
         'enum label fulfillment_type.wedding_order'),
        ('31_customers_is_active.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'is_active')),
         'column customers.is_active'),
        ('32_customers_phone_width.sql',
         (SELECT COALESCE(
            (SELECT (c.data_type = 'text')
                OR (c.character_maximum_length IS NOT NULL AND c.character_maximum_length >= 64)
             FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'customers' AND c.column_name = 'phone'),
            FALSE)),
         'customers.phone VARCHAR(64)+ or TEXT'),
        ('33_wedding_appointments_walk_in.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wedding_appointments' AND column_name = 'customer_id')),
         'column wedding_appointments.customer_id'),
        ('34_staff_contacts_and_permissions.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_permission_override')),
         'table staff_permission_override'),
        ('35_vendors_vendor_code.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'vendor_code')),
         'column vendors.vendor_code'),
        ('36_orders_rbac_permissions.sql',
         (SELECT EXISTS (SELECT 1 FROM staff_role_permission WHERE permission_key = 'orders.view')),
         'staff_role_permission orders.view seed'),
        ('37_order_returns_and_exchange.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'order_return_lines')),
         'table order_return_lines'),
        ('38_register_pos_token_and_checkout_idempotency.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'checkout_client_id')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'register_sessions' AND column_name = 'pos_api_token')),
         'orders.checkout_client_id + register_sessions.pos_api_token'),
        ('39_extended_rbac_catalog.sql',
         (SELECT EXISTS (SELECT 1 FROM staff_role_permission WHERE permission_key = 'catalog.view')),
         'staff_role_permission catalog.view seed'),
        ('40_staff_role_pricing_limits.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_role_pricing_limits')),
         'table staff_role_pricing_limits'),
        ('41_discount_events.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'discount_events')),
         'table discount_events'),
        ('42_roadmap_features.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'alteration_orders')),
         'table alteration_orders'),
        ('43_measurement_retail_and_rbac.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customer_measurements' AND column_name = 'retail_suit')),
         'column customer_measurements.retail_suit'),
        ('44_discount_usage_wedding_views_alteration_audit.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'discount_event_usage')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wedding_insight_saved_views')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'alteration_activity')),
         'tables discount_event_usage + wedding_insight_saved_views + alteration_activity'),
        ('45_remove_staff_mfa.sql',
         (SELECT NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_mfa_sessions')
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'mfa_enabled')),
         'staff MFA artifacts removed'),
        ('46_weather_config.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_settings' AND column_name = 'weather_config')),
         'column store_settings.weather_config'),
        ('47_weather_snapshot_finalize_ledger.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weather_snapshot_finalize_ledger')),
         'table weather_snapshot_finalize_ledger'),
        ('48_weather_vc_daily_usage.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weather_vc_daily_usage')),
         'table weather_vc_daily_usage'),
        ('49_orders_void_sale_permission.sql',
         (SELECT EXISTS (SELECT 1 FROM staff_role_permission WHERE permission_key = 'orders.void_sale')),
         'staff_role_permission orders.void_sale seed'),
        ('50_suit_component_swap_register_open_drawer.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'suit_component_swap_events')),
         'table suit_component_swap_events'),
        ('51_app_notifications.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_notification')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_notification')),
         'tables app_notification + staff_notification'),
        ('52_track_low_stock_morning_digest.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'track_low_stock')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'track_low_stock')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'morning_digest_ledger')),
         'track_low_stock columns + morning_digest_ledger'),
        ('53_default_admin_chris_g_pin.sql',
         (SELECT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234' AND role = 'admin'::staff_role AND pin_hash IS NOT NULL)),
         'staff 1234 admin with pin_hash'),
        ('54_staff_avatar_key.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'avatar_key')),
         'column staff.avatar_key'),
        ('55_register_shift_primary.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'register_sessions' AND column_name = 'shift_primary_staff_id')),
         'column register_sessions.shift_primary_staff_id'),
        ('56_staff_tasks.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'task_instance')
          AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_recurrence')),
         'table task_instance + enum task_recurrence'),
        ('57_staff_schedule.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_day_exception')
          AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'staff_effective_working_day')),
         'table staff_day_exception + function staff_effective_working_day'),
        ('58_staff_schedule_comments.sql',
         (SELECT COALESCE(
            (SELECT obj_description(p.oid, 'pg_proc') IS NOT NULL AND length(trim(obj_description(p.oid, 'pg_proc'))) > 0
             FROM pg_proc p
             WHERE p.proname = 'staff_effective_working_day'
             ORDER BY p.oid
             LIMIT 1),
            FALSE)),
         'COMMENT ON staff_effective_working_day (pg_proc description set)'),
        ('59_store_staff_sop_markdown.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_settings' AND column_name = 'staff_sop_markdown')),
         'column store_settings.staff_sop_markdown'),
        ('60_store_backup_health.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_backup_health')),
         'table store_backup_health'),
        ('61_notification_integration_extras.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'integration_alert_state')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_auth_failure_event')),
         'tables integration_alert_state + staff_auth_failure_event'),
        ('62_ai_platform.sql',
         (SELECT
            (
              EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_doc_chunk')
              AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_saved_report')
            )
            OR
            (
              NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_doc_chunk')
              AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_saved_report')
            )
         ),
         'tables ai_doc_chunk + ai_saved_report (or retired by migration 78)'),
        ('63_customer_hub_rbac.sql',
         (SELECT EXISTS (
            SELECT 1 FROM staff_role_permission
            WHERE permission_key = 'customers.hub_view' AND role = 'salesperson' AND allowed = true)),
         'staff_role_permission customers.hub_view for salesperson'),
        ('64_cashier_customer_duplicate_merge_rbac.sql',
         (SELECT EXISTS (
            SELECT 1 FROM staff_role_permission
            WHERE permission_key = 'customers_duplicate_review' AND role = 'salesperson' AND allowed = true)
          AND EXISTS (
            SELECT 1 FROM staff_role_permission
            WHERE permission_key = 'customers.merge' AND role = 'salesperson' AND allowed = true)),
         'salesperson customers_duplicate_review + customers.merge'),
        ('65_ai_doc_trgm.sql',
         (SELECT
            (
              EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_doc_chunk')
              AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_ai_doc_chunk_content_trgm')
            )
            OR
            (
              NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_doc_chunk')
              AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_ai_doc_chunk_content_trgm')
            )
         ),
         'idx_ai_doc_chunk_content_trgm present with ai_doc_chunk, or both retired'),
        ('66_register_session_lanes.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'register_sessions' AND column_name = 'register_lane')
          AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'register_sessions_open_lane_uidx')),
         'column register_sessions.register_lane + index register_sessions_open_lane_uidx'),
        ('67_register_till_close_group.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'register_sessions' AND column_name = 'till_close_group_id')
          AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'register_sessions_open_till_group_idx')),
         'column register_sessions.till_close_group_id + index register_sessions_open_till_group_idx'),
        ('68_pos_parked_and_rms_charge_audit.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pos_parked_sale')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pos_rms_charge_record')),
         'tables pos_parked_sale + pos_rms_charge_record'),
        ('69_rms_charge_payment_line.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'pos_line_kind')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pos_rms_charge_record' AND column_name = 'record_kind')),
         'products.pos_line_kind + pos_rms_charge_record.record_kind'),
        ('70_podium_sms_config.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_settings' AND column_name = 'podium_sms_config')),
         'column store_settings.podium_sms_config'),
        ('71_podium_webhook_transactional_sms.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'transactional_sms_opt_in')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'podium_webhook_delivery')),
         'customers.transactional_sms_opt_in + table podium_webhook_delivery'),
        ('72_podium_email_transactional_loyalty.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'transactional_email_opt_in')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'podium_conversation_url')),
         'customers.transactional_email_opt_in + customers.podium_conversation_url'),
        ('73_online_store_module.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sale_channel')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_pages')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_coupons')),
         'orders.sale_channel + tables store_pages + store_coupons'),
        ('74_shippo_shipping_foundation.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'fulfillment_method')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_settings' AND column_name = 'shippo_config')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_shipping_rate_quote')),
         'orders.fulfillment_method + store_settings.shippo_config + store_shipping_rate_quote'),
        ('75_unified_shipments_hub.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shipment')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shipment_event')),
         'tables shipment + shipment_event'),
        ('76_store_guest_cart_and_media_assets.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_guest_cart')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_media_asset')),
         'store_guest_cart + store_media_asset'),
        ('77_customer_online_account.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_created_source')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_online_credential')),
         'customers.customer_created_source + customer_online_credential'),
        ('78_retire_ros_ai_tables.sql',
         (SELECT NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_doc_chunk')
          AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_saved_report')
          AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')),
         'ai_doc_chunk + ai_saved_report dropped; vector extension removed'),
        ('79_help_manual_policy.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'help_manual_policy')
          AND EXISTS (SELECT 1 FROM staff_role_permission WHERE permission_key = 'help.manage')),
         'help_manual_policy + help.manage RBAC seed'),
        ('80_pos_gift_card_load_line.sql',
         (SELECT EXISTS (
              SELECT 1 FROM products
              WHERE catalog_handle = 'ros-pos-gift-card-load'
                AND pos_line_kind = 'pos_gift_card_load'
          )),
         'products ros-pos-gift-card-load + pos_gift_card_load'),
        ('81_order_items_variant_search_rank.sql',
         (SELECT EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public'
                AND indexname = 'idx_order_items_variant_id'
          )),
         'index idx_order_items_variant_id on order_items(variant_id)'),
        ('82_order_items_product_id_search_rank.sql',
         (SELECT EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public'
                AND indexname = 'idx_order_items_product_id'
          )),
         'index idx_order_items_product_id on order_items(product_id)'),
        ('83_customer_open_deposit.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name = 'customer_open_deposit_accounts'
          )),
         'table customer_open_deposit_accounts'),
        ('84_counterpoint_sync_extended.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'counterpoint_bridge_heartbeat')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'counterpoint_sync_request')
          AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'counterpoint_sync_issue')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'counterpoint_ticket_ref')),
         'counterpoint heartbeat + sync_request + sync_issue + orders.counterpoint_ticket_ref'),
        ('85_counterpoint_provenance.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'data_source')
          AND EXISTS (
              SELECT 1 FROM information_schema.check_constraints
              WHERE constraint_name = 'customers_created_source_chk'
                AND check_clause LIKE '%counterpoint%'
          )),
         'products.data_source + customers_created_source_chk includes counterpoint'),
        ('86_counterpoint_staff_sync.sql',
         (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'counterpoint_staff_map')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'data_source')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'preferred_salesperson_id')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'processed_by_staff_id')),
         'counterpoint_staff_map + staff.data_source + customers.preferred_salesperson_id + orders.processed_by_staff_id'),
        ('87_products_tax_category.sql',
         (SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tax_category')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'tax_category')),
         'enum tax_category + products.tax_category'),
        ('88_vendors_payment_terms.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'payment_terms'
          )),
         'column vendors.payment_terms'),
        ('89_counterpoint_vendor_item_loyalty.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'vendor_supplier_item'
          )),
         'table vendor_supplier_item + loyalty_point_ledger_cp_ps_loy_ref_uidx'),
        ('90_reporting_insights.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.schemata
              WHERE schema_name = 'reporting'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'store_settings' AND column_name = 'insights_config'
          )),
         'schema reporting + store_settings.insights_config'),
        ('91_counterpoint_open_docs.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'counterpoint_doc_ref'
          )),
         'orders.counterpoint_doc_ref + partial unique index'),
        ('92_counterpoint_category_masters_prc_tiers.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'counterpoint_prc_2'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'counterpoint_prc_3'
          )),
         'product_variants.counterpoint_prc_2 + counterpoint_prc_3'),
        ('93_employee_pricing_per_product_promo_scope.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'employee_extra_amount'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'discount_events' AND column_name = 'scope_type'
          )),
         'products employee sale overrides + discount_events scope'),
        ('94_store_settings_employee_markup_default_15.sql',
         (SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_description d
              INNER JOIN pg_catalog.pg_class c ON c.oid = d.objoid AND c.relname = 'store_settings'
              INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
              INNER JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
              WHERE a.attname = 'employee_markup_percent' AND NOT a.attisdropped
                AND d.description LIKE '%employee sale unit price%'
          )),
         'COMMENT ON store_settings.employee_markup_percent (migration 94)'),
        ('95_counterpoint_staging_gui.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'store_settings'
                AND column_name = 'counterpoint_config'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'counterpoint_staging_batch'
          )),
         'store_settings.counterpoint_config + counterpoint_staging_batch'),
        ('96_reporting_business_day_geo_loyalty.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.routines
              WHERE routine_schema = 'reporting'
                AND routine_name = 'effective_store_timezone'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'reporting'
                AND table_name = 'daily_order_totals'
                AND column_name = 'order_business_date'
          )),
         'reporting.effective_store_timezone + business-day totals + geo/loyalty views'),
        ('97_staff_profile_permissions_and_employment.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'staff_permission'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'staff'
                AND column_name = 'max_discount_percent'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'staff'
                AND column_name = 'employee_customer_id'
          )),
         'staff_permission + per-staff max_discount_percent + employment + employee_customer_id'),
        ('98_shipment_shippo_rate_ref.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'shipment'
                AND column_name = 'shippo_rate_object_id'
          )),
         'column shipment.shippo_rate_object_id'),
        ('99_podium_messaging_reviews.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'podium_conversation'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'podium_message'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'orders'
                AND column_name = 'review_invite_sent_at'
          )),
         'podium_conversation + podium_message + orders review invite columns'),
        ('100_store_review_policy.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'store_settings'
                AND column_name = 'review_policy'
          )),
         'column store_settings.review_policy'),
        ('101_staff_bug_reports.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'staff_bug_report'
          )),
         'table staff_bug_report'),
        ('102_bug_report_server_log_snapshot.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'staff_bug_report'
                AND column_name = 'server_log_snapshot'
          )),
         'column staff_bug_report.server_log_snapshot'),
        ('103_staff_bug_report_triage.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'staff_bug_report'
                AND column_name = 'correlation_id'
          )),
         'column staff_bug_report.correlation_id'),
        ('104_podium_message_sender_name.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'podium_message'
                AND column_name = 'podium_sender_name'
          )),
         'column podium_message.podium_sender_name'),
        ('105_store_register_eod_snapshot.sql',
         (SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'store_register_eod_snapshot'
          )),
         'table store_register_eod_snapshot'),
        ('106_reporting_order_recognition.sql',
         (SELECT EXISTS (
              SELECT 1
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'reporting'
                AND p.proname = 'order_recognition_at'
          )),
         'function reporting.order_recognition_at'),
        ('107_reporting_order_lines_margin.sql',
         (SELECT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'reporting'
                AND table_name = 'order_lines'
                AND column_name = 'line_gross_margin_pre_tax'
          )),
         'column reporting.order_lines.line_gross_margin_pre_tax')
    ) AS t(migration_version, probe_ok, probe_hint)
) AS v;
