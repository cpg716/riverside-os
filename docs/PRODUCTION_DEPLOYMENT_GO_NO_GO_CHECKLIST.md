# Production Deployment Go/No-Go Checklist

Target: Hybrid Tauri Host retail deployment.

## Current Deployment Status (2026-05-23)

- [x] Target release version is **`v0.80.6`**.
- [ ] Current release tag exists: **`v0.80.6`**.
- [ ] Current release has Windows installer/updater assets published.
  - Required action: tag/publish `v0.80.6`, then run the Windows updater release workflow and Windows deployment package workflow before installing Windows stations.
  - Required artifacts: `latest.json`, `riverside-updater-build-manifest.json`, Windows MSI, matching `.sig`, and `RiversideOS-v0.80.6-Windows-Deployment.zip`.
- [ ] Current release has macOS Deployment Manager DMG published.
  - Required artifact: `RiversideOS-Deployment-Manager_0.80.6_universal.dmg`.
- [ ] Latest Playwright E2E push on `main` passed for the final `v0.80.6` release commit.
- [ ] Latest Lint Checks push on `main` passed for the final `v0.80.6` release commit.
- [ ] Production station deployment log is complete for:
  - Main Hub (Backoffice / Server PC)
  - Register #1 Windows Tauri
  - Register #2 iPad PWA
  - Other Windows laptop PWA / optional Tauri clients

## v0.80.6 Catastrophic Failure Prevention Fixes

All six remediation items from the 2026-05-25 audit were applied to `main` and verified:

- [x] **Helcim card-token transaction safety** (`server/src/api/payments.rs`) — success-path UPDATE now executes inside the register-session lock transaction and commits atomically.
- [x] **QBO duplicate-journal prevention** (`server/src/jobs/qbo_sync.rs`) — `syncing` state lock added before POST to QuickBooks; failed posts transition to `failed`, never back to `approved`.
- [x] **RMS double-reversal guard** (`server/src/api/pos.rs`) — `reverse_rms_record_manual` rejects requests when `resolution_status` is already `refunded` or `reversed`.
- [x] **Offline queue flush timeout** (`client/src/lib/offlineQueue.ts`) — `AbortController` with 15-second timeout prevents half-open TCP hangs during replay.
- [x] **RMS reversal permission tightened** (`server/src/api/pos.rs`) — both RMS reversal endpoints now require `customers.rms_charge.reverse` explicitly.
- [x] **Backorder failure notification** (`server/src/api/purchase_orders.rs`) — `notify_backorder_failure` emits an app notification to procurement staff when automatic backorder creation fails after PO receipt.

Verification run on 2026-05-25: `cargo check`, `cargo clippy`, `cargo fmt`, `npm --prefix client run typecheck`, `npm --prefix client run lint`, and `npm run check:server` all passed.

## v0.80.6 Release Readiness Blockers

- [ ] `v0.80.6` Windows updater assets exist: `latest.json`, `riverside-updater-build-manifest.json`, MSI, and `.sig`.
- [ ] `v0.80.6` Windows deployment package exists and its manifest source SHA matches the release tag.
- [ ] `v0.80.6` macOS Deployment Manager DMG exists.
- [ ] Physical station smoke is complete for Main Hub, Register #1 Windows Tauri, Register #2 iPad PWA, and other Windows laptop PWA devices.
- [ ] GitHub checks have rerun and passed on the final release commit.

## Code Gate

