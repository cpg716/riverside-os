import React, { useEffect, useMemo, useState } from "react";
import {
  Search,
  Globe,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  Check,
  Package,
  Activity,
} from "lucide-react";
import { List, RowComponentProps } from "react-window";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { sortVariantsByVariation } from "../../lib/variantSort";
import type { HubVariant } from "./VariationsWorkspace";

type VariantPatch =
  | { quantity_delta: number; notes: string }
  | { web_published: boolean }
  | { track_low_stock: boolean }
  | { retail_price_override: string }
  | { clear_retail_override: boolean }
  | { sale_price_override: string }
  | { clear_sale_override: boolean }
  | { cost_override: string | null };

export interface VariationsListProps {
  variants: HubVariant[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onUpdateVariant: (id: string, patch: VariantPatch) => Promise<unknown>;
  onShowMaintenance: (
    id: string,
    sku: string,
    type: "damaged" | "return_to_vendor",
  ) => void;
  onShowCountCorrection: (id: string, sku: string, delta: number) => void;
}

const ROW_HEIGHT = 100;

interface RowData {
  variants: HubVariant[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onUpdateVariant: (id: string, patch: VariantPatch) => Promise<unknown>;
  onShowMaintenance: (
    id: string,
    sku: string,
    type: "damaged" | "return_to_vendor",
  ) => void;
  onShowCountCorrection: (id: string, sku: string, delta: number) => void;
}

function ListRetailControl({
  variant,
  onUpdate,
}: {
  variant: HubVariant;
  onUpdate: (patch: VariantPatch) => Promise<unknown>;
}) {
  const inheritsParent = variant.retail_price_override == null;
  const [useParent, setUseParent] = useState(inheritsParent);
  const [draft, setDraft] = useState(
    variant.retail_price_override ?? variant.effective_retail,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUseParent(inheritsParent);
    setDraft(variant.retail_price_override ?? variant.effective_retail);
    setError(null);
  }, [inheritsParent, variant.effective_retail, variant.id, variant.retail_price_override]);

  const toggleParent = async (checked: boolean) => {
    setUseParent(checked);
    setError(null);
    if (!checked || inheritsParent) return;
    setSaving(true);
    try {
      await onUpdate({ clear_retail_override: true });
    } catch (updateError) {
      setUseParent(false);
      setError(updateError instanceof Error ? updateError.message : "Price update failed.");
    } finally {
      setSaving(false);
    }
  };

