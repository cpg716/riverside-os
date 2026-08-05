# Main Hub operations and Bug Manager review: 2026-08-04

Audit date: 2026-08-04

Production route: Main Hub over Tailscale

Reporting timezone: America/New_York

Bug Manager window: previous 48 hours

Operations-metric window: previous 7 days

## Executive result

The Main Hub was ready on build
`e532575b61825a040640f2f8b667e4c8cf71546a` with no unavailable readiness
components. The previous seven days contained 207 recorded checkouts with zero
metric failures. Median checkout duration was approximately 45–58 ms by day,
daily p95 was approximately 62–92 ms, and the observed maximum was 177 ms.

Bug Manager contained 40 automated error events in the previous 48 hours and
no staff-authored bug reports. No Riverside application crash, new server-side
HTTP 500, unsafe payment mutation, or financial-allocation failure was
established.

Two operations-tracking defects were found and corrected locally:

1. Register-close `transaction_commit` metrics measured the entire close
   workflow instead of the actual database commit. The close path now records
   the commit duration under `transaction_commit` and the full workflow under
   `total`.
2. Three legacy audit-probe alerts remained open because older runs used one
   dedupe key per run. Migration 181 preserves the newest row as
   `audit_probe:current` and resolves the older duplicates.

This review and the fixes do not deploy or mutate the production Main Hub.

## Evidence reviewed

- Main Hub `/api/ready` and exact build identity.
- Production `operational_phase_metric`, `staff_error_event`,
  `staff_bug_report`, `ops_alert_event`, `ops_audit_probe_run`,
  `ops_audit_probe_result`, and `ops_station_heartbeat` records.
- Current payment-allocation, register-session, and inventory probe queries.
- Windows Application and System events for Riverside POS installation,
  Restart Manager, application failures, service control, and processor
  firmware warnings.
- Local source history and release state for v0.96.0.

Credentials, customer data, complete diagnostic snapshots, and sensitive
provider or payment references are intentionally excluded.

## Bug Manager classification

The 40 automated events consisted of:

- 17 connection symptoms associated with intentional Riverside POS update
  cycles;
- 5 salesperson-attribution guards;
- 5 refund-balance or one-tender safeguards;
- 2 expired Register-session-token messages;
- 11 individual validation or operational guards, including pickup payment and
  readiness checks, alteration requirements, Wedding Deposit payer selection,
  one declined Helcim payment, one failed Manager Access attempt, one unknown
  SKU, and one release-asset mismatch message.

Windows recorded seven Riverside POS MSI install cycles, seven successful
installation completions, and seven Restart Manager event 10010 warnings that
the running POS process could not be restarted because its application SID did
not match the conductor SID. The connection-event clusters align with these
install windows. No Riverside crash event was found. A current monitored
workstation resumed heartbeats on the exact Main Hub build afterward.

Disposition: these connection rows represent real but expected short
interruptions during repeated production updates, not independent crashes.
Avoid repeated update cycles during staffed selling time where practical.

## Operations metrics

Seven-day recorded evidence:

| Operation | Samples | Failures | Observed timing |
| --- | ---: | ---: | --- |
| Checkout total | 207 | 0 | Daily p50 44.7–57.7 ms; p95 62.3–92.4 ms; max 177 ms |
| Checkout database commit | 207 | 0 | Daily p50 0.3–0.9 ms; max 4.4 ms |
| Helcim refund provider | 4 | 0 | 1.54–1.74 seconds |
| Register close | 6 | 0 | Previously mislabeled full-close duration of 8.0–10.6 seconds |

The six-stage privacy-safe Register journey telemetry added in commit
`7a1f2f08` was not present on the audited Main Hub build. Production therefore
had no valid `pos_journey` samples yet. Source/local validation must not be
reported as production performance evidence.

## Audit probes and inventory

The latest stored production audit-probe run was July 28. Its only remaining
violation class was negative available stock, with 673 rows at that time.
Current read-only evaluation found 717 variants:

- 716 active Counterpoint variants;
- 716 variants with negative `stock_on_hand` and one additional
  reservation-only negative-available case;
- 83 variants with inventory movement during the previous seven days;
- lowest observed available quantity: -27.

Current duplicate-checkout, orphan-allocation, over-allocation,
stale-reconciliation, and parked-on-closed-session checks returned zero.

Disposition: the negative inventory is a real operational reconciliation
queue, not a safe code or direct-database repair. Physical counts and normal
stock-adjustment workflows must establish authoritative quantities and retain
inventory-movement evidence.

## Fixes and validation

Changed files:

- `server/src/api/sessions.rs`
- `migrations/181_consolidate_legacy_audit_probe_alerts.sql`
- `server/src/embedded_migrations.rs`
- `client/e2e/register-report-output-contract.spec.ts`

Validation completed before release preparation:

- `npm run check:server`
- `npm run typecheck`
- `npm run lint`
- `cargo fmt --all -- --check`
- `npm run check:migration-layout`
- focused Register report contracts: 28 passed
- focused Register reconciliation unit tests: 2 passed
- migration 181 rehearsed against the production schema inside a transaction;
  one current alert was preserved, two duplicates were resolved, and the
  transaction was rolled back

For the requested v0.96.0 same-version rerun, full local Playwright E2E is
explicitly waived. Exact-commit GitHub Playwright remains required before the
release can be called complete.

## Operational boundary

Source fixes, a commit, a tag, GitHub Actions, release assets, production
deployment, and live behavior are separate claims. This audit applied no
inventory correction, Bug Manager status mutation, audit-probe execution,
release deployment, or Main Hub update.
