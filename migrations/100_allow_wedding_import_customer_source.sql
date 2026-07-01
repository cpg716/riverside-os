ALTER TABLE customers
    DROP CONSTRAINT IF EXISTS customers_created_source_chk;

ALTER TABLE customers
    ADD CONSTRAINT customers_created_source_chk
    CHECK (customer_created_source IN ('store', 'online_store', 'counterpoint', 'podium', 'wedding_import'));
