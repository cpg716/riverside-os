/**
 * ROS `WeddingPartyWithMembers` serializes with #[serde(flatten)]: party columns are top-level with `members`.
 * Legacy clients expected `{ party: { id, ... }, members }`.
 */

export function splitWeddingPartyWithMembers(row: unknown): {
  party: Record<string, unknown> | null;
  members: unknown[];
} {
  if (!row || typeof row !== "object") return { party: null, members: [] };
  const r = row as Record<string, unknown>;
  const nested = r.party;
  if (nested && typeof nested === "object" && nested !== null && (nested as Record<string, unknown>).id != null) {
    return {
      party: nested as Record<string, unknown>,
      members: Array.isArray(r.members) ? r.members : [],
    };
  }
  const { members, ...party } = r;
  if (party.id == null) return { party: null, members: [] };
  return {
    party,
    members: Array.isArray(members) ? members : [],
  };
}

export function partyIdFromWeddingCreateResponse(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const nested = d.party;
  if (nested && typeof nested === "object" && nested !== null && (nested as Record<string, unknown>).id != null) {
    return String((nested as Record<string, unknown>).id);
  }
  if (d.id != null) return String(d.id);
  return undefined;
}
