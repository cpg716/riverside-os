---
id: orders-workspace
title: "Orders Workspace"
order: 1049
summary: "Manage Special, Custom, Wedding, and Layaway orders. Review balances, order kind, and fulfillment status."
source: client/src/components/orders/OrdersWorkspace.tsx
last_scanned: 2026-04-11
tags: orders, fulfillment, deposits, tracking
---

# Orders Workspace

The Orders workspace is the main place to review non-takeaway orders.

## What staff can do here

- Review open or closed orders.
- Filter by **Order**, **Custom**, **Wedding**, or **Layaway**.
- Open an order to see items, balances, and available actions.
- Open an order to see pickup versus shipping mode, remaining work, fulfilled work, and release-blocking balance cues at a glance.
- Edit an open order line directly in the drawer when staff only need to adjust quantity, unit price, or fulfillment without leaving the workspace.
- Open an order in POS when staff need to review it from the register or copy its unfulfilled lines into a new sale.
- After Register checkout activity, reopen the order or return to Orders to see the latest authoritative order data instead of a stale snapshot.
- Use the `Order Integrity` summary at the top of the workspace to quickly see which visible orders are still waiting on booking details, still carrying balance due, or already showing action-needed / overdue follow-up counts from the existing pipeline stats feed.

## Order Lifecycle

1. **Booking**: Orders are typically booked at the Register and appear here immediately.
2. **Tracking**: Use the order kind filter to separate standard Special Orders from Custom and Wedding work.
3. **Payment and Pickup**: Staff can review deposit activity, amount paid, and balance due. A POS handoff is for review or rebuilding lines in a new sale, not for silently changing the original order record.
4. **Completion**: The lifecycle ends when the order is fulfilled or otherwise closed.

## Tips

- **Order** means a standard Special Order.
- **Custom** means a made-to-measure garment order.
- **Wedding** means the order is tied to a wedding member or party workflow.
- For Custom orders, sale price is entered at booking and actual vendor cost is entered when the garment is received.
- Order detail now shows the main Custom booking references, such as fabric, style, model, size anchors, sleeve or cuff measurements, and vendor reference notes, without replacing the full paper form.
- Wedding order detail should show the linked party, member role, and event date so staff know to keep balances and pickup work in the wedding workflow.
- Wedding order detail should show the linked party, member role, and event date so staff know to keep balances and pickup work in the wedding workflow.
- A paid wedding balance does not automatically mean the order is ready. Confirm the linked member is actually ready for pickup before release.
- The lifecycle panel in order detail is the quickest way to tell whether the order is still waiting on measurements, still carrying a deposit balance, fully paid, or already picked up.

Check the order type before making changes so the right team follows up on it.
