import React, { useState, useMemo, useCallback } from "react";
import {
  LayoutGrid,
  List,
  Search,
  Printer,
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

function strVal(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
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

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
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
  const [batchStockSubmitting, setBatchStockSubmitting] = useState(false);

  // Maintenance State
  const [maintenanceTarget, setMaintenanceTarget] = useState<{
    variantId: string;
    sku: string;
    type: "damaged" | "return_to_vendor";
  } | null>(null);
  const [mtQty, setMtQty] = useState("1");
  const [mtNote, setMtNote] = useState("");
  const [submittingMt, setSubmittingMt] = useState(false);

  // Matrix Logic (Refined Axes Detection)
  const detectedAxes = useMemo(() => {
    const keys = new Set<string>();
    for (const v of variants) {
      Object.keys(v.variation_values).forEach((k) => keys.add(k));
    }
    return [...keys];
  }, [variants]);

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

  const rowKeys = useMemo(() => {
    const set = new Set<string>();
    for (const v of variants) {
      const r = strVal(v.variation_values[rowAxis]);
      if (r) set.add(r);
    }
    const arr = [...set].sort(naturalSort);
    // If no row keys detected but we have variants, it means they might have a different key structure
    return arr.length > 0 ? arr : ["Standard"];
  }, [variants, rowAxis]);

  const colKeys = useMemo(() => {
    const set = new Set<string>();
    for (const v of variants) {
      const c = strVal(v.variation_values[actualColAxis]);
      if (c) set.add(c);
    }
    const arr = [...set].sort(naturalSort);
    return arr.length > 0 ? arr : ["Default"];
  }, [variants, actualColAxis]);

  const cellMap = useMemo(() => {
    const m = new Map<string, HubVariant>();
    for (const v of variants) {
      const r = strVal(v.variation_values[rowAxis]) || "Standard";
      const c = strVal(v.variation_values[actualColAxis]) || "Default";
      m.set(`${r}\0${c}`, v);
    }
    return m;
  }, [variants, rowAxis, actualColAxis]);

  // API Call Handlers
  const patchVariant = useCallback(
    async (
      variantId: string,
      patch:
        | {
            quantity_delta: number;
            tx_type?: "damaged" | "return_to_vendor";
            notes?: string;
          }
        | { retail_price_override: string | null }
        | { web_published: boolean }
        | { track_low_stock: boolean },
    ) => {
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
      if (!res.ok) throw new Error("Update failed");
      onVariantUpdated();
    },
    [baseUrl, apiAuth, onVariantUpdated],
  );

  const adjustStock = useCallback(
    async (variantId: string, delta: number) => {
      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/stock-adjust`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ quantity_delta: delta }),
        },
      );
      if (!res.ok) throw new Error("Stock update failed");
      onVariantUpdated();
    },
    [baseUrl, apiAuth, onVariantUpdated],
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

    setSubmittingMt(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/products/variants/${maintenanceTarget.variantId}/stock-adjust`,
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
      toast(
        `Successfully moved ${qty} to ${maintenanceTarget.type === "damaged" ? "Damaged" : "RTV"}`,
        "success",
      );
      setMaintenanceTarget(null);
      setMtQty("1");
      setMtNote("");
      onVariantUpdated();
    } catch {
      toast("Maintenance operation failed", "error");
    } finally {
      setSubmittingMt(false);
    }
  };

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
              className={`flex rounded-xl bg-app-surface shadow-sm border border-app-border p-1 ${viewMode === "grid" ? "ring-1 ring-app-accent/20" : ""}`}
            >
              <button
                onClick={() => setViewMode("grid")}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all ${viewMode === "grid" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                onClick={() => setViewMode("list")}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all ${viewMode === "list" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
              >
                <List size={16} />
              </button>
            </div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
              {variants.length} SKU{variants.length !== 1 ? "s" : ""} ·{" "}
              {categoryName || "Uncategorized"}
            </p>
            {productTrackLowStock && (
              <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 text-[8px] font-black uppercase tracking-widest border border-amber-500/20">
                Auto-Tracking
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
          <button className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2 transition-colors">
            <Printer size={14} />
            <span>Bulk Labels</span>
          </button>
        </div>
      </div>

      {/* Main View Area */}
      {viewMode === "grid" ? (
        <div className="relative overflow-auto rounded-[24px] border border-app-border bg-app-surface/40 shadow-sm backdrop-blur-xl max-h-[70vh]">
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr className="sticky top-0 z-30">
                <th className="sticky left-0 z-40 border-b border-r border-app-border bg-app-surface-2/95 backdrop-blur-md p-4 text-left">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    <SlidersHorizontal size={14} />
                    <span>
                      {rowAxis} \ {actualColAxis}
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
                          onUpdateStock={(delta) => adjustStock(v.id, delta)}
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
          variants={variants}
          selectedIds={selectedIds}
          onToggleSelect={(id) =>
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSelectAll={() => setSelectedIds(new Set(variants.map((v) => v.id)))}
          onDeselectAll={() => setSelectedIds(new Set())}
          onUpdateVariant={
            patchVariant as VariationsListProps["onUpdateVariant"]
          }
          onShowMaintenance={(id, sku, type) =>
            setMaintenanceTarget({ variantId: id, sku, type })
          }
        />
      )}

      {/* Maintenance Modal */}
      {maintenanceTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="w-full max-w-md rounded-[32px] border border-app-border bg-app-surface p-8 shadow-2xl animate-in zoom-in-95 duration-300">
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
        </div>
      )}

      {/* Batch Pricing Modal */}
      {batchStockOpen && (
        <ConfirmationModal
          isOpen={batchStockOpen}
          title="Batch stock adjustment"
          message={`Enter a signed integer (for example: +5 or -2) to apply to all selected variants.\nCurrent value: ${batchStockInput || "(empty)"}`}
          confirmLabel={batchStockSubmitting ? "Applying..." : "Apply"}
          onConfirm={async () => {
            const delta = parseInt(batchStockInput, 10);
            if (isNaN(delta) || delta === 0) {
              toast("Enter a non-zero integer", "error");
              return;
            }
            setBatchStockSubmitting(true);
            try {
              toast(
                `Applying stock delta ${delta} to ${selectedIds.size} variants...`,
                "info",
              );
              await Promise.all(
                [...selectedIds].map((id) =>
                  patchVariant(id, { quantity_delta: delta }),
                ),
              );
              toast("Batch stock adjustment complete", "success");
              setSelectedIds(new Set());
              setBatchStockOpen(false);
              setBatchStockInput("");
            } catch {
              toast("Batch stock update failed", "error");
            } finally {
              setBatchStockSubmitting(false);
            }
          }}
          onClose={() => {
            if (batchStockSubmitting) return;
            setBatchStockOpen(false);
          }}
        />
      )}

      {showBatchPriceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="w-full max-w-sm rounded-[32px] border border-app-border bg-app-surface p-8 shadow-2xl animate-in zoom-in-95 duration-300">
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
                        if (!v) return;
                        const current = parseMoneyToCents(v.effective_retail);
                        finalPriceCents = current + cents;
                      }
                      return patchVariant(id, {
                        retail_price_override: centsToFixed2(finalPriceCents),
                      });
                    });

                    await Promise.all(updates);
                    toast(
                      `Batch price ${batchPriceMode === "fixed" ? "updated" : "adjusted"} successfully`,
                      "success",
                    );
                    setShowBatchPriceModal(false);
                    setBatchPriceInput("");
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
        </div>
      )}

      {/* Batch Command Bar */}
      <BatchCommandBar
        selectedCount={selectedIds.size}
        onClearSelection={() => setSelectedIds(new Set())}
        onBatchPrice={() => setShowBatchPriceModal(true)}
        onBatchWeb={handleBatchWeb}
        onBatchStock={() => {
          setBatchStockOpen(true);
          setBatchStockInput("");
        }}
        onBatchTrackLow={handleBatchTrackLow}
      />
    </div>
  );
};
