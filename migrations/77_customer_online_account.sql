-- Online storefront customer accounts: CRM source + optional password (same customer row).

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS customer_created_source TEXT NOT NULL DEFAULT 'store'
        CONSTRAINT customers_created_source_chk CHECK (customer_created_source IN ('store', 'online_store'));

COMMENT ON COLUMN customers.customer_created_source IS
    'store = staff/POS/import default; online_store = first created via public /shop account registration.';

CREATE TABLE customer_online_credential (
    customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_online_credential_updated ON customer_online_credential (updated_at DESC);

COMMENT ON TABLE customer_online_credential IS
    'Argon2 password for public /shop sign-in; one row per customer who activated online access.';
