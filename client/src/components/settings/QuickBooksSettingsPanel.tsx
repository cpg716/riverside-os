import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, RefreshCw, Save } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { useToast } from "../ui/ToastProviderLogic";

interface QuickBooksSettingsPanelProps {
  onOpenQbo: () => void;
}

interface QboCredentialsPublic {
  realm_id: string | null;
  company_id: string;
  client_id_masked: string | null;
  client_id_set: boolean;
  has_client_secret: boolean;
  has_refresh_token: boolean;
  use_sandbox: boolean;
  token_expires_at: string | null;
  is_active: boolean;
}

const baseUrl = getBaseUrl();

export default function QuickBooksSettingsPanel({
  onOpenQbo,
}: QuickBooksSettingsPanelProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [credentials, setCredentials] = useState<QboCredentialsPublic | null>(
    null,
  );
  const [realmId, setRealmId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [useSandbox, setUseSandbox] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadCredentials = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/qbo/credentials`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        setCredentials(null);
        return;
      }
      const next = (await res.json()) as QboCredentialsPublic;
      setCredentials(next);
      setRealmId(next.realm_id ?? "");
      setUseSandbox(next.use_sandbox);
    } catch {
      setCredentials(null);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

  const saveCredentials = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/credentials`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          realm_id: realmId.trim() || null,
          client_id: clientId.trim() || null,
          client_secret: clientSecret.trim() || null,
          use_sandbox: useSandbox,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save QuickBooks connection", "error");
        return;
      }
      setClientId("");
      setClientSecret("");
      await loadCredentials();
      toast("QuickBooks connection saved", "success");
    } catch {
      toast("Communication error with QuickBooks settings", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!credentials) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  const connectionReady =
    credentials.client_id_set &&
    credentials.has_client_secret &&
    !!credentials.realm_id;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header>
        <div className="mb-4 flex items-center">
          <IntegrationBrandLogo
            brand="qbo"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-emerald-500/20 bg-white px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic uppercase tracking-tighter text-app-text">
          QuickBooks Online
        </h2>
        <p className="mt-2 text-sm font-medium text-app-text-muted">
          Enter Intuit developer credentials, authorize the QBO company, then
          use the bridge for mappings and journal staging.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveCredentials();
        }}
        className="ui-card max-w-5xl space-y-6 border-emerald-500/20 bg-app-surface p-6 shadow-xl"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-app-border pb-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 shadow-inner">
              <IntegrationBrandLogo
                brand="qbo"
                kind="icon"
                className="inline-flex"
                imageClassName="h-9 w-9 object-contain"
              />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Connection Credentials
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-app-text-muted">
                Client ID and Client Secret are saved server-side. Leave saved
                values blank when you only need to update Realm ID or sandbox
                mode.
              </p>
            </div>
          </div>
          <span
            className={`ui-pill text-[10px] font-black uppercase tracking-widest ${
              connectionReady
                ? "bg-app-success/10 text-app-success"
                : "bg-app-warning/10 text-app-warning"
            }`}
          >
            {connectionReady ? "Credentials ready" : "Credentials missing"}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Realm ID / company ID
            <input
              value={realmId}
              onChange={(e) => setRealmId(e.target.value)}
              className="ui-input mt-1 w-full font-mono text-sm"
              placeholder="QBO company Realm ID"
            />
          </label>
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Client ID
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="ui-input mt-1 w-full font-mono text-sm"
              placeholder={
                credentials.client_id_set
                  ? `Saved (${credentials.client_id_masked ?? "set"})`
                  : "Intuit OAuth Client ID"
              }
            />
          </label>
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Client Secret
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              className="ui-input mt-1 w-full font-mono text-sm"
              placeholder={
                credentials.has_client_secret
                  ? "Saved secret - enter only to replace"
                  : "Intuit OAuth Client Secret"
              }
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-app-text">
            <input
              type="checkbox"
              checked={useSandbox}
              onChange={(e) => setUseSandbox(e.target.checked)}
              className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
            />
            Sandbox environment
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy}
              className="ui-btn-primary min-h-11 gap-2 px-5 disabled:opacity-50"
            >
              {busy ? (
                <RefreshCw size={15} className="animate-spin" aria-hidden />
              ) : (
                <Save size={15} aria-hidden />
              )}
              Save connection
            </button>
            <button
              type="button"
              onClick={onOpenQbo}
              className="ui-btn-secondary min-h-11 gap-2 px-5"
            >
              Open QBO Bridge
              <ArrowUpRight size={15} aria-hidden />
            </button>
          </div>
        </div>

        <div className="grid gap-3 border-t border-app-border pt-5 text-xs text-app-text-muted md:grid-cols-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text">
              Client ID
            </p>
            <p className="mt-1">
              {credentials.client_id_set
                ? credentials.client_id_masked ?? "Saved"
                : "Not saved"}
            </p>
          </div>
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text">
              Client Secret
            </p>
            <p className="mt-1">
              {credentials.has_client_secret ? "Saved" : "Not saved"}
            </p>
          </div>
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text">
              Authorization
            </p>
            <p className="mt-1 flex items-center gap-1">
              {credentials.has_refresh_token ? (
                <CheckCircle2 size={13} className="text-app-success" />
              ) : null}
              {credentials.has_refresh_token ? "Authorized" : "Needs OAuth"}
            </p>
          </div>
        </div>
      </form>
    </div>
  );
}
