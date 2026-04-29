# Transactions and Orders (Back Office)

**Audience:** Sales support, managers.

**Where in ROS:** Back Office → **Orders**. Views: **Open Fulfillment**, **Transaction History**.

**Related permissions:** **orders.view** for tab. **orders.refund_process**, **orders.cancel**, **orders.modify**, **orders.void_sale** for destructive paths.

---

## How to use this area

**TRX** = financial sale record: payments, receipts, refunds, returns, balance, and audit.

**ORD** = fulfillment work for **Special**, **Custom**, or **Wedding** orders. Use the linked TRX only for payment context.

**Layaways** are separate. Do not treat a Layaway as an Order.

**Open Fulfillment** = active Special, Custom, and Wedding order work. **Transaction History** = TRX search for receipts, disputes, and CRM follow-up.

### The Three Order Types

1.  **Special Order**: Standard floor items that were out of stock. Fixed catalog pricing.
2.  **Custom (MTM)**: Suits, shirts, or slacks booked as a true **Custom** order. Sale price is entered at booking. Actual vendor cost is entered later, when the garment is received, and should be in place before final fulfillment.
3.  **Wedding Order**: Items linked to a specific wedding party for group event tracking.

---

## Open Fulfillment

1. **Orders** → **Open Fulfillment**.
2. Sort or filter by **date**, **customer**, **status** if available.
3. Click record → verify **lines**, **balance due**, **customer** attachment.
4. **Take payment** only when the linked TRX balance needs payment.
5. **Pickup** / **fulfill**: complete **line checkoffs** if prompted (prevents partial mistakes).
6. **Attach Wedding**: Link a standalone fulfillment record to a **Wedding Party** member when it belongs with a wedding group.

## Transaction History

1. **Orders** → **Transaction History**.
2. Set **date range** first to avoid huge lists.
3. Search **receipt**, **customer name**, **SKU** if fields exist.
4. Open TRX record → **receipt** copy, **audit** timeline, or reprint per policy.

## Returns, refunds, exchanges

- Use **return lines** / **exchange link** per training — do not bypass **refund queue** rules.
- **Void sale** (unpaid mistake carts) differs from **refund after payment** — permission and SOP differ.

## Till / POS coordination

POS may read the same TRX record through the register. If **Back Office** and **POS** disagree, **refresh** both; if persistent, note **TRX id** and time for IT.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| TRX/ORD not found | Widen dates | Wrong store DB |
| Cannot refund | **403** | **orders.refund_process** |
| Pickup blocked | Unpaid line | Read banner |
| Balance wrong after return | **Refresh** TRX record | Finance lead |

## Helping a coworker at POS

Give the **TRX id**, **ORD id**, or **receipt #**; read **status** and **balance** from BO aloud.

## When to get a manager

- **Void after close**, **large refund**, **tax exempt** corrections.
- **Fraud** suspicion.

---

## See also

- [pos-register-cart.md](pos-register-cart.md)
- [../TRANSACTION_RETURNS_EXCHANGES.md](../TRANSACTION_RETURNS_EXCHANGES.md)

**Last reviewed:** 2026-04-04
