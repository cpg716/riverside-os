-- Immutable retail and sale price history for parent products and individual SKUs.

CREATE TABLE IF NOT EXISTS public.catalog_price_change_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    variant_id uuid,
    sku text,
    price_scope text NOT NULL CHECK (price_scope IN ('parent', 'variant')),
    price_kind text NOT NULL CHECK (price_kind IN ('retail', 'sale')),
    old_override numeric(12, 2),
    new_override numeric(12, 2),
    old_effective_price numeric(12, 2),
    new_effective_price numeric(12, 2),
    changed_by uuid,
    changed_by_name text,
    change_source text NOT NULL DEFAULT 'database',
    change_note text,
    source_record_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    changed_at timestamptz NOT NULL DEFAULT now(),
    CHECK (old_override IS NULL OR old_override >= 0),
    CHECK (new_override IS NULL OR new_override >= 0),
    CHECK (old_effective_price IS NULL OR old_effective_price >= 0),
    CHECK (new_effective_price IS NULL OR new_effective_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_catalog_price_history_product_changed
    ON public.catalog_price_change_history (product_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_price_history_variant_changed
    ON public.catalog_price_change_history (variant_id, changed_at DESC)
    WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_price_history_reporting
    ON public.catalog_price_change_history (changed_at DESC, price_kind, price_scope);

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_price_history_source_record
    ON public.catalog_price_change_history (source_record_id, price_kind)
    WHERE source_record_id IS NOT NULL;

COMMENT ON TABLE public.catalog_price_change_history IS
    'Append-only history of every parent and SKU retail or sale price configuration change.';

CREATE OR REPLACE FUNCTION public.capture_catalog_price_actor()
RETURNS TABLE (staff_id uuid, staff_name text, source text, note text)
LANGUAGE plpgsql
AS $$
DECLARE
    actor_setting text;
BEGIN
    actor_setting := NULLIF(current_setting('riverside.price_change_staff_id', true), '');
    staff_id := actor_setting::uuid;
    IF staff_id IS NOT NULL THEN
        SELECT s.full_name INTO staff_name
        FROM public.staff s
        WHERE s.id = staff_id;
    END IF;
    source := COALESCE(
        NULLIF(current_setting('riverside.price_change_source', true), ''),
        'database'
    );
    note := NULLIF(current_setting('riverside.price_change_note', true), '');
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_parent_catalog_price_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actor record;
BEGIN
    SELECT * INTO actor FROM public.capture_catalog_price_actor();

    IF OLD.base_retail_price IS DISTINCT FROM NEW.base_retail_price THEN
        INSERT INTO public.catalog_price_change_history (
            product_id, product_name, price_scope, price_kind,
            old_effective_price, new_effective_price,
            changed_by, changed_by_name, change_source, change_note, metadata
        )
        VALUES (
            NEW.id, NEW.name, 'parent', 'retail',
            OLD.base_retail_price, NEW.base_retail_price,
            actor.staff_id, actor.staff_name, actor.source, actor.note,
            jsonb_build_object(
                'inheriting_variant_count',
                (SELECT COUNT(*) FROM public.product_variants pv
                 WHERE pv.product_id = NEW.id AND pv.retail_price_override IS NULL)
            )
        );
    END IF;

    IF OLD.base_sale_price IS DISTINCT FROM NEW.base_sale_price THEN
        INSERT INTO public.catalog_price_change_history (
            product_id, product_name, price_scope, price_kind,
            old_effective_price, new_effective_price,
            changed_by, changed_by_name, change_source, change_note, metadata
        )
        VALUES (
            NEW.id, NEW.name, 'parent', 'sale',
            OLD.base_sale_price, NEW.base_sale_price,
            actor.staff_id, actor.staff_name, actor.source, actor.note,
            jsonb_build_object(
                'inheriting_variant_count',
                (SELECT COUNT(*) FROM public.product_variants pv
                 WHERE pv.product_id = NEW.id AND pv.sale_price_override IS NULL)
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_parent_catalog_price_change ON public.products;
CREATE TRIGGER trg_audit_parent_catalog_price_change
AFTER UPDATE OF base_retail_price, base_sale_price ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.audit_parent_catalog_price_change();

CREATE OR REPLACE FUNCTION public.audit_variant_catalog_price_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actor record;
    parent_record record;
BEGIN
    IF OLD.retail_price_override IS NOT DISTINCT FROM NEW.retail_price_override
       AND OLD.sale_price_override IS NOT DISTINCT FROM NEW.sale_price_override THEN
        RETURN NEW;
    END IF;

    SELECT p.name, p.base_retail_price, p.base_sale_price
    INTO parent_record
    FROM public.products p
    WHERE p.id = NEW.product_id;

    SELECT * INTO actor FROM public.capture_catalog_price_actor();

    IF OLD.retail_price_override IS DISTINCT FROM NEW.retail_price_override THEN
        INSERT INTO public.catalog_price_change_history (
            product_id, product_name, variant_id, sku, price_scope, price_kind,
            old_override, new_override, old_effective_price, new_effective_price,
            changed_by, changed_by_name, change_source, change_note
        )
        VALUES (
            NEW.product_id, parent_record.name, NEW.id, NEW.sku, 'variant', 'retail',
            OLD.retail_price_override, NEW.retail_price_override,
            COALESCE(OLD.retail_price_override, parent_record.base_retail_price),
            COALESCE(NEW.retail_price_override, parent_record.base_retail_price),
            actor.staff_id, actor.staff_name, actor.source, actor.note
        );
    END IF;

    IF OLD.sale_price_override IS DISTINCT FROM NEW.sale_price_override THEN
        INSERT INTO public.catalog_price_change_history (
            product_id, product_name, variant_id, sku, price_scope, price_kind,
            old_override, new_override, old_effective_price, new_effective_price,
            changed_by, changed_by_name, change_source, change_note
        )
        VALUES (
            NEW.product_id, parent_record.name, NEW.id, NEW.sku, 'variant', 'sale',
            OLD.sale_price_override, NEW.sale_price_override,
            COALESCE(OLD.sale_price_override, parent_record.base_sale_price),
            COALESCE(NEW.sale_price_override, parent_record.base_sale_price),
            actor.staff_id, actor.staff_name, actor.source, actor.note
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_variant_catalog_price_change ON public.product_variants;
CREATE TRIGGER trg_audit_variant_catalog_price_change
AFTER UPDATE OF retail_price_override, sale_price_override ON public.product_variants
FOR EACH ROW
EXECUTE FUNCTION public.audit_variant_catalog_price_change();

-- Preserve earlier parent price audit entries so the dedicated report starts with known history.
INSERT INTO public.catalog_price_change_history (
    product_id, product_name, price_scope, price_kind,
    old_effective_price, new_effective_price,
    changed_by, changed_by_name, change_source, change_note,
    source_record_id, changed_at, metadata
)
SELECT
    a.product_id,
    p.name,
    'parent',
    price.price_kind,
    price.old_price,
    price.new_price,
    a.changed_by,
    s.full_name,
    a.change_source,
    a.change_note,
    a.id,
    a.created_at,
    jsonb_build_object('backfilled_from', 'product_catalog_audit_log')
FROM public.product_catalog_audit_log a
JOIN public.products p ON p.id = a.product_id
LEFT JOIN public.staff s ON s.id = a.changed_by
CROSS JOIN LATERAL (
    SELECT
        'retail'::text AS price_kind,
        (a.before_values ->> 'base_retail_price')::numeric AS old_price,
        (a.after_values ->> 'base_retail_price')::numeric AS new_price
    WHERE a.before_values ? 'base_retail_price'
       OR a.after_values ? 'base_retail_price'

    UNION ALL

    SELECT
        'sale'::text AS price_kind,
        (a.before_values ->> 'base_sale_price')::numeric AS old_price,
        (a.after_values ->> 'base_sale_price')::numeric AS new_price
    WHERE a.before_values ? 'base_sale_price'
       OR a.after_values ? 'base_sale_price'
) price
WHERE price.old_price IS DISTINCT FROM price.new_price
ON CONFLICT (source_record_id, price_kind) WHERE source_record_id IS NOT NULL DO NOTHING;

CREATE OR REPLACE FUNCTION public.prevent_catalog_price_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'catalog price history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_catalog_price_history_mutation
    ON public.catalog_price_change_history;
CREATE TRIGGER trg_prevent_catalog_price_history_mutation
BEFORE UPDATE OR DELETE ON public.catalog_price_change_history
FOR EACH ROW
EXECUTE FUNCTION public.prevent_catalog_price_history_mutation();

CREATE SCHEMA IF NOT EXISTS reporting;

CREATE OR REPLACE VIEW reporting.catalog_price_change_history AS
SELECT
    h.id,
    h.changed_at,
    (h.changed_at AT TIME ZONE reporting.effective_store_timezone())::date AS business_date,
    h.product_id,
    h.product_name,
    h.variant_id,
    h.sku,
    h.price_scope,
    h.price_kind,
    h.old_override,
    h.new_override,
    h.old_effective_price,
    h.new_effective_price,
    h.new_effective_price - h.old_effective_price AS effective_price_change,
    h.changed_by,
    h.changed_by_name,
    h.change_source,
    h.change_note,
    h.metadata
FROM public.catalog_price_change_history h;

COMMENT ON VIEW reporting.catalog_price_change_history IS
    'Append-only parent and SKU retail/sale price history with staff, source, exact before/after values, and business date.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        EXECUTE 'GRANT SELECT ON reporting.catalog_price_change_history TO metabase_ro;';
    END IF;
END
$$;
