-- POS register session API secret (returned only on open / re-issue); not exposed on GET /current.
-- Optional client-supplied idempotency key for checkout replay safety.

ALTER TABLE register_sessions
    ADD COLUMN IF NOT EXISTS pos_api_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS register_sessions_pos_api_token_uidx
    ON register_sessions (pos_api_token)
    WHERE pos_api_token IS NOT NULL;

COMMENT ON COLUMN register_sessions.pos_api_token IS
    'Opaque secret for POS customer/checkout API auth while session is open; cleared on close.';

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS checkout_client_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS orders_checkout_client_id_uidx
    ON orders (checkout_client_id)
    WHERE checkout_client_id IS NOT NULL;

COMMENT ON COLUMN orders.checkout_client_id IS
    'Optional idempotency key from POS offline queue / retries; duplicate POST returns same order.';
