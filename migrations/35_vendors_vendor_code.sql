-- Vendor code from POS / supplier exports (e.g. Lightspeed supplier_code). Distinct from account_number (AP).

ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS vendor_code TEXT;
