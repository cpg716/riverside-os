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
    case "orders":
      return true;
    case "settings":
      return typeof o.section === "string" && !!o.section.trim();
    case "inventory":
      return typeof o.section === "string" && !!o.section.trim();
    case "dashboard":
      return typeof o.subsection === "string" && !!o.subsection.trim();
    case "register":
      return true;
    case "home":
      return typeof o.subsection === "string" && !!o.subsection.trim();
    case "customers":
      return typeof o.subsection === "string" && !!o.subsection.trim();
    case "appointments":
      return typeof o.section === "string" && !!o.section.trim();
    case "qbo":
      return typeof o.section === "string" && !!o.section.trim();
    case "staff":
      return typeof o.section === "string" && !!o.section.trim();
    case "staff_tasks":
      return typeof o.instance_id === "string" && !!o.instance_id.trim();
    case "gift-cards":
      return typeof o.section === "string" && !!o.section.trim();
    default:
      return false;
  }
}
