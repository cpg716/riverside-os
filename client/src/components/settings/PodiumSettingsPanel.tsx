import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  RefreshCw,
  Save,
  TriangleAlert,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { copyTextToClipboard } from "../../lib/clipboard";
import {
  getPodiumOAuthRedirectUri,
  isPodiumOAuthBrowserOriginReady,
  PODIUM_OAUTH_REDIRECT_STORAGE_KEY,
  PODIUM_OAUTH_STATE_STORAGE_KEY,
  PODIUM_PUBLIC_APP_ORIGIN,
} from "../../lib/podiumOAuth";
import ConfirmationModal from "../ui/ConfirmationModal";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { useToast } from "../ui/ToastProviderLogic";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import PodiumSmsSettingsCard from "./PodiumSmsSettingsCard";
import { useCustomerCommunicationSettings } from "./useCustomerCommunicationSettings";

type PodiumReadiness = {
  client_id_configured: boolean;
  client_secret_configured: boolean;
  api_base: string;
  api_version: string;
  credentials_configured: boolean;
  webhook_secret_configured: boolean;
  allow_unsigned_webhook: boolean;
  inbound_ingest_enabled: boolean;
  sms_send_enabled: boolean;
  location_uid_configured: boolean;
};

type PodiumHealth = {
  configured: boolean;
  reachable: boolean;
  latency_ms: number;
  message: string;
};

type PodiumLocation = {
  uid: string;
  name: string;
  display_name: string | null;
  archived: boolean;
};

type PodiumWebhook = {
  uid: string;
  location_uid: string | null;
  url: string;
  disabled: boolean;
  event_types: string[];
};

type PodiumProviderSetup = {
  locations: PodiumLocation[];
  configured_location_uid: string;
  webhook_url: string | null;
  required_event_types: string[];
  matching_webhook: PodiumWebhook | null;
  webhook_status: string;
  message: string;
};

type PodiumContactReconciliationRun = {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  contacts_seen: number;
  contacts_matched: number;
  customers_created: number;
  customers_updated: number;
  conflicts: number;
  outbound_queued: number;
  error: string | null;
};

type PodiumContactSyncOverview = {
  eligible_customers: number;
  mapped_customers: number;
  succeeded_customers: number;
  pending_customers: number;
  processing_customers: number;
  failed_customers: number;
  conflict_customers: number;
  suppressed_customers: number;
  unsynchronized_customers: number;
  open_issues: number;
  last_reconciliation: PodiumContactReconciliationRun | null;
};

type PodiumContactIssue = {
  id: string;
  provider_name: string | null;
  phone_e164: string | null;
  email: string | null;
  reason: string;
  candidate_customer_ids: string[];
};

type PodiumContactReconciliationStart = {
  started: boolean;
  run_id: string;
};

const PODIUM_OAUTH_SCOPE = [
  "read_locations",
  "read_messages",
  "write_messages",
  "read_reviews",
  "write_reviews",
  "read_users",
  "read_contacts",
  "write_contacts",
].join(" ");

