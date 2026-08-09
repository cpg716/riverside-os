-- Keep donated gift-card redemption separate from loyalty and promotional spend.
-- The account remains staff-configured through the QBO mapping matrix.
COMMENT ON COLUMN qbo_mappings.source_type IS
  'category_revenue | category_inventory | category_cogs | custom_revenue | custom_inventory | custom_cogs | tender | tax | liability_deposit | liability_gift_card | liability_store_credit | liability_refund_queue | expense_loyalty | expense_donated | expense_merchant_fee | clearing_invoice_holding | expense_shipping | income_forfeited_deposit | income_shipping | income_alterations';
