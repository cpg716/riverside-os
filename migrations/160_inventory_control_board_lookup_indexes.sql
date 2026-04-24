-- Speed large-catalog inventory control-board hydration after Meilisearch narrows
-- matching variant ids. These indexes support per-product variant counts,
-- last-vendor lookups, and bounded trailing-sales ranking.

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id
    ON product_variants(product_id);

CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_variant_id
    ON purchase_order_lines(variant_id);

CREATE INDEX IF NOT EXISTS idx_transaction_lines_product_transaction
    ON transaction_lines(product_id, transaction_id)
    WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_booked_status_id
    ON transactions(booked_at DESC, status, id);
