import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  ClipboardCheck,
  Copy,
  Database,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  TerminalSquare,
} from "lucide-react";

const baseUrl = getBaseUrl();

type HealthStatus = "ready" | "review" | "degraded" | "blocked";
type ChecklistMode = "open" | "close";

export type OperationsCenterNavigateTarget = {
  tab: "home" | "alterations" | "inventory" | "payments" | "settings" | "customers";
  section?: string;
};

interface IntegrationHealthItem {
  key: string;
  title: string;
  status: string;
  severity: string;
  detail?: string | null;
  last_success_at?: string | null;
  last_failure_at?: string | null;
}

interface OpsHealthSnapshot {
  db_ok: boolean;
  open_alerts: number;
  stations_online: number;
  stations_offline: number;
  pending_bug_reports: number;
  integrations?: IntegrationHealthItem[];
}

interface FulfillmentItem {
  urgency: "rush" | "due_soon" | "standard" | "blocked" | "ready";
  balance_due: number;
}

interface NotificationHealth {
  summary: {
    unread_rows: number;
    stale_unread_rows: number;
    active_inbox_rows: number;
    canonical_notifications_24h: number;
  };
  generator_runs: Array<{
    generator_key: string;
    last_status: "ok" | "failed";
    consecutive_failures: number;
    last_error?: string | null;
    last_finished_at?: string | null;
  }>;
}

interface CounterpointStatus {
  windows_sync_state?: string | null;
  counterpoint_staging_enabled?: boolean;
  staging_pending_count?: number;
  staging_applying_count?: number;
  recent_issues?: Array<{
    id: string;
    entity: string;
    severity: string;
    message: string;
    created_at: string;
  }>;
  entity_runs?: Array<{
    entity: string;
    last_ok_at?: string | null;
    last_error?: string | null;
  }>;
}

interface RmsReconciliationResponse {
  items?: Array<{
    id: string;
    severity: string;
    status: string;
    mismatch_type: string;
    created_at: string;
  }>;
  runs?: Array<{
    status: string;
    started_at: string;
    completed_at?: string | null;
    summary_json?: {
      mismatch_count?: number;
      retryable_count?: number;
    } | null;
  }>;
}

interface PaymentEventsHealth {
  recent_event_count?: number;
  failed_event_count?: number;
  unmatched_event_count?: number;
  ignored_event_count?: number;
  last_event_at?: string | null;
  last_failed_message?: string | null;
}

interface ActiveProviderResponse {
  helcim?: {
    api_token_configured?: boolean;
    terminal_payments_ready?: boolean;
    live_terminal_payments_ready?: boolean;
    simulator_enabled?: boolean;
  };
}

interface PaymentIssue {
  id: string;
  issue_label?: string | null;
  severity?: string | null;
  status?: string | null;
}

interface LifecycleQueueItem {
  lifecycle_status: string;
  risk_level: string;
  is_rush: boolean;
}

interface LoadState<T> {
  data: T | null;
  error: string | null;
}

interface OperationsCategory {
  id: string;
  title: string;
  status: HealthStatus;
  blockerCount: number;
  stale: boolean;
  lastActivity: string;
  summary: string;
  nextAction: string;
  buttonLabel: string;
  target: OperationsCenterNavigateTarget;
  Icon: ComponentType<{ className?: string; size?: number }>;
}

interface TimelineItem {
  label: string;
  detail: string;
  status: HealthStatus;
}

interface RosOperationsCenterProps {
  refreshSignal?: number;
  onNavigate: (target: OperationsCenterNavigateTarget) => void;
}

function emptyState<T>(): LoadState<T> {
  return { data: null, error: null };
}

