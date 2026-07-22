-- A deleted line can no longer satisfy the booking event's line foreign key.
-- Keep the deleted line UUID in immutable metadata, and skip the synthetic
-- line event when the owning transaction itself is being deleted (its complete
-- event history is removed by the transaction foreign key's ON DELETE CASCADE).
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
        -- A cascading transaction deletion has already made the parent row
        -- unavailable. Do not create an event that cannot outlive its parent.
        IF OLD.transaction_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM transactions t
            WHERE t.id = OLD.transaction_id
        ) THEN
            RETURN OLD;
        END IF;

        SELECT COALESCE(p.pos_line_kind, OLD.custom_item_type), COALESCE(OLD.is_internal, FALSE)
        INTO product_line_kind, internal_line
        FROM products p
        WHERE p.id = OLD.product_id;

        INSERT INTO transaction_line_booking_events (
            transaction_id, transaction_line_id, event_kind, booked_at,
            subtotal_delta, tax_delta, is_internal, line_kind, metadata
        ) VALUES (
            OLD.transaction_id, NULL, 'line_deleted', CURRENT_TIMESTAMP,
            -(OLD.quantity::NUMERIC * OLD.unit_price),
            -(OLD.quantity::NUMERIC * (COALESCE(OLD.state_tax, 0) + COALESCE(OLD.local_tax, 0))),
            COALESCE(internal_line, FALSE), product_line_kind,
            jsonb_build_object(
                'deleted_transaction_line_id', OLD.id,
                'product_id', OLD.product_id,
                'variant_id', OLD.variant_id
            )
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
