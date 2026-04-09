# Inventory Scanning & Physical Counts — Riverside OS

Riverside OS features a high-performance inventory management system with support for multi-device scanning, real-time receiving, and unified physical inventory counts.

## Unified Scanning Engine (`useScanner`)

The scanning engine is built to work seamlessly across all device types.

### HID Laser Scanners (Desktop/iPad)
The `useScanner` hook provides a global, timing-dependent listener for HID laser scanners.
- **Timing Detection**: Differentiates between rapid laser input (<80ms char interval) and manual human keyboard entry.
- **Context Awareness**: Does not capture input when the user is focused on standard text inputs (except in the `ReceivingBay` dedicated input).
- **Receiving UX:** **Post inventory** uses the **emerald terminal completion** pattern (**`bg-emerald-600`**, **`border-b-8 border-emerald-800`**) for parity with POS primary actions — see **`UI_STANDARDS.md`**.
- **Real-time Feedback**: The scanner is integrated into a non-blocking bar. SKU lookups and count increments provide immediate visual feedback (success/error states) without interrupting the scanning cadence. Browser dialogs are strictly prohibited.

### PWA Camera Scanning (Smartphone)
For remote access via Tailscale, the `CameraScanner` component uses `html5-qrcode` to provide a native-feel scanning experience in a mobile browser.
- **Visual Guides**: On-screen corner markings for faster alignment.
- **Debounced Scanning**: Prevents accidental double-scans within 800ms.

## Physical Inventory Module

The Physical Inventory system allows you to count stock without closing the store. It is divided into three key phases:

### Phase 1: Session Management
- **One Active Session**: Only one physical inventory can be "Open" at a time to maintain data integrity.
- **Scope**: Counts can be for the **Full Store** or filtered by **Selected Categories**.
- **Resume Capability**: Sessions are persistent and can be saved/resumed over multiple days.

### Phase 2: Counting
- **Multi-Input**: Use laser scanners, camera scanners, or manual SKU searches.
- **Batch Processing**: Scans are buffered locally using `localforage` and synced to the server in batches, ensuring high performance and offline resilience.

### Phase 3: Review & Publish
- **Sales Reconciliation**: This is a critical feature. The system records all sales made *during* the inventory session.
- **Reconciliation Calculation**:
    ```text
    Final Stock = (Counted Quantity - Sales Since Start)
    ```
- **Review Table**: Before publishing, users can review all counts, add adjustment notes, and fix any counting errors.
- **Atomic Publish**: On publish, the system updates `product_variants.stock_on_hand` and logs `inventory_transactions` in a single database transaction.

## POS Inventory Resolution (Intelligent Search)

The POS `Cart` implements an 'Intelligent' search strategy that prioritizes speed and accuracy:

### 1. Direct SKU Scan
- **Precise Match**: If the input is an exact match for a `variant_id`, `sku`, or `vendor_upc`, the item is added to the cart instantly with zero further interaction.
- **Priority**: Primary focus for fast-paced retail checkout.

### 2. Fuzzy Product Search
- **Parent-First Results**: If no exact SKU is found, the system performs a fuzzy search across product names, SKUs, barcodes, vendor UPCs, brands, and variation labels (**`GET /api/products/control-board?search=`** — or **`/api/inventory/control-board`**).
- **Popularity ranking**: When **`search`** is non-empty, SQL orders matches by **trailing parent-product unit sales** (default **45 days** of `orders.booked_at`, **cancelled** orders excluded), then **`product` name**, then **SKU**, so faster-moving **styles** rise to the top. All variants of a product share the same popularity score.
- **Grouping**: The POS dropdown groups rows by **product** so many **distinct parents** can appear (Register requests a bounded **`limit`** — see **`docs/SEARCH_AND_PAGINATION.md`**).
- **Variation Indicators**: Grouped results clearly show if an item has multiple variations (e.g., '5 Variations' or '12 Sizes').

### 3. Variation selection panels
- **Touch-Optimized Hub**: Selecting a grouped product parent opens a high-fidelity 'Variation Selection' modal.
- **Visual Clarity**: Variations are laid out professionally for touch-screen use, allowing staff to quickly tap 'Large', 'Blue', or '14K Gold' to resolve to the exact SKU.

## Vendor UPC Support

## Post-sale returns and restock

