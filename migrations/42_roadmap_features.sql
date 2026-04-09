-- Alterations, customer groups, product bundles, store credit (legacy staff TOTP columns added here; removed in 45_remove_staff_mfa.sql).

CREATE TYPE alteration_status AS ENUM ('intake', 'in_work', 'ready', 'picked_up');

CREATE TABLE IF NOT EXISTS alteration_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    wedding_member_id UUID REFERENCES wedding_members(id) ON DELETE SET NULL,
    status alteration_status NOT NULL DEFAULT 'intake',
    due_at TIMESTAMPTZ,
    notes TEXT,
    linked_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alteration_orders_customer ON alteration_orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alteration_orders_status ON alteration_orders (status, due_at);

CREATE TABLE IF NOT EXISTS customer_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_group_members (
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (customer_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_group_members_group ON customer_group_members (group_id);

CREATE TABLE IF NOT EXISTS product_bundle_components (
    bundle_product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    component_variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    PRIMARY KEY (bundle_product_id, component_variant_id)
);

CREATE TABLE IF NOT EXISTS store_credit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
    balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES store_credit_accounts(id) ON DELETE CASCADE,
    amount NUMERIC(14, 2) NOT NULL,
    balance_after NUMERIC(14, 2) NOT NULL,
    reason TEXT NOT NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_account ON store_credit_ledger (account_id, created_at DESC);

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS mfa_totp_secret TEXT,
    ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN staff.mfa_totp_secret IS 'Base32 TOTP secret (encrypt at rest in production); enrollment UX pending.';

INSERT INTO customer_groups (code, label) VALUES
    ('vip', 'VIP'),
    ('corporate', 'Corporate'),
    ('groomsmen', 'Groomsmen')
ON CONFLICT (code) DO NOTHING;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'customers.merge', true)
ON CONFLICT (role, permission_key) DO NOTHING;
