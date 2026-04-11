# Orders and Wedding Orders — Riverside OS

Special Orders and Wedding Orders allow customers to purchase items that are not fulfilled immediately as floor takeaway. These items may need to be ordered from a vendor, manufactured, or reserved specifically for an event. 

This document covers their lifecycle, inventory impact, financial handling, and differences compared to standard Layaway orders.

## Overview and Differences from Layaways
* **Layaways**: Placed on entirely **in-stock** floor items. The item is immediately removed from floor availability and set aside on a layaway shelf.
* **Orders**: Placed for items that might **not** currently be in stock, requiring procurement. Revenue is deferred until the items physically arrive, are assigned to the customer, and are fulfilled.
* **Wedding Orders**: Function exactly like Orders but are strictly tied to a `wedding_party` and specific event timelines. They enforce additional workflows such as required fittings, group-pay capabilities, and component swapping.
* **Custom Work Orders (MTM Light)**: Specifically for items that don't exist in the catalog yet (SUITS, SHIRTS, etc.). Triggered by the `CUSTOM` SKU prefix, they allow for variable pricing and custom item type selection at the point of sale. 

---

## Lifecycle

1. **Booking**: The cashier builds the cart. If the purchase requires items to be secured for a future pickup date without decrementing floor stock immediately, they designate the lines as **Order** or **Wedding Order**.
2. **Deposit**: The cashier can require a deposit up front. The POS register allows cashiers to specify the requested deposit down payment.
3. **Procurement**: The items enter the procurement pipeline. Management views open orders and issues POs out to vendors for these goods. For **Custom Work Orders**, the item type (e.g., "SUITS") and any rush requirements (Need-By Date) are prioritized in the procurement queue.
4. **Reserving Stock**: When goods arrive via receiving, they automatically or manually allocate into **Reserved Stock** linked to this specific order.
5. **Collection/Fulfillment**: Once all items are reserved and prepped, the customer is notified. They pay the remaining balance, the goods are handed over, and the order is marked **Fulfilled**.

---

## Inventory Impact

Unlike standard takeaway sales, Orders and Wedding orders follow a delayed inventory protocol to protect operational accuracy:

- **stock_on_hand**: Does **not** decrement at the time of booking.
- **pipeline / open order quantity**: Increments, showing management the pending demand that needs to be filled.
- **reserved**: Once inventory is procured and assigned to this exact customer, it transitions into `reserved` stock. It is physically in the store but cannot be sold to anyone else.
- **Fulfillment**: At the moment of physical handover to the customer, both `stock_on_hand` and `reserved` quantities are decremented simultaneously.

---

## Financials (Fulfilled-Recognition)

Riverside OS strictly adheres to a **fulfilled-recognition** model for Orders and Wedding orders to ensure accurate tax and commission data:

- **Initial Deposit**: Captured purely as a Liability (`liability_deposit`) on the balance sheet. No revenue or sales tax is recognized on the day of the deposit.
- **Interim Payments**: Captured as Liability against the customer account.
- **Final Pickup (Fulfillment)**:
    - Entire order value is recognized as **Revenue**.
    - **Sales Tax** is recognized and due for the period surrounding pickup.
    - Deposit liability is relieved against the revenue.
    - **Commissions**: Staff sales commissions trigger based on the actual fulfillment date, not the initial booking date. 

---

## Staff Steps (POS)

### 1. Booking & Setting Deposits
When a customer intends to order items:
1. Build the cart and select the **Order** (or **Wedding**) layout.
2. Select/Add the Customer (Required).
3. If taking a partial deposit today: Type the agreed-upon deposit amount on the payment keypad (e.g., `100`), then tap **Apply deposit**.
4. The remaining **Balance to Pay** instantly drops to match the deposit amount requested. Complete the checkout using normal cash or card tender.
5. Provide the customer with the printed Order receipt detailing their deposit and remaining ledger balance.

### 2. Group Payouts (Wedding Only)
Wedding orders support localized splitting. Tapping **Split deposit (wedding party)** opens the group pay mode. A single groom or sponsor can pay multiple deposits or full balances for groomsmen dynamically in one unified transaction.

### 3. Custom Work Orders & MTM
For items requiring variable pricing or custom creation:
1. Scan or type a SKU starting with **`CUSTOM`** (e.g., `CUSTOM-SUIT`).
2. A configuration popup will appear. Select the **Item Type** (SUITS, SPORT COAT, SLACKS, INDIVIDUALIZED SHIRTS).
3. Enter the **Sale Price** agreed upon for this custom item.
4. Set a **Need By Date** and toggle **Rush Order** if the item needs expedited handling.
5. Toggle **Gift Wrap** if the item requires final presentation packaging.

### 4. Rush & Urgency
Orders marked as **Rush** or possessing a **Need By Date** within the next 48-72 hours are automatically prioritized in the **Register Dashboard**'s "Suggested next" queue. This ensures fulfillment teams see critical deadlines first.

### 5. Order Arrival & Fulfillment
1. Management receives the PO, putting the items into **Reserved**.
2. When the customer arrives, pull up their order via the **Customers** or **Weddings** hubs.
3. If a ledger balance remains, tap **Make Payment** and tender the outstanding total so the remaining balance is `$0.00`.
4. Toggle **Pickup Confirmed** to mark the lines as fulfilled, simultaneously turning liability into recognized revenue.
