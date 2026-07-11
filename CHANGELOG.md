# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepashangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.90.0] - 2026-06-04

### Added
- **RiversideOS User Manual PDF**: Added live, on-demand PDF generation in Help Center Settings with current effective manuals, embedded screenshots, clickable contents, PDF bookmarks, native desktop download, and print/save-to-PDF support.
- **Wedding Party Held Deposits in Register**: Added immediate beneficiary-customer deposit notices, Pay-screen application, customer-history visibility, fulfillment-timed QBO liability release, and atomic void/cancellation restoration for split wedding deposits held before a member has a Transaction Record.
- **Operational Outbox and Recovery Telemetry**: Added durable post-checkout side-effect processing, Main Hub-backed offline/print recovery visibility, phase metrics, and migration `124` operational recovery tables.
- **v0.90.0 Release Documentation Set**: Added current release notes and certification evidence for the v0.90.0 publication, replacing stale v0.85.9 current-release guidance in active deployment docs.
- **Pre-Go-Live Local Review Evidence**: Documented the source-side pre-go-live review results for QBO, Counterpoint sync, backups/restore, Helcim, Podium, Shippo, and release/update code paths that can be validated locally.
- **Shippo Health Coverage**: Added local Shippo health-check test coverage so disabled, missing-token, and healthy credential states are verified without requiring live shipping labels.
- **GO-LIVE Performance and Connectivity Review**: Added a current review artifact and focused Register/Back Office connection recovery coverage for LAN, Tailscale, PWA, and Tauri API-base behavior.

### Fixed
- **Recovery Authentication Continuity**: Operational recovery endpoints now use the shared Staff-or-Register authentication middleware, preventing a stale Register token from overriding valid Staff Access during recovery polling.
- **Mobile Toast Interaction Safety**: Toast notification bodies no longer intercept taps on Register controls underneath them; the visible dismiss control remains interactive.
- **Financial Runtime Boundaries**: Removed weather/provider waits from locked checkout/refund sections, enforced exact-cent tax and total parity, bounded printer dispatch, and made print failures activate the retry path.
- **Helcim, QBO, and IMAP Contracts**: Constrained provider idempotency/request identifiers, added Intuit webhook/OAuth/token-refresh validation, and replaced the legacy synchronous mailbox stack with bounded `async-imap` using current `imap-proto`.
- **RMS Charge CoreCard Purge**: Removed obsolete CoreCard credential surfaces, fake-host E2E dependencies, stale validation scripts, and deployment/manual guidance so RMS Charge is documented and tested as the internal Riverside/R2S workflow.
- **QBO Mapping Fallback Removal**: Removed fallback account mapping behavior from QBO journal staging and workspace copy. Exportable financial activity must now have explicit Chart of Accounts mappings instead of silently routing through a generic fallback.
- **QBO Inventory Adjustment Mapping**: Renamed the legacy inventory adjustment revenue mapping key to `REVENUE_INVENTORY_ADJUSTMENT` so the mapping matrix remains explicit, mappable, and auditable.
- **QBO Direct Layaway Deposit Journals**: Included direct layaway deposit payments in the daily QBO deposit-liability journal and drilldown evidence so deposit cash/card inflows no longer wait for a later fulfillment release before appearing in accounting review.
- **Register and Back Office Connectivity Recovery**: Bounded staff gate startup/API calls, aligned legacy API helpers with the shared runtime API base, and cleaned up checkout replay timeouts so LAN/Tailscale outages recover with clear staff-facing guidance.
- **Helcim Health Test Isolation**: Serialized Helcim environment mutation in unit tests to prevent nondeterministic credential-state failures during parallel cargo test execution.

### Changed
- **Release Metadata Bump**: Updated root, client, server, Tauri, standalone app, ROS Dev Center, and Windows deployment package metadata to v0.90.0.
- **Help/Manual Refresh**: Refreshed active manuals and help-manifest sources so in-app Help Center content reflects the current release guidance and avoids stale v0.85.9 "current release" directions.
- **Deployment Guidance Truthfulness**: Updated active deployment status docs to distinguish source readiness, GitHub release publication, release workflow assets, and physical Windows/hardware go-live gates.
- **Latest Same-Version Rebuild**: Prepared the 2026-07-11 `v0.90.0` replacement-tag rebuild with current production hardening, wedding held-deposit changes, recovery-auth continuity, and mobile toast interaction safety. The final local release suite completed with 380 passed, 12 expected skips, and 0 failures before the replacement tag was moved.

## [0.85.9] - 2026-06-04

### Added
- **ROSIE AI Stack Automatic Updates**: Hardened the ROSIE AI installer script (`Install-RosieAiStack.ps1`) to track current component versions using version-specific state marker files (`sherpa_version.txt`, `stt_version.txt`, `tts_version.txt`). Component upgrades are automatically triggered and downloaded when script version pins or model repositories are updated.
- **Standalone App Self-Updaters**: Added shared Tauri updater plumbing for standalone support tools, including Deployment Manager, ROS Server Manager, Counterpoint Bridge GUI, and ROS Dev Center, with release manifest verification for same-version rebuild detection.
- **Orders Lifecycle Workbench Filters**: Added explicit Orders views for Open Orders, All Records, Closed, and Cancelled plus lifecycle filtering for NTBO, Ordered, Received, Needs Ready Check, Ready for Pickup, and Picked Up.
- **Ready-for-Pickup Staff Queue**: Added a dedicated Orders metric for received items that still need staff ready-check review before customer pickup notifications and release.

### Fixed
- **Windows Deployment Connection Probes**: Wrapped native database connection query tests with temporary `$ErrorActionPreference = "SilentlyContinue"` blocks in `install-server.ps1`, `reset-riverside-database.ps1`, `reset-postgres-password.ps1`, and `audit-system.ps1` to prevent terminating `NativeCommandError` exceptions when connection checks fail.
- **Counterpoint Bridge GUI Self-Containment**: Release builds now run from packaged bridge resources and a bundled Node runtime instead of invoking `npm install` or relying on system `node` at customer install time.
- **Counterpoint Historical Provenance in Orders**: New ROS-origin orders no longer display `CP Open Doc`/Counterpoint historical badges unless the transaction is marked as a Counterpoint import and has Counterpoint document or ticket references.
- **Customer Join/Split Data Separation**: Joined customer accounts now preserve per-person profile views for communications and CRM data, while split accounts keep post-split independence and parent-history guidance for pre-split purchases.

### Changed
- **Maintenance & Repair Layout Redesign**: Redesigned the vertically scrolling sidebar list in the Deployment Manager GUI to feature a horizontal sub-tab category menu (`Status & Control`, `Updates & Setup`, `Database Admin`, `Utility Scripts`, `Danger Zone`) and an expanded full-width log output console at the bottom with a larger adjustable height view.
- **Main Hub Nomenclature Alignment**: Updated and aligned user-facing labels, logs, descriptions, and action triggers from "Server PC" to **"Main Hub"** for architectural nomenclature consistency.
- **Role-Aware In-App Updates**: Update Manager copy and flow now distinguishes Main Hub, Register, and Back Office expectations, including Main Hub server/ROSIE responsibilities and workstation version gates.
- **ROSIE Local LLM Profiles**: Local llama.cpp startup now supports explicit host profiles for Intel i9-12900, Minisforum V3, Apple M3 Pro, Apple M3 Pro CPU-parity, and portable CPU hosts. The Intel i9-12900 profile pins compute and batch threads to 8, disables GPU offload, enables mmap/mlock where supported, and applies P-core affinity on Windows.
- **Release Asset Verification**: Release packaging now verifies updater manifests, build metadata, signatures, build SHA values, and referenced artifacts for POS and standalone app updater channels.

## [0.85.5] - 2026-06-03

### Added
- **Counterpoint Bridge GUI Optimization**: Major performance and UX improvements to the Counterpoint Bridge GUI application:
  - **Performance Enhancements**: Reduced polling frequency from 2s to 5s, added React useCallback/useMemo hooks for preventing unnecessary re-renders, implemented state change detection to only update React state when data actually changes, added cache control to fetch calls for fresh data, and memoized entity stats rendering.
  - **Modern UI Design**: Added real-time sync progress bar with percentage indicator and Zap icon, improved sync state display with animated spinner when syncing, enhanced visual hierarchy with icons and color-coded status, gradient buttons with hover effects, smooth transitions and animations, and clean professional layout with sidebar navigation.
  - **Riverside OS Integration**: Added direct workflow link button that opens the Riverside OS Counterpoint Sync workflow at `/settings/integrations/counterpoint-sync`, enabling seamless navigation between Bridge GUI and Riverside OS for complete GO LIVE workflow.
  - **Complete Entity Coverage**: Bridge GUI supports all 15 entities (Staff, Sales Reps, Vendors, Customers, Store Credits, Customer Notes, Categories, Catalog, Inventory, Vendor Items, Gift Cards, Orders/Tickets, Open Documents, Loyalty History, Receiving) with auto-schema detection for column name alignment.

### Fixed
- **Receipt Centering Issue**: Fixed ESC/POS receipt printing centering by:
  - Adding `spacing: false` and `margin: "full"` options to receiptline transform in both print and preview functions in `ReceiptSummaryModal.tsx`
  - Adding `^^` prefix to centered lines in `receipt_escpos.rs` `centered_lines` function to ensure receiptline treats them as centered/bold
  - These changes ensure proper centering of header and footer lines on thermal printers.
- **Deployment: PostgreSQL password prompts eliminated**: All bare `psql` calls in `install-server.ps1` that were missing the `-w` (no-password) flag have been fixed. `Invoke-PsqlScalar`, `Get-DatabaseEncoding`, `Get-MigrationLedgerExists`, `Get-MigrationApplied`, `Test-CoreIdentityMigrationApplied`, and the database existence check now all pass `-w`, ensuring psql never opens an interactive password prompt in any shell context (GUI-spawned child process or terminal).
- **Deployment: ROSIE `ggml-base.dll` locked during update**: `install-server.ps1` and `Install-RosieAiStack.ps1` now stop the `Riverside OS LLM Host` scheduled task and kill `llama-server`, `sherpa-onnx-offline`, and related processes before overwriting any ROSIE binaries. Prevents Windows from refusing to copy DLLs held open by a running process on incremental updates.
- **Deployment: ROSIE `sherpa-onnx` download aborted by CDN**: `Invoke-Download` in `Install-RosieAiStack.ps1` now retries up to 3 times with exponential backoff (2 s → 4 s), cleaning up partial files between attempts. Resolves "The request was aborted: The connection was closed unexpectedly" failures on GitHub CDN drops during large binary downloads.

### Changed
- **Counterpoint Bridge GUI Code Quality**: Fixed all Tailwind class lint warnings by updating to newer Tailwind CSS syntax (bg-gradient-to-r → bg-linear-to-r, hover:bg-white/[0.02] → hover:bg-white/2, etc.).


## [0.85.0] - 2026-05-31

