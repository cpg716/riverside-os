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
  Check,
  Building2,
  FolderTree,
  LayoutGrid,
  Printer,
  Loader2,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import ProductHubDrawer from "./ProductHubDrawer";
import InventoryBulkBar from "./InventoryBulkBar";
import { openSingleShelfLabel, openShelfLabelsWindow } from "./labelPrint";
import { apiUrl } from "../../lib/apiUrl";
import { useScanner } from "../../hooks/useScanner";
import { playScanSuccess, playScanError } from "../../lib/scanSounds";
import { useToast } from "../ui/ToastProvider";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  centsToFixed2,
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
  variant_rows: BoardRow[];
  /** Sum of variant available_stock (walk-in + web alloc). */
  available_stock_total: number;
  web_published_count: number;
}

function money(v: string) {
  return formatUsdFromCents(parseMoneyToCents(v || "0"));
}

function TemplateMoneyEdit({
  productId,
  field,
  value,
  baseUrl,
  onSaved,
  muted,
  toast,
}: {
  productId: string;
  field: "base_retail_price" | "base_cost";
  value: string;
  baseUrl: string;
  onSaved: () => void;
  muted?: boolean;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = async () => {
    setOpen(false);
    const cents = parseMoneyToCents(draft);
    const n = cents / 100;
    if (!Number.isFinite(n) || n < 0) {
      setDraft(value);
      return;
    }
    const q = Number(centsToFixed2(cents));
    const body =
      field === "base_retail_price"
        ? { base_retail_price: q }
        : { base_cost: q };
    const res = await fetch(`${baseUrl}/api/products/${productId}/model`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...mergedPosStaffHeaders(backofficeHeaders),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "Update failed", "error");
      setDraft(value);
      return;
    }
    onSaved();
  };

  if (!open) {
    return (
      <button
        type="button"
        title="Template base — click to edit"
        onClick={() => setOpen(true)}
        className={`rounded px-1 py-0.5 text-right font-mono text-sm tabular-nums outline-none ring-app-accent focus-visible:ring-2 ${
          muted ? "text-app-text-muted" : "font-bold text-app-text"
        }`}
      >
        {money(value)}
      </button>
    );
  }

  return (
    <input
      autoFocus
      className="ui-input h-8 w-24 min-w-0 px-1 py-0.5 text-right font-mono text-sm tabular-nums"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          setOpen(false);
        }
      }}
    />
  );
}

