---
id: payments-workspace
title: "Payments Operations"
order: 85
summary: "Review Helcim transactions, batches, deposits, reconciliation issues, and payment health without changing processor truth."
source: client/src/components/payments/PaymentsWorkspace.tsx
last_scanned: 2026-07-22
tags: payments, helcim, batches, deposits, reconciliation, terminal, refunds
status: approved
---

# Payments Operations

## Screenshots

![Payments overview](../images/help/payments-workspace/overview.png)

![Processor batches](../images/help/payments-workspace/batches.png)

![Payments health](../images/help/payments-workspace/health.png)

## What this is

Payments Operations is the Back Office workspace for reviewing Riverside card activity against Helcim processor facts. It covers today's activity, processor batches, actual deposits, reconciliation exceptions, transaction lookup, processor-update attachment, and integration health.

When a POS customer is selected, Riverside now creates or reuses that customer's Helcim profile before starting a terminal purchase and sends the Helcim customer code with the payment. This is what allows Helcim's Contact Name/Cardholder Name columns to be populated consistently; older guest payments cannot be renamed retroactively by Riverside.

Use the Register checkout drawer to collect payment. Start card refunds from the original Transaction Record through the guided return or exchange workflow. Payments Operations remains a review and recovery workspace; it does not offer a standalone provider-refund form.

## Before you start

- Viewing requires payment access; syncing, linking, resolving, or accepting differences requires the matching elevated permission.
- Never enter a full card number, CVV, provider token, or private credential in Riverside notes.
- Never type a Helcim transaction ID into a standalone refund form. Open the original Transaction Record so ROS can preserve merchandise, tender, settlement, and audit links together.
- Missing fee or net information means **not ready**, not `$0.00`.
- A batch fee or net is copied to the Riverside payment only when one current Helcim row uniquely links by provider transaction ID and its gross amount, USD currency, final status, and purchase/refund direction agree with Riverside. Any missing, duplicate, or conflicting evidence opens an issue and leaves the payment ledger unchanged. **Unavailable from provider** is not counted as synchronized or as a zero fee, and scheduled retries are paced to avoid provider throttling.
- Automatic deposit links require current USD evidence and either an explicit provider deposit/net amount or a complete net total from all current successful batch transactions. Helcim **net sales** is not treated as bank-deposit evidence. If that evidence later regresses, Riverside marks the imported deposit **Needs review**, unlinks the batch, and records the change in its audit history; verified evidence can relink it later.
- If the terminal and Riverside disagree, do not run the card again until the first attempt is checked.

## Review today's status

1. Open **Payments → Overview**.
2. Review card sales, known fees, expected net, expected deposits, open review items, and last sync status.
3. Treat warning and critical issues as evidence to investigate, not automatic permission to edit a Transaction Record.
4. Open the related tab for details.
5. Record a review note when the issue requires follow-up across shifts.

## Review batches and deposits

1. Open **Batches**, set **From** and **To** for any day, multi-day period, month, or longer range, and search by processor batch number or status. Select **Apply**.
2. Confirm the processor batch number, status, close time, transaction count, and available totals. Use the approved sync action when current processor data is needed.
3. Open **Deposits**, set the needed period, and search by source, QBO deposit, or bank reference before comparing expected batches with actual deposits.
4. Use **Clear** to return a list to all dates with no search.
5. Link only records that clearly represent the same processor settlement.
6. Escalate unexplained amount, fee, net, or timing differences.

Creating a manual deposit or accepting a variance is an audited manager/bookkeeper action. It does not rewrite the original card payment.

## Resolve reconciliation issues

1. Open **Reconciliation**.
2. Read the issue type, Riverside payment, Helcim reference, amount, status, and history.
3. Use **Reviewed** when investigation is ongoing.
4. Use **Link Payment** only after provider, amount, and ownership match.
5. Use **Resolved** or **Mark Expected** only with the required explanation and evidence.
6. Reopen an issue if later evidence shows the resolution was incorrect.

## Check a transaction or health problem

1. Open **Transactions**, set the needed date range, and search by customer, `TXN-` number, provider transaction, batch, or payment method. Select **Apply** to search the complete period.
2. Follow the Transaction number to the financial record when one is linked.
3. An approved **Card Not Present** payment that lost its checkout attachment appears as **Unlinked** / **Missing ROS TXN**. Do not charge the card again; finish the retained checkout or use the audited recovery workflow in **Health → Helcim Terminal Review**.
4. Open **Health** for terminal, automatic processor update, sync, provider-reference, and failed-update evidence.
5. Replay only the stored failed update after its configuration or data problem is corrected.
6. Confirm the replay attached existing provider evidence rather than creating a second charge.

**Reviewed: no ROS action** records staff's investigation but does not hide or financially resolve an approval that is still unlinked. The approval remains visible until an audited link, recovery, refund, or later processor evidence actually resolves it.

## Recover an approved card sale from a retained cart

