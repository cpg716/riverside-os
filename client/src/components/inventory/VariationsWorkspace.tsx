import React, { useEffect, useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  LayoutGrid,
  List,
  Search,
  Printer,
  Package,
  SlidersHorizontal,
  ShieldAlert,
  DollarSign,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { VariationGridCell } from "./VariationGridCell";
import { VariationsList } from "./VariationsList";
import { BatchCommandBar } from "./BatchCommandBar";
import ConfirmationModal from "../ui/ConfirmationModal";
import type { VariationsListProps } from "./VariationsList";
import {
  getInventoryTagPrintConfig,
  openInventoryTagsWindow,
  type InventoryTagPrintResult,
} from "./labelPrint";

export interface HubVariant {
  id: string;
  sku: string;
  variation_values: Record<string, unknown>;
  variation_label: string | null;
  stock_on_hand: number;
  reorder_point: number;
  track_low_stock: boolean;
  retail_price_override: string | null;
  cost_override: string | null;
  barcode: string | null;
  vendor_upc: string | null;
  effective_retail: string;
  web_published: boolean;
  web_price_override: string | null;
  web_gallery_order: number;
}

interface VariationsWorkspaceProps {
  productId: string;
  productTrackLowStock: boolean;
  templateBaseRetail?: string;
  productName: string;
  categoryName: string | null;
  variationAxes: string[];
  matrixRowAxisKey?: string | null;
  matrixColAxisKey?: string | null;
  variants: HubVariant[];
  baseUrl: string;
  onVariantUpdated: () => void;
}

interface VariantPricingPatchResponse {
  status?: string;
  price_changed?: boolean;
  stock_on_hand?: number;
  sku?: string;
  variation_label?: string | null;
  effective_retail?: string;
}

interface VariantReprintPrompt {
  variantId: string;
  sku: string;
  variationLabel: string;
  effectiveRetail: string;
  stockOnHand: number;
}

type VariantPatch =
  | {
      quantity_delta: number;
      notes: string;
      tx_type?: "damaged" | "return_to_vendor";
    }
  | { retail_price_override: string | null }
  | { cost_override: string | null }
  | { web_published: boolean }
  | { track_low_stock: boolean }
  | { barcode: string }
  | { clear_barcode: boolean }
  | { vendor_upc: string }
  | { clear_vendor_upc: boolean };

function strVal(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function fallbackRowLabel(variant: HubVariant): string {
  return variant.variation_label?.trim() || variant.sku;
}

const cardActionButtonClass =
  "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-center text-[10px] font-black uppercase leading-tight tracking-[0.08em] transition-colors";

const identifierInputClass =
  "min-w-0 rounded-lg border border-app-border bg-app-surface px-2 py-1.5 font-mono text-xs text-app-text outline-none focus:border-app-accent";

function VariantIdentifierEditor({
  variant,
  onSave,
}: {
  variant: HubVariant;
  onSave: (patch: VariantPatch) => Promise<VariantPricingPatchResponse | null>;
}) {
  const [barcodeDraft, setBarcodeDraft] = useState(variant.barcode ?? "");
  const [vendorUpcDraft, setVendorUpcDraft] = useState(variant.vendor_upc ?? "");
  const [saving, setSaving] = useState<"barcode" | "vendor_upc" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setBarcodeDraft(variant.barcode ?? "");
    setVendorUpcDraft(variant.vendor_upc ?? "");
  }, [variant.barcode, variant.vendor_upc]);

  const saveIdentifier = async (field: "barcode" | "vendor_upc") => {
    setSaving(field);
    setMessage(null);
    try {
      if (field === "barcode") {
        const next = barcodeDraft.trim();
        await onSave(next ? { barcode: next } : { clear_barcode: true });
        setMessage("Product UPC saved.");
      } else {
        const next = vendorUpcDraft.trim();
        await onSave(next ? { vendor_upc: next } : { clear_vendor_upc: true });
        setMessage("Catalog # saved.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Identifier update failed.");
    } finally {
      setSaving(null);
    }
  };

  const barcodeChanged = barcodeDraft.trim() !== (variant.barcode ?? "");
  const vendorUpcChanged = vendorUpcDraft.trim() !== (variant.vendor_upc ?? "");

  return (
    <div className="mt-4 space-y-2 rounded-xl border border-app-border bg-app-surface-2/60 p-3">
      <div className="grid gap-2">
        <label className="grid gap-1">
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Product UPC
          </span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              value={barcodeDraft}
              onChange={(event) => setBarcodeDraft(event.target.value)}
              className={identifierInputClass}
              placeholder="Manufacturer UPC"
              autoComplete="off"
            />
            <button
              type="button"
              disabled={!barcodeChanged || saving != null}
              onClick={() => void saveIdentifier("barcode")}
              className="rounded-lg border border-app-border bg-app-surface px-2 text-[10px] font-black uppercase tracking-widest text-app-text disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Catalog # / vendor style #
          </span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              value={vendorUpcDraft}
              onChange={(event) => setVendorUpcDraft(event.target.value)}
              className={identifierInputClass}
              placeholder="Supplier style #"
              autoComplete="off"
            />
            <button
              type="button"
              disabled={!vendorUpcChanged || saving != null}
              onClick={() => void saveIdentifier("vendor_upc")}
              className="rounded-lg border border-app-border bg-app-surface px-2 text-[10px] font-black uppercase tracking-widest text-app-text disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </label>
      </div>
      {message ? (
        <p className="text-[10px] font-semibold text-app-text-muted">{message}</p>
      ) : null}
    </div>
  );
}

export const VariationsWorkspace: React.FC<VariationsWorkspaceProps> = ({
  productId,
  productTrackLowStock,

  productName,
  categoryName,
  variationAxes,
  matrixRowAxisKey,
  matrixColAxisKey,
  variants,
  baseUrl,
  onVariantUpdated,
}) => {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [viewMode, setViewMode] = useState<"cards" | "matrix" | "list">("cards");
  const [localSearch, setLocalSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchPriceModal, setShowBatchPriceModal] = useState(false);
  const [batchPriceInput, setBatchPriceInput] = useState("");
  const [batchPriceMode, setBatchPriceMode] = useState<"fixed" | "offset">(
    "fixed",
  );
  const [batchPriceSubmitting, setBatchPriceSubmitting] = useState(false);
  const [batchStockOpen, setBatchStockOpen] = useState(false);
  const [batchStockInput, setBatchStockInput] = useState("");
  const [batchStockReason, setBatchStockReason] = useState("");
  const [stockCorrectionTargetIds, setStockCorrectionTargetIds] = useState<string[]>([]);
  const [stockCorrectionLabel, setStockCorrectionLabel] = useState("");
  const [batchStockSubmitting, setBatchStockSubmitting] = useState(false);
  const [reprintPrompt, setReprintPrompt] = useState<VariantReprintPrompt | null>(null);
  const [batchReprintPrompt, setBatchReprintPrompt] = useState<VariantReprintPrompt[] | null>(null);

  // Maintenance State
  const [maintenanceTarget, setMaintenanceTarget] = useState<{
    variantId?: string;
    variantIds?: string[];
    sku: string;
    type: "damaged" | "return_to_vendor";
  } | null>(null);
  const [mtQty, setMtQty] = useState("1");
  const [mtNote, setMtNote] = useState("");
  const [submittingMt, setSubmittingMt] = useState(false);

  const displayVariants = useMemo(() => {
    const needle = localSearch.trim().toLowerCase();
    if (!needle) return variants;
    return variants.filter((variant) => {
      const label = variant.variation_label?.toLowerCase() ?? "";
      const barcode = variant.barcode?.toLowerCase() ?? "";
      const vendorUpc = variant.vendor_upc?.toLowerCase() ?? "";
      return (
        variant.sku.toLowerCase().includes(needle) ||
        label.includes(needle) ||
        barcode.includes(needle) ||
        vendorUpc.includes(needle)
      );
    });
  }, [variants, localSearch]);

  // Matrix Logic (Refined Axes Detection)
  const detectedAxes = useMemo(() => {
    const keys = new Set<string>();
    for (const v of displayVariants) {
      Object.keys(v.variation_values).forEach((k) => keys.add(k));
    }
    return [...keys];
  }, [displayVariants]);

  const rowAxis =
    matrixRowAxisKey || variationAxes[0] || detectedAxes[0] || "Attribute";
  const colAxis =
    matrixColAxisKey ||
    variationAxes[1] ||
    detectedAxes[1] ||
    (detectedAxes.length > 1 ? detectedAxes[1] : null);

  // Fallback: If we only have 1 axis, we should probably force list mode or a 1D grid.
  // For now, if colAxis is null, we'll still show a grid with "Standard" as column.
  const actualColAxis = colAxis || "Option";

  const hasUsableMatrix = useMemo(() => {
    if (displayVariants.length <= 1) return false;
    const meaningfulRowValues = new Set<string>();
    const meaningfulColValues = new Set<string>();

    for (const variant of displayVariants) {
      const rowValue = strVal(variant.variation_values[rowAxis]);
      const colValue = strVal(variant.variation_values[actualColAxis]);
      if (rowValue) meaningfulRowValues.add(rowValue);
      if (colValue) meaningfulColValues.add(colValue);
    }

    return meaningfulRowValues.size > 1 || meaningfulColValues.size > 1;
  }, [displayVariants, rowAxis, actualColAxis]);

  const displayRowAxisLabel = hasUsableMatrix ? rowAxis : "Variation";
  const displayColAxisLabel = hasUsableMatrix ? actualColAxis : "Default";

  const rowKeys = useMemo(() => {
    const set = new Set<string>();
    for (const v of displayVariants) {
      if (hasUsableMatrix) {
        const r = strVal(v.variation_values[rowAxis]);
        if (r) set.add(r);
      } else {
        set.add(fallbackRowLabel(v));
      }
    }
    const arr = [...set].sort(naturalSort);
    // If no row keys detected but we have variants, it means they might have a different key structure
    return arr.length > 0 ? arr : ["Standard"];
  }, [displayVariants, hasUsableMatrix, rowAxis]);

  const colKeys = useMemo(() => {
    const set = new Set<string>();
    if (!hasUsableMatrix) return ["Default"];
    for (const v of displayVariants) {
      const c = strVal(v.variation_values[actualColAxis]);
      if (c) set.add(c);
    }
    const arr = [...set].sort(naturalSort);
    return arr.length > 0 ? arr : ["Default"];
  }, [displayVariants, hasUsableMatrix, actualColAxis]);

  const cellMap = useMemo(() => {
    const m = new Map<string, HubVariant>();
    for (const v of displayVariants) {
      const r = hasUsableMatrix
        ? strVal(v.variation_values[rowAxis]) || "Standard"
        : fallbackRowLabel(v);
      const c = hasUsableMatrix
        ? strVal(v.variation_values[actualColAxis]) || "Default"
        : "Default";
      m.set(`${r}\0${c}`, v);
    }
    return m;
  }, [displayVariants, hasUsableMatrix, rowAxis, actualColAxis]);

  // API Call Handlers
  const patchVariant = useCallback(
    async (
      variantId: string,
      patch: VariantPatch,
    ): Promise<VariantPricingPatchResponse | null> => {
      const isStock = "quantity_delta" in patch;
      const endpoint = isStock ? "stock-adjust" : "pricing";

      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/${endpoint}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Update failed");
      }
      const payload = (await res.json().catch(() => null)) as
        | VariantPricingPatchResponse
        | null;
      if (!isStock && payload?.price_changed && (payload.stock_on_hand ?? 0) > 0) {
        const currentVariant = variants.find((variant) => variant.id === variantId);
        const effectiveRetail =
          payload.effective_retail ??
          currentVariant?.effective_retail ??
          "0";
        setReprintPrompt({
          variantId,
          sku: payload.sku ?? currentVariant?.sku ?? "Unknown SKU",
          variationLabel:
            payload.variation_label ??
            currentVariant?.variation_label ??
            "Standard",
          effectiveRetail,
          stockOnHand: payload.stock_on_hand ?? 0,
        });
      }
      onVariantUpdated();
      return payload;
    },
    [baseUrl, apiAuth, onVariantUpdated, variants],
  );

  const openStockCorrection = useCallback(
    (variantIds: string[], label: string, defaultDelta = "") => {
      setStockCorrectionTargetIds(variantIds);
      setStockCorrectionLabel(label);
      setBatchStockInput(defaultDelta);
      setBatchStockReason("");
      setBatchStockOpen(true);
    },
    [],
  );

  // Batch Handlers
  const handleBatchWeb = async (status: boolean) => {
    toast(`Updating ${selectedIds.size} variants...`, "info");
    try {
      await Promise.all(
        [...selectedIds].map((id) =>
          patchVariant(id, { web_published: status }),
        ),
      );
      toast(`Successfully updated ${selectedIds.size} variants`, "success");
      setSelectedIds(new Set());
    } catch {
      toast("Some updates failed", "error");
    }
  };

  const handleBatchTrackLow = async (status: boolean) => {
    try {
      await Promise.all(
        [...selectedIds].map((id) =>
          patchVariant(id, { track_low_stock: status }),
        ),
      );
      toast(`Tracking updated for ${selectedIds.size} variants`, "success");
      setSelectedIds(new Set());
    } catch {
      toast("Update failed", "error");
    }
  };

  const handleMaintenanceSubmit = async () => {
    if (!maintenanceTarget) return;
    const qty = parseInt(mtQty, 10);
    if (isNaN(qty) || qty <= 0) return;
    const targetIds =
      maintenanceTarget.variantIds ?? (maintenanceTarget.variantId ? [maintenanceTarget.variantId] : []);
    if (targetIds.length === 0) return;

    setSubmittingMt(true);
    try {
      await Promise.all(
        targetIds.map(async (variantId) => {
          const res = await fetch(
            `${baseUrl}/api/products/variants/${variantId}/stock-adjust`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                quantity_delta: -qty,
                tx_type: maintenanceTarget.type,
                notes: mtNote,
              }),
            },
          );
          if (!res.ok) throw new Error("Adjustment failed");
        }),
      );
      toast(
        `Moved ${qty} from ${targetIds.length} variation${targetIds.length === 1 ? "" : "s"} to ${maintenanceTarget.type === "damaged" ? "Damaged" : "RTV"}`,
        "success",
      );
      setMaintenanceTarget(null);
      setMtQty("1");
      setMtNote("");
      setSelectedIds(new Set());
      onVariantUpdated();
    } catch {
      toast("Maintenance operation failed", "error");
    } finally {
      setSubmittingMt(false);
    }
  };

  const handlePrintTags = useCallback(
    async (variantsToPrint: HubVariant[], successLabel: string) => {
      if (variantsToPrint.length === 0) {
        toast("No variations are ready to print.", "info");
        return;
      }

      let printResult: InventoryTagPrintResult;
      try {
        printResult = await openInventoryTagsWindow(
          variantsToPrint.map((variant) => ({
            sku: variant.sku,
            productName,
            variation: variant.variation_label ?? "Standard",
            price: `$${centsToFixed2(parseMoneyToCents(variant.effective_retail))}`,
          })),
          getInventoryTagPrintConfig(),
          { allowPreviewFallback: false },
        );
      } catch (error) {
        toast(error instanceof Error ? error.message : "Tag print failed.", "error");
        return;
      }
      if (!printResult.markShelfLabeled) {
        toast(
          `${printResult.message} Shelf-label status was not changed because the tag printer did not confirm the job.`,
          "info",
        );
        return;
      }

      try {
        const res = await fetch(
          `${baseUrl}/api/products/variants/bulk-mark-shelf-labeled`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...apiAuth(),
            },
            body: JSON.stringify({
              variant_ids: variantsToPrint.map((variant) => variant.id),
            }),
          },
        );
        if (!res.ok) throw new Error("Tag print status update failed");
        toast(`${successLabel} ${printResult.message}`, "success");
        onVariantUpdated();
      } catch {
        toast("Tags opened for printing, but Riverside could not mark them as printed.", "error");
      }
    },
    [apiAuth, baseUrl, onVariantUpdated, productName, toast],
  );

  const handleBulkLabels = useCallback(() => {
    const variantsToPrint =
      selectedIds.size > 0
        ? displayVariants.filter((variant) => selectedIds.has(variant.id))
        : displayVariants;
    void handlePrintTags(
      variantsToPrint,
      `Inventory tags sent to print for ${variantsToPrint.length} variation${variantsToPrint.length === 1 ? "" : "s"}.`,
    );
  }, [displayVariants, handlePrintTags, selectedIds]);

  const handleBatchMaintenance = useCallback(
    (type: "damaged" | "return_to_vendor") => {
      const selectedVariants = variants.filter((variant) => selectedIds.has(variant.id));
      if (selectedVariants.length === 0) return;
      setMaintenanceTarget({
        variantIds: selectedVariants.map((variant) => variant.id),
        sku: `${selectedVariants.length} selected variation${selectedVariants.length === 1 ? "" : "s"}`,
        type,
      });
    },
    [selectedIds, variants],
  );

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      {/* Header Dashboard */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-black tracking-tight text-app-text flex items-center gap-3">
            <span className="opacity-40 font-mono text-sm leading-none pt-1">
              #{productId.slice(0, 8)}
            </span>
            {productName}
          </h2>
          <div className="flex items-center gap-3">
            <div
              className={`flex rounded-xl bg-app-surface shadow-sm border border-app-border p-1 ${viewMode === "cards" ? "ring-1 ring-app-accent/20" : ""}`}
            >
              <button
                onClick={() => setViewMode("cards")}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all ${viewMode === "cards" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
                title="Card view"
              >
                <Package size={16} />
              </button>
              <button
                onClick={() => setViewMode("matrix")}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all ${viewMode === "matrix" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
                title="Matrix view"
              >
                <LayoutGrid size={16} />
              </button>
              <button
                onClick={() => setViewMode("list")}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all ${viewMode === "list" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
                title="List view"
              >
                <List size={16} />
              </button>
            </div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
              {displayVariants.length} SKU{displayVariants.length !== 1 ? "s" : ""} ·{" "}
              {categoryName || "Uncategorized"}
            </p>
            {productTrackLowStock && (
              <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 text-[8px] font-black uppercase tracking-widest border border-amber-500/20">
                Low-stock alerts
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <div className="relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-app-text-muted group-focus-within:text-app-accent transition-colors" />
            <input
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="Filter variations..."
              className="ui-input h-10 pl-10 w-48 bg-app-surface/50 border-app-border/40 focus:w-64 transition-all duration-300"
            />
          </div>
          <button
            type="button"
            onClick={handleBulkLabels}
            disabled={displayVariants.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase leading-tight tracking-[0.1em] text-app-text-muted transition-colors hover:bg-app-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Printer size={14} />
            <span>Print Tags</span>
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-xs font-semibold leading-relaxed text-amber-850">
        Use SKU actions here for prices, tags, web status, small count corrections, damage, and vendor returns.
        Receive vendor shipments in <span className="font-black">Receive Stock</span>, not as count corrections.
      </div>

      {/* Main View Area */}
      {viewMode === "cards" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {displayVariants.map((v) => (
            <section
              key={v.id}
              className="rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-black text-app-text">
                    {v.sku}
                  </p>
                  <p className="mt-1 text-sm font-black text-app-text">
                    {v.variation_label || "Standard"}
                  </p>
                </div>
                <span
                  className={`rounded-xl px-3 py-1 text-sm font-black tabular-nums ${
                    v.stock_on_hand <= 0
                      ? "bg-red-50 text-red-700"
                      : v.stock_on_hand <= v.reorder_point
                        ? "bg-amber-50 text-amber-700"
                        : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {v.stock_on_hand} on hand
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-widest">
                <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 text-app-text-muted">
                  Retail ${centsToFixed2(parseMoneyToCents(v.effective_retail))}
                </span>
                <span
                  className={`rounded-lg border px-2 py-1 ${
                    v.cost_override
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-app-border bg-app-surface-2 text-app-text-muted"
                  }`}
                >
                  Cost {v.cost_override ? `$${centsToFixed2(parseMoneyToCents(v.cost_override))}` : "inherited"}
                </span>
                <span className={`rounded-lg border px-2 py-1 ${v.web_published ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-app-border bg-app-surface-2 text-app-text-muted"}`}>
                  {v.web_published ? "Online" : "Not online"}
                </span>
                {productTrackLowStock && v.track_low_stock ? (
                  <span className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">
                    Low-stock alert
                  </span>
                ) : null}
              </div>
              <VariantIdentifierEditor
                variant={v}
                onSave={(patch) => patchVariant(v.id, patch)}
              />
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => openStockCorrection([v.id], v.sku, "1")}
                  className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text hover:border-emerald-300 hover:text-emerald-700`}
                >
                  Count Fix
                </button>
                <button
                  type="button"
                  onClick={() => void patchVariant(v.id, { retail_price_override: null })}
                  className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text hover:border-app-accent hover:text-app-accent`}
                >
                  Clear Price
                </button>
                <button
                  type="button"
                  onClick={() => void patchVariant(v.id, { cost_override: null })}
                  className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text hover:border-amber-300 hover:text-amber-700`}
                >
                  Clear Cost
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void handlePrintTags([v], "Inventory tag sent to print.")
                  }
                  className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent hover:text-app-accent`}
                  title="Print inventory tag"
                >
                  <Printer size={14} className="shrink-0" />
                  Print tag
                </button>
                <button
                  type="button"
                  onClick={() => setMaintenanceTarget({ variantId: v.id, sku: v.sku, type: "damaged" })}
                  className={`${cardActionButtonClass} border-red-200 bg-red-50 text-red-700`}
                >
                  Damage
                </button>
                <button
                  type="button"
                  onClick={() => setMaintenanceTarget({ variantId: v.id, sku: v.sku, type: "return_to_vendor" })}
                  className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text hover:border-app-accent hover:text-app-accent`}
                >
                  Return to Vendor
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : viewMode === "matrix" ? (
        <div className="relative overflow-auto rounded-[24px] border border-app-border bg-app-surface/40 shadow-sm backdrop-blur-xl max-h-[70vh]">
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr className="sticky top-0 z-30">
                <th className="sticky left-0 z-40 border-b border-r border-app-border bg-app-surface-2/95 backdrop-blur-md p-4 text-left">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    <SlidersHorizontal size={14} />
                    <span>
                      {displayRowAxisLabel} \ {displayColAxisLabel}
                    </span>
                  </div>
                </th>
                {colKeys.map((ck) => (
                  <th
                    key={ck}
                    className="border-b border-app-border bg-app-surface-2/95 backdrop-blur-md p-4 text-center"
                  >
                    <span className="text-[11px] font-black uppercase tracking-widest text-app-text">
                      {ck}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowKeys.map((rk) => (
                <tr key={rk}>
                  <td className="sticky left-0 z-20 border-b border-r border-app-border bg-app-surface/95 backdrop-blur-md p-4">
                    <span className="text-sm font-black text-app-text">
                      {rk}
                    </span>
                  </td>
                  {colKeys.map((ck) => {
                    const v = cellMap.get(`${rk}\0${ck}`);
                    if (!v)
                      return (
                        <td
                          key={ck}
                          className="border-b border-app-border bg-app-surface-2/20"
                        />
                      );
                    return (
                      <td
                        key={ck}
                        className="border-b border-app-border p-1.5 align-top"
                      >
                        <VariationGridCell
                          variant={v}
                          isOutOfStock={v.stock_on_hand <= 0}
                          isLowStock={
                            v.stock_on_hand > 0 &&
                            v.stock_on_hand <= v.reorder_point
                          }
                          hasPriceOverride={!!v.retail_price_override}
                          onUpdateStock={(delta) =>
                            Promise.resolve(
                              openStockCorrection([v.id], v.sku, String(delta)),
                            )
                          }
                          onUpdatePrice={(cents) =>
                            patchVariant(v.id, {
                              retail_price_override: cents
                                ? centsToFixed2(cents)
                                : null,
                            })
                          }
                          onUpdateTrackLow={(next) =>
                            patchVariant(v.id, { track_low_stock: next })
                          }
                          onUpdateWeb={(next) =>
                            patchVariant(v.id, { web_published: next })
                          }
                          onShowMaintenance={(type) =>
                            setMaintenanceTarget({
                              variantId: v.id,
                              sku: v.sku,
                              type,
                            })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <VariationsList
          variants={displayVariants}
          selectedIds={selectedIds}
          onToggleSelect={(id) =>
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSelectAll={() => setSelectedIds(new Set(displayVariants.map((v) => v.id)))}
          onDeselectAll={() => setSelectedIds(new Set())}
          onUpdateVariant={
            patchVariant as VariationsListProps["onUpdateVariant"]
          }
          onShowMaintenance={(id, sku, type) =>
            setMaintenanceTarget({ variantId: id, sku, type })
          }
          onShowCountCorrection={(id, sku, delta) =>
            openStockCorrection([id], sku, String(delta))
          }
        />
      )}

      {/* Maintenance Modal */}
      {maintenanceTarget && createPortal(
        <div className="ui-overlay-backdrop animate-in fade-in duration-300">
          <div className="ui-modal w-full max-w-md p-8 animate-in zoom-in-95 duration-300">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${maintenanceTarget.type === "damaged" ? "bg-red-500/10 text-red-500" : "bg-app-accent/10 text-app-accent"}`}
                >
                  <ShieldAlert size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-black uppercase tracking-tight text-app-text italic">
                    {maintenanceTarget.type === "damaged"
                      ? "Mark as Damaged"
                      : "Return to Vendor"}
                  </h3>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                    Variation Maintenance
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted mb-1">
                  Target SKU
                </p>
                <p className="font-mono text-sm font-bold text-app-text">
                  {maintenanceTarget.sku}
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Quantity to Remove
                </label>
                <input
                  type="number"
                  value={mtQty}
                  onChange={(e) => setMtQty(e.target.value)}
                  className="ui-input h-12 w-full text-lg font-bold"
                  placeholder="1"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Note / Reason
                </label>
                <textarea
                  value={mtNote}
                  onChange={(e) => setMtNote(e.target.value)}
                  className="ui-input min-h-[100px] w-full p-4 text-sm"
                  placeholder={
                    maintenanceTarget.type === "damaged"
                      ? "Describe damage..."
                      : "Reason for RTV..."
                  }
                />
              </div>
            </div>

            <div className="mt-8 flex gap-3">
              <button
                onClick={() => setMaintenanceTarget(null)}
                className="flex-1 rounded-2xl bg-app-surface-2 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-3 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleMaintenanceSubmit}
                disabled={submittingMt}
                className={`flex-1 rounded-2xl py-4 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all active:scale-95 ${maintenanceTarget.type === "damaged" ? "bg-red-600 shadow-red-600/20" : "bg-app-accent shadow-app-accent/20"}`}
              >
                {submittingMt ? "Working..." : "Confirm Action"}
              </button>
            </div>
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}

      {/* Count correction modal */}
      {batchStockOpen && createPortal(
        <div className="ui-overlay-backdrop animate-in fade-in duration-300">
          <div className="ui-modal w-full max-w-md p-8 animate-in zoom-in-95 duration-300">
            <div className="mb-6">
              <p className="text-[10px] font-black uppercase tracking-[0.25em] text-app-text-muted">
                Count Correction
              </p>
              <h3 className="mt-1 text-xl font-black italic uppercase tracking-tight text-app-text">
                {stockCorrectionLabel || `${stockCorrectionTargetIds.length} selected SKUs`}
              </h3>
              <p className="mt-2 text-xs font-semibold leading-relaxed text-app-text-muted">
                Use this only for verified count corrections. Vendor shipments belong in Receive Stock.
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Signed Quantity Change
                </label>
                <input
                  type="number"
                  value={batchStockInput}
                  onChange={(e) => setBatchStockInput(e.target.value)}
                  className="ui-input h-12 w-full text-lg font-bold"
                  placeholder="+1 or -1"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Reason
                </label>
                <textarea
                  value={batchStockReason}
                  onChange={(e) => setBatchStockReason(e.target.value)}
                  className="ui-input min-h-[96px] w-full p-4 text-sm"
                  placeholder="Explain the count correction."
                />
              </div>
            </div>

            <div className="mt-8 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  if (batchStockSubmitting) return;
                  setBatchStockOpen(false);
                  setStockCorrectionTargetIds([]);
                  setStockCorrectionLabel("");
                }}
                className="flex-1 rounded-2xl bg-app-surface-2 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-3 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={batchStockSubmitting || batchStockReason.trim().length < 3}
                onClick={async () => {
                  const delta = parseInt(batchStockInput, 10);
                  if (isNaN(delta) || delta === 0) {
                    toast("Enter a non-zero integer", "error");
                    return;
                  }
                  if (batchStockReason.trim().length < 3) {
                    toast("Enter a count correction reason", "error");
                    return;
                  }
                  const targetIds = stockCorrectionTargetIds.length > 0
                    ? stockCorrectionTargetIds
                    : [...selectedIds];
                  if (targetIds.length === 0) {
                    toast("Select at least one SKU", "error");
                    return;
                  }
                  setBatchStockSubmitting(true);
                  try {
                    toast(
                      `Applying count correction ${delta} to ${targetIds.length} SKU${targetIds.length === 1 ? "" : "s"}...`,
                      "info",
                    );
                    await Promise.all(
                      targetIds.map((id) =>
                        patchVariant(id, {
                          quantity_delta: delta,
                          notes: batchStockReason.trim(),
                        }),
                      ),
                    );
                    toast("Count correction complete", "success");
                    setSelectedIds(new Set());
                    setBatchStockOpen(false);
                    setBatchStockInput("");
                    setBatchStockReason("");
                    setStockCorrectionTargetIds([]);
                    setStockCorrectionLabel("");
                  } catch (error) {
                    toast(error instanceof Error ? error.message : "Count correction failed", "error");
                  } finally {
                    setBatchStockSubmitting(false);
                  }
                }}
                className="flex-1 rounded-2xl bg-app-accent py-4 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 transition-all active:scale-95 disabled:opacity-50"
              >
                {batchStockSubmitting ? "Applying..." : "Apply"}
              </button>
            </div>
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}

      {showBatchPriceModal && createPortal(
        <div className="ui-overlay-backdrop animate-in fade-in duration-300">
          <div className="ui-modal w-full max-w-sm p-8 animate-in zoom-in-95 duration-300">
            <div className="mb-6 flex flex-col items-center text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-app-accent text-white shadow-lg shadow-app-accent/30">
                <DollarSign size={28} />
              </div>
              <h3 className="text-xl font-black uppercase tracking-tight text-app-text italic">
                Batch Pricing
              </h3>
              <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                Adjusting {selectedIds.size} variants
              </p>
            </div>

            <div className="space-y-6">
              <div className="flex rounded-2xl border border-app-border bg-app-surface-2 p-1">
                <button
                  onClick={() => setBatchPriceMode("fixed")}
                  className={`flex-1 rounded-xl py-2 text-[10px] font-black uppercase tracking-widest transition-all ${batchPriceMode === "fixed" ? "bg-app-accent text-white shadow-sm" : "text-app-text-muted hover:text-app-text"}`}
                >
                  Fixed Price
                </button>
                <button
                  onClick={() => setBatchPriceMode("offset")}
                  className={`flex-1 rounded-xl py-2 text-[10px] font-black uppercase tracking-widest transition-all ${batchPriceMode === "offset" ? "bg-app-accent text-white shadow-sm" : "text-app-text-muted hover:text-app-text"}`}
                >
                  Offset (+/-)
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  {batchPriceMode === "fixed"
                    ? "New Retail Price"
                    : "Price Offset ($)"}
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-app-text-muted">
                    $
                  </span>
                  <input
                    type="text"
                    autoFocus
                    value={batchPriceInput}
                    onChange={(e) => setBatchPriceInput(e.target.value)}
                    className="ui-input h-14 w-full pl-8 pr-4 text-xl font-black tabular-nums"
                    placeholder={batchPriceMode === "fixed" ? "99.99" : "+5.00"}
                  />
                </div>
              </div>
            </div>

            <div className="mt-8 flex gap-3">
              <button
                onClick={() => setShowBatchPriceModal(false)}
                className="flex-1 rounded-2xl bg-app-surface-2 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-3 transition-colors"
                disabled={batchPriceSubmitting}
              >
                Cancel
              </button>
              <button
                disabled={!batchPriceInput || batchPriceSubmitting}
                onClick={async () => {
                  setBatchPriceSubmitting(true);
                  try {
                    const cents = parseMoneyToCents(
                      batchPriceInput.replace("+", ""),
                    );
                    if (isNaN(cents)) throw new Error("Invalid price format");

                    const updates = [...selectedIds].map(async (id) => {
                      let finalPriceCents = cents;
                      if (batchPriceMode === "offset") {
                        const v = variants.find((v) => v.id === id);
                        if (!v) return null;
                        const current = parseMoneyToCents(v.effective_retail);
                        finalPriceCents = current + cents;
                      }
                      return patchVariant(id, {
                        retail_price_override: centsToFixed2(finalPriceCents),
                      });
                    });

                    const responses = await Promise.all(updates);
                    const affected = responses
                      .filter((r): r is VariantPricingPatchResponse =>
                        r != null && r.price_changed === true && (r.stock_on_hand ?? 0) > 0,
                      )
                      .map((r) => {
                        const v = variants.find((var_) => var_.sku === r.sku);
                        return {
                          variantId: v?.id ?? "",
                          sku: r.sku ?? v?.sku ?? "Unknown SKU",
                          variationLabel:
                            r.variation_label ?? v?.variation_label ?? "Standard",
                          effectiveRetail:
                            r.effective_retail ?? v?.effective_retail ?? "0",
                          stockOnHand: r.stock_on_hand ?? 0,
                        };
                      })
                      .filter((item) => item.variantId !== "");

                    toast(
                      `Batch price ${batchPriceMode === "fixed" ? "updated" : "adjusted"} successfully`,
                      "success",
                    );
                    setShowBatchPriceModal(false);
                    setBatchPriceInput("");
                    if (affected.length > 0) {
                      setBatchReprintPrompt(affected);
                    }
                  } catch (e) {
                    toast(
                      e instanceof Error
                        ? e.message
                        : "Failed to batch update price",
                      "error",
                    );
                  } finally {
                    setBatchPriceSubmitting(false);
                  }
                }}
                className="flex-1 rounded-2xl bg-app-accent py-4 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                {batchPriceSubmitting ? "Applying..." : "Apply Bulk"}
              </button>
            </div>
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}

      {/* Batch reprint prompt for multi-variant price changes */}
      <ConfirmationModal
        isOpen={batchReprintPrompt != null && batchReprintPrompt.length > 0}
        title="Print Updated Price Tags?"
        message={
          batchReprintPrompt
            ? `The price of ${batchReprintPrompt.length} variation${batchReprintPrompt.length === 1 ? "" : "s"} has changed. Would you like to print new tags for the ${batchReprintPrompt.reduce((sum, v) => sum + Math.max(0, v.stockOnHand), 0)} units in stock?`
            : ""
        }
        confirmLabel="Print Tags"
        onClose={() => setBatchReprintPrompt(null)}
        onConfirm={() => {
          if (!batchReprintPrompt || batchReprintPrompt.length === 0) return;
          void handlePrintTags(
            batchReprintPrompt.map((item) => {
              const v = variants.find((var_) => var_.id === item.variantId);
              return {
                ...(v ?? ({} as HubVariant)),
                id: item.variantId,
                sku: item.sku,
                variation_label: item.variationLabel,
                effective_retail: item.effectiveRetail,
                stock_on_hand: item.stockOnHand,
              };
            }),
            `Updated price tags for ${batchReprintPrompt.length} variation${batchReprintPrompt.length === 1 ? "" : "s"} sent to print.`,
          );
          setBatchReprintPrompt(null);
        }}
      />

      {/* Batch Command Bar */}
      <ConfirmationModal
        isOpen={reprintPrompt != null}
        title="Print Updated Price Tags?"
        message={
          reprintPrompt
            ? `The price of this item has changed. Would you like to print new tags for the ${reprintPrompt.stockOnHand} units in stock?`
            : ""
        }
        confirmLabel="Print Tags"
        onClose={() => setReprintPrompt(null)}
        onConfirm={() => {
          if (!reprintPrompt) return;
          void (async () => {
            try {
              const printItems = Array.from(
                { length: Math.max(0, reprintPrompt.stockOnHand) },
                () => ({
                  sku: reprintPrompt.sku,
                  productName,
                  variation: reprintPrompt.variationLabel,
                  price: `$${centsToFixed2(parseMoneyToCents(reprintPrompt.effectiveRetail))}`,
                }),
              );
              if (printItems.length === 0) {
                setReprintPrompt(null);
                return;
              }
              const printResult = await openInventoryTagsWindow(
                printItems,
                getInventoryTagPrintConfig(),
                { allowPreviewFallback: false },
              );
              if (!printResult.markShelfLabeled) {
                toast(
                  `${printResult.message} Shelf-label status was not changed because the tag printer did not confirm the job.`,
                  "info",
                );
                return;
              }
              const markRes = await fetch(
                `${baseUrl}/api/products/variants/bulk-mark-shelf-labeled`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...apiAuth(),
                  },
                  body: JSON.stringify({
                    variant_ids: [reprintPrompt.variantId],
                  }),
                },
              );
              if (!markRes.ok) {
                toast(
                  "Tags printed, but Riverside could not mark this variation as shelf-labeled.",
                  "error",
                );
                return;
              }
              toast(
                `${reprintPrompt.stockOnHand} updated price tag${reprintPrompt.stockOnHand === 1 ? "" : "s"} ${printResult.message}`,
                "success",
              );
              onVariantUpdated();
            } catch (error) {
              toast(error instanceof Error ? error.message : "Price tags could not be printed. Please try again.", "error");
            } finally {
              setReprintPrompt(null);
            }
          })();
        }}
      />

      <BatchCommandBar
        selectedCount={selectedIds.size}
        onClearSelection={() => setSelectedIds(new Set())}
        onBatchPrice={() => setShowBatchPriceModal(true)}
        onBatchWeb={handleBatchWeb}
        onBatchStock={() => {
          openStockCorrection([...selectedIds], `${selectedIds.size} selected SKUs`);
        }}
        onBatchTrackLow={handleBatchTrackLow}
        onBatchTags={handleBulkLabels}
        onBatchMaintenance={handleBatchMaintenance}
      />
    </div>
  );
};
