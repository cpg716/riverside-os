-- Phase 2.12: RBAC, hashed PINs, access audit, category commission overrides.

DO $$ BEGIN CREATE TYPE staff_role AS ENUM ('admin', 'salesperson', 'sales_support'); EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS role staff_role NOT NULL DEFAULT 'sales_support';

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS pin_hash TEXT;

COMMENT ON COLUMN staff.pin_hash IS 'Argon2 hash of numeric PIN; NULL = legacy plaintext match on cashier_code only.';

UPDATE staff SET role = 'salesperson'
WHERE base_commission_rate > 0
  AND role = 'sales_support';

CREATE TABLE IF NOT EXISTS staff_access_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    event_kind TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS staff_access_log_staff_created
    ON staff_access_log (staff_id, created_at DESC);

COMMENT ON TABLE staff_access_log IS 'Successful PIN / authority events for audit (checkout, register open, etc.).';

CREATE TABLE IF NOT EXISTS category_commission_overrides (
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    commission_rate NUMERIC(5, 4) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (category_id)
);

COMMENT ON TABLE category_commission_overrides IS 'Global retail commission rate override by category (Odoo-style); else staff.base_commission_rate.';
