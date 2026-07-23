# Held fulfillment-integrity design

These files are retained incident-design evidence. They are intentionally not
part of the active migration sequence, Rust module tree/API router, or React
render path. Do not move them into production code until every requirement
below is implemented and contract-tested together.

## Why this is held

The prototype proves exact-scope recovery mechanics, but it is not a universal
mutation boundary. Repeated single-row statements, fulfilled inserts/COPY,
recognition-driving fields and event tables, and database-owner access can
bypass it. Its transaction-local guard can also reject legitimate
multi-Transaction Counterpoint, wedding, checkout, and exchange work.

The production installer currently gives the application role database/schema
ownership. Trigger evidence owned by that same role is tamper-resistant against
ordinary DML, not immutable against the direct-SQL authority that caused this
incident.

## Required production architecture

1. Create a migration-owner role that the runtime process and maintenance
   scripts cannot use.
2. Run Riverside under a non-owner, least-privilege role. Revoke direct writes
   to every fulfillment and recognition-driving field/table.
3. Route every permitted insert, update, reassignment, and delete through
   trusted write procedures with explicit operation kind, exact record scope,
   declared count, actor, reason, manager decision where required, and external
   correlation ID.
4. Apply the same boundary to normal one-record work and bulk work. Bulk scope
   must be unique, nonempty, capped, eligibility-checked, and committed with its
   audit evidence in one transaction.
5. Adapt and test every normal writer before enforcement: Counterpoint history
   insert/rerun, checkout and wedding beneficiary recalculation, exchange
   settlement, pickup, shipping/shipment events, takeaway recognition, returns,
   line reassignment, and approved maintenance/recovery.
6. Make every related-ledger writer participate in one locking/version contract
   so payment, allocation, inventory, commission, loyalty, activity, and QBO
   evidence cannot change outside the reviewed snapshot.
7. Add payment-allocation create/reassign/update/delete history. Current
   `payment_allocations` rows do not prove when or how a payment became attached
   to a Transaction Record.
8. Add transaction-line/pickup-event identity to inventory release movements
   and retain the balance transition needed to prove each decrement.
9. Add per-Transaction attribution to daily QBO staging/journals.
10. Store audit evidence under an owner/runtime boundary that the application
    and maintenance credentials cannot rewrite; retain an external append-only
    copy for high-impact operations.
11. Configure, create, and restore-test a real Main Hub backup before relying on
    recovery claims.
12. Run adversarial tests for bounded success, all-or-nothing rollback,
    idempotent response loss, sequential single-row attempts, inserts/COPY,
    reassignment, deletes, direct owner attempts, concurrency, and every normal
    workflow above.

Until these requirements pass together, the correct production behavior is to
disable direct financial repair apply, retain forensic evidence, block
unproven automated recovery, and never describe the held prototype as shipped.
