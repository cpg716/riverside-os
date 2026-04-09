import { useEffect, useState, useMemo } from "react";
import { 
  ArrowLeft, 
  Package, 
  CircleDollarSign, 
  ShoppingCart,
  Plus
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { centsToFixed2, parseMoney, parseMoneyToCents } from "../../lib/money";

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
}

function parseAttributes(label: string): string[] {
  return label.split(/[ \t]*[/|,][ \t]*/).map(s => s.trim()).filter(Boolean);
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
}: VariantSelectionModalProps) {
  const [selections, setSelections] = useState<string[]>([]);
  const [priceOverride, setPriceOverride] = useState("");

  useEffect(() => {
    if (!product?.product_id) return;
    setSelections([]);
    setPriceOverride("");
  }, [product?.product_id]);

  const attributeSteps = useMemo(() => {
    if (!product) return [];
    const maxDepth = Math.max(...product.variants.map(v => parseAttributes(v.variation_label).length));
    return Array.from({ length: maxDepth }, (_, i) => `Option ${i + 1}`);
  }, [product]);

  const matchingVariants = useMemo(() => {
    if (!product) return [];
    return product.variants.filter(v => {
      const attrs = parseAttributes(v.variation_label);
      return selections.every((sel, i) => attrs[i] === sel);
    });
  }, [product, selections]);

  const currentStepIndex = selections.length;
  const isSelectionComplete = currentStepIndex === attributeSteps.length;

  const choices = useMemo(() => {
    if (!product || isSelectionComplete) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    matchingVariants.forEach(v => {
      const attrs = parseAttributes(v.variation_label);
      const val = attrs[currentStepIndex];
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
  }, [product, matchingVariants, currentStepIndex, isSelectionComplete]);

  const finalVariant = isSelectionComplete && matchingVariants.length === 1 ? matchingVariants[0] : null;

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
      title={product.name}
      subtitle={isSelectionComplete ? "Finalize Pricing" : `Step ${currentStepIndex + 1}: ${attributeSteps[currentStepIndex]}`}
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
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border-2 border-app-border text-app-text-muted hover:border-app-text hover:text-app-text transition-all active:scale-90 bg-app-surface"
            >
              <ArrowLeft size={24} />
            </button>
          )}
          
          <button
            type="button"
            disabled={!isSelectionComplete || !finalVariant}
            onClick={() => finalVariant && onSelect(finalVariant, priceOverride || undefined)}
            className={`group relative flex h-16 flex-1 items-center justify-center overflow-hidden rounded-2xl border-b-4 transition-all active:scale-[0.98] active:translate-y-1 ${
              isSelectionComplete && finalVariant
               ? "bg-emerald-600 border-emerald-800 text-white shadow-xl shadow-emerald-500/40 hover:bg-emerald-500" 
               : "bg-app-surface-2 border-app-input-border text-app-text-muted cursor-not-allowed opacity-50"
            }`}
          >
             <div className="flex items-center gap-3">
                <ShoppingCart size={24} />
                <span className="text-xl font-black uppercase italic tracking-widest">Add to Sale</span>
             </div>
          </button>
        </div>
      }
    >
      <div className="flex flex-col bg-app-bg px-6 pt-2">
        {/* Identity & Progress Header */}
        <div className="mb-6 flex flex-col gap-3 pt-2">
           {selections.length > 0 && (
             <div className="flex flex-wrap gap-2">
               {selections.map((sel, i) => (
                 <div key={i} className="flex items-center gap-1.5 rounded-full border border-white/20 bg-app-text px-3 py-1 shadow-sm">
                   <span className="text-[9px] font-black uppercase tracking-widest text-white/80">{sel}</span>
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
              <div className="grid grid-cols-2 gap-3">
                {choices.map(choice => (
                  <button
                    key={choice}
                    onClick={() => setSelections(prev => [...prev, choice])}
                    className="group relative flex h-20 flex-col items-center justify-center overflow-hidden rounded-3xl border-2 border-app-border bg-app-surface transition-all hover:border-app-text hover:bg-app-surface-2 active:scale-95 shadow-sm hover:shadow-xl translate-y-0 hover:-translate-y-1"
                  >
                    <span className="text-sm font-black uppercase tracking-tighter text-app-text group-hover:scale-110 transition-transform">
                      {choice}
                    </span>
                    <div className="absolute bottom-1 right-3 opacity-10 group-hover:opacity-100 transition-opacity">
                       <Plus size={14} />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="animate-in zoom-in-95 duration-500 space-y-6 pb-20">
              {/* Product Confirmation Identity (Ultra-Condensed) */}
              <div className="relative overflow-hidden rounded-2xl bg-app-text p-3 text-white shadow-lg">
                 <div className="absolute -right-1 -top-1 opacity-5">
                    <Package size={60} strokeWidth={1} />
                 </div>
                 <div className="relative z-10 flex items-center justify-between">
                    <div>
                       <span className="inline-block rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-emerald-400 ring-1 ring-emerald-500/30 mb-0.5 whitespace-nowrap">
                          {finalVariant?.sku}
                       </span>
                       <h3 className="text-base font-black leading-none tracking-tight uppercase italic">{product.name}</h3>
                    </div>
                    <div className="text-right flex-shrink-0">
                       <p className="text-[10px] font-bold uppercase tracking-widest text-white/70">{finalVariant?.variation_label}</p>
                    </div>
                 </div>
              </div>

              {/* Price Intelligence Numpad (Integrated into Modal) */}
              <div className="rounded-3xl border-2 border-app-border bg-app-surface p-5 shadow-lg space-y-4">
                 <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-app-text">
                       <CircleDollarSign size={14} />
                       <span className="text-[9px] font-black uppercase tracking-widest">Adjust Price</span>
                    </div>
                    {priceOverride && (
                       <button onClick={() => setPriceOverride("")} className="text-[9px] font-black text-red-500 hover:underline uppercase tracking-tighter">Reset</button>
                    )}
                 </div>
                 
                 <div className="flex h-12 items-center justify-center rounded-2xl bg-app-text px-6 ring-2 ring-black/40 transition-all shadow-inner">
                    <span className={`text-2xl font-black tabular-nums transition-colors ${priceOverride ? "text-white" : "text-white/45"}`}>
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
                           className={`flex h-12 items-center justify-center rounded-xl text-lg font-black transition-all active:scale-90 ${k === 'CLR' ? 'bg-app-surface-2 text-app-text-muted' : 'bg-app-surface shadow-sm ring-1 ring-app-border text-app-text hover:ring-app-text'}`}
                         >
                           {k}
                         </button>
                       ))}
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                       <button 
                         onClick={() => handleNumpadKey("%")}
                         className="flex flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xl active:scale-90 hover:bg-indigo-500 transition-all"
                       >
                         <span className="text-xs font-black">%</span>
                         <span className="text-[9px] font-bold uppercase opacity-80">Disc</span>
                       </button>
                       <button 
                         onClick={() => handleNumpadKey("$")}
                         className="flex flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xl active:scale-90 hover:bg-indigo-500 transition-all"
                       >
                         <span className="text-xs font-black">$</span>
                         <span className="text-[9px] font-bold uppercase opacity-80">Price</span>
                       </button>
                    </div>
                 </div>
              </div>
            </div>
          )}
        </div>

      </div>
    </DetailDrawer>
  );
}
