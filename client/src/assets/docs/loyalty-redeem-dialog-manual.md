---
id: loyalty-redeem-dialog
title: "Reward Redemption Dialog"
order: 1044
summary: "Finalize loyalty reward redemptions, apply to sales, or load onto new gift cards."
source: client/src/components/loyalty/LoyaltyRedeemDialog.tsx
last_scanned: 2026-04-11
tags: loyalty, redemption, gift-cards, checkout
---

# Reward Redemption Dialog

The **Reward Redemption Dialog** is the final step in the loyalty reward cycle. It allows staff to deduct points from a customer and convert them into a tangible reward.

## How to use it

1. **Initiate Redemption**: Click "Redeem" on an eligible customer in the Loyalty Workspace.
2. **Review Points & Value**: 
    - Verify the "Points Available" (must be above threshold).
    - Review the "Reward Value" (e.g., $50.00).
3. **Redemption Options**:
    - **Apply to current sale**: Enter an amount to deduct immediately from an open cart.
    - **Load to Gift Card**: If there is a remainder (or the full amount), scan a new physical Gift Card to load the balance.
4. **Communication**: Select "SMS" or "Email" to automatically notify the customer of their new reward via Podium.
5. **Finalize**: Click **Redeem** or **Load Card**.

## Detailed Field Guide

| Field | Purpose |
| :--- | :--- |
| **Apply to current sale ($)** | Deducts this amount from the reward value and applies it as a "Loyalty" tender to the active register session. |
| **Gift card for remainder** | Only appears if some or all of the reward is not applied to a sale. You must scan a valid card code here to store the reward for future use. |
| **Communication opt-ins** | Sends a standardized "Reward Earned" message. Note: Requires customer to have valid contact info or a linked Podium profile. |

## Tips

- **$0.00 Redemptions**: To purely load a reward onto a card for the customer to take home, ensure "Apply to current sale" is set to `$0.00`.
- **Validation**: The system will prevent redemption if the customer's balance has dropped below the threshold since the list was last synced.

> [!TIP]
> After a successful redemption, the customer's record in the Loyalty Workspace will clear from the "Elite Pool" and appear in the "History" tab for letter printing.
