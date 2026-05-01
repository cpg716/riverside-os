import { Package, ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [openUpward, setOpenUpward] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (groupedSearchResults.length === 0) {
      setOpenUpward(false);
      return;
    }

    const recomputePlacement = () => {
      const panel = panelRef.current;
      const anchor = panel?.parentElement;
      if (!panel || !anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const spaceAbove = anchorRect.top;
      const panelHeight = Math.min(
        panel.getBoundingClientRect().height,
        window.innerHeight * 0.65,
      );
      setOpenUpward(spaceBelow < panelHeight && spaceAbove > spaceBelow);
    };

    recomputePlacement();
    window.addEventListener("resize", recomputePlacement);
    window.addEventListener("scroll", recomputePlacement, true);
    return () => {
      window.removeEventListener("resize", recomputePlacement);
      window.removeEventListener("scroll", recomputePlacement, true);
    };
  }, [groupedSearchResults.length, search]);

  if (groupedSearchResults.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className={`absolute left-0 right-0 z-50 max-h-[65vh] overflow-y-auto rounded-3xl border-2 border-app-text bg-app-surface p-3 shadow-[0_32px_96px_-16px_rgba(0,0,0,0.5)] transition-all no-scrollbar ${
        openUpward ? "bottom-full mb-2" : "top-full mt-2"
      }`}
    >
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
              className={`group relative flex min-h-[76px] items-start gap-3 overflow-hidden rounded-2xl border-2 p-3 text-left transition-all sm:min-h-[88px] sm:items-center sm:gap-4 sm:p-4 ${
                isExactSku
                  ? "border-app-accent bg-app-accent/5"
                  : "border-app-border hover:border-app-border hover:bg-app-surface-2"
              }`}
            >
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-sm transition-transform group-hover:scale-105 sm:h-16 sm:w-16">
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
              <div className="relative z-10 min-w-0 flex-1">
                <div className="mb-1 flex min-w-0 items-center gap-2">
                  <p className="line-clamp-2 text-sm font-black leading-snug text-app-text sm:text-base">
                    {item.name}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs font-black uppercase tracking-wide text-app-text-muted">
                    {variationCount > 1
                      ? `${variationCount} Variations`
                      : `SKU: ${item.sku}`}
                  </span>
                  {variationCount === 1 && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-black uppercase tracking-wide ${
                        (item.stock_on_hand || 0) > 0
                          ? "bg-emerald-600/10 text-emerald-700"
                          : "bg-red-500/10 text-red-600"
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
                        className="rounded-lg bg-app-surface-2 px-2 py-1 text-xs font-black uppercase tracking-wide text-app-text-muted"
                      >
                        {v.variation_label || v.sku.slice(-4)}
                      </span>
                    ))}
                    {variationCount > 4 && (
                      <span className="rounded-lg bg-app-surface-2 px-2 py-1 text-xs font-black text-app-text-muted">
                        +{variationCount - 4} More
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-lg font-black tabular-nums text-app-text sm:text-xl">
                  ${item.standard_retail_price}
                </p>
                <div className="mt-1 flex items-center justify-end font-black text-app-accent">
                  <span className="text-xs uppercase tracking-wide">
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
