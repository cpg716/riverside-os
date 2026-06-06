-- Physical inventory scanner resilience: idempotent replay keys for queued scans.

ALTER TABLE public.inventory_count_scan_stream
    ADD COLUMN IF NOT EXISTS client_scan_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_count_stream_session_client_scan
    ON public.inventory_count_scan_stream (session_id, client_scan_id)
    WHERE client_scan_id IS NOT NULL;

COMMENT ON COLUMN public.inventory_count_scan_stream.client_scan_id IS
    'Client-generated scan id used to make offline scanner replay idempotent per physical inventory session.';
