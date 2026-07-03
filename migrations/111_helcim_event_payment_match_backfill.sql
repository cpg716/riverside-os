-- Backfill Helcim webhook rows that already correspond to an existing ROS
-- Helcim payment. This keeps terminal review focused on unresolved provider
-- evidence and preserves provider references needed for card-not-present refunds.

UPDATE public.helcim_event_log e
SET payment_transaction_id = pt.id,
    match_type = 'provider_transaction_id_payment'
FROM public.payment_transactions pt
WHERE e.provider = 'helcim'
  AND e.event_type = 'cardTransaction'
  AND e.processing_status = 'processed'
  AND COALESCE(e.match_type, 'none') = 'none'
  AND e.payment_transaction_id IS NULL
  AND NULLIF(BTRIM(e.provider_transaction_id), '') IS NOT NULL
  AND pt.payment_provider = 'helcim'
  AND pt.provider_transaction_id = e.provider_transaction_id;

UPDATE public.helcim_event_log
SET match_type = 'provider_transaction_id_payment'
WHERE provider = 'helcim'
  AND event_type = 'cardTransaction'
  AND processing_status = 'processed'
  AND COALESCE(match_type, 'none') = 'none'
  AND payment_transaction_id IS NOT NULL;
