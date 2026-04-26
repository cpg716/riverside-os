# Riverside OS — Backend Audit Report

**Scope:** `server/` and `migrations/`  
**Date:** 2026-04-04 (follow-up verification note: **2026-04-08** — staff **`POST /api/bug-reports`**, **`AppState.server_log_ring`**, migrations **102–103** triage/retention, **`PLAN_BUG_REPORTS.md`**)  
**Role framing:** Financial integrity, RBAC, transactional safety, inventory model, observability, handler thinness.

---

## 0. Remediation status (verified against current `server/src`)

The **route-level gaps** called out in §2 and Appendix B have been **addressed in code** as of follow-up verification:

- **Inventory:** `GET /scan-resolve` and `POST /batch-scan` use **`require_staff_perm_or_pos_session`** with **`catalog.view`** / **`catalog.edit`** (POS token or staff permission).
- **Products / categories / vendors / purchase-orders / settings / gift-cards (mutations):** handlers call **`require_staff_with_permission`** with **`catalog.*`**, **`procurement.*`**, **`settings.admin`**, **`gift_cards.manage`** as appropriate; **`list_control_board`** remains **staff or POS session**.
- **Payments / hardware:** **`require_staff_or_pos_register_session`** on **`POST /intent`** and **`POST /print`**; **`POST /intent`** also has a **global rolling-minute rate limit** (**`RIVERSIDE_PAYMENTS_INTENT_PER_MINUTE`**, default **120**).
- **Loyalty:** settings + monthly eligible → **`loyalty.program_settings`**; redeem + ledger → **staff or POS session**; adjust-points unchanged (PIN + permission).
- **Weddings:** **`weddings.view`** / **`weddings.mutate`** on read vs write handlers.
- **Sessions:** **`GET /current`** → staff or POS session; close / cash adjust / reconciliation / X-report → **`require_pos_session_secret_or_permission`** (path session + POS token, or BO **`register.reports`**).
- **Weather:** **`require_authenticated_staff_headers`** on forecast/history.

Extended permission keys and **`staff_role_permission`** seeds live in **`migrations/39_extended_rbac_catalog.sql`**; Rust constants in **`server/src/auth/permissions.rs`**.

Remaining **optional** hardening: Playwright / E2E refresh (**Appendix B.4**); per-IP payment limits if you expose the API beyond trusted networks.

---

## 1. Floating-point / money (Golden Rule)

### Findings

| Location | Types | Assessment |
|----------|--------|------------|
| `server/src/services/vendor_hub.rs` | `f64` for `avg_lead_time_days` | **OK** — operational lead time, not currency. |
| `server/src/logic/weather.rs` | `f32` for temperature / precipitation | **OK** — environmental simulation, not money. |
| `server/src/api/payments.rs` | `ToPrimitive::to_i64()` on `Decimal` | **OK** — converts USD `Decimal` to whole cents for Stripe `i64`; arithmetic stays in `Decimal` until conversion. |
| `server/src/api/transactions.rs` | `ToPrimitive::to_i64()` for refund cents | **OK** — same pattern as payments. |
| `server/src/logic/loyalty.rs` | `to_i64()` | **OK** — points / ledger integer paths, not currency floats. |
| `server/src/logic/importer.rs` | `ToPrimitive` import + `to_i32()` on rounded `Decimal` | **OK** — quantity-like integers from `Decimal`, not `f64` money math. |

### Verdict

No `f32`/`f64` usage was found for **currency** in `server/`. Financial fields in APIs and models consistently use `rust_decimal::Decimal`. PostgreSQL migrations reviewed for `real`/`double precision` money columns: none flagged in sampled migration text; monetary columns use `numeric` / `DECIMAL` (e.g. `opening_float` in `01_initial_schema.sql` is `DECIMAL`).

### Recommendations

- Keep `ToPrimitive` conversions **only** at boundaries (Stripe cents, integer points) and document that they are not intermediate float money math.
- **`logic/importer.rs`:** keep **`ToPrimitive`** for **`to_i32()`** on quantity-like fields.

---

## 2. RBAC / middleware (`server/src/middleware/mod.rs`)

### Implemented primitives

- `require_authenticated_staff_headers` — staff code + PIN rules via `authenticate_pos_staff`.
- `require_staff_with_permission` — Back Office permission catalog + `FORBIDDEN` when missing.
- `require_staff_or_pos_register_session` — staff **or** valid POS session headers.
- `require_pos_register_session_for_checkout` — checkout must match body `session_id`.

