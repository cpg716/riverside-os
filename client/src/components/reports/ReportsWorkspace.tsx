import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, BarChart3, ChevronLeft, Download, Printer, RefreshCw, Search } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  PIVOT_GROUP_OPTIONS,
  REPORTS_CATALOG,
  isAvailableReport,
  reportSearchScore,
  reportVisible,
  type ReportDef,
  type ReportUrlContext,
} from "../../lib/reportsCatalog";
import { openProfessionalTablePrint } from "../pos/zReportPrint";
import { useMediaQuery } from "../../hooks/useMediaQuery";

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

function rowsFromUnknown(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const o = data as Record<string, unknown>;
  if (Array.isArray(o.rows)) return o.rows as Record<string, unknown>[];
  return [];
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
  customer_display_name: "Customer",
  customer_name: "Customer",
  cancellation_count: "Cancellations",
  date: "Date",
  event_date: "Event Date",
  exempt_sales: "Exempt Sales",
  expected_cash: "Expected Cash",
  follow_up_reason: "Follow-Up Reason",
  fees: "Processing Fees",
  from: "From",
  gross: "Gross",
  gross_margin: "Gross Margin",
  gross_sales: "Gross Sales",
  last_transaction_at: "Last Transaction",
  item_name: "Item",
  line_count: "Line Count",
  member_count: "Members",
  missing_measurements_count: "Missing Measurements",
  net: "Net",
  net_sales: "Net Sales",
  no_show_count: "No-Shows",
  open_balance: "Open Balance",
  open_balance_total: "Open Balance Total",
  order_count: "Transactions",
  owner_area: "Owner Area",
  pending_alteration_count: "Pending Alterations",
  pending_pickup_count: "Pending Pickups",
  payments_total: "Payments",
  points_burned: "Points Used",
  points_earned: "Points Earned",
  product_name: "Product",
  quantity: "Quantity",
  reason: "Reason",
  recent_transaction_count: "Recent Transactions",
  recommended_action: "Recommended Action",
  recognized_at: "Completed At",
  register_id: "Register",
  register_number: "Register #",
  report_date: "Report Date",
  reporting_basis: "Basis",
  risk_count: "Risk Count",
  risk_type: "Risk Type",
  oldest_at: "Oldest Item",
  sales_count: "Sales Count",
  sales_volume: "Sales Volume",
  salesperson: "Salesperson",
  session_id: "Session",
  sku: "SKU",
  staff_name: "Staff",
  scheduled_staff_count: "Scheduled Staff",
  shipment_or_pickup_risk_count: "Shipment/Pickup Risk",
  stale_rms_charge_count: "Stale RMS Charges",
  tax_collected: "Tax Collected",
  taxable_sales: "Taxable Sales",
  to: "To",
  total: "Total",
  total_cost: "Total Cost",
  total_discount: "Total Discount",
  total_fees: "Processing Fees",
  total_net: "Net Total",
  total_sales: "Sales Total",
  transaction_count: "Transactions",
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
    for (const column of columns) out[fieldLabel(column)] = row[column];
    return out;
  });
}

