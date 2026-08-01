import { useEffect, useState, useMemo } from "react";
import {
  ArrowLeft,
  Package,
  CircleDollarSign,
  ShoppingCart,
  RefreshCw,
  Plus
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { centsToFixed2, parseMoney, parseMoneyToCents } from "../../lib/money";
import {
  buildVariantSelectionModel,
  initialVariantSelectionPath,
  variantSelectionChoiceLabel,
} from "./variantSelectionLogic";

export interface VariantOption {
  variant_id: string;
  sku: string;
  variation_label: string;
  stock_on_hand: number;
  retail_price: string;
}

export interface ProductWithVariants {
  product_id: string;
  name: string;
  image_url?: string;
  variants: VariantOption[];
}

export interface VariantSelectionModalProps {
  product: ProductWithVariants | null;
  onClose: () => void;
  onSelect: (variant: VariantOption, priceOverride?: string) => void;
  actionLabel?: string;
  allowPriceOverride?: boolean;
  initialVariantId?: string;
  preservedUnitPrice?: string;
  layerClassName?: string;
}

// --- Logical Size Sorting Utility ---
const SIZE_ORDER: Record<string, number> = {
  "OS": 0, "ONESIZE": 0, "ONE SIZE": 0,
  "XXS": 5, "XS": 10, "S": 20, "SMALL": 20, "M": 30, "MEDIUM": 30, "L": 40, "LARGE": 40,
  "XL": 50, "XXL": 60, "2XL": 60, "3XL": 70, "4XL": 80, "5XL": 90
};

function getSortScore(val: string): number {
  const upper = val.toUpperCase().trim();
  if (SIZE_ORDER[upper] !== undefined) return SIZE_ORDER[upper];

  // Try to parse numeric size (e.g. "34", "36R", "10.5")
  const numericMatch = val.match(/^(\d+(\.\d+)?)/);
  if (numericMatch) return 1000 + parseFloat(numericMatch[1]);

  return 5000; // Fallback for colors/other attributes
}

export default function VariantSelectionModal({
  product,
  onClose,
  onSelect,
  actionLabel = "Add to Sale",
  allowPriceOverride = true,
  initialVariantId,
  preservedUnitPrice,
  layerClassName,
}: VariantSelectionModalProps) {
  const [selections, setSelections] = useState<string[]>([]);
  const [priceOverride, setPriceOverride] = useState("");

  const selectionModel = useMemo(
    () => buildVariantSelectionModel(product?.variants ?? []),
    [product],
  );

  const initialVariant = useMemo(
    () => product?.variants.find((variant) => variant.variant_id === initialVariantId) ?? null,
    [initialVariantId, product],
  );
  const initialSelections = useMemo(() => {
    if (!product || !initialVariant) return [];
    return initialVariantSelectionPath(
      selectionModel.entries,
      initialVariant.variant_id,
    );
  }, [initialVariant, product, selectionModel]);

  useEffect(() => {
    if (!product?.product_id) return;
    setSelections(initialSelections);
    setPriceOverride("");
  }, [initialSelections, product?.product_id]);

  const attributeSteps = useMemo(() => {
    return product ? selectionModel.steps : [];
  }, [product, selectionModel.steps]);

  const matchingEntries = useMemo(() => {
    if (!product) return [];
    return selectionModel.entries.filter((entry) =>
      selections.every((selection, index) => entry.path[index] === selection),
    );
  }, [product, selectionModel.entries, selections]);

  const currentStepIndex = selections.length;
  const isSelectionComplete = currentStepIndex === attributeSteps.length;

  const choices = useMemo(() => {
    if (!product || isSelectionComplete) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    matchingEntries.forEach((entry) => {
      const val = entry.path[currentStepIndex];
      if (val && !seen.has(val)) {
        seen.add(val);
        result.push(val);
      }
    });

    // Proper Size Ordering
    return result.sort((a, b) => {
       const scoreA = getSortScore(a);
       const scoreB = getSortScore(b);
       if (scoreA !== scoreB) return scoreA - scoreB;
       return a.localeCompare(b);
    });
  }, [product, matchingEntries, currentStepIndex, isSelectionComplete]);

  const finalVariant =
    isSelectionComplete && matchingEntries.length === 1
      ? matchingEntries[0].variant
      : null;
  const isCurrentVariant = Boolean(initialVariantId && finalVariant?.variant_id === initialVariantId);
  const canSubmit = Boolean(isSelectionComplete && finalVariant && !isCurrentVariant);
  const currentVariantAttributes = useMemo(
    () => selectionModel.entries.find(
      (entry) => entry.variant.variant_id === initialVariant?.variant_id,
    )?.path ?? [],
    [initialVariant?.variant_id, selectionModel.entries],
  );

  const handleNumpadKey = (key: string) => {
    if (key === "CLR") {
      setPriceOverride("");
      return;
    }

    if (key === "%" || key === "$") {
      if (!priceOverride || !finalVariant) return;
      if (key === "%") {
        const discountPercent = parseMoney(priceOverride);
        const baseCents = parseMoneyToCents(finalVariant.retail_price);
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

  if (!product) return null;

  return (
    <DetailDrawer
      isOpen={!!product}
      onClose={onClose}
      layerClassName={layerClassName}
      title={product.name}
      subtitle={isSelectionComplete ? <span className="text-app-text font-black uppercase tracking-widest text-[10px]">Confirm Selection</span> : `Step ${currentStepIndex + 1}: ${attributeSteps[currentStepIndex]}`}
      titleClassName="text-app-text font-black tracking-tighter italic uppercase truncate pr-8"
      noPadding
      panelMaxClassName="max-w-xl"
      footer={
        <div className="flex gap-2">
          {selections.length > 0 && (
            <button
              onClick={() => {
                 if (isSelectionComplete) {
                   setPriceOverride("");
                   setSelections(prev => prev.slice(0, -1));
                 } else {
                   setSelections(prev => prev.slice(0, -1));
                 }
              }}
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface text-app-text-muted transition-all hover:border-app-input-border hover:text-app-text active:scale-95"
            >
              <ArrowLeft size={24} />
            </button>
          )}

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => finalVariant && onSelect(finalVariant, priceOverride || undefined)}
            className={`group relative flex h-16 flex-1 items-center justify-center overflow-hidden rounded-xl border transition-all active:scale-[0.98] ${
              canSubmit
               ? "border-emerald-600 bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-500"
               : "cursor-not-allowed border-app-border bg-app-surface-2 text-app-text-muted opacity-50"
            }`}
          >
             <div className="flex items-center gap-3">
                {initialVariantId ? <RefreshCw size={24} /> : <ShoppingCart size={24} />}
                <span className="text-xl font-black uppercase italic tracking-widest">
                  {isCurrentVariant ? "Current Item Selected" : actionLabel}
                </span>
             </div>
          </button>
        </div>
      }
    >
      <div className="flex h-full flex-col bg-app-surface px-5 py-4">
        {initialVariant ? (
          <div className="mb-4 rounded-2xl border border-app-accent/25 bg-app-accent/5 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-accent">
              Current order selection
            </p>
            <p className="mt-1 font-black text-app-text">{initialVariant.variation_label}</p>
            <p className="mt-1 text-xs font-semibold text-app-text-muted">
              SKU {initialVariant.sku}
              {preservedUnitPrice ? ` · Customer price stays ${preservedUnitPrice}` : ""}
            </p>
          </div>
        ) : null}
        {/* Identity & Progress Header */}
        <div className="mb-3 flex min-h-7 flex-col justify-center gap-2">
           {selections.length > 0 && (
             <div className="flex flex-wrap gap-2">
               {selections.map((sel, i) => (
                 <div key={i} className="flex items-center gap-1.5 rounded-full border border-app-input-border bg-app-surface-2 px-3 py-1.5">
                   <span className="text-xs font-black uppercase tracking-wide text-app-text">{variantSelectionChoiceLabel(sel)}</span>
                 </div>
               ))}
               {selections.length < attributeSteps.length && (
                 <div className="flex h-6 w-12 items-center justify-center rounded-full bg-app-surface-2 animate-pulse">
                    <div className="h-1 w-1 rounded-full bg-app-border mx-0.5" />
                    <div className="h-1 w-1 rounded-full bg-app-border mx-0.5" />
                 </div>
               )}
             </div>
           )}
        </div>

        {/* Step Content */}
        <div className="flex-1 overflow-y-auto no-scrollbar">
          {!isSelectionComplete ? (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="grid grid-cols-2 gap-2 rounded-2xl border border-app-border bg-app-surface-2 p-3">
                {choices.map(choice => (
                  <button
                    key={choice}
                    onClick={() => setSelections(prev => [...prev, choice])}
                    className="group relative flex h-24 flex-col items-center justify-center overflow-hidden rounded-xl border border-app-border bg-app-surface px-3 transition-all hover:border-app-accent hover:bg-app-accent/5 active:scale-[0.98]"
                  >
                    <span className="text-lg font-black uppercase leading-tight tracking-tight text-app-text sm:text-xl">
                      {variantSelectionChoiceLabel(choice)}
                    </span>
                    {initialVariant && currentVariantAttributes[currentStepIndex] === choice ? (
                      <span className="mt-1 text-[9px] font-black uppercase tracking-widest text-app-accent">
                        Current
                      </span>
                    ) : null}
                    <div className="absolute bottom-2 right-2 text-app-text-muted opacity-45 transition-opacity group-hover:text-app-accent group-hover:opacity-100">
                       <Plus size={16} />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="animate-in zoom-in-95 duration-500 space-y-4 pb-4">
              {/* Product Confirmation Identity (Ultra-Condensed) */}
               <div className="relative overflow-hidden rounded-2xl border border-app-border bg-app-surface-2 p-3">
                 <div className="absolute -right-1 -top-1 opacity-5 text-app-text">
                    <Package size={60} strokeWidth={1} />
                 </div>
                 <div className="relative z-10 flex items-center justify-between">
                    <div>
                       <span className="inline-block rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20 mb-0.5 whitespace-nowrap">
                          {finalVariant?.sku}
                       </span>
                       <h3 className="text-base font-black leading-none tracking-tight uppercase italic text-app-text">{product.name}</h3>
                    </div>
                    <div className="text-right flex-shrink-0">
                       <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">{finalVariant?.variation_label}</p>
                    </div>
                 </div>
              </div>

              {/* Price Intelligence Numpad (Integrated into Modal) */}
              {allowPriceOverride ? <div className="space-y-4 rounded-2xl border border-app-border bg-app-surface-2 p-5">
                 <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-app-text">
                       <CircleDollarSign size={14} />
                       <span className="text-[10px] font-black uppercase tracking-widest text-app-text">Adjust Price</span>
                    </div>
                    {priceOverride && (
                       <button onClick={() => setPriceOverride("")} className="text-[9px] font-black text-red-500 hover:underline uppercase tracking-tighter">Reset</button>
                    )}
                 </div>

                 <div className="flex h-12 items-center justify-center rounded-2xl bg-app-surface-2 px-6 ring-2 ring-app-border transition-all shadow-inner overflow-hidden">
                    <span className={`text-2xl font-black tabular-nums transition-colors ${priceOverride ? "text-app-text" : "text-app-text-muted opacity-50"}`}>
                      $
                      {priceOverride ||
                        centsToFixed2(
                          parseMoneyToCents(finalVariant?.retail_price || "0"),
                        )}
                    </span>
                 </div>

                 <div className="grid grid-cols-4 gap-2">
                    <div className="grid grid-cols-3 gap-2 col-span-3">
                       {["1","2","3","4","5","6","7","8","9",".","0","CLR"].map(k => (
                         <button
                           key={k}
                           onClick={() => handleNumpadKey(k)}
                           className={`flex h-16 items-center justify-center rounded-xl text-xl font-black transition-all active:scale-90 ${k === 'CLR' ? 'bg-app-surface-2 text-app-text-muted' : 'bg-app-surface shadow-sm ring-1 ring-app-border text-app-text hover:ring-app-text'}`}
                         >
                           {k}
                         </button>
                       ))}
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                       <button
                         onClick={() => handleNumpadKey("%")}
                         className="flex h-16 flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xl active:scale-90 hover:bg-indigo-500 transition-all"
                       >
                         <span className="text-sm font-black">%</span>
                         <span className="text-[9px] font-bold uppercase opacity-80">Disc</span>
                       </button>
                       <button
                         onClick={() => handleNumpadKey("$")}
                         className="flex h-16 flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xl active:scale-90 hover:bg-indigo-500 transition-all"
                       >
                         <span className="text-sm font-black">$</span>
                         <span className="text-[9px] font-bold uppercase opacity-80">Price</span>
                       </button>
                    </div>
                 </div>
              </div> : null}
            </div>
          )}
        </div>

      </div>
    </DetailDrawer>
  );
}
