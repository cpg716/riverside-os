import { useCallback, useEffect, useState, useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Brain,
  Clipboard,
  ClipboardCheck,
  GitBranch,
  GitMerge,
  Laptop,
  Loader2,
  LogOut,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Tag,
  Terminal,
  Wifi,
  Wrench,
  Database,
  Activity,
} from "lucide-react";
import { apiGet, apiPost, getServerUrl, setServerConfig, type DiagnosticsSnapshot } from "../lib/api";

type HealthStatus = "WARNING" | "CAUTION" | "GOOD";

interface WorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
}

interface Release {
  id: number;
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
}

interface IntegrationHealthItem {
  key: string;
  title: string;
  status: string;
  severity: string;
  detail?: string | null;
  last_success_at?: string | null;
  last_failure_at?: string | null;
}

interface OpsOverview {
  server_time: string;
  db_ok: boolean;
  stations_online: number;
  stations_offline: number;
  open_alerts: number;
  pending_bug_reports: number;
  integrations?: IntegrationHealthItem[];
}

interface AlertEvent {
  id: string;
  title: string;
  severity: string;
  status: string;
  first_seen_at: string;
}

interface Station {
  station_key: string;
  station_label: string;
  online: boolean;
  app_version: string;
  last_seen_at: string;
}

interface ConnectivityLog {
  id: string;
  source: string;
  old_status: string;
  new_status: string;
  detail?: string | null;
  created_at: string;
}

interface GitHubData {
  workflows: { workflow_runs: WorkflowRun[] };
  releases: Release[];
}

function fmtTs(v: string | null | undefined): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function statusBadge(status: string, conclusion: string | null) {
  if (status !== "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-app-warning/12 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-app-warning">
        <Loader2 className="h-3 w-3 animate-spin" />
        {status}
      </span>
    );
  }
  if (conclusion === "success") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-app-success/12 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-app-success">
        Success
      </span>
    );
  }
  if (conclusion === "failure") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-app-danger/12 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-app-danger">
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-app-text-muted/12 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
      {conclusion ?? status}
    </span>
  );
}

