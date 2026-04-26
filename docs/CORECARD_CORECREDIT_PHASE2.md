# CoreCard / CoreCredit Phase 2

Status: **Historical implementation note**. For current RMS Charge documentation, start with [RMS_CHARGE.md](./RMS_CHARGE.md), then use [CORECARD_CORECREDIT_FULL_ARCHITECTURE.md](./CORECARD_CORECREDIT_FULL_ARCHITECTURE.md).

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
  [`CORECARD_CORECREDIT_FULL_ARCHITECTURE.md`](./CORECARD_CORECREDIT_FULL_ARCHITECTURE.md)
- operations runbook:
  [`operations/rms-corecard-runbook.md`](./operations/rms-corecard-runbook.md)
- finance guide:
  [`finance/rms-charge-qbo.md`](./finance/rms-charge-qbo.md)
