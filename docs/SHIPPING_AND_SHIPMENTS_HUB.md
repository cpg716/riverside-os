# Shipping, Shippo, and the unified shipments hub

Status: **Canonical Shipping / Shippo / Shipments Hub reference**. Cross-cutting Podium and notification behavior starts at [Podium Integration](staff/Podium_Integration_Manual.md).

**Audience:** Developers and operators shipping from **POS**, the **Back Office**, the **online storefront**, or **manual** CRM workflows.

**Purpose:** Describe the unified shipping architecture where the **Shipments Hub** is mirrored between both the Back Office and the POS to support salespersons and support staff. Details today's state (schema, env, APIs, UI) versus what remains on the roadmap (**[`docs/PLAN_SHIPPO_SHIPPING.md`](PLAN_SHIPPO_SHIPPING.md)**).

---

## Migrations

| # | File | What it adds |
|---|------|----------------|
| **73** | **`73_online_store_module.sql`** | **`orders.sale_channel`** (`register` \| `web`), storefront catalog flags, pages, coupons, tax helpers, **`online_store.manage`** — **[`docs/PLAN_ONLINE_STORE_MODULE.md`](PLAN_ONLINE_STORE_MODULE.md)** |
| **74** | **`74_shippo_shipping_foundation.sql`** | **`orders.fulfillment_method`** (`pickup` \| `ship`), **`ship_to`**, shipping money + Shippo/tracking columns on **`orders`**; **`store_settings.shippo_config`**; **`store_shipping_rate_quote`** (short-lived quotes for checkout binding) |
| **75** | **`75_unified_shipments_hub.sql`** | **`shipment`**, **`shipment_event`** (append-only log); enums **`shipment_source`** (`pos_order`, `web_order`, `manual_hub`), **`shipment_status`**; RBAC **`shipments.view`**, **`shipments.manage`**; backfill from existing **ship** orders |
| **23** | **`023_shippo_returns_manifests_pickups.sql`** | Adds shipment **direction** (`outbound` \| `return`), return-parent links, carrier-account persistence, Shippo manifest/pickup ids, and **`shipment_batch`** + **`shipment_batch_shipment`** for manifest/SCAN-form and pickup batches. |

These historical objects are now consolidated into the active schema-contract baseline. Apply the baseline with **`./scripts/apply-migrations-docker.sh`** and validate with **`./scripts/migration-status-docker.sh`** plus **`./scripts/validate_schema_contract.sh`**.

---

## Environment and settings

| Mechanism | Notes |
|-----------|--------|
| **Settings -> Integrations -> Geoapify** | Encrypted Geoapify API key for protected staff address typeahead. Geoapify suggestions are limited to the store's local service area around Riverside ZIP **14043**, ranked toward exact street-address matches, and the key is never exposed to the browser. |
| **Settings -> Integrations -> Shippo** | Encrypted Shippo API token and webhook secret for live rates, labels, returns, manifests, pickup scheduling, and tracking updates. |
| **`store_settings.shippo_config`** | JSON: **`enabled`**, **`live_rates_enabled`**, **`from_address`** (name, company, address lines, phone/email, residential flag), **`default_parcel`** — loaded in **`server/src/logic/shippo.rs`** (`StoreShippoConfig`). |

| **`GET` / `PATCH /api/settings/shippo`** | **`settings.admin`** | Read/update **`shippo_config`**; response includes **`api_token_configured`** / **`webhook_secret_configured`** boolean flags. Secrets are never returned. |
| **`POST /api/settings/shippo/test-connection`** | **`settings.admin`** | Sends the configured origin address to Shippo address validation using the configured token. Use this after saving credentials or origin details. |

Live rates run only when the store enables them **and** the token is present (see effective config in code). When live rates are enabled, provider/API failures are visible failures; ROS does **not** silently fall back to demo rates. Demo rates are only for disabled-live or explicit `force_stub` testing.

