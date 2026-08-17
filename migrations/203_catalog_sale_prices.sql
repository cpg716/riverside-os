-- Optional catalog sale prices used only while an eligible POS promotion is active.

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS base_sale_price numeric(12, 2);

ALTER TABLE public.product_variants
    ADD COLUMN IF NOT EXISTS sale_price_override numeric(12, 2);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'products_base_sale_price_nonnegative'
    ) THEN
        ALTER TABLE public.products
            ADD CONSTRAINT products_base_sale_price_nonnegative
            CHECK (base_sale_price IS NULL OR base_sale_price >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'product_variants_sale_price_override_nonnegative'
    ) THEN
        ALTER TABLE public.product_variants
            ADD CONSTRAINT product_variants_sale_price_override_nonnegative
            CHECK (sale_price_override IS NULL OR sale_price_override >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'products_base_sale_price_not_above_retail'
    ) THEN
        ALTER TABLE public.products
            ADD CONSTRAINT products_base_sale_price_not_above_retail
            CHECK (base_sale_price IS NULL OR base_sale_price <= base_retail_price);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'product_variants_sale_override_not_above_retail_override'
    ) THEN
        ALTER TABLE public.product_variants
            ADD CONSTRAINT product_variants_sale_override_not_above_retail_override
            CHECK (
                sale_price_override IS NULL
                OR retail_price_override IS NULL
                OR sale_price_override <= retail_price_override
            );
    END IF;
END
$$;

COMMENT ON COLUMN public.products.base_sale_price IS
    'Optional parent sale price used instead of promotion percent while an eligible discount event is active.';

COMMENT ON COLUMN public.product_variants.sale_price_override IS
    'Optional SKU sale price overriding the parent sale price while an eligible discount event is active.';
