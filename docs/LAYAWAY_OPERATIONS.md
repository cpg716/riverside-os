# Layaway Operations — Riverside OS

Layaways allow customers to reserve in-stock items with a deposit and pay over time. This document covers the lifecycle, inventory impact, and financial handling of Layaways.

## Lifecycle

1. **Booking**: Cashier adds in-stock items to the cart and selects **Layaway**.
2. **Deposit**: Minimum 25% deposit required (Admin can override).
3. **Storage**: Items are moved to a physical Layaway shelf. Inventory system flags them as `on_layaway`.
4. **Payments**: Customer makes periodic payments at the POS via **Customer Hub → Payments**.
5. **Pickup**: Once the balance is zero, the customer picks up the item. Status moves to **Fulfilled**.
6. **Forfeiture**: If a layaway is abandoned, the deposit is forfeited, income is recognized as `forfeited_deposit`, and items return to floor stock.

## Management

Layaways can be managed from two locations:
- **POS**: Specialized **Layaway** workspace for quick access during shifts.
- **Back Office**: **Customers → Layaway Manager** for administrative tracking, payment auditing, and bulk status reviews.

## Inventory Impact

- **stock_on_hand**: Does **not** change when booked. The item is still in the store.
- **on_layaway**: Increments upon booking.
- **available_stock** (`stock_on_hand - reserved - layaway`): Decrements. Other customers/online store cannot buy this item.
- **Pickup**: `stock_on_hand` and `on_layaway` both decrement.

## Financials (Fulfilled-Recognition)

- **Initial Deposit**: Captured as a Liability (`liability_deposit`). No revenue or tax recognized.
- **Interim Payments**: Captured as Liability.
- **Final Pickup (Fulfillment)**:
    - Entire order value recognized as **Revenue**.
    - **Sales Tax** recognized.
    - Deposit liability is relieved.
- **Reporting**: Layaways only appear on Financial/Tax/Commission reports on the **Pickup Date**.

## Forfeiture Logic

If a customer fails to complete a layaway:
1. Manager cancels the order with reason **Forfeited**.
2. `on_layaway` count is released (decremented), making the item available for sale.
3. Funds in `liability_deposit` are moved to `income_forfeited_deposit` in the QBO Journal.
4. **No Refund** is issued.

## Staff Steps (POS)

### Creating a Layaway
1. Build cart.
2. Select **Layaway** from the toolbar.
3. Select/Add Customer (Required).
4. Pay minimum 25% deposit. To enter a custom deposit amount, type the exact dollar amount (e.g., `100`) on the payment keypad and tap **Apply deposit**. The **Pay balance** calculation will then instantly update to reflect what is owed today.
5. Apply cash or card payments to finalize the requested deposit balance.
6. Print Layaway receipt and tag the item for the storage shelf.

### Taking a Payment
1. Go to **Customers**.
2. Find Customer → **Orders** tab.
3. Select Open Layaway → **Make Payment**.

### Pickup
1. Complete final payment (Balance must be $0).
2. Toggle **Pickup Confirmed** in the checkout drawer.
3. Hand over items and complete transaction.

---
*Staff Manuals: [Layaway Manual](docs/staff/layaway-manual.md) | [Order Pickup Manual](docs/staff/order-pickup-manual.md)*
