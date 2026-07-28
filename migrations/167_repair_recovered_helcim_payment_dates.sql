-- Recovered Helcim approvals belong to the provider approval date, not the later
-- date when staff attached the already-approved payment to the ROS ledger.
-- created_at/occurred_at already preserve that approval timestamp; repair only
-- rows carrying the guarded paid-recovery metadata written by ROS.

UPDATE public.payment_transactions payment
SET effective_date =
        (COALESCE(payment.occurred_at, payment.created_at) AT TIME ZONE reporting.effective_store_timezone())::date
FROM public.helcim_terminal_recovery_actions recovery
WHERE payment.payment_provider = 'helcim'
  AND (
      payment.metadata ? 'recovered_from_parked_sale_id'
      OR payment.metadata ? 'recovered_order_payment_target_id'
  )
  AND recovery.source_kind = 'payment_provider_attempt'
  AND recovery.action = 'recovered_transaction'
  AND recovery.source_id::text = payment.metadata->>'payment_provider_attempt_id'
  AND payment.effective_date =
      (recovery.created_at AT TIME ZONE reporting.effective_store_timezone())::date
  AND payment.effective_date IS DISTINCT FROM
      (COALESCE(payment.occurred_at, payment.created_at) AT TIME ZONE reporting.effective_store_timezone())::date;
