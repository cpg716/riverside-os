# Inventory (Back Office)

**Audience:** Inventory leads, buyers, receivers.

**Where in ROS:** Back Office → **Inventory**. Opening Inventory shows the **Inventory Hub**. Main jobs: **Find Item**, **Add/Edit Catalog**, **Promotions**, **Order Stock**, **Receive Stock**, **Correct Stock**, **Count/Reconcile**.

**Related permissions:** **catalog.view** / **catalog.edit** for catalog surfaces. **procurement.view** / **procurement.mutate** for PO-style receiving. **physical_inventory.view** for **Physical count**.

---

## How to use this area

Pick the area that matches the **job**, not the person:

| Staff job | Use it for | Previous tools now under it |
|-----------|------------|-----------------------------|
| **Find Item** | Find, open, and manage existing items from Product hub | Inventory List |
| **Add/Edit Catalog** | Create items and manage catalog structure | Add Item, Categories, Vendors, Import |
| **Promotions** | Create and review time-boxed discounts | Discount events |
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
4. Click a row or **hub** icon to open **Product Hub**.
5. Use **Item Setup** for product family details, vendor, category, tax, employee pricing, and cleanup review.
6. Use **SKUs & Stock** for SKU-level price, web status, tags, low-stock alerts, small count corrections, damage, and vendor returns.

**Common pitfall:** Do not use Product Hub count corrections for vendor shipments. Vendor shipments belong in **Receive Stock** so PO, receiving, reserved stock, and financial staging stay connected.

## Add/Edit Catalog

Use **Add/Edit Catalog** for setup tooling: creating new items, managing category and vendor records, and importing catalog files. For existing item edits, start in **Find Item** instead.

### Add Item

1. **Add/Edit Catalog** → **Add Item** → follow the wizard (3 or 4 steps depending on web publishing):
   - **Step 1: Product & Pricing**: Enter item details, base cost, retail price, and primary vendor.
     - **Vendor Intelligence**: When a vendor is selected, a contextual sidebar shows the vendor code, rules, and guidance.
     - **Margin/Markup Hints**: Profit margin and markup percentages calculate in real-time as cost and retail prices are entered.
     - **Item Rules Grid**: Tax overrides, low-stock warnings, and web-publishing configurations are grouped into a clean 3-column selector layout.
   - **Step 2: Sizes & Options**: Set up matrix axes (Size, Color, Fit, etc.) manually or by using **Copy From** to duplicate the variation structure of an existing product.
   - **Step 3: Web Listing** *(only if "Publish to Web" was checked in Step 1)*: Marketing overrides, tags, categories, image gallery, and SEO fields.
   - **Final Step — Review & Save**: Verify the SKU variations and click the green save button to commit the product catalog record.
2. Enter **non-negative** base retail and cost values. Negative benchmark pricing, negative cost, and negative initial stock are blocked.
3. Primary vendor is required for manually created items because downstream ordering and receiving depend on it.
4. New Riverside-created SKUs use **`ROS-XXXXXX`** and should advance to the next available ROS number. Imported Counterpoint SKUs such as **`B-XXXXXX`** stay unchanged.
5. Use **Copy From** when a new item has similar options to an existing style. Copy From copies option structure only; it does not copy name, vendor, stock, cost, retail, or descriptions.
6. Keep generated SKUs unique. If a SKU already exists anywhere in ROS, the product will not save until the conflict is resolved.
7. Clickable step navigation lets you jump directly between validation-passed steps.
8. Verify the SKU appears in **Find Item** search.

### Web Store Listing (Web Listing Step)

When "Publish to Web" is enabled, the catalog wizard inserts a dedicated **Web Listing** step:
- **Marketing Overrides**: Allows entering a custom **Web Storefront Title** and a rich **Web Description** specifically for online merchandising (falls back to POS name/description if blank).
- **Web Tags**: Input keywords separated by commas to improve online catalog searches (e.g. `wool, suit, wedding`).
- **Online Store Categories**: Assign the product to one or more active nodes using the hierarchical checkbox category tree.
- **Web Image Gallery**: Add web-specific product photos via URL with custom Alt Text. You can also generate high-quality product images using the embedded **AI Image Generator** (powered by Fal.ai Flux Dev/Schnell models) directly inside the gallery card. Use up/down arrow buttons to set the sort order and select the **Hero Image** (used as the primary thumbnail).
- **SEO Optimization**: Override the HTML Meta Title (max 70 characters) and Meta Description (max 160 characters) with real-time length counters.
- **Live Preview Pane**: Displays a side-by-side mockup of the online storefront cart card and the Google Search snippet preview.

### Categories

**Purpose:** Merchandising hierarchy — affects **filters**, **reports**, and how staff **search**.

1. **Inventory** → **Add/Edit Catalog** → **Categories**.
2. **Add** or **rename** nodes per SOP; avoid duplicate names that confuse receivers.
3. Set up to three default option types, such as **Size**, **Color**, and **Fit**. Add Item loads these defaults when that category is selected.
4. **Drag** to reparent only when **buying** and **reporting** agree — large moves need **manager** sign-off.
5. After big changes, spot-check **Find Item** filters and one **Insights** slice if your role can.

## Promotions

**Purpose:** Time-boxed **merchandising** discounts; POS can apply eligible events automatically when lines match.

1. **Inventory** → **Promotions**.
2. Create or edit a promotion: **Promotion Name**, **Receipt Label**, **Starts**, **Ends**, **Discount %**, and **Applies To**.
3. For category or vendor promotions, select the matching category or primary vendor before saving.
4. Attach **variants** / SKUs to selected-SKU promotions; **save** each step.
5. **Test at POS:** add one attached SKU in a **test** cart and confirm discount behavior **before** customer-facing launch.
6. **Usage:** aggregated usage is available to the API as **`/api/discount-events/usage-report`** (admin reporting / future NL tools — see [AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md)); use it for post-mortems after big promos.

