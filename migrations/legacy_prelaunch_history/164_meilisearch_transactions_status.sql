-- Keep Meilisearch sync health aligned with Transactions (TXN) and Orders (ORD).
-- `ros_orders` is a retired pre-refactor status row.

INSERT INTO meilisearch_sync_status (index_name)
VALUES
    ('ros_transactions'),
    ('ros_fulfillment_orders')
ON CONFLICT DO NOTHING;

DELETE FROM meilisearch_sync_status
WHERE index_name = 'ros_orders';