These are **not** applied globally in `main.rs`; each handler must call them explicitly. There is **no** blanket Axum middleware layer for auth.

### Routes with appropriate patterns (examples)

- **Orders:** `require_staff_with_permission` for BO mutations/views; `authorize_order_*_bo_or_register` for register-scoped reads/modify; `require_pos_register_session_for_checkout` on `POST /checkout`.
- **Customers:** `require_customer_access` → `require_staff_or_pos_register_session`.
- **Inventory:** `scan_sku`, `get_product_intelligence`, `list_control_board` use staff or POS session.
- **Insights / QBO / physical_inventory:** `require_staff_with_permission` (module-specific keys).
- **Register sessions:** `authenticate_pos_staff` on open / adjustments / close / token issue (POS model).
- **Loyalty `adjust_points`:** manager cashier + PIN + `LOYALTY_ADJUST_POINTS`.
- **Counterpoint sync:** `COUNTERPOINT_SYNC_TOKEN` validation on bridge routes (M2M).

### Critical gaps (historical — **remediated**)

The table below recorded the **pre-remediation** risk surface. **Current code** gates these surfaces as summarized in **§0** and **Appendix B.2** (✅ rows).

| Module | Original risk (now addressed) |
|--------|-------------------------------|
| **`api/inventory.rs`** — `batch-scan` / `scan-resolve` | Unauthenticated stock / resolution — now **`catalog.edit`** / **`catalog.view`** or POS session. |
| **`api/products.rs`**, **`categories`**, **`vendors`**, **`purchase_orders`** | Unauthenticated catalog / PO — now **`catalog.*`** / **`procurement.*`**. |
| **`api/settings.rs`** | Unauthenticated backups — now **`settings.admin`**. |
| **`api/gift_cards.rs`**, **`payments`**, **`hardware`**, **`loyalty`**, **`weddings`** | See **§0** / **B.2**. |

### Verdict

**Mutation and sensitive read routes** use **staff permissions** and/or **POS register session** (and **session secret** where required). **`POST /api/payments/intent`** adds **global rate limiting** (env-tunable).

### Recommendations

1. Keep **`docs/STAFF_PERMISSIONS.md`** in sync when adding permission keys.
2. Tune **`RIVERSIDE_PAYMENTS_INTENT_PER_MINUTE`** for your traffic; use **`0`** only in controlled dev environments.

---

## 3. Transaction safety

### Strong examples

- **`checkout`** (`transactions.rs`): Single `db.begin()` before order insert, line items, takeaway stock decrements, gift card `FOR UPDATE`, payment rows, allocations, wedding updates; `commit` after `recalc_transaction_totals`.
- **`mark_transaction_pickup`**: Transaction covers fulfillment flags, optional full-fulfill status, **special_order / wedding_order / custom** `stock_on_hand` + `reserved_stock` decrements, `recalc_transaction_totals`.
- **`process_refund`**, **`add_order_item`**, **`update_order_item`**, **`delete_order_item`**, **`patch_order`** (status branch), **`patch_order_attribution`**, **`post_order_exchange_link`**: use explicit transactions where multiple rows change.
- **`logic/physical_inventory::publish_session`**: `pool.begin()`, per-variant `stock_on_hand` update + `inventory_transactions` + audit + session status in one transaction.
- **`logic/order_returns::apply_order_returns`**: `pool.begin()` with `FOR UPDATE` on order and lines.

### Issues / edge cases

1. **`patch_order` (cancel)**  
   **Resolved:** **`order_refund_queue`** insert and **`refund_queued`** activity rows run **inside the same `tx`** as the status update, before **`commit`**. Non-cancel status changes still **`log_order_activity`** on the pool after commit (customer timeline only).

2. **Checkout idempotency** (`checkout_client_id`)  
   **Resolved:** duplicate **`SELECT`** runs **inside** the checkout transaction; **`orders_checkout_client_id_uidx`** conflicts trigger **rollback** and a **replay** read (see **Appendix B.3 T2**).

3. **`gift_cards` issue / load paths**  
   **Update:** issue / void paths that mutate multiple rows use **`db.begin()`** where required (see **`gift_cards.rs`**).

