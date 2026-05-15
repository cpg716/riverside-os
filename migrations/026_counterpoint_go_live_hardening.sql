-- Counterpoint go-live hardening.
--
-- This migration is intentionally idempotent because launch databases may have
-- restored from older baselines whose migration ledger says later Counterpoint
-- staging migrations ran even when the physical table shape is incomplete.

\set ON_ERROR_STOP on

ALTER TABLE public.counterpoint_staging_batch
DROP CONSTRAINT IF EXISTS counterpoint_staging_batch_status_check;

ALTER TABLE public.counterpoint_staging_batch
ADD CONSTRAINT counterpoint_staging_batch_status_check
CHECK (status IN ('pending', 'applying', 'applied', 'discarded', 'failed'));

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS apply_started_at TIMESTAMPTZ;

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS apply_claimed_by_staff_id UUID;

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS last_replayed_at TIMESTAMPTZ;

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS payload_fingerprint TEXT;

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ;

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS recovered_by_staff_id UUID;

ALTER TABLE public.counterpoint_staging_batch
ADD COLUMN IF NOT EXISTS recovery_reason TEXT;

UPDATE public.counterpoint_staging_batch
SET payload_fingerprint = md5(payload::text)
WHERE payload_fingerprint IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'counterpoint_staging_batch_apply_claimed_by_staff_id_fkey'
  ) THEN
    ALTER TABLE public.counterpoint_staging_batch
    ADD CONSTRAINT counterpoint_staging_batch_apply_claimed_by_staff_id_fkey
    FOREIGN KEY (apply_claimed_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'counterpoint_staging_batch_recovered_by_staff_id_fkey'
  ) THEN
    ALTER TABLE public.counterpoint_staging_batch
    ADD CONSTRAINT counterpoint_staging_batch_recovered_by_staff_id_fkey
    FOREIGN KEY (recovered_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;
  END IF;
END $$;

INSERT INTO public.counterpoint_payment_method_map (cp_pmt_typ, ros_method)
VALUES
  ('CASH', 'cash'),
  ('CSH', 'cash'),
  ('CHECK', 'check'),
  ('CHK', 'check'),
  ('CHEQUE', 'check'),
  ('CREDIT CARD', 'credit_card'),
  ('CREDIT', 'credit_card'),
  ('CARD', 'credit_card'),
  ('CC', 'credit_card'),
  ('VISA', 'credit_card'),
  ('VI', 'credit_card'),
  ('MASTERCARD', 'credit_card'),
  ('MASTER CARD', 'credit_card'),
  ('MC', 'credit_card'),
  ('AMEX', 'credit_card'),
  ('AMERICAN EXPRESS', 'credit_card'),
  ('DISCOVER', 'credit_card'),
  ('DISC', 'credit_card'),
  ('DEBIT', 'credit_card'),
  ('DBT', 'credit_card'),
  ('GIFT CERT', 'gift_card'),
  ('GIFT CERTIFICATE', 'gift_card'),
  ('GIFT CARD', 'gift_card'),
  ('GC', 'gift_card'),
  ('STORE CREDIT', 'store_credit'),
  ('STC', 'store_credit'),
  ('ON ACCOUNT', 'on_account'),
  ('ACCOUNT', 'on_account'),
  ('A/R', 'on_account'),
  ('AR', 'on_account'),
  ('RMS CHARGE', 'on_account_rms'),
  ('RMS', 'on_account_rms')
ON CONFLICT (cp_pmt_typ) DO NOTHING;

INSERT INTO public.counterpoint_gift_reason_map (cp_reason_cod, ros_card_kind)
VALUES
  ('LOYALTY', 'loyalty_reward'),
  ('LOYALTY REWARD', 'loyalty_reward'),
  ('REWARD', 'loyalty_reward'),
  ('DONATION', 'donated_giveaway'),
  ('DONATED', 'donated_giveaway'),
  ('GIVEAWAY', 'donated_giveaway'),
  ('PROMO', 'promo_gift_card'),
  ('PROMOTION', 'promo_gift_card'),
  ('MARKETING', 'promo_gift_card'),
  ('PURCHASED', 'purchased'),
  ('SALE', 'purchased')
ON CONFLICT (cp_reason_cod) DO NOTHING;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY entity, COALESCE(external_key, ''), message
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM public.counterpoint_sync_issue
  WHERE NOT resolved
)
UPDATE public.counterpoint_sync_issue i
SET resolved = TRUE,
    resolved_at = COALESCE(i.resolved_at, NOW())
FROM ranked r
WHERE i.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_counterpoint_sync_issue_open_unique
ON public.counterpoint_sync_issue (entity, COALESCE(external_key, ''), message)
WHERE NOT resolved;

CREATE INDEX IF NOT EXISTS idx_counterpoint_staging_status_created
ON public.counterpoint_staging_batch (status, created_at DESC);

COMMENT ON INDEX public.idx_counterpoint_sync_issue_open_unique IS
  'Prevents duplicate unresolved Counterpoint sync issues while preserving resolved historical audit rows.';
