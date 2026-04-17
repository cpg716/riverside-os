# POS Reports

**Audience:** Leads and managers.

**Where in ROS:** POS mode → left rail **Reports** (file chart icon).

**Related permissions:** **register.reports** for session-style reporting. A **valid open register session** is usually still required for live tender reads.

---

## How to use this screen

**Reports** answers **“How is this drawer doing right now?”** — tender buckets, expected vs actual cash context, and mid-shift checks. It is **not** **Back Office → Insights**, which opens **Metabase** for store-wide analytics. Deep pivots and dashboards are built in Metabase (see [insights-back-office.md](insights-back-office.md)).

**Z-Reports (Unified):** **Register #1** is the canonical closing lane. Running **close / Z** on lane #1 automatically aggregates data from satellite lanes (**#2 iPad**, **#3 Back Office**) into a single professional audit document. Mid-shift "X-Reports" have been deprecated; use the live **Register Dashboard** for mid-shift reads — see **[Till group](../TILL_GROUP_AND_REGISTER_OPEN.md)**.

## Common tasks

### Mid-shift activity review

1. Confirm the **correct** drawer/session is active (profile shows expected cashier).
2. POS → **Reports**.
3. View **Daily Sales** to see a chronological timeline of activity. **Check numbers** are displayed next to the payment method for all check transactions.
4. **Print Audit**: Tap the **Print Report** button to generate a professional full-page audit document of the day's activity.

### Train a new hire on tender types

1. Open **Reports** with a **low-traffic** session or training mode if your store uses it.
2. Walk through **each tender line**: cash, card, gift card, store credit, etc.
3. Explain that **voids** and **returns** change these totals — compare to **Orders** if numbers look odd.

### End-of-shift handoff

1. Runner-up reads **Reports** with closing lead.
2. Confirm **no open carts** before trusting session totals.
3. Follow **Z / close** procedure in **Sessions** or manager workflow.

## Helping a coworker

- **“My numbers are zero.”** — They may be on **Reports** with **register closed** or wrong session; open register or **switch session** per policy.
- **“I don’t see Reports.”** — Check **register.reports** permission.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Empty / 403 | **register.reports** + session | Manager uses BO path |
| Totals don’t match cart | Complete or **park** open sales | — |
| Stale timestamp | **Refresh** | Network |
| Two sessions confused | **Session ordinal** on report header | Lead identifies correct drawer |

## When to get a manager

- **Over/short** outside tolerance.
- Suspected **duplicate** card capture or **wrong tender type** on large sale.

---

## See also

- [pos-dashboard.md](pos-dashboard.md)
- [orders-back-office.md](orders-back-office.md)
- [../REGISTER_DASHBOARD.md](../REGISTER_DASHBOARD.md)
- [../STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)
- [../TILL_GROUP_AND_REGISTER_OPEN.md](../TILL_GROUP_AND_REGISTER_OPEN.md)

**Last reviewed:** 2026-04-04
