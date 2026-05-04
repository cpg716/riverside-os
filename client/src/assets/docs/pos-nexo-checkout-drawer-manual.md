---
id: pos-nexo-checkout-drawer
title: "Nexo Checkout Drawer (pos)"
order: 1061
summary: "Guide to the high-level checkout flow, focusing on Helcim card processing."
source: client/src/components/pos/NexoCheckoutDrawer.tsx
last_scanned: 2026-04-11
tags: pos, checkout, helcim, card, payment
---

# Checkout & Payment (Nexo)

The Checkout Drawer is the final step for every sale. It handles tender collection, receipt generation, and real-time Helcim integration.

![Payment Ledger / Checkout Drawer](../images/help/pos/nexo-checkout-drawer.png)

## What this is

Use the **Checkout** side panel to collect payments, apply deposits, and finalize the transaction. It is designed to guide the cashier through the correct tender sequence for Retail, Order, and Wedding sales.

## What this is

Use this drawer to collect tender, finish checkout, and hand the customer into receipt delivery.

## How to use it

1. Review the cart totals and apply any final discounts.
2. Select the customer's preferred **Payment Method**.
3. Follow the specific prompts for that tender (e.g., swipe card, enter cash amount, or scan check).
4. Tap **"Finalize Order"** to complete the transaction and print receipts.

## Credit card processing (Helcim)

Riverside OS collects integrated card payments through Helcim terminal checkout.

### Terminal (Card Reader)
Staff initiate the payment from ROS, and the customer taps, swipes, or inserts their card on the physical Reader.
- **Auto-Reconcile**: The terminal automatically communicates the success status and fee data back to ROS.

## Refunds & Exchanges

- **Card Refunds**: If an order was originally paid via Helcim, the refund can be processed through the Helcim return flow.
- **Exchanges**: If the customer is returning an item and buying another, the drawer will show the **Net Balance Due** or **Refund Due**.

## RMS Charge rules

When staff use `RMS Charge`, RiversideOS follows the existing financing rules already enforced by checkout:

- an attached Riverside customer is required first
- Riverside must resolve the linked RMS account before a charge or RMS payment can continue
- new RMS charges require an eligible plan selection
- RMS payment collection posts against the selected RMS account and should not be treated like a normal retail cash or check payment on the sale

## Tips

- **Split Tenders**: You can split a single order across multiple payment methods (e.g., $100 Cash + $200 Card). ROS will track the fees for the card portion only.
- **Receipts**: After a successful Helcim payment, you can send an SMS or Email receipt via the **Receipt Summary** modal.

## What happens next

After checkout succeeds, continue to the receipt summary screen to print, retry, or send the receipt.
