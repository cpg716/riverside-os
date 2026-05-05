-- RMS CHARGE PAYMENT (R2S pass-through) line kind, ledger seed, pos_rms_charge_record kinds,
-- ad-hoc task_instance (nullable assignment_id), RBAC customers.rms_charge.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS pos_line_kind TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'products_pos_line_kind_chk'
    ) THEN
        ALTER TABLE products
            ADD CONSTRAINT products_pos_line_kind_chk CHECK (
                pos_line_kind IS NULL OR pos_line_kind = 'rms_charge_payment'
            );
    END IF;
END $$;

COMMENT ON COLUMN products.pos_line_kind IS
    'POS-only line semantics. rms_charge_payment = R2S payment collection (no tax at checkout; QBO pass-through).';

INSERT INTO categories (id, name, is_clothing_footwear)
VALUES (
    'b7c0a001-0001-4001-8001-000000000001'::uuid,
    'Internal / POS',
    false
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO category_commission_overrides (category_id, commission_rate)
SELECT c.id, 0
FROM categories c
WHERE c.name = 'Internal / POS'
ON CONFLICT (category_id) DO UPDATE SET commission_rate = 0;

INSERT INTO products (
    id,
    category_id,
    catalog_handle,
    name,
    brand,
    description,
    base_retail_price,
    base_cost,
    spiff_amount,
    variation_axes,
    images,
    is_active,
    is_bundle,
    excludes_from_loyalty,
    pos_line_kind
)
VALUES (
    'b7c0a002-0002-4002-8002-000000000002'::uuid,
    (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1),
    'ros-rms-charge-payment',
    'RMS CHARGE PAYMENT',
    'Riverside OS',
    'R2S payment collection — add via Register search PAYMENT; enter amount on keypad.',
    0.00,
    0.00,
    0.00,
    '{}'::text[],
    '{}'::text[],
    true,
    false,
    true,
    'rms_charge_payment'
)
ON CONFLICT (catalog_handle) DO UPDATE SET
    pos_line_kind = 'rms_charge_payment',
    excludes_from_loyalty = true,
    name = EXCLUDED.name,
    category_id = (SELECT id FROM categories WHERE name = 'Internal / POS' LIMIT 1);

INSERT INTO product_variants (
    id,
    product_id,
    sku,
    variation_values,
    variation_label,
    stock_on_hand,
    reorder_point,
    reserved_stock,
    track_low_stock
)
VALUES (
    'b7c0a003-0003-4003-8003-000000000003'::uuid,
    'b7c0a002-0002-4002-8002-000000000002'::uuid,
    'ROS-RMS-CHARGE-PAYMENT',
    '{}'::jsonb,
    NULL,
    0,
    0,
    0,
    false
)
ON CONFLICT (sku) DO UPDATE SET
    product_id = 'b7c0a002-0002-4002-8002-000000000002'::uuid;

ALTER TABLE pos_rms_charge_record
    ADD COLUMN IF NOT EXISTS record_kind TEXT NOT NULL DEFAULT 'charge';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pos_rms_charge_record_kind_chk'
    ) THEN
        ALTER TABLE pos_rms_charge_record
            ADD CONSTRAINT pos_rms_charge_record_kind_chk CHECK (record_kind IN ('charge', 'payment'));
    END IF;
END $$;

COMMENT ON COLUMN pos_rms_charge_record.record_kind IS
    'charge = sale tender on_account_rms / on_account_rms90; payment = cash/check R2S payment collection.';

CREATE INDEX IF NOT EXISTS idx_pos_rms_charge_record_kind_created
    ON pos_rms_charge_record (record_kind, created_at DESC);

ALTER TABLE task_instance DROP CONSTRAINT IF EXISTS task_instance_assignment_id_fkey;

ALTER TABLE task_instance ALTER COLUMN assignment_id DROP NOT NULL;

ALTER TABLE task_instance
    ADD CONSTRAINT task_instance_assignment_id_fkey
    FOREIGN KEY (assignment_id) REFERENCES task_assignment (id) ON DELETE SET NULL;

COMMENT ON COLUMN task_instance.assignment_id IS
    'NULL for ad-hoc tasks (e.g. R2S payment follow-up); otherwise recurring assignment.';

INSERT INTO ledger_mappings (internal_key, internal_description, qbo_account_id)
VALUES (
    'RMS_R2S_PAYMENT_CLEARING',
    'R2S payment pass-through — credit offset to cash/check tenders (Due to R2S / clearing)',
    NULL
)
ON CONFLICT (internal_key) DO NOTHING;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'customers.rms_charge', true),
    ('sales_support', 'customers.rms_charge', true)
ON CONFLICT (role, permission_key) DO NOTHING;
