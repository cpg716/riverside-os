import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Boxes,
  CalendarClock,
  Gem,
  Package,
  ReceiptText,
  Tag,
  TrendingUp,
  X,
} from "lucide-react";
import {
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

interface ProductOrderCounts {
  special_order: number;
  custom: number;
  wedding_order: number;
}

interface ProductScopeMetrics {
  stock_on_hand: number;
  reserved_stock: number;
  available_stock: number;
  recent_sold_30: number;
  open_orders: ProductOrderCounts;
}

interface ProductIntelligence {
  variant_id: string;
  product_id: string;
  sku: string;
  name: string;
  variation_label: string | null;
  stock_on_hand: number;
  reserved_stock: number;
  available_stock: number;
  qty_on_order: number;
  unit_cost: string | null;
  retail_price: string;
  employee_price: string;
  last_sale_date: string | null;
  last_received_at: string | null;
  next_expected_at: string | null;
  variation: ProductScopeMetrics;
  all_variations: ProductScopeMetrics;
}

interface ProductIntelligenceDrawerProps {
  variantId: string | null;
  currentUnitPrice?: string | number | null;
  regularUnitPrice?: string | number | null;
  onClose: () => void;
}

const baseUrl = getBaseUrl();

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function money(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  return formatUsdFromCents(parseMoneyToCents(value));
}

function MetricCard({
  label,
  value,
  sublabel,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone?: "neutral" | "success" | "warning" | "accent";
}) {
  const toneClass =
    tone === "success"
      ? "border-app-success/25 bg-app-success/10 text-app-success"
      : tone === "warning"
        ? "border-app-warning/25 bg-app-warning/10 text-app-warning"
        : tone === "accent"
          ? "border-app-accent/25 bg-app-accent/10 text-app-accent"
          : "border-app-border bg-app-surface-2 text-app-text";

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.22em] opacity-75">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tabular-nums leading-none">
        {value}
      </p>
      {sublabel ? (
        <p className="mt-2 text-[11px] font-semibold leading-snug text-app-text-muted">
          {sublabel}
        </p>
      ) : null}
    </div>
  );
}

function OrderCountsCard({
  title,
  counts,
}: {
  title: string;
  counts: ProductOrderCounts;
}) {
  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
        {title}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <MetricCard label="Special" value={counts.special_order} />
        <MetricCard label="Custom" value={counts.custom} />
        <MetricCard label="Wedding" value={counts.wedding_order} />
      </div>
    </div>
  );
}

