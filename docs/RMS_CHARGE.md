# RMS Charge / CoreCard Documentation

Status: **Canonical front door** for RMS Charge, CoreCredit, and CoreCard documentation. Start here before editing RMS Charge payment, financing, account-linking, exception, reconciliation, security, or accounting behavior.

RMS Charge is RiversideOS's unified financing tender and payment-collection workflow for CoreCredit/CoreCard-backed activity. Parked cart behavior lives beside it because the POS checkout and Sales Support follow-up flows share register-session, audit, and operator-recovery concerns.

## Start Here

| Need | Document |
|---|---|
| Current end-to-end architecture | [CORECARD_CORECREDIT_FULL_ARCHITECTURE.md](CORECARD_CORECREDIT_FULL_ARCHITECTURE.md) |
| POS parked sales and RMS Charge engineering behavior | [POS_PARKED_SALES_AND_RMS_CHARGES.md](POS_PARKED_SALES_AND_RMS_CHARGES.md) |
| Operator overview | [staff/rms-charge-overview.md](staff/rms-charge-overview.md) |
| POS quick guide | [staff/pos-rms-charge.md](staff/pos-rms-charge.md) |
| Account linking and account management | [staff/rms-charge-accounts.md](staff/rms-charge-accounts.md) |
| RMS Charge transactions | [staff/rms-charge-transactions.md](staff/rms-charge-transactions.md) |
| Exceptions | [staff/rms-charge-exceptions.md](staff/rms-charge-exceptions.md) |
| Reconciliation | [staff/rms-charge-reconciliation.md](staff/rms-charge-reconciliation.md) |
| Operations runbook | [operations/rms-corecard-runbook.md](operations/rms-corecard-runbook.md) |
| Local and fake-host testing | [operations/rms-corecard-how-to-test.md](operations/rms-corecard-how-to-test.md) |
| Sandbox/live validation checklist | [operations/rms-corecard-validation-checklist.md](operations/rms-corecard-validation-checklist.md) |
| Sandbox/live validation runbook | [CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md](CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md) |
| Security and data handling | [security/corecard-data-handling.md](security/corecard-data-handling.md) |
| QBO and accounting expectations | [finance/rms-charge-qbo.md](finance/rms-charge-qbo.md) |
| Phase 1 implementation history | [CORECARD_CORECREDIT_PHASE1.md](CORECARD_CORECREDIT_PHASE1.md) |
| Phase 2 implementation history | [CORECARD_CORECREDIT_PHASE2.md](CORECARD_CORECREDIT_PHASE2.md) |
| Phase 3 implementation history | [CORECARD_CORECREDIT_PHASE3.md](CORECARD_CORECREDIT_PHASE3.md) |

## Maintenance Rules

- CoreCard credentials, tokens, raw PAN, and CVV stay server-side only. Update [security/corecard-data-handling.md](security/corecard-data-handling.md) when this boundary changes.
- POS tender, payment collection, account selection, or receipt behavior should update the relevant staff guide in the same change.
- RMS Charge QBO clearing, journal, or reconciliation behavior should update [finance/rms-charge-qbo.md](finance/rms-charge-qbo.md).
- Permission changes should update [STAFF_PERMISSIONS.md](STAFF_PERMISSIONS.md) and the role-specific staff docs.
- Phase docs are historical implementation notes. Current behavior belongs in the architecture, engineering, operations, finance, security, and staff docs listed above.