Staff address entry uses Geoapify for typeahead and Shippo as the selected-address validation layer. Geoapify improves nearby matching and field fill; broad city/state/postcode-only suggestions are filtered out so operators see usable street-address candidates. Shippo remains the shipping truth before ROS commits a suggested address into staff workflows. If Shippo normalizes the ZIP after selection, ROS fills the Shippo ZIP and shows staff the correction.

---

## APIs (high level)

| Prefix / route | Permission / gate | Role |
|----------------|-------------------|------|
| **`POST /api/store/shipping/rates`** | Public storefront | Web cart: quote shipping; body `to_address`, optional `parcel`, optional `parcels`, optional `customs_declaration_object_id`, optional `force_stub` (default **false** = use live Shippo when Settings require live rates; live-provider failures do **not** silently fall back to demo rates). **`/shop/cart`** collects the address, calls this endpoint, and lets the shopper pick a **`rate_quote_id`** (shown in the order estimate; payment binding is a later phase). |
| **`POST /api/pos/shipping/rates`** | Staff **or** open POS register session | Register: quote before/during checkout. Accepts the same richer address fields as the store path, plus optional single-package or multi-package parcel payloads for custom tooling. |
| **`GET /api/shipments`**, **`POST /api/shipments`** | **`shipments.view`** / **`shipments.manage`** | List (optional **`customer_id`**, open-only filters); create **manual** shipment. |
| **`GET /api/shipments/{id}`** | **`shipments.view`** | Detail + **`events`** timeline. |
| **`PATCH /api/shipments/{id}`** | **`shipments.manage`** | Status, tracking, notes (writes **`shipment_event`**). |
| **`POST /api/shipments/{id}/rates`** | **`shipments.manage`** | Shippo rates for that registry row (`force_stub` query optional; body supports optional `parcel`, `parcels`, and `customs_declaration_object_id`; demo rates only when explicitly requested or live rates are not enabled). |
| **`POST /api/shipments/{id}/apply-quote`** | **`shipments.manage`** | Consumes a **`store_shipping_rate_quote`** row by id. |
| **`POST /api/shipments/{id}/purchase-label`** | **`shipments.manage`** | Buys a Shippo label from the applied live rate, then persists tracking, label URL, Shippo transaction id, and event history. |
| **`POST /api/shipments/{id}/refund-label`** | **`shipments.manage`** | Requests a Shippo refund for an unused purchased label and records a **`label_refund_requested`** event. ROS does not assume carrier approval until Shippo accepts it. |
| **`POST /api/shipments/{id}/return-shipment`** | **`shipments.manage`** | Creates or opens a dedicated **return** shipment linked to the purchased outbound label. Staff then fetch return rates, apply a live quote, and buy the return label without overwriting outbound label truth. |
| **`GET /api/shipments/batch-candidates`** | **`shipments.manage`** | Lists purchased labels with Shippo carrier accounts that can be grouped for a carrier handoff. |
| **`GET /api/shipments/batches`** | **`shipments.view`** | Lists recent manifest and pickup batches with confirmation/document links. |
| **`POST /api/shipments/batches/manifest`** | **`shipments.manage`** | Creates a Shippo manifest/SCAN-form batch for selected labels that share the same carrier account. |
| **`POST /api/shipments/batches/pickup`** | **`shipments.manage`** | Schedules a Shippo pickup for selected labels that share the same carrier account and a staff-entered pickup window/location. |
| **`POST /api/shipments/{id}/notes`** | **`shipments.manage`** | Staff note → event. |
| **`POST /api/webhooks/shippo`** / **`POST /api/integrations/shippo/webhook`** | Unauthenticated, verified by `SHIPPO_WEBHOOK_SECRET` | Inbound Shippo tracking updates. Matches by Shippo transaction id first, then tracking number; updates shipment status to **in transit**, **delivered**, or **exception** and records the raw webhook payload in `shipment_event`. |

Implementation: **`server/src/api/shipments.rs`**, **`server/src/logic/shipment.rs`**, **`server/src/api/pos.rs`**, **`server/src/api/store.rs`**.

