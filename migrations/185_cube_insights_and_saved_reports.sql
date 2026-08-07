-- Governed Cube Core reporting access and reusable native Insights favorites.
--
-- Cube reads curated reporting views only. ROS remains the only staff-facing
-- API and validates every semantic query before forwarding it to Cube.

\set ON_ERROR_STOP on

CREATE OR REPLACE VIEW reporting.inventory_snapshot AS
SELECT
    pv.id AS variant_id,
    p.id AS product_id,
    p.name AS product_name,
    p.brand,
    pv.variation_label,
    CASE
        WHEN NULLIF(BTRIM(pv.variation_label), '') IS NULL THEN p.name
        ELSE CONCAT_WS(' - ', p.name, pv.variation_label)
    END AS item_display_name,
    pv.sku,
    pv.barcode,
    c.name AS category_name,
    v.name AS vendor_name,
    p.is_active,
    pv.track_low_stock,
    pv.stock_on_hand,
    pv.reserved_stock,
    pv.on_layaway,
    (pv.stock_on_hand - pv.reserved_stock - pv.on_layaway) AS available_stock,
    pv.reorder_point,
    COALESCE(pv.retail_price_override, p.base_retail_price)::numeric(12, 2) AS retail_price,
    COALESCE(pv.cost_override, p.base_cost)::numeric(12, 2) AS unit_cost,
    (
        pv.stock_on_hand::numeric
        * COALESCE(pv.cost_override, p.base_cost)
    )::numeric(14, 2) AS inventory_cost_value,
    pv.created_at
FROM public.product_variants pv
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN public.categories c ON c.id = p.category_id
LEFT JOIN public.vendors v ON v.id = p.primary_vendor_id;

COMMENT ON VIEW reporting.inventory_snapshot IS
    'Read-only product variation inventory snapshot for governed Cube Core reporting.';

CREATE TABLE IF NOT EXISTS public.insight_report_favorites (
    id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (BTRIM(name) <> '' AND LENGTH(name) <= 120),
    question text NOT NULL DEFAULT '' CHECK (LENGTH(question) <= 2000),
    report_spec jsonb NOT NULL CHECK (jsonb_typeof(report_spec) = 'object'),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (staff_id, name)
);

CREATE INDEX IF NOT EXISTS idx_insight_report_favorites_staff_updated
    ON public.insight_report_favorites (staff_id, updated_at DESC);

COMMENT ON TABLE public.insight_report_favorites IS
    'Staff-owned validated Cube report specifications. Results are re-run live and are never stored here.';

CREATE TABLE IF NOT EXISTS public.insight_report_history (
    id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
    question text NOT NULL DEFAULT '' CHECK (LENGTH(question) <= 2000),
    title text NOT NULL CHECK (BTRIM(title) <> '' AND LENGTH(title) <= 160),
    report_spec jsonb NOT NULL CHECK (jsonb_typeof(report_spec) = 'object'),
    row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_insight_report_history_staff_active
    ON public.insight_report_history (staff_id, last_accessed_at DESC)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_insight_report_history_staff_archive
    ON public.insight_report_history (staff_id, archived_at DESC)
    WHERE archived_at IS NOT NULL;

COMMENT ON TABLE public.insight_report_history IS
    'Automatic staff report history. Stores governed specifications and run metadata, not stale result snapshots; inactive entries archive after the configured threshold (180-day default).';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cube_ro') THEN
        BEGIN
            CREATE ROLE cube_ro WITH LOGIN NOINHERIT;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping cube_ro role creation; provision it as a PostgreSQL admin for Cube Core.';
        END;
    END IF;
END$$;

DO $$
DECLARE
    database_name text := current_database();
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cube_ro') THEN
        ALTER ROLE cube_ro LOGIN;
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO cube_ro', database_name);
        REVOKE ALL ON SCHEMA public FROM cube_ro;
        REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM cube_ro;
        REVOKE SELECT ON ALL SEQUENCES IN SCHEMA public FROM cube_ro;
        GRANT USAGE ON SCHEMA reporting TO cube_ro;
        GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO cube_ro;
        ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO cube_ro;
        ALTER ROLE cube_ro SET statement_timeout = '20s';
        COMMENT ON ROLE cube_ro IS
            'Cube Core read-only role. Reporting schema only; set its password outside migrations.';

        IF to_regprocedure('reporting.effective_store_timezone()') IS NOT NULL THEN
            GRANT EXECUTE ON FUNCTION reporting.effective_store_timezone() TO cube_ro;
        END IF;
        IF to_regprocedure('reporting.order_recognition_at(uuid,text,text,timestamp with time zone)') IS NOT NULL THEN
            GRANT EXECUTE ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) TO cube_ro;
        END IF;
    END IF;
END$$;

COMMENT ON SCHEMA reporting IS
    'Read-only analytics views for ROS native Insights and Cube Core. Application writes stay on public.*.';

INSERT INTO ros_schema_migrations (version)
VALUES ('185_cube_insights_and_saved_reports.sql')
ON CONFLICT (version) DO NOTHING;
