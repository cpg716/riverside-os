---
id: pos-nexo-checkout-drawer
title: "Nexo Checkout Drawer (pos)"
order: 1061
summary: "Guide to the high-level checkout flow, focusing on Stripe card processing and phone orders."
source: client/src/components/pos/NexoCheckoutDrawer.tsx
last_scanned: 2026-04-11
tags: pos, checkout, stripe, card, manual-entry, payment
---

# Nexo Checkout Drawer (pos)

<!-- help:component-source -->
_Linked component: `client/src/components/pos/NexoCheckoutDrawer.tsx`._
<!-- /help:component-source -->

The **Checkout Drawer** is the final step for every sale. It handles tender collection, receipt generation, and real-time Stripe integration.

## What this is

Use this drawer to collect tender, finish checkout, and hand the customer into receipt delivery.

## How to use it

1. Review the cart totals and apply any final discounts.
2. Select the customer's preferred **Payment Method**.
3. Follow the specific prompts for that tender (e.g., swipe card, enter cash amount, or scan check).
4. Tap **"Finalize Order"** to complete the transaction and print receipts.

## Credit card processing (Stripe)

Riverside OS supports two primary ways to collect card payments:

### 1. Terminal (Card Reader)
Staff initiate the payment from ROS, and the customer taps, swipes, or inserts their card on the physical Reader.
- **Auto-Reconcile**: The terminal automatically communicates the success status and fee data back to ROS.

### 2. Manual Entry (MOTO / Phone Orders)
Used for taking payments over the phone or when a physical card is not present.
- **Secure Vaulting**: Staff enter the card number, CVV, and zip code into the secure Stripe popup. Card data never touches Riverside servers.
- **Reporting**: These are flagged as "Manual" or "MOTO" in your financial reports for audit purposes.

## Refunds & Exchanges

- **Card Refunds**: If an order was originally paid via Stripe, the refund can be processed back to the original card directly from the **Orders Workspace**. A physical card is not required for the refund.
- **Exchanges**: If the customer is returning an item and buying another, the drawer will show the **Net Balance Due** or **Refund Due**.

## RMS Charge rules

When staff use `RMS Charge`, RiversideOS follows the existing financing rules already enforced by checkout:

- an attached Riverside customer is required first
- Riverside must resolve the linked RMS account before a charge or RMS payment can continue
- new RMS charges require an eligible plan selection
- RMS payment collection posts against the selected RMS account and should not be treated like a normal retail cash or check payment on the sale

## Tips

- **Split Tenders**: You can split a single order across multiple payment methods (e.g., $100 Cash + $200 Card). ROS will track the fees for the card portion only.
- **Receipts**: After a successful Stripe payment, you can send an SMS or Email receipt via the **Receipt Summary** modal.

## What happens next

After checkout succeeds, continue to the receipt summary screen to print, retry, or send the receipt.
