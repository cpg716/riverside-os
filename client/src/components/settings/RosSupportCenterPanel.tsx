import { getBaseUrl, getBaseUrlDiagnostics } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  Bug,
  Database,
  RefreshCw,
  Server,
  ShieldAlert,
  Users,
} from "lucide-react";

import { CLIENT_SEMVER } from "../../clientBuildMeta";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import BugReportsSettingsPanel from "./BugReportsSettingsPanel";
import UpdateManagerPanel from "./UpdateManagerPanel";

type IntegrationHealthItem = {
  key: string;
  title: string;
  status: string;
  severity: string;
  detail: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  updated_at: string | null;
};

type OpsHealthSnapshot = {
  server_time: string;
  db_ok: boolean;
  meilisearch_configured: boolean;
  tailscale_expected: boolean;
  integrations: IntegrationHealthItem[];
  open_alerts: number;
  stations_online: number;
  stations_offline: number;
  stations_stale: number;
  pending_bug_reports: number;
};

type RuntimeDiagnosticItem = {
  key: string;
  label: string;
  value: string;
  detail: string;
  severity: string;
};

type RuntimeDiagnosticsSnapshot = {
  generated_at: string;
  items: RuntimeDiagnosticItem[];
};

type StationRow = {
  station_key: string;
  station_label: string;
  app_version: string;
  git_sha: string | null;
  tailscale_node: string | null;
  lan_ip: string | null;
  last_sync_at: string | null;
  last_update_check_at: string | null;
  last_update_install_at: string | null;
  client_timestamp_source: string;
  last_seen_at: string;
  updated_at: string;
  online: boolean;
  monitor_offline: boolean;
  station_lifecycle: "online" | "recently_offline" | "stale" | string;
  actionable: boolean;
  active_staff_sessions: number;
  active_staff_names: string;
};

type AlertEventRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string;
  severity: "critical" | "warning" | "info" | string;
  status: "open" | "acked" | "resolved" | string;
  first_seen_at: string;
  last_seen_at: string;
  acked_at: string | null;
  resolved_at: string | null;
};

type BugOverviewRow = {
  id: string;
  correlation_id: string;
  created_at: string;
  status: string;
  summary: string;
  staff_name: string;
  linked_incidents: number;
  oldest_linked_alert_at: string | null;
};

type NotificationHealth = {
  summary: {
    active_inbox_rows: number;
    unread_rows: number;
    stale_unread_rows: number;
    history_rows: number;
    canonical_notifications_24h: number;
    staff_rows_24h: number;
  };
  generator_runs: Array<{
    generator_key: string;
    last_started_at: string;
    last_finished_at: string;
    last_success_at: string | null;
    last_error_at: string | null;
    last_status: "ok" | "failed";
    last_error: string | null;
    consecutive_failures: number;
  }>;
  volume_by_kind_7d: Array<{
    kind: string;
    semantic_kind: string;
    canonical_count: number;
    recipient_count: number;
  }>;
  stale_unread_by_kind: Array<{
    semantic_kind: string;
    unread_count: number;
    oldest_created_at: string;
  }>;
  fatigue_warnings: Array<{
    key: string;
    severity: "critical" | "warning" | string;
    title: string;
    detail: string;
  }>;
};

type SupportFeedKey =
  | "overview"
  | "runtime"
  | "stations"
  | "alerts"
  | "bugs"
  | "notifications";

type SupportFeedErrors = Partial<Record<SupportFeedKey, boolean>>;
type OperationalStatus = "ready" | "review" | "degraded" | "blocked";

const baseUrl = getBaseUrl();
const STATION_PAGE_SIZE = 10;
const ALERT_PAGE_SIZE = 6;

function fmtTs(v: string | null): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function fmtCount(v: number | null | undefined): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    v ?? 0,
  );
}

function formatNotificationKindLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function severityClass(severity: string): string {
  if (severity === "critical") {
    return "bg-app-danger/12 text-app-danger border border-app-danger/30";
  }
  if (severity === "warning") {
    return "bg-app-warning/12 text-app-warning border border-app-warning/30";
  }
  return "bg-app-success/12 text-app-success border border-app-success/30";
}

