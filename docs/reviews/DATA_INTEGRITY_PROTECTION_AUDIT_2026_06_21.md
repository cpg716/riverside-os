# Riverside OS Data Integrity, Protection, Security, and Auditability Review

**Date:** 2026-06-21  
**Scope:** Code-level review of business-critical data durability, auditability, consistency, recovery, synchronization, and authorization paths.  
**Status:** One confirmed auditability gap fixed in this change set; no remaining release-blocking code defect was proven in this pass.  

## 1. Executive Summary

Riverside OS has a strong data-integrity posture for the highest-risk financial and inventory flows. POS checkout, returns, gift cards, receiving, physical inventory, QBO staging, Counterpoint import, and backup/restore all show explicit domain logic, transaction usage, idempotency/replay handling, or exception tracking in the reviewed code paths.

Overall data integrity health: **Good**. Critical money and stock paths are generally transaction-bound and covered by focused contract tests.

Overall auditability health: **Good after this patch**. The main confirmed gap was in wedding destructive actions, where deletes could proceed without a durable activity row. Member deletion, appointment deletion, and non-inventory item deletion are now committed only with a matching `wedding_activity_log` entry.

Overall protection/security health: **Good**. Reviewed API surfaces consistently route through staff permission middleware for high-risk workflows, and sensitive workflows such as QBO, receiving, register sessions, and wedding mutation use explicit permission gates.

Highest-risk finding fixed: wedding destructive actions could silently lose audit history if activity-log insertion failed, and non-inventory item deletion had no activity entry.

Release-blocking findings: **None remaining from this pass.** Production/RC data probes and host restore drills remain operational signoff items, not newly proven code regressions.

## 2. Detailed Findings

### Finding 1: Wedding destructive actions could lose audit evidence

Severity: **High**  
Category: **Confirmed Data Integrity Risk / Auditability**  
Status: **Fixed**

Evidence:
- `server/src/api/weddings.rs` previously inserted member-delete activity outside the delete transaction and continued if `insert_wedding_activity` failed.
- `server/src/api/weddings.rs` previously deleted appointments before best-effort activity logging.
- `server/src/api/weddings.rs` previously deleted `wedding_non_inventory_items` without a `wedding_activity_log` row.
- `server/src/logic/weddings.rs` already provides the canonical `insert_wedding_activity` helper, so the gap was not architectural; the destructive handlers were not enforcing it.

Affected workflow:
- Wedding party member removal
- Wedding appointment deletion
- Wedding non-inventory checklist/item deletion

User/business impact:
- Staff could remove operational wedding records while the party timeline failed to preserve who/what/when evidence.
- Later dispute resolution, event readiness review, and customer-service recovery could be missing deletion context.

Fix implemented:
- Wrapped the three destructive wedding handlers in DB transactions.
- Inserted the `wedding_activity_log` entry inside the same transaction as the delete.
- Made delete commit depend on successful audit insertion.
- Added missing activity logging for non-inventory item deletion, including item id, description, quantity, and status metadata.

Files involved:
- `server/src/api/weddings.rs`

### Finding 2: Critical financial transaction paths show strong transaction and replay discipline

Severity: **Design Observation**  
Category: **Transaction Durability**

Evidence:
- `server/src/logic/transaction_checkout.rs` contains transaction-bound checkout, stock, allocation, and cleanup logic.
- `server/src/logic/transaction_returns.rs` records returns, restock movement, transaction totals, refund queue updates, and workflow audit in one commit.
- `server/src/logic/gift_card_ops.rs` centralizes in-transaction gift-card balance changes and event rows.
- `server/src/api/qbo.rs` validates balanced QBO staging payloads, unresolved classifications, account mappings, and QBO request ids before sync.
- Existing E2E contracts cover checkout tender, refunds, register close, QBO audit, gift-card redemption, and operational rollout smoke.

Recommended fix:
- No code change in this pass. Continue adding duplicate-submit/provider-webhook tests where `docs/api-audit/api-risk-register.md` already tracks follow-up coverage.

Files involved:
- `server/src/logic/transaction_checkout.rs`
- `server/src/logic/transaction_returns.rs`
- `server/src/logic/gift_card_ops.rs`
- `server/src/api/qbo.rs`
- `docs/api-audit/api-risk-register.md`

### Finding 3: Inventory mutations are mostly ledgered and blocked during physical inventory

Severity: **Design Observation**  
Category: **Inventory Integrity**

Evidence:
- Product Hub manual stock adjustments in `server/src/api/products.rs` lock the variant row, block active physical inventory sessions, enforce reason text, enforce Manager Access for destructive movements, update `product_variants.stock_on_hand`, and insert `inventory_transactions` in the same transaction.
- PO receiving in `server/src/api/purchase_orders.rs` uses transaction-bound receipt posting, idempotent replay handling, `inventory_transactions`, and reserved-stock updates for linked fulfillment.
- Physical inventory publish in `server/src/logic/physical_inventory.rs` snapshots scope, blocks non-sale movements during count, and writes audit rows during publish.

Recommended fix:
- No code change in this pass. Keep production stock drift probes in the release checklist, especially negative available-stock reconciliation.

