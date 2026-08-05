-- Routine completion and inventory-reconciliation events belong in their
-- authoritative workspaces, not in the staff attention inbox. Preserve the
-- historical event while clearing existing copies from active staff inboxes.
UPDATE public.staff_notification AS staff_row
SET read_at = COALESCE(staff_row.read_at, NOW()),
    archived_at = COALESCE(staff_row.archived_at, NOW()),
    compact_summary = COALESCE(
        staff_row.compact_summary,
        LEFT(notification.title || ': ' || notification.body, 280)
    )
FROM public.app_notification AS notification
WHERE staff_row.notification_id = notification.id
  AND staff_row.archived_at IS NULL
  AND (
      notification.kind IN (
          'order_fully_fulfilled',
          'negative_available_stock',
          'negative_available_stock_bundle'
      )
      OR (
          notification.kind = 'ops_alert'
          AND notification.body LIKE 'Inventory Reconciliation Over-Allocation:%'
      )
  );
