-- Migration 28: Universal customer_code, company, DOB, anniversary, Lightspeed custom fields

CREATE SEQUENCE IF NOT EXISTS customer_code_seq START WITH 1;

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS customer_code TEXT,
    ADD COLUMN IF NOT EXISTS company_name TEXT,
    ADD COLUMN IF NOT EXISTS date_of_birth DATE,
    ADD COLUMN IF NOT EXISTS anniversary_date DATE,
    ADD COLUMN IF NOT EXISTS custom_field_1 TEXT,
    ADD COLUMN IF NOT EXISTS custom_field_2 TEXT,
    ADD COLUMN IF NOT EXISTS custom_field_3 TEXT,
    ADD COLUMN IF NOT EXISTS custom_field_4 TEXT;

-- Backfill customer_code for existing rows (stable order)
UPDATE customers u
SET customer_code = v.code
FROM (
    SELECT
        id,
        'ROS-' || LPAD(nextval('customer_code_seq')::text, 8, '0') AS code
    FROM customers
    WHERE customer_code IS NULL
    ORDER BY created_at NULLS LAST, id
) v
WHERE u.id = v.id;

ALTER TABLE customers
    ALTER COLUMN customer_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_code ON customers (customer_code);

COMMENT ON COLUMN customers.customer_code IS 'Stable store-facing id; matches Lightspeed customer_code when imported; auto-assigned for new ROS customers.';
COMMENT ON COLUMN customers.company_name IS 'Organization name when different from person name.';
COMMENT ON COLUMN customers.anniversary_date IS 'Wedding or anniversary date for CRM.';
COMMENT ON COLUMN customers.custom_field_1 IS 'Imported from Lightspeed custom_field_1; general-purpose.';
COMMENT ON COLUMN customers.custom_field_2 IS 'Imported from Lightspeed custom_field_2; general-purpose.';
COMMENT ON COLUMN customers.custom_field_3 IS 'Imported from Lightspeed custom_field_3; general-purpose.';
COMMENT ON COLUMN customers.custom_field_4 IS 'Imported from Lightspeed custom_field_4; general-purpose.';
