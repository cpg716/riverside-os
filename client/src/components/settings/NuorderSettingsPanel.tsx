import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Package,
  ArrowRightLeft,
  Zap,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";

interface NuorderSyncLog {
  id: string;
  sync_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  created_count: number;
  updated_count: number;
  error_message: string | null;
}

export default function NuorderSettingsPanel() {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const baseUrl = getBaseUrl();

  const [loading, setLoading] = useState(false);
  const [syncBusy, setSyncBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<NuorderSyncLog[]>([]);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/nuorder/config`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.recent_logs || []);
      }
    } catch (e) {
      console.error("Nuorder config error:", e);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const triggerSync = async (type: "catalog" | "orders" | "inventory") => {
    setSyncBusy(type);
    try {
      const res = await fetch(`${baseUrl}/api/settings/nuorder/sync/${type}`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const result = await res.json();
        toast(`NuORDER ${type} sync completed: ${result.message}`, "success");
        void fetchConfig();
      } else {
        toast(`NuORDER ${type} sync failed.`, "error");
      }
    } finally {
      setSyncBusy(null);
    }
  };

  const statusColor = (s: string) => {
    if (s === "success") return "text-emerald-500";
    if (s === "failure") return "text-red-500";
    return "text-amber-500";
  };

  return (
    <div className="ui-card p-8 border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-transparent">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-app-surface ring-1 ring-black/5">
            <IntegrationBrandLogo
              brand="nuorder"
              kind="icon"
              className="inline-flex"
              imageClassName="h-8 w-8 object-contain"
            />
          </div>
          <div>
            <div className="mb-2 flex items-center">
              <IntegrationBrandLogo
                brand="nuorder"
                kind="wordmark"
                className="inline-flex rounded-2xl border border-app-border bg-app-surface px-4 py-2 shadow-sm"
                imageClassName="h-8 w-auto object-contain"
              />
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Vendor Portal Sync</h3>
            <p className="text-xs text-app-text-muted mt-1 leading-relaxed max-w-2xl">
              Connect to your NuORDER brand portal to sync styles, download media, import approved orders as pending Purchase Orders, and broadcast inventory ATS levels.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void fetchConfig()}
          className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* API CONFIG */}
        <div className="space-y-6">
          <IntegrationCredentialsCard
            baseUrl={baseUrl}
            integrationKey="nuorder"
            title="NuORDER Credentials"
            description="Save OAuth credentials for the NuORDER brand portal here. Values are encrypted and hidden after save."
            fields={[
              {
                key: "consumer_key",
                label: "Consumer key",
                type: "text",
              },
              {
                key: "consumer_secret",
                label: "Consumer secret",
              },
              {
                key: "user_token",
                label: "User token",
              },
              {
                key: "user_secret",
                label: "User secret",
              },
            ]}
            onSaved={fetchConfig}
          />

          <div className="rounded-xl border border-app-border bg-app-surface/40 p-5 space-y-4">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <Zap className="h-4 w-4" />
              <span className="text-[10px] font-black uppercase tracking-widest">Manual Operations</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(["catalog", "orders", "inventory"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  disabled={!!syncBusy}
                  onClick={() => triggerSync(type)}
                  className="ui-btn-secondary p-4 flex flex-col items-center gap-2 transition-all hover:border-indigo-500/50"
                >
                  {type === "catalog" && <Package className="h-5 w-5" />}
                  {type === "orders" && (
                    <IntegrationBrandLogo
                      brand="nuorder"
                      kind="icon"
                      className="inline-flex"
                      imageClassName="h-5 w-5 object-contain"
                    />
                  )}
                  {type === "inventory" && <ArrowRightLeft className="h-5 w-5" />}
                  <span className="text-[9px] font-black uppercase tracking-widest">
                    {syncBusy === type ? "Syncing..." : `Sync ${type}`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* RECENT LOGS */}
        <div className="rounded-xl border border-app-border bg-app-surface/40 p-5 shadow-sm min-w-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-app-text-muted">
              <IntegrationBrandLogo
                brand="nuorder"
                kind="icon"
                className="inline-flex"
                imageClassName="h-4 w-4 object-contain"
              />
              <span className="text-[10px] font-black uppercase tracking-widest">Recent Activity</span>
            </div>
          </div>
          <div className="space-y-3 max-h-[480px] overflow-y-auto pr-2 custom-scrollbar">
            {logs.length === 0 ? (
              <div className="text-center py-12 text-app-text-muted italic text-xs border-2 border-dashed border-app-border rounded-xl">
                No sync history yet.
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="rounded-lg border border-app-border bg-app-bg/30 p-3 text-xs">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-black uppercase tracking-tighter text-app-text">{log.sync_type}</span>
                    <span className={`font-black uppercase text-[9px] ${statusColor(log.status)}`}>{log.status}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-app-text-muted">
                    <span>{new Date(log.started_at).toLocaleString()}</span>
                    <span className="flex items-center gap-2">
                       {log.created_count > 0 && <span className="text-emerald-600 font-black">+{log.created_count} new</span>}
                       {log.updated_count > 0 && <span className="text-amber-600 font-black">{log.updated_count} upd</span>}
                       {log.created_count === 0 && log.updated_count === 0 && <span>0 items</span>}
                    </span>
                  </div>
                  {log.error_message && (
                    <div className="mt-2 p-2 rounded bg-red-500/5 border border-red-500/20 text-red-600 text-[10px] break-all leading-tight">
                      {log.error_message}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
