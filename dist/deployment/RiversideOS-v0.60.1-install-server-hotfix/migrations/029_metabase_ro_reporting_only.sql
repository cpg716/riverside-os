-- Lock Metabase to the curated reporting schema.
-- An older prelaunch migration temporarily granted metabase_ro SELECT on public.*.
-- That made raw app tables visible in Metabase and bypassed the reporting.* readability contract.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM metabase_ro;
        REVOKE SELECT ON ALL SEQUENCES IN SCHEMA public FROM metabase_ro;

        GRANT USAGE ON SCHEMA reporting TO metabase_ro;
        GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;
        ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO metabase_ro;

        IF EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'reporting'
              AND p.proname = 'effective_store_timezone'
        ) THEN
            GRANT EXECUTE ON FUNCTION reporting.effective_store_timezone() TO metabase_ro;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'reporting'
              AND p.proname = 'order_recognition_at'
        ) THEN
            GRANT EXECUTE ON FUNCTION reporting.order_recognition_at(uuid, text, text, timestamptz) TO metabase_ro;
        END IF;
    END IF;
END$$;

INSERT INTO ros_schema_migrations (version) VALUES ('029_metabase_ro_reporting_only.sql')
ON CONFLICT (version) DO NOTHING;
