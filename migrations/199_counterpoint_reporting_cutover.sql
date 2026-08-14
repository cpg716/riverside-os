UPDATE store_settings
SET counterpoint_config = jsonb_set(
    COALESCE(counterpoint_config, '{}'::jsonb),
    '{reporting_cutover_date}',
    to_jsonb('2026-07-02'::text),
    true
)
WHERE id = 1
  AND NOT (COALESCE(counterpoint_config, '{}'::jsonb) ? 'reporting_cutover_date');

CREATE OR REPLACE FUNCTION reporting.counterpoint_source_is_reportable(
    p_is_counterpoint_import BOOLEAN,
    p_business_date DATE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT
        NOT COALESCE(p_is_counterpoint_import, FALSE)
        OR NULLIF(settings.counterpoint_config->>'reporting_cutover_date', '') IS NULL
        OR p_business_date < (settings.counterpoint_config->>'reporting_cutover_date')::date
    FROM store_settings settings
    WHERE settings.id = 1
$$;

COMMENT ON FUNCTION reporting.counterpoint_source_is_reportable(BOOLEAN, DATE) IS
    'Selects Counterpoint as the booked/completed reporting source before the persisted ROS cutover date and ROS as the source on and after cutover.';
