# POS parked sales, unified RMS Charge financing, and R2S payment collections

This document is the engineering and product-behavior reference for parked sales and RMS Charge internals.

For role-based operational use, start with:

- Back Office RMS manuals:
  [`/Users/cpg/riverside-os/docs/staff/rms-charge-overview.md`](./staff/rms-charge-overview.md)
- POS RMS quick guide:
  [`/Users/cpg/riverside-os/docs/staff/pos-rms-charge.md`](./staff/pos-rms-charge.md)
Server-backed **parked cart** snapshots (auditable), a durable **`pos_rms_charge_record`** ledger (**charges** from the unified **RMS Charge** financing tender and **payments** from the internal **RMS CHARGE PAYMENT** line), **Sales Support** follow-up (notifications and/or **Staff → Tasks** ad-hoc instances), and QBO pass-through mapping. Schema: **migrations [`68_pos_parked_and_rms_charge_audit.sql`](../migrations/legacy_prelaunch_history/68_pos_parked_and_rms_charge_audit.sql)**, **[`69_rms_charge_payment_line.sql`](../migrations/legacy_prelaunch_history/69_rms_charge_payment_line.sql)**, and legacy migration **153** for linked accounts, transaction financing metadata, and program/account fields.

## Parked sales

### Local draft cart vs parked (client)

**Parked** rows are **server-backed** (`pos_parked_sale`) — intentional hold/recall with audit — see below.

Separately, **`Cart.tsx`** may keep an **automatic local draft** of the open sale in **`localforage`** under **`ros_pos_active_sale`** (**`sessionId`**, lines, customer, wedding link, split-deposit disbursements, shipping, primary salesperson, **`checkoutOperator`**). The draft is written when there are cart lines, order payments, alteration intakes, or wedding split-deposit disbursements. If the cashier verified sign-in but **never added work**, nothing is saved; **remount / refresh** returns to the **Cashier for this sale** overlay. When there is at least one active work item, cashiers can leave the **Register** workspace (other POS tabs, Back Office, remount) without losing the transaction **until** they clear the cart, complete checkout, or open a different register session on that instance. Persistence runs only **after** hydration from disk finishes so an empty initial render cannot overwrite a saved draft.

### Payment ledger (checkout UI)

**`client/src/components/pos/NexoCheckoutDrawer.tsx`** — Tender grid and balance summary can scroll on very short viewports; the **amount field, numeric keypad, and primary actions** stay in a **fixed strip** (no keypad scroll). **Apply payment** (primary tender) and **Apply deposit** (ledger release for special / wedding lines) are stacked; **Split deposit (wedding party)** opens **`WeddingLookupDrawer`** in group-pay mode so staff can enter the deposit amount for each selected member. Existing open balances default to that balance; members with no open balance can still receive an entered deposit amount that follows the wedding disbursement/open-deposit flow.

**Checkout payload (`POST /api/transactions/checkout`, `server/src/logic/order_checkout.rs`):**

- **`total_price`** must match **cart lines + shipping only** (±$0.02). **`wedding_disbursements`** amounts are **not** included in **`total_price`**; they are paid from the same collected **`amount_paid`** pool. **`amount_toward_order` = `amount_paid` − sum(`wedding_disbursements`)**; **`balance_due` = `total_price` − `amount_toward_order`**. Party disbursements cannot exceed **`amount_paid`**.
- **Takeaway** (lines + tax): **cash-equivalent tenders** (everything except **`deposit_ledger`** and **`open_deposit`**) must cover the full takeaway total, and **`amount_toward_order`** must fully cover takeaway before any balance remains on special/wedding lines. Deposits are for order liability, not for walking out unpaid takeaway.
- **Deposit-only completion:** when any line is special/wedding, **Complete Sale** can finalize with **ledger deposit** (and no tenders, or with tenders that already cover takeaway in a mixed cart). **`deposit_ledger`** is the synthetic tender when there are no applied tenders but deposit > 0. **`takeawayDueCents`** in **`NexoCheckoutDrawer`** enforces the mixed-cart rule.
- **Customer open deposits** (migration **`83_customer_open_deposit.sql`**): credits when a **wedding disbursement** has **no open beneficiary order** are posted to **`customer_open_deposit_*`** (per-customer balance + ledger). At checkout, tender **`open_deposit`** redeems that balance (requires **`customer_id`**). **`GET /api/customers/{id}/open-deposit`** — **`customers.hub_view`**. POS may prompt to apply an open deposit when the payment drawer opens. Relationship Hub shows **Deposit waiting** when balance > 0. **QBO:** `open_deposit` redemption does not yet mirror the full **`applied_deposit_amount`** journal path; treat as operational liability until mapped.

