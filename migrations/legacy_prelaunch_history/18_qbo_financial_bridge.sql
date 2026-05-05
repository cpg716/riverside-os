-- Phase 2.15: QBO financial bridge — granular mappings, sync staging, credentials.

ALTER TABLE qbo_integration
    ADD COLUMN IF NOT EXISTS client_id TEXT,
    ADD COLUMN IF NOT EXISTS client_secret TEXT,
    ADD COLUMN IF NOT EXISTS realm_id TEXT,
    ADD COLUMN IF NOT EXISTS use_sandbox BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN qbo_integration.client_secret IS 'Store in vault in production; MVP plaintext for single-tenant dev.';
COMMENT ON COLUMN qbo_integration.realm_id IS 'QuickBooks company (realm) id from Intuit; falls back to company_id when null.';

UPDATE qbo_integration SET realm_id = company_id WHERE realm_id IS NULL AND company_id IS NOT NULL AND company_id <> '';

CREATE TABLE IF NOT EXISTS qbo_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    qbo_account_id TEXT NOT NULL REFERENCES qbo_accounts_cache (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    qbo_account_name TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_type, source_id)
);

COMMENT ON TABLE qbo_mappings IS 'Mapping-first COA: category revenue/inventory/cogs, tenders, tax, gift card, holding accounts.';
COMMENT ON COLUMN qbo_mappings.source_type IS 'category_revenue | category_inventory | category_cogs | tender | tax | liability_deposit | liability_gift_card | expense_loyalty | clearing_invoice_holding | expense_shipping';

CREATE TABLE IF NOT EXISTS qbo_sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sync_date DATE NOT NULL,
    journal_entry_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS qbo_sync_logs_date_status_idx
    ON qbo_sync_logs (sync_date DESC, status);

COMMENT ON TABLE qbo_sync_logs IS 'Proposed QBO journal entries: pending → approved → synced | failed.';
