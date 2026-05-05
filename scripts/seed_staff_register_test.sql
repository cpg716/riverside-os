-- Compatibility wrapper for older local/E2E commands.
-- The canonical E2E seed is scripts/seeds/seed_e2e.sql.

\set ON_ERROR_STOP on
\i scripts/seeds/seed_core_required.sql
\i scripts/seeds/seed_rbac.sql
\i scripts/seeds/seed_e2e.sql