async function fetchJson<T>(path: string, headers: HeadersInit): Promise<LoadState<T>> {
  try {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Could not refresh (${response.status})`;
      throw new Error(message);
    }
    return { data: body as T, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Could not refresh.",
    };
  }
}

function statusRank(status: HealthStatus): number {
  if (status === "blocked") return 4;
  if (status === "degraded") return 3;
  if (status === "review") return 2;
  return 1;
}

function worstStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (worst, current) => (statusRank(current) > statusRank(worst) ? current : worst),
    "ready",
  );
}

function statusLabel(status: HealthStatus): string {
  if (status === "blocked") return "Blocked";
  if (status === "degraded") return "Degraded";
  if (status === "review") return "Needs Review";
  return "Ready";
}

function statusClass(status: HealthStatus): string {
  if (status === "blocked") return "border-app-danger/30 bg-app-danger/10 text-app-danger";
  if (status === "degraded") return "border-app-warning/40 bg-app-warning/10 text-app-warning";
  if (status === "review") return "border-amber-500/30 bg-amber-500/10 text-amber-700";
  return "border-app-success/30 bg-app-success/10 text-app-success";
}

function cardClass(status: HealthStatus): string {
  if (status === "blocked") return "border-app-danger/35 bg-app-danger/5";
  if (status === "degraded") return "border-app-warning/35 bg-app-warning/5";
  if (status === "review") return "border-amber-500/30 bg-amber-500/5";
  return "border-app-border bg-app-surface";
}

function fmtNumber(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString();
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "Not loaded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not loaded";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function counterpointLastSuccess(status: CounterpointStatus | null): string {
  const dates = (status?.entity_runs ?? [])
    .map((row) => row.last_ok_at)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (dates.length === 0) return "No successful sync loaded";
  return fmtDate(new Date(Math.max(...dates)).toISOString());
}

function reconciliationSeverityBand(severity?: string | null): HealthStatus {
  const value = String(severity ?? "").toLowerCase();
  if (["critical", "high", "blocking"].includes(value)) return "blocked";
  if (["warning", "medium"].includes(value)) return "review";
  return "ready";
}

function checklistGuidance(mode: ChecklistMode, category: OperationsCategory): string {
  if (category.status === "blocked") {
    return mode === "open"
      ? "Blocked unsafe state. Resolve or assign a manager owner before treating the store as open-ready."
      : "Review before closing register. Resolve or document ownership before treating close as complete.";
  }
  if (category.status === "degraded") {
    return "Degraded but operational only with awareness. Refresh first; if still degraded, confirm the source workflow before signoff.";
  }
  if (category.status === "review") {
    return "Needs Review. Manager review recommended before open/close signoff.";
  }
  return "Ready from loaded sources.";
}

function checklistPriority(status: HealthStatus, mode: ChecklistMode): string {
  if (status === "blocked") {
    return mode === "open"
      ? "Priority: resolve blockers before opening."
      : "Priority: resolve checkout, pickup, reconciliation, or support blockers before close.";
  }
  if (status === "degraded") {
    return "Priority: refresh stale sources, then decide whether degraded operation is acceptable.";
  }
  if (status === "review") {
    return "Priority: assign review owners and continue only after manager acknowledgment.";
  }
  return "Priority: continue the normal checklist rhythm.";
}

export default function RosOperationsCenter({
  refreshSignal = 0,
  onNavigate,
}: RosOperationsCenterProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [ops, setOps] = useState<LoadState<OpsHealthSnapshot>>(emptyState());
  const [fulfillment, setFulfillment] = useState<LoadState<FulfillmentItem[]>>(emptyState());
  const [notifications, setNotifications] = useState<LoadState<NotificationHealth>>(emptyState());
  const [counterpoint, setCounterpoint] = useState<LoadState<CounterpointStatus>>(emptyState());
  const [rms, setRms] = useState<LoadState<RmsReconciliationResponse>>(emptyState());
  const [paymentHealth, setPaymentHealth] = useState<LoadState<PaymentEventsHealth>>(emptyState());
  const [paymentProvider, setPaymentProvider] = useState<LoadState<ActiveProviderResponse>>(emptyState());
  const [paymentIssues, setPaymentIssues] = useState<LoadState<PaymentIssue[]>>(emptyState());
  const [lifecycleQueues, setLifecycleQueues] = useState<LoadState<LifecycleQueueItem[]>>(emptyState());
  const [snapshotCopied, setSnapshotCopied] = useState(false);
  const [checklistMode, setChecklistMode] = useState<ChecklistMode>("open");

  const headers = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);

  const load = useCallback(async () => {
    setLoading(true);
    const [
      opsResult,
      fulfillmentResult,
      notificationResult,
      counterpointResult,
      rmsResult,
      paymentHealthResult,
      paymentProviderResult,
      paymentIssuesResult,
      lifecycleResult,
    ] = await Promise.all([
      fetchJson<OpsHealthSnapshot>("/api/ops/health/snapshot", headers),
      fetchJson<FulfillmentItem[]>("/api/transactions/fulfillment-queue", headers),
      fetchJson<NotificationHealth>("/api/notifications/health", headers),
      fetchJson<CounterpointStatus>("/api/settings/counterpoint-sync/status", headers),
      fetchJson<RmsReconciliationResponse>("/api/customers/rms-charge/reconciliation?limit=10", headers),
      fetchJson<PaymentEventsHealth>("/api/payments/providers/helcim/events/health", headers),
      fetchJson<ActiveProviderResponse>("/api/payments/providers/active", headers),
      fetchJson<PaymentIssue[]>("/api/payments/providers/helcim/reconciliation/items?status=open&limit=25", headers),
      fetchJson<LifecycleQueueItem[]>("/api/order-lifecycle/items", headers),
    ]);

    setOps(opsResult);
    setFulfillment(fulfillmentResult);
    setNotifications(notificationResult);
    setCounterpoint(counterpointResult);
    setRms(rmsResult);
    setPaymentHealth(paymentHealthResult);
    setPaymentProvider(paymentProviderResult);
    setPaymentIssues(paymentIssuesResult);
    setLifecycleQueues(lifecycleResult);
    setLoadedAt(new Date().toLocaleString());
    setLoading(false);
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const derived = useMemo(() => {
    const opsData = ops.data;
    const fulfillmentRows = fulfillment.data ?? [];
    const notificationData = notifications.data;
    const cpData = counterpoint.data;
    const rmsData = rms.data;
    const paymentEvents = paymentHealth.data;
    const provider = paymentProvider.data;
    const paymentReviewItems = paymentIssues.data ?? [];
    const lifecycleItems = lifecycleQueues.data ?? [];
    const lifecycleNtbo = lifecycleItems.filter((item) => item.lifecycle_status === "ntbo").length;
    const lifecycleOrdered = lifecycleItems.filter((item) => item.lifecycle_status === "ordered").length;
    const lifecycleReceived = lifecycleItems.filter((item) => item.lifecycle_status === "received").length;
    const lifecycleReady = lifecycleItems.filter((item) => item.lifecycle_status === "ready_for_pickup").length;
    const lifecycleRushNtbo = lifecycleItems.filter((item) => item.lifecycle_status === "ntbo" && item.is_rush).length;
    const lifecycleAtRisk = lifecycleItems.filter((item) => item.risk_level === "at_risk").length;

    const fulfillmentBlocked = fulfillmentRows.filter((row) => row.urgency === "blocked").length;
    const fulfillmentRush = fulfillmentRows.filter((row) => row.urgency === "rush").length;

    const generatorFailures =
      notificationData?.generator_runs.filter((row) => row.last_status === "failed").length ?? 0;
    const staleUnread = notificationData?.summary.stale_unread_rows ?? 0;
    const activeNotifications = notificationData?.summary.active_inbox_rows ?? 0;

    const cpIssues = cpData?.recent_issues?.length ?? 0;
    const cpApplying = cpData?.staging_applying_count ?? 0;
    const cpPending = cpData?.staging_pending_count ?? 0;
    const cpErrors =
      cpData?.entity_runs?.filter((row) => row.last_error && row.last_error.trim().length > 0).length ?? 0;

    const rmsItems = rmsData?.items?.filter((item) => item.status !== "resolved") ?? [];
    const rmsBlocking = rmsItems.filter((item) => reconciliationSeverityBand(item.severity) === "blocked").length;
    const rmsWarnings = rmsItems.filter((item) => reconciliationSeverityBand(item.severity) === "review").length;

    const paymentReviewCount = paymentReviewItems.length;
    const failedPaymentUpdates = paymentEvents?.failed_event_count ?? 0;
    const unmatchedPaymentUpdates = paymentEvents?.unmatched_event_count ?? 0;
    const terminalReady = provider?.helcim?.terminal_payments_ready === true;
    const paymentConfigured = provider?.helcim?.api_token_configured === true;

    const feedErrors = [
      ops.error,
      fulfillment.error,
      notifications.error,
      counterpoint.error,
      rms.error,
      paymentHealth.error,
      paymentProvider.error,
      paymentIssues.error,
      lifecycleQueues.error,
    ].filter(Boolean).length;

    const categories: OperationsCategory[] = [
      {
        id: "store-readiness",
        title: "Store Readiness",
        status: ops.error
          ? "degraded"
          : !opsData?.db_ok || (opsData?.stations_offline ?? 0) > 0
            ? "blocked"
            : (opsData?.open_alerts ?? 0) > 0
              ? "review"
              : "ready",
        blockerCount: (opsData?.stations_offline ?? 0) + (opsData?.db_ok === false ? 1 : 0),
        stale: Boolean(ops.error),
        lastActivity: loadedAt ?? "Not loaded",
        summary: ops.error
          ? "Store health could not refresh. Showing the last loaded operational context where available."
          : `${fmtNumber(opsData?.stations_online)} station${opsData?.stations_online === 1 ? "" : "s"} online, ${fmtNumber(opsData?.stations_offline)} offline, ${fmtNumber(opsData?.open_alerts)} open alert${opsData?.open_alerts === 1 ? "" : "s"}.`,
        nextAction: (opsData?.stations_offline ?? 0) > 0
          ? "Check offline register workstations before opening or closing the store."
          : "Review open alerts, then continue normal store operations.",
        buttonLabel: "Open Support Center",
        target: { tab: "settings", section: "ros-dev-center" },
        Icon: ShieldCheck,
      },
      {
        id: "sales-register",
        title: "Sales & Register Health",
        status: paymentProvider.error || paymentHealth.error
          ? "degraded"
          : !paymentConfigured || !terminalReady || failedPaymentUpdates > 0
            ? "blocked"
            : paymentReviewCount > 0 || unmatchedPaymentUpdates > 0
              ? "review"
              : "ready",
        blockerCount: failedPaymentUpdates + (terminalReady ? 0 : 1),
        stale: Boolean(paymentProvider.error || paymentHealth.error),
        lastActivity: fmtDate(paymentEvents?.last_event_at),
        summary: paymentProvider.error || paymentHealth.error
          ? "Payment/register health could not refresh from the existing Payments sources."
          : `${terminalReady ? "Terminal payments ready" : "Terminal payments not ready"} · ${fmtNumber(paymentReviewCount)} payment review item${paymentReviewCount === 1 ? "" : "s"} · ${fmtNumber(failedPaymentUpdates)} failed update${failedPaymentUpdates === 1 ? "" : "s"}.`,
        nextAction: terminalReady
          ? "Review Helcim Terminal Review before retrying any unverified card outcome."
          : "Confirm Helcim terminal readiness before taking live card payments.",
        buttonLabel: "Open Payments Health",
        target: { tab: "payments", section: "health" },
        Icon: TerminalSquare,
      },
      {
        id: "fulfillment",
        title: "Fulfillment & Workflow Blockers",
        status: fulfillment.error
          ? "degraded"
          : fulfillmentBlocked > 0 || lifecycleAtRisk > 0
            ? "blocked"
            : fulfillmentRush > 0 || lifecycleNtbo > 0 || lifecycleReceived > 0
              ? "review"
              : "ready",
        blockerCount: fulfillmentBlocked + lifecycleAtRisk,
        stale: Boolean(fulfillment.error || lifecycleQueues.error),
        lastActivity: loadedAt ?? "Not loaded",
        summary: fulfillment.error || lifecycleQueues.error
          ? "Pickup queue could not refresh. Do not treat the queue as clear until refresh succeeds."
          : `${fmtNumber(fulfillmentRows.length)} pickup pending · ${fmtNumber(lifecycleNtbo)} NTBO · ${fmtNumber(lifecycleOrdered)} ordered · ${fmtNumber(lifecycleReceived)} received awaiting prep · ${fmtNumber(lifecycleReady)} ready.`,
        nextAction: fulfillmentBlocked > 0 || lifecycleAtRisk > 0
          ? "Open the pickup queue and review blocked fulfillment work first."
          : lifecycleNtbo > 0
            ? "Open Orders and create vendor purchase orders for NTBO items."
            : "Use the pickup queue for item-level follow-up; this center only summarizes.",
        buttonLabel: "Open Pickup Queue",
        target: { tab: "home", section: "fulfillment" },
        Icon: ShoppingBag,
      },
      {
        id: "sync-reconciliation",
        title: "Sync & Reconciliation",
        status: counterpoint.error || rms.error
          ? "degraded"
          : rmsBlocking > 0 || cpErrors > 0
            ? "blocked"
            : rmsWarnings > 0 || cpIssues > 0 || cpApplying > 0 || cpPending > 0
              ? "review"
              : "ready",
        blockerCount: rmsBlocking + cpErrors,
        stale: Boolean(counterpoint.error || rms.error),
        lastActivity: counterpointLastSuccess(cpData),
        summary: counterpoint.error || rms.error
          ? "Sync or reconciliation health could not refresh from source workspaces."
          : `${fmtNumber(cpIssues)} Counterpoint issue${cpIssues === 1 ? "" : "s"} · ${fmtNumber(cpPending + cpApplying)} staging batch${cpPending + cpApplying === 1 ? "" : "es"} active · ${fmtNumber(rmsItems.length)} RMS mismatch${rmsItems.length === 1 ? "" : "es"} loaded.`,
        nextAction: rmsBlocking > 0
          ? "Review RMS blocking mismatches before relying on pickup/payment visibility."
          : "Use Counterpoint or RMS source workspaces for safe rerun and recovery actions.",
        buttonLabel: rmsBlocking > 0 ? "Open RMS Review" : "Open Counterpoint",
        target: rmsBlocking > 0
          ? { tab: "customers", section: "rms-charge" }
          : { tab: "settings", section: "counterpoint" },
        Icon: Database,
      },
      {
        id: "inventory",
        title: "Inventory Confidence",
        status: notifications.error || counterpoint.error
          ? "degraded"
          : staleUnread > 0 || cpIssues > 0
            ? "review"
            : "ready",
        blockerCount: 0,
        stale: Boolean(notifications.error || counterpoint.error),
        lastActivity: loadedAt ?? "Not loaded",
        summary: notifications.error
          ? "Inventory alert health could not refresh; do not treat stock alerts as clear."
          : `${fmtNumber(staleUnread)} stale alert${staleUnread === 1 ? "" : "s"} · import and physical publish details remain in Inventory source workflows.`,
        nextAction: "Review inventory alerts, imports, and physical counts in their source workspaces before publishing changes.",
        buttonLabel: "Open Inventory Review",
        target: { tab: "inventory", section: "intelligence" },
        Icon: PackageCheck,
      },
      {
        id: "notifications",
        title: "Notifications & Staff Follow-Up",
        status: notifications.error
          ? "degraded"
          : generatorFailures > 0
            ? "blocked"
            : staleUnread > 0 || activeNotifications > 0
              ? "review"
              : "ready",
        blockerCount: generatorFailures,
        stale: Boolean(notifications.error),
        lastActivity: loadedAt ?? "Not loaded",
        summary: notifications.error
          ? "Notification health could not refresh. Refresh before treating the inbox as clear."
          : `${fmtNumber(activeNotifications)} active inbox row${activeNotifications === 1 ? "" : "s"} · ${fmtNumber(staleUnread)} stale unread · ${fmtNumber(generatorFailures)} failing generator${generatorFailures === 1 ? "" : "s"}.`,
        nextAction: generatorFailures > 0
          ? "Open notification health and review failing generators before assuming alerts are current."
          : "Clear reviewed alerts in the notification drawer; retry is safe for failed cleanup actions.",
        buttonLabel: "Open Inbox",
        target: { tab: "home", section: "inbox" },
        Icon: Bell,
      },
      {
        id: "deployment-support",
        title: "Deployment & Support",
        status: feedErrors > 0
          ? "degraded"
          : (opsData?.pending_bug_reports ?? 0) > 0
            ? "review"
            : "ready",
        blockerCount: 0,
        stale: feedErrors > 0,
        lastActivity: loadedAt ?? "Not loaded",
        summary: `Client ${CLIENT_SEMVER} · build ${GIT_SHORT || "unknown"} · ${fmtNumber(opsData?.pending_bug_reports)} pending bug report${opsData?.pending_bug_reports === 1 ? "" : "s"}.`,
        nextAction: "Use Support Center for runtime diagnostics, E2E health, station fleet, backups, and guarded support actions.",
        buttonLabel: "Open Support Center",
        target: { tab: "settings", section: "ros-dev-center" },
        Icon: ClipboardCheck,
      },
    ];

    const overallStatus = worstStatus(categories.map((category) => category.status));
    const blockerCount = categories.reduce((sum, category) => sum + category.blockerCount, 0);
    const degradedCount = categories.filter((category) => category.status === "degraded").length;
    const reviewCount = categories.filter((category) => category.status === "review").length;
    const staleCount = categories.filter((category) => category.stale).length;

    const timeline: TimelineItem[] = [
      ...(ops.error
        ? [{ label: "Store health refresh", detail: ops.error, status: "degraded" as const }]
        : []),
      ...(paymentEvents?.last_failed_message
        ? [{ label: "Latest payment update failure", detail: paymentEvents.last_failed_message, status: "blocked" as const }]
        : []),
      ...(cpData?.recent_issues ?? []).slice(0, 2).map((issue) => ({
        label: `Counterpoint ${issue.entity}`,
        detail: issue.message,
        status: issue.severity === "error" ? "blocked" as const : "review" as const,
      })),
      ...(rmsItems.length > 0
        ? [{
            label: "RMS reconciliation",
            detail: `${fmtNumber(rmsItems.length)} mismatch${rmsItems.length === 1 ? "" : "es"} still need review.`,
            status: rmsBlocking > 0 ? "blocked" as const : "review" as const,
          }]
        : []),
      ...(lifecycleAtRisk > 0
        ? [{
            label: "Item lifecycle",
            detail: `${fmtNumber(lifecycleAtRisk)} lifecycle item${lifecycleAtRisk === 1 ? "" : "s"} at risk; ${fmtNumber(lifecycleRushNtbo)} rush NTBO.`,
            status: "blocked" as const,
          }]
        : lifecycleNtbo > 0
          ? [{
              label: "NTBO queue",
              detail: `${fmtNumber(lifecycleNtbo)} item${lifecycleNtbo === 1 ? "" : "s"} still need vendor ordering.`,
              status: "review" as const,
            }]
          : []),
      ...(generatorFailures > 0
        ? [{
            label: "Notification generators",
            detail: `${fmtNumber(generatorFailures)} generator${generatorFailures === 1 ? "" : "s"} failing.`,
            status: "blocked" as const,
          }]
        : []),
      ...(fulfillmentBlocked > 0
        ? [{
            label: "Pickup queue",
            detail: `${fmtNumber(fulfillmentBlocked)} blocked pickup item${fulfillmentBlocked === 1 ? "" : "s"}.`,
            status: "blocked" as const,
          }]
        : []),
    ].slice(0, 8);

    return {
      categories,
      overallStatus,
      blockerCount,
      degradedCount,
      reviewCount,
      staleCount,
      timeline,
    };
  }, [
    counterpoint.data,
    counterpoint.error,
    fulfillment.data,
    fulfillment.error,
    loadedAt,
    lifecycleQueues.data,
    lifecycleQueues.error,
    notifications.data,
    notifications.error,
    ops.data,
    ops.error,
    paymentHealth.data,
    paymentHealth.error,
    paymentIssues.data,
    paymentIssues.error,
    paymentProvider.data,
    paymentProvider.error,
    rms.data,
    rms.error,
  ]);

  const supportSnapshot = useMemo(() => {
    return [
      "ROS Operations Center support snapshot",
      `Generated: ${loadedAt ?? "not loaded"}`,
      `Client: ${CLIENT_SEMVER}`,
      `Build: ${GIT_SHORT || "unknown"}`,
      `Overall: ${statusLabel(derived.overallStatus)}`,
      `Blockers: ${derived.blockerCount}`,
      `Degraded categories: ${derived.degradedCount}`,
      `Needs review: ${derived.reviewCount}`,
      `Stale/degraded sources: ${derived.staleCount}`,
      "",
      ...derived.categories.map(
        (category) =>
          `${category.title}: ${statusLabel(category.status)} | blockers=${category.blockerCount} | stale=${category.stale ? "yes" : "no"} | ${category.summary} | Next: ${category.nextAction}`,
      ),
      "",
      "Timeline:",
      ...(derived.timeline.length
        ? derived.timeline.map((item) => `${item.label}: ${item.detail}`)
        : ["No recent blocker timeline items loaded."]),
    ].join("\n");
  }, [derived, loadedAt]);

  const readinessChecklist = useMemo(() => {
    const categoryById = new Map(derived.categories.map((category) => [category.id, category]));
    const ids =
      checklistMode === "open"
        ? [
            "store-readiness",
            "sales-register",
            "fulfillment",
            "sync-reconciliation",
            "inventory",
            "notifications",
          ]
        : [
            "sales-register",
            "fulfillment",
            "sync-reconciliation",
            "notifications",
            "inventory",
            "deployment-support",
          ];
    return ids
      .map((id) => categoryById.get(id))
      .filter((category): category is OperationsCategory => Boolean(category))
      .map((category) => ({
        category,
        guidance: checklistGuidance(checklistMode, category),
      }));
  }, [checklistMode, derived.categories]);

  const checklistStatus = worstStatus(
    readinessChecklist.map((item) => item.category.status),
  );
  const checklistCounts = useMemo(
    () => ({
      ready: readinessChecklist.filter((item) => item.category.status === "ready").length,
      review: readinessChecklist.filter((item) => item.category.status === "review").length,
      degraded: readinessChecklist.filter((item) => item.category.status === "degraded").length,
      blocked: readinessChecklist.filter((item) => item.category.status === "blocked").length,
    }),
    [readinessChecklist],
  );
  const actionItems = useMemo(
    () =>
      derived.categories
        .filter((category) => category.status !== "ready" || category.stale || category.blockerCount > 0)
        .sort((a, b) => statusRank(b.status) - statusRank(a.status)),
    [derived.categories],
  );

  const copySnapshot = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(supportSnapshot);
      setSnapshotCopied(true);
      window.setTimeout(() => setSnapshotCopied(false), 2500);
    } catch {
      setSnapshotCopied(false);
    }
  }, [supportSnapshot]);

  return (
    <div className="flex flex-1 flex-col bg-app-bg">
      <div className="space-y-6 p-4 sm:p-6 lg:p-8" data-testid="ros-operations-center">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-app-text-muted">
              Settings / System readiness
            </p>
            <h2 className="mt-2 text-3xl font-black tracking-tight text-app-text">
              ROS Operations Center
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copySnapshot()}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
            >
              <Copy size={14} /> {snapshotCopied ? "Snapshot Copied" : "Copy Support Snapshot"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        <section className={`rounded-2xl border p-5 ${statusClass(derived.overallStatus)}`}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <Activity className="mt-1 shrink-0" size={22} />
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest">Overall store readiness</p>
                <h3 className="mt-1 text-2xl font-black">{statusLabel(derived.overallStatus)}</h3>
                <p className="mt-1 text-sm font-semibold opacity-85">
                  {derived.overallStatus === "blocked"
                    ? "Resolve the marked items before relying on normal operations."
                    : derived.overallStatus === "degraded"
                      ? "Some sources did not refresh. Use the links below to verify source workflows."
                      : derived.overallStatus === "review"
                        ? "Review the highlighted items before treating the day as clear."
                        : "Core checks are clear from the loaded sources."}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Blockers", derived.blockerCount],
                ["Needs Review", derived.reviewCount],
                ["Degraded", derived.degradedCount],
                ["Stale Sources", derived.staleCount],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-current/20 bg-app-surface/60 px-4 py-3">
                  <p className="text-[9px] font-black uppercase tracking-widest opacity-70">{label}</p>
                  <p className="mt-1 text-xl font-black tabular-nums">{value}</p>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-3 text-xs font-semibold opacity-75">
            Last loaded: {loadedAt ?? "Loading"} · Safe refresh only; this center does not mutate source workflows.
          </p>
        </section>

        <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-[0_10px_26px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                Resolve queue
              </p>
              <h3 className="mt-1 text-xl font-black text-app-text">
                {actionItems.length > 0 ? `${actionItems.length} item${actionItems.length === 1 ? "" : "s"} need action` : "All linked sources clear"}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Refresh Sources
            </button>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {actionItems.length > 0 ? (
              actionItems.map((category) => {
                const Icon = category.Icon;
                return (
                  <button
                    key={`action-${category.id}`}
                    type="button"
                    onClick={() => onNavigate(category.target)}
                    className={`flex min-h-24 items-center gap-3 rounded-xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${cardClass(category.status)}`}
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-current/20 bg-app-surface/70">
                      <Icon size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-black text-app-text">{category.title}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[8px] font-black uppercase tracking-widest ${statusClass(category.status)}`}>
                          {statusLabel(category.status)}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-app-text-muted">
                        {category.nextAction}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-app-accent">
                      Resolve
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-xl border border-app-success/30 bg-app-success/10 p-4 text-sm font-black text-app-success lg:col-span-2">
                No blockers, stale sources, or review items are loaded.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-[0_10px_26px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                Open / close check
              </p>
              <h3 className="mt-1 text-xl font-black text-app-text">
                {checklistMode === "open" ? "Open Store" : "Close Store"} readiness
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {(["open", "close"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setChecklistMode(mode)}
                  className={`min-h-10 rounded-xl border px-4 text-[10px] font-black uppercase tracking-widest ${
                    checklistMode === mode
                      ? "border-app-accent bg-app-accent/10 text-app-accent"
                      : "border-app-border bg-app-bg text-app-text-muted hover:text-app-text"
                  }`}
                >
                  {mode === "open" ? "Open Store" : "Close Store"}
                </button>
              ))}
            </div>
          </div>

          <div className={`mt-4 rounded-xl border px-4 py-3 ${statusClass(checklistStatus)}`}>
            <p className="text-[10px] font-black uppercase tracking-widest">
              {checklistMode === "open" ? "Can we safely open?" : "Can we safely close?"}
            </p>
            <p className="mt-1 text-sm font-semibold opacity-90">
              {checklistStatus === "blocked"
                ? "Not clear yet. Resolve blockers or assign ownership before calling this complete."
                : checklistStatus === "degraded"
                  ? "Use caution. Some sources did not refresh, so confirm source workflows before final signoff."
                  : checklistStatus === "review"
                    ? "Operationally possible with manager review of highlighted items."
                    : "Ready from the currently loaded operational sources."}
            </p>
            <p className="mt-2 text-xs font-black opacity-90">
              {checklistPriority(checklistStatus, checklistMode)}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Ready", checklistCounts.ready],
                ["Needs Review", checklistCounts.review],
                ["Degraded", checklistCounts.degraded],
                ["Blocked", checklistCounts.blocked],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-current/20 bg-app-surface/60 px-3 py-2">
                  <p className="text-[8px] font-black uppercase tracking-widest opacity-70">{label}</p>
                  <p className="mt-1 text-lg font-black tabular-nums">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {readinessChecklist.map(({ category, guidance }) => {
              const Icon = category.Icon;
              return (
                <article
                  key={`${checklistMode}-${category.id}`}
                  className={`rounded-xl border p-4 ${cardClass(category.status)}`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-bg text-app-accent">
                        <Icon size={18} />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-black text-app-text">{category.title}</h4>
                        <p className="mt-1 text-xs font-semibold text-app-text-muted">
                          {category.summary}
                        </p>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-widest ${statusClass(category.status)}`}>
                      {statusLabel(category.status)}
                    </span>
                  </div>
                  <div className="mt-3 rounded-lg border border-app-border bg-app-bg/60 px-3 py-2">
                    <p className="mt-1 text-xs font-semibold text-app-text">
                      {guidance} {category.nextAction}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onNavigate(category.target)}
                    aria-label={`Review ${category.title} source workflow`}
                    className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-app-border bg-app-bg px-3 text-[9px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                  >
                    {category.status === "ready" ? "Open Source" : "Resolve Source"}
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          {derived.categories.map((category) => {
            const Icon = category.Icon;
            return (
              <article
                key={category.id}
                className={`rounded-2xl border p-5 shadow-[0_10px_26px_rgba(15,23,42,0.05)] ${cardClass(category.status)}`}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-app-accent">
                      <Icon size={20} />
                    </div>
                    <div>
                      <h3 className="text-base font-black text-app-text">{category.title}</h3>
                      <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
                        {category.summary}
                      </p>
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${statusClass(category.status)}`}>
                    {statusLabel(category.status)}
                  </span>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-xl border border-app-border bg-app-bg/50 px-3 py-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Blockers</p>
                    <p className="mt-1 text-lg font-black text-app-text">{fmtNumber(category.blockerCount)}</p>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-bg/50 px-3 py-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Data State</p>
                    <p className="mt-1 text-sm font-black text-app-text">{category.stale ? "Last loaded" : "Current"}</p>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-bg/50 px-3 py-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Last Activity</p>
                    <p className="mt-1 text-sm font-black text-app-text">{category.lastActivity}</p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onNavigate(category.target)}
                  className="mt-4 inline-flex min-h-10 items-center rounded-xl border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                >
                  {category.status === "ready" ? category.buttonLabel : "Resolve / Review"}
                </button>
              </article>
            );
          })}
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border border-app-border bg-app-surface p-5">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-app-warning" />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Operational Timeline
              </h3>
            </div>
            <div className="mt-4 space-y-3">
              {derived.timeline.length > 0 ? (
                derived.timeline.map((item) => (
                  <div key={`${item.label}:${item.detail}`} className="rounded-xl border border-app-border bg-app-bg/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-black text-app-text">{item.label}</p>
                      <span className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${statusClass(item.status)}`}>
                        {statusLabel(item.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-semibold text-app-text-muted">{item.detail}</p>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-app-border bg-app-bg/50 p-4 text-sm font-semibold text-app-text-muted">
                  No recent blockers or degraded timeline items are loaded from the current sources.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-app-border bg-app-surface p-5">
            <div className="flex items-center gap-2">
              <ClipboardCheck size={18} className="text-app-accent" />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Support
              </h3>
            </div>
            <p className="mt-3 text-sm font-semibold leading-relaxed text-app-text-muted">
              Copy the current status for support, or open deeper diagnostics and guarded actions.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void copySnapshot()}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
              >
                <Copy size={14} /> {snapshotCopied ? "Copied" : "Copy Snapshot"}
              </button>
              <button
                type="button"
                onClick={() => onNavigate({ tab: "settings", section: "ros-dev-center" })}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
              >
                Open Diagnostics
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
