# Booked vs. Fulfilled Reporting — Riverside OS

Riverside OS uses a "Fulfilled-Recognition" model for financial and tax liability. This document explains the distinction between the **Booked Date** (the initial sale) and the **Fulfilled Date** (the revenue recognition event).

## Definitions

| Term | Meaning |
|---|---|
| **Booked Date** (`booked_at`) | The date the transaction was first created in the POS. This is when the customer committed to the purchase and paid a deposit. |
| **Fulfilled Date** (`fulfilled_at`) | The date the items were physically taken by or delivered to the customer. This is when revenue is recognized and legal ownership transfers. |

## Why the distinction?

In wedding and formalwear retail, customers often "book" an order months before they take it home.
- **Deposits** are held as a **Liability** (Unearned Revenue) until the event/pickup.
- **Sales Tax** is typically due based on the date of **possession/delivery** (Fulfillment).
- **Commissions** are earned when the store actually keeps the money (Fulfillment), preventing payouts for cancelled/returned orders.

## Financial Flow

### 1. Booking (Initial Transaction)
- **Status**: `booked` (or `order_placed`).
- **Accounting**:
    - **Debit**: Cash/Card/Tender.
    - **Credit**: `liability_deposit`.
- **Reporting**: Appears in "Booked Sales" reports. Does **not** appear in QBO revenue or Tax reports.

### 2. Fulfillment (Pickup/Takeaway)
- **Status**: `fulfilled` (or `completed`).
- **Accounting**:
    - **Debit**: `liability_deposit`.
    - **Credit**: `revenue_category`, `tax_payable`.
    - **Inventory**: `stock_on_hand` decrements (and `reserved_stock`/`on_layaway` as appropriate).
- **Reporting**: Revenue is recognized. This transaction now appears in:
    - **QBO Daily Staging Journal**.
    - **NY State Sales Tax Reports**.
    - **Staff Commission Payouts**.

## Reporting Semantics in ROS

### Metabase & Insights
- `reporting.orders_core` and `reporting.order_lines` include both dates.
- Most financial dashboards default to **Recognition Date** (Fulfillment).
- Performance/Volume dashboards use **Booked Date** to track current sales activity.

### Sales Tax Tracking
Strictly **Fulfilled-only**. Items are only taxed when they leave the store (Fulfillment).

### Commissions
Strictly **Fulfilled-only**. Payouts are calculated based on the margin of lines fulfilled during the commission period.

## Layaways & Special Orders
- **Layaway**: Items are booked and moved to `on_layaway`. Revenue remains in liability until the final payment and pickup (Fulfillment).
- **Special Orders**: Items are booked and moved to `reserved_stock` upon arrival. Revenue is deferred until pickup (Fulfillment).

---
*For staff workflows, see [Order Pickup Manual](docs/staff/order-pickup-manual.md) and [Layaway Manual](docs/staff/layaway-manual.md).*
