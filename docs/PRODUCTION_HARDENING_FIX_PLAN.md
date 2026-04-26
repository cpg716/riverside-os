# Production Hardening Fix Plan

This plan resolves the audit findings in `docs/reviews/PRODUCTION_HARDENING_AUDIT_2026.md`.

## Batch 1: Release Blockers

1. **Offline checkout recovery**
   - Status: implemented in `client/src/lib/offlineQueue.ts`, `GlobalTopBar`, and `CloseRegisterModal`.
   - Change `offlineQueue` so 4xx replay responses mark items as `blocked` instead of deleting them.
   - Show blocked queue details in the top bar/register surface with response status and operator action.
   - Block register close while pending or blocked checkout queue items exist.
   - Verification: `client/e2e/offline-recovery-contract.spec.ts` covers 4xx queue retention and register-close blocking; `npm --prefix client run test:e2e -- e2e/offline-recovery-contract.spec.ts e2e/qbo-audit-contract.spec.ts e2e/register-audit-contract.spec.ts --workers=1` reported 6 passed on 2026-04-25.

2. **QBO balanced-journal enforcement**
   - Status: implemented in `server/src/api/qbo.rs`.
   - Reject `approve_staging` and `sync_staging` when `payload.totals.balanced !== true`.
   - Recompute the actual postable QBO journal lines so missing account mappings cannot create an unbalanced sync payload.
   - Return an operator-safe error explaining the debit/credit difference.
   - Tests: `cargo test --manifest-path server/Cargo.toml qbo::tests:: --lib` passed locally on 2026-04-25; 6 passed.

3. **QBO token hardening**
   - Status: implemented in `server/src/api/qbo.rs` and `server/src/launcher.rs`.
   - Require non-default `QBO_TOKEN_ENC_KEY` when `RIVERSIDE_STRICT_PRODUCTION=true` or when QBO credentials are activated.
   - Replace new token writes with authenticated `v2:` AEAD wrapping while keeping legacy decrypt compatibility for existing rows when the configured key is correct.
   - Tests: `cargo test --manifest-path server/Cargo.toml qbo::tests:: --lib` passed locally on 2026-04-25; 6 passed.

4. **Register reconciliation identity**
   - Status: implemented in `client/src/components/pos/CloseRegisterModal.tsx`.
   - Remove `1234` fallback from `CloseRegisterModal`.
   - If staff identity is unavailable, prompt re-authentication instead of calling `begin-reconcile`.
   - Verification: `npm run lint`, `npm --prefix client run build`, and `git diff --check`.
   - Coverage follow-up: add automated UI coverage for missing Staff Access once the POS close modal flow is practical to drive deterministically.

5. **Restore safety lockout**
   - Status: implemented in `server/src/api/settings.rs`, `server/src/logic/backups.rs`, and `SettingsWorkspace`.
   - Add server-side restore preflight: no open/reconciling registers, fresh pre-restore backup, explicit target confirmation, and no active production flag unless a guarded emergency path is used.
   - Constrain restore filenames to files listed by `BackupManager::list_backups`.
   - Strict production restore requires `RIVERSIDE_ALLOW_PRODUCTION_RESTORE=true`; normal restore drills should use a non-production database.
   - Tests: `cargo test --manifest-path server/Cargo.toml backups::tests:: --lib` passed locally on 2026-04-25; 2 passed.
   - Restore preflight tests: `cargo test --manifest-path server/Cargo.toml api::settings::tests:: --lib` passed locally on 2026-04-25; 4 passed.
   - Local drill: `server/backups/backup_20260425_020000.dump` restored into `riverside_restore_drill_20260425`; temporary API boot on `127.0.0.1:43310` returned staff list data. Evidence: `docs/reviews/evidence/restore_drill_local_2026-04-25.txt`.
   - Remaining deployment action: repeat the restore drill on the Hybrid Tauri host against a non-production database and attach operator signoff.

6. **Audit contract coverage for tax, commission, QBO, inventory, register, and recovery**
   - Status: implemented.
   - Tax: `client/e2e/tax-audit-contract.spec.ts` covers clothing threshold, discount crossing, stale client tax rejection, returns tax reversal, and QBO tax liability mapping.
   - Commission: `client/e2e/commission-audit-contract.spec.ts` covers fulfillment timing, specificity order, finalized payout immutability, and internal SPIFF receipt exclusion.
   - QBO: `client/e2e/qbo-audit-contract.spec.ts` covers balanced real-checkout proposal, mapped accounts, dedupe, staging list visibility, drilldown linkage, duplicate approval rejection, store-local business-date cutoff near midnight UTC, and shipped-order recognition from shipment events.
   - Inventory: `client/e2e/inventory-audit-contract.spec.ts` covers order-style no-decrement checkout, pickup decrement, duplicate PO receipt retry, and return/restock truth.
   - Physical inventory: fixed session/list reads to include `exclude_reserved` and `exclude_layaway`, and fixed full-scope snapshot parameter binding for reserved/layaway exclusions.
   - Register: `client/e2e/register-audit-contract.spec.ts` covers Register #1 linked lanes, duplicate-open block, satellite attach/close rules, reconciliation baseline, group close, closed-token rejection, post-close token reissue rejection, and parked-sale purge/audit rows during Z-close.
   - Recovery: `api::settings::tests::` and `logic::backups::tests::` cover restore preflight and backup catalog safety.

## Batch 2: Operational Hardening