**Checkout:** POS checkout with **Ship current sale** consumes a valid shipping quote, stores **`transactions.fulfillment_method = ship`**, keeps the quoted address/fee snapshot, and creates or aligns a **`shipment`** row via **`insert_from_pos_order_tx`** (**`server/src/logic/transaction_checkout.rs`**). This is allowed for ordinary current-sale merchandise; shipping does **not** require turning the line into a Special/Custom/Wedding fulfillment order. **Web** paid orders that ship should get the same treatment in the web checkout path when that flow is wired (backfill **75** already tags historical rows by **`sale_channel`**).

---

## RBAC (migration **75**)

| Key | Default (seeded) | Typical use |
|-----|------------------|-------------|
| **`shipments.view`** | admin, sales_support, salesperson | List/read hub, timeline, customer hub tab. |
| **`shipments.manage`** | admin, sales_support only | Manual create, patch, rates, apply quote, staff notes. |

Sidebar **Shipping** maps tab permission **`shipping`** → **`shipments.view`** in **`BackofficeAuthPermissions`**.

---

## UI

- **Shipping** (Back Office) — full-store list, filters, manual shipment modal, detail panel (rates, apply quote, buy/refund labels with selectable label styles, create return-label workflow, status/tracking), **carrier handoff** panel for manifests/pickups, and **event timeline** (`ShipmentsHubSection.tsx`).
- **POS Sidebar → Shipping** (Register) — mirrored access to the hub for floor staff and sales support.
- **Relationship Hub → Shipments** (Joint) — same component with **`customerIdFilter`** for the open customer, available in both BO and POS.
- **Relationship Hub → Interaction timeline** — append-only **`shipment_event`** rows for this customer appear as **`shipping`** entries (requires **`customers.timeline`**), with **`reference_type`** **`shipment`**. Staff with **`shipments.view`** can **click the summary** to jump to the **Shipments** tab with that shipment opened (detail + list).

Roadmap UI (orders workspace label buy, fulfillment gates) remains in **`PLAN_SHIPPO_SHIPPING.md`**.

---

## Shippo capability policy

Implemented because it fits Riverside's current single-store workflow:

- Live domestic rates and label purchase using the store origin.
- Label purchase styles for `PDF_4X6`, `PDF`, `PNG`, and `ZPLII` so staff can choose 4x6, letter, image, or thermal-printer output before buying the label.
- Settings-side Shippo connection/origin validation.
- Rich address payloads (company, address line 2, phone, email, residential flag).
- Multi-piece parcel payload support through the API for staff/admin tooling. The current register UI still uses the default parcel profile for normal counter work.
- International/customs guardrail: non-US live quotes require a pre-created Shippo customs declaration id. ROS does not generate customs item/declaration records yet.
- Inbound tracking webhooks with secret verification.
- Unused-label refund requests with event history.
- Staff-created return-label workflows with separate return shipment rows so outbound label data is never overwritten.
- Pickup scheduling and manifest/SCAN-form batches for purchased labels that share the same Shippo carrier account.

Not implemented yet because it needs additional ROS workflow design or schema:

- Customer self-service return portal. Staff can create return labels inside the hub; customers do not yet initiate returns themselves.
- Shippo platform/managed accounts. Riverside is the merchant shipper, not a marketplace or third-party logistics platform.

---

## Related docs

- **[`docs/PLAN_SHIPPO_SHIPPING.md`](PLAN_SHIPPO_SHIPPING.md)** — full product/technical roadmap (labels, webhooks, late-bound shipping).
- **[`docs/ONLINE_STORE.md`](ONLINE_STORE.md)** — public **`/shop`**, **`/api/store`**, guest cart + CMS (pairs with **store** rates below).
- **[`docs/PLAN_ONLINE_STORE_MODULE.md`](PLAN_ONLINE_STORE_MODULE.md)** — storefront roadmap (Helcim checkout, reporting, assets).
- **[`docs/CUSTOMER_HUB_AND_RBAC.md`](CUSTOMER_HUB_AND_RBAC.md)** — hub tabs and CRM permissions.
- **[`docs/STAFF_PERMISSIONS.md`](STAFF_PERMISSIONS.md)** — effective permissions and overrides.

**Last reviewed:** 2026-05-15
