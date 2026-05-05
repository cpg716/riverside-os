-- Counterpoint provenance: tag imported customers + products with their data source.

-- 1) Widen customer_created_source to accept 'counterpoint'.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_created_source_chk;
ALTER TABLE customers
    ADD CONSTRAINT customers_created_source_chk
        CHECK (customer_created_source IN ('store', 'online_store', 'counterpoint'));

-- 2) General-purpose data_source on products (NULL = ROS-native).
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS data_source TEXT;

COMMENT ON COLUMN products.data_source IS
    'NULL = created in ROS; ''counterpoint'' = imported from Counterpoint; ''csv'' = bulk CSV import.';

-- 3) Track in ledger.
INSERT INTO ros_schema_migrations (version) VALUES ('85_counterpoint_provenance.sql')
ON CONFLICT (version) DO NOTHING;
