-- Migration 138: Payment Check Number
-- Adds explicit column for recording check numbers on payment transactions.

ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS check_number VARCHAR(100);
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS check_number VARCHAR(100);

COMMENT ON COLUMN payment_transactions.check_number IS 'Recorded check number for physical check tenders.';
COMMENT ON COLUMN payment_allocations.check_number IS 'Recorded check number for physical check tenders (copied from transaction).';
