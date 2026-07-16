---
id: pos-order-load-modal
title: "Customer Orders"
order: 1070
summary: "Review a customer's open Special, Custom, or Wedding order work in POS, check balance and lifecycle status, add or edit open lines, collect payments, and load selected pickup lines into the register cart."
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
7. For pickup, select the lines leaving with the customer and use **Pick Up Selected**. ROS adds those lines to a pickup basket; open another order and add its selected lines when the customer is taking items from multiple orders. Use **Start Pickup** when the basket contains every item leaving today.

## Important

- **Add to Order** and **Save Line** update the original fulfillment work and refresh the linked Transaction Record totals.
- Payment taken later remains a new payment movement, but it is attached to the original Transaction Record.
- **Pick Up Selected** does not finish inside this window. It adds the selected pickup lines to the basket, keeps each line's original Transaction Record link, and lets staff combine one or more orders before selecting **Start Pickup**. The register finishes from **Complete Pickup** so the Sale Complete receipt screen opens.
- The pickup basket supports one item, several items, or all open ready items from each of several orders. Payment and pickup release remain tracked against each source Transaction Record.
- New merchandise added after loading pickup lines becomes a new sale line in the same register flow.
- Use the balance and lifecycle note to confirm whether the order still needs payment, receiving follow-up, measurement follow-up, or pickup follow-up.
- When the order has linked alterations marked **Ready**, loading the order for pickup shows those alteration pickups in the Register. Completing the order pickup also marks those ready alterations **Picked Up**.

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

For **Alterations linked to an order**:
- Mark the alteration **Ready** in the Alterations workspace after final inspection.
- Open the customer order from the Register and choose pickup.
- Confirm the Register shows the ready alteration pickup badge before completing pickup.
- Alterations that are still Intake, In Work, or Verify Completed do not automatically release with the order.

## Related workflows

- [Orders Workspace](manual:orders-workspace)
- [Register Checkout](manual:pos-nexo-checkout-drawer)
