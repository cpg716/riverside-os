import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useState } from "react";
import { 
  Package, 
  ShoppingCart, 
  X,
  AlertCircle,
  Gem,
  CircleDollarSign
} from "lucide-react";
import {
  centsToFixed2,
  formatUsdFromCents,
  parseMoney,
  parseMoneyToCents,
} from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

interface ProductIntelligence {
  variant_id: string;
  product_id: string;
  sku: string;
  name: string;
  variation_label: string | null;
  stock_on_hand: number;
  reserved_stock: number;
  available_stock: number;
  qty_on_order: number;
  unit_cost: string | null;
  retail_price: string;
  last_sale_date: string | null;
}

interface ProductIntelligenceDrawerProps {
  variantId: string | null;
  onClose: () => void;
  onAddToSale?: (
    sku: string,
    priceOverride?: string,
  ) => void | Promise<void>;
}

export default function ProductIntelligenceDrawer({
  variantId,
  onClose,
  onAddToSale,
}: ProductIntelligenceDrawerProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [data, setData] = useState<ProductIntelligence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceOverride, setPriceOverride] = useState("");

  const baseUrl = getBaseUrl();

  useEffect(() => {
    if (!variantId) {
      setData(null);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...mergedPosStaffHeaders(backofficeHeaders),
        };

        const res = await fetch(`${baseUrl}/api/inventory/intelligence/${variantId}`, { headers });
        if (!res.ok) throw new Error("Failed to fetch product intelligence");
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Fetch error");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [variantId, baseUrl, backofficeHeaders]);

  const handleNumpadKey = (key: string) => {
    if (key === "CLR") {
      setPriceOverride("");
      return;
    }

    if (key === "%" || key === "$") {
      if (!priceOverride || !data) return;
      if (key === "%") {
        const discountPercent = parseMoney(priceOverride);
        const baseCents = parseMoneyToCents(data.retail_price);
        const newCents = Math.round(
          (baseCents * (100 - discountPercent)) / 100,
        );
        setPriceOverride(centsToFixed2(newCents));
      } else {
        setPriceOverride(centsToFixed2(parseMoneyToCents(priceOverride)));
      }
      return;
    }

    setPriceOverride(prev => {
      if (key === "." && prev.includes(".")) return prev;
      return (prev + key).slice(0, 10);
    });
  };

  if (!variantId) return null;

  return (
    <>
      <div 
        className={`fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${variantId ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />

      <div 
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-md bg-app-bg shadow-2xl transition-transform duration-500 ease-out border-l border-app-border ${variantId ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-app-border bg-app-surface px-6 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <Package size={20} />
              </div>
              <div>
                <h2 className="text-lg font-black uppercase tracking-tight text-app-text leading-none">Confirm Item</h2>
                <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest mt-1">Review & Adjust before adding</p>
              </div>
            </div>
            <button 
              onClick={onClose}
              className="rounded-full p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-colors"
            >
              <X size={24} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar pb-32">
            {loading ? (
              <div className="flex h-full items-center justify-center space-y-4 flex-col">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
                <p className="text-xs font-black uppercase tracking-[0.2em] text-app-text-muted">Analyzing Stock Levels...</p>
              </div>
            ) : error ? (
              <div className="p-8 text-center">
                <AlertCircle size={48} className="mx-auto mb-4 text-app-danger" />
                <p className="text-lg font-bold text-app-text">{error}</p>
              </div>
            ) : data ? (
              <div className="space-y-6 p-6">
                {/* 1. Identity & Selection (TOP) */}
                <div className="relative overflow-hidden rounded-3xl bg-app-surface-2 border border-app-border p-6 shadow-xl">
                   <div className="absolute -right-4 -top-4 opacity-10 text-app-text">
                      <Package size={120} strokeWidth={1} />
                   </div>
                   <div className="relative z-10 space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-full bg-app-surface-3 px-3 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted ring-1 ring-app-border">
                          SKU: {data.sku}
                        </span>
                        {data.variation_label && (
                          <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20">
                            {data.variation_label}
                          </span>
                        )}
                      </div>
                      <h3 className="text-2xl font-black leading-tight tracking-tight uppercase italic text-app-text">{data.name}</h3>
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                   <div className="rounded-2xl border border-emerald-100 bg-emerald-50 content-center p-4">
                      <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-1">Stock On-Hand</p>
                      <p className="text-3xl font-black text-emerald-700 tabular-nums leading-none">{data.stock_on_hand}</p>
                   </div>
                   <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                      <p className="text-[10px] font-black uppercase tracking-widest mb-1 text-app-text-muted">Retail Price</p>
                      <p className="text-3xl font-black text-app-text tabular-nums leading-none">
                        {formatUsdFromCents(parseMoneyToCents(data.retail_price))}
                      </p>
                   </div>
                </div>

                {/* 2. Advanced Price Adjustment Numpad */}
                <div className="space-y-4 rounded-3xl border-2 border-app-accent/20 bg-app-surface p-5 shadow-sm">
                   <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-app-accent">
                         <CircleDollarSign size={18} />
                         <span className="text-xs font-black uppercase tracking-widest">Adjust Item Price</span>
                      </div>
                      {priceOverride && (
                         <button onClick={() => setPriceOverride("")} className="text-[10px] font-black text-red-500 hover:underline uppercase tracking-tighter">Clear Override</button>
                      )}
                   </div>
                   
                   <div className="flex h-16 items-center justify-center rounded-2xl bg-app-surface-2 px-6 ring-2 ring-app-border">
                      <span className={`text-4xl font-black tabular-nums ${priceOverride ? "text-app-accent" : "text-app-text-muted"}`}>
                        $
                        {priceOverride ||
                          centsToFixed2(parseMoneyToCents(data.retail_price))}
                      </span>
                   </div>

                   <div className="grid grid-cols-4 gap-2">
                      <div className="grid grid-cols-3 gap-2 col-span-3">
                         {["1","2","3","4","5","6","7","8","9",".","0","CLR"].map(k => (
                           <button 
                             key={k} 
                             onClick={() => handleNumpadKey(k)}
                             className={`flex h-12 items-center justify-center rounded-xl text-lg font-black transition-all active:scale-95 ${k === "CLR" ? "bg-app-surface-2 text-app-text-muted" : "bg-app-surface text-app-text shadow-sm ring-1 ring-app-border"}`}
                           >
                             {k}
                           </button>
                         ))}
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                         <button 
                           onClick={() => handleNumpadKey("%")}
                           className="flex flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md active:scale-95"
                         >
                           <span className="text-xs font-black">%</span>
                           <span className="text-[9px] font-bold uppercase opacity-80">Disc</span>
                         </button>
                         <button 
                           onClick={() => handleNumpadKey("$")}
                           className="flex flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md active:scale-95"
                         >
                           <span className="text-xs font-black">$</span>
                           <span className="text-[9px] font-bold uppercase opacity-80">Price</span>
                         </button>
                      </div>
                   </div>
                </div>

                {/* Economics (Admin Only) */}
                {data.unit_cost && (
                   <div className="rounded-3xl bg-app-accent/10 p-5 ring-1 ring-app-accent/30 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                         <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent/25 text-app-accent">
                            <Gem size={20} />
                         </div>
                         <div>
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-accent/70">Unit Cost</p>
                            <p className="text-lg font-black text-app-text">
                              {formatUsdFromCents(
                                parseMoneyToCents(data.unit_cost),
                              )}
                            </p>
                         </div>
                      </div>
                      <div className="text-right">
                         <p className="text-[10px] font-black uppercase tracking-widest text-app-accent/70">GPM</p>
                         <p className="text-lg font-black text-emerald-600">
                           {(() => {
                             const unitC = parseMoneyToCents(data.unit_cost);
                             const retailC = parseMoneyToCents(
                               priceOverride || data.retail_price,
                             );
                             if (retailC <= 0) return "—";
                             const tenths = Math.round(
                               ((retailC - unitC) * 1000) / retailC,
                             );
                             return `${(tenths / 10).toFixed(1)}%`;
                           })()}
                         </p>
                      </div>
                   </div>
                )}
              </div>
            ) : null}
          </div>

          {data && (
            <div className="absolute bottom-0 left-0 right-0 border-t border-app-border bg-app-surface/80 p-6 backdrop-blur-md">
              <button 
                type="button"
                onClick={() => {
                  void (async () => {
                    try {
                      await Promise.resolve(
                        onAddToSale?.(data.sku, priceOverride || undefined),
                      );
                    } finally {
                      setPriceOverride("");
                      onClose();
                    }
                  })();
                }}
                className="group relative flex w-full items-center justify-center overflow-hidden rounded-3xl bg-emerald-600 py-6 text-2xl font-black uppercase tracking-[0.2em] text-white shadow-2xl shadow-emerald-500/40 transition-all hover:bg-emerald-500 active:scale-[0.98]"
              >
                <div className="flex items-center gap-4 transition-transform group-hover:scale-110">
                   <ShoppingCart size={32} />
                   <span>Add to Cart</span>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
