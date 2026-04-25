# Riverside OS Production Hardening Audit

**Date:** 2026-04-25  
**Target topology:** Hybrid Tauri Host  
**Version audited:** 0.3.0  
**Branch audited:** `main`  
**Audit endpoint:** Audit + Fix Plan

## Executive Decision

**Status: NOT READY FOR UNCONDITIONAL RETAIL DEPLOYMENT.**

The core financial architecture is strong: checkout uses a database transaction, `checkout_client_id` idempotency exists, server-side tax validation recalculates line taxes, stock decrement is fulfillment-aware, QBO staging is review-first, and commission finalization blocks silent attribution rewrites.

The code-level P1 findings identified in this audit have remediation work and targeted verification attached. Deployment should still remain blocked until the broader release gates, production/RC SQL probes, Hybrid Tauri host drills, QBO/accounting signoff, and backup/restore rehearsal are complete.

## Verification Performed

Passed during this audit:

- `cargo fmt --check --manifest-path server/Cargo.toml`
- `npm run check:server`
- `npm run lint`
- `npm --prefix client run build`
- `npm run test:e2e:release` (181 passed, 7 skipped, 0 failed after audit-contract additions, RMS helper/isolation fix, offline recovery coverage, QBO business-date coverage, parked-sale close coverage, physical-inventory read/snapshot fixes, deterministic non-admin RBAC seed/auth coverage, and checkout tender financial contract coverage)
- `npm --prefix client run test:e2e -- e2e/api-gates.spec.ts e2e/high-risk-regressions.spec.ts e2e/phase2-finance-and-help-lifecycle.spec.ts e2e/rms-permissions.spec.ts --workers=1` (33 passed, 0 skipped)
- `npm run test:e2e:tender` (11 passed, 0 skipped)
- `npm --prefix client run test:e2e -- e2e/tax-audit-contract.spec.ts --workers=1`
- `npm --prefix client run test:e2e -- e2e/commission-audit-contract.spec.ts --workers=1`
- `npm --prefix client run test:e2e -- e2e/qbo-audit-contract.spec.ts --workers=1`
- `npm --prefix client run test:e2e -- e2e/inventory-audit-contract.spec.ts --workers=1`
- `npm --prefix client run test:e2e -- e2e/register-audit-contract.spec.ts --workers=1`
- `npm --prefix client run test:e2e -- e2e/offline-recovery-contract.spec.ts e2e/qbo-audit-contract.spec.ts e2e/register-audit-contract.spec.ts --workers=1` (6 passed)
- `cargo test --manifest-path server/Cargo.toml api::settings::tests:: --lib`
- `cargo test --manifest-path server/Cargo.toml logic::backups::tests:: --lib`

Still outside AI-only verification:

- Hybrid Tauri host backup restore rehearsal. Must be run against a non-production database before go-live.
- Hardware station drill. Must be run on the production register host and peripherals.

Migration evidence:

- Latest migration file observed: `163_dashboard_read_path_indexes.sql`.
- Duplicate numeric prefixes exist and must continue to be compared by full filename: `148`, `155`, `156`, `157`.
- `scripts/migration-status-docker.sh` compares full filenames against `ros_schema_migrations`, which is the correct approach for this repo.

## Findings

### P1-001: Offline checkout replay can silently discard completed sales

**Status:** Remediated and covered by deterministic browser-storage E2E for 4xx retention plus register-close blocking. A future client unit harness can still add narrower success-dequeue coverage.

**Evidence:** `client/src/lib/offlineQueue.ts:91-101`

Queued checkouts previously were removed from local storage on any HTTP 4xx response during replay. A completed offline sale could therefore disappear from the recovery queue if replay received a transient auth/session/client-validation failure after connectivity returned.

**Business impact:** Financial and inventory truth can be lost after an outage. This violates recoverability expectations for live register operation.

**Recommended fix:** Implemented. The queue now retains 4xx failures as blocked recovery rows and register close is blocked while pending/blocked checkout recovery exists.

