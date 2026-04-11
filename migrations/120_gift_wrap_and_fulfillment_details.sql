-- Add Gift Wrap and fulfillment detail fields
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_items' AND column_name = 'needs_gift_wrap') THEN
        ALTER TABLE order_items ADD COLUMN needs_gift_wrap BOOLEAN DEFAULT FALSE;
    END IF;
END $$;
