# Counterpoint false-fulfillment incident — July 21–22, 2026

## Evidence status

This incident is **not fully reconstructable at the original 585-record scope**.
The exact command, code path, reported update count, recovery events, and known
downstream effects are proven. The exact original 585 Transaction Record IDs
are not: the repair script wrote its working manifest to a temporary CSV and
deleted that file when the run ended. The live database did not retain a
before-state manifest, actor, reason, or correlation ID for that operation.

No later count or metadata query may be represented as the missing original
manifest. The evidence gap is itself part of this incident.

## Proven initiating action and mutation path

At `2026-07-21T20:49:04.545Z`, the following live repair was started against
the Main Hub PostgreSQL database:

```text
node scripts/repair-current-counterpoint-imports.mjs --skip-aliases --apply
```

The execution transcript attributes this command to the Codex repair session,
not to a normal in-app staff workflow. ROS did not retain an authenticated
staff actor, Manager Access approval, reason, or correlation ID for the run, so
the database cannot independently attest a human initiating identity.
The sanitized transcript evidence, tool-call identity, timestamps, result, and
source-rollout digest are retained in
[2026-07-21-counterpoint-repair-execution-evidence.json](evidence/2026-07-21-counterpoint-repair-execution-evidence.json).

The run reported:

| Result | Count |
|---|---:|
| Transactions scanned | 58,305 |
| Line updates | 903 |
| Transaction updates | 585 |
| Price changes | 903 |
| Tax changes | 832 |

The faulty pre-fix transaction `UPDATE` combined intended Counterpoint
financial repair fields with unconditional lifecycle mutation:

```text
total_price = repaired total
amount_paid = repaired paid amount
balance_due = repaired balance
status = fulfilled
fulfilled_at = existing fulfilled_at, otherwise booked_at
```

The lifecycle assignments did not require completed business lines, a pickup,
a shipment, inventory movement, Manager Access, or an exact retained manifest.
That is the proven cause of open Transaction Record headers being marked
fulfilled. Commit `b3050047` removed the unconditional `status` and
`fulfilled_at` assignments from the repair script. That code correction does
not reconstruct the deleted 585-row manifest.

This was a direct live SQL repair action. It was not caused by release tagging
and was not a numbered migration.

## Affected-record evidence

The repair process reported **585 transaction updates**, but its original
temporary scope file was deleted. A later recovery produced **568 retained
`status_corrected` activity events across 567 unique Transaction Records**:

| Recovery cohort | Activity events | Unique records |
|---|---:|---:|
| Fulfilled header with active open Counterpoint lines | 558 | 558 |
| Fulfilled Counterpoint header with positive balance | 10 | 10 |
| Combined | 568 | 567 |

One Transaction Record appears in both recovery cohorts. Therefore neither
`585 - 568` nor `585 - 567` is a valid reconstruction of the unknown remainder.
The recovery rules were not a retained copy of the original mutation scope.

The exact 568 recovery-event manifest is
[2026-07-22-counterpoint-status-recovery-manifest.csv](evidence/2026-07-22-counterpoint-status-recovery-manifest.csv).
Its SHA-256 is
`8310560c1c89350d4ab15ccb4f0a6f65d69dd4dc5775acfa0627bc3aa20eb21d`.
The hashed export is retained evidence, but the underlying
`transaction_activity_log` rows are not immutable under the current production
schema. That source-table limitation must remain explicit.

## Proven recovery initiating actions and mutation paths

Both July 22 recoveries were direct `psql` transactions initiated by the Codex
production repair session against the live Main Hub database as the `postgres`
database role. They did not pass through a normal ROS API or staff UI and did
not retain an authenticated staff actor, Manager Access approval, or immutable
correlation record.

The first tool call was issued at `2026-07-22T21:20:15.781Z`. It built a
query-derived temporary scope of fulfilled Counterpoint Transaction Records
having at least one active, non-internal, unfulfilled line after returned
quantity. It asserted exactly 558 rows, then in one transaction changed each
header to `open`, cleared `fulfilled_at`, added repair metadata, and inserted
one `status_corrected` activity row per record. The result was 558 header
updates and 558 activity inserts, followed by `COMMIT`.

The second tool call was issued at `2026-07-22T21:21:34.198Z`. It built a
query-derived temporary scope of fulfilled Counterpoint Transaction Records
with `balance_due > 0`, asserted exactly 10 rows, then performed the same
header reset and one activity insert per record in a single transaction. The
result was 10 header updates and 10 activity inserts, followed by `COMMIT`.

The corresponding database activity timestamps are
`2026-07-22T17:20:14.773479-04:00` and
`2026-07-22T17:21:33.226024-04:00`. The tool-call timestamps come from the
local Codex transcript and the activity timestamps from the Main Hub database
clock; their approximately one-second skew is not evidence of reversed event
order.