### Added
- **POS Register GO LIVE Readiness Review**: Systematic end-to-end review of the POS Register (cart, checkout, payments, printing, sessions, offline), Back Office, Settings & Integrations, and Performance. Six critical fixes implemented (A–F):
  - **Fix A — Session Token Pre-Check**: `useCartCheckout` now probes `GET /api/sessions/current` before tendering. If the session has expired or been closed from another terminal, the cashier gets immediate feedback instead of a late server rejection.
  - **Fix B — Server-Side Printer Config**: Per-register-lane printer settings (receipt, tag, report printers, cash drawer) are now persisted in `store_settings.pos_station_config`. New endpoints `GET|PATCH /api/settings/printer-config/{register_lane}`. The Register Overlay hydrates settings on lane change and syncs them on successful open.
  - **Fix C — Offline Queue Recovery UI**: The POS cart header now polls the offline checkout queue every 10s and displays live badges: an amber "syncing" badge when items are queued, and a red "need recovery" badge when blocked items require manual attention.
  - **Fix D — Receipt Print Retry Queue**: Failed receipt prints are captured in a new `localforage` retry queue (`printRetryQueue.ts`). A "X print retry" danger button appears in the POS header; clicking opens a modal to retry individual jobs or dismiss them.
  - **Fix E — Dynamic Register Lanes**: The Register Overlay dropdown is no longer hardcoded to 4 lanes. It fetches `max_register_lanes` from the new public endpoint `/api/settings/pos-station-config/public` and generates options dynamically. Migration `058_pos_station_config.sql` adds the JSONB column.
  - **Fix F — Helcim Terminal Auto-Reconnect**: `NexoCheckoutDrawer` now runs a 4-second fallback polling interval alongside the SSE stream. If the SSE connection drops silently, polling continues to refresh the terminal attempt status until completion or cancellation.
- **ROSIE Token Telemetry System**: Comprehensive token usage tracking for cost analysis and provider comparison when evaluating local LLMs vs cloud-based APIs:
  - **Database Migration**: `060_rosie_token_telemetry.sql` adds `rosie_token_telemetry` table with fields for model name, provider, input/output tokens, and timestamp. Includes indexes for efficient date-based and provider/model queries.
  - **Non-Blocking Telemetry Recording**: `record_token_telemetry()` function in `rosie_intelligence.rs` uses `tokio::spawn` for fire-and-forget DB inserts, ensuring POS terminal performance is not impacted by telemetry recording.
  - **Token Metrics Query**: `get_token_metrics()` function returns daily tokens, monthly tokens, and estimated monthly cost (using placeholder rate of $0.50 per 1M tokens, configurable for per-provider rates).
  - **API Endpoint**: `GET /api/settings/rosie/token-metrics` exposes telemetry metrics for admin staff (requires `settings.admin` permission).
  - **UI Component**: `RosieTokenMonitor` component in `RosieSettingsPanel.tsx` displays daily token use, actual monthly usage, and estimated monthly cost with clear formatting and placeholder rate disclaimer.
- **ORDER Pick up Inventory and Lifecycle Guards**: Enhanced pickup workflow with inventory availability and lifecycle status checks:
  - **Inventory Availability Check**: Pickup guard now verifies `stock_on_hand >= quantity` for all unfulfilled lines before allowing pickup. Error message shows which items have insufficient inventory with need/have counts.
  - **Received Status Check**: When transitioning to `ReadyForPickup` status, system now verifies `received_at` is not NULL (item went through ordered → received lifecycle via vendor invoice). Prevents marking items ready before they physically arrive.
  - **Manager Override Mechanism**: Both inventory and received status checks can be bypassed using manager override with explicit reason (minimum 12 characters). Requires manager PIN and clear reason. Allows negative inventory for exceptional cases (receiving later brings stock positive).
  - **Payment Screen Recognition**: Fixed order payment line display for pickup transactions - now shows order payment line even when balance due is 0 if there were previous deposits, ensuring payment screen recognizes the transaction properly.
  - **Layaway and All Unfulfilled Transactions**: All pickup checks (inventory, received status, manager override, payment recognition) apply to layaway and all unfulfilled transactions regardless of fulfillment type or balance due status.

### Changed
- **Counterpoint Sync & Guided Migration Pipeline Consolidation**: Unified Counterpoint Sync and Migration Inventory Workbench into a single 8-step guided pipeline:
  - **8-Step Stepper**: SQL Bridge Sync → Inventory Catalog → Customers & CRM → Sales & Ticket History → Gift Cards & Liabilities → Open Orders & Layaways → Loyalty History → Audit & Live Cutover
  - **Consolidated Component**: Merged `InventoryMigrationWorkbench.tsx` logic into `CounterpointSyncSettingsPanel.tsx` under Step 2 sub-tabs
  - **Step 2 Sub-Tabs**: CSV Enrichment, Category Maps, Vendor Maps, AI Enrichment (ROSIE), SKU Gaps, Merge Preview
  - **Linear Step Enforcement**: Steps unlock sequentially based on completion of previous steps
  - **Pipeline Percentage**: Visual progress indicator showing completion across all 8 steps
  - **Backend Step Gate**: Step approval system with `approve-step` API endpoint
  - **Simplified Terminology**: "Open Orders & Deposits", "Gift Card Active Liabilities", "Sales & Ticket History", "Staging Area"
  - **Deleted Files**: Removed `InventoryMigrationWorkbench.tsx` (logic consolidated)
  - **Updated Navigation**: Removed "Migration Workbench" from `sidebarSections.ts` and `SettingsWorkspace.tsx`
- **NY Tax Audit Report Simplification**: Simplified the NY Tax Audit API response structure to match NY State filing requirements with user-friendly fields:
  - **Simplified Response**: Replaced complex line categorization (clothing_footwear_lines, local_only_exempt_lines, clothing_at_or_over_threshold_lines, etc.) with three clear sales categories: gross_sales, taxable_sales, nontaxable_sales.
  - **Tax Totals**: Added total_state_tax, total_local_tax, and total_tax_collected for easy reporting.
  - **Backend**: Updated `nys_tax_audit` function in `insights.rs` to aggregate data into the simplified structure.
  - **Frontend**: Updated `reportsCatalog.ts` to reflect the new simplified title and description.
- **Z-Report Print Layout Redesign**: Major visual overhaul of the Z-Report print output for better readability and professional appearance:
  - **Activity Cards**: Replaced table-based transaction list with card-based layout showing payment method pill, timestamp, customer name, transaction ID chip, and lane chip.
  - **Item Display**: Enhanced item rows with bold product names, muted SKU/fulfillment details, and monospace pricing in a clean grid layout.
  - **Money Section**: Reorganized transaction totals with clear labels for Transaction Amount, Sale Total, Paid, and Balance Due.
  - **CSS Styling**: Added new CSS classes for activity cards, pills, chips, section labels, and improved spacing/borders.
  - **Branding Update**: Changed header from "RIVERSIDE OS" to "RIVERSIDE MEN'S SHOP" throughout print outputs.
  - **Tauri Print Integration**: Added Tauri file save dialog for desktop app - saves HTML file and opens in default browser instead of direct print, with graceful fallback to browser print.
  - **Error Handling**: Added print failure error handling with user-friendly alerts.
- **Daily Sales Report Print Enhancements**: Improved daily sales report print output:
  - **Grand Total**: Added grand total calculation displayed at end of report with clear formatting.
  - **Document Title**: Added document title for browser tab identification.
  - **Generated Timestamp**: Added generated timestamp to report header and footer.
  - **Tauri Integration**: Added Tauri file save dialog for desktop app with same save-and-open workflow as Z-Report.
  - **Section Rename**: Changed "Activity Detail" to "Transaction List" for clarity.
- **Table Print Enhancements**: Improved generic table print output:
  - **Document Title**: Added document title based on report name.
  - **Branding Update**: Changed footer from "RIVERSIDE OS" to "Riverside Men's Shop".
  - **Tauri Integration**: Added Tauri file save dialog with save-and-open workflow.
  - **Error Handling**: Added print failure error handling.
- **Register Reports CSV Export Enhancement**: Improved CSV export with totals and Tauri native file dialog:
  - **Total Rows**: Added grand total row at end of CSV with TOTAL label and summed values for Transaction Total, Sales Total, Tax, and Net Total.
  - **Tauri Native Dialog**: Added Tauri file save dialog using `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` for native file picker experience in desktop app.
  - **Fallback**: Graceful fallback to browser download method if Tauri environment is not available or save fails.
  - **Async Function**: Converted `handleExportCSV` to async function to support Tauri plugin imports.

### Migration
- `058_pos_station_config.sql` — adds `pos_station_config JSONB` to `store_settings` for lane limits and per-station printer configuration.
- `060_rosie_token_telemetry.sql` — adds `rosie_token_telemetry` table for tracking AI token usage with indexes on timestamp and provider/model.

## [0.80.9] - 2026-05-27

### Added
- **QBO Staging Lifecycle Management**: Three new endpoints to manage previously staged/synced journal entries:
  - **Revert to Pending** (`POST /api/qbo/staging/{id}/revert`): Un-approve an approved entry back to pending so mappings can be fixed and the journal regenerated before re-approval. Requires `qbo.staging_approve`.
  - **Retry Failed** (`POST /api/qbo/staging/{id}/retry`): Re-validate balance/accounts and re-attempt QBO JournalEntry POST for failed entries without requiring manual re-propose. Requires `qbo.sync`.
  - **Void Synced Entry** (`POST /api/qbo/staging/{id}/void`): Read the JE SyncToken from QBO, delete the JournalEntry via `?operation=delete`, and mark the local row `voided`. Enables re-staging a corrected entry for the same business date. Requires `qbo.sync`.
- **QBO Workspace UI — Lifecycle Actions**: Contextual action buttons in the staging table: Revert (amber, approved rows), Retry (orange, failed rows), Void in QBO (red/danger confirmation, synced rows). All gated behind confirmation modals with descriptive messaging.
- **QBO Voided Status**: New `voided` status in staging pipeline with distinct visual treatment (gray, line-through) in both Review & Send and History views.
- **Daily Financial Report System**: Automated end-of-day financial summary that generates, stores, and emails a comprehensive business-day report after register Z-close. Covers net sales, tenders, tax, returns, deposits, gift cards, alterations, inventory receiving, freight, category margins with COGS and margin %, and QBO journal status. Features:
  - **Settings Panel** (`Settings → Daily Financial Report`): Enable/disable, configure recipient emails, subject template, auto-send toggle, QBO status inclusion, and inventory activity toggle.
  - **Professional HTML Email**: Gradient header, color-coded KPI cards, clean data tables, margin heat coloring, QBO sync badge, and branded footer.
  - **Auto-Send After Close**: Automatically emails the report after Z-close when enabled. Skips duplicates if already sent for the business date.
  - **Test Send**: Send the most recent completed report as a test with `[TEST]` prefix. Supports email override for ad-hoc testing.
  - **Report History**: View all generated reports with net sales, status badges, in-app HTML preview modal, and one-click resend.
  - **API**: Full REST API at `/api/daily-reports/` — config, generate, send, test-send, history, detail, resend.
  - **Migration**: `052_daily_financial_reports.sql` — `daily_report_config` JSONB on `store_settings`, `daily_financial_reports` table with unique date constraint.

