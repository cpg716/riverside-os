# Schema Contract and Migrations

Riverside OS is pre-launch, so the database has been reset from a long historical migration stream into a clean schema-contract baseline.

The current system is contract-driven:

- active migrations fully define the fresh-install schema
- seed data is applied after schema migrations
- runtime startup validates the schema only
- the server never applies hidden DDL or compatibility patches at startup
- legacy pre-launch migration history is retained for audit context only

## Active Baseline

The only active migration files in `migrations/` are:

| File | Domain |
| --- | --- |
| `001_core_identity_staff.sql` | Core identity, staff, permissions tables, store settings, audit foundations |
| `002_catalog_inventory.sql` | Catalog, product variants, inventory, vendors, procurement |
| `003_customers_weddings_relationships.sql` | Customers, relationships, weddings, measurements |
| `004_pos_transactions_payments.sql` | POS transactions, transaction lines, payments, allocations, refunds, fulfillment orders |
| `005_operations_workflows.sql` | Register sessions, tasks, scheduling, alterations, notifications, backups, operational workflow tables |
| `006_integrations.sql` | QBO, Counterpoint, Podium, Shippo, NuORDER, online store, payment-provider integration tables, Helcim event and settlement foundations |
| `007_reporting_views.sql` | Reporting schema, reporting functions, Metabase-facing views |
| `008_indexes_constraints_triggers.sql` | Cross-domain indexes, constraints, triggers, generated IDs |

Historical migration files live under `migrations/legacy_prelaunch_history/`. They are not applied by the normal migration scripts.

## Seeds

Schema migrations must not contain staff defaults, permissions, store settings, test users, service products, or fixture data.

Seed files live in `scripts/seeds/`:

| File | Purpose | Intended environments |
| --- | --- | --- |
| `seed_core_required.sql` | Required singleton/config rows and non-user bootstrap rows the app expects after schema creation | dev, test, production install |
| `seed_rbac.sql` | Role permission template rows | dev, test, production install |
| `seed_dev.sql` | Local development staff/bootstrap defaults, including Admin `1234` | local dev only |
| `seed_e2e.sql` | Deterministic browser/API fixture staff and test permissions | E2E only |

Apply seeds after migrations. For a normal local development database:

```bash
./scripts/apply-migrations-docker.sh
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < scripts/seeds/seed_core_required.sql
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < scripts/seeds/seed_rbac.sql
docker compose exec -T db psql -U postgres -d riverside_os -v ON_ERROR_STOP=1 < scripts/seeds/seed_dev.sql
```

The deterministic Playwright stack applies `seed_core_required.sql`, `seed_rbac.sql`, and `seed_e2e.sql` automatically through `scripts/e2e-local-stack.sh`.

## Runtime Contract

`server/src/schema_bootstrap.rs` is validation-only. Startup checks for critical tables, columns, reporting views, indexes/functions, and generated ID functions needed by the running binary.

If the connected database does not match the contract, startup fails with a clear schema mismatch error. Fix the database by applying migrations and seeds explicitly; do not add runtime DDL.

## Validation Commands

Use these checks when touching migrations, seeds, schema startup validation, or deployment scripts:

```bash
bash scripts/validate_migration_layout.sh
RIVERSIDE_DB_NAME=riverside_os bash scripts/migration-status-docker.sh
RIVERSIDE_DB_NAME=riverside_os bash scripts/validate_schema_contract.sh
```

For equivalence checks between two databases:

```bash
bash scripts/schema_diff.sh <left-db-or-url> <right-db-or-url>
```

`schema_diff.sh` runs normalized schema-only dumps and fails if the schemas differ.

## Future Migration Rules

After launch, migrations are append-only:

- do not edit old baseline files for live schema changes
- do not rename or renumber existing migration files
- do not add duplicate numeric prefixes
- do not put seed/test data in migrations
- do not rely on runtime schema mutation
- run layout and schema-contract validation before commit

For pre-launch baseline work, regenerate and validate the baseline as a whole. For post-launch work, add a new numbered migration after the current active baseline.

## Payment Provider Settlement Contract

The Helcim settlement foundation is backend-only and lives in the baseline integration schema:

- `helcim_event_log` stores durable inbound webhook events before any mutation.
- `payment_provider_batches` stores provider batch headers by `provider` + `provider_batch_id`.
- `payment_provider_batch_transactions` stores provider transaction membership inside a batch and links to `payment_transactions` when matched.
- `payment_settlement_runs` stores durable sync/reconciliation run history.
- `payment_settlement_items` stores open or historical reconciliation findings.
- `payment_settlement_item_events` stores append-only staff review, note, resolution, reopen, and manual payment-link history for reconciliation findings.

Resolving or marking a reconciliation finding expected records staff review history only. It does not delete processor evidence, mutate payment amounts, create payment ledger rows, or create QBO/bank deposits.

Actual bank deposits are intentionally not modeled in this layer. Phase 2 records expected processor settlement structure and reconciliation findings; bank/QBO deposit matching belongs in a later bank-feed or QBO-deposit layer.
