---
id: customers-rms-charge-admin-section
title: "RMS Charge Workspace"
order: 1008
summary: "Review linked RMS Charge accounts, recent activity, open issues, and reconciliation support for the selected customer."
source: client/src/components/customers/RmsChargeAdminSection.tsx
last_scanned: 2026-04-21
tags: customers, rms-charge, corecard, support, reconciliation
---

# RMS Charge Workspace

<!-- help:component-source -->
_Linked component: `client/src/components/customers/RmsChargeAdminSection.tsx`._
<!-- /help:component-source -->

## What this is

Use this workspace when a customer has an RMS Charge account and staff need to:

- confirm which RMS account is linked to the customer
- review available credit, current balance, and recent RMS activity
- check whether Riverside posted a purchase or payment successfully
- work an open issue or review reconciliation differences

Back Office staff use the full workspace. POS staff only see the limited RMS-safe view allowed by their role.

## What this is not

This workspace is not the general customer review drawer.

If staff need to review the customer profile, messages, measurements, shipments, weddings, or non-RMS order history first, open the `Customer Relationship Hub`.

Move here when the question becomes RMS-specific:

- linked RMS account confirmation
- RMS purchase or payment posting
- RMS account corrections
- RMS exceptions
- RMS reconciliation

## Tabs in Back Office

- `Overview`
  A quick picture of recent RMS activity, failed host actions, pending issues, and recent automatic updates.
- `Accounts`
  Linked RMS Charge accounts for the selected customer, plus manual link and unlink tools for authorized staff.
- `Transactions`
  Riverside-recorded RMS purchases, payments, refunds, and reversals.
- `Programs`
  Available financing plans and whether the selected account is eligible.
- `Exceptions`
  Open RMS issues that may need assignment, retry, resolve, or support follow-up.
- `Reconciliation`
  Differences between Riverside records, CoreCard host state, and accounting-clearing expectations across all RMS activity.

## How to use it

1. Search for and select the correct customer first.
2. Confirm the linked account before reviewing balances or taking any follow-up action.
3. Use `Accounts` to verify the link and status.
4. Use `Transactions` when you need to review a specific RMS purchase or payment.
5. Use `Exceptions` for failed or stale RMS issues.
6. Use `Reconciliation` when finance or support needs to review a mismatch between Riverside, CoreCard, and accounting expectations.

## What each section tells you

### Customer context

The account cards show:

- the masked RMS account
- whether it is primary
- account status
- last verification time

If no account is linked, stop and verify that the correct customer profile is selected before promising RMS financing or payment collection.

### Overview

Use `Overview` for a quick answer to:

- how much RMS purchase activity posted recently
- how much RMS payment activity posted recently
- whether RMS issues are still open
- whether Riverside is still waiting on host updates

This tab is for triage. Open the other sections when you need to act.

### Transactions

Use `Transactions` when you need transaction-level follow-up:

- confirm whether a purchase or payment posted
- find the host reference for an RMS action
- open the linked Riverside transaction when a customer asks about a sale

Do not treat a failed RMS record as completed until the posting status is clearly successful.

### Exceptions

Use `Exceptions` when Riverside could not finish or verify an RMS action automatically.

- `Assign to Me` claims ownership so other staff can see who is working the issue.
- `Retry` is for temporary failures that still look safe to send again.
- `Resolve` is for issues that are already cleared and documented.

Resolution notes should explain what actually cleared the issue.

Do not retry if the wrong customer, account, or program is selected.

### Reconciliation

Use `Reconciliation` when support or finance needs to compare:

- Riverside RMS records
- CoreCard host results
- Riverside's expected accounting-clearing behavior

This is a support and finance review tool. It is not the first place to start for ordinary customer questions.
Even when a customer is selected, this tab still reviews all RMS activity rather than filtering to only that customer's records.

## POS-safe view

In POS, this workspace is intentionally limited.

Staff may be able to:

- look up the linked account
- review recent RMS activity
- check available programs

POS does not expose the full Back Office exception and reconciliation workflow.

## Tips

- Always start from the active Riverside customer profile, not a name-only match.
- Use the masked account and the customer profile together when confirming identity.
- If the account looks stale, blocked, or mismatched, escalate before retrying activity.
- If one RMS support section fails to refresh, the others may still be current and usable. Read the warning on the affected section before escalating.
- Use the role-specific RMS manuals for deeper guidance:
  - `docs/staff/rms-charge-overview.md`
  - `docs/staff/rms-charge-accounts.md`
  - `docs/staff/rms-charge-transactions.md`
  - `docs/staff/rms-charge-exceptions.md`
  - `docs/staff/rms-charge-reconciliation.md`
