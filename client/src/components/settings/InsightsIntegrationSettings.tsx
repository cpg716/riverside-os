import { useCallback, useEffect, useState } from "react";
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

export default function InsightsIntegrationSettings() {
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

  return (
    <section className="ui-card p-8 max-w-3xl border-violet-500/20 bg-gradient-to-br from-violet-500/5 to-transparent">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-600 dark:text-violet-400">
            <BarChart3 className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Insights (Metabase)
            </h3>
            <p className="text-xs text-app-text-muted mt-1 max-w-xl leading-relaxed">
              Phase 2 reporting uses the <code className="font-mono text-[10px]">reporting</code>{" "}
              schema and role <code className="font-mono text-[10px]">metabase_ro</code>.
              <span className="block mt-1">
                <strong className="text-app-text">Margin and private cuts:</strong> Riverside{" "}
                <code className="font-mono text-[10px]">insights.view</code> only opens Insights;
                use separate <strong>Metabase</strong> logins (staff-class vs admin-class) and
                Metabase groups/collections per <code className="font-mono text-[10px]">docs/METABASE_REPORTING.md</code>.
              </span>
              Optional JWT handoff matches{" "}
              <code className="font-mono text-[10px]">RIVERSIDE_METABASE_JWT_SECRET</code> to
              Metabase Authentication → JWT (typically a paid Metabase plan).
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      {loading || !cfg ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Data access policy
            </span>
            <select
              className="ui-input mt-1 w-full max-w-md"
              value={cfg.data_access_mode}
              onChange={(e) =>
                setCfg((c) => (c ? { ...c, data_access_mode: e.target.value } : c))
              }
            >
              <option value="reporting_views_only">
                Reporting views only (metabase_ro → schema reporting)
              </option>
              <option value="full_database_delegate">
                Full database (ops-managed privileged Metabase user — documented risk)
              </option>
            </select>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-2/80 px-4 py-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-app-border"
              checked={cfg.metabase_jwt_sso_enabled}
              onChange={(e) =>
                setCfg((c) =>
                  c ? { ...c, metabase_jwt_sso_enabled: e.target.checked } : c,
                )
              }
            />
            <span className="text-xs text-app-text leading-relaxed">
              <span className="font-bold">ROS → Metabase JWT handoff</span> — After sign-in to
              Riverside, Insights requests a short-lived JWT for Metabase{" "}
              <code className="font-mono text-[10px]">/auth/sso</code>. Requires Metabase JWT auth
              and server env secret (≥16 chars).{" "}
              <span className="text-app-text-muted">
                Secret on server:{" "}
                {jwtSecretConfigured ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                    configured
                  </span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300 font-semibold">
                    not set
                  </span>
                )}
                .
              </span>
            </span>
          </label>

          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Synthetic email domain (no staff.email)
            </span>
            <input
              type="text"
              className="ui-input mt-1 w-full max-w-md font-mono text-xs"
              value={cfg.jwt_email_domain}
              onChange={(e) =>
                setCfg((c) => (c ? { ...c, jwt_email_domain: e.target.value } : c))
              }
              placeholder="store.example.com"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Staff note (Markdown, optional)
            </span>
            <textarea
              className="ui-input mt-1 min-h-[88px] w-full font-mono text-xs"
              value={cfg.staff_note_markdown}
              onChange={(e) =>
                setCfg((c) => (c ? { ...c, staff_note_markdown: e.target.value } : c))
              }
              placeholder="e.g. Staff use Metabase login X (no margin folders); admins use login Y. How to request access…"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Collections / Metabase groups (ops note)
            </span>
            <textarea
              className="ui-input mt-1 min-h-[72px] w-full font-mono text-xs"
              value={cfg.metabase_collections_note}
              onChange={(e) =>
                setCfg((c) =>
                  c ? { ...c, metabase_collections_note: e.target.value } : c,
                )
              }
              placeholder="e.g. Group Reporting–Staff: View on Staff/Approved only. Group Reporting–Admin: margin collection + SQL. Map JWT groups if using SSO…"
            />
          </label>

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="ui-btn-primary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest"
            >
              {saving ? "Saving…" : "Save Insights settings"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
