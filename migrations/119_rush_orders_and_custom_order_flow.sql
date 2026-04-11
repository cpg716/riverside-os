-- Add Rush Order and Custom Work Order fields
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'is_rush') THEN
        ALTER TABLE orders ADD COLUMN is_rush BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'need_by_date') THEN
        ALTER TABLE orders ADD COLUMN need_by_date DATE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_items' AND column_name = 'custom_item_type') THEN
        ALTER TABLE order_items ADD COLUMN custom_item_type TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_items' AND column_name = 'is_rush') THEN
        ALTER TABLE order_items ADD COLUMN is_rush BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_items' AND column_name = 'need_by_date') THEN
        ALTER TABLE order_items ADD COLUMN need_by_date DATE;
    END IF;
END $$;
