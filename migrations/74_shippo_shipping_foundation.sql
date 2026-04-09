-- Shippo shipping foundation: order ship metadata, persisted rate quotes, Settings JSON.

CREATE TYPE order_fulfillment_method AS ENUM ('pickup', 'ship');

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS fulfillment_method order_fulfillment_method NOT NULL DEFAULT 'pickup',
    ADD COLUMN IF NOT EXISTS ship_to JSONB,
    ADD COLUMN IF NOT EXISTS shipping_amount_usd NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS shippo_shipment_object_id TEXT,
    ADD COLUMN IF NOT EXISTS shippo_transaction_object_id TEXT,
    ADD COLUMN IF NOT EXISTS tracking_number TEXT,
    ADD COLUMN IF NOT EXISTS tracking_url_provider TEXT,
    ADD COLUMN IF NOT EXISTS shipping_label_url TEXT;

COMMENT ON COLUMN orders.fulfillment_method IS 'Customer delivery mode: pickup vs ship (Shippo). Distinct from order_items.fulfillment (stock/special-order path).';
COMMENT ON COLUMN orders.ship_to IS 'Structured ship-to address (JSON) when fulfillment_method = ship.';
COMMENT ON COLUMN orders.shipping_amount_usd IS 'Customer-charged shipping (may differ from label cost).';

ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS shippo_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN store_settings.shippo_config IS 'Shippo: from address, default parcel, live_rates_enabled — see logic/shippo.rs.';

CREATE TABLE store_shipping_rate_quote (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expires_at TIMESTAMPTZ NOT NULL,
    amount_usd NUMERIC(12, 2) NOT NULL,
    carrier TEXT NOT NULL,
    service_name TEXT NOT NULL,
    shippo_rate_object_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX store_shipping_rate_quote_expires_idx ON store_shipping_rate_quote (expires_at);
