# Transactions: refunds, line returns, exchanges, and post-sale adjustments

Operational reference for **Back Office** and **register** flows after migrations **`36_orders_rbac_permissions.sql`** and **`37_order_returns_and_exchange.sql`**. Optional idempotent replays use **`transactions.checkout_client_id`** from **`38_register_pos_token_and_checkout_idempotency.sql`**. Implementation lives in `server/src/api/transactions.rs`, `server/src/logic/transaction_recalc.rs`, `server/src/logic/transaction_returns.rs`, `server/src/logic/suit_component_swap.rs`, `server/src/logic/gift_card_ops.rs`, and `client/src/components/orders/OrdersWorkspace.tsx`.

For **staff keys and middleware**, see **`docs/STAFF_PERMISSIONS.md`**. For **special-transaction stock** (checkout vs PO vs pickup), see **`INVENTORY_GUIDE.md`** and **`AGENTS.md`**.

---

## Permission keys

| Key | Use |
|-----|-----|
| `orders.view` | List transactions, read detail, audit trail, receipt ZPL (with BO headers). |
| `orders.modify` | Add/edit/delete lines, pickup, `POST .../returns`, `POST .../exchange-link`. |
| `orders.suit_component_swap` | `POST /api/transactions/{id}/items/{line}/suit-swap` — requires **`orders.modify`** as well; BO staff only (no register_session bypass). Seeded in **`migrations/50_suit_component_swap_register_open_drawer.sql`**. |
| `orders.cancel` | `PATCH` transaction to `cancelled` when **payment allocations** exist (queues refund). |
| `orders.void_sale` | `PATCH` to `cancelled` when the transaction has **no** payment allocations (void mistaken / unpaid cart). Either **`orders.cancel`** or **`orders.void_sale`** suffices when there are no allocations. Seeded in **`migrations/49_orders_void_sale_permission.sql`**. |
| `orders.refund_process` | `GET /api/transactions/refunds/due`, `POST /api/transactions/{id}/refunds/process`. |
| `orders.edit_attribution` | `PATCH .../attribution` (unchanged). |

**Role defaults** are seeded in **`migrations/36_orders_rbac_permissions.sql`** (admin: all; salesperson: view + refund_process; sales_support: all four) and **`orders.void_sale`** in **`migrations/49_orders_void_sale_permission.sql`** (all three roles). Adjust via Staff → Role matrix or overrides.

**Checkout** (`POST /api/transactions/checkout`) requires a **POS register session** whose headers match **`session_id`** in the body (not the `orders.*` keys). Operator and line-level staff fields are validated in the payload.

---

## Register session bypass (read / limited write)

When the client cannot send Back Office staff headers (e.g. receipt modal on the till), some routes accept **`register_session_id`** so a **single open register session** that already has a **positive** `payment_allocation` to the transaction can authorize read or modify:

| Operation | Query / body | Requirement |
|-----------|----------------|-------------|
| List transactions | `GET /api/transactions?register_session_id=…` | Session `lifecycle_status = open`. |
| Transaction detail | `GET /api/transactions/{id}?register_session_id=…` | Same + positive allocation from that session. |
| Audit | `GET /api/transactions/{id}/audit?register_session_id=…` | Same. |
| Receipt ZPL | `GET /api/transactions/{id}/receipt.zpl?register_session_id=…&mode=…` | Same. |
| Pickup | `POST /api/transactions/{id}/pickup` body `{ "register_session_id": "…", … }` | Same. |
| Line returns | `POST /api/transactions/{id}/returns` query `?register_session_id=…` | Same. |
| Exchange link | `POST /api/transactions/{id}/exchange-link?register_session_id=…` | Same positive-allocation rule for **both** transactions being linked. |

**Refund processing** requires **Back Office** staff headers and **`orders.refund_process`** (no register-only bypass). **Exchange link** may use the same register session query/body pattern as returns when linking two transactions tied to that session.

---

## Money refunds (refund queue)

1. **Queue sources**
   - **`PATCH`** transaction to **`cancelled`** when `SUM(payment_allocations)` for the transaction is positive: upserts **`transaction_refund_queue`** (one open row per transaction; amounts merge on conflict).
   - **Line returns** (`POST .../returns`): increases **`amount_due`** on the open queue row (or inserts one).

2. **Process cash-out**
   - **`POST /api/transactions/{transaction_id}/refunds/process`**  
     Body: `session_id` (open register session), `payment_method`, `amount`, optional `gift_card_code` when refunding to a gift card.
   - Requires **`orders.refund_process`** and an **open** register session matching `session_id`.
   - Records negative **`payment_transactions`** + **`payment_allocations`**, updates queue and **`transactions.amount_paid`**, runs **`transaction_recalc`** (totals respect returned qty).
   - **Loyalty:** full accrual clawback when **`amount_paid`** reaches zero after the refund (same transaction).
   - **Gift card:** if `payment_method` indicates a gift-card tender, **`gift_card_code`** is required; balance is credited in the same transaction.
   - **Stripe:** if the method looks like a card tender and a **`stripe_intent_id`** exists on an original positive allocation, the server attempts a **Stripe Refund** before committing; failures roll back the DB transaction.

