import { getBaseUrl } from "./apiConfig";
import {
  STAFF_AVATAR_CATALOG,
  STAFF_AVATAR_KEYS,
  type StaffAvatarCatalogEntry,
  type StaffAvatarKey,
} from "./staffAvatarCatalog.generated";

const KEY_SET = new Set<string>(STAFF_AVATAR_KEYS);

/** Public URL path for a staff portrait.
 *  If `photoUrl` is provided (real uploaded photo), it takes precedence.
 *  Otherwise falls back to the bundled SVG avatar keyed by `key`.
 */
export function staffAvatarUrl(
  key: string | null | undefined,
  photoUrl?: string | null | undefined,
): string {
  if (photoUrl) {
    const baseUrl = getBaseUrl();
    return `${baseUrl}${photoUrl}`;
  }
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
