-- Add wedding_order fulfillment; merge legacy custom lines into special_order.
-- Wedding-linked orders: non-takeaway lines use wedding_order after backfill.

ALTER TYPE fulfillment_type ADD VALUE IF NOT EXISTS 'wedding_order';

UPDATE order_items SET fulfillment = 'special_order' WHERE fulfillment = 'custom';

UPDATE order_items oi
SET fulfillment = 'wedding_order'
FROM orders o
WHERE oi.order_id = o.id
  AND o.wedding_member_id IS NOT NULL
  AND oi.fulfillment = 'special_order';
