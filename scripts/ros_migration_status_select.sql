-- Requires tmp_ros_migration_probes (see ros_migration_build_probes.sql). Requires ros_schema_migrations table.

SELECT
    t.migration_version,
    (m.version IS NOT NULL) AS in_ledger,
    m.applied_at,
    t.probe_ok,
    t.probe_hint,
    CASE
        WHEN m.version IS NULL AND t.probe_ok THEN 'schema OK — add ledger row (backfill) or pre-ledger DB'
        WHEN m.version IS NOT NULL AND NOT t.probe_ok THEN 'LEDGER_MISMATCH: recorded but probe failed'
        WHEN m.version IS NOT NULL AND t.probe_ok THEN 'ok'
        ELSE 'apply SQL file'
    END AS status
FROM tmp_ros_migration_probes t
LEFT JOIN ros_schema_migrations m ON m.version = t.migration_version
ORDER BY t.migration_version;