Both operations used `ON_ERROR_STOP`, lock and statement timeouts, an exact
count assertion that would roll back on mismatch, and a final fulfilled-status
recheck in the `UPDATE`. Neither began from an explicitly reviewed ID manifest.
The operation reason and repair ID were stored only in mutable transaction and
activity metadata. The exact sanitized predicates, assignments, transaction
mechanics, execution context, call identities, and results are retained in
[2026-07-22-counterpoint-status-recovery-execution-evidence.json](evidence/2026-07-22-counterpoint-status-recovery-execution-evidence.json).
Its SHA-256 is
`343efbbdbb92b472a8a5a2d8dadb6bfa0b23c042e1d483118b1225eebf73cc89`.

Follow-up read-only forensics checked the execution-host temp roots, Trash,
Spotlight index, local snapshots, Main Hub statement-log configuration, active
WAL retention/archive configuration, and the backup API. The temp directory was
deleted; no local copy or usable user-data snapshot was found; statement logging
did not retain the SQL/COPY payload; every active WAL file had been modified
after the incident; WAL archiving was disabled; and the API exposed no
restorable artifact. The original 585-ID manifest is therefore not
reconstructable from the inspected retained sources. An uninspected off-system
copy remains the only stated external-evidence limitation. See
[2026-07-22-forensic-retention-evidence.json](evidence/2026-07-22-forensic-retention-evidence.json).

The absence of any cataloged backup, archive target, or replication target is
also an unresolved production recovery-readiness defect. A running backup
worker is not proof of a restorable backup.

## Downstream financial and inventory evidence

The unique 567-record recovery cohort was re-read across Transaction Record
headers, business lines, payment allocations, inventory movements, revenue
recognition, commissions, loyalty, activity audit, operational outboxes, and
QBO evidence. The result is in
[2026-07-22-counterpoint-status-recovery-cross-ledger-v4.csv](evidence/2026-07-22-counterpoint-status-recovery-cross-ledger-v4.csv).
Its SHA-256 is
`5b446364230ec495e5c45eadd657ceec6d581db1c9ad81bb8e2c0fc920ed6f5c`.
The CSV was generated by the hashed audit SQL in a read-only Main Hub session;
the sanitized call identity, read-only controls, exact row/status result, byte
count, SQL hash, and output hash are retained in
[2026-07-23-counterpoint-cross-ledger-production-execution-evidence.json](evidence/2026-07-23-counterpoint-cross-ledger-production-execution-evidence.json).
Its SHA-256 is
`3457fa839233a0310e8c4b42dede580f08dfd2f7c311ccb21d52f7274ee54638`.
Read-only mode was enforced externally with PostgreSQL `PGOPTIONS`; the audit
SQL is one SELECT-only CTE statement and does not contain its own read-only
transaction assertion.
The Codex transcript is append-only execution evidence, not a database-signed
attestation; the CSV records the production state observed at execution time.

The first three cross-ledger exports are superseded. The first had incomplete
payment-window wording and commission filtering. The second overstated current
consistency despite payment, inventory, and QBO traceability gaps. The third
did not treat the positive-balance recovery's removal of proven fulfillment
recognition as a failure. None may be used for the classification below.

What the evidence proves:

- No payment currently linked to the recovery cohort was created during the
  bad apply or recovery window. `payment_allocations` has no `created_at` or
  allocation-history field, so the creation time of an allocation itself is
  not provable from the current schema.
- The bad apply window contains no inventory-movement, commission, loyalty,
  QBO-outbox, or operational-outbox row for the recovery cohort.
- The recovery window contains one inventory movement and two loyalty rows,
  all associated with the legitimate `TXN-566219` pickup described below. It
  contains no commission, QBO-outbox, or operational-outbox row for the cohort.
- The bad update changed header lifecycle state and `fulfilled_at`. That made
  affected headers eligible for fulfilled-revenue reporting during the
  exposure period even though active lines remained open.
- The same SQL statement also applied intended Counterpoint financial repairs.
  Because the original before-state manifest was deleted, current totals must
  not be described as incident deltas or proof that all 585 financial values
  were wrong.
- At verification time, the 567-record cohort's current values total
  `$172,351.61` price, `$129,656.84` stored paid, and `$43,574.64` balance due.
  Those are current values only, not a measured overstatement.
- No posted QBO journal from this incident was found. Two daily QBO proposals
  were generated during the exposure window; both remain `needs_review`, have
  zero journal lines, and have no QuickBooks journal ID. No QBO staff action
  was present in the inspected audit window.
