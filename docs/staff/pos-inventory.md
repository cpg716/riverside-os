# POS Inventory

**Audience:** Sales staff who need SKU lookup from the register.

**Where in ROS:** POS mode → left rail **Inventory** (box icon).

**Related permissions:** **catalog.view** with **staff or POS session** patterns. If you get **403**, use Back Office **Inventory List** or ask a manager.

---

## How to use this screen

POS **Inventory** is a **fast lookup**: **price**, **availability**, **SKU**, and sometimes **image** context — without opening the full **Inventory List** control board. Use it while the customer is at the counter.

The same tab implements **browse-and-add** to the cart:

1. Type **at least two characters** in search; results debounce briefly.
2. Tap a product: **one variant** adds to the cart immediately; **multiple variants** open a picker (sizes/options sorted for apparel).
3. Tap **Add to sale** (emerald) on the correct variant.
4. ROS returns you to Register and adds the SKU to the active sale.
5. Use **Load more products** for the next page — the list is paged, not all-at-once.
6. **Out of stock** rows may show an extra control (clipboard icon) for **special order** follow-up — use **manager SOP**; do not promise dates the system has not confirmed.
7. **Custom Items:** Known Custom garment SKUs book as **Custom** orders in the Register instead of same-day inventory lines. The main Custom SKUs are `100`, `105`, `110`, and `200`. Sale price is entered when the order is booked, and actual vendor cost is entered when the garment is received.

Receiving and PO posting remain in **Back Office → Inventory → Receiving** — [inventory-back-office.md](inventory-back-office.md).

## Common tasks

### Price and availability check

1. POS → **Inventory**.
2. Search **SKU** from tag, **style name**, or **vendor code** per training.
3. Open the **variant** row; read **available** (on hand minus reserved when shown).
4. If **0 available**, offer **special order**, **transfer**, or **similar** SKU per SOP.

### Find SKU for a floor pull

1. Search display ticket description.
2. Note **SKU** and **size**; radio or message the stock runner.
3. **Do not** rely on memory — scan at pickup.

### Customer compares to website

1. Confirm **same** variant (color code).
2. If web shows different price, **store policy** wins — escalate to manager; do not argue from personal phone.

## Helping a coworker

- **“Search spins.”** — Narrow query; use **SKU**; **Load more** at bottom of list.
- **“Price lower in email.”** — Manager may apply **discount event** or **override**; not a POS Inventory fix alone.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| No results | Shorter keyword; scan | BO control board |
| On-hand wrong | **Receiving** not posted | Receiving lead |
| Shows reserved only | **Special order** pipeline | Explain to customer |
| Image missing | Normal for some SKUs | — |

## When to get a manager

- **Markdown** below floor without approval.
- Suspected **ticket swap** (wrong item in bag vs SKU).

---

## See also

- [inventory-back-office.md](inventory-back-office.md)
- [../SEARCH_AND_PAGINATION.md](../SEARCH_AND_PAGINATION.md)
- [../../INVENTORY_GUIDE.md](../../INVENTORY_GUIDE.md)

**Last reviewed:** 2026-04-04
