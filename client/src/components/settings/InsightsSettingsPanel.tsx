import React, { useCallback, useEffect, useState } from "react";
import { Archive, ArrowRight, CheckCircle2, Database, RefreshCw, Sparkles } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

type InsightsConfig = {
  data_access_mode: "reporting_views_only";
  staff_note_markdown: string;
  max_rows: number;
  history_archive_days: number;
};

type InsightsSettingsResponse = {
  config: InsightsConfig;
  engine_ready: boolean;
};

type InsightsSettingsPanelProps = {
  onOpenInsights?: () => void;
};

const InsightsSettingsPanel: React.FC<InsightsSettingsPanelProps> = ({ onOpenInsights }) => {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<InsightsConfig | null>(null);
  const [engineReady, setEngineReady] = useState(false);

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
      setEngineReady(data.engine_ready);
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
      setEngineReady(data.engine_ready);
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
          <Sparkles className="h-4 w-4" /> Riverside Insights
        </div>
        <h2 className="text-3xl font-black uppercase italic tracking-tighter text-app-text">
          Native Data Insights
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
          Choose sensible report limits, history retention, and guidance for staff. Riverside
          handles reporting access automatically—there is no separate account, password, or server secret.
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
                Reporting status
              </h3>
              <p className="mt-1 max-w-xl text-xs font-medium leading-relaxed text-app-text-muted">
                Gemma prepares a checked report plan, and Riverside reads only approved report data.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Check status
            </button>
            {onOpenInsights ? (
              <button
                type="button"
                onClick={onOpenInsights}
                className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                Open Insights <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        <div
          className={`mt-6 rounded-2xl border p-4 ${
            engineReady
              ? "border-emerald-500/25 bg-emerald-500/[0.06]"
              : "border-amber-500/30 bg-amber-500/[0.07]"
          }`}
        >
          <div className="flex items-start gap-3">
            {engineReady ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            ) : (
              <Database className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            )}
            <div>
              <p className={`text-sm font-black ${engineReady ? "text-emerald-700" : "text-amber-700"}`}>
                {engineReady ? "Reporting is ready" : "Main Hub update or repair required"}
              </p>
              <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                {engineReady
                  ? "Staff can open Insights now using their existing Riverside access."
                  : "One or more approved reporting views are missing. Use the normal Riverside Main Hub update or repair process; do not enter a password here."}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <label className="block">
            <span className="ml-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Maximum rows in each report
            </span>
            <input
              type="number"
              min={25}
              max={500}
              value={cfg.max_rows}
              onChange={(event) =>
                setCfg((current) =>
                  current
                    ? { ...current, max_rows: Number(event.target.value) }
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
            Instructions shown in Insights
          </span>
          <textarea
            value={cfg.staff_note_markdown}
            onChange={(event) =>
              setCfg((current) =>
                current ? { ...current, staff_note_markdown: event.target.value } : current,
              )
            }
            className="ui-input mt-2 min-h-28 w-full p-4 text-xs font-medium leading-relaxed"
            placeholder="Example: Use Booked Sales for new orders and Recognized Sales for fulfilled or picked-up merchandise."
          />
        </label>

        <div className="mt-8 border-t border-app-border/50 pt-6">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="ui-btn-primary h-12 px-8 text-[11px] font-black uppercase tracking-[0.18em]"
          >
            {saving ? "Saving..." : "Save Insights settings"}
          </button>
        </div>
      </section>
    </div>
  );
};

export default InsightsSettingsPanel;
