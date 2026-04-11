---
id: orders-workspace
title: "Order Fulfillment Hub"
order: 1049
summary: "Manage regular Orders, Wedding, and Custom orders. Monitor deposits, track pickups, and manage the fulfillment pipeline."
source: client/src/components/orders/OrdersWorkspace.tsx
last_scanned: 2026-04-11
tags: orders, fulfillment, deposits, tracking
---

# Order Fulfillment Hub

The Order Fulfillment Hub is a high-density primary workstation designed for managing the lifecycle of non-takeaway orders (Regular orders, Wedding parties, and Custom work). 

## Fulfillment Summary Strip

At the top of the hub, the **Fulfillment Summary Strip** provides real-time visibility into your pipeline:
- **Total Booked**: The total value of all open orders currently in the system.
- **Deposit Liability**: The amount of cash currently held as deposits for unfulfilled orders.
- **Ready for Pickup**: Count and value of orders that have arrived and are awaiting customer notification/collection.
- **Daily Pickups**: Fulfillment velocity for the current business day.

## High-Density Order Grid

The revamped grid maximizes available screen space to allow staff to manage hundreds of open orders simultaneously.
- **Rapid Identification**: High-contrast typography emphasizes Buyer Names and Order IDs.
- **Status Badging**: Dynamic badges indicate if an order is `Ready for pickup`, `Partially paid`, or `Awaiting items`.
- **Financial Details**: Direct visibility into "Amount Paid" vs "Balance Due" for every row.
- **Inline Actions**: Instant access to "Print Receipt," "Send SMS Update," and "Mark Arrived."

## Order Lifecycle

1. **Booking**: Orders are typically booked at the Register and appear here immediately.
2. **Tracking**: Monitor the status of Order items as they arrive from vendors.
3. **Notification**: Use the inline messaging tools to notify customers via Podium when their order is ready.
4. **Fulfillment**: The lifecycle completes when the items are physically scanned out and the final balance is collected.

## Tips

- **Filtering**: Use the "Quick-Status" buttons to isolate orders that are `Ready for pickup` to batch-process your daily call list.
- **Color Coding**: Orders with past-due fulfillment dates or negative balances will be highlighted with high-visibility warning borders.

> [!TIP]
> Use the "Print Registry" button in the header to generate a physical paper manifest for end-of-day stockroom audits.

