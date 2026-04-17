# Operations (Back Office home)

**Audience:** Managers and staff with access to the Operations area.

**Where in ROS:** Back Office → sidebar **Operations**. Subsections: **Dashboard**, **Inbox**, **Reviews**, **Register reports** (order may match your build).

**Related permissions:** **weddings.view** for wedding/compass blocks and the activity feed. **notifications.view** for bell. **tasks.complete** for task widgets. **customers.hub_view** for Inbox. **reviews.view** for Reviews. **register.reports** for Register reports. Weather often needs no special permission.

---

## How to use this area

**Operations Hub** is the **start-of-day** screen when you are in Back Office (not POS). **Dashboard** pulls together **what needs attention** (Action Board, floor team, weather) plus **sales performance trends** and a **recent activity feed**.

## Dashboard

1. **Operations** → **Dashboard**.
2. Scan blocks **top to bottom**:
   - **Action Board** — ranked from weddings, tasks, and inbox (when your role allows).
   - **Performance Metrics** — real-time sales revenue visualized with trend sparklines.
   - **Team on Floor** — from **Staff → Schedule** when configured.
   - **Task List** — opens checklist items for you (**tasks.complete**).
   - **Weather Hub** — customer and staffing context with condition signals.
   - **Recent Activity** — live store and wedding events feed (**weddings.view**).
3. Use shortcuts to **POS**, **Orders**, or **Weddings** if tiles exist.

**If a block is missing:** assume **permission** or **not configured** before assuming a bug.

## Inbox

1. **Operations** → **Inbox** (Podium / CRM messaging).
2. Requires **customers.hub_view**. Use for operational message threads; see store SOP for response expectations.

## Reviews

1. **Operations** → **Reviews**.
2. Requires **reviews.view**. Post-sale review invites and tracking per your deployment.

## Register reports

1. **Operations** → **Register reports**.
2. Requires **register.reports** (or an open till for lane-scoped views in POS). Store-wide daily register activity and summaries.

## Notifications (bell)

1. Click **bell** in header (from any tab).
2. **Bundled** system alerts (low stock, tasks due, POs, and similar) may appear as **one row** for many items—**tap that row** to expand the list, then open each line or mark done per SOP.
3. **Admin broadcasts** may need a **tap to expand** and read the full message.
4. **Read** → **Complete** or **Dismiss** (archive) per SOP.
5. **Broadcast** is **admin-only** — mis-clicks notify many people.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Wedding block missing | **weddings.view** | Role change |
| Activity feed empty | Quiet period | Check **weddings.view** |
| Bell badge stuck | Open inbox | Re-sign-in |
| Tasks empty | Open **My tasks** once (lazy materialization) | [STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md) |

## When to get a manager

- **Refund queue** or **low stock** items requiring **money** decisions.
- **Broadcast** approval.
- **System-wide** notification failures.

---

## See also

- [pos-dashboard.md](pos-dashboard.md) (POS dashboard — different screen)
- [../PLAN_NOTIFICATION_CENTER.md](../PLAN_NOTIFICATION_CENTER.md)
- [../STAFF_SCHEDULE_AND_CALENDAR.md](../STAFF_SCHEDULE_AND_CALENDAR.md)
- [../WEATHER_VISUAL_CROSSING.md](../WEATHER_VISUAL_CROSSING.md)

**Last reviewed:** 2026-04-15 (v0.2.0 WowDash Pass)
