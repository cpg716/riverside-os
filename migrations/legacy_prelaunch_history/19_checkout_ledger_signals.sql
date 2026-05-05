ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS metadata JSONB;

ALTER TABLE payment_allocations
    ADD COLUMN IF NOT EXISTS metadata JSONB;

COMMENT ON COLUMN payment_transactions.metadata IS
    'POS/QBO ledger metadata signals (gift card subtype, deposit release hints, etc.).';

COMMENT ON COLUMN payment_allocations.metadata IS
    'Allocation-level ledger metadata (e.g., applied_deposit_amount for liability release).';
