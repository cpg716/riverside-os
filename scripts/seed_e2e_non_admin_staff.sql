-- Non-Admin staff for Playwright / CI: `GET /api/insights/margin-pivot` must return 403 (Admin-only).
-- Idempotent. `pin_hash` NULL → only `x-riverside-staff-code` required (see `server/src/auth/pins.rs`).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/seed_e2e_non_admin_staff.sql
--
-- Default `cashier_code` **5678** matches `E2E_NON_ADMIN_CODE` in `client/e2e/api-gates.spec.ts`.

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
VALUES (
    uuid_generate_v4(),
    'E2E Non-Admin',
    '5678',
    0,
    TRUE,
    'salesperson'::staff_role,
    NULL,
    'ros_default'
)
ON CONFLICT (cashier_code) DO NOTHING;
