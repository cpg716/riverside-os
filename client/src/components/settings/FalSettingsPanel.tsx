import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  Coins,
  Activity,
  History,
  AlertCircle,
  FileImage,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";

interface FalSettingsPanelProps {
  baseUrl: string;
}

interface FalBillingResponse {
  username: string;
  credits?: {
    current_balance: number;
    currency: string;
  } | null;
}

interface FalUsageItem {
  endpoint_id: string;
  unit: string;
  quantity: number;
  unit_price: number;
  cost: number;
  currency: string;
  auth_method: string;
}

interface FalUsageBucket {
  bucket: string;
  results: FalUsageItem[];
}

interface FalUsageResponse {
  time_series?: FalUsageBucket[] | null;
}

interface FalJobStatus {
  id: string;
  job_type: string;
  target_id: string;
  pending_job_id?: string | null;
  local_asset_path?: string | null;
  status: string;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export default function FalSettingsPanel({ baseUrl }: FalSettingsPanelProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();

  const [billing, setBilling] = useState<FalBillingResponse | null>(null);
  const [usage, setUsage] = useState<FalUsageResponse | null>(null);
  const [jobs, setJobs] = useState<FalJobStatus[]>([]);

  const [loadingBilling, setLoadingBilling] = useState(true);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [loadingJobs, setLoadingJobs] = useState(true);

  const [billingError, setBillingError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const fetchBilling = useCallback(async () => {
    setLoadingBilling(true);
    setBillingError(null);
    try {
      const res = await fetch(`${baseUrl}/api/settings/fal/billing`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as FalBillingResponse;
        setBilling(j);
      } else {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        setBillingError(errJson.error ?? "Failed to fetch billing info");
        setBilling(null);
      }
    } catch {
      setBillingError("Communication error with server");
      setBilling(null);
    } finally {
      setLoadingBilling(false);
    }
  }, [baseUrl, backofficeHeaders]);

  const fetchUsage = useCallback(async () => {
    setLoadingUsage(true);
    setUsageError(null);
    try {
      const res = await fetch(`${baseUrl}/api/settings/fal/usage`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as FalUsageResponse;
        setUsage(j);
      } else {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        setUsageError(errJson.error ?? "Failed to fetch usage metrics");
        setUsage(null);
      }
    } catch {
      setUsageError("Communication error with server");
      setUsage(null);
    } finally {
      setLoadingUsage(false);
    }
  }, [baseUrl, backofficeHeaders]);

  const fetchJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const res = await fetch(`${baseUrl}/api/ai/visual/jobs`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as FalJobStatus[];
        setJobs(j);
      } else {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        console.error("Failed to fetch visual jobs:", errJson.error);
      }
    } catch (err) {
      console.error("Communication error with server fetching jobs:", err);
    } finally {
      setLoadingJobs(false);
    }
  }, [baseUrl, backofficeHeaders]);

  const refreshAll = useCallback(() => {
    void fetchBilling();
    void fetchUsage();
    void fetchJobs();
  }, [fetchBilling, fetchUsage, fetchJobs]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const totalCost = useMemo(() => {
    if (!usage?.time_series) return 0;
    let sum = 0;
    for (const bucket of usage.time_series) {
      for (const item of bucket.results) {
        sum += item.cost;
      }
    }
    return sum;
  }, [usage]);

  const usageByModel = useMemo(() => {
    const map = new Map<string, { quantity: number; cost: number; unit: string }>();
    if (!usage?.time_series) return [];
    for (const bucket of usage.time_series) {
      for (const item of bucket.results) {
        const existing = map.get(item.endpoint_id) ?? { quantity: 0, cost: 0, unit: item.unit };
        map.set(item.endpoint_id, {
          quantity: existing.quantity + item.quantity,
          cost: existing.cost + item.cost,
          unit: item.unit,
        });
      }
    }
    return Array.from(map.entries()).map(([endpoint_id, stats]) => ({
      endpoint_id,
      ...stats,
    }));
  }, [usage]);

  if (!hasPermission("settings.admin")) {
    return (
      <div className="ui-card p-8 text-center">
        <p className="text-sm font-medium text-app-text-muted">
          Manager access is needed to manage settings.
        </p>
      </div>
    );
  }

  const formatCost = (val: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(val);
  };



  return (
    <div className="space-y-10">
      <header className="mb-2">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex shrink-0 items-center justify-center rounded-2xl border border-app-border bg-app-surface p-2.5 text-indigo-500 shadow-sm">
            <Sparkles className="h-9 w-9" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
              Fal.ai Sidecar
            </h2>
            <p className="text-sm font-medium text-app-text-muted leading-relaxed max-w-3xl">
              Centralized AI visual orchestration for Staff Avatars, Product Master catalog imagery, and Online Store media generation.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshAll}
            className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Sync Dashboard
          </button>
        </div>
      </header>

      {/* Credentials and Account status grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-8">
          <IntegrationCredentialsCard
            baseUrl={baseUrl}
            integrationKey="fal"
            title="Fal.ai Key Management"
            description="Provide your Fal.ai API key to enable high-speed visual diffusion pipelines. Values are encrypted securely."
            fields={[
              {
                key: "api_key",
                label: "Fal.ai API key",
                type: "password",
                help: "Enter an admin scope key to enable usage and balance monitoring.",
              },
              {
                key: "webhook_base_url",
                label: "Webhook Base URL (Override)",
                type: "url",
                placeholder: "e.g. https://your-domain.ngrok-free.app",
                help: "Leave empty to fallback to the default server public URL.",
              },
            ]}
            onSaved={refreshAll}
          />

          {/* Local Jobs History */}
          <section className="ui-card overflow-hidden">
            <div className="p-6 border-b border-app-border bg-app-surface/30 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <History className="w-5 h-5 text-app-accent" />
                <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
                  Local Job History
                </h3>
              </div>
              <span className="text-[10px] font-black text-app-text-muted uppercase">
                {jobs.length} tracked jobs
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-app-bg/50 text-[9px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                    <th className="px-6 py-3">Job ID</th>
                    <th className="px-6 py-3">Type</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3">Details / Errors</th>
                    <th className="px-6 py-3 text-right">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border text-xs">
                  {loadingJobs ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-app-text-muted">
                        <RefreshCw className="h-5 w-5 animate-spin mx-auto opacity-40 mb-2" />
                        Retrieving job registry...
                      </td>
                    </tr>
                  ) : jobs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center font-medium italic text-app-text-muted">
                        No local visual sidecar tasks have been dispatched yet.
                      </td>
                    </tr>
                  ) : (
                    jobs.map((job) => (
                      <tr key={job.id} className="hover:bg-app-surface/20 transition-all">
                        <td className="px-6 py-4 font-mono text-[10px] font-bold text-app-text">
                          {job.id.substring(0, 8)}...
                        </td>
                        <td className="px-6 py-4">
                          <span className="ui-pill text-[9px] bg-indigo-500/10 text-indigo-600 uppercase font-black tracking-tight">
                            {job.job_type.replace("_", " ")}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`ui-pill text-[9px] font-black tracking-tight uppercase ${
                              job.status === "completed"
                                ? "bg-emerald-500/10 text-emerald-600"
                                : job.status === "processing" || job.status === "pending"
                                  ? "bg-amber-500/10 text-amber-600 animate-pulse"
                                  : "bg-red-500/10 text-red-600"
                            }`}
                          >
                            {job.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 max-w-xs truncate text-[11px] font-medium">
                          {job.status === "completed" && job.local_asset_path ? (
                            <a
                              href={job.local_asset_path}
                              target="_blank"
                              rel="noreferrer"
                              className="text-app-accent hover:underline flex items-center gap-1"
                            >
                              <FileImage className="w-3.5 h-3.5" />
                              View Local Cache
                            </a>
                          ) : job.error_message ? (
                            <span className="text-red-500 flex items-center gap-1" title={job.error_message}>
                              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                              {job.error_message}
                            </span>
                          ) : (
                            <span className="text-app-text-muted">In progress...</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right text-app-text-muted text-[10px] font-bold">
                          {new Date(job.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* Sidebar Info/Metrics */}
        <div className="lg:col-span-4 space-y-8">
          {/* Account & Billing */}
          <section className="ui-card p-6 space-y-6">
            <div className="flex items-center gap-3 border-b border-app-border/40 pb-4">
              <Coins className="w-5 h-5 text-app-accent" />
              <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
                Billing Overview
              </h3>
            </div>

            {loadingBilling ? (
              <div className="flex py-6 justify-center">
                <RefreshCw className="h-6 w-6 animate-spin text-app-accent opacity-40" />
              </div>
            ) : billingError ? (
              <div className="ui-panel ui-tint-warning p-4 text-xs text-app-text-muted">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-app-warning shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-app-warning uppercase tracking-widest text-[9px] mb-1">
                      Billing Unreachable
                    </p>
                    <p className="leading-relaxed">
                      {billingError === "FAL_KEY is not configured in settings"
                        ? "Save your Fal.ai API key to configure account details."
                        : "Verify your API key has Platform/Admin level access on Fal.ai."}
                    </p>
                  </div>
                </div>
              </div>
            ) : billing ? (
              <div className="space-y-4">
                <div className="ui-metric-cell ui-tint-success p-4">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                    Current Balance
                  </p>
                  <span className="text-2xl font-black text-app-text leading-none">
                    {billing.credits
                      ? `${formatCost(billing.credits.current_balance)}`
                      : "$0.00"}
                  </span>
                </div>

                <div className="text-[11px] space-y-2 border-t border-app-border/40 pt-4 font-bold uppercase text-app-text-muted">
                  <div className="flex justify-between">
                    <span>Account Name:</span>
                    <span className="text-app-text font-black">{billing.username}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Platform Currency:</span>
                    <span className="text-app-text font-black">
                      {billing.credits?.currency ?? "USD"}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          {/* Usage Statistics */}
          <section className="ui-card p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-app-border/40 pb-4">
              <div className="flex items-center gap-3">
                <Activity className="w-5 h-5 text-app-accent" />
                <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
                  Usage Metrics
                </h3>
              </div>
              <span className="ui-pill bg-indigo-500/10 text-indigo-600 text-[8px] font-black tracking-tight uppercase">
                Last 30 days
              </span>
            </div>

            {loadingUsage ? (
              <div className="flex py-6 justify-center">
                <RefreshCw className="h-6 w-6 animate-spin text-app-accent opacity-40" />
              </div>
            ) : usageError ? (
              <div className="text-xs text-app-text-muted p-2 italic text-center">
                Configure credentials to view usage history metrics.
              </div>
            ) : usageByModel.length === 0 ? (
              <div className="text-xs text-app-text-muted p-2 italic text-center">
                No active usage records on Fal.ai for the current key.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="ui-metric-cell ui-tint-neutral p-4">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                    Total Estimated Spend
                  </p>
                  <span className="text-lg font-black text-app-text">
                    {formatCost(totalCost)}
                  </span>
                </div>

                <div className="space-y-3 pt-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border/20 pb-1">
                    Endpoint Cost Breakdown
                  </p>
                  <div className="space-y-2">
                    {usageByModel.map((model) => (
                      <div key={model.endpoint_id} className="text-xs leading-5">
                        <div className="flex justify-between font-bold text-app-text">
                          <span className="truncate max-w-[180px] font-mono text-[10px]" title={model.endpoint_id}>
                            {model.endpoint_id.split("/").slice(1).join("/") || model.endpoint_id}
                          </span>
                          <span className="font-black text-app-accent">
                            {formatCost(model.cost)}
                          </span>
                        </div>
                        <div className="flex justify-between text-[9px] text-app-text-muted uppercase font-bold tracking-tight leading-none mt-0.5">
                          <span>
                            {model.quantity} {model.unit}s
                          </span>
                          <span>approx cost</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Quick Info & Help */}
          <section className="ui-card p-6 bg-app-accent/5 border-app-accent/20 space-y-4">
            <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-app-accent" />
              <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
                Visual Sidecar Stack
              </h3>
            </div>
            <p className="text-[11px] text-app-text-muted leading-relaxed font-bold uppercase opacity-85">
              Riverside OS downloads all generated assets from Fal.ai into a local cache directory. Offline-first endpoints serve these local files directly to staff and customers.
            </p>
            <div className="pt-2 border-t border-app-border/40 text-[10px] space-y-2 font-semibold">
              <a
                href="https://fal.ai/docs"
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between text-app-accent hover:underline group"
              >
                <span>Browse official Fal.ai Docs</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </a>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
