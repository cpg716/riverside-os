---
id: inventory-back-office
title: "Inventory Back Office"
order: 1060
summary: "Central hub for stock management, purchase orders, receiving, physical counts, and vendor relations."
source: client/src/components/inventory/InventoryWorkspace.tsx
last_scanned: 2026-04-17
tags: inventory, back-office, stock, receiving, counts, vendors, categories, discounts
---

# Inventory (Back Office)

_Audience: Inventory leads, buyers, receivers._

**Where in ROS:** Back Office → **Inventory**. Subsections: **Overview**, **Product List**, **Purchase Orders**, **Receive Items**, **Count Stock**, **Damaged Items**, **Returns**, **Store Map**, **Suppliers**, **Sales**, **Reports**, **System Settings**.

**Related permissions:** **catalog.view** / **catalog.edit** for catalog surfaces. **procurement.view** / **procurement.mutate** for PO-style receiving. **physical_inventory.view** for **Count Stock**. **maintenance.mutate** for **Damaged/Returns**.

---

## How to use this area

Pick the subsection that matches the **job**, not the person: **look up** → **Inventory List**; **new style** → **Add Inventory**; **truck arrived** → **Receiving**; **storewide sale** → **Discount events**; **big file** → **Import**; **yearly count** → **Physical count**.

## Inventory List (control board)

**Purpose:** Find SKUs fast, tweak price/stock fields you are allowed to edit, open **product hub** for matrix and history.

1. Go to **Inventory** → **Product List**.
2. Search by **SKU**, **Name**, or **Supplier** in the top search bar.
3. Use the **Load more** button for large catalogs — the system loads items in batches to keep the interface fast.
4. Click a row to open the **Product Hub** for detailed stock management and the **Size Matrix**.

**Size Matrix (Clothing):**
Use the matrix grid to view stock levels across multiple sizes and colors at once. For new products, use the **Create Sizes** tool to automatically generate `B-XXXXX` SKUs for your entire size run.

## Add Inventory

1. **Add Inventory** → follow wizard steps (category, matrix, initial SKU).
2. **Save** each step; do not close the browser mid-wizard.
3. Verify the SKU appears in **Inventory List** search.

## Receive Items

1. **Receive Items** → open expected **PO** or **direct receipt** flow your store uses.
2. Scan or enter **quantities** to match the packing slip.
3. **Post inventory** (finalize receipt into stock) is the **emerald** primary action (**green** with a **thick bottom edge**). Read totals before confirming.

## Categories

**Purpose:** Merchandising hierarchy — affects **filters**, **reports**, and how staff **search**.

1. **Inventory** → **Categories**.
2. **Add** or **rename** nodes per SOP.
3. **Drag** to reparent only when **buying** and **reporting** agree.

## Discount events

**Purpose:** Time-boxed **merchandising** discounts; POS can apply eligible events automatically when lines match.

1. **Inventory** → **Discount events**.
2. Create or edit an event: **name**, **start/end**, and **rules**.
3. Attach **variants** / SKUs to the event.

## Vendors

**Purpose:** Supplier records used by **receiving**, **PO** flows, and **catalog import** matching.

1. **Inventory** → **Vendors**.
2. Keep **vendor name** and **vendor code** consistent with **Import** CSV columns.

## Import (CSV)

1. **Import** → choose mapping preset.
2. Upload file under your IT **size limit**.
3. Read **preview errors** row by row.

## Physical count

1. **Physical count** (requires **physical_inventory.view**).
2. **Start or resume** session; scan **location** per SOP.
3. **Review variances** before posting adjustments — large shrink hits **financial** review.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **SKU not in search** | Try **SKU** exact; check **inactive** filter. |
| **Cannot edit price** | **catalog.edit** missing; see Manager. |
| **Import HTTP error** | Smaller file; different browser. |
| **Receiving over-receives** | Stop; do not post; Manager reverses/adjusts PO. |

**Last reviewed:** 2026-04-17