4. **`inventory` `batch_scan`**  
   **Gated** — see **§0** and **RBAC** above.

### Verdict

High-stakes flows **checkout**, **pickup**, **returns** (in logic layer), and **physical inventory publish** are **appropriately transactional**. Residual: **post-commit** work after cancel (§3.1) if you want hard **all-or-nothing** with external side effects.

---

## 4. Inventory integrity — `special_order` / `reserved_stock` / `available_stock`

### `available_stock` definition

- `server/src/services/inventory.rs`: `available_stock: (row.stock_on_hand - row.reserved_stock).max(0)` on `ResolvedSkuItem`.
- `server/src/api/inventory.rs` (`get_product_intelligence`): `available_stock: (soh - res).max(0)`.

**Consistent** with invariant `stock_on_hand - reserved_stock` (clamped).

### Checkout (`transactions.rs`)

- **Takeaway:** `stock_on_hand -= qty` with guard `stock_on_hand >= qty`.
- **Special / wedding (persisted):** **no** `stock_on_hand` decrement at checkout (comment: stock arrives via PO → `reserved_stock`).

### PO receipt (`purchase_orders.rs` + comments in codebase)

Receiving increases `stock_on_hand` and, for open special-order demand, bumps **`reserved_stock`** (see grep-backed logic around `reserved_stock = reserved_stock + $1` with fulfillment filters).

### Pickup (`mark_transaction_pickup`)

SQL updates `product_variants` for lines with fulfillment in `('special_order','custom','wedding_order')`:

- `stock_on_hand = GREATEST(stock_on_hand - qty, 0)`
- `reserved_stock = GREATEST(reserved_stock - qty, 0)`

Matches documented lifecycle: reserved units leave both on hand and reserved when the customer picks up.

### Verdict

**Model is coherent** with AGENTS.md: no checkout decrement for special-order lines; PO feeds reservation; pickup decrements both. Legacy `custom` is still handled in SQL filters for backward compatibility.

### Recommendations

- Continue rejecting new `custom` writes at API (`persist_fulfillment` already errors on `Custom`).
- Consider DB check constraint or monitoring if `reserved_stock > stock_on_hand` should never occur (business rule tightening).

---

## 5. Observability & `sqlx` error mapping

### `eprintln!`

**No matches** in `server/**/*.rs` — aligns with project rules (`tracing` only).

### Backup worker

- **`main.rs`** backup scheduler jobs use **`tracing::error!(error = %e, "...")`** for cleanup, cloud sync, and scheduled backup failures.

### `sqlx::Error` → HTTP

- **`OrderError::Database`**, **`InventoryError::Database`**, **`CustomerError::Database`** (partial): generally map to **500** with logging. `CustomerError` maps some unique violations to **409**.
- **`OrderError::IntoResponse`** maps **`SqlxError::RowNotFound`** → **404** (“Order not found”); other DB errors → 500 with logging.

### Verdict

**Good:** No `eprintln!`. **Improve:** More consistent **404** for missing rows and structured `tracing` in all `main.rs` workers.

**Update (2026-04-08):** The API may export **OpenTelemetry OTLP** traces (optional env) and wraps HTTP with **`tower-http`** **`TraceLayer`**; subscriber wiring and bug-report **`ServerLogRing`** are documented in **`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`**.

---

## 6. Clean architecture — logic in handlers

### Well-factored

- Checkout delegates line validation to `logic/checkout_validate`, commission to `logic/sales_commission`, loyalty to `logic/loyalty`, wedding activity to `logic/weddings`.
- Returns body is thin; core in `logic/order_returns`.
- Physical inventory publish in `logic/physical_inventory`.

### Still heavy / worth monitoring

- **`transactions.rs`** remains very large: ZPL receipt generation, list SQL building, and checkout orchestration live in the API module. Consider moving ZPL and complex list queries to `logic/` or `services/` over time.
- **`weddings.rs`** is a large monolith with SQL and orchestration inline — primary **maintainability** concern, not necessarily a correctness bug.

---

## 7. Migrations (spot-check)

- No widespread use of floating-point types for money in sampled files.
- Ledger / commission / QBO migrations reference financial **concepts** but use appropriate SQL types in initial schema patterns.

---

## Summary table