  const saveOverride = async () => {
    const trimmed = draft.trim();
    if (!/^(?:\d+|\d*\.\d{1,2})$/.test(trimmed)) {
      setError("Enter a valid retail price.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onUpdate({
        retail_price_override: centsToFixed2(parseMoneyToCents(trimmed)),
      });
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Price update failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
        <input
          type="checkbox"
          checked={useParent}
          disabled={saving}
          onChange={(event) => void toggleParent(event.target.checked)}
          className="h-3.5 w-3.5 accent-app-accent"
        />
        Parent price
      </label>
      {useParent ? (
        <span className="text-sm font-black tabular-nums tracking-tight text-app-text">
          ${centsToFixed2(parseMoneyToCents(variant.effective_retail))}
        </span>
      ) : (
        <div className="flex items-center justify-end gap-1">
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            aria-label={`Retail override for ${variant.sku}`}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveOverride();
            }}
            className="h-7 w-20 rounded-lg border border-app-border bg-app-surface px-2 text-right text-[11px] font-black tabular-nums"
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveOverride()}
            className="rounded-md bg-app-accent px-2 py-1 text-[9px] font-black uppercase text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
      {error ? (
        <span className="max-w-48 text-right text-[9px] font-bold text-app-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const Row = ({ index, style, ...rowProps }: RowComponentProps<RowData>) => {
  const v = rowProps.variants[index];
  if (!v) return null;

  const isSelected = rowProps.selectedIds.has(v.id);
  const stockColor =
    v.stock_on_hand <= 0
      ? "text-red-500"
      : v.stock_on_hand <= (v.reorder_point ?? 0)
        ? "text-amber-500"
        : "text-emerald-500";

  return (
    <div
      style={style}
      className={`group flex items-center border-b border-app-border/20 px-5 transition-all duration-200 ${
        isSelected ? "bg-app-accent/[0.04] active" : "hover:bg-app-surface-2/60"
      }`}
    >
      <div className="w-14 shrink-0">
        <button
          onClick={() => rowProps.onToggleSelect(v.id)}
          style={{
            backgroundColor: isSelected ? "var(--app-accent)" : "transparent",
          }}
          className={`flex h-5 w-5 items-center justify-center rounded-lg border-2 transition-all duration-300 ${
            isSelected
              ? "border-app-accent shadow-lg"
              : "border-app-border/40 group-hover:border-app-accent/50 hover:bg-app-surface-2"
          }`}
        >
          {isSelected && (
            <Check size={12} strokeWidth={4} className="text-white" />
          )}
        </button>
      </div>

      <div className="flex-1 min-w-0 pr-4">
        <div className="flex flex-col">
          <span className="font-mono text-[14px] font-black tracking-tight text-app-text group-hover:text-app-accent transition-colors truncate">
            {v.sku}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted mt-0.5 opacity-60 truncate">
            {v.variation_label || "Standard / Default"}
          </span>
        </div>
      </div>

      <div className="w-48 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span
              className={`text-xl font-black tabular-nums tracking-tighter ${stockColor}`}
            >
              {v.stock_on_hand}
            </span>
            <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
              Units
            </span>
          </div>

          <div className="flex items-center gap-1 rounded-xl bg-app-surface-2/80 p-1 transition-all duration-300">
            <button
              onClick={() => rowProps.onShowCountCorrection(v.id, v.sku, 1)}
              className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-emerald-500/10 hover:text-emerald-500 text-app-text-muted"
              title="Count correction: add 1 unit"
            >
              <ChevronUp size={16} strokeWidth={3} />
            </button>
            <button
              onClick={() => rowProps.onShowCountCorrection(v.id, v.sku, -1)}
              className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-red-500/10 hover:text-red-500 text-app-text-muted"
              title="Count correction: subtract 1 unit"
            >
              <ChevronDown size={16} strokeWidth={3} />
            </button>
          </div>
        </div>
      </div>

      <div className="w-56 shrink-0 pr-4">
        <div className="flex flex-col gap-1 text-right">
          <ListRetailControl
            variant={v}
            onUpdate={(patch) => rowProps.onUpdateVariant(v.id, patch)}
          />
          <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
            Retail
          </span>
          <span className="text-xs font-black tabular-nums tracking-tight text-app-accent">
            {v.effective_sale
              ? `$${centsToFixed2(parseMoneyToCents(v.effective_sale))}`
              : "—"}
          </span>
          <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
            Sale
          </span>
        </div>
      </div>

      <div className="w-28 shrink-0">
        <button
          onClick={() =>
            void rowProps.onUpdateVariant(v.id, {
              web_published: !v.web_published,
            })
          }
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-[0.11em] transition-all duration-300 ${
            v.web_published
              ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
              : "bg-app-surface-2 text-app-text-muted opacity-60"
          }`}
        >
          <Globe
            size={14}
            className={v.web_published ? "text-emerald-500" : "opacity-40"}
          />
          <span>{v.web_published ? "Live" : "Draft"}</span>
        </button>
      </div>

      <div className="flex w-40 shrink-0 justify-end gap-1.5 pr-1 transition-all duration-300">
        <button
          onClick={() => rowProps.onShowMaintenance(v.id, v.sku, "damaged")}
          className="group/btn inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl border border-red-500/10 bg-red-500/5 px-2.5 py-2 text-[10px] font-black uppercase leading-tight tracking-[0.08em] text-red-600 shadow-sm transition-all hover:bg-red-500 hover:text-white"
        >
          <AlertTriangle size={14} className="shrink-0" />
          Damage
        </button>
        <button
          onClick={() =>
            rowProps.onShowMaintenance(v.id, v.sku, "return_to_vendor")
          }
          className="group/btn inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl border border-app-accent/10 bg-app-accent/5 px-2.5 py-2 text-[10px] font-black uppercase leading-tight tracking-[0.08em] text-app-accent shadow-sm transition-all hover:bg-app-accent hover:text-white"
        >
          <Package size={14} className="shrink-0" />
          RTV
        </button>
      </div>
    </div>
  );
};

export const VariationsList: React.FC<VariationsListProps> = ({
  variants,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
  onUpdateVariant,
  onShowMaintenance,
  onShowCountCorrection,
}) => {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<
    "sku" | "stock_on_hand" | "effective_retail"
  >("sku");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const filteredAndSorted = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const result = variants.filter(
      (v) =>
        v.sku.toLowerCase().includes(needle) ||
        (v.variation_label || "").toLowerCase().includes(needle),
    );
    const naturallyOrdered = sortVariantsByVariation(result);

    if (sortField === "sku") {
      return sortDir === "asc" ? naturallyOrdered : naturallyOrdered.reverse();
    }

    const naturalIndex = new Map(
      naturallyOrdered.map((variant, index) => [variant.id, index]),
    );
    result.sort((a, b) => {
      const mod = sortDir === "asc" ? 1 : -1;
      if (sortField === "stock_on_hand") {
        const comparison = (a.stock_on_hand - b.stock_on_hand) * mod;
        if (comparison !== 0) return comparison;
      } else {
        const priceA = parseMoneyToCents(a.effective_retail);
        const priceB = parseMoneyToCents(b.effective_retail);
        const comparison = (priceA - priceB) * mod;
        if (comparison !== 0) return comparison;
      }
      return (naturalIndex.get(a.id) ?? 0) - (naturalIndex.get(b.id) ?? 0);
    });

    return result;
  }, [variants, search, sortField, sortDir]);

  const toggleSort = (field: "sku" | "stock_on_hand" | "effective_retail") => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortField(field);
    setSortDir("asc");
  };

  const isAllSelected =
    filteredAndSorted.length > 0 &&
    filteredAndSorted.every((v) => selectedIds.has(v.id));

  const rowData: RowData = {
    variants: filteredAndSorted,
    selectedIds,
    onToggleSelect,
    onUpdateVariant,
    onShowMaintenance,
    onShowCountCorrection,
  };

  return (
    <div className="flex flex-col gap-4 animate-in fade-in duration-500 h-[640px]">
      <div className="flex items-center gap-3 rounded-[24px] border border-app-border/70 bg-app-surface p-2 shadow-xl shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted opacity-50" />
          <input
            type="text"
            placeholder="Filter matrix SKUs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-2xl border-none bg-transparent py-3 pl-12 pr-4 text-sm font-black tracking-tight text-app-text outline-none focus:ring-0 placeholder:text-app-text-muted/40"
          />
        </div>
        <div className="h-10 w-px bg-app-border/20" />
        <div className="flex items-center gap-3 px-4">
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">
              High-Density Matrix
            </span>
            <span className="text-[13px] font-black text-app-text tabular-nums tracking-tighter">
              {filteredAndSorted.length} variants
            </span>
          </div>
          <Activity size={20} className="text-app-accent/40 animate-pulse" />
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-[32px] border border-app-border/60 bg-app-surface shadow-2xl ring-1 ring-black/5 flex flex-col">
        <div className="flex items-center bg-app-surface-2 border-b border-app-border/50 h-12 px-5 sticky top-0 z-20 shrink-0">
          <div className="w-14">
            <button
              onClick={isAllSelected ? onDeselectAll : onSelectAll}
              style={{
                backgroundColor: isAllSelected
                  ? "var(--app-accent)"
                  : "transparent",
              }}
              className={`flex h-5 w-5 items-center justify-center rounded-lg border-2 transition-all duration-300 ${
                isAllSelected
                  ? "border-app-accent shadow-lg"
                  : "border-app-border/50 hover:border-app-accent hover:bg-app-accent/5"
              }`}
            >
              {isAllSelected && (
                <Check size={12} strokeWidth={4} className="text-white" />
              )}
            </button>
          </div>
          <button
            type="button"
            className="ui-touch-target flex-1 cursor-pointer text-left font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted"
            onClick={() => toggleSort("sku")}
          >
            SKU / Variant
          </button>
          <button
            type="button"
            className="ui-touch-target w-48 cursor-pointer text-left font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted"
            onClick={() => toggleSort("stock_on_hand")}
          >
            Units SOH
          </button>
          <button
            type="button"
            className="ui-touch-target w-40 cursor-pointer pr-4 text-right font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted"
            onClick={() => toggleSort("effective_retail")}
          >
            Retail / Sale
          </button>
          <div className="w-28 text-center font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted">
            Web
          </div>
          <div className="w-40 pr-1 text-right font-black uppercase tracking-[0.16em] text-[10px] text-app-text-muted">
            Actions
          </div>
        </div>

        <List
          rowComponent={Row}
          rowCount={filteredAndSorted.length}
          rowHeight={ROW_HEIGHT}
          rowProps={rowData}
          className="flex-1"
        />
      </div>
    </div>
  );
};

export default VariationsList;