## [0.80.8] - 2026-05-27

### Added
- **Constant Contact Marketing Integration**: Direct synchronization of marketing-opted-in customers (`marketing_email_opt_in == true`) to selected mailing lists using high-performance v3 Bulk Import Activities. Allows mapping specific customer tags (e.g. `VIP`) and group codes to targeted mailing lists. Built a secure webhook receiver endpoint to ingest real-time campaign delivery events (sent, bounced, unsubscribed, opened, clicked) and display them on the customer relationship timeline. All API credentials and mappings are encrypted at rest using `RIVERSIDE_CREDENTIALS_KEY`.
- **Constant Contact Database Migration**: Added Migration `048_constant_contact_integration.sql` to track sync history logs and normalize/index email event records.
- **Counterpoint Post-Sync Line Resolution**: Changed the Counterpoint sync engine to map unresolved lines to the fallback variant (`HIST-CP-FALLBACK`) and store the original Counterpoint item key in the `vendor_reference` column. Implemented a post-sync resolver database update that dynamically links these lines to their correct variants once the catalog/barcodes are loaded or manually resolved, clearing the warnings and resolving corresponding sync issues automatically.
- **Proactive Dashboard Self-Healing**: Hooked the post-sync resolver into the Counterpoint Settings status dashboard API so that simply loading or refreshing the dashboard immediately resolves corrected items.
- **POS Register Idle Timeout**: Two-tier idle timeout — register open + 10 min of no interaction clears the session and shows the PIN overlay; PIN overlay idle for 5 min navigates to the POS Dashboard. Prevents unattended cashier sessions. Activity tracked via mouse, pointer, keyboard, touch, and scroll events.
- **POS Shell Strict Containment**: Closing the register (Z-report or session end) now always stays in the POS Shell with the PIN overlay showing. Only "Back to Back Office" exits POS mode. Fixes a regression where closing the register sometimes navigated to the Back Office.
- **POS Dashboard — Today's Sales Card**: Replaced the static "Register #N" stats card with a live "Today's Sales" card showing the current booked sales total filtered to today's date. Updates on every `refreshSignal` cycle.
- **POS Dashboard — Unread Notifications Card**: Replaced the "Priority Feed" stats card with an "Unread Notifications" card showing the real-time unread count for the signed-in staff member. Clicking opens the Notifications Drawer.

### Fixed
- **RMS Payment Lines Missing from Receipts**: Removed the `is_internal` filter from both branches of `selected_receipt_items_with_effective_qty` in `server/src/api/transactions.rs`. RMS Charge Payment lines, gift card loads, and alteration service lines now appear on all customer receipts (HTML, thermal ESC/POS, and email). Updated unit test to assert internal lines are included.
- **Receipt Text Wrapping (HTML)**: Applied `table-layout: fixed`, `overflow-wrap: break-word; word-break: break-word` to item table cells, and `width: 1%` on the nowrap qty/price columns in `receipt_studio_html.rs`. Prevents the qty column from stealing all available width in the 320px receipt container and causing product name "one or two letters" to break onto a second line. Also applied `overflow-wrap: break-word` to the `.paper` container and `table td` CSS rule as a global fallback.
- **Sales by Hour Stale Data**: `SalesByHourSnapshotCard.tsx` now filters the API response to `business_date === today` before computing the daily summary. Previously, if today had no hourly rows the card showed the most recent prior-day total instead of $0.
- **CI Lint (`cargo fmt`)**: Applied `cargo fmt` to `server/src/embedded_migrations.rs` — collapsed verbose multi-line `include_str!` tuples to single-line style, resolving the GitHub Actions `cargo fmt --check` failure on both server-lint and tauri-lint jobs.
- **Receipt Column Widths (HTML)**: Replaced `width:1%` shrink-to-fit with explicit proportional widths (`55%/25%/20%` standard, `65%/35%` gift) for more consistent layout across email clients, print, and narrow viewports.
- **E2E Contract Testing**: Updated the Playwright `tender-matrix-contract.spec.ts` test suite to assert that the RMS payment line is printed on the receipt (changing `expect(receipt).not.toContain(...)` to `toContain(...)`), aligning test assertions with the new receipt requirements.
- **Inventory Pricing Patch Flows — Backend Coverage**: Added integration tests for `patch_product_model` base-price cascade (`base_retail_price` changes clear `shelf_labeled_at` only for variants without `retail_price_override`) and `patch_variant_pricing` effective-price semantics (`price_changed` computed against old effective retail, `shelf_labeled_at` cleared only on real changes, no-op when override matches base).
- **Browser Print Fallback Popup Blocker Detection**: `openInventoryTagsPreviewWindow` in `client/src/components/inventory/labelPrint.ts` now returns `"blocked"` when `window.open` returns `null` (e.g., popup blocker). The fallback chain in `openInventoryTagsWindow` propagates this status. All UI callers (`VariationsWorkspace`, `ProductHubDrawer`, `InventoryControlBoard`) now toast an explicit error instead of silently failing or claiming success.
- **Batch Price Update Reprint Prompt**: `VariationsWorkspace` batch price updates now collect per-variant pricing responses and, if any variants experienced a real effective-price change with positive stock, present a single confirmation modal to print updated tags for all affected variations at once. Previously, batch updates silently skipped reprint prompting entirely.

## [0.80.7] - 2026-05-26

### Added
- **Transactional Outbox for QBO**: Added `qbo_sync_outbox` queuing inside the transaction checkout block. Decouples the live registers from QuickBooks Online downtime, rate limits, or transient connection issues by using an asynchronous sync worker with exponential backoff.
- **Offline Queue Conflict Alerts**: Allowed POS terminal checkouts during sync/offline replay to fall back to negative stock levels, inserting warning alerts to `negative_stock_alerts` and broadcasting notification updates to target admin staff.

### Fixed
- **Checkout State Machine & Idempotency**: Hardened transaction checkouts to write orders in a `Processing` state before terminal captures. Integrated client-side `checkoutClientId` idempotency to prevent dual sweeps, and hooked approved terminal payment webhooks to auto-recover and finalize stuck processing checkouts.
- **Strict Webhook Isolation Layers**: Enforced typed `serde` payload validation parsing on Helcim, Shippo, and Podium webhook entry points to prevent upstream API changes from propagating database exceptions.

## [0.80.6] - 2026-05-25

### Added
- **In-App Host Server Updater**: Integrated a native server update orchestration layer in Tauri (`server_updater.rs`). Allows the desktop app to download release packages, unpack binaries and script installers, and run them under Administrator permissions via a standard UAC dialog.
- **Update Manager UI Dashboard**: Enhanced `UpdateManagerPanel.tsx` and `appUpdater.ts` to display server status, download progress, and step-by-step update tracking.

### Fixed
- **Staff Help Viewer Authentication Fallback**: Hardened `server/src/api/help.rs` and help routing to gracefully fall back to the active POS register session credentials if active staff profile headers are absent or incomplete.
- **ROSIE Insights Optional Timeout Expansion**: Increased `ROSIE_OPTIONAL_INSIGHT_TIMEOUT_MS` in `client/src/lib/rosie.ts` from 15s to 120s to prevent premature request aborts on slower CPU-only workstation hardware.

## [0.80.5] - 2026-05-25

### Added
- **POS Register — Dedicated Payment Button**: A new **Payment** action button is available directly in the register toolbar under "Sale options" (next to **Gift Card**). Tapping it inserts the RMS Charge Payment line automatically, bypassing the need to search for "PAYMENT" in the product search. Cashier verification is enforced before the line is added.
- **Production Hardening Suite**: Enterprise-grade production features for scalability, reliability, and observability
- **Fal.ai Visual Sidecar Integration**: Centralized visual generation orchestration for staff avatars, catalog images, and promotional assets.
  - **Local-First Download Worker**: Downloads, crops, and caches generated images locally to comply with the offline-first contract.
  - **Secure Credentials Mapping**: Integrates API keys and webhook settings into the encrypted credentials database table.
  - **Robust Settings Dashboard**: Real-time billing credits, estimated spend and usage statistics, and visual generation job registry.

  - **Health Check Endpoints**: `/api/health`, `/api/ready`, `/api/live` for orchestration and monitoring
  - **Connection Pool Monitoring**: Automatic alerts when pool utilization exceeds 80%
  - **WAL Archiving**: Point-in-time recovery capability with monitoring and failure alerting
  - **System Alert Broadcasting**: Critical system events broadcast to all admin staff
  - **Global Rate Limiting**: IP-based and user-based DoS protection with configurable limits
  - **Redis Cluster Integration**: Distributed caching and locking with graceful fallback
  - **Background Job Queue**: Resilient async processing with retries, dead letter queues, and worker pools
  - **Comprehensive Metrics System**: Business KPIs and technical metrics with multiple export formats
- **Migration checksum drift detection**: Both `apply-migrations-psql.sh` and `apply-migrations-docker.sh` now store a SHA-256 hash of each migration file in `ros_schema_migrations.file_sha256`. On subsequent runs, if a previously applied file has been modified, the script prints a `⚠ DRIFT` warning instead of silently skipping. This prevents the class of bug where columns are added to an already-applied migration file and never reach the database.

