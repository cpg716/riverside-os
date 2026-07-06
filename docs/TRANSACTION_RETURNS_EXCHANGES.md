# Transactions: refunds, line returns, exchanges, and post-sale adjustments

Operational reference for **Back Office** and **register** flows after the schema-contract baseline and RBAC seed are applied. Optional idempotent replays use **`transactions.checkout_client_id`**. Implementation lives in `server/src/api/transactions.rs`, `server/src/logic/transaction_recalc.rs`, `server/src/logic/transaction_returns.rs`, `server/src/logic/suit_component_swap.rs`, `server/src/logic/gift_card_ops.rs`, `client/src/components/pos/PosExchangeWizard.tsx`, `client/src/components/pos/Cart.tsx`, and `client/src/components/orders/OrdersWorkspace.tsx`.

For **staff keys and middleware**, see **`docs/STAFF_PERMISSIONS.md`**. For **special-transaction stock** (checkout vs PO vs pickup), see **`INVENTORY_GUIDE.md`** and **`AGENTS.md`**.

---

## Permission keys

| Key | Use |
|-----|-----|
| `orders.view` | List transactions, read detail, audit trail, receipt ZPL (with BO headers). |
| `orders.modify` | Edit transaction lines, pickup, returns, exchanges. |
| `manager.approval` | Approve elevated Manager Access prompts with staff id + Access PIN; approvals are audited with approver, timestamp, reason, transaction/customer metadata when supplied. |
| `orders.suit_component_swap` | `POST /api/transactions/{id}/items/{line}/suit-swap` — requires **`orders.modify`** as well; BO staff only (no register_session bypass). Seeded by **`scripts/seeds/seed_rbac.sql`**. |
| `orders.cancel` | `PATCH` transaction to `cancelled` when **payment allocations** exist (queues refund). |
| `orders.void_sale` | `PATCH` to `cancelled` when the transaction has **no** payment allocations (void mistaken / unpaid cart). Either **`orders.cancel`** or **`orders.void_sale`** suffices when there are no allocations. Seeded by **`scripts/seeds/seed_rbac.sql`**. |
| `orders.refund_process` | `GET /api/transactions/refunds/due`, `POST /api/transactions/{id}/refunds/process`. |
| `orders.edit_attribution` | `PATCH .../attribution` (unchanged). |

**Role defaults** are seeded in **`scripts/seeds/seed_rbac.sql`**. Adjust via Staff → Role matrix or overrides.

**Checkout** (`POST /api/transactions/checkout`) requires a **POS register session** whose headers match **`session_id`** in the body (not the `orders.*` keys). Operator and line-level staff fields are validated in the payload.

---

## Register session bypass (read / limited write)

When the client cannot send Back Office staff headers (e.g. receipt modal on the till), some routes accept **`register_session_id`** so a **single open register session** can authorize read or modify.

**Policy note:** Returns and exchanges are allowed from an open register session or by Back Office staff with `orders.modify`. Staff still need to verify the original Transaction Record, returned quantities, tender/refund path, and inventory handling before settlement.

| Operation | Query / body | Requirement |
|-----------|----------------|-------------|
| List transactions | `GET /api/transactions?register_session_id=…` | Session `lifecycle_status = open`. |
| Transaction detail | `GET /api/transactions/{id}?register_session_id=…` | Same + positive allocation from that session. |
| Audit | `GET /api/transactions/{id}/audit?register_session_id=…` | Same. |
| Receipt ESC/POS / HTML | `GET /api/transactions/{id}/receipt.escpos?register_session_id=…` or `GET /api/transactions/{id}/receipt.html?register_session_id=…` | Same. |
| Pickup | `POST /api/transactions/{id}/pickup` body `{ "register_session_id": "…", … }` | Same. |
| Line returns | `POST /api/transactions/{id}/returns` query `?register_session_id=…` | Same. |
| Exchange link | `POST /api/transactions/{id}/exchange-link?register_session_id=…` | Same positive-allocation rule for **both** transactions being linked. |