### P1-002: QBO sync does not block unbalanced staged journals

**Status:** Remediated and covered by QBO hardening unit tests plus QBO audit contract coverage.

**Evidence:** `server/src/logic/qbo_journal.rs:1430-1449`, `server/src/api/qbo.rs:1108-1123`, `server/src/api/qbo.rs:1338-1432`

The journal builder records `totals.balanced`, but approval and sync only check workflow status. A manager can approve and attempt to sync a proposal whose own payload says it is unbalanced.

**Business impact:** Accounting can post or attempt to post an invalid journal. Even if QBO rejects it, ROS records a failed sync after the operator has already approved a bad accounting proposal.

**Recommended fix:** Block approval and sync when `payload.totals.balanced !== true`, or require an explicit privileged accounting override with immutable reason and a separate warning state. For go-live, use the strict block.

### P1-003: QBO token storage uses reversible XOR with a default key

**Status:** Remediated for strict production / activation guard and new authenticated `v2:` token writes. Operational key-rotation drill remains a deployment gate.

**Evidence:** `server/src/api/qbo.rs:297-323`

QBO token encryption falls back to `riverside-dev-token-key-change-me` and uses XOR over a SHA-256-derived key. `RIVERSIDE_STRICT_PRODUCTION` does not appear to require `QBO_TOKEN_ENC_KEY`.

**Business impact:** A production database dump can expose QBO OAuth tokens if the host uses the default key. This is a high-risk financial integration secret.

**Recommended fix:** In strict production, refuse startup or QBO activation unless `QBO_TOKEN_ENC_KEY` is present, long, and non-default. Replace XOR with authenticated encryption or delegate token storage to OS/keychain-backed secret storage for the Hybrid Host.

### P1-004: Register reconciliation can fall back to hardcoded staff code `1234`

**Status:** Remediated in code; broader register audit contract coverage now covers linked-lane lifecycle, close rules, and closed-token rejection. Missing-Staff-Access UI automation remains a lower-level coverage follow-up.

**Evidence:** `client/src/components/pos/CloseRegisterModal.tsx:146-149`

When `staffCode` is unavailable or not four digits, the close modal sends `1234` to `begin-reconcile`. Migration probes also recognize seeded `1234` as an admin test account.

**Business impact:** A production station could transition a till group into reconciling using a fallback identity rather than the authenticated staff member. This weakens auditability around end-of-day handling.

**Recommended fix:** Remove the fallback. If the authenticated staff code is unavailable, block reconciliation start and require re-authentication through the unified sign-in/PIN flow.

### P1-005: Restore endpoint lacks server-side operational lockout

**Status:** Remediated and covered by restore preflight unit tests. Hybrid Tauri host restore rehearsal remains a deployment gate.

**Evidence:** `server/src/api/settings.rs:409-420`, `server/src/logic/backups.rs:172-190`

Restore is admin-gated and documented as destructive, but the server does not enforce that all registers are closed, offline queues are clear, background workers are paused, or the restore target is non-production.

**Business impact:** An authorized admin could restore over active retail state while registers are open or while pending checkout recovery exists.

**Recommended fix:** Add server-side restore preflight checks: no open `register_sessions`, no reconciling sessions, no active checkout/write jobs, explicit environment target, and a fresh pre-restore backup. For Hybrid Host, require app restart guidance after restore.

### P2-001: Backup path is process-working-directory relative

**Status:** Remediated with explicit `RIVERSIDE_BACKUP_DIR` strict-production validation and operator-facing diagnostics.

**Evidence:** `server/src/logic/backups.rs:47-57`

Backups write to `PathBuf::from("backups")`. In a packaged Hybrid Tauri Host, process working directory can vary by launch method.

**Business impact:** Operators may believe backups are in one place while the host writes them elsewhere.

**Recommended fix:** Add explicit `RIVERSIDE_BACKUP_DIR`, surface it in Settings/ROS Dev Center, and refuse strict production backup scheduling if the directory is unset or unwritable.

### P2-002: Post-close parked sale purge is outside the register close transaction

