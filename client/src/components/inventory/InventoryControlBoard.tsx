import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Building2,
  LayoutGrid,
  Printer,
  Gem,
  ArrowUpRight,
  BarChart3,
  Box,
  Globe,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
  MoreHorizontal,
  Check,
} from "lucide-react";
import ProductHubDrawer from "./ProductHubDrawer";
import InventoryBulkBar from "./InventoryBulkBar";
import { openShelfLabelsWindow } from "./labelPrint";
import { apiUrl } from "../../lib/apiUrl";
import { useScanner } from "../../hooks/useScanner";
import { playScanSuccess, playScanError } from "../../lib/scanSounds";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";

const HIGH_VALUE_MIN_USD = 500;

/** Paged loads — small pages keep the grid responsive; use “Load more” for deep paging. */
const BOARD_LIMIT_WITH_SEARCH = 600;
const BOARD_LIMIT_BROWSE = 400;

type QuickPick = "suits" | "shirts" | "alterations" | null;

function categoryIdForQuickPick(
  categories: Category[],
  pick: NonNullable<QuickPick>,
): string {
  const n = (s: string) => s.toLowerCase();
  for (const c of categories) {
    const name = n(c.name);
    if (pick === "suits" && name.includes("suit")) return c.id;
    if (pick === "shirts" && name.includes("shirt")) return c.id;
    if (
      pick === "alterations" &&
      (name.includes("alterat") || name.includes("tailor"))
    )
      return c.id;
  }
  return "";
}

interface Category {
  id: string;
  name: string;
  is_clothing_footwear: boolean;
}

interface Vendor {
  id: string;
  name: string;
  vendor_code?: string | null;
}

interface BoardRow {
  variant_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  brand: string | null;
  variation_label: string | null;
  category_id: string | null;
  category_name: string | null;
  is_clothing_footwear: boolean | null;
  stock_on_hand: number;
  /** Units available for sale (on hand minus reserved). */
  available_stock?: number;
  retail_price: string;
  cost_price: string;
  base_retail_price: string;
  base_cost: string;
  shelf_labeled_at?: string | null;
  primary_vendor_id?: string | null;
  primary_vendor_name?: string | null;
  web_published?: boolean;
  web_price_override?: string | null;
}

interface BoardStats {
  total_asset_value: string;
  skus_out_of_stock: number;
  active_vendors: number;
  need_label_skus: number;
  oos_replenishment_skus?: number;
}

interface BoardResponse {
  rows: BoardRow[];
  stats: BoardStats;
}

interface ProductListRow {
  product_id: string;
  brand: string | null;
  product_name: string;
  category_id: string | null;
  is_clothing_footwear: boolean | null;
  base_retail_price: string;
  base_cost: string;
  primary_vendor_name?: string | null;
  stock_on_hand: number;
  cost_extended: number;
  retail_min: number;
  retail_max: number;
  cost_min: number;
  cost_max: number;
  variant_count: number;
  unlabeled_count: number;
  category_name?: string | null;
  variant_rows: BoardRow[];
  /** Sum of variant available_stock (walk-in + web alloc). */
  available_stock_total: number;
  web_published_count: number;
}

function money(v: string | number) {
  if (typeof v === "number") return formatUsdFromCents(Math.round(v * 100));
  return formatUsdFromCents(parseMoneyToCents(v || "0"));
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-app-border bg-app-surface/50 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-app-text shadow-sm backdrop-blur-sm">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-md px-1 text-app-text-muted transition-colors hover:bg-app-accent/10 hover:text-app-accent"
        aria-label={`Remove filter ${label}`}
      >
        <X size={10} strokeWidth={3} />
      </button>
    </span>
  );
}

interface InventoryControlBoardProps {
  openProductHubProductId?: string | null;
  onProductHubDeepLinkConsumed?: () => void;
}

