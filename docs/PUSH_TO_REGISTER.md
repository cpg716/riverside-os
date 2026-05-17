# Push to Register — Riverside OS

The Orders workspace opens unfulfilled Special, Custom, and Wedding order work in POS so staff can review lifecycle and, when needed, copy its unfulfilled lines into a new register sale. The backing sale remains a **Transaction Record**.

## Overview

When staff open an order in POS, Riverside:
- navigates to the register
- keeps the original Transaction Record visible while the unfulfilled order work stays in Orders for balance and pickup follow-up
- lets staff review the order lines and lifecycle state
- allows staff to copy unfulfilled lines into a new register sale if they need to rebuild the sale in POS

## Staff Steps

### From Orders Workspace

1. **Locate the unfulfilled order work** in the Orders workspace.
2. **Click the "Open in POS"** button.
3. **System automatically**:
   - navigates to the POS register
   - keeps the original fulfillment work available for review
   - lets staff copy unfulfilled lines into a new register sale if needed

### At the Register

1. **Review the order work first**:
   - confirm the balance due
   - confirm whether the order is still waiting on measurements, still carrying a deposit, fully paid, or already picked up
   - confirm Wedding party/member context when applicable

2. **If needed, copy unfulfilled lines into the register**:
   - this starts a **new** register sale
   - it does **not** collect payment on the original Transaction Record

3. **Keep the original Transaction Record authoritative**:
   - original deposits and balances stay on the original Transaction Record
   - pickup follow-up stays on the original fulfillment work
   - Wedding follow-up stays tied to the linked member

## Technical Implementation

### Data Flow
1. **OrdersWorkspace** opens the order in POS.
2. **Order loader / POS review** reads the real transaction detail and line items from the live transactions API.
3. **Copy to Register** only copies unfulfilled lines into a new cart when staff explicitly choose that action.

### UI Feedback
- **Lifecycle note**: Shows whether the order is still carrying a deposit, fully paid, waiting on measurements, or already complete
- **Copy warning**: Reminds staff that copying lines starts a new sale and does not post payment to the original Transaction Record

## Business Rules

1. The original Transaction Record remains the source of truth for the sale, deposits, payments, refunds, and balance.
2. Orders are only the unfulfilled Special, Custom, and Wedding fulfillment work inside that Transaction Record.
3. Copying lines into POS is optional and explicit.
4. Copying lines creates a new register sale; it is not a silent payment allocation against the original Transaction Record.
5. Staff should confirm receiving/pickup readiness before collecting final payment.

## Related Components

- `client/src/components/orders/OrdersWorkspace.tsx` - Push to Register button
- `client/src/components/pos/Cart.tsx` - POS copy-to-register behavior
- `client/src/components/pos/OrderLoadModal.tsx` - Order review and lifecycle display

## Permissions
- Uses standard POS authentication via `mergedPosStaffHeaders`
- No additional permissions required beyond standard POS access
