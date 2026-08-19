-- Make average/WAC cost the authoritative ROS merchandise cost while retaining
-- the most recent invoice/source cost separately for purchasing reference.

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS last_cost numeric(12, 2);

ALTER TABLE public.product_variants
    ADD COLUMN IF NOT EXISTS last_cost_override numeric(12, 2);

CREATE TABLE IF NOT EXISTS public.inventory_average_cost_line_repair_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_line_id uuid NOT NULL UNIQUE,
    transaction_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid,
    catalog_handle text NOT NULL,
    prior_unit_cost numeric(12, 2) NOT NULL,
    corrected_unit_cost numeric(12, 2) NOT NULL,
    quantity integer NOT NULL,
    returned_quantity integer NOT NULL DEFAULT 0,
    effective_quantity integer NOT NULL,
    booked_at timestamptz NOT NULL,
    recognition_date date,
    cost_basis text NOT NULL,
    basis_event_date date,
    catalog_manifest_sha256 text NOT NULL,
    cost_event_manifest_sha256 text NOT NULL,
    line_manifest_sha256 text NOT NULL,
    repaired_by_staff_id uuid NOT NULL,
    repaired_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT inventory_average_cost_line_repair_costs_nonnegative
        CHECK (prior_unit_cost >= 0 AND corrected_unit_cost >= 0),
    CONSTRAINT inventory_average_cost_line_repair_quantities_valid
        CHECK (
            quantity > 0
            AND returned_quantity >= 0
            AND effective_quantity >= 0
            AND effective_quantity <= quantity
        )
);

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

-- The retired Counterpoint transfer placed LST_COST in ROS's effective-cost
-- fields. Preserve that evidence as Last Cost. A separate exact ROS-only
-- repair must replace effective cost from reviewed AVG_COST source evidence;
-- this migration never starts the Bridge or reimports inventory.
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
    'Parent average/WAC merchandise cost used for valuation, COGS, margins, below-cost checks, and employee cost-plus pricing.';

COMMENT ON COLUMN public.product_variants.cost_override IS
    'SKU average/WAC merchandise cost overriding products.base_cost.';

COMMENT ON COLUMN public.products.last_cost IS
    'Most recent parent source or invoice unit cost for purchasing reference; never the margin or employee-pricing basis.';

COMMENT ON COLUMN public.product_variants.last_cost_override IS
    'Most recent SKU source or invoice unit cost overriding products.last_cost; never the margin or employee-pricing basis.';

COMMENT ON TABLE public.inventory_average_cost_line_repair_audit IS
    'Immutable evidence for exact ROS transaction-line repairs from Counterpoint historical AVG_COST changes; ambiguous lines are excluded.';
