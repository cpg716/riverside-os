# Operations (Back Office home)

**Audience:** Managers and staff with access to the Operations area.

**Where in ROS:** Back Office → sidebar **Operations**. Subsections: **Dashboard**, **Timeline**, **Daily Sales**, **Pickup Queue**, **Podium Inbox**, **Mailbox**, **Reviews**.

**Related permissions:** **weddings.view** for wedding/compass blocks, appointments, and the activity feed. **notifications.view** for bell and timeline alerts. **tasks.complete** for your task widgets, or **tasks.view_team** for team task visibility. **customers.hub_view** for Podium Inbox and Mailbox. **reviews.view** for Reviews. **register.reports** for Daily Sales. **register.session_attach** for register close status. **orders.view** for Pickup Queue and pickup timeline items. **alterations.manage** for the alterations snapshot and alteration due dates. **procurement.view** for receiving commitments. **physical_inventory.view** for count/reconcile sessions. **qbo.view** for accounting review items. Weather often needs no special permission.

---

## How to use this area

**Operations Hub** is the **start-of-day** screen when you are in Back Office (not POS). **Dashboard** pulls together the KPI strip, **what changed today**, **what needs attention**, register close status, the Action Board, alterations, floor team, sales pace, weather, and a recent activity feed.

## Dashboard

1. **Operations** → **Dashboard**.
2. Scan blocks **top to bottom**:
   - **KPI strip** — sales, register close, pickup queue, alterations, inventory alerts, and attention pressure.
   - **What Changed Today** — booked movement, pickups, appointments, and new wedding counts. Click a number to open its source workspace.
   - **What Needs Attention** — blockers and warnings. Every row opens the source workflow.
   - **Register Close** — open till groups, open sessions, and close-review pressure. Use **Daily Sales** for the full Z-close view.
   - **Action Board** — ranked from weddings, tasks, rush orders, and inbox (when your role allows).
   - **Alterations** — overdue, due-today, ready pickup, and total open garment work from Register intake.
   - **Team on Floor** — from **Staff → Schedule** when configured.
   - **Sales by Hour** and **Recent Activity** — sales pace and live store or wedding events.
3. Treat the dashboard as a routing surface. Open the source workspace before making customer, inventory, close, or manager decisions.

**If a block is missing:** assume **permission** or **not configured** before assuming a bug.

Use the full **Alterations Hub**, **Pickup Queue**, **Daily Sales**, or **Inventory Stock Guidance** when you need search, source filters, status movement, or sign-off. The Operations block is the fast triage snapshot.

## Timeline

1. **Operations** → **Timeline**.
2. Use this as the store planning view for appointments, wedding readiness, pickup commitments, alteration due dates, staff follow-up tasks, receiving commitments, physical inventory sessions, QBO review items, register close work, and open operational alerts.
3. Switch between **Agenda**, **Week**, **Month**, and **Workload** depending on the planning question:
   - **Agenda** — fastest view for what is next.
   - **Week** — staffing and workload planning.
   - **Month** — deadline pressure and busy-day scanning.
   - **Workload** — where operational pressure is coming from.
4. Filter by **Today**, **Overdue**, **Manager**, **Appointments**, **Weddings**, **Pickups**, **Alterations**, **Tasks**, **QBO**, **Receiving**, **Inventory**, or **Alerts**.
5. Click a timeline row to open the source workflow. Do not edit timeline rows directly; make changes in the scheduler, Wedding Manager, Pickup Queue, Alterations, Tasks, QBO, Inventory, or Notifications.

If the Timeline says a source feed did not refresh, treat it as a partial view and open that source workspace before making staffing, customer, receiving, or accounting decisions.

## Daily Sales

1. **Operations** → **Daily Sales**.
2. Requires **register.reports**. Use this for store-wide register totals, lane activity, and transaction drill-down.
3. This is a reporting surface, not the same thing as the live POS register.

## Pickup Queue

1. **Operations** → **Pickup Queue**.
2. Requires **orders.view**. Use this to prioritize customer-ready orders, rush orders, due-soon work, and blocked follow-up.
3. This is a triage queue for pickup/order follow-up, not the full Orders workspace. Open the row to continue fulfillment work and review the linked Transaction Record context.

## Podium Inbox

1. **Operations** → **Podium Inbox**.
2. Requires **customers.hub_view**. This is the shared Podium SMS thread list, not a generic task inbox.
3. Use **Send Text** to message a current customer or a new phone number. Sending and new-contact creation require **customers.hub_edit**.
4. For a phone number that is not already a customer, enter first and last name before sending. ROS creates the contact and records the text.
5. Open a row to jump into the full customer conversation in the Customer Hub.

## Mailbox

1. **Operations** → **Mailbox**.
2. Requires **customers.hub_view**. Use this for store email from `info@riversidemens.com`.
3. Click **Sync inbox** to pull recent IONOS email into ROS.
4. Matched customer email appears here and in the customer **Messages** tab. Unmatched email stays here until staff can identify or answer it.
5. Use **Quick email** for general customer email. SMS still belongs in **Podium Inbox** or the customer **Messages** tab.

## Reviews

1. **Operations** → **Reviews**.
2. Requires **reviews.view**. Post-sale review invites and tracking per your deployment.

## Notifications (bell)

1. Click **bell** in header (from any tab).
2. **Bundled** system alerts (low stock, tasks due, POs, and similar) may appear as **one row** for many items—**tap that row** to expand the list, then open each line or mark done per SOP.
3. **Admin broadcasts** may need a **tap to expand** and read the full message.
4. Keep the drawer open during busy periods if needed; the list and bell refresh automatically while the app is visible.
5. **Payment** alerts open the Payments workspace section that needs review. Register cash discrepancy alerts open the register reports area, not the sale floor.
6. **Read** → **Complete** or **Dismiss** (archive) per SOP.
7. **Broadcast** is **admin-only** — mis-clicks notify many people.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Wedding block missing | **weddings.view** | Role change |
| Activity feed empty | Quiet period | Check **weddings.view** |
| Bell badge stuck | Open inbox | Re-sign-in |
| Register close card missing | Check **register.session_attach** | Manager role review |
| Tasks empty | Open **My tasks** once (lazy materialization) | [STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md) |

## When to get a manager

- **Refund queue** or **low stock** items requiring **money** decisions.
- **Broadcast** approval.
- **System-wide** notification failures.

---

## See also

- [pos-dashboard.md](pos-dashboard.md) (POS dashboard — different screen)
- [../EMAIL_MAILBOX.md](../EMAIL_MAILBOX.md)
- [../PLAN_NOTIFICATION_CENTER.md](../PLAN_NOTIFICATION_CENTER.md)
- [../STAFF_SCHEDULE_AND_CALENDAR.md](../STAFF_SCHEDULE_AND_CALENDAR.md)
- [../WEATHER_VISUAL_CROSSING.md](../WEATHER_VISUAL_CROSSING.md)

**Last reviewed:** 2026-05-17 (v0.60.0 Operations Dashboard pass)
