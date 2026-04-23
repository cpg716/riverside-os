import type { NotificationDeepLink } from "../context/NotificationCenterContextLogic";

function linkField(o: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/** Whether tapping the row should navigate (vs expand-only for broadcast / non-routable). */
export function isActionableNotificationDeepLink(
  link: unknown,
): link is NotificationDeepLink {
  if (!link || typeof link !== "object") return false;
  const o = link as Record<string, unknown>;
  const t = o.type;
  if (typeof t !== "string" || !t.trim()) return false;
  if (t === "none" || t === "notification_bundle") return false;

  switch (t) {
    case "order":
      return !!linkField(o, "order_id", "transaction_id");
    case "wedding_party":
      return typeof o.party_id === "string" && !!o.party_id.trim();
    case "alteration":
      return typeof o.alteration_id === "string" && !!o.alteration_id.trim();
    case "purchase_order":
      return typeof o.po_id === "string" && !!o.po_id.trim();
    case "qbo_staging":
      return typeof o.sync_log_id === "string" && !!o.sync_log_id.trim();
    case "staff_tasks":
      return typeof o.instance_id === "string" && !!o.instance_id.trim();
    case "orders":
    case "settings":
    case "inventory":
    case "dashboard":
    case "register":
    case "home":
    case "customers":
    case "appointments":
    case "qbo":
    case "staff":
    case "gift-cards":
    case "weddings":
    case "loyalty":
    case "reports":
      return true;
    default:
      return false;
  }
}

export function notificationDestinationLabel(link: unknown): string {
  if (!link || typeof link !== "object") return "Notification";
  const t = (link as Record<string, unknown>).type;
  if (typeof t !== "string" || !t.trim()) return "Notification";

  switch (t) {
    case "order":
    case "orders":
      return "Orders";
    case "wedding_party":
    case "weddings":
      return "Weddings";
    case "alteration":
      return "Alterations";
    case "purchase_order":
      return "Purchase Orders";
    case "qbo_staging":
    case "qbo":
      return "QuickBooks";
    case "inventory":
      return "Inventory";
    case "settings":
      return "Settings";
    case "staff_tasks":
      return "Staff Tasks";
    case "staff":
      return "Staff";
    case "customers":
    case "layaways":
      return "Customers";
    case "dashboard":
    case "home":
      return "Operations";
    case "register":
      return "Register";
    case "appointments":
      return "Appointments";
    case "gift-cards":
      return "Gift Cards";
    case "loyalty":
      return "Loyalty";
    case "reports":
      return "Reports";
    default:
      return "Notification";
  }
}

export function notificationPrimaryInteraction(
  kind: string,
  link: unknown,
): "open" | "preview" {
  const isAnnouncement = kind === "admin_broadcast";
  if (isAnnouncement) return "preview";
  return isActionableNotificationDeepLink(link) ? "open" : "preview";
}

export type NotificationRecencyBucket = "today" | "earlier";

export function notificationRecencyBucket(
  createdAt: string,
  now = Date.now(),
): NotificationRecencyBucket {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return "earlier";

  const nowDate = new Date(now);
  return created.getFullYear() === nowDate.getFullYear() &&
    created.getMonth() === nowDate.getMonth() &&
    created.getDate() === nowDate.getDate()
    ? "today"
    : "earlier";
}

export type NotificationSeverity =
  | "announcement"
  | "info"
  | "action"
  | "urgent"
  | "system";

function semanticNotificationKind(kind: string, link: unknown): string {
  if (kind !== "notification_bundle" || !link || typeof link !== "object") {
    return kind;
  }
  const bundleKind = (link as Record<string, unknown>).bundle_kind;
  return typeof bundleKind === "string" && bundleKind.trim() ? bundleKind : kind;
}

export function notificationSeverity(
  kind: string,
  link: unknown,
): NotificationSeverity {
  const semanticKind = semanticNotificationKind(kind, link);

  switch (semanticKind) {
    case "admin_broadcast":
      return "announcement";
    case "after_hours_access_digest":
    case "backup_admin_cloud_failed":
    case "backup_admin_local_failed":
    case "backup_admin_past_due":
    case "commission_finalize_failed":
    case "counterpoint_alerts":
    case "integration_health_failed":
    case "nuorder_sync_failed":
    case "ops_alert":
    case "pin_failure_digest":
    case "qbo_sync_failed":
    case "register_cash_discrepancy":
    case "staff_bug_report":
      return "system";
    case "negative_available_stock":
    case "order_due_stale":
    case "pickup_stale":
    case "po_direct_invoice_overdue":
    case "po_overdue_receive":
    case "po_partial_receive_stale":
      return "urgent";
    case "alteration_due":
    case "appointment_soon":
    case "gift_card_direct_pos_load":
    case "morning_alteration_due":
    case "morning_po_expected":
    case "morning_refund_queue":
    case "morning_wedding_today":
    case "order_fully_fulfilled":
    case "po_draft_stale":
    case "po_received_unlabeled":
    case "po_submitted_no_expected_date":
    case "rms_r2s_charge":
    case "special_order_ready_to_stage":
    case "task_due_soon":
    case "wedding_soon":
      return "action";
    case "catalog_import_rows_skipped":
    case "customer_merge_completed":
    case "gift_card_expiring_soon":
    case "messaging_unread_nudge":
    case "morning_low_stock":
    case "nuorder_sync_success":
    case "review_invite_sent":
      return "info";
    default:
      return isActionableNotificationDeepLink(link) ? "action" : "info";
  }
}

export function isCompletableNotification(
  kind: string,
  link: unknown,
): boolean {
  if (!link || typeof link !== "object") {
    return kind.toLowerCase().includes("task");
  }
  const type = (link as Record<string, unknown>).type;
  if (type === "staff_tasks") return true;
  const lowerKind = kind.toLowerCase();
  if (lowerKind === "notification_bundle") {
    const bundleKind = (link as Record<string, unknown>).bundle_kind;
    return typeof bundleKind === "string" && bundleKind.toLowerCase().includes("task");
  }
  return lowerKind.includes("task");
}
