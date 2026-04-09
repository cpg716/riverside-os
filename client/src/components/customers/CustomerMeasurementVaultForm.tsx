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

export default function CustomerMeasurementVaultForm({
  draft,
  onDraftChange,
  disabled = false,
  gridClassName = "grid gap-2 sm:grid-cols-2 lg:grid-cols-3",
}: {
  draft: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
  disabled?: boolean;
  gridClassName?: string;
}) {
  return (
    <div className={gridClassName}>
      {VAULT_MEASUREMENT_FIELDS.map(({ key, label, kind }) => (
        <label
          key={key}
          className="block rounded-xl border border-app-border bg-app-surface-2 px-3 py-2"
        >
          <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            {label}
          </span>
          <input
            className="ui-input mt-1 w-full font-mono text-sm font-semibold disabled:opacity-50"
            value={draft[key] ?? ""}
            onChange={(e) => onDraftChange(key, e.target.value)}
            inputMode={kind === "text" ? "text" : "decimal"}
            disabled={disabled}
          />
        </label>
      ))}
    </div>
  );
}
