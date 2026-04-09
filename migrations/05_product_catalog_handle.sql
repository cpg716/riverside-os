-- Stable external identity for catalog imports (Lightspeed handle, style #, etc.).
-- Greenfield installs from 01_initial_schema.sql already include this column + constraint.
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_handle TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS products_catalog_handle_uq ON products (catalog_handle);
