---
id: pos-register-gift-card-load-modal
title: "Register Gift Card"
order: 1071
summary: "POS guide for adding a purchased gift card load to the cart."
source: client/src/components/pos/RegisterGiftCardLoadModal.tsx
last_scanned: 2026-04-21
tags: pos, gift-cards, register, staff-manual
---

# Register Gift Card

## Screenshots

![Register dashboard](../images/help/pos/register-dashboard.png)

![Cart with lines](../images/help/pos/cart-with-lines.png)

![Checkout drawer](../images/help/pos/nexo-checkout-drawer.png)

Use this register modal when a customer is buying or reloading a **purchased** gift card at the register.

## What this is

Use this modal to add a purchased gift card load to the current register sale before payment is completed.

## What happens next

After checkout is fully paid, the gift card receives the loaded balance and the receipt summary confirms the masked card code.

## How it works

- The line is added to the cart first.
- The card is only credited after the full sale is paid.
- If the sale is canceled or left unpaid, the card does not receive the balance.
- After checkout, the sale-complete receipt summary shows the loaded card as a masked code so staff can confirm the right card was credited.

## Steps

1. Enter the load amount.
2. Scan or type the gift card code.
3. Confirm the preview looks correct.
4. Choose **Add to Cart**.
5. Finish checkout.

## Important rules

- Use this modal only for **purchased** gift cards.
- Do not use it for loyalty, donated, or promo cards.
- A void card cannot be loaded here.

## If something looks wrong

- If the code belongs to a loyalty, donated, or promo card, stop and send the issue to Back Office.
- If the amount is wrong, remove the cart line before checkout.
- If the sale is not fully paid, the card will not be credited.

## Manager review

Manager review is needed for duplicate load attempts, card-number mismatch, failed receipt delivery after a card sale, or any customer claim that value is missing. Use the transaction and gift card event history as the source of truth before issuing replacement value.

For customer-paid purchased cards, the card load should happen through Register so payment, receipt, and liability evidence stay together. Back Office review is useful for lookup and correction, but it should not replace the sale flow for new customer-paid value.
