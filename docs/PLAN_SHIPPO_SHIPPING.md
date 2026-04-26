# Plan: Shipping via Shippo (Online Store + POS)

> **FUTURE ADDITION:** **Online Store** channel items below **rate estimates** on **`/shop`** — i.e. **Stripe checkout + `rate_quote_id` binding**, **guest-initiated label purchase**, and **web-specific post-payment automation** — stay **deferred** until **[`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)** Phase C checkout exists. Implement and test **POS**, **Back Office Orders**, and **Shipments hub** first.

**Status:** **Partially implemented roadmap/deep spec.** Foundation + unified registry are documented in **[`SHIPPING_AND_SHIPMENTS_HUB.md`](SHIPPING_AND_SHIPMENTS_HUB.md)** (migrations **74**–**75**, rate quotes, **`/api/shipments`**, POS/store rate endpoints). This document remains the **roadmap** for labels, webhooks, late-bound fulfillment gates, and deeper transaction/workspace UX. **Cross-cutting tracker** (Podium + notifications + reviews): **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)**.

Cross-cutting plan for **Shippo** ([Shippo API](https://goshippo.com/docs/)) integration in **two channels**:

1. **Online Store** (**FUTURE** for label + paid-checkout binding) — Customer sees **real-time or cached rates** at cart (**estimate only** until checkout ships); **label purchase** and **tracking** after payment remain **roadmap**.
2. **POS / Register** (**supported path**) — Staff attach **ship-to** orders with **quoted shipping** and **buy label** from register/orders/shipments.

**Related:** [`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md) (web cart, Stripe, ship-to tax). **Shipped reference:** [`SHIPPING_AND_SHIPMENTS_HUB.md`](./SHIPPING_AND_SHIPMENTS_HUB.md). **Money:** `rust_decimal::Decimal` in ROS; Shippo returns string decimals — parse carefully at boundaries.

---

## Goals

- **Single carrier abstraction** in ROS: Shippo normalizes USPS, UPS, FedEx, etc.
- **Rates** from **from_address** (store warehouse / retail location) + **to_address** + **parcel** (weight + dimensions).
- **Labels**: purchase through Shippo; persist **tracking URL**, **carrier**, **label PDF URL** (or Shippo object id for re-fetch).
- **Web + POS** share **`logic/shippo.rs`** (no duplicated HTTP).
- **Audit**: who bought the label, cost, linked `order_id`.
- **Late-bound shipping $**: Many in-store orders **do not** have a final shipping charge at sale time (unknown weight, ship-later, or “we’ll quote when it’s packed”). ROS must support **adding or finalizing the shipping charge later**, including at **fulfillment transitions** (e.g. when staff marks items **ready to ship** or completes **pickup / delivered** steps in Back Office or POS (**Register** cart) — see **`mark_transaction_pickup`** in [`server/src/api/transactions.rs`](../server/src/api/transactions.rs)).

## Non-goals (initial phase)

- Multi-origin warehouses with automatic routing (start **one** `SHIPPO_FROM_ADDRESS_*` default).
- International customs forms (add after domestic stable).
- Customer-facing returns portal (later: Shippo return label API).

---

## Shippo platform prerequisites

