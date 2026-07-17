-- Keep payment-day tender evidence separate from a manager-approved backdated
-- business date. The clearing account must be mapped before a journal can post.
INSERT INTO ledger_mappings (internal_key, internal_description)
VALUES (
    'BACKDATED_SALE_CLEARING',
    'Clearing account linking actual payment day to backdated business day'
)
ON CONFLICT (internal_key) DO UPDATE
SET internal_description = EXCLUDED.internal_description;
