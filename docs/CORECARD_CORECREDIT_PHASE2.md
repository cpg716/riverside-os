# CoreCard / CoreCredit Phase 2

This file is the implementation-history note for Phase 2.

Phase 2 turned RMS Charge into a live host-posted flow:

- financed purchase posting
- RMS payment collection posting
- refund and reversal host actions
- idempotency persistence
- host status persistence
- metadata-driven receipts and host references

## Key shipped foundation

- migration `154_corecard_corecard_phase2_live_posting.sql`
- CoreCard mutation posting support
- normalized host failure classes
- posting event persistence
- host-gated checkout and payment collection
- receipt wording driven by saved metadata
- QBO clearing support for RMS financing and RMS payment collection

## Current references

For current operational behavior, use:

- architecture:
  [`/Users/cpg/riverside-os/docs/CORECARD_CORECREDIT_FULL_ARCHITECTURE.md`](./CORECARD_CORECREDIT_FULL_ARCHITECTURE.md)
- operations runbook:
  [`/Users/cpg/riverside-os/docs/operations/rms-corecard-runbook.md`](./operations/rms-corecard-runbook.md)
- finance guide:
  [`/Users/cpg/riverside-os/docs/finance/rms-charge-qbo.md`](./finance/rms-charge-qbo.md)
