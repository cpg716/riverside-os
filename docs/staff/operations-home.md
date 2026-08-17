# Operations (Back Office home)

**Audience:** Managers and staff with access to the Operations area.

**Where in ROS:** Back Office → sidebar **Operations**. Subsections: **Dashboard**, **Timeline**, **Daily Sales**, **Pickup Queue**, **Customer Interactions**, **Podium Inbox**, **Mailbox**, **Reviews**.

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

The small line beneath a KPI is a related count, not a change-over-time trend. For example, **Inventory Alerts** may also show issue-alert count and **Pickup Queue** may show how many are ready. Riverside does not use up/down arrows for these related totals.

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
2. Requires **register.reports**. Use this for store-wide register totals, booked vs completed pickup/takeaway revenue, lane activity, customer drill-down, and transaction drill-down.
3. The dashboard includes captured weather for the selected store day or date range when weather snapshots are available.
4. This is a reporting surface, not the same thing as the live POS register.
5. **New Orders** counts Special and Custom Transactions whose initial booking activity belongs to the selected business-date range. Older open Orders and later amendments remain in their correct historical or amendment activity; they are not counted again as new.

## Pickup Queue

1. **Operations** → **Pickup Queue**.
2. Requires **orders.view**. Use this to prioritize **Received** and **Ready for Pickup** items, rush work, due-soon work, and current release blockers.
3. This is a release queue, not the full Orders workspace. Procurement, measurement, and vendor-order work stays in **Orders**. Open the row to continue fulfillment work and review the linked Transaction Record context.
4. A remaining balance is context, not automatically a pickup block. The queue shows **Payment needed** only when recorded payments do not cover even one ready item after previously released merchandise. **Verify readiness** means received garments still need the Ready for Pickup check.

## Customer Interactions

1. **Operations** → **Customer Interactions**.
2. Start with **All activity** for recent Podium SMS, store email, and automated delivery records. Use **Needs attention** for unread customer replies and failures.
3. Open **Text messages**, **Email**, or **Automated queue** to continue in the authoritative source. The separate Podium Inbox and Mailbox menu items remain direct shortcuts.
4. For a failed phone/email delivery, select **Update customer**, correct the contact detail, then select **Retry delivery** when offered. Review requests, receipts, and ready messages replay through their existing source workflows; appointment messages retry automatically after correction.
5. Staff with **customers.hub_edit** and the Customers/Loyalty notification preference enabled receive a customer-linked Notification Center alert for each new delivery failure. Opening it takes staff to that customer profile; a later successful delivery clears the resolved alert.
6. A later successful delivery automatically archives the older failed attempt. Use **Mark reviewed without retry** only when the customer was reached another way or no retry is appropriate; add the real resolution to the customer record when needed.
7. Customer Interactions does not replace Podium or Mailbox and does not guess unmatched senders onto customer records.

## Podium Inbox

1. **Operations** → **Podium Inbox**.
2. Requires **customers.hub_view**. This is the shared Podium SMS thread list, not a generic task inbox.
3. Search or filter the shared list, select a conversation, and reply from the text-style thread. Unmatched senders remain replyable before staff link or create a Customer. Use an editable check-in/pickup draft, common emoji, or an optional PNG attachment for SMS when useful. Opening the conversation marks it read; use **Mark unread** when follow-up still belongs to another staff member.
4. Choose **New message** to text a current customer or a new phone number. Sending and new-contact creation require **customers.hub_edit**.
5. An incoming unmatched phone number appears as the conversation's main label and can be answered without creating or matching a customer. **Unknown sender** appears only when Podium provides no usable identifier. Match/add only after staff can verify identity. When starting a separate **New message** to a new number, first and last name are still required and ROS creates the contact.
6. Podium notification items open this inbox and select the named customer's conversation. Use **Open Customer** for profile, Transaction, Fulfillment Order, or wedding follow-up.
7. The conversation header identifies Podium assignees and whether each identity is linked to a Riverside staff profile. Managers maintain that link in **Staff → Team → Edit → Linked Podium Staff Member**.
8. Select one or more conversation checkboxes to mark them **Read**, **Unread**, **Close**, or **Reopen**. Close uses Podium's native closed/archive state; closed threads remain available under the **Closed** filter.
9. **Refresh** reloads the Riverside copy. Open **Status** and use **Pull from Podium** when history is missing; **History incomplete** means the provider pull did not fully finish and must not be treated as current.

