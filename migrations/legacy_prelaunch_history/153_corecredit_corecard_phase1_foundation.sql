-- Phase 1 foundation for unified RMS Charge / CoreCredit / CoreCard integration.
-- Preserves legacy on_account_rms / on_account_rms90 history while introducing
-- linked customer accounts, transaction financing metadata, and richer RMS audit rows.

CREATE TABLE IF NOT EXISTS customer_corecredit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    corecredit_customer_id TEXT NOT NULL,
    corecredit_account_id TEXT NOT NULL,
    corecredit_card_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    is_primary BOOLEAN NOT NULL DEFAULT false,
    program_group TEXT,
    last_verified_at TIMESTAMPTZ,
    verified_by_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    verification_source TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_corecredit_accounts_customer_account
    ON customer_corecredit_accounts (customer_id, corecredit_account_id);

CREATE INDEX IF NOT EXISTS idx_customer_corecredit_accounts_customer_status
    ON customer_corecredit_accounts (customer_id, status, is_primary DESC, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_corecredit_accounts_primary
    ON customer_corecredit_accounts (customer_id)
    WHERE is_primary = TRUE;

COMMENT ON TABLE customer_corecredit_accounts IS
    'Authoritative Riverside-to-CoreCredit/CoreCard account links. No PAN/CVV or browser secrets are stored.';

COMMENT ON COLUMN customer_corecredit_accounts.status IS
    'Linked account lifecycle for RMS Charge resolution (active, inactive, restricted, suspended, closed, etc.).';

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN transactions.metadata IS
    'Transaction-scoped financing metadata (e.g. RMS Charge program/account selection), distinct from tender button identity.';

ALTER TABLE pos_rms_charge_record
    ADD COLUMN IF NOT EXISTS tender_family TEXT,
    ADD COLUMN IF NOT EXISTS program_code TEXT,
    ADD COLUMN IF NOT EXISTS program_label TEXT,
    ADD COLUMN IF NOT EXISTS masked_account TEXT,
    ADD COLUMN IF NOT EXISTS linked_corecredit_customer_id TEXT,
    ADD COLUMN IF NOT EXISTS linked_corecredit_account_id TEXT,
    ADD COLUMN IF NOT EXISTS resolution_status TEXT,
    ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_pos_rms_charge_record_corecredit_account
    ON pos_rms_charge_record (linked_corecredit_account_id, created_at DESC)
    WHERE linked_corecredit_account_id IS NOT NULL;

COMMENT ON COLUMN pos_rms_charge_record.tender_family IS
    'Normalized tender family for financing flows. Charge rows use rms_charge; legacy payment collections may remain NULL.';

COMMENT ON COLUMN pos_rms_charge_record.metadata_json IS
    'Redacted financing metadata captured at checkout for receipts, audit, and future CoreCard posting workflows.';

UPDATE pos_rms_charge_record
SET
    tender_family = COALESCE(tender_family, CASE WHEN record_kind = 'charge' THEN 'rms_charge' ELSE NULL END),
    program_code = COALESCE(
        program_code,
        CASE
            WHEN record_kind = 'charge' AND payment_method = 'on_account_rms90' THEN 'rms90'
            WHEN record_kind = 'charge' AND payment_method = 'on_account_rms' THEN 'standard'
            ELSE NULL
        END
    ),
    program_label = COALESCE(
        program_label,
        CASE
            WHEN record_kind = 'charge' AND payment_method = 'on_account_rms90' THEN 'RMS 90'
            WHEN record_kind = 'charge' AND payment_method = 'on_account_rms' THEN 'Standard'
            ELSE NULL
        END
    ),
    resolution_status = COALESCE(
        resolution_status,
        CASE
            WHEN record_kind = 'charge' THEN 'legacy'
            WHEN record_kind = 'payment' THEN 'payment_collection'
            ELSE NULL
        END
    )
WHERE
    tender_family IS NULL
    OR program_code IS NULL
    OR program_label IS NULL
    OR resolution_status IS NULL;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'pos.rms_charge.use', true),
    ('admin', 'pos.rms_charge.lookup', true),
    ('admin', 'pos.rms_charge.history_basic', true),
    ('admin', 'customers.rms_charge.view', true),
    ('admin', 'customers.rms_charge.manage_links', true),
    ('sales_support', 'pos.rms_charge.use', true),
    ('sales_support', 'pos.rms_charge.lookup', true),
    ('sales_support', 'pos.rms_charge.history_basic', true),
    ('sales_support', 'customers.rms_charge.view', true),
    ('sales_support', 'customers.rms_charge.manage_links', true),
    ('salesperson', 'pos.rms_charge.use', true)
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO staff_permission (staff_id, permission_key, allowed)
SELECT sp.staff_id, nk.permission_key, sp.allowed
FROM staff_permission sp
CROSS JOIN (
    VALUES
        ('pos.rms_charge.use'),
        ('pos.rms_charge.lookup'),
        ('pos.rms_charge.history_basic'),
        ('customers.rms_charge.view'),
        ('customers.rms_charge.manage_links')
) AS nk(permission_key)
WHERE sp.permission_key = 'customers.rms_charge'
ON CONFLICT (staff_id, permission_key) DO UPDATE
SET allowed = EXCLUDED.allowed;

