-- Speed variant-level sales aggregates used to rank inventory control-board text search (POS / Back Office).

CREATE INDEX IF NOT EXISTS idx_order_items_variant_id
    ON order_items(variant_id);

COMMENT ON INDEX idx_order_items_variant_id IS
    'Supports trailing-window units-sold subqueries for control-board search ranking.';
