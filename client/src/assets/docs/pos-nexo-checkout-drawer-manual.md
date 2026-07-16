---
id: pos-nexo-checkout-drawer
title: "Checkout & Payment"
order: 1061
summary: "Collect payment, monitor Helcim card status, and complete a sale from the POS checkout drawer."
source: client/src/components/pos/NexoCheckoutDrawer.tsx
last_scanned: 2026-05-10
tags: pos, checkout, helcim, card, payment, receipt
status: approved
---

# Checkout & Payment

## Screenshots

![Register dashboard](../images/help/pos/register-dashboard.png)

![Cart with lines](../images/help/pos/cart-with-lines.png)

![Checkout drawer](../images/help/pos/nexo-checkout-drawer.png)

## What this is

The checkout drawer collects payment, shows the remaining balance due, and completes the sale. It keeps terminal and hosted Card Not Present payment status visible while the cart stays in the background.

## How to use it

1. Select the payment method the customer is using.
2. Confirm the balance due and choose full balance or split payment.
3. Collect the tender and watch the payment status panel.
4. Complete the sale only after the drawer shows the payment rules are satisfied.

## Payment methods

Choose the tender type on the left, then collect the amount in the center panel.

- **Card reader** sends the payment to the selected Helcim terminal.
- **Card Not Present** is for phone orders. It opens the public HTTPS ROS handoff page; select **Open Helcim Card Entry** on that page to render the secure HelcimPay.js card form. After Helcim approves, ROS automatically attaches the validated approval amount as a **CARD NOT PRESENT** tender; verify it appears in the register ledger before recording the sale. The approval screen's **Add Payment to Sale** button remains available as an idempotent recovery action if the handoff was interrupted. Use **Cancel Card Entry** on the handoff or the drawer's cancel control before approval when the customer stops; the drawer returns to the ledger so you can retry or cancel the pending attempt.
- If Helcim shows **Successful** but ROS cannot attach the approval immediately, keep the handoff open and select **Retry Approval** or **Recover payment** in ROS. ROS preserves the original Helcim response for verification and retries the attach without charging the card again. Do not enter a manual payment or charge the card again while ROS is recovering the approved attempt.
- Riverside does not ask staff to enter a Helcim invoice number for Card Not Present. ROS records the approved Helcim attempt returned by the secure handoff.
- Helcim may ask for billing ZIP and street address during Card Not Present entry. Those fields are controlled by Helcim's hosted verification form, not by ROS.
- **Card refund** appears only when ROS already has the original Helcim payment reference for the refund. Staff do not enter Helcim invoice, provider, or transaction IDs. Use **Card Not Present** refund when the original card is not present. Use **Original Card** only when the customer and original card are present at the terminal.
- Helcim debit/Interac refunds require **Original Card** with the customer and original card present at the terminal. Credit-card refunds use the Payment API and do not require the customer to present the card.
- In a guided return or exchange, a **Card Not Present** refund is staged in the checkout ledger and processed by ROS during final settlement. Do not start a second Helcim refund; wait for the refund or exchange confirmation before treating the return as complete.
- **Manual Card** records a card sale or refund without a live Helcim connection. Enter only the approval/reference, last four digits, and reason. Never enter full card numbers or CVV.
- **Cash**, **check**, **gift card**, **store credit**, and other tenders remain separate so the sale ledger stays auditable.
- For **gift card**, scan or enter the card and wait for Riverside to show its verified **Regular**, **Loyalty**, **Donated**, or **Promo** type, expiration, and **Balance before this transaction**. Riverside blocks Apply until that check succeeds and blocks amounts above the available balance. Checkout verifies the balance again while recording the sale, and the completed receipt lists the card's **balance after this payment**.
- **Staff Account** appears only when the selected customer is linked to an active employee Staff Account. Use it for an employee purchase charged to their receivable balance. The merchandise still follows normal item tax rules.
- **Donation** records a non-sale donation tender. Enter the required note before adding payment so accounting can review why the donation was taken.
- When the selected customer has a wedding deposit held by another party member, the payment screen shows the available amount and most recent payer. Select **Apply $X** to add the eligible amount to this member's sale. The button does not allow the deposit to cover takeaway merchandise, another party disbursement, or an existing-order payment staged in the same checkout.
- Voiding or cancelling that Transaction Record without forfeiture restores the applied wedding deposit to the member's held balance; it is not treated as a new cash refund.
- Store credit and open deposit redemptions are not treated as cash or card tender revenue. An open deposit remains in deposit liability until the linked sale is fulfilled, when it releases to recognized revenue.
- **Cash rounding is currently off.** Cash payments and cash refunds require the exact-cent balance. When pennyless cash rounding is enabled later, it must be recorded as a transaction-level adjustment on the main Transaction Record, not as a separate Transaction Record, pickup, deposit, or orphaned payment activity.

## Terminal display

The terminal badge shows **Terminal: #** and a small **change terminal** hint. Use that control when the lane should send card payments to a different terminal.

Register #1 defaults to Terminal 1, Register #2 defaults to Terminal 2, and Registers #3/#4 choose an available configured terminal. A missing unused terminal slot should not block a register whose selected Helcim terminal is configured.

If a card attempt is canceled and retried, use the current checkout status before sending another request. A message that a Helcim attempt does not belong to the register session means the pending terminal attempt no longer matches the active checkout attempt. Cancel the stale attempt, confirm the till is still open, then send a fresh card request.

If the physical terminal was canceled but ROS still says **Waiting for Card**, select **I canceled on terminal — clear ROS**. This releases only the pending attempt with no provider transaction; an approved/provider-referenced payment remains protected for recovery.

If the terminal approves but the drawer still shows the card attempt as pending or declined, use **Recover payment** before running the card again or changing tender. ROS sends a unique invoice reference with each terminal request and can recover the approved Helcim transaction by that reference and amount when the terminal response is delayed. If the card was truly declined, use **Retry card** to clear the declined attempt and send a new ROS-tracked request to the terminal.

## Keypad and amount controls

Use **Full balance** for the normal path. Use **Split payment** only when the customer is paying with more than one tender.

While cash rounding is off, **Full balance** loads the exact-cent amount for every tender, including cash. If future rounding is enabled, only the cash portion may round, and the receipt/history must show the adjustment on the same Transaction Record.

The amount keypad is sized for register use while keeping the payment status, sale summary, and balance due visible. Any instructions for the selected tender should remain visible below the keypad without needing to scroll.

## Completing the sale

The **Complete sale** button stays unavailable until the payment rules are satisfied. After completion, Riverside OS opens the sale complete screen with print, view, text, email, and gift receipt actions.

If the Main Hub connection drops before the sale completes, keep the checkout drawer open and wait for the connection banner to clear. Do not run the card again unless the drawer and Payments Health confirm that no current or unresolved card request is pending.

If payment saves but pickup or alteration pickup follow-up does not complete, Riverside OS creates checkout recovery for manager review. Resolve that recovery before closing the register.

## What to watch for

- Do not close the drawer while a terminal request is waiting unless you intend to cancel that payment attempt.
- If a terminal is offline or mismatched, fix the terminal selection before retrying.
- If a customer changes tender type, confirm the balance due before collecting the next payment.

## Related workflows

- [Receipt Summary](manual:pos-receipt-summary-modal)
- [Gift Cards Workspace](manual:gift-cards-workspace)
