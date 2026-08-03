-- TXN-625003 was intentionally backdated to 2026-08-01, but its checkout lines
-- inherited the transaction_lines CURRENT_TIMESTAMP default. The booking-event
-- trigger consequently reported the order on 2026-08-03. Repair only the exact
-- reviewed unpaid Wedding Transaction and retain the original timestamps in
-- event metadata for audit.

DO $$
DECLARE
    target_id UUID;
    target_booked_at TIMESTAMPTZ;
    target_customer_id UUID;
    reviewed_line_count BIGINT;
    already_repaired BOOLEAN;
BEGIN
    SELECT id, booked_at, customer_id
    INTO target_id, target_booked_at, target_customer_id
    FROM public.transactions
    WHERE display_id = 'TXN-625003'
      AND business_date = DATE '2026-08-01'
      AND total_price = 202.37
      AND amount_paid = 0.00
      AND balance_due = 202.37
      AND status = 'open'
      AND COALESCE((metadata->>'register_backdated')::boolean, FALSE) = TRUE;

    IF target_id IS NOT NULL THEN
        SELECT COUNT(*)
        INTO reviewed_line_count
        FROM public.transaction_lines line
        INNER JOIN public.product_variants variant ON variant.id = line.variant_id
        INNER JOIN public.transaction_line_booking_events event
            ON event.transaction_line_id = line.id
           AND event.event_kind = 'initial_booking'
        WHERE line.transaction_id = target_id
          AND (
              (variant.sku = 'B-1471072' AND line.quantity = 1
               AND line.unit_price = 52.00 AND line.state_tax = 0.00
               AND line.local_tax = 2.47 AND event.subtotal_delta = 52.00
               AND event.tax_delta = 2.47)
              OR
              (variant.sku = 'B-1504133' AND line.quantity = 1
               AND line.unit_price = 136.00 AND line.state_tax = 5.44
               AND line.local_tax = 6.46 AND event.subtotal_delta = 136.00
               AND event.tax_delta = 11.90)
          );

        IF reviewed_line_count <> 2 THEN
            RAISE EXCEPTION
                'TXN-625003 reporting repair refused: expected 2 exact reviewed lines, found %',
                reviewed_line_count;
        END IF;

        SELECT BOOL_AND(event.booked_at = target_booked_at)
        INTO already_repaired
        FROM public.transaction_line_booking_events event
        WHERE event.transaction_id = target_id
          AND event.event_kind = 'initial_booking';

        IF NOT COALESCE(already_repaired, FALSE) THEN
            UPDATE public.transaction_line_booking_events event
            SET
                booked_at = target_booked_at,
                metadata = COALESCE(event.metadata, '{}'::jsonb)
                    || jsonb_build_object(
                        'reporting_original_booked_at', event.booked_at,
                        'reporting_date_repaired_at', CURRENT_TIMESTAMP,
                        'reporting_date_repaired_by',
                            '178_repair_txn_625003_backdated_reporting.sql',
                        'reporting_date_repair_reason',
                            'Align initial booking event to manager-approved backdated Transaction'
                    )
            WHERE event.transaction_id = target_id
              AND event.event_kind = 'initial_booking';

            UPDATE public.transaction_lines line
            SET booked_at = target_booked_at
            WHERE line.transaction_id = target_id
              AND line.booked_at IS DISTINCT FROM target_booked_at;

            INSERT INTO public.transaction_activity_log (
                transaction_id, customer_id, event_kind, summary, metadata
            )
            VALUES (
                target_id,
                target_customer_id,
                'reporting_date_repaired',
                'Backdated booking events aligned to the approved Transaction business date',
                jsonb_build_object(
                    'business_date', '2026-08-01',
                    'line_count', reviewed_line_count,
                    'repair_source', '178_repair_txn_625003_backdated_reporting.sql',
                    'financial_totals_changed', FALSE,
                    'payment_ledger_changed', FALSE
                )
            );
        END IF;
    END IF;
END
$$;