When staff record **line returns** (`POST /api/orders/{id}/returns`), **takeaway** lines that are already **fulfilled** (picked up) default to **restocking**: `product_variants.stock_on_hand` increases by the returned quantity. **Special order** / **wedding order** lines do not get an automatic floor restock (merchandise was never decremented at checkout the same way as takeaway). Optional per-line **`restock`** on the request overrides the default.

Effective sellable quantity on an order is **original line qty minus** summed **`order_return_lines`**; totals and loyalty accrual math use that effective qty (see **`docs/ORDERS_RETURNS_EXCHANGES.md`**).

## Data Structure

- **`physical_inventory_sessions`**: The lifecycle container.
- **`physical_inventory_snapshots`**: Captured stock levels at the exact moment the session starts.
- **`physical_inventory_counts`**: The raw counted data.
- **`physical_inventory_audit`**: Full log of every scan and manual adjustment.

> [!TIP]
> To enable hardware audio chimes on some browsers (like Chrome/Safari), click once anywhere on the page to "warm up" the Web Audio context. ROS does this automatically on the first "Start Session" or "Mode Toggle" click.

## Related (catalog list UI)

The **Inventory → Inventory List** control board (`client/src/components/inventory/InventoryControlBoard.tsx`, `InventoryWorkspace.tsx`) is the primary non-scanning surface for browsing templates, filters, and inline edits. It uses shared **`ui-input`** styling with the rest of Back Office (`client/src/index.css`). Scanning/receiving flows above are unchanged.

### Product hub: low-stock alerts (Back Office)

**Template hub** (**`ProductHubDrawer`**, opened from the control board): **General** tab has **Track low stock (template)** (`products.track_low_stock`, default off). **Matrix** tab has per-SKU **Track low** (`product_variants.track_low_stock`, default off); disabled until the template flag is on.

**Effective rule for admin morning notifications:** both flags **true**, **`reorder_point` > 0**, and **available** quantity `stock_on_hand - reserved_stock` is at or below **`reorder_point`**. Importers and new products default both flags **false** until staff opt in.

API: **`GET /api/products/{id}/hub`**, **`PATCH /api/products/{id}/model`** (`track_low_stock`), **`PATCH /api/products/variants/{id}/pricing`** (`track_low_stock`). See **`docs/PLAN_NOTIFICATION_CENTER.md`** and migration **`52_track_low_stock_morning_digest.sql`**.

### API & very large catalogs

List data comes from **`GET /api/inventory/control-board`** (same handler as **`GET /api/products/control-board`**). **Filters** and **stock/OOS predicates** stay **in SQL**. When **`search`** is set and **Meilisearch** is configured (**`RIVERSIDE_MEILISEARCH_URL`**), matching **variant ids** are resolved in Meilisearch first, then rows are loaded in PostgreSQL and sorted like the non-Meili path: **text search** uses **parent-product popularity** (trailing window) then **name/SKU**; **browse** (no text search) uses **`ORDER BY p.name, pv.sku`**. Optional **`product_id`** filters to one template’s variants (POS **cart line** variant swap). The Back Office list UI sends explicit **`limit`** (defaults **5_000** when searching, **25_000** when browsing) and supports **Load more SKUs** to append the next **`offset`**. Defaults, caps, and client entry points are summarized in **`docs/SEARCH_AND_PAGINATION.md`**.

**Note:** **`GET /api/products`** (no path suffix) returns only active **product templates** (`LIMIT 200`) — not variant-level search. Use **`control-board`** for SKU/name/barcode discovery.

## Catalog CSV import (Lightspeed / universal)

**Inventory → Import** uploads a vendor or Lightspeed X-Series export and posts to **`POST /api/products/import`**. Mapping keys, body-size limits, **`supply_price`** vs **`supplier_code`**, and **`vendors.vendor_code`** (migration **35**) are documented in **`docs/CATALOG_IMPORT.md`**.

## Suit / 3-piece component swaps (planned)

Swapping **vest** or **pants** (or jacket) for another **SKU** on **one customer’s sale** (not editing the **product** in the catalog) — with correct **stock**, **line cost/retail**, and **QuickBooks inventory adjustments** — is a **separate** workflow from scanning, receiving, and physical counts. Requirements and QBO notes: **`docs/SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`** (see also **`docs/PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md`** §3.2).
