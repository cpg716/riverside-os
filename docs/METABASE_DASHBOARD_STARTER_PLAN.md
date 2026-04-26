# Metabase Dashboard Starter Plan (Riverside OS)

**Status:** **Reference starter / current guidance.** Use this as the recommended initial dashboard lineup; implementation and ops details remain in **[`METABASE_REPORTING.md`](./METABASE_REPORTING.md)** and **[`PLAN_METABASE_INSIGHTS_EMBED.md`](./PLAN_METABASE_INSIGHTS_EMBED.md)**.

This is the recommended first-pass dashboard lineup for Riverside OS.

Use it to build a clean, staff-friendly Metabase experience that feels operational, readable, and useful on day one.

Companion:
- [METABASE_REPORTING.md](./METABASE_REPORTING.md)
- [METABASE_FIELD_MODELING_CHECKLIST.md](./METABASE_FIELD_MODELING_CHECKLIST.md)

---

## Goal

Start with a small, high-quality dashboard set instead of dozens of half-finished dashboards.

The first dashboards should:
- answer real day-to-day store questions
- use the readable `reporting.*` views
- avoid raw IDs and technical noise
- separate staff-safe dashboards from admin-only financial dashboards

---

## Dashboard set

Build these in order.

## 1. Executive Sales Overview

Audience:
- owner
- leadership
- store manager

Source:
- `reporting.transactions_core`

Purpose:
- top-line booked vs fulfilled sales
- payment coverage and balance due
- channel and fulfillment mix

Core cards:
- booked sales this week
- fulfilled sales this week
- open balance due
- average transaction value
- transaction count

Core charts:
- booked sales by business date
- fulfilled sales by business date
- sales by fulfillment method
- sales by sale channel

Core table:
- recent transactions
  - `Transaction #`
  - `Booked Business Date`
  - `Customer Name`
  - `Salesperson`
  - `Status`
  - `Total Price`
  - `Amount Paid`
  - `Balance Due`

---

## 2. Staff Performance

Audience:
- managers
- leadership

Source:
- `reporting.transactions_core`

Purpose:
- understand attribution and performance without exposing too much technical detail

Core cards:
- sales by salesperson
- average ticket by salesperson
- open balance by salesperson

Core charts:
- booked sales by salesperson
- fulfilled sales by salesperson
- transactions by operator

Core table:
- salesperson detail
  - `Salesperson`
  - `Transaction Count`
  - `Booked Sales`
  - `Fulfilled Sales`
  - `Balance Due`

---

## 3. Product and Margin

Audience:
- admin
- owner
- controller

Source:
- `reporting.order_lines`

Purpose:
- best sellers
- weak movers
- gross margin understanding

Core cards:
- total line revenue
- total gross margin
- average margin percent

Core charts:
- top products by revenue
- top products by units sold
- margin by product
- fulfillment mix by product category if modeled

Core table:
- product line performance
  - `Transaction #`
  - `Product Name`
  - `SKU`
  - `Customer Name`
  - `Quantity`
  - `Line Revenue`
  - `Line Cost`
  - `Gross Margin`

---

## 4. Shipping Operations

Audience:
- operations
- shipping team
- managers

Source:
- `reporting.shipments_active`
- `reporting.fulfillment_orders_core`

Purpose:
- track live shipments and shipping economics

Core cards:
- active shipments
- shipments by status
- average label cost
- average shipping charged

Core charts:
- shipments by carrier
- shipments by service
- shipments by status

Core table:
- shipment queue
  - `Transaction #`
  - `Fulfillment Order #`
  - `Customer Name`
  - `Carrier`
  - `Service`
  - `Tracking Number`
  - `Status`
  - `Shipping Charged`
  - `Label Cost`

---

## 5. Alterations Queue

Audience:
- alterations
- support staff
- managers

Source:
- `reporting.alterations_active`

Purpose:
- manage tactical alterations work with a clean queue view

Core cards:
- active alterations
- overdue alterations
- due today
- due this week

Core charts:
- alterations by status
- due volume by day

Core table:
- active alterations queue
  - `Transaction #`
  - `Fulfillment Order #`
  - `Customer Name`
  - `Customer Phone`
  - `Status`
  - `Due At`
  - `Overdue`

---

## 6. Payments and Merchant Reconciliation

Audience:
- owner
- controller
- finance support

Source:
- `reporting.payment_ledger`
- `reporting.merchant_reconciliation`

Purpose:
- understand tenders, fees, payer identity, and linked sale context

Core cards:
- total payment volume
- total merchant fees
- net collected
- check tender volume

Core charts:
- payments by method
- merchant fees over time
- net by business date

Core table:
- payment audit
  - `Business Date`
  - `Payment Method`
  - `Payer Name`
  - `Primary Transaction #`
  - `Linked Transactions`
  - `Gross Amount`
  - `Merchant Fee`
  - `Net Amount`

---

## 7. Weddings Overview

Audience:
- wedding team
- managers

Source:
- `reporting.wedding_party_economics`
- `reporting.fulfillment_orders_core`

Purpose:
- party-level revenue and profitability
- event-driven operational tracking

Core cards:
- active wedding parties
- total wedding revenue
- total wedding profit
- upcoming parties in next 30 days

Core charts:
- revenue by event month
- profit by wedding party
- party count by salesperson

Core table:
- wedding party summary
  - `Wedding Party`
  - `Event Date`
  - `Salesperson`
  - `Member Count`
  - `Order Count`
  - `Total Revenue`
  - `Total Profit`
  - `Margin %`

---

## 8. Loyalty Overview

Audience:
- managers
- marketing
- owner

Source:
- `reporting.loyalty_customer_snapshot`
- `reporting.loyalty_point_ledger`
- `reporting.order_loyalty_accrual`

Purpose:
- understand point balances, customer engagement, and redemption behavior

Core cards:
- total active loyalty balance
- points earned this period
- points redeemed this period
- rewards issued

Core charts:
- points earned vs burned over time
- top loyalty customers by balance
- rewards issued over time

Core table:
- loyalty customer snapshot
  - `Customer Name`
  - `Customer Code`
  - `Phone`
  - `Current Balance`
  - `Lifetime Earned`
  - `Lifetime Redeemed`
  - `Rewards Issued`

---

## Collections recommendation

Create these first:

- `Staff Approved`
  - Executive Sales Overview
  - Shipping Operations
  - Alterations Queue
  - Weddings Overview
  - Loyalty Overview

- `Admin Financial`
  - Product and Margin
  - Payments and Merchant Reconciliation
  - any cost / margin exploration

- `Drafts / Internal`
  - unfinished working dashboards
  - experimental saved questions

---

## Build order

Recommended sequence:

1. Executive Sales Overview
2. Shipping Operations
3. Alterations Queue
4. Weddings Overview
5. Loyalty Overview
6. Staff Performance
7. Payments and Merchant Reconciliation
8. Product and Margin

This gets staff-safe operational value live early, then layers in deeper admin finance views after.

---

## Quality bar

A good Riverside dashboard should:
- read like store operations, not database internals
- use display ids and names prominently
- have strong date filtering
- avoid more than one or two confusing tables per dashboard
- clearly separate staff-safe and admin-only information
