import { useCallback, useEffect, useState, useRef } from "react";
import {
  RefreshCw,
  Save,
  Link,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  ListFilter,
  History,
  Tag,
  ArrowUpRight,
} from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { useToast } from "../ui/ToastProviderLogic";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import { openExternalUrl } from "../../lib/desktopFileBridge";

interface ConstantContactList {
  list_id: string;
  name: string;
  description?: string;
}

interface CcSyncLogRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  sync_type: string;
  status: string;
  created_count: number;
  updated_count: number;
  deleted_count: number;
  error_summary: string | null;
}

interface CcConfigPublic {
  client_id_masked: string | null;
  client_id_set: boolean;
  has_client_secret: boolean;
  has_access_token: boolean;
  has_refresh_token: boolean;
  target_list_id: string | null;
  list_mappings: Record<string, string> | null;
  last_logs: CcSyncLogRow[];
}

const baseUrl = getBaseUrl();

export default function ConstantContactSettingsPanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [config, setConfig] = useState<CcConfigPublic | null>(null);
  const [lists, setLists] = useState<ConstantContactList[]>([]);
  const [targetListId, setTargetListId] = useState("");
  const [listMappings, setListMappings] = useState<Record<string, string>>({});

  // Tag segment management (add new tag to list mapping mapping)
  const [newTag, setNewTag] = useState("");
  const [newTagListId, setNewTagListId] = useState("");

  const [loadingConfig, setLoadingConfig] = useState(true);
  const [loadingLists, setLoadingLists] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  const pollingRef = useRef<number | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/constant-contact/config`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const data = (await res.json()) as CcConfigPublic;
        setConfig(data);
        setTargetListId(data.target_list_id ?? "");
        setListMappings(data.list_mappings ?? {});
      }
    } catch (err) {
      console.error("Failed to load Constant Contact config", err);
    } finally {
      setLoadingConfig(false);
    }
  }, [backofficeHeaders]);

  const fetchListsData = useCallback(async () => {
    setLoadingLists(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/constant-contact/lists`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const data = (await res.json()) as ConstantContactList[];
        setLists(data);
      }
    } catch (err) {
      console.error("Failed to fetch lists", err);
    } finally {
      setLoadingLists(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (config?.has_access_token) {
      void fetchListsData();
    }
  }, [config?.has_access_token, fetchListsData]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
      }
    };
  }, []);

  const startPolling = () => {
    if (pollingRef.current) return;
    pollingRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(`${baseUrl}/api/settings/constant-contact/config`, {
          headers: backofficeHeaders() as Record<string, string>,
        });
        if (res.ok) {
          const data = (await res.json()) as CcConfigPublic;
          if (data.has_access_token) {
            setConfig(data);
            setTargetListId(data.target_list_id ?? "");
            setListMappings(data.list_mappings ?? {});
            toast("Constant Contact successfully authorized!", "success");
            void fetchListsData();
            if (pollingRef.current) {
              window.clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
          }
        }
      } catch (err) {
        console.error("Error polling authorization status", err);
      }
    }, 2500);

    // Stop polling after 2 minutes to prevent infinite loops
    setTimeout(() => {
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
        toast("Authorization polling timed out. Please try again.", "error");
      }
    }, 120000);
  };

  const handleConnect = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/constant-contact/oauth/authorize-url`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const data = (await res.json()) as { url: string };
        await openExternalUrl(data.url, "_blank", "width=600,height=700,status=no,resizable=yes");
        startPolling();
      } else {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        toast(errJson.error ?? "Could not build authorization URL", "error");
      }
    } catch {
      toast("Communication error setting up OAuth flow", "error");
    }
  };

  const handleSaveSettings = async () => {
    setSaveBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/constant-contact/credentials`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          target_list_id: targetListId || null,
          list_mappings: JSON.stringify(listMappings),
        }),
      });
      if (res.ok) {
        toast("Constant Contact configuration saved", "success");
        await fetchConfig();
      } else {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        toast(errJson.error ?? "Failed to save settings", "error");
      }
    } catch {
      toast("Communication error saving settings", "error");
    } finally {
      setSaveBusy(false);
    }
  };

  const handleTriggerSync = async () => {
    if (syncBusy) return;
    setSyncBusy(true);
    toast("Outbound contact synchronization started...", "info");
    try {
      const res = await fetch(`${baseUrl}/api/settings/constant-contact/sync/contacts`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const data = (await res.json()) as { created_count: number; errors: string[] };
        toast(
          `Sync completed! Pushed ${data.created_count} contact updates.`,
          data.errors.length > 0 ? "error" : "success"
        );
        await fetchConfig();
      } else {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        toast(errJson.error ?? "Contacts synchronization failed", "error");
      }
    } catch {
      toast("Error communicating with sync service", "error");
    } finally {
      setSyncBusy(false);
    }
  };

  const handleAddMapping = () => {
    if (!newTag.trim() || !newTagListId) return;
    setListMappings((current) => ({
      ...current,
      [newTag.trim()]: newTagListId,
    }));
    setNewTag("");
    setNewTagListId("");
  };

  const handleRemoveMapping = (tag: string) => {
    setListMappings((current) => {
      const copy = { ...current };
      delete copy[tag];
      return copy;
    });
  };

  if (!hasPermission("constant_contact.manage")) {
    return (
      <div className="ui-card p-8 text-center">
        <p className="text-sm font-medium text-app-text-muted">
          Staff permissions require `constant_contact.manage` to view this integrations panel.
        </p>
      </div>
    );
  }

  if (loadingConfig) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  const isAuthorized = !!config?.has_access_token;
  const isReady = isAuthorized && !!targetListId;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header>
        <div className="mb-4 flex items-center">
          <IntegrationBrandLogo
            brand="constant_contact"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-blue-500/20 bg-app-surface px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic uppercase tracking-tighter text-app-text">
          Constant Contact
        </h2>
        <p className="mt-2 text-sm font-medium text-app-text-muted">
          Synchronize marketing-opted-in customers to targeted mailing lists, map segments/tags (like VIP), and record delivery events back to the customer timeline.
        </p>
      </header>

      {/* 1. secure credential cards */}
      <IntegrationCredentialsCard
        baseUrl={baseUrl}
        integrationKey="constant_contact"
        title="Constant Contact Developer API Keys"
        description="Client ID and Client Secret are encrypted on the server. Request these keys from your Constant Contact developer portal."
        fields={[
          {
            key: "client_id",
            label: "OAuth client ID",
            placeholder: config?.client_id_set
              ? `Saved (${config.client_id_masked ?? "set"})`
              : "Enter Constant Contact Client ID",
            type: "text",
            help: "Used for OAuth authorization code redirect flows.",
          },
          {
            key: "client_secret",
            label: "OAuth client secret",
            placeholder: config?.has_client_secret
              ? "Saved - enter only to replace"
              : "Enter Constant Contact Client Secret",
            type: "password",
            help: "Stored encrypted and never displayed in UI.",
          },
        ]}
        onSaved={fetchConfig}
      />

      {/* 2. OAuth authentication status */}
      <section className="ui-card p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-app-border pb-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 shadow-inner">
              <Link className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                OAuth Authorization Connection
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-app-text-muted">
                Authorize the connection to your Constant Contact account to fetch lists and sync members.
              </p>
            </div>
          </div>
          <span
            className={`ui-pill text-[10px] font-black uppercase tracking-widest ${
              isAuthorized
                ? "bg-emerald-500/10 text-app-success"
                : "bg-app-warning/10 text-app-warning"
            }`}
          >
            {isAuthorized ? "Connected" : "Not Authorized"}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-4 text-xs text-app-text-muted max-w-xl leading-relaxed">
            {isAuthorized ? (
              <p className="flex items-center gap-2 text-app-success font-semibold">
                <CheckCircle2 size={14} />
                Access tokens are valid. Background processes are ready to synchronize contacts.
              </p>
            ) : (
              <p className="flex items-center gap-2">
                <AlertCircle size={14} className="text-app-warning shrink-0" />
                <span>Save Client credentials above first, then click "Authorize Account" to establish authentication.</span>
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={!config?.client_id_set || !config?.has_client_secret}
            onClick={handleConnect}
            className="ui-btn-primary min-h-11 gap-2 px-6 font-black tracking-widest text-[10px] uppercase disabled:opacity-50"
          >
            Authorize Account
            <ArrowUpRight size={14} />
          </button>
        </div>
      </section>

      {/* 3. List maps settings */}
      {isAuthorized && (
        <section className="ui-card p-6 space-y-6">
          <div className="flex items-center gap-4 border-b border-app-border pb-5">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 shadow-inner">
              <ListFilter className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Mailing List & Segment Mapping
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-app-text-muted">
                Map default newsletter targets and connect specific customer tags/groups to dedicated Constant Contact lists.
              </p>
            </div>
          </div>

          <div className="space-y-6">
            <label className="block max-w-xl">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 block">
                Default Contact List (all opted-in customers)
              </span>
              <select
                value={targetListId}
                onChange={(e) => setTargetListId(e.target.value)}
                className="ui-input w-full font-semibold text-sm h-11"
                disabled={loadingLists}
              >
                <option value="">Select target list...</option>
                {lists.map((l) => (
                  <option key={l.list_id} value={l.list_id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>

            {/* List Mappings (VIP and customer groups) */}
            <div className="space-y-4 border-t border-app-border pt-5">
              <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
                Conditional Mappings (VIP & Customer Groups)
              </h4>
              <p className="text-[11px] text-app-text-muted leading-relaxed font-semibold uppercase">
                Customers mapped to matching tags/groups will be added to these lists in addition to the default list.
              </p>

              {Object.keys(listMappings).length > 0 ? (
                <div className="divide-y divide-app-border border border-app-border rounded-xl bg-app-surface-2/30 max-w-2xl overflow-hidden">
                  {Object.entries(listMappings).map(([tag, listId]) => {
                    const listObj = lists.find((l) => l.list_id === listId);
                    return (
                      <div key={tag} className="flex items-center justify-between p-3.5 text-xs">
                        <div className="flex items-center gap-2">
                          <Tag size={13} className="text-blue-500" />
                          <span className="font-bold text-app-text uppercase tracking-tight">{tag}</span>
                          <span className="text-app-text-muted">maps to</span>
                          <span className="font-semibold text-app-accent">{listObj?.name ?? listId}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveMapping(tag)}
                          className="text-[10px] font-black uppercase text-app-warning hover:text-red-500"
                        >
                          Delete
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs italic text-app-text-muted font-medium">No conditional list mappings defined yet.</p>
              )}

              {/* Add mappings builder */}
              <div className="flex flex-wrap items-end gap-3 max-w-2xl bg-app-surface-2 p-4 rounded-xl border border-app-border">
                <label className="flex-1 min-w-[150px]">
                  <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted block mb-1">
                    Tag / Group Code
                  </span>
                  <input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    placeholder="e.g. VIP, Bridal, Staff"
                    className="ui-input w-full text-xs font-semibold h-9"
                  />
                </label>

                <label className="flex-1 min-w-[200px]">
                  <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted block mb-1">
                    Target CC Mailing List
                  </span>
                  <select
                    value={newTagListId}
                    onChange={(e) => setNewTagListId(e.target.value)}
                    className="ui-input w-full text-xs font-semibold h-9"
                  >
                    <option value="">Select list...</option>
                    {lists.map((l) => (
                      <option key={l.list_id} value={l.list_id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  disabled={!newTag.trim() || !newTagListId}
                  onClick={handleAddMapping}
                  className="h-9 px-4 rounded-xl bg-app-text text-white text-[10px] font-black uppercase tracking-widest hover:bg-black/80 disabled:opacity-40"
                >
                  Add Map
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-app-border pt-4">
              <button
                type="button"
                disabled={saveBusy}
                onClick={handleSaveSettings}
                className="ui-btn-primary min-h-11 px-6 font-black tracking-widest text-[10px] uppercase gap-2"
              >
                <Save size={14} />
                Save Mapping settings
              </button>
            </div>
          </div>
        </section>
      )}

      {/* 4. manual sync button and controls */}
      {isReady && (
        <section className="ui-card p-6 space-y-6 border-l-4 border-blue-500">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Outbound Contact Sync Execution
              </h3>
              <p className="mt-1 text-xs text-app-text-muted">
                Trigger an on-demand synchronization push of all opted-in customer profiles to Constant Contact.
              </p>
            </div>
            <button
              type="button"
              disabled={syncBusy}
              onClick={handleTriggerSync}
              className="ui-btn-primary min-h-11 px-6 font-black tracking-widest text-[10px] uppercase gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-md shadow-blue-500/20"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncBusy ? "animate-spin" : ""}`} />
              {syncBusy ? "Synchronizing..." : "Sync Marketing Contacts Now"}
            </button>
          </div>
        </section>
      )}

      {/* 5. sync history logs */}
      {isAuthorized && (
        <section className="ui-card overflow-hidden">
          <div className="p-6 border-b border-app-border bg-app-surface/30 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <History className="w-5 h-5 text-app-accent" />
              <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
                Sync Logs & History
              </h3>
            </div>
            <span className="text-[10px] font-black text-app-text-muted uppercase">
              {config?.last_logs.length ?? 0} runs registered
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-app-bg/50 text-[9px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                  <th className="px-6 py-3">Started At</th>
                  <th className="px-6 py-3">Type</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3 text-center">Pushed Contacts</th>
                  <th className="px-6 py-3">Error / Success details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border text-xs">
                {config?.last_logs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-app-text-muted font-medium italic">
                      No synchronization events registered yet.
                    </td>
                  </tr>
                ) : (
                  config?.last_logs.map((log) => (
                    <tr key={log.id} className="hover:bg-app-surface/10 transition-all">
                      <td className="px-6 py-4 font-mono text-[10px] text-app-text font-semibold">
                        {new Date(log.started_at).toLocaleString()}
                      </td>
                      <td className="px-6 py-4">
                        <span className="ui-pill text-[8.5px] bg-blue-500/10 text-blue-600 uppercase font-black tracking-tight">
                          {log.sync_type.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`ui-pill text-[8.5px] font-black tracking-tight uppercase ${
                            log.status === "success"
                              ? "bg-emerald-500/10 text-emerald-600"
                              : log.status === "running"
                                ? "bg-amber-500/10 text-amber-600 animate-pulse"
                                : "bg-red-500/10 text-red-600"
                          }`}
                        >
                          {log.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center font-bold text-app-text">
                        {log.created_count}
                      </td>
                      <td className="px-6 py-4 max-w-sm truncate text-[11px] font-medium text-app-text-muted">
                        {log.status === "success" ? (
                          <span className="text-emerald-500 flex items-center gap-1">
                            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                            Synchronized successfully
                          </span>
                        ) : log.error_summary ? (
                          <span className="text-red-500 flex items-center gap-1" title={log.error_summary}>
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            {log.error_summary}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
