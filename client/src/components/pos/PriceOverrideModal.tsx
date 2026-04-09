import React, { useRef, useState } from "react";
import { Check, Tag, X } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContext";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { parseMoneyToCents } from "../../lib/money";

interface PriceOverrideModalProps {
  currentPrice: number;
  itemName: string;
  onApply: (newPrice: number, reason: string) => void;
  onCancel: () => void;
}

export default function PriceOverrideModal({
  currentPrice,
  itemName,
  onApply,
  onCancel,
}: PriceOverrideModalProps) {
  useShellBackdropLayer(true);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const { dialogRef, titleId } = useDialogAccessibility(true, {
    onEscape: onCancel,
    initialFocusRef: priceInputRef,
  });
  const [newPrice, setNewPrice] = useState(currentPrice.toString());
  const [reason, setReason] = useState("");

  const handleApply = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPrice.trim();
    if (
      !trimmed ||
      !Number.isFinite(Number.parseFloat(trimmed)) ||
      !reason
    )
      return;
    const priceCents = parseMoneyToCents(trimmed);
    if (priceCents < 0) return;
    onApply(priceCents / 100, reason);
  };

  return (
    <div className="ui-overlay-backdrop z-[60]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal max-w-sm outline-none"
      >
        <div className="ui-modal-header flex items-center justify-between">
          <div className="flex items-center gap-2 text-[var(--app-accent)]">
            <Tag size={20} aria-hidden />
            <h3 id={titleId} className="text-sm font-black uppercase tracking-tight">
              Price Adjustment
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
            aria-label="Dismiss"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        <form onSubmit={handleApply} className="ui-modal-body space-y-4">
          <div>
            <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              {itemName}
            </p>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 font-black text-app-text-muted" aria-hidden>
                $
              </span>
              <input
                ref={priceInputRef}
                type="number"
                step="0.01"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                className="ui-input w-full py-4 pl-8 pr-4 text-2xl font-black"
                aria-label="New price"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Reason for Adjustment
            </label>
            <select
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="ui-input w-full p-3 text-sm font-medium"
            >
              <option value="">Select a reason...</option>
              <option value="manager_special">Manager Special</option>
              <option value="floor_model">Floor Model / Damaged</option>
              <option value="price_match">Price Match</option>
              <option value="bundle_discount">Bundle Discount</option>
              <option value="vip">VIP / Personal Discount</option>
            </select>
          </div>

          <button type="submit" className="ui-btn-primary flex w-full items-center justify-center gap-2 py-4 text-sm">
            <Check size={18} /> Apply New Price
          </button>
        </form>
      </div>
    </div>
  );
}
