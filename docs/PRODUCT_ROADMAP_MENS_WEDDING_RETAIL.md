# Riverside OS — product vision, strengths, and roadmap gaps

**Audience:** owners, product, and engineering planning the next phases of Riverside OS (ROS) for **Riverside Men’s Shop**: fine men’s clothing, **suits sold (not rented)**, and **wedding party** sales.

**Related docs:** [`DEVELOPER.md`](../DEVELOPER.md) (architecture), [`CUSTOMERS_LIGHTSPEED_REFERENCE.md`](./CUSTOMERS_LIGHTSPEED_REFERENCE.md) (CRM parity notes), [`STAFF_PERMISSIONS.md`](./STAFF_PERMISSIONS.md) (RBAC and Lightspeed comparison), [`APPOINTMENTS_AND_CALENDAR.md`](./APPOINTMENTS_AND_CALENDAR.md), [`INVENTORY_GUIDE.md`](../INVENTORY_GUIDE.md), [`SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`](./SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md) (**3-piece / vested component swaps** + QBO inventory adjustments), [`QBO_JOURNAL_TEST_MATRIX.md`](./QBO_JOURNAL_TEST_MATRIX.md) (staging journal checks + ledger fallbacks), [`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](./PWA_AND_REGISTER_DEPLOYMENT_TASKS.md), [`CATALOG_IMPORT.md`](./CATALOG_IMPORT.md), [`OFFLINE_OPERATIONAL_PLAYBOOK.md`](./OFFLINE_OPERATIONAL_PLAYBOOK.md), [`ORDERS_RETURNS_EXCHANGES.md`](./ORDERS_RETURNS_EXCHANGES.md), [`WEDDING_GROUP_PAY_AND_RETURNS.md`](./WEDDING_GROUP_PAY_AND_RETURNS.md) (disbursements + line returns), [`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md) (operational SMS — separate delivery plan).

This document records **men’s / wedding retail fit** for Riverside OS: strengths, **completed roadmap phases**, and a short **optional backlog** (measurements, **suit component swaps**, POS polish, and similar). **Not listed here:** formal AR/house charge, multi-location, and SMS provider work — either not a current product bet or covered outside this doc (e.g. Podium plan above).

---

## 1. Business context

| Dimension | Riverside model |
|-----------|-------------------|
| **Category** | Men’s formalwear, suits, accessories, wedding parties |
| **Ownership** | **Purchase** (customer owns goods). **Rental** workflows are out of scope unless you explicitly add them later |
| **Revenue shape** | High consideration, multi-visit, deposits and balances, group decisions (groomsmen) |
| **Operations** | Fittings, possible alterations, special orders, pickup and staging |
| **Systems expectation** | Modern POS + CRM + inventory + accounting bridge, usable on floor (PWA/tablet) and register (desktop) |

ROS is already aligned with **purchase-based** wedding and special-order stock rules (checkout does not consume floor stock for special-order paths the way takeaway does). See project invariants in [`AGENTS.md`](../AGENTS.md).

---

## 2. Current strengths (what you can lean on)

These are **already implemented** in meaningful depth; they differentiate ROS from a generic POS for your vertical.

### 2.1 Wedding and party commerce

- **Parties, members, pipeline** — Wedding workspace and APIs; member status, linkage to customers and orders
- **Checkout with wedding context** — `wedding_member_id`, fulfillment mapping (e.g. wedding vs special order) in `server/src/api/orders.rs`
- **Group payments** — `wedding_disbursements` on `CheckoutRequest`: one payer, allocations to member balances via payment logic and `recalc_order_totals` patterns (see [`AGENTS.md`](../AGENTS.md) disbursement rules)
- **Receipts and logistics** — Bag tags, ZPL modes, thermal paths documented in [`DEVELOPER.md`](../DEVELOPER.md)

### 2.2 Core retail and register