### Fixed
- **Schema drift: missing columns**: Added migration `037_backfill_missing_columns.sql` to reconcile columns that were added to earlier migration files after they had already been applied — `store_media_asset.deleted_at/alt_text/usage_note` and `categories.variation_axis_presets`. Resolves 500 errors on the Store Dashboard and Categories API endpoints.
- **ROSIE on Server PC**: Windows server install now packages `llama-server.exe`, registers a **Riverside OS LLM Host** startup task on port 8080, and adds **Start-RiversideLlama.cmd** / Deployment Manager **Start ROSIE LLM Host** for repair.
- **RMS Charge race condition**: `reverse_rms_record_manual` now reads `host_reference` inside the same database transaction before commit, eliminating a read-after-commit race.
- **Gift Card lookup filtering**: `GET /api/gift-cards/{code}` now correctly restricts results to `active` non-expired cards, preventing POS use of void or expired cards.
- **Gift Card credit expiration check**: `credit_gift_card_in_tx` now verifies `expires_at > now()` before applying a refund credit.
- **Gift Card depleted reload liability**: Reloading a depleted purchased card now accumulates `original_value = original_value + amount` instead of overwriting it, preserving total liability history.
- **Loyalty monthly eligible filter**: The `monthly_eligible` endpoint now actually uses the `year` and `month` query parameters when provided, filtering to customers with positive ledger activity in that month.
- **Loyalty customer summary NULL safety**: `loyalty_customer_summary` now uses `COALESCE(..., 'Unknown')` to prevent deserialization panics when a customer has no name.
- **Loyalty redemption config validation**: `redeem_reward` now validates that `loyalty_point_threshold > 0` and `loyalty_reward_amount > 0` before processing, preventing point burns against an unconfigured program.
- **Commission recalc SQL safety**: Added explicit `SAFETY` comments to `format!` usages in `commission_recalc.rs` documenting that `ORDER_RECOGNITION_TS_SQL` is a compile-time constant with no injection risk.
- **Database migration runner**: Hardened multi-statement migration execution by splitting on semicolons and executing each non-empty, non-comment chunk individually with `sqlx::query()`. Strips `pg_dump` `SET` and `SELECT pg_catalog.set_config` preamble from migration files to prevent session-side-effect crashes. This is Send-safe across `tokio::spawn` boundaries (unlike `sqlx::raw_sql()`), fixing Windows Tauri compilation failures.
- **CI/CD — Windows deployment package concurrency**: Fixed static `group: windows-deployment-package` concurrency to `group: ${{ github.workflow }}-${{ github.ref }}`, preventing sequential tag pushes from cancelling each other before completion.
- **CI/CD — macOS ROS Dev Center upload paths**: Corrected artifact search paths from `src-tauri/target/` to repo-root `target/` to match the unified Cargo workspace layout, ensuring DMG and app.tar.gz actually reach the GitHub release.
- **POS RMS Charge access restored**: Removed an incorrect blanket `surface === "pos"` guard in `RmsChargeAdminSection.tsx` that blocked staff from viewing RMS Charge records and reporting to R2S while in POS terminal shell mode. Permission-based access (`customers.rms_charge`) remains the correct gate.

### Changed
- **RMS metadata cleanup**: Removed `linked_corecredit_*` fields from `RmsChargeSelectionMetadata` and RMS JSON metadata output. DB columns are preserved for backward compatibility but bound as `NULL` in new inserts.

### Removed
- **CoreCard / CoreCredit Integration**: Removed the entire CoreCard module (`server/src/logic/corecard/`) and all associated API routes, background workers, and test fixtures. The built-in RMS Charge workflow with Helcim as the sole payment provider now handles all charge account operations. This eliminates a deprecated third-party dependency and simplifies the payment architecture.

### Changed
- **Health Check Worker Heartbeats**: The `/api/ready` endpoint now validates actual worker heartbeats from background tasks (backup, notification, weather, email, podium) instead of returning hardcoded `true`. Each worker reports its liveness via `WorkerHealth::mark_heartbeat()`, enabling accurate readiness detection for orchestration systems.

## [0.70.1] - 2026-05-20
### Added
- **Inventory tag print date**: Tag Designer footer text is followed automatically by the print date on every inventory tag (HTML preview and Zebra/ZPL).
- **ROSIE AI model upgrade (E4B)**: Standardized the entire stack on Gemma 4 E4B (4B params, 5.4 GB Q4_K_M) — `MODEL_PIN.json`, Rust default paths, PowerShell installers, dev scripts, e2e mocks, and all docs updated from E2B → E4B.
- **Deployment Manager — PostgreSQL Status Panel**: Live diagnostics showing PG service state, psql connectivity, version, database existence, size, table count, and migration count with a Refresh button.
- **Deployment Manager — PostgreSQL service control**: Start PG / Restart PG / Stop PG buttons inside the status panel with auto-refresh after actions.
- **Deployment Manager — Stop Server**: Added a Stop Server button (previously only Start and Restart were available).
- **Deployment Manager — Uninstall flows**: Uninstall Server (removes binary, scheduled task, firewall rule — preserves database) and Uninstall Register (removes desktop app and shortcuts).

### Fixed
- **Deployment Manager**: Scripts receive `-ConfigPath`, run from the package root, and can relaunch elevated; privileged actions are blocked with a clear message when not running as Administrator.
- **Windows deployment scripts**: Hardened config path resolution, `installRoot` defaults, null-safe package manifest checks, Postgres user normalization (`Admin` → `postgres` / `riverside_app`), and `ros_schema_migrations` audit probe.
- **apply-riverside-migrations.ps1**: Safe property updates when `server` or JWT fields are missing from saved config.

### Removed
- **Stale `hotfix/` directory**: Deleted ~7,800 lines of duplicated deployment scripts that had fallen behind the canonical `deployment/windows/` copies, eliminating triple-maintenance burden and risk of running outdated scripts.

## [0.70.0] - 2026-05-19
### Added
- **Sweden-Style Cash Rounding**: POS transactions dynamically apply Sweden-style cash rounding (to nearest $0.05). Cash rounding offsets are recorded as a separate payment ledger entry (`cash_rounding_offset`) to ensure that base product prices, shipping, and tax lines are untouched and daily drawer reconciliation matches perfectly.
- **CoreCredit Financing**: Integrated consumer line-of-credit (CoreCard/CoreCredit) checks into checkout payment allocations.
- **ROSIE Local AI Copilot**: Powered by a local Gemma LLM sidecar under the strict ROSIE Operating Contract (RBAC constraints, user confirmation gates, no raw SQL).
- **Universal Search Aggregator**: Exposes `/api/search/aggregate` to search CRM, Catalog, Alterations, Weddings, and Help in a single backend call.
- **Transaction Backdating**: Checkout terminal supports booking date overrides to adjust commission and QBO entries.
- **Dynamic Shortcuts**: Combined deterministic backend commands and dynamic Rosie AI search intents in the `GlobalCommandSearch` dialog without duplication.

### Fixed
- **Responsive & QBO Test Stabilization**: Scope locators in `pwa-responsive.spec.ts` to ensure 100% pass rate on responsive/PWA E2E tests.
- **Database Scrubbing**: Added `ros-wipe-business-data-keep-bootstrap-admin.sql` to safely purge all development/testing activity while leaving the seed/bootstrap system metadata and admin users intact.
- **Host Service Commissioning**: Documented and verified startup task integration (`install-server.ps1` registering Axum API as a Scheduled Task and PostgreSQL as an Automatic startup service).

## [0.60.2] - 2026-05-19
### Added
- **Modernized Deployment Manager**: Rebuilt the legacy WinForms/PowerShell deployment manager as a robust, interactive React + Tauri desktop application.
  - **Installation Wizard**: Added a step-by-step UI for choosing station roles (Server vs. Register) and configuring network/database credentials via WowDash design tokens.
  - **Live Execution Streaming**: Decoupled deployment execution from the UI, streaming stdout/stderr directly from the classic PowerShell installation scripts into a live terminal block.
  - **Maintenance & Repair Dashboard**: Restored and expanded all legacy deployment utility functions into a dedicated tab.
    - **Server Control**: Start, Restart, Open Logs, and Check Package utilities.
    - **Database & Migrations**: Apply Migrations, Seed Database, and Factory Reset triggers.
    - **Utility Scripts**: Force ROSIE AI Updates, Sync Counterpoint Bridge, Repair Credentials, and Bootstrap Admin accounts.
  - **Zero-Friction Updates**: Included an inline PowerShell executor to enable rapid invocation of ad-hoc diagnostic scripts directly from the UI.

## [0.60.1] - 2026-05-19
### Changed
- Added known-host selection to the sign-in **API Host Settings** flow while preserving manual IP/URL entry for Register and PWA setup.
- Bumped release metadata to `0.60.1` across package, server, Tauri, and deployment-package defaults for the updater hotfix lane.
- Renamed the Bug Reports "Download for Codex" action to **Download AI diagnostic** so it is tool-agnostic.

