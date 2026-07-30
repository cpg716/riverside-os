-- Reconstruct the deleted paid shirt line on TXN-566201 as itemized return
-- evidence and record the external card refund that staff completed in the old
-- POS on 2026-07-29.
--
-- This repair is intentionally source-locked. It preserves the picked-up suit,
-- does not move inventory, and records the ROS write time separately from the
-- refund's 2026-07-29 effective date.

DO $$
DECLARE
    v_transaction_id constant uuid := '2e5cc176-1f73-4350-9b09-81f77d9fd203';
    v_customer_id constant uuid := '62a08922-da95-4105-817f-3cb440542e57';
    v_deleted_line_id constant uuid := 'e0cbc362-de5d-41d8-8148-7d22b5cc9cac';
    v_deleted_product_id constant uuid := '49f44ba4-6262-46f0-978e-22b633cb5ed7';
    v_deleted_variant_id constant uuid := '08518c73-3b06-45e7-81e3-90741956db6f';
    v_remaining_suit_line_id constant uuid := '8b3bcd4a-a233-4456-85fc-0b72f867968d';
    v_actor_staff_id constant uuid := 'bf085089-e50b-4247-ae0f-155d37803d41';
    v_salesperson_id constant uuid := 'bc2e074f-c361-4963-a109-3702c43543d5';
    v_register_session_id constant uuid := '8435fbe0-c0d3-49c0-998f-c8640ba70ad4';
    v_refund_event_id constant uuid := '7d2f623a-3816-4088-b5c2-13846742edb3';
    v_refund_queue_id constant uuid := 'bb98e389-6c08-4f2d-b9fc-88e930baa38f';
    v_return_line_id constant uuid := '2f863531-74f6-4842-aa1c-10a9046a41bf';
    v_payment_id constant uuid := '3448e784-5ada-476d-ac49-ee5beb4bed93';
    v_allocation_id constant uuid := 'fe972dc2-e4e2-4816-829c-1ffb1ef11864';
    v_deleted_at constant timestamptz := '2026-07-29 15:42:52.413684-04';
    v_refund_effective_date constant date := DATE '2026-07-29';
    v_external_reference constant text := '1234';
    v_card_last4 constant text := '1234';
    v_refund_subtotal constant numeric(12,2) := 64.00;
    v_refund_state_tax constant numeric(12,2) := 0.00;
    v_refund_local_tax constant numeric(12,2) := 3.04;
    v_refund_total constant numeric(12,2) := 67.04;
    v_reason constant text :=
        'External card refund completed in the old POS on 2026-07-29; recorded in ROS at staff direction.';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id = v_transaction_id
    ) THEN
        RETURN;
    END IF;

    -- Idempotent success state.
    IF EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id = v_transaction_id
          AND display_id = 'TXN-566201'
          AND customer_id = v_customer_id
          AND status = 'fulfilled'
          AND total_price = 282.75
          AND amount_paid = 282.75
          AND balance_due = 0.00
    ) AND EXISTS (
        SELECT 1
        FROM public.transaction_lines
        WHERE id = v_deleted_line_id
          AND transaction_id = v_transaction_id
          AND product_id = v_deleted_product_id
          AND variant_id = v_deleted_variant_id
          AND quantity = 1
          AND unit_price = v_refund_subtotal
          AND state_tax = v_refund_state_tax
          AND local_tax = v_refund_local_tax
          AND is_fulfilled = FALSE
    ) AND EXISTS (
        SELECT 1
        FROM public.transaction_return_lines
        WHERE id = v_return_line_id
          AND transaction_id = v_transaction_id
          AND transaction_line_id = v_deleted_line_id
          AND quantity_returned = 1
          AND refund_event_id = v_refund_event_id
          AND refund_total = v_refund_total
          AND restocked = FALSE
    ) AND EXISTS (
        SELECT 1
        FROM public.transaction_refund_queue
        WHERE id = v_refund_queue_id
          AND transaction_id = v_transaction_id
          AND amount_due = v_refund_total
          AND amount_refunded = v_refund_total
          AND is_open = FALSE
    ) AND EXISTS (
        SELECT 1
        FROM public.payment_transactions payment
        INNER JOIN public.payment_allocations allocation
            ON allocation.transaction_id = payment.id
        WHERE payment.id = v_payment_id
          AND payment.session_id = v_register_session_id
          AND payment.payer_id = v_customer_id
          AND payment.payment_method = 'card_terminal_manual'
          AND payment.amount = -v_refund_total
          AND payment.status = 'approved'
          AND payment.effective_date = v_refund_effective_date
          AND payment.payment_provider = 'external'
          AND payment.provider_payment_id = v_external_reference
          AND payment.card_last4 = v_card_last4
          AND allocation.id = v_allocation_id
          AND allocation.target_transaction_id = v_transaction_id
          AND allocation.amount_allocated = -v_refund_total
    ) THEN
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.customers
        WHERE id = v_customer_id
          AND customer_code = 'NATHAN-8D4V'
          AND UPPER(first_name) = 'NATHAN'
          AND UPPER(last_name) = 'WEBSTER'
          AND phone = '607-377-6969'
    ) THEN
        RAISE EXCEPTION 'Migration 173: exact Nathan Webster customer was not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.staff
        WHERE id = v_actor_staff_id
          AND full_name = 'Chris G'
          AND is_active = TRUE
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.staff
        WHERE id = v_salesperson_id
          AND full_name = 'Robyn Cretacci'
          AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Migration 173: reviewed staff evidence no longer matches';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.register_sessions
        WHERE id = v_register_session_id
          AND register_lane = 1
          AND is_open = TRUE
          AND opened_by = v_actor_staff_id
          AND opened_at::date = DATE '2026-07-30'
    ) THEN
        RAISE EXCEPTION 'Migration 173: reviewed current Register #1 session is not open';
    END IF;

    PERFORM 1
    FROM public.transactions
    WHERE id = v_transaction_id
    FOR UPDATE;

    IF NOT EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id = v_transaction_id
          AND display_id = 'TXN-566201'
          AND customer_id = v_customer_id
          AND status = 'fulfilled'
          AND total_price = 282.75
          AND amount_paid = 349.79
          AND balance_due = -67.04
          AND business_date = DATE '2026-05-13'
    ) THEN
        RAISE EXCEPTION 'Migration 173: transaction no longer matches the reviewed unpaid refund state';
    END IF;

    IF (
        SELECT COUNT(*)
        FROM public.transaction_lines
        WHERE transaction_id = v_transaction_id
    ) <> 1 OR NOT EXISTS (
        SELECT 1
        FROM public.transaction_lines
        WHERE id = v_remaining_suit_line_id
          AND transaction_id = v_transaction_id
          AND quantity = 1
          AND unit_price = 260.00
          AND state_tax = 10.40
          AND local_tax = 12.35
          AND fulfillment = 'special_order'
          AND order_lifecycle_status = 'picked_up'
          AND is_fulfilled = TRUE
    ) THEN
        RAISE EXCEPTION 'Migration 173: remaining picked-up suit evidence no longer matches';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.transaction_lines
        WHERE id = v_deleted_line_id
    ) OR EXISTS (
        SELECT 1
        FROM public.transaction_return_lines
        WHERE transaction_id = v_transaction_id
    ) OR EXISTS (
        SELECT 1
        FROM public.transaction_refund_queue
        WHERE transaction_id = v_transaction_id
    ) OR EXISTS (
        SELECT 1
        FROM public.payment_allocations allocation
        WHERE allocation.target_transaction_id = v_transaction_id
          AND allocation.amount_allocated < 0
    ) THEN
        RAISE EXCEPTION 'Migration 173: refund evidence already exists but does not match the reviewed repair';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.transaction_activity_log
        WHERE transaction_id = v_transaction_id
          AND event_kind = 'item_deleted'
          AND created_at = v_deleted_at
          AND metadata->>'transaction_line_id' = v_deleted_line_id::text
          AND metadata->>'product_id' = v_deleted_product_id::text
          AND metadata->>'variant_id' = v_deleted_variant_id::text
          AND metadata->>'sku' = 'B-1621128'
          AND metadata->>'quantity' = '1'
          AND metadata->>'unit_price' = '64.00'
          AND metadata->>'state_tax' = '0'
          AND metadata->>'local_tax' = '3.04'
          AND metadata->>'fulfillment' = 'special_order'
          AND metadata->>'order_lifecycle_status' = 'ready_for_pickup'
          AND metadata->>'deleted_by_staff_id' = v_actor_staff_id::text
          AND metadata->>'payments_retained_on_transaction' = 'true'
    ) THEN
        RAISE EXCEPTION 'Migration 173: deleted shirt audit evidence no longer matches';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.product_variants
        WHERE id = v_deleted_variant_id
          AND product_id = v_deleted_product_id
          AND sku = 'B-1621128'
          AND retail_price_override = 80.00
          AND cost_override = 31.00
    ) THEN
        RAISE EXCEPTION 'Migration 173: deleted shirt catalog evidence no longer matches';
    END IF;

    INSERT INTO public.transaction_lines (
        id,
        transaction_id,
        product_id,
        variant_id,
        salesperson_id,
        fulfillment,
        quantity,
        unit_price,
        unit_cost,
        state_tax,
        local_tax,
        applied_spiff,
        calculated_commission,
        is_fulfilled,
        is_internal,
        order_lifecycle_status,
        ready_for_pickup_at,
        discount_amount,
        booked_at
    )
    VALUES (
        v_deleted_line_id,
        v_transaction_id,
        v_deleted_product_id,
        v_deleted_variant_id,
        v_salesperson_id,
        'special_order',
        1,
        v_refund_subtotal,
        31.00,
        v_refund_state_tax,
        v_refund_local_tax,
        0.00,
        0.00,
        FALSE,
        FALSE,
        'ready_for_pickup',
        TIMESTAMPTZ '2026-05-13 08:33:07-04',
        16.00,
        TIMESTAMPTZ '2026-05-13 08:33:07-04'
    );

    INSERT INTO public.transaction_return_lines (
        id,
        transaction_id,
        transaction_line_id,
        quantity_returned,
        reason,
        restocked,
        staff_id,
        created_at,
        refund_event_id,
        register_session_id,
        refund_subtotal,
        refund_state_tax,
        refund_local_tax,
        refund_total
    )
    VALUES (
        v_return_line_id,
        v_transaction_id,
        v_deleted_line_id,
        1,
        v_reason,
        FALSE,
        v_actor_staff_id,
        v_deleted_at,
        v_refund_event_id,
        v_register_session_id,
        v_refund_subtotal,
        v_refund_state_tax,
        v_refund_local_tax,
        v_refund_total
    );

    INSERT INTO public.transaction_refund_queue (
        id,
        transaction_id,
        customer_id,
        amount_due,
        amount_refunded,
        is_open,
        reason,
        created_at,
        closed_at
    )
    VALUES (
        v_refund_queue_id,
        v_transaction_id,
        v_customer_id,
        v_refund_total,
        v_refund_total,
        FALSE,
        v_reason,
        v_deleted_at,
        CURRENT_TIMESTAMP
    );

    INSERT INTO public.payment_transactions (
        id,
        session_id,
        payer_id,
        category,
        payment_method,
        amount,
        status,
        metadata,
        merchant_fee,
        net_amount,
        occurred_at,
        created_at,
        payment_provider,
        provider_payment_id,
        provider_status,
        card_last4,
        effective_date
    )
    VALUES (
        v_payment_id,
        v_register_session_id,
        v_customer_id,
        'retail_sale',
        'card_terminal_manual',
        -v_refund_total,
        'approved',
        jsonb_build_object(
            'kind', 'external_card_refund',
            'manual_terminal_confirmation', TRUE,
            'requires_operator_terminal_action', FALSE,
            'authorizing_manager_id', v_actor_staff_id,
            'reason', v_reason,
            'external_refund_reference', v_external_reference,
            'card_last4', v_card_last4,
            'external_refund_processor', 'external_card',
            'refund_event_id', v_refund_event_id,
            'transaction_id', v_transaction_id,
            'exact_refund_amount', v_refund_total,
            'refund_effective_date', v_refund_effective_date,
            'repair_migration', '173_record_txn_566201_external_card_refund.sql',
            'recorded_after_close', TRUE
        ),
        0.00,
        -v_refund_total,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        'external',
        v_external_reference,
        'approved',
        v_card_last4,
        v_refund_effective_date
    );

    INSERT INTO public.payment_allocations (
        id,
        transaction_id,
        target_transaction_id,
        amount_allocated,
        metadata
    )
    VALUES (
        v_allocation_id,
        v_payment_id,
        v_transaction_id,
        -v_refund_total,
        jsonb_build_object(
            'refund_event_id', v_refund_event_id,
            'repair_migration', '173_record_txn_566201_external_card_refund.sql'
        )
    );

    UPDATE public.transactions
    SET
        amount_paid = 282.75,
        balance_due = 0.00,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'qbo_revision_required', TRUE,
            'external_card_refund_repair', jsonb_build_object(
                'refund_event_id', v_refund_event_id,
                'payment_transaction_id', v_payment_id,
                'refund_effective_date', v_refund_effective_date,
                'recorded_at', CURRENT_TIMESTAMP,
                'repair_migration', '173_record_txn_566201_external_card_refund.sql'
            )
        )
    WHERE id = v_transaction_id;

    INSERT INTO public.staff_access_log (
        staff_id,
        event_kind,
        metadata
    )
    VALUES (
        v_actor_staff_id,
        'manual_external_card_refund_repair',
        jsonb_build_object(
            'transaction_id', v_transaction_id,
            'refund_queue_id', v_refund_queue_id,
            'refund_event_id', v_refund_event_id,
            'payment_transaction_id', v_payment_id,
            'register_session_id', v_register_session_id,
            'amount_cents', 6704,
            'external_refund_reference', v_external_reference,
            'card_last4', v_card_last4,
            'reason', v_reason,
            'repair_migration', '173_record_txn_566201_external_card_refund.sql'
        )
    );

    INSERT INTO public.transaction_activity_log (
        transaction_id,
        customer_id,
        event_kind,
        summary,
        metadata
    )
    VALUES
    (
        v_transaction_id,
        v_customer_id,
        'refund_evidence_reconstructed',
        'Reconstructed the deleted ChristopherLena shirt as itemized return evidence.',
        jsonb_build_object(
            'transaction_line_id', v_deleted_line_id,
            'sku', 'B-1621128',
            'product_name', 'ChristopherLena Reg Fit (C507)',
            'refund_event_id', v_refund_event_id,
            'refund_total', v_refund_total,
            'restocked', FALSE,
            'source_deleted_at', v_deleted_at,
            'repair_migration', '173_record_txn_566201_external_card_refund.sql'
        )
    ),
    (
        v_transaction_id,
        v_customer_id,
        'refund_processed',
        'Manual external card refund recorded for the removed ChristopherLena shirt.',
        jsonb_build_object(
            'kind', 'external_card_refund',
            'payment_transaction_id', v_payment_id,
            'refund_queue_id', v_refund_queue_id,
            'refund_event_id', v_refund_event_id,
            'amount', v_refund_total,
            'authorizing_manager_id', v_actor_staff_id,
            'reason', v_reason,
            'external_refund_reference', v_external_reference,
            'card_last4', v_card_last4,
            'external_refund_processor', 'external_card',
            'refund_effective_date', v_refund_effective_date,
            'repair_migration', '173_record_txn_566201_external_card_refund.sql'
        )
    );

    INSERT INTO public.customer_timeline_notes (
        customer_id,
        body,
        created_by
    )
    SELECT
        v_customer_id,
        'TXN-566201: $67.04 manual credit-card refund recorded for the removed ChristopherLena shirt. External reference 1234; refund effective 2026-07-29.',
        v_actor_staff_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.customer_timeline_notes
        WHERE customer_id = v_customer_id
          AND body = 'TXN-566201: $67.04 manual credit-card refund recorded for the removed ChristopherLena shirt. External reference 1234; refund effective 2026-07-29.'
    );
END
$$;
