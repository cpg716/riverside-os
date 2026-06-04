-- Add ticket_number field to alteration_orders for physical ticket tracking
-- This allows staff to link physical alteration tickets to digital records

-- Add ticket_number column
ALTER TABLE public.alteration_orders
ADD COLUMN IF NOT EXISTS ticket_number TEXT;

-- Add index for efficient ticket number lookups
CREATE INDEX IF NOT EXISTS idx_alteration_orders_ticket_number
ON public.alteration_orders(ticket_number)
WHERE ticket_number IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.alteration_orders.ticket_number IS 'Physical ticket number from alteration ticket stubs for tracking and matching';