| Area | Status |
|------|--------|
| Floats for money | **Pass** (no currency `f32`/`f64`) |
| RBAC on mutations | **Pass** — staff permissions + POS session patterns per §0 (verify new routes on every PR) |
| Transactions (checkout / refunds / returns / physical publish) | **Pass** with minor post-commit / idempotency notes |
| Special order inventory lifecycle | **Pass** |
| `eprintln!` | **Pass** |
| sqlx → HTTP mapping | **Partial** — mostly 500; some modules better than others |
| Thin handlers | **Partial** — `orders` / `weddings` are dense |

---

## Appendix A — Breadth pass (full `server/src` + `migrations/` inventory)

**Method:** Enumerate every Rust source file under `server/src/` (60 files); run repo-wide greps for money floats, debug print, `unsafe`, TODO stubs, env secrets, and transactions; classify each `server/src/api/*.rs` module by presence of any auth hook (`middleware::*`, `authenticate_pos_staff`, `validate_sync_token`). **Not done:** line-by-line proof of each SQL statement, `cargo audit`, fuzzing, or load testing.

### A.1 Cross-cutting grep (`server/src` only)

| Pattern | Result |
|---------|--------|
| `f32` / `f64` | Only `logic/weather.rs`, `services/vendor_hub.rs` (non-currency). |
| `eprintln!` / `dbg!` / `println!` | **None** in application sources. |
| `unsafe` | **None**. |
| `todo!` / `unimplemented!` | **None**. |
| `pool.begin()` / `db.begin()` | See §3; files: `api/inventory`, `api/orders`, `api/products`, `api/loyalty`, `api/staff`, `api/purchase_orders`, `api/categories`, `logic/loyalty`, `logic/importer`, `logic/order_returns`, `logic/counterpoint_sync`, `logic/lightspeed_customers`, `logic/physical_inventory` (two paths). |
| `std::env::var` | `main.rs` (DB, Stripe, Counterpoint, CORS, dist, body limit, bind), `api/transactions.rs` (optional webhook URL), `logic/backups.rs` (S3 keys). |

### A.2 `server/src` file map (every file, one line each)

**Root / binary**

| File | Role |
|------|------|
| `main.rs` | TCP bind, pool, CORS, body limit, static SPA fallback, spawns QBO refresh + backup + weather workers. |
| `lib.rs` | Crate exports: `api`, `auth`, `logic`, `middleware`, `models`, `schema_bootstrap`, `services`. |

**`api/` (HTTP)** — see A.3 for auth.

| File | Role |
|------|------|
| `mod.rs` | `AppState`, `build_router()`, nests all route modules. |
| `inventory.rs` | Scan, scan-resolve, batch-scan, intelligence; **partial** auth. |
| `transactions.rs` | Checkout, list/detail, pickup, refunds, returns, ZPL, attribution. |
| `products.rs` | CRUD-ish catalog, control board, import, matrix, variants. |
| `insights.rs` | Sales pivot (`group_by` incl. customer), commission, register history, tax audit, etc. |
| `loyalty.rs` | Settings, eligible list, adjust, redeem, ledger. |
| `customers.rs` | Search, browse, profile, hub, timeline, order-history, Lightspeed import. |
| `sessions.rs` | Register open/close, X-report, reconciliation, cash adjustments. |
| `weather.rs` | Forecast/history (read-only API). |
| `qbo.rs` | OAuth-ish callback router, mappings, staging, sync. |
| `staff.rs` | POS list, PIN verify, admin roster, commissions, access log. |
| `vendors.rs` | Vendor CRUD + brands + hub JSON. |
| `gift_cards.rs` | List, by code, issue, void, events. |
| `physical_inventory.rs` | Sessions, counts, review, publish. |
| `settings.rs` | Receipt JSON, backups, DB stats/optimize. |
| `weddings.rs` | Parties, members, appointments, SSE feed, large SQL surface. |
| `purchase_orders.rs` | PO draft, lines, submit, receive, direct invoice. |
| `counterpoint_sync.rs` | Token-gated bridge ingest. |
| `hardware.rs` | Print proxy hook. |
| `payments.rs` | Stripe PaymentIntent create. |
| `categories.rs` | Category tree, CRUD, audit, tax resolution. |

**`middleware/`**

| File | Role |
|------|------|
| `mod.rs` | Staff headers, permission gate, staff **or** POS session, checkout session match. |

**`auth/`**

