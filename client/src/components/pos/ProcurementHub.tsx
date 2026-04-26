import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Package,
  Search,
  Plus,
  ClipboardList,
  TrendingUp,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import { parseMoney, formatMoney } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

interface BoardRow {
  variant_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  brand: string | null;
  variation_label: string | null;
  category_name: string | null;
  stock_on_hand: number;
  retail_price: string;
}

interface Variant {
  id: string;
  sku: string;
  vendor_sku?: string;
  name: string;
  qty_on_hand: number;
  qty_on_order: number;
  retail_price: string;
}

interface Product {
  id: string;
  name: string;
  image_url?: string;
  category?: string;
  variants: Variant[];
}

interface ProcurementHubProps {
  onAddItemToCart: (sku: string) => void;
}

const PAGE_SIZE = 120;

/** Match register variant modal ordering — sizes before colors / other labels. */
const SIZE_ORDER: Record<string, number> = {
  OS: 0,
  ONESIZE: 0,
  "ONE SIZE": 0,
  XXS: 5,
  XS: 10,
  S: 20,
  SMALL: 20,
  M: 30,
  MEDIUM: 30,
  L: 40,
  LARGE: 40,
  XL: 50,
  XXL: 60,
  "2XL": 60,
  "3XL": 70,
  "4XL": 80,
  "5XL": 90,
};

function variantSortScore(label: string): number {
  const upper = label.toUpperCase().trim();
  if (SIZE_ORDER[upper] !== undefined) return SIZE_ORDER[upper]!;
  const numericMatch = label.match(/^(\d+(\.\d+)?)/);
  if (numericMatch) return 1000 + parseFloat(numericMatch[1]!);
  return 5000;
}

function sortVariantsForPicker(variants: Variant[]): Variant[] {
  return [...variants].sort((a, b) => {
    const d = variantSortScore(a.name) - variantSortScore(b.name);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });
}

function summarizeProduct(p: Product): {
  variantCount: number;
  priceLabel: string;
  stockTotal: number;
} {
  const variantCount = p.variants.length;
  const amounts = p.variants.map((v) => parseMoney(v.retail_price));
  const minP = Math.min(...amounts);
  const maxP = Math.max(...amounts);
  const priceLabel =
    variantCount <= 1 || minP === maxP
      ? `$${formatMoney(minP)}`
      : `From $${formatMoney(minP)}`;
  const stockTotal = p.variants.reduce((s, v) => s + v.qty_on_hand, 0);
  return { variantCount, priceLabel, stockTotal };
}

function boardRowsToProducts(rows: BoardRow[]): Product[] {
  const byProduct = new Map<string, BoardRow[]>();
  for (const r of rows) {
    const bucket = byProduct.get(r.product_id) ?? [];
    bucket.push(r);
    byProduct.set(r.product_id, bucket);
  }
  return [...byProduct.values()].map((variants) => {
    const first = variants[0]!;
    return {
      id: first.product_id,
      name: first.brand?.trim()
        ? `${first.brand.trim()} · ${first.product_name}`
        : first.product_name,
      category: first.category_name ?? undefined,
      variants: variants.map((r) => ({
        id: r.variant_id,
        sku: r.sku,
        name: r.variation_label?.trim()
          ? r.variation_label
          : r.product_name,
        qty_on_hand: r.stock_on_hand,
        qty_on_order: 0,
        retail_price: r.retail_price,
      })),
    };
  });
}

