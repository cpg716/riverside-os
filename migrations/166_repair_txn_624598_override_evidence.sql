-- Repair incomplete audit metadata on the two exact TXN-624598 lines whose
-- stored Manual Override value equals the immutable booked unit price.

\set ON_ERROR_STOP on

UPDATE public.transaction_lines line
SET size_specs = COALESCE(line.size_specs, '{}'::jsonb)
    || jsonb_build_object(
      'original_unit_price', line.size_specs->>'overridden_unit_price',
      'override_evidence_repaired_by', 'migration_166'
    )
FROM public.transactions transaction
WHERE line.transaction_id = transaction.id
  AND transaction.display_id = 'TXN-624598'
  AND line.id IN (
    '439b7781-b20c-4b5f-b670-b0097911427d'::uuid,
    'b74ff8e3-a67e-40be-8b11-f1f83e02a6e6'::uuid
  )
  AND LOWER(BTRIM(COALESCE(line.size_specs->>'price_override_reason', '')))
      = 'manual override'
  AND NULLIF(BTRIM(line.size_specs->>'original_unit_price'), '') IS NULL
  AND NULLIF(BTRIM(line.size_specs->>'overridden_unit_price'), '') IS NOT NULL
  AND ROUND(line.unit_price, 2)
      = ROUND((line.size_specs->>'overridden_unit_price')::numeric, 2);
