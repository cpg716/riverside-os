-- Riverside OS — protected no-commission salesperson attribution account.
-- Staff Admin is selectable when a sale should not commission to a salesperson.

INSERT INTO public.staff (
    id,
    full_name,
    cashier_code,
    base_commission_rate,
    is_active,
    role,
    pin_hash,
    avatar_key,
    max_discount_percent,
    data_source
) VALUES (
    '00000000-0000-4000-8000-000000000113',
    'Staff Admin',
    'STAFFADMIN',
    0.0000,
    TRUE,
    'salesperson'::public.staff_role,
    NULL,
    'ros_default',
    0.00,
    'system'
)
ON CONFLICT (cashier_code) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    base_commission_rate = 0.0000,
    is_active = TRUE,
    role = 'salesperson'::public.staff_role,
    pin_hash = NULL,
    avatar_key = 'ros_default',
    max_discount_percent = 0.00,
    data_source = 'system';

COMMENT ON COLUMN public.staff.data_source IS
    'NULL = created in ROS; ''counterpoint'' = imported from Counterpoint sync; ''system'' = protected Riverside system account.';