3. **UI**
   - **Transactions** workspace: refunds-due strip, **Process refund** modal (open register **`session_id`** from **`GET /api/sessions/current`** with **`mergedPosStaffHeaders(backofficeHeaders)`** so the call is authorized when the till is closed but Back Office is signed in). If there is **no** open till (**404**), the UI offers **Go to POS** ( **`RegisterGateContext`** ) so staff can enter POS and open or attach to a lane; with **multiple** open lanes, **`GET /current`** may return **409** — pick a session per **`docs/STAFF_PERMISSIONS.md`** / **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**. `backofficeHeaders` on all transaction fetches.

4. **Admin notification**
   - When the open queue is non-empty, **admin** staff receive a **once-per-store-local-day** summary (`morning_refund_queue`) in the bell inbox — **`docs/PLAN_NOTIFICATION_CENTER.md`**.

---

## Line-level returns

- **`POST /api/transactions/{id}/returns`**  
  Body: `{ "lines": [ { "transaction_item_id", "quantity", "reason?", "restock?" } ] }`  
  Requires **`orders.modify`** (or register session path above).

- **Rules**
  - Cannot return more than **sold qty minus prior returns** per line.
  - Not allowed on **cancelled** transactions.
  - **Restock:** default **true** when line is **takeaway** and **fulfilled**; otherwise no `stock_on_hand` bump (special/wedding semantics per **`INVENTORY_GUIDE.md`**). Explicit **`restock`** overrides default.
  - **`transaction_return_lines`** is append-only audit.
  - **Totals:** `server/src/logic/transaction_recalc.rs` recomputes **`total_price`**, **`balance_due`**, and **status** using effective qty per line.
  - **Refund queue:** refundable line total (incl. line tax) is added to **`transaction_refund_queue.amount_due`**.
  - **Loyalty:** proportional clawback on eligible product subtotal (excludes service / `excludes_from_loyalty`).
  - **Commission:** proportional reduction of **`transaction_items.calculated_commission`** for **fulfilled** lines when returns are recorded.

---

## Exchanges (reporting link)

- **`POST /api/transactions/{id}/exchange-link`**  
  Body: `{ "other_transaction_id": "<uuid>" }`  
  Sets the same **`transactions.exchange_group_id`** on both transactions (new UUID). With **`?register_session_id=…`**, uses the same session authorization as line returns (both transactions must be modifiable on that session). Without it, requires **`orders.modify`** (Back Office).

- **Recommended operational pattern:** return lines on the original transaction (and process refund queue as needed), then **new checkout** for the replacement merchandise; link the two transactions with **exchange-link** for reporting.

- **POS Exchange Wizard** (register): [`PosExchangeWizard`](client/src/components/pos/PosExchangeWizard.tsx) — load original transaction (same register session), record line returns, then continue to the cart for replacement checkout. After checkout, `POST /api/transactions/{original}/exchange-link?register_session_id=…` runs automatically when both legs are on the session. Back Office still supports manual link and refunds.

---

## QBO and accounting notes

- Negative retail **`payment_transactions`** should appear in journal staging; verify mappings after go-live (`server/src/logic/qbo_journal.rs` includes a reminder comment).
- **Return-day restock + suit swaps:** staging **`propose`** warns if **`INV_ASSET`** is unmapped when restock COGS applies; swap cost deltas use **`INV_ASSET`** / **`COGS_DEFAULT`** fallbacks. See **`docs/QBO_JOURNAL_TEST_MATRIX.md`**.
- **Wedding group pay / disbursements:** see **`docs/WEDDING_GROUP_PAY_AND_RETURNS.md`** — return on the **member transaction** that owns the line; refunds follow **`payment_allocations`** on the target transaction.

---

## Related migrations

| File | Purpose |
|------|---------|
| `21_orders_audit_and_refund_queue.sql` | `transaction_activity_log`, `transaction_refund_queue` |
| `24_performance_and_integrity.sql` | Partial unique index: one **open** queue row per `transaction_id` |
| `36_orders_rbac_permissions.sql` | Seeds for `orders.*` keys on `staff_role_permission` |
| `37_order_returns_and_exchange.sql` | `transaction_return_lines`, `transactions.exchange_group_id` |

---

## Client files (quick map)

| Area | Location |
|------|----------|
| Transactions BO workspace | `client/src/components/orders/OrdersWorkspace.tsx` |
| Permission catalog labels | `client/src/lib/staffPermissions.ts` |
| Transactions tab gate | `client/src/context/BackofficeAuthContext.tsx` → `SIDEBAR_TAB_PERMISSION.transactions` |
| Receipt after checkout (session-scoped read) | `client/src/components/pos/ReceiptSummaryModal.tsx` |
| Session-scoped sales list | `client/src/components/pos/RegisterReports.tsx` |