### Fixed
- Added a server-side printer readiness endpoint so PWA/browser receipt stations can verify the server-to-printer TCP path before checkout.
- Updated printer settings so network receipt and Zebra tag checks use the same direct readiness path in browser/PWA and desktop contexts.
- Updated staff Help content for API host setup and PWA receipt-printer readiness behavior.
- Fixed ROSIE showing as unavailable on production: `server/src/launcher.rs` now calls `ensure_rosie_upstream_from_local_llama()` at startup to auto-set `RIVERSIDE_LLAMA_UPSTREAM` from `RIVERSIDE_LLAMA_HOST:RIVERSIDE_LLAMA_PORT` (default `127.0.0.1:8080`), bridging the Tauri-managed sidecar with the Axum ROSIE proxy for satellite clients.
- Fixed default LLM model path mismatch: both the server and Tauri sidecar now look for the **Gemma 4 E2B** model (matching `MODEL_PIN.json`) under `%LOCALAPPDATA%\riverside-os\rosie\` on Windows and `~/Library/Application Support/riverside-os/rosie/` on macOS — previously the code looked for the non-existent E4B variant.
- Wired the ROSIE AI stack into `install-server.ps1`: server installation now automatically downloads the pinned Gemma E2B GGUF (SHA256-verified), installs `sherpa-onnx` via `uv`, and fetches SenseVoice STT and Kokoro TTS models. Writes `RIVERSIDE_LLAMA_*` into the server `.env`. Supports `-SkipRosieSetup` for air-gapped installs.
- Added `MODEL_PIN.json` to the deployment package (`build-deployment-package.ps1`) so the installer can resolve the pinned model without hardcoded fallback values.
- Added `Install-RosieAiStack.ps1` / `Install-RosieAiStack.cmd` to the server hotfix package: a standalone ROSIE setup tool for existing Server PCs that downloads all required models and patches the running `.env` without a full server reinstall.

## [0.60.0] — 2026-05-17
### Added
- Added Windows desktop app recovery for the Backoffice / Server PC: when the local API is unreachable on sign-in, the app can start the installed `Riverside OS Server` scheduled task and retry the staff roster check.
- Added a single-release version contract: `/api/version` exposes the server release, `npm run check:version` verifies root/client/server/Tauri metadata parity, and Windows release workflows fail when release metadata disagrees.
- Added the POS Wedding Register workflow documentation covering customer wedding detection, checklist-driven item add, measurement gating, and Wedding Manager source-of-truth rules.
- Added Podium Inbox direct texting: staff can send SMS to an existing customer or enter a new phone number with first/last name to create a Podium-sourced contact before sending.
- Added Podium communications hardening for inbox health, provider sync, unmatched conversation review, webhook failure logging, mailbox/customer communication timeline visibility, and review invite provider status sync.
- Added Register transaction backdating from the live cart date/time control, with checkout persistence into reporting and QBO-effective dates for that transaction only.

### Changed
- Updated v0.50 GOLD release-certification documentation to reflect the 2026-05-14 Playwright evidence: the standard release gate passed with 310 passed / 31 skipped / 0 failed, and the previously skipped environment/visual-gated lanes were certified separately with 31 passed / 0 skipped / 0 failed.
- Replaced the Windows/Tauri placeholder app icon assets with the Riverside logo mark.
- Updated the Settings → Updates surface to show one `Riverside version`; Windows app, PWA/web app files, and server API mismatches are now reported as `Update incomplete` diagnostics instead of separate normal versions.
- Hardened the Windows updater release workflow so it clean-builds/verifies the client bundle and removes old Riverside MSI/signature/manifest assets before uploading the current release assets.
- Documented the Wedding Manager to Register handoff across the fulfillment contract, cutover design, and staff Register/Weddings guides.

### Fixed
- Allowed pennyless cash rounding on negative refund checkouts so a rounded cash payout can allocate back to the returned transaction without blocking payment finalization.
- Expanded Podium Inbox sync to page through current provider conversations and keep recent unmatched provider threads ordered ahead of older synced rows.
- Hardened release documentation around visual baseline, Payments Operations, Back Office sign-in, and E2E environment requirements so the certification record no longer treats those lanes as unresolved skips.
- Restored the Register salesperson requirement across normal Pay, special-order Review Order, and checkout-finalize paths; the server now rejects sale lines without a sale-level or line-level salesperson.
- Prevented the Windows desktop app from using the PWA service-worker update/cache path so an updated shell cannot keep rendering stale web app files.

## [0.4.5] — 2026-05-07
### Added
- Added online store workspace, merchandising, checkout, and store operations surfaces.
- Added in-app update manager and Windows deployment package workflow support.
- Added Helcim-focused Payments Operations documentation for event logging, fee sync, batch/settlement reconciliation, issue resolution, actual bank deposit matching, automation alerts, and test coverage.
- Added staff-facing Payments Operations guidance covering Overview, Batches, Reconciliation, Transactions, Deposits, Health, permission-gated actions, and expected-vs-actual deposit language.
- Added secure integration credential storage and unified credential settings.
- Added RMS account list snapshots and manual-first RMS Charge handling.
- Added Counterpoint cutover reconciliation for customers, inventory, open docs, category/vendor mappings, inventory fidelity checksums, and mismatch diagnostics.
- Added promo gift cards with event names, one-year expiration, POS tender support, and QBO expense mapping.

### Changed
- Bumped application/package metadata to `0.4.5` across root, client/POS, server, and Tauri manifests/lockfiles.
- Replaced card payment operations with Helcim-centered terminal routing, settlement, webhook logging, and shared-terminal support.
- Strengthened Windows deployment provenance, installer package behavior, and local deployment manager setup.
- Updated Counterpoint gift card and loyalty migration behavior to snapshot-only balances for cutover.
- Documented the schema-contract reset: active baseline migrations `001` through `008`, legacy pre-launch migration archive, separated seed phases, validation-only runtime startup, and schema guardrail scripts.
- Updated developer, local setup, E2E, and deployment docs to use baseline migrations plus `scripts/seeds/` instead of seed-like historical migrations.
- Updated developer, permissions, integration-scope, Settings, and E2E docs to reflect ROS-owned Helcim payment operations and the new `payments.*` permission boundaries.

### Fixed
- Hardened POS register startup flow and database pool sizing for deployment environments.
- Fixed CI/payment/offline blockers and hardened payments operations coverage.
- Fixed Counterpoint gift card snapshot behavior so historical ticket gift applications do not mutate imported current balances.
- Fixed Counterpoint transaction schema alignment and reconciliation visibility for cutover sign-off.
- Fixed Playwright local auto-boot readiness and Back Office navigation/sign-in helper stability for gift card browser smoke.

## [0.4.0] — 2026-05-01
### Added
- Deployment readiness audit for the production topology: Backoffice / Server PC, Register #1 Windows Tauri, Register #2 iPad PWA, and Windows laptop PWA/optional Tauri clients.
- Current deployment status sections documenting release artifact state, CI status, station install paths, and remaining go-live blockers.
- Step-by-step Windows server, Windows register, iPad PWA, and Windows laptop PWA installation checklists in the canonical deployment docs.
- Release documentation for the `v0.4.0` deployment-audit release candidate.

### Changed
- Bumped application/package metadata to `0.4.0` across root, client, server, and Tauri manifests/lockfiles.
- Clarified that `v0.4.0` requires fresh Windows installer/updater assets before station install, because the latest published Windows updater assets remain on the older `v0.2.1` release.
- Updated go/no-go guidance to keep the current Clippy failure and station hardware signoffs visible as release blockers.

### Fixed
- Corrected stale deployment doc links and clarified which guide is canonical for current deployment status.
 
## [0.3.4] — 2026-04-28
### Added
- **Store Events & Holidays Refinement**: 
  - Added **Holiday (Closed)** as a dedicated event kind with distinct visual rendering.
  - Implemented **Numerical Dates** in the print header (e.g., "Mon 27") for better date-of-month clarity.
  - **Unified Event Badges (H/E/M)**: New color-coded badge system for shift boxes:
    - **H (Red)**: Holiday / Store Closed.
    - **E (Green)**: Store Event / Training.
    - **M (Amber)**: Meeting.
- **Professional Print Overhaul**:
  - Full-page landscape utilization with high-density legibility pass.
  - **Large Bold Rendering**: Holidays and Events now use a massive 16px font in the header row for maximum visibility.
  - **Flexible "OFF" Labels**: The printout now respects custom non-working reasons like **"VAC"**, **"REQ OFF"**, and **"REQ"** instead of defaulting to generic "OFF".

### Fixed
- **Cloning Logic 500 Error**: Resolved a critical database schema mismatch that crashed the "Copy from Last Week" function.
- **Event Persistence**: Fixed a server-side loading bug where "Holiday" and "Event" types would reset to "Meeting" upon reload.
- **Print Button Crash**: Resolved a JavaScript error in the print builder caused by a missing date variable.
- **Filtering**: Staff marked as "Template" with zero hours are now correctly excluded from the printed schedule to save space.

### Changed
- **Header Unification**: All store events (not just holidays) now use the 16px bold font size in the professional print header.
- **Visual Grid**: Updated the Planning Grid to use red backgrounds for Holidays and star (★) icons for better at-a-glance recognition.

## [0.3.3] — 2026-04-26
### Changed
- **Standardized Stacking Tiers & Portaling Mandate (v0.3.3+)**: Completed a systemic sweep of the entire UI overlay architecture to resolve "buried" interactive elements.
  - Every Modal, Drawer, Wizard, and system prompt now uses `createPortal` targeting `#drawer-root` in `index.html`.
  - Enforced tiered z-index: **`z-100`** (Drawers/Hubs), **`z-200`** (Modals/Wizards), **`z-300`** (System Priority — Toasts, PWA Prompts).
  - All overlays use the **`.ui-overlay-backdrop`** CSS class for consistent background layering behavior.
  - Added the `Standardized Stacking Tiers & Portaling Mandate` section to `docs/CLIENT_UI_CONVENTIONS.md` and `UI_STANDARDS.md`.

### Fixed
- **Transaction Detail Drawer sub-modals** (Refund, Receipt, Attach to Wedding) no longer render behind their parent drawer.
- **Inventory Control Board** modals (Stock Adjustment, Maintenance/Damaged, Tag Print) portaled and stacked correctly.
- **Cart** inline Edit Order Payment modal portaled correctly.
- **`InventoryControlBoard.tsx`**: Added missing `createPortal` import from `react-dom`.
- **`PwaUpdatePrompt.tsx`**: Resolved a structural parsing error (premature function close) that caused `showInstallPrompt` and `handleInstall` to be inaccessible. Both the Update and Install prompt branches are now correctly structured within the component.
- Extended E2E coverage in `ui-portaling-stacking.spec.ts` for refund modal stacking, receipt modal stacking, and inventory adjustment portaling.

## [0.3.2] — 2026-04-26
### Added
- **Exchange/Return Wizard Redesign**: 
  - Comprehensive UI overhaul with a larger `3xl` width modal and "WowDash" glassmorphism (`backdrop-blur-xl`).
  - Phase-based navigation with guided "Active Instruction" panels and high-fidelity item triage.
- **60-Day Global Return Policy**:
  - Unified policy allowing returns/exchanges up to 60 days from any session.
  - Automatic escalation to **Manager PIN** override for transactions older than 60 days.
- **RBAC Auto-Synchronization**:
  - Profile role updates now automatically sync `staff_permission` sets and `max_discount_percent` while preserving manual overrides.
- **Hardware & Receipts**:
  - **Logo Support**: Added `ReceiptLine` logo support for thermal printers.
  - **Rich Attribution**: Receipts now include Cashier and Salesperson names.
  - **Builder Refinement**: Enhanced Receipt Builder panel with ESC/POS logic hardening and dedicated settings endpoint.
- **POS Intelligence**:
  - **Barcode Scanning**: Support for transaction lookup via receipt barcode scan.
  - **Tender Hardening**: Restricted purchased gift cards to the register and clarified shipping paths.
  - **Event Tracking**: Enhanced register payment tracking and detailed error event logging.
- **Mobile & PWA**:
  - Comprehensive small-screen workspace layout improvements for PWA use.
  - Expanded E2E coverage for small-screen audit and responsive flows.
- **Help Center**: Added controlled authoring for in-app help documentation.

### Changed
- **Unified Transaction Nomenclature**: Finalized the systematic renaming of "Orders" to **"Transactions"** across all financial ledger UI, API endpoints, and permission labels (e.g., `OrderSearchInput` → `TransactionSearchInput`).
- **Commission Architecture**: Reworked commissions into a dedicated reporting ledger for better auditability.
- **QBO Bridge**: Aligned staging logic with the revenue recognition basis.
- **Workspace UI**: Harmonized layouts between Orders and Alterations hubs.
- **Permissions**: Updated the Permission Catalog documentation in the UI to reflect the 60-day Manager PIN requirement.

- **CI Hardening & E2E Stability**:
  - Implemented explicit waits and stable test-IDs in the POS staff identity selection flow to resolve flaky "Target closed" failures.
  - Standardized staff selection helpers across POS and Back Office to use the new `staff-selector-button` and `staff-selector-dropdown` contracts.
  - Finalized the deprecation of **ZPL** receipts; removed stale server-side ZPL generation logic and updated all system defaults and error fallbacks to **ESC/POS**.
  - Pruned obsolete ZPL assertions from E2E coverage to eliminate false-positive CI failures.
- **Tax Integrity**: Hardened tax category controls and server-side checkout validation truth.
- **Meilisearch**: Resolved orders index synchronization and health status reporting bugs.
- **UI Navigation**: Fixed Operations dashboard card navigation and commission drilldown row keys.
- **Hardware**: Fixed alignment and wrapping bugs in ESC/POS receipt lines; tightened Epson hardware handshake.
- **Return Wizard**: Resolved a critical 422 Unprocessable Entity error caused by a schema mismatch on transaction line IDs and fixed walk-in exchange status checks.
- **React**: Fixed "unique key" warnings in the Exchange/Return item lists.
- **Backend**: Fixed compilation errors in `TransactionDetailResponse` and related summaries following the nomenclature refactor.
- **Correctness**: Fixed commission return adjustment drift and cargo fmt/clippy warnings in server.