- QBO remains a material traceability limitation: `qbo_sync_logs` stores daily
  aggregate journals without a Transaction Record foreign key. Current
  evidence cannot prove historical per-Transaction inclusion or exclusion for
  all 567 records. See
  [2026-07-22-qbo-exposure-evidence.json](evidence/2026-07-22-qbo-exposure-evidence.json).

## Recovery defects discovered by verification

Sanitized raw rows for the complete 10-record positive-balance recovery
cohort—including Transaction Record
headers and lines, payment/allocation rows, fulfillment/lifecycle rows,
inventory movements and current variant balances, commission, loyalty,
activity, and outbox evidence—are retained in
[2026-07-22-counterpoint-balance-recovery-cohort-ledger-evidence.json](evidence/2026-07-22-counterpoint-balance-recovery-cohort-ledger-evidence.json).
Its SHA-256 is
`169b2da52e0a2efd392a9f7ec9323a7ddca840f8c8fb83d7fc94483ceefdc6cb`.

The first recovery changed 558 headers to open at
`2026-07-22T21:20:14.773479Z`. The second changed 10 positive-balance headers
at `2026-07-22T21:21:33.226024Z`.

The second recovery definitively removed fulfilled-revenue recognition from
nine Transaction Records with no open lines, fulfilled line evidence, pickup
inventory movements, loyalty evidence, and a retained prior `fulfilled_at`:

- `TXN-566008`
- `TXN-566015`
- `TXN-566043`
- `TXN-566051`
- `TXN-566114`
- `TXN-566162`
- `TXN-566219`
- `TXN-566276`
- `TXN-566432`

Their current values total `$2,957.00`, with `$2,030.52` stored paid and
`$926.48` balance due. They contain 22 fulfilled lines, 20 inventory movement
rows, and 18 loyalty rows (nine accrual plus nine ledger). They currently have
16 payment allocations totaling `$2,030.52`; allocation attachment history is
not retained. The retained raw rows contain zero commission events, zero return
lines, zero per-Transaction QBO outbox rows, and zero operational-outbox rows
for these nine records. The absence of a per-Transaction QBO row does not prove
absence from an aggregate daily journal. `$2,957.00` is the current fulfilled
value omitted from header-recognition reporting after the recovery; it is not
a booked-sale/payment delta and is not proof of QBO posting.

`TXN-566219` proves that status-only recovery was unsafe:

1. The first recovery reopened it because one active line remained open.
2. At `2026-07-22T21:20:17.612468Z`, a legitimate Register pickup fulfilled
   the remaining line.
3. That pickup wrote the canonical pickup activity and lifecycle events,
   decremented inventory by one, and created loyalty accrual evidence.
4. The second recovery then reopened the header solely because `$10.53`
   remained due.
5. The current header is open with no `fulfilled_at`, while both active lines
   are fulfilled/picked up and the legitimate inventory and loyalty effects
   remain.

The cross-ledger verifier marks all nine records **failed — recovery removed
fulfilled recognition**. `TXN-566219` must not be changed
again by a status repair. Manager review of the legitimate pickup, balance due,
tender, inventory movement, loyalty accrual, revenue recognition, and audit
chain is necessary but not sufficient: two current payment allocations exist,
and their attachment history is not retained. ROS must leave the record blocked
until that provenance can be proven; Manager Access cannot convert missing
evidence into approval.

`TXN-566139` is **review required — current exception**. Its retained rows show
a July 8 pickup activity, a one-unit inventory decrement, and matching loyalty
accrual/ledger effects before the July 22 positive-balance recovery reopened the
header. Its current stored paid amount (`-$83.61`) and allocated tender total
(`$83.61`) differ by `$167.22`. That financial mismatch is not proven to have
been created by this incident. Its sole current line is quantity zero,
unfulfilled, and marked ready for pickup, which conflicts with the retained
pickup/inventory/loyalty effects and has no newer line-lifecycle event linking
them. Five current allocations also have no attachment history. Reopening may
therefore be wrong, but restoring recognition is not safely proven either; an
automated recovery must leave the record unchanged pending receipt/tender and
fulfillment investigation.

Final read-only production verification result:

| Result | Records | Meaning |
|---|---:|---|
| Review required — traceability gaps | 557 | Current checks found no listed exception, but payment attachment timing, inventory line/event linkage, and aggregate QBO cannot prove complete per-record history |
| Review required — current exception | 1 | `TXN-566139` financial evidence mismatch and retained fulfillment effects |
| Failed — recovery removed fulfilled recognition | 9 | Positive-balance recovery reopened fully fulfilled records and removed header recognition |

**Zero records are classified as verified.**
The unresolved disposition is 557 traceability reviews, one current-exception
review, and nine failed recognition recoveries.

