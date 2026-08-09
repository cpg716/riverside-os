---
id: loyalty-redeem-dialog
title: "Reward Redemption Dialog"
order: 1044
summary: "Finalize loyalty reward redemptions by issuing the full reward to a loyalty gift card."
source: client/src/components/loyalty/LoyaltyRedeemDialog.tsx
last_scanned: 2026-04-11
tags: loyalty, redemption, gift-cards, checkout
---

# Reward Redemption Dialog

## Screenshots

![Customers ready for a loyalty reward](../images/help/loyalty-workspace/eligible.png)

![Loyalty reward issuance history](../images/help/loyalty-workspace/history.png)

![Adjust loyalty points and review activity](../images/help/loyalty-workspace/adjust-points.png)

The **Reward Redemption Dialog** is the final step in the loyalty reward cycle. It allows staff to deduct points from a customer and issue the full reward to a loyalty gift card.

## What this is

Use this dialog to convert an eligible loyalty balance into a real reward card for the customer.

## When to use it

Open this dialog only after the customer appears in the eligible pool and you are ready to issue the reward card immediately.

## How to use it

1. **Initiate Redemption**: Click "Redeem" on an eligible customer in the Loyalty Workspace.
2. **Review Points & Value**: 
    - Verify the "Points Available" (must be above threshold).
    - Review the "Reward Value" (e.g., $50.00).
3. **Scan a Loyalty Gift Card**:
    - Enter or scan the loyalty gift card code that will receive the reward.
4. **Finalize**: Click **Issue Loyalty Card**.

Riverside stores the card as **Loyalty**, marks it as non-liability, and sets expiration to one calendar year from the server-recorded issue time. Printed letters and History use that saved expiration rather than recalculating it in the browser.

## Detailed Field Guide

| Field | Purpose |
| :--- | :--- |
| **Reward card code** | The loyalty gift card that will receive the full reward value. The dialog only supports reward-card issuance. |

## Tips

- **Separate checkout**: If the customer is buying something right now, finish that sale separately in the register after issuing the loyalty reward card.
- **Validation**: The system will prevent redemption if the customer's balance has dropped below the threshold since the list was last synced.
- **Safe retry**: If a response is interrupted, retry the same card entry. Riverside uses the original request identity so points and card value are not posted twice.
- **Couple-linked customers**: If the customer is linked as a couple, the reward is deducted from the shared primary loyalty account and the dialog uses that shared balance.

> [!TIP]
> After a successful redemption, the customer drops out of the eligible list. Use the **History** tab to confirm the reward card code, expiration, and issuing staff member, then use **Loyalty Activity** if you need to explain the point deduction.

## What happens next

After issuance, confirm the reward in **History**, then print or communicate the fulfillment materials the customer needs.
