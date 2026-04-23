# Metabase Admin Setup Steps (Riverside OS)

This is the literal admin-side setup sequence for turning the Riverside reporting schema into a polished Metabase experience.

Companion:
- [METABASE_REPORTING.md](./METABASE_REPORTING.md)
- [METABASE_FIELD_MODELING_CHECKLIST.md](./METABASE_FIELD_MODELING_CHECKLIST.md)
- [METABASE_DASHBOARD_STARTER_PLAN.md](./METABASE_DASHBOARD_STARTER_PLAN.md)

---

## Goal

Use this checklist after the Riverside reporting migrations are applied.

It walks through:
- connecting Metabase to the right schema
- tuning metadata so staff see readable fields
- setting up collections and permissions
- making the initial dashboard experience feel curated

---

## 1. Confirm the database connection

In Metabase:

1. Open **Admin**
2. Open **Databases**
3. Open the Riverside Postgres connection
4. Confirm:
   - database is `riverside_os`
   - user is `metabase_ro`
   - you are modeling the `reporting` schema as the primary analytics source

Target outcome:
- Metabase questions and dashboards should be built on `reporting.*` views, not raw transactional tables

---

## 2. Rescan and sync metadata

In Metabase:

1. Open **Admin**
2. Open **Databases**
3. Open the Riverside connection
4. Run:
   - **Sync database schema now**
   - **Re-scan field values now** if available

Do this after:
- applying reporting migrations
- adding new readable columns
- renaming or rebuilding views

---

## 3. Set up collections first

In Metabase:

1. Open **Collections**
2. Create:
   - `Staff Approved`
   - `Admin Financial`
   - `Drafts / Internal`

Recommended usage:
- `Staff Approved`
  - safe operational dashboards
  - no margin or cost-heavy exploration
- `Admin Financial`
  - margin
  - payment reconciliation
  - finance-sensitive dashboards
- `Drafts / Internal`
  - unfinished work
  - experimental questions

---

## 4. Create or confirm user groups

In Metabase:

1. Open **Admin**
2. Open **People**
3. Create or confirm:
   - `Reporting - Staff`
   - `Reporting - Admin`

Recommended permissions:
- `Reporting - Staff`
  - view-only access to `Staff Approved`
  - no access to `Admin Financial`
- `Reporting - Admin`
  - full access to both

If you use individual users instead of shared logins, still group them this way.

---

## 5. Model the core views

In Metabase:

1. Open **Admin**
2. Open **Table Metadata**
3. Open each of these views:
   - `reporting.transactions_core`
   - `reporting.order_lines`
   - `reporting.fulfillment_orders_core`
   - `reporting.shipments_active`
   - `reporting.alterations_active`
   - `reporting.payment_ledger`
   - `reporting.merchant_reconciliation`
   - `reporting.wedding_party_economics`
   - `reporting.loyalty_customer_snapshot`
   - `reporting.loyalty_point_ledger`
   - `reporting.loyalty_reward_issuances`
   - `reporting.order_loyalty_accrual`

Then for each:

1. Hide UUID fields
2. Promote display/name fields
3. Rename visible fields to business labels
4. Set semantic types where useful

Use [METABASE_FIELD_MODELING_CHECKLIST.md](./METABASE_FIELD_MODELING_CHECKLIST.md) as the exact field-by-field guide.

---

## 6. Field naming recommendations

Use these visible labels in Metabase where possible:

- `transaction_display_id` → `Transaction #`
- `fulfillment_order_display_id` → `Fulfillment Order #`
- `customer_display_name` → `Customer Name`
- `customer_name` → `Customer Name`
- `operator_display_name` → `Operator`
- `operator_name` → `Operator`
- `primary_salesperson_display_name` → `Salesperson`
- `primary_salesperson_name` → `Salesperson`
- `booked_business_date` → `Booked Business Date`
- `recognition_business_date` → `Fulfilled Business Date`
- `linked_transaction_display_ids` → `Linked Transactions`
- `linked_customer_names` → `Linked Customers`

Avoid exposing names like:
- `transaction_id`
- `customer_id`
- `order_id`
- `fulfillment_order_id`

unless they are intentionally needed for admin debugging.

---

## 7. Semantic types to set

Where available in Metabase metadata, set:

- phone fields → `Phone`
- email fields → `Email`
- monetary fields → currency / numeric
- date fields → date
- timestamp fields → timestamp
- status fields → category
- transaction and fulfillment display ids → entity/key labels for reporting display

This helps filters, formatting, and exports feel more polished.

---

## 8. Build the first dashboards

Use [METABASE_DASHBOARD_STARTER_PLAN.md](./METABASE_DASHBOARD_STARTER_PLAN.md).

Recommended creation order:

1. Executive Sales Overview
2. Shipping Operations
3. Alterations Queue
4. Weddings Overview
5. Loyalty Overview
6. Staff Performance
7. Payments and Merchant Reconciliation
8. Product and Margin

Move finished dashboards into:
- `Staff Approved`
- `Admin Financial`

Leave unfinished work in:
- `Drafts / Internal`

---

## 9. Set a clean homepage

In Metabase:

1. Open **Admin**
2. Open **Settings**
3. Open the homepage/default landing area settings
4. Set the default landing experience to a polished dashboard or curated home collection

Recommended:
- staff users land on `Staff Approved`
- admin users land on a stronger executive dashboard or approved admin collection

Goal:
- people should land somewhere useful, not in a raw list of tables

---

## 10. Hide raw clutter aggressively

If you want Riverside reporting to feel premium, do not be shy about hiding technical fields.

Usually hide:
- UUIDs
- helper relationship ids
- raw metadata/json
- duplicate legacy fields if a cleaner alias exists
- old UUID-fragment short ids if official `TXN-#####` / `ORD-#####` display ids exist

Keep visible:
- names
- display ids
- dates
- statuses
- dollars
- readable business categories

---

## 11. Staff-safe vs admin-only review

Before publishing dashboards:

1. Review `Staff Approved`
2. Make sure there is no:
   - cost
   - gross margin
   - private finance-only detail
3. Review `Admin Financial`
4. Confirm deeper finance views are only there

This is where the Riverside/Metabase permission split matters most.

---

## 12. Smoke test

Use this simple pass:

1. Log in as a staff-class Metabase user
2. Open `Staff Approved`
3. Open at least one dashboard and one table
4. Check:
   - are there names instead of UUIDs?
   - are transaction numbers visible as `TXN-...`?
   - are order/fulfillment references readable?
   - are the filters understandable?
   - does anything feel like internal database jargon?

Then:

1. Log in as an admin-class user
2. Confirm finance-sensitive dashboards are present and readable too

If a report still looks technical, fix the view or field metadata before publishing it widely.

---

## 13. Ongoing maintenance rule

Whenever a new reporting view or field is added:

1. apply the migration
2. sync schema in Metabase
3. model the fields in Admin
4. decide staff-safe vs admin-only placement
5. update the relevant Riverside Metabase docs if the standard changed

That prevents the reporting layer from drifting back into unreadable internals.
