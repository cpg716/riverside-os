-- Counterpoint imports preserve the source-paid unit price in size_specs.
-- Restore the ledger value too so server-side returns and exchanges use the
-- same line price shown on the Counterpoint receipt instead of the ticket-wide
-- proportional adjustment from migration 131.
UPDATE public.transaction_lines
SET unit_price = ROUND((size_specs->>'overridden_unit_price')::numeric, 2)
WHERE transaction_id IN (
        SELECT id
        FROM public.transactions
        WHERE is_counterpoint_import
           OR counterpoint_ticket_ref IS NOT NULL
    )
  AND size_specs ? 'overridden_unit_price'
  AND NULLIF(BTRIM(size_specs->>'overridden_unit_price'), '') IS NOT NULL
  AND BTRIM(size_specs->>'overridden_unit_price') ~ '^[0-9]+(\.[0-9]+)?$'
  AND unit_price IS DISTINCT FROM ROUND((size_specs->>'overridden_unit_price')::numeric, 2);
