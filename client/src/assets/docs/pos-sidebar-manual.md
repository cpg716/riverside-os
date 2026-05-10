---
id: pos-sidebar
title: "POS Sidebar"
order: 1062
summary: "Use the POS rail to move between Register, Customers, RMS Charge, Podium Inbox, Shipping, Layaways, and other register-side workflows."
source: client/src/components/pos/PosSidebar.tsx
last_scanned: 2026-04-22
tags: pos-sidebar, pos, navigation, register
status: approved
---

# POS Sidebar

The POS sidebar is the left rail for register work. It keeps cashier workflows close to the cart without exposing the full Back Office settings tree.

## What this is

Use the POS sidebar to move between register-side tools:

- **Register** for live cart work, checkout, and sale completion.
- **Dashboard** for shift context, register status, and quick operational totals.
- **Customers** for customer lookup, customer creation, and duplicate review.
- **Inventory** for item lookup from the register.
- **Orders**, **Shipping**, **Layaways**, **Gift Cards**, and **Loyalty** for customer-facing work that may come up during a sale.
- **RMS Charge** and **Podium Inbox** for their dedicated POS workflows.

## How to use it

1. Open **Register** when you are ringing a customer.
2. Use **Customers** before or during checkout when the sale needs a customer record.
3. Use **Inventory** to confirm an item, SKU, or stock status without leaving POS.
4. Use **Orders**, **Shipping**, or **Layaways** when a sale turns into a follow-up or fulfillment task.
5. Return to **Register** when you are ready to complete the transaction.

## What to watch for

- Administrative receiving, vendor, purchasing, and product-maintenance tools remain in Back Office Inventory.
- The POS rail is intentionally shorter than the Back Office sidebar so cashiers do not have to navigate through unrelated admin sections during checkout.
- If a section is not visible, the signed-in staff member may not have permission for that workflow.

## Related workflows

- [Register (POS)](manual:pos)
- [Checkout](manual:pos-nexo-checkout-drawer)
- [Receipt Summary](manual:pos-receipt-summary-modal)
- [Customers Workspace](manual:customers-workspace)
