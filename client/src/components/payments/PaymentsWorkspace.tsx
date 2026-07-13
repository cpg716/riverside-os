import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import DetailDrawer from "../layout/DetailDrawer";
import ConfirmationModal from "../ui/ConfirmationModal";
import PromptModal from "../ui/PromptModal";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CreditCard,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const baseUrl = getBaseUrl();

type SectionId =
  | "overview"
  | "batches"
  | "deposits"
  | "reconciliation"
  | "transactions"
  | "refunds"
  | "disputes"
  | "health";

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  variant?: "danger" | "success" | "info";
  onConfirm: () => void;
};

type SettlementRun = {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  summary: Record<string, unknown>;
  error_message: string | null;
};

type OverviewResponse = {
  card_sales_gross: string;
  known_fees: string | null;
  known_net: string | null;
  fee_not_ready_count: number;
  net_not_ready_count: number;
  expected_deposit_from_batches: string | null;
  open_issue_count: number;
  critical_issue_count: number;
  last_settlement_sync: SettlementRun | null;
  last_fee_sync: string | null;
  helcim_api_active: boolean;
};

type BatchRow = {
  id: string;
  provider_batch_id: string;
  status: string | null;
  closed_at: string | null;
  settled_at: string | null;
  expected_deposit_at: string | null;
  gross_amount: string | null;
  fee_amount: string | null;
  net_amount: string | null;
  transaction_count: number | null;
  issue_count: number;
  fee_not_ready_count: number;
  net_not_ready_count: number;
  last_synced_at: string;
};

type BatchDetail = {
  batch: BatchRow;
  critical_issue_count: number;
  warning_issue_count: number;
  info_issue_count: number;
};

type BatchTransactionRow = {
  id: string;
  provider_transaction_id: string;
  payment_transaction_id: string | null;
  amount: string | null;
  status: string | null;
  fee_amount: string | null;
  net_amount: string | null;
  match_status: string;
  match_type: string | null;
  occurred_at: string | null;
  settled_at: string | null;
};

type ReconciliationItem = {
  id: string;
  item_type: string;
  issue_label: string;
  severity: string;
  status: string;
  amount: string | null;
  reference: string | null;
  provider_batch_id: string | null;
  provider_transaction_id: string | null;
  payment_transaction_id: string | null;
  payment_provider_batch_id: string | null;
  message: string | null;
  created_at: string;
  reviewed_at: string | null;
  resolved_at: string | null;
  resolution_type: string | null;
  resolution_note: string | null;
  events: ReconciliationItemEvent[];
};

type ReconciliationItemEvent = {
  id: string;
  action: string;
  note: string | null;
  actor_staff_id: string | null;
  created_at: string;
};

type CandidatePayment = {
  payment_transaction_id: string;
  provider_transaction_id: string | null;
  amount: string;
  payment_date: string;
  payment_status: string;
  provider_status: string | null;
  provider_batch_id: string | null;
  warning_flags: string[];
};

type TransactionRow = {
  payment_transaction_id: string | null;
  provider_transaction_id: string | null;
  transaction_id: string | null;
  transaction_display_id: string | null;
  customer_name: string | null;
  transaction_type: string | null;
  amount: string;
  payment_date: string;
  payment_status: string;
  provider_status: string | null;
  batch_id: string | null;
  provider_batch_id: string | null;
  batch_status: string | null;
  fee_amount: string | null;
  net_amount: string | null;
  fee_status: string;
  net_status: string;
  match_status: string | null;
  issue_count: number;
};

type TimelineRow = {
  occurred_at: string;
  label: string;
  status: string;
};

type TransactionDetail = {
  riverside_payment: Record<string, unknown>;
  processor_payment: Record<string, unknown> | null;
  batch: Record<string, unknown> | null;
  fee_details: Record<string, unknown>;
  issues: ReconciliationItem[];
  timeline: TimelineRow[];
};

type EventsHealth = {
  recent_event_count: number;
  failed_event_count: number;
  ignored_event_count: number;
  unmatched_event_count: number;
  last_event_at: string | null;
  last_failed_message: string | null;
  last_failed_event_id: string | null;
  webhook_delivery_status: string;
  webhook_delivery_label: string;
  webhook_delivery_detail: string;
  webhook_delivery_action: string;
  terminal_review_attempts: HelcimTerminalReviewAttempt[];
  terminal_review_events: HelcimTerminalReviewEvent[];
};

type HelcimTerminalReviewAttempt = {
  id: string;
  status: string;
  amount: string;
  currency: string;
  register_session_id: string | null;
  register_lane: number | null;
  device_id: string | null;
  terminal_id: string | null;
  selected_terminal_key: string | null;
  provider_payment_id: string | null;
  provider_transaction_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  label: string;
  detail: string;
  parked_sale_id: string | null;
  parked_sale_label: string | null;
  parked_customer_name: string | null;
  parked_sale_match_count: number;
  recovery_actions: HelcimTerminalRecoveryAction[];
};

type HelcimTerminalReviewEvent = {
  id: string;
  event_type: string;
  processing_status: string;
  received_at: string;
  error_message: string | null;
  provider_transaction_id: string | null;
  payment_provider_attempt_id: string | null;
  payment_transaction_id: string | null;
  match_type: string | null;
  label: string;
  detail: string;
  recovery_actions: HelcimTerminalRecoveryAction[];
};

type HelcimTerminalRecoverySourceKind = "payment_provider_attempt" | "helcim_event";

type HelcimTerminalRecoveryActionName =
  | "reviewed"
  | "noted"
  | "resolved_no_action"
  | "provider_charge_confirmed"
  | "duplicate_suspected"
  | "refund_required"
  | "replayed_webhook";

type HelcimTerminalRecoveryAction = {
  id: string;
  source_kind: HelcimTerminalRecoverySourceKind;
  source_id: string;
  action: HelcimTerminalRecoveryActionName;
  note: string | null;
  actor_staff_id: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
};

type HelcimAttemptResponse = {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  register_session_id: string | null;
  provider_payment_id: string | null;
  provider_transaction_id: string | null;
  error_message: string | null;
  safe_message: string | null;
  raw_audit_reference: string | null;
  created_at: string;
  completed_at: string | null;
};

type HelcimDevice = {
  code?: string;
  deviceCode?: string;
  id?: string | number;
  nickname?: string;
  name?: string;
  status?: string;
  model?: string;
  type?: string;
  [key: string]: unknown;
};

type HelcimCardTerminal = {
  id?: string | number;
  nickname?: string;
  currency?: string;
  status?: string;
  [key: string]: unknown;
};

type HelcimTerminalRouting = {
  terminals: Array<{
    key: "terminal_1" | "terminal_2";
    label: string;
    configured: boolean;
    in_use_by_register_lane?: number | null;
  }>;
  registers: Array<{
    register_lane: number;
    default_terminal_key?: "terminal_1" | "terminal_2" | null;
    allowed_terminal_keys: Array<"terminal_1" | "terminal_2">;
    choice_required: boolean;
    non_default_override_requires_permission: boolean;
  }>;
};

type ActiveProviderResponse = {
  helcim_terminal_routing?: HelcimTerminalRouting;
};

type DepositRow = {
  id: string;
  source_system: string;
  source_reference: string | null;
  qbo_deposit_id: string | null;
  bank_feed_transaction_id: string | null;
  posted_at: string;
  amount: string;
  currency: string;
  status: string;
  linked_batch_count: number;
  expected_amount: string | null;
  linked_amount: string | null;
  difference: string | null;
  open_issue_count: number;
  reviewed_at: string | null;
};

type DepositBatchLink = {
  id: string;
  payment_provider_batch_id: string;
  provider_batch_id: string;
  expected_net_amount: string | null;
  linked_amount: string | null;
  match_type: string;
  status: string;
  created_at: string;
  batch_status: string | null;
  expected_deposit_at: string | null;
  settled_at: string | null;
};

type DepositEvent = {
  id: string;
  action: string;
  note: string | null;
  actor_staff_id: string | null;
  created_at: string;
};

type DepositIssue = {
  id: string;
  item_type: string;
  issue_label: string;
  severity: string;
  status: string;
  deposit_id: string | null;
  payment_provider_batch_id: string | null;
  provider_batch_id: string | null;
  amount: string | null;
  reference: string | null;
  message: string | null;
  created_at: string;
};

type DepositDetail = {
  deposit: DepositRow;
  linked_batches: DepositBatchLink[];
  events: DepositEvent[];
  issues: DepositIssue[];
};

type DashboardState = {
  overview: OverviewResponse | null;
  batches: BatchRow[];
  deposits: DepositRow[];
  unmatchedBatches: BatchRow[];
  unmatchedDeposits: DepositRow[];
  issues: ReconciliationItem[];
  transactions: TransactionRow[];
  runs: SettlementRun[];
  health: EventsHealth | null;
  terminalDevices: HelcimDevice[];
  cardTerminals: HelcimCardTerminal[];
  terminalRouting: HelcimTerminalRouting | null;
  terminalError: string | null;
};

type Props = {
  activeSection?: string;
  surface?: "backoffice" | "pos";
  onOpenTransactionInBackoffice?: (transactionId: string) => void;
};

function todayYmd(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function money(value: string | null | undefined, emptyLabel = "Not ready") {
  if (value === null || value === undefined || value === "") return emptyLabel;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function sumMoney(values: (string | null | undefined)[]) {
  const total = values.reduce((sum, value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? sum + parsed : sum;
  }, 0);
  return total.toFixed(2);
}

function dollarsInputToCents(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const dollars = Number.parseInt(whole, 10);
  const cents = Number.parseInt(fraction.padEnd(2, "0"), 10) || 0;
  if (!Number.isSafeInteger(dollars) || dollars > 9_000_000) return null;
  return dollars * 100 + cents;
}

function centsMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "Not ready";
  return (value / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function createRefundIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36).padStart(9, "0");
  const randomA = Math.random().toString(36).slice(2, 13).padEnd(11, "0");
  const randomB = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `refund-${timestamp}-${randomA}-${randomB}`;
}

function differenceLabel(value: string | null | undefined) {
  if (!value) return "Not linked";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (Math.abs(parsed) < 0.005) return "Clear";
  return money(value);
}

function shortDateTime(value: string | null | undefined) {
  if (!value) return "Not ready";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not ready";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortDate(value: string | null | undefined) {
  if (!value) return "Not ready";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not ready";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function asText(value: unknown, emptyLabel = "Not ready") {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return emptyLabel;
}

function extractArray<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

function helcimDeviceCode(device: HelcimDevice) {
  const value = device.code ?? device.deviceCode ?? device.id;
  return value === undefined || value === null ? "" : String(value).trim();
}

function helcimDeviceLabel(device: HelcimDevice) {
  return (
    asText(device.nickname, "") ||
    asText(device.name, "") ||
    asText(device.model, "") ||
    `Device ${helcimDeviceCode(device) || "unknown"}`
  );
}

function staffLabel(value: string | null | undefined, emptyLabel = "Not ready") {
  if (!value) return emptyLabel;
  return value
    .replaceAll("_", " ")
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function statusTone(status: string | null | undefined) {
  const normalized = status?.toLowerCase() ?? "";
  if (["approved", "complete", "completed", "processed", "success", "successful", "settled", "matched"].includes(normalized)) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
  }
  if (["critical", "declined", "failed", "open", "unmatched", "needs_review"].includes(normalized)) {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700";
  }
  if (["warning", "running", "received"].includes(normalized)) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700";
  }
  return "border-app-border bg-app-surface-2 text-app-text-muted";
}

