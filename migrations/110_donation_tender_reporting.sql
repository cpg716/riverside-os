CREATE OR REPLACE VIEW reporting.donation_payments AS
WITH allocation_rollup AS (
    SELECT
        pa.transaction_id AS payment_transaction_id,
        COUNT(DISTINCT pa.target_transaction_id) AS linked_transaction_count,
        MIN((pa.target_transaction_id)::text) FILTER (WHERE pa.target_transaction_id IS NOT NULL) AS primary_transaction_id_text,
        MIN(tc.transaction_display_id) FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS primary_transaction_display_id,
        STRING_AGG(DISTINCT tc.transaction_display_id, ', ' ORDER BY tc.transaction_display_id)
            FILTER (WHERE tc.transaction_display_id IS NOT NULL) AS linked_transaction_display_ids,
        STRING_AGG(
            DISTINCT COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown'),
            ', ' ORDER BY COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown')
        ) FILTER (WHERE tc.transaction_id IS NOT NULL) AS linked_customer_names
    FROM public.payment_allocations pa
    LEFT JOIN reporting.transactions_core tc ON tc.transaction_id = pa.target_transaction_id
    GROUP BY pa.transaction_id
)
SELECT
    pt.id,
    pt.id AS payment_transaction_id,
    pt.created_at,
    pt.occurred_at,
    COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) AS business_date,
    pt.payment_method,
    pt.amount AS gross_amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.status::text AS status,
    pt.payment_provider,
    pt.provider_status,
    pt.payer_id,
    TRIM(BOTH FROM concat_ws(' ', c.first_name, c.last_name)) AS payer_name,
    c.customer_code AS payer_code,
    (NULLIF(ar.primary_transaction_id_text, ''))::uuid AS linked_transaction_id,
    ar.linked_transaction_count,
    ar.primary_transaction_display_id,
    ar.linked_transaction_display_ids,
    ar.linked_customer_names,
    COALESCE(NULLIF(TRIM(pt.metadata->>'donation_note'), ''), NULLIF(TRIM(pt.metadata->>'note'), ''), 'No note provided') AS donation_note,
    pt.metadata
FROM public.payment_transactions pt
LEFT JOIN public.customers c ON c.id = pt.payer_id
LEFT JOIN allocation_rollup ar ON ar.payment_transaction_id = pt.id
WHERE LOWER(COALESCE(pt.payment_method, '')) = 'donation'
   OR LOWER(COALESCE(pt.metadata->>'tender_family', '')) = 'donation';

COMMENT ON VIEW reporting.donation_payments IS
    'Donation tender payments with required reason notes, customer labels, and linked transaction display ids for Reports and Metabase.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        GRANT SELECT ON reporting.donation_payments TO metabase_ro;
    END IF;
END $$;
