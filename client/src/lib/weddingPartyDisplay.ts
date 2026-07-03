/**
 * Canonical ROS wedding party display: groom last name + MMDDYY (e.g. Dan Smith + July 20, 2026 -> SMITH-072026).
 * Mirrors `server::logic::wedding_party_display` for client-only fallbacks.
 */
export function formatWeddingPartyTrackingLabel(
  weddingNumber: string | null | undefined,
  groomName: string | null | undefined,
  eventDateIso: string | null | undefined
): string {
  const explicit = (weddingNumber ?? "").trim();
  if (explicit.length > 0) return explicit;
  const groom = (groomName ?? "").trim();
  const cleaned = groom.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const lastName = cleaned.split(/\s+/).filter(Boolean).at(-1) ?? "";
  const name = lastName.length > 0 ? lastName : "WEDDING";
  if (!eventDateIso) return name;
  const d = String(eventDateIso).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return name;
  const yy = m[1].slice(2);
  return `${name}-${m[2]}${m[3]}${yy}`;
}
