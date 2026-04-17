---
id: pos-cart
title: "Register (cart and checkout)"
order: 1050
summary: "Comprehensive guide to the POS Register, including cart management, intelligent search, customer attachment, and the full checkout lifecycle."
source: client/src/components/pos/Cart.tsx
last_scanned: 2026-04-17
tags: pos, register, cart, checkout, payments, stripe, taxes, deposits
---

# POS Register (cart and checkout)

_Audience: Cashiers and sales staff._

**Where in ROS:** POS mode → left rail **Register** (cart icon).

**Related permissions:** Tender and drawer operations require an **open register session** and valid POS staff authentication. **Line discount %** is capped by each cashier’s **`staff.max_discount_percent`** (set on their **Staff → Team** profile; templates live under **Settings → Staff access defaults**).

**Multiple registers:** Your store may run **Register #1** (cash drawer) and **Register #2+** in the same **till shift**. Payments are tracked **per lane**; **one** physical drawer count happens at **Z** on **Register #1**, which closes the whole group. **Admins** opening POS from Back Office usually default to **#2**; **#2** cannot open until **#1** is open.

---

## How to use this screen

The **Register** tab is the **live cart**: search at top, line items in the middle, **totals** and **Complete Sale** / tender actions at the bottom (layout may vary slightly by screen size). The cart uses a **high-density horizontal layout** to maximize visibility: line items show product info on the left, fulfillment toggles in the center, and Qty/Sale controls on the right. **Green (emerald)** buttons are the primary **money** actions — read them carefully before tapping.

## Cashier for this sale

Before you **scan**, **search**, use the **numpad**, or tap **Pay**, the register shows a **full-screen sign-in step**. 

1. **Select Identity**: Choose your name from the **Staff Roster** dropdown. The system will remember your choice for your next sign-in on this device.
2. **Enter PIN**: Type your **4-digit PIN** to authorize the register for this sale. 

That person is recorded as the checkout **operator** for the transaction. **After you complete a sale**, you stay signed in as that cashier; use **Logout** or **Switch cashier** only if someone else should ring the next sale. This is separate from **who opened the drawer** (session) and separate from the **Salesperson** (assigned via the avatar-picker at top or on each line) used for commissions.

## Local draft cart (this device)

While the till is open, an **in-progress sale** is **saved in the browser** on this device (`localforage`, key `ros_pos_active_sale`, scoped to your **register session id**) **only after you have at least one line item** in the cart.

- If you **sign in** as cashier but **never add a line**, nothing is saved.
- **It stays** if you switch to another **POS sidebar** tab, **Exit POS mode**, or refresh — until you **clear the sale**, or the session ends.
- **It is not** the same as **Park**: **Park** is a **server** snapshot for intentional handoff.

## Adding items (intelligent search)

1. **Scan** a barcode or **type** SKU or keywords in the search field.
2. **Single match:** the line may drop in automatically.
3. **Multiple matches:** a **product / variation picker** opens — select the correct **size / color / style**.
4. **Custom Work Orders (MTM Light):** Type **`CUSTOM`** in the search field. A modal will open to select the **Item Type**, and collect the **Price**, **Need By Date**, and **Rush** status. These items are tracked as **Fulfillment Orders**.
5. **Recalling a Transaction:** Tap the **Transactions** button next to the customer search bar. This opens the **Transaction Loader**, where you can select specific items from their history to bring into the active cart for direct pickup or further payment.
6. **Fulfillment Requirements (Rush/Due Date):** Tap the **Zap (Options)** icon in the tool rail to open the **Transaction Review** screen. Set the **Need By Date**, toggle **Rush** status, and switch between **Pickup** and **Ship**.
7. **Quantity and price:** Use the on-screen **numpad**. 
    - **Quantity**: Type amount and tap **Qty**.
    - **Percentage Discount**: Select a line item, type the percentage (e.g. `20`), and tap **%**. 
    - **Manual Override**: Tap **$** to switch to price mode, type the new total unit price, and tap **Apply**. 
8. **Manager PIN Override**: If a discount exceeds your role's limit or you attempt to **Void All**, the **Manager PIN** modal will appear.

## Attaching a customer

1. Use **customer search** at the top of the right-hand rail. 
2. Tap the **customer strip** to open the **relationship hub** slideout (timeline, transactions, profile, etc.).
3. Use the **ruler / measurements** control on that strip when you only need **measurements**.

## Park (hold cart)

1. Use **Park** from the cart when the customer steps away or you must switch tasks.
2. If a parked cart exists for this lane, the register may prompt you to **Continue**, **start fresh**, or **clear parked**.
3. **Z-close** clears any carts still marked parked for lanes in that till group.

## Checkout (Complete Sale)

1. Review **subtotal**, **tax**, and **balance due** with the customer.
2. Tap **Pay** / **Complete Sale**. If special fulfillment is required, the **Transaction Review** screen will appear first.
3. **Tender:** choose the method, enter the amount on the keypad, then **Apply payment**. 
    - **Physical Checks**: Select the **CHECK** tab and enter the **Check #**.
4. **Stripe Unified Branding (Integrated Payments):**
   - **Saved Card**: Select **STRIPE VAULT** to charge a card on file. 
    - **Stripe Credit**: Select **STRIPE CREDIT** (on returns) to issue a credit back via the terminal.
5. **Audited Tax Exemptions:**
   - Tap the **Tax Exempt** toggle in the checkout drawer.
   - **Reason Required**: A valid reason (e.g. Resale) MUST be selected.
6. **Pennyless (Swedish Rounding):**
   - Applies to **CASH** transactions ONLY. Rounded to the nearest **$0.05**.
7. **Transactions / wedding transactions:** The ledger may include **Deposit (ledger)**. Tap **Apply deposit** to record the deposit amount. This reduces the "Balance to Pay" calculation.
8. **Receipt:** After tender, choose **Print**, **Email**, or **Text**. Close that screen only when the customer is fully finished.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Search returns no results** | Type SKU only; scan again; one slow second between scans. |
| **Picker won’t close** | Cancel or tap outside; clear search. |
| **Complete Sale disabled** | Check for missing customer, zero-total line, or needs deposit. |
| **Card stuck on connecting** | Wait full timeout once, then retry tender. |

---

## See Also
- [Inventory Back Office Manual](inventory-back-office-manual.md)
- [Stripe Payments & Vault](stripe-payments-manual.md)
- [Closing the Register (Z-Report)](pos-close-register-modal-manual.md)

**Last reviewed:** 2026-04-17