**Refund processing** requires **Back Office** staff headers and **`orders.refund_process`** (no register-only bypass). **Exchange link** may use the same register session query/body pattern as returns when linking two transactions tied to that session.

**Receipts:** Customer receipts never hide returned or exchanged selected lines. Active quantities print in their normal sale/pickup/shipping sections. Returned or exchanged quantities print in separate **RETURNED / REFUNDED** or **EXCHANGED** sections with a negative credit row that includes applicable item tax. These adjustment rows preserve the original sale proof and do not re-add to receipt merchandise totals.

---

## Money refunds (refund queue)

1. **Queue sources**
   - **`PATCH`** transaction to **`cancelled`** when `SUM(payment_allocations)` for the transaction is positive: upserts **`transaction_refund_queue`** (one open row per transaction; amounts merge on conflict).
   - **Line returns** (`POST .../returns`): increases **`amount_due`** on the open queue row (or inserts one).

2. **Process cash-out**
   - **`POST /api/transactions/{transaction_id}/refunds/process`**  
     Body: `session_id` (open register session), `payment_method`, `amount`, optional `gift_card_code` when refunding to a gift card.
   - Requires **`orders.refund_process`** and an **open** register session matching `session_id`.
   - Records any staged return lines supplied by the register, negative **`payment_transactions`** + **`payment_allocations`**, updates queue and **`transactions.amount_paid`**, then runs **`transaction_recalc`** (totals respect returned qty). These writes happen in one database transaction; if the refund fails, the original Transaction Record remains unchanged.
   - **Loyalty:** full accrual clawback when **`amount_paid`** reaches zero after the refund (same transaction).
   - **Gift card:** if `payment_method` indicates a gift-card tender, **`gift_card_code`** is required; balance is credited in the same transaction.
   - **Helcim:** if the method looks like a card tender and an original positive Helcim allocation has a provider transaction id, the server creates a deterministic provider attempt and attempts a **Helcim Refund**. ROS commits the negative payment and refund queue update only when Helcim returns approved/captured. Provider request errors, rate limits, or declines persist the failed provider attempt for audit and leave ROS refund state unchanged.
   - **Cash rounding:** pennyless cash rounding is currently **OFF**, so cash refunds pay the exact-cent return credit. When enabled later, cash refunds obey the same pennyless-cash rule as cash sales: the exact return credit remains the source of truth, the drawer payout may round to the nearest `$0.05`, and checkout records the adjustment on the returned transaction. Rounding must never create a separate Transaction Record, pickup, deposit, or orphaned payment activity.

