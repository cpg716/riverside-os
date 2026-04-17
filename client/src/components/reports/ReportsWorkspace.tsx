import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, BarChart3, ChevronLeft, Download, RefreshCw, Printer } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  PIVOT_GROUP_OPTIONS,
  REPORTS_CATALOG,
  reportVisible,
  type ReportDef,
  type ReportUrlContext,
} from "../../lib/reportsCatalog";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
import { openProfessionalTablePrint } from "../pos/zReportPrint";

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
  const { backofficeHeaders, hasPermission, permissionsLoaded, staffRole } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [{ from, to }, setRange] = useState(defaultRange);
  const [basis, setBasis] = useState("booked");
  const [groupBy, setGroupBy] = useState<string>("brand");
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

  const runLoad = useCallback(
    async (r: ReportDef) => {
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
    if (selected) void runLoad(selected);
  }, [selected, runLoad]);

  const tableRows = useMemo(() => {
    if (!payload || !selected) return [];
    if (selected.responseKind === "sales_pivot" || selected.responseKind === "margin_pivot") {
      const o = payload as { rows?: Record<string, unknown>[] };
      return o.rows ?? [];
    }
    if (
      selected.responseKind === "best_sellers" ||
      selected.responseKind === "dead_stock"
    ) {
      return rowsFromUnknown(payload);
    }
    if (selected.responseKind === "rows" || selected.responseKind === "wedding_saved_views") {
      return rowsFromUnknown(payload);
    }
    return [];
  }, [payload, selected]);

  const showRange = selected?.usesGlobalDateRange ?? false;
  const showBasis = selected?.usesBasis ?? false;
  const showGroup = selected?.supportsGroupBy ?? false;

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
            Curated owner and manager reports backed by Riverside APIs. Use{" "}
            <span className="text-app-text">Insights</span> (Metabase) to explore ad-hoc cuts on
            the <code className="text-xs">reporting</code> schema.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenMetabaseExplore}
            className="ui-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold uppercase tracking-wide"
          >
            Open Insights (Metabase)
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 rounded-2xl border border-app-border bg-app-surface-2/60 p-4">
        <button
          type="button"
          onClick={onNavigateRegisterReports}
          className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-left text-xs font-bold text-app-text transition hover:border-app-accent/40"
        >
          POS register day &amp; lane reports
          <span className="mt-0.5 block font-semibold text-app-text-muted">
            Operations → Register reports
          </span>
        </button>
        <button
          type="button"
          onClick={onNavigateCommissionPayouts}
          className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-left text-xs font-bold text-app-text transition hover:border-app-accent/40"
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
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((r) => (
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
                    {r.adminOnly ? (
                      <span className="mt-3 ui-chip w-fit bg-amber-500/15 text-[10px] font-black uppercase text-amber-900 dark:text-amber-100">
                        Admin only
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
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
              className="ui-btn-secondary inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold uppercase"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Library
            </button>
            <span className="text-sm font-black text-app-text">{selected.title}</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void runLoad(selected)}
              className="ui-btn-secondary ml-auto inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold uppercase"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
              Refresh
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {showRange ? (
              <>
                <label className="flex flex-col gap-1 text-[10px] font-black uppercase text-app-text-muted">
                  From
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setRange((x) => ({ ...x, from: e.target.value }))}
                    className="ui-input rounded-xl px-3 py-2 text-sm font-semibold"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[10px] font-black uppercase text-app-text-muted">
                  To
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setRange((x) => ({ ...x, to: e.target.value }))}
                    className="ui-input rounded-xl px-3 py-2 text-sm font-semibold"
                  />
                </label>
              </>
            ) : null}
            {showBasis ? (
              <label className="flex flex-col gap-1 text-[10px] font-black uppercase text-app-text-muted">
                Basis
                <select
                  value={basis}
                  onChange={(e) => setBasis(e.target.value)}
                  className="ui-input rounded-xl px-3 py-2 text-sm font-semibold"
                >
                  <option value="booked">Booked (sale date)</option>
                  <option value="completed">Completed (recognition)</option>
                </select>
              </label>
            ) : null}
            {showGroup ? (
              <label className="flex flex-col gap-1 text-[10px] font-black uppercase text-app-text-muted">
                Group by
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  className="ui-input rounded-xl px-3 py-2 text-sm font-semibold"
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
              className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-800 dark:text-red-200"
            >
              {loadErr}
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm font-semibold text-app-text-muted">Loading…</p>
          ) : null}

          {!loading && payload !== null && !loadErr ? (
            <>
              {selected.responseKind === "wedding_health" &&
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
                      <dt className="text-[10px] font-black uppercase text-app-text-muted">
                        {k}
                      </dt>
                      <dd className="text-lg font-black text-app-text">{toCellString(v)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {selected.responseKind === "row_object" &&
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload) ? (
                <div className="overflow-auto rounded-xl border border-app-border">
                  <table className="w-full min-w-[480px] text-left text-sm">
                    <tbody>
                      {Object.entries(payload as Record<string, unknown>).map(([k, v]) => (
                        <tr key={k} className="border-b border-app-border">
                          <th className="whitespace-nowrap bg-app-surface-2 px-3 py-2 font-bold text-app-text">
                            {k}
                          </th>
                          <td className="px-3 py-2 font-semibold text-app-text-muted">
                            {toCellString(v)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {(selected.responseKind === "best_sellers" ||
                selected.responseKind === "dead_stock") &&
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

              {selected.responseKind === "sales_pivot" || selected.responseKind === "margin_pivot"
                ? payload &&
                  typeof payload === "object" &&
                  "truncated" in payload &&
                  (payload as { truncated: boolean }).truncated ? (
                  <p className="text-xs font-bold text-amber-800 dark:text-amber-200">
                    Results truncated at 200 rows — narrow the range or use Metabase for full exports.
                  </p>
                ) : null
                : null}

              {selected.responseKind === "register_day_summary" ? (
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
                    onClick={() => downloadCsv(`${selected.id}.csv`, tableRows)}
                    className="ui-btn-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold uppercase"
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
                        columns: keysFromRows(tableRows),
                        rows: tableRows
                      });
                    }}
                    className="ui-btn-secondary inline-flex items-center gap-2 rounded-xl border-emerald-500/30 px-3 py-2 text-xs font-bold uppercase text-emerald-700 hover:bg-emerald-500 hover:text-white"
                  >
                    <Printer className="h-4 w-4" aria-hidden />
                    Print Report
                  </button>
                </div>
              ) : null}

              {tableRows.length > 0 ? (
                <div className="overflow-auto rounded-xl border border-app-border">
                  <table
                    data-testid="reports-detail-table"
                    className="w-full min-w-[640px] border-collapse text-left text-xs"
                  >
                    <thead>
                      <tr className="border-b border-app-border bg-app-surface-2">
                        {keysFromRows(tableRows).map((k) => (
                          <th key={k} className="whitespace-nowrap px-3 py-2 font-black text-app-text">
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((row, i) => (
                        <tr key={i} className="border-b border-app-border/70">
                          {keysFromRows(tableRows).map((k) => (
                            <td key={k} className="px-3 py-2 font-semibold text-app-text-muted">
                              {toCellString(row[k])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {selected.responseKind === "row_object" ||
              selected.responseKind === "wedding_health" ||
              selected.responseKind === "register_day_summary" ||
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
