-- Register shift primary: optional staff acting as "on register" for UI/tasks, distinct from drawer opener.

ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS shift_primary_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

COMMENT ON COLUMN register_sessions.shift_primary_staff_id IS
    'When set, POS/register primary display and task context use this staff; NULL means use opened_by.';

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'register.shift_handoff', true),
    ('sales_support', 'register.shift_handoff', true),
    ('salesperson', 'register.shift_handoff', true)
ON CONFLICT (role, permission_key) DO NOTHING;
