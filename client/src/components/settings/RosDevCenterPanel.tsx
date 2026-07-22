import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import {
  Code2,
  Database,
  RefreshCw,
  Terminal,
  Server,
  ShieldCheck,
  AlertTriangle,
  CheckCircle,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import GitHubDevOpsPanel from "./GitHubDevOpsPanel";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import RosieIcon from "../common/RosieIcon";

type ServerDiagnostics = {
  version: string;
  uptime_seconds: number;
  rust_version: string;
};

type DatabaseDiagnostics = {
  connected: boolean;
  pool_size: number;
  active_connections: number;
  idle_connections: number;
  migration_count: number;
};

type LogEntry = {
  timestamp: string;
  level: string;
  target: string;
  message: string;
};

type DiagnosticsSnapshot = {
  generated_at: string;
  server: ServerDiagnostics;
  database: DatabaseDiagnostics;
  errors: LogEntry[];
  warnings: LogEntry[];
  github: { token_configured: boolean };
  ai_prompt: string;
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

type AuditProbeRun = {
  id: string;
  probe_count: number;
  total_violation_rows: number;
  probes_with_violations: number;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

type AuditProbeResult = {
  id: string;
  run_id: string;
  probe_key: string;
  probe_label: string;
  severity: string;
  violation_count: number;
  detail_rows: unknown[];
  created_at: string;
};

type GuardedActionKey =
  | "help.reindex_search"
  | "help.generate_manifest"
  | "ops.retention_cleanup"
  | "backup.trigger_local";

const baseUrl = getBaseUrl();

function fmtTs(v: string | null): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
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

export default function RosDevCenterPanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [e2eHealth, setE2eHealth] = useState<E2eHealthSnapshot | null>(null);
  const [e2eHealthLoading, setE2eHealthLoading] = useState(false);
  const [auditRows, setAuditRows] = useState<ActionAuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const [probeRuns, setProbeRuns] = useState<AuditProbeRun[]>([]);
  const [probeResults, setProbeResults] = useState<AuditProbeResult[]>([]);
  const [selectedProbeRunId, setSelectedProbeRunId] = useState<string | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeRunBusy, setProbeRunBusy] = useState(false);

  // ROSIE AI analysis states
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);

  // Database Vacuum state
  const [vacuumBusy, setVacuumBusy] = useState(false);

  // Guarded actions state
  const [actionBusy, setActionBusy] = useState<GuardedActionKey | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [confirmPrimary, setConfirmPrimary] = useState(false);
  const [confirmSecondary, setConfirmSecondary] = useState(false);

  const [manifestDryRun, setManifestDryRun] = useState(true);
  const [manifestIncludeShadcn, setManifestIncludeShadcn] = useState(false);
  const [manifestRescan, setManifestRescan] = useState(false);
  const [manifestCleanupOrphans, setManifestCleanupOrphans] = useState(false);

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

  const loadDiagnostics = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setDiagnosticsError(null);
    try {
      const headers = backofficeHeaders() as Record<string, string>;
      const res = await fetch(`${baseUrl}/api/ops/diagnostics`, { headers });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDiagnosticsError(body.error || `Diagnostics request failed (${res.status}).`);
        return;
      }
      setDiagnostics((await res.json()) as DiagnosticsSnapshot);
    } catch (error) {
      setDiagnosticsError(
        error instanceof Error ? error.message : "Diagnostics could not reach the Main Hub.",
      );
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, canView]);

  const loadAuditLogs = useCallback(async () => {
    if (!canView) return;
    setAuditLoading(true);
    try {
      const headers = backofficeHeaders() as Record<string, string>;
      const res = await fetch(`${baseUrl}/api/ops/audit-log`, { headers });
      if (!res.ok) {
        setAuditRows([]);
        return;
      }
      setAuditRows((await res.json()) as ActionAuditRow[]);
    } catch {
      setAuditRows([]);
    } finally {
      setAuditLoading(false);
    }
  }, [backofficeHeaders, canView]);

  const loadAuditProbes = useCallback(async () => {
    if (!canView) return;
    setProbeLoading(true);
    try {
      const headers = backofficeHeaders() as Record<string, string>;
      const res = await fetch(`${baseUrl}/api/ops/audit-probes`, { headers });
      if (!res.ok) {
        setProbeRuns([]);
        return;
      }
      setProbeRuns((await res.json()) as AuditProbeRun[]);
    } catch {
      setProbeRuns([]);
    } finally {
      setProbeLoading(false);
    }
  }, [backofficeHeaders, canView]);

  const loadProbeDetail = useCallback(
    async (runId: string) => {
      if (!canView) return;
      setSelectedProbeRunId(runId);
      setProbeLoading(true);
      try {
        const headers = backofficeHeaders() as Record<string, string>;
        const res = await fetch(`${baseUrl}/api/ops/audit-probes/${runId}`, { headers });
        if (!res.ok) {
          setProbeResults([]);
          return;
        }
        const data = (await res.json()) as { run: AuditProbeRun; results: AuditProbeResult[] };
        setProbeResults(data.results ?? []);
      } catch {
        setProbeResults([]);
      } finally {
        setProbeLoading(false);
      }
    },
    [backofficeHeaders, canView],
  );

  const runAuditProbes = useCallback(async () => {
    if (!canView) return;
    setProbeRunBusy(true);
    try {
      const headers = {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      };
      const res = await fetch(`${baseUrl}/api/ops/audit-probes`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        toast("Audit probe run failed", "error");
        return;
      }
      const run = (await res.json()) as AuditProbeRun;
      toast(
        run.total_violation_rows > 0
          ? `${run.probes_with_violations} probe(s) found ${run.total_violation_rows} violation(s)`
          : "All probes clean — no violations",
        run.total_violation_rows > 0 ? "info" : "success",
      );
      void loadAuditProbes();
      void loadProbeDetail(run.id);
    } catch {
      toast("Network error running audit probes", "error");
    } finally {
      setProbeRunBusy(false);
    }
  }, [backofficeHeaders, canView, toast, loadAuditProbes, loadProbeDetail]);

  const loadAll = useCallback(() => {
    void loadDiagnostics();
    void loadE2eHealth();
    void loadAuditLogs();
    void loadAuditProbes();
  }, [loadDiagnostics, loadE2eHealth, loadAuditLogs, loadAuditProbes]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const refreshBusy = loading || e2eHealthLoading || auditLoading || probeLoading;

  const blockingLane = e2eHealth?.blocking ?? null;
  const nightlyLane = e2eHealth?.nightly ?? null;

  // Trigger local vacuum / optimize
  const handleVacuumOptimize = async () => {
    setVacuumBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/database/optimize`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        toast("Database optimized successfully", "success");
        void loadDiagnostics();
      } else {
        toast("Database optimization failed", "error");
      }
    } catch {
      toast("Network error optimizing database", "error");
    } finally {
      setVacuumBusy(false);
    }
  };

  // ROSIE AI Analysis trigger
  const runAiAnalysis = async () => {
    if (!diagnostics?.ai_prompt) {
      toast("No diagnostics prompt compiled yet", "error");
      return;
    }
    setAiBusy(true);
    setAiAnalysis(null);
    try {
      const res = await fetch(`${baseUrl}/api/ops/diagnostics/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ prompt: diagnostics.ai_prompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error ?? "AI Analysis failed", "error");
        return;
      }
      if (data.error) {
        toast(data.error, "error");
      } else {
        setAiAnalysis(data.analysis);
        toast("Analysis complete", "success");
      }
    } catch {
      toast("Network error running AI analysis", "error");
    } finally {
      setAiBusy(false);
    }
  };

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
        loadAll();
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

  if (!canView) {
    return (
      <div className="ui-card p-8">
        <h2 className="text-xl font-black uppercase tracking-widest text-app-text">
          Dev Center
        </h2>
        <p className="mt-2 text-sm text-app-text-muted">
          You do not have access to this developer workspace.
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
            <Code2 className="h-8 w-8 text-app-accent" />
            Dev Center
          </h2>
          <p className="mt-1 text-sm font-medium text-app-text-muted">
            Internal diagnostics, database connection pools, local AI log analysis, and E2E regression testing.
          </p>
        </div>
        <button
          type="button"
          onClick={loadAll}
          disabled={refreshBusy}
          className="ui-btn-ghost px-4 py-2 text-xs font-black uppercase tracking-widest"
        >
          <RefreshCw className={`mr-2 inline h-4 w-4 ${refreshBusy ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {diagnosticsError ? (
        <div className="rounded-xl border border-app-warning/40 bg-app-warning/10 px-4 py-3 text-sm font-semibold text-app-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p className="font-black">Diagnostics unavailable</p>
              <p className="mt-1">
                {diagnosticsError} {diagnostics ? "Values below are the last confirmed snapshot." : "No values are being inferred or replaced with zero."}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Main Grid: DB and Server info */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Database diagnostics card */}
        <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-app-accent" />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                PostgreSQL Connection Pool
              </h3>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-widest border ${
                diagnostics?.database.connected
                  ? "bg-app-success/12 text-app-success border-app-success/30"
                  : diagnostics
                    ? "bg-app-danger/12 text-app-danger border-app-danger/30"
                    : "bg-app-warning/12 text-app-warning border-app-warning/30"
              }`}
            >
              {diagnostics?.database.connected
                ? "Connected"
                : diagnostics
                  ? "Disconnected"
                  : "Unavailable"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="ui-metric-cell ui-tint-neutral p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Total Pool Size
              </p>
              <p className="mt-2 text-2xl font-black text-app-text">
                {diagnostics?.database.pool_size ?? "—"}
              </p>
            </div>
            <div className="ui-metric-cell ui-tint-neutral p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Active Connections
              </p>
              <p className="mt-2 text-2xl font-black text-app-accent">
                {diagnostics?.database.active_connections ?? "—"}
              </p>
            </div>
            <div className="ui-metric-cell ui-tint-neutral p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Idle Connections
              </p>
              <p className="mt-2 text-2xl font-black text-app-text">
                {diagnostics?.database.idle_connections ?? "—"}
              </p>
            </div>
            <div className="ui-metric-cell ui-tint-neutral p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Applied Migrations
              </p>
              <p className="mt-2 text-2xl font-black text-app-text">
                {diagnostics?.database.migration_count ?? "—"}
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              disabled={vacuumBusy || !diagnostics?.database.connected}
              onClick={() => void handleVacuumOptimize()}
              className="ui-btn-secondary px-4 py-2 text-xs font-black uppercase tracking-widest"
            >
              <Database className="mr-2 inline h-4 w-4" />
              {vacuumBusy ? "Vacuuming..." : "Vacuum & Optimize DB"}
            </button>
          </div>
        </div>

        {/* Server & Environment info */}
        <div className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60 flex flex-col justify-between">
          <div>
            <div className="mb-4 flex items-center gap-2">
              <Server className="h-5 w-5 text-app-accent" />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Server Environment
              </h3>
            </div>
            <div className="space-y-4">
              <div className="flex justify-between border-b border-app-border/40 pb-2 text-xs">
                <span className="font-bold text-app-text-muted">Package Version:</span>
                <span className="font-mono text-app-text">{diagnostics?.server.version ?? "-"}</span>
              </div>
              <div className="flex justify-between border-b border-app-border/40 pb-2 text-xs">
                <span className="font-bold text-app-text-muted">Rust Runtime Version:</span>
                <span className="font-mono text-app-text">{diagnostics?.server.rust_version ?? "-"}</span>
              </div>
              <div className="flex justify-between border-b border-app-border/40 pb-2 text-xs">
                <span className="font-bold text-app-text-muted">Server Uptime:</span>
                <span className="font-mono text-app-text">
                  {diagnostics?.server.uptime_seconds
                    ? `${(diagnostics.server.uptime_seconds / 3600).toFixed(2)} hours`
                    : "-"}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="font-bold text-app-text-muted">Captured Errors / Warnings (24h):</span>
                <span className="font-mono font-bold text-app-danger">
                  {diagnostics
                    ? `${diagnostics.errors.length} E / ${diagnostics.warnings.length} W`
                    : "Unavailable"}
                </span>
              </div>
            </div>
          </div>
          <p className="mt-4 text-[10px] text-app-text-muted">
            Environment metadata auto-compiled at startup. GitHub token configured:{" "}
            <strong>
              {diagnostics ? (diagnostics.github.token_configured ? "Yes" : "No") : "Unavailable"}
            </strong>
          </p>
        </div>
      </div>

      {/* ROSIE AI Diagnostics Analyzer */}
      <section className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RosieIcon size={20} alt="" />
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                ROSIE AI Log Analyzer
              </h3>
              <p className="mt-1 text-xs text-app-text-muted">
                Run system metrics and log streams through our local Gemma LLM endpoint to diagnose anomalies.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={aiBusy || !diagnostics?.ai_prompt}
            onClick={() => void runAiAnalysis()}
            className="ui-btn-primary px-4 py-2 text-xs font-black uppercase tracking-widest flex items-center gap-2"
          >
            <RosieIcon size={16} alt="" className={aiBusy ? "animate-pulse" : ""} />
            {aiBusy ? "Analyzing Logs..." : "Run AI Analysis"}
          </button>
        </div>

        {aiAnalysis ? (
          <div className="mt-4 rounded-xl border border-app-border/60 bg-black/85 p-4 font-mono text-xs text-emerald-400 overflow-x-auto max-h-96">
            <pre className="whitespace-pre-wrap">{aiAnalysis}</pre>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-app-border p-8 text-center text-xs text-app-text-muted bg-app-bg/20">
            No analysis results yet. Click the button to send compile log snapshot data to the local worker.
          </div>
        )}
      </section>

      {/* E2E health lanes */}
      <section className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Playwright E2E Regression Lanes
          </h3>
        </div>
        <p className="text-xs text-app-text-muted">
          Active test telemetry integrated with GitHub Action workflow runs.
        </p>

        <div className="mt-4">
          <IntegrationCredentialsCard
            baseUrl={baseUrl}
            integrationKey="ops_github"
            title="GitHub E2E Telemetry Sync"
            description="Secure developer configuration containing the repository identifier and GitHub token used by E2E telemetry and DevOps workflow actions."
            fields={[
              {
                key: "repo",
                label: "Repository",
                type: "text",
                placeholder: "owner/riverside-os",
                help: "Must map to GitHub repository name.",
              },
              {
                key: "token",
                label: "GitHub Access Token",
                type: "password",
                help: "Requires workflow-run read access for telemetry. Add workflow dispatch scope only if this server should trigger release workflows.",
              },
            ]}
            onSaved={loadE2eHealth}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[
            { label: "Blocking Merge Checks", lane: blockingLane },
            { label: "Nightly Execution Suite", lane: nightlyLane },
          ].map(({ label, lane }) => (
            <div key={label} className="ui-metric-cell ui-tint-neutral p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-black text-app-text">{label}</p>
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${laneOutcomeClass(
                    lane?.last_run_outcome ?? "unknown",
                  )}`}
                >
                  {(lane?.last_run_outcome ?? "unknown").replace("_", " ")}
                </span>
              </div>
              <p className="mt-2 text-xs text-app-text-muted">
                Run Number: {lane?.run_number ? `#${lane.run_number}` : "-"}
                {lane?.html_url && (
                  <>
                    {" "}
                    •{" "}
                    <a
                      href={lane.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-black text-app-accent underline"
                    >
                      View GitHub Action
                    </a>
                  </>
                )}
              </p>
              <p className="mt-1 text-[11px] text-app-text-muted">
                Started: {fmtTs(lane?.started_at ?? null)} | Completed: {fmtTs(lane?.completed_at ?? null)}
              </p>
              {lane?.failed_specs.length ? (
                <div className="mt-3 rounded-lg border border-app-border/40 bg-app-bg/50 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                    Failed Spec Suites
                  </p>
                  <div className="space-y-1 font-mono text-[10px] text-app-danger">
                    {lane.failed_specs.map((spec) => (
                      <div key={spec}>{spec}</div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {/* Local commands snippet box */}
        <div className="mt-4 rounded-xl border border-app-border/60 bg-app-bg/30 p-4 font-mono text-xs text-app-text space-y-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Local CLI Execution</p>
          <div className="space-y-1">
            <div>blocking: <span className="font-bold">npm --prefix client run test:e2e:blocking</span></div>
            <div>nightly: <span className="font-bold">npm --prefix client run test:e2e:nightly</span></div>
          </div>
        </div>

        <div className="mt-4 border-t border-app-border/40 pt-4">
          <GitHubDevOpsPanel />
        </div>
      </section>

      {/* Developer Guarded Actions */}
      <section className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
        <div className="mb-4 flex items-center gap-2">
          <Terminal className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Guarded Developer Actions
          </h3>
        </div>

        {!canRunActions ? (
          <p className="text-xs text-app-text-muted">
            Developer authorization defaults restrict execution. Developer role mapping is required to run protected commands.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Audit Trail Reason (Required)
              </label>
              <textarea
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                rows={2}
                className="ui-input mt-2 w-full bg-app-bg text-app-text border-app-border"
                placeholder="Reason statement required to sign action payload..."
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="inline-flex items-center gap-2 text-app-text-muted">
                <input
                  type="checkbox"
                  checked={confirmPrimary}
                  onChange={(e) => setConfirmPrimary(e.target.checked)}
                />
                Confirm execution target
              </label>
              <label className="inline-flex items-center gap-2 text-app-text-muted">
                <input
                  type="checkbox"
                  checked={confirmSecondary}
                  onChange={(e) => setConfirmSecondary(e.target.checked)}
                />
                Confirm production safety
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={actionBusy === "help.reindex_search"}
                onClick={() => void runGuardedAction("help.reindex_search", {})}
                className="ui-btn-primary py-3 text-xs font-black uppercase tracking-widest"
              >
                {actionBusy === "help.reindex_search" ? "Reindexing..." : "Reindex Help Search"}
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
                className="ui-btn-secondary py-3 text-xs font-black uppercase tracking-widest"
              >
                {actionBusy === "help.generate_manifest" ? "Generating..." : "Generate Help Manifest"}
              </button>
            </div>

            {/* Manifest Checkboxes */}
            <div className="rounded-xl border border-app-border p-4 text-xs text-app-text bg-app-bg/25">
              <div className="mb-2 font-black uppercase tracking-widest text-[10px] text-app-text-muted">Help Manifest Generation Options</div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
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
                  Rescan files
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={manifestCleanupOrphans}
                    onChange={(e) => setManifestCleanupOrphans(e.target.checked)}
                  />
                  Clean orphans
                </label>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Production Audit Probes */}
      <section className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-app-accent" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Production Audit Probes
            </h3>
          </div>
          <button
            type="button"
            disabled={probeRunBusy}
            onClick={() => void runAuditProbes()}
            className="ui-btn-primary px-4 py-2 text-xs font-black uppercase tracking-widest flex items-center gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${probeRunBusy ? "animate-spin" : ""}`} />
            {probeRunBusy ? "Running..." : "Run Probes Now"}
          </button>
        </div>
        <p className="text-xs text-app-text-muted mb-4">
          Read-only checks for duplicate checkouts, orphan payments, negative stock, QBO integrity,
          commission timing, and backup health. Non-zero results create Dev Center alerts.
        </p>

        {probeLoading && !probeRunBusy && (
          <p className="text-xs text-app-text-muted">Loading probe history...</p>
        )}

        {/* Run history */}
        <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1 mb-4">
          {probeRuns.slice(0, 20).map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => void loadProbeDetail(run.id)}
              className={`w-full text-left ui-metric-cell ui-tint-neutral px-3 py-2 ${selectedProbeRunId === run.id ? "ring-1 ring-app-accent" : ""}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {run.total_violation_rows > 0 ? (
                    <AlertTriangle className="h-4 w-4 text-app-warning" />
                  ) : (
                    <CheckCircle className="h-4 w-4 text-app-success" />
                  )}
                  <span className="text-xs font-black text-app-text">
                    {run.status === "failed" ? "Failed" : run.total_violation_rows > 0 ? `${run.probes_with_violations} probes flagged` : "All clear"}
                  </span>
                </div>
                <span className="text-[10px] text-app-text-muted">{fmtTs(run.created_at)}</span>
              </div>
              <div className="mt-1 flex gap-3 text-[10px] text-app-text-muted">
                <span>{run.probe_count} probes</span>
                <span>{run.total_violation_rows} violations</span>
                {run.duration_ms && <span>{run.duration_ms}ms</span>}
              </div>
            </button>
          ))}
          {!probeRuns.length && !probeLoading && (
            <p className="text-xs text-app-text-muted">No probe runs yet. Click "Run Probes Now" to begin.</p>
          )}
        </div>

        {/* Selected run detail */}
        {selectedProbeRunId && probeResults.length > 0 && (
          <div className="rounded-xl border border-app-border/60 bg-app-bg/30 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2">
              Probe Results
            </p>
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              {probeResults.map((result) => (
                <div
                  key={result.id}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    result.violation_count > 0
                      ? result.severity === "critical"
                        ? "border-app-danger/40 bg-app-danger/5"
                        : "border-app-warning/40 bg-app-warning/5"
                      : "border-app-success/20 bg-app-success/5"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-black text-app-text">{result.probe_label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${
                        result.violation_count > 0
                          ? result.severity === "critical"
                            ? "bg-app-danger/12 text-app-danger border border-app-danger/20"
                            : "bg-app-warning/12 text-app-warning border border-app-warning/20"
                          : "bg-app-success/12 text-app-success border border-app-success/20"
                      }`}
                    >
                      {result.violation_count} rows
                    </span>
                  </div>
                  {result.violation_count > 0 && result.detail_rows.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] text-app-text-muted font-black uppercase tracking-wider">
                        View {result.detail_rows.length} detail row(s)
                      </summary>
                      <div className="mt-2 space-y-1 font-mono text-[10px] text-app-text-muted overflow-x-auto">
                        {result.detail_rows.slice(0, 10).map((row, idx) => (
                          <pre key={idx} className="whitespace-pre-wrap break-all">
                            {JSON.stringify(row, null, 2)}
                          </pre>
                        ))}
                        {result.detail_rows.length > 10 && (
                          <p className="text-[10px] text-app-text-muted italic">
                            ...and {result.detail_rows.length - 10} more rows
                          </p>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Action Audit Log */}
      <section className="ui-card p-6 bg-app-surface/50 backdrop-blur-md border-app-border/60">
        <div className="mb-4 flex items-center gap-2">
          <Terminal className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Audit Trails (Guarded Actions)
          </h3>
        </div>

        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
          {auditRows.slice(0, 10).map((row) => (
            <div key={row.id} className="ui-metric-cell ui-tint-neutral px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-black text-app-text">{row.action_key}</div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${
                    row.result_ok
                      ? "bg-app-success/12 text-app-success border border-app-success/20"
                      : "bg-app-danger/12 text-app-danger border border-app-danger/20"
                  }`}
                >
                  {row.result_ok ? "Success" : "Failed"}
                </span>
              </div>
              <p className="mt-1 text-xs text-app-text-muted">{row.reason}</p>
              <p className="mt-1 text-[10px] text-app-text-muted">
                {fmtTs(row.created_at)} | ID: {row.correlation_id}
              </p>
            </div>
          ))}
          {!auditRows.length && (
            <p className="text-xs text-app-text-muted">No audit trails recorded.</p>
          )}
        </div>
      </section>
    </div>
  );
}
