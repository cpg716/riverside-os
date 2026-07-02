-- Hide stale zero-stock variants from default Inventory Find results.
-- Data is preserved for history, returns, audit, and Counterpoint sync.
-- A variant is hidden only when both are true:
--   1. stock_on_hand <= 0
--   2. no non-cancelled transaction line in the last five years

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS hidden_from_inventory boolean NOT NULL DEFAULT false;

UPDATE product_variants pv
SET hidden_from_inventory = true
WHERE pv.stock_on_hand <= 0
  AND NOT EXISTS (
      SELECT 1
      FROM transaction_lines tl
      JOIN transactions t ON t.id = tl.transaction_id
      WHERE tl.variant_id = pv.id
        AND t.status::text <> 'cancelled'
        AND t.booked_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '5 years'
  );

CREATE INDEX IF NOT EXISTS idx_product_variants_hidden_inventory
    ON product_variants(hidden_from_inventory)
    WHERE hidden_from_inventory = true;
