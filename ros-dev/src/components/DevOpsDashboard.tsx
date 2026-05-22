import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bug,
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
  Server,
  ShieldAlert,
  Tag,
  Terminal,
  Wifi,
  Wrench,
} from "lucide-react";
import { apiGet, apiPost, getServerUrl, setServerConfig, type DiagnosticsSnapshot } from "../lib/api";

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

interface OpsOverview {
  server_time: string;
  db_ok: boolean;
  stations_online: number;
  stations_offline: number;
  open_alerts: number;
  pending_bug_reports: number;
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
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [github, setGithub] = useState<GitHubData | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [ov, al, st, ghWf, ghRel] = await Promise.all([
        apiGet<OpsOverview>("/api/ops/overview").catch(() => null),
        apiGet<{ alerts: AlertEvent[] }>("/api/ops/alerts").catch(() => ({ alerts: [] })),
        apiGet<{ stations: Station[] }>("/api/ops/stations").catch(() => ({ stations: [] })),
        apiGet<{ workflow_runs: WorkflowRun[] }>("/api/ops/github/workflows").catch(() => ({ workflow_runs: [] })),
        apiGet<Release[]>("/api/ops/github/releases").catch(() => []),
      ]);
      setOverview(ov);
      setAlerts(al.alerts);
      setStations(st.stations);
      setGithub({ workflows: { workflow_runs: ghWf.workflow_runs }, releases: ghRel });
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

  const openAlerts = alerts.filter((a) => a.status === "open" || a.status === "acked");
  const criticalAlerts = openAlerts.filter((a) => a.severity === "critical").length;

  return (
    <div className="min-h-screen p-6">
      {/* Header */}
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo1.png" alt="Riverside" className="h-8 w-8" />
          <div>
            <h1 className="text-lg font-black tracking-wide">ROS Dev Center</h1>
            <p className="text-xs text-app-text-muted">
              {getServerUrl()} · {fmtTs(overview?.server_time)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            disabled={loading}
            className="ui-btn ui-btn-ghost ui-btn-sm inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button onClick={handleLogout} className="ui-btn ui-btn-ghost ui-btn-sm">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-lg bg-app-danger/12 px-4 py-3 text-sm text-app-danger">
          {error}
        </div>
      )}