## Mailbox

1. **Operations** → **Mailbox**.
2. Requires **customers.hub_view**. Use this for store email from `info@riversidemens.com`.
3. Use the folder list for **Inbox**, **Important**, **Follow-up**, **Sent**, **Archived**, **Trash**, or **All mail**. The compact **Unmatched** toggle beside search instantly limits the current folder to email that is not linked to a Customer; select it again to return to all conversations.
4. Opening an inbound conversation marks it read. Use **Mark unread** if someone still needs to follow up. Select multiple conversation checkboxes for group **Read**, **Unread**, **Archive**, or **Delete**.
5. **Delete** moves the conversation to recoverable **Trash**; it does not permanently erase the email. **Restore** returns Archived or Trash conversations to Inbox.
6. The selected conversation keeps **Reply**, **Reply all**, **Forward**, **Important**, **Follow-up**, **Archive**, folder movement, and matched-customer access together above the message.
7. The conversation list loads first, then Riverside loads the selected email body on demand. Formatted email opens inside the contained viewer. Use **View plain text** when needed; email scripts, forms, and embedded frames are blocked, and links open separately.
8. Choose **New email** for a general customer email. Add multiple To recipients with commas or semicolons; open **Cc / Bcc** when needed. The message editor supports bold, italic, underline, bulleted and numbered lists, attachments up to 5 MB total, and the saved staff signature.
9. Message text saves automatically as one local draft on that workstation. Closing the composer keeps the draft; **Discard** removes it. Attachments stay with the open composer but must be re-added after a browser reload.
10. Click **Sync** to pull recent IONOS email into ROS. Matched customer email also appears in the customer **Messages** tab; unmatched email stays here for staff follow-up. SMS still belongs in **Podium Inbox** or the customer **Messages** tab.

## Reviews

1. **Operations** → **Reviews**.
2. Requires **reviews.view**. Open **Outbox** to see review requests waiting for their scheduled send time.
3. Staff with **reviews.manage** can choose **Cancel Invite** while a request is still waiting. Confirm by entering a specific reason of at least 12 characters; Riverside records the staff member and reason on the Transaction Record.
4. A request already marked **Sending**, **Sent**, or **Delivered** cannot be cancelled from Riverside. Refresh before acting if its status changed.
5. Use **Failed** and **Retry** only after correcting the displayed contact or integration problem.

## Notifications (bell)

1. Click **bell** in header (from any tab).
2. **Bundled** actionable reminders (tasks due, POs, and similar) may appear as **one row** for many items—**tap that row** to expand the list, then open each line or mark done per SOP.
3. **Admin broadcasts** may need a **tap to expand** and read the full message.
4. Keep the drawer open during busy periods if needed; the list and bell refresh automatically while the app is visible.
5. **Payment** alerts open the Payments workspace section that needs review. Register cash discrepancy alerts open the register reports area, not the sale floor.
6. **Read** → **Complete** or **Dismiss** (archive) per SOP.
7. **Broadcast** is **admin-only** — mis-clicks notify many people.

Routine inventory reconciliation does not use the bell. Review negative available stock and related findings in **Inventory → Reports → Inventory Reconciliation**. Successful fulfillment remains in the Transaction Record. Critical payment, backup, register, integration, and security failures still notify the appropriate staff.

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

**Last reviewed:** 2026-08-16 (unified Customer Interactions and contact-failure recovery updated)