| File | Role |
|------|------|
| `mod.rs` | Re-exports. |
| `permissions.rs` | Permission keys, effective permissions, Admin wildcard. |
| `pins.rs` | PIN hash verify, cashier auth, access log helper. |
| `pos_session.rs` | Opaque POS session token issue/verify. |

**`logic/` (no direct HTTP)**

| File | Role |
|------|------|
| `mod.rs` | Module list. |
| `pricing.rs` | Employee sale unit pricing helpers. |
| `template_variant_pricing.rs` | Effective cost from template. |
| `tax.rs` | NYS / local tax helpers. |
| `inventory.rs` | Module-level **documentation** for PO freight vs ledger (no executable logic). |
| `importer.rs` | Catalog CSV import transaction. |
| `customers.rs` | Customer insert / profile helpers. |
| `lightspeed_customers.rs` | LS import batch in transaction. |
| `counterpoint_sync.rs` | CP customer/inventory batch in transaction. |
| `customer_hub.rs` | Hub stats, visit recency. |
| `customer_order_history.rs` | Paged orders for one customer (booked-date filters). |
| `wedding_party_display.rs` | SQL fragments / labels for parties. |
| `weddings.rs` | Compass queries, activity insert helpers. |
| `wedding_push.rs` | In-process event bus for SSE. |
| `procurement.rs` | PO-side domain helpers. |
| `commission_payout.rs` | Payout window finalize. |
| `sales_commission.rs` | Per-line commission calc. |
| `qbo_journal.rs` | Journal / staging domain. |
| `loyalty.rs` | Points rules, accrual/reversal in tx. |
| `backups.rs` | pg_dump / restore / S3 sync orchestration. |
| `physical_inventory.rs` | Scan resolve, session lifecycle, publish tx. |
| `weather.rs` | Synthetic weather snapshot. |
| `messaging.rs` | Ready-for-pickup triggers (log-based provider). |
| `transaction_recalc.rs` | Balance / totals recompute. |
| `order_returns.rs` | Return lines + restock + refund queue in tx. |
| `gift_card_ops.rs` | Shared gift-card domain (used from checkout/refunds). |
| `checkout_validate.rs` | Server-side checkout line reconciliation. |

**`services/`**

| File | Role |
|------|------|
| `mod.rs` | Re-exports. |
| `inventory.rs` | POS SKU resolve, tax + employee price on `Decimal`. |
| `vendor_hub.rs` | Aggregated vendor dashboard (includes `f64` lead time stat). |

**`models/`**

| File | Role |
|------|------|
| `mod.rs` | sqlx enums, DB-facing types. |
| `product.rs` | Template/variant pricing structs; effective retail/cost via `template_variant_pricing`. |

**Other**

| File | Role |
|------|------|
| `schema_bootstrap.rs` | Ensures RBAC tables from migration 34 at startup. |

### A.3 API modules: any auth hook present?

Grepped for `middleware::`, `require_staff`, `authenticate_pos_staff`, or `validate_sync_token` in each file:

| Has hook | Missing hook entirely |
|----------|------------------------|
| `inventory`, `orders`, `products`, `insights`, `loyalty`, `customers`, `sessions`, `qbo`, `staff`, `physical_inventory`, `counterpoint_sync` | `weather`, `vendors`, `gift_cards`, `settings`, `weddings`, `purchase_orders`, `hardware`, `payments`, `categories` |

**Interpretation:** “Has hook” does **not** mean every route is protected (e.g. `inventory` still exposes unauthenticated `batch_scan` and `scan_resolve`). Modules in the right column have **no** shared gate at all in source — consistent with the RBAC **Fail** in the summary table.

### A.4 `migrations/` breadth

**Count:** 40 `.sql` files (ledger `00` + `01`–`39` per current tree).

**Not individually audited in breadth:** each migration’s DDL/DML correctness. Prior spot-check: money uses `numeric` / `DECIMAL` patterns, not floats.

---

## Appendix B — Remediation backlog (actionable fixes)

This section turns earlier findings into a **implementation checklist**. **Status legend:** ✅ already gated in code today · ⚠️ partial / inconsistent · ❌ missing gate (treat as P0/P1 when API is network-exposed).

### B.1 Permission catalog gaps

Many unauthenticated routes below need **`require_staff_with_permission`**. The v1 catalog in `server/src/auth/permissions.rs` does **not** yet define keys for catalog, procurement, settings, gift cards, or weddings. Recommended approach:

