---
id: pos-shipping-modal
title: "Shipping Quote Modal"
order: 1061
summary: "Component for capturing delivery addresses and fetching live carrier rates at the Register."
source: client/src/components/pos/PosShippingModal.tsx
last_scanned: 2026-04-11
tags: pos, shipping, shippo, rates
---

# Shipping Quote Modal

The **Shipping Quote Modal** is triggered when you tap the **Truck Icon** in the POS Cart. It allows you to select how a customer's order will be delivered.

## Features
- **Address Integration**: Pulls the primary address directly from the linked customer profile.
- **Auto-Fulfillment**: Once a rate is applied, the cart will automatically switch relevant items to "Special Order" (non-takeaway).
- **Live Carrier Rates**: Fetches real-time pricing from USPS, UPS, and FedEx (requires active internet connection).

## Workflow
1. Tap the **Truck Icon** in the cart.
2. Select **Use customer address** or enter a manual destination.
3. Tap **Get shipping rates**.
4. Pick the preferred carrier and service level.
5. Tap **Apply shipping** to add the fee to the transaction.

_For more details on managing shipments after the sale, see the [Shipping & Fulfillment Guide](pos-shipping-manual)._
