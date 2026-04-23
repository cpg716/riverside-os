---
id: notifications-notification-center-bell
title: "Notifications Bell"
order: 1044
summary: "How staff use the bell to check new alerts, open the inbox, and stay caught up during the day."
source: client/src/components/notifications/NotificationCenterBell.tsx
last_scanned: 2026-04-23
tags: notifications, bell, inbox, staff
status: approved
---

# Notifications Bell

<!-- help:component-source -->
_Linked component: `client/src/components/notifications/NotificationCenterBell.tsx`._
<!-- /help:component-source -->

## What this is

The bell is Riverside’s shared notification entry point. Use it to see whether anything new needs your attention and to open the full **Communications & Alerts** drawer.

The number on the bell is your unread count. It tells you there is something new to review, not necessarily that everything is urgent.

## When to use it

Use the bell when you need to:

1. check whether anything new came in during your shift
2. review bundled alerts such as tasks, low stock, purchasing, or order reminders
3. open an alert and jump into the correct workspace
4. clear reviewed alerts out of your active inbox

## Before you start

- You need **`notifications.view`** permission to see the bell and open the drawer.
- The same bell behavior is used across Back Office, POS, and related shells.
- The bell opens the inbox; it does not replace the actual destination workspace.

## Steps

1. Click the **bell** in the top bar.
2. Look at the unread badge first. A larger number means more new alerts, not necessarily more urgent alerts.
3. In the drawer, start with the **Inbox** tab.
4. Review rows from top to bottom. Riverside separates items into **Today** and **Earlier** to make fresh work easier to scan.
5. Tap a row:
   - if it is an actionable single alert, it opens directly
   - if it is a bundle or announcement, it expands first so you can review details
6. Use **Mark Read**, **Complete**, or **Dismiss** as appropriate after review.

## What to watch for

- A row that says **Tap to review** is usually a bundle. Expand it first, then open the exact line you need.
- A row that says **Tap to open** should take you directly to the related record or workspace.
- **Announcements** are for reading, not completing.
- **Complete** is only for task-like alerts. Do not use **Dismiss** when the work itself is still unfinished.

## What happens next

After you open a notification, Riverside should hand you off into the related workspace, record, drawer, or modal. Read items stay in the inbox until you dismiss them or they age into history behavior.

If there is nothing new, the inbox should read as **All caught up for now**. That means there is nothing new waiting for action at this moment.

## Related workflows

- [operations-home.md](../../../../docs/staff/operations-home.md)
- [pos-dashboard.md](../../../../docs/staff/pos-dashboard.md)
- [notifications-notification-center-drawer-manual.md](./notifications-notification-center-drawer-manual.md)
- [settings-staff-profile-panel-manual.md](./settings-staff-profile-panel-manual.md)
