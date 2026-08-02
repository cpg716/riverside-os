# Main Hub production error review: 2026-07-30 through 2026-08-01

Audit date: 2026-08-02
Production host: Main Hub over Tailscale
Reporting timezone: America/New_York
Review window: 2026-07-30 00:00 through 2026-08-02 00:00

## Executive result

The production `staff_error_event` ledger contained 94 rows: 15 Thursday, 50 Friday, and 29 Saturday. There were no staff-authored bug reports in the same window. Most rows were repeated connection symptoms, financial fail-closed safeguards, or staff workflow validation messages rather than independent defects.

One application defect was reproduced from its server trace and is already fixed and deployed: Wedding Deposit preflight returned PostgreSQL's `column reference "id" is ambiguous`. Commit `0f062cef` qualifies the joined member columns and adds a regression test. The Main Hub and the current active monitored Tauri workstation now both identify build `56de49dc`, which contains that fix.

Two operational items remain open and must not be repaired with direct SQL:

1. Helcim attempt `5eff2702` for $140.00 remains `pending` with `manual_reconciliation_required`, no stable provider payment or transaction identifier, and no Riverside payment ledger row. Verify it in the Helcim portal before using the audited Payments Health/Restore action. Two later $140.00 approvals belong to distinct checkout identities and each has its own fully allocated Riverside payment row; they do not resolve the provider uncertainty on `5eff2702`.
2. Inventory variants `B-1284372` and `B-1491569` remain at `stock_on_hand = -1` and `-3`. Perform a physical count and use the normal stock-adjustment workflow with the counted quantity and reason. Do not update `product_variants` directly.

## Evidence sources

- `staff_error_event`, `staff_bug_report`, and `ops_alert_event` in the production PostgreSQL database
- bounded server trace snapshots attached to the production error events
- `payment_provider_attempts`, `payment_transactions`, `payment_allocations`, Wedding Deposit source-ledger tables, product variants, and inventory movements
- Windows Application and System event logs on the Main Hub
- current `/api/live`, `/api/ready`, station heartbeat, Meilisearch health, and running-process evidence
- local source history for the exact deployed build and the Wedding Deposit regression fix

Credentials, customer data, complete provider references, card metadata, and secrets are intentionally excluded from this document.

## Findings and disposition

### 1. Main Hub connection interruptions — resolved after maintenance activity

The ledger recorded 36 connection-related rows: 12 generic Main Hub losses, 15 liveness-probe timeouts, and 9 client retry toasts. These rows represent several clients observing the same interruptions, not 36 independent outages.

Windows Restart Manager event 10010 identifies 12 Riverside desktop replacement/restart cycles during the review window. Those times correlate with the server startup traces and most connection clusters. Windows Application/System logs did not show a Riverside server crash or an unexpected PostgreSQL/Redis failure. Some clients reported the interruption after the corresponding restart, which explains delayed or duplicate timeout rows.

Current proof at audit time:

- Main Hub `/api/live`: HTTP 200
- Main Hub `/api/ready`: `ready`, exact build `56de49dc547803a43e31c1acd9bce7bb6847d8bc`
- PostgreSQL connected; Redis connected; all reported background workers available
- server process start: 2026-08-01 16:46:42 EDT
- no new `staff_error_event` rows after 2026-08-01 16:47 EDT through the audit read
- latest active monitored Tauri workstation heartbeat: version 0.95.5, build `56de49dc`, update observation `confirmed`

Disposition: resolved. Avoid repeated production update cycles during staffed sales hours when practical, because each replacement produces a real short interruption even when the updater succeeds.

### 2. Register/Main Hub build mismatch — resolved

Four Saturday card attempts were stopped before provider dispatch because the Register reported build `a43e9725` while the Main Hub reported `8c910125`. This was correct fail-closed behavior: no card request was sent.

The current active monitored Tauri workstation heartbeat and Main Hub readiness both report `56de49dc`. No mismatch event recurred after the final update.

Disposition: resolved and live-verified.

### 3. Wedding Deposit preflight HTTP 500 — fixed and deployed

At 2026-08-01 14:19 EDT, `POST /api/weddings/deposit-workflows/preflight` returned HTTP 500. The attached server trace records:

`Database error in weddings: column reference "id" is ambiguous`

Commit `0f062cef` changed the joined query to select `member.id`, `member.customer_id`, and `member.wedding_party_id`, and added a database regression test covering the real preflight query. The currently deployed `56de49dc` build contains that commit. There are no later error-ledger rows after the final deployment.

Disposition: fixed in source and verified present on the Main Hub.

### 4. Helcim recovery and refund safeguards — three resolved, one open

Resolved evidence:

- $147.90 refund attempt `05ec22e6`: provider-approved; Riverside contains the exact `-147.90` refund payment row and exact `-147.90` allocation. The original $430.65 sale remains separately allocated. Automatic binding initially stopped on conflicting provider correlation, which prevented a wrong attachment; the final refund row carries the exact provider-attempt reference.
- $287.43 attempt `aaa1b3e1`: finalized `canceled` after hosted card entry was closed before processing. It has no provider transaction and no Riverside payment row, which is consistent with no charge.
- $762.37 attempt `1cf5d651`: provider-approved with one successful $762.37 Riverside payment row. Its source is fully accounted for as $202.37 in direct payment allocations plus $560.00 in held Wedding Deposit source lineage. The Wedding workflow/source tables both reference the same $560.00 source; those two lineage rows must not be added to each other.
- The terminal-not-listening and unresolved-outcome messages correctly blocked repeat dispatch. Later approved attempts show that the payment path recovered.

