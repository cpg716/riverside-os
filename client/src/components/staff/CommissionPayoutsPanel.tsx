import { useCallback, useEffect, useMemo, useState } from "react";
import { Receipt } from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import {
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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
    baseUrl,
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
              const pendCents = parseMoneyToCents(
                r.realized_pending_payout || "0",
              );
              return (
                <tr
                  key={k}
                  className={`hover:bg-app-accent/10 ${
                    commissionSelected.has(k) ? "bg-app-accent/15" : ""
                  }`}
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
                  <td className="px-4 py-3 font-semibold">{r.staff_name}</td>
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
    </div>
  );
}
