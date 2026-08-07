import React, { useCallback, useEffect, useState } from "react";
import { Archive, Database, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

type InsightsConfig = {
  data_access_mode: "reporting_views_only";
  staff_note_markdown: string;
  cube_max_rows: number;
  history_archive_days: number;
};

type InsightsSettingsResponse = {
  config: InsightsConfig;
  cube_secret_configured: boolean;
  cube_upstream: string;
};

const InsightsSettingsPanel: React.FC = () => {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<InsightsConfig | null>(null);
  const [cubeSecretConfigured, setCubeSecretConfigured] = useState(false);
  const [cubeUpstream, setCubeUpstream] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${baseUrl}/api/settings/insights`, {
        headers: backofficeHeaders(),
      });
      if (!response.ok) {
        toast("Could not load Insights settings", "error");
        return;
      }
      const data = (await response.json()) as InsightsSettingsResponse;
      setCfg(data.config);
      setCubeSecretConfigured(data.cube_secret_configured);
      setCubeUpstream(data.cube_upstream);
    } catch {
      toast("Could not load Insights settings", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const response = await fetch(`${baseUrl}/api/settings/insights`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(cfg),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "Save failed";
        toast(message, "error");
        return;
      }
      const data = payload as InsightsSettingsResponse;
      setCfg(data.config);
      setCubeSecretConfigured(data.cube_secret_configured);
      setCubeUpstream(data.cube_upstream);
      toast("Native Insights policy saved", "success");
    } catch {
      toast("Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (!hasPermission("settings.admin")) return null;

  if (loading || !cfg) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  return (
    <div className="animate-in space-y-8 fade-in slide-in-from-bottom-4 duration-500">
      <header>
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-violet-600">
          <Sparkles className="h-4 w-4" /> ROSIE + Cube Core
        </div>
        <h2 className="text-3xl font-black uppercase italic tracking-tighter text-app-text">
          Native Data Insights
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
          Configure the governed semantic reporting layer, automatic report history, and output limits.
          Staff use their existing Riverside access—there is no separate reporting login.
        </p>
      </header>

      <section className="ui-card max-w-4xl border-violet-500/20 bg-gradient-to-br from-violet-500/5 to-transparent p-6 shadow-xl sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-app-border/50 pb-6">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-violet-500/10 p-3 text-violet-600 ring-1 ring-violet-500/20">
              <Database className="h-7 w-7" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Governed reporting engine
              </h3>
              <p className="mt-1 max-w-xl text-xs font-medium leading-relaxed text-app-text-muted">
                Cube can query only approved <code className="font-mono">reporting.*</code> models.
                Gemma produces a validated ReportSpec and never SQL.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reload
          </button>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Database access
              </p>
            </div>
            <p className="mt-3 text-sm font-black text-app-text">Reporting views only</p>
            <p className="mt-1 text-[10px] font-medium leading-relaxed text-app-text-muted">
              Full-database delegation is retired and cannot be enabled from Riverside.
            </p>
          </div>
          <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-violet-600" />
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Cube Core connection
              </p>
            </div>
            <p className={`mt-3 text-sm font-black ${cubeSecretConfigured ? "text-emerald-600" : "text-amber-600"}`}>
              {cubeSecretConfigured ? "Server secret configured" : "Server secret needs setup"}
            </p>
            <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">{cubeUpstream}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <label className="block">
            <span className="ml-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Maximum rows per report
            </span>
            <input
              type="number"
              min={25}
              max={500}
              value={cfg.cube_max_rows}
              onChange={(event) =>
                setCfg((current) =>
                  current
                    ? { ...current, cube_max_rows: Number(event.target.value) }
                    : current,
                )
              }
              className="ui-input mt-2 w-full px-4 py-3 text-sm font-bold"
            />
            <p className="mt-2 text-[10px] font-medium text-app-text-muted">
              Applies to interactive results, CSV export, and print output. Hard maximum: 500.
            </p>
          </label>

          <label className="block">
            <span className="ml-1 inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <Archive className="h-3.5 w-3.5" /> Archive after unused days
            </span>
            <input
              type="number"
              min={30}
              max={730}
              value={cfg.history_archive_days}
              onChange={(event) =>
                setCfg((current) =>
                  current
                    ? { ...current, history_archive_days: Number(event.target.value) }
                    : current,
                )
              }
              className="ui-input mt-2 w-full px-4 py-3 text-sm font-bold"
            />
            <p className="mt-2 text-[10px] font-medium text-app-text-muted">
              Default is 180 days. Favorites stay pinned; archived history can be restored or rerun.
            </p>
          </label>
        </div>

        <label className="mt-6 block">
          <span className="ml-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Staff reporting guidance
          </span>
          <textarea
            value={cfg.staff_note_markdown}
            onChange={(event) =>
              setCfg((current) =>
                current ? { ...current, staff_note_markdown: event.target.value } : current,
              )
            }
            className="ui-input mt-2 min-h-28 w-full p-4 text-xs font-medium leading-relaxed"
            placeholder="Optional guidance about booked vs recognized reporting, report ownership, or review expectations."
          />
        </label>

        <div className="mt-8 border-t border-app-border/50 pt-6">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="ui-btn-primary h-12 px-8 text-[11px] font-black uppercase tracking-[0.18em]"
          >
            {saving ? "Saving..." : "Save Insights policy"}
          </button>
        </div>
      </section>
    </div>
  );
};

export default InsightsSettingsPanel;