export default function InventoryControlBoard({
  openProductHubProductId = null,
  onProductHubDeepLinkConsumed,
}: InventoryControlBoardProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [stats, setStats] = useState<BoardStats>({
    total_asset_value: "0.00",
    skus_out_of_stock: 0,
    active_vendors: 0,
    need_label_skus: 0,
    oos_replenishment_skus: 0,
  });
  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [boardRefreshing, setBoardRefreshing] = useState(true);
  const [oosLowOnly, setOosLowOnly] = useState(false);
  const [oosOnly, setOosOnly] = useState(false);
  const [negativeStockOnly, setNegativeStockOnly] = useState(false);
  const [clothingOnly, setClothingOnly] = useState(false);
  const [unlabeledOnly, setUnlabeledOnly] = useState(false);
  const [highValueOnly, setHighValueOnly] = useState(false);
  const [quickPick, setQuickPick] = useState<QuickPick>(null);
  const [categoryId, setCategoryId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [brandQuery, setBrandQuery] = useState("");
  const [brandDraft, setBrandDraft] = useState("");
  const [groupByBrand, setGroupByBrand] = useState(false);
  const [groupByPrimaryVendor, setGroupByPrimaryVendor] = useState(false);
  const [webOnly, setWebOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [hubProductId, setHubProductId] = useState<string | null>(null);
  const [hubSeedTitle, setHubSeedTitle] = useState("");
  const [cursor, setCursor] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const raw = openProductHubProductId?.trim();
    if (!raw) return;
    setHubProductId(raw);
    setHubSeedTitle("Product");
    onProductHubDeepLinkConsumed?.();
  }, [openProductHubProductId, onProductHubDeepLinkConsumed]);

  const [maintenanceTarget, setMaintenanceTarget] = useState<{
    variantId: string;
    sku: string;
    type: "damaged" | "return_to_vendor";
  } | null>(null);
  const [maintenanceQty, setMaintenanceQty] = useState("1");
  const [maintenanceNote, setMaintenanceNote] = useState("");

  const closeMaintenance = () => {
    setMaintenanceTarget(null);
    setMaintenanceQty("1");
    setMaintenanceNote("");
  };

  const handleMaintenanceSubmit = async () => {
    if (!maintenanceTarget) return;
    const qty = parseInt(maintenanceQty, 10);
    if (!qty || qty <= 0) {
      toast("Invalid quantity", "error");
      return;
    }
    const note = maintenanceNote.trim();
    if (!note) {
      toast("Note is required for maintenance tracking", "error");
      return;
    }
    try {
      await bumpVariantStock(maintenanceTarget.variantId, -qty, maintenanceTarget.type, note);
      toast("Inventory maintenance recorded", "success");
      closeMaintenance();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Maintenance failed", "error");
    }
  };

  const [adjustRow, setAdjustRow] = useState<BoardRow | null>(null);
  const [tableFocus, setTableFocus] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [scanToast, setScanToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const scanToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [boardHasMore, setBoardHasMore] = useState(false);
  const [boardLoadingMore, setBoardLoadingMore] = useState(false);

  const boardPageLimit = debouncedSearch
    ? BOARD_LIMIT_WITH_SEARCH
    : BOARD_LIMIT_BROWSE;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadCategoriesAndVendors = useCallback(async () => {
    const [catRes, vendorRes] = await Promise.all([
      fetch(apiUrl(baseUrl, "/api/categories"), { headers: apiAuth() }),
      fetch(apiUrl(baseUrl, "/api/vendors"), { headers: apiAuth() }),
    ]);
    if (catRes.ok) {
      setCategories((await catRes.json()) as Category[]);
    }
    if (vendorRes.ok) {
      setVendors((await vendorRes.json()) as Vendor[]);
    }
  }, [baseUrl, apiAuth]);

  const refreshBoard = useCallback(async () => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (oosLowOnly) params.set("oos_low_only", "true");
    if (oosOnly) params.set("oos_only", "true");
    if (negativeStockOnly) params.set("negative_stock_only", "true");
    if (clothingOnly) params.set("clothing_only", "true");
    if (unlabeledOnly) params.set("unlabeled_only", "true");
    if (highValueOnly)
      params.set("min_line_value", String(HIGH_VALUE_MIN_USD));
    if (categoryId) params.set("category_id", categoryId);
    if (vendorId) params.set("vendor_id", vendorId);
    if (brandQuery.trim()) params.set("brand", brandQuery.trim());
    if (webOnly) params.set("web_published_only", "true");
    params.set("limit", String(boardPageLimit));
    params.set("offset", "0");

    setBoardRefreshing(true);
    try {
      const boardRes = await fetch(
        apiUrl(baseUrl, `/api/inventory/control-board?${params.toString()}`),
        { headers: apiAuth() },
      );
      if (boardRes.ok) {
        const data = (await boardRes.json()) as BoardResponse;
        setRows(data.rows);
        setBoardHasMore(data.rows.length === boardPageLimit);
        setStats({
          ...data.stats,
          need_label_skus:
            typeof data.stats.need_label_skus === "number"
              ? data.stats.need_label_skus
              : 0,
          oos_replenishment_skus:
            typeof data.stats.oos_replenishment_skus === "number"
              ? data.stats.oos_replenishment_skus
              : 0,
        });
      }
    } finally {
      setBoardRefreshing(false);
    }
  }, [
    baseUrl,
    debouncedSearch,
    oosLowOnly,
    oosOnly,
    negativeStockOnly,
    clothingOnly,
    unlabeledOnly,
    highValueOnly,
    categoryId,
    vendorId,
    brandQuery,
    webOnly,
    boardPageLimit,
    apiAuth,
  ]);

  const refresh = useCallback(async () => {
    await Promise.all([loadCategoriesAndVendors(), refreshBoard()]);
  }, [loadCategoriesAndVendors, refreshBoard]);

  useEffect(() => {
    void loadCategoriesAndVendors();
  }, [loadCategoriesAndVendors]);

  useEffect(() => {
    void refreshBoard();
  }, [refreshBoard]);

  const loadMoreBoard = useCallback(async () => {
    if (!boardHasMore || boardLoadingMore || boardRefreshing) return;
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (oosLowOnly) params.set("oos_low_only", "true");
    if (oosOnly) params.set("oos_only", "true");
    if (negativeStockOnly) params.set("negative_stock_only", "true");
    if (clothingOnly) params.set("clothing_only", "true");
    if (unlabeledOnly) params.set("unlabeled_only", "true");
    if (highValueOnly)
      params.set("min_line_value", String(HIGH_VALUE_MIN_USD));
    if (categoryId) params.set("category_id", categoryId);
    if (vendorId) params.set("vendor_id", vendorId);
    if (brandQuery.trim()) params.set("brand", brandQuery.trim());
    if (webOnly) params.set("web_published_only", "true");
    params.set("limit", String(boardPageLimit));
    params.set("offset", String(rows.length));

    setBoardLoadingMore(true);
    try {
      const boardRes = await fetch(
        apiUrl(baseUrl, `/api/inventory/control-board?${params.toString()}`),
        { headers: apiAuth() },
      );
      if (!boardRes.ok) return;
      const data = (await boardRes.json()) as BoardResponse;
      setRows((prev) => [...prev, ...data.rows]);
      setBoardHasMore(data.rows.length === boardPageLimit);
    } finally {
      setBoardLoadingMore(false);
    }
  }, [
    boardHasMore,
    boardLoadingMore,
    boardRefreshing,
    baseUrl,
    debouncedSearch,
    oosLowOnly,
    oosOnly,
    negativeStockOnly,
    clothingOnly,
    unlabeledOnly,
    highValueOnly,
    categoryId,
    vendorId,
    brandQuery,
    webOnly,
    boardPageLimit,
    rows.length,
    apiAuth,
  ]);

  useEffect(() => {
    if (!quickPick) return;
    const cid = categoryIdForQuickPick(categories, quickPick!);
    setCategoryId(cid);
  }, [quickPick, categories]);

  const productRows = useMemo<ProductListRow[]>(() => {
    const byProduct = new Map<string, BoardRow[]>();
    for (const r of rows) {
      const bucket = byProduct.get(r.product_id) ?? [];
      bucket.push(r);
      byProduct.set(r.product_id, bucket);
    }
    return [...byProduct.values()].map((variants) => {
      const first = variants[0]!;
      let stock = 0;
      let rMinC = Number.POSITIVE_INFINITY;
      let rMaxC = Number.NEGATIVE_INFINITY;
      let cMinC = Number.POSITIVE_INFINITY;
      let cMaxC = Number.NEGATIVE_INFINITY;
      let unlabeled = 0;
      let extCents = 0;
      let availSum = 0;
      let webPub = 0;
      for (const v of variants) {
        stock += v.stock_on_hand;
        availSum +=
          typeof v.available_stock === "number"
            ? v.available_stock
            : v.stock_on_hand;
        if (v.web_published) webPub += 1;
        const retailC = parseMoneyToCents(v.retail_price || "0");
        const costC = parseMoneyToCents(v.cost_price || "0");
        extCents += v.stock_on_hand * costC;
        rMinC = Math.min(rMinC, retailC);
        rMaxC = Math.max(rMaxC, retailC);
        cMinC = Math.min(cMinC, costC);
        cMaxC = Math.max(cMaxC, costC);
        if (!v.shelf_labeled_at) unlabeled += 1;
      }
      return {
        product_id: first.product_id,
        brand: first.brand,
        product_name: first.product_name,
        category_id: first.category_id,
        is_clothing_footwear: first.is_clothing_footwear,
        base_retail_price: first.base_retail_price,
        base_cost: first.base_cost,
        primary_vendor_name: first.primary_vendor_name,
        stock_on_hand: stock,
        cost_extended: extCents / 100,
        retail_min: Number.isFinite(rMinC) ? rMinC / 100 : 0,
        retail_max: Number.isFinite(rMaxC) ? rMaxC / 100 : 0,
        cost_min: Number.isFinite(cMinC) ? cMinC / 100 : 0,
        cost_max: Number.isFinite(cMaxC) ? cMaxC / 100 : 0,
        variant_count: variants.length,
        unlabeled_count: unlabeled,
        variant_rows: variants,
        available_stock_total: availSum,
        web_published_count: webPub,
      };
    });
  }, [rows]);

  const selectedProductIds = useMemo(() => {
    return [...selected];
  }, [selected]);

  const groupedRows = useMemo(() => {
    if (!groupByBrand) return null;
    const m = new Map<string, ProductListRow[]>();
    for (const r of productRows) {
      const k = r.brand?.trim() || "— No brand —";
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [productRows, groupByBrand]);

  const groupedRowsByVendor = useMemo(() => {
    if (!groupByPrimaryVendor) return null;
    const m = new Map<string, ProductListRow[]>();
    for (const r of productRows) {
      const k = r.primary_vendor_name?.trim() || "— No primary vendor —";
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [productRows, groupByPrimaryVendor]);

  const groupStats = useCallback((list: ProductListRow[]) => {
    let units = 0;
    let value = 0;
    for (const r of list) {
      units += r.stock_on_hand;
      value += r.cost_extended;
    }
    return { units, value };
  }, []);

  const toggleSelect = useCallback((productId: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(productId)) n.delete(productId);
      else n.add(productId);
      return n;
    });
  }, []);

  const openProductHub = useCallback((row: ProductListRow) => {
    setHubProductId(row.product_id);
    setHubSeedTitle(
      `${row.brand ? `${row.brand} · ` : ""}${row.product_name}`,
    );
  }, []);

  const bumpVariantStock = async (
    variantId: string,
    quantityDelta: number,
    txType?: string,
    notes?: string,
  ): Promise<void> => {
    const res = await fetch(
      `${baseUrl}/api/products/variants/${variantId}/stock-adjust`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ 
          quantity_delta: quantityDelta,
          tx_type: txType,
          notes: notes
        }),
      },
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? "Stock update failed");
    }
    const data = (await res.json()) as { stock_on_hand: number };
    setRows((prev) =>
      prev.map((r) =>
        r.variant_id === variantId
          ? { ...r, stock_on_hand: data.stock_on_hand }
          : r,
      ),
    );
  };

  const applyStockDelta = async (row: BoardRow, quantityDelta: number, txType?: string, notes?: string) => {
    try {
      await bumpVariantStock(row.variant_id, quantityDelta, txType, notes);
      setAdjustRow(null);
      toast("Stock adjusted", "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Stock update failed", "error");
    }
  };

  const onScanReceive = async (sku: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/inventory/scan-resolve?code=${encodeURIComponent(sku)}`,
      );
      if (!res.ok) {
        playScanError();
        setScanToast({ type: 'error', message: `Not found: ${sku}` });
        if (scanToastTimer.current) clearTimeout(scanToastTimer.current);
        scanToastTimer.current = setTimeout(() => setScanToast(null), 2500);
        return;
      }
      const data = (await res.json()) as { variant_id: string; product_name: string };
      await bumpVariantStock(data.variant_id, 1);
      playScanSuccess();
      setScanToast({ type: 'success', message: `+1 → ${data.product_name}` });
      if (scanToastTimer.current) clearTimeout(scanToastTimer.current);
      scanToastTimer.current = setTimeout(() => setScanToast(null), 2000);
    } catch (e: unknown) {
      playScanError();
      setScanToast({ type: 'error', message: e instanceof Error ? e.message : 'Receive failed' });
      if (scanToastTimer.current) clearTimeout(scanToastTimer.current);
      scanToastTimer.current = setTimeout(() => setScanToast(null), 2500);
    }
  };

  useScanner({
    onScan: (code) => void onScanReceive(code),
    enabled: !adjustRow && !hubProductId,
  });

  const bulkPrintLabels = async () => {
    const chosenProducts = productRows.filter((r) => selected.has(r.product_id));
    if (chosenProducts.length === 0) return;
    const chosenVariants = chosenProducts.flatMap((p) => p.variant_rows);
    openShelfLabelsWindow(
      chosenVariants.map((r) => ({
        sku: r.sku,
        productName: r.product_name,
        variation: r.variation_label ?? "Standard",
      })),
    );
    const res = await fetch(
      `${baseUrl}/api/products/variants/bulk-mark-shelf-labeled`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          variant_ids: chosenVariants.map((r) => r.variant_id),
        }),
      },
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "Could not mark shelf labels", "error");
    } else {
      toast("Labels processed", "success");
    }
    setSelected(new Set());
    await refreshBoard();
  };

  const onMassAssign = async (payload: {
    brand: string | null;
    categoryId: string | null;
  }) => {
    if (selectedProductIds.length === 0) return;
    const res = await fetch(`${baseUrl}/api/products/bulk-set-model`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...apiAuth(),
      },
      body: JSON.stringify({
        product_ids: selectedProductIds,
        ...(payload.brand ? { brand: payload.brand } : {}),
        ...(payload.categoryId ? { category_id: payload.categoryId } : {}),
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "Mass assign failed", "error");
      return;
    }
    toast("Mass assignment successful", "success");
    setSelected(new Set());
    await refreshBoard();
  };

  const bulkWebPublish = async (webPublished: boolean) => {
    const ids = productRows
      .filter((r) => selected.has(r.product_id))
      .flatMap((r) => r.variant_rows.map((v) => v.variant_id));
    if (ids.length === 0) return;
    const res = await fetch(`${baseUrl}/api/products/variants/bulk-web-publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...apiAuth(),
      },
      body: JSON.stringify({ variant_ids: ids, web_published: webPublished }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "Web publish update failed", "error");
      return;
    }
    toast(
      webPublished
        ? `${ids.length} SKU(s) marked for online store`
        : `${ids.length} SKU(s) removed from online store`,
      "success",
    );
    setSelected(new Set());
    await refreshBoard();
  };

  const executeBulkArchive = async () => {
    if (selectedProductIds.length === 0) return;
    setIsArchiving(true);
    try {
      const res = await fetch(`${baseUrl}/api/products/bulk-archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({ product_ids: selectedProductIds }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Archive failed", "error");
        return;
      }
      toast(`${selectedProductIds.length} templates archived`, "success");
      setSelected(new Set());
      await refreshBoard();
    } finally {
      setIsArchiving(false);
      setShowArchiveConfirm(false);
    }
  };

  const onTableKeyDown = (e: ReactKeyboardEvent) => {
    if (!tableFocus) return;
    if (e.key === "Enter" && selected.size > 0) {
      const first = productRows.find((r) => selected.has(r.product_id));
      if (first) openProductHub(first);
    }
    if (e.key === "ArrowDown") {
      setCursor(prev => Math.min(prev + 1, productRows.length - 1));
      e.preventDefault();
    }
    if (e.key === "ArrowUp") {
       setCursor(prev => Math.max(prev - 1, 0));
       e.preventDefault();
    }
  };

  useEffect(() => {
    if (tableFocus && rowRefs.current[cursor]) {
       rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [cursor, tableFocus]);

  const toggleQuickPick = (pick: NonNullable<QuickPick>) => {
    if (quickPick === pick) {
      setQuickPick(null);
      setCategoryId("");
    } else {
      setQuickPick(pick);
    }
  };

  const discoveryBtn = (
    active: boolean | QuickPick,
    label: string,
    onClick: () => void,
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={`relative overflow-hidden rounded-xl border px-3.5 py-1.5 text-[9px] font-black uppercase tracking-[0.15em] transition-all duration-300 active:scale-95 ${
        active
          ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20"
          : "border-app-border bg-app-surface/40 text-app-text-muted hover:border-app-accent/50 hover:bg-app-surface-2 hover:text-app-text"
      }`}
    >
      <span className="relative z-10">{label}</span>
      {active && (
        <span className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/10 to-white/0 animate-shimmer" />
      )}
    </button>
  );

  const renderPriceRange = (min: number, max: number) => (
    <div className="flex flex-col items-end">
      <span className="font-mono text-[11px] font-black tracking-tighter text-app-text">
        {money(max)}
      </span>
      {min !== max && (
        <span className="text-[10px] font-bold text-app-text-muted opacity-40">
          from {money(min)}
        </span>
      )}
    </div>
  );

  const renderRow = (row: ProductListRow, idx: number) => {
    const isSelected = selected.has(row.product_id);
    const focused = tableFocus && cursor === idx;

    const totalSoh = row.stock_on_hand || 0;
    const oos = totalSoh <= 0;
    const low = totalSoh > 0 && totalSoh <= 2;
    const highValue = row.cost_extended >= HIGH_VALUE_MIN_USD;

    const primaryVariant = row.variant_rows?.[0];
    const singleVariant = row.variant_count === 1;

    return (
      <div
        key={row.product_id}
        ref={(el: HTMLDivElement | null) => {
          rowRefs.current[idx] = el;
        }}
        onClick={() => {
          setCursor(idx);
          setTableFocus(true);
        }}
        onDoubleClick={() => openProductHub(row)}
        className={`group relative flex items-center gap-4 px-5 py-3.5 transition-all hover:z-10 border-b border-app-border/30 ${
          focused
            ? "bg-app-accent/5 ring-1 ring-inset ring-app-accent/30"
            : isSelected
              ? "bg-app-accent/10"
              : "bg-app-surface hover:bg-app-surface-2"
        }`}
      >
        {/* Selection Indicator */}
        <div className="flex shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleSelect(row.product_id)}
            className="h-4 w-4 rounded-lg border-app-border bg-app-surface text-app-accent transition-all focus:ring-app-accent shadow-sm"
          />
        </div>

        {/* Product Identity Cluster */}
        <div className="flex min-w-0 flex-[3.5] items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 shadow-inner group-hover:scale-105 transition-transform ${oos ? 'opacity-40 grayscale' : ''}`}>
             {row.is_clothing_footwear ? <Gem size={16} className="text-violet-500" /> : <Box size={16} className="text-app-text-muted" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="truncate text-xs font-black uppercase tracking-tight text-app-text leading-tight group-hover:text-app-accent transition-colors">
                {row.product_name}
              </h3>
              {highValue && (
                <span className="flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[7px] font-black uppercase tracking-widest text-amber-600 border border-amber-500/20">
                  <Gem size={7} /> ASSET
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-[9px] font-bold text-app-text-muted">
                {primaryVariant?.sku || "NO SKU"}
              </span>
              <span className="text-[9px] font-bold uppercase tracking-widest text-app-text-muted opacity-40">
                {row.brand || "—"}
              </span>
              <span className="text-[9px] font-black uppercase tracking-tighter text-app-text-muted/60">
                {row.category_name || "Misc"}
              </span>
            </div>
          </div>
        </div>

        {/* Inventory Velocity & SOH */}
        <div className="flex shrink-0 flex-[1.5] items-center gap-4">
          <div className="text-center min-w-[60px]">
             <p className={`text-xl font-black tabular-nums tracking-tighter ${oos ? 'text-red-500' : low ? 'text-amber-500' : 'text-emerald-500'}`}>
               {totalSoh}
             </p>
             <p className="text-[7px] font-black uppercase tracking-widest text-app-text-muted opacity-50">SOH UNITS</p>
          </div>
          <div className="flex-1 max-w-[80px]">
            <div className="flex items-center justify-between text-[8px] font-black uppercase tracking-[0.1em] text-app-text-muted mb-1 opacity-50">
               <span>AVAIL</span>
               <span>{row.variant_count}x</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-app-border/20">
              <div 
                className={`h-full transition-all duration-700 ${oos ? 'bg-red-500/60' : low ? 'bg-amber-500/60' : 'bg-emerald-500/60'}`}
                style={{ width: `${Math.min(100, (totalSoh / 10) * 100)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Financial Context */}
        <div className="flex shrink-0 flex-[1.5] items-center justify-end gap-6 border-l border-app-border/20 px-4">
           {renderPriceRange(row.retail_min, row.retail_max)}
           <div className="hidden 2xl:flex flex-col items-end min-w-[60px]">
              <div className="flex items-center gap-0.5 text-emerald-500">
                <span className="font-mono text-[10px] font-black">+8%</span>
                <ArrowUpRight size={10} />
              </div>
              <p className="text-[7px] font-black uppercase tracking-widest text-app-text-muted opacity-40">30D VEL</p>
           </div>
        </div>

        {/* Channel Badges */}
        <div className="flex shrink-0 flex-1 flex-wrap gap-1.5 justify-end">
           {row.web_published_count > 0 && (
             <div className="rounded-lg bg-emerald-500/5 px-2 py-1 text-[8px] font-black uppercase tracking-widest text-emerald-600 border border-emerald-500/10 flex items-center gap-1">
               <Globe size={9} /> WEB
             </div>
           )}
           {row.unlabeled_count > 0 && (
             <div className="rounded-lg bg-red-500/5 px-2 py-1 text-[8px] font-black uppercase tracking-widest text-red-600 border border-red-500/10">UNLABELED</div>
           )}
        </div>

        {/* Quick Actions (Reveal on group-hover) */}
        <div className="flex shrink-0 items-center justify-end min-w-[80px]">
          <div className={`flex items-center gap-1 transition-all duration-300 ${focused || 'opacity-0 translate-x-4 group-hover:opacity-100 group-hover:translate-x-0'}`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (singleVariant && primaryVariant) {
                  setAdjustRow(primaryVariant);
                } else {
                  openProductHub(row);
                }
              }}
              className="p-1.5 rounded-xl border border-app-border bg-app-surface text-app-text-muted hover:text-emerald-500 hover:border-emerald-500 transition-all"
              title="Quick Adjust"
            >
              <BarChart3 size={14} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                openProductHub(row);
              }}
              className="p-1.5 rounded-xl border border-app-border bg-app-surface text-app-text-muted hover:text-app-accent hover:border-app-accent transition-all"
              title="Manage"
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-surface selection:bg-app-accent/20 selection:text-app-text">
      <header className="border-b border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-surface)_88%,transparent)] px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <p className="hidden shrink-0 text-[10px] font-black uppercase tracking-[0.2em] text-[var(--app-text-muted)] sm:block">
            Search & filters
          </p>
          <div className="relative min-w-0 flex-1 group">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-text-muted)] transition-colors group-focus-within:text-[var(--app-accent)]"
              size={18}
              aria-hidden
            />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Deep SKU / Brand / Name lookup..."
              className="ui-input h-11 w-full min-w-[240px] pl-10 pr-3 text-sm font-semibold"
              aria-busy={boardRefreshing}
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="h-8 w-px bg-[var(--app-border)] max-sm:hidden" aria-hidden />
            <div className="flex items-center gap-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1">
              <button
                type="button"
                onClick={() => setGroupByBrand(!groupByBrand)}
                className={`rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                  groupByBrand
                    ? "bg-[var(--app-surface)] text-[var(--app-text)] shadow-sm ring-1 ring-[var(--app-border)]"
                    : "text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
                }`}
              >
                Brand Mode
              </button>
              <button
                type="button"
                onClick={() => setGroupByPrimaryVendor(!groupByPrimaryVendor)}
                className={`rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                  groupByPrimaryVendor
                    ? "bg-[var(--app-surface)] text-[var(--app-text)] shadow-sm ring-1 ring-[var(--app-border)]"
                    : "text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
                }`}
              >
                Vendor Mode
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {discoveryBtn(oosLowOnly, "Low Stock (≤2)", () =>
            setOosLowOnly(!oosLowOnly),
          )}
          {discoveryBtn(oosOnly, "Zero Stock", () =>
            setOosOnly(!oosOnly),
          )}
          {discoveryBtn(negativeStockOnly, "Negative Stock", () =>
            setNegativeStockOnly(!negativeStockOnly),
          )}
          {discoveryBtn(clothingOnly, "Clothing Exempt", () =>
            setClothingOnly(!clothingOnly),
          )}
          {discoveryBtn(unlabeledOnly, "Missing Labels", () =>
            setUnlabeledOnly(!unlabeledOnly),
          )}
          {discoveryBtn(highValueOnly, "High Asset Value", () =>
            setHighValueOnly(!highValueOnly),
          )}
          {discoveryBtn(webOnly, "On web", () => setWebOnly(!webOnly))}
          <div className="h-6 w-px bg-app-border mx-2" />
          <div className="flex flex-wrap gap-2">
            {[
              ["suits", "Suits"],
              ["shirts", "Shirts"],
              ["alterations", "Alterations"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => toggleQuickPick(id as NonNullable<QuickPick>)}
                className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
                  quickPick === id
                    ? "border-violet-500 bg-violet-600 text-white shadow-lg shadow-violet-600/20"
                    : "border-app-border bg-app-surface text-app-text-muted hover:border-app-input-border"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {categoryId && (
            <FilterChip
              label={`Category: ${
                categories.find((c) => c.id === categoryId)?.name ?? categoryId
              }`}
              onRemove={() => setCategoryId("")}
            />
          )}
          {vendorId && (
            <FilterChip
              label={`Vendor: ${
                vendors.find((v) => v.id === vendorId)?.name ?? vendorId
              }`}
              onRemove={() => setVendorId("")}
            />
          )}
          {brandQuery && (
            <FilterChip
              label={`Brand: ${brandQuery}`}
              onRemove={() => {
                setBrandQuery("");
                setBrandDraft("");
              }}
            />
          )}
          {webOnly && (
            <FilterChip label="On web" onRemove={() => setWebOnly(false)} />
          )}
          {oosOnly && (
            <FilterChip label="Zero Stock" onRemove={() => setOosOnly(false)} />
          )}
          {negativeStockOnly && (
            <FilterChip label="Negative Stock" onRemove={() => setNegativeStockOnly(false)} />
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-[4] flex-col overflow-hidden">
        {boardRefreshing ? (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex items-start justify-center bg-app-surface/40 pt-10 backdrop-blur-[1px]"
            aria-live="polite"
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-app-border bg-app-surface/95 px-4 py-2 text-xs font-bold text-app-text shadow-lg">
              <Loader2
                className="h-4 w-4 shrink-0 animate-spin text-app-accent"
                aria-hidden
              />
              Working…
            </span>
          </div>
        ) : null}
        <div
          className="flex-1 overflow-auto no-scrollbar outline-none"
          onFocus={() => setTableFocus(true)}
          onBlur={() => setTableFocus(false)}
          onKeyDown={onTableKeyDown}
          tabIndex={0}
        >
          <div className="flex flex-col gap-px bg-app-border/20 pb-20">
            {groupByBrand && groupedRows ? (
              groupedRows.map(([brand, items]) => {
                const stats = groupStats(items);
                return (
                  <Fragment key={brand}>
                    <div className="sticky top-0 z-20 flex items-center justify-between border-b border-app-border bg-app-surface-2/95 px-6 py-2 backdrop-blur-md">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-black uppercase tracking-tight text-app-text italic">
                          {brand}
                        </span>
                        <span className="rounded-full bg-app-border/50 px-2 py-0.5 text-[9px] font-black text-app-text-muted">
                          {items.length} Product Templates
                        </span>
                      </div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted opacity-60">
                        {stats.units} units ·{" "}
                        {money(stats.value)}{" "}
                        asset value
                      </div>
                    </div>
                    {items.map((item, localIdx) => renderRow(item, localIdx))}
                  </Fragment>
                );
              })
            ) : groupByPrimaryVendor && groupedRowsByVendor ? (
              groupedRowsByVendor.map(([v, items]) => {
                const stats = groupStats(items);
                return (
                  <Fragment key={v}>
                    <div className="sticky top-0 z-20 flex items-center justify-between border-b border-violet-200 bg-violet-50/95 px-6 py-2 backdrop-blur-md">
                      <div className="flex items-center gap-3">
                        <Building2 size={16} className="text-violet-400" />
                        <span className="text-sm font-black uppercase tracking-tight text-violet-900 italic">
                          {v}
                        </span>
                        <span className="rounded-full bg-violet-200 px-2 py-0.5 text-[9px] font-black text-violet-500">
                          {items.length} Templates
                        </span>
                      </div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-violet-400">
                        {stats.units} units ·{" "}
                        {money(stats.value)}{" "}
                        asset value
                      </div>
                    </div>
                    {items.map((item, localIdx) => renderRow(item, localIdx))}
                  </Fragment>
                );
              })
            ) : (
              productRows.map((item, idx) => renderRow(item, idx))
            )}

            {!boardRefreshing && productRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-32 text-app-text-muted">
                <Search size={48} className="mb-4 opacity-20" />
                <p className="text-sm font-black uppercase tracking-widest opacity-60">
                  No inventory matches found
                </p>
              </div>
            ) : null}

            {boardHasMore && productRows.length > 0 ? (
              <div className="flex justify-center border-t border-app-border py-8 bg-app-surface/30">
                <button
                  type="button"
                  disabled={boardLoadingMore}
                  onClick={() => void loadMoreBoard()}
                  className="rounded-2xl border border-app-border bg-app-surface px-10 py-4 text-xs font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:shadow-2xl active:scale-95 disabled:opacity-50 shadow-xl"
                >
                  {boardLoadingMore ? "Synchronizing SKUs..." : "Expand Discovery Plane"}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {selected.size > 0 && (
          <InventoryBulkBar
            selectedCount={selected.size}
            onClearSelection={() => setSelected(new Set())}
            onBulkPrintLabels={() => void bulkPrintLabels()}
            onBulkArchive={() => setShowArchiveConfirm(true)}
            onMassAssign={onMassAssign}
            onScanReceive={onScanReceive}
            onBulkPublishWeb={() => void bulkWebPublish(true)}
            onBulkUnpublishWeb={() => void bulkWebPublish(false)}
            categories={categories}
          />
        )}
      </div>

      <footer className="border-t border-[var(--app-border)] bg-[var(--app-surface)] px-4 py-3 shadow-2xl md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-6 md:gap-8">
            <div className="flex flex-col">
              <span className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--app-text-muted)]">
                Asset Value
              </span>
              <span className="text-lg font-black tabular-nums tracking-tighter text-[var(--app-text)]">
                {money(stats.total_asset_value)}
              </span>
            </div>
            <div className="h-8 w-px bg-[var(--app-border)]" />
            <div className="flex flex-col">
              <span className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--app-text-muted)]">
                Replens
              </span>
              <span className="text-lg font-black tabular-nums tracking-tighter text-emerald-600">
                {stats.oos_replenishment_skus ?? 0}
              </span>
            </div>
            <div className="h-8 w-px bg-[var(--app-border)]" />
            <div className="flex flex-col">
              <span className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--app-text-muted)]">
                Unlabeled
              </span>
              <span className="text-lg font-black tabular-nums tracking-tighter text-amber-500">
                {stats.need_label_skus}
              </span>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3 sm:min-w-[20rem] sm:flex-none sm:max-w-xl">
            <div className="relative min-w-[12rem] flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-text-muted)]"
                aria-hidden
              />
              <input
                value={brandDraft}
                onChange={(e) => setBrandDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setBrandQuery(brandDraft);
                    setTableFocus(true);
                  }
                }}
                placeholder="Quick brand filter..."
                className="ui-input h-10 w-full min-w-0 pl-9 text-[10px] font-black uppercase tracking-widest"
              />
            </div>
             <button
               type="button"
               onClick={() => void refresh()}
               className="rounded-xl bg-app-accent px-5 py-2.5 text-[10px] font-black uppercase tracking-[0.2em] text-white shadow-lg shadow-black/15 hover:brightness-110 active:scale-95 transition-all"
             >
               Force Sync
             </button>
          </div>
        </div>
      </footer>

      {adjustRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2.5rem] bg-app-surface p-8 shadow-2xl ring-1 ring-black/5">
            <div className="mb-6 flex flex-col items-center text-center">
              <div className="mb-4 h-14 w-14 rounded-2xl bg-app-accent flex items-center justify-center text-white shadow-lg shadow-app-accent/30">
                <LayoutGrid size={28} />
              </div>
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted mb-1">
                Stock Adjustment
              </p>
              <h3 className="text-xl font-black italic tracking-tighter text-app-text uppercase">
                {adjustRow.variation_label ?? "Standard Variant"}
              </h3>
              <p className="font-mono text-[10px] font-bold text-app-text-muted">
                {adjustRow.sku}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => void applyStockDelta(adjustRow, -1)}
                className="flex flex-col items-center justify-center rounded-3xl border-2 border-app-border bg-app-surface-2 py-6 transition-all hover:border-app-border hover:bg-app-surface"
              >
                <span className="text-3xl font-black text-app-text">-1</span>
                <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mt-1">
                  Decrement
                </span>
              </button>
              <button
                type="button"
                onClick={() => void applyStockDelta(adjustRow, 1)}
                className="flex flex-col items-center justify-center rounded-3xl border-2 border-emerald-500/30 bg-emerald-50 py-6 transition-all hover:border-emerald-500/50 hover:bg-app-surface"
              >
                <span className="text-3xl font-black text-emerald-600">+1</span>
                <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600/60 mt-1">
                  Increment
                </span>
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setMaintenanceTarget({ variantId: adjustRow.variant_id, sku: adjustRow.sku, type: "damaged" })}
                className="flex-1 rounded-xl border border-red-200 bg-red-50 py-3 text-[9px] font-black uppercase tracking-widest text-red-600 hover:bg-red-100"
              >
                Damage…
              </button>
              <button
                type="button"
                onClick={() => setMaintenanceTarget({ variantId: adjustRow.variant_id, sku: adjustRow.sku, type: "return_to_vendor" })}
                className="flex-1 rounded-xl border border-app-accent/30 bg-app-accent/5 py-3 text-[9px] font-black uppercase tracking-widest text-app-accent hover:bg-app-accent/10"
              >
                RTV…
              </button>
            </div>

            <button
              type="button"
              onClick={() => setAdjustRow(null)}
              className="mt-6 w-full rounded-2xl bg-app-surface-2 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted hover:bg-app-border/40 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {maintenanceTarget && (
        <div className="ui-overlay-backdrop flex items-center justify-center p-4">
          <div className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300">
            <div className="ui-modal-header flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`rounded-xl border p-2 ${maintenanceTarget.type === 'damaged' ? "border-red-500/20 bg-red-500/5" : "border-app-accent/20 bg-app-accent/5"}`}>
                   <Printer className={maintenanceTarget.type === 'damaged' ? "text-red-500" : "text-app-accent"} size={22} />
                </div>
                <h3 className="text-lg font-black italic uppercase tracking-tight text-app-text">
                  {maintenanceTarget.type === 'damaged' ? "Mark as Damaged" : "Return to Vendor"}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeMaintenance}
                className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-all"
              >
                <X size={20} />
              </button>
            </div>

            <div className="ui-modal-body space-y-4 py-6">
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-3 text-app-text">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Target SKU</p>
                <p className="mt-1 font-mono text-sm font-bold">{maintenanceTarget.sku}</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Quantity to Remove
                </label>
                <input
                  type="number"
                  min="1"
                  value={maintenanceQty}
                  onChange={(e) => setMaintenanceQty(e.target.value)}
                  className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2.5 font-bold text-app-text outline-none ring-app-accent focus:ring-2"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Maintenance Note
                </label>
                <textarea
                  rows={3}
                  value={maintenanceNote}
                  onChange={(e) => setMaintenanceNote(e.target.value)}
                  placeholder={maintenanceTarget.type === 'damaged' ? "Describe damage (e.g. Broken zipper, stained lapel)" : "Reason for return (e.g. Vendor defect, surplus RTV)"}
                  className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2.5 text-sm font-medium text-app-text outline-none ring-app-accent focus:ring-2"
                />
              </div>
            </div>

            <div className="ui-modal-footer flex gap-3">
              <button type="button" onClick={closeMaintenance} className="ui-btn-secondary flex-1">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleMaintenanceSubmit}
                className={`flex-1 rounded-xl border-b-4 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all active:translate-y-1 active:border-b-0 ${maintenanceTarget.type === 'damaged' ? "bg-red-600 border-red-800" : "bg-app-accent border-app-accent/80"}`}
              >
                Execute Adjustment
              </button>
            </div>
          </div>
        </div>
      )}

      {scanToast && (
        <div className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-6 py-4 rounded-full shadow-2xl transition-all animate-in slide-in-from-bottom-4 duration-300 ${
          scanToast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {scanToast.type === 'success' ? <Check size={20} /> : <SlidersHorizontal size={20} />}
          <span className="text-xs font-black uppercase tracking-widest">{scanToast.message}</span>
        </div>
      )}

      {hubProductId && (
        <ProductHubDrawer
          isOpen={!!hubProductId}
          productId={hubProductId}
          seedTitle={hubSeedTitle}
          baseUrl={baseUrl}
          onClose={() => {
             setHubProductId(null);
             void refresh();
          }}
        />
      )}

      <ConfirmationModal
        isOpen={showArchiveConfirm}
        onClose={() => setShowArchiveConfirm(false)}
        onConfirm={executeBulkArchive}
        title="Archive Products"
        message={`Are you sure you want to archive ${selectedProductIds.length} product(s)? Their variants will be hidden from the active catalog and register. This action is auditable but permanent.`}
        confirmLabel={isArchiving ? "Archiving..." : "Archive Templates"}
        variant="danger"
        loading={isArchiving}
      />
    </div>
  );
}
