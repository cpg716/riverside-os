# Release Verification Ledger — Riverside OS

Last updated: 2026-07-01

This ledger separates **code patched** from **behavior proven**. A workflow is not considered fixed for go-live unless the required proof level is met.

## Status Levels

| Status | Meaning |
|---|---|
| **Target verified** | Reproduced and passed on the real target environment: Windows Main Hub, Register station, hardware, or live/sandbox integration as applicable. |
| **Local verified** | Automated build, typecheck, unit, or E2E proof passed in this repo/workspace. This does not prove hardware or Windows deployment behavior. |
| **Static verified** | Source/package assertions passed, for example broken strings or malformed command patterns are absent. |
| **Patched, not target verified** | Code was changed and local/static checks passed, but the real production path still needs rehearsal. |
| **Unverified** | No current proof attached in this pass. Treat prior “fixed” claims as unproven until evidence is added. |
| **Blocked external** | Requires hardware, Windows target, credentials, Counterpoint SQL, QBO/Helcim/Shippo sandbox, printer, or other external system. |

## Current Evidence Captured In This Pass

| Evidence | Result |
|---|---|
| `cargo check --manifest-path client/src-tauri/Cargo.toml` | Passed |
| `cargo check --manifest-path deployment/manager-app/src-tauri/Cargo.toml` | Passed |
| `cargo check --manifest-path deployment/server-manager-app/src-tauri/Cargo.toml` | Passed |
| `npm --prefix client run typecheck` | Passed |
| `npm --prefix deployment/manager-app run build` | Passed |
| Static deployment assertion: no `psql ... -tAc -w`, no broken sherpa `win-x64.tar.bz2`, no stale visible legacy Main Hub updater copy | Passed |
| Upstream sherpa asset check: `sherpa-onnx-v1.13.2-win-x64-shared-MD-Release.tar.bz2` | Reachable |
| `npm run check:version` | Passed: Riverside version parity OK `0.90.0` |
| `npm run check:updater-release -- --repo cpg716/riverside-os --tag v0.90.0 --platform windows-x86_64 ...` | Passed: published v0.90.0 POS, Deployment Manager, Server Manager, and Counterpoint Bridge GUI updater manifests/assets/signatures are structurally present |
| `npm --prefix client run test:e2e:blocking -- --list` | Passed list/discovery only: 144 blocking tests found in 24 files; tests were not executed |
| `npm run test:e2e:tender` | Passed: 8 tests, 1.6m |
| `npm --prefix client run test:e2e -- e2e/qbo-audit-contract.spec.ts --workers=1` | Passed: 13 tests, 1.7m |
| `npm --prefix client run test:e2e -- e2e/orders-custom-contract.spec.ts e2e/orders-detail-handoff.spec.ts --workers=1` | Passed: 15 tests, 2.0m |
| `npm --prefix client run test:e2e -- e2e/inventory-audit-contract.spec.ts e2e/inventory-receiving-api.spec.ts --workers=1` | Passed: 12 tests, 1.3m |
| `npm --prefix client run test:e2e -- e2e/notification-deep-link-contract.spec.ts --workers=1` | Passed: 11 tests, 32s |
| `npm run test:e2e:rms` | Passed: 13 tests, 1.5m. RMS Charge suite now verifies manual/internal recording without an external financing-host dependency. |
| `npm run generate:help` | Passed: regenerated help quality report, client help manifest, and server manual corpus; 68 approved manuals, 0 draft |
| `npm --prefix client run test:e2e -- e2e/help-center.spec.ts e2e/phase2-finance-and-help-lifecycle.spec.ts e2e/reports-workspace.spec.ts e2e/reporting-trust-contract.spec.ts e2e/reports-mobile-cards.spec.ts --workers=1` | Passed: 31 tests, 2.7m |
| `npm --prefix client run test:e2e -- e2e/alterations-smart-scheduler.spec.ts e2e/wedding-readiness-certification.spec.ts e2e/wedding-readiness-walkthrough.spec.ts --workers=1` | Passed: 6 tests, 1.5m after fixing alteration fixture totals, lifecycle override credential fixture, and invalid `transaction_lines.updated_at` write |
| `npm --prefix client run test:e2e -- e2e/staff-scheduler.spec.ts e2e/scheduler-mobile-ergonomics.spec.ts e2e/alterations-smart-scheduler.spec.ts e2e/wedding-readiness-certification.spec.ts e2e/wedding-readiness-ui.spec.ts e2e/wedding-readiness-walkthrough.spec.ts --workers=1` | Passed: 16 tests, 2.1m |
| Windows PowerShell runtime rehearsal | Not run here; this workspace is macOS and `pwsh` is unavailable |
| Same-version `v0.90.0` release rerun | Published from commit `6064e91c`; GitHub release is Latest with `RiversideOS-v0.90.0-6064e91c-Windows-Deployment.zip` |
| `npm --prefix client run test:e2e -- --workers=1` on release commit `6064e91c` | Passed: 373 passed, 11 skipped |
| GitHub release workflows on `6064e91c` | Passed: Lint Checks, Playwright E2E, macOS ROS Dev Center Release, Windows deployment package |

