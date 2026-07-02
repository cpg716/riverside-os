# POS Reports

**Audience:** Leads and managers.

**Where in ROS:** POS mode → left rail **Reports** (file chart icon).

**Related permissions:** **register.reports** for session-style reporting. A **valid open register session** is usually still required for live tender reads.

---

## How to use this screen

**Reports** answers **“How is this drawer doing right now?”** — tender buckets, expected vs actual cash context, and mid-shift checks. It is **not** **Back Office → Insights**, which opens **Metabase** for store-wide analytics. Deep pivots and dashboards are built in Metabase (see [insights-back-office.md](insights-back-office.md)).

**Z-Reports (Unified):** **Register #1** is the canonical closing lane. Running **close / Z** on lane #1 automatically aggregates data from satellite lanes (**#2 iPad**, **#3 Back Office**) into a single professional audit document. The close flow is three pages: **Cash**, **Checks**, then **Z-Report**. Canceling before the final page does not close the drawer. Mid-shift "X-Reports" have been deprecated; use the live **Register Dashboard** for mid-shift reads — see **[Till group](../TILL_GROUP_AND_REGISTER_OPEN.md)**.

## Common tasks

### Mid-shift activity review

1. Confirm the **correct** drawer/session is active (profile shows expected cashier).
2. POS → **Reports**.
3. View **Daily Sales** to see a chronological timeline of activity. Use **Booked** when comparing what was rung during the drawer/session, and **Completed** when reviewing recognized takeaway and pickup activity. **Check numbers** are displayed next to the payment method for all check transactions.
4. For payment-only activity, use **Receipt** to open the standard Transaction Record receipt showing the payment application, customer, Customer #, phone, totals, and remaining balance. RMS Charge payments show as **RMS Payment** activity, not retail merchandise.
5. For a completed-sale mistake that must be reversed, use **Void** only with Manager Access. Read the impact list before confirming; the original Transaction Record remains visible and the refund workflow may still need completion.
6. **Print Audit**: Tap the **Print Report** button to open the professional full-page Daily Sales document for the selected basis.

### Train a new hire on tender types

1. Open **Reports** with a **low-traffic** session or training mode if your store uses it.
2. Walk through **each tender line**: cash, card, gift card, store credit, etc.
3. Explain that **voids** and **returns** change these totals — compare to **Orders** if numbers look odd.

### End-of-shift handoff

1. Runner-up reads **Reports** with closing lead.
2. Confirm **no open carts** before trusting session totals.
3. Follow **Z / close** on **Register #1**. If card review blocks close, use the close-drawer **Review** action or **POS → Payments** to record the terminal outcome before finalizing.
4. The final Z-report includes cash/check review, lane tenders, QBO journal-entry preview, and non-sale inventory activity such as Receiving, RTV, Damaged, Physical Count, and Adjustments.

## Helping a coworker

- **“My numbers are zero.”** — They may be on **Reports** with **register closed** or wrong session; open register or **switch session** per policy.
- **“I don’t see Reports.”** — Check **register.reports** permission.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Empty / 403 | **register.reports** + session | Manager uses BO path |
| Totals don’t match cart | Complete or **park** open sales | — |
| Card review blocks close | Use **Review** in Z-close or **POS → Payments** and record the terminal outcome | Manager checks Back Office Payments → Health if the issue still remains |
| Voided sale still shows refund due | Complete the refund workflow tied to that void | Manager reviews the void record and refund queue |
| Stale timestamp | **Refresh** | Network |
| Two sessions confused | **Session ordinal** on report header | Lead identifies correct drawer |

## When to get a manager

- **Over/short** outside tolerance.
- Suspected **duplicate** card capture or **wrong tender type** on large sale.
- Any completed-sale **Void** with unclear refund, inventory, QBO, RMS, or customer-history impact.

---

## See also

- [pos-dashboard.md](pos-dashboard.md)
- [pos-void-transactions.md](pos-void-transactions.md)
- [orders-back-office.md](orders-back-office.md)
- [../REGISTER_DASHBOARD.md](../REGISTER_DASHBOARD.md)
- [../STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)
- [../TILL_GROUP_AND_REGISTER_OPEN.md](../TILL_GROUP_AND_REGISTER_OPEN.md)

**Last reviewed:** 2026-05-17
