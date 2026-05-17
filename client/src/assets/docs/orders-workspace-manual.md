---
id: orders-workspace
title: "Orders Workspace"
order: 1049
summary: "Manage Special, Custom, and Wedding order work. Review balances, order kind, and fulfillment status."
source: client/src/components/orders/OrdersWorkspace.tsx
last_scanned: 2026-04-11
tags: orders, fulfillment, deposits, tracking
---

# Orders Workspace

## Screenshots

![Operational home](../images/help/operations-operational-home/main.png)

![Receipt summary](../images/help/pos/receipt-summary.png)

The Orders workspace is the main place to review unfulfilled Special, Custom, and Wedding order work. Use **Transaction Records** for the complete sale history, including takeaways, gift cards, alterations, payments, refunds, and receipts.

![Orders workspace](../images/help/orders-workspace/main.png)

## What staff can do here

- Review **Open Orders** or switch to **Transaction Records** for complete sale history.
- Filter order work by **Special Order**, **Custom**, or **Wedding**.
- Open order work to see items, balances, and available actions.
- Open an order to see pickup versus shipping mode, remaining work, fulfilled work, and release-blocking balance cues at a glance.
- Edit an open order line directly in the drawer when staff only need to adjust quantity, unit price, or fulfillment without leaving the workspace.
- Open order work in POS when staff need to review it from the register or copy its unfulfilled lines into a new sale.
- After Register checkout activity, reopen the parent Transaction Record or return to Orders to see the latest authoritative data instead of a stale snapshot.
- Use the `Order Integrity` summary at the top of the workspace to quickly see which visible orders are still waiting on booking details, still carrying balance due, or already showing action-needed / overdue follow-up counts from the existing pipeline stats feed.

## Order Lifecycle

1. **Booking**: Special, Custom, and Wedding order lines are typically booked at the Register and appear here immediately.
2. **Tracking**: Use the order kind filter to separate standard Special Orders from Custom and Wedding work.
3. **Payment and Pickup**: Staff can review deposit activity, amount paid, and balance due from the linked Transaction Record. A POS handoff is for review or rebuilding lines in a new sale, not for silently changing the original Transaction Record.
4. **Completion**: The lifecycle ends when the order is fulfilled or otherwise closed.

## Tips

- **Special Order** means an out-of-stock catalog item ordered for the customer.
- **Custom** means a made-to-measure garment order.
- **Wedding** means the order is tied to a wedding member or party workflow.
- For Custom orders, sale price is entered at booking and actual vendor cost is entered when the garment is received.
- Order detail now shows the main Custom booking references, such as fabric, style, model, size anchors, sleeve or cuff measurements, and vendor reference notes, without replacing the full paper form.
- Wedding order detail should show the linked party, member role, and event date so staff know to keep balances and pickup work in the wedding workflow.
- A paid wedding balance does not automatically mean the order is ready. Confirm the linked member is actually ready for pickup before release.
- The lifecycle panel in order detail is the quickest way to tell whether the order is still waiting on measurements, still carrying a deposit balance, fully paid, or already picked up.

Check the order type before making changes so the right team follows up on it.

## Related workflows

- [Register Checkout](manual:pos-nexo-checkout-drawer)
- [Customer Relationship Hub](manual:customers-customer-relationship-hub-drawer)
