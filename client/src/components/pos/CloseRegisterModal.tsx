import { getBaseUrl } from "../../lib/apiConfig";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { openProfessionalZReportPrint } from "./zReportPrint";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { getCheckoutQueueSummary, type CheckoutQueueSummary } from "../../lib/offlineQueue";

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

interface ManualDrawerOpenLine {
  id: string;
  staff_id: string;
  staff_name: string;
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
  manual_drawer_opens?: ManualDrawerOpenLine[];
  override_summary?: OverrideSummary[];
  transactions: TransactionLine[];
  unresolved_helcim_attempts?: HelcimCloseReviewAttempt[];
}

interface HelcimCloseReviewAttempt {
  id: string;
  register_session_id: string;
  register_lane: number;
  status: string;
  amount_cents: number;
  selected_terminal_key?: string | null;
  review_reason: "waiting_on_terminal" | "approved_not_recorded" | "outcome_needs_review" | string;
  created_at: string;
}

interface TransactionLine {
  transaction_id: string;
  created_at: string;
  payment_method: string;
  amount: string;
  order_id: string | null;
  transaction_display_id?: string | null;
  transaction_status?: string | null;
  transaction_total?: string | null;
  transaction_paid?: string | null;
  transaction_balance_due?: string | null;
  customer_name: string;
  items?: {
    name: string;
    sku: string;
    quantity: number;
    unit_price: string;
    fulfillment: string;
    is_internal: boolean;
    line_kind?: string | null;
  }[];
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
  const { backofficeHeaders, staffCode, clearStaffCredentials } = useBackofficeAuth();
  useShellBackdropLayer(true);

  const jsonAuthHeaders = useCallback(() => {
    const h = new Headers(mergedPosStaffHeaders(backofficeHeaders));
    h.set("Content-Type", "application/json");
    return h;
  }, [backofficeHeaders]);

  const reconcileCashierCode = useMemo(() => {
    const c = staffCode.trim();
    return /^\d{4}$/.test(c) ? c : null;
  }, [staffCode]);

  const [step, setStep] = useState<"count" | "report">("count");
  const [actualCash, setActualCash] = useState("");
  const [notes, setNotes] = useState("");
  const [closingComments, setClosingComments] = useState("");
  const [countEditReason, setCountEditReason] = useState("");
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
  const [offlineQueueSummary, setOfflineQueueSummary] = useState<CheckoutQueueSummary>({
    totalCount: 0,
    pendingCount: 0,
    blockedCount: 0,
  });

  const baseUrl = getBaseUrl();
  const onReconcilingBegunRef = useRef(onReconcilingBegun);
  onReconcilingBegunRef.current = onReconcilingBegun;

