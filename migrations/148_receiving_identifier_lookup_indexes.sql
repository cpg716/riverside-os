-- Migration 148: Receiving identifier lookup indexes
-- Match the normalized catalog-number and vendor-UPC expressions used by the
-- authoritative receiving scan resolver.

CREATE INDEX IF NOT EXISTS idx_products_catalog_handle_lower_trim
    ON public.products (LOWER(BTRIM(catalog_handle)))
    WHERE catalog_handle IS NOT NULL
      AND BTRIM(catalog_handle) <> '';

CREATE INDEX IF NOT EXISTS idx_product_variants_vendor_upc_lower_trim
    ON public.product_variants (LOWER(BTRIM(vendor_upc)))
    WHERE vendor_upc IS NOT NULL
      AND BTRIM(vendor_upc) <> '';
