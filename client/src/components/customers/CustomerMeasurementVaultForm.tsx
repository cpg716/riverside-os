import { VAULT_MEASUREMENT_FIELDS } from "./retailMeasurementLabels";



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
