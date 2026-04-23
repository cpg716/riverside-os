import { getBaseUrl } from "../../lib/apiConfig";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { openProfessionalZReportPrint } from "./zReportPrint";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

const MANDATORY_NOTE_OVER_USD = 5;

interface TenderTotal {
  payment_method: string;
  total_amount: string;
  tx_count: number;
}

interface CashAdjustmentLine {
  id: string;
  direction: string;
  amount: string;
  category: string | null;
  reason: string;
  created_at: string;
}

interface OverrideSummary {
  reason: string;
  line_count: number;
  total_delta: string;
}

interface Reconciliation {
  report_type?: string;
  session_id: string;
  opening_float: string;
  net_cash_adjustments?: string;
  expected_cash: string;
  tenders: TenderTotal[];
  tenders_by_lane?: TendersByLaneRow[];
  cash_adjustments?: CashAdjustmentLine[];
  override_summary?: OverrideSummary[];
  transactions: TransactionLine[];
}

interface TransactionLine {
  transaction_id: string;
  created_at: string;
  payment_method: string;
  amount: string;
  order_id: string | null;
  customer_name: string;
  override_reasons: string[];
  override_details: OverrideDetail[];
  register_lane?: number;
  register_session_id?: string;
}

interface TendersByLaneRow {
  register_lane: number;
  tenders: TenderTotal[];
}

interface OverrideDetail {
  reason: string;
  original_unit_price: string | null;
  overridden_unit_price: string | null;
  delta_amount: string | null;
}

interface CloseRegisterModalProps {
  sessionId: string;
  cashierName?: string | null;
  registerLane?: number | null;
  registerOrdinal?: number | null;
  onReconcilingBegun?: () => void;
  onCloseComplete: () => void;
  onCancel: () => void;
}

type DenomKey =
  | "c100"
  | "c50"
  | "c20"
  | "c10"
  | "c5"
  | "c1";

const DENOMS: { key: DenomKey; label: string; value: number }[] = [
  { key: "c100", label: "$100", value: 100 },
  { key: "c50", label: "$50", value: 50 },
  { key: "c20", label: "$20", value: 20 },
  { key: "c10", label: "$10", value: 10 },
  { key: "c5", label: "$5", value: 5 },
  { key: "c1", label: "$1", value: 1 },
];

const REGISTER_CLOSE_STEPS = [
  {
    id: "count",
    label: "Blind count",
    hint: "Count the drawer before you see system totals.",
  },
  {
    id: "report",
    label: "Review & finalize",
    hint: "Compare the count, add notes if needed, then close the shift.",
  },
] as const;

function mapCloseSessionError(message: string): string {
  const normalized = message.trim().toLowerCase();
  if (normalized === "register session is already closed") {
    return "This till group was already closed from another register. Refresh Register Reports before starting another Z-close.";
  }
  if (
    normalized ===
    "close the till shift from register #1 only; this closes all linked registers in the shift"
  ) {
    return "Close the shared drawer from Register #1 only. That single Z-close finishes every linked lane in the till group.";
  }
  return message;
}

