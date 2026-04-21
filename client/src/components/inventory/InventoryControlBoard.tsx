import { getBaseUrl } from "../../lib/apiConfig";
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
  Search,
  SlidersHorizontal,
  X,
  MoreHorizontal,
  Check,
} from "lucide-react";
import ProductHubDrawer from "./ProductHubDrawer";
import InventoryBulkBar from "./InventoryBulkBar";
import { getInventoryTagPrintConfig, openInventoryTagsWindow } from "./labelPrint";
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

function InventoryTagPrintModal({
  product,
  onClose,
  onPrint,
}: {
  product: ProductListRow;
  onClose: () => void;
  onPrint: (quantities: Record<string, number>) => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(product.variant_rows.map((row) => [row.variant_id, 1])),
  );

  const totalTags = useMemo(
    () =>
      product.variant_rows.reduce(
        (sum, row) => sum + Math.max(0, quantities[row.variant_id] ?? 0),
        0,
      ),
    [product.variant_rows, quantities],
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-[2rem] border border-app-border bg-app-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-app-border/50 px-6 py-5">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
              Inventory Tags
            </p>
            <h3 className="mt-1 text-2xl font-black tracking-tight text-app-text">
              {product.product_name}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-app-text-muted transition-all hover:text-app-text"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-6 py-5">
          {product.variant_rows.map((row) => (
            <div
              key={row.variant_id}
              className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] items-center gap-3 rounded-2xl border border-app-border/60 bg-app-bg/20 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-base font-black text-app-text">
                  {row.variation_label ?? "Standard"}
                </p>
                <p className="mt-1 font-mono text-[12px] font-bold text-app-text-muted">
                  {row.sku}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                  In Stock
                </p>
                <p className="mt-1 text-xl font-black tracking-tight text-app-text">
                  {row.stock_on_hand}
                </p>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                  Tags
                </label>
                <input
                  type="number"
                  min="0"
                  value={quantities[row.variant_id] ?? 0}
                  onChange={(e) =>
                    setQuantities((prev) => ({
                      ...prev,
                      [row.variant_id]: Math.max(
                        0,
                        Number.parseInt(e.target.value || "0", 10) || 0,
                      ),
                    }))
                  }
                  className="mt-2 w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm font-black text-app-text outline-none focus:ring-2 focus:ring-app-accent/30"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-app-border/50 px-6 py-5">
          <p className="text-sm font-bold text-app-text-muted">
            {totalTags} tag{totalTags === 1 ? "" : "s"} ready to print
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-app-border bg-app-surface px-5 py-2.5 text-[11px] font-black uppercase tracking-[0.18em] text-app-text-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onPrint(quantities)}
              className="rounded-xl border-b-4 border-app-accent/80 bg-app-accent px-5 py-2.5 text-[11px] font-black uppercase tracking-[0.18em] text-white shadow-lg transition-all active:translate-y-1 active:border-b-0"
            >
              Print Inventory Tags
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface InventoryControlBoardProps {
  openProductHubProductId?: string | null;
  onProductHubDeepLinkConsumed?: () => void;
  surface?: "backoffice" | "pos";
}

export default function InventoryControlBoard({
  openProductHubProductId = null,
  onProductHubDeepLinkConsumed,
  surface = "backoffice",
}: InventoryControlBoardProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = getBaseUrl();
  const isPosSurface = surface === "pos";
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [boardRefreshing, setBoardRefreshing] = useState(true);
  const [oosLowOnly, setOosLowOnly] = useState(false);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [oosOnly, setOosOnly] = useState(false);
  const [negativeStockOnly, setNegativeStockOnly] = useState(false);
  const [clothingOnly, setClothingOnly] = useState(false);
  const [unlabeledOnly, setUnlabeledOnly] = useState(false);
  const [highValueOnly, setHighValueOnly] = useState(false);
  const [quickPick, setQuickPick] = useState<QuickPick>(null);
  const [categoryId, setCategoryId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [groupByPrimaryVendor, setGroupByPrimaryVendor] = useState(false);
  const [webOnly, setWebOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [hubProductId, setHubProductId] = useState<string | null>(null);
  const [hubSeedTitle, setHubSeedTitle] = useState("");
  const [printTarget, setPrintTarget] = useState<ProductListRow | null>(null);
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
        // Global stats handled by parent workspace
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
        category_name: first.category_name,
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

  const visibleProductRows = useMemo(() => {
    return productRows.filter((row) => {
      if (inStockOnly && row.stock_on_hand <= 0) return false;
      return true;
    });
  }, [inStockOnly, productRows]);

  const groupedRowsByVendor = useMemo(() => {
    if (!groupByPrimaryVendor) return null;
    const m = new Map<string, ProductListRow[]>();
    for (const r of visibleProductRows) {
      const k = r.primary_vendor_name?.trim() || "— No primary vendor —";
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleProductRows, groupByPrimaryVendor]);

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
      const data = (await res.json()) as {
        variant_id: string;
        product_name: string;
        sku?: string;
      };
      const matchedRow = rows.find((row) => row.variant_id === data.variant_id);
      const nextSearch = matchedRow?.sku ?? data.sku ?? sku;
      setSearchInput(nextSearch);
      setDebouncedSearch(nextSearch);
      playScanSuccess();
      setScanToast({
        type: 'success',
        message: `${data.product_name} matched. Open Receiving Bay to post stock.`,
      });
      if (scanToastTimer.current) clearTimeout(scanToastTimer.current);
      scanToastTimer.current = setTimeout(() => setScanToast(null), 2000);
    } catch (e: unknown) {
      playScanError();
      setScanToast({ type: 'error', message: e instanceof Error ? e.message : 'Scan lookup failed' });
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
    openInventoryTagsWindow(
      chosenVariants.map((r) => ({
        sku: r.sku,
        productName: r.product_name,
        variation: r.variation_label ?? "Standard",
        brand: r.brand,
        price: money(r.retail_price),
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
      toast(err.error ?? "Could not mark inventory tags printed", "error");
    } else {
      toast("Inventory tags queued for printing", "success");
    }
    setSelected(new Set());
    await refreshBoard();
  };

  const printInventoryTags = useCallback(
    async (items: BoardRow[], quantities?: Record<string, number>) => {
      const expandedItems = items.flatMap((row) => {
        const qty = Math.max(0, quantities?.[row.variant_id] ?? 1);
        return Array.from({ length: qty }, () => ({
          sku: row.sku,
          productName: row.product_name,
          variation: row.variation_label ?? "Standard",
          brand: row.brand,
          price: money(row.retail_price),
        }));
      });
      if (expandedItems.length === 0) {
        toast("Choose at least one tag to print", "info");
        return;
      }
      openInventoryTagsWindow(expandedItems, getInventoryTagPrintConfig());
      const res = await fetch(
        `${baseUrl}/api/products/variants/bulk-mark-shelf-labeled`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...apiAuth(),
          },
          body: JSON.stringify({
            variant_ids: items.map((row) => row.variant_id),
          }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Could not mark inventory tags printed", "error");
        return;
      }
      toast(
        expandedItems.length === 1
          ? "Inventory tag sent to print"
          : `${expandedItems.length} inventory tags sent to print`,
        "success",
      );
      setPrintTarget(null);
      await refreshBoard();
    },
    [apiAuth, baseUrl, refreshBoard, toast],
  );

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
        className={`group relative flex items-center gap-4 px-6 py-4 transition-all duration-300 border-b border-app-border/10 ${
          focused
            ? "bg-app-accent/5 ring-1 ring-inset ring-app-accent/20 backdrop-blur-md"
            : isSelected
              ? "bg-app-accent/10 backdrop-blur-md"
              : "bg-transparent hover:bg-app-surface/30 hover:backdrop-blur-sm"
        }`}
      >
        {/* Selection Indicator */}
        {!isPosSurface && (
          <div className="flex shrink-0 items-center justify-center">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleSelect(row.product_id)}
              className="h-4 w-4 rounded-lg border-app-border bg-app-surface text-app-accent transition-all focus:ring-app-accent shadow-sm"
            />
          </div>
        )}

        {/* Product Identity Cluster */}
        <div className="flex min-w-0 flex-[3.9] items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 shadow-inner group-hover:scale-105 transition-transform ${oos ? 'opacity-40 grayscale' : ''}`}>
             {row.is_clothing_footwear ? <Gem size={16} className="text-violet-500" /> : <Box size={16} className="text-app-text-muted" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="truncate text-[1rem] font-black tracking-tight text-app-text leading-none group-hover:text-app-accent transition-colors">
                {row.product_name}
              </h3>
              {highValue && (
                <span className="flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[7px] font-black uppercase tracking-widest text-amber-600 border border-amber-500/20">
                  <Gem size={7} /> ASSET
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-[12px] font-black text-app-text-muted">
                {primaryVariant?.sku || "NO SKU"}
              </span>
              <span className="text-[12px] font-semibold text-app-text-muted">
                {primaryVariant?.variation_label ?? `${row.variant_count} variations`}
              </span>
              <span className="text-[10px] font-black uppercase tracking-tighter text-app-text-muted/70">
                {row.category_name || "Misc"}
              </span>
              {row.primary_vendor_name ? (
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-app-text-muted/50">
                  {row.primary_vendor_name}
                </span>
              ) : null}
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
        <div className="flex shrink-0 items-center justify-end min-w-[120px]">
          <div className={`flex items-center gap-1 transition-all duration-300 ${focused || 'opacity-0 translate-x-4 group-hover:opacity-100 group-hover:translate-x-0'}`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPrintTarget(row);
              }}
              className="p-1.5 rounded-xl border border-app-border bg-app-surface text-app-text-muted hover:text-app-accent hover:border-app-accent transition-all"
              title="Print inventory tags"
            >
              <Printer size={14} />
            </button>
            {!isPosSurface && (
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
            )}
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
    <div className="flex flex-col space-y-8 animate-in fade-in duration-500">
      <div className="shrink-0 space-y-4">
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <div className="relative min-w-0 flex-1 group">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted transition-colors group-focus-within:text-app-accent"
              size={18}
            />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search product, SKU, or variation..."
              className="w-full h-12 bg-app-surface/20 border border-app-border/40 rounded-2xl pl-12 pr-4 text-sm font-semibold placeholder:text-app-text-muted/50 focus:outline-none focus:ring-2 focus:ring-app-accent/50 focus:border-app-accent transition-all"
              aria-busy={boardRefreshing}
            />
          </div>
          {!isPosSurface ? (
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex items-center gap-1 rounded-2xl border border-app-border/40 bg-app-surface/20 p-1 backdrop-blur-md">
                <button
                  type="button"
                  onClick={() => setGroupByPrimaryVendor(!groupByPrimaryVendor)}
                  className={`rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                    groupByPrimaryVendor
                      ? "bg-app-accent text-white shadow-lg"
                      : "text-app-text-muted hover:text-app-text hover:bg-app-surface/40"
                  }`}
                >
                  Stack by Vendor
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="h-11 min-w-[14rem] rounded-2xl border border-app-border/40 bg-app-surface/20 px-4 text-[11px] font-black uppercase tracking-[0.16em] text-app-text outline-none transition-all focus:border-app-accent focus:ring-2 focus:ring-app-accent/20"
          >
            <option value="">All vendors</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
          <select
            value={categoryId}
            onChange={(e) => {
              setQuickPick(null);
              setCategoryId(e.target.value);
            }}
            className="h-11 min-w-[14rem] rounded-2xl border border-app-border/40 bg-app-surface/20 px-4 text-[11px] font-black uppercase tracking-[0.16em] text-app-text outline-none transition-all focus:border-app-accent focus:ring-2 focus:ring-app-accent/20"
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          {discoveryBtn(inStockOnly, "In Stock", () =>
            setInStockOnly(!inStockOnly),
          )}
          {discoveryBtn(oosLowOnly, "Low Stock (≤2)", () =>
            setOosLowOnly(!oosLowOnly),
          )}
          {discoveryBtn(oosOnly, "Out of Stock", () =>
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
          {inStockOnly && (
            <FilterChip label="In Stock" onRemove={() => setInStockOnly(false)} />
          )}
          {webOnly && (
            <FilterChip label="On web" onRemove={() => setWebOnly(false)} />
          )}
          {oosLowOnly && (
            <FilterChip label="Low Stock" onRemove={() => setOosLowOnly(false)} />
          )}
          {oosOnly && (
            <FilterChip
              label="Out of Stock"
              onRemove={() => setOosOnly(false)}
            />
          )}
          {negativeStockOnly && (
            <FilterChip label="Negative Stock" onRemove={() => setNegativeStockOnly(false)} />
          )}
        </div>
      </div>

      <div className="flex flex-col border border-app-border/40 bg-app-bg/10">
        <div 
          className="min-w-[1000px] outline-none"
          onFocus={() => setTableFocus(true)}
          onBlur={() => setTableFocus(false)}
          onKeyDown={onTableKeyDown}
          tabIndex={0}
        >
          <div className="flex flex-col gap-px bg-app-border/20">
            {groupByPrimaryVendor && groupedRowsByVendor ? (
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
              visibleProductRows.map((item, idx) => renderRow(item, idx))
            )}

            {!boardRefreshing && visibleProductRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-32 text-app-text-muted">
                <Search size={48} className="mb-4 opacity-20" />
                <p className="text-sm font-black uppercase tracking-widest opacity-60">
                  No inventory matches found
                </p>
              </div>
            ) : null}

            {boardHasMore && visibleProductRows.length > 0 ? (
              <div className="flex justify-center border-t border-app-border py-8 bg-app-surface/30">
                <button
                  type="button"
                  disabled={boardLoadingMore}
                  onClick={() => void loadMoreBoard()}
                  className="rounded-2xl border border-app-border bg-app-surface px-10 py-4 text-xs font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:shadow-2xl active:scale-95 disabled:opacity-50 shadow-xl"
                >
                  {boardLoadingMore ? "Loading Inventory..." : "Load More Inventory"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Standardized Bulk Action Bar */}
      {!isPosSurface && selected.size > 0 && (
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

      {/* Modern Filter Discovery Footer (Replacing legacy fixed stats) */}
      {!isPosSurface && (
      <div className="border-t border-app-border/30 bg-app-surface/20 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => void refresh()}
              className="h-10 px-6 rounded-xl bg-app-accent/90 text-[10px] font-black uppercase tracking-widest text-white shadow-lg hover:brightness-110 active:scale-95 transition-all backdrop-blur-md"
            >
              Refresh Inventory
            </button>
          </div>

          <div className="flex items-center gap-1 opacity-40 hover:opacity-100 transition-opacity">
            <span className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
              Inventory Synced Locally
            </span>
            <div className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse ml-2" />
          </div>
        </div>
      </div>
      )}

      {!isPosSurface && adjustRow && (
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

      {!isPosSurface && maintenanceTarget && (
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

      {printTarget && (
        <InventoryTagPrintModal
          product={printTarget}
          onClose={() => setPrintTarget(null)}
          onPrint={(quantities) =>
            void printInventoryTags(printTarget.variant_rows, quantities)
          }
        />
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
