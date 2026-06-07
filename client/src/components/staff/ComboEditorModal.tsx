import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { X, Trash2, Search, Plus } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

const DNA = {
  heading: "text-[10px] font-black uppercase tracking-widest text-app-text-muted",
};

interface ComboItem {
  match_type: "category" | "product" | "variant";
  match_id: string;
  qty_required: number;
  sku?: string | null;
  product_name?: string | null;
  category_name?: string | null;
  variation_label?: string | null;
}

interface Combo {
  id?: string;
  label: string;
  reward_amount: string;
  is_active: boolean;
  items: ComboItem[];
}

interface CategoryOption {
  id: string;
  name: string;
}

interface ProductSearchRow {
  product_id: string;
  product_name: string;
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
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<ProductSearchRow[]>([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);

  const [formData, setFormData] = useState<Combo>({
    id: combo?.id ?? undefined,
    label: combo?.label || "",
    reward_amount: combo?.reward_amount || "0",
    is_active: combo ? combo.is_active : true,
    items: combo?.items || [],
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`${baseUrl}/api/categories`, { headers: backofficeHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((rows: CategoryOption[]) => {
        if (!cancelled) setCategories(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) toast("Unable to load categories for combo setup.", "error");
      });
    return () => {
      cancelled = true;
    };
  }, [backofficeHeaders, toast]);

  useEffect(() => {
    const query = productQuery.trim();
    if (query.length < 2) {
      setProductResults([]);
      return;
    }
    const controller = new AbortController();
    setProductSearchLoading(true);
    fetch(`${baseUrl}/api/products/control-board?search=${encodeURIComponent(query)}&limit=20`, {
      headers: backofficeHeaders(),
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { rows?: ProductSearchRow[] }) => {
        const seen = new Set<string>();
        const products = (Array.isArray(data.rows) ? data.rows : []).filter((row) => {
          if (!row.product_id || seen.has(row.product_id)) return false;
          seen.add(row.product_id);
          return true;
        });
        setProductResults(products);
      })
      .catch((err) => {
        if ((err as { name?: string }).name !== "AbortError") setProductResults([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProductSearchLoading(false);
      });
    return () => controller.abort();
  }, [backofficeHeaders, productQuery]);

  const addRequirement = useCallback(
    (item: ComboItem) => {
      setFormData((current) => {
        if (
          current.items.some(
            (existing) =>
              existing.match_type === item.match_type && existing.match_id === item.match_id,
          )
        ) {
          toast("That requirement is already in this combo.", "info");
          return current;
        }
        if (current.items.length >= 4) {
          toast("Combos support up to 4 requirements.", "error");
          return current;
        }
        return {
          ...current,
          items: [...current.items, item],
        };
      });
    },
    [toast],
  );

  const addSelectedCategory = () => {
    const category = categories.find((item) => item.id === selectedCategoryId);
    if (!category) {
      toast("Select a category requirement first.", "error");
      return;
    }
    addRequirement({
      match_type: "category",
      match_id: category.id,
      qty_required: 1,
      category_name: category.name,
    });
    setSelectedCategoryId("");
  };

  const addProduct = (product: ProductSearchRow) => {
    addRequirement({
      match_type: "product",
      match_id: product.product_id,
      qty_required: 1,
      product_name: product.product_name,
    });
    setProductQuery("");
    setProductResults([]);
  };

  const updateItemQuantity = (idx: number, qty: number) => {
    setFormData((current) => ({
      ...current,
      items: current.items.map((item, itemIdx) =>
        itemIdx === idx ? { ...item, qty_required: Math.max(1, Math.trunc(qty || 1)) } : item,
      ),
    }));
  };

  const itemLabel = (item: ComboItem) => {
    if (item.match_type === "category") return item.category_name || "Existing category requirement";
    if (item.match_type === "product") return item.product_name || "Existing product requirement";
    return item.product_name || "Existing item requirement";
  };

  const itemDetail = (item: ComboItem) => {
    if (item.match_type === "category") return "Category requirement";
    if (item.match_type === "product") return "Product requirement";
    return item.sku ? `Item requirement ${item.sku}` : "Item requirement";
  };

  const save = async () => {
    if (!formData.label.trim()) return toast("Bundle label required", "error");
    if ((Number.parseFloat(formData.reward_amount) || 0) <= 0)
      return toast("Reward amount must be greater than zero", "error");
    if (formData.items.length < 3 || formData.items.length > 4)
      return toast("Combo rewards require 3 or 4 requirements.", "error");
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
            <div className="space-y-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
              <label htmlFor="combo-category" className={DNA.heading}>
                Add category requirement
              </label>
              <div className="flex gap-2">
                <select
                  id="combo-category"
                  value={selectedCategoryId}
                  onChange={(e) => setSelectedCategoryId(e.target.value)}
                  className="ui-input min-w-0 flex-1 rounded-xl border-app-border bg-app-surface px-3 py-3 text-sm font-bold text-app-text"
                >
                  <option value="">Select category...</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addSelectedCategory}
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-slate-950 transition hover:bg-emerald-400"
                  aria-label="Add category requirement"
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
              <label htmlFor="combo-product-search" className={DNA.heading}>
                Add product requirement
              </label>
              <div className="relative">
                <Search
                  size={16}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted"
                />
                <input
                  id="combo-product-search"
                  className="w-full rounded-xl border-app-border bg-app-surface py-3 pl-11 pr-4 text-sm font-bold text-app-text ui-input focus:border-emerald-500/40"
                  placeholder="Search product name..."
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                  autoFocus
                />
              </div>
              {productQuery.trim().length >= 2 && (
                <div className="max-h-44 overflow-auto rounded-xl border border-app-border bg-app-surface">
                  {productSearchLoading ? (
                    <div className="px-3 py-3 text-xs font-bold text-app-text-muted">
                      Searching products...
                    </div>
                  ) : productResults.length === 0 ? (
                    <div className="px-3 py-3 text-xs font-bold text-app-text-muted">
                      No products found.
                    </div>
                  ) : (
                    productResults.map((product) => (
                      <button
                        key={product.product_id}
                        type="button"
                        onClick={() => addProduct(product)}
                        className="flex w-full items-center justify-between border-b border-app-border px-3 py-2 text-left text-sm font-bold text-app-text last:border-b-0 hover:bg-app-surface-2"
                      >
                        <span>{product.product_name}</span>
                        <Plus size={16} className="text-emerald-500" />
                      </button>
                    ))
                  )}
                </div>
              )}
              <p className="text-[10px] font-bold text-app-text-muted">
                Build combos from category or product requirements. Wedding transactions are excluded from combo rewards.
              </p>
            </div>

            <div className="space-y-2 rounded-xl border border-app-border bg-app-surface-2 p-2">
            {formData.items.length === 0 ? (
              <div className="px-3 py-4 text-center text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                No requirements added
              </div>
            ) : formData.items.map((item, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-3 rounded-lg border border-app-border bg-app-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-black text-app-text">
                    {itemLabel(item)}
                  </div>
                  <div className="font-mono text-[10px] text-app-text-muted">
                    {itemDetail(item)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <label className="sr-only" htmlFor={`combo-qty-${idx}`}>
                    Quantity required
                  </label>
                  <input
                    id={`combo-qty-${idx}`}
                    type="number"
                    min={1}
                    value={item.qty_required}
                    onChange={(e) => updateItemQuantity(idx, Number(e.target.value))}
                    className="ui-input h-9 w-16 rounded-lg border-app-border bg-app-surface px-2 text-center text-xs font-black text-app-text"
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    className="p-2 text-app-text-muted hover:text-red-500"
                    aria-label="Remove combo requirement"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
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
