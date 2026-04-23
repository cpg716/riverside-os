import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, ChevronsUpDown, X, ShoppingBag } from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { VariationsWorkspace, type HubVariant } from "./VariationsWorkspace";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import {
  formatMoney,
  formatUsdFromCents,
  parseMoney,
  parseMoneyToCents,
} from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  rosieProductCatalogAnalyze,
  rosieProductCatalogSuggest,
  type RosieProductCatalogAnalysisResponse,
  type RosieProductCatalogSuggestionResponse,
} from "../../lib/rosie";

type HubTab = "general" | "variations" | "history";

interface ProductHubProduct {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  base_retail_price: string;
  base_cost: string;
  variation_axes: string[];
  category_id: string | null;
  category_name: string | null;
  is_clothing_footwear: boolean | null;
  matrix_row_axis_key: string | null;
  matrix_col_axis_key: string | null;
  primary_vendor_id: string | null;
  primary_vendor_name: string | null;
  track_low_stock: boolean;
  /** Null = use store default markup %. */
  employee_markup_percent: string | number | null;
  employee_extra_amount: string | number;
  nuorder_product_id: string | null;
}

interface VendorOption {
  id: string;
  name: string;
}

interface ProductHubStats {
  total_units_on_hand: number;
  total_reserved_units: number;
  total_available_units: number;
  value_on_hand: string;
  units_sold_all_time: number;
  open_order_units: number;
  last_physical_count_at?: string | null;
}

interface HubApiVariant {
  id: string;
  sku: string;
  variation_values: Record<string, unknown>;
  variation_label: string | null;
  stock_on_hand: number;
  reserved_stock: number;
  available_stock: number;
  qty_on_order?: number | null;
  last_physical_count_at?: string | null;
  reorder_point: number;
  track_low_stock: boolean;
  retail_price_override: string | null;
  cost_override: string | null;
  effective_retail: string;
  web_published?: boolean;
  web_price_override?: string | null;
  web_gallery_order?: number;
}

interface ProductPoSummaryLine {
  purchase_order_id: string;
  po_number: string;
  status: string;
  ordered_at: string;
  vendor_name: string;
  sku: string;
  quantity_ordered: number;
  quantity_received: number;
}

interface ProductPoSummary {
  open_po_count: number;
  pending_receive_units: number;
  pending_commit_value_usd: string;
  recent_lines: ProductPoSummaryLine[];
}

interface ProductHubResponse {
  product: ProductHubProduct;
  /** Present on current API; fallback for older servers. */
  store_default_employee_markup_percent?: string | number;
  can_view_procurement?: boolean;
  stats: ProductHubStats;
  po_summary: ProductPoSummary;
  variants: HubApiVariant[];
}

interface TimelineEvent {
  at: string;
  kind: string;
  summary: string;
  reference_id: string | null;
}

interface ProductHubDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  productId: string | null;
  baseUrl: string;
  /** Shown in header while loading. */
  seedTitle?: string;
  onHubMutated?: () => void;
}

function money(v: string | number) {
  return formatUsdFromCents(parseMoneyToCents(v));
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not counted yet";
  return new Date(value).toLocaleString();
}

function formatEventKind(kind: string) {
  if (kind === "sale") return "Sale";
  if (kind.startsWith("inventory_")) {
    return kind.replace(/^inventory_/, "").replace(/_/g, " ");
  }
  if (kind.startsWith("catalog_")) {
    return "Catalog update";
  }
  return kind.replace(/_/g, " ");
}