## [0.3.1] — 2026-04-25
### Added
- **Production hardening audit package** with ranked audit report, fix plan, go/no-go checklist, coverage gap matrix, SQL audit probes, and local restore/probe evidence for Hybrid Tauri Host retail readiness.
- **Release-blocking audit contracts** for checkout tender financial truth, NYS/Erie tax behavior, commission payout timing, inventory truth, offline checkout recovery, register close, and QuickBooks staging/business-date behavior.
- **Release evidence docs** covering the `181 passed, 7 skipped, 0 failed` full local release gate and remaining human/hardware/QBO/restore signoffs.

### Changed
- Removed the POS UI E2E quarantine by adding explicit POS readiness contracts; the formerly quarantined POS specs are back in the release gate.
- QBO proposal and drilldown date windows now use configured store-local business date instead of naive UTC calendar cutoffs, with `business_timezone` carried in staging payloads.
- Updated offline/recovery staff documentation to explain blocked checkout recovery and close blockers.
- Bumped application/package metadata to `0.3.1`.

### Fixed
- Stabilized CI Playwright coverage for RMS receipt assertions and tax/QBO fixture isolation.
- Hardened offline checkout replay so 4xx responses retain blocked recovery rows instead of silently deleting queued sales; register close now blocks while checkout recovery is pending or blocked.
- Hardened register close parked-sale cleanup so server-backed parked sales are purged inside the close transaction with audit rows.
- Hardened checkout tender handling by rejecting check tender without a check number and preserving split-tender/cash-rounding ledger traceability.
- Hardened QBO approval/sync so unbalanced staged journals cannot be approved or synced.
- Hardened restore safety with preflight checks, backup catalog membership checks, strict-production guards, and local non-production restore drill evidence.

## [0.3.0] — 2026-04-25
### Added
- **Operational Perfection release** focused on clearer day-to-day workflows, staff-facing visibility, and safer guided decisions across existing modules.
- **Alterations workbench improvements** with garment-centered queue visibility, open-work summary cards, due/status/source filtering, search, Customer Profile alteration visibility, and universal search/Meilisearch coverage.
- **Customer intake refinements** with a more compact Add Customer drawer, duplicate review safeguards, address lookup feedback, and QuickBooks credential settings.
- **Existing order payment allocation foundation** for safely allocating checkout tender across today’s sale and existing open transaction balances without mutating order line items.
- **Operational dashboard visibility** for alteration workload and data-quality signals.

### Changed
- Unified dark shell styling across Back Office and POS/Register surfaces while keeping cards, panels, inputs, and tables readable.
- Refined Customer Profile tab order and renamed Messages to Communications for a clearer CRM flow.
- Updated Register order payment UI to expose safe existing-order payment lines in the current sale.
- Tightened help/staff documentation for visible workflow changes.

### Fixed
- Replaced the embedded full Alterations Hub in Customer Profile with a compact customer-specific alteration section.
- Fixed GitHub Actions failures from stale Alterations E2E selectors and SQLx macro usage in Meilisearch reindexing.
- Improved Alterations workbench layout so long lists and long garment text stay inside their sections.

## [0.2.1] — 2026-04-18
### Added
- **Printing & Layout Refactor**: 
  - Renamed hardware settings to **Printers & Scanners** to include support for barcode/QR peripherals.
  - Removed the redundant **System Control** sidebar in favor of a unified main-sidebar navigation, enabling **Full Workspace** width for all settings panels.
  - Moved **Receipt Builder** and **Tag Designer** to dedicated sections in the main sidebar for better organizational clarity.
  - **Live Thermal Preview**: Integrated the `receiptline` library into the Receipt Builder to provide a high-fidelity, CLI-style preview for legacy thermal (Standard) modes.
  - **Standard Mode Consolidation**: Integrated previously fragmented thermal settings (Store Identifier, Address/Phone toggles) directly into the Unified Receipt Builder.
- **Unified Hybrid Model**: 
  - Merged the standalone Backend Server (Rust Axum) into the Tauri app shell. 
  - Enabled **"Shop Host Mode"** in Settings, allowing a single desktop instance to manage the database and background workers (QBO, Messaging, Backups) for the entire shop.
  - Implemented **"One-Click Universal Updates"**, ensuring the server engine and register UI update in lockstep via the ROS updater.
- **Tailscale Remote Access Integration**: 
  - Integrated `tailscale` CLI management into the Settings workspace.
  - Added **MagicDNS QR-Code Onboarding**, allowing mobile devices to scan and instantly launch the ROS PWA via the private VPN.
  - Implemented **Tailscale Identity Auditing** (`whois`), allowing the server to identify which remote staff member is accessing the system.
  - Added a persistent **"Remote Node"** visual indicator in the Global Top Bar and Sign-In Gate when accessed via Tailscale.
- **Node.js Polyfill Architecture**: Instrumented the Vite build with `vite-plugin-node-polyfills` and explicit aliases (`util`, `stream`, `buffer`, `process`) to support SDK-level libraries in the Tauri browser environment.
- **ROS Dev Center (v1)**:
  - Added **Settings → ROS Dev Center** with Operations Health, Station Fleet, Alert Center, Guarded Actions, and Bug Manager overlays.
  - Added `/api/ops/*` contracts for health snapshots, integration status, station heartbeats, alert acknowledgement, guarded action auditing, and bug-incident linking.
  - Added permissions **`ops.dev_center.view`** and **`ops.dev_center.actions`** with strict admin-default role templates.
- **Integrated Wedding Management Hub (v0.2.1+)**: 
  - Restored the integrated Wedding Management Hub directly within the POS shell, enabling staff to transition between sales and logistical management without shell switching.
  - Implemented `pendingWmPartyId` state for seamless deep-linking from the Register Dashboard and Global Search.
  - Added a **"Manage Party"** quick-action to the Wedding Lookup Drawer for rapid context switching.
  - Refactored `navigateWedding` to prioritize the active POS mode, preventing unnecessary redirects to the standalone Wedding shell.
- **Reporting and migration hardening**:
  - Added migration **149** for ROS Dev Center telemetry/audit schema.
  - Added migration **150** restoring `reporting.order_lines.line_gross_margin_pre_tax` and keeping migration probes in sync.

### Changed
- **Release-candidate parity documentation**:
  - Documented local RC/runtime prerequisites, deterministic E2E stack ports, root/client install requirements, and local Metabase shared-auth expectations.
  - Added explicit RC signoff and operational signoff artifacts for final release review.

### Fixed
- **Release hardening and validation**:
  - Hardened production-facing config guidance for API base selection, CORS, storefront JWT secrets, and frontend dist expectations.
  - Corrected returns/exchanges checkout null handling and aligned receipt/reporting behavior with return-adjusted quantities.
  - Hardened RMS payment collection receipt/reporting behavior and unified historical Z-close reporting to canonical Register #1 rows.
  - Restored deterministic RC E2E execution, including the exchange flow, tender matrix coverage, and root `npm run pack` packaging workflow.

## [0.2.0] — 2026-04-16
### Added
- **Full-Width Workspace Modernization**: Transformed all primary workspaces (Orders, Customers, Inventory, etc.) into a high-performance, edge-to-edge layout. Deprecated nested scrolling in favor of native root document scrolling for a smoother "Pro" experience on 1080p, 1440p, and iPad 11 Pro screens.
- **Customer Relationship Hub Overhaul**: Modernized the Customer Profile UI with "WowDash" glassmorphism, financial KPIs (Lifetime Sales, Balance Due), and a tabbed interface distinguishing between financial Transactions and logistical Fulfillments.
- **Sticky Navigation Enforcement**: Optimized `GlobalTopBar` and `Sidebar` with persistent sticky positioning to anchor navigation during root scrolling.
- **Workspace Density Pass**: Refactored the Customers Workspace for high-density, full-page presentation.
- **Zero-Error Hygiene**: Achieved a 100% clean TypeScript and linting state for the modernization baseline.

### Fixed
- **Checkout Shadowing Vulnerability**: Resolved a critical 500 Internal Server Error in `transaction_checkout.rs` caused by variable shadowing of `transaction_id`. Renamed inner payment records to `payment_tx_id` to ensure correct `payment_allocations` referencing.
- **Case-Insensitive Tax Compliance**: Hardened `client/src/lib/tax.ts` and server-side logic to treat tax categories (e.g., "Clothing") as case-insensitive, ensuring consistent $110 NYS tax exemptions.
- **Light Mode Visual Performance**: Resolved visibility and contrast regressions in POS slideouts ("Finalize Pricing", "Confirm Item") by replacing hardcoded white text with themed semantic tokens (`text-app-text`).
- **Product Hub Layout**: Fixed a z-index surfacing issue in the inventory intelligence panel that obstructed navigation in specific viewports.

### Changed
- **Repository Capacity Optimization**: Reclaimed ~38 GB of disk space by purging redundant Rust target artifacts and cleaning legacy log files.
- **Documentation Alignment**: Synchronized `AGENTS.md`, `TRANSACTIONS_AND_WEDDING_ORDERS.md`, and `AI_REPORTING_DATA_CATALOG.md` with the latest financial integrity invariants and architectural renames.

### [0.2.0] — 2026-04-13 [In Progress]
### Added
- **Professional Reporting Architecture**: High-fidelity Letter/A4 audit documents (Z-Reports, Daily Sales) with decoupled hardware routing (System Print station).
- **Privacy Standard (Receipt Naming)**: Masked "First Name + Last Initial" format on all customer receipts.
- **Persistent Top Bar Architecture**: Introduced a universal, touch-friendly navigation anchor across all shells. Features persistent staff identity, universal breadcrumbs, centered search lookup, and a centralized "System Actions" group (Help, Bug Reports, Notifications, Theme).
- **Transaction-Centric Backend Refactor**: 
  - Systematic renaming of "Orders" to **"Transactions"** throughout the backend logic, API, and database models.
  - Standardized on `transaction_id` and `transaction_lines` to decouple financial ledger entries from logistical fulfillment objects.
  - Refactored core modules: `order_checkout` -> `transaction_checkout`, `order_list` -> `transaction_list`, etc.
  - Migration 142 formally established the `transactions` table and the new helper `fulfillment_orders` logistical registry.
- **Migration Invariant**: Mandatory `DROP VIEW IF EXISTS` for view-altering migrations.
- **Reporting Stabilization (Migration 143)**: Established the `reporting.transactions_core` and `reporting.fulfillment_orders_core` views as the new stable baseline for auditable financial and logistical reporting.
- **Avatar Path Resolution**: Robust multi-path resolution for staff portraits.
- **Audit Recovery**: New manual and emergency PIN reset scripts.
- **Layaway Manager (v2)**: 
  - Restored and hardened the **Layaway Manager** in POS with robust URL construction.
  - Integrated a centralized **Layaway Manager** workspace into the Back Office **Customers** section.
  - Resolved backend SQL decoding errors in order list.
