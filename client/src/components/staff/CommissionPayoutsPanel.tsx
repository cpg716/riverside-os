import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { Receipt, Info, ChevronDown, ChevronRight } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
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
  order_item_id: string;
  order_id: string;
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
  const [commissionSelected, setCommissionSelected] = useState<Set<string>>(
    () => new Set(),
  );
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false);
  const [expandedStaffId, setExpandedStaffId] = useState<string | null>(null);
  const [traceLineId, setTraceLineId] = useState<string | null>(null);

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

  useEffect(() => {
    void loadCommissions();
  }, [loadCommissions]);

  const toggleCommissionRow = (r: CommissionLedgerRow) => {
    const k = commissionRowKey(r);
    setCommissionSelected((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  const selectedPendingTotal = useMemo(() => {
    let tCents = 0;
    for (const r of commissionRows) {
      if (!commissionSelected.has(commissionRowKey(r))) continue;
      tCents += parseMoneyToCents(r.realized_pending_payout || "0");
    }
    return tCents / 100;
  }, [commissionRows, commissionSelected, commissionRowKey]);

  const finalizeCommissionPayout = useCallback(() => {
    const staff_ids = [...commissionSelected].filter(
      (id) => id !== COMMISSION_UNASSIGNED,
    );
    const include_unassigned = commissionSelected.has(COMMISSION_UNASSIGNED);
    if (staff_ids.length === 0 && !include_unassigned) {
      toast("Select at least one staff row (or Unassigned) to finalize.", "info");
      return;
    }
    setShowFinalizeConfirm(true);
  }, [commissionSelected, toast]);

  const executeFinalizeCommissionPayout = useCallback(async () => {
    setShowFinalizeConfirm(false);
    const staff_ids = [...commissionSelected].filter(
      (id) => id !== COMMISSION_UNASSIGNED,
    );
    const include_unassigned = commissionSelected.has(COMMISSION_UNASSIGNED);
    setFinalizeBusy(true);
    try {
      const body: Record<string, unknown> = {
        staff_ids,
        include_unassigned,
      };
      if (commissionFrom.trim()) body.from = commissionFrom.trim();
      if (commissionTo.trim()) body.to = commissionTo.trim();
      const res = await fetch(`${baseUrl}/api/insights/commission-finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Finalize failed");
      }
      const data = (await res.json()) as { lines_finalized?: number };
      setCommissionSelected(new Set());
      await loadCommissions();
      toast(
        data.lines_finalized != null
          ? `Marked ${data.lines_finalized} line(s) as paid out (finalized).`
          : "Payout finalized.",
        "success",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Finalize failed", "error");
    } finally {
      setFinalizeBusy(false);
    }
  }, [
    commissionSelected,
    commissionFrom,
    commissionTo,
    loadCommissions,
    backofficeHeaders,
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
              <em>Unpaid</em> is pipeline on open lines (sale booked in range).{" "}
              <em>Realized (pending payout)</em> uses the <strong>recognition</strong> window: pickup / takeaway when
              fulfilled, shipped orders when the label ships or shipment moves to in transit / delivered (see Shipments
              hub). Not yet marked paid out.{" "}
              <em>Paid out</em> is the same recognition window after you finalize below.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border/80 pt-3">
          <p className="text-[11px] text-app-text-muted">
            Selected pending payout:{" "}
            <span className="font-mono font-bold text-emerald-800">
              {money(selectedPendingTotal)}
            </span>
          </p>
          <button
            type="button"
            disabled={
              finalizeBusy ||
              commissionSelected.size === 0 ||
              selectedPendingTotal <= 0 ||
              !hasPermission("insights.commission_finalize")
            }
            onClick={() => void finalizeCommissionPayout()}
            className="rounded-xl border border-emerald-700/40 bg-emerald-700 px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {finalizeBusy ? "Finalizing…" : "Finalize payout"}
          </button>
        </div>
      </div>

      <div className="ui-card min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-x-contain">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            <tr>
              <th className="w-10 px-2 py-3"> </th>
              <th className="px-4 py-3">Staff</th>
              <th className="px-4 py-3 text-right">Unpaid (sale accrual)</th>
              <th className="px-4 py-3 text-right text-emerald-900/80">
                Realized (pending)
              </th>
              <th className="px-4 py-3 text-right text-app-text-muted">
                Paid out
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {commissionRows.map((r) => {
              const k = commissionRowKey(r);
              const isExpanded = expandedStaffId === k;
              const pendCents = parseMoneyToCents(
                r.realized_pending_payout || "0",
              );
              return (
                <Fragment key={k}>
                  <tr
                    className={`hover:bg-app-accent/10 transition-colors ${
                      commissionSelected.has(k) ? "bg-app-accent/15" : ""
                    } ${isExpanded ? "bg-app-surface-2" : ""}`}
                  >
                    <td className="px-2 py-3">
                      <input
                        type="checkbox"
                        checked={commissionSelected.has(k)}
                        disabled={pendCents <= 0}
                        onChange={() => toggleCommissionRow(r)}
                        className="h-4 w-4 rounded border-app-input-border text-app-accent"
                        title={
                          pendCents > 0
                            ? "Include in payout finalization"
                            : "No pending realized amount"
                        }
                        aria-label={`Select ${r.staff_name} for payout`}
                      />
                    </td>
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
                      {money(r.realized_pending_payout)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-app-text-muted tabular-nums">
                      {money(r.paid_out_commission)}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={5} className="bg-app-surface-2/30 p-0">
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
            {!loading && commissionRows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-app-text-muted"
                >
                  No commission movement in range.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {showFinalizeConfirm ? (
        <ConfirmationModal
          isOpen={true}
          title="Finalize Commission Payout?"
          message={`Finalize payout for ${money(selectedPendingTotal)} in realized (recognition-date) commissions for the selected rows and date window? Matching order lines are locked — attribution correction will no longer change them.`}
          confirmLabel="Execute Finalization"
          onConfirm={executeFinalizeCommissionPayout}
          onClose={() => setShowFinalizeConfirm(false)}
          variant="danger"
        />
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
          {lines.map((ln) => (
            <tr key={ln.order_item_id} className="hover:bg-app-accent/5 transaction-colors group">
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
                <button
                  type="button"
                  onClick={() => onTrace(ln.order_item_id)}
                  title="View Truth Trace explainer"
                  className="p-1.5 rounded-lg text-app-accent hover:bg-app-accent hover:text-white transition-all scale-90 group-hover:scale-100"
                >
                  <Info size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
