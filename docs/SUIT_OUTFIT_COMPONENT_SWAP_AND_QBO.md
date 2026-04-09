# Suit outfit component swap — inventory, costing, and QuickBooks

**Audience:** product, inventory leads, and engineering for **Riverside Men’s Shop** when selling **three-piece** or **vested three-piece** suits where **vest** or **pants** (and rarely **jacket**) may be **exchanged for a different variant** — different **size**, **fit**, or **brand** — before or at sale.

**Related:** [`PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md`](./PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md) (§3.2 backlog), [`INVENTORY_GUIDE.md`](../INVENTORY_GUIDE.md), QBO staging in `server/src/logic/qbo_journal.rs` / [`docs/QBO_JOURNAL_TEST_MATRIX.md`](./QBO_JOURNAL_TEST_MATRIX.md).

This document is a **requirements and design sketch**. It is not an implementation checklist until prioritized.

### Scope: one sale, one customer — not a catalog change

The swap applies **only to that sale** (cart or **open order**) for **that customer**. It is **not** a change to **product master data**: you do **not** redefine the suit SKU, alter default `product_bundle_components`, or rewrite how the style is merchandised for everyone. **Catalog** (`products` / `variants` templates, matrices, import rows) stays as-is; what changes is **this transaction’s line items** (which physical SKUs were sold), **on-hand quantities** for the pieces that moved in/out of stock, and the **accounting** tied to **that** inventory movement. Future sales of the “same” floor style use the catalog defaults unless staff substitute again on those sales.

---

## 1. Business problem

- Floor or special-order workflows often start from a **configured suit** (e.g. jacket + vest + pants) that is **merchandised or ordered as a set**, but **one leg of the set** must change:
  - Vest **size** or **style** swap
  - Pants **waist / length** swap, or **brand** change within policy
- **Cost** and **retail** can **both change** when the substituted SKU differs (different vendor cost, different ticket price).
- Accounting (QuickBooks Online) must reflect **real inventory** and **inventory asset / COGS** consistently — not only a POS line edit, but **stock movements** and, where value changes, something equivalent to an **Inventory Adjustment** (quantity and/or **value**).

“**Bundles**” in ROS today (`product_bundle_components`, checkout expansion) solve **selling** a parent SKU as multiple **variant lines**; they do **not** by themselves provide a **first-class swap** of one physical component for another with **audited inventory deltas** and **QBO inventory adjustment** lines.

---

## 2. Goals

1. **Inventory truth** — Increment/decrement the correct **variant** SKUs for **this event only** (components **removed** go back to available stock or to a defined disposition; **added** components leave stock or are received-as-part-of-outfit per policy). No requirement to mutate how the **product** is defined for other customers.
2. **Attribution** — Tie the event to **reason** (e.g. `suit_component_swap`), optional **order** / **customer** / **staff**, and **before/after** component list or line references.
3. **Costing** — Persist **unit cost** used for each leg; recompute **extended cost** for the outfit or order line set when components change (use **`rust_decimal`** on server; never floats).
4. **Retail** — Update **sell price** on affected lines when the new component’s retail differs; respect existing **discount / override** rules and staff permissions.
5. **QuickBooks** — Produce journal/staging lines appropriate for **inventory quantity adjustments** and, when value changes without a simple PO receipt, **inventory value adjustment** (mapping to QBO **Inventory Asset** / **Inventory Shrinkage** or your accountant’s preferred offset — **confirm with bookkeeper**).
6. **Audit** — Same bar as other financial actions: access log / activity where ROS already patterns QBO and inventory writes.

---

## 3. Operational scenarios (to support in UX)

| Scenario | Inventory | Cost / retail |
|----------|-----------|----------------|
| **A. Swap before checkout** (floor pull, building a ticket) | Replace component A with B on the **cart lines**; **+1** A to `stock_on_hand`, **-1** B from `stock_on_hand` (or reverse per “which piece was physically on hold”). | Recalc from **variant** cost/retail; optional **average cost** rules if you track outfit-level cost. |
| **B. Swap after deposit / open order** | Same as A but tied to **`order_id`**; may interact with **special order** / **reserved** rules — must not break [`AGENTS.md`](../AGENTS.md) special-order stock invariants. | Order line edits + `order_recalc`; inventory transaction still required. |
| **C. Brand change** (different product family) | Treat as **full line replace** for that slot (vest/pants) with explicit **out** SKU and **in** SKU. | Cost/retail from new product; QBO may need **stronger** adjustment if GL categories differ (map in QBO workspace). |

Edge cases: **split sizes** (jacket 42R, pants 36), **orphan** pieces returned to wrong bin, **markdown** components — document in implementation phase.

---

## 4. ROS implementation directions (high level)

- **API + logic** (not in route handlers): e.g. `logic::suit_component_swap` or extend **`inventory`** services with a **typed mutation** that:
  - Validates SKUs exist, stock available (unless negative stock allowed), and staff permission.
  - Runs in a **single DB transaction**: `stock_on_hand` (and **`reserved_stock`** if applicable), optional **`inventory_movements`** or reuse existing adjustment tables if present.
  - Updates **`order_items`** / cart payload as needed and calls **`order_recalc`** when an order exists.
- **Permission key** — e.g. `inventory.suit_component_swap` or reuse **`inventory.view_cost`** + **`catalog.edit`**; split **read vs post** per store policy.
- **QBO bridge** — Extend **`qbo_journal`** (or dedicated staging builder) with an event type **`inventory_adjustment_suit_swap`** (name TBD) carrying:
  - Per-SKU **qty delta** and **value delta** (if your QBO mapping uses value adjustments).
  - Memo text for accountant: party name, order ref, “vest 40R → 42R”, etc.
- **UI** — Back Office **Inventory** or **Orders** surface: “Replace component” wizard (scan/search **out**, scan/search **in**, preview deltas, confirm). POS **Register** (cart) may be **phase 2** if BO-first is safer.

---

## 5. QuickBooks semantics (accounting checklist)

Work with your CPA on exact accounts. Typical patterns:

- **Quantity only** (same average cost): *Inventory quantity adjustment* in QBO.
- **Value change** (replacement SKU different cost): may require **inventory value adjustment** or a **journal entry** pairing **Inventory Asset** and an expense/income offset per firm policy.
- ROS should emit **balanced** staging lines and **never** guess QBO account IDs — use existing **mapping** tables / QBO workspace patterns.

---

## 6. Non-goals (initial phase)

- **Catalog / product-definition edits** — Swaps are **per order / per sale**; do not use this flow to change how a style is modeled in the matrix or bundle parent for the whole store.
- **Automated** “best fit” recommendation (AI sizing).
- **Rental** mix-and-match returns (purchase model only; see roadmap §5).
- Replacing **Counterpoint** or **Lightspeed**-style full matrix import for suit separates — this is **in-store swap** workflow first.

---

## 7. Revision history

| Date | Note |
|------|------|
| 2026-04-04 | Initial spec: 3pc/vested swaps, inventory + cost + retail + QBO inventory adjustment |
| 2026-04-04 | Clarified: **sale-scoped only** — not a product / catalog change |
