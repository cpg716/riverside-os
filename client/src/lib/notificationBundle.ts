import type {
  NotificationDeepLink,
  NotificationRow,
} from "../context/NotificationCenterContext";

export type BundleListItem = {
  title: string;
  subtitle: string;
  deep_link: NotificationDeepLink;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True if `deep_link` is a bundled notification with navigable rows. */
export function parseNotificationBundle(
  deepLink: NotificationRow["deep_link"],
): BundleListItem[] | null {
  const root = deepLink as unknown;
  if (!isRecord(root)) return null;
  if (root.type !== "notification_bundle") return null;
  const rawItems = root.items;
  if (!Array.isArray(rawItems)) return null;
  const out: BundleListItem[] = [];
  for (const el of rawItems) {
    if (!isRecord(el)) continue;
    const dl = el.deep_link;
    if (isRecord(dl) && typeof dl.type === "string" && dl.type) {
      const title =
        typeof el.title === "string" && el.title.trim() ? el.title.trim() : "";
      const subtitle =
        typeof el.subtitle === "string" && el.subtitle.trim()
          ? el.subtitle.trim()
          : "";
      if (!title) continue;
      out.push({
        title,
        subtitle,
        deep_link: dl as NotificationDeepLink,
      });
      continue;
    }
    const sku = typeof el.sku === "string" ? el.sku.trim() : "";
    const product_id =
      typeof el.product_id === "string" ? el.product_id.trim() : "";
    if (sku && product_id) {
      const product_name =
        typeof el.product_name === "string" ? el.product_name.trim() : "";
      const available = Number(el.available);
      const on_hand = Number(el.on_hand);
      const sub =
        Number.isFinite(available) && Number.isFinite(on_hand)
          ? `${product_name || sku} — available ${Math.trunc(available)} (on hand ${Math.trunc(on_hand)})`
          : product_name || sku;
      out.push({
        title: sku,
        subtitle: sub,
        deep_link: {
          type: "inventory",
          section: "list",
          product_id,
        },
      });
    }
  }
  return out.length > 0 ? out : null;
}
