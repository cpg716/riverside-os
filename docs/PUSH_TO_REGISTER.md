# Push to Register — Riverside OS

The Push to Register feature allows staff to seamlessly transition an order from the Orders workspace to the POS register for completion of payment and fulfillment. This streamlines the workflow for orders that are ready for pickup or shipment.

## Overview

When an order has items ready for fulfillment (not yet fulfilled), staff can "push" the order directly to the register from the Orders workspace. This:
- Navigates to the POS register
- Loads the order details (items, customer, saved card info) into the cart
- Prefills saved card selection if available
- Allows deposit allocation during checkout
- Provides clear UI feedback about the loaded order

## Staff Steps

### From Orders Workspace

1. **Locate an order** with unfulfilled items in the Orders workspace
2. **Click the "Push to Register"** button (appears only for orders with 1+ unfulfilled items)
3. **System automatically**:
   - Navigates to `/pos?order_id=<ORDER_ID>`
   - Loads order items into the cart
   - Sets the customer from the order
   - Detects if a saved card is available
   - Shows order loaded badge with clear option

### At the Register

1. **Review loaded order**:
   - Order items appear in the cart
   - Customer is pre-selected
   - Saved card is pre-selected in payment modal (if available)
   - Order loaded badge shows in header

2. **Complete checkout normally**:
   - Apply any deposits (per transaction, not per line)
   - Choose payment method (saved card pre-selected if available)
   - Complete payment as usual

3. **Clear loaded order** (optional):
   - Click the "X" on the order loaded badge to clear the cart and reset
   - Or proceed with checkout which clears on completion

## Technical Implementation

### URL Parameter Approach
- Uses `/pos?order_id=<ORDER_ID>` for pushing orders
- URL parameter is cleared after successful load to prevent reprocessing

### Data Flow
1. **OrdersWorkspace**: Detects orders with unfulfilled items, adds Push to Register button
2. **Cart.tsx**: 
   - Detects `order_id` URL parameter
   - Fetches order details from `/api/orders/{order_id}`
   - Fetches order line items from `/api/orders/order-items/{order_id}`
   - Merges order lines into existing cart (preserves current items)
   - Sets customer from order data
   - Prepares saved card prefilling for OrderReviewModal
3. **OrderReviewModal**: 
   - Displays saved card selection when `stripe_payment_method_id` is present
   - Allows cashier to confirm shipping address and save card for balance
4. **NexoCheckoutDrawer**:
   - Receives pre-selected saved card ID via `preSelectedSavedCardId` prop
   - Auto-selects the saved card in the "Saved Card" tab when available

### UI Feedback
- **Order Loaded Badge**: Shows in cart header with order ID and clear option
- **Toast Notification**: Confirms successful order load with item count
- **Saved Card Prefilling**: Automatic selection in payment modal
- **Clear Option**: Button to reset cart and remove loaded order state

## Business Rules

1. **Only applicable** to orders with 1+ unfulfilled items
2. **Preserves existing cart** items when loading order (adds to current cart)
3. **Deposit allocation** happens per transaction, not per line item
4. **Saved card** is not auto-charged - cashier must manually select to use during payment
5. **Balance calculation** correctly reflects: order total - applied deposits - amount paid = amount due
6. **URL cleanup** prevents accidental reloading on page refresh
7. **Error handling** shows toast notification if order loading fails

## Related Components

- `client/src/components/orders/OrdersWorkspace.tsx` - Push to Register button
- `client/src/components/pos/Cart.tsx` - Order loading logic, URL handling, UI feedback
- `client/src/components/pos/OrderReviewModal.tsx` - Saved card prefilling
- `client/src/components/pos/NexoCheckoutDrawer.tsx` - Saved card auto-selection

## Permissions
- Uses standard POS authentication via `mergedPosStaffHeaders`
- No additional permissions required beyond standard POS access