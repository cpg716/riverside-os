-- Per-staff RBAC + discount cap (runtime); role-wide tables remain Settings templates.
-- Employment dates, linked CRM customer for employee pricing.

CREATE TABLE IF NOT EXISTS staff_permission (
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    allowed BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (staff_id, permission_key),
    CONSTRAINT staff_permission_non_empty_key CHECK (length(trim(permission_key)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_staff_permission_staff ON staff_permission (staff_id);

COMMENT ON TABLE staff_permission IS 'Effective Back Office permissions per staff (non-admin); Admin role bypasses in application code.';
COMMENT ON TABLE staff_role_permission IS 'Settings templates: default permission rows per staff_role for new hires / apply-role-defaults; not read at auth time for non-admin.';

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS max_discount_percent NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS employment_start_date DATE,
    ADD COLUMN IF NOT EXISTS employment_end_date DATE,
    ADD COLUMN IF NOT EXISTS employee_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

COMMENT ON COLUMN staff.max_discount_percent IS 'POS max line discount % vs retail for this staff member; seeded from role template.';
COMMENT ON COLUMN staff.employment_start_date IS 'Optional HR start date.';
COMMENT ON COLUMN staff.employment_end_date IS 'Optional end date; often set when archiving.';
COMMENT ON COLUMN staff.employee_customer_id IS 'CRM profile used for employee-cost checkout and is_employee_purchase; unique across staff.';

-- Backfill discount cap from role template (admin → 100 via staff_role_pricing_limits row).
UPDATE staff s
SET max_discount_percent = COALESCE(
    (SELECT l.max_discount_percent FROM staff_role_pricing_limits l WHERE l.role = s.role),
    30::numeric
)
WHERE max_discount_percent IS NULL;

ALTER TABLE staff
    ALTER COLUMN max_discount_percent SET NOT NULL,
    ALTER COLUMN max_discount_percent SET DEFAULT 30;

ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_max_discount_pct_chk;
ALTER TABLE staff ADD CONSTRAINT staff_max_discount_pct_chk
    CHECK (max_discount_percent >= 0::numeric AND max_discount_percent <= 100::numeric);

CREATE UNIQUE INDEX IF NOT EXISTS staff_employee_customer_uidx
    ON staff (employee_customer_id)
    WHERE employee_customer_id IS NOT NULL;

-- Backfill staff_permission from role template ⊕ legacy overrides (non-admin only).
INSERT INTO staff_permission (staff_id, permission_key, allowed)
SELECT s.id, p.permission_key, true
FROM staff s
INNER JOIN staff_role_permission p ON p.role = s.role AND p.allowed = true
WHERE s.role <> 'admin'::staff_role
ON CONFLICT (staff_id, permission_key) DO NOTHING;

DELETE FROM staff_permission sp
USING staff_permission_override o
WHERE sp.staff_id = o.staff_id
  AND sp.permission_key = o.permission_key
  AND o.effect = 'deny';

INSERT INTO staff_permission (staff_id, permission_key, allowed)
SELECT o.staff_id, o.permission_key, true
FROM staff_permission_override o
INNER JOIN staff s ON s.id = o.staff_id
WHERE o.effect = 'allow'
  AND s.role <> 'admin'::staff_role
ON CONFLICT (staff_id, permission_key) DO UPDATE SET allowed = excluded.allowed;

COMMENT ON TABLE staff_role_pricing_limits IS 'Settings templates: default max discount % per staff_role; runtime reads staff.max_discount_percent.';
