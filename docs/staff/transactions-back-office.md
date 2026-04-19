# Transactions (Back Office)

**Audience:** Sales support, managers.

**Where in ROS:** Back Office → **Transactions**. Subsections: **Open Transactions**, **All Transactions**.

**Related permissions:** **orders.view** for tab. **orders.refund_process**, **orders.cancel**, **orders.modify**, **orders.void_sale** for destructive paths.

---

## How to use this area

**Open Transactions** = **action queue** (unpaid, not picked up, alteration holds, etc.). **All Transactions** = **history** search for receipts, disputes, and CRM follow-up.

### The Three Fulfillment Types (Backlog)

1.  **Special Order**: Standard floor items that were out of stock. Fixed catalog pricing.
2.  **Custom (MTM)**: Suits, shirts, or slacks where **price and cost vary with every order**. Ensure vendor costs are attached before final fulfillment.
3.  **Wedding Order**: Items linked to a specific wedding party for group event tracking.

---

## Open Transactions

1. **Transactions** → **Open Transactions**.
2. Sort or filter by **date**, **customer**, **status** if available.
3. Click transaction → verify **lines**, **balance due**, **customer** attachment.
4. **Take payment** per tender UI; confirm **$0** balance or correct **partial**.
5. **Pickup** / **fulfill**: complete **line checkoffs** if prompted (prevents partial mistakes).
6. **Attach Wedding** (v0.2.0): Link a standalone or imported transaction to a **Wedding Party** member. This updates the transaction kind to `wedding_order` and synchronizes it with the party's Action Board.

## All Transactions

1. **Transactions** → **All Transactions**.
2. Set **date range** first to avoid huge lists.
3. Search **receipt**, **customer name**, **SKU** if fields exist.
4. Open transaction → **receipt** copy, **audit** tab, or **ZPL** reprint per policy.

## Returns, refunds, exchanges

- Use **return lines** / **exchange link** per training — do not bypass **refund queue** rules.
- **Void sale** (unpaid mistake carts) differs from **refund after payment** — permission and SOP differ.

## Till / POS coordination

POS may read the same transaction via **register session** headers. If **Back Office** and **POS** disagree, **refresh** both; if persistent, note **transaction id** and time for IT.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Transaction not found | Widen dates | Wrong store DB |
| Cannot refund | **403** | **orders.refund_process** |
| Pickup blocked | Unpaid line | Read banner |
| Balance wrong after return | **Refresh** transaction | Finance lead |

## Helping a coworker at POS

Give **transaction id** or **receipt #**; read **status** and **balance** from BO aloud.

## When to get a manager

- **Void after close**, **large refund**, **tax exempt** corrections.
- **Fraud** suspicion.

---

## See also

- [pos-register-cart.md](pos-register-cart.md)
- [../TRANSACTION_RETURNS_EXCHANGES.md](../TRANSACTION_RETURNS_EXCHANGES.md)

**Last reviewed:** 2026-04-04
