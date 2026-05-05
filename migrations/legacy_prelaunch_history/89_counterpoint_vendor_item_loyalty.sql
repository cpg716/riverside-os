-- Counterpoint bridge: PO_VEND_ITEM storage + idempotent PS_LOY_PTS_HIST → loyalty_point_ledger.

CREATE TABLE IF NOT EXISTS vendor_supplier_item (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
    cp_item_no TEXT NOT NULL,
    vendor_item_no TEXT NOT NULL DEFAULT '',
    vend_cost NUMERIC(14, 4),
    variant_id UUID REFERENCES product_variants (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vendor_supplier_item_vendor_item_uidx UNIQUE (vendor_id, cp_item_no, vendor_item_no)
);

CREATE INDEX IF NOT EXISTS vendor_supplier_item_variant_idx
    ON vendor_supplier_item (variant_id)
    WHERE variant_id IS NOT NULL;

COMMENT ON TABLE vendor_supplier_item IS
    'Counterpoint PO_VEND_ITEM (vendor SKU cross-ref). Links VEND_NO → vendors.id and ITEM_NO → product_variants when resolvable.';

-- Idempotent loyalty history imports (metadata.cp_ref = cust|bus_date|ref).
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_point_ledger_cp_ps_loy_ref_uidx
    ON loyalty_point_ledger ((metadata ->> 'cp_ref'))
    WHERE reason = 'cp_loy_pts_hist';

INSERT INTO ros_schema_migrations (version) VALUES ('89_counterpoint_vendor_item_loyalty.sql');
