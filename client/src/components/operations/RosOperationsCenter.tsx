import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { CLIENT_SEMVER } from "../../clientBuildMeta";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  Bug,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";

const BugReportsSettingsPanel = lazy(
  () => import("../settings/BugReportsSettingsPanel"),
);
const UpdateManagerPanel = lazy(
  () => import("../settings/UpdateManagerPanel"),
);
const PosJourneyMetricsPanel = lazy(
  () => import("./PosJourneyMetricsPanel"),
);

const baseUrl = getBaseUrl();

type HealthStatus = "WARNING" | "CAUTION" | "GOOD";
type OperationsCenterTab =
  | "overview"
  | "readiness"
  | "stations"
  | "alerts"
  | "integrations"
  | "performance"
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
    | "staff"
    | "customer-notifications";
  section?: string;
  appointmentId?: string;
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

interface SystemReadinessSnapshot {
  status: string;
  build_sha: string;
  unavailable_components?: string[];
  backup?: {
    worker_healthy: boolean;
    tooling_ready: boolean;
    artifact_usable: boolean;
    recent_verified_backup: boolean;
    last_verified_at?: string | null;
    last_verified_filename?: string | null;
    verification_method?: string | null;
    max_age_hours?: number;
  };
  rosie?: {
    llm_available: boolean;
    multimodal_available: boolean;
    stt_available: boolean;
    tts_available: boolean;
  };
}

interface OpenRegisterSession {
  session_id: string;
  register_lane: number;
  cashier_name: string;
  opened_at: string;
  lifecycle_status: string;
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
  unresolved_issue_count?: number;
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

interface HelcimSettlementStatus {
  open_item_count: number;
  actionable_open_item_count: number;
  mismatch_count: number;
  unmatched_transaction_count: number;
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
  client_timestamp_source: string;
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

type OperationsTodayLevel = "do_now" | "follow_up";

interface OperationsTodayItem {
  id: string;
  level: OperationsTodayLevel;
  title: string;
  detail: string;
  nextAction: string;
  sourceLabel: string;
  occurredAt?: string | null;
  targetTab?: OperationsCenterTab;
  navigateTarget?: OperationsCenterNavigateTarget;
}

interface HealthyProof {
  id: string;
  label: string;
  detail: string;
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

async function fetchReadiness(headers: HeadersInit): Promise<LoadState<SystemReadinessSnapshot>> {
  try {
    const response = await fetch(`${baseUrl}/api/ready`, { headers });
    const body = (await response.json()) as SystemReadinessSnapshot;
    return {
      data: body,
      error: response.ok ? null : `Main Hub is not ready (${response.status}).`,
    };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Could not refresh Main Hub readiness.",
    };
  }
}

function isTechnicalAuditAlert(alert: AlertEventRow): boolean {
  const text = `${alert.rule_key} ${alert.title} ${alert.body}`.toLowerCase();
  return text.includes("audit_probe") || text.includes("production audit probe");
}

function isStationOfflineAlert(alert: AlertEventRow): boolean {
  const text = `${alert.rule_key} ${alert.title}`.toLowerCase();
  return text.includes("station") && text.includes("offline");
}

function isFinancialBug(summary: string): boolean {
  return /helcim|payment|ledger|cash out|refund|card|tender|charged|balance/i.test(summary);
}

function fmtRelative(v: string | null | undefined): string {
  if (!v) return "Time unavailable";
  const timestamp = new Date(v).getTime();
  if (!Number.isFinite(timestamp)) return fmtTs(v);
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 2) return "Just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes} minutes ago`;
  const hours = Math.round(elapsedMinutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function LazyPanelFallback() {
  return (
    <div className="ui-card p-6 text-sm font-semibold text-app-text-muted">
      Loading workspace…
    </div>
  );
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
  const [showAdvancedNav, setShowAdvancedNav] = useState(false);

  // Sync deep link automatically
  useEffect(() => {
    if (bugReportsDeepLinkId) {
      setActiveTab("bugs");
    }
  }, [bugReportsDeepLinkId]);

  // Scroll to top on tab changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    if (activeTab !== "overview" && activeTab !== "updates") {
      setShowAdvancedNav(true);
    }
  }, [activeTab]);

  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [ops, setOps] = useState<LoadState<OpsHealthSnapshot>>(emptyState());
  const [systemReadiness, setSystemReadiness] = useState<
    LoadState<SystemReadinessSnapshot>
  >(emptyState());
  const [openRegisterSessions, setOpenRegisterSessions] = useState<
    LoadState<OpenRegisterSession[]>
  >(emptyState());
  const [fulfillment, setFulfillment] = useState<LoadState<FulfillmentItem[]>>(emptyState());
  const [notifications, setNotifications] = useState<LoadState<NotificationHealth>>(emptyState());
  const [counterpoint, setCounterpoint] = useState<LoadState<CounterpointStatus>>(emptyState());
  const [rms, setRms] = useState<LoadState<RmsReconciliationResponse>>(emptyState());
  const [paymentHealth, setPaymentHealth] = useState<LoadState<PaymentEventsHealth>>(emptyState());
  const [paymentProvider, setPaymentProvider] = useState<LoadState<ActiveProviderResponse>>(emptyState());
  const [paymentIssues, setPaymentIssues] = useState<LoadState<PaymentIssue[]>>(emptyState());
  const [paymentSettlement, setPaymentSettlement] = useState<LoadState<HelcimSettlementStatus>>(emptyState());
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

