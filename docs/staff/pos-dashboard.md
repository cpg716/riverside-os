# POS Dashboard

**Audience:** Floor staff while a register session is open.

**Where in ROS:** POS mode → left rail **Dashboard** (first item). Full rail order (when **Alterations** is enabled for your role): **Dashboard**, **Register**, **Tasks**, **Weddings**, **Alterations**, **Inventory**, **Reports**, **Gift Cards**, **Loyalty**, **Settings**.

**Related permissions:** **Attributed sales** metrics may appear only for **salesperson** / **sales_support** roles. **Wedding pulse** needs **weddings.view**. **Session tenders / X-report** needs **register.reports**. **Tasks** needs **tasks.complete**. **Notifications** needs **notifications.view**.

---

## How to use this screen

This is your **shift overview** before you jump into the cart. Scan top-to-bottom: **weather** (if shown), **your numbers** (if your role shows them), **wedding pulse**, **tasks**, **notifications**, and shortcuts back to **Register**.

## When you land here

ROS usually opens **Dashboard** when the drawer opens **unless** you are resuming a **customer**, **order**, **SKU**, or **wedding** deep link — then you may land on **Register** instead.

## Register closed

You see a message to **open the register**. Dashboard metrics tied to the session will not load until a valid session exists.

## Blocks you might see

| Block | You use it to… | If missing |
|-------|----------------|------------|
| **Headline / role** | Confirm you are signed in as expected | Sign out/in |
| **Weather** | Small talk / plan for pickups | Ignore if blank — not all stores configure |
| **Attributed sales** | See your **lines / gross** for the **store calendar day** | Normal for some roles — not a bug |
| **Session tenders / X-report** | Mid-shift tender check (**X** is per lane; **Z** is on **Register #1** when using a till group) | Needs **register.reports** + session rules — see **[Till group](../TILL_GROUP_AND_REGISTER_OPEN.md)** |
| **Wedding pulse** | See today’s wedding pressure | Needs **weddings.view** |
| **Tasks** | Open **My tasks** checklist | Needs **tasks.complete** |
| **Rush Orders** | See how many orders require immediate fulfillment | Priority tracking for "Need By" dates |
| **Notifications** | Short preview; **open bell** for the full inbox. **Bundled** alerts (many SKUs, tasks, etc.) show **one compact row**—tap it in the drawer to **expand** the list, then tap a line to open that item | Needs **notifications.view** |

## Common tasks

### Clear your notifications before shift

1. Tap **Open inbox** or the **bell** (per UI).
2. If a row looks like a **summary** (e.g. many items in one line), **tap it** to expand; then work through **Read** → **Complete** or **Dismiss** (archive) per SOP.
3. Do not **broadcast** — that is admin-only.

### Check tasks before floor

1. From Dashboard, open **Tasks** block.
2. Complete items that apply **before** you unlock the door (lights, music, cash count verification per SOP).

## Helping a coworker

- **“Why don’t I see wedding pulse?”** — They lack **weddings.view**; not something you fix at the register.
- **“Why is my sales $0?”** — Role may hide metrics, or no **attributed** payments yet today — check after first sale.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Dashboard empty / skeleton forever | Wait 15s | Check Wi‑Fi; refresh once |
| Metrics clearly wrong | Note time and screenshot | Manager + **register_metrics** audit |
| Notification won’t dismiss | **Archive** vs **Complete** — try the other | Manager |
| Wrong staff name in header | **Shift handoff** may be needed | See [STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md) |

## When to get a manager

- **Financial** numbers on X-report do not match drawer expectation.
- Bell shows **system** or **security** alerts you do not understand.

---

## See also

- [operations-home.md](operations-home.md)
- [pos-tasks.md](pos-tasks.md)
- [../REGISTER_DASHBOARD.md](../REGISTER_DASHBOARD.md)
- [../TILL_GROUP_AND_REGISTER_OPEN.md](../TILL_GROUP_AND_REGISTER_OPEN.md)
- [../PLAN_NOTIFICATION_CENTER.md](../PLAN_NOTIFICATION_CENTER.md)

**Last reviewed:** 2026-04-04
