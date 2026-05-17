---
id: pos-order-load-modal
title: "Customer Orders"
order: 1070
summary: "Review a customer's open Special, Custom, or Wedding order work in POS, check balance and lifecycle status, add or edit open lines, collect payments, and copy unfulfilled lines only when starting a new sale."
source: client/src/components/pos/OrderLoadModal.tsx
last_scanned: 2026-04-21
tags: pos, orders, pickup, fulfillment
---

# Customer Orders

## Screenshots

![Register dashboard](../images/help/pos/register-dashboard.png)

![Cart with lines](../images/help/pos/cart-with-lines.png)

![Checkout drawer](../images/help/pos/nexo-checkout-drawer.png)

Use this window when a customer already has open Special, Custom, or Wedding work and staff need to review what is still unfulfilled.

## What it shows

- The customer's open order work
- Order date, amount paid, and balance due
- A plain lifecycle note such as **Deposit received**, **Balance paid**, or **Waiting on measurements**
- The order lines that are still unfulfilled
- Controls for adding a SKU to the original fulfillment work
- Quantity and price controls for unfulfilled lines that can still be corrected

## How to use it

1. Select the customer in POS.
2. Open the order loader.
3. Review the order you need.
4. Use **Add to Order** when the customer is adding another item to the same original fulfillment work.
5. Use **Save Line** only when correcting quantity or price on an unfulfilled line.
6. Use **Add Payment** when the customer is paying an existing balance.
7. If you need to rebuild the items as a new register sale, use **Copy Unfulfilled Items**.

## Important

- **Add to Order** and **Save Line** update the original fulfillment work and refresh the linked Transaction Record totals.
- Payment taken later remains a new payment movement, but it is attached to the original Transaction Record.
- **Copy Unfulfilled Items** starts a **new** register sale.
- It does **not** collect payment on the original Transaction Record.
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

## Related workflows

- [Orders Workspace](manual:orders-workspace)
- [Register Checkout](manual:pos-nexo-checkout-drawer)