function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  const cols = keysFromRows(rows);
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(toCellString(r[c]))).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
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
      REPORTS_CATALOG.filter((r) => reportVisible(r, hasPermission, staffRole)),
    [hasPermission, staffRole],
  );

  const searchResults = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return visible;
    return visible
      .map((report) => ({ report, score: reportSearchScore(report, query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ report }) => report);
  }, [searchQuery, visible]);

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

  const tableColumns = useMemo(() => keysFromRows(tableRows), [tableRows]);
  const displayRows = useMemo(
    () => rowsWithDisplayLabels(tableRows, tableColumns),
    [tableColumns, tableRows],
  );
  const showRange = selectedAvailable?.usesGlobalDateRange ?? false;
  const showBasis = selectedAvailable?.usesBasis ?? false;
  const showGroup = selectedAvailable?.supportsGroupBy ?? false;

  return (
    <div
      data-testid="reports-workspace"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto bg-app-surface p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-app-accent">
            <BarChart3 className="h-6 w-6" aria-hidden />
            <h1 className="text-xl font-black tracking-tight text-app-text sm:text-2xl">
              Reports
            </h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm font-semibold text-app-text-muted">
            Search the curated report library by task, question, or keyword. Sensitive reports stay
            separated by staff access.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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

      <div className="flex flex-wrap gap-3 rounded-2xl border border-app-border bg-app-surface-2/60 p-4">
        <button
          type="button"
          onClick={onNavigateRegisterReports}
          className="min-h-11 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-left text-sm font-bold text-app-text transition hover:border-app-accent/40"
        >
          POS register day &amp; lane reports
          <span className="mt-0.5 block font-semibold text-app-text-muted">
            Operations → Register reports
          </span>
        </button>
        <button
          type="button"
          onClick={onNavigateCommissionPayouts}
          className="min-h-11 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-left text-sm font-bold text-app-text transition hover:border-app-accent/40"
        >
          Commission finalize &amp; payouts
          <span className="mt-0.5 block font-semibold text-app-text-muted">
            Staff → Commission payouts
          </span>
        </button>
      </div>

      {!selected ? (
        <>
          {!permissionsLoaded ? (
            <p className="text-sm font-semibold text-app-text-muted">Loading permissions…</p>
          ) : (
            <>
              <label className="relative block max-w-2xl">
                <span className="sr-only">Search reports</span>
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted"
                  aria-hidden
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search reports by task, question, or keyword"
                  className="ui-input w-full rounded-xl py-2 pl-9 pr-3 text-sm font-semibold"
                />
              </label>

              {searchResults.length > 0 ? (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {searchResults.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        data-testid={`reports-catalog-card-${r.id}`}
                        onClick={() => setSelected(r)}
                        className="flex h-full w-full flex-col rounded-2xl border border-app-border bg-app-surface p-4 text-left shadow-sm transition hover:border-app-accent/45"
                      >
                        <span className="text-sm font-black text-app-text">{r.title}</span>
                        <span className="mt-2 flex-1 text-xs font-semibold leading-snug text-app-text-muted">
                          {r.description}
                        </span>
                        <span className="mt-3 flex flex-wrap gap-1.5">
                          <span className="ui-chip bg-app-surface-2 text-xs font-bold text-app-text-muted">
                            {r.category}
                          </span>
                          <span className="ui-chip bg-app-surface-2 text-xs font-bold text-app-text-muted">
                            For {r.audience}
                          </span>
                          <span className="ui-chip bg-app-surface-2 text-xs font-bold text-app-text-muted">
                            {r.sensitivity === "Staff-safe"
                              ? "Staff-safe"
                              : `${r.sensitivity} access`}
                          </span>
                          {!isAvailableReport(r) ? (
                            <span className="ui-chip bg-app-accent/10 text-xs font-bold text-app-accent">
                              Planned
                            </span>
                          ) : null}
                          {r.adminOnly && r.sensitivity !== "Admin-only" ? (
                            <span className="ui-chip bg-app-warning/10 text-xs font-bold text-app-warning">
                              Admin only
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 rounded-2xl border border-app-border bg-app-surface-2/40 p-4">
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
            <span className="min-w-0 flex-1 basis-full text-sm font-black text-app-text sm:basis-auto">
              {selected.title}
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
                <pre
                  data-testid="reports-detail-register-day"
                  className="max-h-[60vh] overflow-auto rounded-xl border border-app-border bg-app-surface p-4 text-xs font-mono text-app-text"
                >
                  {JSON.stringify(payload, null, 2)}
                </pre>
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
                                {toCellString(row[k])}
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
                                {toCellString(row[k])}
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
                  <p className="text-sm font-semibold text-app-text-muted">No rows in this window.</p>
                )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
