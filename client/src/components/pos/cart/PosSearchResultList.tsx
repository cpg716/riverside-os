import { Package, ArrowRight } from "lucide-react";
import { type ResolvedSkuItem } from "../types";

export interface SearchResult extends ResolvedSkuItem {
  image_url?: string;
}

interface PosSearchResultListProps {
  search: string;
  groupedSearchResults: SearchResult[][];
  onSearchResultClick: (item: SearchResult) => void;
}

export function PosSearchResultList({
  search,
  groupedSearchResults,
  onSearchResultClick,
}: PosSearchResultListProps) {
  if (groupedSearchResults.length === 0) return null;

  return (
    <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[65vh] overflow-y-auto rounded-3xl border-2 border-app-text bg-app-surface p-3 shadow-[0_32px_96px_-16px_rgba(0,0,0,0.5)] transition-all no-scrollbar">
      <div className="flex flex-col gap-2">
        {groupedSearchResults.map((group) => {
          const item = group[0];
          const isExactSku = group.some(
            (g) => g.sku.toLowerCase() === search.trim().toLowerCase(),
          );
          const variationCount = group.length;

          return (
            <button
              key={item.product_id}
              onClick={() =>
                onSearchResultClick(
                  group.find(
                    (g) =>
                      g.sku.toLowerCase() ===
                      search.trim().toLowerCase(),
                  ) || item,
                )
              }
              className={`group relative flex items-center gap-4 overflow-hidden rounded-2xl border-2 p-4 text-left transition-all ${
                isExactSku
                  ? "border-app-accent bg-app-accent/5"
                  : "border-app-border hover:border-app-border hover:bg-app-surface-2"
              }`}
            >
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-sm transition-transform group-hover:scale-105">
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Package
                    className="m-auto h-full text-app-text-muted opacity-50"
                    size={24}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1 relative z-10">
                <div className="mb-1 flex items-center gap-2">
                  <p className="truncate text-base font-black uppercase italic leading-tight tracking-tighter text-app-text group-hover/name:text-app-accent">
                    {item.name}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-black uppercase tracking-[0.12em] text-app-text-muted">
                    {variationCount > 1
                      ? `${variationCount} Variations`
                      : `SKU: ${item.sku}`}
                  </span>
                  {variationCount === 1 && (
                    <span
                      className={`text-[10px] font-black uppercase tracking-widest ${
                        (item.stock_on_hand || 0) > 0
                          ? "text-emerald-600"
                          : "text-red-500"
                      }`}
                    >
                      {item.stock_on_hand || 0} IN STOCK
                    </span>
                  )}
                </div>
                {variationCount > 1 && !isExactSku && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {group.slice(0, 4).map((v) => (
                      <span
                        key={v.sku}
                        className="rounded-lg bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted"
                      >
                        {v.variation_label || v.sku.slice(-4)}
                      </span>
                    ))}
                    {variationCount > 4 && (
                      <span className="rounded-lg bg-app-surface-2 px-2 py-1 text-[9px] font-black text-app-text-muted">
                        +{variationCount - 4} More
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xl font-black italic tracking-tighter text-app-text tabular-nums">
                  ${item.standard_retail_price}
                </p>
                <div className="mt-1 flex translate-x-2 items-center justify-end font-black text-app-accent opacity-0 transition-opacity group-hover:translate-x-0 group-hover:opacity-100">
                  <span className="text-[10px] uppercase tracking-tighter">
                    {variationCount > 1 && !isExactSku
                      ? "Size Select"
                      : "Add Cart"}
                  </span>
                  <ArrowRight size={14} />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
