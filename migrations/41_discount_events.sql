-- Scheduled merchandising discounts (e.g. trunk show): variants in an event get an automatic percent off retail at checkout.

CREATE TABLE IF NOT EXISTS discount_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    receipt_label TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    percent_off NUMERIC(5, 2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT discount_events_percent CHECK (percent_off > 0::numeric AND percent_off <= 100::numeric),
    CONSTRAINT discount_events_range CHECK (ends_at >= starts_at)
);

CREATE TABLE IF NOT EXISTS discount_event_variants (
    event_id UUID NOT NULL REFERENCES discount_events(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_discount_event_variants_variant
    ON discount_event_variants (variant_id);

COMMENT ON TABLE discount_events IS 'Time-boxed automatic discount; POS/checkout references event id per line when price matches event percent.';
COMMENT ON TABLE discount_event_variants IS 'Variants eligible for a discount event.';
