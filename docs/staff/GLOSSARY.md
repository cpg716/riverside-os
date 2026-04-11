# Glossary (staff-facing)

Short definitions for terms that appear in Riverside OS, training, and technical docs. For **screen-by-screen** help, use the [guide index](README.md).

| Term | Meaning |
|------|---------|
| **Available stock** | What you can sell from inventory that is not already promised: on-hand minus **reserved** (see [abstracts/orders-and-stock.md](abstracts/orders-and-stock.md)). |
| **Back Office** | Desktop-oriented shell: Operations, Inventory, Weddings, Settings, etc. Signed in with **staff code** (+ PIN when set). |
| **Balance due** | Amount still owed on an order after payments and credits. |
| **Business date** | The store’s calendar day for reporting, driven by **timezone** in receipt/settings — may differ from UTC midnight. |
| **Cashier code** | Short numeric code identifying a staff member at POS; paired with **PIN** when required. |
| **Checkout / Complete Sale** | Finalizing tenders so the order is paid (or partially paid per policy). |
| **Control board** | Paged product list API used for large catalogs (Back Office **Inventory List** and POS **Inventory** browse). |
| **Customer code** | Unique store-assigned ID for every customer profile; used for imports and matching. |
| **Relationship Hub** | Back Office **Customers** slide-out for one profile: overview, wedding parties, order history, timeline, measurements, etc. Tabs use permission keys **`customers.hub_view`**, **`hub_edit`**, **`timeline`**, **`measurements`**; the **Orders** tab also needs **`orders.view`** — [customers-back-office.md](customers-back-office.md). |
| **Discount event** | Time-boxed merchandising discount with eligible SKUs; may apply automatically at POS when rules match. |
| **Disbursement (wedding)** | Splitting one payment across wedding party members’ order balances via the checkout payload — see [abstracts/wedding-group-pay.md](abstracts/wedding-group-pay.md). |
| **Fulfillment / pickup** | Marking lines or orders as physically given to the customer; may affect stock for **stocked** lines. |
| **Gift card liability** | Value the store owes until the card is redeemed — finance cares about issuance and voids. |
| **Load more** | Fetches the **next page** of results; the app does not load entire huge lists at once. |
| **Open order** | Order not fully paid and/or not fully picked up — appears in **Orders → Open Orders**. |
| **Open register / register session** | Active till session: required for many POS money actions and some session-scoped reads. |
| **Permission key** | Server rule (e.g. `orders.refund_process`) that decides if a staff role may perform an action. |
| **POS mode** | Touch-first selling environment (emerald **Add to sale** / **Complete Sale** pattern), entered from Back Office **POS** (launchpad), then **Enter POS**. The **Register** rail tab inside POS is the **live cart / checkout** screen. |
| **POST-only** | An API that **changes** data — there is no GET list for staff browsers; use the in-app screen or reporting APIs. |
| **Recalc** | Server recomputation of order totals, tax, or balances after a change. |
| **Refund queue** | Workflow for processing refunds with controls and audit — see [abstracts/returns-refunds-exchanges.md](abstracts/returns-refunds-exchanges.md). |
| **Reserved stock** | Units physically in the store but promised to **order** (or similar) customers until pickup. |
| **Order** | Line type where stock is **not** reduced at checkout the same way as an immediate pickup; receiving can **reserve** into this pipeline. |
| **Staff code** | Four-digit Back Office sign-in identifier; may match **cashier code** depending on setup. |
| **Toast** | Small non-blocking success/error message at the edge of the UI (ROS does **not** use browser `alert` / `confirm`). |
| **User override** | Per-person allow/deny on a single permission key; **deny** wins over role **allow**. |
| **Void (line / sale)** | Removing a line before pay, or reversing an unpaid mistake cart; **post-payment** voids follow strict policy. |
| **Wedding order** | Order line or order context tied to wedding-party fulfillment rules. |
| **X-report / session tenders** | Mid-shift or end-of-shift register summary — permission and labels vary by role. |
| **403** | HTTP “forbidden”: almost always **missing permission**, not a random bug — see [ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md). |
| **404 (API)** | “Not found” — often **no active register session** when the server expected one, or missing entity ID. |
| **500 / 503** | Server or dependency failure — retry once, then escalate with time and screen — see [ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md). |

---

## See also

- [FAQ.md](FAQ.md)
- [permissions-and-access.md](permissions-and-access.md)

**Last reviewed:** 2026-04-11
