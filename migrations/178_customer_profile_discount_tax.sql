-- Customer-level POS profile controls for automatic discounts and tax exemption.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS profile_discount_percent numeric(5, 2) NOT NULL DEFAULT 0;

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS tax_exempt boolean NOT NULL DEFAULT false;

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS tax_exempt_id text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'customers_profile_discount_percent_chk'
    ) THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_profile_discount_percent_chk
            CHECK (profile_discount_percent >= 0 AND profile_discount_percent <= 100);
    END IF;
END $$;

COMMENT ON COLUMN customers.profile_discount_percent IS
    'Customer profile blanket POS discount percentage for regular-priced items.';

COMMENT ON COLUMN customers.tax_exempt IS
    'When true, POS checkout starts tax-exempt for this customer profile.';

COMMENT ON COLUMN customers.tax_exempt_id IS
    'Tax exemption certificate or tax ID recorded on the customer profile.';