- **Sessions, floats, closeout** — Register session lifecycle; X-report and operational flows in POS components
- **Multi-tender checkout** — Splits, gift cards (with required `sub_type` for QBO ledger), Stripe integration where used
- **Tax and pricing** — NYS-oriented logic in server `logic/` / services (handlers stay thin per project rules)
- **Loyalty** — Program settings, points on checkout, back-office adjustment with permission keys (`loyalty.adjust_points`)

### 2.3 Inventory and buying

- **Catalog, variants, SKU** — Product matrix, scan resolution in POS (documented behavior in [`AGENTS.md`](../AGENTS.md))
- **Checkout bundle expansion** — `product_bundle_components` + `products.is_bundle` can expand a parent to **variant lines** at checkout (migrations **42** / **43**); this is **not** the same as **vest/pants swaps** for assembled suits (see gap below).
- **Special order / takeaway model** — Reserved stock and PO receipt behavior for special orders (see invariants)
- **Receiving, vendors, import** — [`CATALOG_IMPORT.md`](./CATALOG_IMPORT.md), vendor hub, Counterpoint bridge when enabled
- **Suit / component swaps (sale-scoped)** — Back Office **Swap component** + **`POST .../suit-swap`** update **line cost/retail** and **floor stock** for fulfilled **takeaway** lines; QBO daily journal **warns** when swap events exist. Spec / accounting checklist: **[`SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`](./SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md)**.

### 2.4 Customer CRM and appointments

- **Customer hub, timeline, search** — Back-office CRM; POS customer attach
- **Merge, groups, store credit** — Audited **customer merge** (`POST /api/customers/merge`), **`customer_groups`** + membership APIs (permission `customer_groups.manage`), **store credit** accounts/ledger and checkout tender `store_credit` (migration **42**, RBAC in **43**)
- **Appointments** — Store calendar; wedding-optional booking ([`APPOINTMENTS_AND_CALENDAR.md`](./APPOINTMENTS_AND_CALENDAR.md))
- **Measurements in schema** — `customer_measurements` / `measurements` tables and Rust models (`Measurement` in `server/src/models/mod.rs`). **UI** — shared vault editor in CRM hub and POS; Compass wedding member sizing mirrors to vault (see **§3.2**)
- **Alterations MVP** — `alteration_orders` + **`AlterationsWorkspace`** / **`CustomerAlterationsPanel`**; activity table in migration **44**

### 2.5 Insights, staff, and integrations