export default function DevOpsDashboard() {
  const [activeTab, setActiveTab] = useState<"overview" | "stations" | "alerts" | "integrations" | "github" | "diagnostics">("overview");
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [github, setGithub] = useState<GitHubData | null>(null);
  const [connectivityLogs, setConnectivityLogs] = useState<ConnectivityLog[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [triggerCheckBusy, setTriggerCheckBusy] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [ov, al, st, ghWf, ghRel, logs] = await Promise.all([
        apiGet<OpsOverview>("/api/ops/overview").catch(() => null),
        apiGet<AlertEvent[]>("/api/ops/alerts").catch(() => []),
        apiGet<Station[]>("/api/ops/stations").catch(() => []),
        apiGet<{ workflow_runs: WorkflowRun[] }>("/api/ops/github/workflows").catch(() => ({ workflow_runs: [] })),
        apiGet<Release[]>("/api/ops/github/releases").catch(() => []),
        apiGet<ConnectivityLog[]>("/api/ops/connectivity-logs").catch(() => []),
      ]);
      setOverview(ov);
      setAlerts(al);
      setStations(st);
      setGithub({ workflows: { workflow_runs: ghWf.workflow_runs }, releases: ghRel });
      setConnectivityLogs(logs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const diag = await apiGet<DiagnosticsSnapshot>("/api/ops/diagnostics");
      setDiagnostics(diag);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load diagnostics");
    } finally {
      setDiagLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const runRosieAnalysis = async () => {
    if (!diagnostics?.ai_prompt) return;
    setAnalyzing(true);
    setError("");
    try {
      const result = await apiPost<{
        analysis?: string;
        rosie_available?: boolean;
        error?: string;
      }>("/api/ops/diagnostics/analyze", {
        prompt: diagnostics.ai_prompt,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      setAnalysis(result.analysis || "(no analysis returned)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ROSIE analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const triggerHeartbeat = async () => {
    setTriggerCheckBusy(true);
    try {
      await apiPost("/api/ops/audit-probes");
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Heartbeat trigger failed");
    } finally {
      setTriggerCheckBusy(false);
    }
  };

  const triggerRelease = async () => {
    setDispatching(true);
    try {
      await apiPost("/api/ops/github/dispatch", {
        workflow_id: "tauri-register-updater-release.yml",
        branch: "main",
        inputs: {},
      });
      setTimeout(fetchAll, 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dispatch failed");
    } finally {
      setDispatching(false);
    }
  };

  const handleLogout = () => {
    setServerConfig({ url: getServerUrl() || "", staffCode: "" });
    window.location.reload();
  };

  const derived = useMemo(() => {
    let integrationsPillar: HealthStatus = "GOOD";
    const failedIntegrations = (overview?.integrations ?? []).filter((i) => i.status === "failed");
    if (failedIntegrations.some((i) => i.severity === "critical")) {
      integrationsPillar = "WARNING";
    } else if (failedIntegrations.length > 0 || (overview?.integrations ?? []).some((i) => i.status === "disabled" || i.status === "caution")) {
      integrationsPillar = "CAUTION";
    }

    const expectedVer = diagnostics?.server?.version || "0.85.0";
    const appVersionMismatch = stations.some((s) => s.app_version !== expectedVer);
    const updatesPillar: HealthStatus = appVersionMismatch ? "WARNING" : "GOOD";

    let posPillar: HealthStatus = "GOOD";
    if (stations.some((s) => !s.online)) {
      posPillar = "CAUTION";
    }

    let boPillar: HealthStatus = "GOOD";
    if (overview?.db_ok === false) {
      boPillar = "WARNING";
    } else if ((overview?.open_alerts ?? 0) > 0 || (overview?.pending_bug_reports ?? 0) > 0) {
      boPillar = "CAUTION";
    }

    return {
      integrationsPillar: integrationsPillar as HealthStatus,
      updatesPillar: updatesPillar as HealthStatus,
      posPillar: posPillar as HealthStatus,
      boPillar: boPillar as HealthStatus,
    };
  }, [overview, stations, diagnostics]);

  const openAlerts = alerts.filter((a) => a.status === "open" || a.status === "acked");

  return (
    <div className="min-h-screen p-6 bg-app-bg text-app-text font-sans selection:bg-app-accent/30 selection:text-white">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between border-b border-app-border/40 pb-6">
        <div className="flex items-center gap-3">
          <img src="/logo1.png" alt="Riverside" className="h-10 w-10 filter drop-shadow-[0_0_10px_rgba(56,189,248,0.2)]" />
          <div>
            <h1 className="text-xl font-black uppercase tracking-wider text-app-text flex items-center gap-2">
              ROS Dev Center
            </h1>
            <p className="text-xs text-app-text-muted">
              {getServerUrl()} · {fmtTs(overview?.server_time)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            disabled={loading}
            className="ui-btn ui-btn-ghost ui-btn-sm inline-flex items-center gap-1.5 border border-app-border/60 hover:border-app-accent/40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            onClick={handleLogout}
            className="ui-btn ui-btn-ghost ui-btn-sm border border-app-border/60 text-app-danger hover:bg-app-danger/10 hover:border-app-danger/40"
            title="Log Out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-app-danger/30 bg-app-danger/5 px-4 py-3 text-sm text-app-danger flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`ui-card p-5 border-l-4 backdrop-blur-md transition-all hover:-translate-y-0.5 ${
          derived.integrationsPillar === "WARNING" ? "border-l-app-danger border-app-danger/25 bg-app-danger/[0.02]" :
          derived.integrationsPillar === "CAUTION" ? "border-l-app-warning border-app-warning/25 bg-app-warning/[0.02]" :
          "border-l-app-success border-app-border/50 bg-app-surface/40"
        }`}>
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Integrations</span>
              <h3 className="text-lg font-black mt-1">{derived.integrationsPillar}</h3>
            </div>
            <Database className={`h-5 w-5 ${
              derived.integrationsPillar === "WARNING" ? "text-app-danger" :
              derived.integrationsPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
            }`} />
          </div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setActiveTab("integrations")}
              className="text-[10px] font-black uppercase tracking-wider text-app-accent hover:underline flex-1 text-left"
            >
              Configure
            </button>
            <button
              disabled={triggerCheckBusy}
              onClick={triggerHeartbeat}
              className="ui-btn ui-btn-primary ui-btn-sm py-1 px-2.5 text-[9px] h-6 flex items-center justify-center font-black uppercase"
            >
              {triggerCheckBusy ? "Probing..." : "Test Heartbeat"}
            </button>
          </div>
        </div>

        <div className={`ui-card p-5 border-l-4 backdrop-blur-md transition-all hover:-translate-y-0.5 ${
          derived.updatesPillar === "WARNING" ? "border-l-app-danger border-app-danger/25 bg-app-danger/[0.02]" :
          derived.updatesPillar === "CAUTION" ? "border-l-app-warning border-app-warning/25 bg-app-warning/[0.02]" :
          "border-l-app-success border-app-border/50 bg-app-surface/40"
        }`}>
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Updates</span>
              <h3 className="text-lg font-black mt-1">{derived.updatesPillar}</h3>
            </div>
            <RefreshCw className={`h-5 w-5 ${
              derived.updatesPillar === "WARNING" ? "text-app-danger" :
              derived.updatesPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
            }`} />
          </div>
          <div className="mt-4 flex">
            <button
              onClick={() => setActiveTab("github")}
              className="text-[10px] font-black uppercase tracking-wider text-app-accent hover:underline text-left flex-1"
            >
              Trigger Build
            </button>
          </div>
        </div>

        <div className={`ui-card p-5 border-l-4 backdrop-blur-md transition-all hover:-translate-y-0.5 ${
          derived.posPillar === "WARNING" ? "border-l-app-danger border-app-danger/25 bg-app-danger/[0.02]" :
          derived.posPillar === "CAUTION" ? "border-l-app-warning border-app-warning/25 bg-app-warning/[0.02]" :
          "border-l-app-success border-app-border/50 bg-app-surface/40"
        }`}>
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">POS Lane Status</span>
              <h3 className="text-lg font-black mt-1">{derived.posPillar}</h3>
            </div>
            <Laptop className={`h-5 w-5 ${
              derived.posPillar === "WARNING" ? "text-app-danger" :
              derived.posPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
            }`} />
          </div>
          <div className="mt-4">
            <button
              onClick={() => setActiveTab("stations")}
              className="text-[10px] font-black uppercase tracking-wider text-app-accent hover:underline text-left"
            >
              Manage Stations ({overview?.stations_online ?? 0} active)
            </button>
          </div>
        </div>

        <div className={`ui-card p-5 border-l-4 backdrop-blur-md transition-all hover:-translate-y-0.5 ${
          derived.boPillar === "WARNING" ? "border-l-app-danger border-app-danger/25 bg-app-danger/[0.02]" :
          derived.boPillar === "CAUTION" ? "border-l-app-warning border-app-warning/25 bg-app-warning/[0.02]" :
          "border-l-app-success border-app-border/50 bg-app-surface/40"
        }`}>
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Back Office DB</span>
              <h3 className="text-lg font-black mt-1">{derived.boPillar}</h3>
            </div>
            <Activity className={`h-5 w-5 ${
              derived.boPillar === "WARNING" ? "text-app-danger" :
              derived.boPillar === "CAUTION" ? "text-app-warning" : "text-app-success"
            }`} />
          </div>
          <div className="mt-4">
            <button
              onClick={() => setActiveTab("alerts")}
              className="text-[10px] font-black uppercase tracking-wider text-app-accent hover:underline text-left"
            >
              View Alerts ({openAlerts.length} active)
            </button>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-2 border-b border-app-border/40 pb-3 mb-6">
        {(
          [
            { id: "overview", label: "Operations Overview" },
            { id: "stations", label: "Stations Fleet" },
            { id: "alerts", label: "Alert Triage" },
            { id: "integrations", label: "Integration Health" },
            { id: "github", label: "GitHub Workflows" },
            { id: "diagnostics", label: "Diagnostics & ROSIE" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-lg px-4 py-2 text-xs font-black uppercase tracking-widest transition-all ${
              activeTab === tab.id
                ? "bg-app-accent text-slate-900 shadow-md shadow-app-accent/25"
                : "text-app-text-muted hover:bg-app-surface hover:text-app-text"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-6">
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 animate-in fade-in duration-300">
            <div className="ui-card p-6 flex flex-col justify-between">
              <div>
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text mb-4">Server Status Snapshot</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-app-surface/30 rounded-xl border border-app-border/40">
                    <span className="text-[10px] uppercase text-app-text-muted font-bold block">Database</span>
                    <span className={`text-lg font-black mt-1 inline-flex items-center gap-1.5 ${overview?.db_ok ? "text-app-success" : "text-app-danger"}`}>
                      {overview?.db_ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                      {overview?.db_ok ? "Healthy" : "Offline"}
                    </span>
                  </div>
                  <div className="p-4 bg-app-surface/30 rounded-xl border border-app-border/40">
                    <span className="text-[10px] uppercase text-app-text-muted font-bold block">Active Alerts</span>
                    <span className="text-lg font-black mt-1 text-app-text">{openAlerts.length} open</span>
                  </div>
                  <div className="p-4 bg-app-surface/30 rounded-xl border border-app-border/40">
                    <span className="text-[10px] uppercase text-app-text-muted font-bold block">Bug Reports</span>
                    <span className="text-lg font-black mt-1 text-app-text">{overview?.pending_bug_reports ?? 0} pending</span>
                  </div>
                  <div className="p-4 bg-app-surface/30 rounded-xl border border-app-border/40">
                    <span className="text-[10px] uppercase text-app-text-muted font-bold block">Active Stations</span>
                    <span className="text-lg font-black mt-1 text-app-text">
                      {overview?.stations_online ?? 0} / {(overview?.stations_online ?? 0) + (overview?.stations_offline ?? 0)}
                    </span>
                  </div>
                </div>
              </div>
              
              <div className="mt-6 border-t border-app-border/40 pt-4 flex gap-4">
                <button
                  onClick={triggerHeartbeat}
                  disabled={triggerCheckBusy}
                  className="ui-btn ui-btn-primary"
                >
                  {triggerCheckBusy ? "Running Diagnostics Audit..." : "Run Active Probe Audit"}
                </button>
              </div>
            </div>

            <div className="ui-card p-6">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text mb-4">Connectivity Logs</h3>
              {connectivityLogs.length ? (
                <div className="max-h-[300px] overflow-auto rounded-xl border border-app-border/60">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-app-surface">
                      <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                        <th className="px-3 py-2">Time</th>
                        <th className="px-3 py-2">Source</th>
                        <th className="px-3 py-2">Transition</th>
                        <th className="px-3 py-2">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {connectivityLogs.map((log) => (
                        <tr key={log.id} className="border-t border-app-border/40 hover:bg-app-bg/50">
                          <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(log.created_at)}</td>
                          <td className="px-3 py-2 font-mono text-xs">{log.source}</td>
                          <td className="px-3 py-2 text-xs">
                            <span className="text-app-text-muted">{log.old_status}</span>
                            <span className="mx-1">→</span>
                            <span className={log.new_status === "GOOD" ? "text-app-success font-bold" : "text-app-danger font-bold"}>
                              {log.new_status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-app-text-muted truncate max-w-[200px]" title={log.detail || ""}>
                            {log.detail || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-app-text-muted py-8 text-center border border-dashed border-app-border/60 rounded-xl">
                  No connectivity transitions logged.
                </p>
              )}
            </div>
          </div>
        )}

        {activeTab === "stations" && (
          <section className="ui-card p-6 animate-in fade-in duration-300">
            <div className="mb-4 flex items-center gap-2">
              <Wifi className="h-5 w-5 text-app-accent" />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Stations Fleet
              </h3>
            </div>

            {stations.length ? (
              <div className="overflow-auto rounded-xl border border-app-border/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-app-surface">
                    <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">Station</th>
                      <th className="px-3 py-2">Version</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Last Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stations.map((s) => (
                      <tr key={s.station_key} className="border-t border-app-border/40 hover:bg-app-bg/50">
                        <td className="px-3 py-2 font-medium">{s.station_label}</td>
                        <td className="px-3 py-2 text-xs text-app-text-muted">{s.app_version}</td>
                        <td className="px-3 py-2">
                          {s.online ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-app-success/12 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-app-success">
                              <CheckCircle2 className="h-3 w-3" />
                              Online
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-app-danger/12 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-app-danger">
                              Offline
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(s.last_seen_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-app-text-muted">No stations registered.</p>
            )}
          </section>
        )}

        {activeTab === "alerts" && (
          <section className="ui-card p-6 animate-in fade-in duration-300">
            <div className="mb-4 flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-app-warning" />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Active Alerts
              </h3>
            </div>

            {openAlerts.length ? (
              <div className="overflow-auto rounded-xl border border-app-border/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-app-surface">
                    <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">Alert</th>
                      <th className="px-3 py-2">Severity</th>
                      <th className="px-3 py-2">First Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openAlerts.map((a) => (
                      <tr key={a.id} className="border-t border-app-border/40 hover:bg-app-bg/50">
                        <td className="px-3 py-2 font-medium">{a.title}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${
                            a.severity === "critical" ? "bg-app-danger/12 text-app-danger" : "bg-app-warning/12 text-app-warning"
                          }`}>
                            {a.severity}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(a.first_seen_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-app-text-muted">No open alerts.</p>
            )}
          </section>
        )}

        {activeTab === "integrations" && (
          <section className="ui-card p-6 animate-in fade-in duration-300">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-app-accent" />
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Integration Status
                </h3>
              </div>
              <button
                disabled={triggerCheckBusy}
                onClick={triggerHeartbeat}
                className="ui-btn ui-btn-primary ui-btn-sm"
              >
                {triggerCheckBusy ? "Running Audit..." : "Trigger Active Audit Probe"}
              </button>
            </div>

            {overview?.integrations?.length ? (
              <div className="overflow-auto rounded-xl border border-app-border/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-app-surface">
                    <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">Integration</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Last Run Success</th>
                      <th className="px-3 py-2">Last Run Failure</th>
                      <th className="px-3 py-2">Diagnostic Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.integrations.map((i) => (
                      <tr key={i.key} className="border-t border-app-border/40 hover:bg-app-bg/50">
                        <td className="px-3 py-2 font-medium">{i.title}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${
                            i.status === "failed" ? "bg-app-danger/12 text-app-danger" : "bg-app-success/12 text-app-success"
                          }`}>
                            {i.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(i.last_success_at)}</td>
                        <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(i.last_failure_at)}</td>
                        <td className="px-3 py-2 text-xs text-app-text-muted max-w-xs truncate" title={i.detail || ""}>
                          {i.detail || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-app-text-muted">No integration details returned.</p>
            )}
          </section>
        )}

        {activeTab === "github" && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 animate-in fade-in duration-300">
            <div className="ui-card p-6">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GitMerge className="h-5 w-5 text-app-accent" />
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    GitHub Workflows
                  </h3>
                </div>
                <button
                  onClick={triggerRelease}
                  disabled={dispatching}
                  className="ui-btn ui-btn-primary ui-btn-sm inline-flex items-center gap-2"
                >
                  {dispatching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  Build Release
                </button>
              </div>

              {github?.workflows?.workflow_runs?.length ? (
                <div className="max-h-[400px] overflow-auto rounded-xl border border-app-border/60">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-app-surface">
                      <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                        <th className="px-3 py-2">Workflow</th>
                        <th className="px-3 py-2">Branch</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {github.workflows.workflow_runs.slice(0, 10).map((run) => (
                        <tr key={run.id} className="border-t border-app-border/40 hover:bg-app-bg/50">
                          <td className="px-3 py-2">
                            <a
                              href={run.html_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-app-accent hover:underline"
                            >
                              {run.name}
                            </a>
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center gap-1 text-xs text-app-text-muted">
                              <GitBranch className="h-3 w-3" />
                              {run.head_branch}
                            </span>
                          </td>
                          <td className="px-3 py-2">{statusBadge(run.status, run.conclusion)}</td>
                          <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(run.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-app-text-muted">No workflow runs found.</p>
              )}
            </div>

            <div className="ui-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <Tag className="h-5 w-5 text-app-accent" />
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Releases
                </h3>
              </div>

              {github?.releases?.length ? (
                <div className="max-h-[400px] overflow-auto rounded-xl border border-app-border/60">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-app-surface">
                      <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                        <th className="px-3 py-2">Tag</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Published</th>
                      </tr>
                    </thead>
                    <tbody>
                      {github.releases.slice(0, 10).map((rel) => (
                        <tr key={rel.id} className="border-t border-app-border/40 hover:bg-app-bg/50">
                          <td className="px-3 py-2">
                            <a
                              href={rel.html_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-app-accent hover:underline"
                            >
                              <Tag className="h-3 w-3" />
                              {rel.tag_name}
                            </a>
                          </td>
                          <td className="px-3 py-2 text-app-text">{rel.name}</td>
                          <td className="px-3 py-2 text-xs text-app-text-muted">{fmtTs(rel.published_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-app-text-muted">No releases found.</p>
              )}
            </div>
          </div>
        )}

        {activeTab === "diagnostics" && (
          <section className="ui-card p-6 animate-in fade-in duration-300">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-5 w-5 text-app-accent" />
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Diagnostics & AI Analysis
                </h3>
              </div>
              <button
                onClick={fetchDiagnostics}
                disabled={diagLoading}
                className="ui-btn ui-btn-ghost ui-btn-sm inline-flex items-center gap-1 border border-app-border/60 hover:border-app-accent/40"
              >
                <RefreshCw className={`h-4 w-4 ${diagLoading ? "animate-spin" : ""}`} />
                {diagLoading ? "Analyzing..." : "Run Diagnostics"}
              </button>
            </div>

            {!diagnostics ? (
              <div className="rounded-xl border border-app-border/60 p-8 text-center bg-app-surface/20">
                <Terminal className="mx-auto mb-3 h-8 w-8 text-app-text-muted" />
                <p className="text-sm text-app-text-muted">
                  Click "Run Diagnostics" to capture server logs, errors, warnings,
                  and generate an AI prompt for analysis.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="rounded-xl bg-app-surface/30 border border-app-border/40 p-4">
                    <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">Version</div>
                    <div className="text-base font-black text-app-text mt-1">{diagnostics.server.version}</div>
                  </div>
                  <div className="rounded-xl bg-app-surface/30 border border-app-border/40 p-4">
                    <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">Rust</div>
                    <div className="text-base font-black text-app-text mt-1">{diagnostics.server.rust_version}</div>
                  </div>
                  <div className="rounded-xl bg-app-surface/30 border border-app-border/40 p-4">
                    <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">DB Pool</div>
                    <div className="text-base font-black text-app-text mt-1">
                      {diagnostics.database.active_connections}/{diagnostics.database.pool_size}
                    </div>
                  </div>
                  <div className="rounded-xl bg-app-surface/30 border border-app-border/40 p-4">
                    <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">Migrations</div>
                    <div className="text-base font-black text-app-text mt-1">{diagnostics.database.migration_count}</div>
                  </div>
                </div>

                {diagnostics.errors.length > 0 && (
                  <div>
                    <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-danger">
                      <AlertTriangle className="h-4 w-4" />
                      Errors ({diagnostics.errors.length})
                    </h4>
                    <div className="max-h-[200px] overflow-auto rounded-xl border border-app-danger/30 bg-app-danger/5">
                      {diagnostics.errors.map((e, i) => (
                        <div key={i} className="border-b border-app-danger/10 px-3 py-2 text-xs">
                          <div className="flex items-center gap-2 text-app-text-muted">
                            <span>{fmtTs(e.timestamp)}</span>
                            <span className="font-mono text-app-accent">{e.target}</span>
                          </div>
                          <div className="mt-1 text-app-text font-mono">{e.message}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {diagnostics.warnings.length > 0 && (
                  <div>
                    <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-warning">
                      <Wrench className="h-4 w-4" />
                      Warnings ({diagnostics.warnings.length})
                    </h4>
                    <div className="max-h-[200px] overflow-auto rounded-xl border border-app-warning/30 bg-app-warning/5">
                      {diagnostics.warnings.map((w, i) => (
                        <div key={i} className="border-b border-app-warning/10 px-3 py-2 text-xs">
                          <div className="flex items-center gap-2 text-app-text-muted">
                            <span>{fmtTs(w.timestamp)}</span>
                            <span className="font-mono text-app-accent">{w.target}</span>
                          </div>
                          <div className="mt-1 text-app-text font-mono">{w.message}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border/40 pt-4">
                    <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-success">
                      <Clipboard className="h-4 w-4" />
                      AI Analysis Prompt
                    </h4>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(diagnostics.ai_prompt);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        className="ui-btn ui-btn-ghost ui-btn-sm border border-app-border/60"
                      >
                        {copied ? <ClipboardCheck className="h-4 w-4 text-app-success" /> : <Clipboard className="h-4 w-4" />}
                        {copied ? "Copied!" : "Copy"}
                      </button>
                      <button
                        onClick={runRosieAnalysis}
                        disabled={analyzing}
                        className="ui-btn ui-btn-primary ui-btn-sm inline-flex items-center gap-1"
                      >
                        {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
                        {analyzing ? "Analyzing..." : "Analyze with ROSIE"}
                      </button>
                    </div>
                  </div>
                  
                  <div className="max-h-[200px] overflow-auto rounded-xl border border-app-border/60 bg-app-surface/20 p-4">
                    <pre className="whitespace-pre-wrap text-xs text-app-text-muted font-mono">
                      {diagnostics.ai_prompt}
                    </pre>
                  </div>

                  {analysis && (
                    <div className="rounded-xl border border-app-accent/30 bg-app-accent/5 p-4 animate-in slide-in-from-bottom duration-300">
                      <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-accent">
                        <Brain className="h-4 w-4" />
                        ROSIE Analysis
                      </h4>
                      <div className="max-h-[400px] overflow-auto text-sm text-app-text prose prose-invert">
                        {analysis.split("\n").map((line, i) => (
                          <p key={i} className="mb-1">
                            {line.startsWith("##") ? (
                              <span className="font-bold text-app-accent block mt-2">{line}</span>
                            ) : line.startsWith("-") || line.startsWith("1.") || line.startsWith("2.") ? (
                              <span className="text-app-text-muted font-mono text-xs block pl-3">{line}</span>
                            ) : (
                              line
                            )}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {diagnostics.errors.length === 0 && diagnostics.warnings.length === 0 && (
                  <div className="rounded-xl border border-app-success/30 bg-app-success/5 p-6 text-center">
                    <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-app-success" />
                    <p className="text-sm font-black text-app-success">No errors or warnings detected!</p>
                    <p className="mt-1 text-xs text-app-text-muted">
                      Server is running cleanly. Check back after usage.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
