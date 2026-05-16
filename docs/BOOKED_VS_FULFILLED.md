# Booked vs. Fulfilled Reporting — Riverside OS

Riverside OS uses a "Fulfilled-Recognition" model for financial and tax liability. This document explains the distinction between the **Booked Date** (the initial sale) and the **Fulfilled Date** (the revenue recognition event).

## Definitions

| Term | Meaning |
|---|---|
| **Booked Date** (`booked_at`) | The date the transaction was first created in the POS. This is when the customer committed to the purchase and paid a deposit. |
| **Fulfilled Date** (`fulfilled_at`) | The date the items were physically taken by or delivered to the customer. This is when revenue is recognized and legal ownership transfers. |

## Why the distinction?

In wedding and formalwear retail, customers often "book" a transaction months before they take it home.
- **Deposits** are held as a **Liability** (Unearned Revenue) until the event/pickup.
- **Sales Tax** is typically due based on the date of **possession/delivery** (Fulfillment).
- **Commissions** are earned when the store actually keeps the money (Fulfillment), preventing payouts for cancelled/returned orders.

## Financial Flow

### 1. Booking (Initial Transaction)
- **Status**: `open` (or `pending_measurement` when the sale cannot proceed until measurements or exact item details are captured).
- **Accounting**:
    - **Debit**: Cash/Card/Tender.
    - **Credit**: `liability_deposit`.
- **Reporting**: Appears in "Booked Sales" reports. Does **not** appear in QBO revenue or Tax reports.

### 2. Fulfillment (Pickup/Takeaway)
- **Status**: `fulfilled`.
- **Accounting**:
    - **Debit**: `liability_deposit`.
    - **Credit**: `revenue_category`, `tax_payable`.
    - **Inventory**: `stock_on_hand` decrements (and `reserved_stock`/`on_layaway` as appropriate).
- **Reporting**: Revenue is recognized. This transaction now appears in:
    - **QBO Daily Staging Journal**.
    - **NY State Sales Tax Reports**.
    - **Staff Commission Payouts**.

## Status Integrity Contract

- `transactions.status` is the aggregate Transaction state: `open`, `fulfilled`, `cancelled`, or `pending_measurement`.
- `transaction_lines.is_fulfilled` and `transaction_lines.fulfilled_at` are the line-level recognition evidence.
- A Transaction becomes `fulfilled` only through a workflow that updates all related evidence:
    - completed checkout for fully paid takeaway sales;
    - pickup / release for pickup transactions;
    - shipment recognition for shipped transactions.
- Do not manually set a Transaction to `fulfilled` from a generic status edit. The correct workflow must update line timestamps, loyalty accrual, commission events, reporting, and QBO staging inputs together.
- Admin / IT can monitor mismatches in `reporting.transaction_status_integrity`.

## Reporting Semantics in ROS

### Metabase & Insights
- `reporting.transactions_core` and `reporting.order_lines` include both booked and recognition dates.
- Most financial dashboards default to **Recognition Date** (Fulfillment).
- Performance/Volume dashboards use **Booked Date** to track current sales activity.

### Sales Tax Tracking
Strictly **Fulfilled-only**. Items are only taxed when they leave the store (Fulfillment).

### Commissions
Strictly **Fulfilled-only**. Payouts are calculated based on the margin of lines fulfilled during the commission period.

## Layaways & Orders
- **Layaway**: Items are booked and moved to `on_layaway`. Revenue remains in liability until the final payment and pickup (Fulfillment).
- **Orders**: Items are booked and moved to `reserved_stock` upon arrival. Revenue is deferred until pickup (Fulfillment).

---
*For workflow details, see [Transaction Fulfillment and Pickup](TRANSACTION_FULFILLMENT_AND_PICKUP.md), [Layaway Operations](LAYAWAY_OPERATIONS.md), and the staff [POS Loyalty](staff/pos-loyalty.md) manual.*
