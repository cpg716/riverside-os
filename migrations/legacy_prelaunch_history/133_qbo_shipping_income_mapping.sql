-- Add income_shipping mapping for QBO journal - for shipping fee revenue
-- First ensure we have a QBO account for shipping revenue
INSERT INTO qbo_accounts_cache (id, name, account_type)
VALUES ('shipping_revenue_default', 'Shipping Revenue', 'Income')
ON CONFLICT (id) DO NOTHING;

-- Then map income_shipping to it
INSERT INTO qbo_mappings (source_type, source_id, qbo_account_id, qbo_account_name)
VALUES ('income_shipping', 'default', 'shipping_revenue_default', 'Shipping Revenue')
ON CONFLICT (source_type, source_id) DO UPDATE SET
    qbo_account_name = EXCLUDED.qbo_account_name;

COMMENT ON COLUMN qbo_mappings.source_type IS 'category_revenue | category_inventory | category_cogs | tender | tax | liability_deposit | liability_gift_card | expense_loyalty | clearing_invoice_holding | expense_shipping | income_forfeited_deposit | income_shipping';