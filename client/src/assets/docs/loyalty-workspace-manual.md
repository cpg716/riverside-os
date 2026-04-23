---
id: loyalty-workspace
title: "Loyalty Management Hub"
order: 1043
summary: "Review customers ready for rewards, check loyalty activity history, and print reward-card fulfillment materials."
source: client/src/components/loyalty/LoyaltyWorkspace.tsx
last_scanned: 2026-04-11
tags: loyalty, rewards, fulfillment, analytics
---

# Loyalty Management Hub

The Loyalty Management Hub helps staff see who is ready for a reward, review recent loyalty activity, and handle reward-card fulfillment.

## What this is

Use this workspace to manage Riverside loyalty rewards, review reward readiness, and complete fulfillment follow-up after redemption.

## How to use it

1. Start in **Customers Ready For Reward** to see who is eligible.
2. Use **Redeem** when you are ready to issue the loyalty reward to a gift card.
3. Review **Loyalty Activity** or **History** when a customer needs explanation or fulfillment follow-up.
4. Use **Program Settings** only when an authorized admin needs to change loyalty rules or letter content.

## Top Summary

At the top of the workspace, the summary cards show:
- **Points On Accounts**: Total loyalty points currently sitting on customer accounts.
- **Ready For Reward**: Customers who are at or above the reward threshold.
- **Reward Cards Issued**: Total number of loyalty reward cards issued.
- **Recent Adjustments**: Manual loyalty adjustments in the last 30 days.

## Customers Ready For Reward

This is the primary operational list. It shows customers who have reached the `loyalty_point_threshold`.

### Fulfillment Workflow
1. **Refresh Eligible Customers**: Use the refresh button to pull the latest balances.
2. **Redeem Reward**: Click the **Redeem** button to open the redemption dialog. This deducts the points and issues the full reward to a loyalty gift card.
3. **Bulk Labels**: Use this action in the header to print standard mailing labels for every member currently in the pool.

## Loyalty Activity

In the **Adjust** section, select a customer to review recent loyalty activity. The activity list explains whether points were:
- **earned**
- **removed after a return**
- **removed after a full refund**
- **manually adjusted**
- **deducted when a reward card was issued**

For couple-linked customers, Riverside resolves loyalty to the linked primary account. Staff may open either partner, but the loyalty balance and activity still come from the shared primary loyalty record.

## Issuance History (Fulfillment Tracking)

Switch to the **History** tab to see a record of all recent reward issuances. 
- Use the **Print Letter** icon to generate a 8.5x11 "Thank You" letter for the recipient.
- Use the **Print Label** icon to reprint an address label for that specific issuance.

## Program Settings & Letter Templates

In the **Program Settings** tab, administrators can customize the reward rules and the physical fulfillment output.

### Personalizing Reward Letters
You can edit the "Thank You" letter text directly in the **Program Settings** tab. The editor supports real-time tag injection for personalization. Use the following dynamic tags to personalize the output:
- `{{first_name}}`: Recipient's first name.
- `{{last_name}}`: Recipient's last name.
- `{{reward_amount}}`: The dollar value of the reward (e.g., $50.00).
- `{{card_code}}`: The unique Gift Card code generated during redemption.

#### Fulfillment Workflow
1. **Redeem**: Points are deducted and the full reward is issued to a loyalty gift card.
2. **History**: Navigate to the History tab to find the issuance.
3. **Print**: Click the **Print Letter** icon. Riverside OS merges the template with the member data for a ready-to-mail fulfillment packet.

## Tips

- **Check the History**: Always check the History tab after a redemption to print the final fulfillment packet.
- **Dynamic Thresholds**: Reward thresholds and amounts are global; changing them in settings will immediately update the Elite Pool registry.

> [!IMPORTANT]
> Printing letters requires a PDF-capable browser. Ensure pop-ups are allowed for `riverside-os` to enable the print preview window.

## What happens next

After a redemption, the customer leaves the eligible pool and the issuance moves into **History** for letter and label follow-up.