export default function ProcurementHub({ onAddItemToCart }: ProcurementHubProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [search, setSearch] = useState("");
  const [boardRows, setBoardRows] = useState<BoardRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pickerProduct, setPickerProduct] = useState<Product | null>(null);

  const baseUrl = getBaseUrl();

  const products = useMemo(() => boardRowsToProducts(boardRows), [boardRows]);

  const pickerVariants = useMemo(
    () => (pickerProduct ? sortVariantsForPicker(pickerProduct.variants) : []),
    [pickerProduct],
  );

  useEffect(() => {
    setPickerProduct(null);
  }, [search]);

  useEffect(() => {
    if (!pickerProduct) return;
    if (!products.some((p) => p.id === pickerProduct.id)) {
      setPickerProduct(null);
    }
  }, [products, pickerProduct]);

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      const params = new URLSearchParams();
      const q = search.trim();
      if (q.length >= 2) params.set("search", q);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const res = await fetch(
        `${baseUrl}/api/products/control-board?${params.toString()}`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("fetch failed");
      const data = (await res.json()) as { rows: BoardRow[] };
      const rows = data.rows ?? [];
      if (append) {
        setBoardRows((prev) => [...prev, ...rows]);
      } else {
        setBoardRows(rows);
      }
      setHasMore(rows.length === PAGE_SIZE);
    },
    [baseUrl, search, apiAuth],
  );

  useEffect(() => {
    const t = search.trim();
    if (t.length === 1) {
      setBoardRows([]);
      setHasMore(false);
      return;
    }
    const run = async () => {
      setLoading(true);
      try {
        await fetchPage(0, false);
      } catch (err) {
        console.error("Procurement fetch error", err);
        setBoardRows([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    };
    const timer = setTimeout(() => void run(), 300);
    return () => clearTimeout(timer);
  }, [fetchPage, search]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      await fetchPage(boardRows.length, true);
    } catch (err) {
      console.error("Procurement load more error", err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, loading, fetchPage, boardRows.length]);

  const openPicker = (p: Product) => {
    if (p.variants.length === 1) {
      onAddItemToCart(p.variants[0]!.sku);
      return;
    }
    setPickerProduct(p);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app-bg p-4 touch-manipulation sm:p-6 lg:overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {!pickerProduct ? (
        <>
          <header className="mb-4 flex shrink-0 flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-lg font-black tracking-tight text-app-text sm:text-xl">
                Inventory
              </h2>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted sm:text-xs">
                Search products and stock
              </p>
            </div>
            <div className="ui-status-ok ui-pill flex shrink-0 items-center gap-1.5 px-3 py-2">
              <TrendingUp size={14} className="shrink-0" aria-hidden />
              <span className="text-[11px] font-bold sm:text-xs">Stock live</span>
            </div>
          </header>

          <div className="relative mb-4 shrink-0 sm:mb-6">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-app-text-muted"
              aria-hidden
            />
            <input
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Search (2+ characters)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ui-input min-h-[48px] w-full pl-11 text-base sm:text-sm"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-visible lg:overflow-y-auto no-scrollbar">
            <div className="flex flex-col gap-3 pb-4">
              {products.map((product) => {
                const { variantCount, priceLabel, stockTotal } =
                  summarizeProduct(product);
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => openPicker(product)}
                    className="ui-card flex w-full min-h-[72px] items-center gap-4 rounded-2xl border border-app-border p-4 text-left transition-colors hover:border-app-accent/40 active:bg-app-surface-2"
                  >
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-app-border bg-app-surface-2 sm:h-16 sm:w-16">
                      {product.image_url ? (
                        <img
                          src={product.image_url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-app-text-muted">
                          <Package size={22} aria-hidden />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="line-clamp-2 text-[15px] font-black leading-tight text-app-text sm:text-base">
                        {product.name}
                      </h3>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                        {product.category ?? "General"}
                      </p>
                      <p className="mt-2 text-xs font-semibold text-app-text-muted">
                        {variantCount === 1
                          ? `${priceLabel} · ${stockTotal} on hand · tap to add`
                          : `${variantCount} options · ${priceLabel} · ${stockTotal} on hand`}
                      </p>
                    </div>
                    <ChevronRight
                      className="size-6 shrink-0 text-app-text-muted"
                      aria-hidden
                    />
                  </button>
                );
              })}

              {hasMore ? (
                <button
                  type="button"
                  disabled={loadingMore || loading}
                  onClick={() => void loadMore()}
                  className="min-h-[48px] rounded-2xl border border-app-border py-3 text-xs font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface-2 disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more products"}
                </button>
              ) : null}

              {products.length === 0 && !loading && (
                <div className="flex min-h-[10rem] flex-col items-center justify-center rounded-2xl border border-dashed border-app-border px-4 text-center">
                  <Search className="mb-2 opacity-20" size={32} aria-hidden />
                  <p className="text-sm font-bold text-app-text-muted">
                    {search.trim().length > 0 && search.trim().length < 2
                      ? "Type at least 2 characters to search"
                      : "No products — try another search"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-visible lg:overflow-hidden">
          <div className="mb-3 flex shrink-0 items-start gap-2 sm:mb-4">
            <button
              type="button"
              onClick={() => setPickerProduct(null)}
              className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface text-app-text shadow-sm transition-colors hover:bg-app-surface-2 active:scale-[0.98]"
              aria-label="Back to product list"
            >
              <ChevronLeft className="size-6" aria-hidden />
            </button>
            <div className="min-w-0 flex-1 pt-1">
              <h2 className="text-base font-black leading-tight text-app-text sm:text-lg">
                {pickerProduct.name}
              </h2>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                {pickerProduct.category ?? "General"} · pick a size or option
              </p>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-visible pb-4 lg:overflow-y-auto no-scrollbar">
            <div className="flex flex-col gap-3">
              {pickerVariants.map((v) => (
                <div
                  key={v.id}
                  className="ui-card rounded-2xl border border-app-border p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-black text-app-text">
                        {v.name}
                      </p>
                      <p className="mt-1 font-mono text-xs text-app-text-muted">
                        {v.sku}
                      </p>
                      {v.vendor_sku ? (
                        <p className="mt-0.5 text-xs text-app-accent">
                          Vendor: {v.vendor_sku}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-3 text-sm font-bold">
                        <span
                          className={
                            v.qty_on_hand <= 0
                              ? "text-app-danger"
                              : "text-app-text"
                          }
                        >
                          {v.qty_on_hand} on hand
                        </span>
                        <span className="text-app-text-muted">
                          ${v.retail_price}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-row gap-2 sm:flex-col sm:items-stretch">
                      <button
                        type="button"
                        onClick={() => onAddItemToCart(v.sku)}
                        className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-black uppercase tracking-wide text-white shadow-[inset_0_-4px_0_0_rgb(6,95,70)] transition-transform active:scale-[0.98] sm:flex-initial sm:min-w-[160px]"
                      >
                        <Plus className="size-5 shrink-0" aria-hidden />
                        Add to sale
                      </button>
                      {v.qty_on_hand <= 0 ? (
                        <button
                          type="button"
                          className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-app-text-muted transition-colors hover:text-app-text active:scale-[0.98] sm:min-h-[44px] sm:w-full"
                          title="Request order"
                          aria-label="Request order for out of stock variant"
                        >
                          <ClipboardList className="size-5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
