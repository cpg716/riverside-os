# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
