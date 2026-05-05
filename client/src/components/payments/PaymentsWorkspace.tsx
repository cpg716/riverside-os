import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import DetailDrawer from "../layout/DetailDrawer";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CreditCard,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const baseUrl = getBaseUrl();

type SectionId = "overview" | "batches" | "reconciliation" | "transactions" | "health";

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
  payment_transaction_id: string;
  provider_transaction_id: string | null;
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
  last_event_at: string | null;
  last_failed_message: string | null;
};

type DashboardState = {
  overview: OverviewResponse | null;
  batches: BatchRow[];
  issues: ReconciliationItem[];
  transactions: TransactionRow[];
  runs: SettlementRun[];
  health: EventsHealth | null;
};

type Props = {
  activeSection?: string;
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

function staffLabel(value: string | null | undefined, emptyLabel = "Not ready") {
  if (!value) return emptyLabel;
  return value
    .replaceAll("_", " ")
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function statusTone(status: string | null | undefined) {
  const normalized = status?.toLowerCase() ?? "";
  if (["complete", "completed", "processed", "success", "settled", "matched"].includes(normalized)) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
  }
  if (["critical", "failed", "open", "unmatched", "needs_review"].includes(normalized)) {
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
  active,
  onClick,
}: {
  id: SectionId;
  label: string;
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
      {label}
    </button>
  );
}

export default function PaymentsWorkspace({ activeSection = "overview" }: Props) {
  const initialSection = isSection(activeSection) ? activeSection : "overview";
  const [section, setSection] = useState<SectionId>(initialSection);
  const [data, setData] = useState<DashboardState>({
    overview: null,
    batches: [],
    issues: [],
    transactions: [],
    runs: [],
    health: null,
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
  const [transactionSearch, setTransactionSearch] = useState("");
  const { backofficeHeaders, hasPermission, permissionsLoaded } = useBackofficeAuth();
  const { toast } = useToast();
  const canReconcile = permissionsLoaded && hasPermission("payments.reconcile");

  useEffect(() => {
    setSection(isSection(activeSection) ? activeSection : "overview");
  }, [activeSection]);

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const today = todayYmd();
    try {
      const [overview, batches, issues, transactions, runs, health] = await Promise.all([
        getJson<OverviewResponse>(
          `/api/payments/providers/helcim/operations/overview?date_from=${today}&date_to=${today}`,
        ),
        getJson<BatchRow[]>("/api/payments/providers/helcim/batches?limit=50"),
        getJson<ReconciliationItem[]>(
          "/api/payments/providers/helcim/reconciliation/items?status=open&limit=50",
        ),
        getJson<TransactionRow[]>("/api/payments/providers/helcim/transactions?limit=50"),
        getJson<SettlementRun[]>("/api/payments/providers/helcim/sync/runs?limit=10"),
        getJson<EventsHealth>("/api/payments/providers/helcim/events/health"),
      ]);
      setData({ overview, batches, issues, transactions, runs, health });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payments could not load.");
    } finally {
      setLoading(false);
    }
  }, [getJson]);

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
      if (!canReconcile || !issue.provider_transaction_id) return;
      try {
        const candidates = await getJson<CandidatePayment[]>(
          `/api/payments/providers/helcim/reconciliation/items/${issue.id}/candidate-payments`,
        );
        setIssueCandidates(candidates);
      } catch {
        setIssueCandidates([]);
      }
    },
    [canReconcile, getJson],
  );

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

  const patchIssueStatus = useCallback(
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
    },
    [apiHeaders, refresh, toast, updateSelectedIssue],
  );

  const runSync = useCallback(
    async (kind: "batches" | "fees") => {
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
    [apiHeaders, refresh, toast],
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
        transaction.match_status,
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
                <h1 className="text-2xl font-black text-app-text">Payments</h1>
                <p className="text-sm font-medium text-app-text-muted">
                  Daily card activity, deposits, and items that need review.
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runSync("batches")}
              disabled={syncing !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
            >
              <RefreshCw size={16} className={syncing === "batches" ? "animate-spin" : ""} />
              Sync Batches
            </button>
            <button
              type="button"
              onClick={() => void runSync("fees")}
              disabled={syncing !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text transition hover:bg-app-surface-2 disabled:opacity-50"
            >
              <RefreshCw size={16} className={syncing === "fees" ? "animate-spin" : ""} />
              Sync Fees
            </button>
          </div>
        </div>
        <nav className="mt-5 flex gap-2 overflow-x-auto pb-1">
          <SectionButton id="overview" label="Overview" active={section === "overview"} onClick={setSection} />
          <SectionButton id="batches" label="Batches" active={section === "batches"} onClick={setSection} />
          <SectionButton id="reconciliation" label="Reconciliation" active={section === "reconciliation"} onClick={setSection} />
          <SectionButton id="transactions" label="Transactions" active={section === "transactions"} onClick={setSection} />
          <SectionButton id="health" label="Health" active={section === "health"} onClick={setSection} />
        </nav>
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
                onViewIssues={() => setSection("reconciliation")}
                onSyncBatches={() => void runSync("batches")}
                onSyncFees={() => void runSync("fees")}
              />
            )}
            {section === "batches" && <BatchesPanel batches={data.batches} onOpenBatch={openBatch} />}
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
              />
            )}
            {section === "health" && (
              <HealthPanel
                overview={data.overview}
                runs={data.runs}
                health={data.health}
                lastSuccess={lastSuccess}
                lastError={lastError}
                onSyncBatches={() => void runSync("batches")}
                onSyncFees={() => void runSync("fees")}
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
        canReconcile={canReconcile}
        busy={issueBusy}
        onClose={() => setSelectedIssue(null)}
        onOpenPayment={openTransaction}
        onStatus={patchIssueStatus}
        onAddNote={addIssueNote}
        onLinkPayment={linkIssuePayment}
      />
    </div>
  );
}

