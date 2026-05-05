-- Reduce slow-query noise on customer browse, register activity, fulfillment,
-- and inventory dashboard read paths. These indexes support existing query
-- shapes only; they do not alter business behavior.

CREATE INDEX IF NOT EXISTS idx_transactions_customer_booked
    ON transactions(customer_id, booked_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_payer_created
    ON payment_transactions(payer_id, created_at DESC)
    WHERE payer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_measurements_customer_created
    ON measurements(customer_id, created_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_measurements_customer_measured
    ON customer_measurements(customer_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_wedding_members_customer_party_member
    ON wedding_members(customer_id, wedding_party_id, id);

CREATE INDEX IF NOT EXISTS idx_wedding_parties_active_event
    ON wedding_parties(event_date, id)
    WHERE is_deleted IS NULL OR is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_shipment_customer_active_created
    ON shipment(customer_id, created_at DESC)
    WHERE status NOT IN ('delivered', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_transaction_lines_transaction
    ON transaction_lines(transaction_id);

CREATE INDEX IF NOT EXISTS idx_transaction_lines_fulfillment_order
    ON transaction_lines(fulfillment_order_id)
    WHERE fulfillment_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_lines_fulfillment_order_unfulfilled
    ON transaction_lines(fulfillment_order_id)
    WHERE fulfillment_order_id IS NOT NULL
      AND is_fulfilled = FALSE;

CREATE INDEX IF NOT EXISTS idx_transaction_lines_fulfillment_order_rush
    ON transaction_lines(fulfillment_order_id)
    WHERE fulfillment_order_id IS NOT NULL
      AND is_rush = TRUE;

CREATE INDEX IF NOT EXISTS idx_payment_allocations_target_transaction_payment
    ON payment_allocations(target_transaction_id, transaction_id)
    WHERE amount_allocated > 0;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_status_created
    ON payment_transactions(status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_status_created
    ON fulfillment_orders(status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_product_variants_oos_variant
    ON product_variants(id)
    WHERE stock_on_hand <= 0;
