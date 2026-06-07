import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeDollarSign,
  Banknote,
  BarChart3,
  CalendarHeart,
  ChevronLeft,
  ClipboardList,
  CreditCard,
  Download,
  PackageSearch,
  Printer,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  PIVOT_GROUP_OPTIONS,
  REPORT_CATEGORY_DETAILS,
  REPORT_CATEGORY_ORDER,
  REPORTS_CATALOG,
  compareReportsForLibrary,
  isAvailableReport,
  reportSearchScore,
  reportVisible,
  type ReportCategory,
  type ReportChartConfig,
  type ReportDef,
  type ReportUrlContext,
} from "../../lib/reportsCatalog";
import { openProfessionalTablePrint } from "../pos/zReportPrint";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { isTauri } from "@tauri-apps/api/core";

const baseUrl = getBaseUrl();

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultRange(): { from: string; to: string } {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 90);
  return { from: ymd(start), to: ymd(end) };
}

function toCellString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const MONEY_FIELD_PATTERN =
  /(^|_)(amount|balance|cash|commission|cost|deposit|discount|fee|fees|gross|margin|net|paid|price|revenue|sale|sales|subtotal|tax|total|variance|volume)($|_)/i;
const DATE_FIELD_PATTERN = /(^|_)(date|day)$|_at$|time$/i;
const ENUM_FIELD_PATTERN =
  /(^|_)(basis|category|fulfillment|kind|method|reason|source|status|type|area)($|_)/i;

const HIDDEN_REPORT_FIELDS = new Set([
  "id",
  "customer_id",
  "event_id",
  "fulfillment_order_id",
  "line_id",
  "operator_staff_id",
  "order_id",
  "payment_transaction_id",
  "product_id",
  "register_session_id",
  "session_id",
  "staff_id",
  "transaction_id",
  "transaction_line_id",
  "variant_id",
  "wedding_party_id",
  "snapshot_json",
  "z_report_json",
]);

function looksTechnicalField(key: string): boolean {
  const k = key.toLocaleLowerCase();
  if (HIDDEN_REPORT_FIELDS.has(k)) return true;
  if (k.endsWith("_json") || k.endsWith("_metadata") || k === "metadata") return true;
  if (k.endsWith("_uuid")) return true;
  if (k.endsWith("_id") && !k.endsWith("_display_id")) return true;
  return false;
}

function hasDisplayValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function keysFromRowsForDisplay(rows: Record<string, unknown>[]): string[] {
  return keysFromRows(rows).filter((key) => {
    if (looksTechnicalField(key)) return false;
    return rows.some((row) => hasDisplayValue(row[key]));
  });
}

function titleizeValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value;
}

function formatMoney(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }
  if (typeof value === "string" && value.trim() && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value).toLocaleString(undefined, { style: "currency", currency: "USD" });
  }
  return null;
}

function formatDateValue(value: unknown, includeTime: boolean): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return includeTime ? parsed.toLocaleString() : parsed.toLocaleDateString();
}

