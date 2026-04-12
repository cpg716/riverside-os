# Order Review Flow - Implementation Plan

## Status: COMPLETED v0.1.9 ✅

Executive Summary: Checkout flow includes explicit Order Review step before payment - allows cashier to set Rush/Due Date/Shipping for order items.

## Current vs. Target Flow

### Target (Implemented)
```
Cart → [Has Order Items?] → YES → ORDER REVIEW MODAL → Payment
                ↓ NO (takeaway only) → Direct to Payment
                
Also: Require customer if order items exist
```

## Phase 1: Remove Phase 2 Additions (Cleanup) ✅ DONE

Removed from Cart.tsx:
- isRush state, needByDate state
- Flame/Calendar icon imports
- Rush/Due buttons from totals bar
- isRush/needByDate from checkout payload

## Phase 2: Create OrderReviewModal ✅ DONE (v0.1.9)

**Created**: client/src/components/pos/OrderReviewModal.tsx

- Shows order items (non-takeaway only)
- Rush toggle
- Due Date calendar picker
- Pickup vs Ship toggle
- Shipping address form
- Save card for future charges

Props:
- isOpen, onClose, items (non-takeaway), customer, onComplete
- onComplete returns: {isRush, needByDate, fulfillment: pickup|ship, shipTo?, storeCardForBalance?}

UI Components:
1. Header: "Review Order" + item count
2. Order Items List: SKU, Name, Variation, Price
3. Priority: Rush toggle, Due Date calendar
4. Fulfillment: Pickup vs Ship toggle (Ship shows address form)
5. Continue Button

## Phase 3: Wire OrderReviewModal in Cart ✅ DONE

- Import component
- Add state: orderReviewOpen, orderOptions
- Modify Pay button: if orderItems exist → Show OrderReviewModal
- Filter: orderItems = lines.filter(l => l.fulfillment !== 'takeaway')

## Phase 4: Reorder Customer Rail ✅ DONE

- Customer Search → TOP
- Walk-in → BELOW (showWalkInOption moved)

## Phase 5: Require Customer for Order Items ✅ DONE

- if orderItems.length > 0 require selectedCustomer

## Phase 6: Stripe Integration for Shipped Orders ✅ DONE

- When Ship selected: Save card option in OrderReviewModal
- Store stripe_payment_method_id in order for future charges

## Phase 7: Server-Side Updates ✅ DONE (Migration 132)

Add to checkout:
- fulfillment_mode, ship_to, stripe_payment_method_id columns
- Migration 132 adds stripe_payment_method_id to orders table

## Testing Checklist

- [x] Pay with takeaway only → Direct to payment
- [x] Pay with order items → Shows Order Review
- [x] Rush toggle works
- [x] Due Date picker works
- [x] Pickup vs Ship toggle works
- [x] Ship requires address
- [x] Order items require customer
- [x] Customer search FIRST, Walk-in SECOND
- [x] Card saved for future charges

## Files Modified (v0.1.9)

| File | Change |
|------|--------|
| Cart.tsx | Wire OrderReviewModal, orders button |
| OrderReviewModal.tsx | NEW |
| OrderLoadModal.tsx | NEW - load customer's orders |
| CustomerSelector.tsx | Walk-in to bottom |
| orders.rs | by-customer endpoint, order-items |
| order_checkout.rs | New payload fields |
| order_recalc.rs | Balance recalc logic |
| migrations/132_*.sql | stripe_payment_method_id column |

---

## Related: Register Order Loading

See `docs/ORDER_FULFILLMENT_AND_PICKUP.md` for:
- Orders button in Cart (next to Layaway)
- Partial fulfillment by item
- Pickup/Ship inventory impact
- Saved card at checkout for balance charging