-- Migration 117: Inventory Maintenance Transaction Types
-- Adds 'damaged' and 'return_to_vendor' to inventory_tx_type enum
-- Adds ledger mapping keys for financial tracking

-- We use a DO block to safely add enum values (if not already present) 
-- and avoid transaction issues if the environment allows it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'inventory_tx_type' AND e.enumlabel = 'damaged') THEN
        ALTER TYPE inventory_tx_type ADD VALUE 'damaged';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'inventory_tx_type' AND e.enumlabel = 'return_to_vendor') THEN
        ALTER TYPE inventory_tx_type ADD VALUE 'return_to_vendor';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'inventory_tx_type' AND e.enumlabel = 'physical_inventory') THEN
        ALTER TYPE inventory_tx_type ADD VALUE 'physical_inventory';
    END IF;
END
$$;

-- Add ledger mapping keys
-- INV_SHRINKAGE: expense account for damaged/lost goods.
-- INV_RTV_CLEARING: current asset or contra-revenue for RTV items.
INSERT INTO ledger_mappings (internal_key, internal_description)
VALUES 
    ('INV_SHRINKAGE', 'Expense account for damaged or lost inventory (Shrinkage)'),
    ('INV_RTV_CLEARING', 'Clearing account for Return to Vendor items (awaiting credit/refund)')
ON CONFLICT (internal_key) DO NOTHING;

-- Update qbo_mappings comment hints
COMMENT ON COLUMN qbo_mappings.source_type IS 'category_revenue | category_inventory | category_cogs | tender | tax | liability_deposit | liability_gift_card | expense_loyalty | clearing_invoice_holding | expense_shipping | income_forfeited_deposit | expense_shrinkage | asset_rtv_clearing';

INSERT INTO ros_schema_migrations (version) VALUES ('117_inventory_maintenance_tx_types.sql')
ON CONFLICT (version) DO NOTHING;
