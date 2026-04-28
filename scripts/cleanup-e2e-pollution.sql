-- scripts/cleanup-e2e-pollution.sql
-- Purge E2E test data from all tables across the schema.
BEGIN;

-- 1. Identify E2E IDs
CREATE TEMP TABLE e2e_staff_ids AS SELECT id FROM staff WHERE cashier_code IN ('5678', '2468', '1357', '9999');
CREATE TEMP TABLE e2e_customer_ids AS SELECT id FROM customers WHERE first_name IN ('Paige', 'Iris', 'Morgan', 'Charlie', 'Casey', 'Avery', 'Riley', 'Alex', 'Groom Charlie') OR email LIKE '%example.com' OR email LIKE '%test.com';
CREATE TEMP TABLE e2e_gift_card_ids AS SELECT id FROM gift_cards WHERE code LIKE 'E2E-GC-%' OR code LIKE 'GC-PAID-%' OR code LIKE 'GC-DONATED-%' OR code LIKE 'GC-LOWBAL-%' OR code LIKE 'GC-BO-BLOCKED-%';
CREATE TEMP TABLE e2e_category_ids AS SELECT id FROM categories WHERE name LIKE 'E2E Inventory%';
CREATE TEMP TABLE e2e_product_ids AS SELECT id FROM products WHERE name LIKE 'Inventory Audit%' OR name LIKE 'E2E%';
CREATE TEMP TABLE e2e_variant_ids AS SELECT id FROM product_variants WHERE sku LIKE 'INV-AUD%' OR sku LIKE 'COMM-%' OR sku LIKE 'GC-%' OR product_id IN (SELECT id FROM e2e_product_ids);
CREATE TEMP TABLE e2e_vendor_ids AS SELECT id FROM vendors WHERE name LIKE 'E2E%' OR name LIKE 'VND-%';

-- 2. Identify E2E Transaction and RMS Records
CREATE TEMP TABLE e2e_transaction_ids AS 
  SELECT DISTINCT transaction_id FROM transaction_lines WHERE variant_id IN (SELECT id FROM e2e_variant_ids)
  UNION
  SELECT id FROM transactions WHERE customer_id IN (SELECT id FROM e2e_customer_ids);

CREATE TEMP TABLE e2e_rms_record_ids AS
  SELECT id FROM pos_rms_charge_record WHERE transaction_id IN (SELECT id FROM e2e_transaction_ids)
  OR customer_id IN (SELECT id FROM e2e_customer_ids);

-- 3. Cleanup CoreCredit / CoreCard
DELETE FROM corecredit_exception_queue WHERE rms_record_id IN (SELECT id FROM e2e_rms_record_ids) OR account_id LIKE 'CC-E2E%';
DELETE FROM corecard_posting_event WHERE pos_rms_charge_record_id IN (SELECT id FROM e2e_rms_record_ids);
DELETE FROM corecredit_event_log WHERE related_rms_record_id IN (SELECT id FROM e2e_rms_record_ids);
DELETE FROM corecredit_reconciliation_item WHERE rms_record_id IN (SELECT id FROM e2e_rms_record_ids);

-- 4. Cleanup Gift Cards
DELETE FROM gift_card_events WHERE gift_card_id IN (SELECT id FROM e2e_gift_card_ids);
DELETE FROM gift_cards WHERE id IN (SELECT id FROM e2e_gift_card_ids);

-- 5. Cleanup Transactions and Payments
DELETE FROM pos_rms_charge_record WHERE id IN (SELECT id FROM e2e_rms_record_ids);
DELETE FROM payment_allocations WHERE target_transaction_id IN (SELECT id FROM e2e_transaction_ids);
DELETE FROM transaction_lines WHERE transaction_id IN (SELECT id FROM e2e_transaction_ids);
DELETE FROM transactions WHERE id IN (SELECT id FROM e2e_transaction_ids);
DELETE FROM payment_transactions WHERE payer_id IN (SELECT id FROM e2e_customer_ids);

-- 6. Cleanup Inventory
DELETE FROM inventory_transactions WHERE variant_id IN (SELECT id FROM e2e_variant_ids);
DELETE FROM purchase_order_lines WHERE variant_id IN (SELECT id FROM e2e_variant_ids);
DELETE FROM purchase_orders WHERE vendor_id IN (SELECT id FROM e2e_vendor_ids);
DELETE FROM product_variants WHERE id IN (SELECT id FROM e2e_variant_ids);
DELETE FROM products WHERE id IN (SELECT id FROM e2e_product_ids);
DELETE FROM category_audit_log WHERE category_id IN (SELECT id FROM e2e_category_ids);
DELETE FROM categories WHERE id IN (SELECT id FROM e2e_category_ids);
DELETE FROM vendors WHERE id IN (SELECT id FROM e2e_vendor_ids);

-- 7. Cleanup Alterations and Appointments
DELETE FROM alteration_order_items WHERE alteration_order_id IN (SELECT id FROM alteration_orders WHERE customer_id IN (SELECT id FROM e2e_customer_ids));
DELETE FROM alteration_orders WHERE customer_id IN (SELECT id FROM e2e_customer_ids);
DELETE FROM wedding_appointments WHERE customer_id IN (SELECT id FROM e2e_customer_ids);

-- 8. Cleanup Measurements
DELETE FROM measurements WHERE customer_id IN (SELECT id FROM e2e_customer_ids);

-- 9. Cleanup Peripheral Logs and Metadata (Final Verified System Pass)
DELETE FROM staff_notification WHERE compact_summary ILIKE '%E2E%';
DELETE FROM app_notification WHERE title ILIKE '%E2E%' OR body ILIKE '%E2E%';
DELETE FROM staff_error_event WHERE message ILIKE '%E2E%' OR message ILIKE '%Test%';
DELETE FROM ops_action_audit WHERE notes ILIKE '%E2E%' OR action_kind ILIKE '%E2E%';
DELETE FROM task_instance WHERE title_snapshot ILIKE '%E2E%' OR title_snapshot ILIKE '%Test%';
DELETE FROM shipment WHERE recipient_name ILIKE '%E2E%' OR recipient_name ILIKE '%Test%';
DELETE FROM nuorder_sync_logs WHERE notes ILIKE '%E2E%' OR notes ILIKE '%Test%';
DELETE FROM qbo_sync_logs WHERE error_message ILIKE '%E2E%' OR error_message ILIKE '%Test%';
DELETE FROM physical_inventory_sessions WHERE notes ILIKE '%E2E%' OR notes ILIKE '%Test%';
DELETE FROM podium_message WHERE body ILIKE '%E2E%' OR body ILIKE '%Test%';

-- 10. Final Purge
DELETE FROM staff_permission WHERE staff_id IN (SELECT id FROM e2e_staff_ids);
DELETE FROM register_sessions WHERE opened_by IN (SELECT id FROM e2e_staff_ids);
DELETE FROM staff WHERE id IN (SELECT id FROM e2e_staff_ids);
DELETE FROM customers WHERE id IN (SELECT id FROM e2e_customer_ids);

COMMIT;
