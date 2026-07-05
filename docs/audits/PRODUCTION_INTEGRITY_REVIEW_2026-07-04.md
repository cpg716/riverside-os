# Production Integrity Review

Date: 2026-07-04
Scope: Riverside OS production data integrity, auditability, and recoverability review.
Mode: AUDIT with safe targeted fixes for confirmed deterministic issues.

## Executive Summary

Recommendation: **CAUTION**.

The source gates, release-style checks, server compile check, targeted Rust tests, client typecheck, help-impact check, local backup/restore drill, and fresh database migration chain through migration `115` are passing after the fixes in this review. Riverside OS has strong application-level protections for checkout idempotency, financial invariants, print/release readiness, migration checksums, and Staff Access/Manager Access gates.

This review found and fixed five deterministic production-integrity gaps:

1. Counterpoint stock sync and catalog import could set `product_variants.stock_on_hand` without creating an `inventory_transactions` audit row.
2. Legacy returned commissionable transaction lines could be missing compensating `commission_events.return_adjustment` rows.
3. The existing local database was blocked at migration `089_restore_custom_order_catalog_skus.sql` by legacy operational SKUs `100` and `200`.
4. QBO daily journal rows with no postable lines or blocking accounting warnings could remain normal `pending` rows.
5. Back Office transaction line deletion could physically remove lines without checking payment, fulfillment, takeaway, or lifecycle state.
6. QBO setup had token exchange/refresh support but did not expose the Intuit OAuth authorization URL from Settings.

Those confirmed issues are now addressed by code, migrations, documentation, and the local recovery script. The system should still remain **CAUTION** until the remaining production-environment proof items below are resolved or explicitly accepted.

## Review Coverage

Reviewed and validated these integrity areas:

- Financial transaction invariants, payment allocation checks, return/exchange commission adjustments, QBO staging balance guards, tax exemption guardrails, transaction idempotency gates, and transaction line deletion rules.
- Inventory movement auditability, Counterpoint inventory import behavior, receiving/PO ledger controls, reservation state, stock mutation paths, and imported negative-inventory visibility.
- Migration durability on a fresh database through migration `115`.
- Existing local database migration recovery through the pre-retag dirty migration rehearsal and the SKU collision repair script.
- Release-style go-live, deployment, print-routing, Help corpus, client typecheck, lint, server check, rustfmt, and whitespace gates.
- Local Docker `riverside_os` data probes for high-risk records that source-only checks cannot see.
- Local Compose backup/restore mechanics using `pg_dump -Fc` and `pg_restore` into a throwaway database.

## Fixes Made

### Counterpoint Inventory Audit Ledger

Files:

- `server/src/logic/counterpoint_sync.rs`
- `migrations/114_counterpoint_inventory_and_return_audit_backfill.sql`

Counterpoint inventory batch updates now create an `inventory_transactions` adjustment row whenever sync changes a variant's stock quantity. The adjustment records the stock delta, unit cost fallback, source table `counterpoint_inventory_sync`, and a note showing the reconciled stock range.

Counterpoint catalog variant upserts now record a `counterpoint_catalog_import` adjustment when a stock-carrying catalog payload creates or updates stock. The helper skips zero-delta updates so reruns do not duplicate movement history.

Migration `114` backfills:

- `counterpoint_inventory_baseline` adjustment rows for Counterpoint-linked variants that currently have stock but no movement history.
- Missing `return_adjustment` commission events for legacy returned commissionable lines, using the same proportional negative adjustment shape as the live return path.

The migration is idempotent, fresh-database safe, and embedded for packaged installs.

### Local SKU Collision Recovery

File: `scripts/repair-migration-089-custom-sku-collisions.sql`

After the business decision that operational SKUs `100` and `200` did not need to preserve their legacy Counterpoint identity, the repair script was applied to the local Docker database. It:

- Renamed the legacy collision rows to `ROS-LEGACY-CUSTOM-100` and `ROS-LEGACY-CUSTOM-200`.
- Cleared stale Counterpoint item keys from those local operational rows.
- Cleared one orphaned reservation that had no transaction-line backing.
- Wrote `product_catalog_audit_log` entries for traceability.

After this repair, the existing local database migrated through `115` with no checksum drift.

### QBO Blocking Review State

Files:

- `server/src/logic/qbo_journal.rs`
- `server/src/api/qbo.rs`
- `client/src/components/settings/QuickBooksSettingsPanel.tsx`
- `client/src/components/qbo/QboMappingLogic.ts`
- `migrations/115_qbo_blocking_warning_review_status.sql`
- `client/src/components/qbo/QboWorkspace.tsx`
- `client/src/assets/docs/qbo-workspace-manual.md`
- `docs/staff/qbo-bridge.md`

QBO staging now classifies proposals with no postable journal lines or blocking accounting warnings as `needs_review` instead of normal `pending`. The payload records `qbo_stage.review_status` and `qbo_stage.review_blockers`.

Approval and sync gates now reject blocking warnings even when the debit/credit totals balance. The five existing local QBO rows were reclassified from `pending` to `needs_review`.

The QBO workspace now surfaces `needs_review`, keeps those rows out of the approve action, and includes the blocking message in the warning stack. Staff docs now tell accounting to fix mappings or regenerate/review instead of approving empty or mapping-blocked rows. Since QuickBooks is not connected yet, this is expected setup gating rather than a current posting blocker.

Settings now exposes **Connect to QuickBooks**, which generates an Intuit OAuth authorization URL with the QuickBooks Online Accounting scope, stores a one-time state token, validates that state in the callback, exchanges the authorization code for tokens, and clears the state token after success. The mapping matrix also includes a plain **Credit card clearing** row for imported/generic `credit_card` payment rows.

