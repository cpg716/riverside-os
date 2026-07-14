import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsUpDown, Eye, X } from "lucide-react";
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
  rosieChatCompletions,
  rosieProductCatalogAnalyze,
  rosieProductCatalogSuggest,
  type RosieChatCompletionRequest,
  type RosieChatCompletionResponse,
  type RosieProductCatalogAnalysisResponse,
  type RosieProductCatalogSuggestionResponse,
} from "../../lib/rosie";
import { getAppIcon } from "../../lib/icons";
import { getInventoryTagPrintConfig, openInventoryTagsWindow } from "./labelPrint";
import RosieIcon from "../common/RosieIcon";
import { isCustomOrderSku } from "../../lib/customOrders";
import { sortVariantsByVariation } from "../../lib/variantSort";

const VENDOR_ICON = getAppIcon("vendor");

type HubTab = "general" | "variations" | "history";
type ProductTaxOverride = "" | "clothing" | "accessory" | "service";

function productTaxRuleLabel(rule: ProductTaxOverride | null | undefined): string {
  switch (rule) {
    case "clothing":
      return "Clothing & Footwear";
    case "accessory":
      return "Regular taxable";
    case "service":
      return "Service / non-taxable";
    default:
      return "Inherit from category";
  }
}

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
  secondary_vendors?: VendorOption[];
  track_low_stock: boolean;
  tax_category_override?: ProductTaxOverride | null;
  /** Null = use store default markup %. */
  employee_markup_percent: string | number | null;
  employee_extra_amount: string | number;
  nuorder_product_id: string | null;
  catalog_handle: string | null;
}

interface VendorOption {
  id: string;
  name: string;
}

interface CategoryOption {
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
  barcode?: string | null;
  vendor_upc?: string | null;
  effective_retail: string;
  web_published?: boolean;
  web_price_override?: string | null;
  web_gallery_order?: number;
  hidden_from_inventory?: boolean;
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

interface ProductNormalizationReferenceOption {
  name: string | null;
  value: string | null;
}

interface ProductNormalizationReviewComparison {
  variant_id: string;
  ros_sku: string;
  counterpoint_b_sku: string;
  lightspeed_handle: string | null;
  ros_product_name: string;
  lightspeed_product_name: string | null;
  ros_category_name: string | null;
  lightspeed_category: string | null;
  ros_supplier_name: string | null;
  lightspeed_supplier_name: string | null;
  lightspeed_supplier_code: string | null;
  ros_options: Record<string, unknown>;
  lightspeed_options: ProductNormalizationReferenceOption[];
  differences: string[];
}

interface ProductNormalizationReview {
  reference_available: boolean;
  matched_alias_count: number;
  mismatch_count: number;
  needs_normalization: boolean;
  lightspeed_reference_available: boolean;
  rosie_review_suggested: boolean;
  comparisons: ProductNormalizationReviewComparison[];
  notes: string[];
}

interface ProductHubResponse {
  product: ProductHubProduct;
  /** Present on current API; fallback for older servers. */
  store_default_employee_markup_percent?: string | number;
  can_view_procurement?: boolean;
  stats: ProductHubStats;
  po_summary: ProductPoSummary;
  variants: HubApiVariant[];
  normalization_review?: ProductNormalizationReview;
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

interface ProductModelPriceChangeVariant {
  id: string;
  sku: string;
  variation_label: string | null;
  stock_on_hand: number;
  effective_retail: string;
}

interface ProductModelPatchResponse {
  status?: string;
  base_retail_price_changed?: boolean;
  price_change_reprint_variants?: ProductModelPriceChangeVariant[];
}

interface RosieCleanupSuggestionCard {
  scope: string;
  current_value: string | null;
  reference_value: string | null;
  suggested_value: string | null;
  rationale: string;
  confidence: number;
  evidence: string[];
}

interface RosieCleanupSuggestion {
  summary: string;
  suggestions: RosieCleanupSuggestionCard[];
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

function compactValue(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

function isCounterpointItemNumber(value?: string | null) {
  return /^I-\d+$/i.test(value?.trim() ?? "");
}

function vendorCatalogValue(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed || isCounterpointItemNumber(trimmed)) return null;
  return trimmed;
}

function friendlyCleanupNote(note: string) {
  return note
    .replace(
      "Counterpoint/ROS identity remains authoritative.",
      "ROS item identity remains authoritative.",
    )
    .replace(
      "Lightspeed values are normalization reference only.",
      "Reference values are for cleanup review only.",
    )
    .replace(
      "No active Lightspeed normalization reference batch is loaded.",
      "No active external catalog reference batch is loaded.",
    );
}

function formatOptionMap(value: Record<string, unknown>) {
  const entries = Object.entries(value)
    .map(([key, raw]) => `${key}: ${String(raw ?? "—")}`)
    .filter(Boolean);
  return entries.length > 0 ? entries.join(" · ") : "—";
}

function formatReferenceOptions(options: ProductNormalizationReferenceOption[]) {
  const entries = options
    .map((option) =>
      [option.name, option.value]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(": "),
    )
    .filter(Boolean);
  return entries.length > 0 ? entries.join(" · ") : "—";
}

function extractRosieAnswer(completion: RosieChatCompletionResponse | string) {
  if (typeof completion === "string") return completion.trim();
  for (const value of [completion.answer, completion.content, completion.response]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const choice of completion.choices ?? []) {
    const message = choice.message?.content;
    if (typeof message === "string" && message.trim()) return message.trim();
    if (typeof choice.message?.text === "string" && choice.message.text.trim()) {
      return choice.message.text.trim();
    }
    if (Array.isArray(message)) {
      const text = message
        .map((part) => part.text)
        .filter((part): part is string => Boolean(part?.trim()))
        .join("\n")
        .trim();
      if (text) return text;
    }
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text.trim();
    if (typeof choice.content === "string" && choice.content.trim()) return choice.content.trim();
  }
  return "";
}

function parseRosieCleanupSuggestion(answer: string): RosieCleanupSuggestion {
  const jsonText = answer.match(/\{[\s\S]*\}/)?.[0] ?? answer;
  const parsed = JSON.parse(jsonText) as Partial<RosieCleanupSuggestion> & Record<string, unknown>;
  const forbiddenFields = [
    "sku",
    "barcode",
    "quantity",
    "cost",
    "price",
    "tax",
    "accounting",
    "counterpoint_item_key",
    "catalog_handle",
    "merge",
    "delete",
  ];
  const normalizedForbiddenFields = new Set(forbiddenFields);
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  const containsForbiddenKey = (value: unknown): string | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = containsForbiddenKey(item);
        if (nested) return nested;
      }
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.trim().toLowerCase();
      if (normalizedForbiddenFields.has(normalizedKey)) return normalizedKey;
      const nested = containsForbiddenKey(nestedValue);
      if (nested) return nested;
    }
    return null;
  };
  const forbidden =
    containsForbiddenKey(parsed) ??
    (suggestions.length > 0
      ? forbiddenFields.find((field) =>
          suggestions.some((item) => {
            const scope = String((item as Partial<RosieCleanupSuggestionCard>).scope ?? "")
              .trim()
              .toLowerCase();
            return scope.includes(field);
          }),
        )
      : null);
  if (forbidden) {
    throw new Error(`ROSIE suggested a protected field (${forbidden}). Review blocked.`);
  }
  const cleanedSuggestions = suggestions.slice(0, 6).map((item) => {
    const candidate = item as Partial<RosieCleanupSuggestionCard>;
    return {
      scope: String(candidate.scope ?? "cleanup suggestion"),
      current_value:
        typeof candidate.current_value === "string" ? candidate.current_value : null,
      reference_value:
        typeof candidate.reference_value === "string" ? candidate.reference_value : null,
      suggested_value:
        typeof candidate.suggested_value === "string" ? candidate.suggested_value : null,
      rationale: String(candidate.rationale ?? "Review against the evidence before applying later."),
      confidence:
        typeof candidate.confidence === "number"
          ? Math.max(0, Math.min(1, candidate.confidence))
          : 0,
      evidence: Array.isArray(candidate.evidence)
        ? candidate.evidence
            .map((value) => String(value))
            .filter((value) => value.trim())
            .slice(0, 4)
        : [],
    };
  });
  if (cleanedSuggestions.length === 0) {
    throw new Error("ROSIE did not return any structured cleanup suggestions.");
  }
  return {
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "ROSIE returned review-only cleanup notes.",
    suggestions: cleanedSuggestions,
  };
}