## Recovery-specific safeguards prepared

The replacement recovery contract is intentionally narrow:

- staff must select exact Transaction Records through search; there is no
  unbounded or query-derived apply action;
- a request is limited to 100 unique IDs and must declare the identical count;
- preview shows every record's eligibility and transaction, line, payment,
  inventory, revenue, commission, loyalty, audit, and QBO evidence;
- any existing payment allocation blocks apply because historical attachment
  and reassignment timing is not retained;
- reason, actor, reviewing manager, correlation ID, exact scope, and full
  manifest digest are bound together;
- apply requires Manager Access and the same manager identity used for review;
- the server locks and re-reads every record under a serializable transaction;
- any stale, missing, duplicate, ineligible, or changed record rejects the
  complete operation;
- the current database prototype rejects one SQL statement spanning more than
  one Transaction Record without an exact approved operation manifest; it does
  not cover sequential single-row statements or fulfilled inserts;
- all header changes, activity rows, immutable transition events, and
  per-record verification evidence are committed together or rolled back
  together;
- the verifier requires financial values, lines, payments, inventory,
  commissions, loyalty, and QBO/outbox evidence to remain unchanged while
  false revenue recognition is removed;
- immutable evidence remains readable by operation ID; the QBO limitation
  remains `review_required` rather than being reported as fully verified.

Relevant implementation:

- `docs/incidents/design/held-bulk-fulfillment-operation-guard.sql`
- `docs/incidents/design/held-fulfillment-recovery-service.rs.txt`
- `docs/incidents/design/held-fulfillment-integrity-api.rs.txt`
- `docs/incidents/design/held-counterpoint-fulfillment-recovery-panel.tsx.txt`
- `docs/incidents/design/held-counterpoint-pickup-recognition-recovery-panel.tsx.txt`
- `scripts/audit-counterpoint-fulfillment-incident.sql`

These recovery-specific files are a held design, not a production feature. They
were removed from the executable migration list, API router, and client render
path after adversarial validation found the universal-boundary failures below.
Do not use direct SQL to work around the absence of a safe workflow.

The held database-guard design is **not approved for release as a universal
fulfillment boundary**. Review proved that its statement/transaction guard can be bypassed
by repeated single-row autocommit updates and by fulfilled inserts, while also
being capable of rejecting legitimate multi-Transaction Counterpoint, wedding,
and exchange workflows. A universal boundary requires a least-privilege runtime
database role plus trusted write procedures/context for every recognition-driving
insert, update, delete, and reassignment path. Until that work is complete and
the normal writers are contract-tested, the held design must not be represented
as satisfying the “any path” requirement or deployed to production.

## Evidence artifacts

These internal audit artifacts contain masked card last-four values, provider
transaction identifiers, and internal UUIDs where needed for reconciliation.
They contain no connection credentials, but the evidence directory must remain
access-controlled and must not be included in a public distribution.

| Artifact | SHA-256 |
|---|---|
| Sanitized repair execution evidence | `bbbb9d679078a400beb7180a1874990251282d0d3337a572c95729791abfee30` |
| Sanitized recovery execution evidence | `343efbbdbb92b472a8a5a2d8dadb6bfa0b23c042e1d483118b1225eebf73cc89` |
| Recovery event manifest | `8310560c1c89350d4ab15ccb4f0a6f65d69dd4dc5775acfa0627bc3aa20eb21d` |
| Final cross-ledger verification | `5b446364230ec495e5c45eadd657ceec6d581db1c9ad81bb8e2c0fc920ed6f5c` |
| Read-only production cross-ledger execution evidence | `3457fa839233a0310e8c4b42dede580f08dfd2f7c311ccb21d52f7274ee54638` |
| Positive-balance recovery cohort raw ledger evidence | `169b2da52e0a2efd392a9f7ec9323a7ddca840f8c8fb83d7fc94483ceefdc6cb` |
| QBO exposure evidence | `bde4a61acdc1f4bc15bcd2bf149fbff28e2a923c6cfa3564ecbff5a50094717e` |
| Backup reconstruction evidence | `6eb63bad17b2aed0ed4d61c2d3e2c7960587f18bd839d2a5a263c534328ed068` |
| Forensic retention evidence | `e0f78c828aa8eec9c8740230938e5a79579980947cba7ea0923c97f775c59fea` |
| Repeatable cross-ledger audit SQL | `830ed1e4334165a2d0ddc49b3bc0bd37d2abdcd76808bdfe1b4e28dab6bb1e54` |

The production evidence reads were non-mutating. No recovery in this document
should be represented as complete until all 10 positive-balance recovery
records are dispositioned, the other 557 traceability reviews are resolved,
and the exact production build is verified.
