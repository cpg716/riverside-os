-- Migration 142: Transactions vs. Orders Refactor (Idempotent Version)
-- Decouples logistical fulfillment (Orders) from financial checkout (Transactions).

-- 1. Create Sequences for human-readable IDs
CREATE SEQUENCE IF NOT EXISTS transaction_display_id_seq START WITH 10001;
CREATE SEQUENCE IF NOT EXISTS fulfillment_order_display_id_seq START WITH 10001;

-- 2. Rename Core Tables
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename  = 'orders') THEN
        ALTER TABLE orders RENAME TO transactions;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename  = 'order_items') THEN
        ALTER TABLE order_items RENAME TO transaction_lines;
    END IF;
END $$;

-- 3. Create Fulfillment Orders (The logistical header)
CREATE TABLE IF NOT EXISTS fulfillment_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    display_id TEXT UNIQUE NOT NULL, -- ORD-10001
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    wedding_id UUID REFERENCES wedding_parties(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open', -- 'open', 'ready', 'shipped', 'picked_up', 'cancelled'
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    fulfilled_at TIMESTAMPTZ
);

-- 4. Update Transaction Lines (The ledger details)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_lines' AND column_name = 'order_id') THEN
        ALTER TABLE transaction_lines RENAME COLUMN order_id TO transaction_id;
    END IF;
END $$;

ALTER TABLE transaction_lines ADD COLUMN IF NOT EXISTS fulfillment_order_id UUID REFERENCES fulfillment_orders(id) ON DELETE SET NULL;
ALTER TABLE transaction_lines ADD COLUMN IF NOT EXISTS line_display_id TEXT; -- ORD-10001-1
ALTER TABLE transaction_lines ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;

-- 5. Add Transaction Human-Readable IDs
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS display_id TEXT UNIQUE; -- TXN-10001

-- 6. Helper Function for ID Generation
CREATE OR REPLACE FUNCTION generate_txn_display_id() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.display_id IS NULL THEN
        NEW.display_id := 'TXN-' || nextval('transaction_display_id_seq')::text;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_ord_display_id() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.display_id IS NULL THEN
        NEW.display_id := 'ORD-' || nextval('fulfillment_order_display_id_seq')::text;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 7. Triggers for IDs
DROP TRIGGER IF EXISTS trigger_generate_txn_display_id ON transactions;
CREATE TRIGGER trigger_generate_txn_display_id
BEFORE INSERT ON transactions
FOR EACH ROW EXECUTE FUNCTION generate_txn_display_id();

DROP TRIGGER IF EXISTS trigger_generate_ord_display_id ON fulfillment_orders;
CREATE TRIGGER trigger_generate_ord_display_id
BEFORE INSERT ON fulfillment_orders
FOR EACH ROW EXECUTE FUNCTION generate_ord_display_id();

-- 8. Correct Foreign Key names in dependent tables for clarity
DO $$ 
BEGIN
    -- payment_allocations
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'payment_allocations' AND column_name = 'target_order_id') THEN
        ALTER TABLE payment_allocations RENAME COLUMN target_order_id TO target_transaction_id;
    END IF;

    -- shipments (internal table name is 'shipment' per earlier \d)
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'shipment' AND column_name = 'order_id') THEN
        ALTER TABLE shipment RENAME COLUMN order_id TO transaction_id;
    END IF;

    -- alteration_orders
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'alteration_orders' AND column_name = 'linked_order_id') THEN
        ALTER TABLE alteration_orders RENAME COLUMN linked_order_id TO transaction_id;
    END IF;

    -- order_activity_log -> transaction_activity_log
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename  = 'order_activity_log') THEN
        ALTER TABLE order_activity_log RENAME TO transaction_activity_log;
    END IF;
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_activity_log' AND column_name = 'order_id') THEN
        ALTER TABLE transaction_activity_log RENAME COLUMN order_id TO transaction_id;
    END IF;

    -- order_refund_queue -> transaction_refund_queue
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename  = 'order_refund_queue') THEN
        ALTER TABLE order_refund_queue RENAME TO transaction_refund_queue;
    END IF;
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_refund_queue' AND column_name = 'order_id') THEN
        ALTER TABLE transaction_refund_queue RENAME COLUMN order_id TO transaction_id;
    END IF;

    -- order_return_lines -> transaction_return_lines
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename  = 'order_return_lines') THEN
        ALTER TABLE order_return_lines RENAME TO transaction_return_lines;
    END IF;
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_return_lines' AND column_name = 'order_item_id') THEN
        ALTER TABLE transaction_return_lines RENAME COLUMN order_item_id TO transaction_line_id;
    END IF;
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_return_lines' AND column_name = 'order_id') THEN
        ALTER TABLE transaction_return_lines RENAME COLUMN order_id TO transaction_id;
    END IF;
END $$;

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS fulfillment_order_id UUID REFERENCES fulfillment_orders(id);
ALTER TABLE alteration_orders ADD COLUMN IF NOT EXISTS fulfillment_order_id UUID REFERENCES fulfillment_orders(id);

-- 9. Derived Status View (The "Operational Truth")
CREATE OR REPLACE VIEW reporting.transaction_fulfillment_status AS
SELECT 
    t.id AS transaction_id,
    t.display_id AS transaction_display_id,
    CASE 
        WHEN NOT EXISTS (SELECT 1 FROM transaction_lines WHERE transaction_id = t.id AND fulfilled_at IS NULL) THEN 'fulfilled'
        WHEN NOT EXISTS (SELECT 1 FROM transaction_lines WHERE transaction_id = t.id AND fulfilled_at IS NOT NULL) THEN 'open'
        ELSE 'partially_fulfilled'
    END AS fulfillment_status
FROM transactions t;

-- 10. Financial Recognition Logic (Update)
CREATE OR REPLACE FUNCTION reporting.transaction_line_recognition_at(
    p_line_id uuid
) RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT tl.fulfilled_at
    FROM transaction_lines tl
    WHERE tl.id = p_line_id;
$$;

-- Grant permissions to Metabase
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;
GRANT SELECT ON fulfillment_orders TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('142_transactions_and_fulfillment.sql')
ON CONFLICT (version) DO NOTHING;
