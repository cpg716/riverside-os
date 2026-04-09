# Special orders and stock (staff abstract)

**Full detail:** [../../../INVENTORY_GUIDE.md](../../../INVENTORY_GUIDE.md), [../../../AGENTS.md](../../../AGENTS.md) (special order model).

---

## What staff should remember

1. **Checkout** does **not** reduce **stock_on_hand** the same way for **special order** (and similar) lines as for immediate **pickup** of in-stock goods.
2. **Receiving** can increase **on_hand** and may **reserve** quantity toward open special-order demand.
3. **Pickup (fulfill)** reduces **on_hand** and releases the matching **reserved** amount for those lines.
4. **Available** (when shown) reflects **on hand minus reserved** — a positive on-hand can still be partly **spoken for**.

---

## Talking to customers

- Do not promise **same-day pickup** for a **special order** unless the line and notes confirm it.
- If **available** is low but **on hand** looks high, explain that some units may be **reserved** for other customers’ orders (keep wording simple).

---

## Where to work in ROS

- **Receiving / PO:** Back Office [../inventory-back-office.md](../inventory-back-office.md).
- **POS availability:** [../pos-inventory.md](../pos-inventory.md).
- **Orders / pickup:** [../orders-back-office.md](../orders-back-office.md).

---

**Last reviewed:** 2026-04-04
