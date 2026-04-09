-- Migration 108: Customers and Orders Indexing & Bulk Assignment Foundation
-- Optimized for high-volume customer datasets and accurate balance calculations

-- 1. Indexing for Hub and Browse performance
CREATE INDEX IF NOT EXISTS idx_orders_customer_id_status ON orders(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_names ON customers(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_name);

-- 2. Bulk Assignment Endpoint Tables (Foundation)
-- Note: These tables already exist, but we ensure indexes for bulk resolution are present.
CREATE INDEX IF NOT EXISTS idx_customer_group_members_cid ON customer_group_members(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_group_members_gid ON customer_group_members(group_id);

-- 3. Cleanup of any orphaned redundant indexes from early dev if present
-- (Optional, but good for hygiene)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_customers_last_name') THEN
        DROP INDEX idx_customers_last_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_customers_first_name') THEN
        DROP INDEX idx_customers_first_name;
    END IF;
END $$;
