-- Migration 127: Add Staff Attribution to Inventory Transactions
-- Enables detailed audit trails for damaged and return-to-vendor movements.

ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES staff(id);

-- Update existing records if possible, but for fresh ROS instances we just want the schema.
COMMENT ON COLUMN inventory_transactions.created_by IS 'The staff member who performed the inventory adjustment or movement.';