1. Add new `pub const` keys and append them to **`ALL_PERMISSION_KEYS`**.
2. Add **`staff_role_permission`** seeds in a new migration (admin: all true; tune `salesperson` / `sales_support`).
3. Mirror labels in **`client/src/lib/staffPermissions.ts`** and gate **`BackofficeAuthContext`** / **`Sidebar`** as in `docs/STAFF_PERMISSIONS.md`.
4. Ensure each gated `fetch` uses **`backofficeHeaders()`**.

**Suggested new keys (names are indicative — align with product language):**

| Key | Use |
|-----|-----|
| `catalog.view` | Read-only catalog: product/vendor/category lists, hubs, timelines, PO summary reads, tax resolve, `GET /api/products/control-board` could stay **`require_staff_or_pos_register_session`** (register needs it without BO PIN). |
| `catalog.edit` | Product create/import/bulk/matrix/variant pricing & stock & shelf labels & clear overrides. |
| `procurement.view` | List/get purchase orders. |
| `procurement.mutate` | Create/submit/receive PO, direct invoice draft, lines. |
| `settings.admin` | Receipt config, backup CRUD/restore/download, backup settings, DB stats/optimize. |
| `gift_cards.manage` | All gift card list/lookup/issue/void/events. |
| `loyalty.program_settings` | `GET/PATCH /api/loyalty/settings`, `GET /api/loyalty/monthly-eligible` (PII). |
| `loyalty.redeem` | `POST /api/loyalty/redeem-reward` (financial) **or** gate with POS session only (see B.2). |
| `weddings.view` | Read wedding routes (compass, feed, lists, GET party/member, ledger, financial context, SSE). |
| `weddings.mutate` | Create/update/delete parties, members, appointments, restore. |
| `register.reports` | Optional BO key for sensitive register **read** reports if not using session token (see B.2). |

**Alternative:** fold `catalog.*` + `vendors.*` into a single `inventory.catalog_edit` if you want fewer keys (document the merge in `STAFF_PERMISSIONS.md`).

---

### B.2 Route-by-route RBAC / auth (exhaustive for `build_router` nests)

**Note:** The **Status** column is **kept in sync with the repo** as of the last audit pass (RBAC + hygiene). **`RIVERSIDE_PAYMENTS_INTENT_PER_MINUTE`** (default **120**, **`0`** = unlimited) gates **`POST /api/payments/intent`** volume per rolling minute.

Base URL prefix omitted; all paths are under **`/api/...`** as registered in `server/src/api/mod.rs`.

#### `/api/inventory`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/scan/{sku}` | ✅ | `require_staff_or_pos_register_session` — keep. |
| GET | `/scan-resolve` | ✅ | **`require_staff_perm_or_pos_session`** + **`catalog.view`**. |
| GET | `/control-board` | ✅ | Delegates to products `list_control_board`. |
| POST | `/batch-scan` | ✅ | **`require_staff_perm_or_pos_session`** + **`catalog.edit`** (or POS session). |
| GET | `/intelligence/{variant_id}` | ✅ | Staff or POS session; cost hidden from POS without `inventory.view_cost`. |

#### `/api/inventory/physical` (`physical_inventory.rs`)

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| * | `/sessions`, `/sessions/active`, `/sessions/{id}`, counts, review, publish, … | ✅ | Uses `PHYSICAL_INVENTORY_VIEW` / `PHYSICAL_INVENTORY_MUTATE` — verify every handler path (spot-check when implementing). |

#### `/api/transactions`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/` | ✅ | BO `orders.view` or register session scoping. |
| GET | `/refunds/due` | ✅ | `orders.refund_process`. |
| POST | `/checkout` | ✅ | `require_pos_register_session_for_checkout`. |
| PATCH | `/{transaction_id}/attribution` | ✅ | Manager PIN + `orders.edit_attribution`. |
| POST | `/{transaction_id}/pickup` | ✅ | BO `orders.modify` or register session + allocation rule. |
| GET | `/{transaction_id}/audit` | ✅ | Same read model as order detail. |
| POST | `/{transaction_id}/refunds/process` | ✅ | `orders.refund_process` + open session. |
| POST | `/{transaction_id}/returns` | ✅ | Same as modify / register path. |
| POST | `/{transaction_id}/exchange-link` | ✅ | `orders.modify`. |
| POST | `/{transaction_id}/items` | ✅ | `orders.modify`. |
| PATCH/DELETE | `/{transaction_id}/items/{transaction_line_id}` | ✅ | `orders.modify`. |
| GET/PATCH | `/{transaction_id}` | ✅ | View vs cancel/modify split. |
| GET | `/{transaction_id}/receipt.zpl` | ✅ | **`authorize_transaction_read_bo_or_register`** (same model as order read + optional `register_session_id`). |

