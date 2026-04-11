---
id: loyalty-workspace
title: "Loyalty Management Hub"
order: 1043
summary: "Manage the monthly reward cycle, customize fulfillment letters, and monitor loyalty program health."
source: client/src/components/loyalty/LoyaltyWorkspace.tsx
last_scanned: 2026-04-11
tags: loyalty, rewards, fulfillment, analytics
---

# Loyalty Management Hub

The Loyalty Management Hub is a high-density control center for managing Riverside OS’s premium reward cycle. It is designed to track "Elite Pool" eligibility and facilitate professional physical fulfillment.

## Executive Summary Strip

At the top of the workspace, the **Executive Summary Strip** provides real-time program health metrics:
- **Points Vault**: Total points liability currently held by all customers.
- **Elite Pool**: The number of members who have crossed the reward threshold and are awaiting redemption.
- **Rewards Issued**: Total historical count of reward issuances.
- **Retention Activity**: Count of manual adjustments performed by staff in the last 30 days.

## Monthly Elite Pool (Registry)

This is the primary operational grid. It lists all customers who have reached the `loyalty_point_threshold` (e.g., 5,000 pts).

### Fulfillment Workflow
1. **Sync Elite Pool**: Use the "Sync" button to ensure the registry is up to date with the latest accruals.
2. **Redeem Reward**: Click the **Redeem** button to open the redemption dialog. This will deduct the points and either apply the reward to a sale or load it onto a gift card.
3. **Bulk Labels**: Use this action in the header to print standard mailing labels for every member currently in the pool.

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
1. **Redeem**: Points are deducted and a reward (Gift Card or Sale Credit) is issued.
2. **History**: Navigate to the History tab to find the issuance.
3. **Print**: Click the **Print Letter** icon. Riverside OS merges the template with the member data for a ready-to-mail fulfillment packet.

## Tips

- **Check the History**: Always check the History tab after a redemption to print the final fulfillment packet.
- **Dynamic Thresholds**: Reward thresholds and amounts are global; changing them in settings will immediately update the Elite Pool registry.

> [!IMPORTANT]
> Printing letters requires a PDF-capable browser. Ensure pop-ups are allowed for `riverside-os` to enable the print preview window.

