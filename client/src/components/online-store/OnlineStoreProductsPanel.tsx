import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, ExternalLink, Package, Search } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { apiUrl } from "../../lib/apiUrl";
import { centsToFixed2, formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";

type MerchFilter = "all" | "on-web" | "draft" | "needs-setup" | "zero-stock";

interface BoardRow {
  variant_id: string;
  product_id: string;
  total_variant_count: number;
  sku: string;
  product_name: string;
  brand: string | null;
  catalog_handle?: string | null;
  variation_label: string | null;
  stock_on_hand: number;
  available_stock?: number;
  retail_price: string;
  web_published?: boolean;
  web_price_override?: string | null;
  web_gallery_order?: number;
}

interface BoardResponse {
  rows?: BoardRow[];
}

interface MerchProduct {
  product_id: string;
  product_name: string;
  brand: string | null;
  catalog_handle: string | null;
  variants: BoardRow[];
  web_published_count: number;
  available_stock_total: number;
}

interface OnlineStoreProductsPanelProps {
  baseUrl: string;
  onOpenInventoryProduct: (productId: string) => void;
  onRefreshSummary?: () => void;
}

const filterLabels: Record<MerchFilter, string> = {
  all: "All",
  "on-web": "On web",
  draft: "Draft",
  "needs-setup": "Needs setup",
  "zero-stock": "Zero stock",
};

function normalizeHandle(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function groupProducts(rows: BoardRow[]): MerchProduct[] {
  const grouped = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.product_id) ?? [];
    bucket.push(row);
    grouped.set(row.product_id, bucket);
  }
  return [...grouped.values()].map((variants) => {
    const first = variants[0]!;
    const available = variants.reduce(
      (sum, row) =>
        sum +
        (typeof row.available_stock === "number"
          ? row.available_stock
          : row.stock_on_hand),
      0,
    );
    return {
      product_id: first.product_id,
      product_name: first.product_name,
      brand: first.brand,
      catalog_handle: normalizeHandle(first.catalog_handle) || null,
      variants: [...variants].sort((a, b) => {
        const ao = a.web_gallery_order ?? 0;
        const bo = b.web_gallery_order ?? 0;
        return ao === bo ? a.sku.localeCompare(b.sku) : ao - bo;
      }),
      web_published_count: variants.filter((row) => row.web_published).length,
      available_stock_total: available,
    };
  });
}

function productMatchesFilter(product: MerchProduct, filter: MerchFilter): boolean {
  if (filter === "all") return true;
  if (filter === "on-web") return product.web_published_count > 0;
  if (filter === "draft") return product.web_published_count === 0;
  if (filter === "needs-setup") {
    return product.web_published_count > 0 && !product.catalog_handle;
  }
  if (filter === "zero-stock") {
    return product.web_published_count > 0 && product.available_stock_total <= 0;
  }
  return true;
}

function variantPriceLabel(row: BoardRow): string {
  const web = normalizeHandle(row.web_price_override);
  if (web) return `${formatUsdFromCents(parseMoneyToCents(web))} web`;
  return `${formatUsdFromCents(parseMoneyToCents(row.retail_price))} retail`;
}

