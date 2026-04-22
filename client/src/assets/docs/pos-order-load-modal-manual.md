---
id: pos-order-load-modal
title: "Customer Orders"
order: 1070
summary: "Review a customer's open orders in POS, check balance and lifecycle status, and copy unfulfilled lines into a new register sale when needed."
source: client/src/components/pos/OrderLoadModal.tsx
last_scanned: 2026-04-21
tags: pos, orders, pickup, fulfillment
---

# Customer Orders

<!-- help:component-source -->
_Linked component: `client/src/components/pos/OrderLoadModal.tsx`._
<!-- /help:component-source -->

Use this window when a customer already has an open order and staff need to review what is still open.

## What it shows

- The customer's open orders
- Order date, amount paid, and balance due
- A plain lifecycle note such as **Deposit received**, **Balance paid**, or **Waiting on measurements**
- The order lines that are still unfulfilled

## How to use it

1. Select the customer in POS.
2. Open the order loader.
3. Review the order you need.
4. If you need to rebuild the items as a new register sale, use **Copy to Register**.

## Important

- **Copy to Register** starts a **new** register sale.
- It does **not** collect payment on the original order record.
- Use the balance and lifecycle note to confirm whether the order still needs payment, receiving follow-up, measurement follow-up, or pickup follow-up.

## Order types

- **Order**: standard Special Order
- **Custom**: custom garment order
- **Wedding**: order linked to a wedding workflow

Check the order type before continuing so the correct follow-up team handles it.

For **Wedding** orders:
- keep payment, deposit, and pickup work tied to the linked wedding member
- confirm the party context before continuing the order in POS
- a fully paid wedding order still needs member-readiness confirmation before pickup

For **Custom** orders, remember:
- sale price was entered when the order was booked
- actual vendor cost should be entered when the garment is received
- the main vendor-form references can be reviewed in the order detail before you continue pickup or payment work
- order detail may now include size anchors, sleeve or cuff measurements, and vendor order references copied from the HSM or Individualized form
