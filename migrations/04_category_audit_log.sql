-- Adds audit trail for category and tax-rule changes.
-- Greenfield databases created from 01_initial_schema.sql already include this table.
CREATE TABLE IF NOT EXISTS category_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    changed_field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by UUID REFERENCES staff(id),
    change_note TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
