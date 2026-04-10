-- Riverside OS — wipe operational / transactional data; keep bootstrap admin staff (cashier_code = '1234').
--
-- Preserves: ros_schema_migrations, store_settings (singleton), staff_role_permission seeds, qbo_integration / ledger_mappings (connection wiring).
-- Does NOT preserve: per-staff overrides, access logs, catalog, CRM, orders, register history, Counterpoint sync state.
--
-- Before running: pg_dump backup. Stop the API (and bridge) while this runs.
--
-- Apply against your DB, e.g.:
--   docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 -f scripts/ros-wipe-business-data-keep-bootstrap-admin.sql
--
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234' LIMIT 1) THEN
    RAISE EXCEPTION 'No staff row with cashier_code = 1234. Apply migrations (e.g. 53_default_admin_chris_g_pin.sql) before wiping.';
  END IF;
END $$;

-- Notifications & integration noise
DELETE FROM app_notification;
DELETE FROM morning_digest_ledger;
DELETE FROM weather_snapshot_finalize_ledger;
DELETE FROM weather_vc_daily_usage;
DELETE FROM podium_webhook_delivery;
DELETE FROM staff_auth_failure_event;
UPDATE integration_alert_state
SET
  last_failure_at = NULL,
  last_success_at = NULL,
  detail = NULL,
  updated_at = now();
UPDATE store_backup_health
SET
  last_local_success_at = NULL,
  last_local_failure_at = NULL,
  last_local_failure_detail = NULL,
  last_cloud_success_at = NULL,
  last_cloud_failure_at = NULL,
  last_cloud_failure_detail = NULL,
  updated_at = now()
WHERE id = 1;
UPDATE counterpoint_bridge_heartbeat
SET
  last_seen_at = now(),
  bridge_phase = 'idle',
  current_entity = NULL,
  bridge_version = NULL,
  bridge_hostname = NULL,
  updated_at = now()
WHERE id = 1;

DELETE FROM qbo_sync_logs;

DELETE FROM counterpoint_sync_issue;
DELETE FROM counterpoint_sync_request;
DELETE FROM counterpoint_sync_runs;
DELETE FROM counterpoint_staff_map;
DELETE FROM counterpoint_category_map;
DELETE FROM counterpoint_payment_method_map;
DELETE FROM counterpoint_gift_reason_map;
DELETE FROM counterpoint_staging_batch;

-- POS parked / RMS charge
DELETE FROM pos_parked_sale_audit;
DELETE FROM pos_parked_sale;
DELETE FROM pos_rms_charge_record;

-- Shipments
DELETE FROM shipment_event;
DELETE FROM shipment;

-- Storefront / online account
DELETE FROM order_coupon_redemptions;
DELETE FROM customer_online_credential;
DELETE FROM store_guest_cart_line;
DELETE FROM store_guest_cart;
DELETE FROM store_media_asset;

-- Suit swaps, wedding CRM extras
DELETE FROM suit_component_swap_events;
DELETE FROM wedding_insight_saved_views;
DELETE FROM wedding_appointments;

-- Tasks & schedule (rows only; functions/types remain)
DELETE FROM task_instance_item;
DELETE FROM task_instance;
DELETE FROM task_assignment;
DELETE FROM task_checklist_template_item;
DELETE FROM task_checklist_template;
DELETE FROM staff_day_exception;
DELETE FROM staff_weekly_availability;

-- Loyalty / gift cards
DELETE FROM loyalty_reward_issuances;
DELETE FROM order_loyalty_accrual;
DELETE FROM loyalty_point_ledger;
DELETE FROM gift_card_events;
DELETE FROM gift_cards;

-- Duplicate review queue (if present)
DELETE FROM customer_duplicate_review_queue;

-- Discount events (before products)
DELETE FROM discount_event_usage;
DELETE FROM discount_event_variants;
DELETE FROM discount_events;

-- Payments & sales core (order delete cascades to many children)
DELETE FROM payment_transactions;
DELETE FROM orders;

DELETE FROM register_sessions;

-- Weddings (headers cascade members)
DELETE FROM wedding_parties;

-- Customers (cascades hub notes, measurements, groups, deposits, store credit, alterations, etc.)
DELETE FROM customers;

-- Procurement & receiving
DELETE FROM receiving_events;
DELETE FROM purchase_order_lines;
DELETE FROM purchase_orders;

-- Physical inventory
DELETE FROM physical_inventory_audit;
DELETE FROM physical_inventory_counts;
DELETE FROM physical_inventory_snapshots;
DELETE FROM physical_inventory_sessions;

DELETE FROM inventory_transactions;

DELETE FROM product_bundle_components;
DELETE FROM product_variants;
DELETE FROM products;

DELETE FROM vendor_supplier_item;
DELETE FROM vendors;

-- Categories (self-FK: clear parent links first)
UPDATE categories SET parent_id = NULL WHERE parent_id IS NOT NULL;
DELETE FROM categories;

-- Staff-owned rows that block deleting non-bootstrap users
DELETE FROM staff_permission_override;
DELETE FROM staff_access_log;
DELETE FROM category_commission_overrides;
DELETE FROM category_audit_log;

-- Re-seed default customer groups (migration 42)
INSERT INTO customer_groups (code, label) VALUES
  ('vip', 'VIP'),
  ('corporate', 'Corporate'),
  ('groomsmen', 'Groomsmen')
ON CONFLICT (code) DO NOTHING;

-- Remove all staff except default bootstrap POS user
DELETE FROM staff WHERE cashier_code IS DISTINCT FROM '1234';

COMMIT;