function statusClass(status: string): string {
  if (status === "open") return "bg-app-danger/12 text-app-danger";
  if (status === "acked") return "bg-app-warning/12 text-app-warning";
  return "bg-app-success/12 text-app-success";
}

function infoBadgeClass(severity: string): string {
  if (severity === "warning") {
    return "bg-app-warning/12 text-app-warning border border-app-warning/30";
  }
  if (severity === "critical") {
    return "bg-app-danger/12 text-app-danger border border-app-danger/30";
  }
  return "bg-app-info/12 text-app-info border border-app-info/30";
}

function operationalStatusLabel(status: OperationalStatus): string {
  if (status === "blocked") return "Blocked";
  if (status === "degraded") return "Degraded";
  if (status === "review") return "Needs Review";
  return "Ready";
}

function operationalStatusClass(status: OperationalStatus): string {
  if (status === "blocked") {
    return "border-app-danger/30 bg-app-danger/12 text-app-danger";
  }
  if (status === "degraded") {
    return "border-app-warning/30 bg-app-warning/12 text-app-warning";
  }
  if (status === "review") {
    return "border-amber-500/30 bg-amber-500/12 text-amber-700";
  }
  return "border-app-success/30 bg-app-success/12 text-app-success";
}

function stationLifecycleLabel(station: StationRow): string {
  if (station.online) return "Online";
  if (station.actionable) return "Actionable Offline";
  return "Stale History";
}

function stationLifecycleClass(station: StationRow): string {
  if (station.online) return "bg-app-success/12 text-app-success";
  if (station.actionable) return "bg-app-danger/12 text-app-danger";
  return "bg-app-bg text-app-text-muted border border-app-border";
}

function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

function PageControls({
  label,
  page,
  total,
  pageSize,
  onPageChange,
}: {
  label: string;
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = pageCount(total, pageSize);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border/60 pb-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-app-text-muted">
        {label}: {start}-{end} of {total}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface hover:text-app-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Prev
        </button>
        <span className="rounded-lg border border-app-border bg-app-surface px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text">
          Page {page} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface hover:text-app-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function DegradedNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-xs font-semibold text-app-warning">
      {children}
    </p>
  );
}

