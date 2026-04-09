import {
  STAFF_AVATAR_CATALOG,
  STAFF_AVATAR_KEYS,
  type StaffAvatarCatalogEntry,
  type StaffAvatarKey,
} from "./staffAvatarCatalog.generated";

const KEY_SET = new Set<string>(STAFF_AVATAR_KEYS);

/** Public URL path for a bundled staff portrait SVG. */
export function staffAvatarUrl(key: string | null | undefined): string {
  const k = (key ?? "").trim() || "ros_default";
  const safe = KEY_SET.has(k) ? k : "ros_default";
  return `/staff-avatars/${safe}.svg`;
}

export function isKnownStaffAvatarKey(key: string): key is StaffAvatarKey {
  return KEY_SET.has(key.trim());
}

export { STAFF_AVATAR_CATALOG, STAFF_AVATAR_KEYS };
export type { StaffAvatarCatalogEntry, StaffAvatarKey };

const GROUP_LABEL: Record<StaffAvatarCatalogEntry["group"], string> = {
  default: "Default",
  lorelei: "Realistic style",
  avataaars: "Friendly cartoon",
  adventurer: "Bold cartoon",
};

export function staffAvatarGroupLabel(group: StaffAvatarCatalogEntry["group"]): string {
  return GROUP_LABEL[group] ?? group;
}
