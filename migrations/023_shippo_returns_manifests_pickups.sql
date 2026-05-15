-- Shippo return labels, manifests/SCAN forms, and pickup scheduling.

ALTER TABLE shipment
    ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound',
    ADD COLUMN IF NOT EXISTS parent_shipment_id UUID REFERENCES shipment(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS shippo_carrier_account_object_id TEXT,
    ADD COLUMN IF NOT EXISTS shippo_manifest_object_id TEXT,
    ADD COLUMN IF NOT EXISTS shippo_pickup_object_id TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'shipment_direction_chk'
    ) THEN
        ALTER TABLE shipment
            ADD CONSTRAINT shipment_direction_chk
            CHECK (direction IN ('outbound', 'return'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipment_parent_shipment_id
    ON shipment(parent_shipment_id)
    WHERE parent_shipment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipment_direction_status
    ON shipment(direction, status, created_at DESC);

CREATE TABLE IF NOT EXISTS shipment_batch (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    batch_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    carrier_account TEXT NOT NULL,
    shipment_date TIMESTAMPTZ,
    requested_start_time TIMESTAMPTZ,
    requested_end_time TIMESTAMPTZ,
    building_location_type TEXT,
    building_type TEXT,
    instructions TEXT,
    shippo_manifest_object_id TEXT,
    shippo_pickup_object_id TEXT,
    confirmation_code TEXT,
    document_url TEXT,
    raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT shipment_batch_type_chk CHECK (batch_type IN ('manifest', 'pickup')),
    CONSTRAINT shipment_batch_status_chk CHECK (status IN ('created', 'queued', 'success', 'error', 'confirmed', 'cancelled')),
    CONSTRAINT shipment_batch_carrier_account_chk CHECK (btrim(carrier_account) <> '')
);

CREATE TABLE IF NOT EXISTS shipment_batch_shipment (
    batch_id UUID NOT NULL REFERENCES shipment_batch(id) ON DELETE CASCADE,
    shipment_id UUID NOT NULL REFERENCES shipment(id) ON DELETE CASCADE,
    PRIMARY KEY (batch_id, shipment_id)
);

CREATE INDEX IF NOT EXISTS idx_shipment_batch_type_created
    ON shipment_batch(batch_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shipment_batch_shipment_shipment_id
    ON shipment_batch_shipment(shipment_id);

COMMENT ON COLUMN shipment.direction IS
    'outbound for customer deliveries, return for customer-to-store return labels.';

COMMENT ON COLUMN shipment.parent_shipment_id IS
    'Original outbound shipment when this row is a return-label workflow.';

COMMENT ON TABLE shipment_batch IS
    'Shippo manifests/SCAN forms and pickup scheduling batches for selected label transactions.';

COMMENT ON TABLE shipment_batch_shipment IS
    'Join table linking Shippo manifest/pickup batches to the included shipment rows.';