function normalizeCleanupValue(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isInternalPosCategory(categoryName: string | null | undefined): boolean {
  const normalized = normalizeCleanupValue(categoryName);
  return normalized === "internal / pos" || normalized === "internal/pos";
}

function firstCleanupValue(suggestion: RosieCleanupSuggestionCard) {
  return (suggestion.suggested_value ?? suggestion.reference_value ?? "").trim();
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
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const [vendorQuery, setVendorQuery] = useState("");
  const [secondaryVendorMenuOpen, setSecondaryVendorMenuOpen] = useState(false);
  const [secondaryVendorQuery, setSecondaryVendorQuery] = useState("");
  const [vendorSaving, setVendorSaving] = useState(false);
  const vendorPickerRef = useRef<HTMLDivElement>(null);
  const secondaryVendorPickerRef = useRef<HTMLDivElement>(null);
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
  const [cleanupSuggestion, setCleanupSuggestion] =
    useState<RosieCleanupSuggestion | null>(null);
  const [cleanupSuggestionLoading, setCleanupSuggestionLoading] = useState(false);
  const [cleanupSuggestionError, setCleanupSuggestionError] = useState<string | null>(null);
  const [cleanupApplyingKey, setCleanupApplyingKey] = useState<string | null>(null);
  const [reprintPrompt, setReprintPrompt] = useState<ProductModelPriceChangeVariant[] | null>(null);

  const showVariantInInventory = useCallback(
    async (variant: HubApiVariant) => {
      try {
        const res = await fetch(
          `${baseUrl}/api/products/variants/${variant.id}/show-in-inventory`,
          {
            method: "PATCH",
            headers: apiAuth(),
          },
        );
        if (!res.ok) throw new Error(await res.text());
        setHub((current) =>
          current
            ? {
                ...current,
                variants: current.variants.map((row) =>
                  row.id === variant.id ? { ...row, hidden_from_inventory: false } : row,
                ),
              }
            : current,
        );
        onHubMutated?.();
        toast("Variant is visible in Inventory Find.", "success");
      } catch {
        toast("Could not show variant in Inventory Find.", "error");
      }
    },
    [apiAuth, baseUrl, onHubMutated, toast],
  );

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
    setCatalogSuggestion(null);
    setCleanupSuggestion(null);
    setCleanupSuggestionError(null);
    setTab("general");
  }, [isOpen, productId, loadHub, loadTimeline, loadCatalogAnalysis]);

  useEffect(() => {
    if (!isOpen || !productId) return;
    void (async () => {
      const headers = apiAuth();
      const [vendorRes, categoryRes] = await Promise.all([
        fetch(`${baseUrl}/api/vendors`, { headers }),
        fetch(`${baseUrl}/api/categories`, { headers }),
      ]);
      if (!vendorRes.ok) {
        setVendors([]);
      } else {
        const data = (await vendorRes.json()) as { id: string; name: string }[];
        setVendors(Array.isArray(data) ? data.map((v) => ({ id: v.id, name: v.name })) : []);
      }
      if (!categoryRes.ok) {
        setCategories([]);
      } else {
        const data = (await categoryRes.json()) as { id: string; name: string }[];
        setCategories(Array.isArray(data) ? data.map((c) => ({ id: c.id, name: c.name })) : []);
      }
    })();
  }, [isOpen, productId, baseUrl, apiAuth]);

  useEffect(() => {
    if (!isOpen || !productId || tab !== "history") return;
    void loadTimeline();
  }, [isOpen, productId, tab, loadTimeline]);

  useEffect(() => {
    if (!vendorMenuOpen && !secondaryVendorMenuOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const target = ev.target as Node;
      const primaryEl = vendorPickerRef.current;
      const secondaryEl = secondaryVendorPickerRef.current;
      if (primaryEl && !primaryEl.contains(target)) setVendorMenuOpen(false);
      if (secondaryEl && !secondaryEl.contains(target)) setSecondaryVendorMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [vendorMenuOpen, secondaryVendorMenuOpen]);

  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter(
      (v) =>
        v.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q),
    );
  }, [vendors, vendorQuery]);

  const selectedSecondaryVendorIds = useMemo(
    () => new Set((hub?.product.secondary_vendors ?? []).map((vendor) => vendor.id)),
    [hub?.product.secondary_vendors],
  );

  const filteredSecondaryVendors = useMemo(() => {
    const q = secondaryVendorQuery.trim().toLowerCase();
    return vendors.filter((vendor) => {
      if (vendor.id === hub?.product.primary_vendor_id) return false;
      if (selectedSecondaryVendorIds.has(vendor.id)) return false;
      if (!q) return true;
      return vendor.name.toLowerCase().includes(q) || vendor.id.toLowerCase().includes(q);
    });
  }, [vendors, hub?.product.primary_vendor_id, selectedSecondaryVendorIds, secondaryVendorQuery]);

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
          await res.json().catch(() => ({}));
          throw new Error("Product update failed. Check the product details and try again.");
        }
        const payload = (await res.json().catch(() => null)) as
          | ProductModelPatchResponse
          | null;
        if (payload?.base_retail_price_changed) {
          const affectedWithStock = (payload.price_change_reprint_variants ?? []).filter(
            (variant) => variant.stock_on_hand > 0,
          );
          if (affectedWithStock.length > 0) {
            setReprintPrompt(affectedWithStock);
          }
        }
        await loadHub();
        onHubMutated?.();
        return true;
      } catch (e) {
        console.error("Could not update product model", e);
        toast(
          "Product update failed. Check the product details and try again.",
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

  const patchSecondaryVendors = async (vendorIds: string[]) => {
    setVendorSaving(true);
    try {
      const ok = await patchProductModel({ secondary_vendor_ids: vendorIds });
      if (ok) {
        setSecondaryVendorMenuOpen(false);
        setSecondaryVendorQuery("");
      }
    } finally {
      setVendorSaving(false);
    }
  };

  const getCleanupApplyPlan = (suggestion: RosieCleanupSuggestionCard) => {
    const scope = normalizeCleanupValue(suggestion.scope);
    const value = firstCleanupValue(suggestion);
    if (!value) {
      return {
        label: "Suggested only",
        reason: "ROSIE did not provide a direct value to apply.",
        apply: null as (() => Promise<boolean>) | null,
      };
    }

    if (scope.includes("product display name") || scope === "product name") {
      const currentName = hub?.product.name ?? "";
      if (normalizeCleanupValue(currentName) === normalizeCleanupValue(value)) {
        return {
          label: "Already matches",
          reason: "The current product name already matches this suggestion.",
          apply: null as (() => Promise<boolean>) | null,
        };
      }
      return {
        label: "Apply product name",
        reason: "Updates only the product display name.",
        apply: () =>
          patchProductModel({
            name: value,
          }),
      };
    }

    if (scope.includes("category")) {
      const category = categories.find(
        (candidate) => normalizeCleanupValue(candidate.name) === normalizeCleanupValue(value),
      );
      if (!category) {
        return {
          label: "Suggested only",
          reason: "Category applies only when it exactly matches an existing ROS category.",
          apply: null as (() => Promise<boolean>) | null,
        };
      }
      if (hub?.product.category_id === category.id) {
        return {
          label: "Already matches",
          reason: "The product is already assigned to this category.",
          apply: null as (() => Promise<boolean>) | null,
        };
      }
      return {
        label: "Apply category",
        reason: "Assigns an existing ROS category only.",
        apply: () =>
          patchProductModel({
            category_id: category.id,
          }),
      };
    }

    if (scope.includes("supplier") || scope.includes("vendor")) {
      const vendor = vendors.find(
        (candidate) => normalizeCleanupValue(candidate.name) === normalizeCleanupValue(value),
      );
      if (!vendor) {
        return {
          label: "Suggested only",
          reason: "Supplier applies only when it exactly matches an existing ROS vendor.",
          apply: null as (() => Promise<boolean>) | null,
        };
      }
      if (hub?.product.primary_vendor_id === vendor.id) {
        return {
          label: "Already matches",
          reason: "The product is already assigned to this vendor.",
          apply: null as (() => Promise<boolean>) | null,
        };
      }
      return {
        label: "Apply vendor",
        reason: "Assigns an existing ROS vendor only.",
        apply: () =>
          patchProductModel({
            primary_vendor_id: vendor.id,
          }),
      };
    }

    return {
      label: "Suggested only",
      reason: "This cleanup type is review-only until a safe product API supports it.",
      apply: null as (() => Promise<boolean>) | null,
    };
  };

  const applyCleanupSuggestion = async (
    suggestion: RosieCleanupSuggestionCard,
    index: number,
  ) => {
    const plan = getCleanupApplyPlan(suggestion);
    if (!plan.apply) return;
    const key = `${suggestion.scope}-${index}`;
    setCleanupApplyingKey(key);
    try {
      const ok = await plan.apply();
      if (ok) {
        toast("Cleanup suggestion applied.", "success");
      }
    } finally {
      setCleanupApplyingKey(null);
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

  const generateCleanupSuggestion = async () => {
    if (!hub?.normalization_review?.needs_normalization) return;
    setCleanupSuggestionLoading(true);
    setCleanupSuggestionError(null);
    try {
      const evidence = hub.normalization_review.comparisons
        .filter((comparison) => comparison.differences.length > 0)
        .slice(0, 8)
        .map((comparison) => ({
          differences: comparison.differences,
          ros: {
            product_name: comparison.ros_product_name,
            category: comparison.ros_category_name,
            supplier: comparison.ros_supplier_name,
            options: comparison.ros_options,
          },
          lightspeed_reference: {
            product_name: comparison.lightspeed_product_name,
            category: comparison.lightspeed_category,
            supplier: comparison.lightspeed_supplier_name,
            options: comparison.lightspeed_options,
            handle: comparison.lightspeed_handle,
          },
        }));
      const cleanupCompletionPayload: RosieChatCompletionRequest & {
        chat_template_kwargs: { enable_thinking: boolean };
      } = {
        model: "gemma-4-e4b",
        temperature: 0.1,
        max_tokens: 900,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          {
            role: "system",
            content:
              "You are ROSIE, Riverside OS's local inventory cleanup assistant. Return only strict JSON. Suggestions are review-only and must never modify identity, barcode, stock, cost, price, tax, accounting, item keys, handles, product merges, or deletes.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Suggest review-only product cleanup from deterministic ROS vs Lightspeed normalization evidence.",
              allowed_scopes: [
                "product display name",
                "category suggestion",
                "supplier display cleanup",
                "variant option label/value cleanup",
                "mismatch explanation",
              ],
              required_schema: {
                summary: "string",
                suggestions: [
                  {
                    scope: "string",
                    current_value: "string|null",
                    reference_value: "string|null",
                    suggested_value: "string|null",
                    rationale: "string",
                    confidence: "number 0..1",
                    evidence: ["string"],
                  },
                ],
              },
              product_family: {
                product_id: hub.product.id,
                ros_name: hub.product.name,
                ros_category: hub.product.category_name,
                ros_supplier: hub.product.primary_vendor_name,
              },
              evidence,
            }),
          },
        ],
      };
      const completion = await rosieChatCompletions(
        cleanupCompletionPayload,
        { headers: apiAuth() },
      );
      const answer = extractRosieAnswer(completion);
      if (!answer) throw new Error("ROSIE did not return a cleanup suggestion.");
      setCleanupSuggestion(parseRosieCleanupSuggestion(answer));
    } catch (error) {
      setCleanupSuggestion(null);
      setCleanupSuggestionError(
        error instanceof Error
          ? error.message
          : "ROSIE cleanup suggestion is unavailable right now.",
      );
    } finally {
      setCleanupSuggestionLoading(false);
    }
  };

  const title =
    hub?.product.name ??
    seedTitle;
  const productCatalogNumber = vendorCatalogValue(
    hub?.product.catalog_handle ?? hub?.product.nuorder_product_id,
  );
  const counterpointItemNumber = isCounterpointItemNumber(
    hub?.product.catalog_handle ?? hub?.product.nuorder_product_id,
  )
    ? (hub?.product.catalog_handle ?? hub?.product.nuorder_product_id)
    : null;

  const subtitle = (
    <div className="flex items-center gap-2">
      <span>
        {hub?.product?.primary_vendor_name
          ? `Vendor: ${hub.product.primary_vendor_name}`
          : "No vendor assigned"}
      </span>
      {hub?.product?.brand && (
        <>
          <span className="text-app-text-muted/30">·</span>
          <span>Brand: {hub.product.brand}</span>
        </>
      )}
      {productCatalogNumber && (
        <>
          <span className="text-app-text-muted/30">·</span>
          <span className="inline-flex items-center gap-1 text-app-info font-black uppercase tracking-widest text-[10px]">
            Catalog # {productCatalogNumber}
          </span>
        </>
      )}
    </div>
  );

  const totalStock = hub?.stats?.total_units_on_hand ?? 0;
  const orderedVariants = useMemo(
    () => hub
      ? sortVariantsByVariation(hub.variants, [
          hub.product.matrix_row_axis_key,
          hub.product.matrix_col_axis_key,
          ...(hub.product.variation_axes ?? []),
        ])
      : [],
    [hub],
  );
  const isNonStockSaleProduct = Boolean(
    hub &&
      (isInternalPosCategory(hub.product.category_name) ||
        (orderedVariants.length > 0 && orderedVariants.every((variant) => isCustomOrderSku(variant.sku)))),
  );
  const confidenceLabel = catalogAnalysis
    ? `${Math.round((catalogAnalysis.confidence_score ?? 0) * 100)}% confidence`
    : null;
  const parsedCatalogFields = catalogAnalysis
    ? [
        ["Vendor", catalogAnalysis.parsed_fields.vendor],
        ["Brand", catalogAnalysis.parsed_fields.brand],
        ["Vendor code", catalogAnalysis.parsed_fields.supplier_code],
        ["Product type", catalogAnalysis.parsed_fields.product_type],
        ["Color", catalogAnalysis.parsed_fields.color],
        ["Size", catalogAnalysis.parsed_fields.size],
        ["Fit", catalogAnalysis.parsed_fields.fit],
      ].filter(([, value]) => Boolean(value))
    : [];
  const currentParentTitle = hub?.product.name ?? "";
  const suggestedParentTitle = catalogSuggestion?.suggested_parent_title ?? null;
  const normalizationReview = hub?.normalization_review;
  const normalizationExamples =
    normalizationReview?.comparisons
      .filter((comparison) => comparison.differences.length > 0)
      .slice(0, 6) ?? [];

  const hubVariants: HubVariant[] =
    orderedVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      variation_values: v.variation_values,
      variation_label: v.variation_label,
      stock_on_hand: v.stock_on_hand,
      reorder_point: v.reorder_point,
      track_low_stock: v.track_low_stock,
      retail_price_override: v.retail_price_override,
      cost_override: v.cost_override,
      barcode: v.barcode ?? null,
      vendor_upc: v.vendor_upc ?? null,
      effective_retail: v.effective_retail,
      web_published: Boolean(v.web_published),
      web_price_override: v.web_price_override ?? null,
      web_gallery_order: v.web_gallery_order ?? 0,
    }));

  const inventoryEvents = timeline
    .filter((event) => event.kind.startsWith("inventory_"))
    .slice(0, 5);

  const employeeBaseCost = parseMoney(hub?.product.base_cost ?? 0);
  const employeeBaseRetail = parseMoney(hub?.product.base_retail_price ?? 0);
  const employeeMarkupText = employeeMarkupDraft.trim();
  const employeeMarkupPercent = employeeMarkupText
    ? Number.parseFloat(employeeMarkupText)
    : parseMoney(hub?.store_default_employee_markup_percent ?? 15);
  const employeeExtraAmount = parseMoney(employeeExtraDraft);
  const employeePreview =
    Number.isFinite(employeeMarkupPercent) && employeeBaseCost > 0
      ? employeeBaseCost * (1 + employeeMarkupPercent / 100) + Math.max(0, employeeExtraAmount)
      : null;
  const employeePricingMode =
    hub?.product.employee_markup_percent != null || employeeExtraAmount > 0
      ? "Override: Cost + %"
      : "Standard employee discount";
  const employeePreviewWarning =
    employeeBaseCost <= 0
      ? "Add cost before using a cost-plus employee override."
      : employeePreview != null && employeeBaseRetail > 0 && employeePreview > employeeBaseRetail
        ? "Preview is above retail. Review markup or cost before using employee pricing."
        : null;

  const tabBtn = (id: HubTab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/25 active:scale-[0.99] ${
        tab === id
          ? "bg-app-accent text-white"
          : "bg-app-surface-2 text-app-text-muted hover:bg-app-surface hover:text-app-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      <DetailDrawer
        isOpen={isOpen && !!productId}
        onClose={onClose}
        title={title}
        subtitle={subtitle}
        panelMaxClassName="max-w-5xl"
        titleClassName="!normal-case !tracking-tight"
        actions={
          <div className="flex flex-wrap gap-2">
            {tabBtn("general", "Item Setup")}
            {tabBtn("variations", "SKUs & Stock")}
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
            <div className="space-y-5">
              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <h3 className="mb-4 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Item Identity
                </h3>
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  {hub.product.is_clothing_footwear ? (
                    <span className="rounded-lg border border-app-success/20 bg-app-success/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-success">
                      Clothing & Footwear tax rule
                    </span>
                  ) : null}
                  {hub.product.tax_category_override ? (
                    <span className="rounded-lg border border-amber-300/50 bg-amber-100 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-amber-800">
                      Product tax rule: {productTaxRuleLabel(hub.product.tax_category_override)}
                    </span>
                  ) : null}
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-app-text-muted">Name</dt>
                    <dd className="font-bold text-app-text">{hub.product.name}</dd>
                  </div>
                  <div>
                    <dt className="text-app-text-muted">Brand</dt>
                    <dd className="font-bold text-app-text">
                      {hub.product.brand ?? "—"}
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
                  {hub.product.description ? (
                    <div className="sm:col-span-2">
                      <dt className="text-app-text-muted">Description</dt>
                      <dd className="text-app-text">{hub.product.description}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <h3 className="mb-4 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Vendor & Catalog
                </h3>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <dt className="mb-1.5 flex items-center gap-1.5 text-app-text-muted">
                      <VENDOR_ICON size={14} className="text-app-text-muted" />
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
                              className="mt-1 max-h-52 w-full overflow-auto rounded-xl border border-app-border bg-app-surface py-1 shadow-lg"
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
                            <X size={14} /> Clear vendor
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[10px] text-app-text-muted">
                        Used for PO suggestions and stock-out context. Freight
                        stays on the receipt document, not in WAC.
                      </p>
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="mb-1.5 flex items-center gap-1.5 text-app-text-muted">
                      <VENDOR_ICON size={14} className="text-app-text-muted" />
                      Secondary vendors
                    </dt>
                    <dd className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                      <div className="space-y-3">
                        {(hub.product.secondary_vendors ?? []).length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {(hub.product.secondary_vendors ?? []).map((vendor) => (
                              <span
                                key={vendor.id}
                                className="inline-flex items-center gap-2 rounded-xl border border-app-accent bg-app-accent/10 px-3 py-2 text-xs font-bold text-app-accent"
                              >
                                {vendor.name}
                                <button
                                  type="button"
                                  disabled={vendorSaving}
                                  onClick={() =>
                                    void patchSecondaryVendors(
                                      [...selectedSecondaryVendorIds].filter((id) => id !== vendor.id),
                                    )
                                  }
                                  className="rounded-full p-0.5 text-app-accent hover:bg-app-accent/15 disabled:opacity-50"
                                  aria-label={`Remove ${vendor.name}`}
                                >
                                  <X size={12} />
                                </button>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs font-semibold text-app-text-muted">
                            No alternate vendors selected.
                          </p>
                        )}
                        <div ref={secondaryVendorPickerRef} className="relative">
                          <div className="relative">
                            <ChevronsUpDown
                              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted"
                              aria-hidden
                            />
                            <input
                              type="text"
                              role="combobox"
                              aria-expanded={secondaryVendorMenuOpen}
                              aria-controls="secondary-vendor-hub-combo-list"
                              disabled={vendorSaving}
                              value={secondaryVendorQuery}
                              placeholder="Search alternate vendors..."
                              onChange={(event) => {
                                setSecondaryVendorQuery(event.target.value);
                                setSecondaryVendorMenuOpen(true);
                              }}
                              onFocus={() => setSecondaryVendorMenuOpen(true)}
                              className="w-full rounded-xl border border-app-border bg-app-surface py-2.5 pl-3 pr-10 text-sm font-semibold text-app-text outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent/20 disabled:opacity-50"
                            />
                          </div>
                          {secondaryVendorMenuOpen ? (
                            <ul
                              id="secondary-vendor-hub-combo-list"
                              role="listbox"
                              className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-xl border border-app-border bg-app-surface py-1 shadow-lg"
                            >
                              {filteredSecondaryVendors.length === 0 ? (
                                <li className="px-3 py-2 text-xs text-app-text-muted">
                                  No matches.
                                </li>
                              ) : (
                                filteredSecondaryVendors.slice(0, 80).map((vendor) => (
                                  <li key={vendor.id} role="none">
                                    <button
                                      type="button"
                                      role="option"
                                      className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-app-accent/10"
                                      onClick={() =>
                                        void patchSecondaryVendors([
                                          ...selectedSecondaryVendorIds,
                                          vendor.id,
                                        ])
                                      }
                                    >
                                      <span className="font-bold text-app-text">
                                        {vendor.name}
                                      </span>
                                      <span className="font-mono text-[10px] text-app-text-muted">
                                        {vendor.id}
                                      </span>
                                    </button>
                                  </li>
                                ))
                              )}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-2 text-[10px] text-app-text-muted">
                        Approved alternate suppliers for PO line entry and receiving. Min/Max suggestions still use the primary vendor.
                      </p>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-app-text-muted">Catalog # / vendor style #</dt>
                    <dd className="font-mono text-app-text">
                      {productCatalogNumber ?? "—"}
                    </dd>
                    <p className="mt-1 text-[10px] text-app-text-muted">
                      Used for NuORDER, purchase orders, and receiving.
                    </p>
                  </div>
                  {counterpointItemNumber ? (
                    <div>
                      <dt className="text-app-text-muted">Counterpoint item #</dt>
                      <dd className="font-mono text-app-text">{counterpointItemNumber}</dd>
                    </div>
                  ) : null}
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
                </dl>
              </section>

              <section className="ui-panel ui-tint-info p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                      Catalog cleanup review
                    </h3>
                    <p className="mt-1 text-xs text-app-text-muted">
                      Review-only comparison against the active external catalog reference. Suggestions never change SKU, price, cost, stock, tax, or accounting fields automatically.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void generateCleanupSuggestion()}
                    disabled={
                      cleanupSuggestionLoading ||
                      !normalizationReview?.rosie_review_suggested
                    }
                    className="ui-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                  >
                    {cleanupSuggestionLoading ? (
                      "Asking ROSIE…"
                    ) : (
                      <>
                        <RosieIcon size={14} alt="" />
                        Generate ROSIE suggestion
                      </>
                    )}
                  </button>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="ui-metric-cell ui-tint-neutral px-3 py-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Matched aliases
                    </p>
                    <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                      {normalizationReview?.matched_alias_count ?? 0}
                    </p>
                  </div>
                  <div className="ui-metric-cell ui-tint-warning px-3 py-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Difference count
                    </p>
                    <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                      {normalizationReview?.mismatch_count ?? 0}
                    </p>
                  </div>
                  <div className="ui-metric-cell ui-tint-neutral px-3 py-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Review state
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {normalizationReview?.needs_normalization
                        ? "ROSIE review suggested"
                        : normalizationReview?.reference_available
                          ? "No differences found"
                          : "Reference missing"}
                    </p>
                  </div>
                </div>

                {!normalizationReview?.reference_available ? (
                  <p className="mt-4 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-sm font-semibold text-app-text">
                    No active external catalog reference batch is loaded.
                  </p>
                ) : normalizationExamples.length === 0 ? (
                  <p className="mt-4 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-sm font-semibold text-app-text">
                    No review differences were found for this product family.
                  </p>
                ) : (
                  <div className="mt-4 space-y-3">
                    {normalizationExamples.map((comparison) => (
                      <div
                        key={`${comparison.variant_id}-${comparison.counterpoint_b_sku}`}
                        className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            {comparison.differences.join(" · ")}
                          </p>
                          <span className="rounded-full border border-app-border bg-app-surface px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                            {comparison.counterpoint_b_sku}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                          <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Current ROS values
                            </p>
                            <p className="mt-1 font-semibold text-app-text">
                              {compactValue(comparison.ros_product_name)}
                            </p>
                            <p className="text-app-text-muted">
                              {compactValue(comparison.ros_category_name)} ·{" "}
                              {compactValue(comparison.ros_supplier_name)}
                            </p>
                            <p className="mt-1 text-app-text-muted">
                              {formatOptionMap(comparison.ros_options)}
                            </p>
                          </div>
                          <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Reference values
                            </p>
                            <p className="mt-1 font-semibold text-app-text">
                              {compactValue(comparison.lightspeed_product_name)}
                            </p>
                            <p className="text-app-text-muted">
                              {compactValue(comparison.lightspeed_category)} ·{" "}
                              {compactValue(comparison.lightspeed_supplier_name)}
                            </p>
                            <p className="mt-1 text-app-text-muted">
                              {formatReferenceOptions(comparison.lightspeed_options)}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {cleanupSuggestionError ? (
                  <div className="ui-panel ui-tint-warning mt-4 px-4 py-3 text-sm text-app-text">
                    {cleanupSuggestionError}
                  </div>
                ) : null}

                {cleanupSuggestion ? (
                  <div className="mt-4 space-y-3">
                    <p className="text-sm font-semibold text-app-text">
                      {cleanupSuggestion.summary}
                    </p>
                    <div className="grid gap-3 lg:grid-cols-2">
                      {cleanupSuggestion.suggestions.map((suggestion, index) => {
                        const plan = getCleanupApplyPlan(suggestion);
                        const key = `${suggestion.scope}-${index}`;
                        const applying = cleanupApplyingKey === key;
                        return (
                          <div
                            key={key}
                            className="ui-metric-cell ui-tint-success px-4 py-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                {suggestion.scope}
                              </p>
                              <span className="text-[10px] font-black uppercase tracking-widest text-app-success">
                                {Math.round(suggestion.confidence * 100)}%
                              </span>
                            </div>
                            <p className="mt-2 text-sm font-semibold text-app-text">
                              {suggestion.suggested_value ?? "No direct value suggestion"}
                            </p>
                            <p className="mt-2 text-xs text-app-text-muted">
                              {suggestion.rationale}
                            </p>
                            {suggestion.evidence.length > 0 ? (
                              <ul className="mt-2 space-y-1 text-[11px] text-app-text-muted">
                                {suggestion.evidence.map((item) => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            ) : null}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {plan.apply ? (
                                <button
                                  type="button"
                                  disabled={applying}
                                  onClick={() => void applyCleanupSuggestion(suggestion, index)}
                                  className="ui-btn-primary px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                                >
                                  {applying ? "Applying…" : plan.label}
                                </button>
                              ) : (
                                <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                  {plan.label}
                                </span>
                              )}
                              <span className="text-[11px] font-semibold text-app-text-muted">
                                {plan.reason}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  {(normalizationReview?.notes ?? []).map((note) => (
                    <span
                      key={note}
                      className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted"
                    >
                      {friendlyCleanupNote(note)}
                    </span>
                  ))}
                </div>
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                    Inventory snapshot
                  </h3>
                  <span className="rounded-full border border-app-accent/35 bg-app-accent/10 px-4 py-2 text-sm font-black uppercase italic tracking-tight text-app-accent shadow-app-accent/30">
                    {isNonStockSaleProduct ? "Not stock counted" : `On hand: ${totalStock} items`}
                  </span>
                </div>
                <div className="space-y-3">
                  <section className="ui-panel ui-tint-info p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                          {isNonStockSaleProduct ? "Sales item status" : "Inventory status"}
                        </h4>
                        <p className="mt-1 text-xs text-app-text-muted">
                          {isNonStockSaleProduct
                            ? "This item is sold through POS or custom order workflows and is not counted as shelf stock."
                            : "This view uses current inventory values. Reserved items are already promised to open orders and are not available for walk-in sale."}
                        </p>
                      </div>
                      {!isNonStockSaleProduct ? (
                        <div className="ui-metric-cell ui-tint-neutral px-3 py-2 text-right">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Last physical count
                          </p>
                          <p className="mt-1 text-sm font-bold text-app-text">
                            {formatDateTime(hub.stats.last_physical_count_at)}
                          </p>
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {isNonStockSaleProduct ? (
                        <>
                          <div className="ui-metric-cell ui-tint-neutral px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Sold All Time
                            </p>
                            <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                              {hub.stats.units_sold_all_time}
                            </p>
                          </div>
                          <div className="ui-metric-cell ui-tint-info px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Open Orders
                            </p>
                            <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                              {hub.stats.open_order_units}
                            </p>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="ui-metric-cell ui-tint-neutral px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              On hand
                            </p>
                            <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                              {hub.stats.total_units_on_hand}
                            </p>
                          </div>
                          <div className="ui-metric-cell ui-tint-warning px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Reserved in store
                            </p>
                            <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                              {hub.stats.total_reserved_units}
                            </p>
                          </div>
                          <div className="ui-metric-cell ui-tint-success px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Available now
                            </p>
                            <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                              {hub.stats.total_available_units}
                            </p>
                          </div>
                        </>
                      )}
                      {hub.can_view_procurement && !isNonStockSaleProduct ? (
                        <div className="ui-metric-cell ui-tint-info px-4 py-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            On order
                          </p>
                          <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                            {hub.po_summary.pending_receive_units}
                          </p>
                        </div>
                      ) : null}
                    </div>

                    <div className="ui-panel ui-tint-neutral mt-3 px-4 py-3">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        How inventory rules work
                      </p>
                      <div className="mt-2 space-y-1.5 text-[11px] font-medium leading-relaxed text-app-text-muted">
                        {isNonStockSaleProduct ? (
                          <p>
                            This item is used to ring a service, payment, or custom order sale. Review sales and open orders instead of shelf quantity.
                          </p>
                        ) : (
                          <>
                            <p>
                              Available now means on hand minus items already reserved for open store work.
                            </p>
                            <p>
                              Reserved in store covers items already committed to orders, weddings, or other promised pickup work.
                            </p>
                            {hub.can_view_procurement ? (
                              <p>
                                On order shows incoming purchase-order items only. They do not become sellable inventory until the receipt posts.
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-app-border text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        <th className="px-3 py-2">SKU</th>
                        <th className="px-3 py-2">Option</th>
                        {isNonStockSaleProduct ? (
                          <th className="px-3 py-2">Tracking</th>
                        ) : (
                          <>
                            <th className="px-3 py-2 text-right">On hand</th>
                            <th className="px-3 py-2 text-right">Reserved</th>
                            <th className="px-3 py-2 text-right">Available</th>
                          </>
                        )}
                        {hub.can_view_procurement && !isNonStockSaleProduct ? (
                          <th className="px-3 py-2 text-right">On order</th>
                        ) : null}
                        {!isNonStockSaleProduct ? (
                          <th className="px-3 py-2">Last physical count</th>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {orderedVariants.map((variant) => (
                        <tr
                          key={variant.id}
                          className="border-b border-app-border/60 bg-app-surface-2/30 last:border-b-0"
                        >
                          <td className="px-3 py-3 font-mono text-xs font-bold text-app-text">
                            {variant.sku}
                          </td>
                          <td className="px-3 py-3 text-app-text">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate">
                                {variant.variation_label ?? "Standard"}
                              </span>
                              {variant.hidden_from_inventory ? (
                                <span className="rounded-full border border-app-warning/20 bg-app-warning/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-app-warning">
                                  Hidden
                                </span>
                              ) : null}
                            </div>
                          </td>
                          {isNonStockSaleProduct ? (
                            <td className="px-3 py-3 text-xs font-semibold text-app-text-muted">
                              Not stock counted
                            </td>
                          ) : (
                            <>
                              <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                                {variant.stock_on_hand}
                              </td>
                              <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                                {variant.reserved_stock}
                              </td>
                              <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                                {variant.available_stock}
                              </td>
                            </>
                          )}
                          {hub.can_view_procurement && !isNonStockSaleProduct ? (
                            <td className="px-3 py-3 text-right font-black tabular-nums text-app-text">
                              {variant.qty_on_order ?? 0}
                            </td>
                          ) : null}
                          {!isNonStockSaleProduct ? (
                            <td className="px-3 py-3 text-xs text-app-text-muted">
                              <div className="flex items-center justify-between gap-2">
                                <span>{formatDateTime(variant.last_physical_count_at)}</span>
                                {variant.hidden_from_inventory ? (
                                  <button
                                    type="button"
                                    onClick={() => void showVariantInInventory(variant)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-app-success/25 bg-app-success/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-success transition-all hover:border-app-success/45 hover:bg-app-success/15"
                                  >
                                    <Eye size={12} />
                                    Show
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                    </div>

                    <div className="mt-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Recent inventory events
                      </p>
                      {timelineLoading && inventoryEvents.length === 0 ? (
                        <p className="mt-2 text-sm text-app-text-muted">Loading recent activity…</p>
                      ) : inventoryEvents.length === 0 ? (
                        <p className="mt-2 text-sm text-app-text-muted">
                          No inventory movements recorded for this item yet.
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
                      ["Retail value on hand", money(hub?.stats?.value_on_hand ?? 0)],
                      ["Total sold (units)", String(hub?.stats?.units_sold_all_time ?? 0)],
                      ["Open order units", String(hub?.stats?.open_order_units ?? 0)],
                      [
                        "Purchase orders",
                        !hub.can_view_procurement
                          ? "Vendor ordering access needed"
                          : (hub?.po_summary?.open_po_count ?? 0) === 0 &&
                        (hub?.po_summary?.pending_receive_units ?? 0) === 0
                          ? "No open orders"
                          : `${hub?.po_summary?.open_po_count ?? 0} open PO${
                              (hub?.po_summary?.open_po_count ?? 0) === 1 ? "" : "s"
                            } · ${hub?.po_summary?.pending_receive_units ?? 0} pending`,
                      ],
                    ].map(([k, v]) => (
                      <div
                        key={k}
                        className="ui-metric-cell ui-tint-neutral px-4 py-3"
                      >
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          {k}
                        </p>
                        <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                          {v}
                        </p>
                        {k === "Retail value on hand" ? (
                          <p className="mt-1 text-[11px] font-semibold tabular-nums text-app-text-muted">
                            Retail price x on hand; not accounting value.
                          </p>
                        ) : null}
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
                </div>
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <h3 className="mb-4 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Pricing & Selling
                </h3>
                <div className="space-y-3">
                  <label className="block rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                    <span className="text-sm font-bold text-app-text">
                      Product tax rule
                    </span>
                    <select
                      value={hub.product.tax_category_override ?? ""}
                      onChange={(event) => {
                        const value = event.target.value as ProductTaxOverride;
                        void patchPrimaryVendor(
                          value
                            ? { tax_category_override: value }
                            : { clear_tax_category_override: true },
                        );
                      }}
                      className="mt-2 h-11 w-full rounded-xl border border-app-border bg-app-surface px-3 text-xs font-bold text-app-text"
                    >
                      <option value="">Inherit from category</option>
                      <option value="clothing">Clothing & Footwear</option>
                      <option value="accessory">Regular taxable</option>
                      <option value="service">Service / non-taxable</option>
                    </select>
                    <span className="mt-2 block text-xs text-app-text-muted">
                      Product-level rules apply to every SKU under this parent item. Leave inherited unless this product differs from the category rule.
                    </span>
                  </label>

                  <section className="ui-panel ui-tint-neutral p-5">
                    <h4 className="mb-1 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                      Employee sale price
                    </h4>
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
                    <div className="mb-4 grid gap-2 sm:grid-cols-3">
                      <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Mode
                        </p>
                        <p className="mt-1 text-sm font-black text-app-text">
                          {employeePricingMode}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Current cost
                        </p>
                        <p className="mt-1 text-sm font-black tabular-nums text-app-text">
                          {money(hub.product.base_cost)}
                        </p>
                      </div>
                      <div
                        className={`rounded-2xl border px-4 py-3 ${
                          employeePreviewWarning
                            ? "border-amber-200 bg-amber-50 text-amber-800"
                            : "border-emerald-200 bg-emerald-50 text-emerald-800"
                        }`}
                      >
                        <p className="text-[9px] font-black uppercase tracking-widest opacity-70">
                          Employee price preview
                        </p>
                        <p className="mt-1 text-sm font-black tabular-nums">
                          {employeePreview == null ? "Needs cost" : money(employeePreview)}
                        </p>
                        {employeePreviewWarning ? (
                          <p className="mt-1 text-[10px] font-bold leading-snug">
                            {employeePreviewWarning}
                          </p>
                        ) : null}
                      </div>
                    </div>
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
                </div>
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                <h3 className="mb-4 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  System / Tools
                </h3>
                <div className="space-y-3">
                  <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4 transition-colors duration-150 hover:bg-app-surface-2">
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
                        Track low stock for this item
                      </p>
                      <p className="mt-1 text-xs text-app-text-muted">
                        When enabled, individual SKUs can opt in on the SKUs & Stock tab. Morning admin
                        alerts only include variants where both this box and the SKU box are on, and
                        available quantity is at or below reorder point.
                      </p>
                    </div>
                  </label>

                  <section className="ui-panel ui-tint-accent p-5">
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
                  <div className="ui-panel ui-tint-warning mt-4 px-4 py-3 text-sm text-app-text">
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
                            className="ui-metric-cell ui-tint-neutral px-3 py-2"
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
                              className="ui-metric-cell ui-tint-warning px-3 py-2"
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

              <section className="ui-panel ui-tint-accent p-5">
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
                  <div className="ui-panel ui-tint-warning mt-4 px-4 py-3 text-sm text-app-text">
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
                      <div className="ui-metric-cell ui-tint-neutral px-4 py-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Current parent title
                        </p>
                        <p className="mt-2 text-sm font-semibold text-app-text">
                          {currentParentTitle || "—"}
                        </p>
                        <p className="mt-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Current vendor / optional brand
                        </p>
                        <p className="mt-2 text-xs text-app-text-muted">
                          {hub.product.primary_vendor_name ?? "No vendor assigned"} ·{" "}
                          {hub.product.brand ?? "No brand label"}
                        </p>
                        <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
                          Catalog # / vendor style #: {productCatalogNumber ?? "not set"}
                        </p>
                      </div>

                      <div className="ui-metric-cell ui-tint-success px-4 py-3">
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

                    <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                      Review only. Product changes are not applied from ROSIE in this workflow.
                    </div>
                  </div>
                ) : null}
                  </section>
                </div>
              </section>

              {hub.po_summary.recent_lines.length > 0 ? (
                <section className="rounded-2xl border border-app-border bg-app-surface p-5">
                  <h3 className="mb-3 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                    Recent purchase order lines
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
      </DetailDrawer>
      <ConfirmationModal
        isOpen={reprintPrompt != null && reprintPrompt.length > 0}
        title="Print Updated Price Tags?"
        message={
          reprintPrompt
            ? `The price of this item has changed. Would you like to print new tags for the ${reprintPrompt.reduce((sum, variant) => sum + Math.max(0, variant.stock_on_hand), 0)} units in stock?`
            : ""
        }
        confirmLabel="Print Tags"
        onClose={() => setReprintPrompt(null)}
        onConfirm={() => {
          if (!reprintPrompt || reprintPrompt.length === 0) return;
          void (async () => {
            try {
              const printItems = reprintPrompt.flatMap((variant) => {
                const quantity = Math.max(0, variant.stock_on_hand);
                return Array.from({ length: quantity }, () => ({
                  sku: variant.sku,
                  productName: hub?.product.name ?? seedTitle,
                  variation: variant.variation_label ?? "Standard",
                  price: money(variant.effective_retail),
                }));
              });
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
                    variant_ids: reprintPrompt.map((variant) => variant.id),
                  }),
                },
              );
              if (!markRes.ok) {
                toast(
                  "Tags printed, but Riverside could not mark all variants as shelf-labeled.",
                  "error",
                );
                return;
              }
              toast(
                `${printItems.length} updated price tag${printItems.length === 1 ? "" : "s"} ${printResult.message}`,
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
    </>
  );
}
