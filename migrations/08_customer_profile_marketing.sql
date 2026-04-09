-- Customer postal profile + marketing opt-in (separate from transactional messages).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_email_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN customers.marketing_email_opt_in IS 'Promotional email only; transactional email (receipts, appointments) unaffected.';
COMMENT ON COLUMN customers.marketing_sms_opt_in IS 'Promotional SMS only; transactional SMS (pickup, appts) unaffected.';