- **Financial Accuracy (QBO Deposits)**: 
  - Automatically captures **New Deposit Inflows** (Credit Liability) for payments.
  - Ensured balanced journal cycle for all deposit lifecycle states.
- **Staff Lifecycle Management**: Implemented an "Add Staff" action in the Back Office roster, complete with an auditable creation API (`POST /api/staff/admin`) and automatic role-default application.
- **Optimized Administration UI**: Refactored the Staff Edit slideout using a search-first, high-density layout with robust sticky navigation and resolved visual regressions in the CRM search dropdown.

### Fixed
- **Schema Stabilizer**: Repaired table references in migration 135.
- **Authentication UX**: Restored **Full Names** for internal identification screens.
- **Build & Linting**: Fixed float ambiguities and reporting TypeScript types.
### Added
- **Unified PIN Authentication & UX (Auditable Authorization)**: 
  - Systematic terminology migration from legacy "Cashier Code" to **"PIN"** across the entire UI and backend.
  - **Persistent Identity Selection**: Integrated user roster dropdowns into all primary authentication gates (Back Office and POS). Selection is preserved via `localStorage`.
  - **Global Hardware Support**: Unified `NumericPinKeypad` with global keyboard listeners (0-9, Backspace, Enter) for rapid entry.
  - **Role-Based POS Authorization Bypass**: Implemented a dynamic permission-based skip for sensitive POS actions. Users with the `admin` role now automatically bypass manual PIN verification for **Order Attribution**, **Void All**, and **Large Price Overrides**.
  - **Auditable Manager Approvals**: Deployed the **Manager Approval Modal** for non-administrative staff. This allows any manager to authorize a high-risk action without changing the active cashier's session.
  - **System-Wide Authorization Logging**: Enhanced the `/api/auth/verify-pin` endpoint to record `authorize_action` and `authorize_metadata` in the `staff_access_log`.
- **Modularized POS Architecture**: Successfully transitioned the monolithic POS Cart to a high-performance modular hook system (`useCartActions`, `useCartCheckout`, `usePosSearch`).
- **RESTORED: Order Recall & Direct Pickup**: Fully restored the POS "Orders" recall functionality.
- **RESTORED: Parked Sale Snapshotting**: Re-enabled the ability to "Park" active sales to the server. Added a new **"Park Sale"** button to the main Register tool row, complete with server-backed snapshots and auditable recall.
- **RESTORED: Order Metadata Management**: Integrated the "Order Review" workflow into the checkout process.
- **Enhanced Cart Visualization**: Added real-time indicators to the Cart line items for **Rush** (Zap) and **Due Date** (Clock).
- **RESTORED: Intelligence & Decision Support Layer**: Finalized the integration of production-grade decision engines (Wedding Health, Inventory Brain v2, Truth Trace).
- **Simplified Register Standard**: Reduced complexity by limiting physical terminal lanes to exactly 3:
  - **Register #1 (Main)**: Controls the primary cash drawer and reconciliation.
  - **Register #2 (iPad)**: Reserved for mobile satellite sales.
  - **Register #3 (Back Office)**: Reserved for administrative activities and Headquarter sales.
- **Automatic Session Expansion**: Opening Register #1 now automatically initializes zero-float satellite sessions for Register #2 and #3, eliminating the need to manually open satellite lanes.
- **Admin Lane Default**: The Back Office POS entry now correctly defaults to Register #3 when the main drawer is active.
- **X-Report Deprecation**: Finalized the removal of legacy mid-shift snapshots in favor of real-time dashboards and unified Z-reconciliation.
- **Documentation Overhaul**: Synchronized all staff manuals and engineering guides with the new 3-register model.

### Changed
- **UI Normalization Sweep**: Reverted "Cinematic GUI" experimental styles (extreme rounding and 8px borders) to the production-grade design baseline (28px rounding, 2px borders).
- **Documentation Overhaul**: Synchronized all project documentation (`README.md`, `DEVELOPER.md`, `AGENTS.md`) and staff manuals with the current state of the application.
- **Modularized Cart State**: Centralized POS state management in the `useCartActions` hook.

### Fixed
- **Structural Build Errors**: Resolved 100+ blocking TypeScript errors introduced during the v0.2.0 transition.
- **Operations & Dashboard Stabilization**: 
  - **`RegisterDashboard.tsx`**: Removed orphaned `xReport` state and fetcher logic. Optimized `lucide-react` imports and removed unused props (`lifecycleStatus`, `onGoToTasks`). Fixed unsafe `any` type in Morning Compass queue mapping to properly handle `rush_order` and `task` kinds.
  - **`OperationalHome.tsx`**: Cleaned up unused Lucide icons (`Clock`, `ListChecks`, `Sparkles`) and removed the abandoned `pulseRows` variable to eliminate linting warnings.
  - **`WeddingHealthHeatmap.tsx`**: Hardened the component with explicit interfaces (`WmParty`, `PartyWithHealth`) and resolved "module not found" errors by updating `api.d.ts` and adding `Icon.d.ts`. Removed unused `catch` variables.

### Removed
- **Redundant Auth Gates**: Eliminated legacy PIN unlock overlays in `StaffWorkspace.tsx` that were redundant with the top-level Back Office gate.

## [0.1.9] — 2026-04-11
### Added
- **Helcim Power Integration**: Finalized the "Zero-Touch" PCI-compliant card vaulting flow and unlinked terminal credits. Staff can now save customer cards in the Relationship Hub for phone orders and issue credits directly back to cards when cart balances are negative.
- **Wedding Party Order Integration**: Implemented "Attach to Wedding" functionality in `OrdersWorkspace` to allow manual linking of legacy Counterpoint tickets to wedding party members.
- **Zero-Error Baseline Stabilization**: Achieved a 100% clean TypeScript build by resolving lingering type errors in `App.tsx`, `LoyaltyWorkspace.tsx`, and `CommissionManagerWorkspace.tsx`.
- **Relationship Hub Gating**: Ensured all Customer Hub tabs (Orders, Profile, Measurements, Payments) correctly respect RBAC permissions.
- **Help Center Manager E2E Expansion**: Added Playwright coverage for Settings navigation into Help Center Manager, tab visibility checks (Library, Editor, Automation, Search & Index, ROSIE readiness), and request-shape assertions for `generate-manifest` and `reindex-search` admin operations.
- **Help Admin API Gate Coverage**: Expanded `api-gates.spec.ts` with anonymous (`401`), non-Admin (`403`), and Admin success-shape checks for `/api/help/admin/ops/status`, `/api/help/admin/ops/generate-manifest`, and `/api/help/admin/ops/reindex-search`.
- **High-Risk Regression API Suite**: Added `high-risk-regressions.spec.ts` to cover migration-smoke route mounting, NYS tax audit shape/auth checks, revenue basis alias stability (`booked`/`sale`/`completed`/`pickup`), Help Manager RBAC + payload stability, session route auth behavior, and non-admin boundary enforcement on sensitive insights/help admin endpoints.
- **Phase 2 E2E Rollout (Finance + Help Lifecycle)**: Added `phase2-finance-and-help-lifecycle.spec.ts` with end-to-end admin policy lifecycle assertions for Help manuals (update + verify persistence + delete/revert), plus finance-sensitive endpoint contract checks for NYS tax audit payload stability, sales-pivot basis invariants, payments/session auth gates, and non-admin boundaries.
- **Deterministic Tender Matrix Contract Suite**: Added `tender-matrix-contract.spec.ts` to validate payment-intent and cancel endpoint behavior across tender modes (manual card/MOTO, reader card, saved-card invalid PM guardrails, credit-negative rejection, and session-safe non-card path checks) with deterministic API-level assertions.
- **E2E Stability Hardening**: Improved test resilience for Settings/Reports navigation timing by reducing dependence on brittle response timing and strengthening UI-ready assertions in the Podium and Reports workspace specs.

### Changed
- **UI Spacing Refinement**: Adjusted spacing and density across Back Office workspaces for better consistency with the high-density CRM overhaul.
- **Project Structure**: Formally updated all project modules to v0.1.9.
- **Test-Run Hygiene Documentation**: Clarified E2E run expectations around service availability (UI + API) to avoid false-negative `ERR_CONNECTION_REFUSED` failures when the frontend host is not running.
- **Visual Suite Policy**: Standardized visual baseline tests as opt-in (`E2E_RUN_VISUAL=1`) and non-blocking by default to avoid release failures caused by cross-machine font/render snapshot drift.
- **Visual Determinism Defaults**: Hardened Playwright runtime defaults for visual consistency by setting deterministic context controls (animations disabled, UTC timezone, en-US locale) and richer failure artifacts in visual mode.
- **E2E Coverage Depth**: Expanded release-focused Playwright inventory to include additional Phase 2 finance/help lifecycle regression checks for stronger release confidence on tax, reporting basis, admin policy persistence, RBAC boundaries, and tender contract safety.
- **CI Stabilization Hotfix (post-0.1.9 cut)**: Corrected server-side SQLx query typing for Meilisearch order sync, refreshed SQLx prepared query metadata under `server/.sqlx`, and resolved strict Clippy blockers that were preventing `Lint Checks` and `Playwright E2E` from progressing past server build.

## [0.1.8] — 2026-04-11
### Added
- **Morning Compass Evolution**: Formalized `RushOrderRow` and `needsOrder` tracking in the dashboard queue.
- **Custom Work Manual**: New in-app help for tailored services and rush fulfillment workflows.
- **Backup Resiliency Manual**: Documented "Universal Docker Fallback" for database operations.
- **Production-Ready Indexing**: Automatically generated help manifest to sync new manuals with the UI.

- **CRM High-Density Overhaul**: Transformed the Customer list into a visually stunning, name-dominant interface with combined financial/wedding data and tighter spacing.
- **Commission Manager Workspace**: Unified tracking for payouts, promo overrides, and combo rewards in a high-density Back Office hub.
- **SPIFF Incentive Engine**: Implemented specificity-based commission overrides (Variant > Product > Category) and a combo matching engine with strict single-salesperson attribution.
- **Receipt Privacy & Internal Filtering**: Standardized staff names on receipts as "First Name + Last Initial" and automated the filtering of internal SPIFF/Combo lines from customer-facing output.
- **CI/CD Resilience Hardening**: Implemented 30s Playwright buffers and codified 'GitHub CI Resilience' rules in `AGENTS.md` to ensure zero-failure deployments.
- **Navigation Sync**: Synchronized 'daily-sales' ID between Operations and Sidebar to maintain flawless navigation.


