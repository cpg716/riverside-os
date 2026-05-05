# Payments Operations

**Purpose:** Use ROS as the daily card-payment workspace. Helcim remains the card processor, but staff should use **Payments** to review activity, batches, issues, sync health, and actual bank deposits.

Use this guide for **Back Office → Payments**. Use **Settings → Helcim** only for configuration/readiness checks and integration troubleshooting.

## Who should use it

- Managers and bookkeepers checking card activity.
- Staff responsible for end-of-day review.
- Admins investigating processor differences, missing fees, or deposit mismatches.

Sensitive actions require these permissions:

| Action | Permission |
|--------|------------|
| View Payments Operations | `payments.view` |
| Run payment sync actions | `payments.sync` |
| Review payment issues and add notes | `payments.reconcile.review` |
| Resolve, mark expected, or reopen payment issues | `payments.reconcile.resolve` |
| Link a processor payment to an existing Riverside payment | `payments.reconcile.link` |
| Review, reopen, or note actual deposits | `payments.deposit.review` |
| Link actual deposits to expected batches | `payments.deposit.link` |
| Create manual deposits or accept a variance | `payments.deposit.adjust` |

Older staff setups may still include the broad `payments.reconcile` permission. ROS accepts it only as a temporary compatibility fallback for reconciliation review, resolution, and linking actions. New access assignments should use the split permissions above.

## Overview

The **Overview** tab answers: “Are today’s card payments ready for review?”

Cards show:

- **Card Sales Today**: Riverside card payment gross total.
- **Known Fees**: only fees Helcim has explicitly provided.
- **Expected Net**: only net amounts Helcim has explicitly provided.
- **Expected Deposit**: batch-based expected deposit data, not bank-cleared money.
- **Needs Review**: open payment or deposit issues.
- **Sync Status**: last successful sync and health warnings.

If Helcim has not provided a value, ROS shows **Fee not ready** or **Net not ready**. Do not treat a missing fee or net as `$0.00`.

If there are no card payments yet, the tab shows **No payments yet today**. Run sync later after card activity begins.

## Batches

Use **Batches** to review Helcim processor batches.

Check:

- Batch number and status.
- Closed or settled time.
- Gross, fee, and expected deposit totals when available.
- Transaction count.
- Issue count.

Open a batch to see the transactions inside it, fee/net completeness, and any issues tied to that batch.

## Reconciliation

Use **Reconciliation** for items that need staff review.

Common labels:

| Label | Meaning |
|-------|---------|
| **Missing Payment** | Helcim shows a processor payment that is not linked to a Riverside payment. |
| **Not in Deposit** | Riverside has a Helcim payment that has not appeared in processor batch data. |
| **Amount Difference** | Riverside and Helcim amounts do not match. |
| **Status Difference** | Riverside and Helcim disagree about payment state. |
| **Fee Difference** | Both systems provided a fee and the values differ. |
| **Net Difference** | Both systems provided net amount and the values differ. |
| **Fee Not Ready** | Helcim has not provided fee/net data yet. |

Available actions:

1. **Reviewed**: leaves the issue open but records that staff looked at it.
2. **Resolved**: closes the issue with a required note for warning or critical issues.
3. **Mark Expected**: records that the difference is accepted or expected, with a note.
4. **Reopen**: returns a closed issue to open status.
5. **Add Note**: appends history without changing the issue state.
6. **Link Payment**: links a processor payment to an existing Riverside payment when the amount and provider match.

These actions do not change payment amounts, fees, net amounts, or processor truth.

## Transactions

Use **Transactions** to look up a specific payment.

Transaction details show:

- **Riverside Payment**: the ROS payment record.
- **Processor Payment**: the Helcim reference and processor-side status.
- **Batch**: expected deposit grouping when available.
- **Fee Details**: fee/net readiness without inferred values.
- **Timeline**: simplified payment updates.
- **Issues**: linked items needing review.

## Deposits

Use **Deposits** to compare expected Helcim deposits with actual bank deposits recorded in ROS.

Important distinction:

- **Expected Deposit** means ROS expects money based on Helcim batch data.
- **Actual Bank Deposit** means a real bank/QBO/manual deposit record was entered or imported into ROS.

Actions:

1. **Add Manual Deposit**: records an actual bank deposit inside ROS. This does not create a QBO deposit.
2. **Link Expected Batches**: links one or more Helcim batches to an actual bank deposit.
3. **Mark Reviewed**: records staff review of the deposit.
4. **Reopen**: returns the deposit to review.
5. **Add Note**: appends history without changing amounts.

Deposit matching never changes payment ledger amounts, batch amounts, merchant fees, net amounts, QBO records, or bank-feed records.

## Health

Use **Health** to verify payment operations are current.

Watch for:

- **Sync failed**
- **Fee still not ready**
- **Batch has not settled**
- **Deposit needs review**
- **Payment update failed**

Sync actions:

- **Sync Batches** pulls Helcim batch/transaction data.
- **Sync Fees** pulls explicit Helcim fee/net data.

Payment alerts are reminders, not financial corrections. Alerts may clear when the condition disappears, but reconciliation and deposit issues remain manual until staff act.

Alert recipients follow the Payments permission split: sync failures go to staff who can run payment sync, fee/readiness and health alerts go to staff who can view Payments, reconciliation alerts go to staff who can review payment issues, and deposit alerts go to staff who can review actual deposits.

## Payments vs. Helcim Settings

Use **Payments** for daily operations:

- Card activity and totals.
- Sync Batches and Sync Fees.
- Fee/net readiness.
- Batch review.
- Reconciliation issues.
- Actual bank deposit matching.
- Payment health alerts.

Use **Settings → Helcim** only for configuration:

- API token and server-side Helcim credentials.
- Terminal/device code setup.
- Payment update signing secret setup.
- Connection checks before live card processing.

Do not use Settings for daily payment review.

## Common issues and fixes

| Issue | What to do |
|-------|------------|
| Fee not ready | Run **Sync Fees** later. Helcim may not have exposed the fee yet. |
| Batch not settled | Check **Batches** and rerun **Sync Batches** after settlement time. |
| Missing Payment | Open the issue and use **Link Payment** only if the matching Riverside payment is clearly the same amount/provider. |
| Not in Deposit | Check whether the batch has settled and whether sync is current. |
| Deposit difference | Compare linked expected batches with the actual bank deposit. Add a note before accepting any variance. |
| Sync failed | Check **Health**, then escalate to an admin if the failure repeats. |

## When to get a manager

Get a manager or bookkeeper before:

- Marking a warning or critical issue expected/resolved.
- Accepting a deposit variance.
- Linking a processor payment to a Riverside payment.
- Reviewing a deposit that does not match expected batch totals.

Never use Payments Operations to change a sale total, refund amount, merchant fee, net amount, QBO deposit, or bank record.
