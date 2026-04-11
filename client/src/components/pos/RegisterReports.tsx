import { useState, useEffect, useCallback, useMemo } from "react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  Loader2,
  ChevronRight,
  Receipt,
  Calendar,
  Hash,
  DollarSign,
  ShoppingBag,
  Globe,
  Heart,
  Percent,
  Radio,
  Archive,
  Pin,
} from "lucide-react";
import ReceiptSummaryModal from "./ReceiptSummaryModal";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type PresetId = "today" | "yesterday" | "this_week" | "this_month" | "this_year" | "custom";

interface RegisterActivityItem {
  id: string;
  kind: string;
  occurred_at: string;
  title: string;
  subtitle?: string | null;
  order_id?: string | null;
  wedding_party_id?: string | null;
  amount_label?: string | null;
  payment_summary?: string | null;
}

interface RegisterDaySummary {
  timezone: string;
  from_local: string;
  to_local: string;
  preset: string | null;
  is_historical: boolean;
  includes_today: boolean;
  /** Single-day historical payload saved at last Z-close for this date. */
  from_eod_snapshot?: boolean;
  /** `booked` = sale date; `fulfilled` = pickup / fulfilled date. */
  reporting_basis?: string;
  sales_count: number;
  sales_subtotal_no_tax: string;
  avg_sale_no_tax: string;
  online_order_count: number;
  pickup_count: number;
  special_order_sale_count: number;
  appointment_count: number;
  new_wedding_parties_count: number;
  activities: RegisterActivityItem[];
}

interface RegisterSessionRow {
  id: string;
  register_ordinal: number;
  opened_at: string;
  closed_at: string | null;
  cashier_name: string;
  opening_float: string;
  expected_cash: string | null;
  actual_cash: string | null;
  discrepancy: string | null;
  total_sales: string;
}

const PRESETS: { id: PresetId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "this_month", label: "This month" },
  { id: "this_year", label: "This year" },
  { id: "custom", label: "Custom" },
];

function kindPill(kind: string): string {
  switch (kind) {
    case "sale":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 ring-emerald-500/25";
    case "fulfilled":
      return "bg-teal-500/15 text-teal-900 dark:text-teal-100 ring-teal-500/25";
    case "pickup":
      return "bg-sky-500/15 text-sky-900 dark:text-sky-100 ring-sky-500/25";
    case "wedding_party":
      return "bg-rose-500/15 text-rose-900 dark:text-rose-100 ring-rose-500/25";
    case "appointment":
      return "bg-violet-500/15 text-violet-900 dark:text-violet-100 ring-violet-500/25";
    default:
      return "bg-app-surface-2 text-app-text-muted ring-app-border";
  }
}

