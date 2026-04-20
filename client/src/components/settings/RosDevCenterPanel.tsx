import { getBaseUrl, getBaseUrlDiagnostics } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bug,
  CheckCircle2,
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
  | "help.generate_manifest";

const baseUrl = getBaseUrl();

function fmtTs(v: string | null): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function severityClass(severity: string): string {
  if (severity === "critical") {
    return "bg-red-500/20 text-red-300 border border-red-500/40";
  }
  if (severity === "warning") {
    return "bg-amber-500/20 text-amber-300 border border-amber-500/40";
  }
  return "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40";
}

function statusClass(status: string): string {
  if (status === "open") return "bg-red-500/20 text-red-200";
  if (status === "acked") return "bg-amber-500/20 text-amber-200";
  return "bg-emerald-500/20 text-emerald-200";
}

function infoBadgeClass(severity: string): string {
  if (severity === "warning") {
    return "bg-amber-500/20 text-amber-200 border border-amber-500/40";
  }
  if (severity === "critical") {
    return "bg-red-500/20 text-red-200 border border-red-500/40";
  }
  return "bg-sky-500/20 text-sky-200 border border-sky-500/40";
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

  const canView = hasPermission("ops.dev_center.view");
  const canRunActions = hasPermission("ops.dev_center.actions");

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
        toast("Could not load ROS Dev Center data", "error");
        return;
      }

      setOverview((await o.json()) as OpsHealthSnapshot);
      setRuntimeDiagnostics((await r.json()) as RuntimeDiagnosticsSnapshot);
      setStations((await s.json()) as StationRow[]);
      setAlerts((await a.json()) as AlertEventRow[]);
      setAuditRows((await au.json()) as ActionAuditRow[]);
      setBugsOverview((await b.json()) as BugOverviewRow[]);
    } catch {
      toast("Network error loading ROS Dev Center", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, canView, toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const openAlerts = useMemo(
    () => alerts.filter((a) => a.status === "open" || a.status === "acked"),
    [alerts],
  );
  const apiBaseDiagnostics = useMemo(() => getBaseUrlDiagnostics(), []);

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
          ROS Dev Center
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
            ROS Dev Center
          </h2>
          <p className="mt-2 text-sm font-medium text-app-text-muted">
            Operations health, fleet telemetry, guarded actions, and Bug Manager
            triage in one developer command center.
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
          {loading ? (
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
            DB Status
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
            Runtime Diagnostics
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <div className="rounded-xl border border-app-border bg-app-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black text-app-text">API Base</p>
                <p className="mt-1 break-all font-mono text-xs text-app-text">
                  {apiBaseDiagnostics.resolved}
                </p>
                <p className="mt-2 text-xs text-app-text-muted">
                  Source:{" "}
                  {apiBaseDiagnostics.source === "override"
                    ? "local override"
                    : apiBaseDiagnostics.source === "vite-env"
                      ? "Vite env"
                      : apiBaseDiagnostics.source === "same-origin"
                        ? "same-origin browser"
                        : "desktop fallback"}
                </p>
              </div>
              <span className="rounded-full border border-sky-500/40 bg-sky-500/20 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-sky-200">
                client
              </span>
            </div>
          </div>

          {(runtimeDiagnostics?.items ?? []).map((item) => (
            <div
              key={item.key}
              className="rounded-xl border border-app-border bg-app-surface p-4"
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
          Read-only runtime snapshot for developer/admin debugging. Secrets are
          never exposed.
          {runtimeDiagnostics?.generated_at
            ? ` Server snapshot: ${fmtTs(runtimeDiagnostics.generated_at)}`
            : ""}
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
            <div key={item.key} className="rounded-xl border border-app-border bg-app-surface p-4">
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
        <div className="mb-4 flex items-center gap-2">
          <Server className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Station Fleet
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                <th className="py-2">Station</th>
                <th className="py-2">Version</th>
                <th className="py-2">Network</th>
                <th className="py-2">Last Seen</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {stations.map((s) => (
                <tr key={s.station_key} className="border-t border-app-border/60">
                  <td className="py-2">
                    <div className="font-bold text-app-text">{s.station_label}</div>
                    <div className="text-xs text-app-text-muted">{s.station_key}</div>
                  </td>
                  <td className="py-2 font-mono text-xs">
                    {s.app_version}
                    {s.git_sha ? ` (${s.git_sha.slice(0, 10)})` : ""}
                  </td>
                  <td className="py-2 text-xs text-app-text-muted">
                    {s.tailscale_node || s.lan_ip || "-"}
                  </td>
                  <td className="py-2 text-xs text-app-text-muted">{fmtTs(s.last_seen_at)}</td>
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${s.online ? "bg-emerald-500/20 text-emerald-200" : "bg-red-500/20 text-red-200"}`}>
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
        <div className="mb-4 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-amber-400" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Alert Center
          </h3>
        </div>
        <div className="space-y-3">
          {openAlerts.map((a) => (
            <div key={a.id} className="rounded-xl border border-app-border bg-app-surface p-4">
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
            <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
              No open/acked alerts right now.
            </p>
          )}
        </div>
      </section>

      <section className="ui-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Wrench className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Guarded Actions
          </h3>
        </div>

        {!canRunActions ? (
          <p className="text-sm text-app-text-muted">
            You can view action history but do not have permission to run guarded actions.
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

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
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
            <div key={row.id} className="rounded-lg border border-app-border bg-app-surface px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-black text-app-text">{row.action_key}</div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${row.result_ok ? "bg-emerald-500/20 text-emerald-200" : "bg-red-500/20 text-red-200"}`}>
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
            <div key={b.id} className="rounded-lg border border-app-border bg-app-surface px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-black text-app-text">{b.summary}</p>
                  <p className="text-xs text-app-text-muted">
                    {b.staff_name} | {fmtTs(b.created_at)}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${b.status === "pending" ? "bg-amber-500/20 text-amber-200" : "bg-emerald-500/20 text-emerald-200"}`}>
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
