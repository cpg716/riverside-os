-- Accelerate the PostgreSQL fallback paths used when Meilisearch is unavailable.
-- These indexes are read-only performance improvements; search semantics stay unchanged.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_customers_search_trgm
    ON public.customers USING gin (
        (
            COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' ||
            COALESCE(customer_code, '') || ' ' || COALESCE(email, '') || ' ' ||
            COALESCE(phone, '') || ' ' || COALESCE(company_name, '')
        ) gin_trgm_ops
    );

CREATE INDEX IF NOT EXISTS idx_customers_first_name_trgm
    ON public.customers USING gin (COALESCE(first_name, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_last_name_trgm
    ON public.customers USING gin (COALESCE(last_name, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_code_trgm
    ON public.customers USING gin (COALESCE(customer_code, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_email_trgm
    ON public.customers USING gin (COALESCE(email, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_phone_trgm
    ON public.customers USING gin (COALESCE(phone, '') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_search_trgm
    ON public.products USING gin (
        (
            COALESCE(name, '') || ' ' || COALESCE(brand, '') || ' ' ||
            COALESCE(catalog_handle, '')
        ) gin_trgm_ops
    );
CREATE INDEX IF NOT EXISTS idx_products_name_trgm
    ON public.products USING gin (COALESCE(name, '') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_product_variants_search_trgm
    ON public.product_variants USING gin (
        (
            COALESCE(sku, '') || ' ' || COALESCE(barcode, '') || ' ' ||
            COALESCE(vendor_upc, '') || ' ' || COALESCE(variation_label, '')
        ) gin_trgm_ops
    );
CREATE INDEX IF NOT EXISTS idx_product_variants_sku_trgm
    ON public.product_variants USING gin (COALESCE(sku, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_product_variants_barcode_trgm
    ON public.product_variants USING gin (COALESCE(barcode, '') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_transactions_search_trgm
    ON public.transactions USING gin (
        (
            COALESCE(display_id, '') || ' ' || COALESCE(counterpoint_doc_ref, '') || ' ' ||
            COALESCE(counterpoint_ticket_ref, '')
        ) gin_trgm_ops
    );
CREATE INDEX IF NOT EXISTS idx_transactions_display_id_trgm
    ON public.transactions USING gin (COALESCE(display_id, '') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gift_cards_search_trgm
    ON public.gift_cards USING gin (
        (COALESCE(code, '') || ' ' || COALESCE(notes, '')) gin_trgm_ops
    );

CREATE INDEX IF NOT EXISTS idx_payment_transactions_search_trgm
    ON public.payment_transactions USING gin (
        (
            COALESCE(payment_method, '') || ' ' || COALESCE(status, '') || ' ' ||
            COALESCE(provider_payment_id, '') || ' ' || COALESCE(provider_transaction_id, '') || ' ' ||
            COALESCE(check_number, '') || ' ' || COALESCE(card_last4, '')
        ) gin_trgm_ops
    );

INSERT INTO ros_schema_migrations (version) VALUES ('140_search_trigram_read_path_indexes.sql')
ON CONFLICT (version) DO NOTHING;
