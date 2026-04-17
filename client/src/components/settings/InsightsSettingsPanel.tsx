import React, { useCallback, useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type InsightsConfig = {
  data_access_mode: string;
  staff_note_markdown: string;
  metabase_jwt_sso_enabled: boolean;
  jwt_email_domain: string;
  metabase_collections_note: string;
};

type InsightsSettingsResponse = {
  config: InsightsConfig;
  jwt_secret_configured: boolean;
};

const InsightsSettingsPanel: React.FC = () => {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [jwtSecretConfigured, setJwtSecretConfigured] = useState(false);
  const [cfg, setCfg] = useState<InsightsConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/insights`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        toast("Could not load Insights settings", "error");
        return;
      }
      const data = (await res.json()) as InsightsSettingsResponse;
      setCfg(data.config);
      setJwtSecretConfigured(data.jwt_secret_configured);
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
      const res = await fetch(`${baseUrl}/api/settings/insights`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          data_access_mode: cfg.data_access_mode,
          staff_note_markdown: cfg.staff_note_markdown,
          metabase_jwt_sso_enabled: cfg.metabase_jwt_sso_enabled,
          jwt_email_domain: cfg.jwt_email_domain,
          metabase_collections_note: cfg.metabase_collections_note,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(
          typeof err.error === "string" ? err.error : "Save failed",
          "error",
        );
        return;
      }
      const data = (await res.json()) as InsightsSettingsResponse;
      setCfg(data.config);
      setJwtSecretConfigured(data.jwt_secret_configured);
      toast("Insights settings saved", "success");
    } catch {
      toast("Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (!hasPermission("settings.admin")) {
    return null;
  }

  if (loading || !cfg) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-10">
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Data Insights</h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">Configure enterprise reporting, role-based database access, and secure auth handoff.</p>
      </header>

      <section className="ui-card p-8 max-w-4xl border-violet-500/20 bg-gradient-to-br from-violet-500/5 to-transparent shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600/10 text-violet-600 shadow-inner">
              <BarChart3 className="h-7 w-7" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Metabase Insights Layer</h3>
              <p className="text-xs text-app-text-muted mt-1 max-w-xl leading-relaxed">
                Phase 2 reporting uses the <code className="font-mono text-[10px] bg-white/40 dark:bg-black/20 px-1 rounded">reporting</code> schema. 
                Configure how the insights engine connects to the operational database.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 border-violet-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload Config
          </button>
        </div>

        <div className="space-y-8">
          <div className="grid gap-6 md:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">Data Access Restriction Mode</span>
              <select
                className="ui-input w-full px-4 py-3 text-sm font-bold bg-app-bg"
                value={cfg.data_access_mode}
                onChange={(e) =>
                  setCfg((c) => (c ? { ...c, data_access_mode: e.target.value } : c))
                }
              >
                <option value="reporting_views_only">Restricted (Reporting Schema Only)</option>
                <option value="full_database_delegate">Unrestricted (Delegated Privilege)</option>
              </select>
            </label>

            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">Synthetic JWT Email Domain</span>
              <input
                type="text"
                className="ui-input w-full px-4 py-3 text-sm font-mono bg-app-bg"
                value={cfg.jwt_email_domain}
                onChange={(e) =>
                  setCfg((c) => (c ? { ...c, jwt_email_domain: e.target.value } : c))
                }
                placeholder="e.g. store.riverside.io"
              />
            </label>
          </div>

          <label className="flex items-start gap-4 rounded-2xl border border-app-border bg-app-surface-2/60 p-5 cursor-pointer hover:border-violet-500/50 transition-all">
            <div className={`mt-1 h-5 w-5 rounded border-2 flex items-center justify-center transition-all ${cfg.metabase_jwt_sso_enabled ? 'bg-violet-600 border-violet-600 text-white' : 'border-app-border'}`}>
               {cfg.metabase_jwt_sso_enabled && <BarChart3 className="h-3 w-3" />}
            </div>
            <input
              type="checkbox"
              className="sr-only"
              checked={cfg.metabase_jwt_sso_enabled}
              onChange={(e) =>
                setCfg((c) =>
                  c ? { ...c, metabase_jwt_sso_enabled: e.target.checked } : c,
                )
              }
            />
            <div className="flex-1">
              <span className="text-sm font-black uppercase tracking-widest text-app-text">Enable Automated Insights SSO</span>
              <p className="text-[10px] text-app-text-muted mt-1 leading-relaxed font-medium">
                Auth requests use a short-lived token for seamless handoff. Secret configured: {" "}
                {jwtSecretConfigured ? (
                  <span className="text-emerald-600 font-black">ACTIVE</span>
                ) : (
                  <span className="text-rose-600 font-black">MISSING ON HOST</span>
                )}
              </p>
            </div>
          </label>

          <div className="grid gap-6">
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">Staff Access Documentation (Markdown)</span>
              <textarea
                className="ui-input w-full min-h-[100px] p-4 text-xs font-mono leading-relaxed bg-app-bg/50"
                value={cfg.staff_note_markdown}
                onChange={(e) =>
                  setCfg((c) => (c ? { ...c, staff_note_markdown: e.target.value } : c))
                }
                placeholder="Suggest staff classes, collection paths, or how to request new reports."
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">Operational Provisioning Notes</span>
              <textarea
                className="ui-input w-full min-h-[80px] p-4 text-xs font-mono leading-relaxed bg-app-bg/50"
                value={cfg.metabase_collections_note}
                onChange={(e) =>
                  setCfg((c) =>
                    c ? { ...c, metabase_collections_note: e.target.value } : c,
                  )
                }
                placeholder="Internal notes on collections, groups, or Metabase provisioning. Invisible to store staff."
              />
            </label>
          </div>

          <div className="pt-8 border-t border-app-border/40">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="ui-btn-primary h-12 px-10 text-[11px] font-black uppercase tracking-[0.2em] shadow-lg shadow-violet-500/20"
            >
              {saving ? "Persisting..." : "Save Insights Policy"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default InsightsSettingsPanel;
