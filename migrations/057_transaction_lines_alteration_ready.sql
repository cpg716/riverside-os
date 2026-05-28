-- Add alteration_ready flag to transaction_lines
-- This allows alterations to signal to the order system when they are ready for pickup

ALTER TABLE public.transaction_lines
ADD COLUMN alteration_ready boolean DEFAULT false;

-- Add index for efficient queries
CREATE INDEX idx_transaction_lines_alteration_ready
ON public.transaction_lines(alteration_ready)
WHERE alteration_ready = true;

-- Add comment for documentation
COMMENT ON COLUMN public.transaction_lines.alteration_ready IS 'Flag set when linked alteration is ready for pickup. Used to coordinate alteration completion with order fulfillment.';
