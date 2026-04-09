-- Requires tmp_ros_migration_probes in the same psql session. Inserts ledger rows where probes pass.

INSERT INTO ros_schema_migrations (version)
SELECT migration_version
FROM tmp_ros_migration_probes
WHERE probe_ok
ON CONFLICT (version) DO NOTHING;