Open evidence:

- $140.00 attempt `5eff2702`: still `pending`, marked `manual_reconciliation_required`, with no stable provider identifier and no Riverside ledger row. This is intentionally not auto-finalized because absence of a local provider reference is not proof that no charge occurred.

Required action: compare the attempt time and amount with the Helcim portal. If no provider charge exists, use the audited no-payment resolution/release action. If a charge exists, attach or refund it through Payments Health/Restore. Preserve the provider and Riverside audit records either way.

### 5. Negative inventory alerts — open physical reconciliation

The server trace recorded two admin alerts after a Saturday takeaway checkout:

- `B-1284372` fell to `-1`
- `B-1491569` fell to `-3`

Current production reads confirm those values remain `-1` and `-3`, with no reserved or layaway quantity. The inventory movement ledger includes the corresponding sale decrements and an earlier Friday sale decrement for `B-1491569`.

Required action: physically count both variants, then use the existing stock-adjustment or physical-inventory workflow. Record the count source and reason. Direct database correction is prohibited because it would bypass inventory movement evidence.

### 6. Expected workflow safeguards — no code defect established

Repeated messages requiring a salesperson, payer/member selection, pickup readiness, exact item replacement, Manager Access, or recovery of an unresolved provider attempt were validation/fail-closed controls. They prevented incomplete commission attribution, unsafe pickup, cross-customer Wedding Deposit allocation, or duplicate card activity. They should remain visible to staff.

The one variation-load failure occurred at the same time as a Main Hub interruption and did not recur after service recovery.

Disposition: no code change from this review.

### 7. Lower-priority host and configuration warnings

- Meilisearch logged invalid/duplicate customer candidate IDs and safely fell back to PostgreSQL. Current local Meilisearch health is `available`; successful health does not prove the stale-candidate pattern is gone. Rebuild or inspect the customer index if the warning recurs.
- Every observed server start warned that permissive CORS was enabled and strict production was not active. The origin inventory found active production traffic from the Tauri client, the current LAN browser, and the production HTTPS hostname. The persisted Main Hub config and `server\.env` now enable strict production and include those origins plus the existing server, LAN, Tailscale, and Tauri origins. Controlled strict-start attempts did not bind successfully and were rolled back to the original scheduled-task action; the restored API is fully ready but still returns `Access-Control-Allow-Origin: *`. System Audit now probes the effective live response and fails on this persisted-versus-runtime mismatch instead of reporting a false pass. Capture strict-start output and resolve the startup failure in a staffed maintenance window before considering CORS closed.
- Windows logged recurring processor firmware throttling on logical processors 16 through 23 and ACPI real-time-clock errors. The active Balanced plan already permits 100% maximum processor state, so Windows power policy is not the limiter and was not changed. Windows Time had been stopped; it is now Automatic and running, with a successful external synchronization. That mitigates clock drift but does not repair the ACPI firmware method. The Main Hub reports an MSI PRO B660M-A CEC WIFI DDR4 (MS-7D37), board revision 1.0, with AMI BIOS `1.10`, dated 2022-02-23. Schedule any BIOS update through MSI's exact model support path during a backed-up maintenance window rather than flashing production remotely.
- System Audit's `COUNTERPOINT_SYNC_TOKEN` failure was stale. Direct Counterpoint Bridge sync is retired, so Main Hub readiness must not require or create that token. The audit script and installer documentation have been corrected to describe the backend-only boundary.
- A resolved `station_offline` ops alert ran from 14:05 to 14:59 EDT Saturday during the update period.

## Current production health snapshot

At the end of the audit:

- API: ready
- exact Main Hub build: `56de49dc547803a43e31c1acd9bce7bb6847d8bc`
- exact current active monitored Tauri workstation heartbeat build: `56de49dc`
- PostgreSQL: connected
- Redis/job queue: connected and enabled
- Meilisearch local health: available
- backup worker/tooling/artifact checks: healthy
- latest verified backup: 2026-08-02 02:00 EDT, catalog plus SHA-256 verified
- unavailable readiness components: none

## Follow-up checklist

- [ ] Reconcile Helcim attempt `5eff2702` against the provider portal and record the audited outcome.
- [ ] Physically count `B-1284372` and `B-1491569`; post approved stock adjustments if the counts differ from ROS.
- [ ] During a backed-up maintenance window, apply only the BIOS published for MSI PRO B660M-A CEC WIFI DDR4 (MS-7D37) revision 1.0, then verify that Kernel-Processor-Power event 37 and HAL event 21 stop recurring.
- [ ] In a maintenance window, capture the strict-start failure output, correct the effective task environment/startup prerequisite, then prove an allowed origin is echoed exactly and an untrusted origin receives no CORS allow header. System Audit must pass the new live CORS probe.
- [ ] Recheck customer-search warnings after normal Monday usage; rebuild only if the invalid/duplicate candidate warning recurs.
