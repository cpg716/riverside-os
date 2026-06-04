-- Rename the ambiguous QBO inventory adjustment revenue key to an explicit mapping key.

INSERT INTO ledger_mappings (internal_key, internal_description, qbo_account_id, updated_at)
SELECT
    'REVENUE_INVENTORY_ADJUSTMENT',
    'Income account for unclassified positive inventory adjustments',
    qbo_account_id,
    CURRENT_TIMESTAMP
FROM ledger_mappings
WHERE internal_key = 'REVENUE_FALLBACK'
ON CONFLICT (internal_key) DO UPDATE
SET
    internal_description = EXCLUDED.internal_description,
    qbo_account_id = COALESCE(ledger_mappings.qbo_account_id, EXCLUDED.qbo_account_id),
    updated_at = CURRENT_TIMESTAMP;

UPDATE ledger_mappings
SET
    internal_description = CASE internal_key
        WHEN 'REVENUE_ALTERATIONS' THEN 'Alterations revenue'
        WHEN 'REVENUE_SHIPPING' THEN 'Customer-charged shipping income'
        WHEN 'REFUND_LIABILITY_CLEARING' THEN 'Refund queue liability clearing'
        ELSE internal_description
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE internal_key IN ('REVENUE_ALTERATIONS', 'REVENUE_SHIPPING', 'REFUND_LIABILITY_CLEARING');

DELETE FROM ledger_mappings
WHERE internal_key = 'REVENUE_FALLBACK';
