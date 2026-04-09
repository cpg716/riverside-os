# Orders: refunds, line returns, exchanges, and post-sale adjustments

Operational reference for **Back Office** and **register** flows after migrations **`36_orders_rbac_permissions.sql`** and **`37_order_returns_and_exchange.sql`**. Optional idempotent replays use **`orders.checkout_client_id`** from **`38_register_pos_token_and_checkout_idempotency.sql`**. Implementation lives in `server/src/api/orders.rs`, `server/src/logic/order_recalc.rs`, `server/src/logic/order_returns.rs`, `server/src/logic/suit_component_swap.rs`, `server/src/logic/gift_card_ops.rs`, and `client/src/components/orders/OrdersWorkspace.tsx`.

For **staff keys and middleware**, see **`docs/STAFF_PERMISSIONS.md`**. For **special-order stock** (checkout vs PO vs pickup), see **`INVENTORY_GUIDE.md`** and **`AGENTS.md`**.

---

## Permission keys

| Key | Use |
|-----|-----|
| `orders.view` | List orders, read detail, audit trail, receipt ZPL (with BO headers). |
| `orders.modify` | Add/edit/delete lines, pickup, `POST .../returns`, `POST .../exchange-link`. |
| `orders.suit_component_swap` | `POST /api/orders/{id}/items/{line}/suit-swap` — requires **`orders.modify`** as well; BO staff only (no register_session bypass). Seeded in **`migrations/50_suit_component_swap_register_open_drawer.sql`**. |
| `orders.cancel` | `PATCH` order to `cancelled` when **payment allocations** exist (queues refund). |
| `orders.void_sale` | `PATCH` to `cancelled` when the order has **no** payment allocations (void mistaken / unpaid cart). Either **`orders.cancel`** or **`orders.void_sale`** suffices when there are no allocations. Seeded in **`migrations/49_orders_void_sale_permission.sql`**. |
| `orders.refund_process` | `GET /api/orders/refunds/due`, `POST /api/orders/{id}/refunds/process`. |
| `orders.edit_attribution` | `PATCH .../attribution` (unchanged). |

**Role defaults** are seeded in **`migrations/36_orders_rbac_permissions.sql`** (admin: all; salesperson: view + refund_process; sales_support: all four) and **`orders.void_sale`** in **`migrations/49_orders_void_sale_permission.sql`** (all three roles). Adjust via Staff → Role matrix or overrides.

**Checkout** (`POST /api/orders/checkout`) requires a **POS register session** whose headers match **`session_id`** in the body (not the `orders.*` keys). Operator and line-level staff fields are validated in the payload.

---

## Register session bypass (read / limited write)

When the client cannot send Back Office staff headers (e.g. receipt modal on the till), some routes accept **`register_session_id`** so a **single open register session** that already has a **positive** `payment_allocation` to the order can authorize read or modify:

| Operation | Query / body | Requirement |
|-----------|----------------|-------------|
| List orders | `GET /api/orders?register_session_id=…` | Session `lifecycle_status = open`. |
| Order detail | `GET /api/orders/{id}?register_session_id=…` | Same + positive allocation from that session. |
| Audit | `GET /api/orders/{id}/audit?register_session_id=…` | Same. |
| Receipt ZPL | `GET /api/orders/{id}/receipt.zpl?register_session_id=…&mode=…` | Same. |
| Pickup | `POST /api/orders/{id}/pickup` body `{ "register_session_id": "…", … }` | Same. |
| Line returns | `POST /api/orders/{id}/returns` query `?register_session_id=…` | Same. |
| Exchange link | `POST /api/orders/{id}/exchange-link?register_session_id=…` | Same positive-allocation rule for **both** orders being linked. |

**Refund processing** requires **Back Office** staff headers and **`orders.refund_process`** (no register-only bypass). **Exchange link** may use the same register session query/body pattern as returns when linking two orders tied to that session.

---

## Money refunds (refund queue)

1. **Queue sources**
   - **`PATCH`** order to **`cancelled`** when `SUM(payment_allocations)` for the order is positive: upserts **`order_refund_queue`** (one open row per order; amounts merge on conflict).
   - **Line returns** (`POST .../returns`): increases **`amount_due`** on the open queue row (or inserts one).

2. **Process cash-out**
   - **`POST /api/orders/{order_id}/refunds/process`**  
     Body: `session_id` (open register session), `payment_method`, `amount`, optional `gift_card_code` when refunding to a gift card.
   - Requires **`orders.refund_process`** and an **open** register session matching `session_id`.
   - Records negative **`payment_transactions`** + **`payment_allocations`**, updates queue and **`orders.amount_paid`**, runs **`order_recalc`** (totals respect returned qty).
   - **Loyalty:** full accrual clawback when **`amount_paid`** reaches zero after the refund (same transaction).
   - **Gift card:** if `payment_method` indicates a gift-card tender, **`gift_card_code`** is required; balance is credited in the same transaction.
   - **Stripe:** if the method looks like a card tender and a **`stripe_intent_id`** exists on an original positive allocation, the server attempts a **Stripe Refund** before committing; failures roll back the DB transaction.

