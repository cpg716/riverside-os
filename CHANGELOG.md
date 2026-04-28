# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepashangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
 
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
- **Stripe Power Integration**: Finalized the "Zero-Touch" PCI-compliant card vaulting flow and unlinked terminal credits. Staff can now save customer cards in the Relationship Hub for phone orders and issue credits directly back to cards when cart balances are negative.
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
- **Joint Couple Accounts**: Implemented customer partner linking (existing or new) with automatic financial redirection to the primary account. Joint profiles feature combined lifetime spend, loyalty, and order history while maintaining individual measurement privacy.

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
