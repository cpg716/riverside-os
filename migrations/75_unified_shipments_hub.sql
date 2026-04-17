-- Unified shipment registry (POS, web storefront, manual hub) + audit log.

DO $$ BEGIN CREATE TYPE shipment_source AS ENUM ('pos_order', 'web_order', 'manual_hub'); EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE shipment_status AS ENUM (
        'draft',
        'quoted',
        'label_purchased',
        'in_transit',
        'delivered',
        'cancelled',
        'exception'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS shipment (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source shipment_source NOT NULL,
    order_id UUID REFERENCES orders (id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
    created_by_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    status shipment_status NOT NULL DEFAULT 'draft',
    ship_to JSONB NOT NULL DEFAULT '{}'::jsonb,
    parcel JSONB,
    quoted_amount_usd NUMERIC(12, 2),
    shipping_charged_usd NUMERIC(12, 2),
    label_cost_usd NUMERIC(12, 2),
    carrier TEXT,
    service_name TEXT,
    shippo_shipment_object_id TEXT,
    shippo_transaction_object_id TEXT,
    tracking_number TEXT,
    tracking_url_provider TEXT,
    shipping_label_url TEXT,
    internal_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX shipment_one_order_uidx ON shipment (order_id) WHERE order_id IS NOT NULL;

CREATE INDEX shipment_customer_idx ON shipment (customer_id);
CREATE INDEX shipment_status_idx ON shipment (status);
CREATE INDEX shipment_created_at_idx ON shipment (created_at DESC);
CREATE INDEX shipment_source_idx ON shipment (source);

CREATE TABLE shipment_event (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shipment_id UUID NOT NULL REFERENCES shipment (id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    staff_id UUID REFERENCES staff (id) ON DELETE SET NULL
);

CREATE INDEX shipment_event_shipment_at_idx ON shipment_event (shipment_id, at DESC);

COMMENT ON TABLE shipment IS 'Shipments from POS orders, web orders, or manual CRM creation; timeline in shipment_event.';
COMMENT ON TABLE shipment_event IS 'Append-only shipment audit log (status, rates, staff notes).';

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'shipments.view', true),
    ('admin', 'shipments.manage', true),
    ('sales_support', 'shipments.view', true),
    ('sales_support', 'shipments.manage', true),
    ('salesperson', 'shipments.view', true),
    ('salesperson', 'shipments.manage', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Backfill from orders that already have ship fulfillment (pre-shipment-table checkouts).
INSERT INTO shipment (
    source,
    order_id,
    customer_id,
    created_by_staff_id,
    status,
    ship_to,
    quoted_amount_usd,
    shipping_charged_usd,
    carrier,
    shippo_shipment_object_id,
    shippo_transaction_object_id,
    tracking_number,
    tracking_url_provider,
    shipping_label_url,
    created_at,
    updated_at
)
SELECT
    CASE o.sale_channel::text
        WHEN 'web' THEN 'web_order'::shipment_source
        ELSE 'pos_order'::shipment_source
    END,
    o.id,
    o.customer_id,
    o.operator_id,
    CASE
        WHEN o.status::text = 'fulfilled'
             AND o.tracking_number IS NOT NULL
             AND trim(o.tracking_number) <> '' THEN 'delivered'::shipment_status
        WHEN o.tracking_number IS NOT NULL AND trim(o.tracking_number) <> '' THEN 'in_transit'::shipment_status
        WHEN o.shipping_amount_usd IS NOT NULL AND o.shipping_amount_usd > 0 THEN 'quoted'::shipment_status
        ELSE 'draft'::shipment_status
    END,
    COALESCE(o.ship_to, '{}'::jsonb),
    o.shipping_amount_usd,
    o.shipping_amount_usd,
    NULL,
    o.shippo_shipment_object_id,
    o.shippo_transaction_object_id,
    o.tracking_number,
    o.tracking_url_provider,
    o.shipping_label_url,
    o.booked_at,
    o.booked_at
FROM orders o
WHERE o.fulfillment_method = 'ship'
  AND NOT EXISTS (SELECT 1 FROM shipment s WHERE s.order_id = o.id);

-- Backfill log lines for imported order-linked shipments (one event if none yet).
INSERT INTO shipment_event (shipment_id, kind, message, metadata)
SELECT
    s.id,
    'migration_backfill',
    'Imported existing order shipping fields into unified shipment registry.',
    jsonb_build_object('order_id', s.order_id::text)
FROM shipment s
WHERE s.order_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM shipment_event e WHERE e.shipment_id = s.id);