1. **Shippo account** + **API token** (test vs live).
2. **Carrier accounts**: Shippo-managed vs bring-your-own — follow Shippo dashboard setup.
3. Read current **rate limits** and **webhook** signing in [Shippo docs](https://goshippo.com/docs/).

**Secrets:** `SHIPPO_API_TOKEN` in env (never log). Optional `SHIPPO_WEBHOOK_SECRET` for tracking events.

---

## ROS architecture

| Component | Role |
|-----------|------|
| **`server/src/logic/shippo.rs`** | `get_rates(...)`, `create_shipment(...)`, `purchase_label(...)`, parse responses → `Decimal` |
| **`server/src/api/shippo.rs`** or nested under **`orders`** + **`store`** | Thin handlers; staff vs public auth split |
| **`orders` / `order_shipments` schema** | Persist addresses, selected rate id, shipment id, tracking, **shipping_charge** passed to totals |
| **Webhook route** | `POST /api/integrations/shippo/webhook` — verify signature; update tracking state |

### Data model (migrations — illustrative)

**Option A — columns on `orders`**

- `fulfillment_method`: `pickup` | `ship` (enum or text).
- `ship_to` **JSONB** (structured address).
- `shipping_amount_usd` **DECIMAL** (customer-charged line; may differ from label cost).
- `shippo_shipment_object_id`, `shippo_transaction_object_id` (or single transaction id).
- `tracking_number`, `tracking_url_provider`, `shipping_label_url` (optional; prefer Shippo-hosted URL).

**Option B — `order_shipments` table** (better if multi-package later)

- `order_id`, `direction` `outbound`, `to_address` jsonb, `parcel` jsonb, `selected_rate_id`, `label_purchased_at`, `shippo_*` ids, `amount_charged`, `label_cost`.

**POS fee modeling**

- Include **`shipping_amount_usd`** in **`orders.total_price`** / payment allocation the same way discounts are applied — **do not** use float intermediates.
- If today’s checkout only sums **product lines**, extend **`CheckoutRequest`** (or equivalent) with **`shipping_lines: [{ description, amount_usd }]`** validated server-side against **re-selected Shippo rate token** (see below).

### Anti-tamper: web checkout

- Client must not invent shipping prices. Flow:
  1. `POST /api/store/shipping/rates` with **cart id** + **ship-to** → server builds parcel(s) from variant **weights** (require **weight on variant or product** — migration if missing).
  2. Response includes **opaque `rate_quote_id`** (server-stored, short TTL) bound to **amount + carrier + service level**.
  3. `POST /api/store/checkout` includes **`rate_quote_id`**; server verifies and locks shipping into order totals before Stripe session.

### POS flow

1. Cashier attaches customer + items; taps **“Ship order”**.
2. Enter/edit **ship-to** (or pull from **`customers`** address fields).
3. **`POST /api/transactions/{id}/shipping/rates`** or pre-checkout **`POST /api/pos/shipping/rates`** with **line items** → Shippo rates.
4. Cashier picks rate → server stores quote on **draft order** or passes into **`POST /checkout`** payload.
5. **Optional** post-payment: **`POST /api/transactions/{id}/shipping/buy-label`** — `orders.modify` + open register session rules as applicable.

### Late-bound shipping (charge not known at order start)

Retail reality: staff often sell the order **before** they know **package weight**, **carrier choice**, or whether the customer will switch from **pickup** to **ship**. The plan must allow:

| Scenario | Behavior |
|----------|----------|
| **Checkout without shipping $** | Order may complete with **`fulfillment_method = ship`** (or equivalent) and **`shipping_amount_usd = 0`** / unset, plus **ship_to** captured or deferred until packing. |
| **Add charge when “ready”** | When moving lines toward **fulfillment** — e.g. marking **ready for delivery**, **packed**, or using the existing **pickup / mark fulfilled** flow — if the order is **ship** and shipping is still unset or zero, **prompt staff** (Back Office **Orders** + POS **Register**) to **Get Shippo rates → add shipping line** before or as part of that step. |
| **Order already paid** | Adding shipping increases **balance due**; require **`orders.modify`** (and Register rules) to **collect additional tender** or record **account charge**, then **`recalc_transaction_totals`** — same discipline as other post-sale adjustments. |
| **Open / partial pay** | Apply quoted shipping before final payment; **`rate_quote_id`** or server-side re-quote at fulfillment time. |

**UI principle:** Any surface that changes fulfillment state (“ready”, “pickup complete”, “ship this”) for a **ship** order should **gate** or **wizard-link** to **Add shipping** if `shipping_amount_usd` is missing or policy requires a label before dispatch.

**Implementation note:** Wire explicitly to [`mark_transaction_pickup`](../server/src/api/transactions.rs) callers (and parallel BO actions) so staff cannot mark a **ship** order fully fulfilled without either a configured **$0 ship** override (admin) or a **non-zero shipping line** + optional label workflow — product rules TBD per store.

---

## Online Store integration

| Step | Behavior |
|------|----------|
| Cart | Collect **ship-to** (validates with Shippo **address validation** if enabled — optional API). |
| Rates | Show 3–5 options; display **delivery estimate** from Shippo. |
| Checkout | Stripe total = merchandise + tax + **selected shipping** (from verified quote). |
| After pay | Webhook creates order → **auto-purchase label** OR task queue **“pending label”** for Back Office batch print. |
| Email | Include **tracking link** from Shippo/ carrier. |

Tie-in with **§6 destination tax** in [`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md): **ship-to** used for both **tax** and **rates**.

---

## POS integration

| Surface | Behavior |
|---------|----------|
| **[`Cart.tsx`](../client/src/components/pos/Cart.tsx)** or checkout drawer | **“Shipping”** action: modal for address + rate picker + preview of added **$** line (when known at sale time). |
| **Order detail** ([`OrdersWorkspace.tsx`](../client/src/components/orders/OrdersWorkspace.tsx)) | For `fulfillment_method = ship`: **Add / edit shipping** anytime before dispatch (rates + line); tracking, **Reprint label**, **Buy label** if not yet purchased. |
| **Fulfillment / pickup flows** | When staff mark items **ready** or **pickup / delivered** ([`mark_transaction_pickup`](../server/src/api/transactions.rs)): if order ships and shipping not finalized, **offer or require** the Shippo quote → charge step (see **Late-bound shipping** above). |
| **Permissions** | **`orders.modify`** for adding shipping to open order; **`orders.*`** + optional **`shipping.purchase_label`** if you want to restrict label spend. |

### Stock

- Shipping does not change **inventory** rules; **pickup** vs **ship** may affect **when** `stock_on_hand` decrements (already tied to fulfillment type — align with `AGENTS.md` **special_order** / takeaway behavior).

---

## Implementation phases

### Phase 0 — Foundation

- Migration: **`fulfillment_method`**, **`ship_to`**, shipping money columns or **`order_shipments`**.
- `logic/shippo.rs`: client + `get_rates` with hardcoded **from** address from Settings.
- **Settings → Shipping**: from address, default parcel template, enable test mode.

### Phase 1 — POS rates + charge

- API + POS UI: quote → add **shipping line** to checkout; persist on order.
- Receipt shows shipping line.
- **Late path:** same **rates → line** from **Orders** workspace and at **fulfillment / pickup** transitions when shipping was **unknown at checkout**; optional validation hook before **`mark_transaction_pickup`** completes for **ship** orders.

### Phase 2 — Web store

- Store **rate_quote** cache table; integrate with Stripe Checkout totals.
- Webhook completes order + label purchase path.

### Phase 3 — Labels + tracking

- Purchase label API; store PDF link; **Shippo webhooks** → update `orders` tracking state.
- Back Office **batch print** queue (optional).

### Phase 4 — Polish

- Address validation; multi-parcel; **return** labels.

---

## Testing

- Shippo **test API token**; dummy addresses from Shippo docs.
- Mock `reqwest` in unit tests for rate response shapes.

## Documentation

- **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**: env vars, migrations, APIs, RBAC, UI (extend with runbook notes for reprint/void label when label purchase ships).
- **`DEVELOPER.md`**: new routes table.

## Risks

| Risk | Mitigation |
|------|------------|
| Rate quote stale | Short TTL (5–15 min); re-fetch on checkout retry |
| Double-charging shipping | One authoritative **shipping line** (or `order_shipments.amount_charged`); **replace** on re-quote; audit edits |
| Weight missing on SKUs | Block web ship until **weight** set on variant; default POS parcel template |
| Label buy fails after charge | Retry queue + staff alert; refund path documented |
| PII in logs | Redact `ship_to` in traces |

---

## References

- [Shippo API documentation](https://goshippo.com/docs/)
- [`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)
- [`server/src/logic/transaction_checkout.rs`](../server/src/logic/transaction_checkout.rs)
