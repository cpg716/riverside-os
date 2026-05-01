import { getBaseUrl, getBaseUrlDiagnostics } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bug,
  CheckCircle2,
  ClipboardList,
  Database,
  RefreshCw,
  Server,
  ShieldAlert,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";

import { CLIENT_SEMVER } from "../../clientBuildMeta";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import BugReportsSettingsPanel from "./BugReportsSettingsPanel";

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

type E2eFailurePlaybookItem = {
  category: string;
  recommended_next_action: string;
};

type E2eLaneStatus = {
  lane_key: string;
  purpose: string;
  workflow_name: string;
  job_name: string;
  run_id: number | null;
  run_number: number | null;
  html_url: string | null;
  status: string | null;
  conclusion: string | null;
  last_run_outcome: string;
  started_at: string | null;
  completed_at: string | null;
  failed_specs: string[];
  failure_category: string | null;
  recommended_next_action: string | null;
};

type E2eHealthSource = {
  mode: string;
  stale: boolean;
  cache_age_seconds: number | null;
  notes: string[];
};

type E2eHealthSnapshot = {
  generated_at: string;
  source: E2eHealthSource;
  blocking: E2eLaneStatus;
  nightly: E2eLaneStatus;
  failure_issue_url: string | null;
  playbook: E2eFailurePlaybookItem[];
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
  last_seen_at: string;
  updated_at: string;
  online: boolean;
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

type ActionAuditRow = {
  id: string;
  actor_staff_id: string;
  action_key: string;
  reason: string;
  payload_json: unknown;
  payload_hash_sha256: string;
  correlation_id: string;
  result_ok: boolean;
  result_message: string;
  result_json: unknown;
  created_at: string;
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

type GuardedActionKey =
  | "backup.trigger_local"
  | "help.reindex_search"
  | "help.generate_manifest"
  | "ops.retention_cleanup";

const baseUrl = getBaseUrl();

function fmtTs(v: string | null): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
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

function laneOutcomeClass(outcome: string): string {
  if (outcome === "success") {
    return "bg-app-success/12 text-app-success border border-app-success/30";
  }
  if (outcome === "failure") {
    return "bg-app-danger/12 text-app-danger border border-app-danger/30";
  }
  if (outcome === "in_progress") {
    return "bg-app-warning/12 text-app-warning border border-app-warning/30";
  }
  return "bg-app-bg text-app-text-muted border border-app-border";
}

const STATION_PAGE_SIZE = 10;
const ALERT_PAGE_SIZE = 6;
const E2E_FAILURE_PLAYBOOK: Array<{
  category: string;
  nextAction: string;
}> = [
  {
    category: "app startup",
    nextAction:
      "Confirm the app is reachable, then rerun one blocking check before changing tests.",
  },
  {
    category: "auth/seed data",
    nextAction:
      "Re-run seed/migration steps and verify expected staff/session fixtures before triaging selectors.",
  },
  {
    category: "selector/UI contract",
    nextAction:
      "Reproduce with a single spec in headed mode, verify data-testid/role contract, and patch the smallest stable locator.",
  },
  {
    category: "staff-facing wording/layout",
    nextAction:
      "Compare the failure with current staff-facing copy and responsive layout, then update the UI and matching E2E wording together.",
  },
  {
    category: "runtime console/API cleanliness",
    nextAction:
      "Run the runtime cleanliness spec and inspect unexpected browser console output or API 4xx noise before changing tests.",
  },
  {
    category: "financial/audit contract",
    nextAction:
      "Treat as release-blocking. Compare the failed result, then confirm money and audit rules still hold.",
  },
  {
    category: "flaky/timing",
    nextAction:
      "Replace broad waits with deterministic readiness checks and rerun serially to isolate state timing.",
  },
];

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

export default function RosDevCenterPanel({
  bugReportsDeepLinkId = null,
  onBugReportsDeepLinkConsumed,
}: {
  bugReportsDeepLinkId?: string | null;
  onBugReportsDeepLinkConsumed?: () => void;
}) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OpsHealthSnapshot | null>(null);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [alerts, setAlerts] = useState<AlertEventRow[]>([]);
  const [auditRows, setAuditRows] = useState<ActionAuditRow[]>([]);
  const [bugsOverview, setBugsOverview] = useState<BugOverviewRow[]>([]);
  const [runtimeDiagnostics, setRuntimeDiagnostics] =
    useState<RuntimeDiagnosticsSnapshot | null>(null);
  const [e2eHealth, setE2eHealth] = useState<E2eHealthSnapshot | null>(null);
  const [e2eHealthLoading, setE2eHealthLoading] = useState(false);

  const [actionBusy, setActionBusy] = useState<GuardedActionKey | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [confirmPrimary, setConfirmPrimary] = useState(false);
  const [confirmSecondary, setConfirmSecondary] = useState(false);

  const [manifestDryRun, setManifestDryRun] = useState(true);
  const [manifestIncludeShadcn, setManifestIncludeShadcn] = useState(false);
  const [manifestRescan, setManifestRescan] = useState(false);
  const [manifestCleanupOrphans, setManifestCleanupOrphans] = useState(false);

  const [selectedBugId, setSelectedBugId] = useState("");
  const [selectedAlertId, setSelectedAlertId] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [stationPage, setStationPage] = useState(1);
  const [alertPage, setAlertPage] = useState(1);

  const canView = hasPermission("ops.dev_center.view");
  const canRunActions = hasPermission("ops.dev_center.actions");

  const loadE2eHealth = useCallback(
    async (providedHeaders?: Record<string, string>) => {
      if (!canView) return;
      setE2eHealthLoading(true);
      try {
        const headers =
          providedHeaders ?? (backofficeHeaders() as Record<string, string>);
        const res = await fetch(`${baseUrl}/api/ops/e2e-health`, { headers });
        if (!res.ok) {
          setE2eHealth(null);
          return;
        }
        setE2eHealth((await res.json()) as E2eHealthSnapshot);
      } catch {
        setE2eHealth(null);
      } finally {
        setE2eHealthLoading(false);
      }
    },
    [backofficeHeaders, canView],
  );

  const loadAll = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    try {
      const headers = backofficeHeaders() as Record<string, string>;
      const [o, r, s, a, au, b] = await Promise.all([
        fetch(`${baseUrl}/api/ops/overview`, { headers }),
        fetch(`${baseUrl}/api/ops/runtime-diagnostics`, { headers }),
        fetch(`${baseUrl}/api/ops/stations`, { headers }),
        fetch(`${baseUrl}/api/ops/alerts`, { headers }),
        fetch(`${baseUrl}/api/ops/audit-log`, { headers }),
        fetch(`${baseUrl}/api/ops/bugs/overview`, { headers }),
      ]);

      if (!o.ok || !r.ok || !s.ok || !a.ok || !au.ok || !b.ok) {
      toast("Could not load Support Center data", "error");
        return;
      }

      setOverview((await o.json()) as OpsHealthSnapshot);
      setRuntimeDiagnostics((await r.json()) as RuntimeDiagnosticsSnapshot);
      setStations((await s.json()) as StationRow[]);
      setAlerts((await a.json()) as AlertEventRow[]);
      setAuditRows((await au.json()) as ActionAuditRow[]);
      setBugsOverview((await b.json()) as BugOverviewRow[]);
    } catch {
      toast("Network error loading Support Center", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, canView, toast]);

  useEffect(() => {
    void loadAll();
    void loadE2eHealth();
  }, [loadAll, loadE2eHealth]);

  const refreshBusy = loading || e2eHealthLoading;

  const openAlerts = useMemo(
    () => alerts.filter((a) => a.status === "open" || a.status === "acked"),
    [alerts],
  );
  const apiBaseDiagnostics = useMemo(() => getBaseUrlDiagnostics(), []);
  const e2ePlaybook = useMemo(
    () =>
      e2eHealth?.playbook?.length
        ? e2eHealth.playbook.map((item) => ({
            category: item.category,
            nextAction: item.recommended_next_action,
          }))
        : E2E_FAILURE_PLAYBOOK,
    [e2eHealth],
  );
  const blockingLane = e2eHealth?.blocking ?? null;
  const nightlyLane = e2eHealth?.nightly ?? null;
  const stationTotalPages = pageCount(stations.length, STATION_PAGE_SIZE);
  const alertTotalPages = pageCount(openAlerts.length, ALERT_PAGE_SIZE);
  const visibleStations = useMemo(
    () =>
      stations.slice(
        (stationPage - 1) * STATION_PAGE_SIZE,
        stationPage * STATION_PAGE_SIZE,
      ),
    [stationPage, stations],
  );
  const visibleAlerts = useMemo(
    () =>
      openAlerts.slice(
        (alertPage - 1) * ALERT_PAGE_SIZE,
        alertPage * ALERT_PAGE_SIZE,
      ),
    [alertPage, openAlerts],
  );

  useEffect(() => {
    setStationPage((page) => Math.min(page, stationTotalPages));
  }, [stationTotalPages]);

  useEffect(() => {
    setAlertPage((page) => Math.min(page, alertTotalPages));
  }, [alertTotalPages]);

  const runGuardedAction = useCallback(
    async (actionKey: GuardedActionKey, payload: Record<string, unknown>) => {
      if (!canRunActions) return;
      if (!actionReason.trim()) {
        toast("Action reason is required", "error");
        return;
      }
      if (!confirmPrimary || !confirmSecondary) {
        toast("Both confirmations are required", "error");
        return;
      }

      setActionBusy(actionKey);
      try {
        const res = await fetch(`${baseUrl}/api/ops/actions/${actionKey}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({
            reason: actionReason,
            payload,
            confirm_primary: confirmPrimary,
            confirm_secondary: confirmSecondary,
          }),
        });

        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          ok?: boolean;
        };
        if (!res.ok) {
          toast(data.message ?? "Action failed", "error");
          return;
        }
        toast(data.message ?? "Action executed", "success");
        setActionReason("");
        setConfirmPrimary(false);
        setConfirmSecondary(false);
        await loadAll();
      } catch {
        toast("Network error running action", "error");
      } finally {
        setActionBusy(null);
      }
    },
    [
      actionReason,
      backofficeHeaders,
      canRunActions,
      confirmPrimary,
      confirmSecondary,
      loadAll,
      toast,
    ],
  );

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
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
            Support Center
          </h2>
          <p className="mt-2 text-sm font-medium text-app-text-muted">
            Store health, station status, protected actions, and bug follow-up
            in one support workspace.
          </p>
          <p className="mt-1 text-xs text-app-text-muted">
            Control app version: <strong>{CLIENT_SEMVER}</strong>
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadAll();
            void loadE2eHealth();
          }}
          disabled={refreshBusy}
          className="ui-btn-ghost px-4 py-2 text-xs font-black uppercase tracking-widest"
        >
          {refreshBusy ? (
            <RefreshCw className="mr-2 inline h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 inline h-4 w-4" />
          )}
          Refresh
        </button>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="ui-card p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            System Status
          </div>
          <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
            <Database className="h-5 w-5 text-app-accent" />
            {overview?.db_ok ? "Healthy" : "Failure"}
          </div>
        </div>
        <div className="ui-card p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Open Alerts
          </div>
          <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            {overview?.open_alerts ?? 0}
          </div>
        </div>
        <div className="ui-card p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Stations Online
          </div>
          <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
            <Server className="h-5 w-5 text-emerald-400" />
            {overview?.stations_online ?? 0}
          </div>
        </div>
        <div className="ui-card p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Stations Offline
          </div>
          <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
            <Users className="h-5 w-5 text-red-400" />
            {overview?.stations_offline ?? 0}
          </div>
        </div>
        <div className="ui-card p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Pending Bugs
          </div>
          <div className="mt-2 flex items-center gap-2 text-lg font-black text-app-text">
            <Bug className="h-5 w-5 text-app-accent" />
            {overview?.pending_bug_reports ?? 0}
          </div>
        </div>
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Support Details
          </h3>
        </div>
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
            <div
              key={item.key}
              className="ui-metric-cell ui-tint-neutral p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-app-text">{item.label}</p>
                  <p className="mt-1 text-lg font-black text-app-text">{item.value}</p>
                  <p className="mt-2 text-xs leading-relaxed text-app-text-muted">
                    {item.detail}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${infoBadgeClass(item.severity)}`}
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
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            E2E Health
          </h3>
        </div>
        <p className="text-sm text-app-text-muted">
          Live lane status with commands and guidance for blocking, nightly,
          responsive, readability, and runtime-cleanliness checks.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${
              e2eHealth?.source.mode === "live"
                ? "border border-app-success/30 bg-app-success/12 text-app-success"
                : "border border-app-warning/30 bg-app-warning/12 text-app-warning"
            }`}
          >
            Source:{" "}
            {e2eHealth?.source.mode ?? (e2eHealthLoading ? "loading" : "unavailable")}
          </span>
          <span className="rounded-full border border-app-border bg-app-bg px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Last sync:{" "}
            {e2eHealth?.generated_at
              ? fmtTs(e2eHealth.generated_at)
              : e2eHealthLoading
                ? "Loading"
                : "-"}
          </span>
        </div>

        {e2eHealth?.failure_issue_url ? (
          <div className="mt-3">
            <a
              href={e2eHealth.failure_issue_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-black uppercase tracking-wider text-app-accent underline-offset-2 hover:underline"
            >
              Open failure tracker
            </a>
          </div>
        ) : null}

        {e2eHealth?.source.notes?.length ? (
          <div className="mt-3 space-y-2 rounded-xl border border-app-warning/30 bg-app-warning/10 p-3 text-xs text-app-warning">
            {e2eHealth.source.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="ui-metric-cell ui-tint-neutral p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Blocking lane purpose
            </p>
            <p className="mt-2 text-sm font-bold text-app-text">
              {blockingLane?.purpose ??
                "High-signal financial, tax, register, audit, staff-language, and core navigation contracts."}
              {" "}Must pass for merge.
            </p>
          </div>
          <div className="ui-metric-cell ui-tint-neutral p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Nightly lane purpose
            </p>
            <p className="mt-2 text-sm font-bold text-app-text">
              {nightlyLane?.purpose ??
                "Broader responsive, full-suite, visual, and runtime-cleanliness coverage for drift detection without PR blocking."}
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[
            { label: "Blocking lane", lane: blockingLane },
            { label: "Nightly lane", lane: nightlyLane },
          ].map(({ label, lane }) => (
            <div key={label} className="ui-metric-cell ui-tint-neutral p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-black text-app-text">{label}</p>
                <span
                  className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${laneOutcomeClass(
                    lane?.last_run_outcome ?? "unknown",
                  )}`}
                >
                  {(lane?.last_run_outcome ?? "unknown").replace("_", " ")}
                </span>
              </div>
              <p className="mt-2 text-xs text-app-text-muted">
                Run:{" "}
                {lane?.run_number ? `#${lane.run_number}` : "-"}
                {lane?.html_url ? (
                  <>
                    {" "}
                    •{" "}
                    <a
                      href={lane.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-black text-app-accent underline-offset-2 hover:underline"
                    >
                      open
                    </a>
                  </>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-app-text-muted">
                Started: {fmtTs(lane?.started_at ?? null)} • Completed:{" "}
                {fmtTs(lane?.completed_at ?? null)}
              </p>
              {lane?.failure_category ? (
                <p className="mt-2 text-xs text-app-warning">
                  Category: <span className="font-black">{lane.failure_category}</span>
                </p>
              ) : null}
              {lane?.recommended_next_action ? (
                <p className="mt-1 text-xs text-app-text-muted">
                  Next action: {lane.recommended_next_action}
                </p>
              ) : null}
              {lane?.failed_specs.length ? (
                <div className="mt-2 rounded-lg border border-app-border/60 bg-app-bg/40 p-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Failed specs
                  </p>
                  <div className="mt-1 space-y-1">
                    {(lane?.failed_specs ?? []).map((spec) => (
                      <p key={spec} className="font-mono text-[11px] text-app-text">
                        {spec}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-app-border/60 bg-app-bg/30 p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Local commands
          </p>
          <div className="mt-2 space-y-2 font-mono text-xs text-app-text">
            <p>
              blocking: <span className="font-black">npm --prefix client run test:e2e:blocking</span>
            </p>
            <p>
              nightly: <span className="font-black">npm --prefix client run test:e2e:nightly</span>
            </p>
            <p>
              runtime:{" "}
              <span className="font-black">
                npm --prefix client run test:e2e -- e2e/runtime-console-cleanliness.spec.ts --workers=1
              </span>
            </p>
            <p>
              readability:{" "}
              <span className="font-black">
                npm --prefix client run test:e2e -- e2e/staff-audit-labels.spec.ts e2e/settings-mobile.spec.ts e2e/reports-mobile-cards.spec.ts --workers=1
              </span>
            </p>
          </div>
        </div>

        <div className="mt-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Common failure categories and next action
          </p>
          <div className="mt-2 space-y-2">
            {e2ePlaybook.map((item) => (
              <div key={item.category} className="ui-metric-cell ui-tint-neutral p-3">
                <p className="text-xs font-black uppercase tracking-wider text-app-text">
                  {item.category}
                </p>
                <p className="mt-1 text-xs text-app-text-muted">{item.nextAction}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-4 text-xs text-app-text-muted">
          If station test details are unavailable, this card stays limited and
          the rest of Support Center remains usable.
        </p>
        <p className="mt-1 text-xs text-app-text-muted">
          Reference: <code>docs/E2E_REGRESSION_MATRIX.md</code>
        </p>
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Integration Health
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(overview?.integrations ?? []).map((item) => (
            <div key={item.key} className="ui-metric-cell ui-tint-neutral p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-black text-app-text">{item.title}</p>
                  <p className="mt-1 text-xs text-app-text-muted">{item.detail || "-"}</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${severityClass(item.severity)}`}>
                  {item.status}
                </span>
              </div>
              <p className="mt-2 text-[11px] text-app-text-muted">
                Last success: {fmtTs(item.last_success_at)} | Last failure: {fmtTs(item.last_failure_at)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-app-accent" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Station Fleet
            </h3>
          </div>
          <span className="rounded-full border border-app-border bg-app-bg px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            {stations.length} stations
          </span>
        </div>
        <PageControls
          label="Stations"
          page={stationPage}
          total={stations.length}
          pageSize={STATION_PAGE_SIZE}
          onPageChange={setStationPage}
        />
        <div className="mt-3 max-h-[520px] overflow-auto rounded-xl border border-app-border/60">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-app-surface">
              <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                <th className="px-3 py-2">Station</th>
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">Network</th>
                <th className="px-3 py-2">Last Seen</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleStations.map((s) => (
                <tr key={s.station_key} className="border-t border-app-border/60">
                  <td className="px-3 py-2">
                    <div className="font-bold text-app-text">{s.station_label}</div>
                    <div className="text-xs text-app-text-muted">{s.station_key}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {s.app_version}
                    {s.git_sha ? ` (${s.git_sha.slice(0, 10)})` : ""}
                  </td>
                  <td className="px-3 py-2 text-xs text-app-text-muted">
                    {s.tailscale_node || s.lan_ip || "-"}
                  </td>
                  <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(s.last_seen_at)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${s.online ? "bg-app-success/12 text-app-success" : "bg-app-danger/12 text-app-danger"}`}>
                      {s.online ? "Online" : "Offline"}
                    </span>
                  </td>
                </tr>
              ))}
              {!stations.length && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm text-app-text-muted">
                    No station heartbeat data yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-400" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Alert Center
            </h3>
          </div>
          <span className="rounded-full border border-app-border bg-app-bg px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            {openAlerts.length} active alerts
          </span>
        </div>
        <PageControls
          label="Alerts"
          page={alertPage}
          total={openAlerts.length}
          pageSize={ALERT_PAGE_SIZE}
          onPageChange={setAlertPage}
        />
        <div className="mt-3 max-h-[560px] space-y-3 overflow-y-auto pr-1">
          {visibleAlerts.map((a) => (
            <div key={a.id} className="ui-metric-cell ui-tint-neutral p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-black text-app-text">{a.title}</p>
                  <p className="mt-1 text-xs text-app-text-muted">{a.body}</p>
                  <p className="mt-1 text-[11px] text-app-text-muted">
                    First seen {fmtTs(a.first_seen_at)} | Last seen {fmtTs(a.last_seen_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${severityClass(a.severity)}`}>
                    {a.severity}
                  </span>
                  <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${statusClass(a.status)}`}>
                    {a.status}
                  </span>
                  {canRunActions && a.status === "open" && (
                    <button
                      type="button"
                      onClick={() => void ackAlert(a.id)}
                      className="rounded-lg bg-app-accent px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-white"
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
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Wrench className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Protected Actions
          </h3>
        </div>

        {!canRunActions ? (
          <p className="text-sm text-app-text-muted">
            You can view action history, but Manager Access is needed to run protected actions.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Required reason
              </label>
              <textarea
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                rows={3}
                className="ui-input mt-2 w-full"
                placeholder="Why this action is needed (required for audit trail)"
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="inline-flex items-center gap-2 text-app-text-muted">
                <input
                  type="checkbox"
                  checked={confirmPrimary}
                  onChange={(e) => setConfirmPrimary(e.target.checked)}
                />
                I confirm this is intentional.
              </label>
              <label className="inline-flex items-center gap-2 text-app-text-muted">
                <input
                  type="checkbox"
                  checked={confirmSecondary}
                  onChange={(e) => setConfirmSecondary(e.target.checked)}
                />
                I confirm business timing is safe.
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
              <button
                type="button"
                disabled={actionBusy === "backup.trigger_local"}
                onClick={() =>
                  void runGuardedAction("backup.trigger_local", {})
                }
                className="ui-btn-primary py-3 text-xs font-black uppercase tracking-widest"
              >
                {actionBusy === "backup.trigger_local" ? "Running..." : "Trigger Local Backup"}
              </button>

              <button
                type="button"
                disabled={actionBusy === "help.reindex_search"}
                onClick={() =>
                  void runGuardedAction("help.reindex_search", {})
                }
                className="ui-btn-secondary py-3 text-xs font-black uppercase tracking-widest"
              >
                {actionBusy === "help.reindex_search" ? "Running..." : "Reindex Help Search"}
              </button>

              <button
                type="button"
                disabled={actionBusy === "help.generate_manifest"}
                onClick={() =>
                  void runGuardedAction("help.generate_manifest", {
                    dry_run: manifestDryRun,
                    include_shadcn: manifestIncludeShadcn,
                    rescan_components: manifestRescan,
                    cleanup_orphans: manifestCleanupOrphans,
                  })
                }
                className="ui-btn-ghost py-3 text-xs font-black uppercase tracking-widest"
              >
                {actionBusy === "help.generate_manifest" ? "Running..." : "Generate Help Manifest"}
              </button>

              <button
                type="button"
                disabled={actionBusy === "ops.retention_cleanup"}
                onClick={() =>
                  void runGuardedAction("ops.retention_cleanup", {})
                }
                className="ui-btn-ghost py-3 text-xs font-black uppercase tracking-widest"
              >
                {actionBusy === "ops.retention_cleanup" ? "Running..." : "Run Ops Retention"}
              </button>
            </div>

            <div className="rounded-xl border border-app-border p-3 text-xs text-app-text-muted">
              <div className="mb-2 font-black uppercase tracking-widest">Manifest options</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={manifestDryRun}
                    onChange={(e) => setManifestDryRun(e.target.checked)}
                  />
                  Dry run
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={manifestIncludeShadcn}
                    onChange={(e) => setManifestIncludeShadcn(e.target.checked)}
                  />
                  Include shadcn
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={manifestRescan}
                    onChange={(e) => setManifestRescan(e.target.checked)}
                  />
                  Rescan components
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={manifestCleanupOrphans}
                    onChange={(e) => setManifestCleanupOrphans(e.target.checked)}
                  />
                  Cleanup orphans
                </label>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Terminal className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Action Audit
          </h3>
        </div>
        <div className="space-y-2">
          {auditRows.slice(0, 15).map((row) => (
            <div key={row.id} className="ui-metric-cell ui-tint-neutral px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-black text-app-text">{row.action_key}</div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${row.result_ok ? "bg-app-success/12 text-app-success" : "bg-app-danger/12 text-app-danger"}`}>
                  {row.result_ok ? "Success" : "Failed"}
                </span>
              </div>
              <p className="mt-1 text-xs text-app-text-muted">{row.reason}</p>
              <p className="mt-1 text-[11px] text-app-text-muted">
                {fmtTs(row.created_at)} | Correlation {row.correlation_id}
              </p>
            </div>
          ))}
          {!auditRows.length && (
            <p className="text-sm text-app-text-muted">No action audit rows yet.</p>
          )}
        </div>
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Bug Incident Links
          </h3>
        </div>

        {canRunActions && (
          <div className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-app-border p-4 lg:grid-cols-4">
            <select
              value={selectedBugId}
              onChange={(e) => setSelectedBugId(e.target.value)}
              className="ui-input"
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
              className="ui-input"
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
              className="ui-input"
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
          {bugsOverview.slice(0, 15).map((b) => (
            <div key={b.id} className="ui-metric-cell ui-tint-neutral px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-black text-app-text">{b.summary}</p>
                  <p className="text-xs text-app-text-muted">
                    {b.staff_name} | {fmtTs(b.created_at)}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${b.status === "pending" ? "bg-app-warning/12 text-app-warning" : "bg-app-success/12 text-app-success"}`}>
                  {b.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-app-text-muted">
                Linked incidents: {b.linked_incidents} | Oldest linked alert: {fmtTs(b.oldest_linked_alert_at)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="ui-card p-6">
        <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
          Bug Manager (Source of Truth)
        </h3>
        <p className="mt-1 text-xs text-app-text-muted">
          All bug CRUD and status remain canonical in ROS Bug Reports.
        </p>
        <div className="mt-6">
          <BugReportsSettingsPanel
            deepLinkReportId={bugReportsDeepLinkId}
            onDeepLinkConsumed={onBugReportsDeepLinkConsumed}
          />
        </div>
      </section>
    </div>
  );
}
