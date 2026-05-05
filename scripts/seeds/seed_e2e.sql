-- Riverside OS E2E seed data.
-- Idempotent. Run after seed_core_required.sql and seed_rbac.sql.

\set ON_ERROR_STOP on

UPDATE public.store_settings
SET environment_mode = 'e2e'
WHERE id = 1;

INSERT INTO public.staff (
    id, full_name, cashier_code, base_commission_rate, is_active, role, pin_hash, avatar_key, max_discount_percent
) VALUES (
    '2e679a49-5beb-4ef2-a9e1-035040e3c6ab',
    'Chris G',
    '1234',
    0.0200,
    TRUE,
    'admin'::public.staff_role,
    '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc',
    'ros_default',
    100.00
)
ON CONFLICT (cashier_code) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    base_commission_rate = EXCLUDED.base_commission_rate,
    is_active = EXCLUDED.is_active,
    role = EXCLUDED.role,
    pin_hash = EXCLUDED.pin_hash,
    avatar_key = EXCLUDED.avatar_key,
    max_discount_percent = EXCLUDED.max_discount_percent;

INSERT INTO public.staff (
    id, full_name, cashier_code, base_commission_rate, is_active, role, pin_hash, avatar_key
) VALUES (
    '00000000-0000-4000-8000-000000005678',
    'E2E Non-Admin',
    '5678',
    0,
    TRUE,
    'salesperson'::public.staff_role,
    NULL,
    'ros_default'
), (
    '00000000-0000-4000-8000-000000002468',
    'E2E POS Manager',
    '2468',
    0,
    TRUE,
    'sales_support'::public.staff_role,
    NULL,
    'ros_default'
), (
    '00000000-0000-4000-8000-000000001357',
    'E2E Sales Support',
    '1357',
    0,
    TRUE,
    'sales_support'::public.staff_role,
    NULL,
    'ros_default'
)
ON CONFLICT (cashier_code) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    base_commission_rate = EXCLUDED.base_commission_rate,
    is_active = EXCLUDED.is_active,
    role = EXCLUDED.role,
    pin_hash = EXCLUDED.pin_hash,
    avatar_key = EXCLUDED.avatar_key;

WITH rms_staff AS (
    SELECT id, cashier_code
    FROM public.staff
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
INSERT INTO public.staff_permission (staff_id, permission_key, allowed)
SELECT s.id, d.permission_key, TRUE
FROM desired d
INNER JOIN rms_staff s ON s.cashier_code = d.staff_code
ON CONFLICT (staff_id, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;
