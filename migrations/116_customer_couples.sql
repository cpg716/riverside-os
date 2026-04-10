-- Migration 116: Customer Couples
-- Allows linking two customer accounts as a "Couple" with a primary/archived relationship.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS couple_id UUID;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS couple_primary_id UUID REFERENCES customers(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS couple_linked_at TIMESTAMPTZ;

-- Index for couple lookups
CREATE INDEX IF NOT EXISTS idx_customers_couple_id ON customers(couple_id) WHERE couple_id IS NOT NULL;

-- RBAC for coupling
INSERT INTO staff_role_permission (role, permission_key, allowed) 
VALUES 
    ('admin', 'customers.couple_manage', true),
    ('salesperson', 'customers.couple_manage', true),
    ('sales_support', 'customers.couple_manage', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
