-- Retail sizing on measurement vault (sync with wedding_members suit grid), bundle flag, RBAC seeds (legacy staff_mfa_sessions created here; dropped in 45_remove_staff_mfa.sql).

ALTER TABLE customer_measurements
    ADD COLUMN IF NOT EXISTS retail_suit TEXT,
    ADD COLUMN IF NOT EXISTS retail_waist TEXT,
    ADD COLUMN IF NOT EXISTS retail_vest TEXT,
    ADD COLUMN IF NOT EXISTS retail_shirt TEXT,
    ADD COLUMN IF NOT EXISTS retail_shoe TEXT;

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS staff_mfa_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_mfa_sessions_staff ON staff_mfa_sessions (staff_id, expires_at DESC);

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'alterations.manage', true),
    ('admin', 'customer_groups.manage', true),
    ('admin', 'store_credit.manage', true),
    ('sales_support', 'alterations.manage', true),
    ('sales_support', 'customer_groups.manage', true)
ON CONFLICT (role, permission_key) DO NOTHING;