- [ ] v0.80.6 automated certification evidence is recorded in [`docs/releases/v0.80.6-certification.md`](releases/v0.80.6-certification.md).
- [x] No unresolved AI-actionable code-level P0/P1 findings remain in `docs/reviews/PRODUCTION_HARDENING_AUDIT_2026.md`; human/environment verification gates below remain required.
- [x] `cargo fmt --manifest-path server/Cargo.toml --check` — passed locally for v0.4.0 readiness on 2026-05-01.
- [x] `cargo clippy --manifest-path server/Cargo.toml -- -D warnings` — passed locally for v0.4.0 readiness on 2026-05-01 after the Meilisearch helper refactor.
- [x] `cargo check --manifest-path server/Cargo.toml` — passed locally for v0.4.0 readiness on 2026-05-01.
- [x] `cargo fmt --check --manifest-path server/Cargo.toml` — passed locally on 2026-04-25.
- [x] `npm run check:version` — passed locally on 2026-05-17; `Riverside version parity OK: 0.60.0`.
- [x] `git diff --check` — passed locally on 2026-05-17.
- [x] `cargo fmt --manifest-path server/Cargo.toml` — passed locally on 2026-05-17.
- [x] `npm run check:server` — passed locally on 2026-05-17.
- [x] `npm --prefix client run lint` — passed locally on 2026-05-17.
- [x] `npm --prefix client run typecheck` — passed locally on 2026-05-17.
- [x] `npm --prefix client run build` — passed locally on 2026-05-17.
- [x] `npm run test:e2e:release` — passed locally on 2026-05-17; suite reported 337 passed, 12 skipped, 0 failed.
- [x] Help/ROSIE drift verification — `scripts/verify-ai-knowledge-drift.sh` passed locally on 2026-05-17.
- [x] Help manifest refresh — `npm run generate:help:refresh -- --skip-screenshots` passed locally on 2026-05-17.
- [x] Skipped-lane certification: `E2E_API_BASE=http://127.0.0.1:43300 E2E_DATABASE_URL=postgresql://postgres:password@localhost:5433/riverside_os_e2e DATABASE_URL=postgresql://postgres:password@localhost:5433/riverside_os_e2e RIVERSIDE_DB_NAME=riverside_os_e2e E2E_RUN_VISUAL=1 npm --prefix client run test:e2e -- e2e/backoffice-signin.spec.ts e2e/high-risk-regressions.spec.ts e2e/intelligence-and-finance.spec.ts e2e/payments-operations-contract.spec.ts e2e/payments-operations-ui.spec.ts e2e/podium-settings.spec.ts e2e/register-close-reconciliation.spec.ts e2e/staff-tasks.spec.ts e2e/visual-baselines.spec.ts --workers=1` — passed locally on 2026-05-14; suite reported 31 passed, 0 skipped, 0 failed.
- [x] Non-admin/RBAC skip cleanup: `npm --prefix client run test:e2e -- e2e/api-gates.spec.ts e2e/high-risk-regressions.spec.ts e2e/phase2-finance-and-help-lifecycle.spec.ts e2e/rms-permissions.spec.ts --workers=1` reported 33 passed, 0 skipped on 2026-04-25.
- [x] `npm run test:e2e:high-risk` — passed locally on 2026-04-25; suite reported 4 passed, 2 built-in skips.
- [x] `npm run test:e2e:phase2` — passed locally on 2026-04-25; suite reported 3 passed, 2 built-in skips.
- [x] `npm run test:e2e:tender` — passed locally on 2026-04-25; suite reported 11 passed.
- [x] Checkout tender financial contract: `client/e2e/checkout-tender-financial-contract.spec.ts` covers missing check number rejection, split allocation across current sale + existing transaction balance, and cash rounding QBO impact.
- [x] Formerly quarantined POS UI specs run locally without `ROS_QUARANTINE_UNSTABLE_POS_E2E`; targeted subset reported 6 passed on 2026-04-25.
- [x] QBO hardening unit slice: `cargo test --manifest-path server/Cargo.toml qbo::tests:: --lib` reported 6 passed on 2026-04-25.
- [x] Backup path safety unit slice: `cargo test --manifest-path server/Cargo.toml backups::tests:: --lib` reported 2 passed on 2026-04-25.
- [x] Tax audit contract: `npm --prefix client run test:e2e -- e2e/tax-audit-contract.spec.ts --workers=1` passed locally on 2026-04-25.
- [x] Commission audit contract: `npm --prefix client run test:e2e -- e2e/commission-audit-contract.spec.ts --workers=1` passed locally on 2026-04-25.
- [x] QBO audit contract: `npm --prefix client run test:e2e -- e2e/qbo-audit-contract.spec.ts --workers=1` passed locally on 2026-04-25 and covers store-local business-date cutoff near midnight UTC.
- [x] Inventory audit contract: `npm --prefix client run test:e2e -- e2e/inventory-audit-contract.spec.ts --workers=1` passed locally on 2026-04-25.
- [x] Register audit contract: `npm --prefix client run test:e2e -- e2e/register-audit-contract.spec.ts --workers=1` passed locally on 2026-04-25 and covers parked-sale purge/audit rows during Z-close.
- [x] Offline recovery contract: `npm --prefix client run test:e2e -- e2e/offline-recovery-contract.spec.ts --workers=1` passed locally on 2026-04-25 and covers 4xx queue retention plus register close blocking with pending/blocked queue rows.
- [x] Combined #2-#4 audit contracts: `npm --prefix client run test:e2e -- e2e/offline-recovery-contract.spec.ts e2e/qbo-audit-contract.spec.ts e2e/register-audit-contract.spec.ts --workers=1` reported 6 passed on 2026-04-25.
- [x] Restore preflight unit slice: `cargo test --manifest-path server/Cargo.toml api::settings::tests:: --lib` reported 4 passed on 2026-04-25.
- [ ] `scripts/production_audit_probes.sql` runs read-only against the release database and all P0/P1 probes are explained or zero-row.
  - Local dev evidence captured at `docs/reviews/evidence/production_audit_probes_local_2026-04-25.txt`.
  - Local probe result: money allocation, checkout idempotency, tax exemption, commission timing, QBO, parked-sale close, and backup probes returned zero rows.
  - Local probe blocker: negative available stock returned 51 physical inventory rows after excluding explicit POS service/meta SKUs. RC/production inventory must be reconciled to zero unexplained rows, or ownership/accounting must explicitly sign a written waiver before go-live.