### Vendors

**Purpose:** Supplier records used by **receiving**, **PO** flows, and **catalog import** matching.

1. **Inventory** → **Add/Edit Catalog** → **Vendors**.
2. Use the vendor list to search, select, add, edit, or merge suppliers.
3. Keep **vendor name** and **vendor code** unique and consistent with **Import** / **Counterpoint** mappings (see [CATALOG_IMPORT.md](../CATALOG_IMPORT.md)).
4. When onboarding a new supplier, add the vendor **before** bulk import if your file keys off **vendor_code**.
5. Use **Merge** to consolidate duplicate supplier records instead of letting PO and receiving history split across multiple vendors.
6. Do not delete vendors with **open PO** history without **manager** + accounting alignment.

### Import (CSV)

1. **Add/Edit Catalog** → **Catalog Import** → use the **Catalog CSV** mapper for vendor or cleanup files.
2. This tool updates **catalog structure only**. It does **not** replace live **on-hand** stock.
3. For the initial inventory load before launch, use **Settings → Counterpoint**. After launch, quantity changes belong in **Receiving** or **Physical count**.
4. Upload file under your IT **size limit**; if rejected, split file or ask for limit increase.
5. Read **preview errors** row by row; do not assume “partial import” is safe without review.

## Order Stock

1. **Inventory** → **Order Stock**.
2. Select the vendor from the **Unified Vendor Selector Bar** in the top row. The selector bar groups PO building and direct invoices into a single header.
3. Review the **Collapsible NTBO Queue**: Special customer orders awaiting vendor order placement are housed here. Toggle it open to reference needed styles/quantities without cluttering the screen.
4. Standard POs stay editable only while they are **draft**.
5. A standard PO must have at least one line before **Submit PO** is allowed.
6. PO lines require a valid SKU, quantity above zero, and non-negative unit cost.
7. If a SKU is already linked to a different **primary vendor**, ROS blocks adding it to the wrong vendor’s PO.
8. PO worksheets feature tighter grid spacing and hover-reveal action buttons (Mark Sent, Receive, Delete) for cleaner visual management.
9. The **Receive Stock** shortcut in Order Stock moves you to the receiving job without mixing direct invoices into the PO-building screen.

Use **Order Stock** when you are planning or building a vendor order before merchandise arrives. Direct invoices are for merchandise that arrived without a pre-built order, so start them from **Receive Stock** when the paperwork is in hand.

Use **Import PO / Invoice** when the vendor sends paperwork before or with the shipment and you want ROSIE to read it before you build the draft. The importer creates reviewed PO/direct invoice drafts only; it does not submit a PO and it does not post stock.

## Receive Stock

Use **Receive Stock** when merchandise is already here and you have vendor paperwork in hand.

If a physical inventory session is open or in review, receiving is paused. Sales may continue during the count, but ROS will not post received stock until the count is published or canceled.

1. **Receive Stock** → choose a submitted **PO** that is ready to receive, or create a **Direct Invoice** if the shipment arrived without a pre-built PO.
   - **Direct Invoice** is the primary action for paperwork that arrived with merchandise but no pre-built PO.
   - **Build Standard PO** sends you back to Order Stock when the shipment has not arrived yet or the vendor order still needs to be created/sent.
   - **Import PO / Invoice** lets you upload PDF, Word, Excel, CSV, JSON, TXT, JPG, or PNG vendor paperwork. ROSIE reads the file, deterministic parsers pre-read structured data where useful, and staff reviews line matches before creating a draft.
2. The receiving screen shows a **3-step workflow indicator** in the header bar:
   - **Step 1 | Check paperwork** — confirm you have the right vendor invoice or PO.
   - **Step 2 | Count & invoice** — scan or enter quantities; fill in the invoice number and freight amount.
   - **Step 3 | Post inventory** — review totals, then post to finalize.
   - A **"Next: ..."** hint beside the step indicators shows what comes next at each stage.
3. Check the document state before entering quantities:
   - **Submitted PO** = ready to receive.
   - **Direct invoice** = arrived without a pre-built PO and can open receiving immediately.
   - **Draft PO** = order setup; submit it before receiving.
4. Scanning and worksheet entry only **stage** the receipt. They do **not** change live stock yet.
5. **Post Receipt** (the emerald button in the footer) finalizes the receipt into inventory — same **"terminal completion"** pattern as **Complete Sale** at the register. Read totals before confirming.
6. Watch for messages about **reserved** stock for open special orders after posting.

**Direct invoices** and submitted **standard POs** share the same final posting path. Once a receipt is finalized, ROS locks the document and blocks duplicate posting for that receipt ID to preserve database and ledger integrity.

AI-assisted paperwork import follows this same rule: extracted lines can only create a reviewed draft PO or draft direct invoice. Live stock changes only after staff review and **Post Receipt**.

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

## Product Hub variation modes

Open **Product Hub** from **Find Item**. The **SKUs & Stock** tab supports three views:

- **Cards:** default, touch-friendly inventory cards for daily SKU work.
- **Matrix:** compact axis grid when a style has true size/color/fit structure.
- **List:** dense table for long SKU lists and bulk edits.

All views should represent the same filtered SKUs. Used Counterpoint SKUs and new ROS SKUs must both remain searchable, editable, sellable, and usable in receiving and order workflows.

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

**Last reviewed:** 2026-06-04
