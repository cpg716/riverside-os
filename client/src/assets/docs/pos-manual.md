---
id: pos
title: "Register (POS)"
order: 0
summary: "Opening the till, dashboard, ringing sales, suit swap, checkout, wedding lookup."
tags: pos, register, checkout
---

# Register (POS) — staff guide

This guide covers day-to-day use of the in-store register: opening the till, the home dashboard, ringing sales, swapping a suit on an existing order, and taking payment.

---

## What this is

Use **Register (POS)** for live selling, shift-ready lane work, and same-station checkout.

This is the staff workflow for:

- opening the register lane
- moving between the dashboard and the live cart
- ringing normal sales
- handling supported swap and wedding lookup tasks
- taking payment and finishing receipt delivery

## When to use it

Use this guide when a staff member is working a live register station.

- Use **POS → Register** for active selling.
- Use **POS → Dashboard** for shift context between customers.
- Move to the dedicated **Orders**, **Customers**, or **Reports** manuals when the task leaves live checkout.

## Cashier Sign-In

To ensure sales are attributed to the correct staff member, Riverside OS uses a **touch-grid sign-in** system.

1. **Select Your Name**: When starting a sale or changing sessions, tap your avatar/name from the scrollable grid.
2. **Enter PIN**: Type your 4-digit code.
3. **Continue**: Unlock the register.

If you are already logged in but a different staff member needs to ring a sale, they can tap the **Lock** or **User** icon to bring up the sign-in overlay without closing the current register session.

Cashier sign-in records who operated the register. It is separate from **Salesperson** attribution for commissions. Before completing payment, every merchandise, alteration, special-order, custom-order, and wedding-order sale line must have a default Salesperson or a line-level Salesperson. Gift-card-load-only and RMS Charge payment-only flows do not use salesperson attribution.

---

## Open the register workspace

**Option A — from the main menu:** Sign in, then select **Register POS** in the left rail. The screen switches to the register layout (narrow POS sidebar and register tools).

**Option B — direct address:** After you are signed in, you can open the same workspace with the `/pos` address on your store server (for example, if someone shares a link for training).

You must **open the register drawer** when prompted (lane, opening float, and **Open register**) before you can ring sales. The Windows register now shows a **Station Readiness** panel first so you can confirm API reachability and receipt-printer connectivity before customer checkout begins. If the till is already open for your shift, you go straight to the dashboard or register screen.

![Register dashboard after the till is open](../images/help/pos/register-dashboard.png)

---

## Dashboard

When the drawer is active, you often land on **Dashboard**. Here you can see shift-friendly summaries and shortcuts. To ring items, switch to **Register** in the POS sidebar (shopping cart icon).

---

## Ring a sale (Register)

1. Select **Register** in the left POS sidebar.
2. Click in the **product search** field at the top of the sale. The field should auto-focus when the register opens.
3. **Scan a barcode** or **type a SKU**, then press **Enter**.
4. If the system asks you to choose a size or variation, pick the correct line and confirm.
5. Repeat for each item. The cart lists each line with quantity and price.

![Cart with items added](../images/help/pos/cart-with-lines.png)

**Tips**

- Attach a customer or wedding party when your store requires it for the sale.
- If scanner input lands in the wrong field after switching tabs or returning to the register, use **Focus /** next to the product search field, or press **/** on a keyboard station, and scan again.
- Use on-screen actions for discounts or notes only when your manager has shown you how.

## What to watch for

- Confirm the correct staff identity before you start the sale.
- Open the correct register lane before serving customers.
- Do not guess between takeaway, order, and wedding handling if the drawer is asking for a fulfillment decision.
- Treat receipt printer failures as delivery issues only after the sale already succeeded.

---

## Exchange / return

Use this when a customer is exchanging or returning items tied to a completed transaction. The wizard keeps the return, replacement sale, manager approval, and register-session checks together.

1. On the **Register** screen, select **Exchange / Return**.
2. Search or enter the completed transaction.
3. Choose the line being returned or exchanged.
4. Follow the wizard instructions for refund, replacement sale, or manager approval.
5. Complete any replacement checkout before handing the customer their final receipt.

Inventory and bookkeeping follow server rules for takeaway, order, and wedding lines; ask a lead if you are unsure.

---

## Checkout and payment (payment ledger)

1. When the cart is correct, select **Proceed to Payment**.
2. If you are not using a saved customer, confirm **walk-in** when asked.
3. The **Payment ledger** side panel opens. Enter amounts on the keypad, then **Apply payment** for each tender (card, cash, gift card, etc.) the way you were trained.
    - **Physical Checks**: When a customer pays by check, select the **CHECK** tab and enter the **Check #** in the input field before pressing **Apply Payment**.
4. On **Order / Wedding** sales, the ledger may show **Deposit release** — use **Apply deposit** below **Apply payment** when your store records a deposit on the keypad. **Split deposit (wedding party)** opens wedding lookup in group-pay mode to allocate amounts across members. **Takeaway** items (walk out today) must be covered with regular tenders first; deposit and **open deposit** apply to order balances, not unpaid takeaway. If the linked customer has a **party deposit** waiting, you may be asked to apply it to this sale.
5. When the sale is balanced (or deposit-only when the UI allows, including mixed takeaway + order lines once takeaway is paid), finish using **Complete Sale**. If Riverside asks for a Salesperson, return to the cart and select one before finalizing.
6. After the sale completes, the **Receipt Summary** screen opens. If printing fails, Riverside now shows that the **sale still succeeded** and gives you **Retry** and **Check station printer** actions.
7. Close the panel with **Close drawer** when you are done.
8. If you need to hold the transaction for another cashier, use **Park Sale** and enter the label in the Riverside prompt instead of a browser dialog.

![Payment ledger during checkout](../images/help/pos/nexo-checkout-drawer.png)

## Receipt delivery

The **Sale Complete** screen is the receipt handoff point after checkout. Use it to print the customer receipt, view the formatted receipt, send by text or email when a customer is attached, or print a gift receipt when needed.

![Sale complete receipt actions](../images/help/pos/receipt-summary.png)

Select **View Receipt** to inspect the same formatted receipt layout used for customer delivery and the report-printer view.

---

## Wedding lookup

From **Register**, select **Wedding** to open the wedding lookup panel. Search or pick the party you need, then use the on-screen actions your manager defined. Press **Escape** to close when finished.

---

## What happens next

After checkout, staff should either:

- finish receipt delivery from the receipt summary screen
- return to **Dashboard** or **Register** for the next customer
- move into the related order, wedding, or customer workflow when follow-up work is needed

---

## Related workflows
- [Reports (curated)](manual:reports)
- [Insights (Metabase)](manual:insights)
- [Register Reports](manual:pos-register-reports)
