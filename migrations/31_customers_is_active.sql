-- Loyalty and other queries reference customers.is_active; ensure column exists on older DBs.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
