-- Speed parent-product sales aggregates for control-board search ranking.

CREATE INDEX IF NOT EXISTS idx_order_items_product_id
    ON order_items(product_id);

COMMENT ON INDEX idx_order_items_product_id IS
    'Supports trailing-window units-sold GROUP BY product_id for search ranking.';
