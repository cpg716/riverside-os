ALTER TABLE public.transaction_lines
ADD COLUMN IF NOT EXISTS booked_at timestamp with time zone;

UPDATE public.transaction_lines tl
SET booked_at = COALESCE(tl.ready_for_pickup_at, t.booked_at, now())
FROM public.transactions t
WHERE tl.transaction_id = t.id
  AND tl.booked_at IS NULL;

ALTER TABLE public.transaction_lines
ALTER COLUMN booked_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_transaction_lines_booked_at
    ON public.transaction_lines (booked_at);
