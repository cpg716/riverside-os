-- Seed Constant Contact access for staff who already manage Settings integrations.

INSERT INTO staff_role_permission (role, permission_key, allowed)
SELECT role_source.role, permission_source.permission_key, true
FROM (
    SELECT DISTINCT role
    FROM staff_role_permission
    WHERE permission_key = 'settings.admin'
      AND allowed = true
    UNION
    SELECT 'admin'::staff_role
) AS role_source
CROSS JOIN (
    VALUES
        ('constant_contact.manage'),
        ('constant_contact.sync')
) AS permission_source(permission_key)
ON CONFLICT (role, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;

INSERT INTO staff_permission (staff_id, permission_key, allowed)
SELECT DISTINCT settings_staff.staff_id, permission_source.permission_key, true
FROM staff_permission AS settings_staff
CROSS JOIN (
    VALUES
        ('constant_contact.manage'),
        ('constant_contact.sync')
) AS permission_source(permission_key)
WHERE settings_staff.permission_key = 'settings.admin'
  AND settings_staff.allowed = true
ON CONFLICT (staff_id, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;