export default function OnlineStoreProductsPanel({
  baseUrl,
  onOpenInventoryProduct,
  onRefreshSummary,
}: OnlineStoreProductsPanelProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MerchFilter>("all");
  const [handleDrafts, setHandleDrafts] = useState<Record<string, string>>({});
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [orderDrafts, setOrderDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const canEditProducts =
    hasPermission("catalog.edit") || hasPermission("settings.admin");

  const headers = useCallback(
    () =>
      ({
        "Content-Type": "application/json",
        ...mergedPosStaffHeaders(backofficeHeaders),
      }) as Record<string, string>,
    [backofficeHeaders],
  );

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "5000");
      if (query.trim()) params.set("search", query.trim());
      const res = await fetch(
        apiUrl(baseUrl, `/api/inventory/control-board?${params.toString()}`),
        { headers: headers() },
      );
      if (!res.ok) {
        toast("Could not load web merchandising products.", "error");
        return;
      }
      const json = (await res.json()) as BoardResponse;
      const nextRows = Array.isArray(json.rows) ? json.rows : [];
      setRows(nextRows);
      setHandleDrafts((prev) => {
        const next = { ...prev };
        for (const product of groupProducts(nextRows)) {
          next[product.product_id] = product.catalog_handle ?? "";
        }
        return next;
      });
      setPriceDrafts((prev) => {
        const next = { ...prev };
        for (const row of nextRows) {
          if (next[row.variant_id] == null) {
            next[row.variant_id] = normalizeHandle(row.web_price_override);
          }
        }
        return next;
      });
      setOrderDrafts((prev) => {
        const next = { ...prev };
        for (const row of nextRows) {
          if (next[row.variant_id] == null) {
            next[row.variant_id] = String(row.web_gallery_order ?? 0);
          }
        }
        return next;
      });
    } catch {
      toast("Could not load web merchandising products.", "error");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, headers, query, toast]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void loadProducts();
    }, 250);
    return () => window.clearTimeout(t);
  }, [loadProducts]);

  const products = useMemo(() => groupProducts(rows), [rows]);
  const visibleProducts = useMemo(
    () => products.filter((product) => productMatchesFilter(product, filter)),
    [filter, products],
  );

  const summary = useMemo(() => {
    const onWeb = products.filter((product) => product.web_published_count > 0);
    return {
      total: products.length,
      onWeb: onWeb.length,
      needsSetup: onWeb.filter((product) => !product.catalog_handle).length,
      zeroStock: onWeb.filter((product) => product.available_stock_total <= 0)
        .length,
      overrides: rows.filter((row) => normalizeHandle(row.web_price_override))
        .length,
    };
  }, [products, rows]);

  const patchVariant = async (
    variantId: string,
    body: Record<string, unknown>,
    success: string,
  ) => {
    if (!canEditProducts) {
      toast("Catalog edit permission is required for product merchandising.", "error");
      return;
    }
    setBusyKey(variantId);
    try {
      const res = await fetch(
        apiUrl(baseUrl, `/api/products/variants/${variantId}/pricing`),
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        toast(json.error ?? "Variant update failed.", "error");
        return;
      }
      toast(success, "success");
      await loadProducts();
      onRefreshSummary?.();
    } finally {
      setBusyKey(null);
    }
  };

  const saveVariantMerch = async (row: BoardRow) => {
    const priceRaw = normalizeHandle(priceDrafts[row.variant_id]);
    const orderRaw = normalizeHandle(orderDrafts[row.variant_id]);
    const body: Record<string, unknown> = {};
    if (!priceRaw) {
      body.clear_web_price_override = true;
    } else {
      const cents = parseMoneyToCents(priceRaw);
      if (cents < 0) {
        toast("Web price must be non-negative.", "error");
        return;
      }
      body.web_price_override = centsToFixed2(cents);
    }
    const order = Number.parseInt(orderRaw || "0", 10);
    if (!Number.isFinite(order)) {
      toast("Gallery sort must be a number.", "error");
      return;
    }
    body.web_gallery_order = order;
    await patchVariant(row.variant_id, body, "Web merchandising saved.");
  };

  const saveCatalogHandle = async (product: MerchProduct) => {
    if (!canEditProducts) {
      toast("Catalog edit permission is required for product merchandising.", "error");
      return;
    }
    const draft = normalizeHandle(handleDrafts[product.product_id]);
    setBusyKey(product.product_id);
    try {
      const body = draft
        ? { catalog_handle: draft }
        : { clear_catalog_handle: true };
      const res = await fetch(
        apiUrl(baseUrl, `/api/products/${product.product_id}/model`),
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        toast(json.error ?? "Catalog handle update failed.", "error");
        return;
      }
      toast("Storefront slug saved.", "success");
      await loadProducts();
      onRefreshSummary?.();
    } finally {
      setBusyKey(null);
    }
  };

  const copyLink = async (slug: string) => {
    const url = `${window.location.origin}/shop/products/${encodeURIComponent(slug)}`;
    await navigator.clipboard.writeText(url);
    toast("Product link copied.", "success");
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <section className="ui-card p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Products loaded
          </p>
          <p className="mt-2 text-2xl font-black text-app-text">{summary.total}</p>
        </section>
        <section className="ui-card p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            On web
          </p>
          <p className="mt-2 text-2xl font-black text-app-text">{summary.onWeb}</p>
        </section>
        <section className="ui-card p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Needs slug
          </p>
          <p className="mt-2 text-2xl font-black text-app-text">
            {summary.needsSetup}
          </p>
        </section>
        <section className="ui-card p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Zero stock
          </p>
          <p className="mt-2 text-2xl font-black text-app-text">
            {summary.zeroStock}
          </p>
        </section>
        <section className="ui-card p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Web prices
          </p>
          <p className="mt-2 text-2xl font-black text-app-text">
            {summary.overrides}
          </p>
        </section>
      </div>

      <div className="ui-card flex flex-wrap items-center gap-3 p-4">
        <label className="flex min-w-[240px] flex-1 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2">
          <Search size={16} className="text-app-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search web catalog"
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-app-text outline-none placeholder:text-app-text-muted"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(filterLabels) as MerchFilter[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
                filter === id
                  ? "bg-app-accent text-white"
                  : "border border-app-border bg-app-surface text-app-text-muted"
              }`}
            >
              {filterLabels[id]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void loadProducts()}
          className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
          disabled={loading}
        >
          {loading ? "Loading" : "Refresh"}
        </button>
      </div>

      {!canEditProducts ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700">
          You can review storefront merchandising here. Catalog edit permission
          is required to change slugs, publish status, web prices, or gallery
          order.
        </p>
      ) : null}

      <div className="space-y-3">
        {visibleProducts.length === 0 ? (
          <section className="ui-card flex flex-col items-center justify-center p-10 text-center">
            <Package size={34} className="text-app-text-muted" />
            <p className="mt-3 text-sm font-black text-app-text">
              No products match this view.
            </p>
            <p className="mt-1 text-xs text-app-text-muted">
              Adjust the search or merchandising filter.
            </p>
          </section>
        ) : null}
        {visibleProducts.map((product) => {
          const slug = normalizeHandle(product.catalog_handle);
          const blocked = product.web_published_count > 0 && !slug;
          return (
            <section key={product.product_id} className="ui-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-black text-app-text">
                      {product.product_name}
                    </h3>
                    {product.web_published_count > 0 ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-black uppercase text-emerald-700">
                        {product.web_published_count}/{product.variants.length} on web
                      </span>
                    ) : (
                      <span className="rounded-full bg-app-surface-2 px-2 py-1 text-[10px] font-black uppercase text-app-text-muted">
                        Draft
                      </span>
                    )}
                    {blocked ? (
                      <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black uppercase text-amber-700">
                        Missing slug
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-app-text-muted">
                    {product.brand ?? "No brand"} · Available {product.available_stock_total}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {slug ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          window.open(
                            `/shop/products/${encodeURIComponent(slug)}`,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                        className="ui-btn-secondary inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest"
                      >
                        PDP
                        <ExternalLink size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyLink(slug)}
                        className="ui-btn-secondary inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest"
                      >
                        Copy
                        <Copy size={14} />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onOpenInventoryProduct(product.product_id)}
                    className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
                  >
                    Full product hub
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-2 lg:grid-cols-[minmax(240px,0.7fr)_auto]">
                <label>
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Storefront slug
                  </span>
                  <input
                    value={handleDrafts[product.product_id] ?? ""}
                    onChange={(e) =>
                      setHandleDrafts((prev) => ({
                        ...prev,
                        [product.product_id]: e.target.value,
                      }))
                    }
                    className="ui-input mt-1 w-full font-mono text-xs"
                    placeholder="catalog-handle"
                    disabled={!canEditProducts}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void saveCatalogHandle(product)}
                  className="ui-btn-primary self-end text-[10px] font-black uppercase tracking-widest"
                  disabled={!canEditProducts || busyKey === product.product_id}
                >
                  Save slug
                </button>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="border-b border-app-border text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    <tr>
                      <th className="py-2 pr-3">Variant</th>
                      <th className="py-2 pr-3">Web</th>
                      <th className="py-2 pr-3">Stock</th>
                      <th className="py-2 pr-3">Price</th>
                      <th className="py-2 pr-3">Web price</th>
                      <th className="py-2 pr-3">Sort</th>
                      <th className="py-2 pr-0 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {product.variants.map((row) => (
                      <tr key={row.variant_id}>
                        <td className="py-2 pr-3">
                          <p className="font-mono font-bold text-app-text">
                            {row.sku}
                          </p>
                          <p className="text-app-text-muted">
                            {row.variation_label ?? "Base variant"}
                          </p>
                        </td>
                        <td className="py-2 pr-3">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={Boolean(row.web_published)}
                              onChange={(e) =>
                                void patchVariant(
                                  row.variant_id,
                                  { web_published: e.target.checked },
                                  e.target.checked
                                    ? "Variant published to web."
                                    : "Variant unpublished from web.",
                                )
                              }
                              disabled={!canEditProducts || busyKey === row.variant_id}
                            />
                            <span className="text-[10px] font-black uppercase text-app-text-muted">
                              {row.web_published ? "Live" : "Draft"}
                            </span>
                          </label>
                        </td>
                        <td className="py-2 pr-3 font-mono">
                          {typeof row.available_stock === "number"
                            ? row.available_stock
                            : row.stock_on_hand}
                        </td>
                        <td className="py-2 pr-3 font-bold">
                          {variantPriceLabel(row)}
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={priceDrafts[row.variant_id] ?? ""}
                            onChange={(e) =>
                              setPriceDrafts((prev) => ({
                                ...prev,
                                [row.variant_id]: e.target.value,
                              }))
                            }
                            className="ui-input w-28 font-mono text-xs"
                            placeholder="retail"
                            disabled={!canEditProducts}
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={orderDrafts[row.variant_id] ?? "0"}
                            onChange={(e) =>
                              setOrderDrafts((prev) => ({
                                ...prev,
                                [row.variant_id]: e.target.value,
                              }))
                            }
                            className="ui-input w-20 font-mono text-xs"
                            disabled={!canEditProducts}
                          />
                        </td>
                        <td className="py-2 pr-0 text-right">
                          <button
                            type="button"
                            onClick={() => void saveVariantMerch(row)}
                            className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-accent"
                            disabled={!canEditProducts || busyKey === row.variant_id}
                          >
                            <CheckCircle2 size={13} />
                            Save
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
