import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { Receipt, Info, ChevronDown, ChevronRight } from "lucide-react";
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
  paid_out_commission: string;
}

function money(s: string | number) {
  return formatUsdFromCents(parseMoneyToCents(s));
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
      setCommissionRows((await res.json()) as CommissionLedgerRow[]);
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
    if (!selectedStaffId.trim()) return commissionRows;
    return commissionRows.filter((row) => row.staff_id === selectedStaffId);
  }, [commissionRows, selectedStaffId]);

  const selectedStaffName =
    staffRoster.find((row) => row.id === selectedStaffId)?.full_name ?? "Selected staff";

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
              <span className="font-bold text-app-text">Split-date model:</span>{" "}
              <em>Booked not fulfilled</em> is pipeline on open lines sold in range.{" "}
              <em>Earned in period</em> uses the <strong>recognition</strong> window: pickup / takeaway when
              fulfilled, shipped orders when the label ships or shipment moves to in transit / delivered (see Shipments
              hub). This screen is reporting-only; manual payout adjustments move to the Phase 2 ledger.
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
              <th className="px-4 py-3 text-right">Booked not fulfilled</th>
              <th className="px-4 py-3 text-right text-emerald-900/80">
                Earned in period
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {filteredRows.map((r) => {
              const k = commissionRowKey(r);
              const isExpanded = expandedStaffId === k;
              const earnedInPeriod =
                (parseMoneyToCents(r.realized_pending_payout || "0") +
                  parseMoneyToCents(r.paid_out_commission || "0")) /
                100;
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
                        {r.staff_name}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-amber-800 tabular-nums">
                      {money(r.unpaid_commission)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-800 tabular-nums">
                      {money(earnedInPeriod)}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={3} className="bg-app-surface-2/30 p-0">
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
                  colSpan={3}
                  className="px-4 py-8 text-center text-app-text-muted"
                >
                  {selectedStaffId
                    ? "No commission movement for this staff member in range."
                    : "No commission movement in range."}
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
    return <div className="p-8 text-center text-[10px] uppercase font-black tracking-widest text-app-text-muted opacity-40 italic">No individual trace records found for this window.</div>;
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
          {lines.map((ln, index) => (
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
                  <span className="text-[9px] font-bold uppercase tracking-widest text-app-text-muted/50">
                    Pending
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
