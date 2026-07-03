# Transactions and Orders (Back Office)

**Audience:** Sales support, managers.

**Where in ROS:** Back Office → **Orders**. Views: **Open Orders**, **All Records**, **Closed**, **Cancelled**.

**Related permissions:** **orders.view** for tab. **orders.refund_process**, **orders.cancel**, **orders.modify**, **orders.void_sale** for destructive paths.

---

## How to use this area

**Transaction Record** = the complete sale: booked items, takeaways, gift cards, alterations, deposits, payments, receipts, refunds, returns, balance, and audit. The visible transaction number starts with **TXN-**.

**Order** / **Fulfillment Order** = unfulfilled work for **Special**, **Custom**, or **Wedding** items. Use the linked Transaction Record for the complete sale and payment context.

**Layaways** are separate. Do not treat a Layaway as an Order.

**Open Orders** = active Special, Custom, and Wedding order work. **Transaction Records** = complete sale search for receipts, disputes, payments, refunds, and CRM follow-up.

### The Three Order Types

1.  **Special Order**: Standard floor items that were out of stock. Fixed catalog pricing.
2.  **Custom (MTM)**: Suits, shirts, or slacks booked as a true **Custom** order. Sale price is entered at booking. Actual vendor cost is entered later, when the garment is received, and should be in place before final fulfillment.
3.  **Wedding Order**: Items linked to a specific wedding party for group event tracking.

---

## Open Orders

1. **Orders** → **Open Orders**.
2. Sort or filter by **date**, **customer**, **view**, **payment**, **staff**, or **lifecycle**.
3. Review the **Order Items / Lifecycle** column. Each ordered item appears on its own line with its current status: **NTBO**, **Ordered**, **Received**, **Ready for Pickup**, or **Picked Up**.
4. Click record → verify **lines**, **balance due**, **customer** attachment.
5. Use **Print** to produce the filtered Open Orders list. The printout is customer-first and item-focused: customer name and number, phone/email when available, transaction number, one ordered item per line with lifecycle status, salesperson, cashier, total, deposits, and balance.
6. **Take payment** only when the linked Transaction Record balance needs payment.
7. **Pickup** / **fulfill**: complete **line checkoffs** if prompted (prevents partial mistakes).
8. **Attach Wedding**: Link a standalone fulfillment record to a **Wedding Party** member when it belongs with a wedding group.

### Ready for Pickup checks

- Use the **Needs ready check** metric or the **Lifecycle: Needs Ready Check** filter to find orders where receiving is complete but staff still need to review the garment.
- **Received** does not mean customer-ready. Open the Transaction Record, use **Mark Ready**, and confirm the received/prep/customer checklist.
- Marking an item **Ready for Pickup** queues the normal customer SMS/email notification workflow and staff notification. Do not manually text the customer outside the queue unless a manager directs it.

### Item lifecycle terms

| Status | Meaning |
|--------|---------|
| **NTBO** | Needs to be ordered. The item is sold but not yet attached to vendor ordering. |
| **Ordered** | Vendor ordering or PO work is committed. |
| **Received** | The item has been received through the receiving workflow and still needs staff ready-check review. |
| **Ready for Pickup** | The item is ready for customer pickup or final release. |
| **Picked Up** | The item was fulfilled through the pickup path. |

## Transaction Records

1. **Orders** → **Transaction Records**.
2. Set **date range** first to avoid huge lists.
3. Search **Transaction Record #**, **receipt**, **customer name**, **SKU**, or **fulfillment order #** if fields exist.
4. Open Transaction Record → **receipt** copy, **audit** timeline, or reprint per policy.
5. **Correct salesperson/attribution**: Click the **Correct** link next to **Primary Salesperson** in the transaction detail panel to correct whole-sale or line-level salesperson attribution. This action requires Manager Access with a staff approver and Access PIN unless the signed-in staff member already has the required approval permission. ROS keeps an attribution audit row and updates commission credit to the corrected staff member when needed.

## Returns, refunds, exchanges

- Use **return lines** / **exchange link** per training — do not bypass **refund queue** rules.
- **Void sale** (unpaid mistake carts) differs from **refund after payment** — permission and SOP differ.

## Till / POS coordination

POS may read the same Transaction Record through the register. Staff can add an item to the original Transaction Record, correct an unfulfilled line, collect an existing balance, pick up or ship selected lines, or cancel the order without starting a separate sale. New items stay on the same Transaction Record but get their own booked date when added, so booked sales count on the item-added day. Payments taken later stay attached to the original Transaction Record but keep their own payment movement date for QBO review.

For partial pickup or shipping, select only the lines being released. ROS blocks release when payments do not cover the selected merchandise. If a pickup would leave the remaining open items below the required 50% deposit, ROS asks for Manager Access approval and records the override instead of discarding the saved sale/payment. Shipping releases record shipped-line timestamps and shipment audit events when the Transaction Record is linked to a shipment.

If **Back Office** and **POS** disagree, **refresh** both; if persistent, note the transaction number and time for IT.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Transaction or fulfillment order not found | Widen dates | Wrong store DB |
| Cannot refund | **403** | **orders.refund_process** |
| Pickup blocked | Unpaid line | Read banner |
| Balance wrong after return | **Refresh** Transaction Record | Finance lead |

## Helping a coworker at POS

Give the **transaction number**, **fulfillment order number**, or **receipt #**; read **status** and **balance** from BO aloud.

## When to get a manager

- **Void after close**, **large refund**, **tax exempt** corrections.
- **Fraud** suspicion.

---

## See also

- [pos-register-cart.md](pos-register-cart.md)
- [../TRANSACTION_RETURNS_EXCHANGES.md](../TRANSACTION_RETURNS_EXCHANGES.md)

**Last reviewed:** 2026-04-04
