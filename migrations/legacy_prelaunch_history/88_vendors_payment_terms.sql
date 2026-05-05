-- Counterpoint PO_VEND.TERMS_COD and similar: payment terms (e.g. Net 30), not supplier account numbers.

ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS payment_terms TEXT;

COMMENT ON COLUMN vendors.payment_terms IS
    'Supplier payment terms code or label (e.g. Counterpoint TERMS_COD). Distinct from account_number (AP account #).';

COMMENT ON COLUMN vendors.account_number IS
    'AP / supplier account number when known; not for payment terms (see payment_terms).';

INSERT INTO ros_schema_migrations (version) VALUES ('88_vendors_payment_terms.sql');