export default function CloseRegisterModal({
  sessionId,
  cashierName = null,
  registerLane = null,
  registerOrdinal = null,
  onReconcilingBegun,
  onCloseComplete,
  onCancel,
}: CloseRegisterModalProps) {
  const { toast } = useToast();
  const { backofficeHeaders, staffCode } = useBackofficeAuth();
  useShellBackdropLayer(true);

  const jsonAuthHeaders = useCallback(() => {
    const h = new Headers(mergedPosStaffHeaders(backofficeHeaders));
    h.set("Content-Type", "application/json");
    return h;
  }, [backofficeHeaders]);

  const reconcileCashierCode = useMemo(() => {
    const c = staffCode.trim();
    return c.length === 4 ? c : "1234";
  }, [staffCode]);

  const [step, setStep] = useState<"count" | "report">("count");
  const [actualCash, setActualCash] = useState("");
  const [notes, setNotes] = useState("");
  const [closingComments, setClosingComments] = useState("");
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [reconError, setReconError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [denomCounts, setDenomCounts] = useState<Record<DenomKey, string>>(
    () => ({
      c100: "0",
      c50: "0",
      c20: "0",
      c10: "0",
      c5: "0",
      c1: "0",
    }),
  );
  const [coinSupplement, setCoinSupplement] = useState("");
  const [fullDrawerTotal, setFullDrawerTotal] = useState("");
  const [showFinalConfirm, setShowFinalConfirm] = useState(false);

  const baseUrl = getBaseUrl();
  const onReconcilingBegunRef = useRef(onReconcilingBegun);
  onReconcilingBegunRef.current = onReconcilingBegun;

  useEffect(() => {
    if (registerLane != null && registerLane !== 1) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/begin-reconcile`, {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ active: true, cashier_code: reconcileCashierCode }),
        });
        if (res.ok) onReconcilingBegunRef.current?.();
      } catch { /* optional */ }
    })();
  }, [sessionId, baseUrl, jsonAuthHeaders, reconcileCashierCode, registerLane]);

  useEffect(() => {
    if (registerLane != null && registerLane !== 1) return;
    let cancelled = false;
    setReconError(null);
    fetch(`${baseUrl}/api/sessions/${sessionId}/reconciliation`, {
      headers: mergedPosStaffHeaders(backofficeHeaders),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<Reconciliation>;
      })
      .then((data) => {
        if (!cancelled) setRecon(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error("Failed to fetch reconciliation", err);
          setReconError(err instanceof Error ? err.message : "Reconciliation failed");
        }
      });
    return () => { cancelled = true; };
  }, [sessionId, baseUrl, backofficeHeaders, registerLane]);

  const denominationTotal = useMemo(() => {
    let t = 0;
    for (const d of DENOMS) {
      const n = Number.parseInt(denomCounts[d.key] || "0", 10);
      if (Number.isFinite(n) && n >= 0) t += n * d.value;
    }
    return t;
  }, [denomCounts]);

  const handleBlindCountSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const bills = denominationTotal;
    const coinCents =
      coinSupplement.trim() === ""
        ? 0
        : Math.max(0, parseMoneyToCents(coinSupplement));
    const fullDrawerCents =
      fullDrawerTotal.trim() === ""
        ? null
        : parseMoneyToCents(fullDrawerTotal);
    const hasPieces =
      DENOMS.some(
        (d) => Number.parseInt(denomCounts[d.key] || "0", 10) > 0,
      ) || coinCents > 0;
    let totalCents: number | null = null;
    if (hasPieces) totalCents = Math.round(bills * 100) + coinCents;
    else if (
      fullDrawerCents !== null &&
      fullDrawerCents >= 0 &&
      fullDrawerTotal.trim() !== ""
    )
      totalCents = fullDrawerCents;
    if (totalCents == null || totalCents < 0) return;
    setActualCash(centsToFixed2(totalCents));
    setStep("report");
  };

  const internalCancel = async () => {
    try {
      if (registerLane == null || registerLane === 1) {
        await fetch(`${baseUrl}/api/sessions/${sessionId}/begin-reconcile`, {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ active: false, cashier_code: reconcileCashierCode }),
        });
      }
    } catch { /* ignore */ }
    onCancel();
  };

  const { dialogRef, titleId } = useDialogAccessibility(true, {
    onEscape: () => {
      void internalCancel();
    },
    closeOnEscape: !loading && !showFinalConfirm,
  });

  const handleFinalClose = async () => {
    setShowFinalConfirm(false);
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/close`, {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ 
          actual_cash: centsToFixed2(parseMoneyToCents(actualCash)), 
          closing_notes: notes.trim() || null,
          closing_comments: closingComments.trim() || null
        }),
      });
      if (!res.ok) {
        const errorMessage =
          ((await res.json().catch(() => ({}))) as { error?: string }).error ??
          "Failed to close session";
        throw new Error(mapCloseSessionError(errorMessage));
      }
      onCloseComplete();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to close session", "error");
      setLoading(false);
    }
  };

  const renderWorkflowSummary = (currentStep: "count" | "report") => {
    const currentIndex = REGISTER_CLOSE_STEPS.findIndex(
      (stepItem) => stepItem.id === currentStep,
    );
    const nextStep =
      currentIndex < REGISTER_CLOSE_STEPS.length - 1
        ? REGISTER_CLOSE_STEPS[currentIndex + 1]
        : null;

    return (
      <div className="space-y-3 rounded-2xl border border-app-border bg-app-surface-2 p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {REGISTER_CLOSE_STEPS.map((stepItem, index) => {
            const isCurrent = stepItem.id === currentStep;
            const isComplete = index < currentIndex;
            return (
              <div
                key={stepItem.id}
                className={`rounded-xl border px-3 py-3 ${
                  isCurrent
                    ? "border-app-accent bg-app-accent/10 text-app-text"
                    : isComplete
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-app-border bg-app-surface text-app-text-muted"
                }`}
              >
                <p className="text-[10px] font-black uppercase tracking-widest opacity-75">
                  Step {index + 1}
                </p>
                <p className="mt-1 text-xs font-black uppercase tracking-wide text-current">
                  {stepItem.label}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed opacity-80">
                  {stepItem.hint}
                </p>
              </div>
            );
          })}
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface px-3 py-3 text-xs text-app-text-muted">
          <p className="text-[10px] font-black uppercase tracking-widest">
            Current stage
          </p>
          <p className="mt-1 font-bold text-app-text">
            {REGISTER_CLOSE_STEPS[currentIndex]?.label}
          </p>
          <p className="mt-1 leading-relaxed">
            {nextStep
              ? `Next: ${nextStep.label}. ${nextStep.hint}`
              : "Next: finalize the shared drawer from Register #1. This single Z-close finishes every open lane in the till group once the reconciliation summary and notes are complete."}
          </p>
        </div>
      </div>
    );
  };

  if (registerLane != null && registerLane !== 1) {
    return (
      <div className="ui-overlay-backdrop">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal max-w-md animate-workspace-snap outline-none"
        >
          <div className="ui-modal-header">
            <h2 id={titleId} className="text-lg font-black text-app-text">
              Z-close runs on Register #1
            </h2>
          </div>
          <div className="ui-modal-body space-y-3 text-sm text-app-text-muted">
            <p>
              You are on Register #{registerLane}. End-of-shift Z-close and the single cash drawer
              count happen on the primary lane (Register #1). Use shift handoff or attach to Register
              #1 to close the till.
            </p>
          </div>
          <div className="ui-modal-footer">
            <button type="button" onClick={() => void internalCancel()} className="ui-btn-primary w-full py-3">
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "count") {
    const hasBillCounts = DENOMS.some(d => Number.parseInt(denomCounts[d.key] || "0", 10) > 0);
    const coinOk =
      coinSupplement.trim() !== "" &&
      Number.isFinite(parseMoneyToCents(coinSupplement));
    const fullOk =
      fullDrawerTotal.trim() !== "" &&
      Number.isFinite(parseMoneyToCents(fullDrawerTotal));
    const canSubmitDenom = hasBillCounts || coinOk || fullOk;

    return (
      <div className="ui-overlay-backdrop">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal max-h-[95vh] max-w-lg overflow-y-auto rounded-3xl animate-workspace-snap outline-none"
        >
          <div className="ui-modal-header flex items-center justify-between">
            <div className="flex gap-2">
              <span className="ui-pill ui-status-warn">Reconciling</span>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Step 1 of 2</span>
            </div>
            <h2 id={titleId} className="text-sm font-black text-app-text uppercase tracking-widest">
              End of Shift
            </h2>
          </div>
          <div className="ui-modal-body space-y-4">
            {registerLane != null ? (
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Register #{registerLane}
                {registerOrdinal != null ? ` · Session #${registerOrdinal}` : ""}
              </p>
            ) : null}
            {renderWorkflowSummary("count")}
            <p className="text-xs text-app-text-muted">
              Blind count: use the denomination helper (recommended) or enter a total. System expected cash is hidden until next step.
            </p>

            <div className="ui-panel bg-app-surface p-4">
              <p className="mb-3 text-[10px] font-black uppercase text-app-text-muted tracking-widest">Denomination counter</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {DENOMS.map((d) => (
                  <label key={d.key} className="flex flex-col gap-1 text-[10px] font-bold text-app-text-muted">
                    {d.label}
                    <input type="number" min={0} value={denomCounts[d.key]} onChange={e => setDenomCounts(prev => ({ ...prev, [d.key]: e.target.value }))} className="ui-input w-full p-2 text-center font-mono" />
                  </label>
                ))}
              </div>
              <p className="mt-4 text-right font-mono text-lg font-black text-app-text border-t border-app-border pt-2">
                Bills:{" "}
                <span className="text-app-success">
                  ${centsToFixed2(Math.round(denominationTotal * 100))}
                </span>
              </p>
              <label className="mt-4 block text-[10px] font-black uppercase text-app-text-muted tracking-widest">Coins & Rolled ($)</label>
              <input type="number" step="0.01" min={0} value={coinSupplement} onChange={e => setCoinSupplement(e.target.value)} className="ui-input w-full p-3 font-mono text-center mt-1" placeholder="0.00" />
            </div>

            <form onSubmit={handleBlindCountSubmit} className="space-y-4">
              <div className="ui-panel p-4 bg-app-surface">
                <label className="mb-2 block text-[10px] font-black uppercase text-app-text-muted tracking-widest">Or Full Drawer Total ($)</label>
                <input type="number" step="0.01" value={fullDrawerTotal} onChange={e => setFullDrawerTotal(e.target.value)} className="ui-input w-full p-4 text-center font-mono text-2xl" placeholder="---" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={internalCancel} className="ui-btn-secondary flex-1 py-3">Cancel</button>
                <button type="submit" disabled={!canSubmitDenom} className="ui-btn-primary flex-1 py-3 text-sm font-black">Verify Count</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (reconError) {
    return (
      <div className="ui-overlay-backdrop">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal max-w-md animate-workspace-snap outline-none"
        >
          <div className="ui-modal-header text-app-danger font-black uppercase text-xs tracking-widest">
            <h2 id={titleId}>Error</h2>
          </div>
          <div className="ui-modal-body text-center py-10">
            <p className="text-sm text-app-text mb-6">{reconError}</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => void internalCancel()} className="ui-btn-secondary flex-1">
                Close
              </button>
              <button type="button" onClick={() => setStep("count")} className="ui-btn-primary flex-1">
                Back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!recon) {
    return (
      <div className="ui-overlay-backdrop">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy="true"
          tabIndex={-1}
          className="ui-modal flex max-w-xs flex-col items-center justify-center gap-4 p-8 animate-pulse outline-none"
        >
          <h2 id={titleId} className="sr-only">
            Calculating reconciliation
          </h2>
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
          <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">Calculating...</p>
        </div>
      </div>
    );
  }

  const expectedCents = parseMoneyToCents(recon.expected_cash);
  const actualCents = parseMoneyToCents(actualCash);
  const discrepancyCents = actualCents - expectedCents;
  const isOff = discrepancyCents !== 0;
  const openingCents = parseMoneyToCents(recon.opening_float);
  const netAdjCents = parseMoneyToCents(recon.net_cash_adjustments ?? "0");
  const cashSalesCents = expectedCents - openingCents - netAdjCents;
  const needsNote =
    Math.abs(discrepancyCents) > MANDATORY_NOTE_OVER_USD * 100;

  return (
    <div className="ui-overlay-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal flex max-h-[95vh] max-w-3xl flex-col rounded-3xl animate-workspace-snap outline-none"
      >
        <div className="ui-modal-header flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="ui-pill ui-status-warn">Reconciling</span>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Step 2 of 2</span>
            </div>
            <h2 id={titleId} className="text-xl font-black text-app-text">
              Shift Reconciliation
            </h2>
          </div>
          <button
            type="button"
            onClick={() =>
              openProfessionalZReportPrint({
                title: "Z-Report",
                sessionId: recon.session_id,
                registerOrdinal,
                cashierLabel: cashierName,
                openedAt: null,
                openingCents,
                cashSalesCents,
                netAdjustmentsCents: netAdjCents,
                expectedCents,
                actualCents,
                discrepancyCents,
                tenders: recon.tenders,
                overrideSummary: recon.override_summary ?? [],
                tendersByLane: recon.tenders_by_lane,
                transactions: recon.transactions.map((t) => ({
                  created_at: t.created_at,
                  payment_method: t.payment_method,
                  amount: t.amount,
                  customer_name: t.customer_name,
                  register_lane: t.register_lane ?? 1,
                })),
              })
            }
            className="ui-btn-secondary border-app-accent/20 px-4 py-2 text-app-accent shadow-sm"
          >
            Print Z-Report (Full Page)
          </button>
        </div>

        <div className="ui-modal-body flex-1 overflow-y-auto space-y-6">
          {renderWorkflowSummary("report")}
          {(recon.tenders_by_lane?.length ?? 0) > 1 ? (
            <div className="rounded-xl border border-app-accent/20 bg-app-accent/5 p-4 text-xs text-app-text-muted">
              <p className="font-black uppercase tracking-widest text-[10px] text-app-text mb-1">
                One physical drawer
              </p>
              <p>
                Expected cash includes cash tendered on linked registers in this till shift. Finalizing
                closes every open lane in the group.
              </p>
            </div>
          ) : null}
          <div className={`rounded-2xl border-2 p-5 ${isOff ? "border-app-danger/20 bg-app-danger/5" : "border-app-success/20 bg-app-success/5"}`}>
            <h3 className="mb-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border pb-2">Cash Drawer Audit</h3>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between text-app-text-muted font-medium"><span>Opening Float:</span><span className="font-mono">${centsToFixed2(openingCents)}</span></div>
              <div className="flex justify-between text-app-text-muted font-medium"><span>Cash Sales:</span><span className="font-mono text-app-success">+ ${centsToFixed2(cashSalesCents)}</span></div>
              <div className="flex justify-between text-app-text-muted font-medium"><span>Net adjustments:</span><span className="font-mono text-orange-500">${centsToFixed2(netAdjCents)}</span></div>
              <div className="flex justify-between pt-3 border-t border-app-border font-black text-app-text uppercase text-xs"><span>Expected Cash:</span><span className="font-mono">${centsToFixed2(expectedCents)}</span></div>
              <div className="flex justify-between pt-1 font-black text-app-accent text-lg"><span>Actual Counted:</span><span className="font-mono">${centsToFixed2(actualCents)}</span></div>
            </div>
            {isOff && (
              <div className="mt-4 p-4 rounded-xl bg-app-danger/10 border border-app-danger/20">
                <div className="flex justify-between text-app-danger font-black text-xs uppercase tracking-widest">
                  <span>Discrepancy ({discrepancyCents < 0 ? "Short" : "Over"}):</span>
                  <span className="font-mono">${centsToFixed2(Math.abs(discrepancyCents))}</span>
                </div>
                {needsNote ? (
                  <p className="text-[10px] font-bold mt-2 text-app-danger/80 leading-relaxed">
                    Closing notes are required because cash is over or short by more than $5.00. Explain the likely cause before you finalize the shift.
                  </p>
                ) : (
                  <p className="text-[10px] font-semibold mt-2 text-app-danger/75 leading-relaxed">
                    Review the over or short amount before finalizing so the next team understands what changed in the drawer.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4 md:col-span-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Tender breakdown (all lanes)</h3>
              <div className="ui-panel overflow-hidden border-app-border/40">
                <table className="w-full text-xs">
                  <thead className="bg-app-surface border-b border-app-border text-app-text-muted"><tr><th className="px-3 py-2">Method</th><th className="px-3 py-2 text-center">Txs</th><th className="px-3 py-2 text-right">Total</th></tr></thead>
                  <tbody className="divide-y divide-app-border/30">
                    {recon.tenders.map(t => (
                      <tr key={t.payment_method} className="hover:bg-app-surface/40 transition-colors"><td className="px-3 py-2 font-bold capitalize">{t.payment_method}</td><td className="px-3 py-2 text-center">{t.tx_count}</td><td className="px-3 py-2 text-right font-mono font-bold">${centsToFixed2(parseMoneyToCents(t.total_amount))}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {(recon.tenders_by_lane?.length ?? 0) > 0 ? (
              <div className="space-y-4 md:col-span-2">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">By register</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  {recon.tenders_by_lane!.map((row) => (
                    <div key={row.register_lane} className="ui-panel overflow-hidden border-app-border/40">
                      <p className="border-b border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Register #{row.register_lane}
                      </p>
                      <table className="w-full text-xs">
                        <thead className="text-app-text-muted"><tr><th className="px-3 py-2">Method</th><th className="px-3 py-2 text-center">Txs</th><th className="px-3 py-2 text-right">Total</th></tr></thead>
                        <tbody className="divide-y divide-app-border/30">
                          {row.tenders.map((t) => (
                            <tr key={`${row.register_lane}-${t.payment_method}`}>
                              <td className="px-3 py-2 font-bold capitalize">{t.payment_method}</td>
                              <td className="px-3 py-2 text-center">{t.tx_count}</td>
                              <td className="px-3 py-2 text-right font-mono font-bold">${centsToFixed2(parseMoneyToCents(t.total_amount))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-4 md:col-span-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Overrides & Adjusts</h3>
              <div className="ui-panel p-3 space-y-4 max-h-[160px] overflow-y-auto">
                {recon.cash_adjustments?.map(a => (
                  <div key={a.id} className="flex justify-between items-start gap-2 border-b border-app-border/30 pb-2 last:border-0 last:pb-0">
                    <span className="text-[10px] text-app-text uppercase font-bold leading-tight">{a.reason}<br/><span className="text-app-text-muted font-normal text-[9px] capitalize">{a.direction}</span></span>
                    <span className={`font-mono text-[10px] font-black ${a.direction === 'paid_in' ? 'text-app-success' : 'text-app-danger'}`}>${centsToFixed2(parseMoneyToCents(a.amount))}</span>
                  </div>
                ))}
                {(recon.cash_adjustments?.length ?? 0) === 0 && <p className="text-[10px] text-center text-app-text-muted py-4">No adjustments recorded</p>}
              </div>
            </div>
          </div>

          {recon.transactions.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Payments (shift)</h3>
              <div className="ui-panel max-h-48 overflow-auto border-app-border/40">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-app-surface text-app-text-muted">
                    <tr>
                      <th className="px-2 py-2 text-left">Time</th>
                      <th className="px-2 py-2 text-left">Reg</th>
                      <th className="px-2 py-2 text-left">Method</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                      <th className="px-2 py-2 text-left">Customer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border/30">
                    {recon.transactions.map((t) => (
                      <tr key={t.transaction_id}>
                        <td className="px-2 py-1.5 font-mono text-app-text-muted whitespace-nowrap">
                          {new Date(t.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="px-2 py-1.5 font-bold">#{t.register_lane ?? "—"}</td>
                        <td className="px-2 py-1.5 capitalize">{t.payment_method.replace(/_/g, " ")}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold">${centsToFixed2(parseMoneyToCents(t.amount))}</td>
                        <td className="px-2 py-1.5 text-app-text-muted truncate max-w-[120px]" title={t.customer_name}>
                          {t.customer_name || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">Closing Notes / Discrepancy</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} className="ui-input w-full p-4 h-24 resize-none text-sm" placeholder={needsNote ? "REQUIRED: Managerial note for discrepancy..." : "Optional shift notes..."} />
            </div>
            <div>
              <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-emerald-500/80">Daily Context (Momentum View)</label>
              <textarea value={closingComments} onChange={e => setClosingComments(e.target.value)} className="ui-input w-full p-4 h-24 resize-none text-sm border-emerald-500/20" placeholder="e.g. Blizzard kept people home, Parade blocked street..." />
            </div>
          </div>
        </div>

        <div className="ui-modal-footer gap-4 p-6">
          <button type="button" onClick={() => setStep("count")} className="ui-btn-secondary px-8 py-3">
            Recount
          </button>
          <div className="flex-1">
            <button
              type="button"
              onClick={() => setShowFinalConfirm(true)}
              disabled={loading || (needsNote && !notes.trim())}
              className="ui-btn-primary w-full py-3 text-sm font-black shadow-lg"
            >
              {loading ? "Closing..." : "Finalize & Close Shift"}
            </button>
            {needsNote && !notes.trim() ? (
              <p className="mt-2 text-[10px] font-semibold leading-relaxed text-app-danger">
                Add closing notes to explain this cash discrepancy before the shift can be closed.
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <ConfirmationModal
        isOpen={showFinalConfirm}
        title="Close till shift?"
        message="This closes every open register lane in this till shift, finalizes the shared Z report, and clears POS tokens on those lanes. This cannot be undone."
        confirmLabel="Close Shift"
        variant="danger"
        onConfirm={() => void handleFinalClose()}
        onClose={() => setShowFinalConfirm(false)}
      />
    </div>
  );
}
