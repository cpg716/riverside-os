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
4. **Communication**: Select "SMS" or "Email" to automatically notify the customer of their new reward via Podium.
5. **Finalize**: Click **Issue Loyalty Card**.

## Detailed Field Guide

| Field | Purpose |
| :--- | :--- |
| **Reward card code** | The loyalty gift card that will receive the full reward value. The dialog only supports reward-card issuance. |
| **Communication opt-ins** | Sends a standardized "Reward Earned" message. Note: Requires customer to have valid contact info or a linked Podium profile. |

## Tips

- **Separate checkout**: If the customer is buying something right now, finish that sale separately in the register after issuing the loyalty reward card.
- **Validation**: The system will prevent redemption if the customer's balance has dropped below the threshold since the list was last synced.
- **Couple-linked customers**: If the customer is linked as a couple, the reward is deducted from the shared primary loyalty account and the dialog uses that shared balance.

> [!TIP]
> After a successful redemption, the customer drops out of the eligible list. Use the **History** tab to confirm the reward card code, then use **Loyalty Activity** if you need to explain the point deduction.

## What happens next

After issuance, confirm the reward in **History**, then print or communicate the fulfillment materials the customer needs.
