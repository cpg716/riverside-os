# Inventory (Back Office)

**Audience:** Inventory leads, buyers, receivers.

**Where in ROS:** Back Office → **Inventory**. Main jobs: **Find Item**, **Add/Edit Catalog**, **Order Stock**, **Receive Stock**, **Correct Stock**, **Count/Reconcile**.

**Related permissions:** **catalog.view** / **catalog.edit** for catalog surfaces. **procurement.view** / **procurement.mutate** for PO-style receiving. **physical_inventory.view** for **Physical count**.

---

## How to use this area

Pick the area that matches the **job**, not the person:

| Staff job | Use it for | Previous tools now under it |
|-----------|------------|-----------------------------|
| **Find Item** | Find, open, and manage existing items from Product hub | Inventory List |
| **Add/Edit Catalog** | Create items and manage catalog structure | Add Inventory, Categories, Vendors, Import, Discount events |
| **Order Stock** | Build vendor orders and review buying guidance | Purchase Orders, Stock Guidance |
| **Receive Stock** | Post arrived merchandise from vendor paperwork | Receiving, direct invoice receiving |
| **Correct Stock** | Review damaged/lost stock and return-to-vendor movements | Damaged / Loss, Return to Vendor |
| **Count/Reconcile** | Run physical counts and publish reviewed variances | Physical count |

Old deep links and saved shortcuts still open the same tools. The labels above are the staff-facing mental model for deciding where to start.

## Find Item

**Purpose:** Find SKUs fast, open **Product hub**, and manage existing item details, options, pricing fields, stock actions, and history from one item-centered starting point.

To edit an existing item, always start in **Find Item**. Search for the SKU or style, then open **Product hub** from the row.

1. Go to **Inventory** → **Find Item**.
2. Search by **SKU**, **style name**, or **vendor** per header fields.
3. Use **Load more** for large catalogs — the server returns pages, not the whole world at once.
4. Click a row or **hub** icon to open **Product hub** (general, matrix, history tabs).

**Common pitfall:** Editing **on-hand** without understanding **reserved** stock for special orders — when unsure, read [INVENTORY_GUIDE.md](../../INVENTORY_GUIDE.md) or ask a lead.

## Add/Edit Catalog

Use **Add/Edit Catalog** for setup tooling: creating new items, managing category and vendor records, importing catalog files, and maintaining promotions. For existing item edits, start in **Find Item** instead.

### Add Item

1. **Add/Edit Catalog** → **Add Item** → follow wizard steps (category, matrix, initial SKU).
2. Enter **non-negative** base retail and cost values. Negative benchmark pricing, negative cost, and negative initial stock are blocked.
3. Keep generated SKUs unique. If a SKU already exists anywhere in ROS, the product will not save until the conflict is resolved.
4. **Save** each step; do not close the browser mid-wizard.
5. Verify the SKU appears in **Inventory List** search.

### Categories

**Purpose:** Merchandising hierarchy — affects **filters**, **reports**, and how staff **search**.

1. **Inventory** → **Add/Edit Catalog** → **Categories**.
2. **Add** or **rename** nodes per SOP; avoid duplicate names that confuse receivers.
3. **Drag** to reparent only when **buying** and **reporting** agree — large moves need **manager** sign-off.
4. After big changes, spot-check **Inventory List** filters and one **Insights** slice if your role can.

### Discount events

**Purpose:** Time-boxed **merchandising** discounts; POS can apply eligible events automatically when lines match.

1. **Inventory** → **Add/Edit Catalog** → **Promotions**.
2. Create or edit an event: **name**, **start/end**, and **rules** your UI exposes.
3. Attach **variants** / SKUs to the event; **save** each step.
4. **Test at POS:** add one attached SKU in a **test** cart and confirm discount behavior **before** customer-facing launch.
5. **Usage:** aggregated usage is available to the API as **`/api/discount-events/usage-report`** (admin reporting / future NL tools — see [AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md)); use it for post-mortems after big promos.

### Vendors

**Purpose:** Supplier records used by **receiving**, **PO** flows, and **catalog import** matching.