export default function RegisterReports({
  sessionId,
  onOpenWeddingParty,
}: {
  sessionId: string | null;
  onOpenWeddingParty?: (partyId: string) => void;
}) {
  const [view, setView] = useState<"daily" | "zlogs">("daily");
  const [preset, setPreset] = useState<PresetId>("today");
  const [reportBasis, setReportBasis] = useState<"booked" | "fulfilled">("booked");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [summary, setSummary] = useState<RegisterDaySummary | null>(null);
  const [zLogs, setZLogs] = useState<RegisterSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [zLoading, setZLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);

  const buildActivityParams = useCallback(() => {
    const params = new URLSearchParams();
    if (preset === "custom") {
      if (!customFrom || !customTo) {
        params.set("preset", "today");
      } else {
        params.set("preset", "custom");
        params.set("from", customFrom);
        params.set("to", customTo);
      }
    } else {
      params.set("preset", preset);
    }
    if (sessionId) params.set("register_session_id", sessionId);
    params.set("basis", reportBasis);
    return params;
  }, [preset, customFrom, customTo, sessionId, reportBasis]);

  const fetchSummary = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const h = apiAuth();
      const params = buildActivityParams();
      const res = await fetch(`${baseUrl}/api/insights/register-day-activity?${params}`, { headers: h });
      if (res.status === 403) {
        setError(
          sessionId
            ? "Register session is not open, or you do not have access to these reports."
            : "You need the register.reports permission to view store-wide register activity, or open a till for this lane.",
        );
        setSummary(null);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Failed to load register activity");
      }
      const data = (await res.json()) as RegisterDaySummary;
      setSummary(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "An error occurred");
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, buildActivityParams, sessionId]);

  const fetchZLogs = useCallback(async () => {
    setZLoading(true);
    try {
      const h = apiAuth();
      const params = new URLSearchParams({ limit: "40" });
      if (summary) {
        params.set("from", summary.from_local);
        params.set("to", summary.to_local);
      }
      const res = await fetch(`${baseUrl}/api/insights/register-sessions?${params}`, { headers: h });
      if (!res.ok) throw new Error("Failed to fetch Z-Logs");
      const data = (await res.json()) as RegisterSessionRow[];
      setZLogs(Array.isArray(data) ? data : []);
    } catch {
      setZLogs([]);
    } finally {
      setZLoading(false);
    }
  }, [apiAuth, summary]);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    if (!summary?.includes_today) return;
    const t = window.setInterval(() => {
      void fetchSummary();
    }, 45000);
    return () => window.clearInterval(t);
  }, [summary?.includes_today, fetchSummary]);

  useEffect(() => {
    if (view !== "zlogs") return;
    void fetchZLogs();
  }, [view, fetchZLogs]);

  const rangeLabel = useMemo(() => {
    if (!summary) return "";
    if (summary.from_local === summary.to_local) return summary.from_local;
    return `${summary.from_local} → ${summary.to_local}`;
  }, [summary]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-surface p-4 sm:p-6">
      <ReceiptSummaryModal
        orderId={receiptOrderId}
        onClose={() => setReceiptOrderId(null)}
        baseUrl={baseUrl}
        registerSessionId={sessionId}
        getAuthHeaders={apiAuth}
      />

      <div className="mb-4 flex shrink-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">Register</p>
          <h2 className="text-2xl font-black tracking-tight text-app-text">Daily Sales</h2>
          {summary ? (
            <p className="mt-1 text-xs font-semibold text-app-text-muted">
              {rangeLabel}
              <span className="mx-1.5 opacity-40">·</span>
              <span className="font-mono">{summary.timezone}</span>
            </p>
          ) : null}
        </div>
        <div className="flex gap-1 rounded-2xl border border-app-border bg-app-surface-2 p-1 shadow-inner">
          <button
            type="button"
            onClick={() => setView("daily")}
            className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${
              view === "daily" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"
            }`}
          >
            Daily activity
          </button>
          <button
            type="button"
            onClick={() => setView("zlogs")}
            className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${
              view === "zlogs" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"
            }`}
          >
            Closing (Z)
          </button>
        </div>
      </div>

      {view === "daily" ? (
        <div className="mb-4 shrink-0 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">Reporting basis</span>
            <div className="flex gap-1 rounded-2xl border border-app-border bg-app-surface-2 p-1">
              <button
                type="button"
                onClick={() => setReportBasis("booked")}
                className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                  reportBasis === "booked"
                    ? "bg-app-surface text-app-accent shadow-sm"
                    : "text-app-text-muted hover:text-app-text"
                }`}
              >
                Booked (sale date)
              </button>
              <button
                type="button"
                onClick={() => setReportBasis("fulfilled")}
                className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                  reportBasis === "fulfilled"
                    ? "bg-app-surface text-app-accent shadow-sm"
                    : "text-app-text-muted hover:text-app-text"
                }`}
              >
                Fulfilled (pickup)
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-all ${
                preset === p.id
                  ? "bg-app-accent text-white shadow-md shadow-app-accent/25"
                  : "border border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent/40 hover:text-app-text"
              }`}
            >
              {p.label}
            </button>
          ))}
          </div>
        </div>
      ) : null}

      {view === "daily" && preset === "custom" ? (
        <div className="mb-4 flex shrink-0 flex-wrap items-end gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            From
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="ui-input rounded-xl px-3 py-2 text-sm font-semibold"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            To
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="ui-input rounded-xl px-3 py-2 text-sm font-semibold"
            />
          </label>
          <button
            type="button"
            onClick={() => void fetchSummary()}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white shadow-[0_4px_0_0_rgb(6,95,70)] transition hover:bg-emerald-500"
          >
            Apply range
          </button>
        </div>
      ) : null}

      {!sessionId && view === "daily" ? (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-app-text">
          <span className="font-bold">Store-wide view.</span> Managers with register.reports see every lane. Cashiers:
          open a till to scope this screen to the current session.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-app-border bg-app-surface-2/50 shadow-[0_20px_50px_-32px_rgba(0,0,0,0.35)]">
        {view === "daily" ? (
          loading ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <p className="font-bold text-app-text">{error}</p>
              <button
                type="button"
                onClick={() => void fetchSummary()}
                className="mt-4 text-sm font-bold text-app-accent hover:underline"
              >
                Try again
              </button>
            </div>
          ) : summary ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div
                className={`relative shrink-0 overflow-hidden border-b border-app-border px-4 py-5 sm:px-8 ${
                  summary.from_eod_snapshot
                    ? "bg-[linear-gradient(120deg,rgba(99,102,241,0.14)_0%,rgba(129,140,248,0.06)_50%,transparent_100%)]"
                    : summary.is_historical
                      ? "bg-[linear-gradient(120deg,rgba(251,191,36,0.18)_0%,rgba(245,158,11,0.08)_45%,transparent_100%)]"
                      : summary.includes_today
                        ? "bg-[linear-gradient(120deg,rgba(16,185,129,0.16)_0%,rgba(52,211,153,0.06)_50%,transparent_100%)]"
                        : "bg-app-surface/40"
                }`}
              >
                <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(ellipse_at_top_right,rgba(99,102,241,0.12),transparent_60%)]" />
                <div className="relative flex flex-wrap items-center gap-3">
                  {summary.from_eod_snapshot ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/35 bg-indigo-500/15 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-indigo-950 dark:text-indigo-100">
                      <Pin className="h-3.5 w-3.5" />
                      Z-close snapshot · frozen for this day
                    </span>
                  ) : summary.is_historical ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-amber-950 dark:text-amber-100">
                      <Archive className="h-3.5 w-3.5" />
                      End of day · historical range
                    </span>
                  ) : summary.includes_today ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-950 dark:text-emerald-100">
                      <Radio className="h-3.5 w-3.5 animate-pulse" />
                      Live · updates during the day
                    </span>
                  ) : null}
                </div>

                <div className="relative mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <div className="group rounded-2xl border border-app-border/80 bg-app-surface/90 p-4 shadow-sm backdrop-blur-sm transition hover:border-app-accent/30">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                      <Hash className="h-3.5 w-3.5" />
                      {(summary.reporting_basis ?? "booked") === "fulfilled" ? "Fulfilled #" : "Sales #"}
                    </div>
                    <p className="text-2xl font-black tabular-nums text-app-text">{summary.sales_count}</p>
                  </div>
                  <div className="group rounded-2xl border border-app-border/80 bg-app-surface/90 p-4 shadow-sm backdrop-blur-sm transition hover:border-app-accent/30">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                      <DollarSign className="h-3.5 w-3.5" />
                      {(summary.reporting_basis ?? "booked") === "fulfilled"
                        ? "Revenue $ (no tax)"
                        : "Sales $ (no tax)"}
                    </div>
                    <p className="text-2xl font-black tabular-nums text-app-accent">
                      ${centsToFixed2(parseMoneyToCents(summary.sales_subtotal_no_tax))}
                    </p>
                  </div>
                  <div className="group rounded-2xl border border-app-border/80 bg-app-surface/90 p-4 shadow-sm backdrop-blur-sm transition hover:border-app-accent/30">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                      <Percent className="h-3.5 w-3.5" />
                      {(summary.reporting_basis ?? "booked") === "fulfilled" ? "Avg order" : "Avg sale"}
                    </div>
                    <p className="text-2xl font-black tabular-nums text-app-text">
                      ${centsToFixed2(parseMoneyToCents(summary.avg_sale_no_tax))}
                    </p>
                  </div>
                  <div className="group rounded-2xl border border-app-border/80 bg-app-surface/90 p-4 shadow-sm backdrop-blur-sm transition hover:border-app-accent/30">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                      <Calendar className="h-3.5 w-3.5" />
                      Appointments
                    </div>
                    <p className="text-2xl font-black tabular-nums text-app-text">{summary.appointment_count}</p>
                  </div>
                  <div className="group rounded-2xl border border-app-border/80 bg-app-surface/90 p-4 shadow-sm backdrop-blur-sm transition hover:border-app-accent/30">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                      <Globe className="h-3.5 w-3.5" />
                      Online orders
                    </div>
                    <p className="text-2xl font-black tabular-nums text-app-text">{summary.online_order_count}</p>
                  </div>
                  <div className="group rounded-2xl border border-app-border/80 bg-app-surface/90 p-4 shadow-sm backdrop-blur-sm transition hover:border-app-accent/30">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                      <Heart className="h-3.5 w-3.5" />
                      New weddings
                    </div>
                    <p className="text-2xl font-black tabular-nums text-app-text">{summary.new_wedding_parties_count}</p>
                  </div>
                </div>
                <div className="relative mt-3 space-y-1.5 text-[11px] font-semibold leading-relaxed text-app-text-muted">
                  {(summary.reporting_basis ?? "booked") === "fulfilled" ? (
                    <p>
                      <span className="text-app-text">Fulfilled</span> uses the <span className="text-app-text">recognition</span>{" "}
                      clock: <span className="text-app-text">pickup / takeaway</span> by fulfillment time,{" "}
                      <span className="text-app-text">ship</span> when the label is purchased or shipment moves in transit /
                      delivered (Shipments hub). Matches tax and commission recognition; use{" "}
                      <span className="text-app-text">Booked</span> for register-day selling including open orders.
                    </p>
                  ) : (
                    <p>
                      <span className="text-app-text">Booked</span> (#, subtotal without tax, average) uses{" "}
                      <span className="text-app-text">sale date</span> (when the sale was rung), including deposits on open
                      orders. That matches register-day selling activity; recognition-style views use{" "}
                      <span className="text-app-text">Fulfilled</span> (pickup or shipped).
                    </p>
                  )}
                  <p>
                    {(summary.reporting_basis ?? "booked") === "fulfilled" ? (
                      <>
                        Orders fulfilled in this range:{" "}
                        <span className="tabular-nums text-app-text">{summary.pickup_count}</span>
                        <span className="mx-2 opacity-30">|</span>
                        Special-order lines on those orders:{" "}
                        <span className="tabular-nums text-app-text">{summary.special_order_sale_count}</span>
                      </>
                    ) : (
                      <>
                        Pickups completed in this range:{" "}
                        <span className="tabular-nums text-app-text">{summary.pickup_count}</span>
                        <span className="mx-2 opacity-30">|</span>
                        Special-order bookings in this range:{" "}
                        <span className="tabular-nums text-app-text">{summary.special_order_sale_count}</span>
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-app-border bg-app-surface/95 px-4 py-3 backdrop-blur sm:px-8">
                  <ShoppingBag className="h-4 w-4 text-app-text-muted" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Activity timeline
                  </span>
                </div>
                {summary.activities.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-app-text-muted">No activity in this range.</div>
                ) : (
                  <ul className="divide-y divide-app-border">
                    {summary.activities.map((row) => (
                      <li
                        key={row.id}
                        className="flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-app-surface/60 sm:flex-row sm:items-center sm:justify-between sm:px-8"
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-4">
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ring-1 ${kindPill(row.kind)}`}
                          >
                            {row.kind.replace("_", " ")}
                          </span>
                          <div className="min-w-0">
                            <p className="font-bold text-app-text">{row.title}</p>
                            {row.subtitle ? (
                              row.wedding_party_id ? (
                                <button
                                  type="button"
                                  className="mt-0.5 truncate text-left text-sm font-semibold text-app-text-muted hover:text-app-accent"
                                  onClick={() => onOpenWeddingParty?.(row.wedding_party_id!)}
                                >
                                  {row.subtitle}
                                </button>
                              ) : (
                                <p className="mt-0.5 truncate text-sm font-semibold text-app-text-muted">{row.subtitle}</p>
                              )
                            ) : null}
                            {row.payment_summary ? (
                              <p className="mt-1 text-xs text-app-text-muted">{row.payment_summary}</p>
                            ) : null}
                            <p className="mt-1 text-[11px] font-mono text-app-text-muted/80">
                              {new Date(row.occurred_at).toLocaleString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 sm:justify-end">
                          {row.amount_label ? (
                            <span className="text-lg font-black tabular-nums text-app-accent">{row.amount_label}</span>
                          ) : null}
                          {row.order_id ? (
                            <button
                              type="button"
                              onClick={() => setReceiptOrderId(row.order_id!)}
                              className="inline-flex items-center gap-1.5 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-xs font-black uppercase tracking-wide text-app-text shadow-sm hover:border-app-accent/50 hover:text-app-accent"
                              title="Reprint customer receipt"
                            >
                              <Receipt className="h-4 w-4" />
                              Receipt
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null
        ) : zLoading ? (
          <div className="flex flex-1 items-center justify-center py-20">
            <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-app-border px-6 py-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Recent closed sessions (Z)
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {zLogs.length === 0 ? (
                <div className="flex h-full items-center justify-center p-8 text-app-text-muted">No register sessions found.</div>
              ) : (
                zLogs.map((session) => (
                  <div
                    key={session.id}
                    className="grid grid-cols-1 items-center gap-2 border-b border-app-border px-6 py-4 transition-colors hover:bg-app-surface/50 sm:grid-cols-6"
                  >
                    <div className="sm:col-span-2">
                      <p className="text-xs font-bold text-app-text-muted">Lane {session.register_ordinal}</p>
                      <p className="text-sm font-bold text-app-text">{session.cashier_name}</p>
                      <p className="text-xs text-app-text-muted">
                        {new Date(session.opened_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                      </p>
                    </div>
                    <div className="text-sm text-app-text-muted">
                      Closed
                      <br />
                      <span className="font-semibold text-app-text">
                        {session.closed_at
                          ? new Date(session.closed_at).toLocaleString(undefined, { timeStyle: "short" })
                          : "—"}
                      </span>
                    </div>
                    <div className="text-right font-black text-app-accent">
                      ${centsToFixed2(parseMoneyToCents(session.total_sales))}
                    </div>
                    <div className="text-right text-sm text-app-text-muted">
                      Exp. cash ${centsToFixed2(parseMoneyToCents(session.expected_cash ?? "0"))}
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded-lg px-3 py-1 text-xs font-bold text-app-accent hover:bg-app-surface"
                        disabled
                      >
                        Detail <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
