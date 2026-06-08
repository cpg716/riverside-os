# Pre-Go-Live Local Review — 2026-06-04

Scope: repo-local review and fixes only. This file does not claim completion of Windows target-machine rehearsals or live/sandbox credential workflows that require external systems.

## Local Checks Completed

- QBO staging and journal mapping tests passed with the generic `MISC_FALLBACK` path removed.
- Counterpoint sync and reconciliation tests passed, including gift card, loyalty, customer, open-doc, checksum, inventory, and baseline reset coverage.
- Backup and restore guard tests passed, including strict production restore lock, exact filename confirmation, open-register blockers, catalog membership, encrypted backup round trip, and schema repair/validation scripts.
- Helcim local tests passed after serializing environment-mutating health tests to prevent nondeterministic failures.
- Podium local tests passed for OAuth, redirect validation, SMS/email request construction, and webhook signature verification.
- Shippo local health tests were added and passed for missing-token behavior and reachable-status classification.
- Client TypeScript typecheck passed.

## Repo Fixes Applied

- Removed the QBO generic fallback mapping path and renamed the remaining helper to explicit default ledger mapping.
- Removed silent QBO outbox account placeholders; missing mappings now fail with actionable errors instead of posting to invented account refs.
- Renamed ambiguous `REVENUE_FALLBACK` usage to `REVENUE_INVENTORY_ADJUSTMENT` with an idempotent migration preserving any existing mapped account.
- Added deterministic Helcim test environment locking.
- Added local Shippo health coverage.

## Still External

These remain pre-go-live operational gates because they require Windows target machines or real/sandbox provider accounts:

- Full Windows install/update/uninstall rehearsal.
- ROSIE install/update run on target Windows machines.
- Full Counterpoint SQL sync against the real Counterpoint source with final reconciliation.
- QBO sandbox post, void, and re-stage proof using Riverside's sandbox company.
- Helcim, Podium, Shippo, and QuickBooks credential workflow tests with real configured accounts.
- Backup restore rehearsal on the Windows Main Hub against a non-production drill database.
