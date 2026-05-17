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

## Screenshots

![Customers workspace](../images/help/customers-workspace/main.png)

![Orders workspace](../images/help/orders-workspace/main.png)

![Wedding lookup drawer](../images/help/pos/wedding-lookup-drawer.png)

The **Shipments Hub** is the central command for all outgoing orders. It is where you fulfill "Shipping" orders placed at the register or through the online store.

## What this is

Use the Shipments Hub to manage packed-but-not-delivered orders, tracking numbers, and delivery status for customer shipments.

## How to use it

1. Open **Customers → Shipments** or the customer-specific **Shipments** tab.
2. Filter or search for the shipment that needs work.
3. Open the shipment detail panel and enter tracking or notes as needed.
4. Apply a live Shippo rate and buy the label when the shipment is ready to send.
5. Use **Carrier handoff** to create manifests/SCAN forms or request pickup for purchased labels that share the same carrier account.
6. Update the shipment status only when the parcel has genuinely moved to the next stage. Shippo tracking updates may also update the status automatically when webhooks are configured.

## Actions
- **Fulfillment Queue**: View all orders waiting to be packed and shipped.
- **Assign Tracking**: Enter tracking numbers for parcels.
- **Buy / Open Labels**: Apply a live Shippo rate, buy the label, then open the generated label PDF from the shipment detail panel.
- **Unused Label Refund**: If a purchased label will not be used, request an unused-label refund from the label panel. The request is logged; Shippo and the carrier decide whether it is accepted.
- **Return Labels**: From a purchased outbound label, create a return-label workflow, fetch a return rate, buy the return label, and keep the return shipment separate from the outbound shipment.
- **Carrier Handoff**: Select purchased labels for the same carrier account, then create a manifest/SCAN form or schedule pickup from the hub.
- **Address Lookup**: Manual shipments use Geoapify suggestions biased near the store area, then Shippo validates the selected address before ROS fills the form.
- **Status Management**: Mark shipments as "Shipped" or "Delivered" to keep customers informed.

## Accessing the Hub
- **Global**: Sidebar → Customers → **Shipments**.
- **Customer Specific**: Open a customer profile → **Shipments** tab.

## What to watch for

- Confirm you are updating the correct shipment before posting tracking.
- Delivery status should match real carrier progress, not internal intent.
- Do not request a label refund after the package has been handed to the carrier.
- Do not mix carrier accounts in one manifest or pickup request. ROS blocks mixed selections.
- International shipments require manager/admin handling until customs declarations are fully built into ROS.
- Use the fuller shipping guide when the question is about quoting or the original POS shipping setup.

_For the full guide on shipping workflows, see the [Shipping & Fulfillment Guide](pos-shipping-manual)._
