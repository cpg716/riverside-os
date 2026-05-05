-- Migration 148: Separate Wedding Manager shell access from general wedding visibility.

INSERT INTO staff_role_permission (role, permission_key, allowed)
VALUES
    ('admin', 'wedding_manager.open', true),
    ('salesperson', 'wedding_manager.open', false),
    ('sales_support', 'wedding_manager.open', false)
ON CONFLICT (role, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;
