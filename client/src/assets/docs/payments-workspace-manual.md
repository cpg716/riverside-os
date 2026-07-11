---
id: payments-workspace
title: "Payments Operations"
order: 85
summary: "Review Helcim transactions, batches, deposits, reconciliation issues, and payment health without changing processor truth."
source: client/src/components/payments/PaymentsWorkspace.tsx
last_scanned: 2026-07-10
tags: payments, helcim, batches, deposits, reconciliation, terminal, refunds
status: approved
---

# Payments Operations

## Screenshots

![Payments overview](../images/help/payments-workspace/overview.png)

![Processor batches](../images/help/payments-workspace/batches.png)

![Payments health](../images/help/payments-workspace/health.png)

## What this is

Payments Operations is the Back Office workspace for reviewing Riverside card activity against Helcim processor facts. It covers today's activity, processor batches, actual deposits, reconciliation exceptions, transaction lookup, webhook/provider attachment, and integration health.

Use the Register checkout drawer to collect payment. Use Payments Operations to review what happened and resolve evidence safely.

## Before you start

- Viewing requires payment access; syncing, linking, resolving, or accepting differences requires the matching elevated permission.
- Never enter a full card number, CVV, provider token, or private credential in Riverside notes.
- Missing fee or net information means **not ready**, not `$0.00`.
- If the terminal and Riverside disagree, do not run the card again until the first attempt is checked.

## Review today's status

1. Open **Payments → Overview**.
2. Review card sales, known fees, expected net, expected deposits, open review items, and last sync status.
3. Treat warning and critical issues as evidence to investigate, not automatic permission to edit a Transaction Record.
4. Open the related tab for details.
5. Record a review note when the issue requires follow-up across shifts.

## Review batches and deposits

1. Open **Batches** and confirm the processor batch number, status, close time, transaction count, and available totals.
2. Use the approved sync action when current processor data is needed.
3. Open **Deposits** to compare expected batches with actual bank/processor deposits.
4. Link only records that clearly represent the same processor settlement.
5. Escalate unexplained amount, fee, net, or timing differences.

Creating a manual deposit or accepting a variance is an audited manager/bookkeeper action. It does not rewrite the original card payment.

## Resolve reconciliation issues

1. Open **Reconciliation**.
2. Read the issue type, Riverside payment, Helcim reference, amount, status, and history.
3. Use **Reviewed** when investigation is ongoing.
4. Use **Link Payment** only after provider, amount, and ownership match.
5. Use **Resolved** or **Mark Expected** only with the required explanation and evidence.
6. Reopen an issue if later evidence shows the resolution was incorrect.

## Check a transaction or health problem

1. Open **Transactions** to locate the processor event or Riverside payment.
2. Follow the Transaction number to the financial record when one is linked.
3. Open **Health** for terminal, webhook, sync, provider-reference, and failed-update evidence.
4. Replay only the stored failed update after its configuration or data problem is corrected.
5. Confirm the replay attached existing provider evidence rather than creating a second charge.

## What to watch for

- Webhook received, checkout attached, and provider reference saved are different states.
- A normal decline or cancellation is not an approved payment.
- Never retry blindly after a terminal approval that Riverside has not attached.
- Standalone processor refunds do not automatically create a sales return or rewrite merchandise history.
- Do not resolve a reconciliation warning merely to make the dashboard green.

## What happens next

Completed review leaves an auditable history for register close, bookkeeping, QBO clearing, deposit reconciliation, and support follow-up while preserving processor and financial source records.

## Related workflows

- [Checkout & Payment](manual:pos-nexo-checkout-drawer)
- [Closing the Register](manual:pos-close-register-modal)
- [QBO Workspace](manual:qbo-workspace)
- [Helcim Settings](manual:settings-helcim-settings-panel)