## [v0.1.8-alpha] - 2026-04-10 (Baseline)
### Added
- **Lightspeed Asset Recovery**: Integrated the Universal Importer with specific support for Lightspeed CSV headers, enabling bulk restoration of stock levels and asset valuation ($321k+ recovery case).
- **Live Indexing Visibility**: Refactored Meilisearch monitoring to show real-time "Indexing..." pulses and row count polling, eliminating "black box" behavior during mass data ingestion (114k+ records).
- **Counterpoint Staff Sync**: Formally enabled `SYNC_STAFF` with optimized queries for Users (`SY_USR`), Sales Reps (`PS_SLS_REP`), and Buyers (`PO_BUYER`). Implemented server-side consolidation to merge duplicate identities across tables.
- **Inventory Visibility**: Verified 114,000+ variants are fully indexed in Meilisearch.
- **System Stability**: Decoupled Bridge from main dev process to prevent network-related API crashes.
- **Bridge Operation Modes**: Implemented "Manual Mode" (default) for the Counterpoint Bridge. Continuous 15-minute polling is now disabled on startup and must be explicitly toggled ON via the Bridge Commander dashboard.
- **On-Demand Pulls**: Refined the Bridge Command UI to support targeted entity pulls (e.g., just Customers or just Inventory) while maintaining dependency order.
- **Custom Work Order Flow**: Implemented "MTM Light" SKU detection (`CUSTOM` prefix) and configuration modal for SUITS, SHIRTS, and more with variable pricing.
- **Rush Order & Urgency**: Added backend persistence and dashboard visibility for urgent orders with mandatory "Need By" dates.
- **Bridge (Tickets)**: Recovered **98,511 pending tickets** by implementing an item fallback mechanism. Sales history will now sync even if a legacy SKU is missing, ensuring accurate "Lifetime Spend" for all customers.
- **Catalog Architecture**: Fixed SKU hierarchy to match Counterpoint standards: `ITEM_NO` (I-XXXX) is the Parent/Handle, and `BARCODE` (B-XXXX) is the variant SKU. This resolves the synchronization blockages for historical sales.
- **Customer Identity**: Enhanced ticket linking to handle mixed ID formats (`114420` vs `C-114420`). Gary Garcia and others will now correctly see their historical spend attached to their primary loyalty profiles.
- **Meilisearch**: Fixed sync status reporting bug; totals now reflect the millions of records processed instead of only the last batch size.
- **Loyalty History**: Activated point-by-point history tracking for Counterpoint migrations.
- **Sales History Verification**: Confirmed historical ticket ingestion from `PS_TKT_HIST` is mapping correctly to `orders` and attributing spend to customer lifetime statistics (verified with customer Gary Bichler @ $1,695.34).

### Fixed
- **Meilisearch Sync Visibility**: Fixed a critical reporting bug where the server only recorded the size of the final processing batch for row counts. All indices (Customers, Products, Orders, etc.) now correctly report their total record volume instead of partial batch snapshots (e.g., 17,170 rows vs 170).
- **Counterpoint Identity Mapping**: Patched `counterpoint-bridge` to correctly map `ITEM_NO` to `product_identity`. This resolves a critical bug that caused 7,000+ duplicate "ghost" products to be created during synchronization.
- **Data Integrity Safety**: Implemented `catalog_handle` as the primary deduplication key for inventory recovery workflows.
- **System Tooling PATH**: Resolved "command not found" errors for `psql` and `docker` by correctly configuring `~/.zshenv` to include Homebrew and OrbStack paths for non-interactive shells.
- **Bridge Startup Regression**: Patched a critical syntax error in `counterpoint-bridge/index.mjs` (missing `tick` function declaration) that blocked system launch.
- **Gift Card History Sync**: Resolved a SQL error in `CP_GFT_CERT_HIST_QUERY` by replacing the invalid `RS_UTC_DT` column with the standard `DAT` column.
- **Launch Checklist Audit**: Updated `ThingsBeforeLaunch.md` with operational requirements for Custom/MTM flows, Rush Orders, and confirmed existing Gift Receipt functionality.
- **Bridge ↔ Metabase Port Conflict**: Resolved a critical port collision where both Metabase (Docker) and the Bridge Engine defaults conflicted on port 3001. Moved Bridge Command Center to port **3002**.
- **Bridge Commander CORS/Security**: Reconfigured the dashboard to open via HTTP (`http://localhost:3002`) instead of `file://` to resolve browser-enforced security blocks on synchronization requests.
- **Process Hygiene**: Implemented automatic cleanup of hanging server/Vite processes in the startup script to prevent `PoolTimedOut` and `EADDRINUSE` errors.

## [0.1.7] - 2026-04-10

### Fixed
- **Bridge Dashboard Stabilization**: Moved the Bridge Commander dashboard to port **3002** (eliminating port collisions with Metabase on 3001) and refactored manual sync triggers to use valid JSON payloads.
- **Schema Mapping Integrity**: Corrected SQL mapping in the Bridge for Counterpoint v8.2 (`UNIT_COST` and `CURR_AMT` parity).

## [0.1.6] - 2026-04-10

### Added
- **Unified Startup Script**: Created root-level **`START_ON_MAC.sh`** to orchestrate Docker context switching, container checks, and simultaneous launch of API, UI, and Counterpoint Bridge.
- **Bridge Integrated Into Dev Loop**: Added `dev:bridge` script to root `package.json`, allowing the sync engine to run concurrently with the API and UI in a single terminal session.

### Fixed
- **Bridge ↔ Metabase Port Conflict**: Resolved a critical port collision where both Metabase (Docker) and the Bridge Engine defaults conflicted on port 3001. Moved Bridge Command Center to port **3002**.
- **Bridge Commander CORS/Security**: Reconfigured the dashboard to open via HTTP (`http://localhost:3002`) instead of `file://` to resolve browser-enforced security blocks on synchronization requests.
- **Process Hygiene**: Implemented automatic cleanup of hanging server/Vite processes in the startup script to prevent `PoolTimedOut` and `EADDRINUSE` errors.

## [0.1.5] - 2026-04-10

### Added
- **Infrastructure Optimization (OrbStack Transition)**: Successfully migrated the local development environment from Docker Desktop to **OrbStack**, leveraging VirtioFS and native Apple Silicon optimizations for significantly faster container I/O and SQL performance.
- **OrbStack Management Guide**: Created `docs/ORBSTACK_GUIDE.md` detailing the "acid test" for engine identity, context switching, and socket linking protocols.
- **Docker Fresh Install**: Performed a clean build of all core services (`db`, `meilisearch`, `metabase`) on the new engine and successfully re-initialized the database schema with all 117 migrations.

### Changed
- **Documentation Alignment**: Updated all primary documentation (`README.md`, `DEVELOPER.md`, `AGENTS.md`) to reflect the move to OrbStack as the recommended Docker engine for macOS.

## [0.1.4] - 2026-04-10

### Added
- **Repository Hygiene & Capacity**: Reclaimed ~23 GB of disk space by purging redundant Rust build artifacts (`server/target`, `client/src-tauri/target`), removing unused local AI models (Gemma 2B), and cleaning legacy documentation blobs.

### Fixed
- **Settings Workspace Stabilization**: Resolved a `ReferenceError: tabs is not defined` that crashed the System Control panel. Refactored the sidebar to use a nested `groups` structure with section headers ("User", "Integrations", etc.) for improved UX organization.
- **API Endpoint Normalization**: Synchronized frontend `fetch` calls with server-side routes for **Podium** (`/api/settings/podium-sms`) and **Weather** modules.
- **REST Method Compliance**: Standardized all settings save operations to use `PATCH` instead of `PUT`, aligning with server-side Axum route definitions and technical debt reduction goals.
- **UI Interaction**: Restored vertical scrolling to the System Control sidebar via `overflow-y-auto` and the `no-scrollbar` utility.
- **Import Regression**: Repaired broken `backofficeHeaders` imports in `WeatherSettingsPanel.tsx` and `PodiumSettingsPanel.tsx` caused by an incorrect transition from library-based headers to hook-based authentication.

## [0.1.3] - 2026-04-10

### Fixed
- **Settings Workspace Stabilization**: Repaired structural JSX corruption in `SettingsWorkspace.tsx` and updated the modular `InsightsSettingsPanel` integration to restore a stable administrator UI.
- **Meilisearch Sync Performance**: Resolved Rust compilation errors in `meilisearch_sync.rs` related to Task indexing types.
- **Counterpoint Discovery Pipeline**: Patched the Counterpoint bridge validator logic by ensuring `CP_CUSTOMERS_QUERY` includes the mandatory `WHERE` and `ORDER BY` clauses required for store credit schema discovery.
- **Database Schema Health**: Applied Migration 115 to formalize `meilisearch_sync_status` tracking, resolving transient 500 errors in the Integrations dashboard.

## [0.1.2] - 2026-04-09

### Added
- **Search-First Administrative Mandate**: Systematically replaced manual UUID and SKU entry fields with fuzzy-search-powered components (`CustomerSearchInput`, `VariantSearchInput`) across Tasks, Appointments, Gift Cards, and Loyalty modules.
- **Meilisearch Sync Health Dashboard**: New visual interface in Settings → Integrations providing real-time visibility into index health, row counts, and synchronization success/failure for all tracked categories.
- **Physical Inventory Fallback**: Added a manual search and add capability to the inventory counting phase, allowing staff to lookup products without a physical barcode.
- **Joint Couple Accounts**: Implemented customer partner linking (existing or new) with automatic financial redirection to the primary account. Joint profiles feature combined lifetime spend, loyalty, and Transaction Record history while maintaining individual measurement privacy.

### Fixed
- Stabilized GitHub Actions CI by injecting Tauri Linux dependencies (`libwebkit2gtk-4.1-dev`, etc.) into the `ubuntu-latest` lint runner.
- Resolved "Zero-Warning Baseline" ESLint warnings by extracting shared logic out of React Context (`BackofficeAuthContext`, `ToastProvider`) and Components (`CustomerMeasurementVaultForm`, `LoyaltyRedeemDialog`) into `*Logic.ts` files to comply with Fast Refresh guidelines.
- Fixed 401 Unauthorized browser console spam in `Cart.tsx` when the POS eagerly fetched metadata before a valid register session or staff PIN was provided.
- **Backend Stabilization**: Resolved critical Type Mismatches in Rust server logic and fixed schema typos in migration 116.
- **Migration Ledger Reconciliation**: Manually synchronized the database migration ledger to resolve 500 errors caused by partially applied schemas.
- **Client Syntax & Import Fixes**: Resolved a syntax error in `InventoryControlBoard` and a broken import path for `VariantSearchInput` in `PhysicalInventoryWorkspace`.

## [0.1.0] - 2026-04-09

### Added
- Initial baseline versioning for the entire repository.
- Synchronized versions across `client`, `server`, and `tauri` at `0.1.0`.
- Integrated Counterpoint bridge for customer and catalog synchronization.
- Layaway operations and reporting module.
- Multi-lane register support and Z-close groupings.
- Notification center for staff alerts and daily digests.
- Staff task management and floor schedule system.
- Bug report flow with Sentry integration.
- Hardware bridge for legacy printer support via Tauri.
- Meilisearch integration for fuzzy product and help search.
