-- Cashier / floor roles: duplicate review queue + customer merge in Back Office.
-- Migration 62 denied salesperson/sales_support for customers_duplicate_review; restore for floor staff.
-- Migration 42 seeded customers.merge for admin only; extend to the same floor roles.

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('salesperson', 'customers_duplicate_review', true),
    ('salesperson', 'customers.merge', true),
    ('sales_support', 'customers_duplicate_review', true),
    ('sales_support', 'customers.merge', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
