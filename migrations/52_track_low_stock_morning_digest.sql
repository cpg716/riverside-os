-- Per-template and per-variant opt-in for low-stock operational alerts.
-- Morning digest ledger: one admin digest bundle per store-local calendar day.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS track_low_stock BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS track_low_stock BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN products.track_low_stock IS
    'When true, template may participate in low-stock notifications; effective only if variant.track_low_stock is also true.';
COMMENT ON COLUMN product_variants.track_low_stock IS
    'When true with products.track_low_stock, variant is eligible for low-stock alerts when at/below reorder_point.';

CREATE TABLE IF NOT EXISTS morning_digest_ledger (
    store_day DATE PRIMARY KEY,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE morning_digest_ledger IS
    'Prevents duplicate admin morning digest runs for the same store-local calendar day (timezone from receipt_config).';
