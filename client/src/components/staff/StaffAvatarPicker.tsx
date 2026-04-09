import { useMemo, useState } from "react";
import {
  STAFF_AVATAR_CATALOG,
  staffAvatarGroupLabel,
  staffAvatarUrl,
  type StaffAvatarCatalogEntry,
} from "../../lib/staffAvatars";

export default function StaffAvatarPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState<string>("all");

  const groups = useMemo(() => {
    const g = new Set(STAFF_AVATAR_CATALOG.map((e) => e.group));
    return ["all", ...Array.from(g)] as const;
  }, []);

  const filtered: StaffAvatarCatalogEntry[] = useMemo(() => {
    if (filter === "all") return STAFF_AVATAR_CATALOG;
    return STAFF_AVATAR_CATALOG.filter((e) => e.group === filter);
  }, [filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <button
            key={g}
            type="button"
            disabled={disabled}
            onClick={() => setFilter(g)}
            className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest transition-colors ${
              filter === g
                ? "border-app-accent bg-app-accent/15 text-app-text"
                : "border-app-border text-app-text-muted hover:border-app-accent/40"
            } disabled:opacity-50`}
          >
            {g === "all" ? "All" : staffAvatarGroupLabel(g as StaffAvatarCatalogEntry["group"])}
          </button>
        ))}
      </div>
      <div className="grid max-h-[280px] grid-cols-6 gap-2 overflow-y-auto rounded-xl border border-app-border bg-app-surface-2/40 p-3 sm:grid-cols-8">
        {filtered.map((e) => {
          const active = e.key === value;
          return (
            <button
              key={e.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange(e.key)}
              title={e.key}
              className={`relative aspect-square overflow-hidden rounded-xl border-2 transition-all ${
                active
                  ? "border-app-accent ring-2 ring-app-accent/30"
                  : "border-transparent hover:border-app-border"
              } disabled:opacity-50`}
            >
              <img
                src={staffAvatarUrl(e.key)}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