      {/* KPI Cards */}
      <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="ui-card p-4">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-text-muted">
            <Server className="h-4 w-4 text-app-accent" />
            DB Status
          </div>
          <div className="mt-2 flex items-center gap-2">
            {overview?.db_ok ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-app-success" />
                <span className="text-lg font-black text-app-success">Healthy</span>
              </>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-app-danger" />
                <span className="text-lg font-black text-app-danger">Down</span>
              </>
            )}
          </div>
        </div>

        <div className="ui-card p-4">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-text-muted">
            <Laptop className="h-4 w-4 text-app-accent" />
            Stations
          </div>
          <div className="mt-2 text-lg font-black text-app-text">
            {overview?.stations_online ?? 0}
            <span className="mx-1 text-app-text-muted">/</span>
            {(overview?.stations_online ?? 0) + (overview?.stations_offline ?? 0)}
            <span className="ml-2 text-xs font-normal text-app-text-muted">online</span>
          </div>
        </div>

        <div className="ui-card p-4">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-text-muted">
            <ShieldAlert className="h-4 w-4 text-app-warning" />
            Alerts
          </div>
          <div className="mt-2 text-lg font-black text-app-text">
            {openAlerts.length}
            {criticalAlerts > 0 && (
              <span className="ml-2 text-sm text-app-danger">({criticalAlerts} critical)</span>
            )}
          </div>
        </div>

        <div className="ui-card p-4">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-text-muted">
            <Bug className="h-4 w-4 text-app-accent" />
            Bugs
          </div>
          <div className="mt-2 text-lg font-black text-app-text">
            {overview?.pending_bug_reports ?? 0}
            <span className="ml-2 text-xs font-normal text-app-text-muted">pending</span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* GitHub Workflows */}
        <section className="ui-card p-6">
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
              {dispatching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              Build Release
            </button>
          </div>

          {github?.workflows?.workflow_runs?.length ? (
            <div className="max-h-[300px] overflow-auto rounded-xl border border-app-border/60">
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
                    <tr
                      key={run.id}
                      className="border-t border-app-border/40 hover:bg-app-bg/50"
                    >
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
                      <td className="px-3 py-2 text-xs text-app-text-muted">
                        {fmtTs(run.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-app-text-muted">No workflow runs found.</p>
          )}
        </section>

        {/* Releases */}
        <section className="ui-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <Tag className="h-5 w-5 text-app-accent" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Releases
            </h3>
          </div>

          {github?.releases?.length ? (
            <div className="max-h-[300px] overflow-auto rounded-xl border border-app-border/60">
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
                    <tr
                      key={rel.id}
                      className="border-t border-app-border/40 hover:bg-app-bg/50"
                    >
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
                      <td className="px-3 py-2 text-xs text-app-text-muted">
                        {fmtTs(rel.published_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-app-text-muted">No releases found.</p>
          )}
        </section>

        {/* Stations */}
        <section className="ui-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <Wifi className="h-5 w-5 text-app-accent" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Stations
            </h3>
          </div>

          {stations.length ? (
            <div className="max-h-[300px] overflow-auto rounded-xl border border-app-border/60">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-app-surface">
                  <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                    <th className="px-3 py-2">Station</th>
                    <th className="px-3 py-2">Version</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {stations.map((s) => (
                    <tr
                      key={s.station_key}
                      className="border-t border-app-border/40 hover:bg-app-bg/50"
                    >
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
                      <td className="px-3 py-2 text-xs text-app-text-muted">
                        {fmtTs(s.last_seen_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-app-text-muted">No stations found.</p>
          )}
        </section>

        {/* Alerts */}
        <section className="ui-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-app-warning" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Open Alerts
            </h3>
          </div>

          {openAlerts.length ? (
            <div className="max-h-[300px] overflow-auto rounded-xl border border-app-border/60">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-app-surface">
                  <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                    <th className="px-3 py-2">Alert</th>
                    <th className="px-3 py-2">Severity</th>
                    <th className="px-3 py-2">First Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {openAlerts.slice(0, 20).map((a) => (
                    <tr
                      key={a.id}
                      className="border-t border-app-border/40 hover:bg-app-bg/50"
                    >
                      <td className="px-3 py-2">{a.title}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${
                            a.severity === "critical"
                              ? "bg-app-danger/12 text-app-danger"
                              : a.severity === "warning"
                                ? "bg-app-warning/12 text-app-warning"
                                : "bg-app-success/12 text-app-success"
                          }`}
                        >
                          {a.severity}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-app-text-muted">
                        {fmtTs(a.first_seen_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-app-text-muted">No open alerts.</p>
          )}
        </section>

        {/* Diagnostics & AI Prompt */}
        <section className="ui-card col-span-1 p-6 xl:col-span-2">
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
              className="ui-btn ui-btn-ghost ui-btn-sm inline-flex items-center gap-1"
            >
              <RefreshCw className={`h-4 w-4 ${diagLoading ? "animate-spin" : ""}`} />
              {diagLoading ? "Analyzing..." : "Run Diagnostics"}
            </button>
          </div>

          {!diagnostics ? (
            <div className="rounded-xl border border-app-border/60 p-8 text-center">
              <Terminal className="mx-auto mb-3 h-8 w-8 text-app-text-muted" />
              <p className="text-sm text-app-text-muted">
                Click "Run Diagnostics" to capture server logs, errors, warnings,
                and generate an AI prompt for analysis.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Server Stats */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-lg bg-app-bg p-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">Version</div>
                  <div className="text-sm font-black text-app-text">{diagnostics.server.version}</div>
                </div>
                <div className="rounded-lg bg-app-bg p-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">Rust</div>
                  <div className="text-sm font-black text-app-text">{diagnostics.server.rust_version}</div>
                </div>
                <div className="rounded-lg bg-app-bg p-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">DB Pool</div>
                  <div className="text-sm font-black text-app-text">
                    {diagnostics.database.active_connections}/{diagnostics.database.pool_size}
                  </div>
                </div>
                <div className="rounded-lg bg-app-bg p-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">Migrations</div>
                  <div className="text-sm font-black text-app-text">{diagnostics.database.migration_count}</div>
                </div>
              </div>

              {/* Errors */}
              {diagnostics.errors.length > 0 && (
                <div>
                  <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-danger">
                    <AlertTriangle className="h-4 w-4" />
                    Errors ({diagnostics.errors.length})
                  </h4>
                  <div className="max-h-[200px] overflow-auto rounded-xl border border-app-danger/30 bg-app-danger/5">
                    {diagnostics.errors.slice(0, 10).map((e, i) => (
                      <div key={i} className="border-b border-app-danger/10 px-3 py-2 text-xs">
                        <div className="flex items-center gap-2 text-app-text-muted">
                          <span>{fmtTs(e.timestamp)}</span>
                          <span className="font-mono text-app-accent">{e.target}</span>
                        </div>
                        <div className="mt-1 text-app-text">{e.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Warnings */}
              {diagnostics.warnings.length > 0 && (
                <div>
                  <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-warning">
                    <Wrench className="h-4 w-4" />
                    Warnings ({diagnostics.warnings.length})
                  </h4>
                  <div className="max-h-[200px] overflow-auto rounded-xl border border-app-warning/30 bg-app-warning/5">
                    {diagnostics.warnings.slice(0, 10).map((w, i) => (
                      <div key={i} className="border-b border-app-warning/10 px-3 py-2 text-xs">
                        <div className="flex items-center gap-2 text-app-text-muted">
                          <span>{fmtTs(w.timestamp)}</span>
                          <span className="font-mono text-app-accent">{w.target}</span>
                        </div>
                        <div className="mt-1 text-app-text">{w.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* AI Prompt & ROSIE Analysis */}
              {diagnostics.errors.length > 0 && (
                <div className="space-y-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-success">
                      <Clipboard className="h-4 w-4" />
                      AI Prompt
                    </h4>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(diagnostics.ai_prompt);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        className="ui-btn ui-btn-ghost ui-btn-sm inline-flex items-center gap-1"
                      >
                        {copied ? <ClipboardCheck className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                        {copied ? "Copied!" : "Copy"}
                      </button>
                      <button
                        onClick={runRosieAnalysis}
                        disabled={analyzing}
                        className="ui-btn ui-btn-primary ui-btn-sm inline-flex items-center gap-1"
                      >
                        {analyzing ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Brain className="h-4 w-4" />
                        )}
                        {analyzing ? "Analyzing..." : "Analyze with ROSIE"}
                      </button>
                    </div>
                  </div>
                  <div className="max-h-[200px] overflow-auto rounded-xl border border-app-border/60 bg-app-bg p-4">
                    <pre className="whitespace-pre-wrap text-xs text-app-text-muted">
                      {diagnostics.ai_prompt}
                    </pre>
                  </div>

                  {/* ROSIE Analysis Result */}
                  {analysis && (
                    <div className="rounded-xl border border-app-accent/30 bg-app-accent/5 p-4">
                      <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-accent">
                        <Brain className="h-4 w-4" />
                        ROSIE Analysis
                      </h4>
                      <div className="max-h-[400px] overflow-auto text-sm text-app-text">
                        {analysis.split("\n").map((line, i) => (
                          <p key={i} className="mb-1">
                            {line.startsWith("##") ? (
                              <span className="font-bold text-app-accent">{line}</span>
                            ) : line.startsWith("-") || line.startsWith("1.") || line.startsWith("2.") ? (
                              <span className="text-app-text-muted">{line}</span>
                            ) : (
                              line
                            )}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

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
      </div>
    </div>
  );
}
