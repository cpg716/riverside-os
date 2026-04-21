# RMS Charge Reconciliation

**Audience:** Finance/admin, sales support leads, and authorized managers.

**Where in ROS:** Back Office → **Customers** → **RMS charge** → `Reconciliation`

## What reconciliation means

Reconciliation is Riverside's review of whether RMS activity looks consistent across:

- Riverside RMS records
- CoreCard host state
- Riverside's expected QBO-clearing treatment

## What a mismatch means

A mismatch means Riverside found something that does not line up cleanly.

Examples:

- Riverside says `posted` but the host reference is missing
- CoreCard has a host result that Riverside did not absorb yet
- the wrong clearing expectation appears for the RMS record type
- a reversal or refund does not line up with the original record

## Actions to take

1. Open the reconciliation item.
2. Review the RMS record and any linked exception.
3. Check whether a webhook or repair poll already fixed the issue.
4. Decide whether the item needs retry, resolve, or finance follow-up.
