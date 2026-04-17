-- Fine-grained Relationship Hub + aligned customer API surfaces.
-- Enforced in `server/src/api/customers/` via `require_staff_perm_or_pos_session`
-- (Back Office staff permission **or** open register POS session).

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'customers.hub_view', true),
    ('admin', 'customers.hub_edit', true),
    ('admin', 'customers.timeline', true),
    ('admin', 'customers.measurements', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('salesperson', 'customers.hub_view', true),
    ('salesperson', 'customers.hub_edit', true),
    ('salesperson', 'customers.timeline', true),
    ('salesperson', 'customers.measurements', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('sales_support', 'customers.hub_view', true),
    ('sales_support', 'customers.hub_edit', true),
    ('sales_support', 'customers.timeline', true),
    ('sales_support', 'customers.measurements', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