### Data model

- **`pos_parked_sale`** — one row per parked snapshot; **`status`** ∈ `parked` | `recalled` | `deleted`. Scoped to **`register_session_id`**. **List** (GET) joins **`register_sessions`** so closed sessions return no rows; **park** (POST) still requires an open session. **Recall** and **delete** update by **`id`** + **`register_session_id`** + **`status = parked`** (they do **not** require the session row to be “open” in the join — avoids failed deletes when session metadata drifts).
- **`pos_parked_sale_audit`** — append-style rows (`park`, `recall`, `delete`) with **`register_session_id`** retained even if the parked row is removed (**`parked_sale_id`** may become NULL on parent delete).

### API (POS session gate)

Merged under **`/api/sessions`** (same router nest as register session routes). All routes require **`middleware::require_pos_register_session_for_checkout`**: headers **`x-riverside-pos-session-id`** and **`x-riverside-pos-session-token`** must match the **`session_id`** in the path (same rule as **`POST /api/transactions/checkout`**).

| Method | Path | Body / query | Notes |
|--------|------|--------------|--------|
| GET | `/api/sessions/{session_id}/parked-sales` | Optional **`?customer_id=`** | Lists **`status = parked`** for this session; joins **`register_sessions`** so closed sessions return nothing. |
| POST | `/api/sessions/{session_id}/parked-sales` | `{ parked_by_staff_id, label, customer_id?, payload_json }` | **`payload_json`** mirrors cart snapshot (lines, customer, wedding member, disbursements). |
| POST | `/api/sessions/{session_id}/parked-sales/{park_id}/recall` | `{ actor_staff_id }` | Sets **`recalled`** + audit. |
| POST | `/api/sessions/{session_id}/parked-sales/{park_id}/delete` | `{ actor_staff_id }` | Sets **`deleted`** + audit (POST so JSON body is reliable from `fetch`). |

### Audit and access log

- **`pos_parked_sale_audit`** on every park / recall / delete.
- **`log_staff_access`**: **`pos_parked_sale_park`**, **`pos_parked_sale_recall`**, **`pos_parked_sale_delete`**, **`pos_parked_sale_purge_on_close`** (Z-close purge).

### Z-close behavior

When **`close_session`** completes (lane **1**, till group), still-**parked** rows for **all** session IDs in that **`till_close_group_id`** are marked **`deleted`** via **`logic::pos_parked_sales::purge_open_parked_for_sessions`**. If **`opened_by`** is known, **`pos_parked_sale_purge_on_close`** is logged.

### Client

- **`client/src/lib/posParkedSales.ts`** — `fetch` helpers; responses use **`cache: "no-store"`** so list/delete/recall are not served from the HTTP cache after mutations.
- **`client/src/components/pos/Cart.tsx`** — Park / Parked list / customer prompt (**Continue**, **Open parked list**, **Skip for now**, **Delete parked and start new**). Parked mutations **await** a fresh POS session token (**`ensurePosTokenForSession`**) when needed so **`x-riverside-pos-session-token`** matches the server after hydration.

**Actor staff:** Park / recall / delete need a **`parked_by_staff_id`** / **`actor_staff_id`**. The cart resolves **`checkoutOperator.staffId`** from the register **Cashier for this sale** verification (**`POST /api/staff/verify-cashier-code`**) before ringing; if unset (should be rare for park), it falls back to **`GET /api/staff/effective-permissions`** (**Back Office** code + PIN on the device). POS token alone is not enough to infer operator for audit.

### Server modules

- **`server/src/logic/pos_parked_sales.rs`**
- **`server/src/api/pos_parked_sales.rs`** — **`session_subrouter()`** merged in **`server/src/api/mod.rs`**

---

## RMS / R2S: charges vs payments (outside AR)

R2S is an **external** program; ROS does **not** maintain in-store AR for these balances. The ledger is for **audit**, **Sales Support** workflow, **Insights**, **Customers → RMS charge** reporting, and **QBO** pass-through.

| Flow | `record_kind` | Register behavior | Sales Support follow-up |
|------|---------------|-------------------|-------------------------|
| **Charge** | **`charge`** | Sale completed with tender **`on_account_rms`** and RMS program metadata (**Standard**, **RMS 90**, etc.). Historical **`on_account_rms90`** rows remain readable. | Inbox notification **`rms_r2s_charge`** — **Submit R2S charge** |
| **Payment** | **`payment`** | Cart contains **only** the internal line **RMS CHARGE PAYMENT** (search **`PAYMENT`**); tenders **cash** and/or **check** only; **customer required** | Ad-hoc **task** per active **sales_support** — **Post payment to R2S** (checklist item with customer + amount + order ref) |

