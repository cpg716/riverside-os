-- Add rounding_adjustment and final_cash_due to orders table
-- for Pennyless (Swedish) Cash Rounding compliance.

ALTER TABLE orders
ADD COLUMN rounding_adjustment NUMERIC(12, 2) DEFAULT 0.00 NOT NULL;

ALTER TABLE orders
ADD COLUMN final_cash_due NUMERIC(12, 2);

-- Also add a ledger mapping entry for Cash Rounding if not exists
INSERT INTO ledger_mappings (internal_key, internal_description)
VALUES ('CASH_ROUNDING', 'Rounding adjustment for cash transactions (Swedish Rounding)')
ON CONFLICT (internal_key) DO NOTHING;
