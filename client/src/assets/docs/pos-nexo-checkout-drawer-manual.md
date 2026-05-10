---
id: pos-nexo-checkout-drawer
title: "Checkout & Payment"
order: 1061
summary: "Collect payment, monitor Helcim terminal status, and complete a sale from the POS checkout drawer."
source: client/src/components/pos/NexoCheckoutDrawer.tsx
last_scanned: 2026-05-10
tags: pos, checkout, helcim, card, payment, receipt
status: approved
---

# Checkout & Payment

## What this is

The checkout drawer collects payment, shows the remaining balance due, and completes the sale. It keeps payment status visible while the cart stays in the background.

## How to use it

1. Select the payment method the customer is using.
2. Confirm the balance due and choose full balance or split payment.
3. Collect the tender and watch the payment status panel.
4. Complete the sale only after the drawer shows the payment rules are satisfied.

## Payment methods

Choose the tender type on the left, then collect the amount in the center panel.

- **Card reader** sends the payment to the selected Helcim terminal.
- **Manual card** is for approved keyed-card workflows.
- **Cash**, **check**, **gift card**, **store credit**, and other tenders remain separate so the sale ledger stays auditable.
- Store credit and open deposit redemptions are not treated as cash or card tender revenue.

## Terminal display

The terminal badge shows **Terminal: #** and a small **change terminal** hint. Use that control when the lane should send card payments to a different terminal.

If a card attempt is canceled and retried, use the current checkout status before sending another request. A message that a Helcim attempt does not belong to the register session means the pending terminal attempt no longer matches the active checkout attempt. Cancel the stale attempt, confirm the till is still open, then send a fresh card request.

## Keypad and amount controls

Use **Full balance** for the normal path. Use **Split payment** only when the customer is paying with more than one tender.

The amount keypad is sized for register use while keeping the payment status, sale summary, and balance due visible. Any instructions for the selected tender should remain visible below the keypad without needing to scroll.

## Completing the sale

The **Complete sale** button stays unavailable until the payment rules are satisfied. After completion, Riverside OS opens the sale complete screen with print, view, text, email, and gift receipt actions.

## What to watch for

- Do not close the drawer while a terminal request is waiting unless you intend to cancel that payment attempt.
- If a terminal is offline or mismatched, fix the terminal selection before retrying.
- If a customer changes tender type, confirm the balance due before collecting the next payment.
