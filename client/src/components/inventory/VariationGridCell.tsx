import React, { useState } from "react";
import { Globe, AlertTriangle } from "lucide-react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import type { HubVariant } from "./VariationsWorkspace";

export interface VariationCellProps {
  variant: HubVariant;
  isLowStock: boolean;
  isOutOfStock: boolean;
  hasPriceOverride: boolean;
  onUpdateStock: (delta: number) => Promise<void>;
  onUpdatePrice: (cents: number | null) => Promise<void>;
  onUpdateTrackLow: (next: boolean) => Promise<void>;
  onUpdateWeb: (next: boolean) => Promise<void>;
  onShowMaintenance: (type: "damaged" | "return_to_vendor") => void;
}

export const VariationGridCell: React.FC<VariationCellProps> = ({
  variant,
  isLowStock,
  isOutOfStock,
  hasPriceOverride,
  onUpdateStock,
  onUpdatePrice,
  onUpdateTrackLow,
  onUpdateWeb,
  onShowMaintenance,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [stockDraft, setStockDraft] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const [editingPrice, setEditingPrice] = useState(false);
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
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Price Section */}
      <div className="flex items-center justify-between">
        {editingPrice ? (
          <div className="flex items-center gap-1">
            <input
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              placeholder={centsToFixed2(parseMoneyToCents(variant.effective_retail))}
              className="h-7 w-20 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-black"
            />
            <button
              type="button"
              className="rounded-md bg-app-accent px-2 py-1 text-[9px] font-black uppercase text-white"
              onClick={() => {
                const trimmed = priceDraft.trim();
                if (!trimmed) {
                  void onUpdatePrice(null);
                } else {
                  const cents = parseMoneyToCents(trimmed);
                  if (!Number.isNaN(cents)) void onUpdatePrice(cents);
                }
                setEditingPrice(false);
                setPriceDraft("");
              }}
            >
              Save
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setPriceDraft(centsToFixed2(parseMoneyToCents(variant.effective_retail)));
              setEditingPrice(true);
            }}
            className={`text-[11px] font-black tracking-tight tabular-nums transition-colors hover:opacity-80 ${
              hasPriceOverride ? "text-app-accent" : "text-app-text-muted"
            }`}
          >
            ${centsToFixed2(parseMoneyToCents(variant.effective_retail))}
          </button>
        )}
        {variant.web_published && (
          <Globe size={10} className="text-app-success" />
        )}
      </div>

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
      <div
        className={`mt-1 flex flex-col gap-2 overflow-hidden transition-all duration-300 ${isHovered || isUpdating ? "max-h-32 opacity-100" : "max-h-0 opacity-0"}`}
      >
        <div className="relative">
          <input
            type="text"
            inputMode="numeric"
            placeholder="+/- qty"
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
              Track
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
