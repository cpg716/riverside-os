-- First-class Manager Access approval permission.
-- Admin receives this automatically in application code, but seeding it keeps
-- role/default permission editing explicit for future non-admin approvers.

INSERT INTO staff_role_permission (role, permission_key, allowed)
VALUES ('admin', 'manager.approval', true)
ON CONFLICT (role, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;

INSERT INTO staff_permission (staff_id, permission_key, allowed)
SELECT id, 'manager.approval', true
FROM staff
WHERE role = 'admin'::staff_role
  AND is_active = true
ON CONFLICT (staff_id, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;
