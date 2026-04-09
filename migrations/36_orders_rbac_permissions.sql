-- Orders RBAC: view / cancel / refund / modify (returns, pickup, line edits).
-- Admin role bypasses in app code; these rows document defaults for non-admin roles.

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'orders.view', true),
    ('admin', 'orders.cancel', true),
    ('admin', 'orders.refund_process', true),
    ('admin', 'orders.modify', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('salesperson', 'orders.view', true),
    ('salesperson', 'orders.cancel', false),
    ('salesperson', 'orders.refund_process', true),
    ('salesperson', 'orders.modify', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('sales_support', 'orders.view', true),
    ('sales_support', 'orders.cancel', true),
    ('sales_support', 'orders.refund_process', true),
    ('sales_support', 'orders.modify', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
