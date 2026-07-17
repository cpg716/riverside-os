-- Preserve the historical duplicate row and identify the surviving master.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS merged_into_customer_id UUID
        REFERENCES customers(id) ON DELETE RESTRICT;

-- Keep the historical email on the inactive row without blocking a future
-- active customer from using the same address.
ALTER TABLE customers
    DROP CONSTRAINT IF EXISTS customers_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS customers_active_email_uq
    ON customers (email)
    WHERE is_active AND email IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'customers_merged_into_customer_id_check'
    ) THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_merged_into_customer_id_check
            CHECK (merged_into_customer_id IS NULL OR merged_into_customer_id <> id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customers_merged_into_customer_id
    ON customers (merged_into_customer_id)
    WHERE merged_into_customer_id IS NOT NULL;
