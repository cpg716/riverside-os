import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  LayoutGrid,
  List as ListIcon,
  Search,
  Printer,
  Package,
  SlidersHorizontal,
  ShieldAlert,
  DollarSign,
  X,
} from "lucide-react";
import { List as VirtualizedList, type RowComponentProps } from "react-window";
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
import { compareVariationText } from "../../lib/variantSort";

export interface HubVariant {
  id: string;
  sku: string;
  variation_values: Record<string, unknown>;
  variation_label: string | null;
  stock_on_hand: number;
  reorder_point: number;
  track_low_stock: boolean;
  retail_price_override: string | null;
  sale_price_override: string | null;
  cost_override: string | null;
  last_cost_override: string | null;
  effective_average_cost: string;
  effective_last_cost: string | null;
  barcode: string | null;
  vendor_upc: string | null;
  effective_retail: string;
  effective_sale: string | null;
  web_published: boolean;
  web_price_override: string | null;
  web_gallery_order: number;
}

interface VariationsWorkspaceProps {
  productId: string;
  productTrackLowStock: boolean;
  templateBaseRetail?: string;
  templateBaseSale?: string | null;
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
  identity_changed?: boolean;
  price_changed?: boolean;
  stock_on_hand?: number;
  sku?: string;
  variation_values?: Record<string, unknown>;
  variation_label?: string | null;
  effective_retail?: string;
  effective_sale?: string | null;
}

