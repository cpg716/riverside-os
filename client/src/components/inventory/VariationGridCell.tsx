import React, { useEffect, useState } from "react";
import { Globe, AlertTriangle } from "lucide-react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import type { HubVariant } from "./VariationsWorkspace";

export interface VariationCellProps {
  variant: HubVariant;
  isLowStock: boolean;
  isOutOfStock: boolean;
  hasPriceOverride: boolean;
  hasSaleOverride: boolean;
  onUpdateStock: (delta: number) => Promise<unknown>;
  onUpdatePrice: (cents: number | null) => Promise<unknown>;
  onUpdateSale: (cents: number | null) => Promise<unknown>;
  onUpdateTrackLow: (next: boolean) => Promise<unknown>;
  onUpdateWeb: (next: boolean) => Promise<unknown>;
  onShowMaintenance: (type: "damaged" | "return_to_vendor") => void;
}

export const VariationGridCell: React.FC<VariationCellProps> = ({
  variant,
  isLowStock,
  isOutOfStock,
  hasPriceOverride,
  hasSaleOverride,
  onUpdateStock,
  onUpdatePrice,
  onUpdateSale,
  onUpdateTrackLow,
  onUpdateWeb,
  onShowMaintenance,
}) => {
  const currentRetail = centsToFixed2(
    parseMoneyToCents(variant.effective_retail),
  );
  const currentSale = variant.effective_sale
    ? centsToFixed2(parseMoneyToCents(variant.effective_sale))
    : "";
  const [stockDraft, setStockDraft] = useState("");
  const [priceDraft, setPriceDraft] = useState(currentRetail);
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [saleDraft, setSaleDraft] = useState(currentSale);
  const [editingSale, setEditingSale] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [flash, setFlash] = useState<"success" | "error" | null>(null);

  const handleStockSubmit = async (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !stockDraft) return;
    const delta = parseInt(stockDraft, 10);
    if (isNaN(delta) || delta === 0) return;

    setIsUpdating(true);
    try {
      await onUpdateStock(delta);
      setFlash("success");
      setStockDraft("");
      setTimeout(() => setFlash(null), 1000);
    } catch {
      setFlash("error");
      setTimeout(() => setFlash(null), 1000);
    } finally {
      setIsUpdating(false);
    }
  };

  useEffect(() => {
    if (!editingPrice) setPriceDraft(currentRetail);
  }, [currentRetail, editingPrice]);

  useEffect(() => {
    if (!editingSale) setSaleDraft(currentSale);
  }, [currentSale, editingSale]);

  const handlePriceSubmit = async () => {
    const trimmed = priceDraft.trim();
    if (trimmed && !/^(?:\d+|\d*\.\d{1,2})$/.test(trimmed)) {
      setPriceError("Enter a valid price with no more than two decimals.");
      return;
    }

    setIsUpdating(true);
    setPriceError(null);
    try {
      await onUpdatePrice(trimmed ? parseMoneyToCents(trimmed) : null);
      setEditingPrice(false);
    } catch {
      setPriceError("Price could not be updated.");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSaleSubmit = async () => {
    const trimmed = saleDraft.trim();
    if (trimmed && !/^(?:\d+|\d*\.\d{1,2})$/.test(trimmed)) {
      setSaleError("Enter a valid sale price with no more than two decimals.");
      return;
    }
    const nextSaleCents = trimmed ? parseMoneyToCents(trimmed) : null;
    if (
      nextSaleCents != null &&
      nextSaleCents > parseMoneyToCents(currentRetail)
    ) {
      setSaleError("Sale price cannot exceed retail.");
      return;
    }

    setIsUpdating(true);
    setSaleError(null);
    try {
      await onUpdateSale(nextSaleCents);
      setEditingSale(false);
    } catch (error) {
      setSaleError(
        error instanceof Error ? error.message : "Sale price could not be updated.",
      );
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div
      className={`group relative flex flex-col gap-1.5 rounded-xl border p-2 transition-all duration-300 ${
        isOutOfStock
          ? "border-app-danger/30 bg-app-danger/5 shadow-[inset_0_0_12px_-4px_rgba(239,68,68,0.2)]"
          : isLowStock
            ? "border-app-warning/40 bg-app-warning/5 shadow-[inset_0_0_12px_-4px_rgba(245,158,11,0.15)]"
            : "border-app-border bg-app-surface/50 hover:bg-app-surface"
      } ${
        flash === "success"
          ? "ring-2 ring-app-success ring-offset-2 ring-offset-app-bg"
          : ""
      } ${
        flash === "error"
          ? "ring-2 ring-app-danger ring-offset-2 ring-offset-app-bg"
          : ""
      }`}
    >
      {/* Price Section */}
      <div className="flex items-center justify-between">
        {editingPrice ? (
          <div className="flex items-center gap-1">
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              autoFocus
              value={priceDraft}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setPriceDraft(event.target.value);
                setPriceError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handlePriceSubmit();
                if (event.key === "Escape") setEditingPrice(false);
              }}
              aria-label={`Retail price for ${variant.sku}`}
              disabled={isUpdating}
              className="h-7 w-20 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-black"
            />
            <button
              type="button"
              disabled={isUpdating}
              className="rounded-md bg-app-accent px-2 py-1 text-[9px] font-black uppercase text-white"
              onClick={() => void handlePriceSubmit()}
            >
              {isUpdating ? "…" : "Save"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setPriceDraft(currentRetail);
              setPriceError(null);
              setEditingPrice(true);
            }}
            className={`text-[11px] font-black tracking-tight tabular-nums transition-colors hover:opacity-80 ${
              hasPriceOverride ? "text-app-accent" : "text-app-text-muted"
            }`}
          >
            Retail ${currentRetail}
          </button>
        )}
        {variant.web_published && (
          <Globe size={10} className="text-app-success" />
        )}
      </div>
      {priceError ? (
        <p className="text-[9px] font-bold text-app-danger" role="alert">
          {priceError}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        {editingSale ? (
          <div className="flex items-center gap-1">
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              autoFocus
              value={saleDraft}
              placeholder="No sale"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setSaleDraft(event.target.value);
                setSaleError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSaleSubmit();
                if (event.key === "Escape") setEditingSale(false);
              }}
              aria-label={`Sale price for ${variant.sku}`}
              disabled={isUpdating}
              className="h-7 w-20 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-black"
            />
            <button
              type="button"
              disabled={isUpdating}
              className="rounded-md bg-app-accent px-2 py-1 text-[9px] font-black uppercase text-white"
              onClick={() => void handleSaleSubmit()}
            >
              {isUpdating ? "…" : "Save"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setSaleDraft(currentSale);
              setSaleError(null);
              setEditingSale(true);
            }}
            className={`text-[11px] font-black tracking-tight tabular-nums transition-colors hover:opacity-80 ${
              hasSaleOverride ? "text-app-accent" : "text-app-text-muted"
            }`}
          >
            Sale {currentSale ? `$${currentSale}` : "—"}
          </button>
        )}
      </div>
      {saleError ? (
        <p className="text-[9px] font-bold text-app-danger" role="alert">
          {saleError}
        </p>
      ) : null}

      {/* Stock Display */}
      <div className="flex items-center gap-2">
        <span
          className={`text-xl font-black tabular-nums tracking-tighter ${
            isOutOfStock
              ? "text-app-danger"
              : isLowStock
                ? "text-app-warning"
                : "text-app-text"
          }`}
        >
          {variant.stock_on_hand}
        </span>
        {isLowStock && (
          <AlertTriangle size={12} className="text-app-warning animate-pulse" />
        )}
      </div>

      {/* Reorder Label */}
      <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted/60">
        Reorder ≤ {variant.reorder_point}
      </span>

      {/* Progressive Disclosure: Actions & Inputs */}
      <div className="mt-2 flex flex-col gap-2">
        <div className="relative">
          <input
            type="text"
            inputMode="numeric"
            placeholder="Count correction +/-"
            value={stockDraft}
            onChange={(e) => setStockDraft(e.target.value)}
            onKeyDown={handleStockSubmit}
            disabled={isUpdating}
            className="w-full rounded-lg border border-app-border bg-app-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-app-accent focus:ring-1 focus:ring-app-accent/20"
          />
          {isUpdating && (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-app-bg/50 backdrop-blur-[1px]">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onShowMaintenance("damaged")}
            className="flex-1 rounded-md border border-app-danger/20 bg-app-danger/5 py-1 text-[9px] font-black uppercase tracking-tight text-app-danger hover:bg-app-danger hover:text-white transition-colors"
          >
            Damage
          </button>
          <button
            onClick={() => onShowMaintenance("return_to_vendor")}
            className="flex-1 rounded-md border border-app-accent/20 bg-app-accent/5 py-1 text-[9px] font-black uppercase tracking-tight text-app-accent hover:bg-app-accent hover:text-white transition-colors"
          >
            RTV
          </button>
        </div>

        <div className="flex items-center justify-between gap-1">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={variant.track_low_stock}
              onChange={(e) => onUpdateTrackLow(e.target.checked)}
              className="h-3 w-3 rounded border-app-border"
            />
            <span className="text-[9px] font-bold uppercase text-app-text-muted">
              Low stock
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={variant.web_published}
              onChange={(e) => onUpdateWeb(e.target.checked)}
              className="h-3 w-3 rounded border-app-border"
            />
            <span className="text-[9px] font-bold uppercase text-app-text-muted">
              Web
            </span>
          </label>
        </div>
      </div>
    </div>
  );
};
