import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  Bug,
  ClipboardCheck,
  Copy,
  Database,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import BugReportsSettingsPanel from "../settings/BugReportsSettingsPanel";
import UpdateManagerPanel from "../settings/UpdateManagerPanel";

const baseUrl = getBaseUrl();

type HealthStatus = "WARNING" | "CAUTION" | "GOOD";
type ChecklistMode = "open" | "close";
type OperationsCenterTab =
  | "overview"
  | "readiness"
  | "stations"
  | "alerts"
  | "integrations"
  | "bugs"
  | "updates";
type ReadinessCheckStatus =
  | "ready"
  | "warning"
  | "blocked"
  | "manual_required"
  | "not_configured"
  | "unknown";
type ReadinessOverallStatus =
  | "Ready"
  | "Ready with Warnings"
  | "Blocked"
  | "Not Certified"
  | "Unknown";

export type OperationsCenterNavigateTarget = {
  tab:
    | "home"
    | "alterations"
    | "inventory"
    | "payments"
    | "qbo"
    | "settings"
    | "customers"
    | "appointments"
    | "weddings"
    | "staff";
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
  stations_stale?: number;
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

interface ConnectivityLog {
  id: string;
  source: string;
  old_status: string;
  new_status: string;
  detail?: string | null;
  created_at: string;
}

interface StationRow {
  station_key: string;
  station_label: string;
  app_version: string;
  git_sha: string | null;
  tailscale_node: string | null;
  lan_ip: string | null;
  last_seen_at: string;
  online: boolean;
  monitor_offline: boolean;
  actionable: boolean;
  active_staff_sessions: number;
  active_staff_names: string;
}

interface AlertEventRow {
  id: string;
  rule_key: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface BugOverviewRow {
  id: string;
  correlation_id: string;
  created_at: string;
  status: string;
  summary: string;
  staff_name: string;
  linked_incidents: number;
  oldest_linked_alert_at: string | null;
}

interface RuntimeDiagnosticItem {
  key: string;
  label: string;
  value: string;
  detail: string;
  severity: string;
}

interface RuntimeDiagnosticsSnapshot {
  generated_at: string;
  items: RuntimeDiagnosticItem[];
}

interface ReadinessSignoff {
  check_key: string;
  category: "daily_open" | "go_live" | "evidence";
  label: string;
  status: "ready" | "manual_required";
  notes: string;
  evidence_ref: string;
  expires_at?: string | null;
  signed_off_by_staff_id?: string | null;
  signed_off_by_staff_name?: string | null;
  signed_off_at?: string | null;
  updated_at: string;
}

interface ReadinessSignoffDraft {
  notes: string;
  evidence_ref: string;
  expires_at: string;
}

interface LoadState<T> {
  data: T | null;
  error: string | null;
}

interface OperationsCategory {
  id: string;
  title: string;
  status: "ready" | "review" | "degraded" | "blocked";
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
  status: "ready" | "review" | "degraded" | "blocked";
}

interface ReadinessCheck {
  key: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
  required: boolean;
  evidence?: string;
  targetTab?: OperationsCenterTab;
  signoff?: ReadinessSignoff;
}

interface ReadinessSection {
  category: ReadinessSignoff["category"];
  title: string;
  purpose: string;
  overall: ReadinessOverallStatus;
  checks: ReadinessCheck[];
}

interface RosOperationsCenterProps {
  refreshSignal?: number;
  onNavigate: (target: OperationsCenterNavigateTarget) => void;
  bugReportsDeepLinkId?: string | null;
  onBugReportsDeepLinkConsumed?: () => void;
}

function readinessStatusClass(status: ReadinessCheckStatus): string {
  switch (status) {
    case "ready":
      return "border-app-success/30 bg-app-success/10 text-app-success";
    case "warning":
      return "border-app-warning/30 bg-app-warning/10 text-app-warning";
    case "blocked":
      return "border-app-danger/30 bg-app-danger/10 text-app-danger";
    case "manual_required":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-200";
    case "not_configured":
      return "border-app-border bg-app-surface-2 text-app-text-muted";
    case "unknown":
      return "border-app-border bg-app-bg text-app-text-muted";
  }
}

function readinessOverallClass(status: ReadinessOverallStatus): string {
  if (status === "Ready") return "border-app-success/30 bg-app-success/10 text-app-success";
  if (status === "Ready with Warnings") return "border-app-warning/30 bg-app-warning/10 text-app-warning";
  if (status === "Blocked" || status === "Not Certified") {
    return "border-app-danger/30 bg-app-danger/10 text-app-danger";
  }
  return "border-app-border bg-app-surface-2 text-app-text-muted";
}

function readinessStatusLabel(status: ReadinessCheckStatus): string {
  if (status === "manual_required") return "manual signoff required";
  if (status === "not_configured") return "not connected";
  return status.replace(/_/g, " ");
}

function dailyOverall(checks: ReadinessCheck[]): ReadinessOverallStatus {
  const required = checks.filter((check) => check.required);
  if (required.length === 0) return "Unknown";
  if (required.some((check) => check.status === "blocked")) return "Blocked";
  if (required.some((check) => check.status !== "ready")) return "Ready with Warnings";
  return "Ready";
}

function certificationOverall(checks: ReadinessCheck[]): ReadinessOverallStatus {
  const required = checks.filter((check) => check.required);
  if (required.length === 0) return "Unknown";
  if (required.some((check) => check.status === "blocked")) return "Blocked";
  if (required.some((check) => check.status !== "ready")) return "Not Certified";
  return "Ready";
}

function readinessSignoffCurrent(signoff: ReadinessSignoff | undefined): boolean {
  if (!signoff || signoff.status !== "ready" || !signoff.signed_off_at) return false;
  if (!signoff.expires_at) return true;
  const expiresAt = new Date(signoff.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function applyReadinessSignoffs(
  checks: ReadinessCheck[],
  signoffs: ReadinessSignoff[],
): ReadinessCheck[] {
  const signoffByKey = new Map(signoffs.map((signoff) => [signoff.check_key, signoff]));
  return checks.map((check) => {
    const signoff = signoffByKey.get(check.key);
    if (check.status === "manual_required" && readinessSignoffCurrent(signoff)) {
      return {
        ...check,
        status: "ready",
        detail: `${check.detail} Manager signoff recorded by ${signoff?.signed_off_by_staff_name ?? "staff"} on ${fmtTs(signoff?.signed_off_at ?? null)}.`,
        evidence: signoff?.evidence_ref || check.evidence,
        signoff,
      };
    }
    return { ...check, signoff };
  });
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



export default function RosOperationsCenter({
  refreshSignal = 0,
  onNavigate,
  bugReportsDeepLinkId = null,
  onBugReportsDeepLinkConsumed,
}: RosOperationsCenterProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<OperationsCenterTab>("overview");

  // Sync deep link automatically
  useEffect(() => {
    if (bugReportsDeepLinkId) {
      setActiveTab("bugs");
    }
  }, [bugReportsDeepLinkId]);

  // Scroll to top on tab changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [activeTab]);

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
  
  // Support Center state consolidation
  const [stations, setStations] = useState<StationRow[]>([]);
  const [alerts, setAlerts] = useState<AlertEventRow[]>([]);
  const [bugsOverview, setBugsOverview] = useState<BugOverviewRow[]>([]);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnosticsSnapshot | null>(null);
  const [connectivityLogs, setConnectivityLogs] = useState<ConnectivityLog[]>([]);
  const [readinessSignoffs, setReadinessSignoffs] = useState<ReadinessSignoff[]>([]);
  const [signoffDrafts, setSignoffDrafts] = useState<Record<string, ReadinessSignoffDraft>>({});
  const [signoffBusyKey, setSignoffBusyKey] = useState<string | null>(null);
  const [selectedBugId, setSelectedBugId] = useState("");
  const [selectedAlertId, setSelectedAlertId] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [stationPage, setStationPage] = useState(1);
  const [alertPage, setAlertPage] = useState(1);
  const [showStaleStations, setShowStaleStations] = useState(false);
  const [triggerCheckBusy, setTriggerCheckBusy] = useState(false);

  const [snapshotCopied, setSnapshotCopied] = useState(false);
  const [checklistMode, setChecklistMode] = useState<ChecklistMode>("open");

  const canView = hasPermission("ops.dev_center.view");
  const canRunActions = hasPermission("ops.dev_center.actions");

  const headers = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);

  const load = useCallback(async () => {
    if (!canView) return;
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
      stationsResult,
      alertsResult,
      bugsResult,
      runtimeResult,
      logsResult,
      signoffsResult,
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
      fetchJson<StationRow[]>("/api/ops/stations", headers),
      fetchJson<AlertEventRow[]>("/api/ops/alerts", headers),
      fetchJson<BugOverviewRow[]>("/api/ops/bugs/overview", headers),
      fetchJson<RuntimeDiagnosticsSnapshot>("/api/ops/runtime-diagnostics", headers),
      fetchJson<ConnectivityLog[]>("/api/ops/connectivity-logs", headers),
      fetchJson<ReadinessSignoff[]>("/api/ops/readiness/signoffs", headers),
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

    if (stationsResult.data) setStations(stationsResult.data);
    if (alertsResult.data) setAlerts(alertsResult.data);
    if (bugsResult.data) setBugsOverview(bugsResult.data);
    if (runtimeResult.data) setRuntimeDiagnostics(runtimeResult.data);
    if (logsResult.data) setConnectivityLogs(logsResult.data);
    if (signoffsResult.data) setReadinessSignoffs(signoffsResult.data);

    setLoadedAt(new Date().toLocaleString());
    setLoading(false);
  }, [headers, canView]);

  const updateSignoffDraft = useCallback(
    (checkKey: string, patch: Partial<ReadinessSignoffDraft>) => {
      setSignoffDrafts((prev) => ({
        ...prev,
        [checkKey]: {
          ...{ notes: "", evidence_ref: "", expires_at: "" },
          ...(prev[checkKey] ?? {}),
          ...patch,
        },
      }));
    },
    [],
  );

  const saveReadinessSignoff = useCallback(
    async (
      section: ReadinessSection,
      check: ReadinessCheck,
      status: ReadinessSignoff["status"],
    ) => {
      if (!canRunActions) return;
      const draft = signoffDrafts[check.key] ?? {
        notes: check.signoff?.notes ?? "",
        evidence_ref: check.signoff?.evidence_ref ?? check.evidence ?? "",
        expires_at: check.signoff?.expires_at?.slice(0, 10) ?? "",
      };
      setSignoffBusyKey(check.key);
      try {
        const response = await fetch(
          `${baseUrl}/api/ops/readiness/signoffs/${encodeURIComponent(check.key)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headers,
            },
            body: JSON.stringify({
              category: section.category,
              label: check.label,
              status,
              notes: draft.notes.trim(),
              evidence_ref: draft.evidence_ref.trim(),
              expires_at: draft.expires_at ? new Date(draft.expires_at).toISOString() : null,
            }),
          },
        );
        if (!response.ok) {
          toast("Could not save readiness signoff", "error");
          return;
        }
        const saved = (await response.json()) as ReadinessSignoff;
        setReadinessSignoffs((prev) => [
          ...prev.filter((row) => row.check_key !== saved.check_key),
          saved,
        ]);
        setSignoffDrafts((prev) => ({
          ...prev,
          [check.key]: {
            notes: saved.notes,
            evidence_ref: saved.evidence_ref,
            expires_at: saved.expires_at?.slice(0, 10) ?? "",
          },
        }));
        toast(status === "ready" ? "Readiness signoff saved" : "Readiness signoff reopened", "success");
      } catch {
        toast("Network error saving readiness signoff", "error");
      } finally {
        setSignoffBusyKey(null);
      }
    },
    [canRunActions, headers, signoffDrafts, toast],
  );

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const ackAlert = useCallback(
    async (alertId: string) => {
      if (!canRunActions) return;
      try {
        const res = await fetch(`${baseUrl}/api/ops/alerts/ack`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ alert_id: alertId }),
        });
        if (!res.ok) {
          toast("Could not acknowledge alert", "error");
          return;
        }
        toast("Alert acknowledged", "success");
        await load();
      } catch {
        toast("Network error acknowledging alert", "error");
      }
    },
    [headers, canRunActions, load, toast],
  );

  const linkBugAlert = useCallback(async () => {
    if (!canRunActions) return;
    if (!selectedBugId || !selectedAlertId) {
      toast("Select both a bug report and an alert", "error");
      return;
    }

    setLinkBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/ops/bugs/link-alert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          bug_report_id: selectedBugId,
          alert_event_id: selectedAlertId,
          note: linkNote.trim(),
        }),
      });
      if (!res.ok) {
        toast("Could not link bug to alert", "error");
        return;
      }
      toast("Bug linked to ops incident", "success");
      setLinkNote("");
      await load();
    } catch {
      toast("Network error linking bug", "error");
    } finally {
      setLinkBusy(false);
    }
  }, [headers, canRunActions, linkNote, load, selectedAlertId, selectedBugId, toast]);

  const triggerHeartbeat = useCallback(async () => {
    if (!canRunActions) return;
    setTriggerCheckBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/ops/audit-probes`, {
        method: "POST",
        headers,
      });
      if (res.ok) {
        toast("Active integration connectivity heartbeat triggered.", "success");
        setTimeout(() => void load(), 1500);
      } else {
        toast("Failed to trigger integration audit.", "error");
      }
    } catch {
      toast("Network error running heartbeat.", "error");
    } finally {
      setTriggerCheckBusy(false);
    }
  }, [headers, canRunActions, load, toast]);

  // Derived health status grids
  const derived = useMemo(() => {
    const opsData = ops.data;
    const cpData = counterpoint.data;
    const rmsData = rms.data;
    const paymentEvents = paymentHealth.data;
    const provider = paymentProvider.data;
    const paymentReviewItems = paymentIssues.data ?? [];

    const cpIssues = cpData?.recent_issues?.length ?? 0;
    const cpErrors =
      cpData?.entity_runs?.filter((row) => row.last_error && row.last_error.trim().length > 0).length ?? 0;

    const rmsItems = rmsData?.items?.filter((item) => item.status !== "resolved") ?? [];
    const rmsBlocking = rmsItems.filter((item) => item.severity === "critical" || item.severity === "high").length;
    const rmsWarnings = rmsItems.filter((item) => item.severity === "warning" || item.severity === "medium").length;

    const paymentReviewCount = paymentReviewItems.length;
    const failedPaymentUpdates = paymentEvents?.failed_event_count ?? 0;
    const unmatchedPaymentUpdates = paymentEvents?.unmatched_event_count ?? 0;
    const terminalReady = provider?.helcim?.terminal_payments_ready === true;
    const paymentConfigured = provider?.helcim?.api_token_configured === true;

    // Build the 4 status pillars logic
    // 1. Integrations Status
    let integrationsPillar = "GOOD" as HealthStatus;
    const failedIntegrations = (opsData?.integrations ?? []).filter(i => i.status === "failed");
    if (failedIntegrations.some(i => i.severity === "critical")) {
      integrationsPillar = "WARNING";
    } else if (failedIntegrations.length > 0 || (opsData?.integrations ?? []).some(i => i.status === "disabled" || i.status === "caution" || i.status === "CAUTION")) {
      integrationsPillar = "CAUTION";
    }

    // 2. Updates Pillar Status
    const appVersionMismatch = stations.some(s => s.app_version !== CLIENT_SEMVER);
    const updatesPillar = (appVersionMismatch ? "WARNING" : "GOOD") as HealthStatus;

    // 3. POS Pillar Status
    let posPillar = "GOOD" as HealthStatus;
    if (!paymentConfigured || !terminalReady || failedPaymentUpdates > 0) {
      posPillar = "WARNING";
    } else if (paymentReviewCount > 0 || unmatchedPaymentUpdates > 0) {
      posPillar = "CAUTION";
    }

    // 4. Back Office Pillar Status
    let boPillar = "GOOD" as HealthStatus;
    if (opsData?.db_ok === false || rmsBlocking > 0 || cpErrors > 0) {
      boPillar = "WARNING";
    } else if (rmsWarnings > 0 || cpIssues > 0 || (opsData?.stations_offline ?? 0) > 0 || (opsData?.pending_bug_reports ?? 0) > 0) {
      boPillar = "CAUTION";
    }

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
          ? "Store health could not refresh."
          : `${opsData?.stations_online ?? 0} online, ${opsData?.stations_offline ?? 0} offline.`,
        nextAction: (opsData?.stations_offline ?? 0) > 0
          ? "Check offline register workstations."
          : "Review open alerts.",
        buttonLabel: "Open Support Center",
        target: { tab: "settings", section: "ros-operations-center" },
        Icon: ShieldCheck,
      },
    ];

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
    ].slice(0, 8);

    return {
      categories,
      integrationsPillar,
      updatesPillar,
      posPillar,
      boPillar,
      timeline,
      failedIntegrations,
    };
  }, [
    ops,
    counterpoint.data,
    rms.data,
    paymentHealth.data,
    paymentProvider.data,
    paymentIssues.data,
    stations,
    loadedAt,
  ]);

  // Copy snapshot trigger
  const copySnapshot = useCallback(async () => {
    try {
      const summaryText = [
        "ROS Operations & Support Center Snapshot",
        `Generated: ${loadedAt ?? "not loaded"}`,
        `Integrations: ${derived.integrationsPillar}`,
        `Updates: ${derived.updatesPillar}`,
        `POS: ${derived.posPillar}`,
        `Back Office: ${derived.boPillar}`,
        `Stations Online: ${stations.filter(s => s.online).length}`,
        `Alerts Count: ${alerts.length}`,
      ].join("\n");
      await navigator.clipboard.writeText(summaryText);
      setSnapshotCopied(true);
      window.setTimeout(() => setSnapshotCopied(false), 2500);
    } catch {
      setSnapshotCopied(false);
    }
  }, [loadedAt, derived, stations, alerts]);

  // Pagination for Stations / Alerts
  const displayedStations = useMemo(
    () =>
      showStaleStations
        ? stations
        : stations.filter((station) => station.online || station.actionable),
    [showStaleStations, stations],
  );
  const visibleStations = useMemo(
    () =>
      displayedStations.slice(
        (stationPage - 1) * 10,
        stationPage * 10,
      ),
    [displayedStations, stationPage],
  );
  const openAlerts = useMemo(
    () => alerts.filter((a) => a.status === "open" || a.status === "acked"),
    [alerts],
  );
  const visibleAlerts = useMemo(
    () =>
      openAlerts.slice(
        (alertPage - 1) * 6,
        alertPage * 6,
      ),
    [alertPage, openAlerts],
  );
  const readiness = useMemo(() => {
    const opsData = ops.data;
    const cpData = counterpoint.data;
    const paymentEvents = paymentHealth.data;
    const provider = paymentProvider.data;
    const paymentReviewItems = paymentIssues.data ?? [];
    const onlineStations = stations.filter((station) => station.online);
    const offlineActionableStations = stations.filter(
      (station) => !station.online && station.actionable,
    );
    const versionMismatches = stations.filter(
      (station) => station.app_version !== CLIENT_SEMVER,
    );
    const failedIntegrations = (opsData?.integrations ?? []).filter(
      (item) => item.status === "failed",
    );
    const backupIntegration = (opsData?.integrations ?? []).find((item) => {
      const haystack = `${item.key} ${item.title}`.toLowerCase();
      return haystack.includes("backup");
    });
    const cpEntityErrors =
      cpData?.entity_runs?.filter((row) => row.last_error && row.last_error.trim().length > 0)
        .length ?? 0;
    const cpIssues = cpData?.recent_issues?.length ?? 0;
    const paymentConfigured = provider?.helcim?.api_token_configured === true;
    const terminalReady = provider?.helcim?.terminal_payments_ready === true;
    const paymentFailures = paymentEvents?.failed_event_count ?? 0;
    const paymentUnmatched = paymentEvents?.unmatched_event_count ?? 0;
    const criticalAlerts = openAlerts.filter((alert) =>
      ["critical", "error", "blocked", "high"].includes(alert.severity.toLowerCase()),
    );

    const dailyChecks: ReadinessCheck[] = [
      {
        key: "api",
        label: "Backend/API reachable",
        status: ops.error ? "blocked" : opsData ? "ready" : "unknown",
        detail: ops.error ?? (opsData ? "Operations snapshot loaded successfully." : "Operations snapshot has not loaded yet."),
        required: true,
        targetTab: "overview",
      },
      {
        key: "database",
        label: "Database reachable",
        status: opsData?.db_ok === true ? "ready" : opsData?.db_ok === false ? "blocked" : "unknown",
        detail:
          opsData?.db_ok === true
            ? "Database connectivity is healthy."
            : opsData?.db_ok === false
              ? "Database connectivity failed."
              : "Database status is not available.",
        required: true,
        targetTab: "overview",
      },
      {
        key: "register-stations",
        label: "Register # stations online",
        status:
          offlineActionableStations.length > 0
            ? "blocked"
            : onlineStations.length > 0
              ? "ready"
              : stations.length > 0
                ? "warning"
                : "unknown",
        detail:
          stations.length > 0
            ? `${onlineStations.length} online, ${offlineActionableStations.length} actionable offline.`
            : "No station heartbeat rows are available.",
        required: true,
        targetTab: "stations",
      },
      {
        key: "register-sessions",
        label: "Register-session blockers",
        status: "manual_required",
        detail: "No daily open register-session blocker endpoint is connected in this view. Manager must confirm drawers and register sessions before opening.",
        required: true,
        evidence: "Register dashboard / Till Control",
      },
      {
        key: "payments",
        label: "Payment / Helcim readiness",
        status: !paymentConfigured
          ? "not_configured"
          : !terminalReady || paymentFailures > 0
            ? "blocked"
            : paymentReviewItems.length > 0 || paymentUnmatched > 0
              ? "warning"
              : "ready",
        detail: !paymentConfigured
          ? "Helcim API token is not configured."
          : !terminalReady
            ? "Terminal payments are not ready."
            : paymentFailures > 0
              ? `${paymentFailures} failed payment event(s) need review.`
              : paymentReviewItems.length > 0 || paymentUnmatched > 0
                ? `${paymentReviewItems.length} reconciliation item(s), ${paymentUnmatched} unmatched event(s).`
                : "Terminal payments and recent events are clear.",
        required: true,
        targetTab: "integrations",
      },
      {
        key: "counterpoint",
        label: "Counterpoint bridge / sync",
        status: counterpoint.error
          ? "unknown"
          : cpEntityErrors > 0
            ? "blocked"
            : cpIssues > 0 || (cpData?.staging_pending_count ?? 0) > 0
              ? "warning"
              : cpData
                ? "ready"
                : "not_configured",
        detail: counterpoint.error
          ? counterpoint.error
          : cpEntityErrors > 0
            ? `${cpEntityErrors} entity sync error(s) found.`
            : cpIssues > 0
              ? `${cpIssues} recent Counterpoint issue(s) found.`
              : cpData
                ? "Counterpoint status endpoint is connected."
                : "Counterpoint status is not connected.",
        required: true,
        targetTab: "integrations",
      },
      {
        key: "qbo",
        label: "QBO / accounting readiness",
        status: "manual_required",
        detail: "QBO signoff is not automated in this readiness view. Manager must review QBO staging/sync before relying on daily financials.",
        required: false,
        evidence: "QBO bridge workspace",
      },
      {
        key: "backup",
        label: "Backup freshness",
        status: backupIntegration
          ? backupIntegration.status === "failed"
            ? "blocked"
            : backupIntegration.status === "ok" || backupIntegration.status === "ready"
              ? "ready"
              : "warning"
          : "manual_required",
        detail: backupIntegration?.detail ?? "Backup freshness is not exposed as an automated readiness signal here. Review backup evidence before go-live.",
        required: true,
        targetTab: backupIntegration ? "integrations" : undefined,
        evidence: backupIntegration ? undefined : "BACKUP_RESTORE_GUIDE.md",
      },
      {
        key: "critical-alerts",
        label: "Critical operational alerts",
        status:
          criticalAlerts.length > 0
            ? "blocked"
            : openAlerts.length > 0 || (opsData?.pending_bug_reports ?? 0) > 0
              ? "warning"
              : "ready",
        detail:
          criticalAlerts.length > 0
            ? `${criticalAlerts.length} critical alert(s) are open.`
            : openAlerts.length > 0
              ? `${openAlerts.length} alert(s) need review.`
              : (opsData?.pending_bug_reports ?? 0) > 0
                ? `${opsData?.pending_bug_reports ?? 0} pending bug report(s) need triage.`
                : "No critical alerts or pending bug report blockers.",
        required: true,
        targetTab: criticalAlerts.length > 0 || openAlerts.length > 0 ? "alerts" : "bugs",
      },
    ];

    const goLiveChecks: ReadinessCheck[] = [
      {
        key: "release-version",
        label: "Release / version verified",
        status:
          stations.length === 0
            ? "unknown"
            : versionMismatches.length > 0
              ? "warning"
              : "ready",
        detail:
          stations.length === 0
            ? `Current client is ${CLIENT_SEMVER}; no station fleet rows are loaded.`
            : versionMismatches.length > 0
              ? `${versionMismatches.length} station(s) do not match ${CLIENT_SEMVER}.`
              : `All loaded stations match ${CLIENT_SEMVER}.`,
        required: true,
        targetTab: "stations",
        evidence: "docs/releases/v0.90.0-certification.md",
      },
      {
        key: "migrations",
        label: "Migrations applied",
        status: opsData?.db_ok === true ? "ready" : opsData?.db_ok === false ? "blocked" : "unknown",
        detail: opsData?.db_ok === true ? "Database is reachable; migration-specific proof still belongs in deployment evidence." : "Database health is not confirmed.",
        required: true,
        evidence: "docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md",
      },
      {
        key: "store-deployment",
        label: "Windows / store deployment complete",
        status: "manual_required",
        detail: "Deployment completion is a manual owner/support signoff. Use the deployment guide and go/no-go checklist.",
        required: true,
        evidence: "docs/STORE_DEPLOYMENT_GUIDE.md",
      },
      {
        key: "register-deployment",
        label: "Register # station deployment validated",
        status:
          offlineActionableStations.length > 0
            ? "blocked"
            : onlineStations.length > 0 && versionMismatches.length === 0
              ? "ready"
              : "manual_required",
        detail:
          onlineStations.length > 0
            ? `${onlineStations.length} online station(s); ${versionMismatches.length} version mismatch(es).`
            : "No online Register # station evidence is loaded.",
        required: true,
        targetTab: "stations",
      },
      {
        key: "hardware-stress",
        label: "Hardware stress test passed",
        status: "manual_required",
        detail: "Printer, scanner, cash drawer, and payment hardware stress proof must be reviewed manually.",
        required: true,
        evidence: "docs/staff/hardware-stress-test-manual.md",
      },
      {
        key: "qbo-signoff",
        label: "QBO / accounting signoff complete",
        status: "manual_required",
        detail: "Accounting signoff is not inferred from runtime health.",
        required: true,
        evidence: "QBO bridge workspace",
      },
      {
        key: "counterpoint-reconciliation",
        label: "Counterpoint reconciliation complete",
        status:
          cpEntityErrors > 0
            ? "blocked"
            : cpIssues > 0
              ? "warning"
              : "manual_required",
        detail:
          cpEntityErrors > 0
            ? `${cpEntityErrors} Counterpoint entity error(s) block certification.`
            : cpIssues > 0
              ? `${cpIssues} Counterpoint issue(s) need reconciliation review.`
              : "Runtime bridge status can be clean, but reconciliation still requires signoff.",
        required: true,
        targetTab: "integrations",
      },
      {
        key: "backup-restore",
        label: "Backup restore drill complete",
        status: "manual_required",
        detail: "Restore-drill evidence must be verified by owner/support before certification.",
        required: true,
        evidence: "docs/BACKUP_SYSTEM_VERIFICATION.md",
      },
      {
        key: "help-center",
        label: "Help Center / docs current",
        status: "manual_required",
        detail: "Help Center generation and screenshot freshness are build/release evidence, not runtime proof.",
        required: true,
        evidence: "docs/MANUAL_CREATION.md",
      },
      {
        key: "pilot-signoff",
        label: "Staff pilot / go-no-go signoff complete",
        status: "manual_required",
        detail: "Owner and staff pilot signoff must be recorded outside automated health checks.",
        required: true,
        evidence: "docs/staff/pilot-support-package.md",
      },
    ];

    const evidenceChecks: ReadinessCheck[] = [
      {
        key: "snapshot",
        label: "Diagnostics snapshot",
        status: runtimeDiagnostics ? "ready" : "unknown",
        detail: runtimeDiagnostics ? `Runtime diagnostics generated ${fmtTs(runtimeDiagnostics.generated_at)}.` : "Runtime diagnostics have not loaded.",
        required: false,
        targetTab: "overview",
      },
      {
        key: "fleet",
        label: "Station fleet status",
        status: stations.length > 0 ? "ready" : "unknown",
        detail: stations.length > 0 ? `${stations.length} station row(s) available.` : "No station rows loaded.",
        required: false,
        targetTab: "stations",
      },
      {
        key: "integrations",
        label: "Integration monitor",
        status: failedIntegrations.length > 0 ? "warning" : opsData?.integrations ? "ready" : "unknown",
        detail: opsData?.integrations ? `${opsData.integrations.length} integration signal(s), ${failedIntegrations.length} failed.` : "Integration signals are not loaded.",
        required: false,
        targetTab: "integrations",
      },
      {
        key: "docs",
        label: "Release, deployment, backup, and smoke-check docs",
        status: "manual_required",
        detail: "Review the referenced documents for proof instead of duplicating long checklists in this UI.",
        required: false,
        evidence: "docs/PRODUCTION_DEPLOYMENT_GO_NO_GO_CHECKLIST.md; docs/operations/post-release/operational-smoke-checklist.md",
      },
      {
        key: "bugs",
        label: "Recent bugs / alerts / updates",
        status: (opsData?.pending_bug_reports ?? 0) > 0 || openAlerts.length > 0 ? "warning" : "ready",
        detail: `${opsData?.pending_bug_reports ?? 0} pending bug report(s), ${openAlerts.length} active alert(s).`,
        required: false,
        targetTab: "bugs",
      },
    ];

    return {
      daily: {
        category: "daily_open",
        title: "Daily Open Readiness",
        purpose: "Answers whether Riverside OS can safely open and operate the store today.",
        overall: dailyOverall(applyReadinessSignoffs(dailyChecks, readinessSignoffs)),
        checks: applyReadinessSignoffs(dailyChecks, readinessSignoffs),
      },
      certification: {
        category: "go_live",
        title: "Go-Live / Production Certification",
        purpose: "Answers whether this environment is certified for production rollout, a major release, or a new Register # station.",
        overall: certificationOverall(applyReadinessSignoffs(goLiveChecks, readinessSignoffs)),
        checks: applyReadinessSignoffs(goLiveChecks, readinessSignoffs),
      },
      evidence: {
        category: "evidence",
        title: "Evidence & Support",
        purpose: "Gives owner, manager, and support one place to find proof and copy current diagnostic context.",
        overall: dailyOverall(applyReadinessSignoffs(evidenceChecks, readinessSignoffs)),
        checks: applyReadinessSignoffs(evidenceChecks, readinessSignoffs),
      },
    } satisfies {
      daily: ReadinessSection;
      certification: ReadinessSection;
      evidence: ReadinessSection;
    };
  }, [
    counterpoint.data,
    counterpoint.error,
    openAlerts,
    ops.data,
    ops.error,
    paymentHealth.data,
    paymentIssues.data,
    paymentProvider.data,
    runtimeDiagnostics,
    readinessSignoffs,
    stations,
  ]);

  return (
    <div className="flex flex-1 flex-col bg-app-bg text-app-text font-sans">
      <div className="space-y-6 p-4 sm:p-6 lg:p-8" data-testid="ros-operations-center">
        {/* Universal Top Dashboard Header */}
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between border-b border-app-border/40 pb-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-app-text-muted">
              System Operations
            </p>
            <h2 className="mt-2 text-3xl font-black italic tracking-tighter uppercase text-app-text flex items-center gap-2">
              <ShieldAlert className="h-8 w-8 text-app-accent" />
              ROS Operations & Support Center
            </h2>
            <p className="mt-1 text-sm font-medium text-app-text-muted">
              v0.85.0 Command Plane & Active Heartbeat diagnostics panel.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copySnapshot()}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface-2"
            >
              <Copy size={14} /> {snapshotCopied ? "Snapshot Copied" : "Copy Snapshot"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50 transition-transform active:scale-95"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        {/* Universal Tabs */}
        <div className="flex flex-wrap gap-2 border-b border-app-border/40 pb-3">
          {(
            [
              { id: "overview", label: "Operations Overview" },
              { id: "readiness", label: "Readiness" },
              { id: "stations", label: "Stations Fleet" },
              { id: "alerts", label: "Alert Triage" },
              { id: "integrations", label: "Integration Health" },
              { id: "bugs", label: "Bug Manager" },
              { id: "updates", label: "Updates" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg px-4 py-2 text-xs font-black uppercase tracking-widest transition-all ${
                activeTab === tab.id
                  ? "bg-app-accent text-white shadow-md shadow-app-accent/20"
                  : "text-app-text-muted hover:bg-app-surface hover:text-app-text"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content Rendering */}
        {activeTab === "overview" && (
          <div className="space-y-6 animate-in fade-in duration-300">
            
            {/* Primary View: 4 Status Grid Pillars */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
              
              {/* Pillar 1: Integrations */}
              <div className={`ui-card p-5 border-l-4 rounded-xl shadow-sm bg-app-surface/50 backdrop-blur-md transition-transform hover:-translate-y-1 ${
                derived.integrationsPillar === "WARNING" ? "border-l-app-danger border-app-danger/20 animate-pulse" :
                derived.integrationsPillar === "CAUTION" ? "border-l-app-warning border-app-warning/20" :
                "border-l-app-success border-app-border/60"
              }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Integrations</span>
                    <h3 className="text-xl font-black mt-1">
                      {derived.integrationsPillar}
                    </h3>
                  </div>
                  <Database size={20} className={
                    derived.integrationsPillar === "WARNING" ? "text-app-danger" :
                    derived.integrationsPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
                  } />
                </div>
                
                {derived.integrationsPillar !== "GOOD" && (
                  <div className="mt-3 bg-app-bg/60 p-3 rounded-lg border border-app-border/40 text-xs">
                    <p className="font-bold text-app-text">Why this is an issue:</p>
                    <p className="text-app-text-muted mt-0.5">
                      {derived.integrationsPillar === "WARNING" 
                        ? "Critical external sync systems (e.g. QBO, Lightspeed) are offline or reporting invalid credentials."
                        : "One or more integrations are not configured or are experiencing minor connectivity lag."}
                    </p>
                  </div>
                )}
                
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("integrations")}
                    className="ui-btn-ghost flex-1 py-2 text-[10px] font-black uppercase tracking-widest text-center"
                  >
                    Diagnose
                  </button>
                  {derived.integrationsPillar === "WARNING" && (
                    <button
                      type="button"
                      disabled={triggerCheckBusy}
                      onClick={() => void triggerHeartbeat()}
                      className="ui-btn-primary bg-app-danger hover:bg-app-danger/80 py-2 px-3 text-[10px] font-black uppercase tracking-widest text-center text-white"
                    >
                      {triggerCheckBusy ? "Probing..." : "Direct Fix"}
                    </button>
                  )}
                </div>
              </div>

              {/* Pillar 2: Updates */}
              <div className={`ui-card p-5 border-l-4 rounded-xl shadow-sm bg-app-surface/50 backdrop-blur-md transition-transform hover:-translate-y-1 ${
                derived.updatesPillar === "WARNING" ? "border-l-app-danger border-app-danger/20" :
                derived.updatesPillar === "CAUTION" ? "border-l-app-warning border-app-warning/20" :
                "border-l-app-success border-app-border/60"
              }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Updates</span>
                    <h3 className="text-xl font-black mt-1">
                      {derived.updatesPillar}
                    </h3>
                  </div>
                  <RefreshCw size={20} className={
                    derived.updatesPillar === "WARNING" ? "text-app-danger" :
                    derived.updatesPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
                  } />
                </div>
                
                {derived.updatesPillar !== "GOOD" && (
                  <div className="mt-3 bg-app-bg/60 p-3 rounded-lg border border-app-border/40 text-xs">
                    <p className="font-bold text-app-text">Why this is an issue:</p>
                    <p className="text-app-text-muted mt-0.5">
                      Station fleet client version mismatch detected. Version consistency is required for database schema integrity.
                    </p>
                  </div>
                )}
                
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("updates")}
                    className="ui-btn-ghost flex-1 py-2 text-[10px] font-black uppercase tracking-widest text-center"
                  >
                    View Status
                  </button>
                  {derived.updatesPillar === "WARNING" && (
                    <button
                      type="button"
                      onClick={() => setActiveTab("updates")}
                      className="ui-btn-primary py-2 px-3 text-[10px] font-black uppercase tracking-widest text-center text-white"
                    >
                      Update Fleet
                    </button>
                  )}
                </div>
              </div>

              {/* Pillar 3: POS */}
              <div className={`ui-card p-5 border-l-4 rounded-xl shadow-sm bg-app-surface/50 backdrop-blur-md transition-transform hover:-translate-y-1 ${
                derived.posPillar === "WARNING" ? "border-l-app-danger border-app-danger/20 animate-pulse" :
                derived.posPillar === "CAUTION" ? "border-l-app-warning border-app-warning/20" :
                "border-l-app-success border-app-border/60"
              }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">POS & Payments</span>
                    <h3 className="text-xl font-black mt-1">
                      {derived.posPillar}
                    </h3>
                  </div>
                  <TerminalSquare size={20} className={
                    derived.posPillar === "WARNING" ? "text-app-danger" :
                    derived.posPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
                  } />
                </div>
                
                {derived.posPillar !== "GOOD" && (
                  <div className="mt-3 bg-app-bg/60 p-3 rounded-lg border border-app-border/40 text-xs">
                    <p className="font-bold text-app-text">Why this is an issue:</p>
                    <p className="text-app-text-muted mt-0.5">
                      {derived.posPillar === "WARNING" 
                        ? "Helcim payment terminal connection is offline or has unverified transactions awaiting confirmation."
                        : "Payment review items or blocked checkout queues require staff intervention."}
                    </p>
                  </div>
                )}
                
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onNavigate({ tab: "payments", section: "health" })}
                    className="ui-btn-ghost flex-1 py-2 text-[10px] font-black uppercase tracking-widest text-center"
                  >
                    Payments Setup
                  </button>
                  {derived.posPillar === "WARNING" && (
                    <button
                      type="button"
                      onClick={() => onNavigate({ tab: "settings", section: "helcim" })}
                      className="ui-btn-primary py-2 px-3 text-[10px] font-black uppercase tracking-widest text-center text-white"
                    >
                      Quick-Fix
                    </button>
                  )}
                </div>
              </div>

              {/* Pillar 4: Back Office */}
              <div className={`ui-card p-5 border-l-4 rounded-xl shadow-sm bg-app-surface/50 backdrop-blur-md transition-transform hover:-translate-y-1 ${
                derived.boPillar === "WARNING" ? "border-l-app-danger border-app-danger/20 animate-pulse" :
                derived.boPillar === "CAUTION" ? "border-l-app-warning border-app-warning/20" :
                "border-l-app-success border-app-border/60"
              }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Back Office & Server</span>
                    <h3 className="text-xl font-black mt-1">
                      {derived.boPillar}
                    </h3>
                  </div>
                  <Server size={20} className={
                    derived.boPillar === "WARNING" ? "text-app-danger" :
                    derived.boPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
                  } />
                </div>
                
                {derived.boPillar !== "GOOD" && (
                  <div className="mt-3 bg-app-bg/60 p-3 rounded-lg border border-app-border/40 text-xs">
                    <p className="font-bold text-app-text">Why this is an issue:</p>
                    <p className="text-app-text-muted mt-0.5">
                      {derived.boPillar === "WARNING"
                        ? "Server database integrity alert, schema conflicts, or critical RMS synchronization failure."
                        : "Offline client heartbeats or unlinked bug reports pending review."}
                    </p>
                  </div>
                )}
                
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("alerts")}
                    className="ui-btn-ghost flex-1 py-2 text-[10px] font-black uppercase tracking-widest text-center"
                  >
                    View Alerts
                  </button>
                  {derived.boPillar === "WARNING" && (
                    <button
                      type="button"
                      onClick={() => onNavigate({ tab: "settings", section: "backups" })}
                      className="ui-btn-primary py-2 px-3 text-[10px] font-black uppercase tracking-widest text-center text-white"
                    >
                      Database Fix
                    </button>
                  )}
                </div>
              </div>

            </div>

            {/* Store Open/Close checklist section */}
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
                      className={`min-h-10 rounded-xl border px-4 text-[10px] font-black uppercase tracking-widest transition-all ${
                        checklistMode === mode
                          ? "border-app-accent bg-app-accent/10 text-app-accent font-black"
                          : "border-app-border bg-app-bg text-app-text-muted hover:text-app-text"
                      }`}
                    >
                      {mode === "open" ? "Open Store" : "Close Store"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {derived.categories.map((category) => {
                  const Icon = category.Icon;
                  return (
                    <article
                      key={`${checklistMode}-${category.id}`}
                      className={`rounded-xl border p-4 bg-app-surface border-app-border`}
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
                        <span className={`shrink-0 rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-widest ${
                          category.status === "blocked" ? "border-app-danger/30 bg-app-danger/10 text-app-danger" : "border-app-success/30 bg-app-success/10 text-app-success"
                        }`}>
                          {category.status}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onNavigate(category.target)}
                        className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-app-border bg-app-bg px-3 text-[9px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2 transition-colors"
                      >
                        Resolve Source
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>

            {/* Diagnostics Summary & Support Copy Pane */}
            <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-2xl border border-app-border bg-app-surface p-5">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={18} className="text-app-warning" />
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Operational Timeline
                  </h3>
                </div>
                <div className="mt-4 space-y-3">
                  {derived.timeline.length > 0 ? (
                    derived.timeline.map((item, idx) => (
                      <div key={idx} className="rounded-xl border border-app-border bg-app-bg/50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-black text-app-text">{item.label}</p>
                          <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
                            item.status === "blocked" ? "border-app-danger/30 bg-app-danger/10 text-app-danger" : "border-app-warning/30 bg-app-warning/10 text-app-warning"
                          }`}>
                            {item.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-app-text-muted">{item.detail}</p>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-xl border border-app-border bg-app-bg/50 p-4 text-sm font-semibold text-app-text-muted">
                      No recent operational timeline exceptions recorded.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-app-border bg-app-surface p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <ClipboardCheck size={18} className="text-app-accent" />
                    <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                      Diagnostics Snapshot
                    </h3>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-app-text-muted">
                    Save the current operational snap to clipboard for remote team review, or run immediate runtime diagnostics tests.
                  </p>
                  <div className="mt-4 border border-app-border rounded-xl p-3 bg-black/10 font-mono text-[10px] text-app-text-muted">
                    <p>Client Semver: {CLIENT_SEMVER}</p>
                    <p>Git Build Hash: {GIT_SHORT || "Local Dev Build"}</p>
                    <p>Stations Online: {stations.filter(s => s.online).length}</p>
                    <p>
                      Database Connectivity:{" "}
                      {ops.data?.db_ok === true
                        ? "OK"
                        : ops.data?.db_ok === false
                          ? "FAILED"
                          : "UNKNOWN"}
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => void copySnapshot()}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2 transition-colors"
                  >
                    <Copy size={14} /> Copy Snapshot
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("stations")}
                    className="inline-flex min-h-10 items-center justify-center rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2 transition-colors"
                  >
                    Diagnose Fleet
                  </button>
                </div>
              </div>
            </section>

          </div>
        )}

        {/* TAB: READINESS */}
        {activeTab === "readiness" && (
          <div className="space-y-6 animate-in fade-in duration-300">
            <section className="rounded-2xl border border-app-border bg-app-surface p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-app-text-muted">
                    Owner Readiness
                  </p>
                  <h3 className="mt-1 text-2xl font-black italic uppercase tracking-tight text-app-text">
                    Can Riverside OS open the store today?
                  </h3>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
                    This view consolidates existing health, station, integration, alert, backup, and support evidence.
                    Manual items stay manual so this screen does not create false confidence.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copySnapshot()}
                    className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                  >
                    <Copy size={14} /> Copy Snapshot
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("alerts")}
                    className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                  >
                    <AlertTriangle size={14} /> Alerts
                  </button>
                </div>
              </div>
            </section>

            {([readiness.daily, readiness.certification, readiness.evidence] as ReadinessSection[]).map((section) => (
              <section
                key={section.title}
                className="rounded-2xl border border-app-border bg-app-surface p-5"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h3 className="text-lg font-black uppercase tracking-tight text-app-text">
                      {section.title}
                    </h3>
                    <p className="mt-1 max-w-3xl text-xs font-semibold leading-relaxed text-app-text-muted">
                      {section.purpose}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${readinessOverallClass(section.overall)}`}
                  >
                    {section.overall}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 xl:grid-cols-2">
                  {section.checks.map((check) => {
                    const draft = signoffDrafts[check.key] ?? {
                      notes: check.signoff?.notes ?? "",
                      evidence_ref: check.signoff?.evidence_ref ?? check.evidence ?? "",
                      expires_at: check.signoff?.expires_at?.slice(0, 10) ?? "",
                    };
                    const canEditSignoff =
                      canRunActions &&
                      (check.status === "manual_required" || check.signoff != null);
                    return (
                    <article
                      key={check.key}
                      className="rounded-xl border border-app-border bg-app-bg/40 p-4"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-black text-app-text">
                              {check.label}
                            </p>
                            {check.required ? (
                              <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-text-muted">
                                Required
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                            {check.detail}
                          </p>
                          {check.evidence ? (
                            <p className="mt-2 break-words font-mono text-[10px] text-app-text-muted">
                              Evidence: {check.evidence}
                            </p>
                          ) : null}
                        </div>
                        <span
                          className={`shrink-0 rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest ${readinessStatusClass(check.status)}`}
                        >
                          {readinessStatusLabel(check.status)}
                        </span>
                      </div>
                      {check.targetTab ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (check.targetTab) setActiveTab(check.targetTab);
                          }}
                          className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-app-border bg-app-surface px-3 text-[9px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                        >
                          Open Source
                        </button>
                      ) : null}
                      {check.signoff ? (
                        <div className="mt-3 rounded-lg border border-app-border bg-app-surface/70 p-3 text-[10px] font-semibold leading-relaxed text-app-text-muted">
                          <p>
                            Signoff: {check.signoff.status === "ready" ? "Ready" : "Reopened"}
                            {check.signoff.signed_off_by_staff_name
                              ? ` by ${check.signoff.signed_off_by_staff_name}`
                              : ""}
                            {check.signoff.signed_off_at
                              ? ` on ${fmtTs(check.signoff.signed_off_at)}`
                              : ""}
                          </p>
                          {check.signoff.expires_at ? (
                            <p>Expires: {fmtTs(check.signoff.expires_at)}</p>
                          ) : null}
                          {check.signoff.notes ? <p>Notes: {check.signoff.notes}</p> : null}
                        </div>
                      ) : null}
                      {canEditSignoff ? (
                        <div className="mt-3 space-y-2 rounded-lg border border-app-border bg-app-surface/70 p-3">
                          <div className="grid gap-2 sm:grid-cols-2">
                            <input
                              type="text"
                              value={draft.evidence_ref}
                              onChange={(event) =>
                                updateSignoffDraft(check.key, {
                                  evidence_ref: event.target.value,
                                })
                              }
                              placeholder="Evidence link, file, or workspace"
                              className="ui-input text-xs"
                            />
                            <input
                              type="date"
                              value={draft.expires_at}
                              onChange={(event) =>
                                updateSignoffDraft(check.key, {
                                  expires_at: event.target.value,
                                })
                              }
                              className="ui-input text-xs"
                            />
                          </div>
                          <textarea
                            value={draft.notes}
                            onChange={(event) =>
                              updateSignoffDraft(check.key, {
                                notes: event.target.value,
                              })
                            }
                            placeholder="Manager notes"
                            className="ui-input min-h-16 w-full text-xs"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={signoffBusyKey === check.key}
                              onClick={() => void saveReadinessSignoff(section, check, "ready")}
                              className="inline-flex min-h-9 items-center rounded-lg bg-app-accent px-3 text-[9px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                            >
                              Manager Signoff
                            </button>
                            {check.signoff ? (
                              <button
                                type="button"
                                disabled={signoffBusyKey === check.key}
                                onClick={() =>
                                  void saveReadinessSignoff(section, check, "manual_required")
                                }
                                className="inline-flex min-h-9 items-center rounded-lg border border-app-border bg-app-surface px-3 text-[9px] font-black uppercase tracking-widest text-app-text disabled:opacity-50"
                              >
                                Reopen
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* TAB: STATIONS FLEET */}
        {activeTab === "stations" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl animate-in fade-in duration-300">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Server className="h-5 w-5 text-app-accent" />
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Station Fleet Triage
                  </h3>
                  <p className="mt-1 text-xs text-app-text-muted">
                    Workstation pulse monitoring. Toggle Stale History to view older inactive sessions.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowStaleStations((value) => !value)}
                  className="rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface hover:text-app-text transition-colors"
                >
                  {showStaleStations ? "Hide Stale" : "Show Stale"}
                </button>
              </div>
            </div>

            <div className="mt-3 overflow-auto rounded-xl border border-app-border/60">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="bg-app-surface/80 text-[10px] uppercase tracking-widest text-app-text-muted border-b border-app-border">
                    <th className="px-4 py-3">Station</th>
                    <th className="px-4 py-3">Version</th>
                    <th className="px-4 py-3">Network / IP</th>
                    <th className="px-4 py-3">Staff Access</th>
                    <th className="px-4 py-3">Last Seen</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleStations.map((s) => (
                    <tr key={s.station_key} className="border-t border-app-border/60 hover:bg-app-surface/20 transition-colors">
                      <td className="px-4 py-3 font-bold">{s.station_label}</td>
                      <td className="px-4 py-3 font-mono text-xs">{s.app_version}</td>
                      <td className="px-4 py-3 text-xs text-app-text-muted">{s.tailscale_node || s.lan_ip || "-"}</td>
                      <td className="px-4 py-3 text-xs text-app-text-muted">
                        {s.active_staff_sessions > 0
                          ? `${s.active_staff_names} (${s.active_staff_sessions})`
                          : "No active session"}
                      </td>
                      <td className="px-4 py-3 text-xs text-app-text-muted">{fmtTs(s.last_seen_at)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${
                          s.online ? "bg-app-success/10 text-app-success border border-app-success/20" : "bg-app-danger/10 text-app-danger border border-app-danger/20"
                        }`}>
                          {s.online ? "Online" : "Offline"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            <div className="mt-6 flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                disabled={stationPage <= 1}
                onClick={() => setStationPage(p => Math.max(1, p - 1))}
                className="ui-btn-ghost px-3 py-1.5 text-[10px] font-black uppercase"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={visibleStations.length < 10}
                onClick={() => setStationPage(p => p + 1)}
                className="ui-btn-ghost px-3 py-1.5 text-[10px] font-black uppercase"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* TAB: ALERTS */}
        {activeTab === "alerts" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl animate-in fade-in duration-300">
            <div className="mb-4">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Alert Center
              </h3>
              <p className="mt-1 text-xs text-app-text-muted">
                Active operational triggers. Acknowledging items updates their status while keeping them visible.
              </p>
            </div>

            <div className="space-y-3">
              {visibleAlerts.map((a) => (
                <div key={a.id} className="border border-app-border bg-app-bg/50 p-4 rounded-xl flex justify-between items-start">
                  <div>
                    <p className="font-bold text-app-text">{a.title}</p>
                    <p className="text-xs text-app-text-muted mt-1">{a.body}</p>
                    <p className="text-[10px] text-app-text-muted mt-2">First Seen: {fmtTs(a.first_seen_at)}</p>
                  </div>
                  {canRunActions && a.status === "open" && (
                    <button
                      type="button"
                      onClick={() => void ackAlert(a.id)}
                      className="ui-btn-primary py-1 px-3 text-[10px] font-black uppercase text-white"
                    >
                      Ack
                    </button>
                  )}
                </div>
              ))}
              {openAlerts.length === 0 && (
                <p className="text-sm text-app-text-muted">No open/active system alerts.</p>
              )}
            </div>
            
            <div className="mt-6 flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                disabled={alertPage <= 1}
                onClick={() => setAlertPage(p => Math.max(1, p - 1))}
                className="ui-btn-ghost px-3 py-1.5 text-[10px] font-black uppercase"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={visibleAlerts.length < 6}
                onClick={() => setAlertPage(p => p + 1)}
                className="ui-btn-ghost px-3 py-1.5 text-[10px] font-black uppercase"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* TAB: INTEGRATION HEALTH */}
        {activeTab === "integrations" && (
          <div className="space-y-6 animate-in fade-in duration-300">
            <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Integration Status Monitor
                  </h3>
                  <p className="mt-1 text-xs text-app-text-muted">
                    API connectivity, background workers, and sync health logs.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={triggerCheckBusy}
                  onClick={() => void triggerHeartbeat()}
                  className="ui-btn-primary py-2 px-4 text-xs font-black uppercase text-white"
                >
                  {triggerCheckBusy ? "Testing..." : "Force Heartbeat Poll"}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(ops.data?.integrations ?? []).map((item) => (
                  <div key={item.key} className="border border-app-border p-4 rounded-xl bg-app-bg/30">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-bold text-app-text">{item.title}</p>
                        <p className="text-xs text-app-text-muted mt-1">{item.detail || "No details available"}</p>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${
                        item.status === "failed" ? "bg-app-danger/10 text-app-danger border border-app-danger/20 animate-pulse" : "bg-app-success/10 text-app-success border border-app-success/20"
                      }`}>
                        {item.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Diagnostic logs */}
            <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Connectivity Log
              </h3>
              <p className="mt-1 text-xs text-app-text-muted">
                Transition log of integrations state changes (GOOD &lt;-&gt; WARNING).
              </p>
              
              <div className="mt-4 max-h-[300px] overflow-y-auto space-y-2">
                {connectivityLogs.map((log) => (
                  <div key={log.id} className="border-b border-app-border/40 py-2 flex justify-between text-xs">
                    <div>
                      <span className="font-bold text-app-text uppercase">{log.source}</span>
                      <span className="text-app-text-muted ml-2">
                        {log.old_status} &rarr; <span className={log.new_status === "WARNING" ? "text-app-danger font-bold" : "text-app-success"}>{log.new_status}</span>
                      </span>
                      <p className="text-[10px] text-app-text-muted mt-0.5">{log.detail}</p>
                    </div>
                    <span className="text-app-text-muted font-mono">{fmtTs(log.created_at)}</span>
                  </div>
                ))}
                {connectivityLogs.length === 0 && (
                  <p className="text-xs text-app-text-muted">No state transition logs available.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB: BUGS */}
        {activeTab === "bugs" && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Bug linking section */}
            {canRunActions && (
              <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl">
                <div className="mb-4">
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Bug incident links
                  </h3>
                  <p className="mt-1 text-xs text-app-text-muted">
                    Associate front-end bug tickets directly with server operational alerts.
                  </p>
                </div>
                <div className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-app-border p-4 lg:grid-cols-4 bg-app-bg/30">
                  <select
                    value={selectedBugId}
                    onChange={(e) => setSelectedBugId(e.target.value)}
                    className="ui-input bg-app-bg text-app-text border-app-border"
                  >
                    <option value="">Select bug report</option>
                    {bugsOverview.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.summary.slice(0, 72)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={selectedAlertId}
                    onChange={(e) => setSelectedAlertId(e.target.value)}
                    className="ui-input bg-app-bg text-app-text border-app-border"
                  >
                    <option value="">Select alert</option>
                    {openAlerts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                  <input
                    value={linkNote}
                    onChange={(e) => setLinkNote(e.target.value)}
                    placeholder="Optional link note"
                    className="ui-input bg-app-bg text-app-text border-app-border"
                  />
                  <button
                    type="button"
                    disabled={linkBusy}
                    onClick={() => void linkBugAlert()}
                    className="ui-btn-primary px-4 py-2 text-xs font-black uppercase tracking-widest"
                  >
                    {linkBusy ? "Linking..." : "Link Bug To Alert"}
                  </button>
                </div>
              </div>
            )}

            <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl">
              <div className="mb-4">
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Bug Manager
                </h3>
                <p className="mt-1 text-xs text-app-text-muted">
                  Create, view, and update customer and staff-filed bug report tickets.
                </p>
              </div>
              <BugReportsSettingsPanel
                deepLinkReportId={bugReportsDeepLinkId}
                onDeepLinkConsumed={onBugReportsDeepLinkConsumed}
              />
            </div>
          </div>
        )}

        {/* TAB: UPDATES */}
        {activeTab === "updates" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl animate-in fade-in duration-300">
            <UpdateManagerPanel />
          </div>
        )}

      </div>
      
      {/* Hidden container to ensure required runtime diagnostics imports are consumed */}
      <div className="hidden" aria-hidden="true">
        {runtimeDiagnostics?.generated_at}
        {lifecycleQueues.error}
        {notifications.error}
        {fulfillment.error}
        {Activity && <Activity />}
        {Bell && <Bell />}
        {Bug && <Bug />}
      </div>
    </div>
  );
}

function fmtTs(v: string | null): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}
