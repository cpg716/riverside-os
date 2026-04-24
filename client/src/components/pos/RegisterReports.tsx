import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useMemo } from "react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  Loader2,
  Receipt,
  Calendar,
  DollarSign,
  Globe,
  Heart,
  Printer,
  Download,
  Package,
  Truck,
  CreditCard,
  Banknote,
  User,
  Clock,
} from "lucide-react";
import ReceiptSummaryModal from "./ReceiptSummaryModal";
import ProductHubDrawer from "../inventory/ProductHubDrawer";
import { openProfessionalDailySalesPrint } from "./zReportPrint";

const baseUrl = getBaseUrl();

type PresetId = "today" | "yesterday" | "this_week" | "this_month" | "this_year" | "custom";
type ZPresetId = "recent" | "today" | "yesterday" | "this_week" | "this_month" | "custom";

interface ActivityItemDetail {
  name: string;
  sku: string;
  quantity: number;
  reg_price: string;
  price: string;
  product_id: string;
  fulfillment?: string | null;
}

interface TransactionPayment {
  method: string;
  amount_label: string;
}

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
  sales_total?: string | null;
  tax_total?: string | null;
  is_takeaway?: boolean | null;
  channel?: string | null;
  wedding_party_name?: string | null;
  items?: ActivityItemDetail[] | null;
  customer_name?: string | null;
  customer_code?: string | null;
  deposits_paid?: string | null;
  balance_due?: string | null;
  fulfillment_type?: string | null;
  transaction_total?: string | null;
  short_id?: string | null;
  payments?: TransactionPayment[] | null;
  cashier_name?: string | null;
}

interface RegisterDaySummary {
  timezone: string;
  from_local: string;
  to_local: string;
  preset: string | null;
  is_historical: boolean;
  includes_today: boolean;
  from_eod_snapshot?: boolean;
  reporting_basis?: string;
  sales_count: number;
  sales_subtotal_no_tax: string;
  sales_tax_total: string;
  avg_sale_no_tax: string;
  online_order_count: number;
  pickup_count: number;
  special_order_sale_count: number;
  appointment_count: number;
  new_wedding_parties_count: number;
  stripe_fees_total: string;
  net_sales: string;
  cash_collected: string;
  deposits_collected: string;
  activities: RegisterActivityItem[];
  amount_label?: string;
}

interface RegisterSessionRow {
  id: string;
  register_lane: number;
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

interface OpenRegisterSessionRow {
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  cashier_name: string;
  opened_at: string;
  till_close_group_id: string;
  lifecycle_status: string;
}

interface RegisterCoordinationGroup {
  tillCloseGroupId: string;
  sessions: OpenRegisterSessionRow[];
}

interface GroupedDayActivity {
  date: string;
  label: string;
  activities: RegisterActivityItem[];
  total_sales: string;
  total_tax: string;
  count: number;
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
    case "pickup":
      return "bg-sky-500/15 text-sky-900 dark:text-sky-100 ring-sky-500/25";
    default:
      return "bg-app-surface-2 text-app-text-muted ring-app-border";
  }
}

function paymentIcon(method: string) {
  const m = method.toLowerCase();
  if (m.includes("card") || m.includes("stripe")) return <CreditCard size={12} />;
  if (m.includes("cash")) return <Banknote size={12} />;
  if (m.includes("gift")) return <Package size={12} />;
  return <CreditCard size={12} />;
}

function registerLifecycleLabel(status: string) {
  switch (status) {
    case "reconciling":
      return "Pending close";
    case "closed":
      return "Closed";
    case "open":
    default:
      return "Open drawer";
  }
}

function registerLifecycleTone(status: string) {
  switch (status) {
    case "reconciling":
      return "border-app-warning/20 bg-app-warning/10 text-app-warning";
    case "closed":
      return "border-app-success/20 bg-app-success/10 text-app-success";
    case "open":
    default:
      return "border-app-info/20 bg-app-info/10 text-app-info";
  }
}

function primaryRegisterSession(
  sessions: OpenRegisterSessionRow[],
): OpenRegisterSessionRow | null {
  return sessions.find((session) => session.register_lane === 1) ?? sessions[0] ?? null;
}

