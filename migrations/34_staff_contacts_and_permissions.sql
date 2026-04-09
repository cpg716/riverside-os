-- Staff contact fields + RBAC: role defaults and per-staff overrides.

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS email TEXT;

COMMENT ON COLUMN staff.phone IS 'Work phone for SMS notifications (optional).';
COMMENT ON COLUMN staff.email IS 'Work email for notifications (optional).';

CREATE TABLE IF NOT EXISTS staff_role_permission (
    role staff_role NOT NULL,
    permission_key TEXT NOT NULL,
    allowed BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (role, permission_key)
);

CREATE TABLE IF NOT EXISTS staff_permission_override (
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    PRIMARY KEY (staff_id, permission_key)
);

CREATE INDEX IF NOT EXISTS staff_permission_override_staff
    ON staff_permission_override (staff_id);

COMMENT ON TABLE staff_role_permission IS 'Default Back Office permissions per staff_role; Admin role bypasses in application code.';
COMMENT ON TABLE staff_permission_override IS 'Per-staff allow/deny deltas applied after role defaults.';

-- Catalog keys (must match server/src/auth/permissions.rs)
INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'staff.view', true),
    ('admin', 'staff.edit', true),
    ('admin', 'staff.manage_pins', true),
    ('admin', 'staff.manage_commission', true),
    ('admin', 'staff.view_audit', true),
    ('admin', 'staff.manage_access', true),
    ('admin', 'qbo.view', true),
    ('admin', 'qbo.mapping_edit', true),
    ('admin', 'qbo.staging_approve', true),
    ('admin', 'qbo.sync', true),
    ('admin', 'insights.view', true),
    ('admin', 'insights.commission_finalize', true),
    ('admin', 'physical_inventory.view', true),
    ('admin', 'physical_inventory.mutate', true),
    ('admin', 'orders.edit_attribution', true),
    ('admin', 'loyalty.adjust_points', true),
    ('admin', 'inventory.view_cost', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('salesperson', 'staff.view', false),
    ('salesperson', 'staff.edit', false),
    ('salesperson', 'staff.manage_pins', false),
    ('salesperson', 'staff.manage_commission', false),
    ('salesperson', 'staff.view_audit', false),
    ('salesperson', 'staff.manage_access', false),
    ('salesperson', 'qbo.view', false),
    ('salesperson', 'qbo.mapping_edit', false),
    ('salesperson', 'qbo.staging_approve', false),
    ('salesperson', 'qbo.sync', false),
    ('salesperson', 'insights.view', false),
    ('salesperson', 'insights.commission_finalize', false),
    ('salesperson', 'physical_inventory.view', false),
    ('salesperson', 'physical_inventory.mutate', false),
    ('salesperson', 'orders.edit_attribution', false),
    ('salesperson', 'loyalty.adjust_points', false),
    ('salesperson', 'inventory.view_cost', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('sales_support', 'staff.view', false),
    ('sales_support', 'staff.edit', false),
    ('sales_support', 'staff.manage_pins', false),
    ('sales_support', 'staff.manage_commission', false),
    ('sales_support', 'staff.view_audit', false),
    ('sales_support', 'staff.manage_access', false),
    ('sales_support', 'qbo.view', false),
    ('sales_support', 'qbo.mapping_edit', false),
    ('sales_support', 'qbo.staging_approve', false),
    ('sales_support', 'qbo.sync', false),
    ('sales_support', 'insights.view', false),
    ('sales_support', 'insights.commission_finalize', false),
    ('sales_support', 'physical_inventory.view', false),
    ('sales_support', 'physical_inventory.mutate', false),
    ('sales_support', 'orders.edit_attribution', false),
    ('sales_support', 'loyalty.adjust_points', false),
    ('sales_support', 'inventory.view_cost', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