  useEffect(() => {
    if (registerLane != null && registerLane !== 1) return;
    if (!reconcileCashierCode) return;
    void (async () => {
      try {
        const summary = await getCheckoutQueueSummary();
        setOfflineQueueSummary(summary);
        if (summary.totalCount > 0) return;
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
    if (!reconcileCashierCode) return;
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
  }, [sessionId, baseUrl, backofficeHeaders, registerLane, reconcileCashierCode]);

  const refreshOfflineQueueSummary = useCallback(async () => {
    const summary = await getCheckoutQueueSummary();
    setOfflineQueueSummary(summary);
    return summary;
  }, []);

  useEffect(() => {
    void refreshOfflineQueueSummary();
    const handleQueueChanged = () => {
      void refreshOfflineQueueSummary();
    };
    window.addEventListener("queue_changed", handleQueueChanged);
    return () => window.removeEventListener("queue_changed", handleQueueChanged);
  }, [refreshOfflineQueueSummary]);

  const denominationTotal = useMemo(() => {
    let t = 0;
    for (const d of DENOMS) {
      const n = Number.parseInt(denomCounts[d.key] || "0", 10);
      if (Number.isFinite(n) && n >= 0) t += n * d.value;
    }
    return t;
  }, [denomCounts]);

  const blockForOfflineQueue = useCallback(async () => {
    const summary = await refreshOfflineQueueSummary();
    if (summary.totalCount === 0) return false;
    try {
      if ((registerLane == null || registerLane === 1) && reconcileCashierCode) {
        await fetch(`${baseUrl}/api/sessions/${sessionId}/begin-reconcile`, {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ active: false, cashier_code: reconcileCashierCode }),
        });
      }
    } catch { /* optional recovery; the close remains blocked either way */ }
    const message =
      summary.blockedCount > 0
        ? `${summary.blockedCount} completed checkout${summary.blockedCount === 1 ? "" : "s"} need manager recovery before Z-close.`
        : `${summary.pendingCount} completed checkout${summary.pendingCount === 1 ? "" : "s"} still need to sync before Z-close.`;
    toast(message, "error");
    return true;
  }, [baseUrl, jsonAuthHeaders, reconcileCashierCode, refreshOfflineQueueSummary, registerLane, sessionId, toast]);

  const unresolvedHelcimAttempts = useMemo(
    () => recon?.unresolved_helcim_attempts ?? [],
    [recon?.unresolved_helcim_attempts],
  );
  const helcimReviewMessage = useMemo(() => {
    if (unresolvedHelcimAttempts.length === 0) return null;
    const approved = unresolvedHelcimAttempts.filter((attempt) => attempt.review_reason === "approved_not_recorded").length;
    const pending = unresolvedHelcimAttempts.filter((attempt) => attempt.review_reason === "waiting_on_terminal").length;
    const review = unresolvedHelcimAttempts.filter((attempt) => attempt.review_reason === "outcome_needs_review").length;
    const parts: string[] = [];
    if (approved > 0) parts.push(`${approved} card approval${approved === 1 ? "" : "s"} not recorded in ROS`);
    if (pending > 0) parts.push(`${pending} card outcome${pending === 1 ? "" : "s"} still waiting on the terminal`);
    if (review > 0) parts.push(`${review} card outcome${review === 1 ? "" : "s"} unresolved`);
    return `Card payment review required before Z-close: ${parts.join(", ")}. Review the terminal result, then record or void the attempt before closing.`;
  }, [unresolvedHelcimAttempts]);

  const blockForHelcimReview = useCallback(() => {
    if (!helcimReviewMessage) return false;
    toast(helcimReviewMessage, "error");
    return true;
  }, [helcimReviewMessage, toast]);

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
    void (async () => {
      if (await blockForOfflineQueue()) return;
      if (blockForHelcimReview()) return;
      setActualCash(centsToFixed2(totalCents));
      setStep("report");
    })();
  };

