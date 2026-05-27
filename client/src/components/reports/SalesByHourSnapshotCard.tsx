import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import DashboardGridCard from "../ui/DashboardGridCard";

const baseUrl = getBaseUrl();

type SalesByHourRow = {
  business_date: string;
  weekday: string;
  hour: number;
  hour_label: string;
  transaction_count: number;
  sales_total: string;
  avg_sale_per_hour: string;
  day_transaction_count: number;
  day_sales_total: string;
  active_sales_hours: number;
  sales_per_hour: string;
  prior_year_business_date: string;
  prior_year_day_sales_total: string | null;
  prior_year_sales_per_hour: string | null;
  sales_delta_vs_prior_year: string | null;
  prior_week_business_date: string;
  prior_week_day_sales_total: string | null;
  sales_delta_vs_prior_week: string | null;
};

type Props = {
  authHeaders: () => HeadersInit;
  canLoad: boolean;
  refreshSignal?: number;
  className?: string;
  onOpenReport?: () => void;
};

function localYmd(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currency(value: string | number | null | undefined): string {
  const amount =
    typeof value === "number"
      ? value
      : value == null
        ? 0
        : Number.parseFloat(String(value));
  return Number.isFinite(amount)
    ? amount.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
      })
    : "$0.00";
}

function numeric(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentDelta(current: number, prior: number): string | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  const pct = ((current - prior) / prior) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

export default function SalesByHourSnapshotCard({
  authHeaders,
  canLoad,
  refreshSignal = 0,
  className,
  onOpenReport,
}: Props) {
  const [rows, setRows] = useState<SalesByHourRow[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");

  const load = useCallback(async () => {
    if (!canLoad) {
      setRows([]);
      setLoadState("idle");
      return;
    }
    const today = localYmd();
    setLoadState("loading");
    try {
      const res = await fetch(
        `${baseUrl}/api/insights/sales-by-day?from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error("sales-by-hour");
      const payload = (await res.json()) as SalesByHourRow[];
      // Filter to today only — the API returns rows ordered by date desc,
      // so if today had no sales the first row could be a prior-day record.
      const todayRows = Array.isArray(payload)
        ? payload.filter((r) => r.business_date === today)
        : [];
      setRows(todayRows);
      setLoadState("idle");
    } catch {
      setRows([]);
      setLoadState("error");
    }
  }, [authHeaders, canLoad]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const summary = useMemo(() => {
    const first = rows[0];
    const peak = rows.reduce<SalesByHourRow | null>((winner, row) => {
      if (!winner) return row;
      return numeric(row.sales_total) > numeric(winner.sales_total) ? row : winner;
    }, null);
    const daySales = numeric(first?.day_sales_total);
    const priorYearSales =
      first?.prior_year_day_sales_total == null ? null : numeric(first.prior_year_day_sales_total);
    return {
      daySales,
      salesPerHour: numeric(first?.sales_per_hour),
      transactionCount: Number(first?.day_transaction_count ?? 0),
      activeHours: Number(first?.active_sales_hours ?? 0),
      averageSale:
        Number(first?.day_transaction_count ?? 0) > 0
          ? daySales / Number(first?.day_transaction_count ?? 1)
          : 0,
      peak,
      priorYearSales,
      priorYearDate: first?.prior_year_business_date ?? null,
      priorYearDelta:
        priorYearSales == null ? null : percentDelta(daySales, priorYearSales),
    };
  }, [rows]);

  if (!canLoad) return null;

  return (
    <DashboardGridCard
      title="Sales by Hour"
      subtitle="Today by sale time, with prior-year comparison when available"
      icon={BarChart3}
      className={className}
      actionLabel={onOpenReport ? "Open report" : undefined}
      onAction={onOpenReport}
      contentClassName="space-y-4"
    >
      {loadState === "error" ? (
        <div className="rounded-xl border border-app-danger/20 bg-app-danger/10 px-3 py-2 text-xs font-semibold text-app-text">
          Sales-by-hour data could not refresh.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            Sales
          </p>
          <p className="mt-1 text-2xl font-black text-app-text">
            {loadState === "loading" ? "..." : currency(summary.daySales)}
          </p>
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            Sales / hour
          </p>
          <p className="mt-1 text-2xl font-black text-app-text">
            {loadState === "loading" ? "..." : currency(summary.salesPerHour)}
          </p>
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            Avg sale
          </p>
          <p className="mt-1 text-xl font-black text-app-text">
            {loadState === "loading" ? "..." : currency(summary.averageSale)}
          </p>
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            Active hours
          </p>
          <p className="mt-1 text-xl font-black text-app-text">
            {loadState === "loading" ? "..." : summary.activeHours}
          </p>
        </div>
      </div>

      <div className="space-y-2 text-xs font-semibold text-app-text-muted">
        <p>
          {summary.transactionCount > 0
            ? `${summary.transactionCount} sales tracked across ${summary.activeHours} active hour${summary.activeHours === 1 ? "" : "s"}.`
            : "No sales recorded yet today."}
        </p>
        <p>
          Peak hour:{" "}
          <span className="font-black text-app-text">
            {summary.peak
              ? `${summary.peak.hour_label} (${currency(summary.peak.sales_total)})`
              : "No peak yet"}
          </span>
        </p>
        <p>
          Prior-year same date:{" "}
          <span className="font-black text-app-text">
            {summary.priorYearSales == null
              ? "No matching data"
              : `${currency(summary.priorYearSales)} on ${summary.priorYearDate}${
                  summary.priorYearDelta ? ` (${summary.priorYearDelta})` : ""
                }`}
          </span>
        </p>
      </div>
    </DashboardGridCard>
  );
}
