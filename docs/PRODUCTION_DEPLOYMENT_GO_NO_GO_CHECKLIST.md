# Production Deployment Go/No-Go Checklist

Target: Hybrid Tauri Host retail deployment.

### Current Deployment Status (2026-07-23 publication snapshot)

- [x] Target source release version is **`v0.95.0`** across root, client, server, Tauri, standalone apps, ROS Dev Center, and Windows deployment metadata.
- [x] Source-side QBO fallback mapping has been removed; exportable financial activity must resolve to an explicit Chart of Accounts mapping before posting.
- [x] Source-side local review evidence is recorded in [`docs/reviews/legacy/2026-06/PRE_GO_LIVE_LOCAL_REVIEW_2026_06_05.md`](reviews/legacy/2026-06/PRE_GO_LIVE_LOCAL_REVIEW_2026_06_05.md).
- [x] v0.95.0 release notes and certification evidence are recorded in [`docs/releases/v0.95.0-release-notes.md`](releases/v0.95.0-release-notes.md) and [`docs/releases/v0.95.0-certification.md`](releases/v0.95.0-certification.md).
- [x] Before the replacement retag, GitHub release **`v0.95.0`** was published as Latest from superseded build `feb0db16`; that asset set remains historical evidence only.
- [x] The 2026-07-23 Register/search/reporting/runtime replacement is committed, retagged, promoted, published, and independently verified at `d9e68018f99f0778a21b0ffca1b57f287594561c`.
- [x] Non-E2E local release checks passed for the final replacement source tree on 2026-07-23. Local Playwright is intentionally skipped at operator direction.
- [x] Exact-commit GitHub Lint, all four blocking Playwright shards, aggregate Playwright, Windows, macOS, and verified-candidate promotion passed for `d9e68018`.
- [x] Financial, register, Counterpoint, Help/ROSIE, backup/restore, and reporting launch-critical local suites passed on 2026-06-05.
- [ ] Production station deployment log is complete for Main Hub, Register #1 Windows Tauri, Register #2 iPad PWA, and other Windows laptop PWA / optional Tauri clients.

## v0.95.0 Release Scope & Resiliency Hardening

v0.95.0 preserves the v0.85.x GO LIVE readiness baseline, incorporates the extensive v0.90.0 development-cycle hardening, and adds exact-SHA candidate promotion:

- [x] **QBO Explicit Mapping Enforcement** — journal staging and workspace UI no longer route missing mappings through generic fallback accounts.
- [x] **QBO Inventory Adjustment Key Alignment** — the mapping key is now `REVENUE_INVENTORY_ADJUSTMENT`, keeping inventory adjustment exports explicit and mappable.
- [x] **Pre-Go-Live Local Review Fixes** — locally verifiable QBO, Counterpoint, backup/restore, Helcim, Podium, Shippo, and release/update code paths were reviewed and targeted issues were fixed where possible.
- [x] **Helcim Test Isolation** — unit tests serialize credential-environment mutation so local and CI cargo runs do not fail nondeterministically.
- [x] **Shippo Health Test Coverage** — disabled, missing-token, and healthy credential states are covered without requiring live label purchases.
- [x] **Help and Manual Refresh** — the checkout, Payments Health, Register recovery, release, and certification manuals are updated for the replacement source; generated Help impact remains part of the pre-retag gate.
- [x] **GO-LIVE Connectivity Hardening** — Register and Back Office startup/recovery paths now use bounded API calls, shared runtime API-base handling, explicit Main Hub recovery guidance, and focused E2E coverage for outage/recheck behavior.
- [x] **Direct Layaway Deposit QBO Handling** — daily QBO staging now includes direct layaway cash/card deposit inflows as `liability_deposit` evidence without changing fulfillment-time revenue recognition.

## v0.95.0 Release Readiness Gates

- [x] `v0.95.0` GitHub release exists and is marked Latest.
- [x] Pre-candidate `v0.95.0` Windows updater and standalone-app assets exist for build `feb0db16`.
- [x] Replacement `v0.95.0` updater manifests, installers, signatures, and standalone-app assets name full commit `d9e68018f99f0778a21b0ffca1b57f287594561c`.
- [x] `RiversideOS-v0.95.0-d9e68018-Windows-Deployment.zip` exists as the only same-version deployment ZIP and passed independent provenance verification.
- [ ] Physical station smoke is complete for Main Hub, Register #1 Windows Tauri, Register #2 iPad PWA, and other Windows laptop PWA devices.
- [ ] Real external credential workflows have been tested where required for go-live: QBO sandbox/production, Helcim, Podium, Shippo, and Counterpoint SQL.

## Code Gate

- [x] Final replacement source and publication validation is recorded in [`docs/releases/v0.95.0-certification.md`](releases/v0.95.0-certification.md), including exact-commit CI, candidate runs, promotion, release state, manifests, signatures, asset count, and deployment-ZIP provenance.
- [x] Replacement local validation passed before tagging: whitespace, version parity, client lint/typecheck, locked Rust checks, deployment release gates, go-live blockers, and Help impact. Local Playwright is intentionally skipped at operator direction.
- [x] Exact-commit GitHub Lint run `30006157344` and blocking Playwright run `30006157349` passed on full commit `d9e68018f99f0778a21b0ffca1b57f287594561c`.
- [ ] `scripts/production_audit_probes.sql` runs read-only against the release database and all P0/P1 probes are explained or zero-row.
- [x] The July 21 false-fulfillment incident remains explicitly disclosed: the universal write boundary, payment-allocation history, inventory line/event provenance, per-Transaction QBO attribution, and restore-tested Main Hub backup remain incomplete. The held prototype under `docs/incidents/design/` is not shipped.
- [x] The retained 567-record cohort remains classified as 557 traceability reviews, one current-exception review, nine failed recognition recoveries, and zero verified. Operator direction on 2026-07-23 makes this a non-blocking release warning; it does not authorize additional status edits or allow the cohort to be described as verified.
- [x] `npm run check:pre-retag` verifies the evidence hashes and prints a prominent Counterpoint incident warning while allowing the release workflow to continue.

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
- [ ] Confirm pending or blocked checkout recovery remains visible with its repair actions while ordinary authorized close stays available.
- [ ] Confirm the immediate and archived Z-Report preserve the exact pre-close recovery warnings under **Unresolved Issues at Close** without resolving them.
- [ ] Confirm cash count, check review, Daily Cash Deposit date, and an over-$5 discrepancy note remain required close inputs.

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
