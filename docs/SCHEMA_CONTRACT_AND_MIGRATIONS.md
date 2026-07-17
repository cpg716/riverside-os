# Schema Contract and Migrations

Applied migration SQL is immutable. Migration checksum verification accepts LF/CRLF differences and the historical single-extra-final-newline variant because those do not change executable SQL. Any other checksum difference remains blocking and requires a new numbered migration; never overwrite the stored ledger checksum merely to silence drift.

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
| `009_promo_gift_cards.sql` | Promo gift card enum support and event-name tracking |
| `010_counterpoint_ingest_quarantine.sql` | Counterpoint ingest quarantine review tables |
| `011_product_variant_barcode_aliases.sql` | Product variant barcode alias tracking |
| `012_lightspeed_normalization_reference.sql` | Lightspeed normalization reference tables |
| `013_financial_effective_dates.sql` | Financial effective-date tracking |
| `014_helcim_terminal_recovery_actions.sql` | Helcim terminal recovery action audit |
| `015_counterpoint_staging_applying_status.sql` | Counterpoint staging apply status |
| `016_counterpoint_staging_apply_claim_metadata.sql` | Counterpoint staging apply-claim metadata |
| `017_counterpoint_staging_observability.sql` | Counterpoint staging observability fields |
| `018_order_item_lifecycle.sql` | Order item lifecycle tracking |
| `019_takeaway_completed_recognition.sql` | Takeaway completed recognition support |
| `020_order_lifecycle_needs_measurements.sql` | Order lifecycle measurement flags |
| `021_wedding_cutover_review.sql` | Wedding cutover review tracking |
| `022_email_mailbox.sql` | Email mailbox tables |
| `023_shippo_returns_manifests_pickups.sql` | Shippo returns, manifests, and pickups |
| `024_register_drawer_open_events.sql` | Register drawer-open event audit |
| `025_qbo_bridge_mapping_hardening.sql` | QBO bridge mapping hardening |
| `026_counterpoint_go_live_hardening.sql` | Counterpoint go-live hardening |
| `027_repair_promo_gift_card_schema.sql` | Promo gift card schema repair |
| `028_podium_communications_hardening.sql` | Podium communications hardening |
| `029_metabase_ro_reporting_only.sql` | Metabase read-only reporting access |
| `030_podium_staff_identity_mapping.sql` | Podium staff identity mapping |
| `031_checkout_takeaway_loyalty_backfill.sql` | Checkout takeaway loyalty backfill |
| `032_transaction_status_integrity.sql` | Transaction status integrity tracking |
| `033_qbo_inventory_receiving_clearing.sql` | QBO inventory receiving clearing account support |
| `034_transaction_void_records.sql` | POS transaction void audit and reversal tracking |
| `035_backup_resilience_settings.sql` | Backup and resilience settings |
| `036_financial_date_and_counterpoint_integrity.sql` | Financial date and Counterpoint integrity hardening |
| `037_backfill_missing_columns.sql` | Backfill columns added to earlier files after they were applied (`store_media_asset.deleted_at/alt_text/usage_note`, `categories.variation_axis_presets`) |
| `038_web_listing_and_categories.sql` | Adds web listing and category schema |
| `039_wal_archiving_configuration.sql` | Adds PostgreSQL WAL archiving configuration |
| `040_ops_audit_probes.sql` | Adds operations audit probe records |
| `041_staff_avatar_photo.sql` | Adds staff avatar photo support |
| `042_seed_admin_account.sql` | Adds the initial admin account schema/seed support |
| `043_fal_visual_sidecar.sql` | Adds FAL visual sidecar records |
| `044_customer_review_opt_out.sql` | Adds customer review opt-out tracking |
| `045_qbo_webhook_events_and_hardening.sql` | Adds QBO webhook events and hardening fields |
| `046_alteration_pickup_tracking.sql` | Adds alteration pickup tracking |
| `047_phase4_resiliency.sql` | Adds Phase 4 resiliency controls |
| `048_constant_contact_integration.sql` | Adds Constant Contact integration data |
| `049_constant_contact_permissions.sql` | Adds Constant Contact permissions |
| `050_inventory_migration_workbench.sql` | Adds inventory migration workbench records |
| `051_receiving_freight_ledger_keys.sql` | Adds receiving freight ledger keys |
| `052_daily_financial_reports.sql` | Adds daily financial report records |
| `053_customer_notification_queue.sql` | Adds the customer notification queue |
| `054_customer_opt_in_defaults.sql` | Adds customer communication opt-in defaults |
| `055_alteration_ticket_number.sql` | Adds alteration ticket numbers |
| `056_alteration_verify_completed_status.sql` | Adds alteration completion verification status |
| `057_transaction_lines_alteration_ready.sql` | Adds alteration-ready state to transaction lines |
| `058_pos_station_config.sql` | Adds POS station configuration |
| `060_rosie_token_telemetry.sql` | Adds ROSIE token telemetry |
| `061_ops_connectivity_logs.sql` | Adds operations connectivity logs |
| `062_rename_qbo_inventory_adjustment_revenue.sql` | Renames the QBO inventory-adjustment revenue mapping |
| `063_notification_search_and_fatigue.sql` | Adds notification search and fatigue controls |
| `064_staff_schedule_admin_effective_days.sql` | Adds effective-day controls for staff schedule administration |
| `065_procurement_imports.sql` | Adds procurement import records |
| `066_ops_readiness_signoffs.sql` | Adds operations readiness signoffs |
| `067_customer_notification_center.sql` | Adds customer notification center data |
| `068_transaction_lines_discount_amount.sql` | Stores transaction-line discount amounts |
| `069_retire_qbo_transaction_outbox.sql` | Retires the QBO transaction outbox schema |
| `070_task_assignment_ownership.sql` | Adds task assignment ownership |
| `071_physical_inventory_readiness_controls.sql` | Adds physical-inventory readiness controls |
| `072_physical_inventory_scan_idempotency.sql` | Adds idempotent physical-inventory scan tracking |
| `073_product_secondary_vendors.sql` | Adds secondary vendor relationships for products |
| `074_discount_events_full_inventory_scope.sql` | Extends discount events to the full inventory scope |
| `075_daily_sales_weather_reporting.sql` | Adds daily sales and weather reporting data |
| `076_commission_combo_variant_targets.sql` | Adds commission targets for combo variants |
| `077_register_cash_deposit.sql` | Adds register cash-deposit records |
| `078_data_integrity_hardening.sql` | Provider ledger, QBO pending-row, and online checkout attempt integrity constraints |
| `079_counterpoint_transition_review_packs.sql` | Historical prelaunch Counterpoint review tables; not part of the go-live import workflow |
| `080_counterpoint_payment_method_aliases.sql` | Counterpoint tender alias seeds observed during real-data import rehearsals |
| `081_counterpoint_import_first_proof.sql` | Counterpoint import-first run, source-count, raw-record, provenance, and exception proof tables |
| `082_loyalty_reward_threshold_floor.sql` | Loyalty reward threshold floor enforcement |
| `083_staff_schedule_requests_and_appointment_identity.sql` | Staff request-off and appointment staff identity hardening |
| `084_staff_birthdays_notifications.sql` | Staff birthday notification fields and notification type |
| `085_rosie_read_tool_audit.sql` | ROSIE read-tool audit table |
| `086_rosie_tool_gap_log.sql` | ROSIE unsupported tool gap logging |
| `087_open_deposit_ledger_sources.sql` | Open deposit ledger source traceability |
| `088_drop_counterpoint_review_pack_tables.sql` | Drops retired Counterpoint review-pack tables from the active schema |
| `089_restore_custom_order_catalog_skus.sql` | Restores protected ROS custom-order catalog SKUs and preserves Counterpoint copies under CP-prefixed SKUs |
| `090_counterpoint_import_run_kind_modes.sql` | Normalizes Counterpoint import-run kinds for direct live ingest |
| `091_counterpoint_2024_history_floor.sql` | Sets the Counterpoint import-run history floor default to January 1, 2024 |
| `092_counterpoint_live_tender_aliases.sql` | Adds live Riverside Counterpoint tender aliases observed in 2024+ history probes |
| `093_counterpoint_square_tender_alias.sql` | Adds the Counterpoint Square tender alias |
| `094_counterpoint_closed_ticket_balance_presentation.sql` | Preserves closed-ticket balance presentation for Counterpoint history |
| `095_register_session_station_tokens.sql` | Adds station-bound register session token support |
| `096_counterpoint_category_tax_defaults.sql` | Adds Counterpoint category tax defaults |
| `097_manager_approval_permission.sql` | Adds manager approval permission support |
| `098_transaction_line_booked_at.sql` | Stores transaction-line booked timestamps |
| `099_transaction_line_shipping_release.sql` | Adds transaction-line shipping recognition release support |
| `100_allow_wedding_import_customer_source.sql` | Allows imported wedding customer source metadata |
| `101_register_open_lane_uniqueness_guard.sql` | Prevents duplicate open register lanes |
| `102_counterpoint_open_doc_tax_repair.sql` | Repairs Counterpoint open-document tax data |
| `103_counterpoint_open_doc_tax_header_repair.sql` | Repairs Counterpoint open-document tax headers |
| `104_wedding_import_customer_identity_repair.sql` | Repairs imported wedding customer identity links |
| `105_wedding_import_duplicate_customer_repair.sql` | Repairs duplicate imported wedding customers |
| `106_counterpoint_variation_label_cleanup.sql` | Cleans Counterpoint variation labels |
| `107_counterpoint_variation_all_star_cleanup.sql` | Cleans Counterpoint all-star variation labels |
| `108_inventory_hide_stale_zero_stock.sql` | Hides stale zero-stock inventory variants |
| `109_wedding_party_numbers.sql` | Adds wedding party number support |
| `110_donation_tender_reporting.sql` | Adds donation tender reporting support |
| `111_helcim_event_payment_match_backfill.sql` | Backfills Helcim event/payment matches |
| `112_weather_vc_request_cache.sql` | Adds Visual Crossing request caching and cooldowns |
| `113_system_staff_admin_salesperson.sql` | Adds system staff/admin salesperson support |
| `114_counterpoint_inventory_and_return_audit_backfill.sql` | Backfills Counterpoint inventory and return audit data |
| `115_qbo_blocking_warning_review_status.sql` | Adds QBO blocking-warning review status |
| `116_payment_allocation_transaction_index.sql` | Adds payment-allocation transaction lookup index |
| `117_retire_counterpoint_stale_notifications.sql` | Retires stale Counterpoint notifications |
| `118_repair_joe_webb_failed_exchange_return.sql` | Repairs a failed exchange return record |
| `119_backfill_open_deferred_payment_deposit_metadata.sql` | Backfills deferred-payment deposit metadata |
| `120_resolve_browser_station_offline_alerts.sql` | Resolves stale browser-station offline alerts |
| `121_pos_shipping_charge_links.sql` | Links POS shipping charges to source transactions |
| `122_unhide_inventory_variants.sql` | Restores intentionally visible inventory variants |
| `123_staff_accounts.sql` | Adds staff account support |
| `124_operational_recovery_and_telemetry.sql` | Adds operational recovery and telemetry records |
| `125_staff_access_sessions.sql` | Adds revocable Staff Access sessions |
| `126_register_business_day_z_reports.sql` | Adds business-day-specific Z-Report records |
| `127_counterpoint_transaction_reconciliation.sql` | Adds Counterpoint transaction reconciliation records |
| `128_helcim_paid_parked_sale_recovery.sql` | Adds approved Helcim parked-sale recovery records |
| `129_backfill_checkout_payment_payers.sql` | Backfills checkout payment payer links |
| `130_archive_duplicate_shipping_alteration_fee_products.sql` | Archives duplicate shipping and alteration fee products |
| `131_repair_counterpoint_historical_paid_amounts.sql` | Repairs historical Counterpoint paid amounts |
| `132_reliability_read_path_indexes.sql` | Adds reliability indexes for payment, history, and wedding reads |
| `133_qbo_backdated_sale_clearing.sql` | Adds QBO clearing support for manager-approved backdated sales |

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
psql "$DATABASE_URL" -f scripts/audit_data_integrity_diagnostics.sql
```

Before applying migration `078_data_integrity_hardening.sql` to production, run the diagnostics script against the production `DATABASE_URL` and confirm each probe returns zero rows. If any rows appear, pause the deployment and complete operator/accounting review before applying `078`; the migration intentionally enforces unique provider ledger keys, one pending QBO daily staging row per date, and one open online checkout payment attempt per session/provider.

For equivalence checks between two databases:

```bash
bash scripts/schema_diff.sh <left-db-or-url> <right-db-or-url>
```

`schema_diff.sh` runs normalized schema-only dumps and fails if the schemas differ.

## Checksum Drift Detection

As of migration 079, migration tooling stores a SHA-256 checksum of each migration file in the `file_sha256` column of `ros_schema_migrations`. Server startup verifies applied checksums, fails on drift, and refuses pending migrations unless `RIVERSIDE_APPLY_PENDING_MIGRATIONS_ON_STARTUP=true` is explicitly set for a non-production startup apply.

On each run the script compares the current file hash against the stored hash. If a file has been modified since it was applied, the script prints a **`⚠ DRIFT`** warning:

```
⚠ DRIFT: 006_integrations.sql has changed since it was applied!
  → This file was modified after being applied. You may need a new migration to reconcile.
