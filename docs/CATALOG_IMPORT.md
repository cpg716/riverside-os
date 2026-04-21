# Catalog CSV import (catalog-only vendor mapper)

End-to-end reference for **Inventory → Import** (`UniversalImporter`) and **`POST /api/products/import`**.

## Code map

| Layer | Location |
|-------|-----------|
| UI | `client/src/components/inventory/UniversalImporter.tsx` |
| Handler | `server/src/api/products.rs` (`import_catalog`) |
| Logic | `server/src/logic/importer.rs` (`execute_import`) |

**Low-stock notification flags (migration 52):** CSV import does **not** set **`track_low_stock`** on templates or variants; new and upserted rows keep the column default **`false`** until staff enable tracking in the **product hub** (see **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`INVENTORY_GUIDE.md`**).

## Request body size (413 Payload Too Large)

The client sends the full parsed CSV as JSON (`rows` + `mapping`). Serialized size is often **several times** the raw `.csv` file.

- **Server**: `server/src/main.rs` applies Axum **`DefaultBodyLimit`** (default **256 MiB** after app wiring).
- **Override**: set **`RIVERSIDE_MAX_BODY_BYTES`** to a decimal byte count (minimum accepted **1 MiB** when parsing the env var).
- **Observability**: on startup, `tracing` logs `HTTP request body limit` with `max_json_body_bytes`.

## Product direction

- **Counterpoint sync is the authoritative pre-launch inventory path.**
- **Inventory → Import** is now a **catalog-only** CSV mapper for vendor manifests, cleanup files, and one-off catalog onboarding.
- This endpoint does **not** accept or apply **`stock_on_hand`** updates. Live stock must come from **Counterpoint sync**, **Receiving**, or **Physical Inventory**.
- Legacy **Lightspeed X-Series** inventory import wording has been retired from this surface; the remaining importer behavior is generic catalog mapping only.
- Product and vendor records created downstream from import are still expected to satisfy current catalog rules: non-negative pricing/cost, unique vendor naming/code, and clean PO vendor linkage before receiving.

## JSON payload shape

- **`rows`**: `Array<Record<string, string>>` — each row keyed by exact CSV header strings.
- **`mapping`**: maps logical field names to **CSV header names** (values must match the keys in each row object).
- **`category_id`** (optional UUID): fallback when a row has no resolvable category from the mapped category column; required if no category column is mapped.

### Mapping keys (server)

| Key | Role |
|-----|------|
| `product_identity` | Groups variants (catalog handle, style number, or other parent identity) |
| `sku`, `barcode` | Variant identity / scan fields |
| `product_name`, `retail_price`, `unit_cost`, `brand` | Product fields |
| `category` | Category label → `categories` (create if missing, `is_clothing_footwear = true`) |
| `supplier` | Supplier **name** column → find/create `vendors`, set `products.primary_vendor_id` |
| `supplier_code` | Optional; non-empty cell updates **`vendors.vendor_code`** for the vendor resolved from `supplier` on that row |

If the payload includes **`mapping["stock_on_hand"]`**, the server rejects the request with a validation error explaining that stock imports have moved to **Counterpoint sync**.

If **`supplier`** is unmapped or the cell is empty, no primary vendor is set for that product row and **`supplier_code`** cannot attach to a vendor for that row.

## Schema: `vendors.vendor_code`

- **`migrations/35_vendors_vendor_code.sql`** adds **`vendors.vendor_code`** (`TEXT`, nullable).
- **`GET /api/vendors`** and vendor create JSON include **`vendor_code`**.
- **Vendor Hub** (`VendorHub.tsx`) displays **Vendor code** when present (distinct from **Account #** / `account_number`).

## Back Office sidebar shortcut

On the main Back Office **`Sidebar`**, **double-click** a primary nav tab button (or the **collapsed** profile avatar) to **toggle** sidebar expanded vs collapsed icon rail. The bottom chevron control remains **single-click** only (double-click would toggle multiple times).
