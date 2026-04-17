-- Riverside OS - Schema Repair Baseline (Migration 135)
-- Purpose: Add missing columns identified during the v0.1.9 stabilization and repair structural regressions.

-- 1. Staff Repair
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS avatar_key TEXT;

-- 2. Orders Repair
ALTER TABLE orders ADD COLUMN IF NOT EXISTS short_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_method TEXT;

-- 3. Payment Transactions Repair
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success';
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS merchant_fee NUMERIC(12,2) DEFAULT 0.00;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS net_amount NUMERIC(12,2) DEFAULT 0.00;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS card_brand TEXT;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS card_last4 TEXT;

-- 4. Wedding Parties Repair
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS suit_variant_id UUID REFERENCES product_variants(id);

-- 5. Reporting Schema Sync
-- Update reporting.alterations_active
DROP VIEW IF EXISTS reporting.alterations_active;
CREATE VIEW reporting.alterations_active AS
SELECT 
    ao.id AS alteration_id,
    ao.linked_order_id AS order_id,
    o.short_id AS order_short_id,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name,
    ao.status::text AS status,
    ao.due_at,
    ao.created_at
FROM alteration_orders ao
LEFT JOIN orders o ON o.id = ao.linked_order_id
LEFT JOIN customers c ON c.id = ao.customer_id
WHERE ao.status::text NOT IN ('picked_up');

-- Update merchant_reconciliation view
-- Principle: Count sale at time of pickup (fulfilled_at) for commissions/taxes, 
-- but recognize revenue at initial booking (booked_at).
DROP VIEW IF EXISTS reporting.merchant_reconciliation;
CREATE VIEW reporting.merchant_reconciliation AS
SELECT 
    pt.id AS transaction_id,
    pt.occurred_at,
    pt.amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.payment_method,
    o.id AS order_id,
    o.booked_at AS revenue_recognition_date,
    COALESCE(o.fulfilled_at, o.booked_at) AS tax_commission_basis_date
FROM payment_transactions pt
LEFT JOIN payment_allocations pa ON pa.transaction_id = pt.id
LEFT JOIN orders o ON o.id = pa.target_order_id;
