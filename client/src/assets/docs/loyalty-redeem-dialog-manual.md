---
id: loyalty-redeem-dialog
title: "Reward Redemption Dialog"
order: 1044
summary: "Load one or more configured reward blocks onto each loyalty gift card."
source: client/src/components/loyalty/LoyaltyRedeemDialog.tsx
last_scanned: 2026-04-11
tags: loyalty, redemption, gift-cards, checkout
---

# Reward Redemption Dialog

## Screenshots

![Customers ready for a loyalty reward](../images/help/loyalty-workspace/eligible.png)

![Loyalty reward issuance history](../images/help/loyalty-workspace/history.png)

![Adjust loyalty points and review activity](../images/help/loyalty-workspace/adjust-points.png)

The **Reward Redemption Dialog** is the final step in the loyalty reward cycle. It lets staff choose how many available reward blocks to load on the scanned loyalty gift card.

## What this is

Use this dialog to convert an eligible loyalty balance into a real reward card for the customer.

## When to use it

Open this dialog only after the customer appears in the eligible pool and you are ready to issue the reward card immediately.

## How to use it

1. **Initiate Redemption**: Click "Redeem" on an eligible customer in the Loyalty Workspace.
2. **Choose the Card Amount**:
    - Verify the available points and reward blocks.
    - Use **−**, **+**, the number field, or **Use all** to choose how many configured reward blocks go on this card.
    - With the standard $50 reward, choosing 2 loads $100 and choosing 7 loads $350.
3. **Scan a Loyalty Gift Card**:
    - Enter or scan the complete eight-digit numeric loyalty gift card code that will receive the reward.
4. **Finalize**: Click **Issue $[amount] Card**.
5. Repeat with another card for any remaining rewards, or close/skip to leave those points available for later.

Riverside stores the card as **Loyalty**, marks it as non-liability, and sets expiration to one calendar year from the server-recorded issue time. Printed letters and History use that saved expiration rather than recalculating it in the browser.

## Detailed Field Guide

| Field | Purpose |
| :--- | :--- |
| **Reward blocks on this card** | Number of configured reward increments to load on this card. The amount and remaining points update immediately. |
| **Reward card code** | The loyalty gift card that will receive the selected reward value. The dialog only supports reward-card issuance. |

## Tips

- **Separate checkout**: If the customer is buying something right now, finish that sale separately in the register after issuing the loyalty reward card.
- **Validation**: Riverside rejects incomplete or non-numeric card scans before deducting points or creating card value. It also prevents redemption if the customer's balance has dropped below the threshold since the list was last synced.
- **Safe retry**: If a response is interrupted, retry the same card entry. Riverside uses the original request identity so points and card value are not posted twice.
- **Flexible split**: A customer with $150 available can load $100 on one card and $50 on another. A customer with $400 can load $350 and leave the final $50 available.
- **Couple-linked customers**: If the customer is linked as a couple, the reward is deducted from the shared primary loyalty account and the dialog uses that shared balance.

> [!TIP]
> After a successful redemption, the customer drops out of the eligible list. Use the **History** tab to confirm the reward card code, expiration, and issuing staff member, then use **Loyalty Activity** if you need to explain the point deduction.

## What happens next

After issuance, confirm the reward in **History**, then print or communicate the fulfillment materials the customer needs.
