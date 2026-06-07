-- Metabase-readable daily sales weather view.
-- Keeps weather reporting in the curated reporting schema instead of exposing raw public tables.

CREATE OR REPLACE VIEW reporting.daily_sales_weather AS
WITH sales AS (
    SELECT
        COALESCE(t.business_date, (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) AS business_date,
        COALESCE(SUM(
            GREATEST(tl.quantity - COALESCE(ret.returned_quantity, 0), 0)::numeric
            * tl.unit_price
        ), 0)::numeric(14, 2) AS sales,
        COALESCE(SUM(
            GREATEST(tl.quantity - COALESCE(ret.returned_quantity, 0), 0)::numeric
            * (tl.state_tax + tl.local_tax)
        ), 0)::numeric(14, 2) AS tax_collected,
        COUNT(DISTINCT t.id)::bigint AS transaction_count,
        COALESCE(SUM(GREATEST(tl.quantity - COALESCE(ret.returned_quantity, 0), 0)), 0)::bigint AS line_units
    FROM public.transactions t
    JOIN public.transaction_lines tl ON tl.transaction_id = t.id
    LEFT JOIN public.products p ON p.id = tl.product_id
    LEFT JOIN (
        SELECT transaction_line_id, SUM(quantity_returned)::int AS returned_quantity
        FROM public.transaction_return_lines
        GROUP BY transaction_line_id
    ) ret ON ret.transaction_line_id = tl.id
    WHERE COALESCE(tl.is_internal, false) = false
      AND p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment'
      AND p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load'
    GROUP BY COALESCE(t.business_date, (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date)
),
weather AS (
    SELECT
        day_row.business_date,
        COALESCE(register_weather.snapshot, transaction_weather.snapshot) AS snapshot,
        CASE
            WHEN register_weather.snapshot IS NOT NULL THEN 'Register close'
            WHEN transaction_weather.snapshot IS NOT NULL THEN 'Checkout'
            ELSE NULL
        END AS weather_source
    FROM (SELECT DISTINCT business_date FROM sales) day_row
    LEFT JOIN LATERAL (
        SELECT rs.weather_snapshot AS snapshot
        FROM public.register_sessions rs
        WHERE rs.weather_snapshot IS NOT NULL
          AND jsonb_typeof(rs.weather_snapshot) = 'array'
          AND (rs.closed_at AT TIME ZONE reporting.effective_store_timezone())::date = day_row.business_date
        ORDER BY rs.closed_at DESC NULLS LAST
        LIMIT 1
    ) register_weather ON true
    LEFT JOIN LATERAL (
        SELECT t.weather_snapshot AS snapshot
        FROM public.transactions t
        WHERE t.weather_snapshot IS NOT NULL
          AND jsonb_typeof(t.weather_snapshot) = 'array'
          AND COALESCE(t.business_date, (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) = day_row.business_date
        ORDER BY t.booked_at DESC
        LIMIT 1
    ) transaction_weather ON register_weather.snapshot IS NULL
)
SELECT
    sales.business_date,
    sales.sales,
    sales.tax_collected,
    sales.transaction_count,
    sales.line_units,
    weather.snapshot->0->>'condition' AS weather_condition,
    (weather.snapshot->0->>'temp_high')::numeric(8, 2) AS weather_high,
    (weather.snapshot->0->>'temp_low')::numeric(8, 2) AS weather_low,
    (weather.snapshot->0->>'precipitation_inches')::numeric(8, 3) AS precipitation_inches,
    weather.weather_source
FROM sales
LEFT JOIN weather ON weather.business_date = sales.business_date;

COMMENT ON VIEW reporting.daily_sales_weather IS
    'Daily sales totals with captured weather conditions for Metabase and weather-aware sales reporting.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        GRANT SELECT ON reporting.daily_sales_weather TO metabase_ro;
    END IF;
END$$;

INSERT INTO ros_schema_migrations (version) VALUES ('075_daily_sales_weather_reporting.sql')
ON CONFLICT (version) DO NOTHING;
