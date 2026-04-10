# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