### Data model (`pos_rms_charge_record`)

- One row per recorded event; **`record_kind`** ∈ **`charge`** | **`payment`** (migration **69**; existing rows backfilled **`charge`**).
- **`charge`**: **`payment_method`** is the financing tender movement. New Phase 1 checkouts normalize under **`on_account_rms`** and store program/account detail in **`transactions.metadata`**, **`payment_transactions.metadata`**, and **`pos_rms_charge_record`** (`tender_family`, `program_code`, `program_label`, `masked_account`, linked RMS account ids, `resolution_status`).
- **`payment`**: **`payment_method`** is the **collection** tender (**`cash`**, **`check`**). Linked **`order_id`** is the **payment-collection** order (single internal line **`ROS-RMS-CHARGE-PAYMENT`**, **`products.pos_line_kind = rms_charge_payment`**).
- Common columns: **`register_session_id`**, optional **`customer_id`**, **`payment_transaction_id`** (unique when set), **`customer_display`**, **`order_short_ref`**, **`amount`**, **`operator_staff_id`**.

### Checkout and server modules

- **`server/src/logic/order_checkout.rs`** — validates RMS payment carts (no mixed lines, no wedding disbursements, no discount events on the payment line, **cash/check** splits only, **skip stock** for the internal SKU, **`payment_transactions`** category **`rms_account_payment`** for that order shape). Inserts **`pos_rms_charge_record`** inside the checkout transaction for both charge and payment splits as applicable.
- **`server/src/logic/checkout_validate.rs`** — zero tax, qty **1**, positive **`unit_price`** for **`rms_charge_payment`** lines.
- **`server/src/logic/pos_rms_charge.rs`** — metadata normalization, **`insert_rms_record`**, receipt wording helpers, and **`notify_sales_support_after_checkout`** for **charge** notifications after commit.
- **`server/src/logic/pos_rms_charge.rs`** — RMS Charge metadata normalization, record insertion, receipt wording helpers, and Sales Support follow-up.
- **`server/src/logic/tasks.rs`** — **`create_adhoc_rms_payment_followup_tasks`** after successful **payment** checkout (**`task_instance.assignment_id`** nullable — migration **69**).
- **`server/src/services/inventory.rs`** — resolves **`pos_line_kind`** for tax/line behavior at checkout.

### Notifications (charges only)

- **`kind`**: **`rms_r2s_charge`**
- **`title`**: **Submit R2S charge**
- **`dedupe_key`**: `rms_r2s:{order_id}:{payment_transaction_id}`
- **`source`**: **`pos_checkout`**
- **`deep_link`**: JSON includes **`order_id`**, **`register_session_id`**, **`customer_id`**, **`payment_transaction_id`**, **`payment_method`**, **`amount`**

**Access log:** **`rms_charge_notified`** on the checkout operator after charge fan-out.

### POS client (payment collection)

- **`client/src/components/pos/NexoCheckoutDrawer.tsx`** — one financing button: **RMS Charge**. After selection, POS requires an active customer, calls **`GET /api/pos/rms-charge/resolve-account`**, displays masked account choices/summary, loads **`GET /api/pos/rms-charge/programs`**, and persists selected program/account metadata in checkout state.
- **`client/src/components/pos/Cart.tsx`** — includes a dedicated **Payment** button in the register toolbar to quickly load the RMS Charge Payment line; product search keyword **`PAYMENT`** (case-insensitive) also injects the seeded line via **`GET /api/pos/rms-payment-line-meta`**; **Price** numpad sets amount (**`price_override_reason`**: **`rms_charge_payment`**); **no tax** on the line.
- Customer-facing receipts for this transaction shape suppress the internal **RMS CHARGE PAYMENT** merchandise line and print the payment summary / totals only.
- **`client/src/components/pos/NexoCheckoutDrawer.tsx`** — prop **`rmsPaymentCollectionMode`**: only **Cash** and **Check** tender tabs; **`check`** uses payment method **`check`** (map in QBO **Settings → QBO Bridge → Mappings** matrix). Deposit / split-deposit controls are suppressed where inappropriate for RMS payment collection.
- POS resolves accounts from Riverside's linked RMS account table first, then the latest imported **`rms_account_list_snapshots`** when the snapshot is uniquely matched to the customer. Weekly account-list import performs unique normalized-phone matching; ambiguous phones remain unmatched for manual review.
- Current POS completion records the selected account/program/reference and creates R2S follow-up. There is no external financing-host posting step in the Riverside checkout path.
- Payment collection resolves the linked or imported account in the drawer before cash/check tenders are added, so payment follow-up remains customer/account-driven rather than name-driven.

