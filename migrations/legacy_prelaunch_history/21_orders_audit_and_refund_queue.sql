CREATE TABLE IF NOT EXISTS order_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    customer_id UUID NULL REFERENCES customers(id) ON DELETE SET NULL,
    event_kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_activity_log_order_created
    ON order_activity_log(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_activity_log_customer_created
    ON order_activity_log(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_refund_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    customer_id UUID NULL REFERENCES customers(id) ON DELETE SET NULL,
    amount_due NUMERIC(14,2) NOT NULL,
    amount_refunded NUMERIC(14,2) NOT NULL DEFAULT 0,
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_order_refund_queue_open
    ON order_refund_queue(is_open, created_at DESC);
