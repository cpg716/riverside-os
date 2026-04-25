-- Track Back Office Orders workspace search separately from all financial transactions.
-- `ros_orders` is transaction-backed order records (special/custom/wedding/layaway/open docs).

INSERT INTO meilisearch_sync_status (index_name)
VALUES ('ros_orders')
ON CONFLICT DO NOTHING;

DELETE FROM meilisearch_sync_status
WHERE index_name = 'ros_fulfillment_orders';
