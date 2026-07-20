-- Read-only search fallback plans. Run with EXPLAIN_PATH=.../scripts/explain-search-paths.sql
-- against a production replica or an explicitly approved Main Hub database connection.
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id, display_id
FROM public.transactions
WHERE COALESCE(display_id, '') ILIKE '%TXN%'
ORDER BY created_at DESC
LIMIT 8;

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id, sku
FROM public.product_variants
WHERE (
    COALESCE(sku, '') || ' ' || COALESCE(barcode, '') || ' ' ||
    COALESCE(vendor_upc, '') || ' ' || COALESCE(variation_label, '')
  ) ILIKE '%suit%'
LIMIT 100;

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id, first_name, last_name
FROM public.customers
WHERE (
    COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' ||
    COALESCE(customer_code, '') || ' ' || COALESCE(email, '') || ' ' ||
    COALESCE(phone, '') || ' ' || COALESCE(company_name, '')
  ) ILIKE '%smith%'
LIMIT 8;
