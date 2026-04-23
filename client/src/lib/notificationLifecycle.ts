import type { NotificationRow } from "../context/NotificationCenterContextLogic";

export function bulkReadableNotificationIds(rows: NotificationRow[]): string[] {
  return rows
    .filter((row) => !row.archived_at && !row.read_at)
    .map((row) => row.staff_notification_id);
}

export function bulkArchivableNotificationIds(rows: NotificationRow[]): string[] {
  return rows
    .filter((row) => !row.archived_at && !!row.read_at)
    .map((row) => row.staff_notification_id);
}
