---
id: gift-cards-workspace
title: "Gift Cards Workspace"
order: 1010
summary: "Back Office gift card guide for looking up cards, issuing donated cards, and voiding cards safely."
source: client/src/components/gift-cards/GiftCardsWorkspace.tsx
last_scanned: 2026-04-21
tags: gift-cards, back-office, staff-manual
---

# Gift Cards Workspace

The Gift Cards workspace is the Back Office control surface for managing the store's gift card liability and promotional card issuance.

![Gift Cards Workspace Main List](../images/help/gift-cards-workspace/main.png)

## What this is

Use this workspace to look up card balances, review transaction history, issue promotional (donated) cards, and void cards when necessary. 

> [!IMPORTANT]
> Purchased gift cards must be sold or reloaded from the **Register** to ensure correct financial recording. This workspace is for administrative management and promotional issuance only.

## What this screen is for

- Review open cards and current liability totals.
- Look up a card by code, kind, or status.
- Review recent activity for the selected card.
- Issue a donated/giveaway card.
- Void a card when a manager has approved it.

## What this screen is not for

- Regular register redemption during checkout.
- Customer-paid purchased gift card sales or reloads. Use **Register → Gift Card** so the sale, tender, card event, and gift card liability stay together.
- Loyalty reward issuance from the monthly loyalty flow.
- Manual balance corrections without approval.

## Card kinds

- **Purchased**: customer-paid gift cards sold from Register. These increase gift card liability when sold/loaded and reduce gift card liability when redeemed.
- **Loyalty reward**: rewards issued from the loyalty workflow. These are not purchased-card liabilities.
- **Donated / giveaway**: promotional cards. These do not use the purchased gift card liability path.

## How to use it

### Refresh card list

1. Open **Gift Cards** in Back Office.
2. Select filters if needed.
3. Select a card row to open its detail panel.
4. Click **Refresh Cards** to reload the current list.

## What the detail panel shows

- Current balance and original value
- Status and expiration date
- Linked customer, if any
- Notes
- Recent activity such as issued, loaded, used at checkout, refunded to card, and voided

### Issue a donated card

1. Open **Issue Donated**.
2. Enter the card code and amount.
3. Add notes that explain why the card was issued.
4. Confirm the new card appears in the list.

### Void a card

1. Find the card in the list.
2. Confirm you have the right code and balance.
3. Use **Void** only when policy allows it.
4. Refresh the list and confirm the card is no longer active.

## Checkout reminder

When a cashier redeems a gift card in checkout, Riverside matches the card type from the real card record. If the cashier picks the wrong gift card type, checkout blocks the payment and tells them which type to use.

## Tips

- Treat gift cards like cash.
- If a customer says the balance is wrong, compare the card and the event history before changing anything.
- Use notes on donated cards so finance and support can tell why the card exists.