3. **UI**
   - **Transactions** workspace: refunds-due strip, **Process refund** modal (open register **`session_id`** from **`GET /api/sessions/current`** with **`mergedPosStaffHeaders(backofficeHeaders)`** so the call is authorized when the till is closed but Back Office is signed in). If there is **no** open till (**404**), the UI offers **Go to POS** ( **`RegisterGateContext`** ) so staff can enter POS and open or attach to a lane; with **multiple** open lanes, **`GET /current`** may return **409** — pick a session per **`docs/STAFF_PERMISSIONS.md`** / **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`**. `backofficeHeaders` on all transaction fetches.

4. **Admin visibility**
   - Open refund queue items stay visible in the **Transactions** workspace. Riverside OS does **not** create a daily bell alert for refunds because refunds are expected to be handled in-person as part of the customer transaction workflow.

## POS transaction voids

- **`POST /api/transactions/{id}/void`**
  Body: `{ "register_session_id", "manager_staff_id", "manager_pin", "reason" }`
  Requires an open register session, **`orders.refund_process`**, and Manager Access from a staff approver with **`manager.approval`**.

- **Rules**
  - A void is never a delete. The original Transaction Record, payment rows, receipt references, timestamps, and audit feed remain visible.
  - The transaction is moved to the existing cancelled reporting state for booked/revenue exclusion, while `transaction_void_records` stores the first-class void record, original totals, approving manager, register session, tender summary, refund queue link, and inventory impact.
  - Remaining active lines are recorded through `transaction_return_lines` with reason `void`. Fulfilled takeaway lines restock; special/custom/wedding/layaway order-style lines do not silently restock.
  - Loyalty accrual is reversed during the void.
  - Refund/reversal remains capped by paid credit. If a paid balance remains, the void opens or updates `transaction_refund_queue`; if the transaction was already fully refunded, the void record is marked `no_refund_due`.
  - Actual money movement still uses the existing refund processor so cash, card/Helcim, split tender, gift card, and store credit reversals write negative payment evidence and reconciliation-safe ledger rows.

- **POS UI**
  - Register → Daily Sales → Activity exposes **Void** beside the receipt action.
  - The modal explains customer/payment history retention, refund queue impact, inventory handling, and accounting handoff before requiring Manager Access.
  - Manager Access is selected staff identity + Access PIN, not a legacy cashier-code shortcut.
  - Completion tells staff whether a refund workflow was opened or no paid balance remained.
  - Back Office Transaction Record shows the void record, reversal status, original total, refundable amount, Manager Access approver, reason, and restock impact for review.

---

## Line-level returns

- **`POST /api/transactions/{id}/returns`**  
  Body: `{ "lines": [ { "transaction_line_id", "quantity", "reason?", "restock?" } ] }`  
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

- **Exchange/Return Wizard** (register): [`PosExchangeWizard`](client/src/components/pos/PosExchangeWizard.tsx) — A high-fidelity, "WowDash" themed workspace for processing post-sale adjustments at the till. 
   - **Wide Workspace**: Uses a `3xl` width modal to provide a zero-scroll triage environment.
   - **Guided Phases**: Implements step-by-step navigation (Selection, Returns, Cart replacement).
   - **Customer-scoped selection**: When a customer is already loaded, the first phase lists that customer's Transaction Records instead of running a global customer-name search.
   - **Line handoff**: Transaction Record item rows can launch Register with the original transaction and selected transaction line preloaded for return/exchange quantity confirmation.
   - **Active Instructions**: Context-aware instruction cards guide staff through complex return semantics.
   - **Automated Linking**: After replacement checkout, `POST /api/transactions/{original}/exchange-settlement` links the legs for reporting.
   - **Staged returns**: Selecting return quantities in the wizard does not mutate the original Transaction Record. The selected line ids, quantities, reason, and restock choice are carried into the final refund or exchange settlement request.
   - **Settlement**: return credits, deposits, replacement lines, and any remaining customer balance or refund must flow through checkout so the cart, payment allocations, customer history, QBO staging, and audit trail agree. Return lines are recorded only after the refund/exchange settlement succeeds; interrupted or failed flows must leave the original items visible and unreturned. If the original Transaction Record still has a balance due and the returned item creates no paid refund credit, settlement is still valid when it records return lines and links the replacement sale.

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
| `034_transaction_void_records.sql` | Append-only POS void records and reversal-state tracking |
| `118_repair_joe_webb_failed_exchange_return.sql` | One-time repair for the stale TXN-621978 Mantoni shirt return marker created by the failed exchange flow |

---

## Client files (quick map)

| Area | Location |
|------|----------|
| Transactions BO workspace | `client/src/components/orders/OrdersWorkspace.tsx` |
| Permission catalog labels | `client/src/lib/staffPermissions.ts` |
| Transactions tab gate | `client/src/context/BackofficeAuthContext.tsx` → `SIDEBAR_TAB_PERMISSION.transactions` |
| Receipt after checkout (session-scoped read) | `client/src/components/pos/ReceiptSummaryModal.tsx` |
| Session-scoped sales list | `client/src/components/pos/RegisterReports.tsx` |
