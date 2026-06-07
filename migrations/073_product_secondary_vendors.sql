-- Allow product families to be ordered/received from approved secondary vendors
-- without changing the primary vendor used for Min/Max PO suggestions.

CREATE TABLE IF NOT EXISTS public.product_secondary_vendors (
    product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS product_secondary_vendors_vendor_idx
    ON public.product_secondary_vendors (vendor_id, product_id);

COMMENT ON TABLE public.product_secondary_vendors IS
    'Additional approved vendors for a product. Primary vendor remains the PO suggestion vendor for Min/Max replenishment.';