function TemplateCategorySelect({
  productId,
  categoryId,
  categories,
  baseUrl,
  onSaved,
  toast,
}: {
  productId: string;
  categoryId: string | null;
  categories: Category[];
  baseUrl: string;
  onSaved: () => void;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  return (
    <select
      value={categoryId ?? ""}
      onChange={async (e) => {
        const v = e.target.value;
        const body = v
          ? { category_id: v }
          : { clear_category_id: true };
        const res = await fetch(`${baseUrl}/api/products/${productId}/model`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...mergedPosStaffHeaders(backofficeHeaders),
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          toast(err.error ?? "Category update failed", "error");
          return;
        }
        onSaved();
      }}
      className="ui-input max-w-[160px] min-w-0 py-1 pl-2 pr-7 text-[10px] font-bold uppercase tracking-tight"
    >
      <option value="">Uncategorized</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full px-1 text-app-text-muted hover:bg-app-border/40 hover:text-app-text"
        aria-label={`Remove filter ${label}`}
      >
        ×
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

  useEffect(() => {
    const raw = openProductHubProductId?.trim();
    if (!raw) return;
    setHubProductId(raw);
    setHubSeedTitle("Product");
    onProductHubDeepLinkConsumed?.();
  }, [openProductHubProductId, onProductHubDeepLinkConsumed]);
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

  const toggleSelect = (productId: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(productId)) n.delete(productId);
      else n.add(productId);
      return n;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === productRows.length && productRows.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(productRows.map((r) => r.product_id)));
    }
  };

  const openProductHub = useCallback((row: ProductListRow) => {
    setHubProductId(row.product_id);
    setHubSeedTitle(
      `${row.brand ? `${row.brand} · ` : ""}${row.product_name}`,
    );
  }, []);

  const bumpVariantStock = async (
    variantId: string,
    quantityDelta: number,
  ): Promise<void> => {
    const res = await fetch(
      `${baseUrl}/api/products/variants/${variantId}/stock-adjust`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity_delta: quantityDelta }),
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

  const applyStockDelta = async (row: BoardRow, quantityDelta: number) => {
    try {
      await bumpVariantStock(row.variant_id, quantityDelta);
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
  };

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
      className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
        active
          ? "border-app-accent/60 bg-app-accent/10 text-app-text shadow-sm shadow-app-accent/15"
          : "border-app-border bg-app-surface text-app-text-muted hover:border-app-input-border"
      }`}
    >
      {label}
    </button>
  );

  const renderPriceRange = (min: number, max: number) =>
    min === max
      ? formatUsdFromCents(parseMoneyToCents(min))
      : `${formatUsdFromCents(parseMoneyToCents(min))} - ${formatUsdFromCents(parseMoneyToCents(max))}`;

  const renderRow = (row: ProductListRow) => {
    const oos = row.stock_on_hand <= 0;
    const low = row.stock_on_hand > 0 && row.stock_on_hand <= 2;
    const singleVariant = row.variant_count === 1;
    const primaryVariant = singleVariant ? row.variant_rows[0] ?? null : null;
    return (
      <tr
        key={row.product_id}
        className="group relative transition-colors hover:bg-app-surface-2/90"
      >
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={selected.has(row.product_id)}
            onChange={() => toggleSelect(row.product_id)}
            className="h-4 w-4 rounded border-app-input-border text-app-accent"
            aria-label={`Select ${row.product_name}`}
          />
        </td>
        <td className="px-3 py-2">
          <button
            type="button"
            onClick={() => openProductHub(row)}
            className="text-left text-sm font-black uppercase tracking-tight text-app-text transition-colors hover:text-app-accent"
          >
            {(row.brand ? `${row.brand} · ` : "") + row.product_name}
          </button>
          <div className="text-[9px] font-bold uppercase text-app-text-muted">
            {singleVariant && primaryVariant ? (
              <>
                {primaryVariant.variation_label ?? "Variant"} •{" "}
                <span className="font-mono">{primaryVariant.sku}</span>
              </>
            ) : (
              <>{row.variant_count} variants in matrix</>
            )}
            {row.unlabeled_count > 0 ? (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-black text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                {row.unlabeled_count} need label
              </span>
            ) : null}
          </div>
          {row.primary_vendor_name ? (
            <div className="mt-0 text-[9px] font-semibold normal-case tracking-tight text-violet-600/90 dark:text-violet-300/90">
              Primary vendor · {row.primary_vendor_name}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2">
          <TemplateCategorySelect
            productId={row.product_id}
            categoryId={row.category_id}
            categories={categories}
            baseUrl={baseUrl}
            onSaved={() => void refreshBoard()}
            toast={toast}
          />
          {row.is_clothing_footwear ? (
            <div className="mt-1 text-[9px] font-black uppercase tracking-widest text-emerald-600">
              Clothing tax exempt
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2 text-center">
          <span
            className={`font-black ${
              oos
                ? "text-red-500"
                : low
                  ? "text-amber-500"
                  : "text-app-text"
            }`}
          >
            {row.stock_on_hand}
          </span>
          <div className="mt-0.5 text-[9px] font-bold uppercase tracking-tight text-app-text-muted">
            Avail {row.available_stock_total}
          </div>
        </td>
        <td className="px-3 py-2 text-center">
          <span
            className={`text-[10px] font-black uppercase tracking-tight ${
              row.web_published_count > 0
                ? "text-emerald-600"
                : "text-app-text-muted"
            }`}
          >
            {row.web_published_count}/{row.variant_count}
          </span>
          <div className="text-[9px] font-bold uppercase text-app-text-muted">
            online
          </div>
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex flex-col items-end gap-0">
            <span className="font-mono text-sm font-semibold tabular-nums text-app-text">
              {renderPriceRange(row.retail_min, row.retail_max)}
            </span>
            <div className="mt-0.5 flex items-center justify-end gap-2 text-[9px] text-app-text-muted">
              <span className="shrink-0 font-bold uppercase tracking-tight">Base</span>
              <TemplateMoneyEdit
                productId={row.product_id}
                field="base_retail_price"
                value={row.base_retail_price}
                baseUrl={baseUrl}
                onSaved={() => void refreshBoard()}
                muted
                toast={toast}
              />
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex flex-col items-end gap-0">
            <span className="font-mono text-sm tabular-nums text-app-text-muted">
              {renderPriceRange(row.cost_min, row.cost_max)}
            </span>
            <div className="mt-0.5 flex items-center justify-end gap-2 text-[9px] text-app-text-muted">
              <span className="shrink-0 font-bold uppercase tracking-tight">Base</span>
              <TemplateMoneyEdit
                productId={row.product_id}
                field="base_cost"
                value={row.base_cost}
                baseUrl={baseUrl}
                onSaved={() => void refreshBoard()}
                muted
                toast={toast}
              />
            </div>
          </div>
        </td>
        <td className="relative px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-2">
            <div className="pointer-events-none opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100">
              <div className="flex flex-col gap-1 rounded-l-xl border border-app-border/90 bg-app-surface/95 py-2 pl-2 pr-3 shadow-lg backdrop-blur-md">
                <button
                  type="button"
                  title="Print shelf label"
                  onClick={() =>
                    singleVariant && primaryVariant
                      ? openSingleShelfLabel({
                          sku: primaryVariant.sku,
                          productName: row.product_name,
                          variation: primaryVariant.variation_label ?? "Standard",
                        })
                      : openShelfLabelsWindow(
                          row.variant_rows.map((v) => ({
                            sku: v.sku,
                            productName: row.product_name,
                            variation: v.variation_label ?? "Standard",
                          })),
                        )
                  }
                  className="flex items-center gap-2 rounded-lg px-1 py-1 text-left text-[10px] font-bold uppercase tracking-[0.15em] text-app-text-muted transition-colors hover:bg-app-surface-2"
                >
                  <Printer size={14} className="shrink-0" aria-hidden />
                  {singleVariant ? "Print label" : "Print all labels"}
                </button>
                <button
                  type="button"
                  title={singleVariant ? "Quick stock adjust" : "Open product hub"}
                  onClick={() =>
                    singleVariant && primaryVariant
                      ? setAdjustRow(primaryVariant)
                      : openProductHub(row)
                  }
                  className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[10px] font-black uppercase tracking-[0.15em] text-app-accent transition-colors hover:bg-app-accent/10"
                >
                  {singleVariant ? (
                    <LayoutGrid size={14} className="shrink-0" aria-hidden />
                  ) : (
                    <SlidersHorizontal size={14} className="shrink-0" aria-hidden />
                  )}
                  {singleVariant ? "Adjust" : "Review models"}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => openProductHub(row)}
              className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text-muted"
              aria-label={`Open Hub for ${row.product_name}`}
            >
              <SlidersHorizontal size={18} />
            </button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-surface-2 selection:bg-app-accent/20 selection:text-app-text">
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
          {discoveryBtn(oosLowOnly, "Stock Outs", () =>
            setOosLowOnly(!oosLowOnly),
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
          className="flex-1 overflow-auto no-scrollbar"
          onFocus={() => setTableFocus(true)}
          onBlur={() => setTableFocus(false)}
          onKeyDown={onTableKeyDown}
          tabIndex={0}
        >
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-20">
              <tr className="bg-app-surface-2 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted shadow-sm backdrop-blur-md">
                <th className="border-b border-app-border px-3 py-2.5 text-left">
                  <input
                    type="checkbox"
                    checked={
                      selected.size === productRows.length &&
                      productRows.length > 0
                    }
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-app-input-border text-app-accent"
                    aria-label="Select all products"
                  />
                </th>
                <th className="border-b border-app-border px-3 py-2.5 text-left">
                  <div className="flex items-center gap-2">
                    <LayoutGrid size={14} className="text-app-text-muted" />
                    Product Description
                  </div>
                </th>
                <th className="border-b border-app-border px-3 py-2.5 text-left">
                  <div className="flex items-center gap-2">
                    <FolderTree size={14} className="text-app-text-muted" />
                    Categorization
                  </div>
                </th>
                <th className="border-b border-app-border px-3 py-2.5 text-center">
                  SOH
                </th>
                <th className="border-b border-app-border px-3 py-2.5 text-center">
                  Web
                </th>
                <th className="border-b border-app-border px-3 py-2.5 text-right">
                  Retail
                </th>
                <th className="border-b border-app-border px-3 py-2.5 text-right">
                  Cost
                </th>
                <th className="border-b border-app-border px-3 py-2.5 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border bg-app-surface">
              {groupByBrand && groupedRows ? (
                groupedRows.map(([brand, items]) => {
                  const stats = groupStats(items);
                  return (
                    <Fragment key={brand}>
                      <tr className="bg-app-surface-2/50">
                        <td
                          colSpan={8}
                          className="border-b border-app-border px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-black uppercase tracking-tight text-app-text italic">
                                {brand}
                              </span>
                              <span className="rounded-full bg-app-border/50 px-2 py-0.5 text-[9px] font-black text-app-text-muted">
                                {items.length} Product Templates
                              </span>
                            </div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                              {stats.units} units ·{" "}
                              {formatUsdFromCents(parseMoneyToCents(stats.value))}{" "}
                              asset value
                            </div>
                          </div>
                        </td>
                      </tr>
                      {items.map(renderRow)}
                    </Fragment>
                  );
                })
              ) : groupByPrimaryVendor && groupedRowsByVendor ? (
                groupedRowsByVendor.map(([v, items]) => {
                  const stats = groupStats(items);
                  return (
                    <Fragment key={v}>
                      <tr className="bg-violet-50/30">
                        <td
                          colSpan={8}
                          className="border-b border-violet-100/50 px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <Building2
                                size={16}
                                className="text-violet-400"
                              />
                              <span className="text-sm font-black uppercase tracking-tight text-violet-900 italic">
                                {v}
                              </span>
                              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[9px] font-black text-violet-500">
                                {items.length} Templates
                              </span>
                            </div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-violet-400">
                              {stats.units} units ·{" "}
                              {formatUsdFromCents(parseMoneyToCents(stats.value))}{" "}
                              asset value
                            </div>
                          </div>
                        </td>
                      </tr>
                      {items.map(renderRow)}
                    </Fragment>
                  );
                })
              ) : (
                productRows.map(renderRow)
              )}
            </tbody>
          </table>
          {boardHasMore && productRows.length > 0 ? (
            <div className="flex justify-center border-t border-app-border py-4">
              <button
                type="button"
                disabled={boardLoadingMore}
                onClick={() => void loadMoreBoard()}
                className="rounded-xl border border-app-border bg-app-surface-2 px-6 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-border/25 disabled:opacity-50"
              >
                {boardLoadingMore ? "Loading…" : "Load more SKUs"}
              </button>
              <span className="sr-only">
                Appends the next {boardPageLimit} variant rows with the same filters
              </span>
            </div>
          ) : null}
          {!boardRefreshing && productRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-20 text-app-text-muted">
              <Search size={48} className="mb-4 opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest opacity-60">
                No inventory matches found
              </p>
            </div>
          ) : null}
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
              <h3 className="text-xl font-black italic tracking-tighter text-app-text uppercase italic">
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
