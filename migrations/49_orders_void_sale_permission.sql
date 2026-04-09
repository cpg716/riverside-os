-- Void unpaid orders: narrower key than orders.cancel (cancel still required when payments exist).

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'orders.void_sale', true),
    ('sales_support', 'orders.void_sale', true),
    ('salesperson', 'orders.void_sale', true)
ON CONFLICT (role, permission_key) DO NOTHING;
