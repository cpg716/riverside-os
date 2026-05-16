import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { Receipt, Info, ChevronDown, ChevronRight, Printer } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";
import CommissionTraceModal from "./CommissionTraceModal";

const baseUrl = getBaseUrl();

const COMMISSION_UNASSIGNED = "__unassigned__";

interface CommissionLedgerRow {
  staff_id: string | null;
  staff_name: string;
  unpaid_commission: string;
  realized_pending_payout: string;
  base_commission_amount: string;
  spiff_commission_amount: string;
  earned_sale_count: number;
  current_commission_rate: string;
  current_commission_rate_since: string | null;
}

function money(s: string | number) {
  return formatUsdFromCents(parseMoneyToCents(s));
}

function percent(s: string | number) {
  const rate = typeof s === "number" ? s : Number.parseFloat(s || "0");
  if (!Number.isFinite(rate)) return "0.0%";
  return `${(rate * 100).toFixed(1)}%`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

interface CommissionLineRow {
  event_id: string | null;
  event_type: string;
  transaction_line_id: string | null;
  transaction_id: string | null;
  order_short_id: string;
  booked_at: string;
  product_name: string;
  unit_price: string;
  quantity: string;
  line_gross: string;
  calculated_commission: string;
  is_fulfilled: boolean;
  fulfilled_at: string | null;
  is_finalized: boolean;
}

interface CommissionStaffRow {
  id: string;
  full_name: string;
  role?: string;
}

function chip(
  active: boolean,
  label: string,
  onClick: () => void,
) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
        active
          ? "border-app-accent/60 bg-app-surface-2 text-app-text shadow-sm shadow-app-accent/10"
          : "border-app-border bg-app-surface text-app-text-muted hover:border-app-input-border"
      }`}
    >
      {label}
    </button>
  );
}

export default function CommissionPayoutsPanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [commissionRows, setCommissionRows] = useState<CommissionLedgerRow[]>(
    [],
  );
  const [commissionFrom, setCommissionFrom] = useState("");
  const [commissionTo, setCommissionTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expandedStaffId, setExpandedStaffId] = useState<string | null>(null);
  const [traceLineId, setTraceLineId] = useState<string | null>(null);
  const [staffRoster, setStaffRoster] = useState<CommissionStaffRow[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState("");
  const [adjustStaffId, setAdjustStaffId] = useState("");
  const [adjustDate, setAdjustDate] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustBusy, setAdjustBusy] = useState(false);

  const commissionRowKey = useCallback((r: CommissionLedgerRow) => {
    return r.staff_id ?? COMMISSION_UNASSIGNED;
  }, []);

  const loadCommissions = useCallback(async () => {
    if (!hasPermission("insights.view")) {
      setCommissionRows([]);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams();
      if (commissionFrom.trim()) p.set("from", commissionFrom.trim());
      if (commissionTo.trim()) p.set("to", commissionTo.trim());
      const q = p.toString();
      const res = await fetch(
        `${baseUrl}/api/insights/commission-ledger${q ? `?${q}` : ""}`,
        { headers: backofficeHeaders() },
      );
      if (!res.ok) throw new Error("Ledger failed");
      const rows = (await res.json()) as CommissionLedgerRow[];
      setCommissionRows(rows);
    } catch (e) {
      setErr(
        e instanceof Error ? e.message : "Could not load commission ledger.",
      );
      setCommissionRows([]);
    } finally {
      setLoading(false);
    }
  }, [commissionFrom, commissionTo, hasPermission, backofficeHeaders]);

  const setLocalYmd = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const applyPayoutDayWindow = (days: number, endOffsetDays: number) => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - endOffsetDays);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    setCommissionFrom(setLocalYmd(start));
    setCommissionTo(setLocalYmd(end));
  };

  const applyPriorMonthWindow = () => {
    const now = new Date();
    const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const firstOfPriorMonth = new Date(
      firstOfThisMonth.getFullYear(),
      firstOfThisMonth.getMonth() - 1,
      1,
    );
    const lastOfPriorMonth = new Date(
      firstOfThisMonth.getFullYear(),
      firstOfThisMonth.getMonth(),
      0,
    );
    setCommissionFrom(setLocalYmd(firstOfPriorMonth));
    setCommissionTo(setLocalYmd(lastOfPriorMonth));
  };

  useEffect(() => {
    void loadCommissions();
  }, [loadCommissions]);

  useEffect(() => {
    const loadRoster = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`);
        if (!res.ok) throw new Error("Could not load staff roster");
        const rows = (await res.json()) as CommissionStaffRow[];
        setStaffRoster(
          rows.filter(
            (row) => !row.role || row.role === "salesperson" || row.role === "admin",
          ),
        );
      } catch {
        setStaffRoster([]);
      }
    };
    void loadRoster();
  }, []);

  const filteredRows = useMemo(() => {
    const earnedRows = commissionRows.filter(
      (row) => parseMoneyToCents(row.realized_pending_payout || "0") !== 0,
    );
    if (!selectedStaffId.trim()) return earnedRows;
    return earnedRows.filter((row) => row.staff_id === selectedStaffId);
  }, [commissionRows, selectedStaffId]);

  const selectedStaffName =
    staffRoster.find((row) => row.id === selectedStaffId)?.full_name ?? "Selected staff";
  const roleByStaffId = useMemo(() => {
    return new Map(staffRoster.map((row) => [row.id, row.role ?? "staff"]));
  }, [staffRoster]);
  const reportRangeLabel = `${commissionFrom || "Start"} to ${commissionTo || "Today"}`;
  const visibleTotals = useMemo(() => {
    return filteredRows.reduce(
      (totals, row) => {
        const earned = parseMoneyToCents(row.realized_pending_payout || "0");
        const baseEarned = parseMoneyToCents(row.base_commission_amount || "0");
        const spiffEarned = parseMoneyToCents(row.spiff_commission_amount || "0");
        return {
          earned: totals.earned + earned,
          baseEarned: totals.baseEarned + baseEarned,
          spiffEarned: totals.spiffEarned + spiffEarned,
          saleCount: totals.saleCount + (row.earned_sale_count ?? 0),
        };
      },
      { earned: 0, baseEarned: 0, spiffEarned: 0, saleCount: 0 },
    );
  }, [filteredRows]);

  const staffReportStatus = useCallback((row: CommissionLedgerRow, saleCount: number) => {
    const earned = parseMoneyToCents(row.realized_pending_payout || "0");
    if (earned !== 0 && saleCount > 0) return "Earned commission";
    if (earned !== 0) return "Adjustment only";
    return "No earned commission";
  }, []);

  const printCommissionReport = useCallback(() => {
    if (filteredRows.length === 0) {
      toast("There are no commission rows to print for this range.", "error");
      return;
    }

    const printedAt = new Date().toLocaleString();
    const staffScope = selectedStaffId ? selectedStaffName : "All staff";
    const rows = filteredRows
      .map((row) => {
        const earned = parseMoneyToCents(row.realized_pending_payout || "0");
        const baseEarned = parseMoneyToCents(row.base_commission_amount || "0");
        const spiffEarned = parseMoneyToCents(row.spiff_commission_amount || "0");
        const saleCount = row.earned_sale_count ?? 0;
        const role = row.staff_id ? roleByStaffId.get(row.staff_id) ?? "staff" : "unassigned";
        return `
          <tr>
            <td>
              <strong>${escapeHtml(row.staff_name)}</strong>
              <span>${escapeHtml(role)}</span>
            </td>
            <td>${escapeHtml(percent(row.current_commission_rate))}</td>
            <td>${escapeHtml(row.current_commission_rate_since || "Unknown")}</td>
            <td class="num">${saleCount}</td>
            <td class="num">${escapeHtml(formatUsdFromCents(baseEarned))}</td>
            <td class="num">${escapeHtml(formatUsdFromCents(spiffEarned))}</td>
            <td class="num total">${escapeHtml(formatUsdFromCents(earned))}</td>
          </tr>
        `;
      })
      .join("");
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>Commission Report</title>
          <style>
            body { font-family: Inter, Arial, sans-serif; color: #111827; margin: 28px; }
            header { border-bottom: 2px solid #111827; padding-bottom: 14px; margin-bottom: 18px; }
            h1 { margin: 0; font-size: 24px; letter-spacing: 0.03em; }
            .meta { color: #4b5563; font-size: 12px; margin-top: 6px; }
            .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 18px 0; }
            .tile { border: 1px solid #d1d5db; border-radius: 10px; padding: 10px; }
            .tile span { display: block; color: #6b7280; font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
            .tile strong { display: block; margin-top: 4px; font-size: 18px; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th { background: #f3f4f6; color: #374151; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; text-align: left; }
            th, td { border-bottom: 1px solid #e5e7eb; padding: 9px; vertical-align: top; }
            td span { display: block; color: #6b7280; font-size: 10px; margin-top: 3px; text-transform: capitalize; }
            .num { text-align: right; font-variant-numeric: tabular-nums; }
            .total { font-size: 16px; font-weight: 900; color: #065f46; }
            tfoot td { border-top: 2px solid #111827; font-weight: 900; }
            footer { margin-top: 18px; color: #6b7280; font-size: 11px; }
            @media print { body { margin: 0.35in; } }
          </style>
        </head>
        <body>
          <header>
            <h1>Commission Report</h1>
            <div class="meta">Staff: ${escapeHtml(staffScope)} | Range: ${escapeHtml(reportRangeLabel)} | Printed: ${escapeHtml(printedAt)}</div>
          </header>
          <section class="summary">
            <div class="tile"><span>Total commissions paid</span><strong>${escapeHtml(formatUsdFromCents(visibleTotals.earned))}</strong></div>
            <div class="tile"><span>Earned sale count</span><strong>${visibleTotals.saleCount}</strong></div>
            <div class="tile"><span>Staff included</span><strong>${filteredRows.length}</strong></div>
          </section>
          <table>
            <thead>
              <tr>
                <th>Staff</th>
                <th>Rate</th>
                <th>Rate since</th>
                <th class="num">Sales</th>
                <th class="num">By rate</th>
                <th class="num">SPIFF</th>
                <th class="num">Earned commission</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr>
                <td colspan="3">Total commissions paid for period</td>
                <td class="num">${visibleTotals.saleCount}</td>
                <td class="num">${escapeHtml(formatUsdFromCents(visibleTotals.baseEarned))}</td>
                <td class="num">${escapeHtml(formatUsdFromCents(visibleTotals.spiffEarned))}</td>
                <td class="num total">${escapeHtml(formatUsdFromCents(visibleTotals.earned))}</td>
              </tr>
            </tfoot>
          </table>
          <footer>Commission report: earned commission follows the recognition window for fulfilled/picked up/shipped work plus approved manual adjustments.</footer>
          <script>window.onload=function(){window.print();}</script>
        </body>
      </html>
    `;
    const printWindow = window.open("", "_blank", "width=1100,height=800");
    if (!printWindow) {
      toast("Allow pop-ups to print the commission report.", "error");
      return;
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  }, [
    filteredRows,
    reportRangeLabel,
    roleByStaffId,
    selectedStaffId,
    selectedStaffName,
    toast,
    visibleTotals,
  ]);

  const submitManualAdjustment = useCallback(async () => {
    if (!hasPermission("staff.manage_commission")) {
      toast("You do not have permission to add commission adjustments.", "error");
      return;
    }
    const staff_id = adjustStaffId || selectedStaffId;
    if (!staff_id) {
      toast("Choose a staff member for the adjustment.", "error");
      return;
    }
    const amount = Number.parseFloat(adjustAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      toast("Enter a non-zero adjustment amount.", "error");
      return;
    }
    if (!adjustDate) {
      toast("Choose a reporting date for the adjustment.", "error");
      return;
    }
    if (adjustNote.trim().length < 3) {
      toast("Add a note for the adjustment.", "error");
      return;
    }
    setAdjustBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/insights/commission-adjustments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          staff_id,
          reporting_date: adjustDate,
          amount,
          note: adjustNote.trim(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not add adjustment");
      }
      setAdjustAmount("");
      setAdjustNote("");
      await loadCommissions();
      toast("Commission adjustment added.", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not add adjustment", "error");
    } finally {
      setAdjustBusy(false);
    }
  }, [
    adjustAmount,
    adjustDate,
    adjustNote,
    adjustStaffId,
    backofficeHeaders,
    hasPermission,
    loadCommissions,
    selectedStaffId,
    toast,
  ]);

  if (!hasPermission("insights.view")) {
    return (
      <section className="ui-card p-6">
        <p className="text-sm text-app-text-muted">
          You do not have permission to view the commission ledger.
        </p>
      </section>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {err ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {err}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 px-4 py-3 text-xs text-app-text-muted">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Receipt className="mt-0.5 shrink-0 text-app-accent" size={18} />
            <p>
              <span className="font-bold text-app-text">Commission report:</span>{" "}
              earned commission uses the <strong>recognition</strong> window:
              pickup / takeaway when fulfilled, shipped orders when the label
              ships or shipment moves to in transit / delivered, plus approved
              manual adjustments. Open booked pipeline is intentionally not
              included in this commission report.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
              Staff
              <select
                value={selectedStaffId}
                onChange={(e) => {
                  setSelectedStaffId(e.target.value);
                  if (e.target.value) setAdjustStaffId(e.target.value);
                }}
                className="ui-input px-2 py-1 font-sans text-[11px]"
              >
                <option value="">All staff</option>
                {staffRoster.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
              From
              <input
                type="date"
                value={commissionFrom}
                onChange={(e) => setCommissionFrom(e.target.value)}
                className="ui-input px-2 py-1 font-sans text-[11px]"
              />
            </label>
            <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
              To
              <input
                type="date"
                value={commissionTo}
                onChange={(e) => setCommissionTo(e.target.value)}
                className="ui-input px-2 py-1 font-sans text-[11px]"
              />
            </label>
            <button
              type="button"
              onClick={() => void loadCommissions()}
              className="rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={printCommissionReport}
              disabled={filteredRows.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-input-border disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer size={14} />
              Print report
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-app-border/80 pt-3">
          <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Period presets
          </span>
          {chip(false, "Last 14 days", () => applyPayoutDayWindow(14, 0))}
          {chip(false, "Prior 14 days", () => applyPayoutDayWindow(14, 14))}
          {chip(false, "Prior month payroll", applyPriorMonthWindow)}
        </div>
        {hasPermission("staff.manage_commission") ? (
          <div className="grid gap-2 border-t border-app-border/80 pt-3 md:grid-cols-[1.2fr_0.8fr_0.8fr_1.8fr_auto]">
            <select
              value={adjustStaffId || selectedStaffId}
              onChange={(e) => setAdjustStaffId(e.target.value)}
              className="ui-input px-2 py-2 text-[11px]"
              aria-label="Adjustment staff"
            >
              <option value="">Adjustment staff...</option>
              {staffRoster.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.full_name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={adjustDate}
              onChange={(e) => setAdjustDate(e.target.value)}
              className="ui-input px-2 py-2 text-[11px]"
              aria-label="Adjustment reporting date"
            />
            <input
              type="number"
              step="0.01"
              value={adjustAmount}
              onChange={(e) => setAdjustAmount(e.target.value)}
              placeholder="+/- amount"
              className="ui-input px-2 py-2 text-[11px]"
              aria-label="Adjustment amount"
            />
            <input
              value={adjustNote}
              onChange={(e) => setAdjustNote(e.target.value)}
              placeholder="Adjustment note"
              className="ui-input px-2 py-2 text-[11px]"
              aria-label="Adjustment note"
            />
            <button
              type="button"
              disabled={adjustBusy}
              onClick={() => void submitManualAdjustment()}
              className="rounded-xl border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-input-border disabled:opacity-50"
            >
              {adjustBusy ? "Adding..." : "Add adjustment"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="ui-card min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-x-contain">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            <tr>
              <th className="px-4 py-3">Staff</th>
              <th className="px-4 py-3">Rate</th>
              <th className="px-4 py-3">Rate since</th>
              <th className="px-4 py-3 text-right">Sales</th>
              <th className="px-4 py-3 text-right">By rate</th>
              <th className="px-4 py-3 text-right">SPIFF $</th>
              <th className="px-4 py-3 text-right text-emerald-900/80">
                Earned commission
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {filteredRows.map((r) => {
              const k = commissionRowKey(r);
              const isExpanded = expandedStaffId === k;
              const earnedInPeriod =
                parseMoneyToCents(r.realized_pending_payout || "0") / 100;
              const baseEarned = parseMoneyToCents(r.base_commission_amount || "0") / 100;
              const spiffEarned = parseMoneyToCents(r.spiff_commission_amount || "0") / 100;
              const saleCount = r.earned_sale_count ?? 0;
              const staffRole = r.staff_id ? roleByStaffId.get(r.staff_id) ?? "staff" : "unassigned";
              const reportStatus = staffReportStatus(r, saleCount);
              return (
                <Fragment key={k}>
                  <tr
                    className={`hover:bg-app-accent/10 transition-colors ${
                      isExpanded ? "bg-app-surface-2" : ""
                    }`}
                  >
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedStaffId(isExpanded ? null : k)
                        }
                        className="flex items-center gap-2 font-semibold text-app-text hover:text-app-accent transition-colors text-left"
                      >
                        {isExpanded ? (
                          <ChevronDown size={14} className="text-app-accent" />
                        ) : (
                          <ChevronRight size={14} className="text-app-text-muted" />
                        )}
                        <span>
                          <span className="block">{r.staff_name}</span>
                          <span className="mt-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            {staffRole} · {reportRangeLabel}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className="block text-sm font-black text-app-text">
                        {percent(r.current_commission_rate)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="block text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                        {r.current_commission_rate_since || "Unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-black text-app-text tabular-nums">
                      {saleCount}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-app-text tabular-nums">
                      {money(baseEarned)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-app-text-muted tabular-nums">
                      {money(spiffEarned)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-2xl font-black text-emerald-800 tabular-nums">
                      {money(earnedInPeriod)}
                      <span className="mt-1 block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {reportStatus}
                      </span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={7} className="bg-app-surface-2/30 p-0">
                        <div className="border-t border-app-border/30 animate-in fade-in slide-in-from-top-1 duration-200">
                          <CommissionDrillDown
                            staffId={r.staff_id}
                            from={commissionFrom}
                            to={commissionTo}
                            onTrace={(id) => setTraceLineId(id)}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!loading && filteredRows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-app-text-muted"
                >
                  {selectedStaffId
                    ? "No earned commission for this staff member in range. If completed sales exist, confirm this staff member has a commission rate or active SPIFF/Combo rule."
                    : "No earned commission in range. If completed sales exist, confirm salesperson assignments plus commission rates or active SPIFF/Combo rules."}
                </td>
              </tr>
            ) : null}
            {!loading && filteredRows.length > 0 ? (
              <tr className="border-t-2 border-app-text/20 bg-app-surface-2">
                <td colSpan={3} className="px-4 py-4 text-[11px] font-black uppercase tracking-widest text-app-text">
                  Total commissions paid for period
                </td>
                <td className="px-4 py-4 text-right font-mono font-black tabular-nums">
                  {visibleTotals.saleCount}
                </td>
                <td className="px-4 py-4 text-right font-mono font-black tabular-nums">
                  {formatUsdFromCents(visibleTotals.baseEarned)}
                </td>
                <td className="px-4 py-4 text-right font-mono font-black tabular-nums">
                  {formatUsdFromCents(visibleTotals.spiffEarned)}
                </td>
                <td className="px-4 py-4 text-right font-mono text-3xl font-black text-emerald-800 tabular-nums">
                  {formatUsdFromCents(visibleTotals.earned)}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedStaffId ? (
        <div className="ui-card">
          <div className="border-b border-app-border px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Staff report
            </p>
            <p className="mt-1 text-sm font-semibold text-app-text">
              {selectedStaffName}
            </p>
            <p className="mt-1 text-[11px] text-app-text-muted">
              This staff-level line report still runs even when the commission
              summary table has no visible row for the selected window.
            </p>
          </div>
          <CommissionDrillDown
            staffId={selectedStaffId}
            from={commissionFrom}
            to={commissionTo}
            onTrace={(id) => setTraceLineId(id)}
          />
        </div>
      ) : null}

      {traceLineId && (
        <CommissionTraceModal
          lineId={traceLineId}
          onClose={() => setTraceLineId(null)}
          authHeaders={backofficeHeaders}
        />
      )}
    </div>
  );
}

function CommissionDrillDown({
  staffId,
  from,
  to,
  onTrace,
}: {
  staffId: string | null;
  from: string;
  to: string;
  onTrace: (lineId: string) => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [lines, setLines] = useState<CommissionLineRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLines = async () => {
      setLoading(true);
      try {
        const p = new URLSearchParams();
        if (staffId) p.set("staff_id", staffId);
        if (from) p.set("from", from);
        if (to) p.set("to", to);
        const res = await fetch(`${baseUrl}/api/insights/commission-lines?${p.toString()}`, {
          headers: backofficeHeaders(),
        });
        if (res.ok) setLines((await res.json()) as CommissionLineRow[]);
      } catch {
        /* silent */
      } finally {
        setLoading(false);
      }
    };
    void fetchLines();
  }, [staffId, from, to, backofficeHeaders]);

  if (loading) {
    return <div className="p-8 text-center text-[10px] uppercase font-black tracking-widest text-app-text-muted animate-pulse">Consulting the Truth Ledger...</div>;
  }

  if (lines.length === 0) {
    return (
      <div className="p-8 text-center text-[10px] uppercase font-black tracking-widest text-app-text-muted opacity-60 italic">
        No individual trace records found for this window. Check the date
        range, salesperson assignment, and commission rate setup.
      </div>
    );
  }

  return (
    <div className="p-4 bg-app-surface-2-80">
      <table className="w-full text-left text-[11px] border-collapse">
        <thead className="text-[9px] font-black uppercase tracking-widest text-app-text-muted/60">
          <tr className="border-b border-app-border/20">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Order</th>
            <th className="px-3 py-2">Product</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Gross</th>
            <th className="px-3 py-2 text-right text-emerald-800">Earned</th>
            <th className="px-3 py-2 text-center w-12">Trace</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-app-border/10">
          {lines.map((ln, index) => {
            const hasPayableCommission =
              parseMoneyToCents(ln.calculated_commission) !== 0;
            return (
              <tr
                key={ln.event_id ?? ln.transaction_line_id ?? `${ln.event_type}-${index}`}
                className="hover:bg-app-accent/5 transaction-colors group"
              >
                <td className="px-3 py-2 text-app-text-muted whitespace-nowrap">
                  {new Date(ln.booked_at).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 font-mono font-bold text-app-text">
                  {ln.order_short_id}
                </td>
                <td className="px-3 py-2 font-bold text-app-text truncate max-w-[150px]" title={ln.product_name}>
                  {ln.product_name}
                </td>
                <td className="px-3 py-2 text-right font-mono text-app-text-muted">
                  {ln.quantity}
                </td>
                <td className="px-3 py-2 text-right font-mono text-app-text">
                  {money(ln.line_gross)}
                </td>
                <td className="px-3 py-2 text-right font-mono font-black text-emerald-700">
                  {money(ln.calculated_commission)}
                </td>
                <td className="px-3 py-2 text-center">
                  {ln.event_id ? (
                    <button
                      type="button"
                      onClick={() => onTrace(ln.event_id!)}
                      title="View Truth Trace explainer"
                      className="p-1.5 rounded-lg text-app-accent hover:bg-app-accent hover:text-white transition-all scale-90 group-hover:scale-100"
                    >
                      <Info size={14} />
                    </button>
                  ) : (
                    <span
                      className="text-[9px] font-bold uppercase tracking-widest text-app-text-muted/50"
                      title={
                        hasPayableCommission
                          ? "Fulfilled line has payable commission but no event row yet."
                          : "Fulfilled line has no payable commission because no rate or active rule applied."
                      }
                    >
                      {hasPayableCommission ? "Pending" : "No rate"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
