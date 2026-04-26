# POS Register (cart and checkout)

**Audience:** Cashiers and sales staff.

**Where in ROS:** POS mode → left rail **Register** (cart icon).

**Related permissions:** Tender and drawer operations require an **open register session** and valid POS staff authentication. **Line discount %** is capped by each cashier’s **`staff.max_discount_percent`** (set on their **Staff → Team** profile; templates live under **Settings → Staff access defaults**).

**Multiple registers:** Your store may run **Register #1** (cash drawer) and **Register #2+** in the same **till shift**. Payments are tracked **per lane**; **one** physical drawer count happens at **Z** on **Register #1**, which closes the whole group. **Admins** opening POS from Back Office usually default to **#2**; **#2** cannot open until **#1** is open. Details: **[Till group](../TILL_GROUP_AND_REGISTER_OPEN.md)**.

---

## How to use this screen

The **Register** tab is the **live cart**: search at top, line items in the middle, **totals** and **Complete Sale** / tender actions at the bottom (layout may vary slightly by screen size). The cart uses a **high-density horizontal layout** to maximize visibility: line items show product info on the left, fulfillment toggles in the center, and Qty/Sale controls on the right. **Green (emerald)** buttons are the primary **money** actions \u2014 read them carefully before tapping.

## Cashier for this sale

Before you **scan**, **search**, use the **numpad**, or tap **Pay**, the register shows a **full-screen sign-in step**. 

1. **Select Identity**: Choose your name from the **Staff Roster** dropdown. The system will remember your choice for your next sign-in on this device.
2. **Enter PIN**: Type your **4-digit PIN** to authorize the register for this sale. 

That person is recorded as the checkout **operator** for the transaction. **After you complete a sale**, you stay signed in as that cashier; use **Logout** or **Switch cashier** only if someone else should ring the next sale. Clearing the cart or starting a new sale does **not** sign you out. This is separate from **who opened the drawer** (session) and separate from the **Salesperson** (assigned via the avatar-picker at top or on each line) used for commissions.

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
5. **Custom Orders:** One of the three primary fulfillment types. The known Custom garment SKUs automatically book as **Custom** orders:
   - `100` HSM Custom Suit
   - `105` HSM Custom Sport Coat
   - `110` HSM Custom Slacks
   - `200` Individualized Custom Shirt
   When one of these SKUs is added, the **Custom Order** window opens so you can confirm the garment type, enter the **Sale Price**, add **Need By Date** or **Rush** details, and capture the main vendor-form references such as fabric, style, model, size anchors, sleeve or cuff measurements, and vendor order numbers. **Vendor cost is not entered at booking**. The actual cost is entered later, when the garment is received. These items stay tracked as **Fulfillment Orders**.
6. **Wrong size after adding?** Tap the **product name** on the line (not only the SKU chip). If that style has multiple sizes/options, the **variation picker** opens again so you can **swap** the line without removing it; if there is only one SKU, a **review / price** panel may open instead.
7. **Cart Item Toggles:** Each line in the cart now includes quick toggles for **Gift Wrap** (blue wrapping icon). Tapping this updates the fulfillment requirement immediately.
8. **Recalling a Transaction:** If a customer has items to pick up or a previous transaction to resume, tap the **Transactions** button next to the customer search bar. This opens the **Transaction Loader**, where you can select specific items from their history to bring into the active cart for direct pickup or further payment.
9. **Fulfillment Requirements (Rush/Due Date):** Tap the **Zap (Options)** icon in the tool rail to open the **Transaction Review** screen. Here you can set the **Need By Date** and toggle **Rush** status for the whole sale. Use the separate **Ship current sale** action in the cart when the customer wants delivery; that flow captures the address, rate quote, and shipment tracking together.
10. **Quantity and price:** Use the on-screen **numpad**. 
    - **Quantity**: Type amount and tap **Qty** (or **Apply** if in Qty mode).
    - **Percentage Discount**: Select a line item, type the percentage (e.g. `20`), and tap **%**. This instantly calculates the discounted price and recalculates the line tax based on the new net price.
    - **Manual Override**: Tap **$** to switch to price mode, type the new total unit price, and tap **Apply**. Override reasons are recorded for audit. Price changes are capped by your role's **`max_discount_percent`**.
11. **Manager PIN Override**: If a discount exceeds your role's limit (e.g., >10%) or you attempt to **Void All** lines, the **Manager PIN** modal will appear. Have a manager select their name and enter their PIN; this authorizes the action for the current sale without changing your login.
12. Confirm the **line total** matches what you told the customer.

**R2S payment on the customer’s outside charge (not a normal sale):** When the customer is paying down an **R2S-managed** balance (not store credit, not a new purchase), type **`PAYMENT`** in the product search. Select **RMS CHARGE PAYMENT**, attach the **customer**, enter the **amount** on the **Price** numpad (no tax on this line; no loyalty points on this transaction type). Complete the sale with **Cash** or **Check** only (other tenders are hidden for this flow). **Sales Support** gets a **task** to confirm the payment was posted in the **R2S** portal — complete it per SOP. Details: **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.

