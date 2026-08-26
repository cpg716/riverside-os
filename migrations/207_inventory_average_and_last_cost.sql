-- Make average/WAC cost the authoritative ROS merchandise cost while retaining
-- the most recent invoice/source cost separately for purchasing reference.

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS last_cost numeric(12, 2);

ALTER TABLE public.product_variants
    ADD COLUMN IF NOT EXISTS last_cost_override numeric(12, 2);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'products_last_cost_nonnegative'
    ) THEN
        ALTER TABLE public.products
            ADD CONSTRAINT products_last_cost_nonnegative
            CHECK (last_cost IS NULL OR last_cost >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'product_variants_last_cost_override_nonnegative'
    ) THEN
        ALTER TABLE public.product_variants
            ADD CONSTRAINT product_variants_last_cost_override_nonnegative
            CHECK (last_cost_override IS NULL OR last_cost_override >= 0);
    END IF;
END
$$;

-- Before this migration Counterpoint LST_COST occupied the effective-cost
-- fields. Preserve that value as last cost before the next source-verified
-- Counterpoint run replaces effective cost with AVG_COST.
UPDATE public.products
SET last_cost = base_cost
WHERE last_cost IS NULL;

UPDATE public.product_variants pv
SET last_cost_override = COALESCE(
    (
        SELECT it.unit_cost
        FROM public.inventory_transactions it
        WHERE it.variant_id = pv.id
          AND it.tx_type = 'po_receipt'
          AND it.unit_cost IS NOT NULL
        ORDER BY it.created_at DESC, it.id DESC
        LIMIT 1
    ),
    pv.cost_override
)
WHERE pv.last_cost_override IS NULL;

COMMENT ON COLUMN public.products.base_cost IS
    'Authoritative parent average/WAC merchandise cost used for valuation, COGS, margins, below-cost checks, and employee cost-plus pricing.';

COMMENT ON COLUMN public.product_variants.cost_override IS
    'Authoritative SKU average/WAC merchandise cost overriding products.base_cost.';

COMMENT ON COLUMN public.products.last_cost IS
    'Most recent parent source or invoice unit cost for purchasing reference; never the margin or employee-pricing basis.';

COMMENT ON COLUMN public.product_variants.last_cost_override IS
    'Most recent SKU source or invoice unit cost overriding products.last_cost; never the margin or employee-pricing basis.';