function formatWeatherSnapshot(value: unknown): string | null {
  const firstDay = Array.isArray(value) ? value[0] : value;
  if (!firstDay || typeof firstDay !== "object") return null;
  const row = firstDay as Record<string, unknown>;
  const condition = typeof row.condition === "string" ? row.condition.trim() : "";
  const high = numberFromUnknown(row.temp_high);
  const low = numberFromUnknown(row.temp_low);
  const precip = numberFromUnknown(row.precipitation_inches);
  const parts = [
    condition,
    high !== null ? `High ${high.toFixed(0)}°` : null,
    low !== null ? `Low ${low.toFixed(0)}°` : null,
    precip !== null ? `Precip ${precip.toFixed(2)} in` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatCellValue(value: unknown, key: string): string {
  if (value === null || value === undefined) return "";
  if (key === "weather_snapshot") return formatWeatherSnapshot(value) ?? "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    return value
      .map((item) => (MONEY_FIELD_PATTERN.test(key) ? formatMoney(item) || toCellString(item) : toCellString(item)))
      .join(", ");
  }
  if (MONEY_FIELD_PATTERN.test(key)) {
    const money = formatMoney(value);
    if (money) return money;
  }
  if (DATE_FIELD_PATTERN.test(key)) {
    const date = formatDateValue(value, key.endsWith("_at") || key.endsWith("time"));
    if (date) return date;
  }
  if (typeof value === "string") {
    if (key === "phone" || key.endsWith("_phone")) return formatPhone(value);
    if (ENUM_FIELD_PATTERN.test(key)) return titleizeValue(value);
    return value;
  }
  if (typeof value === "object") return "";
  return String(value);
}

function rowsFromUnknown(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const o = data as Record<string, unknown>;
  if (Array.isArray(o.rows)) return o.rows as Record<string, unknown>[];
  if (Array.isArray(o.transactions)) return o.transactions as Record<string, unknown>[];
  return [];
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatChartMetric(value: number, format: ReportChartConfig["valueFormat"]): string {
  if (format === "money") {
    return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }
  if (format === "points") {
    return `${value.toLocaleString()} pts`;
  }
  return value.toLocaleString();
}

function ReportMiniChart({
  config,
  rows,
}: {
  config: ReportChartConfig;
  rows: Record<string, unknown>[];
}) {
  const data = rows
    .map((row) => ({
      label: formatCellValue(row[config.labelKey], config.labelKey) || "Unspecified",
      value: numberFromUnknown(row[config.valueKey]),
      secondaryValue: config.secondaryValueKey
        ? numberFromUnknown(row[config.secondaryValueKey])
        : null,
    }))
    .filter(
      (item): item is { label: string; value: number; secondaryValue: number | null } =>
        item.value !== null,
    )
    .slice(0, config.limit ?? 8);

  if (data.length === 0) return null;

  const max = Math.max(
    1,
    ...data.flatMap((item) => [
      Math.abs(item.value),
      item.secondaryValue === null ? 0 : Math.abs(item.secondaryValue),
    ]),
  );

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-[0.2em] text-app-text">
          {config.title}
        </h3>
        <span className="text-[11px] font-bold text-app-text-muted">Top {data.length}</span>
      </div>
      <div className="space-y-3">
        {data.map((item, index) => {
          const width = `${Math.max(4, (Math.abs(item.value) / max) * 100)}%`;
          const secondaryWidth =
            item.secondaryValue === null
              ? null
              : `${Math.max(4, (Math.abs(item.secondaryValue) / max) * 100)}%`;
          return (
            <div key={`${item.label}-${index}`} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate font-bold text-app-text-muted">
                  {item.label}
                </span>
                <span className="shrink-0 font-black text-app-text">
                  {formatChartMetric(item.value, config.valueFormat)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-app-surface-2">
                <div
                  className={`h-full rounded-full ${
                    item.value < 0 ? "bg-app-danger/70" : "bg-app-accent/75"
                  }`}
                  style={{ width }}
                />
              </div>
              {secondaryWidth ? (
                <div className="h-1 overflow-hidden rounded-full bg-app-surface-2/70">
                  <div
                    className="h-full rounded-full bg-app-warning/75"
                    style={{ width: secondaryWidth }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function keysFromRows(rows: Record<string, unknown>[]): string[] {
  const s = new Set<string>();
  for (const r of rows.slice(0, 50)) {
    for (const k of Object.keys(r)) s.add(k);
  }
  return Array.from(s);
}

const FIELD_LABELS: Record<string, string> = {
  appointment_type: "Appointment Type",
  appointment_count: "Appointments",
  appointment_date: "Appointment Date",
  avg_discount_percent: "Avg. Discount %",
  brand: "Brand",
  cashier_name: "Cashier",
  category: "Category",
  completed_count: "Completed",
  customer_display: "Customer",
  customer_display_name: "Customer",
  customer_name: "Customer",
  cancellation_count: "Cancellations",
  date: "Date",
  event_date: "Event Date",
  exempt_sales: "Exempt Sales",
  expected_cash: "Expected Cash",
  follow_up_reason: "Follow-Up Reason",
  from_eod_snapshot: "Closed-Day Snapshot",
  fees: "Processing Fees",
  from: "From",
  from_local: "From",
  gross: "Gross",
  gross_amount: "Gross Amount",
  gross_margin: "Gross Margin",
  gross_sales: "Gross Sales",
  label_cost: "Label Cost",
  label_count: "Labels",
  last_transaction_at: "Last Transaction",
  item_name: "Item",
  is_historical: "Historical Window",
  includes_today: "Includes Today",
  line_count: "Line Count",
  line_units: "Units",
  member_count: "Members",
  merchant_fees_total: "Merchant Fees",
  missing_measurements_count: "Missing Measurements",
  net: "Net",
  net_amount: "Net Amount",
  net_sales: "Net Sales",
  net_velocity: "Net Points",
  new_wedding_parties_count: "New Wedding Parties",
  no_show_count: "No-Shows",
  open_balance: "Open Balance",
  open_balance_total: "Open Balance Total",
  order_count: "Transactions",
  order_short_ref: "Transaction #",
  owner_area: "Owner Area",
  payment_count: "Payments",
  payment_method: "Payment Method",
  payment_provider: "Processor",
  provider_status: "Provider Status",
  pending_alteration_count: "Pending Alterations",
  pending_pickup_count: "Pending Pickups",
  payments_total: "Payments",
  points_burned: "Points Used",
  points_earned: "Points Earned",
  product_name: "Product",
  quoted_amount: "Quoted Amount",
  quantity: "Quantity",
  reason: "Reason",
  record_kind: "Record Type",
  recent_transaction_count: "Recent Transactions",
  recommended_action: "Recommended Action",
  recognized_at: "Completed At",
  register_id: "Register",
  register_number: "Register #",
  report_date: "Report Date",
  reporting_basis: "Basis",
  revenue_momentum: "Last 7 Days",
  risk_count: "Risk Count",
  risk_type: "Risk Type",
  oldest_at: "Oldest Item",
  sales_count: "Sales Count",
  sales_subtotal_no_tax: "Sales Before Tax",
  sales_tax_total: "Sales Tax",
  sales_volume: "Sales Volume",
  salesperson: "Salesperson",
  session_id: "Session",
  sku: "SKU",
  staff_name: "Staff",
  scheduled_staff_count: "Scheduled Staff",
  shipment_or_pickup_risk_count: "Shipment/Pickup Risk",
  shipment_count: "Shipments",
  shipping_charged: "Shipping Charged",
  shipping_margin: "Shipping Margin",
  stale_rms_charge_count: "Stale RMS Charges",
  tax_collected: "Tax Collected",
  taxable_sales: "Taxable Sales",
  to: "To",
  to_local: "To",
  total: "Total",
  total_cost: "Total Cost",
  total_discount: "Total Discount",
  total_fees: "Processing Fees",
  total_net: "Net Total",
  total_sales: "Sales Total",
  total_amount: "Total Amount",
  transaction_count: "Transactions",
  transaction_total: "Transaction Total",
  unit_cost: "Unit Cost",
  units_sold: "Units Sold",
  unpaid_balance_count: "Unpaid Members",
  unpaid_balance_total: "Unpaid Balance Total",
  unfulfilled_item_count: "Unfulfilled Items",
  upcoming_wedding_date: "Upcoming Wedding Date",
  variance: "Variance",
  walk_in_count: "Walk-Ins",
  wedding_linked_count: "Wedding-Linked",
  wedding_party_name: "Wedding Party",
  weather_snapshot: "Weather",
  weather_summary: "Weather",
};

function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function rowsWithDisplayLabels(
  rows: Record<string, unknown>[],
  columns: string[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of columns) out[fieldLabel(column)] = formatCellValue(row[column], column);
    return out;
  });
}

async function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  const cols = keysFromRows(rows);
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(toCellString(r[c]))).join(",")),
  ];
  const csvContent = lines.join("\n");

  if (isTauri()) {
    // In Tauri, use the save dialog API
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const filePath = await save({
        defaultPath: filename,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, csvContent);
      }
    } catch (err) {
      console.error("Tauri save failed:", err);
      // Fallback to browser method
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }
  } else {
    // Browser/PWA: use standard download
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
}

const REGISTER_DAY_SUMMARY_FIELDS = [
  "from_local",
  "to_local",
  "reporting_basis",
  "sales_count",
  "sales_subtotal_no_tax",
  "sales_tax_total",
  "net_sales",
  "cash_collected",
  "deposits_collected",
  "weather_summary",
  "merchant_fees_total",
  "pickup_count",
  "appointment_count",
  "new_wedding_parties_count",
  "includes_today",
  "from_eod_snapshot",
];

type ReportCategoryVisual = {
  icon: LucideIcon;
  accent: string;
  soft: string;
  ring: string;
  chip: string;
};

const REPORT_CATEGORY_VISUALS: Record<ReportCategory, ReportCategoryVisual> = {
  Sales: {
    icon: TrendingUp,
    accent: "text-sky-600",
    soft: "bg-sky-500/10",
    ring: "border-sky-400/40",
    chip: "bg-sky-500/10 text-sky-800 dark:text-sky-100",
  },
  Register: {
    icon: Banknote,
    accent: "text-emerald-600",
    soft: "bg-emerald-500/10",
    ring: "border-emerald-400/40",
    chip: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-100",
  },
  Finance: {
    icon: BadgeDollarSign,
    accent: "text-amber-600",
    soft: "bg-amber-500/10",
    ring: "border-amber-400/40",
    chip: "bg-amber-500/10 text-amber-800 dark:text-amber-100",
  },
  Customers: {
    icon: Users,
    accent: "text-violet-600",
    soft: "bg-violet-500/10",
    ring: "border-violet-400/40",
    chip: "bg-violet-500/10 text-violet-800 dark:text-violet-100",
  },
  Weddings: {
    icon: CalendarHeart,
    accent: "text-pink-600",
    soft: "bg-pink-500/10",
    ring: "border-pink-400/40",
    chip: "bg-pink-500/10 text-pink-800 dark:text-pink-100",
  },
  Inventory: {
    icon: PackageSearch,
    accent: "text-cyan-600",
    soft: "bg-cyan-500/10",
    ring: "border-cyan-400/40",
    chip: "bg-cyan-500/10 text-cyan-800 dark:text-cyan-100",
  },
  Staff: {
    icon: ClipboardList,
    accent: "text-lime-700",
    soft: "bg-lime-500/10",
    ring: "border-lime-400/40",
    chip: "bg-lime-500/10 text-lime-800 dark:text-lime-100",
  },
  Operations: {
    icon: ShieldAlert,
    accent: "text-rose-600",
    soft: "bg-rose-500/10",
    ring: "border-rose-400/40",
    chip: "bg-rose-500/10 text-rose-800 dark:text-rose-100",
  },
};

function ReportTile({ report, onSelect }: { report: ReportDef; onSelect: () => void }) {
  const visual = REPORT_CATEGORY_VISUALS[report.category];
  const Icon = visual.icon;

  return (
    <button
      type="button"
      data-testid={`reports-catalog-card-${report.id}`}
      onClick={onSelect}
      className={`group relative flex h-full w-full overflow-hidden rounded-2xl border ${visual.ring} bg-app-surface p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-app-accent/50 hover:shadow-md`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${visual.soft}`} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col pl-1">
        <span className="flex items-start gap-3">
          <span
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-current/20 ${visual.soft} ${visual.accent}`}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-black text-app-text">{report.title}</span>
            <span className="mt-1 block text-xs font-semibold leading-snug text-app-text-muted">
              {report.description}
            </span>
          </span>
        </span>
        <span className="mt-4 flex flex-wrap gap-1.5">
          <span className={`ui-chip text-xs font-bold ${visual.chip}`}>
            {report.category}
          </span>
          <span className="ui-chip bg-app-surface-2 text-xs font-bold text-app-text-muted">
            For {report.audience}
          </span>
          <span className="ui-chip bg-app-surface-2 text-xs font-bold text-app-text-muted">
            {report.sensitivity === "Staff-safe"
              ? "Staff-safe"
              : `${report.sensitivity} access`}
          </span>
          {!isAvailableReport(report) ? (
            <span className="ui-chip bg-app-accent/10 text-xs font-bold text-app-accent">
              Planned
            </span>
          ) : null}
          {report.adminOnly && report.sensitivity !== "Admin-only" ? (
            <span className="ui-chip bg-app-warning/10 text-xs font-bold text-app-warning">
              Admin only
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function registerDayActivityRows(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const activities = (payload as { activities?: unknown }).activities;
  return Array.isArray(activities) ? (activities as Record<string, unknown>[]) : [];
}

type Props = {
  onOpenMetabaseExplore: () => void;
  onNavigateRegisterReports: () => void;
  onNavigateCommissionPayouts: () => void;
};

export default function ReportsWorkspace({
  onOpenMetabaseExplore,
  onNavigateRegisterReports,
  onNavigateCommissionPayouts,
}: Props) {
  const isCompactLayout = useMediaQuery("(max-width: 1023px)");
  const { backofficeHeaders, hasPermission, permissionsLoaded, staffRole } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [{ from, to }, setRange] = useState(defaultRange);
  const [basis, setBasis] = useState("booked");
  const [groupBy, setGroupBy] = useState<string>("brand");
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState<ReportDef | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const ctx: ReportUrlContext = useMemo(
    () => ({ fromYmd: from, toYmd: to, basis, groupBy }),
    [from, to, basis, groupBy],
  );

  const visible = useMemo(
    () =>
      REPORTS_CATALOG.filter((r) => reportVisible(r, hasPermission, staffRole)).sort(
        compareReportsForLibrary,
      ),
    [hasPermission, staffRole],
  );

  const searchResults = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return visible;
    return visible
      .map((report) => ({ report, score: reportSearchScore(report, query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || compareReportsForLibrary(a.report, b.report))
      .map(({ report }) => report);
  }, [searchQuery, visible]);

  const groupedSearchResults = useMemo(() => {
    const byCategory = new Map<ReportCategory, ReportDef[]>();
    for (const report of searchResults) {
      const reports = byCategory.get(report.category) ?? [];
      reports.push(report);
      byCategory.set(report.category, reports);
    }

    return REPORT_CATEGORY_ORDER.map((category) => ({
      category,
      reports: byCategory.get(category) ?? [],
    })).filter((group) => group.reports.length > 0);
  }, [searchResults]);

  const runLoad = useCallback(
    async (r: ReportDef) => {
      if (!isAvailableReport(r)) return;
      setLoading(true);
      setLoadErr(null);
      setPayload(null);
      try {
        const path = r.buildPath(ctx);
        const res = await fetch(`${baseUrl}${path}`, { headers: apiAuth() });
        const text = await res.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        if (!res.ok) {
          const msg =
            body &&
            typeof body === "object" &&
            "error" in body &&
            typeof (body as { error: unknown }).error === "string"
              ? (body as { error: string }).error
              : `Request failed (${res.status})`;
          setLoadErr(msg);
          return;
        }
        setPayload(body);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : "Load failed");
      } finally {
        setLoading(false);
      }
    },
    [apiAuth, ctx],
  );

  useEffect(() => {
    if (!selected) return;
    if (isAvailableReport(selected)) {
      void runLoad(selected);
      return;
    }
    setLoading(false);
    setLoadErr(null);
    setPayload(null);
  }, [selected, runLoad]);

  const selectedAvailable = selected && isAvailableReport(selected) ? selected : null;

  const tableRows = useMemo(() => {
    if (!payload || !selectedAvailable) return [];
    if (selectedAvailable.responseKind === "sales_pivot" || selectedAvailable.responseKind === "margin_pivot") {
      const o = payload as { rows?: Record<string, unknown>[] };
      return o.rows ?? [];
    }
    if (
      selectedAvailable.responseKind === "best_sellers" ||
      selectedAvailable.responseKind === "dead_stock"
    ) {
      return rowsFromUnknown(payload);
    }
    if (selectedAvailable.responseKind === "rows" || selectedAvailable.responseKind === "wedding_saved_views") {
      return rowsFromUnknown(payload);
    }
    return [];
  }, [payload, selectedAvailable]);

  const tableColumns = useMemo(() => keysFromRowsForDisplay(tableRows), [tableRows]);
  const displayRows = useMemo(
    () => rowsWithDisplayLabels(tableRows, tableColumns),
    [tableColumns, tableRows],
  );
  const showRange = selectedAvailable?.usesGlobalDateRange ?? false;
  const showBasis = selectedAvailable?.usesBasis ?? false;
  const showGroup = selectedAvailable?.supportsGroupBy ?? false;
  const selectedVisual = selected ? REPORT_CATEGORY_VISUALS[selected.category] : null;
  const SelectedIcon = selectedVisual?.icon;

  return (
    <div
      data-testid="reports-workspace"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto bg-app-bg p-4 sm:p-6"
    >
      <div className="relative overflow-hidden rounded-3xl border border-app-border bg-gradient-to-br from-app-accent/10 via-app-bg to-sky-500/10 p-5 shadow-sm">
        <div
          className="pointer-events-none absolute right-6 top-4 h-28 w-28 rounded-full bg-app-accent/10 blur-3xl"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute bottom-0 right-36 h-24 w-24 rounded-full bg-amber-400/10 blur-3xl"
          aria-hidden
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex max-w-3xl gap-4">
            <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-accent/25 bg-app-accent/10 text-app-accent shadow-sm">
              <BarChart3 className="h-7 w-7" aria-hidden />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-black tracking-tight text-app-text sm:text-3xl">
                  Reports
                </h1>
                <span className="ui-chip bg-app-accent/10 text-xs font-black text-app-accent">
                  {visible.length} available
                </span>
              </div>
              <p className="mt-2 text-sm font-semibold text-app-text-muted">
                Search the curated report library by task, question, or keyword. Color-coded
                categories keep finance, register, staff, wedding, inventory, and operations work
                easy to scan without changing report access rules.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-app-border bg-app-surface/80 px-3 py-1 text-xs font-black text-app-text-muted">
                  <Sparkles className="h-3.5 w-3.5 text-app-accent" aria-hidden />
                  Curated store library
                </span>
                <span className="rounded-full border border-app-border bg-app-surface/80 px-3 py-1 text-xs font-black text-app-text-muted">
                  {REPORT_CATEGORY_ORDER.length} categories
                </span>
                <span className="rounded-full border border-app-border bg-app-surface/80 px-3 py-1 text-xs font-black text-app-text-muted">
                  RBAC filtered
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenMetabaseExplore}
            className="ui-btn-secondary inline-flex min-h-11 items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold"
          >
            Open Advanced Reports
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="grid gap-3 rounded-3xl border border-app-border bg-app-surface-2/60 p-4 shadow-sm md:grid-cols-2">
        <button
          type="button"
          onClick={onNavigateRegisterReports}
          className="group flex min-h-16 items-center gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-left transition hover:-translate-y-0.5 hover:border-emerald-500/50 hover:shadow-sm"
        >
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-700">
            <CreditCard className="h-5 w-5" aria-hidden />
          </span>
          <span>
            <span className="block text-sm font-black text-app-text">
              POS register day &amp; lane reports
            </span>
            <span className="mt-0.5 block text-xs font-semibold text-app-text-muted">
              Operations → Register reports
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onNavigateCommissionPayouts}
          className="group flex min-h-16 items-center gap-3 rounded-2xl border border-lime-400/30 bg-lime-500/10 px-4 py-3 text-left transition hover:-translate-y-0.5 hover:border-lime-500/50 hover:shadow-sm"
        >
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-lime-500/15 text-lime-700">
            <BadgeDollarSign className="h-5 w-5" aria-hidden />
          </span>
          <span>
            <span className="block text-sm font-black text-app-text">
              Commission finalize &amp; payouts
            </span>
            <span className="mt-0.5 block text-xs font-semibold text-app-text-muted">
              Staff → Commission payouts
            </span>
          </span>
        </button>
      </div>

      {!selected ? (
        <>
          {!permissionsLoaded ? (
            <p className="text-sm font-semibold text-app-text-muted">Loading permissions…</p>
          ) : (
            <>
              <div className="rounded-3xl border border-app-border bg-app-surface p-4 shadow-sm">
                <label className="relative block max-w-3xl">
                  <span className="sr-only">Search reports</span>
                  <Search
                    className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-app-text-muted"
                    aria-hidden
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search reports by task, question, or keyword"
                    className="ui-input w-full rounded-2xl py-3 pl-12 pr-3 text-sm font-semibold"
                  />
                </label>
              </div>

              {searchResults.length > 0 ? (
                <div className="space-y-5">
                  {groupedSearchResults.map(({ category, reports }) => {
                    const categoryDetails = REPORT_CATEGORY_DETAILS[category];
                    const visual = REPORT_CATEGORY_VISUALS[category];
                    const CategoryIcon = visual.icon;
                    return (
                      <section
                        key={category}
                        className={`overflow-hidden rounded-3xl border ${visual.ring} bg-app-surface shadow-sm`}
                      >
                        <div className={`flex flex-wrap items-center justify-between gap-3 border-b border-app-border p-4 ${visual.soft}`}>
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-current/20 bg-app-surface/70 ${visual.accent}`}
                            >
                              <CategoryIcon className="h-5 w-5" aria-hidden />
                            </span>
                            <div className="min-w-0">
                              <h2 className="text-sm font-black text-app-text">
                                {categoryDetails.label}
                              </h2>
                              <p className="mt-0.5 text-xs font-semibold text-app-text-muted">
                                {categoryDetails.description}
                              </p>
                            </div>
                          </div>
                          <span className="text-xs font-bold text-app-text-muted">
                            {reports.length} {reports.length === 1 ? "report" : "reports"}
                          </span>
                        </div>
                        <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                          {reports.map((r) => (
                            <li key={r.id}>
                              <ReportTile report={r} onSelect={() => setSelected(r)} />
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </div>
              ) : searchQuery.trim() ? (
                <p className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm font-semibold text-app-text-muted">
                  No matching reports yet. Try a task like pickup, balance, tax, or slow stock.
                </p>
              ) : (
                <p className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm font-semibold text-app-text-muted">
                  No reports are available for your current access.
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <div
          className={`flex min-h-0 flex-1 flex-col gap-4 rounded-3xl border ${selectedVisual?.ring ?? "border-app-border"} bg-app-surface-2/40 p-4 shadow-sm`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setPayload(null);
                setLoadErr(null);
              }}
              className="ui-btn-secondary inline-flex min-h-11 items-center gap-1 rounded-xl px-3 py-2 text-sm font-bold"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Library
            </button>
            <span className="flex min-w-0 flex-1 basis-full items-center gap-3 text-sm font-black text-app-text sm:basis-auto">
              {SelectedIcon && selectedVisual ? (
                <span
                  className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-current/20 ${selectedVisual.soft} ${selectedVisual.accent}`}
                >
                  <SelectedIcon className="h-5 w-5" aria-hidden />
                </span>
              ) : null}
              <span className="min-w-0">
                <span className="block truncate">{selected.title}</span>
                <span className="mt-0.5 block text-xs font-semibold text-app-text-muted">
                  {REPORT_CATEGORY_DETAILS[selected.category].label}
                </span>
              </span>
            </span>
            {isAvailableReport(selected) ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => void runLoad(selected)}
                className="ui-btn-secondary inline-flex min-h-11 w-full items-center justify-center gap-1 rounded-xl px-3 py-2 text-sm font-bold sm:ml-auto sm:w-auto"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
                Refresh
              </button>
            ) : null}
          </div>

          {!isAvailableReport(selected) ? (
            <div
              data-testid="reports-planned-card"
              className="rounded-xl border border-app-accent/20 bg-app-accent/10 px-4 py-3"
            >
              <p className="text-sm font-black text-app-text">Planned curated report</p>
              <p className="mt-1 text-sm font-semibold text-app-text-muted">
                {selected.plannedReason}
              </p>
              <p className="mt-2 text-xs font-semibold text-app-text-muted">
                Search tags: {selected.keywords.slice(0, 6).join(", ")}
              </p>
            </div>
          ) : null}

          {isAvailableReport(selected) ? (
          <div data-testid="reports-detail-filters" className="flex flex-wrap items-end gap-3">
            {showRange ? (
              <>
                <label className="flex w-full flex-col gap-1 text-xs font-bold text-app-text-muted sm:w-auto">
                  From
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setRange((x) => ({ ...x, from: e.target.value }))}
                    className="ui-input w-full rounded-xl px-3 py-2 text-sm font-semibold sm:w-auto"
                  />
                </label>
                <label className="flex w-full flex-col gap-1 text-xs font-bold text-app-text-muted sm:w-auto">
                  To
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setRange((x) => ({ ...x, to: e.target.value }))}
                    className="ui-input w-full rounded-xl px-3 py-2 text-sm font-semibold sm:w-auto"
                  />
                </label>
              </>
            ) : null}
            {showBasis ? (
              <label className="flex w-full flex-col gap-1 text-xs font-bold text-app-text-muted sm:w-auto">
                Basis
                <select
                  value={basis}
                  onChange={(e) => setBasis(e.target.value)}
                  className="ui-input w-full rounded-xl px-3 py-2 text-sm font-semibold sm:w-auto"
                >
                  <option value="booked">Booked (sale date)</option>
                  <option value="completed">Completed (recognition)</option>
                </select>
              </label>
            ) : null}
            {showGroup ? (
              <label className="flex w-full flex-col gap-1 text-xs font-bold text-app-text-muted sm:w-auto">
                Group by
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  className="ui-input w-full rounded-xl px-3 py-2 text-sm font-semibold sm:w-auto"
                >
                  {PIVOT_GROUP_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          ) : null}

          {selected.id === "commission_ledger" ? (
            <p className="text-xs font-semibold text-app-text-muted">
              To finalize payouts, use{" "}
              <button
                type="button"
                className="font-bold text-app-accent underline"
                onClick={onNavigateCommissionPayouts}
              >
                Staff → Commission payouts
              </button>
              .
            </p>
          ) : null}

          {loadErr ? (
            <div
              data-testid="reports-detail-error"
              className="rounded-xl border border-app-danger/20 bg-app-danger/10 px-4 py-3 text-sm font-semibold text-app-text"
            >
              {loadErr}
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm font-semibold text-app-text-muted">Loading…</p>
          ) : null}

          {!loading && payload !== null && !loadErr && selectedAvailable ? (
            <>
              {selectedAvailable.responseKind === "wedding_health" &&
              payload &&
              typeof payload === "object" ? (
                <dl
                  data-testid="reports-detail-wedding-health"
                  className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
                >
                  {Object.entries(payload as Record<string, unknown>).map(([k, v]) => (
                    <div
                      key={k}
                      className="rounded-xl border border-app-border bg-app-surface px-3 py-2"
                    >
                      <dt className="text-xs font-bold text-app-text-muted">
                        {fieldLabel(k)}
                      </dt>
                      <dd className="text-lg font-black text-app-text">{toCellString(v)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {selectedAvailable.responseKind === "row_object" &&
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload) ? (
                isCompactLayout ? (
                  <dl
                    data-testid="reports-detail-row-object-cards"
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {Object.entries(payload as Record<string, unknown>).map(([k, v]) => (
                      <div
                        key={k}
                        className="rounded-xl border border-app-border bg-app-surface px-3 py-2"
                      >
                        <dt className="text-xs font-bold text-app-text-muted">{fieldLabel(k)}</dt>
                        <dd className="mt-1 text-sm font-semibold text-app-text">{toCellString(v)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <div className="overflow-auto rounded-xl border border-app-border">
                    <table
                      data-testid="reports-detail-row-object-table"
                      className="w-full min-w-[480px] text-left text-sm"
                    >
                      <tbody>
                        {Object.entries(payload as Record<string, unknown>).map(([k, v]) => (
                          <tr key={k} className="border-b border-app-border">
                            <th className="whitespace-nowrap bg-app-surface-2 px-3 py-2 font-bold text-app-text">
                              {fieldLabel(k)}
                            </th>
                            <td className="px-3 py-2 font-semibold text-app-text-muted">
                              {toCellString(v)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : null}

              {(selectedAvailable.responseKind === "best_sellers" ||
                selectedAvailable.responseKind === "dead_stock") &&
              payload &&
              typeof payload === "object" ? (
                <div className="text-xs font-semibold text-app-text-muted">
                  {(payload as { reporting_basis?: string }).reporting_basis ? (
                    <span className="mr-3">
                      Basis: {(payload as { reporting_basis: string }).reporting_basis}
                    </span>
                  ) : null}
                  {(payload as { from?: string }).from ? (
                    <span className="mr-3">Period: {(payload as { from: string }).from} → {(payload as { to: string }).to}</span>
                  ) : null}
                </div>
              ) : null}

              {selectedAvailable.responseKind === "sales_pivot" || selectedAvailable.responseKind === "margin_pivot"
                ? payload &&
                  typeof payload === "object" &&
                  "truncated" in payload &&
                  (payload as { truncated: boolean }).truncated ? (
                  <p className="text-xs font-bold text-app-warning">
                    Showing the first 200 rows. Narrow the date range or use Advanced Reports for full exports.
                  </p>
                ) : null
                : null}

              {selectedAvailable.responseKind === "register_day_summary" ? (
                <div data-testid="reports-detail-register-day" className="space-y-4">
                  <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {REGISTER_DAY_SUMMARY_FIELDS.map((key) => {
                      const value = (payload as Record<string, unknown>)[key];
                      if (!hasDisplayValue(value)) return null;
                      return (
                        <div
                          key={key}
                          className="rounded-xl border border-app-border bg-app-surface px-3 py-2"
                        >
                          <dt className="text-xs font-bold text-app-text-muted">
                            {fieldLabel(key)}
                          </dt>
                          <dd className="mt-1 text-sm font-black text-app-text">
                            {formatCellValue(value, key)}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                  {registerDayActivityRows(payload).length > 0 ? (
                    <div className="overflow-auto rounded-xl border border-app-border">
                      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-app-border bg-app-surface-2">
                            {keysFromRowsForDisplay(registerDayActivityRows(payload)).map((key) => (
                              <th
                                key={key}
                                className="whitespace-nowrap px-3 py-2 font-black text-app-text"
                              >
                                {fieldLabel(key)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {registerDayActivityRows(payload).map((row, index) => (
                            <tr key={index} className="border-b border-app-border/70">
                              {keysFromRowsForDisplay(registerDayActivityRows(payload)).map((key) => (
                                <td
                                  key={key}
                                  className="px-3 py-2 font-semibold text-app-text-muted"
                                >
                                  {formatCellValue(row[key], key)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {tableRows.length > 0 ? (
                selectedAvailable.chartConfigs?.length ? (
                  <div
                    data-testid="reports-detail-charts"
                    className="grid gap-3 lg:grid-cols-2"
                  >
                    {selectedAvailable.chartConfigs.map((config) => (
                      <ReportMiniChart
                        key={`${selectedAvailable.id}-${config.title}`}
                        config={config}
                        rows={tableRows}
                      />
                    ))}
                  </div>
                ) : null
              ) : null}

              {tableRows.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => downloadCsv(`${selected.id}.csv`, displayRows)}
                    className="ui-btn-secondary inline-flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold"
                  >
                    <Download className="h-4 w-4" aria-hidden />
                    Download CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      openProfessionalTablePrint({
                        title: selected.title,
                        subtitle: `${from} to ${to} (${basis} basis${groupBy ? `, grouped by ${groupBy}` : ""})`,
                        columns: keysFromRows(displayRows),
                        rows: displayRows
                      });
                    }}
                    className="ui-btn-secondary inline-flex min-h-11 items-center gap-2 rounded-xl border-app-success/20 px-3 py-2 text-sm font-bold text-app-success hover:bg-app-success hover:text-white"
                  >
                    <Printer className="h-4 w-4" aria-hidden />
                    Print Report
                  </button>
                </div>
              ) : null}

              {tableRows.length > 0 ? (
                isCompactLayout ? (
                  <div data-testid="reports-detail-cards" className="space-y-3">
                    {tableRows.map((row, i) => (
                      <article
                        key={i}
                        className="rounded-xl border border-app-border bg-app-surface px-3 py-3"
                      >
                        <dl className="space-y-2">
                          {tableColumns.map((k) => (
                            <div
                              key={k}
                              className="grid grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] items-start gap-2 text-xs"
                            >
                              <dt className="truncate font-bold text-app-text-muted">
                                {fieldLabel(k)}
                              </dt>
                              <dd className="break-all font-semibold text-app-text">
                                {formatCellValue(row[k], k)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="overflow-auto rounded-xl border border-app-border">
                    <table
                      data-testid="reports-detail-table"
                      className="w-full min-w-[640px] border-collapse text-left text-xs"
                    >
                      <thead>
                        <tr className="border-b border-app-border bg-app-surface-2">
                          {tableColumns.map((k) => (
                            <th key={k} className="whitespace-nowrap px-3 py-2 font-black text-app-text">
                              {fieldLabel(k)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tableRows.map((row, i) => (
                          <tr key={i} className="border-b border-app-border/70">
                            {tableColumns.map((k) => (
                              <td key={k} className="px-3 py-2 font-semibold text-app-text-muted">
                                {formatCellValue(row[k], k)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : null}

              {selectedAvailable.responseKind === "row_object" ||
              selectedAvailable.responseKind === "wedding_health" ||
              selectedAvailable.responseKind === "register_day_summary" ||
              tableRows.length > 0
                ? null
                : (
                  <div className="rounded-xl border border-app-border bg-app-surface px-4 py-3">
                    <p className="text-sm font-black text-app-text">No report rows for this window.</p>
                    <p className="mt-1 text-sm font-semibold text-app-text-muted">
                      This report is connected, but the selected dates did not return matching activity.
                    </p>
                    {showRange ? (
                      <button
                        type="button"
                        className="ui-btn-secondary mt-3 min-h-10 rounded-xl px-3 py-2 text-xs font-black"
                        onClick={() => {
                          const end = new Date();
                          const start = new Date();
                          start.setFullYear(start.getFullYear() - 1);
                          setRange({ from: ymd(start), to: ymd(end) });
                        }}
                      >
                        Show last 12 months
                      </button>
                    ) : null}
                  </div>
                )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
