-- Promote source-proven Ballin Counterpoint B-SKUs to the canonical ROS SKU.
-- Generated CP-* recovery identities remain valid only when Counterpoint has no
-- usable B-* barcode for that exact matrix cell.

CREATE TABLE IF NOT EXISTS public.counterpoint_variant_sku_repair_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES public.product_variants(id),
    product_id UUID NOT NULL REFERENCES public.products(id),
    catalog_handle TEXT NOT NULL,
    counterpoint_item_key TEXT NOT NULL,
    old_sku TEXT NOT NULL,
    old_barcode TEXT,
    new_sku TEXT NOT NULL,
    repair_kind TEXT NOT NULL,
    migration_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (variant_id, migration_name)
);

COMMENT ON TABLE public.counterpoint_variant_sku_repair_audit IS
    'Append-only before/after evidence for source-proven Counterpoint variant SKU promotion.';

DO $migration$
DECLARE
    candidate_count BIGINT;
    audit_count BIGINT;
    updated_count BIGINT;
BEGIN
    CREATE TEMP TABLE migration_214_ballin_sku_repair
    ON COMMIT DROP
    AS
    SELECT
        variant.id AS variant_id,
        variant.product_id,
        UPPER(BTRIM(product.catalog_handle)) AS catalog_handle,
        BTRIM(variant.counterpoint_item_key) AS counterpoint_item_key,
        BTRIM(variant.sku) AS old_sku,
        variant.barcode AS old_barcode,
        UPPER(BTRIM(variant.barcode)) AS new_sku
    FROM public.product_variants variant
    INNER JOIN public.products product ON product.id = variant.product_id
    WHERE product.data_source = 'counterpoint'
      AND UPPER(BTRIM(product.catalog_handle)) = ANY (
          ARRAY['I-103859', 'I-100216', 'I-103945']::TEXT[]
      )
      AND BTRIM(variant.sku) ~* '^CP-[A-Z0-9]{6,13}$'
      AND UPPER(BTRIM(variant.barcode)) ~ '^B-[0-9]+$'
      AND NULLIF(BTRIM(variant.counterpoint_item_key), '') IS NOT NULL;

    SELECT COUNT(*) INTO candidate_count
    FROM migration_214_ballin_sku_repair;

    IF candidate_count = 0 THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM migration_214_ballin_sku_repair candidate
        INNER JOIN migration_214_ballin_sku_repair duplicate
            ON duplicate.new_sku = candidate.new_sku
           AND duplicate.variant_id <> candidate.variant_id
    ) OR EXISTS (
        SELECT 1
        FROM migration_214_ballin_sku_repair candidate
        INNER JOIN public.product_variants existing
            ON UPPER(BTRIM(existing.sku)) = candidate.new_sku
           AND existing.id <> candidate.variant_id
    ) OR EXISTS (
        SELECT 1
        FROM migration_214_ballin_sku_repair candidate
        INNER JOIN public.product_variant_barcode_aliases alias
            ON alias.normalized_alias = LOWER(candidate.new_sku)
           AND alias.status = 'active'
           AND alias.variant_id <> candidate.variant_id
    ) THEN
        RAISE EXCEPTION
            'Migration 214 refused Ballin SKU promotion because a Counterpoint B-SKU is not uniquely owned';
    END IF;

    INSERT INTO public.counterpoint_variant_sku_repair_audit (
        variant_id,
        product_id,
        catalog_handle,
        counterpoint_item_key,
        old_sku,
        old_barcode,
        new_sku,
        repair_kind,
        migration_name
    )
    SELECT
        candidate.variant_id,
        candidate.product_id,
        candidate.catalog_handle,
        candidate.counterpoint_item_key,
        candidate.old_sku,
        candidate.old_barcode,
        candidate.new_sku,
        'promote_counterpoint_b_sku',
        '214_promote_ballin_counterpoint_b_skus.sql'
    FROM migration_214_ballin_sku_repair candidate;

    GET DIAGNOSTICS audit_count = ROW_COUNT;
    IF audit_count <> candidate_count THEN
        RAISE EXCEPTION
            'Migration 214 wrote % of % required Ballin SKU audit rows',
            audit_count,
            candidate_count;
    END IF;

    UPDATE public.product_variants variant
    SET sku = candidate.new_sku,
        barcode = candidate.new_sku
    FROM migration_214_ballin_sku_repair candidate
    WHERE variant.id = candidate.variant_id
      AND BTRIM(variant.sku) = candidate.old_sku
      AND variant.barcode IS NOT DISTINCT FROM candidate.old_barcode;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    IF updated_count <> candidate_count THEN
        RAISE EXCEPTION
            'Migration 214 promoted % of % audited Ballin Counterpoint B-SKUs',
            updated_count,
            candidate_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM migration_214_ballin_sku_repair candidate
        INNER JOIN public.product_variants variant ON variant.id = candidate.variant_id
        WHERE variant.sku IS DISTINCT FROM candidate.new_sku
           OR variant.barcode IS DISTINCT FROM candidate.new_sku
    ) THEN
        RAISE EXCEPTION
            'Migration 214 post-state verification found an unpromoted Ballin Counterpoint B-SKU';
    END IF;

    UPDATE public.meilisearch_sync_status
    SET source_revision = source_revision + 1,
        verified_revision = NULL,
        last_verified_at = NULL,
        verification_state = 'pending',
        verification_detail = 'Ballin Counterpoint B-SKUs changed; product and variant index revalidation is required.',
        verified_source_count = NULL,
        verified_document_count = NULL,
        updated_at = NOW()
    WHERE index_name IN ('ros_variants', 'ros_store_products');
END
$migration$;
