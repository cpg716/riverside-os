import { getBaseUrl } from "../../lib/apiConfig";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { openProfessionalZReportPrint } from "./zReportPrint";
import type { ReportPrintAction } from "../../lib/reportPrint";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  clearLocallyRecoveredCheckout,
  getCheckoutQueueSummary,
  type CheckoutQueueSummary,
} from "../../lib/offlineQueue";
import {
  listGlobalRegisterRecoveryJobs,
  listCurrentRegisterRecoveryJobs,
  recoverExchangeSettlementJob,
  recoveryJobsOutsideCurrentTillGroup,
  replayCheckoutRecoveryJob,
  replayGlobalCheckoutRecoveryJob,
  reportStationCloseStatus,
  verifyGlobalRecoveryFollowUp,
  type ServerRecoveryJob,
} from "../../lib/serverRecovery";
import RosieInsightSummary from "../help/RosieInsightSummary";
import RosieIcon from "../common/RosieIcon";
import ManagerApprovalModal from "./ManagerApprovalModal";

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
  qbo_activity_date?: string;
  pending_business_dates?: string[];
  cash_count_is_single_day?: boolean;
  qbo_journal?: QboJournalProposal | null;
  qbo_journal_error?: string | null;
  opening_float: string;
  net_cash_adjustments?: string;
  total_rounding_adjustments?: string;
  expected_cash: string;
  physical_expected_cash?: string;
  tenders: TenderTotal[];
  tenders_by_lane?: TendersByLaneRow[];
  cash_adjustments?: CashAdjustmentLine[];
  manual_drawer_opens?: ManualDrawerOpenLine[];
  override_summary?: OverrideSummary[];
  transactions: TransactionLine[];
  inventory_activity?: InventoryActivityLine[];
  unresolved_helcim_attempts?: HelcimCloseReviewAttempt[];
}

interface CloseSessionResult {
  status: "closed" | "business_day_closed";
  business_date: string;
  next_business_date?: string | null;
  discrepancy?: string | null;
  till_group_closed: boolean;
}

interface QboJournalProposal {
  activity_date: string;
  business_timezone: string;
  generated_at: string;
  lines: QboJournalLine[];
  warnings: string[];
  totals: {
    debits: string;
    credits: string;
    balanced: boolean;
  };
}

interface QboJournalLine {
  qbo_account_id: string;
  qbo_account_name: string;
  debit: string;
  credit: string;
  memo: string;
}

