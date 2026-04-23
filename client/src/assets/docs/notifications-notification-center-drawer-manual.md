---
id: notifications-notification-center-drawer
title: "Notification Center and Team Announcements"
order: 1045
summary: "How staff and managers use the Communications & Alerts drawer to review alerts, clean up the inbox, and send team announcements when allowed."
source: client/src/components/notifications/NotificationCenterDrawer.tsx
last_scanned: 2026-04-23
tags: notifications, inbox, announcements, managers
status: approved
---

# Notification Center and Team Announcements

<!-- help:component-source -->
_Linked component: `client/src/components/notifications/NotificationCenterDrawer.tsx`._
<!-- /help:component-source -->

## What this is

The **Communications & Alerts** drawer is Riverside’s in-app notification center. It is where staff review new alerts, reopen earlier activity, and keep their inbox under control during the day.

For managers and approved admins, this same drawer also includes the **Announce** tab for team-wide announcements.

## When to use it

Use this drawer when you need to:

1. review new operational alerts
2. open the exact order, task, appointment, product, PO, or settings area tied to a notification
3. mark reviewed alerts as read
4. complete task-like alerts
5. dismiss reviewed alerts out of the active inbox
6. send a team announcement if your role allows broadcasts

## Before you start

- You need **`notifications.view`** to use the inbox.
- You need **`notifications.broadcast`** to send announcements.
- Not every row behaves the same way:
  - actionable single alerts open directly
  - bundles expand first
  - announcements expand for reading

## How to use the Inbox

1. Open the bell, then stay on **Inbox** for active work.
2. Start in **Today**. These are the newest alerts and reminders.
3. Review the label and chip on each row:
   - **Heads up** = informational
   - **Action needed** = likely needs follow-up
   - **Urgent** = higher-priority operational risk
   - **System alert** = important system/admin issue
   - **Announcement** = team communication
4. Tap the row:
   - **Tap to open** means Riverside should take you directly to the related record
   - **Tap to review** means expand first, then choose the specific child item
   - **Tap to read** means the row is informational or announcement-oriented
5. After review, use the footer actions:
   - **Mark Read** when you have seen it
   - **Complete** only when the alert represents finished task work
   - **Dismiss** when the alert is reviewed and can leave the active inbox

## Quick cleanup

The inbox includes a **Quick cleanup** bar so staff do not have to clear routine items one by one.

Use it like this:

1. Click **Mark new read** to clear the unread state from visible inbox rows you already reviewed.
2. Click **Dismiss reviewed** to move visible read items out of the active inbox.
3. Use bulk cleanup only after you have actually reviewed the items. It is meant to reduce repeated taps, not hide work you still need to do.

## Earlier activity

Use **Earlier** when you need to revisit alerts that were already completed or dismissed.

This is the right place to confirm:

- whether an item really left the active inbox
- what you already reviewed earlier in the shift or on a prior day
- whether a dismissed or completed alert still needs follow-up in its real workspace

## Team announcements (manager/admin only)

If you have broadcast permission:

1. Open **Announce**.
2. Enter a short title the team can scan quickly.
3. Write the message in plain operational language.
4. Choose the audience carefully:
   - all active staff
   - admins only
   - salesperson + sales support
   - specific staff members
5. Send the announcement only when the message is broad enough to justify inbox space.

## What to watch for

- Do not treat every alert like a task. Some rows are informational and should only be reviewed or dismissed.
- Bundled rows are there to reduce clutter. Expand them to open the exact child item you need.
- **Dismiss** removes the row from active inbox use, but it does not erase the underlying order, task, or record.
- System alerts should stand out visually. If you do not understand a system alert, escalate instead of dismissing it casually.
- Broadcasts notify many people at once. Keep them rare, clear, and operational.

## What happens next

After you open a notification, Riverside should hand you off into the related workspace, record, drawer, or modal. After you clean up the inbox, Riverside should read as **All caught up for now** when nothing new needs attention.

If **Earlier** is empty, that simply means there is no completed or dismissed notification history to show yet.

## Related workflows

- [notifications-notification-center-bell-manual.md](./notifications-notification-center-bell-manual.md)
- [settings-staff-profile-panel-manual.md](./settings-staff-profile-panel-manual.md)
- [operations-home.md](../../../../docs/staff/operations-home.md)
- [pos-dashboard.md](../../../../docs/staff/pos-dashboard.md)
