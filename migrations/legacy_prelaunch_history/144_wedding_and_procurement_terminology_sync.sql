-- Migration 144: Finalize Transaction Terminology in Weddings and Procurement
-- Renames lingering 'order_id' to 'transaction_id' in wedding_members for financial consistency.
-- Note: Procurement tables already use 'purchase_order_id' in DB, so no rename needed there, 
-- but we must ensure receiving_events doesn't have an orphaned duplicate column.

DO $$ 
BEGIN
    -- 1. Rename order_id to transaction_id in wedding_members
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'wedding_members' AND column_name = 'order_id'
    ) THEN
        ALTER TABLE wedding_members RENAME COLUMN order_id TO transaction_id;
    END IF;

    -- 2. Cleanup receiving_events (ensure we only have purchase_order_id)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'receiving_events' AND column_name = 'purchase_order_id'
        AND EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'receiving_events' AND column_name = 'purchase_transaction_id'
        )
    ) THEN
        -- Standardize on purchase_order_id for procurement logic (Logistics vs Finance split)
        ALTER TABLE receiving_events DROP COLUMN purchase_transaction_id;
    END IF;
END $$;