export default function ProductIntelligenceDrawer({
  variantId,
  currentUnitPrice,
  regularUnitPrice,
  onClose,
}: ProductIntelligenceDrawerProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [data, setData] = useState<ProductIntelligence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!variantId) {
      setData(null);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...mergedPosStaffHeaders(backofficeHeaders),
        };

        const res = await fetch(`${baseUrl}/api/inventory/intelligence/${variantId}`, { headers });
        if (!res.ok) throw new Error("Product information could not be loaded.");
        setData((await res.json()) as ProductIntelligence);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Product information could not be loaded.");
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [variantId, backofficeHeaders]);

  const priceSummary = useMemo(() => {
    if (!data) return null;
    const regularCents = parseMoneyToCents(regularUnitPrice ?? data.retail_price);
    const currentCents = parseMoneyToCents(currentUnitPrice ?? data.retail_price);
    const discountCents = Math.max(0, regularCents - currentCents);
    const discountPercent =
      regularCents > 0 && discountCents > 0
        ? Math.round((discountCents / regularCents) * 1000) / 10
        : 0;

    return {
      regular: formatUsdFromCents(regularCents),
      current: formatUsdFromCents(currentCents),
      discount:
        discountCents > 0
          ? `${formatUsdFromCents(discountCents)} off · ${discountPercent.toFixed(1)}%`
          : "No cart discount",
    };
  }, [currentUnitPrice, data, regularUnitPrice]);

  if (!variantId) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <>
      <div className="ui-overlay-backdrop !z-[200]" aria-hidden="true" />

      <div className="fixed inset-x-0 bottom-0 z-[200] max-h-[96dvh] w-full rounded-t-3xl border border-app-border bg-app-bg shadow-2xl transition-transform duration-300 ease-out sm:inset-y-0 sm:bottom-auto sm:right-0 sm:max-h-none sm:w-full sm:max-w-2xl sm:rounded-none sm:border-l sm:border-t-0">
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-app-border bg-app-surface px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent ring-1 ring-app-accent/20">
                <Package size={22} />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-black uppercase tracking-tight text-app-text">
                  Item Information
                </h2>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                  Stock, pricing, orders, and sales history
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text"
              aria-label="Close item information"
            >
              <X size={24} />
            </button>
          </div>

          <div className="no-scrollbar flex-1 overflow-y-auto p-4 sm:p-6">
            {loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-4">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-app-accent border-t-transparent" />
                <p className="text-xs font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Loading item information…
                </p>
              </div>
            ) : error ? (
              <div className="rounded-3xl border border-app-danger/25 bg-app-danger/10 p-8 text-center">
                <AlertCircle size={48} className="mx-auto mb-4 text-app-danger" />
                <p className="text-lg font-bold text-app-text">{error}</p>
              </div>
            ) : data ? (
              <div className="space-y-4">
                <div className="relative overflow-hidden rounded-3xl border border-app-border bg-app-surface p-5 shadow-sm">
                  <Package className="absolute -right-6 -top-6 size-36 text-app-text opacity-[0.04]" />
                  <div className="relative z-10 space-y-4">
                    <div className="flex flex-wrap gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-app-surface-2 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted ring-1 ring-app-border">
                        <Tag size={12} /> SKU: {data.sku}
                      </span>
                      {data.variation_label ? (
                        <span className="rounded-full bg-app-success/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-app-success ring-1 ring-app-success/20">
                          {data.variation_label}
                        </span>
                      ) : null}
                    </div>
                    <h3 className="text-2xl font-black uppercase italic leading-tight tracking-tight text-app-text">
                      {data.name}
                    </h3>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <MetricCard
                    label="Current Cart Price"
                    value={priceSummary?.current ?? money(data.retail_price)}
                    sublabel={`Regular ${priceSummary?.regular ?? money(data.retail_price)} · ${priceSummary?.discount ?? "No cart discount"}`}
                    tone="accent"
                  />
                  <MetricCard
                    label="Employee Price"
                    value={money(data.employee_price)}
                    sublabel="Employee sale reference"
                    tone="success"
                  />
                  {data.unit_cost ? (
                    <MetricCard
                      label="Unit Cost"
                      value={money(data.unit_cost)}
                      sublabel="Admin cost visibility"
                      tone="warning"
                    />
                  ) : null}
                  <MetricCard
                    label="Retail Price"
                    value={money(data.retail_price)}
                    sublabel="Catalog price before cart-level discount"
                  />
                </div>

                <div className="rounded-3xl border border-app-border bg-app-surface p-4">
                  <div className="mb-3 flex items-center gap-2 text-app-text">
                    <Boxes size={18} className="text-app-accent" />
                    <h4 className="text-xs font-black uppercase tracking-[0.22em]">
                      Inventory
                    </h4>
                  </div>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <MetricCard label="This Variation" value={data.variation.stock_on_hand} sublabel="Stock on hand" tone="success" />
                    <MetricCard label="Available" value={data.variation.available_stock} sublabel="This variation" />
                    <MetricCard label="All Variations" value={data.all_variations.stock_on_hand} sublabel="Parent total on hand" />
                    <MetricCard label="On Order" value={data.qty_on_order} sublabel={data.next_expected_at ? `Next ETA ${formatDate(data.next_expected_at)}` : "Open PO quantity"} tone={data.qty_on_order > 0 ? "accent" : "neutral"} />
                  </div>
                </div>

                <div className="rounded-3xl border border-app-border bg-app-surface p-4">
                  <div className="mb-3 flex items-center gap-2 text-app-text">
                    <TrendingUp size={18} className="text-app-success" />
                    <h4 className="text-xs font-black uppercase tracking-[0.22em]">
                      Movement
                    </h4>
                  </div>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <MetricCard label="Sold 30 Days" value={data.variation.recent_sold_30} sublabel="This variation" tone="success" />
                    <MetricCard label="Sold 30 Days" value={data.all_variations.recent_sold_30} sublabel="All variations" />
                    <MetricCard label="Last Sold" value={formatDate(data.last_sale_date)} sublabel="Most recent sale" />
                    <MetricCard label="Last Received" value={formatDateTime(data.last_received_at)} sublabel="PO receipt history" />
                  </div>
                </div>

                <div className="rounded-3xl border border-app-border bg-app-surface p-4">
                  <div className="mb-3 flex items-center gap-2 text-app-text">
                    <ReceiptText size={18} className="text-app-warning" />
                    <h4 className="text-xs font-black uppercase tracking-[0.22em]">
                      Open Customer Orders
                    </h4>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <OrderCountsCard title="This variation" counts={data.variation.open_orders} />
                    <OrderCountsCard title="All variations" counts={data.all_variations.open_orders} />
                  </div>
                </div>

                <div className="rounded-3xl border border-app-border bg-app-surface-2 p-4">
                  <div className="flex items-start gap-3">
                    <CalendarClock size={18} className="mt-0.5 shrink-0 text-app-text-muted" />
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                        Operational note
                      </p>
                      <p className="mt-1 text-sm font-semibold leading-relaxed text-app-text-muted">
                        This view is read-only. Price changes, quantity edits, and fulfillment changes stay on the cart line and keypad controls.
                      </p>
                    </div>
                  </div>
                </div>

                {data.unit_cost ? (
                  <div className="rounded-3xl border border-app-accent/25 bg-app-accent/10 p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-app-accent/15 text-app-accent">
                        <Gem size={20} />
                      </div>
                      <p className="text-sm font-bold text-app-text-muted">
                        Cost is visible because this staff member has cost-view access.
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>,
    root,
  );
}
