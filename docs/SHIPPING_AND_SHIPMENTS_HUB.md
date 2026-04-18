# Shipping, Shippo, and the unified shipments hub

**Audience:** Developers and operators shipping from **POS**, the **Back Office**, the **online storefront**, or **manual** CRM workflows.

**Purpose:** Describe the unified shipping architecture where the **Shipments Hub** is mirrored between both the Back Office and the POS to support salespersons and support staff. Details today's state (schema, env, APIs, UI) versus what remains on the roadmap (**[`docs/PLAN_SHIPPO_SHIPPING.md`](PLAN_SHIPPO_SHIPPING.md)**).

---

## Migrations

| # | File | What it adds |
|---|------|----------------|
| **73** | **`73_online_store_module.sql`** | **`orders.sale_channel`** (`register` \| `web`), storefront catalog flags, pages, coupons, tax helpers, **`online_store.manage`** — **[`docs/PLAN_ONLINE_STORE_MODULE.md`](PLAN_ONLINE_STORE_MODULE.md)** |
| **74** | **`74_shippo_shipping_foundation.sql`** | **`orders.fulfillment_method`** (`pickup` \| `ship`), **`ship_to`**, shipping money + Shippo/tracking columns on **`orders`**; **`store_settings.shippo_config`**; **`store_shipping_rate_quote`** (short-lived quotes for checkout binding) |
| **75** | **`75_unified_shipments_hub.sql`** | **`shipment`**, **`shipment_event`** (append-only log); enums **`shipment_source`** (`pos_order`, `web_order`, `manual_hub`), **`shipment_status`**; RBAC **`shipments.view`**, **`shipments.manage`**; backfill from existing **ship** orders |

Apply with **`./scripts/apply-migrations-docker.sh`** (ledger in **`migrations/00_ros_migration_ledger.sql`**). Status: **`./scripts/migration-status-docker.sh`**.

---

## Environment and settings

| Mechanism | Notes |
|-----------|--------|
| **`SHIPPO_API_TOKEN`** | Server env; **never log**. Required for live Shippo API calls when enabled. |
| **`SHIPPO_WEBHOOK_SECRET`** | Reserved for future tracking webhooks (optional). |
| **`store_settings.shippo_config`** | JSON: **`enabled`**, **`live_rates_enabled`**, **`from_address`**, **`default_parcel`** — loaded in **`server/src/logic/shippo.rs`** (`StoreShippoConfig`). |

| **`GET` / `PATCH /api/settings/shippo`** | **`settings.admin`** | Read/update **`shippo_config`**; response includes **`api_token_configured`** / **`webhook_secret_configured`** (boolean flags from env only — secrets are never returned). |

Live rates run only when the store enables them **and** the token is present (see effective config in code).

---

## APIs (high level)

| Prefix / route | Permission / gate | Role |
|----------------|-------------------|------|
| **`POST /api/store/shipping/rates`** | Public storefront | Web cart: quote shipping; body `to_address`, optional `parcel`, optional `force_stub` (default **false** = try live Shippo when Settings + token allow). **`/shop/cart`** collects the address, calls this endpoint, and lets the shopper pick a **`rate_quote_id`** (shown in the order estimate; payment binding is a later phase). |
| **`POST /api/pos/shipping/rates`** | Staff **or** open POS register session | Register: quote before/during checkout. |
| **`GET /api/shipments`**, **`POST /api/shipments`** | **`shipments.view`** / **`shipments.manage`** | List (optional **`customer_id`**, open-only filters); create **manual** shipment. |
| **`GET /api/shipments/{id}`** | **`shipments.view`** | Detail + **`events`** timeline. |
| **`PATCH /api/shipments/{id}`** | **`shipments.manage`** | Status, tracking, notes (writes **`shipment_event`**). |
| **`POST /api/shipments/{id}/rates`** | **`shipments.manage`** | Shippo rates for that registry row (`force_stub` query optional). |
| **`POST /api/shipments/{id}/apply-quote`** | **`shipments.manage`** | Consumes a **`store_shipping_rate_quote`** row by id. |
| **`POST /api/shipments/{id}/notes`** | **`shipments.manage`** | Staff note → event. |

Implementation: **`server/src/api/shipments.rs`**, **`server/src/logic/shipment.rs`**, **`server/src/api/pos.rs`**, **`server/src/api/store.rs`**.

**Checkout:** POS checkout with **ship** fulfillment creates or aligns a **`shipment`** row via **`insert_from_pos_order_tx`** (**`server/src/logic/order_checkout.rs`**). **Web** paid orders that ship should get the same treatment in the web checkout path when that flow is wired (backfill **75** already tags historical rows by **`sale_channel`**).

---

## RBAC (migration **75**)

| Key | Default (seeded) | Typical use |
|-----|------------------|-------------|
| **`shipments.view`** | admin, sales_support, salesperson | List/read hub, timeline, customer hub tab. |
| **`shipments.manage`** | admin, sales_support only | Manual create, patch, rates, apply quote, staff notes. |

Sidebar **Customers → Shipments** maps subsection permission **`customers:ship`** → **`shipments.view`** in **`BackofficeAuthContext`**.

---

## UI

- **Customers → Shipments** (BO) — full-store list, filters, manual shipment modal, detail panel (rates, apply quote, status/tracking), **event timeline** (`ShipmentsHubSection.tsx`).
- **POS Sidebar → Shipping** (Register) — mirrored access to the hub for floor staff and sales support.
- **Relationship Hub → Shipments** (Joint) — same component with **`customerIdFilter`** for the open customer, available in both BO and POS.
- **Relationship Hub → Interaction timeline** — append-only **`shipment_event`** rows for this customer appear as **`shipping`** entries (requires **`customers.timeline`**), with **`reference_type`** **`shipment`**. Staff with **`shipments.view`** can **click the summary** to jump to the **Shipments** tab with that shipment opened (detail + list).

Roadmap UI (orders workspace label buy, fulfillment gates) remains in **`PLAN_SHIPPO_SHIPPING.md`**.

---

## Related docs

- **[`docs/PLAN_SHIPPO_SHIPPING.md`](PLAN_SHIPPO_SHIPPING.md)** — full product/technical roadmap (labels, webhooks, late-bound shipping).  
- **[`docs/ONLINE_STORE.md`](ONLINE_STORE.md)** — public **`/shop`**, **`/api/store`**, guest cart + CMS (pairs with **store** rates below).  
- **[`docs/PLAN_ONLINE_STORE_MODULE.md`](PLAN_ONLINE_STORE_MODULE.md)** — storefront roadmap (Stripe checkout, reporting, assets).  
- **[`docs/CUSTOMER_HUB_AND_RBAC.md`](CUSTOMER_HUB_AND_RBAC.md)** — hub tabs and CRM permissions.  
- **[`docs/STAFF_PERMISSIONS.md`](STAFF_PERMISSIONS.md)** — effective permissions and overrides.

**Last reviewed:** 2026-04-05