function OverviewPanel({
  overview,
  issues,
  onViewIssues,
  onSyncBatches,
  onSyncFees,
}: {
  overview: OverviewResponse | null;
  issues: ReconciliationItem[];
  onViewIssues: () => void;
  onSyncBatches: () => void;
  onSyncFees: () => void;
}) {
  const missingPayments = issues.filter((issue) => issue.issue_label === "Missing Payment").length;
  const notInDeposit = issues.filter((issue) => issue.issue_label === "Not in Deposit").length;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Card Sales Today" value={money(overview?.card_sales_gross, "$0.00")} />
        <MetricCard
          label="Known Fees"
          value={money(overview?.known_fees, "Fee not ready")}
          note={`${overview?.fee_not_ready_count ?? 0} payments waiting for fees`}
          tone={(overview?.fee_not_ready_count ?? 0) > 0 ? "warning" : "good"}
        />
        <MetricCard
          label="Expected Net"
          value={money(overview?.known_net, "Net not ready")}
          note={`${overview?.net_not_ready_count ?? 0} payments waiting for net`}
          tone={(overview?.net_not_ready_count ?? 0) > 0 ? "warning" : "good"}
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
        <WarningLine count={overview?.fee_not_ready_count ?? 0} label="Fee not ready" />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSyncBatches} className="rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white">
          Sync Batches
        </button>
        <button type="button" onClick={onSyncFees} className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text">
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
    return <EmptyState title="No open payment issues" body="Current processor data matches Riverside records." />;
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
}: {
  transactions: TransactionRow[];
  search: string;
  onSearch: (value: string) => void;
  onOpenPayment: (paymentId: string) => void;
}) {
  return (
    <div className="space-y-4">
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
        empty="No payments found."
        headers={["Amount", "Date", "Status", "Batch", "Fee status", "Match status"]}
        rows={transactions.map((transaction) => ({
          key: transaction.payment_transaction_id,
          onClick: () => onOpenPayment(transaction.payment_transaction_id),
          cells: [
            money(transaction.amount, "$0.00"),
            shortDateTime(transaction.payment_date),
            <StatusPill value={transaction.payment_status} />,
            transaction.provider_batch_id ?? "Not in deposit",
            transaction.fee_amount ? money(transaction.fee_amount) : "Fee not ready",
            <StatusPill value={transaction.match_status ?? "Not ready"} />,
          ],
        }))}
      />
    </div>
  );
}

