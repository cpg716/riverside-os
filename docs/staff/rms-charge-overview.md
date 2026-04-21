# RMS Charge Overview

**Audience:** Sales support, managers, finance/admin, and anyone who needs the plain-language picture before working in the RMS Charge workspace.

**Where in ROS:** Back Office → **Customers** → **RMS charge**

## What RMS Charge is

RMS Charge is Riverside's financing workflow for customers whose RMS account is managed through CoreCredit/CoreCard.

In day-to-day use, Riverside staff see one financing tender:

- `RMS Charge`

Program selection happens **after** the tender is chosen. That means staff do not choose separate buttons for `RMS` versus `RMS 90`.

## Two kinds of RMS activity

### Financing purchase

This is when the customer uses RMS Charge to pay for a new sale.

### Payment collection

This is when the customer is making a payment toward an RMS balance that already exists.

## What CoreCard does

CoreCard is the outside host that Riverside talks to on the server side.

In simple terms, CoreCard is where Riverside confirms:

- which RMS account belongs to the customer
- which programs are available
- whether a purchase or payment post succeeds
- which host reference belongs to that transaction
- whether later refunds, reversals, and status updates are valid

Staff do not log in to CoreCard from the browser. Riverside handles that server-side.

## What you can do in the RMS Charge workspace

Back Office RMS Charge is organized into:

- `Overview`
- `Accounts`
- `Transactions`
- `Programs`
- `Exceptions`
- `Reconciliation`

## Key terms

- `program`
  The financing option chosen after `RMS Charge` is selected, such as `Standard` or `RMS 90`.
- `posting status`
  Whether Riverside successfully posted the action to CoreCard.
- `host reference`
  The external CoreCard-side reference Riverside stores for the posted action.
- `exception`
  A failed, stale, or mismatched RMS item that needs follow-up.
- `reconciliation`
  A comparison of Riverside RMS records, CoreCard state, and expected QBO-clearing behavior.

## What staff should remember

- Always use the active Riverside customer as the source of truth.
- Do not rely on name-only matching.
- Do not promise RMS success until the system confirms the host post succeeded.
- Do not treat a failed host post as a completed sale or completed payment collection.

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
