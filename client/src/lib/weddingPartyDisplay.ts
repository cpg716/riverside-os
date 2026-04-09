/**
 * Canonical ROS wedding party display: compact name + MMDDYY (e.g. Newell + May 22, 2026 → Newell-052226).
 * Mirrors `server::logic::wedding_party_display` for client-only fallbacks.
 */
export function formatWeddingPartyTrackingLabel(
  partyName: string | null | undefined,
  groomName: string | null | undefined,
  eventDateIso: string | null | undefined
): string {
  const groom = (groomName ?? "").trim();
  const pn = (partyName ?? "").trim();
  const base = pn.length > 0 ? pn : groom;
  const compact = base.replace(/\s+/g, "");
  const name = compact.length > 0 ? compact : "Party";
  if (!eventDateIso) return name;
  const d = String(eventDateIso).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return name;
  const yy = m[1].slice(2);
  return `${name}-${m[2]}${m[3]}${yy}`;
}
