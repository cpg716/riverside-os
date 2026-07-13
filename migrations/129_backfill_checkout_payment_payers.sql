-- Checkout payments created with a linked customer must retain that customer as
-- the payer so Customer History and payer-level payment reporting stay complete.
-- The checkout transaction ID is already persisted in payment metadata, making
-- this backfill deterministic and idempotent.

UPDATE public.payment_transactions AS payment
SET payer_id = checkout.customer_id
FROM public.transactions AS checkout
WHERE payment.payer_id IS NULL
  AND checkout.customer_id IS NOT NULL
  AND payment.metadata->>'checkout_transaction_id' = checkout.id::text;
