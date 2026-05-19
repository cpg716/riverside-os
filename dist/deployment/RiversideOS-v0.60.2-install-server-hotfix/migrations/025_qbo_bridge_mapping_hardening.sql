-- Harden QBO mapping metadata so every journal fallback key is visible/editable.

INSERT INTO ledger_mappings (internal_key, internal_description)
VALUES
    ('REVENUE_ALTERATIONS', 'Alterations revenue fallback'),
    ('REVENUE_SHIPPING', 'Customer-charged shipping income fallback'),
    ('CASH_ROUNDING', 'Cash rounding adjustments'),
    ('RMS_CHARGE_FINANCING_CLEARING', 'RMS financed sales clearing'),
    ('RMS_R2S_PAYMENT_CLEARING', 'R2S payment collections clearing'),
    ('REFUND_LIABILITY_CLEARING', 'Refund queue liability fallback')
ON CONFLICT (internal_key) DO UPDATE
SET internal_description = EXCLUDED.internal_description;

COMMENT ON COLUMN qbo_mappings.source_type IS 'category_revenue | category_inventory | category_cogs | custom_revenue | custom_inventory | custom_cogs | tender | tax | liability_deposit | liability_gift_card | liability_store_credit | liability_refund_queue | expense_loyalty | expense_merchant_fee | clearing_invoice_holding | expense_shipping | income_forfeited_deposit | income_shipping | income_alterations';
