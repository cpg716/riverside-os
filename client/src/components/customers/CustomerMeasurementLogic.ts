import { VAULT_MEASUREMENT_FIELDS } from "./retailMeasurementLabels";

/** Minimal vault row shape from `GET .../measurements`. */
export type VaultMeasurementLatest = Record<string, string | number | null | undefined>;

export function measurementDraftFromLatest(latest: unknown): Record<string, string> {
  if (!latest || typeof latest !== "object") return {};
  const row = latest as Record<string, unknown>;
  const d: Record<string, string> = {};
  for (const { key } of VAULT_MEASUREMENT_FIELDS) {
    const v = row[key];
    d[key] = v != null && String(v).trim() !== "" ? String(v) : "";
  }
  return d;
}

/** Build JSON body for `PATCH .../measurements` (non-empty fields only). */
export function serializeMeasurementPatch(draft: Record<string, string>): Record<string, string | number> {
  const body: Record<string, string | number> = {};
  for (const { key, kind } of VAULT_MEASUREMENT_FIELDS) {
    const raw = (draft[key] ?? "").trim();
    if (!raw) continue;
    if (kind === "text") {
      body[key] = raw;
    } else {
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n)) body[key] = n;
    }
  }
  return body;
}