**Status:** Remediated and covered by `client/e2e/register-audit-contract.spec.ts`, which asserts Z-close purges server-backed parked sales and writes `purge_on_close` audit rows.

**Evidence:** `server/src/api/sessions.rs:1574-1611`, `server/src/api/sessions.rs:1663-1674`

Register close commits before purging open parked sales. If purge fails, close succeeds and only logs the failure.

**Business impact:** Stale parked carts can survive Z-close and confuse the next shift.

**Recommended fix:** Implemented by moving parked-sale purge into the close transaction and recording per-sale audit rows.

### P2-003: POS UI release coverage was quarantined

**Evidence:** `docs/E2E_REGRESSION_MATRIX.md`, `docs/POS_E2E_TESTABILITY_FOLLOWUP.md`, `client/e2e/helpers/openPosRegister.ts`

The POS golden path, tender UI smoke, tax-exempt checkout UI, and one exchange UI-open test were quarantined in CI because helpers inferred readiness from transient POS shell and cashier-overlay state.

**Business impact:** Register UI regressions can ship while API contracts remain green.

**Status:** Implemented. POS shell/register/cart/cashier overlay now expose explicit readiness contracts, and CI no longer sets the quarantine flag. These specs are release gates again.

### P2-004: QBO recognition uses UTC date in staging

**Status:** Remediated and covered by `client/e2e/qbo-audit-contract.spec.ts`. QBO proposal and drilldown date cuts now use store-local business date via `reporting.effective_store_timezone()`, proposal payloads include `business_timezone`, and near-midnight UTC activity is asserted against the intended store business date.

**Evidence:** `server/src/logic/qbo_journal.rs` and QBO drilldown queries now use the configured store timezone for business-date windows; `docs/QBO_JOURNAL_TEST_MATRIX.md` documents the store-local policy.

**Business impact:** Late-day retail activity can land on a different accounting date than the store-local close day.

**Recommended fix:** Implemented store-local business-date staging. Accounting still needs to sign off that the configured store timezone matches the intended QBO close policy before go-live.

## Strong Controls Observed

- Checkout begins a DB transaction before session validation and financial writes.
- Duplicate `checkout_client_id` is handled before insert and at unique-index race time.
- `payment_tx_id` naming avoids the historic transaction/payment ID shadowing bug.
- Server recalculates and validates line tax instead of trusting display totals.
- Takeaway stock decrements at checkout; special/custom/wedding stock waits for fulfillment.
- Commission payout finalization blocks silent salesperson rewrites.
- QBO proposal warnings and balanced totals are generated.
- Register close requires notes when cash discrepancy exceeds `$5`.
- Migration reconciliation compares full filenames, which handles duplicate numeric prefixes.

## Probe Evidence

- Local read-only probe output: `docs/reviews/evidence/production_audit_probes_local_2026-04-25.txt`.
- Local restore drill output: `docs/reviews/evidence/restore_drill_local_2026-04-25.txt`.
- Zero-row local probes: duplicate checkout client IDs, missing payment allocation references, over-allocated payments, stale reconciling sessions, parked sales on closed sessions, premature order-style stock decrement, tax-exempt missing reason, finalized commission without fulfillment, unbalanced QBO staging, missing QBO business timezone, and stale backup health.
- Local blocker signal: negative available stock returned 51 physical inventory rows after excluding explicit POS service/meta SKUs. This local data set is not production evidence, but the same probe must return zero unexplained rows on the RC/restored/production database before retail go-live.
- Local restore result: latest local dump restored into a separate database, migration ledgers were present, and the API booted against the restored database. Hybrid Tauri host restore rehearsal remains required before production go-live.

## Go-Live Position

Riverside OS has the right architecture for a production POS, and the audit remediation pass has closed the identified code-level P1 findings with targeted verification. Do not deploy for unattended retail use until the remaining release gates, production/RC probe run, Hybrid Tauri host drills, accounting/QBO signoff, hardware signoff, and backup/restore signoff are complete.
