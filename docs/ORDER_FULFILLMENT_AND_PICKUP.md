# Order Fulfillment, Pickup, and Shipping

Operational reference for **register** flows: loading customer orders, partial fulfillment, pickup, and shipping. Updates from v0.1.9.

## Overview

```
Customer Order Lifecycle:
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Booked   │───→│ In       │───→│ Fulfilled│───→│ Closed   │
│         │    │ Progress │    │         │    │         │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                     ↑                 ↑               ↑
              Partial Pickup      Full Pickup       Paid Off
              / Ship            / Ship
```

---

## Register: Loading Customer Orders

### Orders Button in Cart

Located in the **Cart toolbar** (next to Layaway toggle). Activates only when a customer is selected.

**Endpoint**: `GET /api/orders/by-customer/{customer_id}`

Returns open orders (status NOT IN 'fulfilled', 'cancelled', 'void_sale').

### OrderLoadModal

Displays customer's open orders with:
- Order total, balance due, status
- Rush badge (if is_rush)
- Due Date badge (if need_by_date within 4 days)

Actions per order:
- **Items** - View order line items
- **Pickup** - Load full order for in-store pickup
- **Ship** - Load full order for shipping

### Order Items View

**Endpoint**: `GET /api/orders/order-items/{order_id}`

Returns line items with:
- SKU, product name, variation
- Quantity, unit price
- Fulfillment type (special_order, wedding_order, layaway, takeaway)
- is_fulfilled flag

---

## Partial Fulfillment

The system supports **picking up or shipping individual items** from a multi-item order.

### Mark Items as Fulfilled

**Endpoint**: `POST /api/orders/{order_id}/pickup`

```json
{
  "register_session_id": "uuid",
  "delivered_item_ids": ["uuid1", "uuid2"]
}
```

- Empty array = fulfill ALL items
- Non-empty array = fulfill only those specified

### Balance Recalculation

After pickup, `recalc_order_totals()` recomputes:
1. **Total price**: SUM(item price + tax × remaining qty) + shipping
2. **Balance due**: total_price - amount_paid
3. **Status**: fulfilled if all items fulfilled AND balance_due <= 0

**Server**: `server/src/logic/order_recalc.rs`

---

## Inventory Impact

At pickup (`POST /api/orders/{order_id}/pickup`):

| Fulfillment Type | stock_on_hand | reserved_stock | on_layaway |
|-------------------|---------------|-----------------|------------|
| takeaway | -qty (done at checkout) | - | - |
| special_order | - | -qty | - |
| wedding_order | - | -qty | - |
| layaway | - | - | -qty |

---

## Saved Card for Balance

When an order is created with Ship fulfillment, the customer can save a card for charging the balance at pickup.

### Storage

- Column: `orders.stripe_payment_method_id`
- Migration: **132_order_stripe_payment_method.sql**

### Checkout Flow

1. **OrderReviewModal**: Select saved card OR enter new card
2. **Saved to order**: stripe_payment_method_id stored at checkout
3. **At pickup**: Charge saved card for remaining balance + shipping

---

## Order vs Pickup Workflows

### At Register (New Orders)

```
Cart → Add Items → Select Customer → Review Order (Rush/Due/Ship)
     → Payment → Order Created (Open)
```

### At Back Office (Existing Orders)

```
Orders Workspace → Find Customer's Order → Pickup OR Ship
    → Select Items (partial OK) → Mark Fulfilled
    → Inventory Adjusted → Balance Recalced → Status Updated
```

---

## QuickBooks Integration

### Revenue Recognition

Orders are recognized as revenue at **fulfillment time** (not checkout). See `docs/BOOKED_VS_FULFILLED.md`.

### Shipping Fees

- Stored in: `orders.shipping_amount_usd`
- Included in order total at recalculation
- **Gap**: Not yet explicitly mapped in QBO journal (needs `income_shipping` mapping in `qbo_mappings`)

---

## Permission Keys

| Key | Use |
|-----|-----|
| `orders.view` | List orders, read detail |
| `orders.modify` | Pickup, fulfill items |
| `orders.cancel` | Cancel order |

---

## Files

| File | Purpose |
|------|---------|
| `client/src/components/pos/OrderLoadModal.tsx` | Customer order loader UI |
| `client/src/components/pos/OrderReviewModal.tsx` | Order review before payment |
| `server/src/api/orders.rs` | API: list_customer_orders, mark_order_pickup |
| `server/src/logic/order_recalc.rs` | Balance recalculation |
| `server/src/logic/order_checkout.rs` | Checkout with fulfillment fields |
| `migrations/132_order_stripe_payment_method.sql` | stripe_payment_method_id column |

---

## Testing Checklist

- [ ] Orders button disabled when no customer
- [ ] Order list shows Rush/Due badges
- [ ] Items view shows fulfillment status per line
- [ ] Partial pickup (some items) works
- [ ] Full pickup marks order fulfilled
- [ ] Balance recalculates after pickup
- [ ] Inventory decrements appropriately
- [ ] Card saved for future charges

---

## Known Gaps (Future Work)

| Gap | Description | Priority |
|----|-------------|----------|
| **QBO Shipping mapping** | Shipping fees not explicitly mapped in QBO journal (`income_shipping` missing in `qbo_mappings`) | Medium |
| **Push to POS** | No "Push to POS" button in Orders workspace to send order to register | Medium |
| **Auto-charge at pickup** | Saved card not automatically charged for balance + shipping at pickup/release | Medium |
| **Shippo label integration** | No Shippo integration for generating shipping labels from ROS | Low |