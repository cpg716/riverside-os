ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS profile_discount_reason text;

UPDATE customers
SET profile_discount_reason = 'Legacy profile discount — reason not previously recorded'
WHERE profile_discount_percent > 0
  AND NULLIF(BTRIM(profile_discount_reason), '') IS NULL;

UPDATE customers
SET profile_discount_reason = NULL
WHERE profile_discount_percent = 0
  AND profile_discount_reason IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'customers_profile_discount_reason_chk'
          AND conrelid = 'customers'::regclass
    ) THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_profile_discount_reason_chk
            CHECK (
                (
                    profile_discount_percent = 0
                    AND profile_discount_reason IS NULL
                )
                OR
                (
                    profile_discount_percent > 0
                    AND NULLIF(BTRIM(profile_discount_reason), '') IS NOT NULL
                    AND CHAR_LENGTH(profile_discount_reason) <= 500
                )
            );
    END IF;
END
$$;

COMMENT ON COLUMN customers.profile_discount_reason IS
    'Required explanation for a persistent customer profile discount.';
