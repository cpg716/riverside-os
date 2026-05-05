-- Riverside OS development seed data.
-- Idempotent. Run after seed_core_required.sql and seed_rbac.sql.

\set ON_ERROR_STOP on

UPDATE public.store_settings
SET environment_mode = 'development'
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
