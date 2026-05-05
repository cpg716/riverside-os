-- ROSIE-assisted catalog normalization audit trail.

CREATE TABLE IF NOT EXISTS product_catalog_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    changed_by UUID REFERENCES staff(id),
    change_source TEXT NOT NULL DEFAULT 'manual',
    before_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    change_note TEXT,
    suggestion_confidence DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_product_catalog_audit_product_created
    ON product_catalog_audit_log (product_id, created_at DESC);

COMMENT ON TABLE product_catalog_audit_log IS
    'Append-only audit trail for manual and ROSIE-assisted catalog normalization changes.';