#### `/api/products`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| POST | `/` | ✅ | **`catalog.edit`**. |
| GET | `/` | ✅ | **`catalog.view`**. |
| GET | `/control-board` | ✅ | Staff or POS session. |
| POST | `/bulk-update`, `/bulk-set-model`, `/bulk-archive` | ✅ | **`catalog.edit`**. |
| POST | `/variants/bulk-mark-shelf-labeled` | ✅ | **`catalog.edit`**. |
| POST | `/import` | ✅ | **`catalog.edit`**. |
| POST | `/matrix/generate` | ✅ | **`catalog.edit`**. |
| PATCH | `/variants/{variant_id}/stock-adjust` | ✅ | **`catalog.edit`**. |
| PATCH | `/variants/{variant_id}/pricing` | ✅ | **`catalog.edit`**. |
| GET | `/{product_id}/po-summary` | ✅ | **`require_catalog_or_procurement_view`**. |
| POST | `/{product_id}/clear-retail-overrides` | ✅ | **`catalog.edit`**. |
| PATCH | `/{product_id}/model` | ✅ | **`catalog.edit`**. |
| GET | `/{product_id}/hub`, `/timeline`, `/variants` | ✅ | **`catalog.view`**. |

#### `/api/categories`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/`, `/tree`, `/audit`, `/resolve-tax/{category_id}` | ✅ | **`catalog.view`**. |
| POST | `/` | ✅ | **`catalog.edit`**. |
| PATCH | `/{category_id}` | ✅ | **`catalog.edit`**. |

#### `/api/vendors`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/`, `/{vendor_id}/hub`, `/{vendor_id}/brands` | ✅ | **`catalog.view`**. |
| POST | `/`, `/{vendor_id}/brands` | ✅ | **`catalog.edit`**. |
| DELETE | `/{vendor_id}/brands/{brand_id}` | ✅ | **`catalog.edit`**. |

#### `/api/purchase-orders`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/`, `/{po_id}` | ✅ | **`procurement.view`**. |
| POST | `/`, `/direct-invoice`, `/{po_id}/lines`, `/submit`, `/receive` | ✅ | **`procurement.mutate`**. |

#### `/api/settings`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| * | `/receipt`, `/backups`, `/backup/config`, `/database/*` | ✅ | **`settings.admin`** on every handler. |

#### `/api/gift-cards`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| * | all routes | ✅ | **`gift_cards.manage`** / POS lookup paths as implemented in module. |

#### `/api/payments`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| POST | `/intent` | ✅ | **`require_staff_or_pos_register_session`** + global rolling-minute **rate limit** (`RIVERSIDE_PAYMENTS_INTENT_PER_MINUTE`). |

#### `/api/hardware`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| POST | `/print` | ✅ | **`require_staff_or_pos_register_session`**. |

#### `/api/loyalty`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET/PATCH | `/settings` | ✅ | **`loyalty.program_settings`**. |
| GET | `/monthly-eligible` | ✅ | **`loyalty.program_settings`**. |
| POST | `/adjust-points` | ✅ | Cashier + PIN + `loyalty.adjust_points`. |
| POST | `/redeem-reward` | ✅ | **`require_staff_or_pos_register_session`** (optional future **`loyalty.redeem`** split for BO-only). |
| GET | `/ledger` | ✅ | **`require_staff_or_pos_register_session`**. |

#### `/api/customers`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| * | all | ✅ | **`require_customer_access`** on **every** routed handler in **`customers.rs`** (browse, search, create, hub, import, etc.). |