### Transaction Line Delete Hardening

Files:

- `server/src/api/transactions.rs`
- `client/src/assets/docs/orders-workspace-manual.md`
- `docs/staff/transactions-back-office.md`

Back Office line deletion now locks the transaction and line in one database transaction, then rejects deletion when:

- The transaction is not `open` or `pending_measurement`.
- Any payment allocation exists.
- The line is fulfilled.
- The line is a takeaway sale line.
- The line has advanced past `needs_measurements` or `ntbo`.

The delete, total recalculation, and activity log now commit together. Paid, fulfilled, pickup, vendor-processing, or completed-sale history must go through the return, refund, exchange, cancellation, or void workflows.

## Evidence From Data Probes

Current local Docker `riverside_os` probes after the fixes:

- QBO staging status: `needs_review = 5`; `pending = 0`.
- Negative available stock rows: `583`.
- Negative stock-on-hand rows: `583`.
- Positive stock rows where commitments exceed stock: `0`.
- Imported Counterpoint negative inventory remains visible in ROS data. Per business direction, this is external Counterpoint inventory state, not a ROS-owned correction target.
- Custom SKU recovery proof: SKUs `100`, `200`, `ROS-LEGACY-CUSTOM-100`, and `ROS-LEGACY-CUSTOM-200` all have stock `0`, reserved `0`, layaway `0`, and no Counterpoint item key.
- Highest applied migration in local Docker DB: `115_qbo_blocking_warning_review_status.sql`.
- Fresh throwaway database migrated through `115` with no drift.
- Local backup/restore row-count proof matched for `customers`, `transactions`, `transaction_lines`, `payment_transactions`, `payment_allocations`, `product_variants`, `inventory_transactions`, `qbo_sync_logs`, `commission_events`, and `ros_schema_migrations`.

Historical probes before the fixes found:

- Counterpoint-linked stock without movement ledger: `4588`.
- Returned commissionable lines missing return adjustment: `2`.
- Local migration blocker at SKU `100` in migration `089`.
- QBO pending rows: `5`.

Those four historical findings are addressed by this change set and local recovery run.

## Remaining Risks And Business Decisions

### External Data State: Counterpoint Negative Inventory

`583` variants still have negative stock on hand and negative availability. These are no longer caused by SKU `100`/`200` reservation collisions; the remaining examples are Counterpoint-style inventory SKUs with negative physical stock values.

Business decision recorded: this is not a ROS production-integrity blocker. ROS should preserve and display/import the values as external Counterpoint inventory state rather than silently clamping or rewriting them.

The ROS-owned integrity requirement is that Counterpoint stock changes remain auditable and do not create hidden local reservations or migration collisions. That requirement is addressed by the Counterpoint inventory audit ledger fix and the local SKU collision repair.

### P1: Main Hub Backup/Restore Proof

Local Compose backup and restore mechanics passed. That does not prove the intended production Main Hub machine has current backup media, permissions, disk space, or restore readiness.

Business decision needed: run the same backup/restore drill against the actual Main Hub environment before go-live, or explicitly accept local-only proof.

### Expected Setup Gate: QBO Mapping Before Posting Is Enabled

The five QBO rows are now blocked as `needs_review`, not silently approvable. Because QuickBooks is not connected or configured yet, these rows are not a current production posting failure.

The `credit_card` warning is tied to Counterpoint-imported payment rows, not current ROS checkout. QBO mappings still need to be configured before QBO posting is enabled, then these dates can be regenerated, reviewed, or left as historical/import-only staging evidence.

### External Systems Not Proven In This Pass

This review did not prove live Helcim, QBO, Constant Contact, Shippo, Podium, Counterpoint SQL Server, Windows installer/update, printer hardware, or multi-register hardware behavior against production credentials/devices. Those require environment-specific validation.

## Validation Run

- `cargo fmt --manifest-path server/Cargo.toml -- --check` - passed.
- `cargo test --manifest-path server/Cargo.toml qbo --lib` - passed, `20` tests.
- `cargo test --manifest-path server/Cargo.toml counterpoint_inventory_unmatched_rows_are_visible_and_deduped --lib` - passed.
- `npm --prefix client run typecheck` - passed.
- `npm run check:server` - passed.
- `npm run check:help-impact` - passed.
- Fresh throwaway database migration from `001` through `115` using `./scripts/apply-migrations-docker.sh` - passed with checksum drift verification.
- Existing local database migrated through `115` after `scripts/repair-migration-089-custom-sku-collisions.sql` - passed with no checksum drift.
- Local Compose backup/restore drill with table row-count comparison - passed.
- Local data probes for QBO status, imported negative inventory visibility, custom SKU repair, and migration status - passed.
- `npm run check:pre-retag` - passed.
- `git diff --check` - passed.

## Final Assessment

Riverside OS has the core code controls expected of a production POS/ERM system: financial invariant gates, idempotent transaction handling, permission gates, migration checksums, audit paths, and release-style validation gates. This review fixed the confirmed deterministic gaps found in inventory audit completeness, commission return audit completeness, local migration recovery, QBO review gating, and transaction line deletion controls.

The remaining blockers are environment decisions, not safe automatic code repairs. The system should remain **CAUTION** for production system-of-record use until Main Hub backup/restore proof is current and external integrations/hardware are validated against the actual production environment. QBO mappings are required before enabling QuickBooks posting, but they are not a current production blocker while QBO is intentionally disconnected.
