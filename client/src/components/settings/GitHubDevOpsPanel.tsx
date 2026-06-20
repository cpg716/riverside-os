import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
  Rocket,
  Tag,
} from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

interface WorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface Release {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
}

interface GitHubData {
  workflows: { workflow_runs: WorkflowRun[] };
  releases: Release[];
}

type ReleaseScope = "full-deployment" | "app-updater-only";

function fmtTs(v: string | null): string {
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

export default function GitHubDevOpsPanel() {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();

  const [data, setData] = useState<GitHubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dispatchingScope, setDispatchingScope] = useState<ReleaseScope | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const headers = backofficeHeaders() as Record<string, string>;
      const [wfRes, relRes] = await Promise.all([
        fetch(`${baseUrl}/api/ops/github/workflows`, { headers }),
        fetch(`${baseUrl}/api/ops/github/releases`, { headers }),
      ]);

      const workflows = wfRes.ok ? await wfRes.json() : { workflow_runs: [] };
      const releases = relRes.ok ? await relRes.json() : [];
      setData({ workflows, releases });
    } catch {
      toast("Could not load GitHub data. Check RIVERSIDE_GITHUB_TOKEN.");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const triggerRelease = async (packageScope: ReleaseScope) => {
    setDispatchingScope(packageScope);
    try {
      const headers = {
        ...backofficeHeaders(),
        "Content-Type": "application/json",
      } as Record<string, string>;

      const res = await fetch(`${baseUrl}/api/ops/github/dispatch`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workflow_id: "windows-deployment-package.yml",
          branch: "main",
          inputs: {
            package_scope: packageScope,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Dispatch failed");
      }

      toast(
        packageScope === "app-updater-only"
          ? "Windows app updater workflow dispatched. Check Actions tab."
          : "Windows deployment release workflow dispatched. Check Actions tab.",
      );
      setTimeout(fetchData, 3000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Dispatch failed";
      toast(msg);
    } finally {
      setDispatchingScope(null);
    }
  };

  return (
    <section className="ui-card p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitMerge className="h-5 w-5 text-app-accent" />
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            GitHub DevOps
          </h3>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => triggerRelease("app-updater-only")}
            disabled={dispatchingScope !== null}
            className="ui-btn ui-btn-secondary ui-btn-sm inline-flex items-center gap-2"
          >
            {dispatchingScope === "app-updater-only" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            Windows App Update
          </button>
          <button
            onClick={() => triggerRelease("full-deployment")}
            disabled={dispatchingScope !== null}
            className="ui-btn ui-btn-primary ui-btn-sm inline-flex items-center gap-2"
          >
            {dispatchingScope === "full-deployment" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            Full Deployment
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="ui-btn ui-btn-ghost ui-btn-sm inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Workflow Runs */}
      <div className="mb-6">
        <h4 className="mb-2 text-xs font-black uppercase tracking-widest text-app-text-muted">
          Recent Workflow Runs
        </h4>
        {loading ? (
          <p className="text-sm text-app-text-muted">Loading...</p>
        ) : data?.workflows?.workflow_runs?.length ? (
          <div className="max-h-[240px] overflow-auto rounded-xl border border-app-border/60">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-app-surface">
                <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                  <th className="px-3 py-2">Workflow</th>
                  <th className="px-3 py-2">Branch</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Time</th>
                </tr>
              </thead>
              <tbody>
                {data.workflows.workflow_runs.slice(0, 10).map((run) => (
                  <tr
                    key={run.id}
                    className="border-t border-app-border/40 hover:bg-app-surface/50"
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
                    <td className="px-3 py-2">
                      {statusBadge(run.status, run.conclusion)}
                    </td>
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
      </div>

      {/* Releases */}
      <div>
        <h4 className="mb-2 text-xs font-black uppercase tracking-widest text-app-text-muted">
          Recent Releases
        </h4>
        {loading ? (
          <p className="text-sm text-app-text-muted">Loading...</p>
        ) : data?.releases?.length ? (
          <div className="max-h-[200px] overflow-auto rounded-xl border border-app-border/60">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-app-surface">
                <tr className="text-[10px] uppercase tracking-widest text-app-text-muted">
                  <th className="px-3 py-2">Tag</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Published</th>
                </tr>
              </thead>
              <tbody>
                {data.releases.slice(0, 10).map((rel) => (
                  <tr
                    key={rel.id}
                    className="border-t border-app-border/40 hover:bg-app-surface/50"
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
      </div>
    </section>
  );
}
