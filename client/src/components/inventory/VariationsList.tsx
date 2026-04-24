import React, { useMemo, useState } from "react";
import {
  Search,
  Globe,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  Check,
  Package,
  Activity,
  Info,
} from "lucide-react";
import { List, RowComponentProps } from "react-window";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import type { HubVariant } from "./VariationsWorkspace";

type VariantPatch =
  | { quantity_delta: number }
  | { web_published: boolean }
  | { track_low_stock: boolean }
  | { retail_price_override: string | null };

export interface VariationsListProps {
  variants: HubVariant[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onUpdateVariant: (id: string, patch: VariantPatch) => Promise<void>;
  onShowMaintenance: (
    id: string,
    sku: string,
    type: "damaged" | "return_to_vendor",
  ) => void;
}

const ROW_HEIGHT = 84;

interface RowData {
  variants: HubVariant[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onUpdateVariant: (id: string, patch: VariantPatch) => Promise<void>;
  onShowMaintenance: (
    id: string,
    sku: string,
    type: "damaged" | "return_to_vendor",
  ) => void;
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

          <div className="flex items-center gap-1 rounded-xl bg-app-surface-2/80 p-1 opacity-0 group-hover:opacity-100 transition-all duration-300">
            <button
              onClick={() =>
                void rowProps.onUpdateVariant(v.id, { quantity_delta: 1 })
              }
              className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-emerald-500/10 hover:text-emerald-500 text-app-text-muted"
              title="Add 1 Unit"
            >
              <ChevronUp size={16} strokeWidth={3} />
            </button>
            <button
              onClick={() =>
                void rowProps.onUpdateVariant(v.id, { quantity_delta: -1 })
              }
              className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-red-500/10 hover:text-red-500 text-app-text-muted"
              title="Subtract 1 Unit"
            >
              <ChevronDown size={16} strokeWidth={3} />
            </button>
          </div>
        </div>
      </div>

      <div className="w-32 shrink-0 pr-4">
        <div className="flex flex-col text-right">
          <div className="flex items-center justify-end gap-1">
            <span className="text-sm font-black tabular-nums tracking-tight text-app-text">
              ${centsToFixed2(parseMoneyToCents(v.effective_retail))}
            </span>
            {v.retail_price_override && (
              <div
                className="animate-pulse text-app-accent"
                title="Price Override Active"
              >
                <Info size={10} />
              </div>
            )}
          </div>
          <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
            Retail
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

      <div className="w-48 shrink-0 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-all duration-300">
        <button
          onClick={() => rowProps.onShowMaintenance(v.id, v.sku, "damaged")}
          className="group/btn flex items-center gap-2 rounded-xl border border-red-500/10 bg-red-500/5 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-600 hover:bg-red-500 hover:text-white transition-all shadow-sm"
        >
          <AlertTriangle size={14} />
          Damage
        </button>
        <button
          onClick={() =>
            rowProps.onShowMaintenance(v.id, v.sku, "return_to_vendor")
          }
          className="group/btn flex items-center gap-2 rounded-xl border border-app-accent/10 bg-app-accent/5 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent hover:bg-app-accent hover:text-white transition-all shadow-sm"
        >
          <Package size={14} />
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

    result.sort((a, b) => {
      const mod = sortDir === "asc" ? 1 : -1;

      if (sortField === "sku") {
        return a.sku.localeCompare(b.sku) * mod;
      }

      if (sortField === "stock_on_hand") {
        return (a.stock_on_hand - b.stock_on_hand) * mod;
      }

      const priceA = parseMoneyToCents(a.effective_retail);
      const priceB = parseMoneyToCents(b.effective_retail);
      return (priceA - priceB) * mod;
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
          <div
            className="flex-1 cursor-pointer font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted"
            onClick={() => toggleSort("sku")}
          >
            SKU / Variant
          </div>
          <div
            className="w-48 cursor-pointer font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted"
            onClick={() => toggleSort("stock_on_hand")}
          >
            Units SOH
          </div>
          <div
            className="w-32 cursor-pointer pr-4 text-right font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted"
            onClick={() => toggleSort("effective_retail")}
          >
            Retail
          </div>
          <div className="w-28 text-center font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted">
            Web
          </div>
          <div className="w-48 text-right font-black uppercase tracking-[0.2em] text-[10px] text-app-text-muted">
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