## Hybrid Host Gate

- [ ] Production host boots the Tauri app and embedded engine together.
- [ ] `DATABASE_URL` points to the intended production PostgreSQL.
- [ ] `RIVERSIDE_STRICT_PRODUCTION=true` where browser/PWA access is enabled.
- [ ] `RIVERSIDE_CORS_ORIGINS`, `FRONTEND_DIST`, and storefront JWT secret are configured where applicable.
- [ ] `RIVERSIDE_CREDENTIALS_KEY` is configured and non-default before saving Backoffice integration credentials, including QBO.
- [ ] `RIVERSIDE_BACKUP_DIR` is set to an absolute durable path, writable, and visible to operators in Settings and ROS Dev Center.

## Register Drill

- [ ] Open Register #1.
- [ ] Attach Register #2 and Register #3.
- [ ] Complete cash, check, card, gift card, loyalty, RMS, and split-tender sale drills.
- [ ] Verify check tender requires check number.
- [ ] Complete cash rounding sale and verify reporting/QBO staging.
- [ ] Close exact-cash Z report.
- [ ] Close cash-discrepancy Z report and verify notes + notification.
- [ ] Confirm register close is blocked while checkout queue has pending or blocked entries.

## Inventory Drill

- [ ] Takeaway sale decrements `stock_on_hand`.
- [ ] Special/custom/wedding checkout does not decrement `stock_on_hand`.
- [ ] PO receipt increments stock exactly once.
- [ ] Duplicate receipt retry is idempotent.
- [ ] Pickup decrements stock/reserved/on-layaway as appropriate.
- [ ] Return with restock updates stock, refund queue, receipt, reports, and QBO staging.
- [ ] Physical inventory publish produces an auditable adjustment.

## Accounting Drill

- [ ] QBO mappings are complete for tenders, revenue, COGS, inventory, tax, deposits, gift cards, loyalty, shipping, RMS, merchant fees, and rounding.
- [ ] Proposed journal is balanced before approval.
- [ ] Unbalanced journal cannot approve or sync.
- [ ] Failed QBO sync records a failed log and notification.
- [ ] Successful QBO sync records journal entry id and staff audit event.
- [ ] Accounting signs off the configured store-local business-date policy and QBO company timezone alignment.

## Backup and Recovery Drill

- [ ] Manual backup succeeds.
- [ ] Manual backup lands in the configured `RIVERSIDE_BACKUP_DIR`.
- [ ] Cloud sync succeeds when enabled.
- [x] Local restore drill succeeds into a non-production database.
  - Evidence: `docs/reviews/evidence/restore_drill_local_2026-04-25.txt`.
  - Source backup: `server/backups/backup_20260425_020000.dump`.
  - Target database: `riverside_restore_drill_20260425`.
- [x] Restored database boots API.
  - Evidence: temporary API on `127.0.0.1:43310` returned `GET /api/staff/list-for-pos` JSON array length 61.
  - Client/hardware restore rehearsal on the Hybrid Tauri host remains required before go-live.
- [x] Migration ledger exists after restore.
  - Evidence: restored database contains `ros_schema_migrations`.
  - Full active-baseline ledger reconciliation and schema-contract validation remain required during production release cut.
- [ ] Search index rebuild path is verified after restore.
- [x] Restore preflight rejects open/reconciling register sessions in unit coverage.
- [ ] Restore is blocked while registers are open on the Hybrid Tauri host during the live recovery rehearsal.

## Final Decision

- [ ] Owner signoff.
- [ ] Accounting signoff.
- [ ] Store operations signoff.
- [ ] Hardware signoff.
- [ ] Backup/restore signoff.

Deployment decision: **GO only if every item above is complete or explicitly waived in writing by ownership.**
