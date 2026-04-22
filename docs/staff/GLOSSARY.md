# Glossary (staff-facing)

Short definitions for terms that appear in Riverside OS, training, and technical docs. For **screen-by-screen** help, use the [guide index](README.md).

| Term | Meaning |
|------|---------|
| **403** | HTTP “forbidden”: almost always **missing permission**, not a random bug — see [ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md). |
| **404 (API)** | “Not found” — often **no active register session** when the server expected one, or missing entity ID. |
| **500 / 503** | Server or dependency failure — retry once, then escalate with time and screen — see [ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md). |
| **Action Board** | Prioritized operational queue (formerly "Morning Compass") showing wedding tasks and alerts. |
| **Allocation** | Reserving physical units for a specific **Order** so they aren't sold to someone else. |
| **Appointment** | A scheduled store visit; can be generic or linked to a specific wedding party. |
| **Available stock** | What you can sell from inventory that is not already promised: on-hand minus **reserved** (see [abstracts/orders-and-stock.md](abstracts/orders-and-stock.md)). |
| **Back Office** | Desktop-oriented shell: Operations, Inventory, Weddings, Settings, etc. Signed in with a **PIN**. |
| **Bag Tag** | A 2x1 thermal label generated for individual items in an order (?mode=bag-tag). |
| **Balance due** | Amount still owed on an order after payments and credits. |
| **Business date** | The store’s calendar day for reporting, driven by **timezone** in receipt/settings — may differ from UTC midnight. |
| **Card Vaulting** | Securely saving a customer's credit card in the Relationship Hub for future use (PCI-compliant via Stripe SetupIntents). |
| **Catalog handle** | The primary identifier used to match Counterpoint items (`ITEM#`). |
| **Checkout / Complete Sale** | Finalizing tenders so the order is paid (or partially paid per policy). |
| **Control board** | Paged product list API used for large catalogs (Back Office **Inventory List** and POS **Inventory** browse). |
| **Custom Item / MTM** | A made-to-measure garment order that stays in the **Custom** bucket. Known Custom SKUs include `100`, `105`, `110`, and `200`. Sale price is entered at booking; actual vendor cost is entered when the garment is received. |
| **Customer code** | Unique store-assigned ID for every customer profile; used for imports and matching. |
| **Deposit (Open)** | A payment held on a customer account (unlinked to a specific order) that can be applied to future purchases. |
| **Deposit (Order)** | A partial payment made at checkout for tailored or special-order items. |
| **Discount event** | Time-boxed merchandising discount with eligible SKUs; may apply automatically at POS when rules match. |
| **Disbursement (wedding)** | Splitting one payment across wedding party members’ order balances via the checkout payload — see [abstracts/wedding-group-pay.md](abstracts/wedding-group-pay.md). |
| **Employee Price** | A discounted price tier applied automatically when the attached customer is a linked staff member. |
| **Operations Hub** | The primary **Operations** dashboard (Back Office) showing metrics, Action Board, and floor status. |
| **Fulfillment / pickup** | Marking lines or orders as physically given to the customer; may affect stock for **stocked** lines. |
| **Gift card liability** | Value the store owes until the card is redeemed — finance cares about issuance and voids. |
| **Inventory Brain** | Intelligence engine that identifies sales velocity and stock-rescue (clearance) opportunities. |
| **Load more** | Fetches the **next page** of results; any screen using the **Control Board** pattern does not load the entire list at once. |
| **Low Stock Flag** | A visual indicator marking variants that have dropped below a set threshold. |
| **Meilisearch** | The engine providing "fuzzy" search, allowing for typos and partial matches across the catalog and help center. |
| **Operations Hub** | (Formerly "Morning Compass") The operational center showing prioritized wedding queues, weather, and staff tasks. |
| **Need By Date** | The hard customer deadline for an order or custom work. |
| **Open order** | Order not fully paid and/or not fully picked up — appears in **Orders → Open Orders**. |
| **Open register** | An active till session (**register session**) required for many POS money actions. |
| **Order** | Line type where stock is **not** reduced at checkout (Takeaway) but instead reserved for future fulfillment. |
| **Parked Sale** | A cart snapshot saved to the server, allowing it to be retrieved on other registers in the same lane group. |
| **Permission key** | Server rule (e.g. `orders.refund_process`) that decides if a staff role may perform an action. |
| **Access PIN** | 4-digit staff secret code used to sign in and to authorize manager overrides (voids, large discounts, attribution). |
| **Employee Tracking ID** | A unique 4-digit numeric ID auto-assigned to each staff member for reporting (commissions) and audit logs. Not used for login. |
| **Podium** | The integration used for SMS messaging, webchat, and digital review invites. |
| **POS mode** | Touch-first selling environment (emerald **Add to sale** / **Complete Sale** pattern), entered from Back Office **POS** (launchpad). |
| **POST-only** | An API that **changes** data — there is no GET list for staff browsers; use the in-app screen or reporting APIs. |
| **Recalc** | Server recomputation of order totals, tax, or balances after a change. |
| **Refund queue** | Workflow for processing refunds with controls and audit — see [abstracts/returns-refunds-exchanges.md](abstracts/returns-refunds-exchanges.md). |
| **Register #1** | The primary register lane; manages the cash drawer, float, and Z-close. |
| **Register #2** | A secondary register lane (iPad/BO) that attaches to Register #1 for a shared till session. |
| **Register Manager** | The administrative view of the POS dashboard, providing oversight of register metrics and floor priority. |
| **Relationship Hub** | Back Office **Customers** slide-out for one profile: overview, wedding parties, history, timeline, measurements, and payments. |
| **Reserved stock** | Units physically in the store but promised to an **Order** or **Custom Work** until pickup. |
| **RMS / RMS90 / R2S** | The "house charge" financial ecosystem used for local account billing. |
| **Rush Order** | An order explicitly marked as urgent, moving it to the top of the **Fulfillment Cockpit** and **Morning Compass**. |
| **Satellite Lane** | A secondary register lane (iPad/BO) that attaches to Register #1 for a shared till session. |
| **Shippo** | The carrier integration used for quoting shipping rates and generating tracking numbers. |
| **Store Credit** | A balance held by a customer that can be used as a tender at checkout. |
| **Stripe Credit** | Issuing a payment return directly back to a customer's physical card via the terminal (unlinked credit). |
| **Till Group** | A collection of register lanes that share a physical cash drawer and a single **Z-Report**. |
| **Toast** | Small non-blocking success/error message at the edge of the UI (ROS does **not** use browser `alert` / `confirm`). |
| **Truth Trace** | A user-visible "explainer" that breaks down the math behind complex features like commissions or inventory reorders. |
| **Universal Importer** | The tool used to bulk-update catalog data from CSV files (supports Lightspeed/NuORDER presets). |
| **Sparkline** | High-density trend chart shown on dashboard cards to visualize sales or performance over time. |
| **User override** | Per-person allow/deny on a single permission key; **deny** wins over role **allow**. |
| **Void (line / sale)** | Removing a line before pay, or reversing an unpaid mistake cart; **post-payment** voids follow strict policy. |
| **Wedding Health** | A risk-scoring algorithm (40/40/20) that flags parties at risk of fulfillment failure. |
| **Wedding order** | Order line or order context tied to wedding-party fulfillment rules. |
| **WowDash** | The unified, premium design system for Riverside OS dashboards and metrics visualization. |
| **Z-Report** | The final register reconciliation that closes the session and any associated satellite lanes. |

---

## See also

- [FAQ.md](FAQ.md)
- [permissions-and-access.md](permissions-and-access.md)

**Last reviewed:** 2026-04-13
