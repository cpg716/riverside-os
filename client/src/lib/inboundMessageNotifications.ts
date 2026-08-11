import type { NotificationRow } from "../context/NotificationCenterContextLogic";

function semanticKind(row: NotificationRow): string {
  if (row.deep_link?.type !== "notification_bundle") return row.kind;
  const bundleKind = row.deep_link.bundle_kind;
  return typeof bundleKind === "string" && bundleKind.trim()
    ? bundleKind.trim()
    : row.kind;
}

export function inboundMessagePopupTitle(row: NotificationRow): string | null {
  const kind = semanticKind(row);
  if (
    kind === "podium_sms_bundle" ||
    kind === "podium_email_bundle" ||
    kind === "podium_sms_inbound" ||
    kind === "podium_email_inbound"
  ) {
    return row.title.trim() || "New Podium message";
  }
  if (kind === "store_email_inbound") {
    return row.title.trim() || "New store email";
  }
  return null;
}

export function inboundMessageNotificationFingerprint(row: NotificationRow): string {
  return JSON.stringify([
    row.notification_id,
    row.created_at,
    row.title,
    row.body,
    row.deep_link,
  ]);
}