  const internalCancel = async () => {
    try {
      if ((registerLane == null || registerLane === 1) && reconcileCashierCode) {
        await fetch(`${baseUrl}/api/sessions/${sessionId}/begin-reconcile`, {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ active: false, cashier_code: reconcileCashierCode }),
        });
      }
    } catch { /* ignore */ }
    onCancel();
  };

  const requireStaffReauth = useCallback(() => {
    clearStaffCredentials();
    onCancel();
    toast("Staff Access is required before Z-close. Sign in again with your Access PIN.", "error");
  }, [clearStaffCredentials, onCancel, toast]);

  const { dialogRef, titleId } = useDialogAccessibility(true, {
    onEscape: () => {
      void internalCancel();
    },
    closeOnEscape: !loading && !showFinalConfirm,
  });

  const buildClosingNotesForReport = () => {
    const countEditNote = countEditReason.trim()
      ? `Count edit note: ${countEditReason.trim()}`
      : "";
    return [notes.trim(), countEditNote].filter(Boolean).join("\n");
  };

  const handleFinalClose = async () => {
    setShowFinalConfirm(false);
    if (!reconcileCashierCode) {
      requireStaffReauth();
      return;
    }
    if (await blockForOfflineQueue()) return;
    if (blockForHelcimReview()) return;
    setLoading(true);
    const closingNotesForReport = buildClosingNotesForReport();
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/close`, {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          actual_cash: centsToFixed2(parseMoneyToCents(actualCash)),
          closing_notes: closingNotesForReport || null,
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
      <div className="ui-panel ui-tint-neutral space-y-3 p-4">
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
                      ? "ui-tint-success text-app-success"
                      : "ui-tint-neutral text-app-text-muted"
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
        <div className="ui-metric-cell ui-tint-info px-3 py-3 text-xs text-app-text-muted">
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

  const renderOfflineQueueBlocker = () => {
    if (offlineQueueSummary.totalCount === 0) return null;
    return (
      <div className="ui-panel ui-tint-danger p-4 text-xs text-app-text-muted">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
            Checkout recovery required
          </p>
          <span className="rounded-full border border-app-danger/25 bg-app-danger/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-danger">
            Owner: manager
          </span>
        </div>
        <p className="mt-1 leading-relaxed">
          {offlineQueueSummary.blockedCount > 0
            ? `${offlineQueueSummary.blockedCount} completed checkout${offlineQueueSummary.blockedCount === 1 ? "" : "s"} need manager recovery.`
            : null}
          {offlineQueueSummary.pendingCount > 0
            ? ` ${offlineQueueSummary.pendingCount} completed checkout${offlineQueueSummary.pendingCount === 1 ? "" : "s"} still need to sync.`
            : null}
          {" "}Resolve these before closing so the Z report includes every completed sale.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {["Open the checkout recovery item", "Resolve or sync each sale", "Return here and retry close"].map((step, index) => (
            <div key={step} className="rounded-xl border border-app-danger/20 bg-app-surface/80 px-3 py-2">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-danger">Step {index + 1}</p>
              <p className="mt-1 font-bold text-app-text">{step}</p>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderHelcimReviewBlocker = () => {
    if (!helcimReviewMessage) return null;
    return (
      <div className="ui-panel ui-tint-danger p-4 text-xs text-app-text-muted">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
            Card payment needs review
          </p>
          <span className="rounded-full border border-app-danger/25 bg-app-danger/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-danger">
            Owner: manager
          </span>
        </div>
        <p className="mt-1 leading-relaxed">{helcimReviewMessage}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {unresolvedHelcimAttempts.slice(0, 4).map((attempt) => (
            <p key={attempt.id} className="rounded-xl border border-app-border bg-app-surface/70 px-3 py-2 font-semibold text-app-text">
              Register #{attempt.register_lane} · ${centsToFixed2(Math.abs(attempt.amount_cents))} · {
                attempt.review_reason === "approved_not_recorded"
                  ? "Approved, not recorded"
                  : attempt.review_reason === "waiting_on_terminal"
                    ? "Waiting on terminal"
                    : "Outcome unresolved"
              }
            </p>
          ))}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {["Go to Payments > Health", "Record, void, or release the attempt", "Return here and retry close"].map((step, index) => (
            <div key={step} className="rounded-xl border border-app-danger/20 bg-app-surface/80 px-3 py-2">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-danger">Step {index + 1}</p>
              <p className="mt-1 font-bold text-app-text">{step}</p>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  if (registerLane != null && registerLane !== 1) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <button
          type="button"
          className="absolute inset-0 bg-black/50"
          onClick={() => void internalCancel()}
          aria-label="Close"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal relative w-full max-w-none rounded-t-3xl animate-workspace-snap outline-none sm:max-w-md sm:rounded-3xl"
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
      </div>,
      root
    );
  }

  if (!reconcileCashierCode) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <button
          type="button"
          className="absolute inset-0 bg-black/50"
          onClick={onCancel}
          aria-label="Close"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal relative w-full max-w-none rounded-t-3xl animate-workspace-snap outline-none sm:max-w-md sm:rounded-3xl"
        >
          <div className="ui-modal-header">
            <h2 id={titleId} className="text-lg font-black text-app-text">
              Staff Access required
            </h2>
          </div>
          <div className="ui-modal-body space-y-3 text-sm text-app-text-muted">
            <p>
              Z-close needs the authenticated staff member who is physically completing the drawer count. Sign in again with your Access PIN before reconciling this till shift.
            </p>
          </div>
          <div className="ui-modal-footer flex gap-3">
            <button type="button" onClick={onCancel} className="ui-btn-secondary flex-1 py-3">
              Cancel
            </button>
            <button type="button" onClick={requireStaffReauth} className="ui-btn-primary flex-1 py-3">
              Change Staff Member
            </button>
          </div>
        </div>
      </div>,
      root
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

    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <button
          type="button"
          className="absolute inset-0 bg-black/50"
          onClick={() => void internalCancel()}
          aria-label="Close"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal relative max-h-[96dvh] w-full max-w-none overflow-y-auto rounded-t-3xl animate-workspace-snap outline-none sm:max-h-[95vh] sm:max-w-5xl sm:rounded-3xl"
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
          <div className="ui-modal-body grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <div className="space-y-4">
              {registerLane != null ? (
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Register #{registerLane}
                  {registerOrdinal != null ? ` · Session #${registerOrdinal}` : ""}
                </p>
              ) : null}
              {renderWorkflowSummary("count")}
              {renderOfflineQueueBlocker()}
              {renderHelcimReviewBlocker()}
              <p className="rounded-2xl border border-app-border bg-app-surface/70 px-4 py-3 text-xs font-semibold text-app-text-muted">
                Count the drawer without looking at the expected cash. Use the bill helper, or enter one full drawer total.
              </p>
            </div>

            <form onSubmit={handleBlindCountSubmit} className="space-y-4">
              <div className="ui-panel ui-tint-neutral p-4">
                <p className="mb-3 text-[10px] font-black uppercase text-app-text-muted tracking-widest">Bill count</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {DENOMS.map((d) => (
                    <label key={d.key} className="flex flex-col gap-1 text-[10px] font-bold text-app-text-muted">
                      {d.label}
                      <input type="number" min={0} value={denomCounts[d.key]} onChange={e => setDenomCounts(prev => ({ ...prev, [d.key]: e.target.value }))} className="ui-input w-full p-2 text-center font-mono" />
                    </label>
                  ))}
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <label className="block text-[10px] font-black uppercase text-app-text-muted tracking-widest">
                    Coins & rolled coin
                    <input type="number" step="0.01" min={0} value={coinSupplement} onChange={e => setCoinSupplement(e.target.value)} className="ui-input mt-1 w-full p-3 font-mono text-center" placeholder="0.00" />
                  </label>
                  <p className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-right font-mono text-lg font-black text-app-text">
                    Bills <span className="text-app-success">${centsToFixed2(Math.round(denominationTotal * 100))}</span>
                  </p>
                </div>
              </div>

              <div className="ui-panel ui-tint-neutral p-4">
                <label className="mb-2 block text-[10px] font-black uppercase text-app-text-muted tracking-widest">Or enter full drawer total</label>
                <input type="number" step="0.01" value={fullDrawerTotal} onChange={e => setFullDrawerTotal(e.target.value)} className="ui-input w-full p-4 text-center font-mono text-2xl" placeholder="---" />
              </div>
              <div className="sticky bottom-0 -mx-4 flex gap-3 border-t border-app-border bg-app-surface/95 px-4 py-3 backdrop-blur">
                <button type="button" onClick={internalCancel} className="ui-btn-secondary flex-1 py-3">Cancel</button>
                <button type="submit" disabled={!canSubmitDenom} className="ui-btn-primary flex-1 py-3 text-sm font-black">Verify Count</button>
              </div>
            </form>
          </div>
        </div>
      </div>,
      root
    );
  }

  if (reconError) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <button
          type="button"
          className="absolute inset-0 bg-black/50"
          onClick={() => void internalCancel()}
          aria-label="Close"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal relative w-full max-w-none rounded-t-3xl animate-workspace-snap outline-none sm:max-w-md sm:rounded-3xl"
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
      </div>,
      root
    );
  }

  if (!recon) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy="true"
          tabIndex={-1}
          className="ui-modal flex w-full max-w-none flex-col items-center justify-center gap-4 rounded-t-3xl p-8 animate-pulse outline-none sm:max-w-xs sm:rounded-3xl"
        >
          <h2 id={titleId} className="sr-only">
            Calculating reconciliation
          </h2>
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
          <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">Calculating...</p>
        </div>
      </div>,
      root
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
  const closingNotesForReport = buildClosingNotesForReport();
  const closeBlockers = [
    offlineQueueSummary.totalCount > 0 ? "Checkout recovery" : null,
    helcimReviewMessage ? "Card payment review" : null,
    needsNote && notes.trim() === "" ? "Cash discrepancy note" : null,
  ].filter(Boolean);
  const closeReady = closeBlockers.length === 0;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={() => void internalCancel()}
        aria-label="Close"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal relative flex max-h-[96dvh] w-full max-w-none flex-col rounded-t-3xl animate-workspace-snap outline-none sm:max-h-[95vh] sm:max-w-3xl sm:rounded-3xl"
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
                closingNotes: closingNotesForReport || null,
                closingComments: closingComments.trim() || null,
                tenders: recon.tenders,
                overrideSummary: recon.override_summary ?? [],
                tendersByLane: recon.tenders_by_lane,
                manualDrawerOpens: recon.manual_drawer_opens ?? [],
                transactions: recon.transactions.map((t) => ({
                  created_at: t.created_at,
                  payment_method: t.payment_method,
                  amount: t.amount,
                  customer_name: t.customer_name,
                  transaction_display_id: t.transaction_display_id,
                  transaction_status: t.transaction_status,
                  transaction_total: t.transaction_total,
                  transaction_paid: t.transaction_paid,
                  transaction_balance_due: t.transaction_balance_due,
                  items: t.items ?? [],
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
          <div
            className={`rounded-2xl border px-4 py-3 ${
              closeReady
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-rose-200 bg-rose-50 text-rose-900"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-black uppercase tracking-widest">
                {closeReady ? "Ready to close" : "Close blocked"}
              </p>
              <span className="rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest">
                {closeReady ? "All checks clear" : `${closeBlockers.length} action${closeBlockers.length === 1 ? "" : "s"}`}
              </span>
            </div>
            <p className="mt-1 text-sm font-semibold">
              {closeReady
                ? "Cash count, checkout recovery, and card review are clear. Finalize when notes are correct."
                : `Before closing: ${closeBlockers.join(", ")}.`}
            </p>
            <p className="mt-2 text-xs font-bold opacity-85">
              {closeReady
                ? "Review any late refunds or recovery notes before final close so the shift handoff stays clear."
                : "Use the action cards below to clear each item, then retry close."}
              {closeReady
                ? " After close, accounting can confirm the QuickBooks status from the QBO workspace."
                : ""}
            </p>
          </div>
          {renderOfflineQueueBlocker()}
          {renderHelcimReviewBlocker()}
          {(recon.tenders_by_lane?.length ?? 0) > 1 ? (
            <div className="ui-panel ui-tint-accent p-4 text-xs text-app-text-muted">
              <p className="font-black uppercase tracking-widest text-[10px] text-app-text mb-1">
                One physical drawer
              </p>
              <p>
                Expected cash includes cash tendered on linked registers in this till shift. Finalizing
                closes every open lane in the group.
              </p>
            </div>
          ) : null}
          <div className={`ui-panel p-5 ${isOff ? "ui-tint-danger" : "ui-tint-success"}`}>
            <h3 className="mb-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border pb-2">Cash drawer count</h3>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between text-app-text-muted font-medium"><span>Opening Float:</span><span className="font-mono">${centsToFixed2(openingCents)}</span></div>
              <div className="flex justify-between text-app-text-muted font-medium"><span>Cash Sales:</span><span className="font-mono text-app-success">+ ${centsToFixed2(cashSalesCents)}</span></div>
              <div className="flex justify-between text-app-text-muted font-medium"><span>Net adjustments:</span><span className="font-mono text-app-warning">${centsToFixed2(netAdjCents)}</span></div>
              <div className="flex justify-between pt-3 border-t border-app-border font-black text-app-text uppercase text-xs"><span>Expected Cash:</span><span className="font-mono">${centsToFixed2(expectedCents)}</span></div>
              <div className="flex justify-between pt-1 font-black text-app-accent text-lg"><span>Actual Counted:</span><span className="font-mono">${centsToFixed2(actualCents)}</span></div>
            </div>
            <div className="mt-4 rounded-2xl border border-app-border bg-app-surface/70 p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Edit count reason
                  <input
                    value={countEditReason}
                    onChange={(event) => setCountEditReason(event.target.value)}
                    className="ui-input mt-1 w-full p-3 text-xs normal-case tracking-normal"
                    placeholder="Required if you re-open the drawer count after reviewing discrepancy"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (!countEditReason.trim()) {
                      toast("Add a reason before editing the counted amount.", "error");
                      return;
                    }
                    setStep("count");
                  }}
                  className="ui-btn-secondary px-4 py-3 text-xs font-black uppercase tracking-widest"
                >
                  Edit Count
                </button>
              </div>
              {countEditReason.trim() ? (
                <p className="mt-2 text-[10px] font-bold text-app-text-muted">
                  This reason will be saved in the internal Z-report notes with the staff member closing the shift.
                </p>
              ) : null}
            </div>
            {isOff && (
              <div className="ui-panel ui-tint-danger mt-4 p-4">
                <div className="flex justify-between text-app-danger font-black text-xs uppercase tracking-widest">
                  <span>Discrepancy ({discrepancyCents < 0 ? "Short" : "Over"}):</span>
                  <span className="font-mono">${centsToFixed2(Math.abs(discrepancyCents))}</span>
                </div>
                {needsNote ? (
                  <p className="text-[10px] font-bold mt-2 text-app-danger/80 leading-relaxed">
                    Cash discrepancy blocker: closing notes are required because cash is over or short by more than $5.00. Explain the likely cause before you finalize the shift.
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
                  <thead className="bg-app-surface-2 border-b border-app-border text-app-text-muted"><tr><th className="px-3 py-2">Method</th><th className="px-3 py-2 text-center">Txs</th><th className="px-3 py-2 text-right">Total</th></tr></thead>
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
                      <p className="border-b border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
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

            <div className="space-y-4 md:col-span-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Manual Drawer Opens</h3>
              <div className="ui-panel p-3 space-y-4 max-h-[160px] overflow-y-auto">
                {recon.manual_drawer_opens?.map((event) => (
                  <div key={event.id} className="flex justify-between items-start gap-2 border-b border-app-border/30 pb-2 last:border-0 last:pb-0">
                    <span className="text-[10px] text-app-text uppercase font-bold leading-tight">
                      {event.reason}
                      <br />
                      <span className="text-app-text-muted font-normal text-[9px] normal-case">
                        {event.staff_name} · {new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </span>
                  </div>
                ))}
                {(recon.manual_drawer_opens?.length ?? 0) === 0 && <p className="text-[10px] text-center text-app-text-muted py-4">No manual drawer opens recorded</p>}
              </div>
            </div>
          </div>

          {recon.transactions.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Payments (shift)</h3>
              <div className="ui-panel max-h-48 overflow-auto border-app-border/40">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-app-surface-2 text-app-text-muted">
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
                        <td className="px-2 py-1.5 font-bold text-app-text">#{t.register_lane ?? 1}</td>
                        <td className="px-2 py-1.5 capitalize text-app-text">{t.payment_method}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold text-app-text">${centsToFixed2(parseMoneyToCents(t.amount))}</td>
                        <td className="px-2 py-1.5 truncate text-app-text-muted">{t.customer_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="space-y-3 pt-2">
            <label className="block text-[10px] font-black uppercase text-app-text-muted tracking-widest">Shift Notes (Internal)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} className="ui-input w-full p-4 text-xs min-h-[80px]" placeholder="Explain any discrepancy or shift events..." />
          </div>

          <div className="space-y-3">
            <label className="block text-[10px] font-black uppercase text-app-text-muted tracking-widest">Closing Comments (Public)</label>
            <textarea value={closingComments} onChange={e => setClosingComments(e.target.value)} className="ui-input w-full p-4 text-xs min-h-[60px]" placeholder="Add comments for the Z report..." />
          </div>

          <div className="sticky bottom-0 -mx-1 flex gap-3 border-t border-app-border bg-app-surface/95 px-1 py-4 backdrop-blur">
            <button type="button" onClick={() => void internalCancel()} disabled={loading} className="ui-btn-secondary flex-1 py-4 text-sm font-bold">Cancel</button>
            <button type="button" onClick={() => setShowFinalConfirm(true)} disabled={loading || (needsNote && notes.trim() === '')} className="ui-btn-primary flex-1 py-4 text-sm font-black shadow-lg shadow-app-accent/20">Finalize & Close Shift</button>
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
    </div>,
    root
  );
}
