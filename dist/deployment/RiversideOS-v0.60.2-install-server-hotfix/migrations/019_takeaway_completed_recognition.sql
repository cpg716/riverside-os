-- Treat fully takeaway pickup transactions as completed at sale time.
-- Order-style pickup transactions still wait for pickup fulfillment.

CREATE OR REPLACE FUNCTION reporting.order_recognition_at(
    p_order_id uuid,
    p_fulfillment_method text,
    p_status text,
    p_fulfilled_at timestamptz
) RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
    SELECT CASE
        WHEN p_status = 'cancelled' THEN NULL::timestamptz
        WHEN COALESCE(NULLIF(BTRIM(p_fulfillment_method), ''), 'pickup') = 'pickup'
          AND EXISTS (
              SELECT 1
              FROM transaction_lines tl_takeaway
              WHERE tl_takeaway.transaction_id = p_order_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM transaction_lines tl_non_takeaway
              WHERE tl_non_takeaway.transaction_id = p_order_id
                AND tl_non_takeaway.fulfillment::text <> 'takeaway'
          )
          THEN (
              SELECT o.booked_at
              FROM transactions o
              WHERE o.id = p_order_id
          )
        WHEN COALESCE(NULLIF(BTRIM(p_fulfillment_method), ''), 'pickup') = 'pickup' THEN p_fulfilled_at
        ELSE (
            SELECT MIN(se.at)
            FROM shipment s
            INNER JOIN shipment_event se ON se.shipment_id = s.id
            WHERE s.transaction_id = p_order_id
              AND COALESCE(s.status::text, '') <> 'cancelled'
              AND (
                  se.kind = 'label_purchased'
                  OR (se.kind = 'updated' AND (
                      se.message LIKE '%status set to in_transit%'
                      OR se.message LIKE '%status set to delivered%'
                  ))
              )
        )
    END;
$$;

COMMENT ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) IS
    'Completed-revenue clock: fully takeaway pickup transactions recognize at sale time; order-style pickup transactions use fulfilled_at; ship mode uses shipment events.';

REVOKE ALL ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) TO metabase_ro;';
    END IF;
END$$;
