# Transaction Fulfillment, Pickup, and Shipping

**Status:** Canonical pickup, partial fulfillment, and shipping workflow reference. For the full transactions doc map, start at [`TRANSACTIONS.md`](TRANSACTIONS.md).

Operational reference for **register** flows: loading customer transactions, partial fulfillment, pickup, and shipping. Updates from v0.2.0.

## Register Shipping vs Orders

Shipping is a delivery method, not automatically an Order.

- **Ship current sale**: staff can add shipping to an in-stock Register sale before payment. Checkout records `fulfillment_method = ship`, stores the quoted shipping amount/address snapshot, and creates a shipment registry row. The merchandise line can remain a current-sale/takeaway-style line; it does not become a Special/Custom/Wedding fulfillment order just because it ships.
- **Ship existing order**: staff can ship an already-open transaction/order-style line from the Orders or Shipments workflow. This is fulfillment/release work against existing transaction lines.
- **Pickup existing order**: staff use the pickup/release flow to mark open transaction lines fulfilled for in-store handoff.

The historical endpoint for marking lines fulfilled is still `POST /api/transactions/{transaction_id}/pickup`; staff-facing UI should distinguish **Release for Pickup** from **Shipping** even when shared fulfillment internals are reused.

## Overview

```
Customer Transaction Lifecycle:
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Booked   │───→│ In       │───→│ Fulfilled│───→│ Closed   │
│         │    │ Progress │    │         │    │         │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                     ↑                 ↑               ↑
              Partial Pickup      Full Pickup       Paid Off
              / Ship            / Ship
```

---

## Register: Loading Customer Transactions

### Transactions Button in Cart

Located in the **Cart toolbar** (next to Layaway toggle). Activates only when a customer is selected.

**Endpoint**: `GET /api/customers/{customer_id}/transaction-history`

Returns open transactions (status NOT IN 'fulfilled', 'cancelled', 'void_sale').

### TransactionLoadModal

Displays customer's open transactions with:
- Transaction total, balance due, status
- Rush badge (if is_rush)
- Due Date badge (if need_by_date within 4 days)

Actions per transaction:
- **Items** - View transaction line items
- **Pickup** - Load full transaction for in-store pickup
- **Ship** - Load full transaction for shipping

### Transaction Lines View

**Endpoint**: `GET /api/transactions/{transaction_id}`

Returns line items with:
- SKU, product name, variation
- Quantity, unit price, **unit cost** (Custom items allow manual entry of cost at booking; otherwise set at receipt)
- Fulfillment type (**special_order**, **custom**, **wedding_order**, **layaway**, **takeaway**)
- is_fulfilled flag

---

## Partial Fulfillment

The system supports **picking up or shipping individual items** from a multi-item transaction.

### Mark Items as Fulfilled

**Endpoint**: `POST /api/transactions/{transaction_id}/pickup`

```json
{
  "register_session_id": "uuid",
  "delivered_item_ids": ["uuid1", "uuid2"]
}
```

- Empty array = fulfill ALL items
- Non-empty array = fulfill only those specified

### Balance Recalculation

After pickup, `recalc_transaction_totals()` recomputes:
1. **Total price**: SUM(item price + tax × remaining qty) + shipping
2. **Balance due**: total_price - amount_paid
3. **Status**: fulfilled if all items fulfilled AND balance_due <= 0

**Server**: `server/src/logic/transaction_recalc.rs`

---

## Inventory Impact

At pickup (`POST /api/transactions/{transaction_id}/pickup`):

| Fulfillment Type | stock_on_hand | reserved_stock | on_layaway |
|-------------------|---------------|-----------------|------------|
| takeaway | -qty (done at checkout) | - | - |
| special_order | - | -qty | - |
| custom | - | -qty | - |
| wedding_order | - | -qty | - |
| layaway | - | - | -qty |

---

## Saved Card for Balance

When a transaction is created with Ship fulfillment, the customer can save a card for charging the balance at pickup.

### Storage

- Column: `transactions.stripe_payment_method_id`
- Migration: **142_transactions_and_fulfillment.sql**

### Checkout Flow

1. **TransactionReviewModal**: Select saved card OR enter new card
2. **Saved to transaction**: stripe_payment_method_id stored at checkout
3. **At pickup**: Charge saved card for remaining balance + shipping

---

## Transaction vs Pickup Workflows

### At Register (New Transactions)

```
Cart → Add Items → Select Customer → optional Ship current sale
     → Review Transaction (Rush/Due/Pickup release)
     → Payment → Transaction Created (Open)
```

### At Back Office (Existing Transactions)

```
Transactions Workspace → Find Customer's Transaction → Pickup OR Ship
    → Select Items (partial OK) → Mark Fulfilled
    → Inventory Adjusted → Balance Recalced → Status Updated
```

---

## QuickBooks Integration

### Revenue Recognition

Transactions are recognized as revenue at **fulfillment time** (not booking). See [`REPORTING_BOOKED_AND_FULFILLED.md`](REPORTING_BOOKED_AND_FULFILLED.md).

### Shipping Fees

- Stored in: `transactions.shipping_amount_usd`
- Included in transaction total at recalculation
- **Gap**: Not yet explicitly mapped in QBO journal (needs `income_shipping` mapping in `qbo_mappings`)

---

## Permission Keys

| Key | Use |
|-----|-----|
| `orders.view` | List transactions, read detail |
| `orders.modify` | Pickup, fulfill items |
| `orders.cancel` | Cancel transaction |

---

## Files

| File | Purpose |
|------|---------|
| `client/src/components/pos/TransactionLoadModal.tsx` | Customer transaction loader UI |
| `client/src/components/pos/TransactionReviewModal.tsx` | Transaction review before payment |
| `server/src/api/transactions.rs` | API: list_transactions, mark_transaction_pickup |
| `server/src/logic/transaction_recalc.rs` | Balance recalculation |
| `server/src/logic/transaction_checkout.rs` | Checkout with fulfillment fields |
| `migrations/142_transactions_and_fulfillment.sql` | stripe_payment_method_id column |

---

## Testing Checklist

- [ ] Transactions button disabled when no customer
- [ ] Transaction list shows Rush/Due badges
- [ ] Items view shows fulfillment status per line
- [ ] Partial pickup (some items) works
- [ ] Full pickup marks transaction fulfilled
- [ ] Balance recalculates after pickup
- [ ] Inventory decrements appropriately
- [ ] Card saved for future charges

---

## Known Gaps (Future Work)

| Gap | Description | Priority |
|----|-------------|----------|
| **QBO Shipping mapping** | Shipping fees not explicitly mapped in QBO journal (`income_shipping` missing in `qbo_mappings`) | Medium |
| **Push to POS** | No "Push to POS" button in Transactions workspace to send transaction to register | Medium |
| **Auto-charge at pickup** | Saved card not automatically charged for balance + shipping at pickup/release | Medium |
| **Shippo label integration** | No Shippo integration for generating shipping labels from ROS | Low |
