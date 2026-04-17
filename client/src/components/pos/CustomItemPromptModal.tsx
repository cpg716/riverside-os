import { useState, useEffect } from "react";
import type { TaxCategory } from "../../lib/tax";

interface CustomItemPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (data: { 
    itemType: string; 
    price: string; 
    cost: string;
    needByDate: string | null; 
    isRush: boolean; 
    needsGiftWrap: boolean;
    taxCategory: TaxCategory;
  }) => void;
}

const ITEM_TYPES = ["SUITS", "SPORT COAT", "SLACKS", "INDIVIDUALIZED SHIRTS", "OTHER"];

export default function CustomItemPromptModal({
  isOpen,
  onClose,
  onConfirm,
}: CustomItemPromptModalProps) {
  const [itemType, setItemType] = useState(ITEM_TYPES[0]);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [needByDate, setNeedByDate] = useState("");
  const [isRush, setIsRush] = useState(false);
  const [needsGiftWrap, setNeedsGiftWrap] = useState(false);
  const [taxCategory, setTaxCategory] = useState<TaxCategory>("clothing");

  // Sync tax category when item type changes
  useEffect(() => {
    if (itemType === "OTHER") {
      setTaxCategory("other");
    } else {
      setTaxCategory("clothing");
    }
  }, [itemType]);

  const handleConfirm = () => {
    onConfirm({
      itemType,
      price: price || "0.00",
      cost: cost || "0.00",
      needByDate: needByDate || null,
      isRush,
      needsGiftWrap,
      taxCategory,
    });
    // Reset
    setPrice("");
    setCost("");
    setNeedByDate("");
    setIsRush(false);
    setNeedsGiftWrap(false);
  };

  return (
    <div
      className={`fixed inset-0 z-[120] flex items-center justify-center p-4 transition-all ${
        isOpen ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="border-b border-app-border bg-app-surface-2 px-6 py-4">
          <h3 className="text-lg font-black uppercase italic tracking-tighter text-app-text">
            Custom Work Order
          </h3>
          <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
            Configure custom item details
          </p>
        </div>

        <div className="space-y-4 p-6">
          {/* Item Type */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Item Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {ITEM_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setItemType(t)}
                  className={`rounded-xl border-2 px-3 py-2 text-[10px] font-black uppercase tracking-wide transition-all ${
                    itemType === t
                      ? "border-app-accent bg-app-accent/10 text-app-accent shadow-sm"
                      : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-input-border hover:bg-app-surface"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Tax Category Override (Visible if OTHER) */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Tax Classification
            </label>
            <div className="flex gap-2">
              {(["clothing", "footwear", "other"] as TaxCategory[]).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setTaxCategory(cat)}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${
                    taxCategory === cat
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
                      : "border-app-border bg-app-surface-2 text-app-text-muted"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Price */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Sale Price ($)
            </label>
            <input
              type="text"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="ui-input h-12 w-full text-lg font-black tabular-nums tracking-tight"
            />
          </div>

          {/* Cost */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Vendor Cost ($)
            </label>
            <input
              type="text"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="0.00"
              className="ui-input h-12 w-full text-lg font-black tabular-nums tracking-tight border-amber-200/50"
            />
          </div>

          {/* Need By Date */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Need By Date
            </label>
            <input
              type="date"
              value={needByDate}
              onChange={(e) => setNeedByDate(e.target.value)}
              className="ui-input h-12 w-full text-sm font-bold uppercase tracking-widest"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {/* Rush Order */}
            <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 p-3 transition-colors hover:bg-app-surface">
              <div className="flex flex-col">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Rush
                </span>
                <span className="text-[10px] font-bold text-red-600">
                  URGENT
                </span>
              </div>
              <div
                onClick={() => setIsRush(!isRush)}
                className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                  isRush ? "bg-red-600" : "bg-zinc-300 dark:bg-zinc-700"
                }`}
              >
                <div
                  className={`absolute left-0.5 top-0.5 h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
                    isRush ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </label>

            {/* Gift Wrap */}
            <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 p-3 transition-colors hover:bg-app-surface">
              <div className="flex flex-col">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Wrap
                </span>
                <span className="text-[10px] font-bold text-emerald-600">
                  DECO
                </span>
              </div>
              <div
                onClick={() => setNeedsGiftWrap(!needsGiftWrap)}
                className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                  needsGiftWrap ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"
                }`}
              >
                <div
                  className={`absolute left-0.5 top-0.5 h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
                    needsGiftWrap ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </label>
          </div>
        </div>

        <div className="flex gap-2 border-t border-app-border bg-app-surface-2 p-4">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl py-3 text-xs font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface hover:text-app-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex-1 rounded-xl bg-app-accent py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/30 transition-all hover:brightness-110 active:scale-[0.98]"
          >
            Add to Cart
          </button>
        </div>
      </div>
    </div>
  );
}
