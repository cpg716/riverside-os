-- Repair TXN-566054 after the July 21 Counterpoint repair changed a source
-- quantity from zero to one. The August 21 pickup then recalculated the
-- Transaction from that false $65 line and created a false customer balance.
--
-- This repair is deliberately source-locked to the retained Counterpoint raw
-- record, exact current financial state, exact line IDs, and exact pickup stock
-- movement. It preserves the valid $167.22 payment and suit pickup.

DO $migration$
DECLARE
    repair_transaction_uuid CONSTANT uuid := '4e30e9de-97ab-44d6-8b33-4b9d8532a29b';
    suit_line_id CONSTANT uuid := '8f217837-c842-4f6c-afcc-96dc7afb5421';
    shirt_line_id CONSTANT uuid := '73aacfaf-14a6-4629-b361-c3320fefe41c';
    shirt_variant_id CONSTANT uuid := '31812eb0-a103-483e-9461-f2cd98acc512';
    raw_record_id CONSTANT uuid := 'ed383cb6-014a-4745-afb0-d268faa71208';
    pickup_inventory_movement_id CONSTANT uuid := '8c6d6c80-9e1f-40dc-96be-13ea459b6339';
    source_document CONSTANT text := 'MAIN|1|1|2026-06-10T11:16:34|101161468876|O-117945';
    repair_name CONSTANT text := '211_repair_txn_566054_counterpoint_quantity.sql';
    source_payload jsonb;
    affected_count bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id = repair_transaction_uuid
    ) THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.transaction_activity_log activity
        WHERE activity.transaction_id = repair_transaction_uuid
          AND activity.event_kind = 'financial_repair'
          AND activity.metadata->>'repair_migration' = repair_name
    ) THEN
        IF NOT EXISTS (
            SELECT 1
            FROM public.transactions transaction_record
            INNER JOIN public.transaction_lines suit
                ON suit.id = suit_line_id
               AND suit.transaction_id = transaction_record.id
            INNER JOIN public.transaction_lines shirt
                ON shirt.id = shirt_line_id
               AND shirt.transaction_id = transaction_record.id
            WHERE transaction_record.id = repair_transaction_uuid
              AND transaction_record.status = 'fulfilled'::public.order_status
              AND ROUND(transaction_record.total_price, 2) = 282.75
              AND ROUND(transaction_record.amount_paid, 2) = 282.75
              AND ROUND(transaction_record.balance_due, 2) = 0
              AND suit.quantity = 1
              AND ROUND(suit.unit_price, 2) = 260.00
              AND ROUND(suit.state_tax, 2) = 10.40
              AND ROUND(suit.local_tax, 2) = 12.35
              AND shirt.quantity = 0
              AND shirt.size_specs->>'counterpoint_quantity' = '0'
              AND EXISTS (
                  SELECT 1
                  FROM public.inventory_transactions movement
                  WHERE movement.variant_id = shirt_variant_id
                    AND movement.tx_type = 'adjustment'::public.inventory_tx_type
                    AND movement.quantity_delta = 1
                    AND movement.reference_table = 'counterpoint_source_quantity_repair'
                    AND movement.reference_id = shirt_line_id
                    AND movement.notes = 'Migration 211: reverse false TXN-566054 shirt pickup decrement'
              )
        ) THEN
            RAISE EXCEPTION
                'Migration 211 found its audit marker but TXN-566054 is not in the verified repaired state';
        END IF;
        RETURN;
    END IF;

    SELECT raw.payload
    INTO source_payload
    FROM public.counterpoint_import_raw_records raw
    INNER JOIN public.counterpoint_import_runs import_run
        ON import_run.id = raw.import_run_id
       AND import_run.status = 'completed'
    WHERE raw.id = raw_record_id
      AND raw.entity_key = 'open_docs'
      AND raw.source_key = source_document
      AND raw.source_row_hash = 'a8cff87aed6d1369869bca507f55e933cbe92ecf77e8ce4521fc678607cfe5da'
      AND raw.landed = TRUE
      AND raw.landed_table = 'transactions'
      AND raw.landed_id = repair_transaction_uuid;

    IF source_payload IS NULL
       OR ROUND(NULLIF(source_payload->>'total_price', '')::numeric, 2) <> 282.75
       OR (
            SELECT COUNT(*)
            FROM jsonb_array_elements(source_payload->'lines') source_line
            WHERE source_line->>'sku' = 'B-1449396'
              AND NULLIF(source_line->>'lin_seq_no', '')::int = 1
              AND NULLIF(source_line->>'quantity', '')::int = 1
              AND ROUND(NULLIF(source_line->>'unit_price', '')::numeric, 2) = 260.00
          ) <> 1
       OR (
            SELECT COUNT(*)
            FROM jsonb_array_elements(source_payload->'lines') source_line
            WHERE source_line->>'sku' = 'B-1471092'
              AND NULLIF(source_line->>'lin_seq_no', '')::int = 2
              AND NULLIF(source_line->>'quantity', '')::int = 0
              AND ROUND(NULLIF(source_line->>'unit_price', '')::numeric, 2) = 65.00
          ) <> 1
    THEN
        RAISE EXCEPTION
            'Migration 211 refused TXN-566054 repair because retained Counterpoint source evidence does not match';
    END IF;

    SELECT COUNT(*)
    INTO affected_count
    FROM public.transactions transaction_record
    INNER JOIN public.transaction_lines suit
        ON suit.id = suit_line_id
       AND suit.transaction_id = transaction_record.id
    INNER JOIN public.transaction_lines shirt
        ON shirt.id = shirt_line_id
       AND shirt.transaction_id = transaction_record.id
    WHERE transaction_record.id = repair_transaction_uuid
      AND transaction_record.display_id = 'TXN-566054'
      AND transaction_record.counterpoint_doc_ref = source_document
      AND transaction_record.is_counterpoint_import = TRUE
      AND transaction_record.status = 'open'::public.order_status
      AND ROUND(transaction_record.total_price, 2) = 347.75
      AND ROUND(transaction_record.amount_paid, 2) = 282.75
      AND ROUND(transaction_record.balance_due, 2) = 65.00
      AND COALESCE(transaction_record.shipping_amount_usd, 0) = 0
      AND COALESCE(transaction_record.rounding_adjustment, 0) = 0
      AND transaction_record.fulfilled_at = TIMESTAMPTZ '2026-08-21 09:12:40.672849-04'
      AND suit.variant_id = '8584bc16-3f8b-41bf-bc1e-708bff2b432b'
      AND suit.quantity = 1
      AND ROUND(suit.unit_price, 2) = 260.00
      AND ROUND(suit.state_tax, 2) = 10.40
      AND ROUND(suit.local_tax, 2) = 7.80
      AND suit.is_fulfilled = TRUE
      AND suit.order_lifecycle_status = 'picked_up'::public.order_item_lifecycle_status
      AND shirt.variant_id = shirt_variant_id
      AND shirt.quantity = 1
      AND ROUND(shirt.unit_price, 2) = 65.00
      AND ROUND(shirt.state_tax, 2) = 2.60
      AND ROUND(shirt.local_tax, 2) = 1.95
      AND shirt.is_fulfilled = TRUE
      AND shirt.order_lifecycle_status = 'picked_up'::public.order_item_lifecycle_status
      AND shirt.size_specs->>'counterpoint_quantity' = '1';

    IF affected_count <> 1 THEN
        RAISE EXCEPTION
            'Migration 211 refused TXN-566054 repair: expected one exact pre-repair Transaction, found %',
            affected_count;
    END IF;

    IF (
        SELECT ROUND(COALESCE(SUM(allocation.amount_allocated), 0), 2)
        FROM public.payment_allocations allocation
        WHERE allocation.target_transaction_id = repair_transaction_uuid
    ) <> 282.75 THEN
        RAISE EXCEPTION
            'Migration 211 refused TXN-566054 repair because payment allocations do not equal $282.75';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.transaction_return_lines returned
        WHERE returned.transaction_line_id IN (suit_line_id, shirt_line_id)
    ) OR EXISTS (
        SELECT 1
        FROM public.commission_events commission
        WHERE commission.transaction_line_id = shirt_line_id
    ) OR EXISTS (
        SELECT 1
        FROM public.transaction_loyalty_accrual loyalty
        WHERE loyalty.transaction_id = repair_transaction_uuid
    ) OR EXISTS (
        SELECT 1
        FROM public.qbo_sync_outbox qbo
        WHERE qbo.transaction_id = repair_transaction_uuid
    ) THEN
        RAISE EXCEPTION
            'Migration 211 refused TXN-566054 repair because a downstream return, commission, loyalty, or QBO record now requires separate reversal';
    END IF;

    SELECT COUNT(*)
    INTO affected_count
    FROM public.inventory_transactions movement
    WHERE movement.id = pickup_inventory_movement_id
      AND movement.variant_id = shirt_variant_id
      AND movement.tx_type = 'sale'::public.inventory_tx_type
      AND movement.quantity_delta = -1
      AND movement.reference_table = 'transactions'
      AND movement.reference_id = repair_transaction_uuid
      AND movement.created_at = TIMESTAMPTZ '2026-08-21 09:12:40.672849-04';

    IF affected_count <> 1 OR EXISTS (
        SELECT 1
        FROM public.inventory_transactions movement
        WHERE movement.variant_id = shirt_variant_id
          AND movement.reference_table = 'counterpoint_source_quantity_repair'
          AND movement.reference_id = shirt_line_id
    ) THEN
        RAISE EXCEPTION
            'Migration 211 refused TXN-566054 repair because the false pickup inventory movement is missing or already reversed';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.transaction_line_booking_events initial_event
        WHERE initial_event.transaction_line_id = suit_line_id
          AND initial_event.event_kind = 'initial_booking'
          AND initial_event.subtotal_delta = 260.00
          AND initial_event.tax_delta = 22.75
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.transaction_line_booking_events bad_repair_event
        WHERE bad_repair_event.transaction_line_id = shirt_line_id
          AND bad_repair_event.event_kind = 'line_amendment'
          AND bad_repair_event.booked_at = TIMESTAMPTZ '2026-07-21 16:49:17.273017-04'
          AND bad_repair_event.subtotal_delta = 65.00
          AND bad_repair_event.tax_delta = 4.55
          AND bad_repair_event.metadata->>'old_quantity' = '0'
          AND bad_repair_event.metadata->>'new_quantity' = '1'
    ) THEN
        RAISE EXCEPTION
            'Migration 211 refused TXN-566054 repair because the retained booking-event evidence does not match';
    END IF;

    PERFORM set_config('riverside.suppress_booking_event', 'true', true);

    UPDATE public.transaction_lines suit
    SET state_tax = 10.40,
        local_tax = 12.35,
        size_specs = COALESCE(suit.size_specs, '{}'::jsonb) || jsonb_build_object(
            'counterpoint_source_quantity_repair', repair_name
        )
    WHERE suit.id = suit_line_id
      AND suit.transaction_id = repair_transaction_uuid
      AND suit.quantity = 1
      AND ROUND(suit.unit_price, 2) = 260.00
      AND ROUND(suit.state_tax, 2) = 10.40
      AND ROUND(suit.local_tax, 2) = 7.80;

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> 1 THEN
        RAISE EXCEPTION 'Migration 211 failed to restore the TXN-566054 suit tax allocation';
    END IF;

    UPDATE public.transaction_lines shirt
    SET quantity = 0,
        state_tax = 0,
        local_tax = 0,
        size_specs = COALESCE(shirt.size_specs, '{}'::jsonb)
            || jsonb_build_object(
                'counterpoint_quantity', 0,
                'counterpoint_source_quantity_repair', repair_name,
                'counterpoint_source_raw_record_id', raw_record_id,
                'counterpoint_source_row_hash', 'a8cff87aed6d1369869bca507f55e933cbe92ecf77e8ce4521fc678607cfe5da'
            )
    WHERE shirt.id = shirt_line_id
      AND shirt.transaction_id = repair_transaction_uuid
      AND shirt.quantity = 1
      AND ROUND(shirt.unit_price, 2) = 65.00
      AND ROUND(shirt.state_tax, 2) = 2.60
      AND ROUND(shirt.local_tax, 2) = 1.95;

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> 1 THEN
        RAISE EXCEPTION 'Migration 211 failed to restore the TXN-566054 source shirt quantity';
    END IF;

    INSERT INTO public.transaction_line_booking_events (
        transaction_id,
        transaction_line_id,
        event_kind,
        booked_at,
        subtotal_delta,
        tax_delta,
        is_internal,
        line_kind,
        metadata
    ) VALUES
    (
        repair_transaction_uuid,
        suit_line_id,
        'line_amendment',
        now(),
        0,
        4.55,
        FALSE,
        NULL,
        jsonb_build_object(
            'repair_migration', repair_name,
            'reporting_excluded', 'counterpoint_source_quantity_repair',
            'old_state_tax', 10.40,
            'new_state_tax', 10.40,
            'old_local_tax', 7.80,
            'new_local_tax', 12.35
        )
    ),
    (
        repair_transaction_uuid,
        shirt_line_id,
        'line_amendment',
        now(),
        -65.00,
        -4.55,
        FALSE,
        NULL,
        jsonb_build_object(
            'repair_migration', repair_name,
            'reporting_excluded', 'counterpoint_source_quantity_repair',
            'old_quantity', 1,
            'new_quantity', 0,
            'counterpoint_source_raw_record_id', raw_record_id
        )
    );

    INSERT INTO public.inventory_transactions (
        variant_id,
        tx_type,
        quantity_delta,
        reference_table,
        reference_id,
        notes
    ) VALUES (
        shirt_variant_id,
        'adjustment'::public.inventory_tx_type,
        1,
        'counterpoint_source_quantity_repair',
        shirt_line_id,
        'Migration 211: reverse false TXN-566054 shirt pickup decrement'
    );

    UPDATE public.product_variants variant
    SET stock_on_hand = COALESCE(variant.stock_on_hand, 0) + 1
    WHERE variant.id = shirt_variant_id;

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> 1 THEN
        RAISE EXCEPTION 'Migration 211 failed to reverse the false shirt inventory decrement';
    END IF;

    UPDATE public.transactions transaction_record
    SET total_price = 282.75,
        balance_due = 0,
        status = 'fulfilled'::public.order_status,
        metadata = COALESCE(transaction_record.metadata, '{}'::jsonb)
            || jsonb_build_object(
                'counterpoint_source_quantity_repair', jsonb_build_object(
                    'repair_migration', repair_name,
                    'repaired_at', now(),
                    'source_raw_record_id', raw_record_id,
                    'source_row_hash', 'a8cff87aed6d1369869bca507f55e933cbe92ecf77e8ce4521fc678607cfe5da',
                    'shirt_transaction_line_id', shirt_line_id,
                    'old_shirt_quantity', 1,
                    'new_shirt_quantity', 0,
                    'preserved_amount_paid', 282.75,
                    'removed_false_balance', 65.00,
                    'reversed_inventory_quantity', 1
                )
            )
    WHERE transaction_record.id = repair_transaction_uuid
      AND transaction_record.status = 'open'::public.order_status
      AND ROUND(transaction_record.total_price, 2) = 347.75
      AND ROUND(transaction_record.amount_paid, 2) = 282.75
      AND ROUND(transaction_record.balance_due, 2) = 65.00;

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> 1 THEN
        RAISE EXCEPTION 'Migration 211 failed to clear the false TXN-566054 balance';
    END IF;

    INSERT INTO public.transaction_activity_log (
        transaction_id,
        customer_id,
        event_kind,
        summary,
        metadata
    )
    SELECT
        transaction_record.id,
        transaction_record.customer_id,
        'financial_repair',
        'Removed false $65 Counterpoint shirt quantity and cleared the customer balance.',
        jsonb_build_object(
            'repair_migration', repair_name,
            'counterpoint_document', source_document,
            'counterpoint_raw_record_id', raw_record_id,
            'counterpoint_source_row_hash', 'a8cff87aed6d1369869bca507f55e933cbe92ecf77e8ce4521fc678607cfe5da',
            'shirt_transaction_line_id', shirt_line_id,
            'old_shirt_quantity', 1,
            'new_shirt_quantity', 0,
            'old_total_price', 347.75,
            'new_total_price', 282.75,
            'amount_paid_preserved', 282.75,
            'old_balance_due', 65.00,
            'new_balance_due', 0,
            'inventory_reversal_quantity', 1,
            'valid_payment_preserved', 167.22,
            'valid_suit_pickup_preserved', TRUE
        )
    FROM public.transactions transaction_record
    WHERE transaction_record.id = repair_transaction_uuid;

    IF NOT EXISTS (
        SELECT 1
        FROM public.transactions transaction_record
        INNER JOIN public.transaction_lines suit ON suit.id = suit_line_id
        INNER JOIN public.transaction_lines shirt ON shirt.id = shirt_line_id
        WHERE transaction_record.id = repair_transaction_uuid
          AND transaction_record.status = 'fulfilled'::public.order_status
          AND ROUND(transaction_record.total_price, 2) = 282.75
          AND ROUND(transaction_record.amount_paid, 2) = 282.75
          AND ROUND(transaction_record.balance_due, 2) = 0
          AND ROUND(
                suit.quantity * (suit.unit_price + suit.state_tax + suit.local_tax)
                + shirt.quantity * (shirt.unit_price + shirt.state_tax + shirt.local_tax),
                2
              ) = 282.75
          AND shirt.quantity = 0
          AND shirt.size_specs->>'counterpoint_quantity' = '0'
          AND (
                SELECT COUNT(*)
                FROM public.inventory_transactions movement
                WHERE movement.variant_id = shirt_variant_id
                  AND movement.tx_type = 'adjustment'::public.inventory_tx_type
                  AND movement.quantity_delta = 1
                  AND movement.reference_table = 'counterpoint_source_quantity_repair'
                  AND movement.reference_id = shirt_line_id
              ) = 1
          AND (
                SELECT COUNT(*)
                FROM public.transaction_activity_log activity
                WHERE activity.transaction_id = repair_transaction_uuid
                  AND activity.event_kind = 'financial_repair'
                  AND activity.metadata->>'repair_migration' = repair_name
              ) = 1
    ) THEN
        RAISE EXCEPTION 'Migration 211 post-state verification failed for TXN-566054';
    END IF;
END
$migration$;
