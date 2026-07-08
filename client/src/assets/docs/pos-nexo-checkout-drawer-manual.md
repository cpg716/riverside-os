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
- **Card Not Present** is for phone orders. It opens the public HTTPS ROS handoff page; select **Open Helcim Card Entry** on that page to render the secure HelcimPay.js card form. After Helcim approves, ROS returns to the payment screen and shows the attached **CARD NOT PRESENT** tender.
- Riverside does not ask staff to enter a Helcim invoice number for Card Not Present. ROS records the approved Helcim attempt returned by the secure handoff.
- **Card refund** appears only when ROS already has the original Helcim payment reference for the refund. Staff do not enter Helcim invoice, provider, or transaction IDs. Use **Card Not Present** refund when the original card is not present. Use **Original Card** only when the customer and original card are present at the terminal.
- **Manual Card** records a card sale or refund without a live Helcim connection. Enter only the approval/reference, last four digits, and reason. Never enter full card numbers or CVV.
- **Cash**, **check**, **gift card**, **store credit**, and other tenders remain separate so the sale ledger stays auditable.
- **Donation** records a non-sale donation tender. Enter the required note before adding payment so accounting can review why the donation was taken.
- Store credit and open deposit redemptions are not treated as cash or card tender revenue.
- **Cash rounding is currently off.** Cash payments and cash refunds require the exact-cent balance. When pennyless cash rounding is enabled later, it must be recorded as a transaction-level adjustment on the main Transaction Record, not as a separate Transaction Record, pickup, deposit, or orphaned payment activity.

## Terminal display

The terminal badge shows **Terminal: #** and a small **change terminal** hint. Use that control when the lane should send card payments to a different terminal.

Register #1 defaults to Terminal 1, Register #2 defaults to Terminal 2, and Registers #3/#4 choose an available configured terminal. A missing unused terminal slot should not block a register whose selected Helcim terminal is configured.

If a card attempt is canceled and retried, use the current checkout status before sending another request. A message that a Helcim attempt does not belong to the register session means the pending terminal attempt no longer matches the active checkout attempt. Cancel the stale attempt, confirm the till is still open, then send a fresh card request.

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