export default function ProductHubDrawer({
  isOpen,
  onClose,
  productId,
  baseUrl,
  seedTitle = "Product",
  onHubMutated,
}: ProductHubDrawerProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [tab, setTab] = useState<HubTab>("general");
  const [loading, setLoading] = useState(false);
  const [hub, setHub] = useState<ProductHubResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorSaving, setVendorSaving] = useState(false);
  const vendorPickerRef = useRef<HTMLDivElement>(null);
  const [employeeMarkupDraft, setEmployeeMarkupDraft] = useState("");
  const [employeeExtraDraft, setEmployeeExtraDraft] = useState("");
  const [employeeSaving, setEmployeeSaving] = useState(false);
  const [catalogAnalysis, setCatalogAnalysis] =
    useState<RosieProductCatalogAnalysisResponse | null>(null);
  const [catalogAnalysisLoading, setCatalogAnalysisLoading] = useState(false);
  const [catalogAnalysisError, setCatalogAnalysisError] = useState<string | null>(null);
  const [catalogSuggestion, setCatalogSuggestion] =
    useState<RosieProductCatalogSuggestionResponse | null>(null);
  const [catalogSuggestionLoading, setCatalogSuggestionLoading] = useState(false);
  const [catalogSuggestionError, setCatalogSuggestionError] = useState<string | null>(null);
  const [catalogSuggestionConfirmOpen, setCatalogSuggestionConfirmOpen] = useState(false);
  const [catalogSuggestionApplying, setCatalogSuggestionApplying] = useState(false);

  const loadHub = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/products/${productId}/hub`, {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("Failed to load product hub");
      setHub((await res.json()) as ProductHubResponse);
    } catch {
      setHub(null);
      toast("Could not load product hub.", "error");
    } finally {
      setLoading(false);
    }
  }, [productId, baseUrl, toast, apiAuth]);

  const loadTimeline = useCallback(async () => {
    if (!productId) return;
    setTimelineLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/products/${productId}/timeline`, {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("bad");
      const data = (await res.json()) as { events: TimelineEvent[] };
      setTimeline(data.events ?? []);
    } catch {
      setTimeline([]);
    } finally {
      setTimelineLoading(false);
    }
  }, [productId, baseUrl, apiAuth]);

  const loadCatalogAnalysis = useCallback(async () => {
    if (!productId) return;
    setCatalogAnalysisLoading(true);
    setCatalogAnalysisError(null);
    try {
      const analysis = await rosieProductCatalogAnalyze(productId, {
        headers: apiAuth(),
      });
      setCatalogAnalysis(analysis);
    } catch (error) {
      setCatalogAnalysis(null);
      setCatalogAnalysisError(
        error instanceof Error
          ? error.message
          : "ROSIE catalog analysis is unavailable right now.",
      );
    } finally {
      setCatalogAnalysisLoading(false);
    }
  }, [productId, apiAuth]);

  const loadCatalogSuggestion = useCallback(async () => {
    if (!productId) return;
    setCatalogSuggestionLoading(true);
    setCatalogSuggestionError(null);
    try {
      const suggestion = await rosieProductCatalogSuggest(productId, {
        headers: apiAuth(),
      });
      setCatalogSuggestion(suggestion);
    } catch (error) {
      setCatalogSuggestion(null);
      setCatalogSuggestionError(
        error instanceof Error
          ? error.message
          : "ROSIE catalog suggestion is unavailable right now.",
      );
    } finally {
      setCatalogSuggestionLoading(false);
    }
  }, [productId, apiAuth]);

  useEffect(() => {
    if (!isOpen || !productId) return;
    void loadHub();
    void loadTimeline();
    void loadCatalogAnalysis();
    void loadCatalogSuggestion();
    setTab("general");
  }, [isOpen, productId, loadHub, loadTimeline, loadCatalogAnalysis, loadCatalogSuggestion]);

  useEffect(() => {
    if (!isOpen || !productId) return;
    void (async () => {
      const res = await fetch(`${baseUrl}/api/vendors`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        setVendors([]);
        return;
      }
      const data = (await res.json()) as { id: string; name: string }[];
      setVendors(Array.isArray(data) ? data.map((v) => ({ id: v.id, name: v.name })) : []);
    })();
  }, [isOpen, productId, baseUrl, apiAuth]);

  useEffect(() => {
    if (!isOpen || !productId || tab !== "history") return;
    void loadTimeline();
  }, [isOpen, productId, tab, loadTimeline]);

  useEffect(() => {
    if (!vendorMenuOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const el = vendorPickerRef.current;
      if (el && !el.contains(ev.target as Node)) setVendorMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [vendorMenuOpen]);

  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter(
      (v) =>
        v.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q),
    );
  }, [vendors, vendorQuery]);

  const patchProductModel = useCallback(
    async (body: Record<string, unknown>) => {
      if (!productId) return false;
      try {
        const res = await fetch(`${baseUrl}/api/products/${productId}/model`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...apiAuth(),
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errBody.error ?? "Update failed");
        }
        await loadHub();
        onHubMutated?.();
        return true;
      } catch (e) {
        toast(
          e instanceof Error ? e.message : "Could not update product",
          "error",
        );
        return false;
      }
    },
    [productId, baseUrl, toast, apiAuth, loadHub, onHubMutated],
  );

  const patchPrimaryVendor = async (body: Record<string, unknown>) => {
    setVendorSaving(true);
    try {
      const ok = await patchProductModel(body);
      if (ok) {
        setVendorMenuOpen(false);
        setVendorQuery("");
      }
    } finally {
      setVendorSaving(false);
    }
  };

  useEffect(() => {
    if (!hub) return;
    setEmployeeMarkupDraft(
      hub.product.employee_markup_percent != null &&
        hub.product.employee_markup_percent !== ""
        ? String(hub.product.employee_markup_percent)
        : "",
    );
    setEmployeeExtraDraft(
      formatMoney(parseMoney(hub.product.employee_extra_amount)),
    );
  }, [hub]);

  const saveEmployeePricing = async () => {
    if (!hub) return;
    setEmployeeSaving(true);
    try {
      const hadMarkupOverride = hub.product.employee_markup_percent != null;
      const trimmed = employeeMarkupDraft.trim();
      const body: Record<string, unknown> = {};

      if (!trimmed && hadMarkupOverride) {
        body.clear_employee_markup_percent = true;
      } else if (trimmed) {
        const pct = Number.parseFloat(trimmed);
        if (!Number.isFinite(pct) || pct < 0) {
          toast("Markup % must be a non-negative number.", "error");
          return;
        }
        body.employee_markup_percent = pct;
      }

      const extra = parseMoney(employeeExtraDraft);
      if (extra < 0) {
        toast("Extra per unit cannot be negative.", "error");
        return;
      }
      const prevExtra = parseMoney(hub.product.employee_extra_amount);
      if (Math.abs(extra - prevExtra) > 1e-6) {
        body.employee_extra_amount = extra;
      }

      if (Object.keys(body).length === 0) {
        toast("No changes to save.", "error");
        return;
      }

      const ok = await patchProductModel(body);
      if (ok) toast("Employee sale pricing updated.", "success");
    } finally {
      setEmployeeSaving(false);
    }
  };

  const clearEmployeeMarkupOverride = async () => {
    if (hub == null || hub.product.employee_markup_percent == null) return;
    setEmployeeSaving(true);
    try {
      const ok = await patchProductModel({
        clear_employee_markup_percent: true,
      });
      if (ok) toast("Markup override cleared; store default applies.", "success");
    } finally {
      setEmployeeSaving(false);
    }
  };

  const applyCatalogSuggestion = async () => {
    if (!hub || !catalogSuggestion?.suggested_parent_title) return;
    setCatalogSuggestionApplying(true);
    try {
      const body: Record<string, unknown> = {
        name: catalogSuggestion.suggested_parent_title,
        audit_source: "rosie",
        audit_note: "Applied ROSIE catalog normalization suggestion from Product Hub",
        audit_confidence: catalogSuggestion.suggestion_confidence,
      };

      const supplierCode = catalogAnalysis?.parsed_fields.supplier_code?.trim();
      if (supplierCode && supplierCode !== (hub.product.nuorder_product_id ?? "").trim()) {
        body.catalog_handle = supplierCode;
      }

      const suggestedBrand = catalogAnalysis?.parsed_fields.brand?.trim();
      const currentBrand = (hub.product.brand ?? "").trim();
      if (suggestedBrand && suggestedBrand !== currentBrand) {
        body.brand = suggestedBrand;
      }

      const ok = await patchProductModel(body);
      if (!ok) return;

      await Promise.all([loadCatalogAnalysis(), loadCatalogSuggestion()]);
      if (tab === "history") {
        await loadTimeline();
      }
      setCatalogSuggestionConfirmOpen(false);
      toast("ROSIE catalog suggestion applied.", "success");
    } finally {
      setCatalogSuggestionApplying(false);
    }
  };

  const title =
    hub?.product.name ??
    seedTitle;

  const subtitle = (
    <div className="flex items-center gap-2">
      <span>{hub?.product?.brand ?? "Product template hub"}</span>
      {hub?.product?.nuorder_product_id && (
        <>
          <span className="text-app-text-muted/30">·</span>
          <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-black uppercase tracking-widest text-[10px]">
            <ShoppingBag size={10} /> NuORDER {hub.product?.nuorder_product_id}
          </span>
        </>
      )}
    </div>
  );

  const totalStock = hub?.stats?.total_units_on_hand ?? 0;
  const confidenceLabel = catalogAnalysis
    ? `${Math.round((catalogAnalysis.confidence_score ?? 0) * 100)}% confidence`
    : null;
  const parsedCatalogFields = catalogAnalysis
    ? [
        ["Vendor", catalogAnalysis.parsed_fields.vendor],
        ["Brand", catalogAnalysis.parsed_fields.brand],
        ["Supplier code", catalogAnalysis.parsed_fields.supplier_code],
        ["Product type", catalogAnalysis.parsed_fields.product_type],
        ["Color", catalogAnalysis.parsed_fields.color],
        ["Size", catalogAnalysis.parsed_fields.size],
        ["Fit", catalogAnalysis.parsed_fields.fit],
      ].filter(([, value]) => Boolean(value))
    : [];
  const currentParentTitle = hub?.product.name ?? "";
  const suggestedParentTitle = catalogSuggestion?.suggested_parent_title ?? null;
  const suggestedBrand = catalogAnalysis?.parsed_fields.brand?.trim() ?? "";
  const currentBrand = (hub?.product.brand ?? "").trim();
  const suggestedSupplierCode = catalogAnalysis?.parsed_fields.supplier_code?.trim() ?? "";
  const currentSupplierCode = (hub?.product.nuorder_product_id ?? "").trim();
  const canApplyCatalogSuggestion =
    Boolean(hub) &&
    Boolean(
      (suggestedParentTitle && suggestedParentTitle !== currentParentTitle) ||
        (suggestedBrand && suggestedBrand !== currentBrand) ||
        (suggestedSupplierCode && suggestedSupplierCode !== currentSupplierCode),
    );

  const hubVariants: HubVariant[] =
    hub?.variants?.map((v) => ({
      id: v.id,
      sku: v.sku,
      variation_values: v.variation_values,
      variation_label: v.variation_label,
      stock_on_hand: v.stock_on_hand,
      reorder_point: v.reorder_point,
      track_low_stock: v.track_low_stock,
      retail_price_override: v.retail_price_override,
      cost_override: v.cost_override,
      effective_retail: v.effective_retail,
      web_published: Boolean(v.web_published),
      web_price_override: v.web_price_override ?? null,
      web_gallery_order: v.web_gallery_order ?? 0,
    })) ?? [];

  const inventoryEvents = timeline
    .filter((event) => event.kind.startsWith("inventory_"))
    .slice(0, 5);

  const tabBtn = (id: HubTab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors ${
        tab === id
          ? "bg-app-accent text-white"
          : "bg-app-surface-2 text-app-text-muted hover:text-app-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <DetailDrawer
      isOpen={isOpen && !!productId}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      panelMaxClassName="max-w-3xl"
      titleClassName="!normal-case !tracking-tight"
      actions={
        <div className="flex flex-wrap gap-2">
          {tabBtn("general", "General")}
          {tabBtn("variations", "Variations")}
          {tabBtn("history", "History")}
        </div>
      }
    >
      {loading || !hub ? (
        <p className="text-sm text-app-text-muted">
          {loading ? "Loading hub…" : "No data."}
        </p>
      ) : (
        <>
          {tab === "general" && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full border border-app-accent/35 bg-app-accent/10 px-4 py-2 text-sm font-black uppercase italic tracking-tight text-app-accent shadow-app-accent/30">
                  In stock: {totalStock} units
                </span>
                {hub.product.is_clothing_footwear ? (
                  <span className="rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-700">
                    Clothing / footwear tax class
                  </span>
                ) : null}
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-app-border"
                  checked={hub.product.track_low_stock}
                  onChange={(e) =>
                    void patchPrimaryVendor({ track_low_stock: e.target.checked })
                  }
                />
                <div>
                  <p className="text-sm font-bold text-app-text">
                    Track low stock (template)
                  </p>
                  <p className="mt-1 text-xs text-app-text-muted">
                    When enabled, individual SKUs can still opt in on the Variations tab. Morning admin
                    alerts only include variants where both this box and the SKU box are on, and
                    available quantity is at or below reorder point.
                  </p>
                </div>
              </label>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                      Inventory truth
                    </h3>
                    <p className="mt-1 text-xs text-app-text-muted">
                      This view uses current server inventory values. Reserved units are already
                      promised to open orders and are not available for walk-in sale.
                    </p>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-surface-2/80 px-3 py-2 text-right">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Last physical count
                    </p>
                    <p className="mt-1 text-sm font-bold text-app-text">
                      {formatDateTime(hub.stats.last_physical_count_at)}
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-2xl border border-app-border bg-app-surface-2/90 px-4 py-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      On hand
                    </p>
                    <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                      {hub.stats.total_units_on_hand}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-app-border bg-app-surface-2/90 px-4 py-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Reserved in store
                    </p>
                    <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                      {hub.stats.total_reserved_units}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-app-border bg-app-surface-2/90 px-4 py-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Available now
                    </p>
                    <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                      {hub.stats.total_available_units}
                    </p>
                  </div>
                  {hub.can_view_procurement ? (
                    <div className="rounded-2xl border border-app-border bg-app-surface-2/90 px-4 py-3">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        On order
                      </p>
                      <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                        {hub.po_summary.pending_receive_units}
                      </p>
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 rounded-2xl border border-app-border bg-app-surface-2/70 px-4 py-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    How inventory rules work
                  </p>
                  <div className="mt-2 space-y-1.5 text-[11px] font-medium leading-relaxed text-app-text-muted">
                    <p>
                      Available now follows the live server rule: on hand minus units already reserved for open store work.
                    </p>
                    <p>
                      Reserved in store covers units already committed to orders, weddings, or other promised pickup work.
                    </p>
                    {hub.can_view_procurement ? (
                      <p>
                        On order shows incoming purchase-order units only. They do not become sellable inventory until the receipt posts.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-app-border text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        <th className="px-3 py-2">SKU</th>
                        <th className="px-3 py-2">Option</th>
                        <th className="px-3 py-2 text-right">On hand</th>
                        <th className="px-3 py-2 text-right">Reserved</th>
                        <th className="px-3 py-2 text-right">Available</th>
                        {hub.can_view_procurement ? (
                          <th className="px-3 py-2 text-right">On order</th>
                        ) : null}
                        <th className="px-3 py-2">Last physical count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hub.variants.map((variant) => (
                        <tr
                          key={variant.id}
                          className="border-b border-app-border/60 bg-app-surface-2/30 last:border-b-0"
                        >
                          <td className="px-3 py-3 font-mono text-xs font-bold text-app-text">
                            {variant.sku}
                          </td>
                          <td className="px-3 py-3 text-app-text">
                            {variant.variation_label ?? "Standard"}
                          </td>
                          <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                            {variant.stock_on_hand}
                          </td>
                          <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                            {variant.reserved_stock}
                          </td>
                          <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                            {variant.available_stock}
                          </td>
                          {hub.can_view_procurement ? (
                            <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                              {variant.qty_on_order ?? 0}
                            </td>
                          ) : null}
                          <td className="px-3 py-3 text-xs text-app-text-muted">
                            {formatDateTime(variant.last_physical_count_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Recent inventory events
                  </p>
                  {timelineLoading && inventoryEvents.length === 0 ? (
                    <p className="mt-2 text-sm text-app-text-muted">Loading recent activity…</p>
                  ) : inventoryEvents.length === 0 ? (
                    <p className="mt-2 text-sm text-app-text-muted">
                      No inventory movements recorded for this template yet.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {inventoryEvents.map((event, index) => (
                        <li
                          key={`${event.at}-${index}`}
                          className="rounded-xl border border-app-border bg-app-surface-2/80 px-3 py-2"
                        >
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            {formatDateTime(event.at)} · {formatEventKind(event.kind)}
                          </p>
                          <p className="mt-1 text-sm font-semibold text-app-text">
                            {event.summary}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["$ value on hand", money(hub?.stats?.value_on_hand ?? 0)],
                  ["Total sold (units)", String(hub?.stats?.units_sold_all_time ?? 0)],
                  ["Open order units", String(hub?.stats?.open_order_units ?? 0)],
                  [
                    "Purchase orders",
                    !hub.can_view_procurement
                      ? "Procurement access required"
                      : (hub?.po_summary?.open_po_count ?? 0) === 0 &&
                    (hub?.po_summary?.pending_receive_units ?? 0) === 0
                      ? "No open pipeline"
                      : `${hub?.po_summary?.open_po_count ?? 0} open PO${
                          (hub?.po_summary?.open_po_count ?? 0) === 1 ? "" : "s"
                        } · ${hub?.po_summary?.pending_receive_units ?? 0} pending`,
                  ],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded-2xl border border-app-border bg-app-surface-2/90 px-4 py-3"
                  >
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      {k}
                    </p>
                    <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                      {v}
                    </p>
                    {k === "Purchase orders" &&
                    hub.can_view_procurement &&
                    ((hub?.po_summary?.open_po_count ?? 0) > 0 ||
                      (hub?.po_summary?.pending_receive_units ?? 0) > 0) ? (
                      <p className="mt-1 text-[11px] font-semibold tabular-nums text-app-text-muted">
                        ≈ {money(hub?.po_summary?.pending_commit_value_usd ?? 0)} committed (at
                        line unit cost)
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <h3 className="mb-1 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Employee sale price
                </h3>
                <p className="mb-4 text-xs text-app-text-muted">
                  Unit price for employee sales is{" "}
                  <span className="font-semibold text-app-text">
                    cost × (1 + markup%) + extra
                  </span>
                  . Leave markup blank to use the store default (
                  {formatMoney(
                    parseMoney(
                      hub.store_default_employee_markup_percent ?? 15,
                    ),
                  )}
                  %). Extra is added per unit after markup.
                </p>
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                  <div className="min-w-[140px] flex-1">
                    <label
                      htmlFor="hub-employee-markup"
                      className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                    >
                      Markup % override
                    </label>
                    <input
                      id="hub-employee-markup"
                      type="text"
                      inputMode="decimal"
                      placeholder={`Default (${formatMoney(parseMoney(hub.store_default_employee_markup_percent ?? 15))}%)`}
                      value={employeeMarkupDraft}
                      onChange={(e) => setEmployeeMarkupDraft(e.target.value)}
                      disabled={employeeSaving}
                      className="ui-input w-full py-2.5 text-sm font-semibold"
                    />
                  </div>
                  <div className="min-w-[140px] flex-1">
                    <label
                      htmlFor="hub-employee-extra"
                      className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                    >
                      Extra / unit ($)
                    </label>
                    <input
                      id="hub-employee-extra"
                      type="text"
                      inputMode="decimal"
                      value={employeeExtraDraft}
                      onChange={(e) => setEmployeeExtraDraft(e.target.value)}
                      disabled={employeeSaving}
                      className="ui-input w-full py-2.5 text-sm font-semibold tabular-nums"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={employeeSaving}
                      onClick={() => void saveEmployeePricing()}
                      className="ui-btn-primary rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest"
                    >
                      Save
                    </button>
                    {hub.product.employee_markup_percent != null ? (
                      <button
                        type="button"
                        disabled={employeeSaving}
                        onClick={() => void clearEmployeeMarkupOverride()}
                        className="ui-btn-secondary rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest"
                      >
                        Use store markup
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                      ROSIE catalog analysis
                    </h3>
                    <p className="mt-1 text-xs text-app-text-muted">
                      Read-only parsing of the current product data. This surfaces confidence and
                      issues without changing catalog fields.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadCatalogAnalysis()}
                    disabled={catalogAnalysisLoading}
                    className="ui-btn-secondary rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    {catalogAnalysisLoading ? "Analyzing…" : "Refresh analysis"}
                  </button>
                </div>

                {catalogAnalysisError ? (
                  <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                    {catalogAnalysisError}
                  </div>
                ) : null}

                {catalogAnalysis ? (
                  <div className="mt-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-app-accent/30 bg-app-accent/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent">
                        {confidenceLabel}
                      </span>
                      <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                        Source: {catalogAnalysis.source_route}
                      </span>
                    </div>

                    {parsedCatalogFields.length > 0 ? (
                      <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        {parsedCatalogFields.map(([label, value]) => (
                          <div
                            key={label}
                            className="rounded-xl border border-app-border bg-app-surface-2/80 px-3 py-2"
                          >
                            <dt className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              {label}
                            </dt>
                            <dd className="mt-1 font-semibold text-app-text">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="text-sm text-app-text-muted">
                        ROSIE could not parse any structured fields confidently from the current
                        product data.
                      </p>
                    )}

                    {catalogAnalysis.issues_detected.length > 0 ? (
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Issues detected
                        </p>
                        <ul className="mt-2 space-y-2 text-sm text-app-text">
                          {catalogAnalysis.issues_detected.map((issue) => (
                            <li
                              key={issue}
                              className="rounded-xl border border-app-border bg-app-surface-2/80 px-3 py-2"
                            >
                              {issue}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {catalogAnalysis.unresolved_parts.length > 0 ? (
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Unresolved / ambiguous
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {catalogAnalysis.unresolved_parts.map((part) => (
                            <span
                              key={part}
                              className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-xs font-semibold text-app-text"
                            >
                              {part}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                      ROSIE normalization suggestion
                    </h3>
                    <p className="mt-1 text-xs text-app-text-muted">
                      Operator-reviewed parent-title cleanup grounded in the current catalog
                      analysis. Variant field suggestions are inspection-only in this pass.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadCatalogSuggestion()}
                    disabled={catalogSuggestionLoading}
                    className="ui-btn-secondary rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    {catalogSuggestionLoading ? "Refreshing…" : "Refresh suggestion"}
                  </button>
                </div>

                {catalogSuggestionError ? (
                  <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                    {catalogSuggestionError}
                  </div>
                ) : null}

                {catalogSuggestion ? (
                  <div className="mt-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-app-accent/30 bg-app-accent/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent">
                        {Math.round((catalogSuggestion.suggestion_confidence ?? 0) * 100)}%
                        suggestion confidence
                      </span>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-app-border bg-app-surface-2/80 px-4 py-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Current parent title
                        </p>
                        <p className="mt-2 text-sm font-semibold text-app-text">
                          {currentParentTitle || "—"}
                        </p>
                        <p className="mt-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Current brand / supplier code
                        </p>
                        <p className="mt-2 text-xs text-app-text-muted">
                          {(hub.product.brand ?? "No brand")} ·{" "}
                          {hub.product.nuorder_product_id ?? "No supplier code"}
                        </p>
                      </div>

                      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Suggested parent title
                        </p>
                        <p className="mt-2 text-sm font-semibold text-app-text">
                          {suggestedParentTitle ?? "No safe suggestion"}
                        </p>
                        <p className="mt-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Suggested variant fields
                        </p>
                        <p className="mt-2 text-xs text-app-text-muted">
                          {[
                            catalogSuggestion.suggested_variant_fields.color
                              ? `Color: ${catalogSuggestion.suggested_variant_fields.color}`
                              : null,
                            catalogSuggestion.suggested_variant_fields.size
                              ? `Size: ${catalogSuggestion.suggested_variant_fields.size}`
                              : null,
                            catalogSuggestion.suggested_variant_fields.fit
                              ? `Fit: ${catalogSuggestion.suggested_variant_fields.fit}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "No grounded variant-field suggestion"}
                        </p>
                      </div>
                    </div>

                    {catalogSuggestion.suggestion_issues.length > 0 ? (
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Suggestion issues
                        </p>
                        <ul className="mt-2 space-y-2 text-sm text-app-text">
                          {catalogSuggestion.suggestion_issues.map((issue) => (
                            <li
                              key={issue}
                              className="rounded-xl border border-app-border bg-app-surface-2/80 px-3 py-2"
                            >
                              {issue}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={!canApplyCatalogSuggestion || catalogSuggestionApplying}
                        onClick={() => setCatalogSuggestionConfirmOpen(true)}
                        className="ui-btn-primary rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest disabled:opacity-50"
                      >
                        Apply parent suggestion
                      </button>
                      {!canApplyCatalogSuggestion ? (
                        <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                          Nothing safe to apply
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </section>

              {hub.po_summary.recent_lines.length > 0 ? (
                <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                  <h3 className="mb-3 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                    Recent PO lines for this template
                  </h3>
                  <ul className="space-y-2 text-sm">
                    {hub.po_summary.recent_lines.map((line) => (
                      <li
                        key={`${line.purchase_order_id}-${line.sku}-${line.quantity_ordered}`}
                        className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-app-border bg-app-surface-2/80 px-3 py-2"
                      >
                        <span className="font-bold text-app-text">
                          {line.po_number}{" "}
                          <span className="font-mono text-xs font-semibold text-app-text-muted">
                            {line.sku}
                          </span>
                        </span>
                        <span className="text-xs text-app-text-muted">
                          {line.vendor_name} · {line.status.replace(/_/g, " ")}
                        </span>
                        <span className="w-full text-xs tabular-nums text-app-text-muted sm:w-auto">
                          {line.quantity_received}/{line.quantity_ordered} received ·{" "}
                          {new Date(line.ordered_at).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <h3 className="mb-4 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Template
                </h3>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <dt className="mb-1.5 flex items-center gap-1.5 text-app-text-muted">
                      <Building2 size={14} className="text-app-text-muted" />
                      Primary vendor
                    </dt>
                    <dd>
                      <div
                        ref={vendorPickerRef}
                        className="relative flex flex-col gap-2 sm:flex-row sm:items-start"
                      >
                        <div className="relative min-w-0 flex-1">
                          <div className="relative">
                            <ChevronsUpDown
                              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted"
                              aria-hidden
                            />
                            <input
                              type="text"
                              role="combobox"
                              aria-expanded={vendorMenuOpen}
                              aria-controls="vendor-hub-combo-list"
                              disabled={vendorSaving}
                              value={
                                vendorMenuOpen
                                  ? vendorQuery
                                  : (hub.product.primary_vendor_name ??
                                    "")
                              }
                              placeholder="Search vendors…"
                              onChange={(e) => {
                                setVendorQuery(e.target.value);
                                setVendorMenuOpen(true);
                              }}
                              onFocus={() => {
                                setVendorQuery("");
                                setVendorMenuOpen(true);
                              }}
                              className="w-full rounded-xl border border-app-border bg-app-surface-2 py-2.5 pl-3 pr-10 text-sm font-semibold text-app-text outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent/20 disabled:opacity-50"
                            />
                          </div>
                          {vendorMenuOpen ? (
                            <ul
                              id="vendor-hub-combo-list"
                              role="listbox"
                              className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-xl border border-app-border bg-app-surface py-1 shadow-lg"
                            >
                              {filteredVendors.length === 0 ? (
                                <li className="px-3 py-2 text-xs text-app-text-muted">
                                  No matches.
                                </li>
                              ) : (
                                filteredVendors.slice(0, 80).map((v) => (
                                  <li key={v.id} role="none">
                                    <button
                                      type="button"
                                      role="option"
                                      className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-app-accent/10"
                                      onClick={() =>
                                        void patchPrimaryVendor({
                                          primary_vendor_id: v.id,
                                        })
                                      }
                                    >
                                      <span className="font-bold text-app-text">
                                        {v.name}
                                      </span>
                                      <span className="font-mono text-[10px] text-app-text-muted">
                                        {v.id}
                                      </span>
                                    </button>
                                  </li>
                                ))
                              )}
                            </ul>
                          ) : null}
                        </div>
                        {hub.product.primary_vendor_id ? (
                          <button
                            type="button"
                            disabled={vendorSaving}
                            onClick={() =>
                              void patchPrimaryVendor({
                                clear_primary_vendor_id: true,
                              })
                            }
                            className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:border-red-200 hover:bg-red-50 hover:text-red-800 disabled:opacity-50"
                          >
                            <X size={14} /> Clear
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[10px] text-app-text-muted">
                        Used for PO suggestions and stock-out context. Freight
                        stays on the receipt document, not in WAC.
                      </p>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-app-text-muted">Category</dt>
                    <dd className="font-bold text-app-text">
                      {hub.product.category_name ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-app-text-muted">Base retail</dt>
                    <dd className="font-bold text-app-text">
                      {money(hub.product.base_retail_price)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-app-text-muted">Base cost</dt>
                    <dd className="font-mono text-app-text">
                      {money(hub.product.base_cost)}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-app-text-muted">Variation axes</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {(hub.product.variation_axes ?? []).length ? (
                        hub.product.variation_axes.map((a) => (
                          <span
                            key={a}
                            className="rounded-lg bg-app-surface-2 px-2 py-0.5 text-xs font-semibold text-app-text"
                          >
                            {a}
                          </span>
                        ))
                      ) : (
                        <span className="text-app-text-muted">—</span>
                      )}
                    </dd>
                  </div>
                  {hub.product.description ? (
                    <div className="sm:col-span-2">
                      <dt className="text-app-text-muted">Description</dt>
                      <dd className="text-app-text">{hub.product.description}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            </div>
          )}

          {tab === "variations" && (
            <VariationsWorkspace
              productId={hub.product.id}
              productTrackLowStock={hub.product.track_low_stock}
              templateBaseRetail={hub.product.base_retail_price}
              productName={hub.product.name}
              categoryName={hub.product.category_name}
              variationAxes={hub.product.variation_axes ?? []}
              matrixRowAxisKey={hub.product.matrix_row_axis_key}
              matrixColAxisKey={hub.product.matrix_col_axis_key}
              variants={hubVariants}
              baseUrl={baseUrl}
              onVariantUpdated={() => {
                void loadHub();
                onHubMutated?.();
              }}
            />
          )}

          {tab === "history" && (
            <div className="space-y-3">
              {timeline.length > 0 ? (
                <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                  Newest first
                </p>
              ) : null}
              {timelineLoading ? (
                <p className="text-sm text-app-text-muted">Loading timeline…</p>
              ) : timeline.length === 0 ? (
                <p className="text-sm text-app-text-muted">
                  No product history recorded yet.
                </p>
              ) : (
                <ul className="relative space-y-0 border-l-2 border-app-border pl-6">
                  {timeline.map((ev, i) => (
                    <li key={`${ev.at}-${i}`} className="relative pb-6">
                      <span className="absolute -left-[9px] top-1.5 h-3 w-3 rounded-full border-2 border-app-surface bg-app-accent shadow-sm" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        {new Date(ev.at).toLocaleString()} · {formatEventKind(ev.kind)}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-app-text">
                        {ev.summary}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      <ConfirmationModal
        isOpen={catalogSuggestionConfirmOpen}
        onClose={() => setCatalogSuggestionConfirmOpen(false)}
        onConfirm={() => void applyCatalogSuggestion()}
        title="Apply ROSIE catalog suggestion"
        message={`Apply the grounded parent-title suggestion for this product?\n\nCurrent: ${currentParentTitle || "—"}\nSuggested: ${suggestedParentTitle || "—"}\n\nThis writes through the existing product update API and records a ROSIE audit entry.`}
        confirmLabel="Apply suggestion"
        variant="info"
        loading={catalogSuggestionApplying}
      />
    </DetailDrawer>
  );
}