#### `/api/sessions`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/current` | ✅ | **`require_staff_or_pos_register_session`**. |
| POST | `/open` | ✅ | Cashier + PIN. |
| POST | `/{session_id}/pos-api-token` | ✅ | Cashier + PIN; opener-only. |
| GET | `/{session_id}/reconciliation`, `/{session_id}/x-report` | ✅ | **`require_pos_session_secret_or_permission`** + **`register.reports`**. |
| POST | `/{session_id}/adjustments` | ✅ | **`require_pos_session_secret_or_permission`** + **`register.reports`**. |
| POST | `/{session_id}/begin-reconcile` | ✅ | Same gate; **active** branch requires **`authenticate_pos_staff`**; inactive branch only flips lifecycle when authorized. |
| POST | `/{session_id}/close` | ✅ | **`require_pos_session_secret_or_permission`** + **`register.reports`**. |

#### `/api/staff`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/list-for-pos`, POST `/verify-cashier-code` | ✅ | Intentional POS bootstrap. |
| GET | `/effective-permissions` | ✅ | Authenticated staff headers. |
| Admin routes | `/admin/*` | ✅ | Permission-gated in module — re-verify on change. |

#### `/api/insights`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| * | (pivot, commission, register history, …) | ✅ | `INSIGHTS_VIEW` / `INSIGHTS_COMMISSION_FINALIZE` — keep aligned with client. |

#### `/api/qbo`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| * | `/api/qbo/*` | ✅ | Permission keys per handler. |
| GET | `/api/auth/qbo/callback` | ✅ | OAuth callback — no staff headers; keep redirect/state validation strict. |

#### `/api/weddings`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/events` (SSE), `/morning-compass`, `/activity-feed`, `/actions`, lists, GET party/member, ledger, financial-context | ✅ | **`weddings.view`**. |
| POST/PATCH/DELETE | appointments, parties, members, restore | ✅ | **`weddings.mutate`**. |

#### `/api/weather`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| GET | `/history`, `/forecast` | ✅ | **`require_authenticated_staff_headers`**. |

#### `/api/sync/counterpoint`

| Method | Path | Status | Remediation |
|--------|------|--------|-------------|
| * | health, customers, inventory, orders stub | ✅ | Sync token when configured; keep token out of logs. |

---

### B.3 Non-RBAC fixes (data integrity & hygiene)

| ID | Item | Action |
|----|------|--------|
| T1 | `patch_order` cancel → refund queue | **Done** — refund queue + `refund_queued` activity are **in-transaction** before **`commit`**. |
| T2 | Checkout `checkout_client_id` idempotency | **Done:** idempotency **`SELECT`** runs **inside** the checkout **`tx`**; **`orders_checkout_client_id_uidx`** race handled by **rollback + replay** `SELECT` on pool. |
| T3 | Gift card issue / multi-step handlers | **Done** — mutating paths use **`db.begin()`** where multiple rows change (**`gift_cards.rs`**). |
| T4 | `OrderError::Database` / `RowNotFound` | **`OrderError::IntoResponse`** maps **`SqlxError::RowNotFound`** → **404**; other DB errors → 500. |
| T5 | `main.rs` backup worker log | **Done** — cleanup / cloud sync / scheduled backup failures use **`tracing::error!(error = %e, ...)`**. |
| T6 | `logic/importer.rs` | **`ToPrimitive`** retained — used (**`to_i32()`**). |
| T7 | Handler size | **`build_receipt_zpl`** + snapshot types live in **`logic/receipt_zpl.rs`**; **`OrderDetailResponse::receipt_for_zpl`** maps API DTO → logic. Further split of **`load_order_detail`** / wedding SQL is optional. |

---

### B.4 Verification checklist (after implementation)

1. **403** from API when staff lacks the new key; **401** when headers/session missing — covered by **`client/e2e/api-gates.spec.ts`** (runs when API is up; **skipped** if `E2E_API_BASE` unreachable).
2. **Client:** every touched workspace passes **`backofficeHeaders()`**; sidebar hides routes without permission.
3. **Playwright / E2E:** **`E2E_BASE_URL=http://localhost:5173`** (default in **`playwright.config.ts`**); full suite: `npm run test:e2e` from **`client/`** with dev server + API for non-skipped gates.
4. **`cargo check`** + smoke: register open → batch scan / payments intent only with session or staff as designed; **`429`** from **`POST /api/payments/intent`** when over **`RIVERSIDE_PAYMENTS_INTENT_PER_MINUTE`**.

---

*Deep-dive correctness and security work should layer on top of this inventory (per-subsystem review + tests + `cargo audit`).*