interface VariantReprintPrompt {
  variantId: string;
  sku: string;
  barcode: string | null;
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
  | { variation_values: Record<string, string> }
  | { variation_label: string }
  | { retail_price_override: string }
  | { clear_retail_override: boolean }
  | { sale_price_override: string }
  | { clear_sale_override: boolean }
  | { cost_override: string | null }
  | { web_published: boolean }
  | { track_low_stock: boolean }
  | { barcode: string }
  | { clear_barcode: boolean }
  | { vendor_upc: string }
  | { clear_vendor_upc: boolean };

interface VariantCardDraft {
  tagQuantity?: string;
  variationValues?: Record<string, string>;
  variationLabel?: string;
  barcode?: string;
  vendorUpc?: string;
  useParentRetail?: boolean;
  retailOverride?: string;
}

interface VariantCardDraftStore {
  read: (variantId: string) => VariantCardDraft | undefined;
  write: (variantId: string, patch: Partial<VariantCardDraft>) => void;
  clear: (variantId: string, keys: (keyof VariantCardDraft)[]) => void;
}

function strVal(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function fallbackRowLabel(variant: HubVariant): string {
  return variant.variation_label?.trim() || variant.sku;
}

const cardActionButtonClass =
  "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-center text-[10px] font-black uppercase leading-tight tracking-[0.08em] transition-colors";

const identifierInputClass =
  "min-w-0 rounded-lg border border-app-border bg-app-surface px-2 py-1.5 font-mono text-xs text-app-text outline-none focus:border-app-accent";

const MAX_TAG_PRINT_QUANTITY = 999;

function parseTagPrintQuantity(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number.parseInt(value, 10);
  return quantity >= 1 && quantity <= MAX_TAG_PRINT_QUANTITY ? quantity : null;
}

function VariantTagPrintControl({
  variantId,
  sku,
  onPrint,
  draftStore,
}: {
  variantId: string;
  sku: string;
  onPrint: (quantity: number) => void;
  draftStore: VariantCardDraftStore;
}) {
  const [quantityDraft, setQuantityDraft] = useState(
    () => draftStore.read(variantId)?.tagQuantity ?? "1",
  );
  const quantity = parseTagPrintQuantity(quantityDraft);

  const updateQuantityDraft = (value: string) => {
    setQuantityDraft(value);
    draftStore.write(variantId, { tagQuantity: value });
  };

  const print = () => {
    if (quantity != null) onPrint(quantity);
  };

  return (
    <div
      role="group"
      aria-label={`Print tags for ${sku}`}
      className="w-full min-w-0 space-y-1.5 sm:w-72"
    >
      <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
        Tag copies
      </label>
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-1.5">
        <input
          type="number"
          min={1}
          max={MAX_TAG_PRINT_QUANTITY}
          step={1}
          inputMode="numeric"
          aria-label={`Tag copies for ${sku}`}
          aria-invalid={quantity == null}
          value={quantityDraft}
          onChange={(event) => updateQuantityDraft(event.target.value)}
          onBlur={() => {
            if (quantity == null) updateQuantityDraft("1");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              print();
            }
          }}
          className="min-w-0 rounded-xl border border-app-border bg-app-surface px-1.5 py-2 text-center text-xs font-black tabular-nums text-app-text outline-none focus:border-app-accent"
          title={`Tag copies (1-${MAX_TAG_PRINT_QUANTITY})`}
        />
        <button
          type="button"
          onClick={print}
          disabled={quantity == null}
          className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent hover:text-app-accent disabled:cursor-not-allowed disabled:opacity-50`}
          title="Print inventory tags"
        >
          <Printer size={14} className="shrink-0" />
          Print {quantity ?? "-"} {quantity === 1 ? "tag" : "tags"}
        </button>
      </div>
      <p className="text-[9px] leading-tight text-app-text-muted">
        Leave at 1 for one tag. Change copies for a batch; press again for another job.
      </p>
    </div>
  );
}

function VariantIdentityEditor({
  variant,
  variationAxes,
  onSave,
  draftStore,
}: {
  variant: HubVariant;
  variationAxes: string[];
  onSave: (patch: VariantPatch) => Promise<VariantPricingPatchResponse | null>;
  draftStore: VariantCardDraftStore;
}) {
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>(() => {
    const savedDraft = draftStore.read(variant.id)?.variationValues;
    if (savedDraft) return savedDraft;
    return Object.fromEntries(
      variationAxes.map((axis) => [axis, strVal(variant.variation_values[axis]) ?? ""]),
    );
  });
  const [labelDraft, setLabelDraft] = useState(
    () => draftStore.read(variant.id)?.variationLabel ?? variant.variation_label ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const savedDraft = draftStore.read(variant.id);
    if (!savedDraft?.variationValues) {
      const nextDrafts: Record<string, string> = {};
      for (const axis of variationAxes) {
        nextDrafts[axis] = strVal(variant.variation_values[axis]) ?? "";
      }
      setValueDrafts(nextDrafts);
    }
    if (savedDraft?.variationLabel === undefined) {
      setLabelDraft(variant.variation_label ?? "");
    }
    setMessage(null);
  }, [draftStore, variant.id, variant.variation_label, variant.variation_values, variationAxes]);

  const hasAxes = variationAxes.length > 0;
  const valuesChanged = variationAxes.some(
    (axis) =>
      (valueDrafts[axis] ?? "").trim() !==
      (strVal(variant.variation_values[axis]) ?? "").trim(),
  );
  const labelChanged = labelDraft.trim() !== (variant.variation_label ?? "").trim();
  const canSave = hasAxes
    ? valuesChanged && variationAxes.every((axis) => (valueDrafts[axis] ?? "").trim())
    : labelChanged && Boolean(labelDraft.trim());

  const saveIdentity = async () => {
    if (!canSave) return;
    setSaving(true);
    setMessage(null);
    try {
      const payload = hasAxes
        ? {
            variation_values: Object.fromEntries(
              variationAxes.map((axis) => [axis, (valueDrafts[axis] ?? "").trim()]),
            ),
          }
        : { variation_label: labelDraft.trim() };
      const response = await onSave(payload);
      draftStore.clear(variant.id, ["variationValues", "variationLabel"]);
      setMessage(
        response?.identity_changed === false
          ? "Variation name is already set to those values."
          : "Variation name updated and added to Timeline.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Variation name update failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-app-border bg-app-surface-2/60 p-3">
      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        Variation name
      </p>
      <div className="grid gap-2">
        {hasAxes ? (
          variationAxes.map((axis) => (
            <label key={axis} className="grid gap-1">
              <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                {axis}
              </span>
              <input
                aria-label={`Variation ${axis}`}
                value={valueDrafts[axis] ?? ""}
                maxLength={120}
                disabled={saving}
                onChange={(event) => {
                  setValueDrafts((current) => {
                    const next = { ...current, [axis]: event.target.value };
                    draftStore.write(variant.id, { variationValues: next });
                    return next;
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveIdentity();
                }}
                className="ui-input h-9 min-w-0 text-sm font-bold"
              />
            </label>
          ))
        ) : (
          <input
            aria-label="Variation name"
            value={labelDraft}
            maxLength={240}
            disabled={saving}
            onChange={(event) => {
              setLabelDraft(event.target.value);
              draftStore.write(variant.id, { variationLabel: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveIdentity();
            }}
            className="ui-input h-9 min-w-0 text-sm font-bold"
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[9px] leading-relaxed text-app-text-muted">
          Updates catalog, matrix, search, POS selection, and future tags without changing SKU or financial history.
        </p>
        <button
          type="button"
          disabled={!canSave || saving}
          onClick={() => void saveIdentity()}
          className="shrink-0 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save name"}
        </button>
      </div>
      {message ? (
        <p className="text-[10px] font-semibold text-app-text-muted">{message}</p>
      ) : null}
    </div>
  );
}

function VariantIdentifierEditor({
  variant,
  onSave,
  draftStore,
}: {
  variant: HubVariant;
  onSave: (patch: VariantPatch) => Promise<VariantPricingPatchResponse | null>;
  draftStore: VariantCardDraftStore;
}) {
  const [barcodeDraft, setBarcodeDraft] = useState(
    () => draftStore.read(variant.id)?.barcode ?? variant.barcode ?? "",
  );
  const [vendorUpcDraft, setVendorUpcDraft] = useState(
    () => draftStore.read(variant.id)?.vendorUpc ?? variant.vendor_upc ?? "",
  );
  const [saving, setSaving] = useState<"barcode" | "vendor_upc" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const savedDraft = draftStore.read(variant.id);
    if (savedDraft?.barcode === undefined) setBarcodeDraft(variant.barcode ?? "");
    if (savedDraft?.vendorUpc === undefined) setVendorUpcDraft(variant.vendor_upc ?? "");
  }, [draftStore, variant.barcode, variant.id, variant.vendor_upc]);

  const saveIdentifier = async (field: "barcode" | "vendor_upc") => {
    setSaving(field);
    setMessage(null);
    try {
      if (field === "barcode") {
        const next = barcodeDraft.trim();
        await onSave(next ? { barcode: next } : { clear_barcode: true });
        draftStore.clear(variant.id, ["barcode"]);
        setMessage("Product UPC saved.");
      } else {
        const next = vendorUpcDraft.trim();
        await onSave(next ? { vendor_upc: next } : { clear_vendor_upc: true });
        draftStore.clear(variant.id, ["vendorUpc"]);
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
    <div className="space-y-2 rounded-xl border border-app-border bg-app-surface-2/60 p-3">
      <div className="grid gap-2">
        <div className="grid gap-1">
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Product UPC
          </span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              aria-label="Product UPC"
              value={barcodeDraft}
              onChange={(event) => {
                setBarcodeDraft(event.target.value);
                draftStore.write(variant.id, { barcode: event.target.value });
              }}
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
        </div>
        <div className="grid gap-1">
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Catalog # / vendor style #
          </span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              aria-label="Catalog number or vendor style number"
              value={vendorUpcDraft}
              onChange={(event) => {
                setVendorUpcDraft(event.target.value);
                draftStore.write(variant.id, { vendorUpc: event.target.value });
              }}
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
        </div>
      </div>
      {message ? (
        <p className="text-[10px] font-semibold text-app-text-muted">{message}</p>
      ) : null}
    </div>
  );
}

function VariantRetailInheritanceEditor({
  variant,
  parentRetail,
  onSave,
  draftStore,
}: {
  variant: HubVariant;
  parentRetail: string;
  onSave: (patch: VariantPatch) => Promise<VariantPricingPatchResponse | null>;
  draftStore: VariantCardDraftStore;
}) {
  const inheritsParent = variant.retail_price_override == null;
  const [useParent, setUseParent] = useState(
    () => draftStore.read(variant.id)?.useParentRetail ?? inheritsParent,
  );
  const [overrideDraft, setOverrideDraft] = useState(
    () =>
      draftStore.read(variant.id)?.retailOverride ??
      variant.retail_price_override ??
      variant.effective_retail,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const savedDraft = draftStore.read(variant.id);
    if (savedDraft?.useParentRetail === undefined) setUseParent(inheritsParent);
    if (savedDraft?.retailOverride === undefined) {
      setOverrideDraft(variant.retail_price_override ?? variant.effective_retail);
    }
    setMessage(null);
  }, [draftStore, inheritsParent, variant.effective_retail, variant.id, variant.retail_price_override]);

  const saveOverride = async () => {
    const trimmed = overrideDraft.trim();
    if (!/^(?:\d+|\d*\.\d{1,2})$/.test(trimmed)) {
      setMessage("Enter a non-negative retail price with no more than two decimals.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await onSave({
        retail_price_override: centsToFixed2(parseMoneyToCents(trimmed)),
      });
      draftStore.clear(variant.id, ["retailOverride", "useParentRetail"]);
      setMessage("SKU retail override saved and added to Timeline.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retail override update failed.");
    } finally {
      setSaving(false);
    }
  };

  const selectUseParent = async (checked: boolean) => {
    setUseParent(checked);
    draftStore.write(variant.id, { useParentRetail: checked });
    setMessage(null);
    if (!checked || inheritsParent) return;
    setSaving(true);
    try {
      await onSave({ clear_retail_override: true });
      draftStore.clear(variant.id, ["retailOverride", "useParentRetail"]);
      setMessage("SKU now inherits the parent retail price.");
    } catch (error) {
      setUseParent(false);
      draftStore.write(variant.id, { useParentRetail: false });
      setMessage(error instanceof Error ? error.message : "Could not restore parent pricing.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-app-border bg-app-surface-2/60 p-3">
      <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text">
        <input
          type="checkbox"
          checked={useParent}
          disabled={saving}
          onChange={(event) => void selectUseParent(event.target.checked)}
          className="h-4 w-4 accent-app-accent"
        />
        Use parent retail price ({`$${centsToFixed2(parseMoneyToCents(parentRetail))}`})
      </label>
      {!useParent ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <label className="relative min-w-0">
            <span className="sr-only">Retail override for {variant.sku}</span>
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted">
              $
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={overrideDraft}
              disabled={saving}
              onChange={(event) => {
                setOverrideDraft(event.target.value);
                draftStore.write(variant.id, { retailOverride: event.target.value });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveOverride();
              }}
              className="ui-input h-9 w-full pl-7 text-sm font-bold tabular-nums"
            />
          </label>
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveOverride()}
            className="rounded-lg border border-app-border bg-app-surface px-3 text-[10px] font-black uppercase tracking-widest text-app-text disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save override"}
          </button>
        </div>
      ) : null}
      {message ? (
        <p className="text-[10px] font-semibold text-app-text-muted">{message}</p>
      ) : null}
    </div>
  );
}

function VariantPricingEditor({
  variant,
  itemSalePrice,
  onSave,
}: {
  variant: HubVariant;
  itemSalePrice: string | null;
  onSave: (patch: VariantPatch) => Promise<VariantPricingPatchResponse | null>;
}) {
  const [saleDraft, setSaleDraft] = useState(
    variant.sale_price_override ?? variant.effective_sale ?? "",
  );
  const [averageCostDraft, setAverageCostDraft] = useState(
    variant.cost_override ?? variant.effective_average_cost,
  );
  const [saving, setSaving] = useState<"sale" | "cost" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const saleChanged =
    saleDraft.trim() !==
    (variant.sale_price_override ?? variant.effective_sale ?? "").trim();
  const averageCostChanged =
    averageCostDraft.trim() !==
    (variant.cost_override ?? variant.effective_average_cost).trim();

  useEffect(() => {
    setSaleDraft(variant.sale_price_override ?? variant.effective_sale ?? "");
    setAverageCostDraft(variant.cost_override ?? variant.effective_average_cost);
    setMessage(null);
  }, [
    variant.cost_override,
    variant.effective_average_cost,
    variant.effective_sale,
    variant.id,
    variant.sale_price_override,
  ]);

  const normalizedMoney = (value: string, label: string): string | null => {
    const trimmed = value.trim();
    if (!/^(?:\d+|\d*\.\d{1,2})$/.test(trimmed)) {
      setMessage(`Enter a valid ${label} with no more than two decimals.`);
      return null;
    }
    return centsToFixed2(parseMoneyToCents(trimmed));
  };

  const saveSale = async () => {
    const amount = normalizedMoney(saleDraft, "sale price");
    if (amount == null) return;
    setSaving("sale");
    setMessage(null);
    try {
      await onSave({ sale_price_override: amount });
      setMessage("SKU sale price saved and added to Timeline.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sale price update failed.");
    } finally {
      setSaving(null);
    }
  };

  const saveAverageCost = async () => {
    const amount = normalizedMoney(averageCostDraft, "average cost");
    if (amount == null) return;
    setSaving("cost");
    setMessage(null);
    try {
      await onSave({ cost_override: amount });
      setMessage("SKU average-cost override saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Average cost update failed.");
    } finally {
      setSaving(null);
    }
  };

  const restoreInherited = async (field: "sale" | "cost") => {
    setSaving(field);
    setMessage(null);
    try {
      await onSave(
        field === "sale" ? { clear_sale_override: true } : { cost_override: null },
      );
      setMessage(
        field === "sale"
          ? itemSalePrice
            ? "SKU now uses the item sale price."
            : "SKU sale-price override removed; no item sale price is set."
          : "SKU now uses the item average cost.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Pricing update failed.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-app-border bg-app-surface-2/60 p-3">
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Sale price
        </p>
        <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
          {variant.sale_price_override != null
            ? "This SKU has its own sale price."
            : itemSalePrice
              ? `Uses item sale price $${centsToFixed2(parseMoneyToCents(itemSalePrice))}.`
              : "No sale price is set for the item."}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="relative min-w-32 flex-1">
            <span className="sr-only">Sale price override for {variant.sku}</span>
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted">
              $
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={saleDraft}
              disabled={saving != null}
              onChange={(event) => setSaleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveSale();
              }}
              className="ui-input h-9 w-full pl-7 text-sm font-bold tabular-nums"
              placeholder="No SKU sale price"
            />
          </label>
          <button
            type="button"
            disabled={saving != null || !saleChanged}
            onClick={() => void saveSale()}
            className="ui-btn-secondary h-9 px-3 text-[10px] font-black uppercase tracking-widest"
          >
            Save sale
          </button>
          {variant.sale_price_override != null ? (
            <button
              type="button"
              disabled={saving != null}
              onClick={() => void restoreInherited("sale")}
              className="text-[10px] font-black uppercase tracking-widest text-app-accent disabled:opacity-50"
            >
              {itemSalePrice ? "Use item sale price" : "Remove SKU sale price"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="border-t border-app-border/60 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Average cost
            </p>
            <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
              Financial cost basis. Last cost is purchasing reference only
              {variant.effective_last_cost
                ? ` ($${centsToFixed2(parseMoneyToCents(variant.effective_last_cost))})`
                : ""}.
            </p>
          </div>
          {variant.cost_override != null ? (
            <span className="ui-pill border-amber-300 bg-amber-50 text-[9px] font-black uppercase text-amber-700">
              SKU override
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="relative min-w-32 flex-1">
            <span className="sr-only">Average cost override for {variant.sku}</span>
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted">
              $
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={averageCostDraft}
              disabled={saving != null}
              onChange={(event) => setAverageCostDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveAverageCost();
              }}
              className="ui-input h-9 w-full pl-7 text-sm font-bold tabular-nums"
            />
          </label>
          <button
            type="button"
            disabled={saving != null || !averageCostChanged}
            onClick={() => void saveAverageCost()}
            className="ui-btn-secondary h-9 px-3 text-[10px] font-black uppercase tracking-widest"
          >
            Save cost
          </button>
          {variant.cost_override != null ? (
            <button
              type="button"
              disabled={saving != null}
              onClick={() => void restoreInherited("cost")}
              className="text-[10px] font-black uppercase tracking-widest text-app-accent disabled:opacity-50"
            >
              Use item average cost
            </button>
          ) : null}
        </div>
      </div>
      {message ? (
        <p className="text-[10px] font-semibold text-app-text-muted">{message}</p>
      ) : null}
    </div>
  );
}

type PatchVariantHandler = (
  variantId: string,
  patch: VariantPatch,
) => Promise<VariantPricingPatchResponse | null>;

interface SelectedVariationEditorProps {
  variant: HubVariant;
  productTrackLowStock: boolean;
  templateBaseRetail: string;
  templateBaseSale: string | null;
  variationAxes: string[];
  draftStore: VariantCardDraftStore;
  onPatchVariant: PatchVariantHandler;
  onStockCorrection: (variant: HubVariant) => void;
  onPrintTags: (variant: HubVariant, quantity: number) => void;
  onMaintenance: (
    variant: HubVariant,
    type: "damaged" | "return_to_vendor",
  ) => void;
  onClose: () => void;
}

function SelectedVariationEditor({
  variant,
  productTrackLowStock,
  templateBaseRetail,
  templateBaseSale,
  variationAxes,
  draftStore,
  onPatchVariant,
  onStockCorrection,
  onPrintTags,
  onMaintenance,
  onClose,
}: SelectedVariationEditorProps) {
  return (
    <section
      className="rounded-2xl border border-app-accent/30 bg-app-surface p-4 shadow-sm ring-1 ring-app-accent/10"
      aria-labelledby={`variation-editor-${variant.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-accent">
            Edit selected variation
          </p>
          <h3
            id={`variation-editor-${variant.id}`}
            className="mt-1 text-lg font-black tracking-tight text-app-text"
          >
            {variant.variation_label || "Standard"}
          </h3>
          <p className="mt-1 font-mono text-xs font-bold text-app-text-muted">
            {variant.sku}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-xl px-3 py-1.5 text-sm font-black tabular-nums ${
              variant.stock_on_hand <= 0
                ? "bg-red-50 text-red-700"
                : variant.stock_on_hand <= variant.reorder_point
                  ? "bg-amber-50 text-amber-700"
                  : "bg-emerald-50 text-emerald-700"
            }`}
          >
            {variant.stock_on_hand} on hand
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target inline-flex items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-app-text-muted hover:text-app-text"
            aria-label="Close variation editor"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-3">
        <VariantIdentityEditor
          variant={variant}
          variationAxes={variationAxes}
          onSave={(patch) => onPatchVariant(variant.id, patch)}
          draftStore={draftStore}
        />
        <VariantIdentifierEditor
          variant={variant}
          onSave={(patch) => onPatchVariant(variant.id, patch)}
          draftStore={draftStore}
        />
        <div className="space-y-3">
          <VariantRetailInheritanceEditor
            variant={variant}
            parentRetail={templateBaseRetail}
            onSave={(patch) => onPatchVariant(variant.id, patch)}
            draftStore={draftStore}
          />
          <VariantPricingEditor
            variant={variant}
            itemSalePrice={templateBaseSale}
            onSave={(patch) => onPatchVariant(variant.id, patch)}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-app-border bg-app-surface-2/60 p-3">
        <button
          type="button"
          onClick={() => onStockCorrection(variant)}
          className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text hover:border-emerald-300 hover:text-emerald-700`}
        >
          Correct count
        </button>
        <button
          type="button"
          aria-pressed={variant.web_published}
          onClick={() =>
            void onPatchVariant(variant.id, {
              web_published: !variant.web_published,
            })
          }
          className={`${cardActionButtonClass} ${
            variant.web_published
              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
              : "border-app-border bg-app-surface-2 text-app-text"
          }`}
        >
          {variant.web_published ? "Published online" : "Not published online"}
        </button>
        {productTrackLowStock ? (
          <label className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[10px] font-black uppercase tracking-widest text-app-text">
            <input
              type="checkbox"
              checked={variant.track_low_stock}
              onChange={(event) =>
                void onPatchVariant(variant.id, {
                  track_low_stock: event.target.checked,
                })
              }
              className="h-4 w-4 accent-app-accent"
            />
            Low-stock alert
          </label>
        ) : null}
        <VariantTagPrintControl
          variantId={variant.id}
          sku={variant.sku}
          onPrint={(quantity) => onPrintTags(variant, quantity)}
          draftStore={draftStore}
        />
        <button
          type="button"
          onClick={() => onMaintenance(variant, "damaged")}
          className={`${cardActionButtonClass} border-red-200 bg-red-50 text-red-700`}
        >
          Record damage
        </button>
        <button
          type="button"
          onClick={() => onMaintenance(variant, "return_to_vendor")}
          className={`${cardActionButtonClass} border-app-border bg-app-surface-2 text-app-text hover:border-app-accent hover:text-app-accent`}
        >
          Return to Vendor
        </button>
      </div>
    </section>
  );
}

interface CompactCardRowProps {
  variants: HubVariant[];
  columnCount: number;
  activeVariantId: string | null;
  selectedIds: Set<string>;
  onEdit: (variantId: string) => void;
  onToggleSelect: (variantId: string) => void;
}

const CompactVariantCard = React.memo(function CompactVariantCard({
  variant,
  active,
  selected,
  onEdit,
  onToggleSelect,
}: {
  variant: HubVariant;
  active: boolean;
  selected: boolean;
  onEdit: () => void;
  onToggleSelect: () => void;
}) {
  const stockClass =
    variant.stock_on_hand <= 0
      ? "bg-red-50 text-red-700"
      : variant.stock_on_hand <= variant.reorder_point
        ? "bg-amber-50 text-amber-700"
        : "bg-emerald-50 text-emerald-700";

  return (
    <section
      className={`h-full rounded-2xl border bg-app-surface p-3 shadow-sm transition-colors ${
        active
          ? "border-app-accent ring-2 ring-app-accent/15"
          : "border-app-border hover:border-app-accent/50"
      }`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="mt-1 h-4 w-4 shrink-0 accent-app-accent"
          aria-label={`Select ${variant.sku} for bulk actions`}
        />
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
          aria-label={`Edit variation ${variant.variation_label || variant.sku}`}
        >
          <span className="block truncate font-mono text-[11px] font-black text-app-text-muted">
            {variant.sku}
          </span>
          <span className="mt-0.5 block truncate text-sm font-black text-app-text">
            {variant.variation_label || "Standard"}
          </span>
        </button>
        <span className={`shrink-0 rounded-lg px-2 py-1 text-xs font-black tabular-nums ${stockClass}`}>
          {variant.stock_on_hand} on hand
        </span>
      </div>

      <button
        type="button"
        onClick={onEdit}
        className="mt-3 grid w-full grid-cols-2 gap-x-3 gap-y-2 border-t border-app-border/60 pt-3 text-left"
        aria-label={`Open editor for ${variant.variation_label || variant.sku}`}
      >
        <span className="min-w-0">
          <span className="block text-[8px] font-black uppercase tracking-widest text-app-text-muted">
            Product UPC
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10px] font-bold text-app-text">
            {variant.barcode || "Not recorded"}
          </span>
        </span>
        <span>
          <span className="block text-[8px] font-black uppercase tracking-widest text-app-text-muted">
            Retail / sale
          </span>
          <span className="mt-0.5 block text-[10px] font-bold tabular-nums text-app-text">
            ${centsToFixed2(parseMoneyToCents(variant.effective_retail))}
            {variant.effective_sale
              ? ` / $${centsToFixed2(parseMoneyToCents(variant.effective_sale))}`
              : " / No sale"}
          </span>
        </span>
        <span>
          <span className="block text-[8px] font-black uppercase tracking-widest text-app-text-muted">
            Average cost
          </span>
          <span className="mt-0.5 block text-[10px] font-bold tabular-nums text-app-text">
            ${centsToFixed2(parseMoneyToCents(variant.effective_average_cost))}
            {variant.cost_override != null ? " override" : " inherited"}
          </span>
        </span>
        <span className="flex items-end justify-between gap-2">
          <span>
            <span className="block text-[8px] font-black uppercase tracking-widest text-app-text-muted">
              Web
            </span>
            <span className="mt-0.5 block text-[10px] font-bold text-app-text">
              {variant.web_published ? "Published" : "Not published"}
            </span>
          </span>
          <span className="text-[9px] font-black uppercase tracking-widest text-app-accent">
            {active ? "Editing" : "Edit"}
          </span>
        </span>
      </button>
    </section>
  );
});

function CompactCardRow({
  index,
  style,
  ariaAttributes,
  variants,
  columnCount,
  activeVariantId,
  selectedIds,
  onEdit,
  onToggleSelect,
}: RowComponentProps<CompactCardRowProps>) {
  const rowVariants = variants.slice(index * columnCount, (index + 1) * columnCount);

  return (
    <div {...ariaAttributes} style={{ ...style, paddingBottom: 10 }}>
      <div
        className="grid h-full gap-2.5"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {rowVariants.map((variant) => (
          <CompactVariantCard
            key={variant.id}
            variant={variant}
            active={variant.id === activeVariantId}
            selected={selectedIds.has(variant.id)}
            onEdit={() => onEdit(variant.id)}
            onToggleSelect={() => onToggleSelect(variant.id)}
          />
        ))}
      </div>
    </div>
  );
}

export const VariationsWorkspace: React.FC<VariationsWorkspaceProps> = ({
  productId,
  productTrackLowStock,
  templateBaseRetail = "0",
  templateBaseSale = null,
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
  const deferredSearch = useDeferredValue(localSearch);
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [cardColumnCount, setCardColumnCount] = useState(1);
  const cardDraftsRef = useRef(new Map<string, VariantCardDraft>());
  const cardDraftStore = useMemo<VariantCardDraftStore>(
    () => ({
      read: (variantId) => cardDraftsRef.current.get(variantId),
      write: (variantId, patch) => {
        const current = cardDraftsRef.current.get(variantId) ?? {};
        cardDraftsRef.current.set(variantId, { ...current, ...patch });
      },
      clear: (variantId, keys) => {
        const current = cardDraftsRef.current.get(variantId);
        if (!current) return;
        const next = { ...current };
        for (const key of keys) delete next[key];
        if (Object.keys(next).length === 0) cardDraftsRef.current.delete(variantId);
        else cardDraftsRef.current.set(variantId, next);
      },
    }),
    [],
  );
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
    const needle = deferredSearch.trim().toLowerCase();
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
  }, [deferredSearch, variants]);

