# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] — 2026-04-11
### Added
- **Stripe Power Integration**: Finalized the "Zero-Touch" PCI-compliant card vaulting flow and unlinked terminal credits. Staff can now save customer cards in the Relationship Hub for phone orders and issue credits directly back to cards when cart balances are negative.
- **Wedding Party Order Integration**: Implemented "Attach to Wedding" functionality in `OrdersWorkspace` to allow manual linking of legacy Counterpoint tickets to wedding party members.
- **Zero-Error Baseline Stabilization**: Achieved a 100% clean TypeScript build by resolving lingering type errors in `App.tsx`, `LoyaltyWorkspace.tsx`, and `CommissionManagerWorkspace.tsx`.
- **Relationship Hub Gating**: Ensured all Customer Hub tabs (Orders, Profile, Measurements, Payments) correctly respect RBAC permissions.
- **Help Center Manager E2E Expansion**: Added Playwright coverage for Settings navigation into Help Center Manager, tab visibility checks (Library, Editor, Automation, Search & Index, ROSIE readiness), and request-shape assertions for `generate-manifest` and `reindex-search` admin operations.
- **Help Admin API Gate Coverage**: Expanded `api-gates.spec.ts` with anonymous (`401`), non-Admin (`403`), and Admin success-shape checks for `/api/help/admin/ops/status`, `/api/help/admin/ops/generate-manifest`, and `/api/help/admin/ops/reindex-search`.
- **High-Risk Regression API Suite**: Added `high-risk-regressions.spec.ts` to cover migration-smoke route mounting, NYS tax audit shape/auth checks, revenue basis alias stability (`booked`/`sale`/`completed`/`pickup`), Help Manager RBAC + payload stability, session route auth behavior, and non-admin boundary enforcement on sensitive insights/help admin endpoints.
- **E2E Stability Hardening**: Improved test resilience for Settings/Reports navigation timing by reducing dependence on brittle response timing and strengthening UI-ready assertions in the Podium and Reports workspace specs.

### Changed
- **UI Spacing Refinement**: Adjusted spacing and density across Back Office workspaces for better consistency with the high-density CRM overhaul.
- **Project Structure**: Formally updated all project modules to v0.1.9.
- **Test-Run Hygiene Documentation**: Clarified E2E run expectations around service availability (UI + API) to avoid false-negative `ERR_CONNECTION_REFUSED` failures when the frontend host is not running.
- **Visual Suite Policy**: Standardized visual baseline tests as opt-in (`E2E_RUN_VISUAL=1`) and non-blocking by default to avoid release failures caused by cross-machine font/render snapshot drift.

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