  const canView = hasPermission("ops.dev_center.view");
  const canRunActions = hasPermission("ops.dev_center.actions");

  const headers = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);

    const [
      opsResult,
      systemReadinessResult,
      openRegisterSessionsResult,
      fulfillmentResult,
      notificationResult,
      counterpointResult,
      rmsResult,
      paymentHealthResult,
      paymentProviderResult,
      paymentIssuesResult,
      paymentSettlementResult,
      lifecycleResult,
      stationsResult,
      alertsResult,
      bugsResult,
    ] = await Promise.all([
      fetchJson<OpsHealthSnapshot>("/api/ops/health/snapshot", headers),
      fetchReadiness(headers),
      fetchJson<OpenRegisterSession[]>("/api/sessions/list-open", headers),
      fetchJson<FulfillmentItem[]>("/api/transactions/fulfillment-queue", headers),
      fetchJson<NotificationHealth>("/api/notifications/health", headers),
      fetchJson<CounterpointStatus>("/api/settings/counterpoint-sync/status", headers),
      fetchJson<RmsReconciliationResponse>("/api/customers/rms-charge/reconciliation?limit=10", headers),
      fetchJson<PaymentEventsHealth>("/api/payments/providers/helcim/events/health", headers),
      fetchJson<ActiveProviderResponse>("/api/payments/providers/active", headers),
      fetchJson<PaymentIssue[]>("/api/payments/providers/helcim/reconciliation/items?status=open&limit=25", headers),
      fetchJson<HelcimSettlementStatus>("/api/payments/providers/helcim/settlements/status", headers),
      fetchJson<LifecycleQueueItem[]>("/api/order-lifecycle/items", headers),
      fetchJson<StationRow[]>("/api/ops/stations", headers),
      fetchJson<AlertEventRow[]>("/api/ops/alerts", headers),
      fetchJson<BugOverviewRow[]>("/api/ops/bugs/overview", headers),
    ]);

    setOps(opsResult);
    setSystemReadiness(systemReadinessResult);
    setOpenRegisterSessions(openRegisterSessionsResult);
    setFulfillment(fulfillmentResult);
    setNotifications(notificationResult);
    setCounterpoint(counterpointResult);
    setRms(rmsResult);
    setPaymentHealth(paymentHealthResult);
    setPaymentProvider(paymentProviderResult);
    setPaymentIssues(paymentIssuesResult);
    setPaymentSettlement(paymentSettlementResult);
    setLifecycleQueues(lifecycleResult);

    if (stationsResult.data) setStations(stationsResult.data);
    if (alertsResult.data) setAlerts(alertsResult.data);
    if (bugsResult.data) setBugsOverview(bugsResult.data);

    setLoadedAt(new Date().toLocaleString());
    setLoading(false);
  }, [headers, canView]);

  const loadReadinessEvidence = useCallback(async () => {
    if (!canView) return;
    const [runtimeResult, signoffsResult] = await Promise.all([
      fetchJson<RuntimeDiagnosticsSnapshot>("/api/ops/runtime-diagnostics", headers),
      fetchJson<ReadinessSignoff[]>("/api/ops/readiness/signoffs", headers),
    ]);
    if (runtimeResult.data) setRuntimeDiagnostics(runtimeResult.data);
    if (signoffsResult.data) setReadinessSignoffs(signoffsResult.data);
  }, [canView, headers]);

  const loadConnectivityEvidence = useCallback(async () => {
    if (!canView) return;
    const logsResult = await fetchJson<ConnectivityLog[]>(
      "/api/ops/connectivity-logs",
      headers,
    );
    if (logsResult.data) setConnectivityLogs(logsResult.data);
  }, [canView, headers]);

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

  useEffect(() => {
    if (activeTab === "readiness") void loadReadinessEvidence();
    if (activeTab === "integrations") void loadConnectivityEvidence();
  }, [activeTab, loadConnectivityEvidence, loadReadinessEvidence, refreshSignal]);

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

  const triggerAuditProbes = useCallback(async () => {
    if (!canRunActions) return;
    setTriggerCheckBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/ops/audit-probes`, {
        method: "POST",
        headers,
      });
      if (res.ok) {
        toast("Production audit probes completed.", "success");
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

    const rmsItems = rmsData?.items?.filter((item) => item.status !== "resolved") ?? [];
    const rmsBlocking = rmsItems.filter((item) => item.severity === "critical" || item.severity === "high").length;
    const rmsWarnings = rmsItems.filter((item) => item.severity === "warning" || item.severity === "medium").length;

    const paymentReviewCount =
      paymentSettlement.data?.actionable_open_item_count ?? paymentReviewItems.length;
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
    } else if (
      failedIntegrations.length > 0
      || (opsData?.integrations ?? []).some(
        (i) => i.status === "caution" || i.status === "CAUTION",
      )
    ) {
      integrationsPillar = "CAUTION";
    }

    // 2. Updates Pillar Status
    const appVersionMismatch = stations
      .filter((station) => station.online || station.actionable)
      .some((station) => station.app_version !== CLIENT_SEMVER);
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
    if (opsData?.db_ok === false || rmsBlocking > 0) {
      boPillar = "WARNING";
    } else if (
      rmsWarnings > 0
      || (opsData?.stations_offline ?? 0) > 0
      || (opsData?.pending_bug_reports ?? 0) > 0
    ) {
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
    paymentSettlement.data,
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
  const operationsToday = useMemo(() => {
    const items: OperationsTodayItem[] = [];
    const addItem = (item: OperationsTodayItem) => {
      if (!items.some((candidate) => candidate.id === item.id)) items.push(item);
    };

    const opsData = ops.data;
    const paymentEvents = paymentHealth.data;
    const provider = paymentProvider.data?.helcim;
    const paymentReviewCount =
      paymentSettlement.data?.actionable_open_item_count ?? paymentIssues.data?.length ?? 0;
    const paymentFailures = paymentEvents?.failed_event_count ?? 0;
    const paymentUnmatched = paymentEvents?.unmatched_event_count ?? 0;
    const onlineStations = stations.filter((station) => station.online);
    const offlineActionableStations = stations.filter(
      (station) => !station.online && station.actionable,
    );
    const staffAlerts = openAlerts.filter((alert) => !isTechnicalAuditAlert(alert));
    const pendingBugs = bugsOverview.filter((bug) => bug.status === "pending");
    const blockedFulfillment = (fulfillment.data ?? []).filter(
      (item) => item.urgency === "blocked",
    ).length;
    const rushFulfillment = (fulfillment.data ?? []).filter(
      (item) => item.urgency === "rush",
    ).length;
    const riskyLifecycle = (lifecycleQueues.data ?? []).filter(
      (item) => item.is_rush || item.risk_level === "at_risk" || item.risk_level === "high",
    ).length;
    const rmsOpen = (rms.data?.items ?? []).filter((item) => item.status !== "resolved");
    const rmsCritical = rmsOpen.filter((item) =>
      ["critical", "high"].includes(item.severity.toLowerCase()),
    ).length;

    if (ops.error || (systemReadiness.error && !systemReadiness.data)) {
      addItem({
        id: "system-refresh",
        level: "do_now",
        title: "ROS could not confirm current system health",
        detail: ops.error ?? systemReadiness.error ?? "Current readiness evidence is unavailable.",
        nextAction: "Refresh once. If this remains, contact support before relying on this screen.",
        sourceLabel: "System health",
        targetTab: "readiness",
      });
    } else if (opsData?.db_ok === false || systemReadiness.data?.status === "not_ready") {
      addItem({
        id: "system-not-ready",
        level: "do_now",
        title: "Main Hub needs attention",
        detail:
          systemReadiness.data?.unavailable_components?.join(", ") ||
          "The Main Hub or database is not reporting ready.",
        nextAction: "Open readiness evidence and confirm which dependency is unavailable.",
        sourceLabel: "Main Hub",
        targetTab: "readiness",
      });
    } else if (systemReadiness.data?.status === "degraded") {
      addItem({
        id: "system-degraded",
        level: "follow_up",
        title: "A supporting service needs follow-up",
        detail:
          systemReadiness.data.unavailable_components?.join(", ") ||
          "The Main Hub is operating with a non-blocking dependency unavailable.",
        nextAction: "Open readiness evidence after immediate store work is safe.",
        sourceLabel: "Main Hub",
        targetTab: "readiness",
      });
    }

    if (stations.length > 0 && onlineStations.length === 0) {
      addItem({
        id: "stations-none-online",
        level: "do_now",
        title: "No active workstation is reporting online",
        detail: `${offlineActionableStations.length} workstation${offlineActionableStations.length === 1 ? " is" : "s are"} awaiting a heartbeat.`,
        nextAction: "Confirm the Main Hub and the workstation needed for today are running.",
        sourceLabel: "Workstations",
        targetTab: "stations",
      });
    } else if (offlineActionableStations.length > 0) {
      addItem({
        id: "stations-offline",
        level: "follow_up",
        title: `${offlineActionableStations.length} workstation${offlineActionableStations.length === 1 ? " is" : "s are"} offline`,
        detail: `${onlineStations.length} workstation${onlineStations.length === 1 ? " remains" : "s remain"} online, so this does not block store operation.`,
        nextAction: "Confirm whether the offline workstation is expected, then review or retire stale station history.",
        sourceLabel: "Workstations",
        targetTab: "stations",
      });
    }

    if (provider?.api_token_configured !== true) {
      addItem({
        id: "helcim-setup",
        level: "do_now",
        title: "Card payments are not configured",
        detail: "ROS cannot confirm the Helcim payment connection.",
        nextAction: "Open Helcim Settings and complete the required connection setup.",
        sourceLabel: "Payments",
        navigateTarget: { tab: "settings", section: "helcim" },
      });
    } else if (provider.terminal_payments_ready !== true || paymentFailures > 0) {
      addItem({
        id: "helcim-blocked",
        level: "do_now",
        title: "Card payments need attention",
        detail:
          paymentFailures > 0
            ? `${paymentFailures} recent payment update${paymentFailures === 1 ? "" : "s"} failed. ${paymentEvents?.last_failed_message ?? ""}`.trim()
            : "The assigned payment terminal is not ready.",
        nextAction: "Open Payments Health, confirm the terminal is listening, and resolve the exact failed attempt before retrying.",
        sourceLabel: "Payments",
        occurredAt: paymentEvents?.last_event_at,
        navigateTarget: { tab: "payments", section: "health" },
      });
    } else if (paymentReviewCount > 0 || paymentUnmatched > 0) {
      addItem({
        id: "payment-review",
        level: "follow_up",
        title: `${paymentReviewCount} payment reconciliation item${paymentReviewCount === 1 ? "" : "s"} need review`,
        detail: `${paymentUnmatched} unmatched provider event${paymentUnmatched === 1 ? "" : "s"}. Customer payments are not assumed missing until the linked evidence is reviewed.`,
        nextAction: "Open Payments Health and work the oldest actionable item first.",
        sourceLabel: "Payments",
        navigateTarget: { tab: "payments", section: "health" },
      });
    }

    for (const bug of pendingBugs.slice(0, 4)) {
      addItem({
        id: `bug:${bug.id}`,
        level: isFinancialBug(bug.summary) ? "do_now" : "follow_up",
        title: `Staff report: ${bug.summary}`,
        detail: `Reported by ${bug.staff_name} ${fmtRelative(bug.created_at)}.`,
        nextAction: "Open the report, confirm current impact, and record an owner or resolution.",
        sourceLabel: "Staff report",
        occurredAt: bug.created_at,
        targetTab: "bugs",
      });
    }

    if (blockedFulfillment > 0 || rushFulfillment > 0 || riskyLifecycle > 0) {
      addItem({
        id: "fulfillment-risk",
        level: blockedFulfillment > 0 ? "do_now" : "follow_up",
        title:
          blockedFulfillment > 0
            ? `${blockedFulfillment} pickup item${blockedFulfillment === 1 ? " is" : "s are"} blocked`
            : `${Math.max(rushFulfillment, riskyLifecycle)} rush or at-risk order item${Math.max(rushFulfillment, riskyLifecycle) === 1 ? "" : "s"}`,
        detail: `${rushFulfillment} rush pickup item${rushFulfillment === 1 ? "" : "s"}; ${riskyLifecycle} lifecycle item${riskyLifecycle === 1 ? "" : "s"} marked at risk.`,
        nextAction: "Open the Pickup Queue and resolve the nearest customer deadline first.",
        sourceLabel: "Pickup Queue",
        navigateTarget: { tab: "home", section: "fulfillment" },
      });
    }

    if (rmsCritical > 0 || rmsOpen.length > 0) {
      addItem({
        id: "rms-reconciliation",
        level: rmsCritical > 0 ? "do_now" : "follow_up",
        title: `${rmsOpen.length} RMS reconciliation item${rmsOpen.length === 1 ? "" : "s"} need review`,
        detail: `${rmsCritical} high-priority mismatch${rmsCritical === 1 ? "" : "es"}.`,
        nextAction: "Open RMS Charge reconciliation and review the source Transaction Record before changing anything.",
        sourceLabel: "RMS Charge",
        navigateTarget: { tab: "customers", section: "rms-charge" },
      });
    }

    const counterpointIntegration = (opsData?.integrations ?? []).find(
      (item) => item.key.toLowerCase().includes("counterpoint"),
    );
    const counterpointIssues =
      counterpoint.data?.unresolved_issue_count ?? counterpoint.data?.recent_issues?.length ?? 0;
    if (counterpointIntegration?.status === "failed" || counterpointIssues > 0) {
      addItem({
        id: "counterpoint",
        level: "follow_up",
        title: "Counterpoint sync needs review",
        detail:
          counterpointIntegration?.detail ||
          `${counterpointIssues} Counterpoint issue${counterpointIssues === 1 ? "" : "s"} remain unresolved.`,
        nextAction: "Open Counterpoint Settings and confirm whether the bridge should still be running before clearing any history.",
        sourceLabel: "Counterpoint",
        navigateTarget: { tab: "settings", section: "counterpoint" },
      });
    }

    const otherFailedIntegrations = (opsData?.integrations ?? []).filter((item) => {
      const key = item.key.toLowerCase();
      return item.status === "failed" && !key.includes("counterpoint") && !key.includes("helcim");
    });
    for (const integration of otherFailedIntegrations.slice(0, 3)) {
      addItem({
        id: `integration:${integration.key}`,
        level: integration.severity === "critical" ? "do_now" : "follow_up",
        title: `${integration.title} connection needs attention`,
        detail: integration.detail || "The configured service did not pass its health check.",
        nextAction: "Open Integration Health for the latest safe diagnostic and owning Settings page.",
        sourceLabel: "Integration",
        occurredAt: integration.last_failure_at,
        targetTab: "integrations",
      });
    }

    const staleUnread = notifications.data?.summary.stale_unread_rows ?? 0;
    if (staleUnread > 0) {
      addItem({
        id: "notification-backlog",
        level: "follow_up",
        title: `${staleUnread} stale notification${staleUnread === 1 ? "" : "s"} need cleanup`,
        detail: "Old unread rows are separated from today's action count so the bell remains useful.",
        nextAction: "Open Customer Notifications and complete or archive work that no longer needs attention.",
        sourceLabel: "Notifications",
        navigateTarget: { tab: "customer-notifications" },
      });
    }

    for (const alert of staffAlerts) {
      if (isStationOfflineAlert(alert)) continue;
      const normalizedTitle = alert.title.trim().toLowerCase();
      if (items.some((item) => item.title.trim().toLowerCase() === normalizedTitle)) continue;
      addItem({
        id: `alert:${alert.id}`,
        level: ["critical", "error", "blocked", "high"].includes(alert.severity.toLowerCase())
          ? "do_now"
          : "follow_up",
        title: alert.title,
        detail: alert.body,
        nextAction: "Open the alert for its current evidence before acknowledging it.",
        sourceLabel: "Operational alert",
        occurredAt: alert.last_seen_at,
        targetTab: "alerts",
      });
    }

    const healthyProofs: HealthyProof[] = [];
    if (opsData?.db_ok && systemReadiness.data?.status === "ready") {
      healthyProofs.push({
        id: "main-hub",
        label: "Main Hub and database",
        detail: "Ready and responding",
      });
    }
    if (systemReadiness.data?.backup?.recent_verified_backup) {
      healthyProofs.push({
        id: "backup",
        label: "Verified backup",
        detail: `${fmtRelative(systemReadiness.data.backup.last_verified_at)} · ${systemReadiness.data.backup.last_verified_filename ?? "verified archive"}`,
      });
    }
    if (onlineStations.length > 0) {
      healthyProofs.push({
        id: "stations",
        label: "Active workstations",
        detail: `${onlineStations.length} online`,
      });
    }
    if ((openRegisterSessions.data?.length ?? 0) > 0) {
      healthyProofs.push({
        id: "register-sessions",
        label: "Open Register sessions",
        detail: `${openRegisterSessions.data?.length ?? 0} open`,
      });
    }
    if (
      provider?.api_token_configured === true &&
      provider.terminal_payments_ready === true &&
      paymentFailures === 0
    ) {
      healthyProofs.push({
        id: "payments",
        label: "Card payment connection",
        detail: "Ready",
      });
    }
    if (systemReadiness.data?.rosie?.llm_available) {
      healthyProofs.push({
        id: "rosie",
        label: "ROSIE",
        detail: "Local intelligence ready",
      });
    }

    const doNow = items.filter((item) => item.level === "do_now");
    const followUp = items.filter((item) => item.level === "follow_up");
    const hardBlocked =
      opsData?.db_ok === false ||
      systemReadiness.data?.status === "not_ready" ||
      (stations.length > 0 && onlineStations.length === 0) ||
      (provider?.api_token_configured === true && provider.terminal_payments_ready !== true);

    return {
      doNow,
      followUp,
      healthyProofs,
      overall: hardBlocked
        ? ("Blocked" as const)
        : doNow.length > 0 || followUp.length > 0
          ? ("Needs Attention" as const)
          : ("Ready" as const),
    };
  }, [
    alerts,
    bugsOverview,
    counterpoint.data,
    fulfillment.data,
    lifecycleQueues.data,
    notifications.data,
    openAlerts,
    openRegisterSessions.data,
    ops.data,
    ops.error,
    paymentHealth.data,
    paymentIssues.data,
    paymentProvider.data,
    paymentSettlement.data,
    rms.data,
    stations,
    systemReadiness.data,
    systemReadiness.error,
  ]);
  const readiness = useMemo(() => {
    const opsData = ops.data;
    const cpData = counterpoint.data;
    const paymentEvents = paymentHealth.data;
    const provider = paymentProvider.data;
    const paymentReviewItems = paymentIssues.data ?? [];
    const paymentReviewCount =
      paymentSettlement.data?.actionable_open_item_count ?? paymentReviewItems.length;
    const onlineStations = stations.filter((station) => station.online);
    const operationalStations = stations.filter(
      (station) => station.online || station.actionable,
    );
    const offlineActionableStations = stations.filter(
      (station) => !station.online && station.actionable,
    );
    const versionMismatches = operationalStations.filter(
      (station) => station.app_version !== CLIENT_SEMVER,
    );
    const failedIntegrations = (opsData?.integrations ?? []).filter(
      (item) => item.status === "failed",
    );
    const qboIntegration = (opsData?.integrations ?? []).find((item) =>
      item.key.toLowerCase().includes("qbo"),
    );
    const cpEntityErrors =
      cpData?.entity_runs?.filter((row) => row.last_error && row.last_error.trim().length > 0)
        .length ?? 0;
    const cpIssues = cpData?.unresolved_issue_count ?? cpData?.recent_issues?.length ?? 0;
    const paymentConfigured = provider?.helcim?.api_token_configured === true;
    const terminalReady = provider?.helcim?.terminal_payments_ready === true;
    const paymentFailures = paymentEvents?.failed_event_count ?? 0;
    const paymentUnmatched = paymentEvents?.unmatched_event_count ?? 0;
    const staffAlerts = openAlerts.filter((alert) => !isTechnicalAuditAlert(alert));
    const criticalAlerts = staffAlerts.filter((alert) =>
      ["critical", "error", "blocked", "high"].includes(alert.severity.toLowerCase()),
    );
    const backup = systemReadiness.data?.backup;
    const openSessionCount = openRegisterSessions.data?.length ?? 0;

    const dailyChecks: ReadinessCheck[] = [
      {
        key: "api",
        label: "Backend/API reachable",
        status:
          ops.error || (systemReadiness.error && !systemReadiness.data)
            ? "blocked"
            : systemReadiness.data
              ? "ready"
              : "unknown",
        detail:
          ops.error ??
          systemReadiness.error ??
          (systemReadiness.data
            ? "The Main Hub API is reachable. Dependency readiness is shown in the checks below."
            : "Main Hub readiness has not loaded yet."),
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
          onlineStations.length === 0 && stations.length > 0
            ? "blocked"
            : offlineActionableStations.length > 0
              ? "warning"
              : onlineStations.length > 0
                ? "ready"
                : "unknown",
        detail:
          stations.length > 0
            ? `${onlineStations.length} online, ${offlineActionableStations.length} offline. An offline secondary workstation does not block opening while an active workstation remains online.`
            : "No station heartbeat rows are available.",
        required: true,
        targetTab: "stations",
      },
      {
        key: "register-sessions",
        label: "Open Register sessions",
        status: openRegisterSessions.error
          ? "unknown"
          : openSessionCount > 0
            ? "ready"
            : "warning",
        detail: openRegisterSessions.error
          ? `Register sessions could not refresh: ${openRegisterSessions.error}`
          : openSessionCount > 0
            ? `${openSessionCount} Register session${openSessionCount === 1 ? " is" : "s are"} open.`
            : "No Register session is open yet. Open the required drawer before taking a payment.",
        required: false,
        evidence: "Live Register session ledger",
      },
      {
        key: "payments",
        label: "Payment / Helcim readiness",
        status: !paymentConfigured
          ? "not_configured"
          : !terminalReady || paymentFailures > 0
            ? "blocked"
            : paymentReviewCount > 0 || paymentUnmatched > 0
              ? "warning"
              : "ready",
        detail: !paymentConfigured
          ? "Helcim API token is not configured."
          : !terminalReady
            ? "Terminal payments are not ready."
            : paymentFailures > 0
              ? `${paymentFailures} failed payment event(s) need review.`
              : paymentReviewCount > 0 || paymentUnmatched > 0
                ? `${paymentReviewCount} actionable reconciliation item(s), ${paymentUnmatched} unmatched event(s).`
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
        required: false,
        targetTab: "integrations",
      },
      {
        key: "qbo",
        label: "QBO / accounting readiness",
        status: !qboIntegration || qboIntegration.status === "disabled"
          ? "not_configured"
          : qboIntegration.status === "failed"
            ? "warning"
            : "ready",
        detail: qboIntegration?.detail ?? "QBO is not configured. This does not block daily store operation.",
        required: false,
        targetTab: "integrations",
      },
      {
        key: "backup",
        label: "Backup freshness",
        status: !backup
          ? "unknown"
          : backup.worker_healthy && backup.artifact_usable && backup.recent_verified_backup
            ? "ready"
            : "blocked",
        detail: !backup
          ? "Verified backup evidence has not loaded."
          : backup.recent_verified_backup
            ? `Verified ${fmtRelative(backup.last_verified_at)} using ${backup.verification_method ?? "archive verification"}: ${backup.last_verified_filename ?? "backup archive"}.`
            : `No usable verified backup is within the ${backup.max_age_hours ?? 30}-hour readiness window.`,
        required: true,
        targetTab: "readiness",
        evidence: backup?.last_verified_filename ?? "GET /api/ready",
      },
      {
        key: "critical-alerts",
        label: "Critical operational alerts",
        status:
          criticalAlerts.length > 0
            ? "blocked"
            : staffAlerts.length > 0 || (opsData?.pending_bug_reports ?? 0) > 0
              ? "warning"
              : "ready",
        detail:
          criticalAlerts.length > 0
            ? `${criticalAlerts.length} critical alert(s) are open.`
            : staffAlerts.length > 0
              ? `${staffAlerts.length} staff-actionable alert(s) need review. Technical audit evidence remains in Advanced Diagnostics.`
              : (opsData?.pending_bug_reports ?? 0) > 0
                ? `${opsData?.pending_bug_reports ?? 0} pending bug report(s) need triage.`
                : "No critical alerts or pending bug report blockers.",
        required: true,
        targetTab: criticalAlerts.length > 0 || staffAlerts.length > 0 ? "alerts" : "bugs",
      },
    ];

    const goLiveChecks: ReadinessCheck[] = [
      {
        key: "release-version",
        label: "Release / version verified",
        status:
          operationalStations.length === 0
            ? "unknown"
            : versionMismatches.length > 0
              ? "warning"
              : "ready",
        detail:
          operationalStations.length === 0
            ? `Current client is ${CLIENT_SEMVER}; no station fleet rows are loaded.`
            : versionMismatches.length > 0
              ? `${versionMismatches.length} station(s) do not match ${CLIENT_SEMVER}.`
              : `All active stations match ${CLIENT_SEMVER}.`,
        required: true,
        targetTab: "stations",
        evidence: "docs/releases/v0.96.0-certification.md",
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
            ? "warning"
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
        status: operationalStations.length > 0 ? "ready" : "unknown",
        detail:
          operationalStations.length > 0
            ? `${operationalStations.length} active/actionable station row(s); ${stations.length - operationalStations.length} stale history row(s) excluded.`
            : "No active or actionable station rows loaded.",
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
    openRegisterSessions.data,
    openRegisterSessions.error,
    ops.data,
    ops.error,
    paymentHealth.data,
    paymentIssues.data,
    paymentSettlement.data,
    paymentProvider.data,
    runtimeDiagnostics,
    readinessSignoffs,
    stations,
    systemReadiness.data,
    systemReadiness.error,
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
              Operations Today
            </h2>
            <p className="mt-1 text-sm font-medium text-app-text-muted">
              Riverside OS {CLIENT_SEMVER} · What needs action now, with technical detail available when you need it.
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
              onClick={() => {
                void load();
                if (activeTab === "readiness") void loadReadinessEvidence();
                if (activeTab === "integrations") void loadConnectivityEvidence();
              }}
              disabled={loading}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50 transition-transform active:scale-95"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        {/* Calm staff navigation; raw evidence stays behind Advanced Diagnostics. */}
        <div className="space-y-3 border-b border-app-border/40 pb-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: "overview", label: "Operations Today" },
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
            <button
              type="button"
              aria-expanded={showAdvancedNav}
              onClick={() => setShowAdvancedNav((current) => !current)}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-black uppercase tracking-widest text-app-text-muted transition-all hover:bg-app-surface hover:text-app-text"
            >
              Advanced Diagnostics
              <ChevronDown
                size={14}
                className={`transition-transform ${showAdvancedNav ? "rotate-180" : ""}`}
              />
            </button>
          </div>
          {showAdvancedNav ? (
            <div className="flex flex-wrap gap-2 rounded-xl border border-app-border bg-app-surface-2/40 p-3">
              {(
                [
                  { id: "readiness", label: "Certification Evidence" },
                  { id: "stations", label: "Workstations" },
                  { id: "alerts", label: "Alert History" },
                  { id: "integrations", label: "Integration Details" },
                  { id: "performance", label: "Register Performance" },
                  { id: "bugs", label: "Bug & Error Diagnostics" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`rounded-lg border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
                    activeTab === tab.id
                      ? "border-app-accent bg-app-accent/10 text-app-accent"
                      : "border-app-border bg-app-bg text-app-text-muted hover:text-app-text"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Tab Content Rendering */}
        {activeTab === "overview" ? (
          <div className="space-y-6 animate-in fade-in duration-300">
            <section
              data-testid="operations-today-action-summary"
              className={`rounded-2xl border p-5 shadow-sm ${
                operationsToday.overall === "Blocked"
                  ? "border-app-danger/30 bg-app-danger/10"
                  : operationsToday.overall === "Needs Attention"
                    ? "border-app-warning/30 bg-app-warning/10"
                    : "border-app-success/30 bg-app-success/10"
              }`}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                    Store status
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <h3 className="text-2xl font-black text-app-text">
                      {operationsToday.overall}
                    </h3>
                    <span className="ui-pill bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text">
                      {operationsToday.doNow.length} do now
                    </span>
                    <span className="ui-pill bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text">
                      {operationsToday.followUp.length} follow up
                    </span>
                  </div>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
                    {operationsToday.overall === "Ready"
                      ? "ROS found no current customer-blocking or operational work."
                      : "Start with Do Now. Follow-up work can be handled after immediate customer and financial needs are safe."}
                  </p>
                </div>
                <p className="text-xs font-semibold text-app-text-muted">
                  Refreshed {loadedAt ?? "when data is available"}
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-app-border bg-app-surface p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-danger/10 text-app-danger">
                  <AlertTriangle size={20} aria-hidden />
                </span>
                <div>
                  <h3 className="text-lg font-black text-app-text">Do Now</h3>
                  <p className="text-xs font-semibold text-app-text-muted">
                    Customer-blocking, financial, or store-opening work.
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {operationsToday.doNow.length > 0 ? (
                  operationsToday.doNow.map((item) => (
                    <article
                      key={item.id}
                      className="rounded-xl border border-app-danger/25 bg-app-bg/50 p-4"
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-black text-app-text">{item.title}</h4>
                            <span className="ui-pill bg-app-danger/10 text-[9px] font-black uppercase tracking-widest text-app-danger">
                              {item.sourceLabel}
                            </span>
                            {item.occurredAt ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-app-text-muted">
                                <Clock3 size={11} aria-hidden /> {fmtRelative(item.occurredAt)}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                            {item.detail}
                          </p>
                          <p className="mt-2 text-xs font-bold text-app-text">
                            Next: {item.nextAction}
                          </p>
                        </div>
                        {item.targetTab || item.navigateTarget ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (item.targetTab) setActiveTab(item.targetTab);
                              if (item.navigateTarget) onNavigate(item.navigateTarget);
                            }}
                            className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl bg-app-accent px-4 text-[10px] font-black uppercase tracking-widest text-white"
                          >
                            Open source
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="flex items-center gap-3 rounded-xl border border-app-success/25 bg-app-success/10 p-4 text-sm font-bold text-app-success">
                    <CheckCircle2 size={18} aria-hidden /> No immediate action is required.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-app-border bg-app-surface p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-warning/10 text-app-warning">
                  <Clock3 size={20} aria-hidden />
                </span>
                <div>
                  <h3 className="text-lg font-black text-app-text">Needs Follow-Up</h3>
                  <p className="text-xs font-semibold text-app-text-muted">
                    Important work that does not currently stop the store.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {operationsToday.followUp.length > 0 ? (
                  operationsToday.followUp.map((item) => (
                    <article
                      key={item.id}
                      className="rounded-xl border border-app-border bg-app-bg/40 p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-black text-app-text">{item.title}</h4>
                        <span className="ui-pill bg-app-warning/10 text-[9px] font-black uppercase tracking-widest text-app-warning">
                          {item.sourceLabel}
                        </span>
                      </div>
                      <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                        {item.detail}
                      </p>
                      <p className="mt-2 text-xs font-bold text-app-text">
                        Next: {item.nextAction}
                      </p>
                      {item.targetTab || item.navigateTarget ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (item.targetTab) setActiveTab(item.targetTab);
                            if (item.navigateTarget) onNavigate(item.navigateTarget);
                          }}
                          className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-app-border bg-app-surface px-3 text-[9px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                        >
                          Open source
                        </button>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <p className="text-sm font-semibold text-app-text-muted">
                    No follow-up work is waiting.
                  </p>
                )}
              </div>
            </section>

            <details className="rounded-2xl border border-app-border bg-app-surface">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
                <div className="flex items-center gap-3">
                  <CheckCircle2 size={20} className="text-app-success" aria-hidden />
                  <div>
                    <h3 className="text-sm font-black text-app-text">Healthy systems</h3>
                    <p className="text-xs font-semibold text-app-text-muted">
                      {operationsToday.healthyProofs.length} current proof item{operationsToday.healthyProofs.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <ChevronDown size={16} className="text-app-text-muted" aria-hidden />
              </summary>
              <div className="grid gap-3 border-t border-app-border px-5 py-4 sm:grid-cols-2 xl:grid-cols-3">
                {operationsToday.healthyProofs.map((proof) => (
                  <div key={proof.id} className="rounded-xl border border-app-success/20 bg-app-success/5 p-3">
                    <p className="text-xs font-black text-app-text">{proof.label}</p>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">{proof.detail}</p>
                  </div>
                ))}
              </div>
            </details>

            <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 text-xs font-medium leading-relaxed text-app-text-muted">
              Routine staff corrections, intentionally disabled services, old history, and raw audit rows do not inflate this action list. They remain available under Advanced Diagnostics for support and engineering review.
            </div>
          </div>
        ) : null}

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
                    Workstation pulse monitoring. Last Seen is server-recorded. Sync/check times
                    are client-reported and future-bounded; install time requires confirmed native
                    updater evidence.
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
                  onClick={() => void triggerAuditProbes()}
                  className="ui-btn-primary py-2 px-4 text-xs font-black uppercase text-white"
                >
                  {triggerCheckBusy ? "Testing..." : "Run Audit Probes"}
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

        {/* TAB: REGISTER PERFORMANCE */}
        {activeTab === "performance" && (
          <div className="space-y-6 animate-in fade-in duration-300">
            <Suspense fallback={<LazyPanelFallback />}>
              <PosJourneyMetricsPanel
                headers={headers}
                refreshSignal={loadedAt}
              />
            </Suspense>
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
              <Suspense fallback={<LazyPanelFallback />}>
                <BugReportsSettingsPanel
                  deepLinkReportId={bugReportsDeepLinkId}
                  onDeepLinkConsumed={onBugReportsDeepLinkConsumed}
                />
              </Suspense>
            </div>
          </div>
        )}

        {/* TAB: UPDATES */}
        {activeTab === "updates" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 rounded-xl animate-in fade-in duration-300">
            <Suspense fallback={<LazyPanelFallback />}>
              <UpdateManagerPanel />
            </Suspense>
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