**Fulfillment Orders:** Lines that are **not** takeaway fulfillment typically do **not** reduce on-hand stock at checkout; **takeaway** items decrement stock at sale time. The system may allow **negative on-hand** when policy permits oversell. Do not promise same-day pickup unless the line type and notes say so.

**Shipping without an order:** A customer can buy an in-stock item at the Register and have it shipped without turning the merchandise line into a Special/Custom/Wedding fulfillment order. Use **Ship current sale** before payment. Riverside records the transaction delivery method as **Ship**, stores the address and shipping fee from the rate quote, and creates the shipment record for follow-up. This is separate from shipping an existing open order from the Orders/Shipments workflow.

**Register alterations:** Use **Alteration** from the Register toolbar after selecting the customer. Every Register alteration adds an editable **Alteration** cart line. Free/included work shows **$0.00**; charged work shows the entered service amount. The source garment can be a current cart item, past purchase, SKU lookup, or custom/manual description, but lookup-only and past-purchase garments are **not** sold again. Removing a source sale line asks whether to remove the attached alteration too or keep it as a custom/manual item.

## Attaching a customer

Attach **before** completing tax-sensitive or loyalty-linked sales if your SOP requires it:

1. Use **customer search** at the top of the right-hand rail. Search by name, phone, or email to attach a profile to the sale. Walk-in and Parked options are located directly below the search bar for quick access.
2. If the search has no match, use **Add Customer** at the top of the results. The Add Customer drawer is the same intake used in Back Office and will pre-fill the name, phone, or email you typed.
3. With a customer on the sale, tap the **customer strip** to open the **relationship hub** slideout (same hub as Back Office \u2014 timeline, transactions, profile, and more where your role allows). Use the **ruler / measurements** control on that strip when you only need **measurements**, not the full hub.
4. **Load more** if the list is long; try **last name + phone** if name is common.
5. If **duplicate profiles** appear, **do not merge** at the register unless trained — pick the profile the store uses for that person or get a manager.

When adding or completing a customer profile at the register, the **Address** field may show address suggestions after you start typing. Selecting a suggestion fills **Address**, **City**, **State**, and **ZIP**. If lookup is slow, unavailable, or no match appears, type the address manually and continue; checkout and customer save must not wait on address lookup.

**Employee pricing:** If the attached customer is your **linked employee CRM profile** (set by an admin on **Staff → Team**), new lines default to **employee price** when the catalog provides it; checkout still validates prices against allowed tiers.

## Park (hold cart)

Your store may offer **Park** to save the **current cart** on the **server** (not just this browser) while the register session stays open. Use **Park** when you need a **named, auditable** hold or to work across devices; the **local draft** (above) still helps if you only switched screens on the same device.

