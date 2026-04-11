# POS Register (cart and checkout)

**Audience:** Cashiers and sales staff.

**Where in ROS:** POS mode → left rail **Register** (cart icon).

**Related permissions:** Tender and drawer operations require an **open register session** and valid POS staff authentication. **Line discount %** is capped by each cashier’s **`staff.max_discount_percent`** (set on their **Staff → Team** profile; templates live under **Settings → Staff access defaults**).

**Multiple registers:** Your store may run **Register #1** (cash drawer) and **Register #2+** in the same **till shift**. Payments are tracked **per lane**; **one** physical drawer count happens at **Z** on **Register #1**, which closes the whole group. **Admins** opening POS from Back Office usually default to **#2**; **#2** cannot open until **#1** is open. Details: **[Till group](../TILL_GROUP_AND_REGISTER_OPEN.md)**.

---

## How to use this screen

The **Register** tab is the **live cart**: search at top, line items in the middle, **totals** and **Complete Sale** / tender actions at the bottom (layout may vary slightly by screen size). **Green (emerald)** buttons are the primary **money** actions — read them carefully before tapping.

## Cashier for this sale

Before you **scan**, **search**, use the **numpad**, or tap **Pay**, the register shows a **full-screen cashier step** and asks for **your 4-digit staff code** (**Cashier for this sale**). That person is recorded as the checkout **operator** for the transaction. **After you complete a sale**, you stay signed in as that cashier so you can finish **receipt** steps (below); use **Switch cashier** when the cart is empty if someone else should ring the next sale. Clearing the cart or starting a new sale does **not** by itself sign you out. This is separate from **who opened the drawer** (session) and separate from the **Salesperson** line used for commissions.

## Local draft cart (this device)

While the till is open, an **in-progress sale** is **saved in the browser** on this device (`localforage`, key `ros_pos_active_sale`, scoped to your **register session id**) **only after you have at least one line item** in the cart (lines, linked customer, shipping selection, default salesperson, and cashier-for-sale).

- If you **sign in** as cashier but **never add a line**, nothing is saved. **Refresh** or **returning** to this screen may ask for **Cashier for this sale** again.
- **It stays** if you switch to another **POS sidebar** tab (Dashboard, Inventory, Settings, etc.), **Exit POS mode** to Back Office, or refresh — until you **clear the sale**, or the saved snapshot does not match the current register session (e.g. different lane/session). **Cashier-for-this-sale** is reset when the **register session** changes, not on every cart clear.
- **It is not** the same as **Park** (below): **Park** is a **server** snapshot for intentional handoff; the local draft is automatic recovery for the same session/device.

Staff-facing details for engineers: **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)** (parked vs local draft).

## Adding items (intelligent search)

1. **Scan** a barcode or **type** SKU or keywords in the search field.
2. **Single match:** the line may drop in automatically.
3. **Multiple matches:** a **product / variation picker** opens — select the correct **size / color / style**; wrong selection causes return work later.
4. **Search suggestions:** keyword matches may list **best‑selling styles first** (recent store sales by product), then alphabetically — so common names like “suit” still surface many **different** products, not only one matrix with many sizes.
5. **Custom Work Orders (MTM Light):** To book a custom garment (Suits, Sport Coats, Slacks, or Individualized Shirts), type **`CUSTOM`** in the search field as the SKU. A modal will open to select the **Item Type**, and collect the **Price**, **Need By Date**, and **Rush** status. These items are tracked as Special Orders.
6. **Wrong size after adding?** Tap the **product name** on the line (not only the SKU chip). If that style has multiple sizes/options, the **variation picker** opens again so you can **swap** the line without removing it; if there is only one SKU, a **review / price** panel may open instead.
7. **Cart Item Toggles:** Each line in the cart now includes quick toggles for **Gift Wrap** (blue wrapping icon) and **Rush** (orange/red clock icon). Tapping these updates the fulfillment priority immediately.
8. **Quantity and price:** use the on-screen **numpad**; **%** discount and **$** override only if your role allows; if blocked, call a manager for **override**.
7. Confirm the **line total** matches what you told the customer.

**R2S payment on the customer’s outside charge (not a normal sale):** When the customer is paying down an **R2S-managed** balance (not store credit, not a new purchase), type **`PAYMENT`** in the product search. Select **RMS CHARGE PAYMENT**, attach the **customer**, enter the **amount** on the **Price** numpad (no tax on this line; no loyalty points on this transaction type). Complete the sale with **Cash** or **Check** only (other tenders are hidden for this flow). **Sales Support** gets a **task** to confirm the payment was posted in the **R2S** portal — complete it per SOP. Details: **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.

**Special orders:** Lines that are **not** takeaway fulfillment typically do **not** reduce on-hand stock at checkout; **takeaway** items decrement stock at sale time. The system may allow **negative on-hand** when policy permits oversell. Do not promise same-day pickup unless the line type and notes say so.

## Attaching a customer

Attach **before** completing tax-sensitive or loyalty-linked sales if your SOP requires it:

1. Use **customer attach** / search from the cart (exact control label on your build).
2. With a customer on the sale, tap the **customer strip** to open the **relationship hub** slideout (same hub as Back Office — timeline, orders, profile, and more where your role allows). Use the **ruler / measurements** control on that strip when you only need **measurements**, not the full hub.
3. **Load more** if the list is long; try **last name + phone** if name is common.
4. If **duplicate profiles** appear, **do not merge** at the register unless trained — pick the profile the store uses for that person or get a manager.

