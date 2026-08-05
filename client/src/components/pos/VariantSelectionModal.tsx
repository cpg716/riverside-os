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
  const [discountPercentInput, setDiscountPercentInput] = useState("");

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
    setDiscountPercentInput("");
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
  const hasPriceChange = Boolean(
    priceOverride &&
    finalVariant &&
    parseMoneyToCents(priceOverride) !==
      parseMoneyToCents(preservedUnitPrice ?? finalVariant.retail_price),
  );
  const canSubmit = Boolean(
    isSelectionComplete && finalVariant && (!isCurrentVariant || hasPriceChange),
  );
  const currentVariantAttributes = useMemo(
    () => selectionModel.entries.find(
        (entry) => entry.variant.variant_id === initialVariant?.variant_id,
      )?.path ?? [],
    [initialVariant?.variant_id, selectionModel.entries],
  );

  const goBack = () => {
    setPriceOverride("");
    setDiscountPercentInput("");
    if (selections.length === 0) {
      onClose();
      return;
    }
    setSelections((previous) => previous.slice(0, -1));
  };

  const editSelection = (selectionIndex: number) => {
    setPriceOverride("");
    setDiscountPercentInput("");
    setSelections((previous) => previous.slice(0, selectionIndex));
  };

  const resetPriceAdjustment = () => {
    setPriceOverride("");
    setDiscountPercentInput("");
  };

  const applyDiscountPercent = (rawValue: string) => {
    const cleaned = rawValue.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 6);
    if (!cleaned || !finalVariant) {
      setDiscountPercentInput(cleaned);
      setPriceOverride("");
      return;
    }
    const parsedPercent = parseMoney(cleaned);
    if (!Number.isFinite(parsedPercent)) return;
    const discountPercent = Math.min(100, Math.max(0, parsedPercent));
    setDiscountPercentInput(
      discountPercent === parsedPercent ? cleaned : String(discountPercent),
    );
    const baseCents = parseMoneyToCents(finalVariant.retail_price);
    const newCents = Math.round((baseCents * (100 - discountPercent)) / 100);
    setPriceOverride(newCents === baseCents ? "" : centsToFixed2(newCents));
  };

  const handleNumpadKey = (key: string) => {
    if (key === "CLR") {
      resetPriceAdjustment();
      return;
    }

    if (key === "%" || key === "$") {
      if (!priceOverride || !finalVariant) return;
      if (key === "%") {
        applyDiscountPercent(priceOverride);
      } else {
        const normalizedPrice = centsToFixed2(parseMoneyToCents(priceOverride));
        setPriceOverride(normalizedPrice);
        const baseCents = parseMoneyToCents(finalVariant.retail_price);
        const normalizedCents = parseMoneyToCents(normalizedPrice);
        setDiscountPercentInput(
          normalizedCents < baseCents && baseCents > 0
            ? ((1 - normalizedCents / baseCents) * 100)
                .toFixed(2)
                .replace(/\.00$/, "")
                .replace(/(\.\d)0$/, "$1")
            : "",
        );
      }
      return;
    }

    setDiscountPercentInput("");
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
      contentContained
      panelMaxClassName="max-w-xl"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={goBack}
            data-testid="variant-selection-back"
            className="flex h-16 min-w-28 shrink-0 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 text-app-text transition-all hover:border-app-input-border hover:bg-app-surface-2 active:scale-95"
          >
            <ArrowLeft size={22} aria-hidden />
            <span className="text-xs font-black uppercase tracking-widest">
              Back
            </span>
          </button>

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
                  {isCurrentVariant && !hasPriceChange ? "Current Item Selected" : actionLabel}
                </span>
             </div>
          </button>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col bg-app-surface px-5 py-4">
        <div
          data-testid="variant-selection-scroll-region"
          className={`flex min-h-0 flex-1 flex-col no-scrollbar ${
            isSelectionComplete ? "overflow-hidden" : "overflow-y-auto"
          }`}
        >
          <section
            data-testid="variant-item-to-build"
            className={`shrink-0 rounded-2xl border-2 border-app-accent/30 bg-app-accent/5 shadow-sm ${
              isSelectionComplete ? "mb-3 p-4" : "mb-4 p-4"
            }`}
          >
            {!isSelectionComplete ? (
              <div className="flex items-start gap-3">
                {product.image_url ? (
                  <img
                    src={product.image_url}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded-xl border border-app-border bg-white object-contain"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface text-app-accent">
                    <Package size={26} aria-hidden />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-app-accent">
                    Item to Build
                  </p>
                  <h3 className="mt-1 text-lg font-black uppercase leading-tight tracking-tight text-app-text">
                    {product.name}
                  </h3>
                </div>
              </div>
            ) : (
              <p className="text-[11px] font-black uppercase tracking-[0.24em] text-app-accent">
                Selected options
              </p>
            )}

            <div
              className={`grid gap-2 ${
                isSelectionComplete ? "mt-2 grid-cols-3" : "mt-4 sm:grid-cols-2"
              }`}
            >
              {attributeSteps.map((step, index) => {
                const selection = selections[index];
                const isCurrentStep = index === currentStepIndex;
                return (
                  <button
                    key={`${step}-${index}`}
                    type="button"
                    disabled={!selection}
                    onClick={() => editSelection(index)}
                    className={`rounded-xl border text-left transition-colors ${
                      isSelectionComplete ? "min-h-24 px-4 py-3" : "px-3 py-2"
                    } ${
                      selection
                        ? "border-app-accent/30 bg-app-surface hover:border-app-accent"
                        : isCurrentStep
                          ? "border-app-accent bg-app-accent/10"
                          : "cursor-default border-app-border bg-app-surface-2 opacity-65"
                    }`}
                    aria-label={
                      selection
                        ? `Edit ${step}: ${variantSelectionChoiceLabel(selection)}`
                        : undefined
                    }
                  >
                    <span
                      className={`block font-black uppercase tracking-widest text-app-text-muted ${
                        isSelectionComplete ? "text-[10px]" : "text-[9px]"
                      }`}
                    >
                      {step}
                    </span>
                    <span
                      className={`mt-1 flex items-center justify-between gap-2 font-black uppercase tracking-wide text-app-text ${
                        isSelectionComplete ? "text-sm" : "text-xs"
                      }`}
                    >
                      <span>
                        {selection
                          ? variantSelectionChoiceLabel(selection)
                          : isCurrentStep
                            ? "Choose now"
                            : "Pending"}
                      </span>
                      {selection ? (
                        <span className="text-[9px] tracking-widest text-app-accent">
                          Edit
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {initialVariant ? (
            <div className="mb-4 rounded-2xl border border-app-accent/25 bg-app-accent/5 p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-accent">
                Current order selection
              </p>
              <p className="mt-1 font-black text-app-text">
                {initialVariant.variation_label}
              </p>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                SKU {initialVariant.sku}
                {preservedUnitPrice
                  ? ` · Customer price stays ${preservedUnitPrice}`
                  : ""}
              </p>
            </div>
          ) : null}
          {/* Step Content */}
          {!isSelectionComplete ? (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="grid grid-cols-2 gap-2 rounded-2xl border border-app-border bg-app-surface-2 p-3">
                {choices.map((choice) => (
                  <button
                    key={choice}
                    onClick={() => setSelections((prev) => [...prev, choice])}
                    className="group relative flex h-24 flex-col items-center justify-center overflow-hidden rounded-xl border border-app-border bg-app-surface px-3 transition-all hover:border-app-accent hover:bg-app-accent/5 active:scale-[0.98]"
                  >
                    <span className="text-lg font-black uppercase leading-tight tracking-tight text-app-text sm:text-xl">
                      {variantSelectionChoiceLabel(choice)}
                    </span>
                    {initialVariant &&
                    currentVariantAttributes[currentStepIndex] === choice ? (
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
            <div className="mt-auto shrink-0 animate-in zoom-in-95 duration-500">
              {allowPriceOverride ? (
                <div className="space-y-2 rounded-t-2xl border border-b-0 border-app-border bg-app-surface-2 p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-app-text">
                      <CircleDollarSign size={14} />
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
                        Line Pricing
                      </span>
                    </div>
                    {priceOverride && (
                      <button
                        type="button"
                        onClick={resetPriceAdjustment}
                        className="text-[9px] font-black text-red-500 hover:underline uppercase tracking-tighter"
                      >
                        Reset
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {priceOverride ? (
                      <div className="rounded-xl border border-app-border bg-app-surface p-3">
                        <span className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Regular unit price
                        </span>
                        <span className="mt-1 block text-lg font-black tabular-nums text-app-text">
                          $
                          {centsToFixed2(
                            parseMoneyToCents(
                              finalVariant?.retail_price || "0",
                            ),
                          )}
                        </span>
                      </div>
                    ) : null}
                    <label
                      className={`rounded-xl border border-app-border bg-app-surface p-3 ${
                        priceOverride ? "" : "col-span-2"
                      }`}
                    >
                      <span className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Line discount %
                      </span>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          data-testid="variant-line-discount-percent"
                          value={discountPercentInput}
                          onChange={(event) =>
                            applyDiscountPercent(event.target.value)
                          }
                          inputMode="decimal"
                          placeholder="0"
                          aria-label="Line discount percent"
                          className="min-w-0 flex-1 bg-transparent text-lg font-black tabular-nums text-app-text outline-none"
                        />
                        <span className="text-sm font-black text-app-text-muted">
                          %
                        </span>
                      </div>
                      <span className="mt-1 block text-[9px] font-bold text-app-text-muted">
                        Manager Access above your limit.
                      </span>
                    </label>
                    <div className="rounded-xl border border-app-border bg-app-surface p-3 text-center">
                      <span className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {priceOverride ? "Final unit price" : "Unit price"}
                      </span>
                      <span
                        data-testid="variant-final-unit-price"
                        className={`block text-2xl font-black tabular-nums transition-colors ${priceOverride ? "text-emerald-600 dark:text-emerald-400" : "text-app-text"}`}
                      >
                        $
                        {priceOverride ||
                          centsToFixed2(
                            parseMoneyToCents(
                              finalVariant?.retail_price || "0",
                            ),
                          )}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {isSelectionComplete && allowPriceOverride ? (
          <div
            data-testid="variant-pricing-pinpad"
            className="shrink-0 rounded-b-2xl border border-app-border bg-app-surface p-3"
          >
            <div className="grid grid-cols-4 gap-2">
              <div className="col-span-3 grid grid-cols-3 gap-2">
                {[
                  "1",
                  "2",
                  "3",
                  "4",
                  "5",
                  "6",
                  "7",
                  "8",
                  "9",
                  ".",
                  "0",
                  "CLR",
                ].map((k) => (
                  <button
                    type="button"
                    key={k}
                    onClick={() => handleNumpadKey(k)}
                    className={`flex h-16 items-center justify-center rounded-xl text-xl font-black transition-all active:scale-90 ${k === "CLR" ? "bg-app-surface-2 text-app-text-muted" : "bg-app-surface text-app-text shadow-sm ring-1 ring-app-border hover:ring-app-text"}`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => handleNumpadKey("%")}
                  className="flex h-16 flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xl transition-all hover:bg-indigo-500 active:scale-90"
                >
                  <span className="text-sm font-black">%</span>
                  <span className="text-[9px] font-bold uppercase opacity-80">
                    Disc
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleNumpadKey("$")}
                  className="flex h-16 flex-col items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xl transition-all hover:bg-indigo-500 active:scale-90"
                >
                  <span className="text-sm font-black">$</span>
                  <span className="text-[9px] font-bold uppercase opacity-80">
                    Price
                  </span>
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </DetailDrawer>
  );
}
