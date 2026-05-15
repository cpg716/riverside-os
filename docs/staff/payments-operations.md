# Payments Operations

**Purpose:** Use ROS as the daily card-payment workspace. Helcim remains the card processor, but staff should use **Payments** to review activity, batches, issues, sync health, and actual bank deposits.

Use this guide for **Back Office → Payments**. Use **Settings → Helcim** only for configuration/readiness checks and integration troubleshooting. Developer and integration contracts live in [`../HELCIM.md`](../HELCIM.md).

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
| Use a non-default Helcim terminal on Register #1/#2 | `payments.terminal.override` |

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

If Helcim has not provided a value, ROS shows **Fee not ready** or **Net not ready**. Do not treat a missing fee or net as `$0.00`. Fee/net readiness is a tracking signal, not a reason by itself to stop daily payment review.

If there are no card payments yet, the tab shows **No payments yet today**. Run sync later after card activity begins.

## Register card payments

Use the POS checkout drawer for live card collection.

- **Card Reader** sends the sale amount to the selected Helcim terminal for tap, insert, or swipe.
- **Manual Card** is for phone orders. It still uses the selected Helcim terminal; staff key the card on the terminal. Do not type card numbers or CVV into ROS notes, references, search fields, or support chats.
- **Saved Card** charges a Helcim-saved card token for the selected customer. ROS shows masked card details when Helcim returns them, but staff should never copy or expose the token.
- **Card Refund** appears for refund/negative checkout totals. ROS sends the refund to the selected Helcim terminal and records it only after Helcim approval.

Terminal selection is in the checkout drawer header. Register #1 defaults to **Terminal 1**, Register #2 defaults to **Terminal 2**, and Register #3/#4 must choose an available terminal. A green dot means the selected terminal path is ready; a red dot means configuration, routing, or terminal availability needs attention.

The **Payment Status** panel shows whether a terminal transaction was sent, is waiting for approval, approved, declined, canceled, expired, or returned an error code. Do not complete the sale until the Helcim attempt is approved and appears as an applied payment.

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

## RMS Charge

Use **RMS Charge Sale** and **RMS Charge Payment** as normal manual financial workflows. Staff do not need a live CoreCard API post to record the sale, collect an RMS payment, or preserve the operational reference trail in ROS.

Required details:

- **Customer** and **Account**.
- **Program**.
- Financed amount or payment amount.
- **Reference Number** when available.
- Payment tender for RMS Charge payment collection.

The **Reference Number** is the approval, authorization, merchant, or support reference from the approved R2S/CoreCard process. Never enter a PAN, CVV, card token, or full account number in this field.

RMS Charge entries appear in customer history, RMS Charge reporting, and reconciliation review. They preserve the staff actor, timestamps, account/program metadata, and reference details. ROS does not imply that bank deposit matching, QBO posting, or live CoreCard settlement happened automatically.

Manual RMS Charge refunds and reversals are recorded manually against the RMS Charge transaction/reference trail. Future live-post references are not required for that manual tracking path.

Every POS-created RMS Charge Sale and RMS Charge Payment must be reported to R2S by the next day. This is tracked in **Customers → RMS Charge**, not the Payments workspace. Use the `Report to R2S` status, due date, and `Mark Reported` action on the RMS Charge record after staff complete the R2S follow-up.

If live CoreCard automation is enabled later, ROS may add host references automatically after validated live reads/posts. The staff workflow remains **RMS Charge Sale**, **RMS Charge Payment**, **Reference Number**, **Program**, and **Account**.

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
- **Batch has not settled**
- **Deposit needs review**
- **Payment update failed**
- **Terminal not ready**

Sync actions:

- **Sync Batches** pulls Helcim batch/transaction data.
- **Sync Fees** pulls explicit Helcim fee/net data. If fees are not available yet, ROS keeps them as **Fee not ready** instead of estimating them or treating them as `$0.00`.
- **Replay Last Update** retries the latest failed Helcim payment update from the stored webhook event. Processed or ignored updates cannot be replayed.
- **Ping** sends a Helcim device ping to confirm that an API-mode terminal is listening.

