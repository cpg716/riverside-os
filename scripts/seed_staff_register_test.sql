-- scripts/seed_staff_register_test.sql
-- Seed staff and a test register session for E2E flows.
UPDATE store_settings SET environment_mode = 'e2e' WHERE id = 1;

-- Default admin for register / Back Office (idempotent). Apply migration 53 for Argon2 pin_hash on code 1234.
INSERT INTO staff (id, full_name, cashier_code, base_commission_rate, is_active, role)
VALUES (
    uuid_generate_v4(),
    'Chris G',
    '1234',
    0,
    true,
    'admin'::staff_role
)
ON CONFLICT (cashier_code) DO NOTHING;
