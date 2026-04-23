---
title: "Stripe Payments & Vault"
id: stripe-payments
order: 150
summary: "Guide to card vaulting, saved card payments, and terminal credits."
tags: stripe, payments, vault, refunds, credits
---
# Stripe Payments, Vaulting, and Credits — Staff Manual

Riverside OS (ROS) includes a "Power Integration" for Stripe that allows for more secure and flexible payment workflows. This guide covers how to vault customer cards for phone orders, pay using a saved card, and issue credits.

---

## What this is

Use this guide when staff need to work with saved cards, card-present Stripe payments, or terminal-based credits inside Riverside.

## How to use it

1. Decide whether the workflow is card vaulting, charging a saved card, or issuing a credit.
2. Open the correct customer or checkout surface first.
3. Follow the Stripe-managed prompts instead of collecting card data manually in Riverside.
4. Confirm the resulting vault, charge, or credit before moving to the next step of the sale or return.

## 🔒 Customer Privacy & Security

**ROS is designed for 100% PCI compliance.**

- **No Stored Card Data**: Our servers never see the full card number or CVC.
- **Secure Handling**: All card collection is performed through our encrypted, Stripe-managed interface.
- **Reference Only**: Staff only see the last 4 digits and the card brand for identification.

---

## 🏦 Card Vaulting (Relationship Hub)

To securely save a customer's card for phone orders or future transactions:

1. **Find the Customer**: Open the **Customers** workspace and search for your customer.
2. **Open the Hub**: Click the customer's name to open their Relationship Hub.
3. **Payments Tab**: Select the **Payments & Vault** tab in the hub.
4. **Vault New Card**: Tap the **Vault New Card** button. This will open a secure, Stripe-hosted window.
5. **Secure Entry**: Type the card details and click **Save**.
6. **Result**: The card metadata (Brand/Last 4) will now appear in the list.

---

## 💳 Processing Sales with a Saved Card (POS)

If a customer has a vaulted card, you can process their payment without them physically presenting the card.

1. **Identify Customer**: Ensure the customer is linked to the cart at checkout.
2. **Payment Drawer**: Tap **Pay / Complete Sale**.
3. **Saved Card Tab**: Select the **Saved Card** tab.
4. **Select & Charge**: Choose the customer's vaulted card and tap the green **Charge Saved Card** button.
5. **Connecting...**: The system will authorize the charge with Stripe instantly.

---

## 🔄 Issuing Terminal Credits (Refunds)

For certain returns or unlinked refunds, you can issue a credit directly back to a customer's card via the terminal.

1. **Negative Balance**: If a cart balance is negative (e.g., -$50.00), the **Stripe Credit** tab will appear.
2. **Activate Terminal**: Select the **Stripe Credit** tab and tap **Complete with Credit**.
3. **Customer Action**: The terminal will prompt the customer to insert or tap their card.
4. **Instant Receipt**: Once the terminal confirms the credit, the sale is finalized.

---

## ❓ FAQ & Troubleshooting

- **Why is the "Saved Card" tab missing?**
  - Verify that a customer is linked to the current cart. Saved cards are only available for linked customers.
- **Why is the "Stripe Credit" tab missing?**
  - Verify that the cart has a **negative** balance. Terminal credits are only available for balances less than $0.00.
- **Terminal Error?**
  - Ensure the Stripe terminal is powered on and connected to the same network as your ROS station.
- **Deleted Cards?**
  - You can remove a vaulted card at any time from the **Customer Hub** by tapping the "Remove" icon.

## What happens next

- Vaulted cards appear in the customer's saved payment list.
- Saved-card charges continue through the normal receipt and order flow.
- Terminal credits finalize the return path and should be verified like any other completed refund.
