-- scripts/e2e-pollution-audit.sql
-- Final attempt at a clean audit across the system.

SELECT 'staff' as tbl, count(*) FROM staff WHERE full_name ILIKE '%E2E%' OR full_name ILIKE '%Test%'
UNION ALL
SELECT 'customers', count(*) FROM customers WHERE first_name ILIKE '%E2E%' OR email ILIKE '%example.com' OR first_name IN ('Paige', 'Iris', 'Morgan', 'Charlie')
UNION ALL
SELECT 'wedding_parties', count(*) FROM wedding_parties WHERE groom_name ILIKE '%E2E%' OR groom_name ILIKE '%Test%'
UNION ALL
SELECT 'physical_inventory_sessions', count(*) FROM physical_inventory_sessions WHERE notes ILIKE '%E2E%' OR notes ILIKE '%Test%'
UNION ALL
SELECT 'task_instance', count(*) FROM task_instance WHERE title_snapshot ILIKE '%E2E%' OR title_snapshot ILIKE '%Test%'
UNION ALL
SELECT 'podium_message', count(*) FROM podium_message WHERE body ILIKE '%E2E%' OR body ILIKE '%Test%'
UNION ALL
SELECT 'staff_notification', count(*) FROM staff_notification WHERE title ILIKE '%E2E%'
UNION ALL
SELECT 'staff_error_event', count(*) FROM staff_error_event WHERE error_message ILIKE '%E2E%'
UNION ALL
SELECT 'ops_action_audit', count(*) FROM ops_action_audit WHERE notes ILIKE '%E2E%'
UNION ALL
SELECT 'shipment', count(*) FROM shipment WHERE recipient_name ILIKE '%E2E%'
UNION ALL
SELECT 'nuorder_sync_logs', count(*) FROM nuorder_sync_logs WHERE notes ILIKE '%E2E%';
