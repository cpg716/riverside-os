# Orders (Back Office)

**Audience:** Sales support, managers.

**Where in ROS:** Back Office → **Orders**. Subsections: **Open Orders**, **All Orders**.

**Related permissions:** **orders.view** for tab. **orders.refund_process**, **orders.cancel**, **orders.modify**, **orders.void_sale** for destructive paths.

---

## How to use this area

**Open Orders** = **action queue** (unpaid, not picked up, alteration holds, etc.). **All Orders** = **history** search for receipts, disputes, and CRM follow-up.

## Open Orders

1. **Orders** → **Open Orders**.
2. Sort or filter by **date**, **customer**, **status** if available.
3. Click order → verify **lines**, **balance due**, **customer** attachment.
4. **Take payment** per tender UI; confirm **$0** balance or correct **partial**.
5. **Pickup** / **fulfill**: complete **line checkoffs** if prompted (prevents partial mistakes).

## All Orders

1. **Orders** → **All Orders**.
2. Set **date range** first to avoid huge lists.
3. Search **receipt**, **customer name**, **SKU** if fields exist.
4. Open order → **receipt** copy, **audit** tab, or **ZPL** reprint per policy.

## Returns, refunds, exchanges

- Use **return lines** / **exchange link** per training — do not bypass **refund queue** rules.
- **Void sale** (unpaid mistake carts) differs from **refund after payment** — permission and SOP differ.

## Till / POS coordination

POS may read the same order via **register session** headers. If **Back Office** and **POS** disagree, **refresh** both; if persistent, note **order id** and time for IT.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Order not found | Widen dates | Wrong store DB |
| Cannot refund | **403** | **orders.refund_process** |
| Pickup blocked | Unpaid line | Read banner |
| Balance wrong after return | **Refresh** order | Finance lead |

## Helping a coworker at POS

Give **order id** or **receipt #**; read **status** and **balance** from BO aloud.

## When to get a manager

- **Void after close**, **large refund**, **tax exempt** corrections.
- **Fraud** suspicion.

---

## See also

- [pos-register-cart.md](pos-register-cart.md)
- [../ORDERS_RETURNS_EXCHANGES.md](../ORDERS_RETURNS_EXCHANGES.md)

**Last reviewed:** 2026-04-04