Important: the published `v0.90.0` updater and deployment assets now include the same-version rebuild fixes through commit `6064e91c`. That proves source inclusion and release workflow publication, but it still does **not** prove Windows Main Hub install/update behavior, hardware paths, live credentials, or target-device smoke unless those real environments are exercised and recorded.

## Verification Matrix

| Area | Prior claim risk | Current proof | Current status | Required proof before go-live |
|---|---|---|---|---|
| Windows Deployment Manager install/update flow | High: screenshots showed real failures after prior “fixed” claims | Deployment Manager TypeScript build passed; Tauri cargo check passed; Main Hub install/update now passes `-StationMode mainhub`; child PowerShell consoles suppressed; refreshed v0.90.0 assets were published from `6064e91c` | **Patched, not target verified** | Run Main Hub install/update/repair/uninstall on the Windows Main Hub from the published package, capture logs and final station config |
| In-app Main Hub updater | High: update instructions and runner path were unclear/unreliable | Tauri cargo check passed; runner now writes transcript and invokes `install-register.ps1 -StationMode mainhub`; refreshed v0.90.0 assets were published from `6064e91c` | **Patched, not target verified** | Run from installed Windows app, confirm UAC launch, transcript creation, server/app update, relaunch, and version/build detection |
| ROSIE LLM/STT/TTS install/update | High: screenshots showed sherpa 404 and missing model/runtime | Corrected sherpa release asset; package builder now bundles sherpa binaries/DLLs; asset HEAD request passed; refreshed v0.90.0 deployment package was published from `6064e91c` | **Patched, not target verified** | Install on Main Hub, verify `llama-server.exe`, `sherpa-onnx-offline.exe`, `sherpa-onnx-offline-tts.exe`, scheduled task, LLM health, STT, and TTS |
| PostgreSQL install/migration bootstrap | High: screenshots showed `syntax error at or near "-" LINE 1: -w` | Corrected `psql -w -tAc` flag ordering in install/migration/credential scripts; static bad-pattern scan passed | **Patched, not target verified** | Run install-server/update/repair on Windows against existing and fresh DB states; confirm migrations ledger and UTF-8 checks pass |
| Station role labeling: Main Hub/Register/Back Office | High: screenshots showed Main Hub detected but station label not installed or Back Office | Main Hub fallback added in in-app updater panel; Main Hub station config can apply loopback API; Deployment Manager and scripts now use Main Hub wording | **Patched, not target verified** | Verify `C:\ProgramData\RiversideOS\station-config.json`, in-app Settings → Updates station label, and register/back-office labels on actual machines |
| Counterpoint Bridge GUI | High: prior claims involved packaging/runtime reliability | No current bridge GUI runtime test in this pass | **Unverified** | Run packaged Bridge GUI without developer tooling, connect to Counterpoint SQL, verify schema probe, sync progress, errors, and logs |
| Counterpoint data sync/import | High: go-live blocker for customers, purchase history, open docs, inventory, gift cards, loyalty | No current Counterpoint SQL reconciliation in this pass | **Blocked external** | Reconcile sample/full CP import: customers, sales history, open orders, deposits, balances, inventory, gift cards, and loyalty current balances |
| QBO journal staging/publish/rebuild | High: financial correctness and daily staging are go-live critical | Local QBO audit contract passed: 13 tests covering refunds, inventory/COGS reversal, deposits/store credit/gift cards/layaways, balanced/deduped proposal, business dates, and shipped-order recognition | **Local verified, sandbox unverified** | Run sandbox Z-report/day activity staging, publish, void/rebuild, retry, and account mapping proof against intended QBO company |
| Register checkout/payments/tax/discounts | High: sales processing is business-critical | Local tender/checkout financial contracts passed: 8 tests covering check number requirement, split tender allocation, cash rounding, mixed/non-cash tenders, and RMS payment collection revenue behavior | **Local verified, hardware unverified** | Run hardware/sandbox tender matrix: cash, card, check, split tender, discounts, tax edge cases, sale complete, receipt, drawer close |
| Receipt/report/tag printing | High: prior issues in print routing and retry queue | No printer hardware proof in this pass | **Blocked external** | Verify allowed printer config, browser/report print paths, ESC/POS receipts, failed receipt retry retention, reprint from sale/order |
| Orders vs transactions and fulfillment lifecycle | High: repeated user-visible confusion | Local orders contracts passed: 15 tests covering custom/special/wedding distinctions, deposit visibility, pickup status, detail drawer, POS handoff, and authoritative reopen after register activity | **Local verified, operator workflow unverified** | Manually verify order-only list filtering, lifecycle statuses, ready-for-pickup workflow, closed/cancelled filters, and drawer wording on target UI |
| Notifications | Medium/high: fatigue and duplicate risk | Local notification deep-link contracts passed: 11 tests covering actionability, bundle preview behavior, completion safety, severity mapping, shared read eligibility, recency, and bulk lifecycle safety | **Local verified, volume/fatigue unverified** | Verify de-dupe volume, severity/category/source filters, history/search, and operational notification volume with realistic data |
| Inventory/ProductHub/PO import | High: inventory correctness and receiving are critical | Local inventory/ProductHub contracts passed: 12 tests covering stock value basis, no checkout decrement for fulfillment orders, exact-once pickup/PO receipt, physical inventory block, returns/restock, ProductHub inventory truth, timeline readability, and direct invoice receiving | **Local verified, hardware/import unverified** | Verify PO/invoice AI import formats and stock/reserved/on-layaway invariants with real vendor files and receiving workflow |
| Wedding Manager | Medium/high: customer/order/appointment/history wiring | Local wedding readiness/UI walkthrough passed: 3 specs in the 16-test scheduling/wedding suite covering wedding readiness risk, vendor delay, partial/balance-blocked/complete states, dashboard UI, and repeatable walkthrough parties | **Local verified, import unverified** | Run wedding import drill and target UI workflow; verify members, orders, payments, appointments, history, statuses, and register links |
| RMS Charge workflows | Medium/high: financial/task/payment implications | RMS Charge now uses internal/manual recording plus R2S follow-up; obsolete external financing-host E2E dependencies were removed from scripts, specs, and docs; local RMS E2E passed 13 tests | **Local verified, R2S workflow unverified** | Run store workflow proof for staff posting/follow-up against R2S outside Riverside |
| Shippo shipping | Medium/high: order/register shipping paths | No current Shippo sandbox proof in this pass | **Blocked external** | Verify order/register shipment creation, label purchase, tracking, void/refund, address validation, and reporting fields |
| Helcim payments | High: payment processing and reporting | No Helcim terminal/API proof in this pass | **Blocked external** | Verify terminal stream/poll fallback, payment capture, saved cards, refunds, failures, reporting, and QBO tender mapping |
| Meilisearch search | Medium/high: discoverability across workflows | No current index/search proof in this pass | **Unverified** | Run search/index smoke: customers, products, orders, help, weddings, fallback behavior, index freshness |
| Reports/Metabase | Medium/high: staff trust and management visibility | Local report UI/trust contracts passed: 31-test Help/Reports suite covered reports workspace, finance/help lifecycle, reporting trust contracts, and mobile report cards | **Local verified, Metabase external unverified** | Verify Metabase auth/embed, readable fields, charts, and daily financial report alignment with target data |
| Help Center/manual generation/ROSIE help | Medium/high: staff onboarding and support | Help manifest/manual corpus regenerated; 31-test Help/Reports suite passed, including Help Center search/admin flows, Ask ROSIE help requests, and ROSIE voice input UI path | **Local verified, ROSIE runtime target unverified** | Verify ROSIE runtime-backed answers, staff manual screenshots/content spot-check, and target help search/index freshness |
| Appointments/staff scheduling/tasks | Medium: operating workflow reliability | Local scheduling suite passed: 16 tests covering public roster, staff availability, master scheduler, store events, master template mode, mobile ergonomics, alteration smart scheduler, manual alteration appointment creation, and wedding readiness | **Local verified, operator workflow unverified** | Verify target UI operator workflow, notifications, print/export, and real staff scheduling data |
| Backup/restore | High: data preservation | No restore drill in this pass | **Blocked external** | Run Windows Main Hub backup and non-production restore drill; verify app boots and migration ledger/data counts are intact |

## P0 Proof Queue

These must be proven before calling the release ready:

1. **Windows Main Hub deployment rehearsal** — full install, update, repair, uninstall/reinstall, station label proof, transcript/log capture.
2. **ROSIE runtime proof** — LLM, STT, TTS, sherpa binaries, scheduled task, model path, update/rerun idempotency.
3. **Register financial proof** — checkout, payment, tax, discount, receipt, refund/exchange, Z-close staging.
4. **QBO proof** — mapped journal staging for all financial activity, publish, void, rebuild, retry, no fallback accounts.
5. **Counterpoint cutover proof** — SQL bridge plus reconciliation for customers, sales history, open orders, inventory, gift cards, loyalty balances.
6. **Hardware proof** — Helcim terminal, receipt/tag/report printers, cash drawer, scanner, Register/Back Office station roles.
7. **Backup/restore proof** — Windows Main Hub backup and non-production restore drill.

## Rule Going Forward

No future fix in this repo should be reported as “fixed” unless the response states its proof level. Acceptable wording is:

- **Patched only** — code changed but behavior not exercised.
- **Static/local verified** — commands/tests passed in this workspace.
- **Target verified** — actual Windows/hardware/integration workflow passed with evidence.