3. **UI**
   - **Orders** workspace: refunds-due strip, **Process refund** modal (open register **`session_id`** from **`GET /api/sessions/current`** with **`mergedPosStaffHeaders(backofficeHeaders)`** so the call is authorized when the till is closed but Back Office is signed in). If there is **no** open till (**404**), the UI offers **Go to POS** ( **`RegisterGateContext`** ) so staff can enter POS and open or attach to a lane; with **multiple** open lanes, **`GET /current`** may return **409** — pick a session per **`docs/STAFF_PERMISSIONS.md`** / **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**. `backofficeHeaders` on all order fetches.

4. **Admin notification**
   - When the open queue is non-empty, **admin** staff receive a **once-per-store-local-day** summary (`morning_refund_queue`) in the bell inbox — **`docs/PLAN_NOTIFICATION_CENTER.md`**.

---

## Line-level returns

- **`POST /api/orders/{id}/returns`**  
  Body: `{ "lines": [ { "order_item_id", "quantity", "reason?", "restock?" } ] }`  
  Requires **`orders.modify`** (or register session path above).

- **Rules**
  - Cannot return more than **sold qty minus prior returns** per line.
  - Not allowed on **cancelled** orders.
  - **Restock:** default **true** when line is **takeaway** and **fulfilled**; otherwise no `stock_on_hand` bump (special/wedding semantics per **`INVENTORY_GUIDE.md`**). Explicit **`restock`** overrides default.
  - **`order_return_lines`** is append-only audit.
  - **Totals:** `server/src/logic/order_recalc.rs` recomputes **`total_price`**, **`balance_due`**, and **status** using effective qty per line.
  - **Refund queue:** refundable line total (incl. line tax) is added to **`order_refund_queue.amount_due`**.
  - **Loyalty:** proportional clawback on eligible product subtotal (excludes service / `excludes_from_loyalty`).
  - **Commission:** proportional reduction of **`order_items.calculated_commission`** for **fulfilled** lines when returns are recorded.

---

## Exchanges (reporting link)

- **`POST /api/orders/{id}/exchange-link`**  
  Body: `{ "other_order_id": "<uuid>" }`  
  Sets the same **`orders.exchange_group_id`** on both orders (new UUID). With **`?register_session_id=…`**, uses the same session authorization as line returns (both orders must be modifiable on that session). Without it, requires **`orders.modify`** (Back Office).

- **Recommended operational pattern:** return lines on the original order (and process refund queue as needed), then **new checkout** for the replacement merchandise; link the two orders with **exchange-link** for reporting.

- **POS Exchange Wizard** (register): [`PosExchangeWizard`](client/src/components/pos/PosExchangeWizard.tsx) — load original order (same register session), record line returns, then continue to the cart for replacement checkout. After checkout, `POST /api/orders/{original}/exchange-link?register_session_id=…` runs automatically when both legs are on the session. Back Office still supports manual link and refunds.

---

## QBO and accounting notes

- Negative retail **`payment_transactions`** should appear in journal staging; verify mappings after go-live (`server/src/logic/qbo_journal.rs` includes a reminder comment).
- **Return-day restock + suit swaps:** staging **`propose`** warns if **`INV_ASSET`** is unmapped when restock COGS applies; swap cost deltas use **`INV_ASSET`** / **`COGS_DEFAULT`** fallbacks. See **`docs/QBO_JOURNAL_TEST_MATRIX.md`**.
- **Wedding group pay / disbursements:** see **`docs/WEDDING_GROUP_PAY_AND_RETURNS.md`** — return on the **member order** that owns the line; refunds follow **`payment_allocations`** on the target order.

---

## Related migrations

| File | Purpose |
|------|---------|
| `21_orders_audit_and_refund_queue.sql` | `order_activity_log`, `order_refund_queue` |
| `24_performance_and_integrity.sql` | Partial unique index: one **open** queue row per `order_id` |
| `36_orders_rbac_permissions.sql` | Seeds for `orders.*` keys on `staff_role_permission` |
| `37_order_returns_and_exchange.sql` | `order_return_lines`, `orders.exchange_group_id` |

---

## Client files (quick map)

| Area | Location |
|------|----------|
| Orders BO workspace | `client/src/components/orders/OrdersWorkspace.tsx` |
| Permission catalog labels | `client/src/lib/staffPermissions.ts` |
| Orders tab gate | `client/src/context/BackofficeAuthContext.tsx` → `SIDEBAR_TAB_PERMISSION.orders` |
| Receipt after checkout (session-scoped read) | `client/src/components/pos/ReceiptSummaryModal.tsx` |
| Session-scoped sales list | `client/src/components/pos/RegisterReports.tsx` |
