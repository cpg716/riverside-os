-- Deterministic RMS E2E staff fixtures.
-- 1234 admin comes from scripts/seed_staff_register_test.sql
-- 5678 non-admin comes from scripts/seed_e2e_non_admin_staff.sql

INSERT INTO staff (
    id,
    full_name,
    cashier_code,
    base_commission_rate,
    is_active,
    role,
    pin_hash,
    avatar_key
)
VALUES
    (
        uuid_generate_v4(),
        'E2E POS Manager',
        '2468',
        0,
        TRUE,
        'sales_support'::staff_role,
        NULL,
        'ros_default'
    ),
    (
        uuid_generate_v4(),
        'E2E Sales Support',
        '1357',
        0,
        TRUE,
        'sales_support'::staff_role,
        NULL,
        'ros_default'
    )
ON CONFLICT (cashier_code) DO NOTHING;

WITH rms_staff AS (
    SELECT id, cashier_code
    FROM staff
    WHERE cashier_code IN ('5678', '2468', '1357')
),
desired(staff_code, permission_key) AS (
    VALUES
        ('5678', 'pos.rms_charge.use'),
        ('5678', 'pos.rms_charge.lookup'),
        ('5678', 'pos.rms_charge.history_basic'),
        ('5678', 'pos.rms_charge.payment_collect'),
        ('2468', 'pos.rms_charge.use'),
        ('2468', 'pos.rms_charge.lookup'),
        ('2468', 'pos.rms_charge.history_basic'),
        ('2468', 'pos.rms_charge.payment_collect'),
        ('1357', 'customers.rms_charge.view'),
        ('1357', 'customers.rms_charge.manage_links'),
        ('1357', 'customers.rms_charge.resolve_exceptions'),
        ('1357', 'customers.rms_charge.reconcile'),
        ('1357', 'customers.rms_charge.reporting'),
        ('1357', 'qbo.mapping_edit'),
        ('1357', 'qbo.view')
)
INSERT INTO staff_permission (staff_id, permission_key, allowed)
SELECT s.id, d.permission_key, TRUE
FROM desired d
INNER JOIN rms_staff s ON s.cashier_code = d.staff_code
ON CONFLICT (staff_id, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;