export default function RegisterReports({
  sessionId,
  onOpenWeddingParty,
  deepLinkTransactionId,
  onDeepLinkConsumed,
}: {
  sessionId: string | null;
  onOpenWeddingParty?: (partyId: string) => void;
  deepLinkTransactionId?: string | null;
  onDeepLinkConsumed?: () => void;
}) {
  const [view, setView] = useState<"dashboard" | "activity" | "z-reports">("dashboard");
  const [preset, setPreset] = useState<PresetId>("today");
  const [reportBasis, setReportBasis] = useState<"booked" | "fulfilled">("booked");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [summary, setSummary] = useState<RegisterDaySummary | null>(null);
  const [summaryBooked, setSummaryBooked] = useState<RegisterDaySummary | null>(null);
  const [zLogs, setZLogs] = useState<RegisterSessionRow[]>([]);
  const [openSessions, setOpenSessions] = useState<OpenRegisterSessionRow[]>([]);
  const [openSessionsError, setOpenSessionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zLoading, setZLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);
  const [hubProductId, setHubProductId] = useState<string | null>(null);
  const [zPreset, setZPreset] = useState<ZPresetId>("recent");
  const [customFromZ, setCustomFromZ] = useState("");
  const [customToZ, setCustomToZ] = useState("");

  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);

  const buildActivityParams = useCallback((basis: "booked" | "fulfilled" = reportBasis) => {
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
    params.set("basis", basis);
    return params;
  }, [preset, customFrom, customTo, sessionId, reportBasis]);

  const fetchSummary = useCallback(async (basis?: "booked" | "fulfilled") => {
    const targetBasis = basis || reportBasis;
    setError(null);
    setLoading(true);
    try {
      const h = apiAuth();
      const params = buildActivityParams(targetBasis);
      const res = await fetch(`${baseUrl}/api/insights/register-day-activity?${params}`, { headers: h });
      if (res.status === 403) {
        setError(sessionId ? "Register session is not open." : "register.reports permission required.");
        return null;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Failed to load activity");
      }
      return (await res.json()) as RegisterDaySummary;
    } catch (e) {
      setError(e instanceof Error ? e.message : "An error occurred");
      return null;
    } finally {
      setLoading(false);
    }
  }, [apiAuth, buildActivityParams, sessionId, reportBasis]);

  useEffect(() => {
    const load = async () => {
      const bookedData = await fetchSummary("booked");
      if (bookedData) setSummaryBooked(bookedData);
      const fulfilledData = await fetchSummary("fulfilled");
      if (fulfilledData) setSummary(fulfilledData);
    };
    load();
  }, [fetchSummary, preset, customFrom, customTo]);

  const buildZLogParams = useCallback(() => {
    const params = new URLSearchParams({ limit: "40" });
    if (zPreset === "custom") {
      if (customFromZ && customToZ) {
        params.set("preset", "custom");
        params.set("from", customFromZ);
        params.set("to", customToZ);
      } else {
        params.set("preset", "recent");
      }
    } else if (zPreset === "recent") {
      params.set("preset", "recent");
    } else {
      params.set("preset", zPreset);
    }
    return params;
  }, [zPreset, customFromZ, customToZ]);

  const fetchZLogs = useCallback(async () => {
    setZLoading(true);
    try {
      const h = apiAuth();
      const params = buildZLogParams();
      const res = await fetch(`${baseUrl}/api/insights/register-sessions?${params}`, { headers: h });
      if (!res.ok) throw new Error("Failed to fetch Z-Logs");
      const data = (await res.json()) as RegisterSessionRow[];
      setZLogs(Array.isArray(data) ? data : []);
    } catch {
      setZLogs([]);
    } finally {
      setZLoading(false);
    }
  }, [apiAuth, buildZLogParams]);

  const fetchOpenSessions = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/sessions/list-open`, {
        headers: apiAuth(),
      });
      if (res.status === 401 || res.status === 403) {
        setOpenSessions([]);
        setOpenSessionsError("Register coordination visibility requires attach access.");
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch open register sessions");
      const data = (await res.json()) as OpenRegisterSessionRow[];
      setOpenSessions(Array.isArray(data) ? data : []);
      setOpenSessionsError(null);
    } catch (error) {
      setOpenSessions([]);
      setOpenSessionsError(
        error instanceof Error ? error.message : "Could not load active register sessions.",
      );
    }
  }, [apiAuth]);

  useEffect(() => {
    if (view === "z-reports") {
      void fetchZLogs();
      void fetchOpenSessions();
    }
  }, [view, zPreset, customFromZ, customToZ, fetchZLogs, fetchOpenSessions]);

  const rangeLabel = useMemo(() => {
    if (!summary) return "";
    if (summary.from_local === summary.to_local) return summary.from_local;
    return `${summary.from_local} → ${summary.to_local}`;
  }, [summary]);

  useEffect(() => {
    if (deepLinkTransactionId) {
      setReceiptOrderId(deepLinkTransactionId);
      onDeepLinkConsumed?.();
    }
  }, [deepLinkTransactionId, onDeepLinkConsumed]);

  const groupedActivities = useMemo((): GroupedDayActivity[] => {
    const source = reportBasis === "booked" ? summaryBooked : summary;
    if (!source?.activities?.length) return [];
    const groups: Record<string, RegisterActivityItem[]> = {};
    source.activities.forEach((a) => {
      const date = new Date(a.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      if (!groups[date]) groups[date] = [];
      groups[date].push(a);
    });
    return Object.entries(groups).map(([date, acts]) => ({
      date,
      label: date,
      activities: acts,
      total_sales: acts.reduce((sum, a) => sum + (parseFloat(a.sales_total || "0") || 0), 0).toFixed(2),
      total_tax: acts.reduce((sum, a) => sum + (parseFloat(a.tax_total || "0") || 0), 0).toFixed(2),
      count: acts.length,
    }));
  }, [summary, summaryBooked, reportBasis]);

  const coordinationGroups = useMemo((): RegisterCoordinationGroup[] => {
    const grouped = new Map<string, OpenRegisterSessionRow[]>();
    openSessions.forEach((session) => {
      const existing = grouped.get(session.till_close_group_id) ?? [];
      existing.push(session);
      grouped.set(session.till_close_group_id, existing);
    });
    return Array.from(grouped.entries())
      .map(([tillCloseGroupId, sessions]) => ({
        tillCloseGroupId,
        sessions: sessions.sort((left, right) => left.register_lane - right.register_lane),
      }))
      .sort((left, right) => left.sessions[0]!.register_lane - right.sessions[0]!.register_lane);
  }, [openSessions]);

  const coordinationSummary = useMemo(() => {
    const openDrawerCount = coordinationGroups.length;
    const reconcilingGroups = coordinationGroups.filter((group) =>
      group.sessions.some((session) => session.lifecycle_status === "reconciling"),
    );
    return {
      activeSessions: openSessions.length,
      openDrawers: openDrawerCount,
      pendingCloses: reconcilingGroups.length,
      reconcilingGroups,
    };
  }, [openSessions, coordinationGroups]);

  const handlePrint = () => {
    if (!summary || !summaryBooked) return;
    openProfessionalDailySalesPrint({
      title: `Daily Sales - ${rangeLabel}`,
      rangeLabel,
      summary: {
        sales_count: summary.sales_count,
        sales_subtotal_no_tax: summary.sales_subtotal_no_tax,
        sales_tax_total: summary.sales_tax_total,
        net_sales: summary.net_sales,
        appointment_count: summary.appointment_count,
        online_order_count: summary.online_order_count,
        new_wedding_parties_count: summary.new_wedding_parties_count,
        stripe_fees_total: summary.stripe_fees_total,
        cash_collected: summary.cash_collected,
        deposits_collected: summary.deposits_collected,
      },
      activities: summary.activities.map(a => ({
        ...a,
        items: a.items?.map(i => ({
          name: i.name,
          sku: i.sku,
          quantity: i.quantity,
          reg_price: i.reg_price || i.price,
          price: i.price
        }))
      }))
    });
  };

  const handleExportCSV = () => {
    if (!summary?.activities.length) return;
    const rows = summary.activities.flatMap(a => {
      const itemRows = (a.items || []).map((item, idx) => ({
        "Date": new Date(a.occurred_at).toLocaleDateString(),
        "Time": new Date(a.occurred_at).toLocaleTimeString(),
        "Kind": a.kind,
        "Order ID": a.order_id || "",
        "Customer Name": a.customer_name || "",
        "Customer #": a.customer_code || "",
        "Wedding Party": a.wedding_party_name || "",
        "Item": item.name,
        "SKU": item.sku,
        "Qty": item.quantity,
        "Reg Price": item.reg_price,
        "Sale Price": item.price,
        "Takeaway": a.is_takeaway ? "Yes" : "No",
        "Fulfillment": a.fulfillment_type || "",
        "Deposit Paid": idx === 0 ? (a.deposits_paid || "0") : "",
        "Balance Due": idx === 0 ? (a.balance_due || "0") : "",
        "Transaction Total": idx === 0 ? (a.transaction_total || a.amount_label || "0") : "",
        "Sales Total": idx === 0 ? (a.sales_total || "0") : "",
        "Tax": idx === 0 ? (a.tax_total || "0") : "",
        "Net Total": idx === 0 ? (a.amount_label || "0") : "",
      }));
      return itemRows;
    });
    const headers = ["Date", "Time", "Kind", "Order ID", "Customer Name", "Customer #", "Wedding Party", "Item", "SKU", "Qty", "Reg Price", "Sale Price", "Takeaway", "Fulfillment", "Deposit Paid", "Balance Due", "Transaction Total", "Sales Total", "Tax", "Net Total"];
    const csv = [headers.join(","), ...rows.map(r => headers.map(h => {
      const v = r[h as keyof typeof r]?.toString() || "";
      return v.includes(",") ? `"${v}"` : v;
    }).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `daily-sales-${preset}.csv`;
    a.click();
  };

  return (
    <div className="flex flex-1 flex-col bg-app-surface p-4 sm:p-6">
      <ReceiptSummaryModal
        transactionId={receiptOrderId}
        onClose={() => setReceiptOrderId(null)}
        baseUrl={baseUrl}
        registerSessionId={sessionId}
        getAuthHeaders={apiAuth}
      />

      {/* Header */}
      <div className="mb-4 flex shrink-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">Register</p>
            <h2 className="text-2xl font-black tracking-tight text-app-text">Daily Sales</h2>
            {summary && (
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                {rangeLabel}
                <span className="mx-1.5 opacity-40">·</span>
                <span className="font-mono">{summary.timezone}</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-1 rounded-2xl border border-app-border bg-app-surface-2 p-1 shadow-inner">
          <button type="button" onClick={() => setView("dashboard")} className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${view === "dashboard" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
            Dashboard
          </button>
          <button type="button" onClick={() => setView("activity")} className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${view === "activity" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
            Activity
          </button>
          <button type="button" onClick={() => setView("z-reports")} className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${view === "z-reports" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
            Z-Reports
          </button>
        </div>
      </div>

      {/* Filters */}
      {view === "activity" && (
        <div className="mb-4 shrink-0 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">View Mode</span>
            <div className="flex gap-1 rounded-2xl border border-app-border bg-app-surface-2 p-1">
              <button type="button" onClick={() => { setReportBasis("fulfilled"); setSummary(summaryBooked); setSummaryBooked(summary); }} className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${reportBasis === "fulfilled" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
                Fulfilled (Pickup)
              </button>
              <button type="button" onClick={() => { setReportBasis("booked"); const temp = summary; setSummary(summaryBooked); setSummaryBooked(temp); }} className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${reportBasis === "booked" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
                Booked (Sale)
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" onClick={() => setPreset(p.id)} className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-all ${preset === p.id ? "bg-app-accent text-white shadow-md shadow-app-accent/25" : "border border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent/40 hover:text-app-text"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {view === "dashboard" && (
        <div className="mb-4 shrink-0 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" onClick={() => setPreset(p.id)} className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-all ${preset === p.id ? "bg-app-accent text-white shadow-md shadow-app-accent/25" : "border border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent/40 hover:text-app-text"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {view !== "z-reports" && preset === "custom" && (
        <div className="mb-4 flex shrink-0 flex-wrap items-end gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            From
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="ui-input rounded-xl px-3 py-2 text-sm font-semibold" />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            To
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="ui-input rounded-xl px-3 py-2 text-sm font-semibold" />
          </label>
          <button type="button" onClick={() => { fetchSummary("booked"); fetchSummary("fulfilled"); }} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white shadow-[0_4px_0_0_rgb(6,95,70)] transition hover:bg-emerald-500">
            Apply
          </button>
        </div>
      )}

      {!sessionId && view !== "z-reports" && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-app-text">
          <span className="font-bold">Store-wide view.</span> Managers with register.reports see every lane.
        </div>
      )}

      {/* Content Area */}
      <div className="flex flex-1 flex-col rounded-[24px] border border-app-border bg-app-surface-2/50 shadow-[0_20px_50px_-32px_rgba(0,0,0,0.35)]">

        {/* Dashboard View */}
        {view === "dashboard" && (
          loading ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
            </div>
          ) : (
            <div className="flex flex-col gap-2 p-3">
              <div className="flex gap-2 mb-2">
                <button type="button" onClick={handlePrint} className="ui-btn-secondary flex items-center gap-1.5 border-emerald-500/30 px-3 py-1.5 text-xs font-black text-emerald-700 hover:bg-emerald-500 hover:text-white">
                  <Printer size={12} />Print
                </button>
                <button type="button" onClick={handleExportCSV} className="ui-btn-secondary flex items-center gap-1.5 border-app-border px-3 py-1.5 text-xs font-black text-app-text hover:bg-app-surface">
                  <Download size={12} />CSV
                </button>
              </div>

              {/* Booked Summary - First and Default */}
              {summaryBooked && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <DollarSign className="h-3 w-3 text-emerald-600" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-emerald-700">Booked (Sale)</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-emerald-600">Sales #</div>
                      <p className="text-lg font-black text-emerald-700">{summaryBooked.sales_count}</p>
                    </div>
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-emerald-600">Sales $</div>
                      <p className="text-lg font-black text-emerald-700">${centsToFixed2(parseMoneyToCents(summaryBooked.sales_subtotal_no_tax))}</p>
                    </div>
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-amber-600">Tax</div>
                      <p className="text-lg font-black text-amber-600">${centsToFixed2(parseMoneyToCents(summaryBooked.sales_tax_total))}</p>
                    </div>
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-rose-600">Fees</div>
                      <p className="text-lg font-black text-rose-600">${centsToFixed2(parseMoneyToCents(summaryBooked.stripe_fees_total))}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-black uppercase text-blue-700">Cash Taken</span>
                        <span className="text-lg font-black text-blue-700">${summaryBooked.cash_collected}</span>
                      </div>
                    </div>
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-black uppercase text-emerald-700">Deposits Taken</span>
                        <span className="text-lg font-black text-emerald-700">${summaryBooked.deposits_collected}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Fulfilled Summary */}
              {summary && (
                <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Truck className="h-3 w-3 text-sky-600" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-sky-700">Fulfilled</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-sky-600">Orders</div>
                      <p className="text-lg font-black text-sky-700">{summary.pickup_count || 0}</p>
                    </div>
                    <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-sky-600">Revenue</div>
                      <p className="text-lg font-black text-sky-700">${centsToFixed2(parseMoneyToCents(summary.sales_subtotal_no_tax))}</p>
                    </div>
                    <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-sky-600">Tax</div>
                      <p className="text-lg font-black text-sky-700">${centsToFixed2(parseMoneyToCents(summary.sales_tax_total))}</p>
                    </div>
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2">
                      <div className="text-[9px] font-black uppercase text-emerald-700">Net</div>
                      <p className="text-lg font-black text-emerald-700">${centsToFixed2(parseMoneyToCents(summary.net_sales))}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Additional Metrics - Compact */}
              <div className="grid grid-cols-4 gap-2">
                <div className="rounded-lg border border-app-border bg-app-surface p-2">
                  <div className="flex items-center gap-1 text-[9px] font-black uppercase text-app-text-muted"><Calendar className="h-2.5 w-2.5" />Appts</div>
                  <p className="text-base font-black">{summaryBooked?.appointment_count || 0}</p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-surface p-2">
                  <div className="flex items-center gap-1 text-[9px] font-black uppercase text-app-text-muted"><Globe className="h-2.5 w-2.5" />Online</div>
                  <p className="text-base font-black">{summaryBooked?.online_order_count || 0}</p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-surface p-2">
                  <div className="flex items-center gap-1 text-[9px] font-black uppercase text-app-text-muted"><Heart className="h-2.5 w-2.5" />Weddings</div>
                  <p className="text-base font-black">{summaryBooked?.new_wedding_parties_count || 0}</p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-surface p-2">
                  <div className="flex items-center gap-1 text-[9px] font-black uppercase text-app-text-muted"><Package className="h-2.5 w-2.5" />Orders</div>
                  <p className="text-base font-black">{summaryBooked?.special_order_sale_count || 0}</p>
                </div>
              </div>
              {/* Combined Totals Placeholder - already handled by individual summary boxes */}
            </div>
          )
        )}

        {/* Activity View */}
        {view === "activity" && (
          loading ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <p className="font-bold text-app-text">{error}</p>
              <button type="button" onClick={() => { fetchSummary("booked"); fetchSummary("fulfilled"); }} className="mt-4 text-sm font-bold text-app-accent hover:underline">Try again</button>
            </div>
          ) : groupedActivities.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-app-text-muted">No activity in this range.</div>
          ) : (
            <div className="flex flex-col gap-4 p-3 sm:p-4">
              <div className="flex justify-end gap-2 mb-2">
                <button type="button" onClick={handlePrint} className="ui-btn-secondary flex items-center gap-2 border-emerald-500/30 px-3 py-1.5 text-xs font-black text-emerald-700 hover:bg-emerald-500 hover:text-white">
                  <Printer size={12} />Print
                </button>
                <button type="button" onClick={handleExportCSV} className="ui-btn-secondary flex items-center gap-2 border-app-border px-3 py-1.5 text-xs font-black text-app-text hover:bg-app-surface">
                  <Download size={12} />Export
                </button>
              </div>
              {groupedActivities.map((group) => (
                <div key={group.date} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between border-b border-app-border pb-2">
                    <div>
                      <span className="text-xs font-black uppercase tracking-wider text-app-text">{group.label}</span>
                      <span className="ml-2 text-[10px] text-app-text-muted">({group.count} transactions)</span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-black text-app-text-muted">Total: </span>
                      <span className="text-sm font-black text-app-accent">${group.total_sales}</span>
                    </div>
                  </div>
                  {group.activities.map((row) => (
                    <div 
                      key={row.id} 
                      className="group relative flex flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm transition-all mb-4"
                    >
                      <div className="flex flex-col lg:flex-row lg:items-stretch divide-y lg:divide-y-0 lg:divide-x divide-app-border">
                        {/* 1. Transaction Overview (Left) */}
                        <div className="p-5 lg:w-1/4 flex flex-col justify-between bg-app-surface-2/20">
                          <div>
                            <div className="flex items-center gap-2 mb-3">
                               <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ring-1 shadow-sm ${kindPill(row.kind)}`}>
                                 {row.title}
                               </span>
                               <span className="text-[10px] font-bold text-app-text-muted flex items-center gap-1 opacity-60">
                                 <Clock size={10} />
                                 {new Date(row.occurred_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                               </span>
                            </div>
                            <div className="flex flex-col gap-1">
                               <h4 className="text-base font-black text-app-text tracking-tight flex items-start gap-2">
                                 <User size={16} className="text-app-text-muted opacity-30 mt-0.5 shrink-0" />
                                 <span className="truncate">{row.customer_name || "Walk-in Customer"}</span>
                               </h4>
                               <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                 {row.customer_code && <span className="ui-pill text-[8px] font-black tracking-widest bg-app-surface text-app-text-muted">#{row.customer_code}</span>}
                                 {row.wedding_party_name && (
                                   <button 
                                     type="button" 
                                     onClick={(e) => {
                                       e.stopPropagation();
                                       if (row.wedding_party_id && onOpenWeddingParty) onOpenWeddingParty(row.wedding_party_id);
                                     }}
                                     className="flex items-center gap-1 rounded bg-rose-500/5 px-2 py-0.5 text-[9px] font-black text-rose-600 ring-1 ring-rose-500/20 hover:bg-rose-500/10 transition-colors uppercase"
                                   >
                                     <Heart size={10} /> {row.wedding_party_name}
                                   </button>
                                 )}
                               </div>
                               <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                                  <span className="font-mono text-[10px] font-black text-app-text uppercase tracking-tighter bg-app-surface-2 px-1.5 py-0.5 rounded">#{row.short_id || row.order_id?.slice(0, 8)}</span>
                                  {row.is_takeaway && <span className="text-[8px] font-black bg-orange-500/10 text-orange-600 px-1.5 py-0.5 rounded uppercase leading-none">Takeaway</span>}
                                  {row.channel === 'web' && <span className="text-[8px] font-black bg-sky-500/10 text-sky-600 px-1.5 py-0.5 rounded uppercase flex items-center gap-1 leading-none"><Globe size={8}/> Online</span>}
                               </div>
                            </div>
                          </div>
                          
                          <div className="mt-4 pt-4 border-t border-app-border/40">
                             <button type="button" onClick={() => setReceiptOrderId(row.order_id!)} className="ui-btn-secondary w-full py-2 flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest hover:bg-app-accent hover:text-white transition-all shadow-sm">
                                <Receipt size={14} /> Receipt
                             </button>
                          </div>
                        </div>

                        {/* 2. Items Ledger (Middle) */}
                        <div className="p-5 flex-1 lg:max-w-xl">
                           <div className="mb-3 flex items-center justify-between">
                              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Line Items</h5>
                              <span className="text-[10px] font-bold text-app-text-muted opacity-40">({row.items?.length || 0} units)</span>
                           </div>
                           <table className="w-full text-left">
                              <thead>
                                 <tr className="text-[8px] font-black uppercase tracking-[0.1em] text-app-text-muted border-b border-app-border/40 pb-2">
                                    <th className="pb-2">Description / SKU</th>
                                    <th className="pb-2 text-center">Qty</th>
                                    <th className="pb-2 text-center">Reg</th>
                                    <th className="pb-2 text-center">Sale</th>
                                    <th className="pb-2 text-right">Fulfillment</th>
                                 </tr>
                              </thead>
                              <tbody className="divide-y divide-app-border/20">
                                 {row.items?.map((it, i) => (
                                    <tr key={i} className="text-[11px] hover:bg-app-surface-2/30 transition-colors">
                                       <td className="py-2.5 pr-4">
                                          <div className="font-black text-app-text leading-snug">{it.name}</div>
                                          <div className="font-mono text-[9px] text-app-text-muted opacity-40 uppercase tracking-tighter mt-0.5">{it.sku}</div>
                                       </td>
                                       <td className="py-2.5 text-center align-top font-bold text-app-text">{it.quantity}</td>
                                       <td className="py-2.5 text-center align-top text-app-text-muted/60 line-through font-medium tracking-tighter tabular-nums">${it.reg_price}</td>
                                       <td className="py-2.5 text-center align-top font-black text-app-text tracking-tighter tabular-nums">${it.price}</td>
                                       <td className="py-2.5 text-right align-top">
                                          <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-tight ${
                                             it.fulfillment === 'takeaway' ? 'bg-orange-500/10 text-orange-600' :
                                             it.fulfillment === 'special_order' || it.fulfillment === 'custom' ? 'bg-sky-500/10 text-sky-600' :
                                             it.fulfillment === 'layaway' ? 'bg-purple-500/10 text-purple-600' : it.fulfillment === 'pickup' ? 'bg-emerald-500/10 text-emerald-600' :
                                             'bg-app-surface-2 text-app-text-muted font-bold'
                                          }`}>
                                             {it.fulfillment === 'takeaway' ? 'TAKEN' : it.fulfillment === 'special_order' || it.fulfillment === 'custom' ? 'ORDERED' : it.fulfillment === 'layaway' ? 'LAYAWAY' : it.fulfillment === 'pickup' ? 'PICKUP' : it.fulfillment?.toUpperCase() || 'UNKNOWN'}
                                          </span>
                                       </td>
                                    </tr>
                                 ))}
                                 {!row.items?.length && (
                                   <tr>
                                      <td colSpan={5} className="py-8 text-center text-xs italic text-app-text-muted opacity-40">No item details recorded for this transaction</td>
                                   </tr>
                                 )}
                              </tbody>
                           </table>
                        </div>

                        {/* 3. Financial Breakdown (Right) */}
                        <div className="p-5 lg:w-1/4 bg-app-surface-2/10 flex flex-col justify-between">
                           <div className="space-y-3">
                              <div className="flex flex-col items-end gap-0.5">
                                 <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Sales Total (Booked)</span>
                                 <span className="text-lg font-black text-app-text tabular-nums leading-none tracking-tighter">
                                   ${row.sales_total || "0.00"}
                                 </span>
                              </div>
                              
                              <div className="flex flex-col items-end gap-0.5 pt-2 border-t border-app-border/40">
                                 <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600">Deposits Taken / Trans. Total</span>
                                 <span className="text-base font-black text-emerald-700 tabular-nums leading-none tracking-tighter">
                                   ${row.transaction_total || "0.00"}
                                 </span>
                                 <div className="flex items-center gap-1 text-[9px] font-bold text-app-text-muted mt-1 opacity-60">
                                    {row.payment_summary && (
                                       <>
                                         {paymentIcon(row.payment_summary)}
                                         <span className="uppercase tracking-tighter tabular-nums">{row.payment_summary}</span>
                                       </>
                                    )}
                                 </div>
                              </div>
                           </div>

                           <div className="mt-6 pt-4 border-t-2 border-app-border flex flex-col items-end">
                              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted mb-1">Balance Due</span>
                              <span className="text-3xl font-black text-app-accent tabular-nums tracking-tighter leading-none">
                                 ${row.balance_due || "0.00"}
                              </span>
                           </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {/* Grand Total */}
              {reportBasis === "booked" ? summaryBooked && (
                <div className="mt-4 flex items-center justify-between rounded-xl border-2 border-emerald-500 bg-emerald-500/5 px-4 py-3">
                  <span className="text-sm font-black uppercase text-emerald-700">Daily Total ({summaryBooked.activities.length} transactions)</span>
                  <div className="text-right">
                    <span className="text-xs font-black text-app-text-muted">Subtotal: ${centsToFixed2(parseMoneyToCents(summaryBooked.sales_subtotal_no_tax))}</span>
                    <span className="mx-2">|</span>
                    <span className="text-sm font-black text-emerald-700">Total: {summaryBooked.amount_label}</span>
                  </div>
                </div>
              ) : summary && (
                <div className="mt-4 flex items-center justify-between rounded-xl border-2 border-sky-500 bg-sky-500/5 px-4 py-3">
                  <span className="text-sm font-black uppercase text-sky-700">Daily Total ({summary.activities.length} transactions)</span>
                  <div className="text-right">
                    <span className="text-xs font-black text-app-text-muted">Subtotal: ${centsToFixed2(parseMoneyToCents(summary.sales_subtotal_no_tax))}</span>
                    <span className="mx-2">|</span>
                    <span className="text-sm font-black text-sky-700">Total: {summary.amount_label}</span>
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {/* Z-Reports View */}
        {view === "z-reports" && (
          zLoading ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b border-app-border bg-app-surface/80 px-4 py-3 sm:px-6">
                <div className="flex gap-1 rounded-xl border border-app-border bg-app-surface-2 p-1">
                  {[
                    { id: "recent" as const, label: "Recent" },
                    { id: "today" as const, label: "Today" },
                    { id: "yesterday" as const, label: "Yesterday" },
                    { id: "this_week" as const, label: "Week" },
                    { id: "this_month" as const, label: "Month" },
                    { id: "custom" as const, label: "Custom" },
                  ].map((p) => (
                    <button key={p.id} type="button" onClick={() => setZPreset(p.id)} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${zPreset === p.id ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {zPreset === "custom" && (
                  <div className="flex items-center gap-2">
                    <input type="date" value={customFromZ} onChange={(e) => setCustomFromZ(e.target.value)} className="ui-input rounded-lg px-3 py-2 text-sm" />
                    <span className="text-app-text-muted">to</span>
                    <input type="date" value={customToZ} onChange={(e) => setCustomToZ(e.target.value)} className="ui-input rounded-lg px-3 py-2 text-sm" />
                    <button type="button" onClick={() => void fetchZLogs()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500">Apply</button>
                  </div>
                )}
              </div>
              <div className="border-b border-app-border bg-app-surface-2/40 px-4 py-4 sm:px-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                      Register coordination
                    </p>
                    <p className="mt-1 text-sm font-semibold text-app-text">
                      See which drawers are still open, which till group is already closing, and where staff should avoid duplicate close work.
                    </p>
                  </div>
                  <div className="grid min-w-[240px] gap-2 sm:grid-cols-3">
                    {[
                      ["Active sessions", String(coordinationSummary.activeSessions)],
                      ["Open drawers", String(coordinationSummary.openDrawers)],
                      ["Pending closes", String(coordinationSummary.pendingCloses)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-xl border border-app-border bg-app-surface px-3 py-3 text-center"
                      >
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          {label}
                        </p>
                        <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                {coordinationSummary.pendingCloses > 0 ? (
                  <div className="mt-3 rounded-xl border border-amber-300 bg-amber-100/90 px-4 py-3 text-sm text-amber-900">
                    <p className="text-[10px] font-black uppercase tracking-widest">
                      Pending close in progress
                    </p>
                    <p className="mt-1 font-semibold leading-relaxed">
                      One or more till groups are already reconciling. Finish the active close from Register #1 before another staff member starts a second Z-close attempt.
                    </p>
                  </div>
                ) : null}
                <div className="mt-3 rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm text-app-text-muted">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                    Shared drawer rule
                  </p>
                  <p className="mt-1 leading-relaxed">
                    Each till group has one physical drawer. Satellite lanes stay visible here, but final Z-close still runs once from Register #1 for the whole group.
                  </p>
                </div>
                {openSessionsError ? (
                  <p className="mt-3 text-xs font-semibold text-app-text-muted">
                    {openSessionsError}
                  </p>
                ) : coordinationGroups.length === 0 ? (
                  <p className="mt-3 text-xs font-semibold text-app-text-muted">
                    No open drawers are visible right now.
                  </p>
                ) : (
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {coordinationGroups.map((group) => {
                      const isReconciling = group.sessions.some(
                        (session) => session.lifecycle_status === "reconciling",
                      );
                      const primarySession = primaryRegisterSession(group.sessions);
                      return (
                        <div
                          key={group.tillCloseGroupId}
                          className="rounded-2xl border border-app-border bg-app-surface px-4 py-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Drawer group
                              </p>
                              <p className="mt-1 text-sm font-black text-app-text">
                                {primarySession
                                  ? `Register #${primarySession.register_lane} close anchor`
                                  : "Shared till group"}
                              </p>
                              <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
                                Shift ID {group.tillCloseGroupId.slice(0, 8)}…
                              </p>
                            </div>
                            <span
                              className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
                                isReconciling
                                  ? "border-amber-300 bg-amber-100/90 text-amber-900"
                                  : "border-sky-200 bg-sky-50 text-sky-900"
                              }`}
                            >
                              {isReconciling ? "Closing now" : "Open"}
                            </span>
                          </div>
                          <div className="mt-3 space-y-2">
                            {group.sessions.map((session) => (
                              <div
                                key={session.session_id}
                                className="flex items-center justify-between gap-3 rounded-xl border border-app-border/70 bg-app-surface-2/60 px-3 py-3"
                              >
                                <div>
                                  <p className="text-sm font-black text-app-text">
                                    Register #{session.register_lane}
                                  </p>
                                  <p className="text-[11px] font-semibold text-app-text-muted">
                                    {session.cashier_name} · opened{" "}
                                    {new Date(session.opened_at).toLocaleString(undefined, {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    })}
                                  </p>
                                </div>
                                <span
                                  className={`rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest ${registerLifecycleTone(
                                    session.lifecycle_status,
                                  )}`}
                                >
                                  {registerLifecycleLabel(session.lifecycle_status)}
                                </span>
                              </div>
                            ))}
                          </div>
                          <p className="mt-3 text-[11px] font-medium leading-relaxed text-app-text-muted">
                            {isReconciling
                              ? "This group is already in reconciliation. Avoid starting another close from a linked register."
                              : "Close this shared drawer from Register #1 when every linked lane in the till group is ready."}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {zLogs.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-20 text-app-text-muted">
                  No register sessions recorded in this range.
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-app-border overflow-y-auto">
                  {zLogs.map((session) => (
                    <li key={session.id} className="flex items-center gap-4 px-4 py-4 sm:px-6 hover:bg-app-surface/50">
                      <div className="flex-1">
                        <p className="text-xs font-bold text-app-text-muted">
                          Register #{session.register_lane} · Session #{session.register_ordinal}
                        </p>
                        <p className="font-black text-app-text">{session.cashier_name}</p>
                        <p className="text-sm text-app-text-muted">
                          Opened {new Date(session.opened_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-app-text-muted">Closed</p>
                        <p className="font-bold text-app-text">
                          {session.closed_at
                            ? new Date(session.closed_at).toLocaleString(undefined, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : "Still open"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="mb-1">
                          <span className="rounded-full border border-app-border bg-app-surface px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Z-close anchor
                          </span>
                        </p>
                        <p className="text-xl font-black tabular-nums text-app-accent">${centsToFixed2(parseMoneyToCents(session.total_sales))}</p>
                        <p className="text-xs text-app-text-muted">Exp. cash ${centsToFixed2(parseMoneyToCents(session.expected_cash ?? "0"))}</p>
                        {session.discrepancy &&
                        Math.abs(parseMoneyToCents(session.discrepancy)) > 0 ? (
                          <p className="text-xs font-black text-amber-600">
                            Discrepancy ${centsToFixed2(parseMoneyToCents(session.discrepancy))}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        )}
      </div>

      <ProductHubDrawer
        isOpen={!!hubProductId}
        productId={hubProductId}
        onClose={() => setHubProductId(null)}
        baseUrl={baseUrl}
      />
    </div>
  );
}