Use this only when **Health → Helcim Terminal Review** shows an approved charge and an **Exact retained cart found** card.

1. Confirm the customer, parked-sale label, amount, Register number, provider transaction, and approval time all describe the same sale.
2. Select **Recover Paid Sale**. This action requires payment-resolution access and Manager Access.
3. Enter a specific recovery note explaining why Helcim approved the card but the ROS checkout did not finish.
4. Type **RECOVER PAID SALE** in the second confirmation.
5. Wait for the recovered Transaction number. Do not run the card again.
6. Open the recovered Transaction and confirm its lines, customer, payment, balance, order status, and Helcim reference.

ROS refuses recovery when the retained cart is missing or ambiguous, the cart total differs from the approval, the register sessions differ, the provider transaction is already linked, the processor evidence is not one approved USD purchase, or the cart needs a specialized Wedding or Alterations workflow. Refund, reverse, non-USD, declined, and identity-mismatched processor rows cannot be recovered as a sale. A successful recovery creates the sale through normal checkout logic and records the manager, original operator, original approval time, parked cart, payment allocation, and Helcim match in one audited database transaction.

## Card Not Present checkout handoff

1. Select **Helcim Card Not Present** in the open Register checkout. This opens Helcim's secure hosted card-entry page; it does not use the physical terminal.
2. Keep the checkout open while the card is entered. The hosted page returns the approval and provider transaction to the same checkout using its signed response. Riverside accepts it only for the exact handoff request, provider attempt, checkout, customer, and amount.
3. Review the approval details in the Riverside handoff screen and select **Add Payment to Sale**. This posts the approved amount to the checkout ledger and enables **Record Sale**.
4. If the handoff is interrupted, use **Recover Payment** or **Check Status** from the same checkout. These actions reuse the existing Helcim approval and are safe to repeat; they do not create a second charge.
5. If the payment was approved but cannot be attached, stop retrying the card and use **Health → Helcim Terminal Review** to recover it to the exact retained checkout or target Transaction Record.

The Card Not Present flow must never be routed to a physical terminal. A successful approval is not complete in Riverside until the payment appears in the checkout ledger and the resulting Transaction Record shows the Helcim provider reference. After the approval is attached—or provider recovery proves a definitive decline/cancel—completing or clearing the sale resets the hosted handoff. An unresolved result keeps the sale locked and visible in Payments Health.

## Recover an approved card payment onto an existing order

Use this only when the customer has an open Transaction Record, Helcim approved the payment, and no retained-cart match exists.

1. Compare the terminal receipt, customer, amount, approval time, and provider transaction in **Health → Helcim Terminal Review**.
2. Select **Recover Order Payment** on the exact approved terminal attempt.
3. Enter the open target Transaction Record, such as `TXN-624363`.
4. Enter a specific recovery note explaining why the approved payment was not recorded.
5. Type **RECOVER ORDER PAYMENT** to authorize the financial recovery.
6. Reopen the customer and target Transaction Record. Confirm the payment, remaining balance, customer history, and Helcim match.

ROS refuses recovery when the target is missing, closed, belongs to no customer, has no order lines, has no balance, cannot accept the full approved amount, or the Helcim processor transaction is missing, mismatched, or already linked. The action uses the existing approval and never charges the card again.

## What to watch for

- Processor update received, checkout attached, and provider reference saved are different states.
- A normal decline or cancellation is not an approved payment.
- Never retry blindly after a terminal approval that Riverside has not attached.
- Approved provider payments cannot be removed, parked, or transferred to another customer. **Clear Sale**, another tender, and **Record Sale** remain unavailable while a card request is pending or unverified, or while an approval is still unattached. Continue only after ROS attaches the approval or recovers a definitive provider decline/cancel; live pending attempts cannot be released locally. Use Payments Health when the checkout cannot recover the result.
- Never use paid-sale recovery to force a near match. The exact retained-cart banner must be present.
- Card refunds must originate from the original Transaction Record and remain part of the guided return or exchange settlement. Payments Operations shows the resulting provider and recovery evidence without creating a separate processor-only refund.
- Do not resolve a reconciliation warning merely to make the dashboard green.
- Batches, deposits, and payment transactions load in pages. Search is applied by the Main Hub to the full matching record set; select **Apply**, then use **Previous** or **Next** instead of treating the current page as the complete history.
- Deposit summary cards labeled **Page** total only the records on the current page. If refresh fails, Riverside identifies the data as last loaded instead of presenting it as current.

## What happens next

Completed review leaves an auditable history for register close, bookkeeping, QBO clearing, deposit reconciliation, and support follow-up while preserving processor and financial source records.

## Related workflows

- [Checkout & Payment](manual:pos-nexo-checkout-drawer)
- [Closing the Register](manual:pos-close-register-modal)
- [QBO Workspace](manual:qbo-workspace)
- [Helcim Settings](manual:settings-helcim-settings-panel)
