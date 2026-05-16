# RMS Charge Overview

**Audience:** Sales support, managers, finance/admin, and anyone who needs the plain-language picture before working in the RMS Charge workspace.

**Where in ROS:** Back Office → **Customers** → **RMS charge**

## What RMS Charge is

RMS Charge is Riverside's manual-first financing workflow. Staff use it to record RMS Charge sales, RMS Charge payments, accounts, programs, reference numbers, and follow-up reporting to R2S.

In day-to-day use, Riverside staff see one financing tender:

- `RMS Charge`

Program selection happens **after** the tender is chosen. That means staff do not choose separate buttons for `RMS` versus `RMS 90`.

## Two kinds of RMS activity

### Financing purchase

This is when the customer uses RMS Charge to pay for a new sale.

### Payment collection

This is when the customer is making a payment toward an RMS balance that already exists.

## Report to R2S

Every RMS Charge Sale and RMS Charge Payment created through POS must be reported to R2S by the next day.

Customer → `RMS Charge` tracks this directly on each RMS Charge record:

- `Unreported`
  The record still needs R2S follow-up.
- `Overdue`
  The next-day reporting deadline has passed.
- `Reported`
  Staff recorded that the R2S follow-up was completed.

Marking a record `Reported` only clears the reporting follow-up. It does not change transaction amounts, post to an external RMS system, or imply automatic accounting/bank reconciliation.

Use `Reference Number` for the R2S approval, authorization, merchant, or support reference. Do not enter PAN, CVV, card tokens, or full account numbers.

Permission required to mark reported: `rms_charge.report_to_r2s` or RMS Charge reporting access.

## Manual RMS readiness

The current pilot workflow is manual RMS Charge. A record is ready for daily review when the account, program, amount, reference number, and `Report to R2S` status are clear. The Payments workspace is Helcim-focused and should not be used as proof of RMS Charge status.

## What you can do in the RMS Charge workspace

Back Office RMS Charge is organized into:

- `Overview`
- `Accounts`
- `Transactions` / `Report to R2S`
- `Programs`
- `Exceptions`
- `Reconciliation`

Important:

- `Overview`, `Accounts`, and account-level RMS detail can follow the selected customer
- `Reconciliation` remains a global support review tab and is not filtered to only the selected customer
- if one RMS support section is temporarily unavailable, the other sections can still remain usable

## When to use Customers versus RMS Charge

Use the main `Customers` workspace and the `Customer Relationship Hub` when staff need the broader account picture:

- profile details
- notes and customer history
- measurements
- weddings
- shipments
- non-RMS order review

Use `RMS Charge` when the issue is specifically about financing accounts, R2S reporting status, reference numbers, exceptions, or reconciliation.

## Key terms

- `program`
  The financing option chosen after `RMS Charge` is selected, such as `Standard` or `RMS 90`.
- `Reference Number`
  The approval, authorization, merchant, or support reference staff use for RMS Charge follow-up.
- `Report to R2S`
  The next-day reporting checklist for RMS Charge Sales and RMS Charge Payments.
- `exception`
  A failed, stale, or mismatched RMS item that needs follow-up.
- `reconciliation`
  A comparison of Riverside RMS records, available RMS update state, and expected QBO-clearing behavior.

## What staff should remember

- Always use the active Riverside customer as the source of truth.
- Do not rely on name-only matching.
- Report every POS-created RMS Charge Sale and RMS Charge Payment to R2S by the next day.
- Mark the RMS Charge record `Reported` after the R2S follow-up is complete.
- Do not treat `Reported` as automatic live posting, bank reconciliation, or QBO posting.

## Related guides

- Accounts:
  [`/Users/cpg/riverside-os/docs/staff/rms-charge-accounts.md`](./rms-charge-accounts.md)
- Transactions:
  [`/Users/cpg/riverside-os/docs/staff/rms-charge-transactions.md`](./rms-charge-transactions.md)
- Exceptions:
  [`/Users/cpg/riverside-os/docs/staff/rms-charge-exceptions.md`](./rms-charge-exceptions.md)
- Reconciliation:
  [`/Users/cpg/riverside-os/docs/staff/rms-charge-reconciliation.md`](./rms-charge-reconciliation.md)
- POS quick guide:
  [`/Users/cpg/riverside-os/docs/staff/pos-rms-charge.md`](./pos-rms-charge.md)
