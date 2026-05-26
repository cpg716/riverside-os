-- 046 Alteration Pickup Tracking
-- Adds audit columns for when a customer picks up completed alteration work.

ALTER TABLE public.alteration_orders
    ADD COLUMN IF NOT EXISTS picked_up_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS picked_up_by_staff_id uuid;

-- Add index for querying ready alterations by customer
CREATE INDEX IF NOT EXISTS idx_alteration_orders_customer_ready
    ON public.alteration_orders(customer_id, status)
    WHERE status = 'ready';
