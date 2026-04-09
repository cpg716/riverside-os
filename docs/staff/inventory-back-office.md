# Inventory (Back Office)

**Audience:** Inventory leads, buyers, receivers.

**Where in ROS:** Back Office → **Inventory**. Subsections: **Inventory List**, **Add Inventory**, **Receiving**, **Categories**, **Discount events**, **Import**, **Vendors**, **Physical count**.

**Related permissions:** **catalog.view** / **catalog.edit** for catalog surfaces. **procurement.view** / **procurement.mutate** for PO-style receiving. **physical_inventory.view** for **Physical count**.

---

## How to use this area

Pick the subsection that matches the **job**, not the person: **look up** → **Inventory List**; **new style** → **Add Inventory**; **truck arrived** → **Receiving**; **storewide sale** → **Discount events**; **big file** → **Import**; **yearly count** → **Physical count**.

## Inventory List (control board)

**Purpose:** Find SKUs fast, tweak price/stock fields you are allowed to edit, open **product hub** for matrix and history.

1. Go to **Inventory** → **Inventory List**.
2. Search by **SKU**, **style name**, or **vendor** per header fields.
3. Use **Load more** for large catalogs — the server returns pages, not the whole world at once.
4. Click a row or **hub** icon to open **Product hub** (general, matrix, history tabs).

**Common pitfall:** Editing **on-hand** without understanding **reserved** stock for special orders — when unsure, read [INVENTORY_GUIDE.md](../../INVENTORY_GUIDE.md) or ask a lead.

## Add Inventory

1. **Add Inventory** → follow wizard steps (category, matrix, initial SKU).
2. **Save** each step; do not close the browser mid-wizard.
3. Verify the SKU appears in **Inventory List** search.

## Receiving

1. **Receiving** → open expected **PO** or **direct receipt** flow your store uses.
2. Scan or enter **quantities** to match the packing slip.
3. **Post inventory** (finalize receipt into stock) is the **emerald** primary action (**green** with a **thick bottom edge**) — same **“terminal completion”** pattern as **Complete Sale** on the register (**`UI_STANDARDS.md`**). Read totals before confirming.
4. Watch for messages about **reserved** stock for open special orders after posting.

**At the register**, staff browse the catalog and tap **Add to sale** from **POS → Inventory** (same data family as the control board) — [pos-inventory.md](pos-inventory.md).

## Categories

**Purpose:** Merchandising hierarchy — affects **filters**, **reports**, and how staff **search**.

1. **Inventory** → **Categories**.
2. **Add** or **rename** nodes per SOP; avoid duplicate names that confuse receivers.
3. **Drag** to reparent only when **buying** and **reporting** agree — large moves need **manager** sign-off.
4. After big changes, spot-check **Inventory List** filters and one **Insights** slice if your role can.

## Discount events

**Purpose:** Time-boxed **merchandising** discounts; POS can apply eligible events automatically when lines match.

1. **Inventory** → **Discount events**.
2. Create or edit an event: **name**, **start/end**, and **rules** your UI exposes.
3. Attach **variants** / SKUs to the event; **save** each step.
4. **Test at POS:** add one attached SKU in a **test** cart and confirm discount behavior **before** customer-facing launch.
5. **Usage:** aggregated usage is available to the API as **`/api/discount-events/usage-report`** (admin reporting / future NL tools — see [AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md)); use it for post-mortems after big promos.

## Vendors

**Purpose:** Supplier records used by **receiving**, **PO** flows, and **catalog import** matching.

1. **Inventory** → **Vendors**.
2. Keep **vendor name** and **vendor code** consistent with **Import** CSV columns (see [CATALOG_IMPORT.md](../CATALOG_IMPORT.md)).
3. When onboarding a new supplier, add the vendor **before** bulk import if your file keys off **vendor_code**.
4. Do not delete vendors with **open PO** history without **manager** + accounting alignment.

## Import (CSV)

1. **Import** → choose mapping preset (e.g. Lightspeed vs universal).
2. Upload file under your IT **size limit**; if rejected, split file or ask for limit increase.
3. Read **preview errors** row by row; do not assume “partial import” is safe without review.

## Physical count

1. **Physical count** (requires **physical_inventory.view**).
2. **Start or resume** session; scan **location** per SOP.
3. **Review variances** before posting adjustments — large shrink hits **financial** review.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| SKU not in search | Try **SKU** exact; check **inactive** filter | **Add Inventory** or import |
| Cannot edit price | **catalog.edit** missing | Manager |
| Import HTTP error | Smaller file; different browser | Server log / IT |
| Receiving over-receives | Stop; do not post | Manager reverses / adjusts PO |
| Hub won’t save | Field validation (negative qty, bad money) | Fix red fields |
| Load more duplicates rows | UI glitch | Refresh list |

## When to get a manager

- **Shrink** over threshold, **negative on-hand** investigations.
- **Deleting** products or mass **price** changes outside promotion.
- **Vendor return** or **damage** write-offs.

---

## See also

- [pos-inventory.md](pos-inventory.md)
- [../../INVENTORY_GUIDE.md](../../INVENTORY_GUIDE.md)
- [../CATALOG_IMPORT.md](../CATALOG_IMPORT.md)
- [../SEARCH_AND_PAGINATION.md](../SEARCH_AND_PAGINATION.md)
- [../PLAN_NOTIFICATION_CENTER.md](../PLAN_NOTIFICATION_CENTER.md)

**Last reviewed:** 2026-04-04
