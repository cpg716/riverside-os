-- Staff Accounts: receivable balance for employees linked to customer records.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pos_line_kind_chk;
ALTER TABLE products
    ADD CONSTRAINT products_pos_line_kind_chk CHECK (
        pos_line_kind IS NULL
        OR pos_line_kind IN (
            'rms_charge_payment',
            'pos_gift_card_load',
            'alteration_service',
            'staff_account_payment'
        )
    );

COMMENT ON COLUMN products.pos_line_kind IS
    'POS-only line semantics. rms_charge_payment = R2S payment collection; pos_gift_card_load = purchased card value; alteration_service = register alteration work-order service line; staff_account_payment = employee staff account paydown.';

CREATE TABLE IF NOT EXISTS staff_accounts (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'active',
    current_balance numeric(14,2) NOT NULL DEFAULT 0.00,
    credit_limit numeric(14,2) NOT NULL DEFAULT 0.00,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_accounts_status_chk CHECK (status IN ('active', 'paused', 'closed')),
    CONSTRAINT staff_accounts_balance_nonnegative CHECK (current_balance >= 0),
    CONSTRAINT staff_accounts_credit_limit_nonnegative CHECK (credit_limit >= 0),
    CONSTRAINT staff_accounts_staff_unique UNIQUE (staff_id),
    CONSTRAINT staff_accounts_customer_unique UNIQUE (customer_id)
);

CREATE TABLE IF NOT EXISTS staff_account_ledger (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    staff_account_id uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
    entry_kind text NOT NULL,
    amount numeric(14,2) NOT NULL,
    balance_before numeric(14,2) NOT NULL,
    balance_after numeric(14,2) NOT NULL,
    transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
    payment_transaction_id uuid REFERENCES payment_transactions(id) ON DELETE SET NULL,
    register_session_id uuid REFERENCES register_sessions(id) ON DELETE SET NULL,
    operator_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_account_ledger_kind_chk CHECK (entry_kind IN ('charge', 'payment', 'adjustment', 'reversal')),
    CONSTRAINT staff_account_ledger_amount_nonzero CHECK (amount <> 0)
);

CREATE INDEX IF NOT EXISTS idx_staff_account_ledger_account_created
    ON staff_account_ledger (staff_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_account_ledger_transaction
    ON staff_account_ledger (transaction_id);

INSERT INTO staff_accounts (staff_id, customer_id)
SELECT s.id, s.employee_customer_id
FROM staff s
WHERE s.employee_customer_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO products (
    id, category_id, catalog_handle, name, brand, description,
    base_retail_price, base_cost, spiff_amount, variation_axes,
    images, is_active, is_bundle, excludes_from_loyalty, pos_line_kind
)
VALUES (
    'b7c0a008-0008-4008-8008-000000000008'::uuid,
    (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1),
    'ros-staff-account-payment',
    'STAFF ACCOUNT PAYMENT',
    'Riverside OS',
    'Register staff account paydown line. Use from the Staff Account action.',
    0.00, 0.00, 0.00, '{}'::text[], '{}'::text[], true, false, true, 'staff_account_payment'
)
ON CONFLICT (id) DO UPDATE SET
    catalog_handle = EXCLUDED.catalog_handle,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    pos_line_kind = EXCLUDED.pos_line_kind,
    excludes_from_loyalty = EXCLUDED.excludes_from_loyalty;

INSERT INTO product_variants (
    id, product_id, sku, variation_values, variation_label,
    stock_on_hand, reorder_point, reserved_stock, track_low_stock
)
VALUES (
    'b7c0a009-0009-4009-8009-000000000009'::uuid,
    'b7c0a008-0008-4008-8008-000000000008'::uuid,
    'ROS-STAFF-ACCOUNT-PAYMENT',
    '{}'::jsonb,
    NULL,
    0,
    0,
    0,
    false
)
ON CONFLICT (id) DO UPDATE SET
    product_id = EXCLUDED.product_id,
    sku = EXCLUDED.sku;

INSERT INTO qbo_mappings (source_type, source_id, qbo_account_id, qbo_account_name)
SELECT 'asset_staff_accounts_receivable', 'default', 'STAFF_ACCOUNTS_RECEIVABLE', 'Staff Accounts Receivable'
WHERE NOT EXISTS (
    SELECT 1
    FROM qbo_mappings
    WHERE source_type = 'asset_staff_accounts_receivable'
      AND source_id = 'default'
);