interface InventoryActivityLine {
  id: string;
  created_at: string;
  tx_type: string;
  sku: string;
  product_name: string;
  category_name?: string | null;
  quantity_delta: number;
  unit_cost?: string | null;
  value_delta: string;
  reference_table?: string | null;
  reference_id?: string | null;
  notes?: string | null;
  staff_name?: string | null;
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

interface ZReportDaySummary {
  sales_count: number;
  sales_tax_total: string;
  cash_collected: string;
  deposits_collected: string;
  net_sales: string;
  pickup_count: number;
  special_order_sale_count: number;
  appointment_count: number;
  new_appointment_count: number;
  new_wedding_parties_count: number;
  new_invoice_count: number;
  pickups_today?: Array<{
    occurred_at: string;
    customer_name?: string | null;
    customer_code?: string | null;
    short_id?: string | null;
    sales_total?: string | null;
    transaction_total?: string | null;
    items?: Array<{ name: string; sku: string; quantity: number }> | null;
  }>;
}

interface TransactionLine {
  payment_transaction_id?: string;
  transaction_id?: string;
  created_at: string;
  payment_method: string;
  amount: string;
  payments?: {
    payment_method: string;
    amount: string;
    check_number?: string | null;
  }[] | null;
  check_number?: string | null;
  order_id?: string | null;
  transaction_display_id?: string | null;
  transaction_status?: string | null;
  transaction_total?: string | null;
  transaction_paid?: string | null;
  transaction_balance_due?: string | null;
  shipping_amount?: string | null;
  customer_name: string;
  items?: {
    name: string;
    sku: string;
    quantity: number;
    unit_price: string;
    original_unit_price?: string | null;
    overridden_unit_price?: string | null;
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

type CoinDenomKey =
  | "coin100"
  | "coin50"
  | "coin25"
  | "coin10"
  | "coin5"
  | "coin1";

type EntryTarget =
  | { mode: "count"; group: "bill"; key: DenomKey }
  | { mode: "count"; group: "coin"; key: CoinDenomKey }
  | { mode: "money"; key: "fullDrawerTotal" };

interface CheckReviewEntry {
  checkNumber: string;
  amount: string;
  confirmed: boolean;
}

type HelcimCloseReviewAction =
  | "reviewed"
  | "resolved_no_action"
  | "provider_charge_confirmed"
  | "duplicate_suspected"
  | "refund_required";

type RecoveryManagerMode =
  | "replay_current"
  | "replay_historical"
  | "settle_current_exchange"
  | "settle_historical_exchange"
  | "verify_current_follow_up"
  | "verify_historical_follow_up"
  | "force_close";

interface CloseRecoveryBlockDetails {
  recoveryJobKeys: string[];
  stationBlockers: string[];
}

interface RecoveryManagerApproval {
  managerStaffId: string;
  managerPin: string;
  reason: string;
}

const HELCIM_CLOSE_REVIEW_ACTIONS: { value: HelcimCloseReviewAction; label: string }[] = [
  { value: "reviewed", label: "Reviewed" },
  { value: "resolved_no_action", label: "No charge / no action" },
  { value: "provider_charge_confirmed", label: "Charge confirmed" },
  { value: "duplicate_suspected", label: "Duplicate suspected" },
  { value: "refund_required", label: "Refund needed" },
];

const DENOMS: { key: DenomKey; label: string; valueCents: number }[] = [
  { key: "c100", label: "$100", valueCents: 10000 },
  { key: "c50", label: "$50", valueCents: 5000 },
  { key: "c20", label: "$20", valueCents: 2000 },
  { key: "c10", label: "$10", valueCents: 1000 },
  { key: "c5", label: "$5", valueCents: 500 },
  { key: "c1", label: "$1", valueCents: 100 },
];

const COIN_DENOMS: { key: CoinDenomKey; label: string; valueCents: number }[] = [
  { key: "coin100", label: "$1", valueCents: 100 },
  { key: "coin50", label: "50c", valueCents: 50 },
  { key: "coin25", label: "25c", valueCents: 25 },
  { key: "coin10", label: "10c", valueCents: 10 },
  { key: "coin5", label: "5c", valueCents: 5 },
  { key: "coin1", label: "1c", valueCents: 1 },
];

const todayLocalDateInput = () => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const REGISTER_CLOSE_STEPS = [
  {
    id: "count",
    label: "Cash",
    hint: "Count drawer.",
  },
  {
    id: "checks",
    label: "Checks",
    hint: "Verify checks.",
  },
  {
    id: "report",
    label: "Z-Report",
    hint: "Close and print.",
  },
] as const;

function parseCountInput(value: string): number {
  const clean = value.trim();
  if (clean === "") return 0;
  const parsed = Number.parseInt(clean, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeCountInput(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits === "") return "0";
  return digits.replace(/^0+(?=\d)/, "");
}

function paymentLineId(line: TransactionLine): string {
  return line.payment_transaction_id ?? line.transaction_id ?? `${line.created_at}-${line.payment_method}-${line.amount}`;
}

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

function recoveryStepDescriptions(job: ServerRecoveryJob): string[] {
  if (!job.payload || typeof job.payload !== "object") return [];
  const steps = (job.payload as { recovery_steps?: unknown }).recovery_steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    if (!step || typeof step !== "object") return [];
    const value = step as {
      kind?: unknown;
      transaction_id?: unknown;
      transaction_line_ids?: unknown;
      alteration_id?: unknown;
    };
    const lineCount = Array.isArray(value.transaction_line_ids)
      ? value.transaction_line_ids.length
      : 0;
    if (
      value.kind === "ship_transaction" &&
      typeof value.transaction_id === "string"
    ) {
      return [
        `Ship Transaction Record ${value.transaction_id}${lineCount > 0 ? ` (${lineCount} line${lineCount === 1 ? "" : "s"})` : ""}`,
      ];
    }
    if (
      value.kind === "pickup_transaction" &&
      typeof value.transaction_id === "string"
    ) {
      return [
        `Record pickup for Transaction Record ${value.transaction_id}${lineCount > 0 ? ` (${lineCount} line${lineCount === 1 ? "" : "s"})` : ""}`,
      ];
    }
    if (
      value.kind === "alteration_pickup" &&
      typeof value.alteration_id === "string"
    ) {
      return [`Record alteration pickup ${value.alteration_id}`];
    }
    return [];
  });
}

function recoveryKindLabel(kind: ServerRecoveryJob["kind"]): string {
  switch (kind) {
    case "checkout_offline":
      return "Saved offline checkout";
    case "checkout_unconfirmed":
      return "Unconfirmed online checkout";
    case "pickup_after_payment":
      return "Paid order follow-up";
    case "receipt_print":
      return "Receipt print retry";
    case "exchange_settlement":
      return "Exchange settlement";
  }
}

function recoveryReasonLength(value: string): number {
  return Array.from(value.trim()).length;
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
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  useShellBackdropLayer(true);

  const jsonAuthHeaders = useCallback(() => {
    const h = new Headers(mergedPosStaffHeaders(backofficeHeaders));
    h.set("Content-Type", "application/json");
    return h;
  }, [backofficeHeaders]);

  const fetchBookedDaySummaryForZ = useCallback(async (businessDate?: string | null): Promise<ZReportDaySummary | null> => {
    const params = new URLSearchParams({ basis: "booked" });
    if (businessDate?.trim()) {
      params.set("preset", "custom");
      params.set("from", businessDate.trim());
      params.set("to", businessDate.trim());
    } else {
      params.set("preset", "today");
    }
    try {
      const res = await fetch(`${baseUrl}/api/insights/register-day-activity?${params}`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (!res.ok) return null;
      return (await res.json()) as ZReportDaySummary;
    } catch (error) {
      console.warn("Failed to load Z-report day summary counters", error);
      return null;
    }
  }, [backofficeHeaders, baseUrl]);

  const [step, setStep] = useState<"count" | "checks" | "report">("count");
  const [actualCash, setActualCash] = useState("");
  const [cashDepositDate, setCashDepositDate] = useState(todayLocalDateInput);
  const [cashDepositAmount, setCashDepositAmount] = useState("0.00");
  const [cashDepositEdited, setCashDepositEdited] = useState(false);
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
  const [coinCounts, setCoinCounts] = useState<Record<CoinDenomKey, string>>(
    () => ({
      coin100: "0",
      coin50: "0",
      coin25: "0",
      coin10: "0",
      coin5: "0",
      coin1: "0",
    }),
  );
  const [fullDrawerTotal, setFullDrawerTotal] = useState("");
  const [activeEntry, setActiveEntry] = useState<EntryTarget | null>(null);
  const [freshEntry, setFreshEntry] = useState(false);
  const [checkReview, setCheckReview] = useState<Record<string, CheckReviewEntry>>({});
  const [activeHelcimReviewId, setActiveHelcimReviewId] = useState<string | null>(null);
  const [helcimReviewAction, setHelcimReviewAction] = useState<HelcimCloseReviewAction>("reviewed");
  const [helcimReviewNote, setHelcimReviewNote] = useState("");
  const [helcimReviewSubmitting, setHelcimReviewSubmitting] = useState(false);
  const [showFinalConfirm, setShowFinalConfirm] = useState(false);
  const [offlineQueueSummary, setOfflineQueueSummary] = useState<CheckoutQueueSummary>({
    totalCount: 0,
    pendingCount: 0,
    blockedCount: 0,
  });
  const [serverRecoveryJobs, setServerRecoveryJobs] = useState<ServerRecoveryJob[]>([]);
  const [globalRecoveryJobs, setGlobalRecoveryJobs] = useState<ServerRecoveryJob[]>([]);
  const [globalRecoveryStatus, setGlobalRecoveryStatus] = useState<
    "loading" | "available" | "error"
  >("loading");
  const [globalRecoveryError, setGlobalRecoveryError] = useState<string | null>(null);
  const [recoveryManagerMode, setRecoveryManagerMode] = useState<RecoveryManagerMode | null>(null);
  const [recoveryManagerJobKeys, setRecoveryManagerJobKeys] = useState<string[]>([]);
  const [recoveryManagerReason, setRecoveryManagerReason] = useState("");
  const [exchangeProviderRefundNotice, setExchangeProviderRefundNotice] = useState<string | null>(null);
  const [closeRecoveryBlock, setCloseRecoveryBlock] = useState<CloseRecoveryBlockDetails | null>(null);

  const onReconcilingBegunRef = useRef(onReconcilingBegun);
  onReconcilingBegunRef.current = onReconcilingBegun;

  useEffect(() => {
    if (registerLane != null && registerLane !== 1) return;
    void (async () => {
      try {
        const [summary, jobs] = await Promise.all([
          getCheckoutQueueSummary(),
          listCurrentRegisterRecoveryJobs(),
        ]);
        setOfflineQueueSummary(summary);
        setServerRecoveryJobs(jobs);
        const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/begin-reconcile`, {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ active: true }),
        });
        if (res.ok) {
          onReconcilingBegunRef.current?.();
          await reportStationCloseStatus(summary);
        }
      } catch { /* optional */ }
    })();
  }, [sessionId, baseUrl, jsonAuthHeaders, registerLane]);

  const refreshReconciliation = useCallback(async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/reconciliation`, {
      headers: mergedPosStaffHeaders(backofficeHeaders),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as Reconciliation;
    setRecon(data);
    return data;
  }, [backofficeHeaders, baseUrl, sessionId]);

  useEffect(() => {
    if (registerLane != null && registerLane !== 1) return;
    let cancelled = false;
    setReconError(null);
    refreshReconciliation()
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
  }, [refreshReconciliation, registerLane]);

  const refreshGlobalRecoveryJobs = useCallback(async () => {
    try {
      const jobs = await listGlobalRegisterRecoveryJobs(backofficeHeaders());
      setGlobalRecoveryJobs(jobs);
      setGlobalRecoveryStatus("available");
      setGlobalRecoveryError(null);
      return jobs;
    } catch (error) {
      setGlobalRecoveryStatus("error");
      setGlobalRecoveryError(
        error instanceof Error
          ? error.message
          : "Prior till-group recovery could not be checked.",
      );
      throw error;
    }
  }, [backofficeHeaders]);

  const refreshOfflineQueueSummary = useCallback(async (acknowledge = true) => {
    const [summary, jobs] = await Promise.all([
      getCheckoutQueueSummary(),
      listCurrentRegisterRecoveryJobs(),
    ]);
    setOfflineQueueSummary(summary);
    setServerRecoveryJobs(jobs);
    if (acknowledge) await reportStationCloseStatus(summary);
    return { summary, jobs };
  }, []);

  useEffect(() => {
    void refreshOfflineQueueSummary();
    void refreshGlobalRecoveryJobs().catch(() => {});
    const handleQueueChanged = () => {
      void refreshOfflineQueueSummary();
      void refreshGlobalRecoveryJobs().catch(() => {});
    };
    window.addEventListener("queue_changed", handleQueueChanged);
    const recoveryRefresh = window.setInterval(() => {
      void refreshOfflineQueueSummary();
      void refreshGlobalRecoveryJobs().catch(() => {});
    }, 10_000);
    return () => {
      window.removeEventListener("queue_changed", handleQueueChanged);
      window.clearInterval(recoveryRefresh);
    };
  }, [refreshGlobalRecoveryJobs, refreshOfflineQueueSummary]);

  const billTotalCents = useMemo(() => {
    let t = 0;
    for (const d of DENOMS) {
      t += parseCountInput(denomCounts[d.key]) * d.valueCents;
    }
    return t;
  }, [denomCounts]);

  const coinTotalCents = useMemo(() => {
    let t = 0;
    for (const d of COIN_DENOMS) {
      t += parseCountInput(coinCounts[d.key]) * d.valueCents;
    }
    return t;
  }, [coinCounts]);

  const denominationTotalCents = billTotalCents + coinTotalCents;

  useEffect(() => {
    if (!recon || cashDepositEdited) return;
    const countedLessFloat = parseMoneyToCents(actualCash) - parseMoneyToCents(recon.opening_float);
    setCashDepositAmount(centsToFixed2(Math.max(0, countedLessFloat)));
  }, [actualCash, cashDepositEdited, recon]);

  const blockForOfflineQueue = useCallback(async () => {
    const { summary, jobs } = await refreshOfflineQueueSummary();
    if (summary.totalCount === 0 && jobs.length === 0) return false;
    const message =
      summary.blockedCount > 0
        ? `${summary.blockedCount} completed checkout${summary.blockedCount === 1 ? "" : "s"} need manager recovery before Z-close.`
        : jobs.length > 0
          ? `${jobs.length} server recovery item${jobs.length === 1 ? "" : "s"} must be resolved before Z-close.`
          : `${summary.pendingCount} completed checkout${summary.pendingCount === 1 ? "" : "s"} still need to sync before Z-close.`;
    toast(message, "error");
    return true;
  }, [refreshOfflineQueueSummary, toast]);

  const unresolvedHelcimAttempts = useMemo(
    () => recon?.unresolved_helcim_attempts ?? [],
    [recon?.unresolved_helcim_attempts],
  );
  const helcimReviewMessage = useMemo(() => {
    if (unresolvedHelcimAttempts.length === 0) return null;
    const approved = unresolvedHelcimAttempts.filter((attempt) => attempt.review_reason === "approved_not_recorded").length;
    const parts: string[] = [];
    if (approved > 0) parts.push(`${approved} card approval${approved === 1 ? "" : "s"} not recorded in ROS`);
    return `Helcim approval review: ${parts.join(", ")}. Repair or add a close note so accounting can follow up.`;
  }, [unresolvedHelcimAttempts]);

  const checkPayments = useMemo(
    () =>
      (recon?.transactions ?? []).filter(
        (line) => line.payment_method.trim().toLowerCase() === "check",
      ),
    [recon?.transactions],
  );

  useEffect(() => {
    setCheckReview((prev) => {
      const next: Record<string, CheckReviewEntry> = {};
      for (const line of checkPayments) {
        const id = paymentLineId(line);
        next[id] = prev[id] ?? {
          checkNumber: line.check_number ?? "",
          amount: centsToFixed2(parseMoneyToCents(line.amount)),
          confirmed: false,
        };
      }
      return next;
    });
  }, [checkPayments]);

  const checksReady = useMemo(
    () =>
      checkPayments.every((line) => {
        const review = checkReview[paymentLineId(line)];
        return (
          review?.confirmed === true &&
          review.checkNumber.trim() !== "" &&
          parseMoneyToCents(review.amount) === parseMoneyToCents(line.amount)
        );
      }),
    [checkPayments, checkReview],
  );

  const recordHelcimCloseReview = useCallback(async (attemptId: string) => {
    if (helcimReviewSubmitting) return;
    if (helcimReviewAction !== "reviewed" && !helcimReviewNote.trim()) {
      toast("Add a note for this card review outcome.", "error");
      return;
    }
    setHelcimReviewSubmitting(true);
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/helcim-close-review/${attemptId}`, {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          action: helcimReviewAction,
          note: helcimReviewNote.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Card review could not be recorded.");
      }
      setActiveHelcimReviewId(null);
      setHelcimReviewAction("reviewed");
      setHelcimReviewNote("");
      await refreshReconciliation();
      toast("Card review cleared for Z-close.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Card review could not be recorded.", "error");
    } finally {
      setHelcimReviewSubmitting(false);
    }
  }, [
    baseUrl,
    helcimReviewAction,
    helcimReviewNote,
    helcimReviewSubmitting,
    jsonAuthHeaders,
    refreshReconciliation,
    sessionId,
    toast,
  ]);

  const applyKeypadInput = (token: string) => {
    if (!activeEntry) return;
    const update = (current: string, money: boolean) => {
      if (token === "clear") return money ? "" : "0";
      if (token === "back") {
        const next = freshEntry ? "" : current.slice(0, -1);
        return next === "" ? (money ? "" : "0") : next;
      }
      if (token === "." && !money) return current;
      if (token === "." && current.includes(".")) return current;
      const base = freshEntry || (!money && current === "0") ? "" : current;
      return `${base}${token}`;
    };

    if (activeEntry.mode === "money") {
      setFullDrawerTotal((current) => update(current, true));
      setFreshEntry(false);
      return;
    }
    if (activeEntry.group === "bill") {
      setDenomCounts((prev) => ({
        ...prev,
        [activeEntry.key]: update(prev[activeEntry.key], false),
      }));
      setFreshEntry(false);
      return;
    }
    setCoinCounts((prev) => ({
      ...prev,
      [activeEntry.key]: update(prev[activeEntry.key], false),
    }));
    setFreshEntry(false);
  };

  const activeEntryLabel = useMemo(() => {
    if (!activeEntry) return "Tap a field";
    if (activeEntry.mode === "money") return "Drawer total";
    const source = activeEntry.group === "bill" ? DENOMS : COIN_DENOMS;
    return source.find((d) => d.key === activeEntry.key)?.label ?? "Count";
  }, [activeEntry]);

  const handleBlindCountSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fullDrawerCents =
      fullDrawerTotal.trim() === ""
        ? null
        : parseMoneyToCents(fullDrawerTotal);
    const totalCents =
      fullDrawerCents !== null && fullDrawerTotal.trim() !== ""
        ? fullDrawerCents
        : denominationTotalCents > 0
          ? denominationTotalCents
          : null;
    if (totalCents == null || totalCents < 0) return;
    void (async () => {
      if (await blockForOfflineQueue()) return;
      setActualCash(centsToFixed2(totalCents));
      setStep("checks");
    })();
  };

  const internalCancel = async () => {
    try {
      if (registerLane == null || registerLane === 1) {
        await fetch(`${baseUrl}/api/sessions/${sessionId}/begin-reconcile`, {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ active: false }),
        });
        await reportStationCloseStatus(offlineQueueSummary);
      }
    } catch { /* ignore */ }
    onCancel();
  };

  const { dialogRef, titleId } = useDialogAccessibility(true, {
    onEscape: () => {
      void internalCancel();
    },
    closeOnEscape: !loading && !showFinalConfirm && recoveryManagerMode == null,
  });

  const buildClosingNotesForReport = useCallback(() => {
    const countEditNote = countEditReason.trim()
      ? `Count edit note: ${countEditReason.trim()}`
      : "";
    const checkReviewNote = checkPayments.length > 0
      ? `Check review: ${checkPayments.map((line) => {
          const review = checkReview[paymentLineId(line)];
          return `#${review?.checkNumber.trim() || "missing"} $${centsToFixed2(parseMoneyToCents(line.amount))}`;
        }).join(", ")}`
      : "";
    return [notes.trim(), countEditNote, checkReviewNote].filter(Boolean).join("\n");
  }, [checkPayments, checkReview, countEditReason, notes]);

  const openCurrentZReportPrint = useCallback(async (
    currentRecon: Reconciliation | null = recon,
    action: ReportPrintAction = "print",
  ) => {
    if (!currentRecon) return false;
    const currentExpectedCents = parseMoneyToCents(currentRecon.expected_cash);
    const currentActualCents = parseMoneyToCents(actualCash);
    const cashCountIsSingleDay = currentRecon.cash_count_is_single_day ?? true;
    const currentOpeningCents = parseMoneyToCents(currentRecon.opening_float);
    const currentNetAdjCents = parseMoneyToCents(currentRecon.net_cash_adjustments ?? "0");
    const currentRoundingCents = parseMoneyToCents(currentRecon.total_rounding_adjustments ?? "0");
    const currentCashSalesCents = currentExpectedCents - currentOpeningCents - currentNetAdjCents - currentRoundingCents;
    const closingNotesForReport = buildClosingNotesForReport();
    const daySummary = await fetchBookedDaySummaryForZ(
      currentRecon.qbo_activity_date ?? currentRecon.qbo_journal?.activity_date ?? null,
    );
    const opened = await openProfessionalZReportPrint({
      title: "Z-Report",
      sessionId: currentRecon.session_id,
      action,
      registerOrdinal,
      cashierLabel: cashierName,
      openedAt: null,
      openingCents: currentOpeningCents,
      cashSalesCents: currentCashSalesCents,
      netAdjustmentsCents: currentNetAdjCents,
      roundingAdjustmentsCents: currentRoundingCents,
      expectedCents: currentExpectedCents,
      actualCents: cashCountIsSingleDay ? currentActualCents : null,
      discrepancyCents: cashCountIsSingleDay ? currentActualCents - currentExpectedCents : null,
      businessDate: currentRecon.qbo_activity_date ?? null,
      cashDepositDate: cashCountIsSingleDay ? cashDepositDate.trim() || null : null,
      cashDepositAmountCents: cashCountIsSingleDay ? parseMoneyToCents(cashDepositAmount) : undefined,
      closingNotes: closingNotesForReport || null,
      closingComments: closingComments.trim() || null,
      tenders: currentRecon.tenders,
      overrideSummary: currentRecon.override_summary ?? [],
      tendersByLane: currentRecon.tenders_by_lane,
      manualDrawerOpens: currentRecon.manual_drawer_opens ?? [],
      newOrdersCount: daySummary?.special_order_sale_count,
      ordersPickedUpCount: daySummary?.pickup_count,
      todayAppointmentsCount: daySummary?.appointment_count ?? 0,
      newAppointmentsCount: daySummary?.new_appointment_count ?? 0,
      newWeddingPartiesCount: daySummary?.new_wedding_parties_count ?? 0,
      newInvoicesCount: daySummary?.new_invoice_count ?? 0,
      salesCount: daySummary?.sales_count,
      salesTaxTotal: daySummary?.sales_tax_total,
      cashCollected: daySummary?.cash_collected,
      depositsCollected: daySummary?.deposits_collected,
      netSales: daySummary?.net_sales,
      pickupsToday: (daySummary?.pickups_today ?? []).map((pickup) => ({
        occurred_at: pickup.occurred_at,
        customer_name: pickup.customer_name,
        customer_code: pickup.customer_code,
        short_id: pickup.short_id,
        sales_total: pickup.sales_total,
        transaction_total: pickup.transaction_total,
        items: pickup.items?.map((item) => ({
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
        })),
      })),
      qboActivityDate: currentRecon.qbo_activity_date ?? currentRecon.qbo_journal?.activity_date ?? null,
      qboJournal: currentRecon.qbo_journal ?? null,
      qboJournalError: currentRecon.qbo_journal_error ?? null,
      inventoryActivity: currentRecon.inventory_activity ?? [],
      transactions: currentRecon.transactions.map((t) => ({
        created_at: t.created_at,
        payment_method: t.payment_method,
        amount: t.amount,
        payments: t.payments ?? null,
        customer_name: t.customer_name,
        transaction_display_id: t.transaction_display_id,
        transaction_status: t.transaction_status,
        transaction_total: t.transaction_total,
        transaction_paid: t.transaction_paid,
        transaction_balance_due: t.transaction_balance_due,
        shipping_amount: t.shipping_amount,
        items: t.items ?? [],
        register_lane: t.register_lane ?? 1,
      })),
    });
    if (opened) {
      toast("Z-report opened for review.", "success");
    }
    return opened;
  }, [actualCash, buildClosingNotesForReport, cashDepositAmount, cashDepositDate, cashierName, closingComments, fetchBookedDaySummaryForZ, recon, registerOrdinal, toast]);

  const handleFinalClose = async (
    forceApproval?: RecoveryManagerApproval,
  ): Promise<boolean> => {
    setShowFinalConfirm(false);
    if (!forceApproval && await blockForOfflineQueue()) return false;
    if (!cashDepositDate.trim()) {
      toast("Enter the Daily Cash Deposit date before closing.", "error");
      return false;
    }
    if (checkPayments.length > 0 && !checksReady) {
      toast("Finish the check review before closing.", "error");
      return false;
    }
    if (recon) {
      const expected = parseMoneyToCents(recon.physical_expected_cash ?? recon.expected_cash);
      const discrepancy = parseMoneyToCents(actualCash) - expected;
      if (Math.abs(discrepancy) > MANDATORY_NOTE_OVER_USD * 100 && !notes.trim()) {
        toast("Add a cash discrepancy note before closing.", "error");
        return false;
      }
    }
    if (forceApproval && recoveryReasonLength(forceApproval.reason) < 12) {
      toast("Enter at least 12 characters explaining the forced recovery close.", "error");
      return false;
    }
    setLoading(true);
    const closingNotesForReport = buildClosingNotesForReport();
    const cashDepositCentsForClose = parseMoneyToCents(cashDepositAmount);
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/close`, {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          actual_cash: centsToFixed2(parseMoneyToCents(actualCash)),
          cash_deposit_date: cashDepositDate.trim(),
          cash_deposit_amount: centsToFixed2(cashDepositCentsForClose),
          closing_notes: closingNotesForReport || null,
          closing_comments: closingComments.trim() || null,
          force_unresolved_recovery: Boolean(forceApproval),
          manager_staff_id: forceApproval?.managerStaffId ?? null,
          manager_pin: forceApproval?.managerPin ?? null,
          manager_reason: forceApproval?.reason.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          recovery_job_keys?: string[];
          station_blockers?: string[];
        };
        if (body.error === "checkout_recovery_blocks_close") {
          setCloseRecoveryBlock({
            recoveryJobKeys: body.recovery_job_keys ?? [],
            stationBlockers: body.station_blockers ?? [],
          });
          await refreshOfflineQueueSummary();
        }
        const errorMessage = body.message ?? body.error ?? "Failed to close session";
        throw new Error(mapCloseSessionError(errorMessage));
      }
      const result = (await res.json()) as CloseSessionResult;
      const opened = await openCurrentZReportPrint(recon);
      if (!opened) {
        toast("Z-report could not open. Check the Reports printer setup.", "error");
      }
      if (!result.till_group_closed) {
        const nextRecon = await refreshReconciliation();
        setRecon(nextRecon);
        setStep("count");
        setCheckReview({});
        setLoading(false);
        toast(
          `${result.business_date} is closed separately. ${result.next_business_date ?? "The next business day"} must be closed next.`,
          "success",
        );
        return true;
      }
      onCloseComplete();
      return true;
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to close session", "error");
      setLoading(false);
      return false;
    }
  };

  const replayableRecoveryJobs = serverRecoveryJobs.filter(
    (job) => job.kind === "checkout_offline" || job.kind === "checkout_unconfirmed",
  );
  const currentPickupFollowUpJobs = serverRecoveryJobs.filter(
    (job) => job.kind === "pickup_after_payment",
  );
  const currentExchangeSettlementJobs = serverRecoveryJobs.filter(
    (job) => job.kind === "exchange_settlement",
  );
  const historicalRecoveryJobs = recoveryJobsOutsideCurrentTillGroup(
    serverRecoveryJobs,
    globalRecoveryJobs,
  );
  const historicalReplayableRecoveryJobs = historicalRecoveryJobs.filter(
    (job) => job.kind === "checkout_offline" || job.kind === "checkout_unconfirmed",
  );
  const historicalPickupFollowUpJobs = historicalRecoveryJobs.filter(
    (job) => job.kind === "pickup_after_payment",
  );
  const historicalExchangeSettlementJobs = historicalRecoveryJobs.filter(
    (job) => job.kind === "exchange_settlement",
  );

  const openRecoveryManagerApproval = (
    mode: RecoveryManagerMode,
    jobs: ServerRecoveryJob[] = [],
  ) => {
    setRecoveryManagerJobKeys(jobs.map((job) => job.client_job_key));
    setRecoveryManagerMode(mode);
  };

  const handleRecoveryManagerApproval = async (
    pin: string,
    managerId: string,
  ): Promise<boolean> => {
    const reason = recoveryManagerReason.trim();
    if (recoveryReasonLength(reason) < 12) {
      throw new Error("Enter at least 12 characters explaining this recovery action.");
    }
    if (recoveryManagerMode === "force_close") {
      return handleFinalClose({
        managerStaffId: managerId,
        managerPin: pin,
        reason,
      });
    }
    const approval = {
      managerStaffId: managerId,
      managerPin: pin,
      reason,
    };
    if (
      recoveryManagerMode === "settle_current_exchange" ||
      recoveryManagerMode === "settle_historical_exchange"
    ) {
      const jobs =
        recoveryManagerMode === "settle_current_exchange"
          ? currentExchangeSettlementJobs
          : historicalExchangeSettlementJobs;
      const selectedKeys = new Set(recoveryManagerJobKeys);
      const selectedJobs = jobs.filter((job) => selectedKeys.has(job.client_job_key));
      if (
        recoveryManagerJobKeys.length === 0 ||
        selectedJobs.length !== recoveryManagerJobKeys.length
      ) {
        throw new Error(
          "The exchange recovery list changed. Close this approval and review the current records again.",
        );
      }

      let settled = 0;
      let deferredCardRefundCents = 0;
      let settlementFailure: unknown = null;
      for (const job of selectedJobs) {
        try {
          const result = await recoverExchangeSettlementJob(
            job.client_job_key,
            sessionId,
            approval,
          );
          deferredCardRefundCents += parseMoneyToCents(
            result.deferredCardRefundDueAmount,
          );
          settled += 1;
        } catch (error) {
          settlementFailure = error;
          break;
        }
      }
      await Promise.all([
        refreshOfflineQueueSummary(),
        refreshGlobalRecoveryJobs().catch(() => []),
      ]);
      if (deferredCardRefundCents > 0) {
        setExchangeProviderRefundNotice(
          `$${centsToFixed2(deferredCardRefundCents)} of linked card refund remains due. Open each original Transaction Record and complete its card refund workflow before Z-close.`,
        );
      }
      if (settled > 0) {
        try {
          await refreshReconciliation();
          setReconError(null);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          setReconError(message);
          throw new Error(
            `${settled} exchange settlement${settled === 1 ? " was" : "s were"} completed and audited, but Z-close totals could not refresh: ${message}. Refresh the close screen before continuing.`,
          );
        }
      }
      if (settlementFailure) {
        const message =
          settlementFailure instanceof Error
            ? settlementFailure.message
            : "Exchange settlement recovery failed.";
        throw new Error(
          settled > 0
            ? `${settled} exchange settlement${settled === 1 ? " was" : "s were"} completed before the next record failed: ${message}`
            : message,
        );
      }
      setCloseRecoveryBlock(null);
      toast(
        `${settled} exchange settlement${settled === 1 ? "" : "s"} completed from the saved Main Hub record and audited to this Register session.`,
        "success",
      );
      if (deferredCardRefundCents > 0) {
        toast(
          `$${centsToFixed2(deferredCardRefundCents)} of linked card refund remains due in the original Transaction Record.`,
          "info",
        );
      }
      return true;
    }
    if (
      recoveryManagerMode === "verify_current_follow_up" ||
      recoveryManagerMode === "verify_historical_follow_up"
    ) {
      const jobs =
        recoveryManagerMode === "verify_current_follow_up"
          ? currentPickupFollowUpJobs
          : historicalPickupFollowUpJobs;
      const selectedKeys = new Set(recoveryManagerJobKeys);
      const selectedJobs = jobs.filter((job) => selectedKeys.has(job.client_job_key));
      if (
        recoveryManagerJobKeys.length === 0 ||
        selectedJobs.length !== recoveryManagerJobKeys.length
      ) {
        throw new Error(
          "The paid follow-up list changed. Close this approval and review the current records again.",
        );
      }
      let verified = 0;
      try {
        for (const job of selectedJobs) {
          await verifyGlobalRecoveryFollowUp(
            job.client_job_key,
            approval,
            backofficeHeaders(),
          );
          await clearLocallyRecoveredCheckout(job.client_job_key);
          verified += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Verification failed.";
        throw new Error(
          verified > 0
            ? `${verified} follow-up record${verified === 1 ? " was" : "s were"} verified before the next record failed: ${message}`
            : message,
        );
      } finally {
        await Promise.all([
          refreshOfflineQueueSummary(),
          refreshGlobalRecoveryJobs().catch(() => []),
        ]);
      }
      setCloseRecoveryBlock(null);
      toast(
        `${verified} paid follow-up record${verified === 1 ? "" : "s"} verified against completed Orders/Alterations work and audited.`,
        "success",
      );
      return true;
    }

    const isHistoricalReplay = recoveryManagerMode === "replay_historical";
    const jobs = isHistoricalReplay
      ? historicalReplayableRecoveryJobs
      : recoveryManagerMode === "replay_current"
        ? replayableRecoveryJobs
        : [];
    const selectedKeys = new Set(recoveryManagerJobKeys);
    const selectedJobs = jobs.filter((job) => selectedKeys.has(job.client_job_key));
    if (
      recoveryManagerJobKeys.length === 0 ||
      selectedJobs.length !== recoveryManagerJobKeys.length
    ) {
      throw new Error(
        "The checkout recovery list changed. Close this approval and review the current records again.",
      );
    }

    let recovered = 0;
    let postClose = 0;
    try {
      for (const job of selectedJobs) {
        const result = isHistoricalReplay
          ? await replayGlobalCheckoutRecoveryJob(
              job.client_job_key,
              approval,
              backofficeHeaders(),
            )
          : await replayCheckoutRecoveryJob(job.client_job_key, approval);
        await clearLocallyRecoveredCheckout(job.client_job_key);
        recovered += 1;
        if (result.postClose) postClose += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Checkout recovery failed.";
      throw new Error(
        recovered > 0
          ? `${recovered} checkout${recovered === 1 ? " was" : "s were"} recovered before the next record failed: ${message}`
          : message,
      );
    } finally {
      await Promise.all([
        refreshOfflineQueueSummary(),
        refreshGlobalRecoveryJobs().catch(() => []),
      ]);
    }
    setCloseRecoveryBlock(null);
    toast(
      `${recovered} checkout${recovered === 1 ? "" : "s"} recovered and audited${postClose > 0 ? `; ${postClose} recorded as post-close supplements` : ""}.`,
      "success",
    );
    return true;
  };

  const renderRecoveryManagerModal = () => {
    const isFollowUpVerification =
      recoveryManagerMode === "verify_current_follow_up" ||
      recoveryManagerMode === "verify_historical_follow_up";
    const isExchangeSettlement =
      recoveryManagerMode === "settle_current_exchange" ||
      recoveryManagerMode === "settle_historical_exchange";
    const title =
      recoveryManagerMode === "force_close"
        ? "Force Z-Close"
        : isExchangeSettlement
          ? "Complete Exchange Settlement"
          : isFollowUpVerification
            ? "Verify Completed Follow-up"
            : "Recover Checkout Sales";
    const message =
      recoveryManagerMode === "force_close"
        ? "Authorize an audited Z-close while preserving every unresolved recovery record for follow-up. This does not dismiss, alter, or hide the outstanding work."
        : isExchangeSettlement
          ? "Authorize completion from the locked Main Hub exchange record. Riverside verifies the original exchange-credit tender against its origin Register session and records any new relief or refund movement in this current Register session. No financial amount comes from this approval screen."
          : isFollowUpVerification
            ? "Confirm the named Orders/Alterations work was already completed. Riverside checks recorded database evidence before resolving the recovery record; this approval does not perform or assume the work."
            : "Authorize exact replay of the saved checkout identity and payment snapshot. Duplicate or changed payloads are rejected, and prior-group results remain tied to the original Register session.";
    return (
      <ManagerApprovalModal
        isOpen={recoveryManagerMode != null}
        title={title}
        message={message}
        onApprove={handleRecoveryManagerApproval}
        onClose={() => {
          setRecoveryManagerMode(null);
          setRecoveryManagerJobKeys([]);
        }}
      />
    );
  };

  const renderWorkflowSummary = (currentStep: "count" | "checks" | "report") => {
    const currentIndex = REGISTER_CLOSE_STEPS.findIndex(
      (stepItem) => stepItem.id === currentStep,
    );
    const nextStep =
      currentIndex < REGISTER_CLOSE_STEPS.length - 1
        ? REGISTER_CLOSE_STEPS[currentIndex + 1]
        : null;

    return (
      <div className="rounded-2xl border border-app-border bg-app-surface/70 p-3">
        <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Close steps</p>
        <div className="grid gap-2">
          {REGISTER_CLOSE_STEPS.map((stepItem, index) => {
            const isCurrent = stepItem.id === currentStep;
            const isComplete = index < currentIndex;
            return (
              <div
                key={stepItem.id}
                className={`rounded-xl border px-3 py-2 ${
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
                <p className="mt-0.5 text-[11px] font-black uppercase tracking-wide text-current">
                  {stepItem.label}
                </p>
                <p className="mt-0.5 text-[10px] font-semibold opacity-80">
                  {stepItem.hint}
                </p>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] font-bold text-app-text-muted">
          {nextStep ? `Next: ${nextStep.label}` : "Next: print Z-Report"}
        </p>
      </div>
    );
  };

  const renderOfflineQueueBlocker = () => {
    const hasRecoveryBlocker =
      offlineQueueSummary.totalCount > 0 ||
      serverRecoveryJobs.length > 0 ||
      (closeRecoveryBlock?.stationBlockers.length ?? 0) > 0;
    if (!hasRecoveryBlocker) return null;
    const nonReplayableJobs = serverRecoveryJobs.filter(
      (job) => job.kind !== "checkout_offline" && job.kind !== "checkout_unconfirmed",
    );
    return (
      <div className="ui-panel ui-tint-danger p-3 text-xs text-app-text-muted">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
            Current till-group recovery
          </p>
          <span className="rounded-full border border-app-danger/25 bg-app-danger/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-danger">
            Manager
          </span>
        </div>
        <p className="mt-1 font-semibold">
          {offlineQueueSummary.blockedCount > 0 ? `${offlineQueueSummary.blockedCount} need recovery.` : ""}
          {offlineQueueSummary.pendingCount > 0 ? ` ${offlineQueueSummary.pendingCount} still syncing.` : ""}
          {serverRecoveryJobs.length > 0 ? ` ${serverRecoveryJobs.length} durable Main Hub recovery item${serverRecoveryJobs.length === 1 ? "" : "s"} remain.` : ""}
          {" "}Resolve before close when possible. An audited Manager force-close preserves unresolved work for later recovery; it does not dismiss it.
        </p>
        {closeRecoveryBlock?.stationBlockers.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 font-semibold text-app-danger">
            {closeRecoveryBlock.stationBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        ) : null}
        {nonReplayableJobs.length > 0 ? (
          <p className="mt-2 rounded-xl border border-app-danger/20 bg-app-surface/70 p-2 font-semibold">
            {nonReplayableJobs.some((job) => job.kind === "exchange_settlement")
              ? "An exchange replacement is saved, but its return settlement still needs completion. "
              : ""}
            {nonReplayableJobs.some((job) => job.kind === "pickup_after_payment")
              ? "A paid order follow-up still needs completion in Orders/Alterations, then audited verification here. "
              : ""}
            {nonReplayableJobs.some((job) => job.kind === "receipt_print")
              ? "A receipt print retry remains queued. "
              : ""}
            These records remain fully visible after a forced Z-close.
          </p>
        ) : null}
        {currentPickupFollowUpJobs.map((job) => {
          const steps = recoveryStepDescriptions(job);
          return (
            <div
              key={job.client_job_key}
              className="mt-2 rounded-xl border border-app-warning/25 bg-app-warning/10 p-2"
            >
              <p className="font-black text-app-text">
                {job.label?.trim() || recoveryKindLabel(job.kind)} · {job.status}
              </p>
              <p className="mt-1 font-semibold">
                Complete the named work in Orders or Alterations before selecting verification.
              </p>
              {steps.length > 0 ? (
                <ul className="mt-1 list-disc space-y-1 pl-5 font-mono text-[10px]">
                  {steps.map((description) => (
                    <li key={description}>{description}</li>
                  ))}
                </ul>
              ) : null}
              {job.last_error?.trim() ? (
                <p className="mt-1 font-semibold text-app-danger">
                  Last recorded issue: {job.last_error}
                </p>
              ) : null}
            </div>
          );
        })}
        <label className="mt-3 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Manager recovery reason
          <textarea
            value={recoveryManagerReason}
            onChange={(event) => setRecoveryManagerReason(event.target.value)}
            maxLength={500}
            placeholder="Explain the recovery or why Z-close must continue (minimum 12 characters)."
            className="ui-input mt-2 min-h-20 w-full p-3 text-xs normal-case tracking-normal"
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          {replayableRecoveryJobs.length > 0 ? (
            <button
              type="button"
              disabled={loading || recoveryReasonLength(recoveryManagerReason) < 12}
              onClick={() =>
                openRecoveryManagerApproval("replay_current", replayableRecoveryJobs)
              }
              className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              Manager Recover {replayableRecoveryJobs.length} Sale{replayableRecoveryJobs.length === 1 ? "" : "s"}
            </button>
          ) : null}
          {currentExchangeSettlementJobs.length > 0 ? (
            <button
              type="button"
              disabled={loading || recoveryReasonLength(recoveryManagerReason) < 12}
              onClick={() =>
                openRecoveryManagerApproval(
                  "settle_current_exchange",
                  currentExchangeSettlementJobs,
                )
              }
              className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              Complete {currentExchangeSettlementJobs.length} Exchange Settlement{currentExchangeSettlementJobs.length === 1 ? "" : "s"}
            </button>
          ) : null}
          {currentPickupFollowUpJobs.length > 0 ? (
            <button
              type="button"
              disabled={loading || recoveryReasonLength(recoveryManagerReason) < 12}
              onClick={() =>
                openRecoveryManagerApproval(
                  "verify_current_follow_up",
                  currentPickupFollowUpJobs,
                )
              }
              className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              Verify {currentPickupFollowUpJobs.length} Completed Follow-up{currentPickupFollowUpJobs.length === 1 ? "" : "s"}
            </button>
          ) : null}
          {step === "report" ? (
            <button
              type="button"
              disabled={loading || recoveryReasonLength(recoveryManagerReason) < 12}
              onClick={() => openRecoveryManagerApproval("force_close")}
              className="ui-btn-secondary border-app-danger/30 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-danger disabled:opacity-50"
            >
              Manager Force Z-Close
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderHistoricalRecovery = () => {
    const hasCurrentRecoveryPanel =
      offlineQueueSummary.totalCount > 0 ||
      serverRecoveryJobs.length > 0 ||
      (closeRecoveryBlock?.stationBlockers.length ?? 0) > 0;
    const canAct =
      globalRecoveryStatus === "available" &&
      recoveryReasonLength(recoveryManagerReason) >= 12 &&
      !loading;
    return (
      <div className="ui-panel ui-tint-info p-3 text-xs text-app-text-muted">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-accent">
              Prior or other till-group recovery
            </p>
            <p className="mt-1 font-semibold">
              Informational for this close. These records are outside the current till group and do
              not block its Z-close.
            </p>
          </div>
          {globalRecoveryStatus === "error" ? (
            <button
              type="button"
              onClick={() => void refreshGlobalRecoveryJobs().catch(() => {})}
              className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
            >
              Retry Check
            </button>
          ) : null}
        </div>

        {globalRecoveryStatus === "loading" ? (
          <p className="mt-2 rounded-xl border border-app-border bg-app-surface/70 p-2 font-semibold">
            Checking the Main Hub for recovery records outside this till group…
          </p>
        ) : null}
        {globalRecoveryStatus === "error" ? (
          <p className="mt-2 rounded-xl border border-app-danger/25 bg-app-danger/10 p-2 font-semibold text-app-danger">
            Global recovery list unavailable: {globalRecoveryError ?? "Unknown error"} This is not
            confirmation that no prior recovery exists.
            {globalRecoveryJobs.length > 0
              ? " The last visible records below may be stale until Retry Check succeeds."
              : ""}
          </p>
        ) : null}
        {exchangeProviderRefundNotice ? (
          <p className="mt-2 rounded-xl border border-app-warning/25 bg-app-warning/10 p-2 font-semibold text-app-warning">
            Exchange settlement completed, but {exchangeProviderRefundNotice}
          </p>
        ) : null}
        {globalRecoveryStatus === "available" && historicalRecoveryJobs.length === 0 ? (
          <p className="mt-2 rounded-xl border border-app-success/25 bg-app-success/10 p-2 font-semibold text-app-success">
            Main Hub reports no checkout, exchange settlement, receipt retry, or paid follow-up
            recovery outside this till group.
          </p>
        ) : null}

        {historicalRecoveryJobs.length > 0 ? (
          <div className="mt-3 space-y-2">
            {historicalRecoveryJobs.map((job) => {
              const steps = recoveryStepDescriptions(job);
              return (
                <div
                  key={job.client_job_key}
                  className="rounded-xl border border-app-border bg-app-surface/80 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-app-text">
                      {job.label?.trim() || recoveryKindLabel(job.kind)}
                    </p>
                    <span className="rounded-full border border-app-warning/25 bg-app-warning/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-warning">
                      {job.status}
                    </span>
                  </div>
                  <p className="mt-1 break-all font-mono text-[10px]">
                    Recovery key: {job.client_job_key}
                    {job.register_session_id
                      ? ` · Register session: ${job.register_session_id}`
                      : " · Register session unavailable"}
                  </p>
                  {job.kind === "pickup_after_payment" ? (
                    <p className="mt-2 font-semibold">
                      Complete every named step in Orders or Alterations first. Manager verification
                      checks recorded database evidence; it does not perform or assume the work.
                    </p>
                  ) : job.kind === "exchange_settlement" ? (
                    <p className="mt-2 font-semibold">
                      The replacement Transaction Record is saved, but the original return and
                      exchange settlement are still incomplete. Manager completion below uses the
                      locked server record, verifies the original tender, and posts any new refund
                      movement to this current Register session. Do not record another replacement sale.
                    </p>
                  ) : job.kind === "receipt_print" ? (
                    <p className="mt-2 font-semibold">
                      The financial Transaction Record is saved. Retry or dismiss only the receipt
                      print job from Print Recovery; do not record another sale.
                    </p>
                  ) : (
                    <p className="mt-2 font-semibold">
                      Manager recovery replays the exact saved checkout and records any post-close
                      result against its original Register session.
                    </p>
                  )}
                  {steps.length > 0 ? (
                    <ul className="mt-1 list-disc space-y-1 pl-5 font-mono text-[10px]">
                      {steps.map((description) => (
                        <li key={description}>{description}</li>
                      ))}
                    </ul>
                  ) : null}
                  {job.last_error?.trim() ? (
                    <p className="mt-2 font-semibold text-app-danger">
                      Last recorded issue: {job.last_error}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {historicalRecoveryJobs.length > 0 && !hasCurrentRecoveryPanel ? (
          <label className="mt-3 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Manager recovery reason
            <textarea
              value={recoveryManagerReason}
              onChange={(event) => setRecoveryManagerReason(event.target.value)}
              maxLength={500}
              placeholder="Explain the prior sale recovery (minimum 12 characters)."
              className="ui-input mt-2 min-h-20 w-full p-3 text-xs normal-case tracking-normal"
            />
          </label>
        ) : null}
        {historicalRecoveryJobs.length > 0 && hasCurrentRecoveryPanel ? (
          <p className="mt-3 font-semibold">
            Use the Manager recovery reason in the current till-group section above for either action.
          </p>
        ) : null}
        {historicalRecoveryJobs.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {historicalReplayableRecoveryJobs.length > 0 ? (
              <button
                type="button"
                disabled={!canAct}
                onClick={() =>
                  openRecoveryManagerApproval(
                    "replay_historical",
                    historicalReplayableRecoveryJobs,
                  )
                }
                className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
              >
                Recover {historicalReplayableRecoveryJobs.length} Prior Sale{historicalReplayableRecoveryJobs.length === 1 ? "" : "s"}
              </button>
            ) : null}
            {historicalExchangeSettlementJobs.length > 0 ? (
              <button
                type="button"
                disabled={!canAct}
                onClick={() =>
                  openRecoveryManagerApproval(
                    "settle_historical_exchange",
                    historicalExchangeSettlementJobs,
                  )
                }
                className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
              >
                Complete {historicalExchangeSettlementJobs.length} Prior Exchange Settlement{historicalExchangeSettlementJobs.length === 1 ? "" : "s"}
              </button>
            ) : null}
            {historicalPickupFollowUpJobs.length > 0 ? (
              <button
                type="button"
                disabled={!canAct}
                onClick={() =>
                  openRecoveryManagerApproval(
                    "verify_historical_follow_up",
                    historicalPickupFollowUpJobs,
                  )
                }
                className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
              >
                Verify {historicalPickupFollowUpJobs.length} Completed Follow-up{historicalPickupFollowUpJobs.length === 1 ? "" : "s"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderHelcimReviewBlocker = () => {
    if (!helcimReviewMessage) return null;
    return (
      <div className="ui-panel ui-tint-warning p-3 text-xs text-app-text-muted">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-warning">
            Card approval review
          </p>
          <span className="rounded-full border border-app-warning/25 bg-app-warning/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-warning">Close review</span>
        </div>
        <p className="mt-1 font-semibold">
          {unresolvedHelcimAttempts.length} approved Helcim card payment{unresolvedHelcimAttempts.length === 1 ? "" : "s"} need repair or a close note. Z-close can continue.
        </p>
        <div className="mt-2 space-y-2">
          {unresolvedHelcimAttempts.slice(0, 4).map((attempt) => (
            <div key={attempt.id} className="rounded-2xl border border-app-border bg-app-surface/80 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-black text-app-text">
                  Reg #{attempt.register_lane} · ${centsToFixed2(Math.abs(attempt.amount_cents))} · Approved not attached
                </p>
                <button
                  type="button"
                  onClick={() => setActiveHelcimReviewId((current) => current === attempt.id ? null : attempt.id)}
                  className="rounded-full border border-app-border bg-app-surface px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text"
                >
                  Review
                </button>
              </div>
              {activeHelcimReviewId === attempt.id ? (
                <div className="mt-3 grid gap-2">
                  <select
                    value={helcimReviewAction}
                    onChange={(event) => setHelcimReviewAction(event.target.value as HelcimCloseReviewAction)}
                    className="ui-input w-full px-3 py-2 text-xs font-bold"
                  >
                    {HELCIM_CLOSE_REVIEW_ACTIONS.map((action) => (
                      <option key={action.value} value={action.value}>{action.label}</option>
                    ))}
                  </select>
                  <textarea
                    value={helcimReviewNote}
                    onChange={(event) => setHelcimReviewNote(event.target.value)}
                    placeholder={helcimReviewAction === "reviewed" ? "Optional note" : "Required note"}
                    className="ui-input min-h-16 w-full p-3 text-xs"
                  />
                  <button
                    type="button"
                    disabled={helcimReviewSubmitting || (helcimReviewAction !== "reviewed" && !helcimReviewNote.trim())}
                    onClick={() => void recordHelcimCloseReview(attempt.id)}
                    className="ui-btn-primary py-2 text-xs font-black uppercase tracking-widest disabled:opacity-50"
                  >
                    Record Review Action
                  </button>
                </div>
              ) : null}
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
        <div
          className="absolute inset-0 bg-black/50"
          aria-hidden="true"
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

  if (step === "count") {
    const fullOk =
      fullDrawerTotal.trim() !== "" &&
      Number.isFinite(parseMoneyToCents(fullDrawerTotal));
    const canSubmitDenom = denominationTotalCents > 0 || fullOk;

    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <div
          className="absolute inset-0 bg-black/50"
          aria-hidden="true"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal relative max-h-[96dvh] w-full max-w-none overflow-y-auto rounded-t-3xl animate-workspace-snap outline-none sm:max-h-[95vh] sm:max-w-[92rem] sm:rounded-3xl"
        >
          <div className="ui-modal-header flex items-center justify-between">
            <div className="flex gap-2">
              <span className="ui-pill ui-status-warn">Reconciling</span>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Step 1 of 3</span>
            </div>
            <h2 id={titleId} className="text-sm font-black text-app-text uppercase tracking-widest">
              End of Shift
            </h2>
          </div>
          <div className="ui-modal-body grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_420px]">
            <div className="space-y-3">
              {registerLane != null ? (
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Register #{registerLane}
                  {registerOrdinal != null ? ` · Session #${registerOrdinal}` : ""}
                </p>
              ) : null}
              {renderWorkflowSummary("count")}
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Review
              </p>
              {renderOfflineQueueBlocker()}
              {renderHistoricalRecovery()}
              {renderHelcimReviewBlocker()}
              <p className="rounded-2xl border border-app-border bg-app-surface/70 px-3 py-2 text-[11px] font-bold text-app-text-muted">
                Blind count. Enter denominations or one total.
              </p>
            </div>

            <form onSubmit={handleBlindCountSubmit} className="contents">
              <div className="space-y-3">
                <div className="ui-panel ui-tint-neutral p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase text-app-text-muted tracking-widest">Bills</p>
                    <p className="font-mono text-sm font-black text-app-success">${centsToFixed2(billTotalCents)}</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {DENOMS.map((d) => {
                      const active = activeEntry?.mode === "count" && activeEntry.group === "bill" && activeEntry.key === d.key;
                      return (
                        <label key={d.key} className="flex flex-col gap-1 text-[10px] font-bold text-app-text-muted">
                          {d.label}
                          <input
                            type="text"
                            inputMode="numeric"
                            value={denomCounts[d.key]}
                            onFocus={(event) => {
                              setActiveEntry({ mode: "count", group: "bill", key: d.key });
                              setFreshEntry(true);
                              event.currentTarget.select();
                            }}
                            onChange={e => {
                              setFreshEntry(false);
                              setDenomCounts(prev => ({ ...prev, [d.key]: normalizeCountInput(e.target.value) }));
                            }}
                            className={`ui-input w-full p-3 text-center font-mono text-lg ${active ? "border-app-accent ring-2 ring-app-accent/20" : ""}`}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="ui-panel ui-tint-neutral p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase text-app-text-muted tracking-widest">Coins</p>
                    <p className="font-mono text-sm font-black text-app-success">${centsToFixed2(coinTotalCents)}</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {COIN_DENOMS.map((d) => {
                      const active = activeEntry?.mode === "count" && activeEntry.group === "coin" && activeEntry.key === d.key;
                      return (
                        <label key={d.key} className="flex flex-col gap-1 text-[10px] font-bold text-app-text-muted">
                          {d.label}
                          <input
                            type="text"
                            inputMode="numeric"
                            value={coinCounts[d.key]}
                            onFocus={(event) => {
                              setActiveEntry({ mode: "count", group: "coin", key: d.key });
                              setFreshEntry(true);
                              event.currentTarget.select();
                            }}
                            onChange={e => {
                              setFreshEntry(false);
                              setCoinCounts(prev => ({ ...prev, [d.key]: normalizeCountInput(e.target.value) }));
                            }}
                            className={`ui-input w-full p-3 text-center font-mono text-lg ${active ? "border-app-accent ring-2 ring-app-accent/20" : ""}`}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="ui-panel ui-tint-neutral p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <label className="block text-[10px] font-black uppercase text-app-text-muted tracking-widest">Drawer total instead</label>
                    <p className="font-mono text-sm font-black text-app-text">${centsToFixed2(denominationTotalCents)}</p>
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={fullDrawerTotal}
                    onFocus={(event) => {
                      setActiveEntry({ mode: "money", key: "fullDrawerTotal" });
                      setFreshEntry(true);
                      event.currentTarget.select();
                    }}
                    onChange={e => {
                      setFreshEntry(false);
                      setFullDrawerTotal(e.target.value.replace(/[^\d.]/g, ""));
                    }}
                    className={`ui-input w-full p-4 text-center font-mono text-3xl ${activeEntry?.mode === "money" ? "border-app-accent ring-2 ring-app-accent/20" : ""}`}
                    placeholder="---"
                  />
                </div>
              </div>

              <div className="ui-panel ui-tint-neutral flex min-h-[520px] flex-col gap-3 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Keypad</p>
                  <p className="rounded-full bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">{activeEntryLabel}</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"].map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyKeypadInput(key)}
                      disabled={!activeEntry || (key === "." && activeEntry.mode !== "money")}
                      className="rounded-xl border border-app-border bg-app-surface px-3 py-5 text-2xl font-black text-app-text shadow-sm disabled:opacity-30"
                    >
                      {key === "back" ? "Back" : key}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => applyKeypadInput("clear")} disabled={!activeEntry} className="ui-btn-secondary py-3 text-xs font-black uppercase tracking-widest">
                  Clear
                </button>
                <div className="mt-auto rounded-2xl border border-app-border bg-app-surface px-3 py-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Counted</p>
                  <p className="font-mono text-2xl font-black text-app-text">
                    ${centsToFixed2(fullOk ? parseMoneyToCents(fullDrawerTotal) : denominationTotalCents)}
                  </p>
                </div>
              </div>

              <div className="sticky bottom-0 -mx-4 flex gap-3 border-t border-app-border bg-app-surface/95 px-4 py-3 backdrop-blur lg:col-span-2 lg:col-start-2">
                <button type="button" onClick={internalCancel} className="ui-btn-secondary flex-1 py-3">Cancel</button>
                <button type="submit" disabled={!canSubmitDenom} className="ui-btn-primary flex-1 py-3 text-sm font-black">Next: Checks</button>
              </div>
            </form>
          </div>
        </div>
        {renderRecoveryManagerModal()}
      </div>,
      root
    );
  }

  if (reconError) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <div
          className="absolute inset-0 bg-black/50"
          aria-hidden="true"
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
  const physicalExpectedCents = parseMoneyToCents(recon.physical_expected_cash ?? recon.expected_cash);
  const actualCents = parseMoneyToCents(actualCash);
  const discrepancyCents = actualCents - physicalExpectedCents;
  const cashCountIsSingleDay = recon.cash_count_is_single_day ?? true;
  const isOff = discrepancyCents !== 0;
  const openingCents = parseMoneyToCents(recon.opening_float);
  const netAdjCents = parseMoneyToCents(recon.net_cash_adjustments ?? "0");
  const roundingCents = parseMoneyToCents(recon.total_rounding_adjustments ?? "0");
  const cashSalesCents = expectedCents - openingCents - netAdjCents - roundingCents;
  const cashDepositCents = parseMoneyToCents(cashDepositAmount);
  const needsNote =
    Math.abs(discrepancyCents) > MANDATORY_NOTE_OVER_USD * 100;
  const hasRecoveryBlockers =
    offlineQueueSummary.totalCount > 0 ||
    serverRecoveryJobs.length > 0 ||
    (closeRecoveryBlock?.stationBlockers.length ?? 0) > 0;
  const closeBlockers = [
    hasRecoveryBlockers ? "Checkout recovery" : null,
    checkPayments.length > 0 && !checksReady ? "Check review" : null,
    needsNote && notes.trim() === "" ? "Cash discrepancy note" : null,
    cashDepositDate.trim() === "" ? "Cash deposit date" : null,
  ].filter(Boolean);
  const closeReady = closeBlockers.length === 0;
  const closeInsightFacts = {
    title: `Register #${registerOrdinal ?? registerLane ?? "?"} close review`,
    metrics: [
      { id: "expected-cash", label: "Expected cash", value: `$${centsToFixed2(expectedCents)}` },
      { id: "actual-cash", label: "Actual counted", value: `$${centsToFixed2(actualCents)}` },
      { id: "cash-deposit", label: "Daily cash deposit", value: `${cashDepositDate || "No date"} · $${centsToFixed2(cashDepositCents)}` },
      {
        id: "cash-discrepancy",
        label: "Cash over or short",
        value: `${discrepancyCents < 0 ? "-" : "+"}$${centsToFixed2(Math.abs(discrepancyCents))}`,
        tone: isOff ? "warning" : "success",
      },
      { id: "tender-count", label: "Tender families", value: String(recon.tenders.length) },
    ],
    bullets: [
      {
        id: "close-ready",
        label: closeReady
          ? "All close blockers are clear; staff still reviews the Z-report before final close."
          : `Close is blocked by ${closeBlockers.join(", ")}.`,
        severity: closeReady ? "success" : "warning",
      },
      {
        id: "cash-note",
        label: needsNote
          ? "Cash discrepancy is over the required note threshold."
          : "Cash discrepancy is within the no-note threshold, but staff can still document it.",
        severity: needsNote ? "warning" : "info",
      },
      {
        id: "card-review",
        label: helcimReviewMessage ?? "No approved Helcim card payments are missing from ROS.",
        severity: helcimReviewMessage ? "info" : "success",
      },
      {
        id: "offline-queue",
        label:
          hasRecoveryBlockers
            ? `${offlineQueueSummary.totalCount} local, ${serverRecoveryJobs.length} Main Hub, and ${closeRecoveryBlock?.stationBlockers.length ?? 0} linked-workstation recovery records must clear or receive audited Manager force-close approval.`
            : "No checkout recovery items are blocking close.",
        severity: hasRecoveryBlockers ? "warning" : "success",
      },
    ],
    disclaimers: [
      "Explain visible close facts only. Do not close the register, change tender totals, change counted cash, or approve payment outcomes.",
    ],
  };

  if (step === "checks") {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <div
          className="absolute inset-0 bg-black/50"
          aria-hidden="true"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal relative flex max-h-[96dvh] w-full max-w-none flex-col rounded-t-3xl animate-workspace-snap outline-none sm:max-h-[95vh] sm:max-w-4xl sm:rounded-3xl"
        >
          <div className="ui-modal-header flex items-center justify-between">
            <div className="flex gap-2">
              <span className="ui-pill ui-status-warn">Reconciling</span>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Step 2 of 3</span>
            </div>
            <h2 id={titleId} className="text-sm font-black uppercase tracking-widest text-app-text">
              Check Review
            </h2>
          </div>
          <div className="ui-modal-body flex-1 overflow-y-auto space-y-4">
            {renderWorkflowSummary("checks")}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div className="ui-panel ui-tint-neutral p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Checks taken
                  </p>
                  <p className="font-mono text-lg font-black text-app-text">
                    {checkPayments.length}
                  </p>
                </div>

                {checkPayments.length === 0 ? (
                  <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-8 text-center">
                    <p className="text-sm font-black text-app-text">No checks this shift</p>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">Continue to final review.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {checkPayments.map((line, index) => {
                      const id = paymentLineId(line);
                      const review = checkReview[id] ?? {
                        checkNumber: line.check_number ?? "",
                        amount: centsToFixed2(parseMoneyToCents(line.amount)),
                        confirmed: false,
                      };
                      const amountMatches = parseMoneyToCents(review.amount) === parseMoneyToCents(line.amount);
                      const numberReady = review.checkNumber.trim() !== "";
                      return (
                        <div key={id} className="rounded-2xl border border-app-border bg-app-surface p-3">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Check {index + 1}
                            </p>
                            <p className="font-mono text-sm font-black text-app-text">
                              ${centsToFixed2(parseMoneyToCents(line.amount))}
                            </p>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
                            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Check #
                              <input
                                value={review.checkNumber}
                                onChange={(event) =>
                                  setCheckReview((prev) => ({
                                    ...prev,
                                    [id]: { ...review, checkNumber: event.target.value, confirmed: false },
                                  }))
                                }
                                className="ui-input mt-1 w-full p-3 font-mono text-sm"
                              />
                            </label>
                            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Amount
                              <input
                                value={review.amount}
                                onChange={(event) =>
                                  setCheckReview((prev) => ({
                                    ...prev,
                                    [id]: { ...review, amount: event.target.value.replace(/[^\d.]/g, ""), confirmed: false },
                                  }))
                                }
                                className={`ui-input mt-1 w-full p-3 text-right font-mono text-sm ${amountMatches ? "" : "border-app-danger"}`}
                                inputMode="decimal"
                              />
                            </label>
                            <label className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-xs font-black uppercase tracking-widest ${review.confirmed ? "border-app-success/30 bg-app-success/10 text-app-success" : "border-app-border bg-app-surface-2 text-app-text-muted"}`}>
                              <input
                                type="checkbox"
                                checked={review.confirmed}
                                disabled={!amountMatches || !numberReady}
                                onChange={(event) =>
                                  setCheckReview((prev) => ({
                                    ...prev,
                                    [id]: { ...review, confirmed: event.target.checked },
                                  }))
                                }
                              />
                              Confirm
                            </label>
                          </div>
                          {!amountMatches || !numberReady ? (
                            <p className="mt-2 text-[10px] font-bold text-app-danger">
                              {numberReady ? "Amount must match the recorded check payment." : "Check number required."}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="ui-panel ui-tint-info flex flex-col justify-between gap-3 p-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Check total</p>
                  <p className="mt-1 font-mono text-2xl font-black text-app-text">
                    ${centsToFixed2(checkPayments.reduce((sum, line) => sum + parseMoneyToCents(line.amount), 0))}
                  </p>
                </div>
                <p className="text-xs font-semibold text-app-text-muted">
                  Match paper checks to ROS before closing.
                </p>
              </div>
            </div>

            <div className="sticky bottom-0 -mx-1 flex gap-3 border-t border-app-border bg-app-surface/95 px-1 py-4 backdrop-blur">
              <button type="button" onClick={() => void internalCancel()} className="ui-btn-secondary flex-1 py-3">
                Cancel
              </button>
              <button type="button" onClick={() => setStep("count")} className="ui-btn-secondary flex-1 py-3">
                Back
              </button>
              <button type="button" onClick={() => setStep("report")} disabled={!checksReady} className="ui-btn-primary flex-1 py-3 text-sm font-black">
                Next: Z-Report
              </button>
            </div>
          </div>
        </div>
      </div>,
      root,
    );
  }

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
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
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Step 3 of 3</span>
            </div>
            <h2 id={titleId} className="text-xl font-black text-app-text">
              Z-Report
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              void openCurrentZReportPrint(recon, "preview")
                .then((opened) => {
                  if (!opened) {
                    toast("Z-report could not open for review.", "error");
                  }
                })
                .catch((error) => {
                  toast(
                    error instanceof Error
                      ? error.message
                      : "Z-report could not open.",
                    "error",
                  );
                });
            }}
            className="ui-btn-secondary border-app-accent/20 px-4 py-2 text-app-accent shadow-sm"
          >
            Preview Print
          </button>
        </div>

        <div className="ui-modal-body flex-1 overflow-y-auto space-y-6">
          {renderWorkflowSummary("report")}
          {recon?.qbo_activity_date ? (
            <div className="rounded-2xl border border-app-warning/30 bg-app-warning/10 px-4 py-3 text-sm text-app-text">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-warning">
                Z-Report business date
              </p>
              <p className="mt-1 text-lg font-black tabular-nums">
                {recon.qbo_activity_date}
              </p>
              {(recon.pending_business_dates?.length ?? 0) > 1 ? (
                <p className="mt-1 font-semibold leading-relaxed text-app-text-muted">
                  {recon.pending_business_dates!.length} business days are waiting to close. This report contains only {recon.qbo_activity_date}; after it closes, {recon.pending_business_dates![1]} must be closed separately.
                </p>
              ) : (
                <p className="mt-1 font-semibold text-app-text-muted">
                  Only activity from this store-local business date is included.
                </p>
              )}
            </div>
          ) : null}
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
              <span className="rounded-full bg-app-surface/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest">
                {closeReady ? "All checks clear" : `${closeBlockers.length} action${closeBlockers.length === 1 ? "" : "s"}`}
              </span>
            </div>
            <p className="mt-1 text-sm font-semibold">
              {closeReady
                ? "Required close checks are clear."
                : `Before closing: ${closeBlockers.join(", ")}.`}
            </p>
          </div>
          <div className="rounded-2xl border border-app-accent/25 bg-app-accent/5 px-4 py-3">
            <p className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-app-accent">
              <RosieIcon size={14} alt="" />
              Register close explainer
            </p>
            <p className="mt-1 text-xs font-semibold text-app-text-muted">
              ROSIE explains the visible close facts only. Final close, cash counts, and payment
              outcomes stay in the normal manager-reviewed workflow.
            </p>
            <RosieInsightSummary
              surface="register_close_review"
              title="Register Close"
              mode="explain"
              getHeaders={() => Object.fromEntries(jsonAuthHeaders().entries())}
              facts={closeInsightFacts}
              className="mt-3"
            />
          </div>
          {renderOfflineQueueBlocker()}
          {renderHistoricalRecovery()}
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
              <div className="flex justify-between text-app-text-muted font-medium"><span>Cash Sales (Gross):</span><span className="font-mono text-app-success">+ ${centsToFixed2(cashSalesCents)}</span></div>
              <div className="flex justify-between text-app-text-muted font-medium"><span>Cash Rounding:</span><span className="font-mono text-app-warning">{roundingCents < 0 ? "-" : "+"}${centsToFixed2(Math.abs(roundingCents))}</span></div>
              <div className="flex justify-between text-app-text-muted font-medium"><span>Net adjustments:</span><span className="font-mono text-app-warning">{netAdjCents < 0 ? "-" : "+"}${centsToFixed2(Math.abs(netAdjCents))}</span></div>
              <div className="flex justify-between pt-3 border-t border-app-border font-black text-app-text uppercase text-xs"><span>{cashCountIsSingleDay ? "Expected Cash:" : `Expected Cash for ${recon.qbo_activity_date}:`}</span><span className="font-mono">${centsToFixed2(expectedCents)}</span></div>
              {!cashCountIsSingleDay ? (
                <div className="flex justify-between text-app-warning font-black text-xs"><span>Current drawer expected across missed days:</span><span className="font-mono">${centsToFixed2(physicalExpectedCents)}</span></div>
              ) : null}
              <div className="flex justify-between pt-1 font-black text-app-accent text-lg"><span>Actual Counted:</span><span className="font-mono">${centsToFixed2(actualCents)}</span></div>
              <div className="flex justify-between pt-2 text-app-text font-bold"><span>{cashCountIsSingleDay ? "Daily Cash Deposit:" : "Current combined cash deposit:"}</span><span className="font-mono">${centsToFixed2(cashDepositCents)}</span></div>
            </div>
            <div className="mt-4 rounded-2xl border border-app-border bg-app-surface/70 p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Deposit Date
                  <input
                    type="date"
                    value={cashDepositDate}
                    onChange={(event) => setCashDepositDate(event.target.value)}
                    className="ui-input mt-1 w-full p-3 text-xs normal-case tracking-normal"
                  />
                </label>
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Deposit Amount
                  <input
                    value={cashDepositAmount}
                    onChange={(event) => {
                      setCashDepositEdited(true);
                      setCashDepositAmount(event.target.value);
                    }}
                    inputMode="decimal"
                    className="ui-input mt-1 w-full p-3 text-xs normal-case tracking-normal"
                    placeholder="0.00"
                  />
                </label>
              </div>
              <p className="mt-2 text-[11px] font-semibold text-app-text-muted">
                {cashCountIsSingleDay
                  ? "Default is actual counted cash minus opening float. Adjust only when retaining a different start bank."
                  : "This is the current physical drawer deposit across the missed dates. It is retained for the final till-group audit and is not assigned to this historical day."}
              </p>
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
                      <tr key={paymentLineId(t)}>
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
            <button type="button" onClick={() => setStep("checks")} disabled={loading} className="ui-btn-secondary flex-1 py-4 text-sm font-bold">Back</button>
            <button type="button" onClick={() => setShowFinalConfirm(true)} disabled={loading || !closeReady} className="ui-btn-primary flex-1 py-4 text-sm font-black shadow-lg shadow-app-accent/20">Close & Print Z-Report</button>
          </div>
        </div>
      </div>
      <ConfirmationModal
        isOpen={showFinalConfirm}
        title="Close and print?"
        message={
          (recon?.pending_business_dates?.length ?? 0) > 1
            ? `This closes only ${recon?.qbo_activity_date}. ${recon?.pending_business_dates?.[1]} will remain waiting for its own separate Z-Report.`
            : `This closes the till group and creates the Z-Report for ${recon?.qbo_activity_date ?? "the business day"}.`
        }
        confirmLabel="Close & Print"
        variant="danger"
        onConfirm={() => void handleFinalClose()}
        onClose={() => setShowFinalConfirm(false)}
      />
      {renderRecoveryManagerModal()}
    </div>,
    root
  );
}
