import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, ChevronDown, Search } from "lucide-react";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

export interface VendorOption {
  id: string;
  name: string;
}

function money(v: string) {
  return formatUsdFromCents(parseMoneyToCents(v || "0"));
}

/**
 * Searchable primary-vendor combobox for the control board. When a vendor is
 * selected and `scopedStockValue` is set (WAC value on hand from board stats),
 * the trigger shows that dollar figure.
 */
export default function VendorFilterChip({
  vendors,
  selectedVendorId,
  onSelect,
  scopedStockValue,
}: {
  vendors: VendorOption[];
  selectedVendorId: string | null;
  onSelect: (id: string | null) => void;
  /** Raw decimal string from API `stats.total_asset_value` when this vendor is active. */
  scopedStockValue?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selectedName = useMemo(() => {
    if (!selectedVendorId) return null;
    return vendors.find((v) => v.id === selectedVendorId)?.name ?? null;
  }, [vendors, selectedVendorId]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return vendors;
    return vendors.filter((v) => v.name.toLowerCase().includes(n));
  }, [vendors, q]);

  const triggerLabel = selectedVendorId
    ? selectedName
      ? scopedStockValue != null && scopedStockValue !== ""
        ? `${selectedName} · ${money(scopedStockValue)} on hand`
        : selectedName
      : selectedVendorId
    : "All vendors";

  return (
    <div ref={rootRef} className="relative min-w-[12rem]">
      <p className="mb-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
        Primary vendor
      </p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-left text-xs font-bold text-app-text shadow-sm transition-colors hover:border-app-input-border"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Filter catalog by template primary vendor"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Building2
            className="h-4 w-4 shrink-0 text-app-accent-2"
            aria-hidden
          />
          <span className="truncate">{triggerLabel}</span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-app-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-xl">
          <div className="relative border-b border-app-border p-2">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted"
              aria-hidden
            />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search vendors…"
              className="w-full rounded-lg border border-app-border py-2 pl-9 pr-2 text-xs text-app-text outline-none ring-app-accent focus:ring-2"
            />
          </div>
          <ul
            className="max-h-52 overflow-y-auto py-1"
            role="listbox"
            aria-label="Vendors"
          >
            <li role="option">
              <button
                type="button"
                onClick={() => {
                  onSelect(null);
                  setOpen(false);
                  setQ("");
                }}
                className={`w-full px-3 py-2 text-left text-xs font-semibold transition-colors hover:bg-app-surface-2 ${
                  !selectedVendorId ? "bg-app-accent/10 text-app-text" : ""
                }`}
              >
                All vendors
              </button>
            </li>
            {filtered.map((v) => (
              <li key={v.id} role="option">
                <button
                  type="button"
                  onClick={() => {
                    onSelect(v.id);
                    setOpen(false);
                    setQ("");
                  }}
                  className={`w-full px-3 py-2 text-left text-xs font-semibold transition-colors hover:bg-app-surface-2 ${
                    selectedVendorId === v.id
                      ? "bg-app-accent-2/15 text-app-text"
                      : ""
                  }`}
                >
                  {v.name}
                </button>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-app-text-muted">
                No matches
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
