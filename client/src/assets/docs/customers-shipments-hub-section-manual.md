---
id: customers-shipments-hub-section
title: "Shipments Hub"
order: 1009
summary: "Back Office headquarters for managing pending shipments, tracking numbers, and delivery status."
source: client/src/components/customers/ShipmentsHubSection.tsx
last_scanned: 2026-04-11
tags: back-office, shipments, fulfillment, tracking
---

# Shipments Hub

The **Shipments Hub** is the central command for all outgoing orders. It is where you fulfill "Shipping" orders placed at the register or through the online store.

## What this is

Use the Shipments Hub to manage packed-but-not-delivered orders, tracking numbers, and delivery status for customer shipments.

## How to use it

1. Open **Customers → Shipments** or the customer-specific **Shipments** tab.
2. Filter or search for the shipment that needs work.
3. Open the shipment detail panel and enter tracking or notes as needed.
4. Update the shipment status only when the parcel has genuinely moved to the next stage.

## Actions
- **Fulfillment Queue**: View all orders waiting to be packed and shipped.
- **Assign Tracking**: Enter tracking numbers for parcels.
- **Print Labels**: (Future Integration) Quick links to Shippo for label printing.
- **Status Management**: Mark shipments as "Shipped" or "Delivered" to keep customers informed.

## Accessing the Hub
- **Global**: Sidebar → Customers → **Shipments**.
- **Customer Specific**: Open a customer profile → **Shipments** tab.

## What to watch for

- Confirm you are updating the correct shipment before posting tracking.
- Delivery status should match real carrier progress, not internal intent.
- Use the fuller shipping guide when the question is about quoting or the original POS shipping setup.

_For the full guide on shipping workflows, see the [Shipping & Fulfillment Guide](pos-shipping-manual.md)._
