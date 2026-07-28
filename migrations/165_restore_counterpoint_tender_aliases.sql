-- Restore canonical Counterpoint tender aliases that were absent from the live
-- mapping table and repair only imported payments that retained the exact
-- source tender in metadata.

\set ON_ERROR_STOP on

WITH tender_map(cp_pmt_typ, ros_method) AS (
  VALUES
    ('VISA', 'credit_card'),
    ('MC', 'credit_card'),
    ('AMEX', 'credit_card'),
    ('DISCOVER', 'credit_card'),
    ('CREDITCARD', 'credit_card'),
    ('GC', 'gift_card'),
    ('PROM GC', 'gift_card'),
    ('DONATION', 'gift_card'),
    ('RMS CHARGE', 'on_account_rms'),
    ('RMS 90 DAY', 'on_account_rms90'),
    ('STORE CRED', 'store_credit')
)
INSERT INTO public.counterpoint_payment_method_map (cp_pmt_typ, ros_method)
SELECT cp_pmt_typ, ros_method
FROM tender_map
ON CONFLICT (cp_pmt_typ) DO UPDATE
SET ros_method = EXCLUDED.ros_method;

WITH tender_map(cp_pmt_typ, ros_method) AS (
  VALUES
    ('VISA', 'credit_card'),
    ('MC', 'credit_card'),
    ('AMEX', 'credit_card'),
    ('DISCOVER', 'credit_card'),
    ('CREDITCARD', 'credit_card'),
    ('GC', 'gift_card'),
    ('PROM GC', 'gift_card'),
    ('DONATION', 'gift_card'),
    ('RMS CHARGE', 'on_account_rms'),
    ('RMS 90 DAY', 'on_account_rms90'),
    ('STORE CRED', 'store_credit')
)
UPDATE public.payment_transactions payment
SET payment_method = tender_map.ros_method,
    metadata = COALESCE(payment.metadata, '{}'::jsonb) || jsonb_build_object(
      'counterpoint_tender_reclassified_by', 'migration_165',
      'counterpoint_tender_previous_method', payment.payment_method
    )
FROM tender_map
WHERE payment.payment_method = 'counterpoint_unmapped'
  AND UPPER(BTRIM(COALESCE(payment.metadata->>'counterpoint_pmt_typ', '')))
      = tender_map.cp_pmt_typ;

WITH tender_map(cp_pmt_typ) AS (
  VALUES
    ('VISA'),
    ('MC'),
    ('AMEX'),
    ('DISCOVER'),
    ('CREDITCARD'),
    ('GC'),
    ('PROM GC'),
    ('DONATION'),
    ('RMS CHARGE'),
    ('RMS 90 DAY'),
    ('STORE CRED')
)
UPDATE public.counterpoint_sync_issue issue
SET resolved = TRUE,
    resolved_at = COALESCE(issue.resolved_at, NOW())
FROM tender_map
WHERE NOT issue.resolved
  AND issue.message = format(
    'Unmapped Counterpoint payment method "%s"; recorded as counterpoint_unmapped for review',
    tender_map.cp_pmt_typ
  );
