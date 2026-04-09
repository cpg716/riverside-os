-- Adds QuickBooks integration/mapping tables for existing environments.
-- Greenfield databases created from 01_initial_schema.sql already include these tables.
CREATE TABLE IF NOT EXISTS qbo_integration (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    last_sync_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS qbo_accounts_cache (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_type TEXT,
    account_number TEXT,
    is_active BOOLEAN DEFAULT true,
    refreshed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    internal_key TEXT UNIQUE NOT NULL,
    internal_description TEXT,
    qbo_account_id TEXT REFERENCES qbo_accounts_cache(id),
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