```

This catches the exact scenario that caused the `deleted_at` / `variation_axis_presets` production errors: a migration file was edited in-place after being applied, the ledger said "done", and the new columns were silently skipped.

**When you see a DRIFT warning**: create a new numbered migration (e.g. `038_...`) with `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` to reconcile. Do not re-apply the modified file.

## Future Migration Rules

Migrations are **append-only and immutable** once applied to any environment:

- **never edit an already-applied migration file** — the checksum system will flag it as drift
- do not rename or renumber existing migration files
- do not add duplicate numeric prefixes
- do not put seed/test data in migrations
- do not rely on runtime schema mutation
- run layout and schema-contract validation before commit
- all new schema changes get the next numbered file (e.g. `038_...`)
- use `IF NOT EXISTS` / `IF EXISTS` guards in new migrations for safe idempotency

For post-launch work, add a new numbered migration after the current active baseline. Never modify baseline files.

## Payment Provider Settlement Contract

The Helcim settlement foundation is backend-only and lives in the baseline integration schema:

- `integration_credentials` stores encrypted server-side integration credentials saved from Backoffice Settings. `RIVERSIDE_CREDENTIALS_KEY` (or the existing `QBO_TOKEN_ENC_KEY` during transition) must be configured on the server before credentials can be saved; API responses expose configured status only, not raw secrets. QBO client credentials and OAuth tokens now use this shared store, while `qbo_integration` remains the metadata row for company realm, sandbox mode, token expiry, and sync timestamps.
- `helcim_event_log` stores durable inbound webhook events before any mutation. Replay is limited to stored failed Helcim events and reuses the stored payload; raw replay payloads are not accepted.
- `payment_provider_attempts` stores POS/Payments provider attempts for terminal payments, hosted manual-card payments, terminal refunds, storefront HelcimPay.js payments, saved-card token payments, card refunds/reverses, and queued transaction refunds. A failed provider attempt is audit evidence only; it must not by itself create or mutate `payment_transactions`.
- `payment_provider_batches` stores provider batch headers by `provider` + `provider_batch_id`.
- `payment_provider_batch_transactions` stores provider transaction membership inside a batch and links to `payment_transactions` when matched.
- `payment_settlement_runs` stores durable sync/reconciliation run history.
- `payment_settlement_items` stores open or historical reconciliation findings.
- `payment_settlement_item_events` stores append-only staff review, note, resolution, reopen, and manual payment-link history for reconciliation findings.
- `payment_actual_deposits` stores actual bank, QBO-reference, or manual deposit records.
- `payment_actual_deposit_batches` links actual deposits to expected provider batches without mutating provider truth.
- `payment_deposit_reconciliation_runs` and `payment_deposit_reconciliation_items` store actual-vs-expected deposit review runs and findings.
- `payment_actual_deposit_events` stores append-only staff history for actual deposit creation, notes, review, accepted variance, reopen, and batch-link actions.

Resolving or marking a reconciliation finding expected records staff review history only. It does not delete processor evidence, mutate payment amounts, create payment ledger rows, or create QBO/bank deposits.

Actual bank deposits are modeled for matching and audit only. The deposit layer does not create QuickBooks deposits, automate bank-feed ingestion, mutate payment ledger amounts, or change expected Helcim batch amounts, fees, or net values.

Helcim refund attempts are two-phase from ROS's perspective: the provider attempt may be recorded as failed for audit, but `payment_transactions`, refund queue totals, and transaction paid amounts are updated only after the provider response normalizes to approved/captured.

Payments automation uses the notification system for operational alerts only. Scheduled Helcim fee and batch syncs may refresh explicit provider data, but they do not infer fees or net amounts and do not mutate payment, batch, deposit, QBO, or bank-feed truth. Payment alert notifications are bundled and deduped by condition; clearing an alert only removes the staff reminder and never auto-resolves reconciliation or deposit review items.

## Weather Integration Cache Contract

Migration `112_weather_vc_request_cache.sql` stores expiring Visual Crossing Timeline responses and short-lived 429 cooldowns by request key. It is a provider-request cache only: it does not replace `transactions.weather_snapshot`, `register_sessions.weather_snapshot`, or `weather_vc_daily_usage`, and it does not create reporting weather rows by itself.