### Customers (Back Office) — RMS charge

- **Sidebar:** **Customers** → **RMS charge** (subsection id **`rms-charge`**).
- **Permissions:** Back Office uses **`customers.rms_charge.view`** / **`customers.rms_charge.manage_links`** (legacy **`customers.rms_charge`** still works). POS financing uses **`pos.rms_charge.use`**, optional **`pos.rms_charge.lookup`**, optional **`pos.rms_charge.history_basic`**, and optional **`pos.rms_charge.payment_collect`** for payment collection tools.
- **API:** **`GET /api/customers/rms-charge/records`** — query **`from`**, **`to`**, optional **`kind`** (`charge` \| `payment`), **`customer_id`**, search **`q`**, **`limit`** / **`offset`**.
- **Linked account APIs:** **`POST /api/customers/rms-charge/link-account`**, **`POST /api/customers/rms-charge/unlink-account`**, **`GET /api/customers/rms-charge/customer/{customer_id}/accounts`**.
- **Live detail APIs:** **`GET /api/customers/rms-charge/accounts/{account_id}/balances`**, **`GET /api/customers/rms-charge/accounts/{account_id}/transactions`**, **`GET /api/customers/rms-charge/records/{record_id}`**.
- **UI:** **`client/src/components/customers/RmsChargeAdminSection.tsx`**.
- Phase 3 completes the workspace with overview, accounts, transactions, programs, exceptions, reconciliation, sync health, and retry/resolve actions.

### POS / register metadata

- **`GET /api/pos/rms-payment-line-meta`** — **`server/src/api/pos.rs`**, nested under **`/api/pos`**; **staff or open register session**. Returns **`product_id`**, **`variant_id`**, **`sku`**, **`name`** for the internal line (avoids hard-coded UUIDs in the client).

### QBO (accounting)

- **Ledger mapping** key **`RMS_R2S_PAYMENT_CLEARING`** — credit-side pass-through for **payment** line totals (day journal excludes those lines from category revenue/COGS/tax and posts the clearing credit — **`server/src/logic/qbo_journal.rs`**). Configure the QBO account in **Settings → QBO Bridge** ledger/expense-style mapping UI (**`client/src/components/settings/QBOMapping.tsx`**).
- **Ledger mapping** key **`RMS_CHARGE_FINANCING_CLEARING`** — explicit clearing mapping for live RMS Charge financed purchase tenders and their refund/reversal counterparts.
- **Tender** row **`check`** in the granular mapping matrix (**`client/src/components/qbo/QboMappingMatrix.tsx`**, **`QBO_MATRIX_TENDERS`**) so **check** payments journal like other tenders.
- RMS payment reversals debit the same **`RMS_R2S_PAYMENT_CLEARING`** account so refund-day journals stay balanced with the cash/check outflow.
- Phase 3 reconciliation surfaces those clearing expectations inside the RMS Charge workspace so finance staff can triage Riverside/R2S/QBO mismatches without leaving the RMS toolset.

### Reporting (Insights / Metabase)

- **`GET /api/insights/rms-charges`** — query params **`from`**, **`to`**. Requires **`insights.view`**. Returns rows from **`pos_rms_charge_record`** including **`record_kind`** (migration **69** + API shape). Up to **500** rows with order/customer context.
- **UI:** Back Office **Insights** is **Metabase** (same-origin **`/metabase/`**). Use a Metabase question or dashboard wired to the charge ledger (or a store template), or consume this **JSON** endpoint from integrations. For **filtered** charge vs payment lists and customer filters, use **Customers → RMS charge**.

---

## Helcim terminal simulation

Helcim terminal payments use **`POST /api/payments/providers/helcim/purchase`** and remain pending until provider approval. In local/e2e development, the built-in Helcim simulator can approve, decline, or cancel pending attempts when:

- **`HELCIM_SIMULATOR_ENABLED=true`**, and
- **`RIVERSIDE_STRICT_PRODUCTION`** is not enabled.

See **`client/src/components/pos/NexoCheckoutDrawer.tsx`**.

---

## Related documentation

- **`docs/TILL_GROUP_AND_REGISTER_OPEN.md`** — Z-close and till group (purge uses same **`group_ids`**).
- **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`** — inbox patterns.
- **`docs/AI_REPORTING_DATA_CATALOG.md`** — **`/api/insights/rms-charges`** for NL reporting.
- **`docs/staff/pos-register-cart.md`** — cashier-facing parked + tender notes.
- **`docs/staff/insights-back-office.md`** — Back Office Insights (Metabase) + RMS context.