Payment alerts are reminders, not financial corrections. Alerts may clear when the condition disappears, but reconciliation and deposit issues remain manual until staff act.

Alert recipients follow the Payments permission split: sync failures go to staff who can run payment sync, payment-health alerts go to staff who can view Payments, reconciliation alerts go to staff who can review payment issues, and deposit alerts go to staff who can review actual deposits.

Terminal status comes from Helcim device and card-terminal APIs. Device codes are still configured in **Settings → Helcim**, but daily readiness checks belong in **Payments → Health**. If a ping returns a device-not-listening or rate-limit message, do not retry repeatedly; confirm the terminal is signed in, in API mode, and assigned to the correct register.

Provider errors, including Helcim rate limits, remain visible in the issue text so staff can decide whether to retry later or escalate instead of repeatedly submitting the same payment action.

### Helcim payment updates and terminal review

Helcim can send signed terminal webhooks to ROS when the store has a public HTTPS ROS API URL. The delivery path is:

```text
/api/webhooks/helcim
```

Admins configure the public delivery URL and signing secret in **Settings → Helcim**. Helcim should send only the terminal events ROS handles: `cardTransaction` and `terminalCancel`.

For production, the public delivery URL must be reachable from the internet. If the store uses Cloudflare Tunnel, the tunnel service must be running on the host that can reach the ROS API. If Cloudflare shows a tunnel error such as `1033`, terminal approval/cancel webhooks cannot reach ROS even though ROS and the register may be open locally.

Keep these two states separate during review:

- **Webhook received by ROS** means a signed Helcim delivery reached ROS and was stored.
- **Provider event attached to ROS checkout** means ROS matched that stored event to one safe pending terminal checkout attempt.

Webhook receipt alone does not record a payment in ROS. If Payments Health says **Provider event not attached to ROS checkout**, treat it as provider evidence requiring review, not as a completed ROS payment.

If the webhook signing secret is missing or wrong, ROS rejects the delivery before it enters Payments Health. Ask an admin to check server logs and Settings → Helcim before assuming Helcim did not send anything.

## Register terminal routing

Riverside uses two shared Helcim terminals:

- **Register #1** defaults to **Terminal 1**.
- **Register #2** defaults to **Terminal 2**.
- **Register #3** is Backoffice and must choose **Terminal 1** or **Terminal 2** before sending a terminal payment.
- **Register #4** is Smartphone use and must choose **Terminal 1** or **Terminal 2** before sending a terminal payment.

Staff never type Helcim device codes in POS. Device codes are configured only in **Settings -> Helcim** as **Terminal 1 device code** and **Terminal 2 device code**.

If POS shows **Terminal in use by Register #X**, another payment attempt is still pending on that terminal. Do not send another payment to that terminal until the existing attempt is approved, canceled, failed, or expires locally. If the message does not clear after the customer leaves the terminal flow, check **Payments -> Health** and escalate before retrying repeatedly.

Register #1/#2 non-default terminal use requires Manager Access through `payments.terminal.override` or admin compatibility. Register #3/#4 choosing either configured terminal does not require that override because choosing is the normal workflow for those lanes.

## Refund safety

Card refunds that go through Helcim create a durable provider-attempt audit row before ROS records the refund. ROS only writes the negative payment and updates the refund queue after Helcim returns an approved or captured refund status.

If Helcim declines the refund, returns a rate-limit response, or the provider request fails, ROS keeps the refund state unchanged and records the failed provider attempt for review.

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

- API token and Helcim credential entry. The API token enables Helcim batch, transaction, settlement, and fee reads.
- Terminal 1 and Terminal 2 device code entry.
- Register routing visibility: Register #1 -> Terminal 1, Register #2 -> Terminal 2, Register #3/#4 choose Terminal 1 or Terminal 2.
- Payment update webhook path, supported event list, and signing secret entry.
- Connection checks before live card processing.

Saved integration credentials are encrypted server-side. Staff should enter them in Backoffice Settings instead of editing environment files. The server still needs its credential encryption key configured by an administrator before Settings can save new secrets.

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
