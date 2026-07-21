CREATE TABLE IF NOT EXISTS transaction_line_booking_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    transaction_line_id UUID REFERENCES transaction_lines(id) ON DELETE SET NULL,
    event_kind TEXT NOT NULL,
    booked_at TIMESTAMPTZ NOT NULL,
    subtotal_delta NUMERIC(14, 2) NOT NULL,
    tax_delta NUMERIC(14, 2) NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    line_kind TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transaction_line_booking_events_date
    ON transaction_line_booking_events (booked_at, transaction_id);

CREATE OR REPLACE FUNCTION record_transaction_line_booking_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    product_line_kind TEXT;
    internal_line BOOLEAN;
    event_booked_at TIMESTAMPTZ;
    old_subtotal NUMERIC(14, 2);
    old_tax NUMERIC(14, 2);
    new_subtotal NUMERIC(14, 2);
    new_tax NUMERIC(14, 2);
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT COALESCE(p.pos_line_kind, OLD.custom_item_type), COALESCE(OLD.is_internal, FALSE)
        INTO product_line_kind, internal_line
        FROM products p
        WHERE p.id = OLD.product_id;

        INSERT INTO transaction_line_booking_events (
            transaction_id, transaction_line_id, event_kind, booked_at,
            subtotal_delta, tax_delta, is_internal, line_kind, metadata
        ) VALUES (
            OLD.transaction_id, OLD.id, 'line_deleted', CURRENT_TIMESTAMP,
            -(OLD.quantity::NUMERIC * OLD.unit_price),
            -(OLD.quantity::NUMERIC * (COALESCE(OLD.state_tax, 0) + COALESCE(OLD.local_tax, 0))),
            COALESCE(internal_line, FALSE), product_line_kind,
            jsonb_build_object('product_id', OLD.product_id, 'variant_id', OLD.variant_id)
        );
        RETURN OLD;
    END IF;

    SELECT COALESCE(p.pos_line_kind, NEW.custom_item_type), COALESCE(NEW.is_internal, FALSE)
    INTO product_line_kind, internal_line
    FROM products p
    WHERE p.id = NEW.product_id;

    new_subtotal := NEW.quantity::NUMERIC * NEW.unit_price;
    new_tax := NEW.quantity::NUMERIC * (COALESCE(NEW.state_tax, 0) + COALESCE(NEW.local_tax, 0));

    IF TG_OP = 'INSERT' THEN
        SELECT COALESCE(NEW.booked_at, t.booked_at)
        INTO event_booked_at
        FROM transactions t
        WHERE t.id = NEW.transaction_id;

        INSERT INTO transaction_line_booking_events (
            transaction_id, transaction_line_id, event_kind, booked_at,
            subtotal_delta, tax_delta, is_internal, line_kind, metadata
        ) VALUES (
            NEW.transaction_id, NEW.id, 'initial_booking', COALESCE(event_booked_at, CURRENT_TIMESTAMP),
            new_subtotal, new_tax, internal_line, product_line_kind,
            jsonb_build_object('product_id', NEW.product_id, 'variant_id', NEW.variant_id)
        );
        RETURN NEW;
    END IF;

    IF OLD.quantity IS DISTINCT FROM NEW.quantity
        OR OLD.unit_price IS DISTINCT FROM NEW.unit_price
        OR OLD.state_tax IS DISTINCT FROM NEW.state_tax
        OR OLD.local_tax IS DISTINCT FROM NEW.local_tax
    THEN
        old_subtotal := OLD.quantity::NUMERIC * OLD.unit_price;
        old_tax := OLD.quantity::NUMERIC * (COALESCE(OLD.state_tax, 0) + COALESCE(OLD.local_tax, 0));

        INSERT INTO transaction_line_booking_events (
            transaction_id, transaction_line_id, event_kind, booked_at,
            subtotal_delta, tax_delta, is_internal, line_kind, metadata
        ) VALUES (
            NEW.transaction_id, NEW.id, 'line_amendment', CURRENT_TIMESTAMP,
            new_subtotal - old_subtotal, new_tax - old_tax, internal_line, product_line_kind,
            jsonb_build_object(
                'old_quantity', OLD.quantity,
                'new_quantity', NEW.quantity,
                'old_unit_price', OLD.unit_price,
                'new_unit_price', NEW.unit_price,
                'old_variant_id', OLD.variant_id,
                'new_variant_id', NEW.variant_id
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transaction_line_booking_event_trigger ON transaction_lines;
CREATE TRIGGER transaction_line_booking_event_trigger
AFTER INSERT OR UPDATE OR DELETE ON transaction_lines
FOR EACH ROW EXECUTE FUNCTION record_transaction_line_booking_event();

INSERT INTO transaction_line_booking_events (
    transaction_id, transaction_line_id, event_kind, booked_at,
    subtotal_delta, tax_delta, is_internal, line_kind, metadata
)
SELECT
    tl.transaction_id,
    tl.id,
    'initial_booking',
    COALESCE(tl.booked_at, t.booked_at, CURRENT_TIMESTAMP),
    tl.quantity::NUMERIC * tl.unit_price,
    tl.quantity::NUMERIC * (COALESCE(tl.state_tax, 0) + COALESCE(tl.local_tax, 0)),
    COALESCE(tl.is_internal, FALSE),
    COALESCE(p.pos_line_kind, tl.custom_item_type),
    jsonb_build_object('product_id', tl.product_id, 'variant_id', tl.variant_id, 'backfilled', true)
FROM transaction_lines tl
INNER JOIN transactions t ON t.id = tl.transaction_id
LEFT JOIN products p ON p.id = tl.product_id
WHERE NOT EXISTS (
    SELECT 1
    FROM transaction_line_booking_events existing
    WHERE existing.transaction_line_id = tl.id
      AND existing.event_kind = 'initial_booking'
);
