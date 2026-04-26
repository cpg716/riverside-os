---
id: pos-shipping-manual
title: "Shipping & Fulfillment Guide"
order: 1061
summary: "Guide to quoting current-sale shipping at the Register and tracking shipments after checkout."
source: client/src/components/pos/Cart.tsx
last_scanned: 2026-04-11
tags: pos, shipping, shippo, fulfillment, back-office
---

# Shipping & Fulfillment Guide

Riverside OS features a unified shipping integration that connects the **POS Register**, the **Online Store**, and the **Customer Relationship Hub**. Shipping is a delivery method, not automatically a Special/Custom/Wedding order.

## What this is

Use this guide for shipping quotes at checkout and for the follow-up shipment workflow after the sale is booked.

## How to use it

1. Link the correct customer profile before quoting shipment at the register.
2. Add **Ship current sale** in the POS cart and confirm the quoted rate.
3. Complete checkout with shipping paid correctly.
4. Move into the **Shipments Hub** afterward to post tracking and status updates.

## 1. Shipping from the POS (Register)

When a customer wants to have their purchase shipped, follow these steps at the register:

### Linking a Customer
Shipping **requires** a linked customer profile. Use the **Customer Selector** to link an existing customer or create a new one. This is necessary to store the delivery address and provide tracking notifications.

### Adding Shipping to the Cart
1. Build the customer's cart as usual.
2. Tap **Ship current sale** below the subtotal.
3. The **Ship this Sale** window will open.
    - **Use customer address**: Quickly pull the saved address from the CRM.
    - **Edit address**: Manually enter a one-time delivery address for this order.
4. Tap **Get shipping rates**. The system will fetch live carrier pricing (USPS, UPS, FedEx) or demo rates if configured.
5. Select the desired rate and tap **Apply shipping to sale**.

### Fulfillment & Payment Rules
- **Current-sale shipping**: Shipping ordinary in-stock merchandise does not require converting the line to a Special/Custom/Wedding fulfillment order.
- **Immediate Payment**: Shipping fees are treated as an immediate liability. They must be paid in full at the time of sale (along with any takeaway items) before the register will allow the transaction to be finalized.
- **Reporting**: Shipped transactions remain in **Open** status until the shipment workflow records the carrier handoff/recognition event.

## 2. Managing Shipments (Back Office)

Once a sale with shipping is completed, it appears in the **Shipments Hub**.

### Finding Shipments
Navigate to **Operations → Shipments** or **Customers → Shipments** in the Back Office sidebar.
- **Filters**: Use the status filters (Pending, Shipped, Delivered) to manage your daily outgoing parcel queue.
- **Search**: Search by Customer Name, Order ID, or Tracking Number.

### Updating Status & Tracking
Click on any shipment to open the **Shipment Detail** panel:
1. **Enter Tracking**: Add the tracking number provided by your carrier.
2. **Post Note**: Add internal notes (e.g., "Box 1 of 2") to the shipment timeline.
3. **Change Status**: Once the parcel is picked up by the carrier, change the status to **Shipped**. This will update the order's timeline and notify the customer (if Podium is integrated).

## 3. Customer Visibility

Staff can view the shipping history of any customer directly within their **Relationship Hub**:
- **Shipments Tab**: A dedicated tab showing all past and pending deliveries for that specific client.
- **Interaction Timeline**: Every shipping update (Created, Shipped, Delivered) is logged as a "Shipping" event in the customer's activity feed.

## 4. Troubleshooting & Tips

- **Rates Expired?**: Shipping quotes are valid for approximately 15 minutes. If a customer hesitates at checkout, you may need to re-fetch rates before completing the sale.
- **Address Validation**: Ensure the ZIP code and State match. Live rates will fail if the carrier cannot verify the address.
- **Weight and Dimensions**: By default, the system uses your store's **Default Parcel** settings (found in Settings → Integrations). For oversized items, ensure you are quoting appropriately.

> [!TIP]
> Use the **Shipments Hub** every morning to review **Pending** shipments. This ensures no orders are left to age in the backroom.