export default function PodiumSettingsPanel({ baseUrl }: { baseUrl: string }) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const {
    settings,
    setSettings,
    loading,
    saving,
    load: loadCommunicationSettings,
    savePatch,
  } = useCustomerCommunicationSettings(baseUrl);
  const [readiness, setReadiness] = useState<PodiumReadiness | null>(null);
  const [providerSetup, setProviderSetup] =
    useState<PodiumProviderSetup | null>(null);
  const [providerError, setProviderError] = useState("");
  const [health, setHealth] = useState<PodiumHealth | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookConfirmOpen, setWebhookConfirmOpen] = useState(false);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactOverview, setContactOverview] =
    useState<PodiumContactSyncOverview | null>(null);
  const [contactIssues, setContactIssues] = useState<PodiumContactIssue[]>([]);
  const reconciliationRunning =
    contactOverview?.last_reconciliation?.status === "running";
  const redirectUri = getPodiumOAuthRedirectUri();
  const callbackReady = isPodiumOAuthBrowserOriginReady(redirectUri);
  const appCredentialsReady = Boolean(
    readiness?.client_id_configured && readiness.client_secret_configured,
  );

  const loadReadiness = useCallback(async () => {
    try {
      const response = await fetch(`${baseUrl}/api/settings/podium/readiness`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!response.ok) return null;
      const next = (await response.json()) as PodiumReadiness;
      setReadiness(next);
      return next;
    } catch {
      return null;
    }
  }, [backofficeHeaders, baseUrl]);

  const loadProviderSetup = useCallback(async () => {
    setProviderError("");
    try {
      const providerResponse = await fetch(
        `${baseUrl}/api/settings/podium/provider-setup`,
        {
          headers: backofficeHeaders() as Record<string, string>,
          cache: "no-store",
        },
      );
      if (!providerResponse.ok) {
        const body = (await providerResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        setProviderSetup(null);
        setProviderError(body.error ?? "Podium provider setup could not be read.");
      } else {
        setProviderSetup((await providerResponse.json()) as PodiumProviderSetup);
      }
    } catch {
      setProviderSetup(null);
      setProviderError("Podium provider setup could not be read.");
    }
  }, [backofficeHeaders, baseUrl]);

  const loadContactDiagnostics = useCallback(async () => {
    try {
      const [issuesResponse, overviewResponse] = await Promise.all([
        fetch(
          `${baseUrl}/api/customers/podium/contact-reconciliation-issues?limit=50`,
          {
            headers: backofficeHeaders() as Record<string, string>,
            cache: "no-store",
          },
        ),
        fetch(`${baseUrl}/api/customers/podium/contact-sync-overview`, {
          headers: backofficeHeaders() as Record<string, string>,
          cache: "no-store",
        }),
      ]);
      if (issuesResponse.ok) {
        const issues = (await issuesResponse.json()) as PodiumContactIssue[];
        setContactIssues(Array.isArray(issues) ? issues : []);
      }
      if (overviewResponse.ok) {
        setContactOverview(
          (await overviewResponse.json()) as PodiumContactSyncOverview,
        );
      }
    } catch {
      setContactOverview(null);
    }
  }, [backofficeHeaders, baseUrl]);

  const refreshPodiumState = useCallback(async () => {
    await loadCommunicationSettings();
    const nextReadiness = await loadReadiness();
    if (nextReadiness?.credentials_configured) {
      await Promise.all([loadProviderSetup(), loadContactDiagnostics()]);
    } else {
      setProviderSetup(null);
      setProviderError("");
      setContactOverview(null);
    }
  }, [
    loadCommunicationSettings,
    loadContactDiagnostics,
    loadProviderSetup,
    loadReadiness,
  ]);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness]);

  useEffect(() => {
    if (settings?.credentials_configured) {
      void Promise.all([loadProviderSetup(), loadContactDiagnostics()]);
    }
  }, [loadContactDiagnostics, loadProviderSetup, settings?.credentials_configured]);

  useEffect(() => {
    if (contactOverview?.last_reconciliation?.status !== "running") return;
    const intervalId = window.setInterval(() => {
      void loadContactDiagnostics();
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [contactOverview?.last_reconciliation?.status, loadContactDiagnostics]);

  const startOAuth = async () => {
    if (!appCredentialsReady) {
      toast("Save the Podium Client ID and Client Secret first.", "error");
      return;
    }
    if (!redirectUri || !callbackReady) {
      toast("Open Riverside from its public HTTPS address before connecting Podium.", "error");
      return;
    }
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      scope: PODIUM_OAUTH_SCOPE,
    });
    try {
      const response = await fetch(
        `${baseUrl}/api/settings/podium/oauth/authorize-url?${params}`,
        { headers: backofficeHeaders() as Record<string, string> },
      );
      const body = (await response.json().catch(() => ({}))) as {
        authorize_url?: string;
        error?: string;
      };
      if (!response.ok || !body.authorize_url) {
        toast(body.error ?? "Podium authorization is not ready.", "error");
        return;
      }
      sessionStorage.setItem(PODIUM_OAUTH_STATE_STORAGE_KEY, state);
      sessionStorage.setItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY, redirectUri);
      window.location.assign(body.authorize_url);
    } catch {
      toast("Could not start Podium authorization.", "error");
    }
  };

  const copyRedirectUri = async () => {
    if (!redirectUri) return;
    if (await copyTextToClipboard(redirectUri)) {
      toast("Podium callback URL copied.", "success");
    } else {
      toast("Could not copy the callback URL.", "error");
    }
  };

  const saveLocation = async () => {
    if (!settings) return;
    const saved = await savePatch(
      { location_uid: settings.location_uid },
      "Podium location saved.",
    );
    if (saved) await loadProviderSetup();
  };

  const ensureWebhook = async () => {
    setWebhookBusy(true);
    try {
      const response = await fetch(`${baseUrl}/api/settings/podium/webhook`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      const body = (await response.json().catch(() => ({}))) as
        | PodiumProviderSetup
        | { error?: string };
      if (!response.ok) {
        toast(
          "error" in body && body.error
            ? body.error
            : "Podium webhook registration failed.",
          "error",
        );
        return;
      }
      setProviderSetup(body as PodiumProviderSetup);
      toast("Podium webhook subscription is current.", "success");
    } catch {
      toast("Podium webhook registration failed.", "error");
    } finally {
      setWebhookBusy(false);
      setWebhookConfirmOpen(false);
    }
  };

  const checkHealth = async () => {
    setHealthBusy(true);
    try {
      const response = await fetch(`${baseUrl}/api/settings/podium/health`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!response.ok) throw new Error("podium-health");
      setHealth((await response.json()) as PodiumHealth);
    } catch {
      toast("Podium health check could not run.", "error");
    } finally {
      setHealthBusy(false);
    }
  };

  const reconcileContacts = async () => {
    setContactBusy(true);
    try {
      const response = await fetch(
        `${baseUrl}/api/customers/podium/contact-reconcile`,
        {
          method: "POST",
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      const body = (await response.json().catch(() => ({}))) as
        | PodiumContactReconciliationStart
        | { error?: string };
      if (!response.ok) {
        if (response.status === 409) {
          toast(
            "A Podium contact reconciliation is already running. Try again after it finishes.",
            "info",
          );
          await loadContactDiagnostics();
          return;
        }
        toast(
          "error" in body && body.error
            ? body.error
            : "Podium contact reconciliation could not run.",
          "error",
        );
        return;
      }
      toast(
        "Podium contact reconciliation started. You can leave this page while it runs.",
        "success",
      );
      await loadContactDiagnostics();
    } catch {
      toast("Podium contact reconciliation could not run.", "error");
    } finally {
      setContactBusy(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-30" />
      </div>
    );
  }

  const webhookCanBeEnsured = Boolean(
    providerSetup?.configured_location_uid &&
      providerSetup.webhook_url &&
      readiness?.webhook_secret_configured,
  );

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header>
        <IntegrationBrandLogo
          brand="podium"
          kind="wordmark"
          className="inline-flex rounded-2xl border border-app-border bg-app-surface px-4 py-2 shadow-sm"
          imageClassName="h-10 w-auto object-contain"
        />
        <h2 className="mt-4 text-3xl font-black italic uppercase tracking-tighter text-app-text">
          Podium Integration
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
          Connect Riverside to one Podium location, manage its verified webhook subscription,
          and control Podium text messaging. Email, reviews, receipts, and storefront settings
          now live with the features that own them.
        </p>
      </header>

      <section className="ui-card max-w-5xl p-6">
        <div className="rounded-2xl border border-app-warning/30 bg-app-warning/10 p-5">
          <h3 className="text-sm font-black uppercase tracking-widest text-app-warning">
            Connect Podium in 3 steps
          </h3>
          <ol className="mt-4 space-y-4 text-sm font-medium text-app-text-muted">
            <li>
              <strong className="text-app-text">1. Create the OAuth app.</strong> Register this
              exact callback in Podium:
              <code className="mt-2 block break-all rounded-xl bg-app-surface p-3 text-xs text-app-text">
                {redirectUri ?? "Callback unavailable"}
              </code>
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  href="https://developer.podium.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="ui-btn-secondary inline-flex h-9 items-center gap-2 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  Open Podium Developer Portal
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
                <button
                  type="button"
                  disabled={!redirectUri}
                  onClick={() => void copyRedirectUri()}
                  className="ui-btn-secondary inline-flex h-9 items-center gap-2 px-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  <Copy className="h-3 w-3" aria-hidden /> Copy callback
                </button>
              </div>
              {!callbackReady ? (
                <a
                  href={PODIUM_PUBLIC_APP_ORIGIN}
                  className="mt-3 inline-flex text-xs font-black text-app-warning underline"
                >
                  Open Secure Riverside before connecting
                </a>
              ) : null}
            </li>
            <li>
              <strong className="text-app-text">2. Save the app keys.</strong> Use the Client ID
              and Client Secret from Podium.
            </li>
            <li>
              <strong className="text-app-text">3. Approve Riverside.</strong>
              <div>
                <button
                  type="button"
                  disabled={!appCredentialsReady || !callbackReady}
                  onClick={() => void startOAuth()}
                  className="ui-btn-primary mt-3 px-5 py-2.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  {settings.credentials_configured
                    ? "Reconnect Podium Account"
                    : "Connect Podium Account"}
                </button>
              </div>
            </li>
          </ol>
        </div>

        <div className="mt-6">
          <IntegrationCredentialsCard
            baseUrl={baseUrl}
            integrationKey="podium"
            title="Podium App Keys"
            description="Riverside saves the refresh token automatically after approval."
            fields={[
              { key: "client_id", label: "Client ID", type: "text" },
              { key: "client_secret", label: "Client Secret" },
            ]}
            onSaved={refreshPodiumState}
          />
        </div>

        <details className="mt-6 rounded-2xl border border-app-border bg-app-surface-2/60 p-5">
          <summary className="cursor-pointer text-xs font-black uppercase tracking-widest text-app-text">
            Advanced and incoming-message setup
          </summary>
          <p className="mt-2 text-xs font-semibold leading-5 text-app-text-muted">
            The signing secret verifies incoming webhooks. Leave API host and token URL blank
            unless Podium support instructs otherwise.
          </p>
          <div className="mt-4">
            <IntegrationCredentialsCard
              baseUrl={baseUrl}
              integrationKey="podium"
              title="Advanced Podium Credentials"
              description="Recovery and webhook values only."
              fields={[
                {
                  key: "refresh_token",
                  label: "Refresh Token",
                  optional: true,
                  help: "Manual recovery only; OAuth normally saves this.",
                },
                {
                  key: "webhook_secret",
                  label: "Webhook Signing Secret",
                  optional: true,
                  help: "Must match the secret registered with Podium.",
                },
                {
                  key: "api_base_url",
                  label: "API Host Override",
                  type: "url",
                  optional: true,
                  placeholder: "https://api.podium.com",
                },
                {
                  key: "oauth_token_url",
                  label: "OAuth Token URL Override",
                  type: "url",
                  optional: true,
                  placeholder: "https://api.podium.com/oauth/token",
                },
              ]}
              onSaved={refreshPodiumState}
            />
          </div>
        </details>
      </section>

      <section className="ui-card max-w-5xl p-6">
        <div className="mb-5 border-b border-app-border pb-4">
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Provider location and webhook
          </h3>
          <p className="mt-1 text-xs font-semibold leading-5 text-app-text-muted">
            Riverside reads locations and subscriptions directly from Podium. Registering the
            webhook is an explicit provider-side change.
          </p>
        </div>

        {settings.credentials_configured && providerSetup ? (
          <>
            <div className="grid gap-4 md:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Podium location
                </span>
                <select
                  value={settings.location_uid}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, location_uid: event.target.value }
                        : current,
                    )
                  }
                  className="ui-input h-11 w-full px-3 text-sm font-bold"
                >
                  <option value="">Select a Podium location</option>
                  {settings.location_uid &&
                  !providerSetup.locations.some(
                    (location) => location.uid === settings.location_uid,
                  ) ? (
                    <option value={settings.location_uid} disabled>
                      Saved location unavailable ({settings.location_uid})
                    </option>
                  ) : null}
                  {providerSetup.locations.map((location) => (
                    <option
                      key={location.uid}
                      value={location.uid}
                      disabled={location.archived}
                    >
                      {location.display_name || location.name}
                      {location.archived ? " (archived)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={saving || !settings.location_uid.trim()}
                onClick={() => void saveLocation()}
                className="ui-btn-secondary mt-auto inline-flex h-11 items-center justify-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
              >
                <Save className="h-4 w-4" aria-hidden />
                Save Location
              </button>
            </div>

            <div
              className={`mt-4 rounded-2xl border p-4 ${
                providerSetup.webhook_status === "ready"
                  ? "border-app-success/30 bg-app-success/10"
                  : "border-app-warning/30 bg-app-warning/10"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                    Webhook: {providerSetup.webhook_status.replaceAll("_", " ")}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-app-text-muted">
                    {providerSetup.message}
                  </p>
                  {providerSetup.webhook_url ? (
                    <code className="mt-2 block break-all text-[10px] text-app-text-muted">
                      {providerSetup.webhook_url}
                    </code>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={
                    webhookBusy ||
                    !webhookCanBeEnsured ||
                    providerSetup.webhook_status === "ready"
                  }
                  onClick={() => setWebhookConfirmOpen(true)}
                  className="ui-btn-primary h-10 px-4 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  {providerSetup.matching_webhook ? "Update Webhook" : "Register Webhook"}
                </button>
              </div>
            </div>
          </>
        ) : settings.credentials_configured ? (
          <div className="rounded-2xl border border-app-warning/30 bg-app-warning/10 p-4 text-xs font-semibold text-app-warning">
            {providerError || "Reading Podium locations and webhooks..."}
          </div>
        ) : (
          <p className="text-sm font-semibold text-app-text-muted">
            Connect the Podium account before selecting a location or registering webhooks.
          </p>
        )}

        {readiness ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="API host" value={readiness.api_base.replace("https://", "")} />
            <Metric label="API version" value={readiness.api_version} />
            <Metric
              label="Signature verification"
              value={readiness.webhook_secret_configured ? "Configured" : "Missing"}
            />
            <Metric
              label="Inbound processing"
              value={readiness.inbound_ingest_enabled ? "Enabled" : "Disabled"}
            />
          </div>
        ) : null}
      </section>

      <PodiumSmsSettingsCard
        settings={settings}
        setSettings={setSettings}
        savePatch={savePatch}
        saving={saving}
      />

      <section className="ui-card max-w-5xl p-6">
        <details>
          <summary className="cursor-pointer text-sm font-black uppercase tracking-widest text-app-text">
            Diagnostics and contact maintenance
          </summary>
          <p className="mt-2 text-xs font-semibold leading-5 text-app-text-muted">
            Health checks are read-only. Contact reconciliation runs in the background, compares
            the full Podium contact list, and queues only missing or failed Riverside contacts.
            Ambiguous matches stay unresolved for safe review.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={healthBusy || !settings.credentials_configured}
              onClick={() => void checkHealth()}
              className="ui-btn-secondary inline-flex h-10 items-center gap-2 px-4 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${healthBusy ? "animate-spin" : ""}`} />
              Check Health
            </button>
            <button
              type="button"
              disabled={
                contactBusy || reconciliationRunning || !settings.credentials_configured
              }
              onClick={() => void reconcileContacts()}
              className="ui-btn-secondary inline-flex h-10 items-center gap-2 px-4 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${contactBusy || reconciliationRunning ? "animate-spin" : ""}`}
              />
              {reconciliationRunning ? "Reconciliation Running" : "Reconcile Contacts"}
            </button>
          </div>
          {health ? (
            <div
              className={`mt-4 rounded-xl border p-4 text-xs font-semibold ${
                health.reachable
                  ? "border-app-success/30 bg-app-success/10"
                  : "border-app-warning/30 bg-app-warning/10"
              }`}
            >
              <div className="flex items-center gap-2 font-black uppercase tracking-widest text-app-text">
                {health.reachable ? (
                  <CheckCircle2 className="h-4 w-4 text-app-success" />
                ) : (
                  <TriangleAlert className="h-4 w-4 text-app-warning" />
                )}
                {health.reachable ? "Authenticated" : "Needs attention"} · {health.latency_ms} ms
              </div>
              <p className="mt-1 text-app-text-muted">{health.message}</p>
            </div>
          ) : null}
          {contactOverview ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <Metric
                label="Eligible ROS customers"
                value={String(contactOverview.eligible_customers)}
              />
              <Metric
                label="Mapped to Podium"
                value={String(contactOverview.mapped_customers)}
              />
              <Metric
                label="Needs first sync"
                value={String(contactOverview.unsynchronized_customers)}
              />
              <Metric
                label="Queued"
                value={String(
                  contactOverview.pending_customers +
                    contactOverview.processing_customers,
                )}
              />
              <Metric label="Failed" value={String(contactOverview.failed_customers)} />
              <Metric
                label="Conflicts"
                value={String(contactOverview.conflict_customers)}
              />
            </div>
          ) : null}
          {contactOverview?.last_reconciliation ? (
            <div
              className={`mt-4 rounded-xl border p-4 text-xs font-semibold ${
                contactOverview.last_reconciliation.status === "failed"
                  ? "border-app-warning/30 bg-app-warning/10"
                  : "border-app-border bg-app-surface-2/60"
              }`}
            >
              <p className="font-black uppercase tracking-widest text-app-text">
                Last reconciliation: {contactOverview.last_reconciliation.status}
              </p>
              <p className="mt-1 text-app-text-muted">
                Started {formatContactTimestamp(contactOverview.last_reconciliation.started_at)}.
                {contactOverview.last_reconciliation.status === "succeeded"
                  ? ` Compared ${contactOverview.last_reconciliation.contacts_seen} Podium contacts and queued ${contactOverview.last_reconciliation.outbound_queued} Riverside contacts.`
                  : contactOverview.last_reconciliation.status === "running"
                    ? " Progress refreshes automatically while it runs."
                    : " The run stopped before completing; review the reason below and retry."}
              </p>
              {contactOverview.last_reconciliation.error ? (
                <p className="mt-2 text-app-warning">
                  {contactOverview.last_reconciliation.error}
                </p>
              ) : null}
            </div>
          ) : null}
          {contactIssues.length > 0 ? (
            <div className="mt-4 rounded-xl border border-app-warning/30 bg-app-warning/10 p-4">
              <p className="text-xs font-black uppercase tracking-widest text-app-warning">
                {contactOverview?.open_issues ?? contactIssues.length} unresolved contact{" "}
                {(contactOverview?.open_issues ?? contactIssues.length) === 1
                  ? "match"
                  : "matches"}
              </p>
              <ul className="mt-2 space-y-2 text-xs font-semibold text-app-text-muted">
                {contactIssues.slice(0, 8).map((issue) => (
                  <li key={issue.id}>
                    <span className="font-black text-app-text">
                      {issue.provider_name ||
                        issue.phone_e164 ||
                        issue.email ||
                        "Podium contact"}
                      :
                    </span>{" "}
                    {describeContactIssue(issue)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </details>
      </section>

      <ConfirmationModal
        isOpen={webhookConfirmOpen}
        onClose={() => setWebhookConfirmOpen(false)}
        onConfirm={() => void ensureWebhook()}
        loading={webhookBusy}
        title="Register Podium webhook?"
        message="This creates or updates Riverside's Podium subscription for message, contact, and review-link events at the selected location. Podium will begin queueing events immediately."
        confirmLabel="Register webhook"
        variant="info"
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface-2/60 p-3">
      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
        {label}
      </p>
      <p className="mt-1 truncate text-xs font-black text-app-text">{value}</p>
    </div>
  );
}

function formatContactTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString();
}

function describeContactIssue(issue: PodiumContactIssue) {
  const candidateCount = issue.candidate_customer_ids.length;
  switch (issue.reason) {
    case "provider_uid_identity_conflict":
      return "Podium's saved identity conflicts with a different Riverside customer.";
    case "ambiguous_identity":
      return `${candidateCount} Riverside customers share this phone or email.`;
    case "multiple_provider_contacts_match_customer":
      return "More than one Podium contact appears to match this Riverside customer.";
    default:
      return issue.reason.replaceAll("_", " ");
  }
}
