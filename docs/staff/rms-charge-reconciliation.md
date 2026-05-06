# RMS Charge Reconciliation

**Audience:** Finance/admin, sales support leads, and authorized managers.

**Where in ROS:** Back Office → **Customers** → **RMS charge** → `Reconciliation`

## Scope

The `Reconciliation` tab is a global RMS support view.

- it reviews all RMS activity in scope for the run
- it does **not** filter mismatch rows down to only the customer currently selected in the workspace
- use the selected customer for account review and transaction follow-up, not as a reconciliation filter

## What reconciliation means

Reconciliation is Riverside's review of whether RMS activity looks consistent across:

- Riverside RMS records
- available RMS account/update state
- Riverside's expected QBO-clearing treatment

## What a mismatch means

A mismatch means Riverside found something that does not line up cleanly.

Examples:

- Riverside says a future live post succeeded but the reference is missing
- an external update exists that Riverside did not absorb yet
- the wrong clearing expectation appears for the RMS record type
- a reversal or refund does not line up with the original record
- an RMS Charge Sale or RMS Charge Payment is still unreported to R2S after the next-day due date

## R2S reporting is separate

The `Report to R2S` status belongs to the RMS Charge transaction record. It is a staff follow-up checklist, not a live API post and not QBO/bank reconciliation.

Before closing daily RMS work, review Customer → `RMS Charge` → `Transactions` for `Unreported` and `Overdue` records. Use `Mark Reported` only after staff complete the R2S reporting step.

## Pre-live no-go signals

Reconciliation does not replace optional live-integration proof. Before enabling future live API posting, stop and review if any of these are present:

- account, program, balance, or summary reads are not live-confirmed
- readiness still says `Not live-verified yet`
- Settings → `CoreCard` says a restart is required after credentials were saved
- unsigned update mode is enabled outside a controlled test
- future live-posted RMS records are missing references
- repair polling has unresolved exceptions or stale unmatched events

## Actions to take

1. Open the reconciliation item.
2. Review the RMS record and any linked exception.
3. Check whether the R2S reporting status also needs staff follow-up.
4. Decide whether the item needs retry, resolve, or finance follow-up.