1. Use **Park** from the cart when the customer steps away or you must switch tasks.
2. If a parked cart exists for this lane, the register may prompt you to **Continue**, open the **parked list**, **start fresh**, or **clear parked** — follow on-screen choices and store SOP.
3. **Z-close** (end of shift on **Register #1**) clears any carts still marked parked for lanes in that till group; retrieve or complete sales before close when possible.

Technical reference for engineers and leads: **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.

## Checkout (Complete Sale)

1. Review **subtotal**, **tax**, and **balance due** with the customer.
2. Tap **Pay** / **Complete Sale** (or equivalent green action). If the transaction requires Rush/Due Date details or special fulfillment, the **Transaction Review** screen appears before payment. If the customer wants delivery, use **Ship current sale** from the cart before payment so checkout has a valid quote and address snapshot.
3. **Tender:** choose the method, enter the amount on the keypad, then **Apply payment** for each tender before finalizing. Enter cash, swipe/tap card, gift card, or **split** tenders per training. Wait for **approved** state on card; do not hand back change until tender is confirmed on screen.
    - **Physical Checks**: When a customer pays by check, select the **CHECK** tab and enter the **Check #** in the input field before pressing **Apply Payment**.
    - The **keypad** stays fixed in the payment panel — scroll only affects the tender and balance area above it if the screen is very short.
4. **Stripe Unified Branding (Integrated Payments):**
   - Integrated Card and Vault methods are labeled as **STRIPE CARD**, **STRIPE MANUAL**, or **STRIPE VAULT**.
   - **Saved Card**: Select **STRIPE VAULT** to charge a card on file without the physical reader. 
   - **Stripe Credit**: Select **STRIPE CREDIT** (on returns) to issue a credit back via the terminal.
   - See **[`stripe-payments-manual.md`](../../client/src/assets/docs/stripe-payments-manual.md)** for full details.
5. **Audited Tax Exemptions:**
   - For tax-free sales, tap the **Tax Exempt** toggle in the checkout drawer.
   - **Reason Required**: A valid reason (e.g. Resale, Exempt Org) MUST be selected.
   - Taxes will be struck through, and the **Balance Due** will update automatically.
5. **Pennyless (Swedish Rounding):**
   - Riverside OS uses **Pennyless** (Swedish Rounding) for all **CASH** transactions.
   - **How it works**: For cash payments and refunds, the total is rounded to the nearest **$0.05**.
     - $3.22 rounds to $3.20.
     - $3.23 rounds to $3.25.
   - **Important**: This rounding ONLY applies when the **CASH** tab is selected in the checkout drawer. If the customer switches to CARD or another method, the original unrounded total ($3.22) is required.
   - **Suggested Amounts**: When you tap **Pay Balance** in the CASH tab, the system will automatically suggest the rounded amount (e.g., $3.20). Use **Split Balance** when you want the drawer to load roughly half of the current amount due for a deposit-style payment.
   - **Ledger Integrity**: The printed receipt will show the original total and a "Rounding Adjustment" to ensure the financial books balance to zero.
6. **Transactions / wedding transactions (when shown):** The balance ledger may include **Deposit (ledger)**. Use the same keypad, then tap **Apply deposit** (below **Apply payment**) to record the deposit amount the customer pledges to pay today. This instantly reduces the "Balance to Pay" calculation down to just the requested deposit (+ any immediate takeaway goods). Once the balance is updated, use **Apply payment** via cash/card to fulfill the deposit target. **Split deposit (wedding party)** opens wedding lookup in **group pay** mode so one payer can split amounts across members (same as **Wedding** → party → **Enter Group Pay**). If your sale is **fulfillment lines only** (no take-home items) and you are **not** using a split wedding payout list, you may be able to tap **Complete Sale** with **only** a deposit set — follow store policy.
7. **Store date and time** next to **Salesperson** is a live clock in the store’s receipt timezone; the **printed receipt time** is the time the server records when the sale completes.
8. **Receipt:** after tender completes, a **receipt** screen opens on top of the cart — **Print receipt** uses the Epson receipt printer configured in **Printers & Scanners**, and **Email receipt** / **Text receipt** use the standard receipt content. Register #1 opens the attached cash drawer only for **CASH** and **CHECK** sales. You can view or edit **phone** and **email** on that screen and **save** them to the customer record when allowed. Close that screen when done; only then does the register treat the sale as fully finished for “next customer” flow. Offer **bag tag** / label prints if your store uses them.

**RMS Charge (house charge on a sale):** Use the single **RMS Charge** tender button, not separate RMS / RMS90 buttons. After selecting it, POS resolves the linked customer account, shows only **masked** account choices, and then opens a required plan-selection step for the eligible **program** (for example **Standard** or **RMS 90**). The system does **not** silently default the plan for the cashier. Riverside posts the financing transaction to CoreCard before checkout finishes, so the sale does **not** complete if the host post fails. The receipt prints **RMS Charge**, the saved program label, masked account, and host reference when available. For the quick cashier workflow, see **[POS RMS Charge](pos-rms-charge.md)**.

**RMS Charge slim workspace in POS:** Permitted staff can open the RMS Charge workspace in POS to review the current customer’s account summary, available credit, recent RMS history, posting status, and host references. Standard floor staff do **not** see Back Office exception or reconciliation controls there. Payment collection visibility depends on **`pos.rms_charge.payment_collect`** or a richer RMS role.

**RMS payment collection:** Search **PAYMENT** to add the internal **RMS CHARGE PAYMENT** line. The register still only accepts **cash** or **check** for this flow, but POS now resolves the linked RMS account before taking the tender and posts the payment to CoreCard before the collection succeeds.

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
| **Complete Sale** disabled | Missing customer, zero-total line, open modal, or (fulfillment items) need to pay balance **or** set deposit per on-screen hint | Read the hint; apply tenders and/or deposit |
| Card stuck on **connecting** | Wait full timeout once | Retry tender; if repeated, use fallback SOP (other lane / manual auth) |
| **Balance due** wrong after discount | Remove and re-add discount | Manager reviews transaction lines |
| Wrong item on ticket | **Before pay:** remove line, re-add | **After pay:** return/exchange flow — manager |

## When to get a manager

- Any **refund**, **exchange**, or **void** after payment.
- **Suspected fraud** or mismatched ID for house charge.
- Customer **disputes price** that is not a simple scan error.
- Error toast mentioning **server** or **recalc** more than once.

---

## See also

- [../POS_PARKED_SALES_AND_RMS_CHARGES.md](../POS_PARKED_SALES_AND_RMS_CHARGES.md)
- [pos-rms-charge.md](pos-rms-charge.md)
- [transactions-back-office.md](transactions-back-office.md)
- [customers-back-office.md](customers-back-office.md)
- [../TRANSACTION_RETURNS_EXCHANGES.md](../TRANSACTION_RETURNS_EXCHANGES.md)
- [../TILL_GROUP_AND_REGISTER_OPEN.md](../TILL_GROUP_AND_REGISTER_OPEN.md)
- [../SEARCH_AND_PAGINATION.md](../SEARCH_AND_PAGINATION.md)
- [../WEDDING_GROUP_PAY_AND_RETURNS.md](../WEDDING_GROUP_PAY_AND_RETURNS.md)

**Last reviewed:** 2026-04-16
