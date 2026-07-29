-- Assign the completed WALK-IN sale TXN-624853 to Glenn Jones after staff
-- confirmed the sale was recorded without its intended customer.
--
-- Scope is intentionally exact. Financial totals, tax, inventory, fulfillment,
-- tender amount, and provider evidence are not changed.

DO $$
DECLARE
    v_transaction_id constant uuid := 'e9fbb62d-02e6-4256-9b3c-e6faced388a8';
    v_customer_id constant uuid := '0d420fc3-c810-44df-8385-e60e223073aa';
    v_payment_id constant uuid := 'e7fb59cc-4852-4870-b589-2a9b3bcc07a3';
    v_actor_staff_id constant uuid := 'bf085089-e50b-4247-ae0f-155d37803d41';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.customers
        WHERE id = v_customer_id
          AND customer_code = 'GLENN-D8P9'
          AND UPPER(first_name) = 'GLENN'
          AND UPPER(last_name) = 'JONES'
          AND phone = '716-200-3657'
    ) THEN
        RAISE EXCEPTION 'Migration 172: exact Glenn Jones customer record was not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.staff
        WHERE id = v_actor_staff_id
          AND full_name = 'Chris G'
          AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Migration 172: exact acting staff record was not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id = v_transaction_id
          AND display_id = 'TXN-624853'
          AND customer_id IS NOT DISTINCT FROM v_customer_id
          AND total_price = 79.61
          AND amount_paid = 79.61
          AND balance_due = 0.00
          AND status = 'fulfilled'
    ) AND NOT EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE id = v_transaction_id
          AND display_id = 'TXN-624853'
          AND customer_id IS NULL
          AND total_price = 79.61
          AND amount_paid = 79.61
          AND balance_due = 0.00
          AND status = 'fulfilled'
    ) THEN
        RAISE EXCEPTION 'Migration 172: transaction no longer matches the reviewed WALK-IN sale';
    END IF;

    IF (
        SELECT COUNT(*)
        FROM public.transaction_lines
        WHERE transaction_id = v_transaction_id
          AND fulfillment = 'takeaway'
          AND quantity = 1
          AND is_fulfilled = TRUE
          AND fulfillment_order_id IS NULL
    ) <> 1 OR (
        SELECT COUNT(*)
        FROM public.transaction_lines
        WHERE transaction_id = v_transaction_id
    ) <> 1 THEN
        RAISE EXCEPTION 'Migration 172: transaction lines no longer match the reviewed takeaway sale';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.payment_transactions payment
        INNER JOIN public.payment_allocations allocation
            ON allocation.transaction_id = payment.id
        WHERE payment.id = v_payment_id
          AND payment.payer_id IS NOT DISTINCT FROM v_customer_id
          AND payment.payment_method = 'card_terminal'
          AND payment.amount = 79.61
          AND payment.status = 'success'
          AND allocation.target_transaction_id = v_transaction_id
          AND allocation.amount_allocated = 79.61
          AND (
              SELECT COUNT(*)
              FROM public.payment_allocations all_allocations
              WHERE all_allocations.transaction_id = payment.id
          ) = 1
    ) AND NOT EXISTS (
        SELECT 1
        FROM public.payment_transactions payment
        INNER JOIN public.payment_allocations allocation
            ON allocation.transaction_id = payment.id
        WHERE payment.id = v_payment_id
          AND payment.payer_id IS NULL
          AND payment.payment_method = 'card_terminal'
          AND payment.amount = 79.61
          AND payment.status = 'success'
          AND allocation.target_transaction_id = v_transaction_id
          AND allocation.amount_allocated = 79.61
          AND (
              SELECT COUNT(*)
              FROM public.payment_allocations all_allocations
              WHERE all_allocations.transaction_id = payment.id
          ) = 1
    ) THEN
        RAISE EXCEPTION 'Migration 172: payment no longer matches the reviewed single-allocation tender';
    END IF;

    UPDATE public.transactions
    SET customer_id = v_customer_id
    WHERE id = v_transaction_id
      AND customer_id IS NULL;

    UPDATE public.payment_transactions
    SET payer_id = v_customer_id
    WHERE id = v_payment_id
      AND payer_id IS NULL;

    UPDATE public.transaction_activity_log
    SET customer_id = v_customer_id
    WHERE transaction_id = v_transaction_id
      AND customer_id IS NULL;

    INSERT INTO public.transaction_activity_log (
        transaction_id,
        customer_id,
        event_kind,
        summary,
        metadata
    )
    SELECT
        v_transaction_id,
        v_customer_id,
        'customer_reassignment',
        'Assigned completed WALK-IN transaction to Glenn Jones.',
        jsonb_build_object(
            'repair_migration', '172_reassign_txn_624853_to_glenn_jones.sql',
            'transaction_display_id', 'TXN-624853',
            'prior_customer_id', NULL,
            'new_customer_id', v_customer_id,
            'payment_id', v_payment_id,
            'actor_staff_id', v_actor_staff_id,
            'reason', 'Staff confirmed the completed WALK-IN sale belongs to Glenn Jones.'
        )
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.transaction_activity_log existing
        WHERE existing.transaction_id = v_transaction_id
          AND existing.event_kind = 'customer_reassignment'
          AND existing.metadata->>'repair_migration'
              = '172_reassign_txn_624853_to_glenn_jones.sql'
    );

    INSERT INTO public.customer_timeline_notes (
        customer_id,
        body,
        created_by
    )
    SELECT
        v_customer_id,
        'TXN-624853 was reassigned from WALK-IN to Glenn Jones after staff verification.',
        v_actor_staff_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.customer_timeline_notes existing
        WHERE existing.customer_id = v_customer_id
          AND existing.body
              = 'TXN-624853 was reassigned from WALK-IN to Glenn Jones after staff verification.'
    );
END
$$;