- Make backup directory explicit with `RIVERSIDE_BACKUP_DIR`; surface it in Settings and ROS Dev Center.
  - Status: implemented in `server/src/logic/backups.rs`, `server/src/launcher.rs`, `server/src/api/settings.rs`, `ops_dev_center.rs`, and `SettingsWorkspace`.
  - Strict production startup now requires `RIVERSIDE_BACKUP_DIR` to be an absolute durable path.
  - Settings and ROS Dev Center runtime diagnostics show whether the host is using an explicit backup path or the local dev fallback.
- Move parked-sale cleanup into register close transaction or persist a blocking close-cleanup alert.
  - Status: implemented in `server/src/api/sessions.rs` and `server/src/logic/pos_parked_sales.rs`.
  - Z-close now purges server-backed parked sales inside the same database transaction as the register-session close.
  - Each purged parked sale receives a `pos_parked_sale_audit` row with `action = 'purge_on_close'`; register close staff-access metadata includes the purge count.
- Convert QBO staging date logic to store-local business date or document signed accounting acceptance for UTC.
  - Status: implemented in `server/src/logic/qbo_journal.rs` and QBO drilldown queries in `server/src/api/qbo.rs`.
  - QBO proposal windows now use `reporting.effective_store_timezone()` for fulfilled/recognized, booked, tender, return, inventory, forfeiture, and drilldown date cuts.
  - Revenue, COGS, tax, deposit-release, alteration, RMS pass-through, and drilldown attribution now share the reporting recognition basis: pickup/takeaway fulfillment timestamps plus shipped-order shipment events.
  - Proposal payloads include `business_timezone`, and QBO docs/staff SOPs now describe staging date as the store-local business date.
- Add a SQL audit probe pack for payment allocation, stock, commission, QBO, register, and backup invariants.
  - Status: implemented in `scripts/production_audit_probes.sql`.
  - Probes are read-only and cover checkout idempotency, payment allocations, stale register reconciliation, closed-register parked sales, negative available stock, premature order-style stock movement, tax-exempt reason gaps, commission finalization timing, QBO staging, and backup health.
  - Local evidence: `docs/reviews/evidence/production_audit_probes_local_2026-04-25.txt`.
  - Local result: all P0/P1 probes returned zero rows except negative available stock, which returned 51 physical inventory rows in the local dev database after excluding explicit POS service/meta SKUs. Treat any unexplained negative available stock in RC/production as a data-readiness blocker.

## Batch 3: Test Stabilization

- Remove the POS CI quarantine by stabilizing:
  - Status: implemented in `PosShell`, `Cart`, `PosSaleCashierSignInOverlay`, `openPosRegister.ts`, and `.github/workflows/playwright-e2e.yml`.
  - POS shell, register panel, cart shell, and cashier overlay now expose explicit readiness attributes for deterministic Playwright waits.
  - CI no longer sets `ROS_QUARANTINE_UNSTABLE_POS_E2E=1`; the POS UI subset is back in the release suite.
  - RMS Charge workspace E2E helper now uses the browser's same-origin `/api` proxy instead of forcing a cross-origin API override, and the resolved-exception assertion now queries the resolved queue explicitly so full-suite data volume cannot hide the row behind the default active-issue limit.
  - POS golden scan-to-checkout path.
  - Tender drawer UI.
  - Tax-exempt checkout UI.
  - Exchange wizard UI-open path.
- Add API-level fallback coverage where hardware/UI state remains difficult to make deterministic.
- Keep `--workers=1` for full release runs until POS shell isolation is proven stable.

## Required Verification

All of the following must pass after fixes:

- `cargo fmt --check --manifest-path server/Cargo.toml`
- `npm run check:server`
- `npm run lint`
- `npm --prefix client run build`
- `npm run test:e2e:release` — passed locally on 2026-04-25 after audit-contract additions, RMS helper/isolation fix, offline recovery coverage, QBO business-date coverage, parked-sale close coverage, physical-inventory read/snapshot fixes, deterministic non-admin RBAC seed/auth coverage, and checkout tender financial contract coverage; 181 passed, 7 skipped, 0 failed.
- `npm --prefix client run test:e2e -- e2e/api-gates.spec.ts e2e/high-risk-regressions.spec.ts e2e/phase2-finance-and-help-lifecycle.spec.ts e2e/rms-permissions.spec.ts --workers=1` — passed locally on 2026-04-25; 33 passed, 0 skipped.
- `npm run test:e2e:high-risk` — passed locally on 2026-04-25.
- `npm run test:e2e:phase2` — passed locally on 2026-04-25.
- `npm run test:e2e:tender` — passed locally on 2026-04-25; 11 passed, 0 skipped.
- Targeted audit contract tests:
  - `npm --prefix client run test:e2e -- e2e/tax-audit-contract.spec.ts --workers=1`
  - `npm --prefix client run test:e2e -- e2e/commission-audit-contract.spec.ts --workers=1`
  - `npm --prefix client run test:e2e -- e2e/qbo-audit-contract.spec.ts --workers=1`
  - `npm --prefix client run test:e2e -- e2e/inventory-audit-contract.spec.ts --workers=1`
  - `npm --prefix client run test:e2e -- e2e/register-audit-contract.spec.ts --workers=1`
  - `npm --prefix client run test:e2e -- e2e/offline-recovery-contract.spec.ts e2e/qbo-audit-contract.spec.ts e2e/register-audit-contract.spec.ts --workers=1` — passed locally on 2026-04-25; 6 passed.
  - `cargo test --manifest-path server/Cargo.toml api::settings::tests:: --lib`
  - `cargo test --manifest-path server/Cargo.toml logic::backups::tests:: --lib`

## Release Rule

No retail deployment while any P1 finding remains unresolved.