**Employee pricing:** If the attached customer is your **linked employee CRM profile** (set by an admin on **Staff → Team**), new lines default to **employee price** when the catalog provides it; checkout still validates prices against allowed tiers.

## Park (hold cart)

Your store may offer **Park** to save the **current cart** on the **server** (not just this browser) while the register session stays open. Use **Park** when you need a **named, auditable** hold or to work across devices; the **local draft** (above) still helps if you only switched screens on the same device.

1. Use **Park** from the cart when the customer steps away or you must switch tasks.
2. If a parked cart exists for this lane, the register may prompt you to **Continue**, open the **parked list**, **start fresh**, or **clear parked** — follow on-screen choices and store SOP.
3. **Z-close** (end of shift on **Register #1**) clears any carts still marked parked for lanes in that till group; retrieve or complete sales before close when possible.

Technical reference for engineers and leads: **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.

## Checkout (Complete Sale)

1. Review **subtotal**, **tax**, and **balance due** with the customer.
2. Tap **Pay** / **Complete Sale** (or equivalent green action) to open the **payment ledger**.
3. **Tender:** choose the method, enter the amount on the keypad, then **Apply payment** for each tender before finalizing. Enter cash, swipe/tap card, gift card, or **split** tenders per training. Wait for **approved** state on card; do not hand back change until tender is confirmed on screen. The **keypad** stays fixed in the payment panel — scroll only affects the tender and balance area above it if the screen is very short.
4. **Special / wedding orders (when shown):** The balance ledger may include **Deposit (ledger)**. Use the same keypad, then tap **Apply deposit** (below **Apply payment**) to record the deposit amount the customer pledges to pay today. This instantly reduces the "Balance to Pay" calculation down to just the requested deposit (+ any immediate takeaway goods). Once the balance is updated, use **Apply payment** via cash/card to fulfill the deposit target. **Split deposit (wedding party)** opens wedding lookup in **group pay** mode so one payer can split amounts across members (same as **Wedding** → party → **Enter Group Pay**). If your sale is **order lines only** (no take-home items) and you are **not** using a split wedding payout list, you may be able to tap **Complete Sale** with **only** a deposit set — follow store policy.
5. **Store date and time** next to **Salesperson** is a live clock in the store’s receipt timezone; the **printed receipt time** is the time the server records when the sale completes.
6. **Receipt:** after tender completes, a **receipt** screen opens on top of the cart — **print** (thermal path depends on Settings receipt / printer setup), **Email receipt**, and **Text receipt**. When **Podium** is configured in Integrations, email sends **inline HTML** from **Receipt Builder**, and text sends a **receipt image** (when your store has a saved receipt template and the carrier supports it) or a **plain summary**. You can view or edit **phone** and **email** on that screen and **save** them to the customer record when allowed. Close that screen when done; only then does the register treat the sale as fully finished for “next customer” flow. Offer **bag tag** / label prints if your store uses them.

**RMS / RMS90 (house charge on a sale):** When a **normal** sale completes with an **RMS** or **RMS90** tender, **Sales Support** usually gets an inbox notification (**Submit R2S charge**) to record the **new charge** in **R2S**. That is different from a **payment-only** transaction (search **PAYMENT**) where the customer is **paying** an existing R2S balance — see above and **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.

## Void line vs void sale

- **Remove line** before tender: usually allowed within policy.
- **Void whole sale** or **post-tender void:** manager and **orders.*** permissions; follow store policy.

## Helping a customer who is confused

- **“Why is tax different?”** — Customer record, ship-to, or category can change tax; do not guess; say you will verify with a lead.
- **“Coupon didn’t work.”** — Check **discount events** and line eligibility; manager may apply manual discount if allowed.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Search returns **no results** | Type **SKU** only; scan again; one slow second between scans | Inventory checks **active** SKU in Back Office **Inventory List** |
| Picker won’t close | **Cancel** or tap outside if allowed; clear search | Refresh **only if no tender in progress**; manager |
| **Price override** blocked | Expected at cap | Manager with higher cap or admin |
| **Complete Sale** disabled | Missing customer, zero-total line, open modal, or (special orders) need to pay balance **or** set deposit per on-screen hint | Read the hint; apply tenders and/or deposit |
| Card stuck on **connecting** | Wait full timeout once | Retry tender; if repeated, use fallback SOP (other lane / manual auth) |
| **Balance due** wrong after discount | Remove and re-add discount | Manager reviews order lines |
| Wrong item on ticket | **Before pay:** remove line, re-add | **After pay:** return/exchange flow — manager |

## When to get a manager

- Any **refund**, **exchange**, or **void** after payment.
- **Suspected fraud** or mismatched ID for house charge.
- Customer **disputes price** that is not a simple scan error.
- Error toast mentioning **server** or **recalc** more than once.

---

## See also

- [../POS_PARKED_SALES_AND_RMS_CHARGES.md](../POS_PARKED_SALES_AND_RMS_CHARGES.md)
- [orders-back-office.md](orders-back-office.md)
- [customers-back-office.md](customers-back-office.md)
- [../ORDERS_RETURNS_EXCHANGES.md](../ORDERS_RETURNS_EXCHANGES.md)
- [../TILL_GROUP_AND_REGISTER_OPEN.md](../TILL_GROUP_AND_REGISTER_OPEN.md)
- [../SEARCH_AND_PAGINATION.md](../SEARCH_AND_PAGINATION.md)
- [../WEDDING_GROUP_PAY_AND_RETURNS.md](../WEDDING_GROUP_PAY_AND_RETURNS.md)

**Last reviewed:** 2026-04-06