- **Insights** — Pivots, commission views (permission-gated), sessions, tax audit surfaces; **wedding saved views** persisted per staff (`wedding_insight_saved_views`, migration **44**); **wedding health** (**`insights.view`**) summarizes parties closing in 30 days, members without orders, and **members with open order balance** (`GET /api/insights/wedding-health`); **best-sellers** / **dead-stock** use the same booked vs recognition **`basis`** as sales pivot.
- **Staff RBAC** — PIN, headers, role defaults, overrides ([`STAFF_PERMISSIONS.md`](./STAFF_PERMISSIONS.md))
- **QBO bridge** — Mapping, staging, sync patterns (`server/src/api/qbo.rs`)
- **Deployment** — PWA + Tauri register, offline checkout queue (`localforage`), hardware print bridge ([`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](./PWA_AND_REGISTER_DEPLOYMENT_TASKS.md))

### 2.6 Messaging (foundation)

- **Pickup / status hooks** — `MessagingService` in `server/src/logic/messaging.rs`; today **tracing / scaffold**. **Operational SMS** delivery is scoped in **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, not in **§3.2** below.

### 2.7 Operations and production

- **Void vs cancel** — **`orders.void_sale`** (migration **49**) allows **`PATCH`** to **`cancelled`** when the order has **no** payment allocations; **`orders.cancel`** remains required when money was allocated (refund queue). See **[`docs/ORDERS_RETURNS_EXCHANGES.md`](./ORDERS_RETURNS_EXCHANGES.md)**.
- **Lightspeed customer import issues** — `POST /api/customers/import/lightspeed` returns an **`issues`** array (missing `customer_code`, `email_conflict`); Back Office **auto-downloads** a CSV when any row is reported.
- **Offline** — Checkout queue + **[`docs/OFFLINE_OPERATIONAL_PLAYBOOK.md`](./OFFLINE_OPERATIONAL_PLAYBOOK.md)** for staff guidance.
- **CORS** — Set **`RIVERSIDE_CORS_ORIGINS`** (and optionally **`RIVERSIDE_STRICT_PRODUCTION`**) in production; see `server/src/main.rs`.

---

## 3. Roadmap status — completed vs optional backlog

### 3.1 Completed (this initiative)

| Theme | What shipped |
|--------|----------------|
| **Suit / component swap** | **`POST /api/orders/{id}/items/{line}/suit-swap`**, `suit_component_swap_events`, inventory `adjustment` rows for fulfilled takeaway swaps; QBO journal **warnings** when swaps exist on the activity date; Back Office **Orders → Swap component**; permission **`orders.suit_component_swap`** (**50**). |
| **Register drawer (BO)** | **`register.open_drawer`** gates **`POST /api/sessions/{id}/adjustments`** for non–POS-token callers; POS still uses session headers (**50**). |
| **QBO journal hygiene** | **`docs/QBO_JOURNAL_TEST_MATRIX.md`** for sandbox/staging **propose** regression; server warns when return-day restock needs **`INV_ASSET`** and swap cost deltas use **`INV_ASSET`** / **`COGS_DEFAULT`** fallbacks (see also **`SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`**). |
| **POS exchange + link** | **`PosExchangeWizard`** (returns + order totals/tenders); replacement checkout triggers **`POST /api/orders/{original}/exchange-link?register_session_id=…`** from the cart when an exchange is in progress (`Cart.tsx`). |
| **Measurements (labels)** | Shared retail sizing labels: **`client/src/components/customers/retailMeasurementLabels.ts`** (CRM hub + Compass). |
| **POS exchange / wedding refunds** | Exchange wizard copy on group-pay edge cases; **`docs/WEDDING_GROUP_PAY_AND_RETURNS.md`** (correct member order for returns, refunds vs allocations). |
| **Returns / exchanges / credit** | Refund queue, line returns, exchange link, store credit tender, POS exchange wizard shell; **`orders.void_sale`** split from cancel-with-payments (**49**). |
| **Discount governance** | **`staff_role_pricing_limits`** at checkout (**40**). |
| **CRM** | Merge, groups, store credit (**42–43**); Lightspeed import **row-level issues + CSV** export on the client. |
| **Alterations + checkout bundles** | **`alteration_orders`** + UI; **`product_bundle_components`** + checkout expansion (**42–43**). |
| **Wedding analytics** | Saved views (**44**); **wedding health** tiles including **open balance** count on linked orders. |
| **Security / ops** | CORS allowlist env vars; offline playbook doc. |

### 3.2 Optional backlog (not required for core men’s / wedding retail)

The earlier initiative items in this section are **complete** in product terms: shared measurement vault editor (hub, POS, Compass), suit-swap extensions + register path + QBO swap/return signals, POS exchange wizard with totals/tenders and **automatic exchange-link** after replacement checkout on the same session, **`docs/QBO_JOURNAL_TEST_MATRIX.md`** + ledger fallback warnings, **`docs/WEDDING_GROUP_PAY_AND_RETURNS.md`**, and **`register.open_drawer`**. Treat new work here as **net-new** bets (see section 4), not leftover gaps from this roadmap.

---

## 4. Suggested prioritization (after roadmap completion)

Core P0–P2 themes and the follow-up slices (QBO staging matrix + **`INV_ASSET` / `COGS_DEFAULT`** hygiene, register exchange auto-link, wedding group return ops doc, **`register.open_drawer`**, floor training on Swap vs Exchange vs BO swap) are **shipped or documented**. Use the table for **what to do next** when you want new scope.

| Priority | Theme | Rationale |
|----------|--------|-----------|
| **Next bets** | **§5 out-of-scope themes** or **[`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md)** | SMS delivery, AR, multi-location, rental — only when strategy changes |
| **Ongoing** | **`QBO_JOURNAL_TEST_MATRIX.md` checklist** | Re-run after mapping or tax rule changes; keep **propose** warnings empty in staging |
| **Ongoing** | **Staff playbooks** | Short floor refresher: register **Swap** vs **Exchange** vs Back Office **Swap component** |

---

## 5. Explicitly out of scope (unless you change strategy)

- **Suit rental** lifecycle (rental agreements, damage fees, return-to-rack as rental SKU) — your stated model is **purchase**
- **Marketplace / omnichannel** (Amazon, etc.) without dedicated integration work
- **Full Lightspeed feature parity** — use [`CUSTOMERS_LIGHTSPEED_REFERENCE.md`](./CUSTOMERS_LIGHTSPEED_REFERENCE.md) as a **menu of ideas**, not a checklist

---

## 6. How to use this doc in planning

1. Treat **§3.1** as the **baseline** shipped for men’s / wedding retail; triage **new** bets from **§4** and **§5**, not from a leftover **§3.2** gap list (that initiative is closed).  
2. For CRM/API details, use [`CUSTOMERS_LIGHTSPEED_REFERENCE.md`](./CUSTOMERS_LIGHTSPEED_REFERENCE.md) and [`DEVELOPER.md`](../DEVELOPER.md).  
3. For staff policy, extend [`STAFF_PERMISSIONS.md`](./STAFF_PERMISSIONS.md) when adding keys.  
4. For deployment, PWA, and CORS: [`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](./PWA_AND_REGISTER_DEPLOYMENT_TASKS.md), [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md), and **[`OFFLINE_OPERATIONAL_PLAYBOOK.md`](./OFFLINE_OPERATIONAL_PLAYBOOK.md)**.  
5. For **vest/pants swaps** and QBO: **[`SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`](./SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md)** and **[`QBO_JOURNAL_TEST_MATRIX.md`](./QBO_JOURNAL_TEST_MATRIX.md)**.

---

## 7. Revision history

| Date | Note |
|------|------|
| 2026-04-04 | Initial roadmap and gap document for men’s / wedding retail context |
| 2026-04-04 | Synced to repo: merge, groups, store credit, bundles, alteration MVP, wedding insight saved views (migrations **42–44**); refreshed §2–§4 and §3.1–3.5, §3.10 |
| 2026-04-04 | Doc alignment pass: **`docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md`**, **`DEVELOPER.md`** (customers API blurb + table), **`docs/STAFF_PERMISSIONS.md`** (Lightspeed matrix + migrations **40**, **42–43**), **`ROS_AI_INTEGRATION_PLAN.md`** (Pillar 5 vs shipped merge) |
| 2026-04-04 | **Roadmap completion:** **`orders.void_sale`** (**49**), Lightspeed import **`issues`** + CSV download, wedding health **open-balance** KPI, **`docs/OFFLINE_OPERATIONAL_PLAYBOOK.md`**, roadmap §3–§4 rewritten to completed vs optional backlog |
| 2026-04-04 | Dropped **§3.2** items AR, multi-location, and messaging (not a current bet / covered by **`PLAN_PODIUM_SMS_INTEGRATION.md`**); refreshed §4 prioritization and §2.6 |
| 2026-04-04 | Added **suit outfit component swap** backlog + **`SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`**; removed **guided selling**; clarified checkout bundles vs swap workflow |
| 2026-04-04 | Suit swap scoped as **per-sale / per-customer** only — **not** a catalog or product-definition change |
| 2026-04-04 | Closed follow-up slice: **QBO** matrix + **`INV_ASSET`/`COGS_DEFAULT`** checklist, **register exchange-link** after POS replacement checkout, **`WEDDING_GROUP_PAY_AND_RETURNS.md`**, **`register.open_drawer`**; **§3.2** marked complete; **§4** repointed to new bets + ongoing QA/training |

When you complete a major initiative listed here, add a row and optionally link the PR or migration number so the doc stays honest.
