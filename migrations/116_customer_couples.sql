-- Migration 116: Customer Couples
-- Allows linking two customer accounts as a "Couple" with a primary/archived relationship.

ALTER TABLE customers ADD COLUMN couple_id UUID;
ALTER TABLE customers ADD COLUMN couple_primary_id UUID REFERENCES customers(id);
ALTER TABLE customers ADD COLUMN couple_linked_at TIMESTAMPTZ;

-- Index for couple lookups
CREATE INDEX idx_customers_couple_id ON customers(couple_id) WHERE couple_id IS NOT NULL;

-- RBAC for coupling
INSERT INTO staff_role_permissions (role_id, permission_key)
SELECT id, 'customers.couple_manage' FROM staff_roles WHERE role_key IN ('admin', 'manager', 'cashier');
