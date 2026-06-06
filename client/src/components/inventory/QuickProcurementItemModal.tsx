import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Barcode, PackagePlus, X } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { apiUrl } from "../../lib/apiUrl";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import type { VariantSearchResult } from "../ui/VariantSearchInput";

interface QuickProductResponse {
  id: string;
  name: string;
}

interface QuickVariantResponse {
  id: string;
  sku: string;
  variation_label?: string | null;
}

interface Props {
  vendorId: string;
  vendorName: string;
  initialSku?: string;
  defaultCost?: string;
  defaultRetail?: string;
  onClose: () => void;
  onCreated: (variant: VariantSearchResult) => void;
}

const baseUrl = getBaseUrl();

export default function QuickProcurementItemModal({
  vendorId,
  vendorName,
  initialSku = "",
  defaultCost = "0.00",
  defaultRetail = "0.00",
  onClose,
  onCreated,
}: Props) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [sku, setSku] = useState(initialSku.trim().toUpperCase());
  const [variationLabel, setVariationLabel] = useState("Standard");
  const [cost, setCost] = useState(defaultCost);
  const [retail, setRetail] = useState(defaultRetail);
  const [busy, setBusy] = useState(false);
  const [nextSkuBusy, setNextSkuBusy] = useState(false);

  useEffect(() => {
    setSku(initialSku.trim().toUpperCase());
  }, [initialSku]);

  const headers = useMemo(
    () => ({
      "Content-Type": "application/json",
      ...mergedPosStaffHeaders(backofficeHeaders),
    }),
    [backofficeHeaders],
  );

  const requestNextSku = async () => {
    setNextSkuBusy(true);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/products/next-ros-skus?count=1"), {
        headers,
      });
      if (!res.ok) throw new Error("Could not reserve the next ROS SKU.");
      const body = (await res.json()) as { skus?: string[]; start?: number };
      setSku(body.skus?.[0] ?? `ROS-${String(body.start ?? 1).padStart(6, "0")}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not reserve the next ROS SKU.", "error");
    } finally {
      setNextSkuBusy(false);
    }
  };

  const createItem = async () => {
    const cleanName = name.trim();
    const cleanSku = sku.trim().toUpperCase();
    const cleanLabel = variationLabel.trim();
    const costCents = parseMoneyToCents(cost);
    const retailCents = parseMoneyToCents(retail);
    if (!cleanName) {
      toast("Enter an item name.", "error");
      return;
    }
    if (!cleanSku) {
      toast("Enter a SKU.", "error");
      return;
    }
    if (costCents < 0 || retailCents < 0) {
      toast("Cost and retail must be zero or higher.", "error");
      return;
    }

    setBusy(true);
    try {
      const createRes = await fetch(apiUrl(baseUrl, "/api/products"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          category_id: null,
          primary_vendor_id: vendorId,
          name: cleanName,
          brand: null,
          description: null,
          base_retail_price: centsToFixed2(retailCents),
          base_cost: centsToFixed2(costCents),
          variation_axes: [],
          images: [],
          track_low_stock: false,
          publish_variants_to_web: false,
          tax_category_override: null,
          variants: [
            {
              sku: cleanSku,
              variation_values: {},
              variation_label: cleanLabel || null,
              stock_on_hand: 0,
              retail_price_override: null,
              cost_override: null,
              track_low_stock: false,
            },
          ],
        }),
      });
      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Item could not be created.");
      }
      const product = (await createRes.json()) as QuickProductResponse;
      const variantRes = await fetch(apiUrl(baseUrl, `/api/products/${product.id}/variants`), {
        headers,
      });
      if (!variantRes.ok) throw new Error("Item was created, but the new SKU could not be loaded.");
      const variants = (await variantRes.json()) as QuickVariantResponse[];
      const variant = variants.find((row) => row.sku.toUpperCase() === cleanSku) ?? variants[0];
      if (!variant) throw new Error("Item was created without a usable SKU.");

      onCreated({
        product_id: product.id,
        variant_id: variant.id,
        sku: variant.sku,
        product_name: product.name,
        variation_label: (variant.variation_label ?? cleanLabel) || null,
        cost_price: centsToFixed2(costCents),
        retail_price: centsToFixed2(retailCents),
      });
      toast("Item created and selected.", "success");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Item could not be created.", "error");
    } finally {
      setBusy(false);
    }
  };

  const root = document.getElementById("drawer-root") ?? document.body;

  return createPortal(
    <div className="ui-overlay-backdrop z-200 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-procurement-item-title"
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-app-border bg-app-surface-2 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-app-accent/30 bg-app-accent/10 p-2 text-app-accent">
              <PackagePlus size={20} />
            </div>
            <div>
              <h2 id="quick-procurement-item-title" className="text-base font-black text-app-text">Quick Add Item</h2>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Vendor: {vendorName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-app-border bg-app-surface p-2 text-app-text-muted transition hover:text-app-text"
            aria-label="Close quick add item"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Item Name</span>
            <input
              autoFocus
              aria-label="Item Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="ui-input h-11 w-full text-sm font-bold"
              placeholder="Product name from vendor paperwork"
            />
          </label>

          <label className="space-y-1">
            <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">SKU</span>
            <div className="flex gap-2">
              <input
                aria-label="SKU"
                value={sku}
                onChange={(event) => setSku(event.target.value.toUpperCase())}
                className="ui-input h-11 min-w-0 flex-1 font-mono text-sm font-bold"
                placeholder="Scan or enter SKU"
              />
              <button
                type="button"
                onClick={() => void requestNextSku()}
                disabled={nextSkuBusy}
                className="h-11 rounded-xl border border-app-border bg-app-surface px-3 text-xs font-bold text-app-text-muted transition hover:border-app-accent hover:text-app-accent disabled:opacity-40"
              >
                <Barcode size={15} />
              </button>
            </div>
          </label>

          <label className="space-y-1">
            <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Variation</span>
            <input
              aria-label="Variation"
              value={variationLabel}
              onChange={(event) => setVariationLabel(event.target.value)}
              className="ui-input h-11 w-full text-sm font-bold"
              placeholder="Standard, size, color, or option"
            />
          </label>

          <label className="space-y-1">
            <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Unit Cost</span>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted/50">$</span>
              <input
                aria-label="Unit Cost"
                type="number"
                min={0}
                step="0.01"
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                className="ui-input h-11 w-full pl-7 text-sm font-bold"
              />
            </div>
          </label>

          <label className="space-y-1">
            <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Retail</span>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted/50">$</span>
              <input
                aria-label="Retail"
                type="number"
                min={0}
                step="0.01"
                value={retail}
                onChange={(event) => setRetail(event.target.value)}
                className="ui-input h-11 w-full pl-7 text-sm font-bold"
              />
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-3 border-t border-app-border bg-app-surface-2 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-xl border border-app-border bg-app-surface px-5 text-xs font-bold text-app-text-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void createItem()}
            disabled={busy}
            className="h-11 rounded-xl bg-app-accent px-5 text-xs font-bold text-white shadow-md shadow-app-accent/20 transition hover:brightness-110 disabled:opacity-40"
          >
            {busy ? "Creating..." : "Create & Use Item"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
