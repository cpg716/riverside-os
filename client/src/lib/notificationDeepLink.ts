import type { NotificationDeepLink } from "../context/NotificationCenterContextLogic";

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
      return typeof o.order_id === "string" && !!o.order_id.trim();
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