function StatusPill({ value }: { value: string | null | undefined }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(value)}`}>
      {staffLabel(value)}
    </span>
  );
}

function MetricCard({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "neutral" | "warning" | "danger" | "good";
}) {
  const accent =
    tone === "danger"
      ? "border-rose-500/30"
      : tone === "warning"
        ? "border-amber-500/30"
        : tone === "good"
          ? "border-emerald-500/30"
          : "border-app-border";
  return (
    <div className={`rounded-lg border ${accent} bg-app-surface p-4 shadow-sm`}>
      <div className="text-xs font-semibold text-app-text-muted">{label}</div>
      <div className="mt-2 text-2xl font-black text-app-text">{value}</div>
      {note ? <div className="mt-2 text-xs font-medium text-app-text-muted">{note}</div> : null}
    </div>
  );
}

function SectionButton({
  id,
  label,
  badge,
  active,
  onClick,
}: {
  id: SectionId;
  label: string;
  badge?: number;
  active: boolean;
  onClick: (id: SectionId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
        active
          ? "bg-app-accent text-white shadow-sm"
          : "border border-app-border bg-app-surface text-app-text hover:bg-app-surface-2"
      }`}
    >
      <span className="inline-flex items-center gap-2">
        {label}
        {badge && badge > 0 ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-black ${active ? "bg-app-surface/20 text-white" : "bg-amber-100 text-amber-800"}`}>
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export default function PaymentsWorkspace({
  activeSection = "overview",
  surface = "backoffice",
  onOpenTransactionInBackoffice,
}: Props) {
  const posSurface = surface === "pos";
  const initialSection = posSurface ? "transactions" : isSection(activeSection) ? activeSection : "overview";
  const [section, setSection] = useState<SectionId>(initialSection);
  const [data, setData] = useState<DashboardState>({
    overview: null,
    batches: [],
    deposits: [],
    unmatchedBatches: [],
    unmatchedDeposits: [],
    issues: [],
    transactions: [],
    runs: [],
    health: null,
    terminalDevices: [],
    cardTerminals: [],
    terminalRouting: null,
    terminalError: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<"batches" | "fees" | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<BatchRow | null>(null);
  const [batchDetail, setBatchDetail] = useState<BatchDetail | null>(null);
  const [batchTransactions, setBatchTransactions] = useState<BatchTransactionRow[]>([]);
  const [batchIssues, setBatchIssues] = useState<ReconciliationItem[]>([]);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);
  const [transactionDetail, setTransactionDetail] = useState<TransactionDetail | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<ReconciliationItem | null>(null);
  const [issueCandidates, setIssueCandidates] = useState<CandidatePayment[]>([]);
  const [issueBusy, setIssueBusy] = useState(false);
  const [selectedDepositId, setSelectedDepositId] = useState<string | null>(null);
  const [depositDetail, setDepositDetail] = useState<DepositDetail | null>(null);
  const [depositBusy, setDepositBusy] = useState(false);
  const [transactionSearch, setTransactionSearch] = useState("");
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [standaloneRefundBusy, setStandaloneRefundBusy] = useState(false);
  const [standaloneRefundAttempt, setStandaloneRefundAttempt] = useState<HelcimAttemptResponse | null>(null);
  const { backofficeHeaders, hasPermission, permissionsLoaded } = useBackofficeAuth();
  const { toast } = useToast();
  const hasAnyPermission = useCallback(
    (keys: string[]) => permissionsLoaded && keys.some((key) => hasPermission(key)),
    [hasPermission, permissionsLoaded],
  );
  const canSync = !posSurface && hasAnyPermission(["payments.sync"]);
  const canReconcileReview = posSurface || hasAnyPermission([
    "payments.reconcile.review",
    "payments.reconcile",
  ]);
  const canReconcileResolve = posSurface || hasAnyPermission([
    "payments.reconcile.resolve",
    "payments.reconcile",
  ]);
  const canReconcileLink = hasAnyPermission([
    "payments.reconcile.link",
    "payments.reconcile",
  ]);
  const canDepositReview = hasAnyPermission(["payments.deposit.review"]);
  const canDepositLink = hasAnyPermission(["payments.deposit.link"]);
  const canDepositAdjust = hasAnyPermission(["payments.deposit.adjust"]);

  useEffect(() => {
    setSection(posSurface ? "transactions" : isSection(activeSection) ? activeSection : "overview");
  }, [activeSection, posSurface]);

  const apiHeaders = useMemo(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const getJson = useCallback(
    async <T,>(path: string): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`, { headers: apiHeaders });
      const text = await response.text();
      const body = text ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Request failed (${response.status})`;
        throw new Error(message);
      }
      return body as T;
    },
    [apiHeaders],
  );

  const sendJson = useCallback(
    async <T,>(path: string, method: "POST" | "PATCH", payload?: unknown): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...apiHeaders,
          "Content-Type": "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const text = await response.text();
      const body = text ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Request failed (${response.status})`;
        throw new Error(message);
      }
      return body as T;
    },
    [apiHeaders],
  );

  const confirmAction = useCallback((request: ConfirmRequest) => {
    setConfirmRequest(request);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const today = todayYmd();
    try {
      if (posSurface) {
        const [health, activeProvider, transactions] = await Promise.all([
          getJson<EventsHealth>("/api/payments/providers/helcim/events/health"),
          getJson<ActiveProviderResponse>("/api/payments/providers/active"),
          getJson<TransactionRow[]>(
            `/api/payments/providers/helcim/transactions?date_from=${today}&date_to=${today}&limit=100`,
          ),
        ]);
        const [terminalDevicesResult, cardTerminalsResult] = await Promise.all([
          getJson<unknown>("/api/payments/providers/helcim/terminal/devices?limit=100")
            .then((body) => ({ body, error: null as string | null }))
            .catch((err) => ({ body: null, error: err instanceof Error ? err.message : "Device status could not load." })),
          getJson<unknown>("/api/payments/providers/helcim/terminal/card-terminals")
            .then((body) => ({ body, error: null as string | null }))
            .catch((err) => ({ body: null, error: err instanceof Error ? err.message : "Card terminal status could not load." })),
        ]);
        setData({
          overview: null,
          batches: [],
          deposits: [],
          unmatchedBatches: [],
          unmatchedDeposits: [],
          issues: [],
          transactions,
          runs: [],
          health,
          terminalDevices: extractArray<HelcimDevice>(terminalDevicesResult.body, ["devices", "data", "items", "results"]),
          cardTerminals: extractArray<HelcimCardTerminal>(cardTerminalsResult.body, ["cardTerminals", "card_terminals", "data", "items", "results"]),
          terminalRouting: activeProvider.helcim_terminal_routing ?? null,
          terminalError: terminalDevicesResult.error ?? cardTerminalsResult.error,
        });
        return;
      }
      const [overview, batches, deposits, unmatchedBatches, unmatchedDeposits, issues, transactions, runs, health, activeProvider] = await Promise.all([
        getJson<OverviewResponse>(
          `/api/payments/providers/helcim/operations/overview?date_from=${today}&date_to=${today}`,
        ),
        getJson<BatchRow[]>("/api/payments/providers/helcim/batches?limit=50"),
        getJson<DepositRow[]>("/api/payments/providers/helcim/deposits?limit=50"),
        getJson<BatchRow[]>("/api/payments/providers/helcim/deposits/unmatched-batches?limit=25"),
        getJson<DepositRow[]>("/api/payments/providers/helcim/deposits/unmatched-deposits?limit=25"),
        getJson<ReconciliationItem[]>(
          "/api/payments/providers/helcim/reconciliation/items?status=open&limit=50",
        ),
        getJson<TransactionRow[]>("/api/payments/providers/helcim/transactions?limit=50"),
        getJson<SettlementRun[]>("/api/payments/providers/helcim/sync/runs?limit=10"),
        getJson<EventsHealth>("/api/payments/providers/helcim/events/health"),
        getJson<ActiveProviderResponse>("/api/payments/providers/active"),
      ]);
      const [terminalDevicesResult, cardTerminalsResult] = overview.helcim_api_active
        ? await Promise.all([
            getJson<unknown>("/api/payments/providers/helcim/terminal/devices?limit=100")
              .then((body) => ({ body, error: null as string | null }))
              .catch((err) => ({ body: null, error: err instanceof Error ? err.message : "Device status could not load." })),
            getJson<unknown>("/api/payments/providers/helcim/terminal/card-terminals")
              .then((body) => ({ body, error: null as string | null }))
              .catch((err) => ({ body: null, error: err instanceof Error ? err.message : "Card terminal status could not load." })),
          ])
        : [
            { body: null, error: "Helcim API token is not saved in Backoffice Settings." },
            { body: null, error: null },
          ];
      const terminalError = terminalDevicesResult.error ?? cardTerminalsResult.error;
      setData({
        overview,
        batches,
        deposits,
        unmatchedBatches,
        unmatchedDeposits,
        issues,
        transactions,
        runs,
        health,
        terminalDevices: extractArray<HelcimDevice>(terminalDevicesResult.body, ["devices", "data", "items", "results"]),
        cardTerminals: extractArray<HelcimCardTerminal>(cardTerminalsResult.body, ["cardTerminals", "card_terminals", "data", "items", "results"]),
        terminalRouting: activeProvider.helcim_terminal_routing ?? null,
        terminalError,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payments could not load.");
    } finally {
      setLoading(false);
    }
  }, [getJson, posSurface]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openBatch = useCallback(
    async (batch: BatchRow) => {
      setSelectedBatch(batch);
      setBatchDetail(null);
      setBatchTransactions([]);
      setBatchIssues([]);
      try {
        const [detail, transactions, issues] = await Promise.all([
          getJson<BatchDetail>(`/api/payments/providers/helcim/batches/${batch.id}`),
          getJson<BatchTransactionRow[]>(
            `/api/payments/providers/helcim/batches/${batch.id}/transactions`,
          ),
          getJson<ReconciliationItem[]>(
            `/api/payments/providers/helcim/reconciliation/items?status=open&batch_id=${encodeURIComponent(batch.id)}&limit=50`,
          ),
        ]);
        setBatchDetail(detail);
        setBatchTransactions(transactions);
        setBatchIssues(issues);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Batch could not load.", "error");
      }
    },
    [getJson, toast],
  );

  const openTransaction = useCallback(
    async (paymentId: string | null) => {
      if (!paymentId) {
        toast("This issue is not linked to a Riverside payment yet.", "info");
        return;
      }
      setSelectedPaymentId(paymentId);
      setTransactionDetail(null);
      try {
        const detail = await getJson<TransactionDetail>(
          `/api/payments/providers/helcim/transactions/${encodeURIComponent(paymentId)}`,
        );
        setTransactionDetail(detail);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Payment could not load.", "error");
      }
    },
    [getJson, toast],
  );

  const openIssue = useCallback(
    async (issue: ReconciliationItem) => {
      setSelectedIssue(issue);
      setIssueCandidates([]);
      if (!canReconcileLink || !issue.provider_transaction_id) return;
      try {
        const candidates = await getJson<CandidatePayment[]>(
          `/api/payments/providers/helcim/reconciliation/items/${issue.id}/candidate-payments`,
        );
        setIssueCandidates(candidates);
      } catch {
        setIssueCandidates([]);
      }
    },
    [canReconcileLink, getJson],
  );

  const openDeposit = useCallback(
    async (deposit: DepositRow) => {
      setSelectedDepositId(deposit.id);
      setDepositDetail(null);
      try {
        const detail = await getJson<DepositDetail>(
          `/api/payments/providers/helcim/deposits/${encodeURIComponent(deposit.id)}`,
        );
        setDepositDetail(detail);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Deposit could not load.", "error");
      }
    },
    [getJson, toast],
  );

  const createManualDeposit = useCallback(
    async (payload: {
      posted_at: string;
      amount: string;
      source_reference?: string;
      note?: string;
    }) => {
      confirmAction({
        title: "Add Actual Bank Deposit?",
        message:
          "This records bank activity for matching only. It will not post to QuickBooks or change payment totals.",
        confirmLabel: "Add Deposit",
        onConfirm: () => {
          void (async () => {
            setDepositBusy(true);
            try {
              const body = await sendJson<{ deposit: DepositDetail }>(
                "/api/payments/providers/helcim/deposits",
                "POST",
                {
                  ...payload,
                  source_system: "manual",
                },
              );
              setSelectedDepositId(body.deposit.deposit.id);
              setDepositDetail(body.deposit);
              toast("Actual bank deposit added.", "success");
              await refresh();
            } catch (err) {
              toast(err instanceof Error ? err.message : "Deposit could not be added.", "error");
            } finally {
              setDepositBusy(false);
            }
          })();
        },
      });
    },
    [confirmAction, refresh, sendJson, toast],
  );

  const linkDepositBatches = useCallback(
    async (depositId: string, batchIds: string[], note: string) => {
      confirmAction({
        title: "Link Expected Batches?",
        message:
          "Link only batches that make up this actual bank deposit. This will not change batch totals, fees, net amounts, or bank records.",
        confirmLabel: "Link Batches",
        onConfirm: () => {
          void (async () => {
            setDepositBusy(true);
            try {
              const body = await sendJson<{ deposit: DepositDetail }>(
                `/api/payments/providers/helcim/deposits/${depositId}/link-batches`,
                "POST",
                {
                  batch_ids: batchIds,
                  note,
                },
              );
              setDepositDetail(body.deposit);
              toast("Expected batches linked.", "success");
              await refresh();
            } catch (err) {
              toast(err instanceof Error ? err.message : "Batches could not be linked.", "error");
            } finally {
              setDepositBusy(false);
            }
          })();
        },
      });
    },
    [confirmAction, refresh, sendJson, toast],
  );

  const addDepositNote = useCallback(
    async (depositId: string, note: string) => {
      setDepositBusy(true);
      try {
        const body = await sendJson<{ deposit: DepositDetail }>(
          `/api/payments/providers/helcim/deposits/${depositId}/notes`,
          "POST",
          { note },
        );
        setDepositDetail(body.deposit);
        toast("Note added.", "success");
      } catch (err) {
        toast(err instanceof Error ? err.message : "Note could not be added.", "error");
      } finally {
        setDepositBusy(false);
      }
    },
    [sendJson, toast],
  );

  const reviewDeposit = useCallback(
    async (depositId: string, note: string, acceptVariance: boolean) => {
      if (acceptVariance) {
        confirmAction({
          title: "Accept Difference?",
          message:
            "Accepting a difference records staff review only. It does not change QuickBooks, bank deposits, payment totals, fees, or net amounts.",
          confirmLabel: "Accept Difference",
          variant: "danger",
          onConfirm: () => {
            void (async () => {
              setDepositBusy(true);
              try {
                const body = await sendJson<{ deposit: DepositDetail }>(
                  `/api/payments/providers/helcim/deposits/${depositId}/review`,
                  "PATCH",
                  {
                    note: note.trim() || undefined,
                    accept_variance: true,
                  },
                );
                setDepositDetail(body.deposit);
                toast("Difference accepted.", "success");
                await refresh();
              } catch (err) {
                toast(err instanceof Error ? err.message : "Deposit could not be reviewed.", "error");
              } finally {
                setDepositBusy(false);
              }
            })();
          },
        });
        return;
      }
      setDepositBusy(true);
      try {
        const body = await sendJson<{ deposit: DepositDetail }>(
          `/api/payments/providers/helcim/deposits/${depositId}/review`,
          "PATCH",
          {
            note: note.trim() || undefined,
            accept_variance: acceptVariance,
          },
        );
        setDepositDetail(body.deposit);
        toast(acceptVariance ? "Difference accepted." : "Deposit reviewed.", "success");
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : "Deposit could not be reviewed.", "error");
      } finally {
        setDepositBusy(false);
      }
    },
    [confirmAction, refresh, sendJson, toast],
  );

  const reopenDeposit = useCallback(
    async (depositId: string) => {
      setDepositBusy(true);
      try {
        const body = await sendJson<{ deposit: DepositDetail }>(
          `/api/payments/providers/helcim/deposits/${depositId}/reopen`,
          "POST",
        );
        setDepositDetail(body.deposit);
        toast("Deposit reopened.", "success");
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : "Deposit could not be reopened.", "error");
      } finally {
        setDepositBusy(false);
      }
    },
    [refresh, sendJson, toast],
  );

  const runDepositReview = useCallback(async () => {
    setDepositBusy(true);
    try {
      await sendJson<unknown>("/api/payments/providers/helcim/deposits/reconciliation/runs", "POST", {});
      toast("Deposit review refreshed.", "success");
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Deposit review could not run.", "error");
    } finally {
      setDepositBusy(false);
    }
  }, [refresh, sendJson, toast]);

  const updateSelectedIssue = useCallback((item: ReconciliationItem) => {
    setSelectedIssue(item);
    setData((current) => ({
      ...current,
      issues:
        item.status === "open"
          ? current.issues.map((issue) => (issue.id === item.id ? item : issue))
          : current.issues.filter((issue) => issue.id !== item.id),
    }));
    setBatchIssues((current) =>
      item.status === "open"
        ? current.map((issue) => (issue.id === item.id ? item : issue))
        : current.filter((issue) => issue.id !== item.id),
    );
    setTransactionDetail((current) =>
      current
        ? {
            ...current,
            issues:
              item.status === "open"
                ? current.issues.map((issue) => (issue.id === item.id ? item : issue))
                : current.issues.filter((issue) => issue.id !== item.id),
          }
        : current,
    );
  }, []);

  const applyIssueStatus = useCallback(
    async (
      issue: ReconciliationItem,
      action: "reviewed" | "resolved" | "ignored" | "reopened",
      note: string,
      resolutionType?: string,
    ) => {
      setIssueBusy(true);
      try {
        const response = await fetch(
          `${baseUrl}/api/payments/providers/helcim/reconciliation/items/${issue.id}/status`,
          {
            method: "PATCH",
            headers: {
              ...apiHeaders,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action,
              note: note.trim() || undefined,
              resolution_type: resolutionType,
            }),
          },
        );
        const body = (await response.json()) as { item?: ReconciliationItem; error?: string };
        if (!response.ok || !body.item) {
          throw new Error(body.error || `Issue update failed (${response.status})`);
        }
        updateSelectedIssue(body.item);
        toast(action === "ignored" ? "Issue marked expected." : "Issue updated.", "success");
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : "Issue update failed.", "error");
      } finally {
        setIssueBusy(false);
      }
    },
    [apiHeaders, refresh, toast, updateSelectedIssue],
  );

  const patchIssueStatus = useCallback(
    async (
      issue: ReconciliationItem,
      action: "reviewed" | "resolved" | "ignored" | "reopened",
      note: string,
      resolutionType?: string,
    ) => {
      if (action === "resolved" || action === "ignored") {
        confirmAction({
          title: action === "ignored" ? "Mark Expected?" : "Resolve Issue?",
          message:
            action === "ignored"
              ? "This records that staff accepts the issue as expected. It will not change payment totals, payment records, or bank records."
              : "This closes the issue for staff review. It will not change payment totals, payment records, or bank records.",
          confirmLabel: action === "ignored" ? "Mark Expected" : "Resolve",
          variant: action === "ignored" ? "danger" : "info",
          onConfirm: () => {
            void applyIssueStatus(issue, action, note, resolutionType);
          },
        });
        return;
      }
      await applyIssueStatus(issue, action, note, resolutionType);
    },
    [applyIssueStatus, confirmAction],
  );

  const addIssueNote = useCallback(
    async (issue: ReconciliationItem, note: string) => {
      setIssueBusy(true);
      try {
        const response = await fetch(
          `${baseUrl}/api/payments/providers/helcim/reconciliation/items/${issue.id}/notes`,
          {
            method: "POST",
            headers: {
              ...apiHeaders,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ note }),
          },
        );
        const body = (await response.json()) as { item?: ReconciliationItem; error?: string };
        if (!response.ok || !body.item) {
          throw new Error(body.error || `Note failed (${response.status})`);
        }
        updateSelectedIssue(body.item);
        toast("Note added.", "success");
      } catch (err) {
        toast(err instanceof Error ? err.message : "Note failed.", "error");
      } finally {
        setIssueBusy(false);
      }
    },
    [apiHeaders, toast, updateSelectedIssue],
  );

  const linkIssuePayment = useCallback(
    async (issue: ReconciliationItem, paymentTransactionId: string, note: string) => {
      confirmAction({
        title: "Link Payment?",
        message:
          "Link only when the Riverside payment and processor reference are the same payment. This will not create a payment or change the amount.",
        confirmLabel: "Link Payment",
        variant: "danger",
        onConfirm: () => {
          void (async () => {
            setIssueBusy(true);
            try {
              const response = await fetch(
                `${baseUrl}/api/payments/providers/helcim/reconciliation/items/${issue.id}/link-payment`,
                {
                  method: "POST",
                  headers: {
                    ...apiHeaders,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    payment_transaction_id: paymentTransactionId,
                    note,
                  }),
                },
              );
              const body = (await response.json()) as { item?: ReconciliationItem; error?: string };
              if (!response.ok || !body.item) {
                throw new Error(body.error || `Link failed (${response.status})`);
              }
              updateSelectedIssue(body.item);
              toast("Payment linked.", "success");
              await refresh();
            } catch (err) {
              toast(err instanceof Error ? err.message : "Link failed.", "error");
            } finally {
              setIssueBusy(false);
            }
          })();
        },
      });
    },
    [apiHeaders, confirmAction, refresh, toast, updateSelectedIssue],
  );

  const runSync = useCallback(
    async (kind: "batches" | "fees") => {
      if (!canSync) {
        toast("Payment sync requires payment sync access.", "error");
        return;
      }
      setSyncing(kind);
      try {
        const path =
          kind === "batches"
            ? "/api/payments/providers/helcim/settlements/sync"
            : "/api/payments/providers/helcim/fees/sync";
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: apiHeaders,
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Sync failed (${response.status})`);
        }
        toast(kind === "batches" ? "Batch sync finished." : "Fee sync finished.", "success");
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : "Sync failed.", "error");
      } finally {
        setSyncing(null);
      }
    },
    [apiHeaders, canSync, refresh, toast],
  );

  const pingDevice = useCallback(async (code: string) => {
    const normalized = code.trim();
    if (!normalized) return;
    try {
      await sendJson(`/api/payments/providers/helcim/terminal/devices/${encodeURIComponent(normalized)}/ping`, "POST");
      toast(`Ping sent to Helcim device ${normalized}.`, "success");
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Helcim device ping failed.", "error");
    }
  }, [refresh, sendJson, toast]);

  const recordHelcimRecoveryAction = useCallback(
    async (
      sourceKind: HelcimTerminalRecoverySourceKind,
      sourceId: string,
      action: HelcimTerminalRecoveryActionName,
      note: string,
    ) => {
      try {
        await sendJson("/api/payments/providers/helcim/terminal/recovery-actions", "POST", {
          source_kind: sourceKind,
          source_id: sourceId,
          action,
          note,
          metadata: { source: "payments_health" },
        });
        toast("Helcim review action recorded.", "success");
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : "Helcim review action could not be recorded.", "error");
      }
    },
    [refresh, sendJson, toast],
  );

  const recoverPaidParkedSale = useCallback(
    async (attempt: HelcimTerminalReviewAttempt, note: string, confirmation: string) => {
      try {
        if (!attempt.parked_sale_id) {
          throw new Error("No retained parked sale is available for this approval.");
        }
        const response = await sendJson<{ transaction_display_id: string }>(
          "/api/payments/providers/helcim/terminal/recover-paid-parked-sale",
          "POST",
          {
            parked_sale_id: attempt.parked_sale_id,
            payment_provider_attempt_id: attempt.id,
            confirmation,
            note,
          },
        );
        toast(`${response.transaction_display_id} recovered and linked to Helcim.`, "success");
        await refresh();
      } catch (error) {
        toast(error instanceof Error ? error.message : "Paid sale recovery failed.", "error");
        throw error;
      }
    },
    [refresh, sendJson, toast],
  );

  const recoverPaidOrderPayment = useCallback(
    async (
      attempt: HelcimTerminalReviewAttempt,
      targetTransactionDisplayId: string,
      note: string,
      confirmation: string,
    ) => {
      try {
        const response = await sendJson<{ target_transaction_display_id: string }>(
          "/api/payments/providers/helcim/terminal/recover-paid-order-payment",
          "POST",
          {
            target_transaction_display_id: targetTransactionDisplayId,
            payment_provider_attempt_id: attempt.id,
            confirmation,
            note,
          },
        );
        toast(
          `Payment recovered and linked to ${response.target_transaction_display_id}.`,
          "success",
        );
        await refresh();
      } catch (error) {
        toast(error instanceof Error ? error.message : "Order payment recovery failed.", "error");
        throw error;
      }
    },
    [refresh, sendJson, toast],
  );

  const replayFailedHelcimEvent = useCallback((eventId: string) => {
    if (!canSync) {
      toast("Webhook replay requires payment sync access.", "error");
      return;
    }
    confirmAction({
      title: "Replay Failed Helcim Update?",
      message:
        "Replay only after the configuration or data problem that caused this Helcim update to fail has been corrected.",
      confirmLabel: "Replay Update",
      variant: "danger",
      onConfirm: () => {
        void (async () => {
          try {
            await sendJson(`/api/payments/providers/helcim/events/${encodeURIComponent(eventId)}/replay`, "POST");
            toast("Helcim update replayed.", "success");
            await refresh();
          } catch (err) {
            toast(err instanceof Error ? err.message : "Helcim update replay failed.", "error");
          }
        })();
      },
    });
  }, [canSync, confirmAction, refresh, sendJson, toast]);

  const startStandaloneCardRefund = useCallback(
    (payload: { amountCents: number; originalTransactionId: number }) => {
      confirmAction({
        title: "Start Helcim Card Refund?",
        message:
          "This sends the refund to Helcim and records the provider attempt in ROS. It will not create a ROS sales refund or change a Transaction Record by itself.",
        confirmLabel: "Start Refund",
        variant: "danger",
        onConfirm: () => {
          void (async () => {
            setStandaloneRefundBusy(true);
            try {
              const attempt = await sendJson<HelcimAttemptResponse>(
                "/api/payments/providers/helcim/card/refund",
                "POST",
                {
                  amount_cents: payload.amountCents,
                  original_transaction_id: payload.originalTransactionId,
                  idempotency_key: createRefundIdempotencyKey(),
                },
              );
              setStandaloneRefundAttempt(attempt);
              toast(
                attempt.status === "approved" || attempt.status === "captured"
                  ? "Standalone Helcim refund approved and recorded."
                  : "Standalone Helcim refund recorded for review.",
                attempt.status === "failed" ? "error" : "success",
              );
              await refresh();
            } catch (err) {
              toast(err instanceof Error ? err.message : "Standalone refund could not be started.", "error");
            } finally {
              setStandaloneRefundBusy(false);
            }
          })();
        },
      });
    },
    [confirmAction, refresh, sendJson, toast],
  );

  const filteredTransactions = useMemo(() => {
    const query = transactionSearch.trim().toLowerCase();
    if (!query) return data.transactions;
    return data.transactions.filter((transaction) =>
      [
        transaction.payment_transaction_id,
        transaction.provider_transaction_id,
        transaction.provider_batch_id,
        transaction.payment_status,
        transaction.provider_status,
        transaction.match_status,
        transaction.transaction_display_id,
        transaction.customer_name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [data.transactions, transactionSearch]);

  const groupedIssues = useMemo(() => {
    const groups = new Map<string, ReconciliationItem[]>();
    for (const issue of data.issues) {
      const key = issue.issue_label || "Needs Review";
      groups.set(key, [...(groups.get(key) ?? []), issue]);
    }
    return Array.from(groups.entries());
  }, [data.issues]);

  const lastSuccess = data.runs.find((run) => run.status === "completed" || run.status === "success");
  const lastError = data.runs.find((run) => run.error_message);
  const reconciliationBadge = data.overview?.open_issue_count ?? data.issues.length;
  const depositBadge =
    data.deposits.reduce((total, deposit) => total + deposit.open_issue_count, 0) +
    data.unmatchedBatches.length +
    data.unmatchedDeposits.length;
  const healthBadge =
    (posSurface || !lastError ? 0 : 1) +
    (data.health?.failed_event_count ?? 0) +
    (data.health?.terminal_review_attempts.length ?? 0) +
    (data.health?.terminal_review_events.length ?? 0);

  return (
    <div className="flex flex-1 flex-col bg-app-bg">
      <header className="border-b border-app-border bg-app-surface px-4 py-5 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-app-accent text-white">
                <CreditCard size={22} aria-hidden />
              </div>
              <div>
                <h1 className="text-2xl font-black text-app-text">{posSurface ? "POS Payments" : "Payments"}</h1>
                <p className="text-sm font-medium text-app-text-muted">
                  {posSurface
                    ? "Today's card transactions, terminal status, and review items for closing the register."
                    : "Daily card activity, deposits, and items that need review."}
                </p>
              </div>
            </div>
          </div>
          {!posSurface ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runSync("batches")}
              disabled={syncing !== null || !canSync}
              title={!canSync ? "You do not have permission to perform this action" : undefined}
              className="inline-flex items-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
            >
              <RefreshCw size={16} className={syncing === "batches" ? "animate-spin" : ""} />
              Sync Batches
            </button>
            <button
              type="button"
              onClick={() => void runSync("fees")}
              disabled={syncing !== null || !canSync}
              title={!canSync ? "You do not have permission to perform this action" : undefined}
              className="inline-flex items-center gap-2 rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text transition hover:bg-app-surface-2 disabled:opacity-50"
            >
              <RefreshCw size={16} className={syncing === "fees" ? "animate-spin" : ""} />
              Sync Fees
            </button>
          </div>
          ) : null}
        </div>
        {!posSurface ? (
        <nav className="mt-5 flex gap-2 overflow-x-auto pb-1">
          <SectionButton id="overview" label="Overview" active={section === "overview"} onClick={setSection} />
          <SectionButton id="batches" label="Batches" active={section === "batches"} onClick={setSection} />
          <SectionButton id="deposits" label="Deposits" badge={depositBadge} active={section === "deposits"} onClick={setSection} />
          <SectionButton id="reconciliation" label="Reconciliation" badge={reconciliationBadge} active={section === "reconciliation"} onClick={setSection} />
          <SectionButton id="transactions" label="Transactions" active={section === "transactions"} onClick={setSection} />
          <SectionButton id="disputes" label="Disputes" active={section === "disputes"} onClick={setSection} />
          <SectionButton id="health" label="Health" badge={healthBadge} active={section === "health"} onClick={setSection} />
        </nav>
        ) : (
          <nav className="mt-5 flex gap-2 overflow-x-auto pb-1">
            <SectionButton id="transactions" label="Today" active={section === "transactions"} onClick={setSection} />
            <SectionButton id="refunds" label="Refund" active={section === "refunds"} onClick={setSection} />
            <SectionButton id="health" label="Terminal Health" badge={healthBadge} active={section === "health"} onClick={setSection} />
          </nav>
        )}
      </header>

      <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {loading ? (
          <div className="rounded-lg border border-app-border bg-app-surface p-8 text-sm font-semibold text-app-text-muted">
            Loading payments…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-5 text-sm font-semibold text-rose-700">
            {error}
          </div>
        ) : (
          <>
            {section === "overview" && (
              <OverviewPanel
                overview={data.overview}
                issues={data.issues}
                canSync={canSync}
                onViewIssues={() => setSection("reconciliation")}
                onSyncBatches={() => void runSync("batches")}
                onSyncFees={() => void runSync("fees")}
              />
            )}
            {section === "batches" && <BatchesPanel batches={data.batches} onOpenBatch={openBatch} />}
            {section === "deposits" && (
              <DepositsPanel
                deposits={data.deposits}
                unmatchedBatches={data.unmatchedBatches}
                unmatchedDeposits={data.unmatchedDeposits}
                canAdjust={canDepositAdjust}
                canReview={canDepositReview}
                busy={depositBusy}
                onCreateDeposit={createManualDeposit}
                onOpenDeposit={openDeposit}
                onRunReview={() => void runDepositReview()}
              />
            )}
            {section === "reconciliation" && (
              <ReconciliationPanel
                groups={groupedIssues}
                onOpenIssue={openIssue}
                onOpenPayment={openTransaction}
              />
            )}
            {section === "transactions" && (
              <TransactionsPanel
                transactions={filteredTransactions}
                search={transactionSearch}
                onSearch={setTransactionSearch}
                onOpenPayment={openTransaction}
                onOpenTransaction={onOpenTransactionInBackoffice}
                title={posSurface ? "Today's Transactions" : "Transactions"}
                empty={posSurface ? "No card transactions recorded today." : "No payments found."}
              />
            )}
            {section === "refunds" && posSurface && (
              <StandaloneRefundPanel
                busy={standaloneRefundBusy}
                latestAttempt={standaloneRefundAttempt}
                onStartRefund={startStandaloneCardRefund}
              />
            )}
            {section === "disputes" && !posSurface && (
              <DisputesPanel
                issues={data.issues}
                transactions={data.transactions}
                health={data.health}
                onOpenIssue={openIssue}
                onOpenPayment={openTransaction}
              />
            )}
            {section === "health" && (
              <HealthPanel
                surface={surface}
                overview={data.overview}
                runs={data.runs}
                health={data.health}
                terminalDevices={data.terminalDevices}
                cardTerminals={data.cardTerminals}
                terminalRouting={data.terminalRouting}
                terminalError={data.terminalError}
                lastSuccess={lastSuccess}
                lastError={lastError}
                depositAlertCount={depositBadge}
                reconciliationAlertCount={reconciliationBadge}
                canSync={canSync}
                canRecoveryReview={canReconcileReview}
                canRecoveryResolve={canReconcileResolve}
                onSyncBatches={() => void runSync("batches")}
                onSyncFees={() => void runSync("fees")}
                onPingDevice={(code) => void pingDevice(code)}
                onRecordRecoveryAction={recordHelcimRecoveryAction}
                onRecoverPaidParkedSale={recoverPaidParkedSale}
                onRecoverPaidOrderPayment={recoverPaidOrderPayment}
                onReplayFailedEvent={replayFailedHelcimEvent}
              />
            )}
          </>
        )}
      </main>

      <BatchDrawer
        batch={selectedBatch}
        detail={batchDetail}
        transactions={batchTransactions}
        issues={batchIssues}
        onClose={() => setSelectedBatch(null)}
        onOpenPayment={openTransaction}
        onOpenIssue={openIssue}
      />
      <TransactionDrawer
        paymentId={selectedPaymentId}
        detail={transactionDetail}
        onClose={() => setSelectedPaymentId(null)}
        onOpenIssue={openIssue}
      />
      <IssueDrawer
        issue={selectedIssue}
        candidates={issueCandidates}
        canReview={canReconcileReview}
        canResolve={canReconcileResolve}
        canLink={canReconcileLink}
        busy={issueBusy}
        onClose={() => setSelectedIssue(null)}
        onOpenPayment={openTransaction}
        onStatus={patchIssueStatus}
        onAddNote={addIssueNote}
        onLinkPayment={linkIssuePayment}
      />
      <DepositDrawer
        depositId={selectedDepositId}
        detail={depositDetail}
        unmatchedBatches={data.unmatchedBatches}
        busy={depositBusy}
        canReview={canDepositReview}
        canLink={canDepositLink}
        canAdjust={canDepositAdjust}
        onClose={() => setSelectedDepositId(null)}
        onLinkBatches={linkDepositBatches}
        onAddNote={addDepositNote}
        onReview={reviewDeposit}
        onReopen={reopenDeposit}
      />
      <ConfirmationModal
        isOpen={Boolean(confirmRequest)}
        onClose={() => setConfirmRequest(null)}
        onConfirm={() => {
          const request = confirmRequest;
          setConfirmRequest(null);
          request?.onConfirm();
        }}
        title={confirmRequest?.title ?? "Confirm"}
        message={confirmRequest?.message ?? ""}
        confirmLabel={confirmRequest?.confirmLabel ?? "Confirm"}
        variant={confirmRequest?.variant ?? "info"}
      />
    </div>
  );
}

function OverviewPanel({
  overview,
  issues,
  canSync,
  onViewIssues,
  onSyncBatches,
  onSyncFees,
}: {
  overview: OverviewResponse | null;
  issues: ReconciliationItem[];
  canSync: boolean;
  onViewIssues: () => void;
  onSyncBatches: () => void;
  onSyncFees: () => void;
}) {
  const missingPayments = issues.filter((issue) => issue.issue_label === "Missing Payment").length;
  const notInDeposit = issues.filter((issue) => issue.issue_label === "Not in Deposit").length;
  const noPaymentsToday = Number(overview?.card_sales_gross ?? 0) === 0;
  return (
    <div className="space-y-6">
      {noPaymentsToday ? (
        <EmptyState
          title="No payments yet today"
          body="Run sync to check for updates when card activity begins."
          compact
        />
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Card Sales Today" value={money(overview?.card_sales_gross, "$0.00")} />
        <MetricCard
          label="Known Fees"
          value={money(overview?.known_fees, "Fee not ready")}
          note={`${overview?.fee_not_ready_count ?? 0} payments waiting for fees`}
          tone={(overview?.fee_not_ready_count ?? 0) > 0 ? "neutral" : "good"}
        />
        <MetricCard
          label="Expected Net"
          value={money(overview?.known_net, "Net not ready")}
          note={`${overview?.net_not_ready_count ?? 0} payments waiting for net`}
          tone={(overview?.net_not_ready_count ?? 0) > 0 ? "neutral" : "good"}
        />
        <MetricCard
          label="Expected Deposit"
          value={money(overview?.expected_deposit_from_batches, "Deposit not ready")}
          note="From settled batch data only"
        />
        <MetricCard
          label="Needs Review"
          value={`${overview?.open_issue_count ?? 0}`}
          note={`${overview?.critical_issue_count ?? 0} critical`}
          tone={(overview?.critical_issue_count ?? 0) > 0 ? "danger" : (overview?.open_issue_count ?? 0) > 0 ? "warning" : "good"}
        />
        <MetricCard
          label="Sync Status"
          value={overview?.last_settlement_sync?.status ?? "Not ready"}
          note={overview?.last_settlement_sync ? shortDateTime(overview.last_settlement_sync.started_at) : "No sync yet"}
          tone={overview?.helcim_api_active ? "good" : "warning"}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <WarningLine count={missingPayments} label="Missing payments" />
        <WarningLine count={notInDeposit} label="Not in deposit" />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSyncBatches} disabled={!canSync} title={!canSync ? "You do not have permission to perform this action" : undefined} className="rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          Sync Batches
        </button>
        <button type="button" onClick={onSyncFees} disabled={!canSync} title={!canSync ? "You do not have permission to perform this action" : undefined} className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text disabled:opacity-50">
          Sync Fees
        </button>
        <button type="button" onClick={onViewIssues} className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text">
          View Issues
        </button>
      </div>
    </div>
  );
}

function WarningLine({ count, label }: { count: number; label: string }) {
  const clear = count === 0;
  return (
    <div className={`flex items-center gap-3 rounded-lg border p-4 ${clear ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
      {clear ? <CheckCircle2 size={18} className="text-emerald-700" /> : <AlertTriangle size={18} className="text-amber-700" />}
      <div>
        <div className="text-sm font-black text-app-text">{label}</div>
        <div className="text-xs font-semibold text-app-text-muted">{clear ? "Clear" : `${count} need review`}</div>
      </div>
    </div>
  );
}

function BatchesPanel({ batches, onOpenBatch }: { batches: BatchRow[]; onOpenBatch: (batch: BatchRow) => void }) {
  return (
    <DataTable
      empty="No batches found."
      headers={["Batch #", "Status", "Closed", "Gross", "Fees", "Expected Deposit", "Transactions", "Issues"]}
      rows={batches.map((batch) => ({
        key: batch.id,
        onClick: () => onOpenBatch(batch),
        cells: [
          batch.provider_batch_id,
          <StatusPill value={batch.status ?? "Not ready"} />,
          shortDateTime(batch.closed_at),
          money(batch.gross_amount, "Not ready"),
          money(batch.fee_amount, "Fee not ready"),
          money(batch.net_amount, "Deposit not ready"),
          String(batch.transaction_count ?? 0),
          batch.issue_count > 0 ? `${batch.issue_count} needs review` : "Clear",
        ],
      }))}
    />
  );
}

function DepositsPanel({
  deposits,
  unmatchedBatches,
  unmatchedDeposits,
  canAdjust,
  canReview,
  busy,
  onCreateDeposit,
  onOpenDeposit,
  onRunReview,
}: {
  deposits: DepositRow[];
  unmatchedBatches: BatchRow[];
  unmatchedDeposits: DepositRow[];
  canAdjust: boolean;
  canReview: boolean;
  busy: boolean;
  onCreateDeposit: (payload: {
    posted_at: string;
    amount: string;
    source_reference?: string;
    note?: string;
  }) => void;
  onOpenDeposit: (deposit: DepositRow) => void;
  onRunReview: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [postedDate, setPostedDate] = useState(todayYmd());
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const expectedTotal = sumMoney(deposits.map((deposit) => deposit.expected_amount));
  const actualTotal = sumMoney(deposits.map((deposit) => deposit.amount));
  const openIssues = deposits.reduce((total, deposit) => total + deposit.open_issue_count, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Actual Bank Deposits" value={money(actualTotal, "$0.00")} />
        <MetricCard label="Linked Expected Deposits" value={money(expectedTotal, "Deposit not ready")} />
        <MetricCard label="Unmatched Expected" value={`${unmatchedBatches.length}`} tone={unmatchedBatches.length > 0 ? "warning" : "good"} />
        <MetricCard label="Needs Review" value={`${openIssues}`} tone={openIssues > 0 ? "warning" : "good"} />
      </div>

      <div className="flex flex-wrap gap-2">
        {canAdjust ? (
          <button type="button" onClick={() => setShowAdd((value) => !value)} className="rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white">
            Add Manual Deposit
          </button>
        ) : null}
        {canReview ? (
          <button type="button" onClick={onRunReview} disabled={busy} className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text disabled:opacity-50">
            Refresh Deposit Review
          </button>
        ) : null}
      </div>

      {showAdd ? (
        <section className="rounded-lg border border-app-border bg-app-surface p-4">
          <h2 className="text-base font-black text-app-text">Add Actual Bank Deposit</h2>
          <p className="mt-1 text-sm font-semibold text-app-text-muted">
            This records bank-cleared money for matching only. It does not post to QuickBooks or change payment totals.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <label className="text-sm font-semibold text-app-text">
              Posted Date
              <input value={postedDate} onChange={(event) => setPostedDate(event.target.value)} type="date" className="mt-1 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 outline-none focus:border-app-accent" />
            </label>
            <label className="text-sm font-semibold text-app-text">
              Actual Amount
              <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 outline-none focus:border-app-accent" />
            </label>
            <label className="text-sm font-semibold text-app-text">
              Reference
              <input value={reference} onChange={(event) => setReference(event.target.value)} className="mt-1 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 outline-none focus:border-app-accent" />
            </label>
            <label className="text-sm font-semibold text-app-text">
              Note
              <input value={note} onChange={(event) => setNote(event.target.value)} className="mt-1 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 outline-none focus:border-app-accent" />
            </label>
          </div>
          <button
            type="button"
            disabled={busy || !amount.trim()}
            onClick={() => {
              onCreateDeposit({
                posted_at: new Date(`${postedDate}T12:00:00`).toISOString(),
                amount,
                source_reference: reference.trim() || undefined,
                note: note.trim() || undefined,
              });
              setAmount("");
              setReference("");
              setNote("");
              setShowAdd(false);
            }}
            className="mt-4 rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            Save Actual Bank Deposit
          </button>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-black text-app-text">Deposits</h2>
        <DataTable
          empty="No deposits recorded yet."
          headers={["Posted Date", "Source", "Actual Amount", "Expected Amount", "Difference", "Linked Batches", "Status", "Needs Review"]}
          rows={deposits.map((deposit) => ({
            key: deposit.id,
            onClick: () => onOpenDeposit(deposit),
            cells: [
              shortDate(deposit.posted_at),
              staffLabel(deposit.source_system),
              money(deposit.amount, "$0.00"),
              money(deposit.expected_amount, "Not linked"),
              differenceLabel(deposit.difference),
              String(deposit.linked_batch_count),
              <StatusPill value={deposit.status} />,
              deposit.open_issue_count > 0 ? `${deposit.open_issue_count} needs review` : "Clear",
            ],
          }))}
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-lg font-black text-app-text">Unmatched Expected Batches</h2>
          <DataTable
            empty="No unmatched expected batches."
            headers={["Batch #", "Expected Deposit", "Expected Date", "Status"]}
            rows={unmatchedBatches.map((batch) => ({
              key: batch.id,
              cells: [
                batch.provider_batch_id,
                money(batch.net_amount, "Deposit not ready"),
                shortDate(batch.expected_deposit_at ?? batch.settled_at ?? batch.closed_at),
                <StatusPill value={batch.status} />,
              ],
            }))}
          />
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-black text-app-text">Unmatched Actual Deposits</h2>
          <DataTable
            empty="No unmatched actual deposits."
            headers={["Posted Date", "Actual Amount", "Reference", "Status"]}
            rows={unmatchedDeposits.map((deposit) => ({
              key: deposit.id,
              onClick: () => onOpenDeposit(deposit),
              cells: [
                shortDate(deposit.posted_at),
                money(deposit.amount, "$0.00"),
                deposit.source_reference ?? "Manual entry",
                <StatusPill value={deposit.status} />,
              ],
            }))}
          />
        </section>
      </div>
    </div>
  );
}

function ReconciliationPanel({
  groups,
  onOpenIssue,
  onOpenPayment,
}: {
  groups: [string, ReconciliationItem[]][];
  onOpenIssue: (issue: ReconciliationItem) => void;
  onOpenPayment: (paymentId: string | null) => void;
}) {
  if (groups.length === 0) {
    return <EmptyState title="No issues — everything matches" body="Review issues before end of day when they appear." />;
  }
  return (
    <div className="space-y-5">
      {groups.map(([label, items]) => (
        <section key={label} className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-black text-app-text">{label}</h2>
            <span className="text-sm font-semibold text-app-text-muted">{items.length}</span>
          </div>
          <DataTable
            empty="No issues in this group."
            headers={["Issue", "Severity", "Amount", "Reference", "When", "Action"]}
            rows={items.map((issue) => ({
              key: issue.id,
              onClick: () => onOpenIssue(issue),
              cells: [
                issue.message || issue.issue_label,
                <StatusPill value={issue.severity} />,
                money(issue.amount, "Not ready"),
                issue.reference ?? "Not ready",
                shortDate(issue.created_at),
                <div className="flex flex-wrap gap-3">
                  <button type="button" className="text-sm font-bold text-app-accent" onClick={(event) => { event.stopPropagation(); onOpenIssue(issue); }}>
                    Open Issue
                  </button>
                  <button type="button" className="text-sm font-bold text-app-text-muted" onClick={(event) => { event.stopPropagation(); onOpenPayment(issue.payment_transaction_id); }}>
                    View Payment
                  </button>
                </div>,
              ],
            }))}
          />
        </section>
      ))}
    </div>
  );
}

function TransactionsPanel({
  transactions,
  search,
  onSearch,
  onOpenPayment,
  onOpenTransaction,
  title = "Transactions",
  empty = "No payments found.",
}: {
  transactions: TransactionRow[];
  search: string;
  onSearch: (value: string) => void;
  onOpenPayment: (paymentId: string | null) => void;
  onOpenTransaction?: (transactionId: string) => void;
  title?: string;
  empty?: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-black text-app-text">{title}</h2>
        <p className="mt-1 text-sm font-semibold text-app-text-muted">
          Review payment records and open any row for provider, batch, and reconciliation details.
        </p>
      </div>
      <label className="flex max-w-md items-center gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text">
        <Search size={16} className="text-app-text-muted" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search payments"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-app-text-muted"
        />
      </label>
      <DataTable
        empty={empty}
        headers={["Date", "Amount", "Status", "Type", "Customer", "Batch", "Fee", "Net", "Match", "ROS Transaction"]}
        rows={transactions.map((transaction) => ({
          key:
            transaction.payment_transaction_id ??
            transaction.provider_transaction_id ??
            `${transaction.payment_date}-${transaction.amount}`,
          onClick: () => onOpenPayment(transaction.payment_transaction_id),
          cells: [
            shortDateTime(transaction.payment_date),
            money(transaction.amount, "$0.00"),
            <StatusPill value={transaction.provider_status ?? transaction.payment_status} />,
            staffLabel(transaction.transaction_type ?? "Purchase"),
            transaction.customer_name ?? "Customer not linked",
            transaction.provider_batch_id ?? "Not in deposit",
            transaction.fee_amount ? money(transaction.fee_amount) : "Fee not ready",
            transaction.net_amount ? money(transaction.net_amount) : "Net not ready",
            <StatusPill value={transaction.match_status ?? "Not ready"} />,
            transaction.transaction_id && onOpenTransaction ? (
              <button
                type="button"
                className="text-sm font-bold text-app-accent hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenTransaction(transaction.transaction_id!);
                }}
              >
                {transaction.transaction_display_id ?? "Open Transaction"}
              </button>
            ) : transaction.payment_transaction_id || transaction.provider_transaction_id ? (
              <span className="text-sm font-semibold text-amber-700">Missing ROS TXN</span>
            ) : (
              <span className="text-sm font-semibold text-app-text-muted">No TXN</span>
            ),
          ],
        }))}
      />
    </div>
  );
}

function StandaloneRefundPanel({
  busy,
  latestAttempt,
  onStartRefund,
}: {
  busy: boolean;
  latestAttempt: HelcimAttemptResponse | null;
  onStartRefund: (payload: { amountCents: number; originalTransactionId: number }) => void;
}) {
  const [amount, setAmount] = useState("");
  const [originalTransactionId, setOriginalTransactionId] = useState("");
  const amountCents = dollarsInputToCents(amount);
  const providerTransactionId = Number.parseInt(originalTransactionId.trim(), 10);
  const validProviderTransactionId = Number.isFinite(providerTransactionId) && providerTransactionId > 0;
  const canSubmit = !busy && amountCents !== null && amountCents > 0 && validProviderTransactionId;

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-app-border bg-app-surface p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <RotateCcw size={18} className="text-app-accent" aria-hidden />
              <h2 className="text-lg font-black text-app-text">Standalone Helcim Refund</h2>
            </div>
            <p className="mt-1 text-sm font-semibold text-app-text-muted">
              Refund an existing Helcim transaction from the register and keep the provider attempt in ROS.
            </p>
          </div>
          <StatusPill value={latestAttempt?.status ?? "Ready"} />
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <label className="text-sm font-semibold text-app-text">
            Refund Amount
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="mt-1 min-h-11 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-base font-bold text-app-text outline-none focus:border-app-accent"
            />
          </label>
          <label className="text-sm font-semibold text-app-text">
            Original Helcim Transaction ID
            <input
              value={originalTransactionId}
              onChange={(event) => setOriginalTransactionId(event.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              placeholder="Helcim transaction ID"
              className="mt-1 min-h-11 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-base font-bold text-app-text outline-none focus:border-app-accent"
            />
          </label>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit || amountCents === null) return;
              onStartRefund({
                amountCents,
                originalTransactionId: providerTransactionId,
              });
            }}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
          >
            <RotateCcw size={16} aria-hidden />
            Start Refund
          </button>
        </div>

        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm font-semibold text-app-text-muted">
          This is for provider-side card refunds where the original Helcim transaction ID is known.
          Use the checkout drawer Card Refund path when the original card and customer are present for a terminal refund.
        </div>
      </section>

      {latestAttempt ? (
        <section className="rounded-lg border border-app-border bg-app-surface p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-black text-app-text">Latest Register Refund</h2>
              <p className="mt-1 text-sm font-semibold text-app-text-muted">
                Provider attempt {latestAttempt.id}
              </p>
            </div>
            <StatusPill value={latestAttempt.status} />
          </div>
          <div className="mt-4 grid gap-3 text-sm font-semibold text-app-text-muted md:grid-cols-2 xl:grid-cols-4">
            <span>Amount {centsMoney(latestAttempt.amount_cents)}</span>
            <span>Helcim transaction {latestAttempt.provider_transaction_id ?? "Not returned yet"}</span>
            <span>Provider payment {latestAttempt.provider_payment_id ?? "Not returned yet"}</span>
            <span>{shortDateTime(latestAttempt.completed_at ?? latestAttempt.created_at)}</span>
            {latestAttempt.error_message || latestAttempt.safe_message ? (
              <span className="md:col-span-2 xl:col-span-4">
                {latestAttempt.safe_message ?? latestAttempt.error_message}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function DisputesPanel({
  issues,
  transactions,
  health,
  onOpenIssue,
  onOpenPayment,
}: {
  issues: ReconciliationItem[];
  transactions: TransactionRow[];
  health: EventsHealth | null;
  onOpenIssue: (issue: ReconciliationItem) => void;
  onOpenPayment: (paymentId: string | null) => void;
}) {
  const disputeIssues = issues.filter((issue) => {
    const text = [
      issue.issue_label,
      issue.item_type,
      issue.message,
      issue.reference,
      issue.resolution_type,
      issue.resolution_note,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /dispute|chargeback|duplicate|refund|required|reverse/.test(text);
  });
  const disputeTransactions = transactions.filter((transaction) => {
    const text = [
      transaction.transaction_type,
      transaction.provider_status,
      transaction.payment_status,
      transaction.match_status,
      transaction.provider_transaction_id,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /dispute|chargeback|refund|reverse|duplicate|declined/.test(text);
  });
  const recoveryActions = [
    ...(health?.terminal_review_attempts ?? []),
    ...(health?.terminal_review_events ?? []),
  ].flatMap((item) =>
    item.recovery_actions
      .filter((action) => action.action === "duplicate_suspected" || action.action === "refund_required")
      .map((action) => ({
        ...action,
        label: item.provider_transaction_id ?? item.label,
      })),
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard label="Open Dispute Signals" value={`${disputeIssues.length}`} tone={disputeIssues.length > 0 ? "warning" : "good"} />
        <MetricCard label="Refund / Reverse Rows" value={`${disputeTransactions.length}`} tone={disputeTransactions.length > 0 ? "warning" : "good"} />
        <MetricCard label="Terminal Recovery Flags" value={`${recoveryActions.length}`} tone={recoveryActions.length > 0 ? "warning" : "good"} />
      </div>

      <section className="rounded-lg border border-app-border bg-app-surface p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldAlert size={18} className="text-app-accent" aria-hidden />
              <h2 className="text-lg font-black text-app-text">Dispute Workbench</h2>
            </div>
            <p className="mt-1 text-sm font-semibold text-app-text-muted">
              Review chargeback, duplicate, refund-required, and reversal signals without leaving Payments.
            </p>
          </div>
          <StatusPill value={disputeIssues.length + recoveryActions.length > 0 ? "Needs Review" : "Clear"} />
        </div>
        <div className="mt-4 rounded-lg border border-app-border bg-app-bg p-4 text-sm font-semibold text-app-text-muted">
          Helcim documents card transactions, refunds, reverses, webhooks, and hardware actions for the public API. A dispute case response API is not present in the current Helcim developer index, so this view keeps ROS review, notes, recovery flags, and payment links in one place until Helcim exposes a supported dispute-response endpoint.
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-black text-app-text">Review Items</h2>
        <DataTable
          empty="No dispute review items found."
          headers={["Issue", "Severity", "Amount", "Reference", "When", "Action"]}
          rows={disputeIssues.map((issue) => ({
            key: issue.id,
            onClick: () => onOpenIssue(issue),
            cells: [
              issue.message || issue.issue_label,
              <StatusPill value={issue.severity} />,
              money(issue.amount, "Not ready"),
              issue.reference ?? "Not ready",
              shortDate(issue.created_at),
              <button
                type="button"
                className="text-sm font-bold text-app-accent"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenIssue(issue);
                }}
              >
                Open Issue
              </button>,
            ],
          }))}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-black text-app-text">Refunds, Reverses, and Duplicates</h2>
        <DataTable
          empty="No refund, reversal, duplicate, or dispute-like payments found."
          headers={["Date", "Amount", "Status", "Type", "Customer", "Provider Ref", "Match"]}
          rows={disputeTransactions.map((transaction) => ({
            key:
              transaction.payment_transaction_id ??
              transaction.provider_transaction_id ??
              `${transaction.payment_date}-${transaction.amount}`,
            onClick: () => onOpenPayment(transaction.payment_transaction_id),
            cells: [
              shortDateTime(transaction.payment_date),
              money(transaction.amount, "$0.00"),
              <StatusPill value={transaction.provider_status ?? transaction.payment_status} />,
              staffLabel(transaction.transaction_type ?? "Payment"),
              transaction.customer_name ?? "Customer not linked",
              transaction.provider_transaction_id ?? "Not ready",
              <StatusPill value={transaction.match_status ?? "Not ready"} />,
            ],
          }))}
        />
      </section>

      {recoveryActions.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-black text-app-text">Terminal Recovery Flags</h2>
          <DataTable
            empty="No recovery flags found."
            headers={["Flag", "Reference", "Note", "When"]}
            rows={recoveryActions.map((action) => ({
              key: action.id,
              cells: [
                staffLabel(action.action),
                action.label,
                action.note ?? "No note",
                shortDateTime(action.created_at),
              ],
            }))}
          />
        </section>
      ) : null}
    </div>
  );
}

function HealthPanel({
  surface = "backoffice",
  overview,
  runs,
  health,
  terminalDevices,
  cardTerminals,
  terminalRouting,
  terminalError,
  lastSuccess,
  lastError,
  depositAlertCount,
  reconciliationAlertCount,
  canSync,
  canRecoveryReview,
  canRecoveryResolve,
  onSyncBatches,
  onSyncFees,
  onPingDevice,
  onRecordRecoveryAction,
  onRecoverPaidParkedSale,
  onRecoverPaidOrderPayment,
  onReplayFailedEvent,
}: {
  surface?: "backoffice" | "pos";
  overview: OverviewResponse | null;
  runs: SettlementRun[];
  health: EventsHealth | null;
  terminalDevices: HelcimDevice[];
  cardTerminals: HelcimCardTerminal[];
  terminalRouting: HelcimTerminalRouting | null;
  terminalError: string | null;
  lastSuccess: SettlementRun | undefined;
  lastError: SettlementRun | undefined;
  depositAlertCount: number;
  reconciliationAlertCount: number;
  canSync: boolean;
  canRecoveryReview: boolean;
  canRecoveryResolve: boolean;
  onSyncBatches: () => void;
  onSyncFees: () => void;
  onPingDevice: (code: string) => void;
  onReplayFailedEvent: (eventId: string) => void;
  onRecordRecoveryAction: (
    sourceKind: HelcimTerminalRecoverySourceKind,
    sourceId: string,
    action: HelcimTerminalRecoveryActionName,
    note: string,
  ) => Promise<void>;
  onRecoverPaidParkedSale: (
    attempt: HelcimTerminalReviewAttempt,
    note: string,
    confirmation: string,
  ) => Promise<void>;
  onRecoverPaidOrderPayment: (
    attempt: HelcimTerminalReviewAttempt,
    targetTransactionDisplayId: string,
    note: string,
    confirmation: string,
  ) => Promise<void>;
}) {
  const posSurface = surface === "pos";
  const terminalReviewAttempts = health?.terminal_review_attempts ?? [];
  const terminalReviewEvents = health?.terminal_review_events ?? [];
  const [recoveryNoteAttempt, setRecoveryNoteAttempt] = useState<HelcimTerminalReviewAttempt | null>(null);
  const [recoveryConfirmAttempt, setRecoveryConfirmAttempt] = useState<HelcimTerminalReviewAttempt | null>(null);
  const [recoveryNote, setRecoveryNote] = useState("");
  const [orderRecoveryAttempt, setOrderRecoveryAttempt] = useState<HelcimTerminalReviewAttempt | null>(null);
  const [orderRecoveryNoteAttempt, setOrderRecoveryNoteAttempt] = useState<HelcimTerminalReviewAttempt | null>(null);
  const [orderRecoveryConfirmAttempt, setOrderRecoveryConfirmAttempt] = useState<HelcimTerminalReviewAttempt | null>(null);
  const [orderRecoveryTarget, setOrderRecoveryTarget] = useState("");
  const [orderRecoveryNote, setOrderRecoveryNote] = useState("");
  const unlinkedApprovalCount = terminalReviewAttempts.length + terminalReviewEvents.length;
  const paymentAlertCount =
    (posSurface || !lastError ? 0 : 1) +
    (health?.failed_event_count ?? 0) +
    unlinkedApprovalCount +
    (posSurface ? 0 : depositAlertCount + reconciliationAlertCount);
  const lastChecked =
    (posSurface ? null : runs[0]?.completed_at ?? runs[0]?.started_at) ??
    health?.last_event_at ??
    overview?.last_fee_sync;
  const alertRows = [
    !posSurface && lastError
      ? {
          label: "Sync failed",
          detail: lastError.error_message ?? "The latest batch sync needs review.",
          tone: "danger" as const,
        }
      : null,
    (health?.failed_event_count ?? 0) > 0
      ? {
          label: "Helcim update failed",
          detail: health?.last_failed_message ?? `${health?.failed_event_count ?? 0} Helcim update(s) failed processing.`,
          tone: "danger" as const,
        }
      : null,
    unlinkedApprovalCount > 0
      ? {
          label: "Approved card not attached",
          detail: `${unlinkedApprovalCount} Helcim card approval(s) have no matching ROS purchase or refund payment row.`,
          tone: "warning" as const,
        }
      : null,
    !posSurface && reconciliationAlertCount > 0
      ? {
          label: "Payment issues need review",
          detail: `${reconciliationAlertCount} payment issue(s) are open.`,
          tone: "warning" as const,
        }
      : null,
    !posSurface && depositAlertCount > 0
      ? {
          label: "Deposit needs review",
          detail: `${depositAlertCount} deposit item(s) need review.`,
          tone: "warning" as const,
        }
      : null,
  ].filter(Boolean) as { label: string; detail: string; tone: "warning" | "danger" }[];

  return (
    <div className="space-y-6">
      {posSurface ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Terminal Routing" value={terminalRouting ? "Loaded" : "Not ready"} tone={terminalRouting ? "good" : "warning"} />
          <MetricCard label="Unlinked Approvals" value={`${unlinkedApprovalCount}`} tone={unlinkedApprovalCount > 0 ? "warning" : "good"} />
          <MetricCard label="Recent Updates" value={`${health?.recent_event_count ?? 0}`} />
          <MetricCard label="Last Update" value={shortDateTime(health?.last_event_at)} />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Helcim Connection" value={overview?.helcim_api_active ? "Connected" : "Not active"} tone={overview?.helcim_api_active ? "good" : "warning"} />
          <MetricCard label="Last Sync" value={runs[0] ? shortDateTime(runs[0].started_at) : "Not ready"} note={staffLabel(runs[0]?.status)} />
          <MetricCard label="Last Success" value={lastSuccess ? shortDateTime(lastSuccess.completed_at ?? lastSuccess.started_at) : "Not ready"} />
          <MetricCard label="Last Error" value={lastError?.error_message ?? "Clear"} tone={lastError ? "warning" : "good"} />
        </div>
      )}
      <div className="rounded-lg border border-app-border bg-app-surface p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-app-text">Payment Alerts</h2>
            <p className="mt-1 text-sm font-semibold text-app-text-muted">
              {posSurface
                ? `Last checked ${shortDateTime(lastChecked)}. Unlinked Helcim approvals can be reviewed during close without blocking close.`
                : `Last checked ${shortDateTime(lastChecked)}. Alerts do not close issues or change payment totals.`}
            </p>
          </div>
          <StatusPill value={paymentAlertCount > 0 ? "Needs Review" : "Clear"} />
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {alertRows.length === 0 ? (
            <EmptyState
              title="No payment alerts right now"
              body={posSurface ? "No approved Helcim card payments are missing from ROS." : "Payments, deposits, and updates are clear right now."}
              compact
            />
          ) : (
            alertRows.map((alert) => (
              <div
                key={alert.label}
                className={`rounded-lg border p-4 ${
                  alert.tone === "danger"
                    ? "border-rose-500/30 bg-rose-500/10"
                    : "border-amber-500/30 bg-amber-500/10"
                }`}
              >
                <div className="text-sm font-black text-app-text">{alert.label}</div>
                <div className="mt-1 text-sm font-semibold text-app-text-muted">{alert.detail}</div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="rounded-lg border border-app-border bg-app-surface p-5">
        <h2 className="text-lg font-black text-app-text">Payment Updates</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <MetricCard label="Recent Updates" value={`${health?.recent_event_count ?? 0}`} />
          <MetricCard label="Failed Updates" value={`${health?.failed_event_count ?? 0}`} tone={(health?.failed_event_count ?? 0) > 0 ? "warning" : "good"} />
          <MetricCard label="No Action Needed" value={`${health?.ignored_event_count ?? 0}`} />
          <MetricCard label="Last Update" value={shortDateTime(health?.last_event_at)} />
        </div>
        {health?.failed_event_count ? (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm font-semibold text-app-text-muted">
            <div className="font-black text-app-text">Helcim update failed</div>
            <div className="mt-1">{health.last_failed_message ?? "A signed Helcim update could not be processed."}</div>
            {!posSurface && canSync && health.last_failed_event_id ? (
              <button
                type="button"
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-app-surface px-3 py-2 text-xs font-black uppercase tracking-widest text-app-text"
                onClick={() => onReplayFailedEvent(health.last_failed_event_id as string)}
              >
                <RotateCcw size={14} aria-hidden />
                Replay Failed Update
              </button>
            ) : null}
          </div>
        ) : health && ["not_configured", "missing_secret", "not_receiving"].includes(health.webhook_delivery_status) ? (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm font-semibold text-app-text-muted">
            <div className="font-black text-app-text">{health.webhook_delivery_label}</div>
            <div className="mt-1">{health.webhook_delivery_detail}</div>
            <div className="mt-2 font-black text-app-text">Action: {health.webhook_delivery_action}</div>
          </div>
        ) : health?.webhook_delivery_status === "receiving" ? (
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm font-semibold text-app-text-muted">
            <div className="font-black text-app-text">{health.webhook_delivery_label}</div>
            <div className="mt-1">{health.webhook_delivery_detail}</div>
          </div>
        ) : null}
      </div>
      <div className="rounded-lg border border-app-border bg-app-surface p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-app-text">Helcim Terminal Review</h2>
            <p className="mt-1 text-sm font-semibold text-app-text-muted">
              Only approved Helcim card purchases or refunds missing from ROS appear here.
            </p>
          </div>
          <StatusPill value={unlinkedApprovalCount > 0 ? "Needs Review" : "Clear"} />
        </div>
        {unlinkedApprovalCount === 0 ? (
          <div className="mt-4">
            <EmptyState title="No unlinked Helcim approvals" body="Every approved Helcim card payment currently known to ROS is attached or cleared." compact />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {terminalReviewAttempts.length > 0 ? (
              <section className="space-y-3">
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text-muted">Terminal Attempts</h3>
                <div className="grid gap-3 lg:grid-cols-2">
                  {terminalReviewAttempts.map((attempt) => (
                    <div key={attempt.id} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="text-sm font-black text-app-text">{attempt.label}</div>
                          <div className="mt-1 text-xs font-semibold text-app-text-muted">
                            {money(attempt.amount)} {attempt.currency.toUpperCase()} ·{" "}
                            {attempt.register_lane ? `Register #${attempt.register_lane}` : "Register not linked"} ·{" "}
                            {shortDateTime(attempt.created_at)}
                          </div>
                        </div>
                        <StatusPill value={attempt.status} />
                      </div>
                      <p className="mt-3 text-sm font-semibold text-app-text-muted">{attempt.detail}</p>
                      {attempt.parked_sale_id && attempt.parked_sale_match_count === 1 ? (
                        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                          <div className="text-sm font-black text-app-text">Exact retained cart found</div>
                          <div className="mt-1 text-xs font-semibold text-app-text-muted">
                            {attempt.parked_customer_name || "Linked customer"} · {attempt.parked_sale_label || "Parked sale"} · {money(attempt.amount)}
                          </div>
                          {canRecoveryResolve ? (
                            <button
                              type="button"
                              className="mt-3 rounded-lg bg-app-accent px-3 py-2 text-sm font-black text-white"
                              onClick={() => setRecoveryNoteAttempt(attempt)}
                            >
                              Recover Paid Sale
                            </button>
                          ) : null}
                        </div>
                      ) : attempt.parked_sale_match_count > 1 ? (
                        <div className="mt-3 text-xs font-bold text-amber-800">More than one retained cart matches. Manual review is required.</div>
                      ) : canRecoveryResolve ? (
                        <div className="mt-3 rounded-lg border border-app-border bg-app-surface p-3">
                          <div className="text-sm font-black text-app-text">Payment for an existing order?</div>
                          <div className="mt-1 text-xs font-semibold text-app-text-muted">
                            Use only when the terminal receipt and customer account confirm the exact target Transaction Record.
                          </div>
                          <button
                            type="button"
                            className="mt-3 rounded-lg border border-app-accent px-3 py-2 text-sm font-black text-app-accent"
                            onClick={() => setOrderRecoveryAttempt(attempt)}
                          >
                            Recover Order Payment
                          </button>
                        </div>
                      ) : null}
                      <div className="mt-3 grid gap-2 text-xs font-semibold text-app-text-muted sm:grid-cols-2">
                        <span>Terminal {attempt.terminal_id ?? attempt.device_id ?? "Not ready"}</span>
                        <span>Provider transaction {attempt.provider_transaction_id ?? "Not attached"}</span>
                        {attempt.error_message ? <span className="sm:col-span-2">{attempt.error_message}</span> : null}
                      </div>
                      <HelcimRecoveryActionPanel
                        sourceKind="payment_provider_attempt"
                        sourceId={attempt.id}
                        actions={attempt.recovery_actions}
                        canReview={canRecoveryReview}
                        canResolve={canRecoveryResolve}
                        onRecord={onRecordRecoveryAction}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            {terminalReviewEvents.length > 0 ? (
              <section className="space-y-3">
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text-muted">Provider Events</h3>
                <div className="grid gap-3 lg:grid-cols-2">
                  {terminalReviewEvents.map((event) => (
                    <div key={event.id} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="text-sm font-black text-app-text">{event.label}</div>
                          <div className="mt-1 text-xs font-semibold text-app-text-muted">
                            {staffLabel(event.event_type)} · {shortDateTime(event.received_at)}
                          </div>
                        </div>
                        <StatusPill value={event.processing_status} />
                      </div>
                      <p className="mt-3 text-sm font-semibold text-app-text-muted">{event.detail}</p>
                      <div className="mt-3 grid gap-2 text-xs font-semibold text-app-text-muted sm:grid-cols-2">
                        <span>Provider transaction {event.provider_transaction_id ?? "Not attached"}</span>
                        <span>Match {event.match_type ?? "none"}</span>
                        {event.error_message ? <span className="sm:col-span-2">{event.error_message}</span> : null}
                      </div>
                      <HelcimRecoveryActionPanel
                        sourceKind="helcim_event"
                        sourceId={event.id}
                        actions={event.recovery_actions}
                        canReview={canRecoveryReview}
                        canResolve={canRecoveryResolve}
                        onRecord={onRecordRecoveryAction}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
      <div className="rounded-lg border border-app-border bg-app-surface p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-app-text">Terminal Control</h2>
            <p className="mt-1 text-sm font-semibold text-app-text-muted">
              {posSurface
                ? "Check configured terminal routing and device status."
                : "Device codes come from Helcim API mode. Ping checks whether the device is listening."}
            </p>
          </div>
          <StatusPill value={terminalError ? "Needs Review" : terminalDevices.length > 0 ? "Ready" : "Not Ready"} />
        </div>
        {terminalError ? (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm font-semibold text-app-text-muted">
            {terminalError}
          </div>
        ) : null}
        {terminalRouting ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {terminalRouting.terminals.map((terminal) => {
              const status = !terminal.configured
                ? "Not configured"
                : terminal.in_use_by_register_lane
                  ? `In use by Register #${terminal.in_use_by_register_lane}`
                  : "Ready";
              return (
                <div key={terminal.key} className="rounded-lg border border-app-border bg-app-surface-2 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-black text-app-text">{terminal.label}</div>
                      <div className="mt-1 text-xs font-semibold text-app-text-muted">
                        {terminal.key === "terminal_1"
                          ? "Register #1 default; Registers #3/#4 can choose"
                          : "Register #2 default; Registers #3/#4 can choose"}
                      </div>
                    </div>
                    <StatusPill value={status} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <section className="space-y-3">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text-muted">Payment Devices</h3>
            {terminalDevices.length === 0 ? (
              <EmptyState title="No devices returned" body="Confirm API mode and device code setup in Helcim." compact />
            ) : (
              <div className="space-y-2">
                {terminalDevices.map((device, index) => {
                  const code = helcimDeviceCode(device);
                  return (
                    <div key={code || String(index)} className="rounded-lg border border-app-border bg-app-surface-2 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-black text-app-text">{helcimDeviceLabel(device)}</div>
                          <div className="mt-1 text-xs font-semibold text-app-text-muted">
                            Code {code || "Not ready"} · {staffLabel(device.status, "Status not ready")}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onPingDevice(code)}
                          disabled={(!posSurface && !canSync) || !code}
                          title={!posSurface && !canSync ? "You do not have permission to perform this action" : undefined}
                          className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs font-black uppercase tracking-widest text-app-text disabled:opacity-50"
                        >
                          Ping
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text-muted">Card Terminals</h3>
            {cardTerminals.length === 0 ? (
              <EmptyState title="No card terminals returned" body="Helcim did not return processor terminal records." compact />
            ) : (
              <DataTable
                empty="No card terminals found."
                headers={["Terminal", "Currency", "Status"]}
                rows={cardTerminals.map((terminal, index) => ({
                  key: String(terminal.id ?? terminal.nickname ?? index),
                  cells: [
                    asText(terminal.nickname ?? terminal.id),
                    asText(terminal.currency),
                    <StatusPill value={asText(terminal.status, "Not ready")} />,
                  ],
                }))}
              />
            )}
          </section>
        </div>
      </div>
      {!posSurface ? (
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSyncBatches} disabled={!canSync} title={!canSync ? "You do not have permission to perform this action" : undefined} className="rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          Sync Batches
        </button>
        <button type="button" onClick={onSyncFees} disabled={!canSync} title={!canSync ? "You do not have permission to perform this action" : undefined} className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text disabled:opacity-50">
          Sync Fees
        </button>
      </div>
      ) : null}
      <PromptModal
        isOpen={recoveryNoteAttempt !== null}
        onClose={() => setRecoveryNoteAttempt(null)}
        onSubmit={(value) => {
          const trimmed = value.trim();
          if (trimmed.length < 10) return false;
          setRecoveryNote(trimmed);
          setRecoveryConfirmAttempt(recoveryNoteAttempt);
          return true;
        }}
        title="Paid Sale Recovery Note"
        message="Explain why this approved Helcim payment must be converted from the retained parked cart. At least 10 characters are required."
        placeholder="Required recovery reason"
        confirmLabel="Continue"
      />
      <PromptModal
        isOpen={recoveryConfirmAttempt !== null}
        onClose={() => setRecoveryConfirmAttempt(null)}
        onSubmit={async (value) => {
          if (value.trim() !== "RECOVER PAID SALE" || !recoveryConfirmAttempt) return false;
          await onRecoverPaidParkedSale(recoveryConfirmAttempt, recoveryNote, value.trim());
          setRecoveryNote("");
          return true;
        }}
        title="Confirm Financial Recovery"
        message="This creates the missing ROS transaction from the exact retained cart and links the existing approved Helcim charge. It does not charge the card again. Type RECOVER PAID SALE to continue."
        placeholder="RECOVER PAID SALE"
        confirmLabel="Recover and Link"
      />
      <PromptModal
        isOpen={orderRecoveryAttempt !== null}
        onClose={() => setOrderRecoveryAttempt(null)}
        onSubmit={(value) => {
          const target = value.trim().toUpperCase();
          if (!/^TXN-\d+$/.test(target) || !orderRecoveryAttempt) return false;
          setOrderRecoveryTarget(target);
          setOrderRecoveryNoteAttempt(orderRecoveryAttempt);
          return true;
        }}
        title="Target Transaction Record"
        message="Enter the exact open Transaction Record that should receive this approved Helcim payment. Confirm the terminal receipt, amount, and customer first."
        placeholder="TXN-######"
        confirmLabel="Continue"
      />
      <PromptModal
        isOpen={orderRecoveryNoteAttempt !== null}
        onClose={() => setOrderRecoveryNoteAttempt(null)}
        onSubmit={(value) => {
          const trimmed = value.trim();
          if (trimmed.length < 10 || !orderRecoveryNoteAttempt) return false;
          setOrderRecoveryNote(trimmed);
          setOrderRecoveryConfirmAttempt(orderRecoveryNoteAttempt);
          return true;
        }}
        title="Order Payment Recovery Note"
        message={`Explain why this approved Helcim payment belongs on ${orderRecoveryTarget}. At least 10 characters are required.`}
        placeholder="Required recovery reason"
        confirmLabel="Continue"
      />
      <PromptModal
        isOpen={orderRecoveryConfirmAttempt !== null}
        onClose={() => setOrderRecoveryConfirmAttempt(null)}
        onSubmit={async (value) => {
          if (
            value.trim() !== "RECOVER ORDER PAYMENT" ||
            !orderRecoveryConfirmAttempt
          ) {
            return false;
          }
          await onRecoverPaidOrderPayment(
            orderRecoveryConfirmAttempt,
            orderRecoveryTarget,
            orderRecoveryNote,
            value.trim(),
          );
          setOrderRecoveryTarget("");
          setOrderRecoveryNote("");
          return true;
        }}
        title="Confirm Order Payment Recovery"
        message={`This links the existing approved Helcim charge to ${orderRecoveryTarget}, recalculates its balance, and records an audit entry. It does not charge the card again. Type RECOVER ORDER PAYMENT to continue.`}
        placeholder="RECOVER ORDER PAYMENT"
        confirmLabel="Recover and Link"
      />
    </div>
  );
}

function HelcimRecoveryActionPanel({
  sourceKind,
  sourceId,
  actions,
  canReview,
  canResolve,
  onRecord,
}: {
  sourceKind: HelcimTerminalRecoverySourceKind;
  sourceId: string;
  actions: HelcimTerminalRecoveryAction[];
  canReview: boolean;
  canResolve: boolean;
  onRecord: (
    sourceKind: HelcimTerminalRecoverySourceKind,
    sourceId: string,
    action: HelcimTerminalRecoveryActionName,
    note: string,
  ) => Promise<void>;
}) {
  const options = useMemo(() => {
    const reviewActions: Array<{ value: HelcimTerminalRecoveryActionName; label: string }> = [
      { value: "reviewed", label: "Reviewed" },
      { value: "noted", label: "Add Note" },
    ];
    const resolutionActions: Array<{ value: HelcimTerminalRecoveryActionName; label: string }> = [
      { value: "resolved_no_action", label: "Resolved: No ROS Action" },
      { value: "provider_charge_confirmed", label: "Provider Charge Confirmed" },
      { value: "duplicate_suspected", label: "Duplicate Suspected" },
      { value: "refund_required", label: "Refund Required" },
      { value: "replayed_webhook", label: "Webhook Replay Reviewed" },
    ];
    return [
      ...(canReview ? reviewActions : []),
      ...(canResolve ? resolutionActions : []),
    ];
  }, [canReview, canResolve]);
  const [selectedAction, setSelectedAction] = useState<HelcimTerminalRecoveryActionName>(
    options[0]?.value ?? "reviewed",
  );
  const [note, setNote] = useState("");
  const selectedIsAllowed = options.some((option) => option.value === selectedAction);
  const noteRequired = selectedAction !== "reviewed";
  const noteReady = !noteRequired || note.trim().length > 0;

  useEffect(() => {
    if (!selectedIsAllowed && options[0]) {
      setSelectedAction(options[0].value);
    }
  }, [options, selectedIsAllowed]);

  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface p-3">
      <div className="text-xs font-black uppercase tracking-widest text-app-text-muted">Recovery Audit</div>
      {actions.length === 0 ? (
        <div className="mt-2 text-sm font-semibold text-app-text-muted">No recovery actions recorded.</div>
      ) : (
        <div className="mt-2 space-y-2">
          {actions.slice(0, 4).map((action) => (
            <div key={action.id} className="rounded-md border border-app-border bg-app-surface-2 p-2">
              <div className="text-xs font-black text-app-text">
                {staffLabel(action.action)} · {shortDateTime(action.created_at)}
              </div>
              {action.note ? <div className="mt-1 text-xs font-semibold text-app-text-muted">{action.note}</div> : null}
            </div>
          ))}
        </div>
      )}
      {options.length === 0 ? (
        <div className="mt-3 text-sm font-semibold text-app-text-muted">
          You do not have permission to add Helcim recovery actions.
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          <select
            value={selectedAction}
            onChange={(event) => setSelectedAction(event.target.value as HelcimTerminalRecoveryActionName)}
            className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm font-semibold text-app-text outline-none focus:border-app-accent"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={noteRequired ? "Required review note" : "Optional note"}
            className="min-h-20 rounded-lg border border-app-border bg-app-bg p-3 text-sm font-medium text-app-text outline-none focus:border-app-accent"
          />
          <button
            type="button"
            disabled={!selectedIsAllowed || !noteReady}
            onClick={async () => {
              await onRecord(sourceKind, sourceId, selectedAction, note);
              setNote("");
            }}
            className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm font-bold text-app-text disabled:opacity-50"
          >
            Record Review Action
          </button>
        </div>
      )}
    </div>
  );
}

function BatchDrawer({
  batch,
  detail,
  transactions,
  issues,
  onClose,
  onOpenPayment,
  onOpenIssue,
}: {
  batch: BatchRow | null;
  detail: BatchDetail | null;
  transactions: BatchTransactionRow[];
  issues: ReconciliationItem[];
  onClose: () => void;
  onOpenPayment: (paymentId: string | null) => void;
  onOpenIssue: (issue: ReconciliationItem) => void;
}) {
  return (
    <DetailDrawer
      isOpen={Boolean(batch)}
      onClose={onClose}
      title={batch ? `Batch ${batch.provider_batch_id}` : "Batch"}
      subtitle={batch ? <span>{batch.status ?? "Not ready"} · {shortDateTime(batch.closed_at)}</span> : null}
      panelMaxClassName="max-w-3xl"
    >
      {!batch ? null : (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Gross" value={money(batch.gross_amount, "Not ready")} />
            <MetricCard label="Fees" value={money(batch.fee_amount, "Fee not ready")} />
            <MetricCard label="Expected Deposit" value={money(batch.net_amount, "Deposit not ready")} />
          </section>
          <section className="rounded-lg border border-app-border bg-app-surface p-4">
            <h3 className="text-base font-black text-app-text">Summary</h3>
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <InfoLine label="Transactions" value={String(batch.transaction_count ?? transactions.length)} />
              <InfoLine label="Last synced" value={shortDateTime(batch.last_synced_at)} />
              <InfoLine label="Fee not ready" value={`${batch.fee_not_ready_count}`} />
              <InfoLine label="Net not ready" value={`${batch.net_not_ready_count}`} />
              <InfoLine label="Critical issues" value={`${detail?.critical_issue_count ?? 0}`} />
              <InfoLine label="Warnings" value={`${detail?.warning_issue_count ?? 0}`} />
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="text-base font-black text-app-text">Transactions</h3>
            <DataTable
              empty="No transactions found."
              headers={["Amount", "Status", "Fee", "Net", "Match", "Action"]}
              rows={transactions.slice(0, 25).map((transaction) => ({
                key: transaction.id,
                cells: [
                  money(transaction.amount, "Not ready"),
                  <StatusPill value={transaction.status} />,
                  money(transaction.fee_amount, "Fee not ready"),
                  money(transaction.net_amount, "Net not ready"),
                  <StatusPill value={transaction.match_status} />,
                  <button type="button" className="text-sm font-bold text-app-accent" onClick={() => onOpenPayment(transaction.payment_transaction_id)}>
                    View Payment
                  </button>,
                ],
              }))}
            />
          </section>
          <section className="space-y-3">
            <h3 className="text-base font-black text-app-text">Issues</h3>
            {issues.length === 0 ? (
              <EmptyState title="No open issues" body="This batch is clear." compact />
            ) : (
              <DataTable
                empty="No issues found."
                headers={["Issue", "Severity", "Reference"]}
                rows={issues.map((issue) => ({
                  key: issue.id,
                  onClick: () => onOpenIssue(issue),
                  cells: [issue.issue_label, <StatusPill value={issue.severity} />, issue.reference ?? "Not ready"],
                }))}
              />
            )}
          </section>
        </div>
      )}
    </DetailDrawer>
  );
}

function TransactionDrawer({
  paymentId,
  detail,
  onClose,
  onOpenIssue,
}: {
  paymentId: string | null;
  detail: TransactionDetail | null;
  onClose: () => void;
  onOpenIssue: (issue: ReconciliationItem) => void;
}) {
  const payment = detail?.riverside_payment;
  const processor = detail?.processor_payment;
  const batch = detail?.batch;
  const fees = detail?.fee_details;
  return (
    <DetailDrawer
      isOpen={Boolean(paymentId)}
      onClose={onClose}
      title="Payment Detail"
      subtitle={paymentId ? <span>{paymentId}</span> : null}
      panelMaxClassName="max-w-3xl"
    >
      {!detail ? (
        <div className="text-sm font-semibold text-app-text-muted">Loading payment…</div>
      ) : (
        <div className="space-y-6">
          <DetailSection title="Riverside Payment">
            <InfoLine label="Amount" value={money(asText(payment?.amount, ""), "Not ready")} />
            <InfoLine label="Status" value={staffLabel(asText(payment?.status, ""))} />
            <InfoLine label="Date" value={shortDateTime(asText(payment?.created_at, ""))} />
            <InfoLine label="Method" value={asText(payment?.payment_method)} />
          </DetailSection>
          <DetailSection title="Processor Payment">
            <InfoLine label="Processor Reference" value={asText(processor?.provider_transaction_id)} />
            <InfoLine label="Status" value={staffLabel(asText(processor?.status, ""))} />
            <InfoLine label="Amount" value={money(asText(processor?.amount, ""), "Not ready")} />
            <InfoLine label="Matched" value={staffLabel(asText(processor?.match_status, ""))} />
          </DetailSection>
          <DetailSection title="Batch">
            <InfoLine label="Batch #" value={asText(batch?.provider_batch_id)} />
            <InfoLine label="Status" value={staffLabel(asText(batch?.status, ""))} />
            <InfoLine label="Expected Deposit" value={money(asText(batch?.net_amount, ""), "Deposit not ready")} />
          </DetailSection>
          <DetailSection title="Fee Details">
            <InfoLine label="Fee status" value={staffLabel(asText(fees?.fee_status, ""))} />
            <InfoLine label="Fee" value={money(asText(fees?.fee_amount, ""), "Fee not ready")} />
            <InfoLine label="Net status" value={staffLabel(asText(fees?.net_status, ""))} />
            <InfoLine label="Net" value={money(asText(fees?.net_amount, ""), "Net not ready")} />
          </DetailSection>
          <DetailSection title="Timeline">
            <div className="space-y-2">
              {detail.timeline.map((item) => (
                <div key={`${item.occurred_at}-${item.label}`} className="flex items-start gap-3 rounded-lg border border-app-border bg-app-surface-2 p-3">
                  <Clock3 size={16} className="mt-0.5 text-app-text-muted" />
                  <div>
                    <div className="text-sm font-bold text-app-text">{item.label || "Payment Update"}</div>
                    <div className="text-xs font-semibold text-app-text-muted">{shortDateTime(item.occurred_at)} · {staffLabel(item.status)}</div>
                  </div>
                </div>
              ))}
            </div>
          </DetailSection>
          <DetailSection title="Issues">
            {detail.issues.length === 0 ? (
              <div className="text-sm font-semibold text-app-text-muted">No open issues.</div>
            ) : (
              <div className="space-y-2">
                {detail.issues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => onOpenIssue(issue)}
                    className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-left"
                  >
                    <div className="text-sm font-black text-app-text">{issue.issue_label || "Needs Review"}</div>
                    <div className="text-xs font-semibold text-app-text-muted">{issue.message ?? issue.reference ?? "Needs Review"}</div>
                  </button>
                ))}
              </div>
            )}
          </DetailSection>
        </div>
      )}
    </DetailDrawer>
  );
}

function DepositDrawer({
  depositId,
  detail,
  unmatchedBatches,
  busy,
  canReview,
  canLink,
  canAdjust,
  onClose,
  onLinkBatches,
  onAddNote,
  onReview,
  onReopen,
}: {
  depositId: string | null;
  detail: DepositDetail | null;
  unmatchedBatches: BatchRow[];
  busy: boolean;
  canReview: boolean;
  canLink: boolean;
  canAdjust: boolean;
  onClose: () => void;
  onLinkBatches: (depositId: string, batchIds: string[], note: string) => void;
  onAddNote: (depositId: string, note: string) => void;
  onReview: (depositId: string, note: string, acceptVariance: boolean) => void;
  onReopen: (depositId: string) => void;
}) {
  const [note, setNote] = useState("");
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);

  useEffect(() => {
    setNote("");
    setSelectedBatchIds([]);
  }, [depositId]);

  const deposit = detail?.deposit;
  const hasDifference = Boolean(deposit?.difference && Math.abs(Number(deposit.difference)) >= 0.005);
  return (
    <DetailDrawer
      isOpen={Boolean(depositId)}
      onClose={onClose}
      title="Actual Bank Deposit"
      subtitle={deposit ? <span>{shortDate(deposit.posted_at)} · {money(deposit.amount, "$0.00")}</span> : null}
      panelMaxClassName="max-w-3xl"
    >
      {!detail || !deposit ? (
        <div className="text-sm font-semibold text-app-text-muted">Loading deposit…</div>
      ) : (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Actual Bank Deposit" value={money(deposit.amount, "$0.00")} />
            <MetricCard label="Expected Deposit" value={money(deposit.expected_amount, "Not linked")} />
            <MetricCard label="Difference" value={differenceLabel(deposit.difference)} tone={hasDifference ? "warning" : "good"} />
          </section>

          <DetailSection title="Deposit Details">
            <InfoLine label="Posted Date" value={shortDateTime(deposit.posted_at)} />
            <InfoLine label="Source" value={staffLabel(deposit.source_system)} />
            <InfoLine label="Reference" value={deposit.source_reference ?? "Manual entry"} />
            <InfoLine label="Status" value={staffLabel(deposit.status)} />
            <InfoLine label="Linked Batches" value={String(deposit.linked_batch_count)} />
            <InfoLine label="Reviewed" value={deposit.reviewed_at ? shortDateTime(deposit.reviewed_at) : "Not yet"} />
          </DetailSection>

          <section className="space-y-3">
            <h3 className="text-base font-black text-app-text">Linked Expected Batches</h3>
            <DataTable
              empty="No expected batches linked."
              headers={["Batch #", "Expected Deposit", "Expected Date", "Status"]}
              rows={detail.linked_batches.map((link) => ({
                key: link.id,
                cells: [
                  link.provider_batch_id,
                  money(link.expected_net_amount, "Deposit not ready"),
                  shortDate(link.expected_deposit_at ?? link.settled_at),
                  <StatusPill value={link.batch_status ?? link.status} />,
                ],
              }))}
            />
          </section>

          {canLink ? (
            <section className="rounded-lg border border-app-border bg-app-surface p-4">
              <h3 className="text-base font-black text-app-text">Link Expected Batches</h3>
              <p className="mt-1 text-sm font-semibold text-app-text-muted">
                Link only batches that make up this actual bank deposit.
              </p>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Required note for matching"
                className="mt-3 min-h-20 w-full rounded-lg border border-app-border bg-app-bg p-3 text-sm font-medium text-app-text outline-none focus:border-app-accent"
              />
              <div className="mt-3 max-h-64 space-y-2 overflow-auto">
                {unmatchedBatches.length === 0 ? (
                  <EmptyState title="No expected batches ready" body="All expected batches are already linked or not ready." compact />
                ) : (
                  unmatchedBatches.map((batch) => {
                    const checked = selectedBatchIds.includes(batch.id);
                    return (
                      <label key={batch.id} className="flex items-center justify-between gap-3 rounded-lg border border-app-border bg-app-surface-2 p-3 text-sm font-semibold text-app-text">
                        <span>
                          <span className="font-black">{batch.provider_batch_id}</span>
                          <span className="ml-2 text-app-text-muted">{money(batch.net_amount, "Deposit not ready")}</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setSelectedBatchIds((current) =>
                              event.target.checked
                                ? [...current, batch.id]
                                : current.filter((id) => id !== batch.id),
                            );
                          }}
                          className="h-4 w-4 accent-app-accent"
                        />
                      </label>
                    );
                  })
                )}
              </div>
              <button
                type="button"
                disabled={busy || selectedBatchIds.length === 0 || note.trim().length === 0}
                onClick={() => {
                  onLinkBatches(deposit.id, selectedBatchIds, note);
                  setSelectedBatchIds([]);
                  setNote("");
                }}
                className="mt-3 rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                Link Expected Batches
              </button>
            </section>
          ) : null}

          {(canReview || canAdjust) ? (
            <section className="rounded-lg border border-app-border bg-app-surface p-4">
              <h3 className="text-base font-black text-app-text">Review</h3>
              <p className="mt-1 text-sm font-semibold text-app-text-muted">
                Reviewing does not post to QuickBooks, change payment totals, or change bank records.
              </p>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={hasDifference ? "A note is required to accept a difference" : "Add a note"}
                className="mt-3 min-h-20 w-full rounded-lg border border-app-border bg-app-bg p-3 text-sm font-medium text-app-text outline-none focus:border-app-accent"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {canReview ? (
                  <>
                    <ActionButton disabled={busy} onClick={() => onReview(deposit.id, note, false)}>
                      Mark Reviewed
                    </ActionButton>
                    <ActionButton disabled={busy} onClick={() => onReopen(deposit.id)}>
                      Reopen
                    </ActionButton>
                    <ActionButton disabled={busy || note.trim().length === 0} onClick={() => onAddNote(deposit.id, note)}>
                      Add Note
                    </ActionButton>
                  </>
                ) : null}
                {canAdjust && hasDifference ? (
                  <ActionButton disabled={busy || note.trim().length === 0} onClick={() => onReview(deposit.id, note, true)}>
                    Difference Accepted
                  </ActionButton>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            <h3 className="text-base font-black text-app-text">Issues</h3>
            {detail.issues.length === 0 ? (
              <EmptyState title="No open deposit issues" body="This actual deposit is clear." compact />
            ) : (
              <DataTable
                empty="No deposit issues."
                headers={["Issue", "Severity", "Amount", "Reference"]}
                rows={detail.issues.map((issue) => ({
                  key: issue.id,
                  cells: [
                    issue.message ?? issue.issue_label,
                    <StatusPill value={issue.severity} />,
                    money(issue.amount, "Not ready"),
                    issue.reference ?? "Not ready",
                  ],
                }))}
              />
            )}
          </section>

          <section className="rounded-lg border border-app-border bg-app-surface p-4">
            <h3 className="text-base font-black text-app-text">History</h3>
            {detail.events.length === 0 ? (
              <div className="mt-2 text-sm font-semibold text-app-text-muted">No staff notes yet.</div>
            ) : (
              <div className="mt-3 space-y-2">
                {detail.events.map((event) => (
                  <div key={event.id} className="rounded-lg border border-app-border bg-app-surface-2 p-3">
                    <div className="text-sm font-bold text-app-text">{staffLabel(event.action)}</div>
                    <div className="text-xs font-semibold text-app-text-muted">{shortDateTime(event.created_at)}</div>
                    {event.note ? <div className="mt-2 text-sm font-medium text-app-text">{event.note}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </DetailDrawer>
  );
}

function IssueDrawer({
  issue,
  candidates,
  canReview,
  canResolve,
  canLink,
  busy,
  onClose,
  onOpenPayment,
  onStatus,
  onAddNote,
  onLinkPayment,
}: {
  issue: ReconciliationItem | null;
  candidates: CandidatePayment[];
  canReview: boolean;
  canResolve: boolean;
  canLink: boolean;
  busy: boolean;
  onClose: () => void;
  onOpenPayment: (paymentId: string | null) => void;
  onStatus: (
    issue: ReconciliationItem,
    action: "reviewed" | "resolved" | "ignored" | "reopened",
    note: string,
    resolutionType?: string,
  ) => void;
  onAddNote: (issue: ReconciliationItem, note: string) => void;
  onLinkPayment: (issue: ReconciliationItem, paymentTransactionId: string, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [linkNote, setLinkNote] = useState("");

  useEffect(() => {
    setNote("");
    setLinkNote("");
  }, [issue?.id]);

  const noteRequired = ["critical", "warning"].includes(issue?.severity?.toLowerCase() ?? "");
  return (
    <DetailDrawer
      isOpen={Boolean(issue)}
      onClose={onClose}
      title={issue?.issue_label ?? "Issue"}
      subtitle={issue ? <span>{issue.severity} · {shortDateTime(issue.created_at)}</span> : null}
      panelMaxClassName="max-w-3xl"
    >
      {!issue ? null : (
        <div className="space-y-6">
          <section className="rounded-lg border border-app-border bg-app-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-base font-black text-app-text">Issue Summary</h3>
                <p className="mt-1 text-sm font-semibold text-app-text-muted">
                  {issue.message ?? "This payment needs review."}
                </p>
              </div>
              <StatusPill value={issue.status} />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <InfoLine label="Amount" value={money(issue.amount, "Not ready")} />
              <InfoLine label="Processor Reference" value={issue.provider_transaction_id ?? "Not ready"} />
              <InfoLine label="Batch" value={issue.provider_batch_id ?? "Not ready"} />
              <InfoLine label="Reviewed" value={issue.reviewed_at ? shortDateTime(issue.reviewed_at) : "Not yet"} />
              <InfoLine label="Resolved" value={issue.resolved_at ? shortDateTime(issue.resolved_at) : "Not yet"} />
              <InfoLine label="Reason" value={staffLabel(issue.resolution_type)} />
            </div>
          </section>

          {canReview || canResolve ? (
            <section className="rounded-lg border border-app-border bg-app-surface p-4">
              <h3 className="text-base font-black text-app-text">Actions</h3>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={noteRequired ? "Add a note before closing this issue" : "Add a note"}
                className="mt-3 min-h-24 w-full rounded-lg border border-app-border bg-app-bg p-3 text-sm font-medium text-app-text outline-none focus:border-app-accent"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {canReview ? (
                  <>
                    <ActionButton disabled={busy} onClick={() => onStatus(issue, "reviewed", note)}>
                      Mark Reviewed
                    </ActionButton>
                    <ActionButton
                      disabled={busy || note.trim().length === 0}
                      onClick={() => {
                        onAddNote(issue, note);
                        setNote("");
                      }}
                    >
                      Add Note
                    </ActionButton>
                  </>
                ) : null}
                {canResolve ? (
                  <>
                    <ActionButton disabled={busy || (noteRequired && note.trim().length === 0)} onClick={() => onStatus(issue, "resolved", note, "resolved")}>
                      Resolve
                    </ActionButton>
                    <ActionButton disabled={busy || note.trim().length === 0} onClick={() => onStatus(issue, "ignored", note, "expected")}>
                      Mark Expected
                    </ActionButton>
                    <ActionButton disabled={busy} onClick={() => onStatus(issue, "reopened", note)}>
                      Reopen
                    </ActionButton>
                  </>
                ) : null}
              </div>
            </section>
          ) : (
            <div className="rounded-lg border border-app-border bg-app-surface p-4 text-sm font-semibold text-app-text-muted">
              You do not have permission to perform this action. You can still review issue details.
            </div>
          )}

          {canLink && issue.provider_transaction_id ? (
            <section className="rounded-lg border border-app-border bg-app-surface p-4">
              <h3 className="text-base font-black text-app-text">Link Payment</h3>
              <p className="mt-1 text-sm font-semibold text-app-text-muted">
                Link only when the amount and payment direction match.
              </p>
              <textarea
                value={linkNote}
                onChange={(event) => setLinkNote(event.target.value)}
                placeholder="Required note for linking"
                className="mt-3 min-h-20 w-full rounded-lg border border-app-border bg-app-bg p-3 text-sm font-medium text-app-text outline-none focus:border-app-accent"
              />
              <div className="mt-3 space-y-2">
                {candidates.length === 0 ? (
                  <EmptyState title="No payment candidates" body="No matching Riverside payments are ready to link." compact />
                ) : (
                  candidates.map((candidate) => (
                    <div key={candidate.payment_transaction_id} className="rounded-lg border border-app-border bg-app-surface-2 p-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-black text-app-text">{money(candidate.amount, "$0.00")}</div>
                          <div className="text-xs font-semibold text-app-text-muted">
                            {shortDateTime(candidate.payment_date)} · {staffLabel(candidate.payment_status)}
                          </div>
                          {candidate.warning_flags.length > 0 ? (
                            <div className="mt-2 text-xs font-bold text-amber-700">
                              {candidate.warning_flags.join(", ")}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex gap-3">
                          <button
                            type="button"
                            onClick={() => onOpenPayment(candidate.payment_transaction_id)}
                            className="text-sm font-bold text-app-text-muted"
                          >
                            View Payment
                          </button>
                          <button
                            type="button"
                            disabled={busy || candidate.warning_flags.length > 0 || linkNote.trim().length === 0}
                            onClick={() => onLinkPayment(issue, candidate.payment_transaction_id, linkNote)}
                            className="rounded-lg bg-app-accent px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                          >
                            Link Payment
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          ) : null}

          <section className="rounded-lg border border-app-border bg-app-surface p-4">
            <h3 className="text-base font-black text-app-text">History</h3>
            {issue.events.length === 0 ? (
              <div className="mt-2 text-sm font-semibold text-app-text-muted">No staff notes yet.</div>
            ) : (
              <div className="mt-3 space-y-2">
                {issue.events.map((event) => (
                  <div key={event.id} className="rounded-lg border border-app-border bg-app-surface-2 p-3">
                    <div className="text-sm font-bold text-app-text">{staffLabel(event.action)}</div>
                    <div className="text-xs font-semibold text-app-text-muted">{shortDateTime(event.created_at)}</div>
                    {event.note ? <div className="mt-2 text-sm font-medium text-app-text">{event.note}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </DetailDrawer>
  );
}

function ActionButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-app-border bg-app-surface-2 px-3 py-2 text-sm font-bold text-app-text transition hover:bg-app-bg disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-app-border bg-app-surface p-4">
      <h3 className="text-base font-black text-app-text">{title}</h3>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold text-app-text-muted">{label}</div>
      <div className="break-words text-sm font-bold text-app-text">{value}</div>
    </div>
  );
}

function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: { key: string; cells: ReactNode[]; onClick?: () => void }[];
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState title={empty} body="Try syncing or narrowing the view." compact />;
  return (
    <div className="overflow-hidden rounded-lg border border-app-border bg-app-surface">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-app-border text-left text-sm">
          <thead className="bg-app-surface-2 text-xs font-bold text-app-text-muted">
            <tr>
              {headers.map((header) => (
                <th key={header} scope="col" className="px-4 py-3">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {rows.map((row) => (
              <tr
                key={row.key}
                onClick={row.onClick}
                className={row.onClick ? "cursor-pointer transition hover:bg-app-surface-2" : undefined}
              >
                {row.cells.map((cell, index) => (
                  <td key={`${row.key}-${index}`} className="px-4 py-3 align-middle text-app-text">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState({ title, body, compact = false }: { title: string; body: string; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-app-border bg-app-surface text-center ${compact ? "p-4" : "p-8"}`}>
      <div className="text-sm font-black text-app-text">{title}</div>
      <div className="mt-1 text-sm font-medium text-app-text-muted">{body}</div>
    </div>
  );
}

function isSection(value: string): value is SectionId {
  return [
    "overview",
    "batches",
    "deposits",
    "reconciliation",
    "transactions",
    "refunds",
    "disputes",
    "health",
  ].includes(value);
}
