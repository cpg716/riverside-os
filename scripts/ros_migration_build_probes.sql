-- Baseline migration probes for schema-contract status checks.
-- Legacy per-file probes were retired with the pre-launch baseline reset.

\set ON_ERROR_STOP on

DROP TABLE IF EXISTS tmp_ros_migration_probes;
CREATE TEMP TABLE tmp_ros_migration_probes (
    migration_version TEXT PRIMARY KEY,
    probe_ok          BOOLEAN NOT NULL,
    probe_hint        TEXT NOT NULL
);

INSERT INTO tmp_ros_migration_probes
SELECT *
FROM (
    VALUES
        ('001_core_identity_staff.sql',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_permission')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations'),
         'core identity/staff tables + migration ledger'),
        ('002_catalog_inventory.sql',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'inventory_transactions'),
         'catalog and inventory tables'),
        ('003_customers_weddings_relationships.sql',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customers')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wedding_members'),
         'customers and wedding relationship tables'),
        ('004_pos_transactions_payments.sql',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transactions')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transaction_lines')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_allocations'),
         'POS transaction and payment tables'),
        ('005_operations_workflows.sql',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'task_instance')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_weekly_schedule'),
         'operations workflow tables'),
        ('006_integrations.sql',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'counterpoint_sync_runs')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_provider_attempts'),
         'integration tables'),
        ('007_reporting_views.sql',
         to_regclass('reporting.transactions_core') IS NOT NULL
         AND to_regclass('reporting.payment_ledger') IS NOT NULL,
         'reporting views'),
        ('008_indexes_constraints_triggers.sql',
         EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_transaction_lines_transaction')
         AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_generate_txn_display_id'),
         'indexes and triggers'),
        ('009_promo_gift_cards.sql',
         EXISTS (
             SELECT 1
             FROM pg_enum e
             JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'gift_card_kind'
               AND e.enumlabel = 'promo_gift_card'
         )
         AND EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'gift_cards'
               AND column_name = 'promo_event_name'
         ),
         'promo gift card kind and event name column')
) AS t(migration_version, probe_ok, probe_hint);
