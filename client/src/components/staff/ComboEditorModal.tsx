import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useRef, useState } from "react";
import { X, Trash2, Barcode } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import VariantSearchInput, {
  type VariantSearchResult,
} from "../ui/VariantSearchInput";

const baseUrl = getBaseUrl();

const DNA = {
  heading: "text-[10px] font-black uppercase tracking-widest text-app-text-muted",
};

interface ComboItem {
  match_type: "category" | "product" | "variant";
  match_id: string;
  qty_required: number;
  sku?: string;
  product_name?: string;
  variation_label?: string | null;
}

interface Combo {
  id?: string;
  label: string;
  reward_amount: string;
  is_active: boolean;
  items: ComboItem[];
}

export default function ComboEditorModal({
  combo,
  onClose,
  onSaved,
}: {
  combo: Combo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [loading, setLoading] = useState(false);
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const [scanValue, setScanValue] = useState("");

  const [formData, setFormData] = useState<Combo>({
    id: combo?.id ?? undefined,
    label: combo?.label || "",
    reward_amount: combo?.reward_amount || "0",
    is_active: combo ? combo.is_active : true,
    items: combo?.items || [],
  });

  const addVariant = useCallback(
    (variant: {
      product_id: string;
      variant_id: string;
      sku: string;
      product_name: string;
      variation_label?: string | null;
    }) => {
      setFormData((current) => {
        if (current.items.some((item) => item.match_id === variant.variant_id)) {
          toast("SKU is already in this combo.", "info");
          return current;
        }
        if (current.items.length >= 4) {
          toast("Combos support up to 4 SKUs.", "error");
          return current;
        }
        return {
          ...current,
          items: [
            ...current.items,
            {
              match_type: "variant",
              match_id: variant.variant_id,
              qty_required: 1,
              sku: variant.sku,
              product_name: variant.product_name,
              variation_label: variant.variation_label,
            },
          ],
        };
      });
      window.setTimeout(() => scanInputRef.current?.focus(), 0);
    },
    [toast],
  );

  const addSearchVariant = useCallback(
    (variant: VariantSearchResult) => {
      addVariant({
        product_id: variant.product_id,
        variant_id: variant.variant_id,
        sku: variant.sku,
        product_name: variant.product_name,
        variation_label: variant.variation_label,
      });
    },
    [addVariant],
  );

  const scanSku = async () => {
    const code = scanValue.trim();
    if (!code) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/inventory/scan/${encodeURIComponent(code)}`,
        { headers: backofficeHeaders() },
      );
      if (!res.ok) throw new Error("SKU not found");
      const item = (await res.json()) as {
        product_id: string;
        variant_id: string;
        sku: string;
        name: string;
        variation_label?: string | null;
      };
      addVariant({
        product_id: item.product_id,
        variant_id: item.variant_id,
        sku: item.sku,
        product_name: item.name,
        variation_label: item.variation_label,
      });
      setScanValue("");
    } catch {
      toast("No active SKU matched that scan.", "error");
    } finally {
      window.setTimeout(() => scanInputRef.current?.focus(), 0);
    }
  };

  const save = async () => {
    if (!formData.label.trim()) return toast("Bundle label required", "error");
    if ((Number.parseFloat(formData.reward_amount) || 0) <= 0)
      return toast("Reward amount must be greater than zero", "error");
    if (formData.items.length < 3 || formData.items.length > 4)
      return toast("Combo rewards require 3 or 4 SKUs.", "error");
    if (formData.items.some((it) => !it.match_id))
      return toast("All items must have a target", "error");
    if (formData.items.some((it) => it.qty_required <= 0))
      return toast("Requirement quantity must be greater than zero", "error");

    setLoading(true);
    try {
      const payload = {
        ...formData,
        label: formData.label.trim(),
        reward_amount: Number.parseFloat(formData.reward_amount),
        items: formData.items.map((item) => ({
          match_type: item.match_type,
          match_id: item.match_id,
          qty_required: Math.trunc(item.qty_required),
        })),
      };
      const res = await fetch(`${baseUrl}/api/staff/commissions/combos`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...backofficeHeaders(),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("Save failed");
      toast("Bundle saved", "success");
      onSaved();
    } catch {
      toast("Failed to save bundle", "error");
    } finally {
      setLoading(false);
    }
  };

  const removeItem = (idx: number) => {
    setFormData({
      ...formData,
      items: formData.items.filter((_, i) => i !== idx),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-app-border bg-app-surface p-8 shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-lg font-black tracking-tight text-app-text uppercase line-height-tight">
              {combo ? "Edit Bundle" : "Configure Combo"}
            </h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/60 mt-1 font-mono">
              MULTI-ITEM REWARD ENGINE
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-2 text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6 max-h-[60vh] overflow-auto pr-2">
          <div className="space-y-1.5">
            <label className={DNA.heading}>Bundle Name</label>
            <input
              className="w-full ui-input rounded-xl border-app-border bg-app-surface px-4 py-3 text-sm font-bold text-app-text focus:border-emerald-500/40"
              placeholder="e.g. Full Suit + Shirt Package"
              value={formData.label}
              onChange={(e) =>
                setFormData({ ...formData, label: e.target.value })
              }
            />
          </div>

          <div className="space-y-1.5">
            <label className={DNA.heading}>Reward Amount ($)</label>
            <div className="relative">
              <input
                type="number"
                className="w-full ui-input rounded-xl border-app-border bg-app-surface py-3 pl-8 pr-4 font-mono text-sm font-black tabular-nums text-emerald-600 dark:text-emerald-400"
                placeholder="0.00"
                value={formData.reward_amount}
                onChange={(e) =>
                  setFormData({ ...formData, reward_amount: e.target.value })
                }
              />
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted font-bold">
                $
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-3">
              <label htmlFor="combo-sku-scan" className={DNA.heading}>
                Combo SKUs
              </label>
              <div className="relative">
                <Barcode
                  size={16}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted"
                />
                <input
                  ref={scanInputRef}
                  id="combo-sku-scan"
                  className="w-full rounded-xl border-app-border bg-app-surface py-3 pl-11 pr-4 text-sm font-bold text-app-text ui-input focus:border-emerald-500/40"
                  placeholder="Scan SKU, then Enter"
                  value={scanValue}
                  onChange={(e) => setScanValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void scanSku();
                    }
                  }}
                  autoFocus
                />
              </div>
              <VariantSearchInput
                onSelect={addSearchVariant}
                placeholder="Search item name or SKU..."
              />
              <p className="text-[10px] font-bold text-app-text-muted">
                Add 3 or 4 SKUs. Wedding transactions are excluded from combo
                rewards.
              </p>
            </div>

            <div className="space-y-2 rounded-xl border border-app-border bg-app-surface-2 p-2">
            {formData.items.length === 0 ? (
              <div className="px-3 py-4 text-center text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                No SKUs added
              </div>
            ) : formData.items.map((item, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between rounded-lg border border-app-border bg-app-surface px-3 py-2"
              >
                <div>
                  <div className="text-xs font-black text-app-text">
                    {item.product_name || "Existing SKU requirement"}
                  </div>
                  <div className="font-mono text-[10px] text-app-text-muted">
                    {item.sku || item.match_id.slice(0, 8)}
                    {item.variation_label ? ` - ${item.variation_label}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeItem(idx)}
                  className="p-2 text-app-text-muted hover:text-red-500"
                  aria-label="Remove combo SKU"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-8 border-t border-app-border mt-8">
          <button
            type="button"
            disabled={loading}
            onClick={save}
            className="flex-1 bg-emerald-500 text-slate-950 font-black uppercase tracking-widest text-[10px] py-4 rounded-2xl shadow-xl shadow-emerald-500/20 hover:bg-emerald-400 active:scale-95 transition-all disabled:opacity-50"
          >
            {loading
              ? "Syncing Bundle..."
              : combo
                ? "Update Bundle"
                : "Activate Bundle"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-6 bg-app-surface-2 text-app-text-muted font-black uppercase tracking-widest text-[10px] py-4 rounded-2xl hover:text-app-text transition-colors"
          >
            Exit
          </button>
        </div>
      </div>
    </div>
  );
}