function HealthPanel({
  overview,
  runs,
  health,
  lastSuccess,
  lastError,
  onSyncBatches,
  onSyncFees,
}: {
  overview: OverviewResponse | null;
  runs: SettlementRun[];
  health: EventsHealth | null;
  lastSuccess: SettlementRun | undefined;
  lastError: SettlementRun | undefined;
  onSyncBatches: () => void;
  onSyncFees: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Helcim Connection" value={overview?.helcim_api_active ? "Connected" : "Not active"} tone={overview?.helcim_api_active ? "good" : "warning"} />
        <MetricCard label="Last Sync" value={runs[0] ? shortDateTime(runs[0].started_at) : "Not ready"} note={staffLabel(runs[0]?.status)} />
        <MetricCard label="Last Success" value={lastSuccess ? shortDateTime(lastSuccess.completed_at ?? lastSuccess.started_at) : "Not ready"} />
        <MetricCard label="Last Error" value={lastError?.error_message ?? "Clear"} tone={lastError ? "warning" : "good"} />
      </div>
      <div className="rounded-lg border border-app-border bg-app-surface p-5">
        <h2 className="text-lg font-black text-app-text">Payment Updates</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <MetricCard label="Recent Updates" value={`${health?.recent_event_count ?? 0}`} />
          <MetricCard label="Needs Review" value={`${health?.failed_event_count ?? 0}`} tone={(health?.failed_event_count ?? 0) > 0 ? "warning" : "good"} />
          <MetricCard label="No Action Needed" value={`${health?.ignored_event_count ?? 0}`} />
          <MetricCard label="Last Update" value={shortDateTime(health?.last_event_at)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSyncBatches} className="rounded-lg bg-app-accent px-4 py-2 text-sm font-bold text-white">
          Sync Batches
        </button>
        <button type="button" onClick={onSyncFees} className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text">
          Sync Fees
        </button>
      </div>
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

function IssueDrawer({
  issue,
  candidates,
  canReconcile,
  busy,
  onClose,
  onOpenPayment,
  onStatus,
  onAddNote,
  onLinkPayment,
}: {
  issue: ReconciliationItem | null;
  candidates: CandidatePayment[];
  canReconcile: boolean;
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

  const noteRequired = issue?.severity === "Critical" || issue?.severity === "Warning";
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

          {canReconcile ? (
            <section className="rounded-lg border border-app-border bg-app-surface p-4">
              <h3 className="text-base font-black text-app-text">Actions</h3>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={noteRequired ? "Add a note before closing this issue" : "Add a note"}
                className="mt-3 min-h-24 w-full rounded-lg border border-app-border bg-app-bg p-3 text-sm font-medium text-app-text outline-none focus:border-app-accent"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <ActionButton disabled={busy} onClick={() => onStatus(issue, "reviewed", note)}>
                  Mark Reviewed
                </ActionButton>
                <ActionButton disabled={busy} onClick={() => onStatus(issue, "resolved", note, "resolved")}>
                  Resolve
                </ActionButton>
                <ActionButton disabled={busy} onClick={() => onStatus(issue, "ignored", note, "expected")}>
                  Mark Expected
                </ActionButton>
                <ActionButton disabled={busy} onClick={() => onStatus(issue, "reopened", note)}>
                  Reopen
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
              </div>
            </section>
          ) : (
            <div className="rounded-lg border border-app-border bg-app-surface p-4 text-sm font-semibold text-app-text-muted">
              You can review issue details. Payment linking and closing requires payment reconciliation access.
            </div>
          )}

          {canReconcile && issue.provider_transaction_id ? (
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
  return ["overview", "batches", "reconciliation", "transactions", "health"].includes(value);
}
