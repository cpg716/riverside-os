# Booked vs. Fulfilled Reporting — Riverside OS

Riverside OS uses a "Fulfilled-Recognition" model for financial and tax liability. This document explains the distinction between the **Booked Date** (the initial sale) and the **Fulfilled Date** (the revenue recognition event).

## Definitions

| Term | Meaning |
|---|---|
| **Booked Date** (`booked_at`) | For an initial line, the date the Transaction was created in POS. For a later line addition or value amendment, the date that line value was added or changed. |
| **Fulfilled Date** (`fulfilled_at`) | The financial recognition date. Normally this is when merchandise is taken or delivered. **Pick Up Later is the explicit exception:** ownership, revenue, inventory relief, and commission occur on the sale date while Riverside retains physical custody. |

### Manager-approved backdated sales

Register backdating changes the transaction's **business/booked date** only after Manager Access approval. It does not rewrite the immutable creation time. Every payment movement keeps its actual processing date so card batches, the physical drawer, deposits, and QBO clearing evidence remain truthful. Payment `created_at`/`occurred_at` remain the audit timestamps. Receipts identify the backdated business date, and the register clears the override after the sale.

QBO uses a dedicated `BACKDATED_SALE_CLEARING` account to link the actual payment-day tender entry to the backdated business-day revenue or deposit-liability entry. This keeps daily tender reconciliation and business-date reporting separate without leaving the journal out of balance.

### Payment events and target orders

A payment processed today is a current-day payment event even when its allocation reduces an older Transaction Record. Daily Sales and the booked Z-Report show **Payment on Order** with the payment receipt Transaction number, public target Order/Transaction number, amount, tender, and remaining balance. The allocation does not become a new merchandise sale and does not move the older order's booked date. Receipt reprint uses the payment-event Transaction Record; order Detail uses the allocation target.

When staff recover an already-approved historical Helcim payment, its payment movement remains on the provider approval date. Attaching that approval to ROS later must not add the old tender to the current Daily Sales or Z-Report.

When one physical tender funds both a current sale and an older order, drawer and tender reconciliation count that tender once. Allocation detail remains visible for audit without repeating cash tendered, change, or card/check evidence.

### Existing-order amendments

Adding merchandise to or removing merchandise from an older open Transaction creates a line-booking event on the store-local amendment date; it does not rewrite the parent Transaction's original booked date. Daily Sales and the booked Z-Report net all same-day line additions, removals, and price/quantity/tax adjustments for that Transaction. A positive net change increases that amendment day's Booked Subtotal, while a negative net change reduces it by the signed pre-tax amount. A same-price product, variant, fulfillment, or line-kind switch contributes $0 but remains auditable as **Order Adjustment (No Net Change)**. An Order item cancellation or other return credit that reduces the summary without a successful refund tender remains visible once as signed return activity; payment-backed refunds continue to use their one event-scoped refund row.

Report detail uses the signed event components rather than the Transaction's entire current item list. Staff can therefore distinguish an item addition from a negative price correction or removed item, while the total reflects the complete signed net change.

Booked Sales is always the pre-tax value of that activity. Daily Sales and Z-Reports present **Subtotal**, **Tax**, and **Total With Tax** separately. Collected tax is never included in Sales, Net Sales, or average sale.

### Imported Counterpoint history

For Counterpoint history, the source business date is the booked date. ROS copies that same timestamp to the imported Transaction Record, every imported transaction line, and the initial booking event. The later ROS import timestamp remains separate audit context and must never become Booked Sales activity. A history row with a missing or invalid source booking timestamp is held for import review instead of being stamped with the current time. Legacy initial events created by the booking-event backfill use the parent Transaction's authoritative booking timestamp in Daily Sales and booked Z-Reports; mismatched stored timestamps are repaired inside ROS while the original value remains in event audit metadata. Transaction totals and tender ledgers remain unchanged. Counterpoint history is not reimported to perform this repair.

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
    - completed checkout for fully paid Take Now and Pick Up Later sales;
    - pickup / release for pickup transactions;
    - shipment recognition for shipped transactions.
- Do not manually set a Transaction to `fulfilled` from a generic status edit. The correct workflow must update line timestamps, loyalty accrual, commission events, reporting, and QBO staging inputs together.
- Admin / IT can monitor mismatches in `reporting.transaction_status_integrity`.

## Reporting Semantics in ROS

### Native Insights
- `reporting.transactions_core` and `reporting.order_lines` include both booked and recognition dates.
- Cube exposes separate **booked** and **recognized** datasets so the basis cannot change silently.
- Ask for **recognized** reporting for fulfilled revenue and **booked** reporting for current sales activity or pipeline.

### Sales Tax Tracking
Strictly **Fulfilled-only**. Items are only taxed when they leave the store (Fulfillment).

### Commissions
Strictly **Fulfilled-only**. Payouts are calculated based on the margin of lines financially fulfilled during the commission period. Pick Up Later lines are fulfilled and commissioned on their sale date, not their later custody-release date.

## Layaways & Orders
- **Layaway**: Items are booked and moved to `on_layaway`. Revenue remains in liability until the final payment and pickup (Fulfillment).
- **Orders**: Items are booked and moved to `reserved_stock` upon arrival. Revenue is deferred until pickup (Fulfillment).

---
*For workflow details, see [Transaction Fulfillment and Pickup](TRANSACTION_FULFILLMENT_AND_PICKUP.md), [Layaway Operations](LAYAWAY_OPERATIONS.md), and the staff [POS Loyalty](staff/pos-loyalty.md) manual.*