1. **Inventory** → **Add/Edit Catalog** → **Vendors**.
2. Keep **vendor name** and **vendor code** unique and consistent with **Import** / **Counterpoint** mappings (see [CATALOG_IMPORT.md](../CATALOG_IMPORT.md)).
3. When onboarding a new supplier, add the vendor **before** bulk import if your file keys off **vendor_code**.
4. Use **Merge** to consolidate duplicate supplier records instead of letting PO and receiving history split across multiple vendors.
5. Do not delete vendors with **open PO** history without **manager** + accounting alignment.

### Import (CSV)

1. **Add/Edit Catalog** → **Catalog Import** → use the **Catalog CSV** mapper for vendor or cleanup files.
2. This tool updates **catalog structure only**. It does **not** replace live **on-hand** stock.
3. For the initial inventory load before launch, use **Settings → Counterpoint**. After launch, quantity changes belong in **Receiving** or **Physical count**.
4. Upload file under your IT **size limit**; if rejected, split file or ask for limit increase.
5. Read **preview errors** row by row; do not assume “partial import” is safe without review.

## Order Stock

1. **Inventory** → **Order Stock**.
2. Select the correct vendor **before** creating the PO.
3. Standard POs stay editable only while they are **draft**.
4. A standard PO must have at least one line before **Submit PO** is allowed.
5. PO lines require a valid SKU, quantity above zero, and non-negative unit cost.
6. If a SKU is already linked to a different **primary vendor**, ROS blocks adding it to the wrong vendor’s PO.

Use **Order Stock** when you are planning or building a vendor order before merchandise arrives. Direct invoices are for merchandise that arrived without a pre-built order, so start them from **Receive Stock** when the vendor paperwork is already in hand.

## Receive Stock

Use **Receive Stock** when merchandise is already here and you have vendor paperwork in hand.

1. **Receive Stock** → choose a submitted **PO** that is ready to receive, or create a **Direct Invoice** if the shipment arrived without a pre-built PO.
2. Check the document state before opening the receiving worksheet:
   - **Submitted PO** = ready to receive.
   - **Direct invoice** = arrived without a pre-built PO and can open receiving immediately.
   - **Draft PO** = order setup; submit it before receiving.
3. Scan or enter **quantities** to match the packing slip.
4. Scanning and worksheet entry only **stage** the receipt. They do **not** change live stock yet.
5. **Post inventory** (finalize receipt into stock) is the **emerald** primary action (**green** with a **thick bottom edge**) — same **“terminal completion”** pattern as **Complete Sale** on the register (**`UI_STANDARDS.md`**). Read totals before confirming.
6. Watch for messages about **reserved** stock for open special orders after posting.

**Direct invoices** and submitted **standard POs** now share the same final posting path. If a receipt is retried, ROS prevents duplicate stock posting for the same receipt payload.

**At the register**, staff browse the catalog and tap **Add to sale** from **POS → Inventory** (same data family as the control board) — [pos-inventory.md](pos-inventory.md).

## Correct Stock

Use **Correct Stock** to review correction history for stock that left normal sale/receiving paths. To change stock, start from **Find Item**, choose the item/SKU, and use the stock adjustment action there.

Choose the correction path by the real-world reason:

| Staff job | Start here | Use when |
|----------|------------|----------|
| Fix a small count mistake | **Find Item** stock adjustment | The shelf count was off by one or needs a small count correction. |
| Record damage or loss | **Find Item** → **Damage/Loss** | Merchandise is damaged, missing, or unsellable. |
| Return merchandise to a vendor | **Find Item** → **Return to Vendor** | Merchandise is leaving for vendor credit or a vendor claim. |
| Run a full or category count | **Count/Reconcile** | You are reconciling a shelf, category, cycle count, or full-store count. |

The **Damage/Loss History** and **Vendor Return History** sections under **Correct Stock** are review/report sections. They show prior movements; they are not the starting point for a new correction.

## Count/Reconcile

1. **Count/Reconcile** (requires **physical_inventory.view**).
2. **Start or resume** session; scan **location** per SOP.
3. **Review variances** before posting adjustments — large shrink hits **financial** review.
4. For **full store** or category counts, review also surfaces in-scope SKUs that were **not counted**. Do not treat those rows as already reviewed just because they were not scanned.

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

**Last reviewed:** 2026-04-21
