# Rush & Due Date Implementation Plan

## Overview

Add ability to mark any order as Rush and set a Due Date. Track centrally in OrdersWorkspace. Access via POS for all staff.

## Data Model (EXISTING ✓)

Migration 119 already added:
- `orders.is_rush` BOOLEAN DEFAULT FALSE
- `orders.need_by_date` DATE
- `order_items.is_rush` BOOLEAN DEFAULT FALSE  
- `order_items.need_by_date` DATE

## Implementation Phases

### Phase 1: API Changes ✅ DONE

- [x] Add `PATCH /api/orders/{id}` endpoint to update `is_rush` and `need_by_date`
- [x] Ensure GET endpoints include these fields in responses

### Phase 2: Cart (POS) - Create/Edit Order ✅ DONE

- [x] Add "Rush" toggle in order header (near totals)
- [x] Add "Due Date" picker (prompt for YYYY-MM-DD)
- [x] Defaults: Rush OFF, Due Date empty

### Phase 3: Orders List Display ✅ DONE

- [x] Add Rush/Due Soon badges in OrdersWorkspace
- [x] Update pipeline stats: rush_orders, due_soon_orders

### Phase 4: POS Sidebar - Orders Tab ✅ DONE

- [x] Add "Orders" sidebar item in POS
- [x] Shows OrdersWorkspace with rush/due stats

### Phase 5: Audit Trail ✅ DONE

- [x] Log is_rush changes (staff_id, timestamp, old/new)
- [x] Log need_by_date changes
- [x] Log order creation with rush/due from Cart checkout

---

## Technical Details

### API: PATCH /api/orders/{order_id}

```json
{
  "is_rush": true|false,
  "need_by_date": "2026-04-20"
}
```

Requires: `orders.modify` permission

### Cart UI

- **Rush toggle**: Single checkbox on order header
- **Due Date**: Calendar picker, defaults to empty
- Touch-friendly: Large tap targets

### OrdersWorkspace Stats

Add to existing stats:
- `rush_orders`: WHERE is_rush = TRUE
- `due_soon_orders`: WHERE need_by_date <= now + 4 days

---

## Files to Modify

| File | Change |
|------|--------|
| `server/src/api/orders.rs` | Add PATCH handler |
| `server/src/logic/order_list.rs` | Update queries |
| `client/src/components/pos/Cart.tsx` | Add Rush/Due UI |
| `client/src/components/orders/OrdersWorkspace.tsx` | Add badges/filters |
| `client/src/components/layout/PosSidebar.tsx` | Add Orders tab |
| `client/src/components/pos/PosShell.tsx` | Add Orders route |

---

## Testing

1. Create order → mark Rush → save → verify in database
2. Create order → set Due Date → save → verify in database  
3. View in OrdersWorkspace → badges display correctly
4. POS Orders tab → shows Rush/Due Soon counts
5. Audit log → entries created on changes