Files involved:
- `server/src/api/products.rs`
- `server/src/api/purchase_orders.rs`
- `server/src/logic/physical_inventory.rs`
- `docs/PRODUCTION_COVERAGE_GAP_MATRIX.md`

### Finding 4: Counterpoint imports use quarantine and exception tracking

Severity: **Design Observation**  
Category: **Synchronization & Imports**

Evidence:
- `server/src/logic/counterpoint_sync.rs` filters unsafe inventory/catalog rows into `counterpoint_ingest_quarantine`.
- Import proof records unlanded rows in `counterpoint_import_exceptions`.
- Command-center readiness blocks on open exceptions.
- Tests in the same module cover quarantined inventory rows and unlanded exception records.

Recommended fix:
- No code change in this pass. Continue requiring operator review of open exceptions before import signoff.

Files involved:
- `server/src/logic/counterpoint_sync.rs`
- `docs/COUNTERPOINT_REAL_DATA_TEST_RUN_AUDIT.md`

### Finding 5: Recovery posture is implemented but still needs host-drill evidence

Severity: **Potential Risk**  
Category: **Data Protection & Recovery**

Evidence:
- Backup settings, WAL archive status, backup health notifications, and restore scripts exist.
- `docs/PRODUCTION_COVERAGE_GAP_MATRIX.md` still lists hybrid Tauri host restore rehearsal and production/RC probe signoff as follow-up items.
- `docs/RELEASE_VERIFICATION_LEDGER.md` identifies backup/restore proof as an external blocker for release evidence in prior verification.

Recommended fix:
- Run a non-production restore drill from a current encrypted/off-site-style backup on the target host and attach evidence to release readiness.
- Run `scripts/production_audit_probes.sql` against RC/production snapshots after inventory reconciliation.

Files involved:
- `server/src/logic/backups.rs`
- `server/src/launcher.rs`
- `migrations/035_backup_resilience_settings.sql`
- `migrations/039_wal_archiving_configuration.sql`
- `scripts/production_audit_probes.sql`
- `docs/PRODUCTION_COVERAGE_GAP_MATRIX.md`

## 3. Data Integrity Scorecard

| Area | Score | Notes |
| --- | --- | --- |
| POS Transactions | Good | Transaction and E2E coverage for tender, split tender, register close, offline recovery, and idempotency-sensitive flows. |
| Inventory | Good | Ledgered adjustments, PO receiving, physical inventory safeguards, and movement audit are present. Production stock probes still required for live data. |
| Customers | Good | Customer merge is transaction-bound; follow-up risk remains ongoing dedupe/merge coverage. |
| Weddings | Good after fix | Destructive delete audit gap fixed. Money/member relationships have dedicated ledger/readiness paths. |
| Accounting/QBO | Good | Balanced staging validation, explicit mappings, approval flow, retry/revert/void lifecycle, and failure notifications are present. |
| Imports/Sync | Good | Counterpoint quarantine, exception tracking, staging batches, and proof gates are present. |
| Audit Trails | Good after fix | Financial, inventory, notification, and wedding activity logs exist; destructive wedding deletes now require activity rows. |
| Database Design | Good | FK/index baseline is substantial. Some historical `ON DELETE SET NULL` choices are intentional for preserving records while avoiding orphan blockers. |
| Security/Authorization | Good | Staff/permission middleware is consistently used on reviewed critical APIs. |
| Recovery/Protection | Fair-Good | Backup/WAL/health systems exist, but host restore drill and production probe evidence remain operational requirements. |

## 4. Implementation Plan

Phase 1: Release-blocking integrity issues
- Fixed: wedding destructive actions now require durable activity rows in the same transaction.
- Continue to block release only on newly proven P0/P1 regressions or failed release E2E/pre-retag gates.

Phase 2: Financial and accounting correctness
- Maintain duplicate-submit and provider-replay coverage for checkout, Helcim, refunds, and QBO retry/void paths.
- Keep QBO staging strict: no fallback mappings and no approval while classifications are unresolved.

Phase 3: Inventory and customer integrity
- Run production/RC stock probes and reconcile any unexplained negative available-stock rows.
- Add focused tests only when a concrete stock drift or merge-history gap is proven.

Phase 4: Auditability and recovery improvements
- Add future targeted tests for wedding delete audit enforcement.
- Complete host restore drill with encrypted/off-site-style backup settings and attach evidence.

Phase 5: Security hardening
- Continue API exposure reviews for new endpoints.
- Preserve server-side permission checks; avoid client-only authorization assumptions.

## 5. Validation Plan

Targeted validation completed in this change:
- `cargo fmt`
- `cargo check`

Recommended next validation before release or after further fixes:
- `npm run check:help-impact -- --help-not-needed` for this audit-only/manual-neutral change, or full `npm run check:help-impact` if Help manuals are edited.
- Targeted Playwright wedding readiness and wedding manager flows if UI behavior changes.
- `npm run test:e2e:release` before release tagging.
- `npm run release:retag -- v0.90.0` only after E2E is green for the exact release commit.
- `scripts/production_audit_probes.sql` against RC/restored production snapshots.
- Non-production backup restore drill from the current backup path and encryption/off-site configuration.

