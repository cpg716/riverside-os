# CoreCredit / CoreCard Phase 1

Status: **Historical implementation note**. For current RMS Charge documentation, start with [RMS_CHARGE.md](./RMS_CHARGE.md), then use [CORECARD_CORECREDIT_FULL_ARCHITECTURE.md](./CORECARD_CORECREDIT_FULL_ARCHITECTURE.md).

This file is the implementation-history note for Phase 1.

Phase 1 established the foundation for the unified `RMS Charge` tender:

- one financing tender button in POS
- server-side account resolution
- program metadata persistence
- customer-to-CoreCard account linkage
- server-only CoreCard broker scaffolding

## Key shipped foundation

- migration `153_corecredit_corecard_phase1_foundation.sql`
- `customer_corecredit_accounts`
- enriched `pos_rms_charge_record` financing metadata
- transaction metadata support
- server-side CoreCard auth/config/redaction scaffolding
- account linking and account-resolution APIs
- unified POS `RMS Charge` tender flow

## Current references

For current operational behavior, use:

- architecture:
  [`CORECARD_CORECREDIT_FULL_ARCHITECTURE.md`](./CORECARD_CORECREDIT_FULL_ARCHITECTURE.md)
- Back Office staff guides:
  [`staff/rms-charge-overview.md`](./staff/rms-charge-overview.md)
- POS staff guide:
  [`staff/pos-rms-charge.md`](./staff/pos-rms-charge.md)
- engineering detail:
  [`POS_PARKED_SALES_AND_RMS_CHARGES.md`](./POS_PARKED_SALES_AND_RMS_CHARGES.md)
