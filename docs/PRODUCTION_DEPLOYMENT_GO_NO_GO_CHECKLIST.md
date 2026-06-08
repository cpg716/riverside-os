# Production Deployment Go/No-Go Checklist

Target: Hybrid Tauri Host retail deployment.

### Current Deployment Status (2026-06-05)

- [x] Target source release version is **`v0.90.0`** across root, client, server, Tauri, standalone apps, ROS Dev Center, and Windows deployment metadata.
- [x] Source-side QBO fallback mapping has been removed; exportable financial activity must resolve to an explicit Chart of Accounts mapping before posting.
- [x] Source-side local review evidence is recorded in [`docs/reviews/legacy/2026-06/PRE_GO_LIVE_LOCAL_REVIEW_2026_06_05.md`](reviews/legacy/2026-06/PRE_GO_LIVE_LOCAL_REVIEW_2026_06_05.md).
- [x] v0.90.0 release notes and certification evidence are recorded in [`docs/releases/v0.90.0-release-notes.md`](releases/v0.90.0-release-notes.md) and [`docs/releases/v0.90.0-certification.md`](releases/v0.90.0-certification.md).
- [x] GitHub release **`v0.90.0`** is published as Latest.
- [x] Release workflows published fresh v0.90.0 Windows updater, Windows deployment package, Counterpoint Bridge GUI, Server Manager, Deployment Manager, and macOS ROS Dev Center assets.
- [x] Local Lint/Clippy/Cargo checks pass for the v0.90.0 release source tree.
- [x] Financial, register, Counterpoint, Help/ROSIE, backup/restore, and reporting launch-critical local suites passed on 2026-06-05.
- [ ] Production station deployment log is complete for Main Hub, Register #1 Windows Tauri, Register #2 iPad PWA, and other Windows laptop PWA / optional Tauri clients.

## v0.90.0 Release Scope & Resiliency Hardening

v0.90.0 preserves the v0.85.x GO LIVE readiness baseline and adds the source-side release hardening required before publishing a fresh latest release:

- [x] **QBO Explicit Mapping Enforcement** — journal staging and workspace UI no longer route missing mappings through generic fallback accounts.
- [x] **QBO Inventory Adjustment Key Alignment** — the mapping key is now `REVENUE_INVENTORY_ADJUSTMENT`, keeping inventory adjustment exports explicit and mappable.
- [x] **Pre-Go-Live Local Review Fixes** — locally verifiable QBO, Counterpoint, backup/restore, Helcim, Podium, Shippo, and release/update code paths were reviewed and targeted issues were fixed where possible.
- [x] **Helcim Test Isolation** — unit tests serialize credential-environment mutation so local and CI cargo runs do not fail nondeterministically.
- [x] **Shippo Health Test Coverage** — disabled, missing-token, and healthy credential states are covered without requiring live label purchases.
- [x] **Help and Manual Refresh** — active Help Center source manuals and release docs are updated to v0.90.0 current-release guidance.

## v0.90.0 Release Readiness Gates

- [x] `v0.90.0` GitHub release exists and is marked Latest.
- [x] `v0.90.0` Windows updater assets exist: `latest.json`, `riverside-updater-build-manifest.json`, MSI, and `.sig`.
- [x] `v0.90.0` Windows deployment package exists: `RiversideOS-v0.90.0-1e630a1-Windows-Deployment.zip`.
- [x] `v0.90.0` standalone app assets exist for Deployment Manager, Server Manager, Counterpoint Bridge GUI, and ROS Dev Center where applicable.
- [ ] Physical station smoke is complete for Main Hub, Register #1 Windows Tauri, Register #2 iPad PWA, and other Windows laptop PWA devices.
- [ ] Real external credential workflows have been tested where required for go-live: QBO sandbox/production, Helcim, Podium, Shippo, and Counterpoint SQL.

## Code Gate

- [x] v0.90.0 source validation list is defined in [`docs/releases/v0.90.0-certification.md`](releases/v0.90.0-certification.md).
- [x] v0.90.0 local validation commands pass before tagging: `git diff --check`, help manifest generation, version parity, client lint/typecheck, Rust fmt, cargo check, cargo clippy, standalone Tauri cargo checks, and targeted release-critical Rust tests.
- [ ] Latest GitHub Actions checks pass on the final v0.90.0 follow-up commit; original release commit Lint passed, original Playwright failed on stale Orders E2E assertions now fixed locally.
- [ ] `scripts/production_audit_probes.sql` runs read-only against the release database and all P0/P1 probes are explained or zero-row.

## In-App Update System (v0.80.9+)

- [x] Release workflows run `scripts/verify-updater-release-assets.mjs` after uploading updater assets for POS, Deployment Manager, Server Manager, Counterpoint Bridge GUI, and ROS Dev Center.
- [x] Updater release proof checks require `+build` metadata, `build_sha`, non-empty signatures, referenced release artifacts, and matching `.sig` assets.
- [x] Manual update recovery path is documented in `docs/DEPLOYMENT_MANAGER.md`.
- [ ] Daily update check background worker is running (verify via `GET /api/ops/update-check` returning valid JSON after server start).
- [ ] `update_available` notification is delivered to at least one `settings.admin` staff member when a newer GitHub release exists.
- [ ] **Settings → Updates → Server update** on the Main Hub shows the correct current and latest version.
- [ ] Safe-window hint correctly reflects local time (before 10 AM / after 6 PM = safe; during store hours = warning).
- [ ] Server update button triggers the guided PowerShell flow: download → extract → install → restart task → readiness poll.
- [ ] After server update, the `"Riverside OS Server"` scheduled task restarts automatically and `/api/health` returns 200 within 60 s.
- [ ] Satellite station (Register #1 or Back Office laptop) shows the **"Update Required"** version gate screen — not the PIN screen — when client version is behind the server.
- [ ] Windows Tauri satellite: **"Update to vX.X.X"** button installs the signed MSI via the Tauri updater and relaunches correctly.
- [ ] PWA satellite: hard reload serves updated web files after Main Hub update; version gate clears.
- [ ] Staff cannot sign in on any station until client version matches server version.
- [ ] Physical update rehearsal is complete on Main Hub, Windows Register, Back Office workstation, and PWA/iPad station using the documented pre-go-live rehearsal.

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
- [ ] Complete odd-cent cash sale with rounding off and verify exact-cent checkout, receipt, reporting, and QBO staging.
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

- [ ] QBO mappings are complete for tenders, revenue, COGS, inventory, tax, deposits, gift cards, loyalty, shipping, RMS, and merchant fees. Cash rounding mapping is required only when pennyless rounding is explicitly enabled.
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
  - Evidence: `docs/reviews/evidence/restore_drill_local_2026-06-05.txt`.
  - Source database: `riverside_os_e2e`.
  - Target database: `riverside_restore_drill_20260605_115624`.
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
