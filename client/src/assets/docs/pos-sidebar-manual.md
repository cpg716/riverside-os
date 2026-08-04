---
id: pos-sidebar
title: "POS Sidebar"
order: 1062
summary: "Open every permitted POS destination directly from one scrollable navigation rail."
source: client/src/components/pos/PosSidebar.tsx
last_scanned: 2026-04-22
tags: pos-sidebar, pos, navigation, register
status: approved
---

# POS Sidebar

## Screenshots

![Register dashboard](../images/help/pos-sidebar/workflow-1.png)

![Cart with lines](../images/help/pos-sidebar/workflow-2.png)

![Checkout drawer](../images/help/pos-sidebar/workflow-3.png)

The POS sidebar is the left rail for register work. It keeps cashier workflows close to the cart without exposing the full Back Office settings tree.

## What this is

Use the direct POS destinations to move between register-side tools without opening nested navigation groups:

- **Register** for live cart work, checkout, and sale completion.
- **Dashboard** for shift context, register status, and quick operational totals.
- **Customers** for customer lookup, customer creation, and duplicate review.
- **Weddings, Alterations, Orders, Tasks, Customer Notifications, and Podium Inbox** for daily customer and fulfillment work.
- **RMS Charge, Inventory, Payments, Reports, Gift Cards, Loyalty, Layaways, Shipping, and permitted POS Settings** for supporting register operations.

## How to use it

1. Open **Register** when you are ringing a customer.
2. Use **Customers** before or during checkout when the sale needs a customer record.
3. Select **Orders**, **Weddings**, **Alterations**, **Tasks**, or a messaging destination directly for customer follow-up.
4. Select **Inventory**, **Shipping**, **Payments**, **Reports**, **Gift Cards**, **Loyalty**, **Layaways**, **RMS Charge**, or permitted settings directly when needed.
5. Return to **Register** when you are ready to complete the transaction.

## Operational detail

The POS rail is organized in daily workflow order and scrolls when the full permitted menu is taller than the screen. Its scrollbar stays visually hidden so the collapsed rail preserves the full icon and touch area; use a mouse wheel, trackpad, or touch gesture to reach additional destinations. It can still collapse to an icon rail, but every destination remains a direct selection without opening **Work** or **More** first. Use Register for the live sale, Dashboard for between-customer priorities, and supporting hubs only when they are part of the current transaction. If a tool is missing, it is usually controlled by Staff Access or POS mode restrictions, not a broken sidebar.


## What to watch for

- Administrative receiving, vendor, purchasing, and product-maintenance tools remain in Back Office Inventory.
- The POS rail remains scrollable when needed without placing a wide scrollbar beside the navigation icons.
- If a section is not visible, the signed-in staff member may not have permission for that workflow.

## Related workflows

- [Register (POS)](manual:pos)
- [Checkout](manual:pos-nexo-checkout-drawer)
- [Receipt Summary](manual:pos-receipt-summary-modal)
- [Customers Workspace](manual:customers-workspace)
