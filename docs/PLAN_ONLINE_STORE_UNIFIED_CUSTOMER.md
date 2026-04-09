# Plan: Unified customer account and purchase history (online loyalty surface)

**Audience:** Product and engineering — **goals and constraints only.** No implementation schedule; ecommerce checkout and full `/shop` commerce remain **on hold** at Riverside.

**Status:** **Documentation only — not scheduled.** This doc captures product intent for when web work resumes. **Current product focus:** Podium reviews — **[`docs/PLAN_PODIUM_REVIEWS.md`](./PLAN_PODIUM_REVIEWS.md)**. For shipped storefront baseline (catalog, cart estimates, JWT accounts, no paid web checkout), see **[`docs/ONLINE_STORE.md`](./ONLINE_STORE.md)** and **[`docs/PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)**.

---

## 1. Single customer base

- **`customers` in PostgreSQL** is the only long-lived identity for people who shop with Riverside. There is **no** parallel “web-only CRM” or duplicate customer table.
- Web sign-up **links** to the same rows staff use in Back Office and POS: **`customer_online_credential`** (migration **77**) and **`customer_created_source`** describe how the account was created or activated — see **[`docs/ONLINE_STORE.md`](./ONLINE_STORE.md)**.
- **In-store and online activity** should both roll up under that one customer: orders attributed with **`orders.sale_channel`** (register vs web) where applicable.

---

## 2. Account creation / linkage (product intent)

When a visitor registers on the public site:

1. **Match candidates** against existing ROS **`customers`** using **name, email, phone, and address** (and any future stable identifiers you adopt).
2. **Matching rules are TBD** at implementation time: exact vs normalized/fuzzy match, multi-hit tie-breaking, and escalation to staff (duplicate review, merge tooling) should align with **[`docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md`](./CUSTOMERS_LIGHTSPEED_REFERENCE.md)** and hub/merge flows — avoid silently attaching a web login to the wrong person.
3. **If a single confident match exists** — Prompt the visitor to **set a password** (activate web credential on the existing row). UX copy should reflect **identity confirmation** where policy requires it.
4. **If no safe match** — **Create** a new **`customers`** row with appropriate **`customer_created_source`** (consistent with migration **77** patterns and your import/provenance rules).

This preserves **one customer base** while allowing structured onboarding on the web.

---

## 3. Unified purchase history (receipt-grade)

**Goal:** The signed-in **account** area shows **both** in-store and online purchases in **one** timeline (not two silos).

Per order / per visit, the customer-facing detail should approach **receipt-level** usefulness:

- Line items (descriptions, quantities, prices)
- Taxes and totals
- Dates (store-local or purchase-time semantics TBD)
- **Forms of payment** / tenders (customer-safe wording; no internal-only fields)

Presentation can mirror staff receipt concepts without copying internal templates — see **[`docs/RECEIPT_BUILDER_AND_DELIVERY.md`](./RECEIPT_BUILDER_AND_DELIVERY.md)** as an analogue for “what good looks like,” not as the implementation of the account UI.

Channel labels (**in-store vs web**) should be clear so customers understand where each purchase happened.

---

## 4. “Not one box” — separate surfaces, shared data

Riverside intentionally avoids a **single monolithic UI** where every workflow for every role lives in one undifferentiated shell.

- **One system of record:** Postgres **`customers`**, **`orders`**, payments, and integrations.
- **Different operational surfaces:** public **`/shop`** and account UX; **Back Office** CRM (**Customer hub**, merge, permissions); **POS** (speed-first); **Settings** (**`online_store.manage`**, integrations). Different people own CMS vs floor vs CRM vs register.
- **Different training and permissions:** Staff use RBAC keys appropriate to each area — see **[`docs/STAFF_PERMISSIONS.md`](./STAFF_PERMISSIONS.md)** and **[`docs/CUSTOMER_HUB_AND_RBAC.md`](./CUSTOMER_HUB_AND_RBAC.md)**. The web account experience is **customer-facing**, not a replacement for staff tools.

Unified data does **not** mean collapsing all workflows into “one box.”

---

## 5. Gaps vs shipped code today

Honest bridge to the repo **as documented** in **[`docs/ONLINE_STORE.md`](./ONLINE_STORE.md)**:

- **Paid web checkout** is not built; **`sale_channel = web`** orders from checkout are limited until Phase C ships in **[`docs/PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)**.
- **Account order list** today is **web-scoped** relative to full unified history; exposing **in-store** orders to the same JWT session requires **future read APIs** and permission-sensitive field filtering (customer-safe projections).
- **Richer match-at-register flows** (multi-field identity match, staff escalation) are **future** server + `/shop` UX work, not specified here at API level.

When this initiative moves from goals to engineering, add concrete endpoints, matching policy, and QA scenarios in **`DEVELOPER.md`** / **`ONLINE_STORE.md`** and link back here.

---

## Related docs

| Doc | Role |
|-----|------|
| [`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md) | Full storefront roadmap vs shipped |
| [`ONLINE_STORE.md`](./ONLINE_STORE.md) | `/shop`, `/api/store`, account JWT |
| [`PLAN_PODIUM_REVIEWS.md`](./PLAN_PODIUM_REVIEWS.md) | Current reviews-focused work |
| [`CUSTOMERS_LIGHTSPEED_REFERENCE.md`](./CUSTOMERS_LIGHTSPEED_REFERENCE.md) | Merge, import, customer codes |