export default function RosSupportCenterPanel({
  bugReportsDeepLinkId = null,
  onBugReportsDeepLinkConsumed,
}: {
  bugReportsDeepLinkId?: string | null;
  onBugReportsDeepLinkConsumed?: () => void;
}) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<
    "overview" | "stations" | "alerts" | "integrations" | "bugs" | "updates"
  >("overview");

  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OpsHealthSnapshot | null>(null);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [alerts, setAlerts] = useState<AlertEventRow[]>([]);
  const [bugsOverview, setBugsOverview] = useState<BugOverviewRow[]>([]);
  const [notificationHealth, setNotificationHealth] =
    useState<NotificationHealth | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] =
    useState<RuntimeDiagnosticsSnapshot | null>(null);
  const [feedErrors, setFeedErrors] = useState<SupportFeedErrors>({});

  const [selectedBugId, setSelectedBugId] = useState("");
  const [selectedAlertId, setSelectedAlertId] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [stationPage, setStationPage] = useState(1);
  const [alertPage, setAlertPage] = useState(1);
  const [showStaleStations, setShowStaleStations] = useState(false);

  const canView = hasPermission("ops.dev_center.view");
  const canRunActions = hasPermission("ops.dev_center.actions");

  const loadAll = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    const headers = backofficeHeaders() as Record<string, string>;
    const fetchJson = async <T,>(
      key: SupportFeedKey,
      path: string,
    ): Promise<{ key: SupportFeedKey; ok: true; data: T } | { key: SupportFeedKey; ok: false }> => {
      try {
        const res = await fetch(`${baseUrl}${path}`, { headers });
        if (!res.ok) return { key, ok: false };
        return { key, ok: true, data: (await res.json()) as T };
      } catch {
        return { key, ok: false };
      }
    };

    try {
      const results = await Promise.all([
        fetchJson<OpsHealthSnapshot>("overview", "/api/ops/overview"),
        fetchJson<RuntimeDiagnosticsSnapshot>(
          "runtime",
          "/api/ops/runtime-diagnostics",
        ),
        fetchJson<StationRow[]>("stations", "/api/ops/stations"),
        fetchJson<AlertEventRow[]>("alerts", "/api/ops/alerts"),
        fetchJson<BugOverviewRow[]>("bugs", "/api/ops/bugs/overview"),
        fetchJson<NotificationHealth>("notifications", "/api/notifications/health"),
      ]);

      const nextErrors: SupportFeedErrors = {};
      for (const result of results) {
        if (!result.ok) {
          nextErrors[result.key] = true;
          continue;
        }
        if (result.key === "overview") setOverview(result.data as OpsHealthSnapshot);
        if (result.key === "runtime") {
          setRuntimeDiagnostics(result.data as RuntimeDiagnosticsSnapshot);
        }
        if (result.key === "stations") setStations(result.data as StationRow[]);
        if (result.key === "alerts") setAlerts(result.data as AlertEventRow[]);
        if (result.key === "bugs") setBugsOverview(result.data as BugOverviewRow[]);
        if (result.key === "notifications") {
          setNotificationHealth(result.data as NotificationHealth);
        }
      }
      setFeedErrors(nextErrors);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, canView]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Handle deep link redirect to bugs tab automatically
  useEffect(() => {
    if (bugReportsDeepLinkId) {
      setActiveTab("bugs");
    }
  }, [bugReportsDeepLinkId]);

  const openAlerts = useMemo(
    () => alerts.filter((a) => a.status === "open" || a.status === "acked"),
    [alerts],
  );
  const apiBaseDiagnostics = useMemo(() => getBaseUrlDiagnostics(), []);
  
  const stationCounts = useMemo(
    () => ({
      online: stations.filter((station) => station.online).length,
      actionableOffline: stations.filter(
        (station) => !station.online && station.actionable,
      ).length,
      stale: stations.filter((station) => !station.online && !station.actionable).length,
    }),
    [stations],
  );
  const displayedStations = useMemo(
    () =>
      showStaleStations
          ? stations
          : stations.filter((station) => station.online || station.actionable),
    [showStaleStations, stations],
  );
  const stationTotalPages = pageCount(displayedStations.length, STATION_PAGE_SIZE);
  const alertTotalPages = pageCount(openAlerts.length, ALERT_PAGE_SIZE);
  
  const visibleStations = useMemo(
    () =>
      displayedStations.slice(
        (stationPage - 1) * STATION_PAGE_SIZE,
        stationPage * STATION_PAGE_SIZE,
      ),
    [displayedStations, stationPage],
  );
  const visibleAlerts = useMemo(
    () =>
      openAlerts.slice(
        (alertPage - 1) * ALERT_PAGE_SIZE,
        alertPage * ALERT_PAGE_SIZE,
      ),
    [alertPage, openAlerts],
  );
  const supportStatus = useMemo<OperationalStatus>(() => {
    const sourceFailures = Object.values(feedErrors).filter(Boolean).length;
    const criticalIntegrations =
      overview?.integrations.filter((item) => item.severity === "critical").length ?? 0;
    const warningIntegrations =
      overview?.integrations.filter((item) => item.severity === "warning").length ?? 0;
    const criticalAlerts = openAlerts.filter((alert) => alert.severity === "critical").length;
    const warningAlerts = openAlerts.filter((alert) => alert.severity === "warning").length;
    const criticalRuntime =
      runtimeDiagnostics?.items.filter((item) => item.severity === "critical").length ?? 0;
    const warningRuntime =
      runtimeDiagnostics?.items.filter((item) => item.severity === "warning").length ?? 0;

    if (overview?.db_ok === false || criticalIntegrations > 0 || criticalAlerts > 0 || criticalRuntime > 0) {
      return "blocked";
    }
    if (!overview || sourceFailures > 0) return "degraded";
    if (
      warningIntegrations > 0 ||
      warningAlerts > 0 ||
      warningRuntime > 0 ||
      overview.stations_offline > 0 ||
      overview.pending_bug_reports > 0
    ) {
      return "review";
    }
    return "ready";
  }, [feedErrors, openAlerts, overview, runtimeDiagnostics]);

  useEffect(() => {
    setStationPage((page) => Math.min(page, stationTotalPages));
  }, [stationTotalPages]);

  useEffect(() => {
    setAlertPage((page) => Math.min(page, alertTotalPages));
  }, [alertTotalPages]);

  const ackAlert = useCallback(
    async (alertId: string) => {
      if (!canRunActions) return;
      try {
        const res = await fetch(`${baseUrl}/api/ops/alerts/ack`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ alert_id: alertId }),
        });
        if (!res.ok) {
          toast("Could not acknowledge alert", "error");
          return;
        }
        toast("Alert acknowledged", "success");
        await loadAll();
      } catch {
        toast("Network error acknowledging alert", "error");
      }
    },
    [backofficeHeaders, canRunActions, loadAll, toast],
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
          ...(backofficeHeaders() as Record<string, string>),
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
      await loadAll();
    } catch {
      toast("Network error linking bug", "error");
    } finally {
      setLinkBusy(false);
    }
  }, [
    backofficeHeaders,
    canRunActions,
    linkNote,
    loadAll,
    selectedAlertId,
    selectedBugId,
    toast,
  ]);

  if (!canView) {
    return (
      <div className="ui-card p-8">
        <h2 className="text-xl font-black uppercase tracking-widest text-app-text">
          Support Center
        </h2>
        <p className="mt-2 text-sm text-app-text-muted">
          You do not have access to this workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Premium Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-app-border/40 pb-4">
        <div>
          <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text flex items-center gap-2">
            <ShieldAlert className="h-8 w-8 text-app-accent" />
            Support Center
          </h2>
          <p className="mt-1 text-sm font-medium text-app-text-muted">
            Workstation heartbeats, integration logs, and customer-facing support controls.
          </p>
          <p className="mt-1 text-xs text-app-text-muted">
            Control app version: <strong>{CLIENT_SEMVER}</strong>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadAll()}
          disabled={loading}
          className="ui-btn-ghost px-4 py-2 text-xs font-black uppercase tracking-widest"
        >
          <RefreshCw className={`mr-2 inline h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-2 border-b border-app-border/40 pb-3">
        {(
          [
            { id: "overview", label: "Overview & Diagnostics" },
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

      {/* Main Tab Panels */}
      <div className="space-y-6">
        {/* TAB: OVERVIEW */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {feedErrors.overview && (
              <DegradedNotice>
                Overview details could not refresh. Showing the last available support summary.
              </DegradedNotice>
            )}

            {/* Overall Grid */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
              <div className="ui-card p-5 bg-app-surface/50 backdrop-blur-md border-app-border/60">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Operational Status
                </div>
                <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
                  <Database className="h-5 w-5 text-app-accent" />
                  {operationalStatusLabel(supportStatus)}
                </div>
                <div
                  className={`mt-3 rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wider text-center ${operationalStatusClass(
                    supportStatus,
                  )}`}
                >
                  {supportStatus === "blocked"
                    ? "Recovery Required"
                    : supportStatus === "degraded"
                      ? "Partial Visibility"
                      : supportStatus === "review"
                        ? "Manager Review"
                        : "Normal"}
                </div>
              </div>

              <div className="ui-card p-5 bg-app-surface/50 backdrop-blur-md border-app-border/60">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Open Alerts
                </div>
                <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
                  <AlertTriangle className="h-5 w-5 text-amber-400" />
                  {overview?.open_alerts ?? 0}
                </div>
              </div>

              <div className="ui-card p-5 bg-app-surface/50 backdrop-blur-md border-app-border/60">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Stations Online
                </div>
                <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
                  <Server className="h-5 w-5 text-emerald-400" />
                  {overview?.stations_online ?? 0}
                </div>
              </div>

              <div className="ui-card p-5 bg-app-surface/50 backdrop-blur-md border-app-border/60">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Stations Offline
                </div>
                <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
                  <Users className="h-5 w-5 text-red-400" />
                  {overview?.stations_offline ?? stationCounts.actionableOffline}
                </div>
                <p className="mt-2 text-[11px] font-semibold text-app-text-muted">
                  {fmtCount(overview?.stations_stale ?? stationCounts.stale)} stale archived.
                </p>
              </div>

              <div className="ui-card p-5 bg-app-surface/50 backdrop-blur-md border-app-border/60">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Pending Bugs
                </div>
                <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
                  <Bug className="h-5 w-5 text-app-accent" />
                  {overview?.pending_bug_reports ?? 0}
                </div>
              </div>
            </div>

            {/* Diagnostics snapshot */}
            <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
              <div className="mb-4 flex items-center gap-2">
                <Activity className="h-5 w-5 text-app-accent" />
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Connection & Runtime Diagnostics
                </h3>
              </div>
              {feedErrors.runtime && (
                <div className="mb-4">
                  <DegradedNotice>
                    Runtime details could not refresh. Other support tools remain available.
                  </DegradedNotice>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <div className="ui-metric-cell ui-tint-info p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-app-text">App connection</p>
                      <p className="mt-1 break-all font-mono text-xs text-app-text">
                        {apiBaseDiagnostics.resolved}
                      </p>
                      <p className="mt-2 text-xs text-app-text-muted">
                        Source:{" "}
                        {apiBaseDiagnostics.source === "override"
                          ? "local override"
                          : apiBaseDiagnostics.source === "vite-env"
                            ? "app setting"
                            : apiBaseDiagnostics.source === "same-origin"
                              ? "current browser"
                              : "desktop fallback"}
                      </p>
                    </div>
                    <span className="rounded-full border border-app-info/30 bg-app-info/12 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-app-info">
                      app
                    </span>
                  </div>
                </div>

                {(runtimeDiagnostics?.items ?? []).map((item) => (
                  <div key={item.key} className="ui-metric-cell ui-tint-neutral p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-black text-app-text">{item.label}</p>
                        <p className="mt-1 text-lg font-black text-app-text">{item.value}</p>
                        <p className="mt-2 text-xs leading-relaxed text-app-text-muted">
                          {item.detail}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${infoBadgeClass(
                          item.severity,
                        )}`}
                      >
                        {item.severity}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-app-text-muted">
                Read-only support snapshot. Secrets are never exposed.
                {runtimeDiagnostics?.generated_at
                  ? ` Last checked: ${fmtTs(runtimeDiagnostics.generated_at)}`
                  : ""}
              </p>
            </div>

            {/* Notifications health */}
            <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Bell className="h-5 w-5 text-app-accent" />
                  <div>
                    <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                      Notification Health
                    </h3>
                    <p className="mt-1 text-xs text-app-text-muted">
                      Generator status, stale alerts, and delivery logs.
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
                    notificationHealth?.generator_runs.some((r) => r.last_status === "failed")
                      ? "border-app-danger/30 bg-app-danger/12 text-app-danger"
                      : "border-app-success/30 bg-app-success/12 text-app-success"
                  }`}
                >
                  {notificationHealth?.generator_runs.filter((r) => r.last_status === "failed").length ??
                    0}{" "}
                  failing
                </span>
              </div>
              {feedErrors.notifications && (
                <div className="mb-4">
                  <DegradedNotice>
                    Notification health could not refresh. Staff alerts remain usable.
                  </DegradedNotice>
                </div>
              )}
              {(notificationHealth?.fatigue_warnings ?? []).length > 0 && (
                <div className="mb-4 grid gap-2">
                  {notificationHealth?.fatigue_warnings.map((warning) => (
                    <div
                      key={warning.key}
                      className={`rounded-xl border px-4 py-3 ${
                        warning.severity === "critical"
                          ? "border-app-danger/35 bg-app-danger/10"
                          : "border-app-warning/35 bg-app-warning/10"
                      }`}
                    >
                      <p className="text-xs font-black uppercase tracking-widest text-app-text">
                        {warning.title}
                      </p>
                      <p className="mt-1 text-xs text-app-text-muted">
                        {warning.detail}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  { label: "Unread", value: notificationHealth?.summary.unread_rows },
                  {
                    label: "Stale unread",
                    value: notificationHealth?.summary.stale_unread_rows,
                  },
                  {
                    label: "Active rows",
                    value: notificationHealth?.summary.active_inbox_rows,
                  },
                  {
                    label: "Generated 24h",
                    value: notificationHealth?.summary.canonical_notifications_24h,
                  },
                ].map(({ label, value }) => (
                  <div key={label} className="ui-metric-cell ui-tint-neutral p-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {label}
                    </p>
                    <p className="mt-2 text-xl font-black text-app-text">
                      {fmtCount(value)}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="ui-metric-cell ui-tint-neutral p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Generator status
                  </p>
                  <div className="mt-3 space-y-3">
                    {(notificationHealth?.generator_runs ?? []).slice(0, 5).map((row) => (
                      <div
                        key={row.generator_key}
                        className="flex items-start justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-bold text-app-text">
                            {formatNotificationKindLabel(row.generator_key)}
                          </p>
                          <p className="truncate text-[11px] text-app-text-muted">
                            {row.last_status === "failed"
                              ? row.last_error || "Generator failed"
                              : `Last ran ${fmtTs(row.last_finished_at)}`}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-wider ${
                            row.last_status === "failed"
                              ? "border-app-danger/30 bg-app-danger/12 text-app-danger"
                              : "border-app-success/30 bg-app-success/12 text-app-success"
                          }`}
                        >
                          {row.last_status === "failed"
                            ? `${row.consecutive_failures}x fail`
                            : "OK"}
                        </span>
                      </div>
                    ))}
                    {!notificationHealth?.generator_runs.length && (
                      <p className="text-xs text-app-text-muted">
                        No generator run records yet.
                      </p>
                    )}
                  </div>
                </div>

                <div className="ui-metric-cell ui-tint-neutral p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Highest volume (7d)
                  </p>
                  <div className="mt-3 space-y-2">
                    {(notificationHealth?.volume_by_kind_7d ?? []).slice(0, 5).map((row) => (
                      <div
                        key={`${row.kind}:${row.semantic_kind}`}
                        className="flex justify-between gap-3 text-xs"
                      >
                        <span className="truncate text-app-text">
                          {formatNotificationKindLabel(row.semantic_kind)}
                        </span>
                        <span className="font-bold text-app-text-muted">
                          {fmtCount(row.recipient_count)} rows
                        </span>
                      </div>
                    ))}
                    {!notificationHealth?.volume_by_kind_7d.length && (
                      <p className="text-xs text-app-text-muted">
                        No notification volume in the last 7 days.
                      </p>
                    )}
                  </div>
                </div>

                <div className="ui-metric-cell ui-tint-neutral p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Stale unread
                  </p>
                  <div className="mt-3 space-y-2">
                    {(notificationHealth?.stale_unread_by_kind ?? []).slice(0, 5).map((row) => (
                      <div
                        key={row.semantic_kind}
                        className="flex justify-between gap-3 text-xs"
                      >
                        <span className="truncate text-app-text">
                          {formatNotificationKindLabel(row.semantic_kind)}
                        </span>
                        <span className="font-bold text-app-warning">
                          {fmtCount(row.unread_count)}
                        </span>
                      </div>
                    ))}
                    {!notificationHealth?.stale_unread_by_kind.length && (
                      <p className="text-xs text-app-text-muted">
                        No stale unread alerts.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB: STATIONS FLEET */}
        {activeTab === "stations" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
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
                <span className="rounded-full border border-app-success/30 bg-app-success/12 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-success">
                  {fmtCount(stationCounts.online)} online
                </span>
                <span className="rounded-full border border-app-danger/30 bg-app-danger/12 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-danger">
                  {fmtCount(stationCounts.actionableOffline)} actionable offline
                </span>
                <span className="rounded-full border border-app-border bg-app-bg px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {fmtCount(stationCounts.stale)} stale
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setShowStaleStations((value) => !value);
                    setStationPage(1);
                  }}
                  className="rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface hover:text-app-text transition-colors"
                >
                  {showStaleStations ? "Hide Stale" : "Show Stale"}
                </button>
              </div>
            </div>

            {feedErrors.stations && (
              <div className="mb-4">
                <DegradedNotice>
                  Station details could not refresh. Showing the last available station list.
                </DegradedNotice>
              </div>
            )}

            <PageControls
              label="Stations"
              page={stationPage}
              total={displayedStations.length}
              pageSize={STATION_PAGE_SIZE}
              onPageChange={setStationPage}
            />

            <div className="mt-3 max-h-[520px] overflow-auto rounded-xl border border-app-border/60">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-app-surface">
                  <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
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
                      <td className="px-4 py-3">
                        <div className="font-bold text-app-text">{s.station_label}</div>
                        <div className="text-xs text-app-text-muted">{s.station_key}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {s.app_version}
                        {s.git_sha ? ` (${s.git_sha.slice(0, 10)})` : ""}
                      </td>
                      <td className="px-4 py-3 text-xs text-app-text-muted">
                        {s.tailscale_node || s.lan_ip || "-"}
                      </td>
                      <td className="px-4 py-3 text-xs text-app-text-muted">
                        {s.active_staff_sessions > 0
                          ? `${s.active_staff_names} (${s.active_staff_sessions})`
                          : "No active session"}
                      </td>
                      <td className="px-4 py-3 text-xs text-app-text-muted">
                        {fmtTs(s.last_seen_at)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${stationLifecycleClass(
                            s,
                          )}`}
                        >
                          {stationLifecycleLabel(s)}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!displayedStations.length && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-sm text-app-text-muted">
                        No active station heartbeat data in the current view.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB: ALERTS */}
        {activeTab === "alerts" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-400" />
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Alert Center
                  </h3>
                  <p className="mt-1 text-xs text-app-text-muted">
                    Active operational triggers. Acknowledging items updates their status while keeping them visible.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-app-danger/30 bg-app-danger/12 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-danger">
                  {fmtCount(openAlerts.filter((a) => a.severity === "critical").length)} critical
                </span>
                <span className="rounded-full border border-app-warning/30 bg-app-warning/12 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-warning">
                  {fmtCount(openAlerts.filter((a) => a.severity === "warning").length)} warning
                </span>
                <span className="rounded-full border border-app-border bg-app-bg px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {fmtCount(openAlerts.length)} active
                </span>
              </div>
            </div>

            {feedErrors.alerts && (
              <div className="mb-4">
                <DegradedNotice>
                  Alert details could not refresh. Showing the last available alert list.
                </DegradedNotice>
              </div>
            )}

            <PageControls
              label="Alerts"
              page={alertPage}
              total={openAlerts.length}
              pageSize={ALERT_PAGE_SIZE}
              onPageChange={setAlertPage}
            />

            <div className="mt-3 max-h-[560px] space-y-3 overflow-y-auto pr-1">
              {visibleAlerts.map((a) => (
                <div key={a.id} className="ui-metric-cell ui-tint-neutral p-4 hover:bg-app-surface/30 transition-colors">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-black text-app-text">{a.title}</p>
                      <p className="mt-1 text-xs text-app-text-muted">{a.body}</p>
                      <p className="mt-1 text-[11px] text-app-text-muted">
                        First seen {fmtTs(a.first_seen_at)} | Last seen {fmtTs(a.last_seen_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${severityClass(
                          a.severity,
                        )}`}
                      >
                        {a.severity}
                      </span>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${statusClass(
                          a.status,
                        )}`}
                      >
                        {a.status}
                      </span>
                      {canRunActions && a.status === "open" && (
                        <button
                          type="button"
                          onClick={() => void ackAlert(a.id)}
                          className="rounded-lg bg-app-accent hover:bg-app-accent-hover transition-colors px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-white"
                        >
                          Ack
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {!openAlerts.length && (
                <p className="ui-panel ui-tint-success px-4 py-3 text-sm text-app-success">
                  No open/acked alerts right now.
                </p>
              )}
            </div>
          </div>
        )}

        {/* TAB: INTEGRATION HEALTH */}
        {activeTab === "integrations" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
            <div className="mb-4 flex items-center gap-2">
              <Activity className="h-5 w-5 text-app-accent" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Integration Status Monitor
                </h3>
                <p className="mt-1 text-xs text-app-text-muted">
                  API connectivity, background workers, and sync health logs.
                </p>
              </div>
            </div>

            {feedErrors.overview && (
              <div className="mb-4">
                <DegradedNotice>
                  Integration health could not refresh. Showing cached status where available.
                </DegradedNotice>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(overview?.integrations ?? []).map((item) => (
                <div key={item.key} className="ui-metric-cell ui-tint-neutral p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-black text-app-text">{item.title}</p>
                      <p className="mt-1 text-xs text-app-text-muted">{item.detail || "-"}</p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${severityClass(
                        item.severity,
                      )}`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-app-text-muted">
                    Last success: {fmtTs(item.last_success_at)} | Last failure: {fmtTs(item.last_failure_at)}
                  </p>
                </div>
              ))}
              {(!overview?.integrations || !overview.integrations.length) && (
                <p className="text-sm text-app-text-muted lg:col-span-2">
                  No integrations currently configured or reporting status.
                </p>
              )}
            </div>
          </div>
        )}

        {/* TAB: BUGS */}
        {activeTab === "bugs" && (
          <div className="space-y-6">
            {/* Incident linking logic */}
            <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
              <div className="mb-4 flex items-center gap-2">
                <Bug className="h-5 w-5 text-app-accent" />
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Bug Incident Links
                  </h3>
                  <p className="mt-1 text-xs text-app-text-muted">
                    Associate front-end bug tickets directly with server operational alerts.
                  </p>
                </div>
              </div>

              {feedErrors.bugs && (
                <div className="mb-4">
                  <DegradedNotice>
                    Bug incident links could not refresh. Showing cached metadata.
                  </DegradedNotice>
                </div>
              )}

              {canRunActions && (
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
              )}

              <div className="space-y-2">
                {bugsOverview.slice(0, 10).map((b) => (
                  <div key={b.id} className="ui-metric-cell ui-tint-neutral px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-black text-app-text">{b.summary}</p>
                        <p className="text-xs text-app-text-muted">
                          {b.staff_name} | {fmtTs(b.created_at)}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${
                          b.status === "pending"
                            ? "bg-app-warning/12 text-app-warning"
                            : "bg-app-success/12 text-app-success"
                        }`}
                      >
                        {b.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-app-text-muted">
                      Linked incidents: {b.linked_incidents} | Oldest linked alert:{" "}
                      {fmtTs(b.oldest_linked_alert_at)}
                    </p>
                  </div>
                ))}
                {!bugsOverview.length && (
                  <p className="text-sm text-app-text-muted">No bug reports available to link.</p>
                )}
              </div>
            </div>

            {/* Embedded Bug Manager */}
            <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Bug Manager
              </h3>
              <p className="mt-1 text-xs text-app-text-muted">
                Create, view, and update customer and staff-filed bug report tickets.
              </p>
              <div className="mt-6 border-t border-app-border/40 pt-4">
                <BugReportsSettingsPanel
                  deepLinkReportId={bugReportsDeepLinkId}
                  onDeepLinkConsumed={onBugReportsDeepLinkConsumed}
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB: UPDATES */}
        {activeTab === "updates" && (
          <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Updates & Platform Configuration
            </h3>
            <p className="mt-1 text-xs text-app-text-muted">
              Trigger service updates, re-pull desktop files, and manage client version tags.
            </p>
            <div className="mt-6 border-t border-app-border/40 pt-4">
              <UpdateManagerPanel />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
