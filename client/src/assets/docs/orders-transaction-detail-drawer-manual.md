---
id: orders-transaction-detail-drawer
title: "Transaction Detail Drawer (orders)"
order: 1058
summary: "Draft maintainer scaffold for client/src/components/orders/TransactionDetailDrawer.tsx. Promote to approved after SOP review and screenshot capture."
source: client/src/components/orders/TransactionDetailDrawer.tsx
last_scanned: 2026-04-27
tags: orders-transaction-detail-drawer, component, auto-scaffold
status: draft
---

# Transaction Detail Drawer (orders)

<!-- help:component-source -->
_Linked component: `client/src/components/orders/TransactionDetailDrawer.tsx`._
<!-- /help:component-source -->

## What this is

Use this drawer to review the financial ledger and operator timeline for a non-takeaway order.

## What the rule summary means

The drawer now explains three common Riverside rules inline:

- booking records the transaction balance and payment history
- pickup or fulfillment is what completes the order
- a paid balance does not automatically mean the item is ready until receiving, measurements, and pickup work are actually complete

This is especially important for special orders, custom work, and wedding-linked transactions.

## How to use it

1. Open the transaction from Orders or a related customer/order surface.
2. Review the rule summary first so you know whether you are looking at payment state, readiness state, or both.
3. Use the top fulfillment summary chips to confirm whether the order is pickup or shipping, whether work is still open, and whether balance still blocks release.
4. Use the financial summary to confirm total, paid amount, deposits, and balance due.
5. In the Items section, review `Still Open` versus `Already Fulfilled` so remaining work and completed work do not blend together.
6. Use `Edit` on an open line when you need to adjust quantity, unit price, or fulfillment using the existing audited order-line contract.
7. Save or cancel the line edit before moving on. The drawer refreshes the order detail and timeline after a successful save.
8. If the order was sent to Register and staff completed register work, reopen the drawer from Orders to recheck the latest authoritative transaction state.
9. Use the order timeline to confirm what changed and who touched the order.

## Rule reminders

- Payment status and readiness status are related, but they are not the same thing.
- Deposits reduce balance due without completing pickup.
- `Fulfilled` means the pickup or fulfillment step has been completed in RiversideOS.
