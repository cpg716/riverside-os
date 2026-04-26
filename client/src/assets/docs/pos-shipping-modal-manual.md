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

The **Shipping Quote Modal** is triggered when you tap **Ship current sale** in the POS Cart. It captures the delivery address and carrier quote for a current Register sale.

## What this is

Use this modal to capture the destination address and apply a shipping quote to the current Register sale. This does not require creating a Special/Custom/Wedding order; it can ship ordinary in-stock merchandise from the current sale.

## When to use it

Open this modal when the customer wants delivery instead of leaving with the product today. Use Orders or the Shipments Hub when you are shipping an already-open order.

## Features
- **Address Integration**: Pulls the primary address directly from the linked customer profile.
- **Current-sale shipping**: The sale is marked for shipping and a shipment record is created at checkout.
- **Live Carrier Rates**: Fetches real-time pricing from USPS, UPS, and FedEx (requires active internet connection).

## Workflow
1. Tap **Ship current sale** in the cart.
2. Select **Use customer address** or enter a manual destination.
3. Tap **Get shipping rates**.
4. Pick the preferred carrier and service level.
5. Tap **Apply shipping** to add the fee to the transaction.

## What to watch for

- Shipping requires a usable address before the quote can be trusted.
- Applying shipping does not sell the item twice and does not require converting the line into a Special Order.
- Use the full shipping guide if the task moves beyond quoting into shipment follow-up.

_For more details on managing shipments after the sale, see the [Shipping & Fulfillment Guide](pos-shipping-manual.md)._