  const activeVariant = useMemo(
    () => variants.find((variant) => variant.id === activeVariantId) ?? null,
    [activeVariantId, variants],
  );

  const handleCardGridResize = useCallback(({ width }: { width: number }) => {
    const nextColumnCount = width >= 1180 ? 3 : width >= 700 ? 2 : 1;
    setCardColumnCount((current) =>
      current === nextColumnCount ? current : nextColumnCount,
    );
  }, []);

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
    const arr = [...set].sort(compareVariationText);
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
    const arr = [...set].sort(compareVariationText);
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
      options: { refreshParent?: boolean; promptReprint?: boolean } = {},
    ): Promise<VariantPricingPatchResponse | null> => {
      const { refreshParent = true, promptReprint = true } = options;
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
      if (
        promptReprint &&
        !isStock &&
        payload?.price_changed &&
        (payload.stock_on_hand ?? 0) > 0
      ) {
        const currentVariant = variants.find((variant) => variant.id === variantId);
        const effectiveRetail =
          payload.effective_retail ??
          currentVariant?.effective_retail ??
          "0";
        setReprintPrompt({
          variantId,
          sku: payload.sku ?? currentVariant?.sku ?? "Unknown SKU",
          barcode: currentVariant?.barcode ?? null,
          variationLabel:
            payload.variation_label ??
            currentVariant?.variation_label ??
            "Standard",
          effectiveRetail,
          stockOnHand: payload.stock_on_hand ?? 0,
        });
      }
      if (refreshParent) onVariantUpdated();
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
          patchVariant(id, { web_published: status }, { refreshParent: false }),
        ),
      );
      toast(`Successfully updated ${selectedIds.size} variants`, "success");
      setSelectedIds(new Set());
    } catch {
      toast("Some updates failed", "error");
    } finally {
      onVariantUpdated();
    }
  };

  const handleBatchTrackLow = async (status: boolean) => {
    try {
      await Promise.all(
        [...selectedIds].map((id) =>
          patchVariant(id, { track_low_stock: status }, { refreshParent: false }),
        ),
      );
      toast(`Tracking updated for ${selectedIds.size} variants`, "success");
      setSelectedIds(new Set());
    } catch {
      toast("Update failed", "error");
    } finally {
      onVariantUpdated();
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
    async (
      variantsToPrint: HubVariant[],
      successLabel: string,
      copiesPerVariant = 1,
    ) => {
      if (variantsToPrint.length === 0) {
        toast("No variations are ready to print.", "info");
        return;
      }

      const tagItems = variantsToPrint.flatMap((variant) =>
        Array.from({ length: copiesPerVariant }, () => ({
          sku: variant.sku,
          barcode: variant.barcode,
          productName,
          variation: variant.variation_label ?? "Standard",
          price: `$${centsToFixed2(parseMoneyToCents(variant.effective_retail))}`,
        })),
      );

      let printResult: InventoryTagPrintResult;
      try {
        printResult = await openInventoryTagsWindow(
          tagItems,
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
              variant_ids: Array.from(new Set(variantsToPrint.map((variant) => variant.id))),
            }),
          },
        );
        if (!res.ok) throw new Error("Tag print status update failed");
        toast(`${successLabel} ${printResult.message}`, "success");
      } catch {
        toast("Tags opened for printing, but Riverside could not mark them as printed.", "error");
      }
    },
    [apiAuth, baseUrl, productName, toast],
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

  const handleSelectedStockCorrection = useCallback(
    (variant: HubVariant) => openStockCorrection([variant.id], variant.sku, "1"),
    [openStockCorrection],
  );
  const handleSelectedPrintTags = useCallback(
    (variant: HubVariant, quantity: number) => {
      void handlePrintTags(
        [variant],
        `${quantity} inventory tag${quantity === 1 ? "" : "s"} sent to print.`,
        quantity,
      );
    },
    [handlePrintTags],
  );
  const handleSelectedMaintenance = useCallback(
    (variant: HubVariant, type: "damaged" | "return_to_vendor") => {
      setMaintenanceTarget({ variantId: variant.id, sku: variant.sku, type });
    },
    [],
  );
  const toggleVariantSelection = useCallback((variantId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  }, []);
  const compactCardRowProps = useMemo<CompactCardRowProps>(
    () => ({
      variants: displayVariants,
      columnCount: cardColumnCount,
      activeVariantId,
      selectedIds,
      onEdit: setActiveVariantId,
      onToggleSelect: toggleVariantSelection,
    }),
    [
      activeVariantId,
      cardColumnCount,
      displayVariants,
      selectedIds,
      toggleVariantSelection,
    ],
  );
  const compactCardRowCount = Math.ceil(displayVariants.length / cardColumnCount);

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
            <div className="flex rounded-xl border border-app-border bg-app-surface p-1 shadow-sm">
              <button
                type="button"
                aria-pressed={viewMode === "cards"}
                onClick={() => setViewMode("cards")}
                className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[10px] font-black uppercase tracking-widest transition-all ${viewMode === "cards" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
              >
                <Package size={15} aria-hidden />
                Cards
              </button>
              <button
                type="button"
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
                className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[10px] font-black uppercase tracking-widest transition-all ${viewMode === "list" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
              >
                <ListIcon size={15} aria-hidden />
                List
              </button>
              <button
                type="button"
                aria-pressed={viewMode === "matrix"}
                onClick={() => setViewMode("matrix")}
                className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[10px] font-black uppercase tracking-widest transition-all ${viewMode === "matrix" ? "bg-app-accent text-white shadow-lg shadow-app-accent/30" : "text-app-text-muted hover:bg-app-surface-2"}`}
              >
                <LayoutGrid size={15} aria-hidden />
                Matrix
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
            <span>
              {selectedIds.size > 0
                ? `Print ${selectedIds.size} selected`
                : "Print all tags"}
            </span>
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-xs font-semibold leading-relaxed text-amber-850">
        In Cards, select <span className="font-black">Edit</span> to change one
        variation&apos;s name, identifiers, prices, web status, tags, or stock status.
        Use the checkboxes for bulk actions. Receive vendor shipments in{" "}
        <span className="font-black">Receive Stock</span>, not as count corrections.
      </div>

      {/* Main View Area */}
      {viewMode === "cards" ? (
        <div className="space-y-3">
          {activeVariant ? (
            <SelectedVariationEditor
              variant={activeVariant}
              productTrackLowStock={productTrackLowStock}
              templateBaseRetail={templateBaseRetail}
              templateBaseSale={templateBaseSale}
              variationAxes={variationAxes}
              draftStore={cardDraftStore}
              onPatchVariant={patchVariant}
              onStockCorrection={handleSelectedStockCorrection}
              onPrintTags={handleSelectedPrintTags}
              onMaintenance={handleSelectedMaintenance}
              onClose={() => setActiveVariantId(null)}
            />
          ) : null}
          {displayVariants.length > 0 ? (
            <VirtualizedList
              rowComponent={CompactCardRow}
              rowCount={compactCardRowCount}
              rowHeight={190}
              rowProps={compactCardRowProps}
              overscanCount={2}
              onResize={handleCardGridResize}
              className="rounded-2xl"
              style={{ height: "min(68vh, 760px)", width: "100%" }}
              aria-label="Variation cards"
            />
          ) : (
            <div className="rounded-2xl border border-app-border bg-app-surface p-8 text-center text-sm font-semibold text-app-text-muted">
              No variations match this filter.
            </div>
          )}
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
                          hasSaleOverride={!!v.sale_price_override}
                          onUpdateStock={(delta) =>
                            Promise.resolve(
                              openStockCorrection([v.id], v.sku, String(delta)),
                            )
                          }
                          onUpdatePrice={(cents) =>
                            patchVariant(
                              v.id,
                              cents == null
                                ? { clear_retail_override: true }
                                : { retail_price_override: centsToFixed2(cents) },
                            )
                          }
                          onUpdateSale={(cents) =>
                            patchVariant(
                              v.id,
                              cents == null
                                ? { clear_sale_override: true }
                                : { sale_price_override: centsToFixed2(cents) },
                            )
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
          onToggleSelect={toggleVariantSelection}
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
                        }, { refreshParent: false }),
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
                    onVariantUpdated();
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
                      }, { refreshParent: false, promptReprint: false });
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
                          barcode: v?.barcode ?? null,
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
                    onVariantUpdated();
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
                barcode: item.barcode,
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
                  barcode: reprintPrompt.barcode,
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
