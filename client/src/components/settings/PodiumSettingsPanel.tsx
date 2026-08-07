import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, Copy, ExternalLink, Info, TriangleAlert } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import ReviewInvitesSettingsCard from "./ReviewInvitesSettingsCard";
import {
  getPodiumOAuthRedirectUri,
  isPodiumOAuthBrowserOriginReady,
  PODIUM_PUBLIC_APP_ORIGIN,
  PODIUM_OAUTH_STATE_STORAGE_KEY,
  PODIUM_OAUTH_REDIRECT_STORAGE_KEY
} from "../../lib/podiumOAuth";

interface PodiumSmsConfig {
  sms_send_enabled: boolean;
  sms_features: {
    staff_messages: boolean;
    receipts: boolean;
    ready_for_pickup: boolean;
    alteration_ready: boolean;
    appointment_confirmation: boolean;
    appointment_reminder: boolean;
    unknown_sender_welcome: boolean;
  };
  location_uid: string;
  templates: {
    ready_for_pickup: string;
    alteration_ready: string;
    unknown_sender_welcome: string;
    appointment_confirmation: string;
    appointment_reminder: string;
  };
  templates_effective: PodiumSmsConfig["templates"];
  email_templates: {
    ready_for_pickup_subject: string;
    ready_for_pickup_html: string;
    alteration_ready_subject: string;
    alteration_ready_html: string;
    appointment_confirmation_subject: string;
    appointment_confirmation_html: string;
    appointment_reminder_subject: string;
    appointment_reminder_html: string;
  };
  email_templates_effective: PodiumSmsConfig["email_templates"];
  review_templates: {
    sms_body: string;
    email_subject: string;
    email_body: string;
  };
  review_templates_effective: PodiumSmsConfig["review_templates"];
  receipt_templates: {
    sms_caption: string;
    gift_sms_caption: string;
    email_subject: string;
    gift_email_subject: string;
  };
  receipt_templates_effective: PodiumSmsConfig["receipt_templates"];
  widget_embed_enabled: boolean;
  widget_snippet_html: string;
  credentials_configured: boolean;
  oauth_authorize_url: string;
  oauth_token_url_hint: string;
}

interface PodiumReadiness {
  client_id_configured: boolean;
  client_secret_configured: boolean;
  api_base: string;
  credentials_configured: boolean;
  webhook_secret_configured: boolean;
  allow_unsigned_webhook: boolean;
  inbound_inbox_preview_enabled: boolean;
  sms_send_enabled: boolean;
  location_uid_configured: boolean;
  widget_embed_enabled: boolean;
}

interface PodiumHealth {
  configured: boolean;
  reachable: boolean;
  latency_ms: number;
  message: string;
}

interface PodiumContactReconciliationResult {
  contacts_seen: number;
  contacts_matched: number;
  customers_created: number;
  customers_updated: number;
  conflicts: number;
  outbound_queued: number;
}

interface PodiumContactIssue {
  id: string;
  provider_contact_uid: string;
  provider_name: string | null;
  phone_e164: string | null;
  email: string | null;
  reason: string;
  candidate_customer_ids: string[];
  last_seen_at: string;
}

interface PodiumAuthorizeUrlResponse {
  authorize_url: string;
}

interface PodiumSettingsPanelProps {
  baseUrl: string;
}

const PODIUM_TEMPLATE_DEFAULTS = {
  ready_for_pickup: "Hi {first_name}, your Riverside order {transaction_ref} is ready for pickup. We look forward to seeing you.",
  alteration_ready: "Hi {first_name}, your alteration {alteration_ref} is ready for your final fitting or pickup.",
  unknown_sender_welcome: "Hi from Riverside! We've saved your contact info. Reply here for questions about your order.",
  appointment_confirmation: "Hi {first_name}, your Riverside {appointment_type} appointment is set for {starts_at}. Calendar invite attached.",
  appointment_reminder: "Hi {first_name}, reminder: your Riverside {appointment_type} appointment is tomorrow at {starts_at}.",
};

const OPERATIONAL_EMAIL_TEMPLATE_DEFAULTS: PodiumSmsConfig["email_templates"] = {
  ready_for_pickup_subject: "Your Riverside order is ready",
  ready_for_pickup_html:
    "<p>Hi {first_name},</p><p>Your Riverside order <b>{transaction_ref}</b> is ready for pickup.</p><p>Questions? Call {store_phone}.</p>",
  alteration_ready_subject: "Your alteration is ready",
  alteration_ready_html:
    "<p>Hi {first_name},</p><p>Your alteration <b>{alteration_ref}</b> is ready for your final fitting or pickup.</p><p>Questions? Call {store_phone}.</p>",
  appointment_confirmation_subject: "Appointment confirmed — Riverside",
  appointment_confirmation_html:
    "<p>Hi {first_name},</p><p>Your <b>{appointment_type}</b> appointment is scheduled for <b>{starts_at}</b>.</p>{notes_block}",
  appointment_reminder_subject: "Reminder: your Riverside appointment is tomorrow",
  appointment_reminder_html:
    "<p>Hi {first_name},</p><p>This is a reminder that your <b>{appointment_type}</b> appointment is tomorrow at <b>{starts_at}</b>.</p><p>Questions? Call {store_phone}.</p>",
};

const REVIEW_TEMPLATE_DEFAULTS: PodiumSmsConfig["review_templates"] = {
  sms_body:
    "Hi {first_name}, thank you for choosing {store_name}. We would appreciate your review: {review_url}",
  email_subject: "How was your Riverside experience?",
  email_body:
    "Hi {first_name},\n\nThank you for choosing {store_name}. We would appreciate your feedback. Share your review here: {review_url}\n\nThank you,\n{store_name}",
};

const RECEIPT_TEMPLATE_DEFAULTS: PodiumSmsConfig["receipt_templates"] = {
  sms_caption: "{store_name} — Receipt {receipt_ref} (image attached).",
  gift_sms_caption: "{store_name} — Gift receipt {receipt_ref} (image attached).",
  email_subject: "Receipt — {receipt_ref}",
  gift_email_subject: "Gift receipt — {receipt_ref}",
};

type SmsTemplateKey = keyof PodiumSmsConfig["templates"];
type SmsFeatureKey = keyof PodiumSmsConfig["sms_features"];
type ReviewTemplateKey = keyof PodiumSmsConfig["review_templates"];
type ReceiptTemplateKey = keyof PodiumSmsConfig["receipt_templates"];

const PODIUM_SMS_TEMPLATE_BLOCKS: {
  key: SmsTemplateKey;
  featureKey: SmsFeatureKey;
  label: string;
  description: string;
  tags: { token: string; label: string }[];
}[] = [
  {
    key: "ready_for_pickup",
    featureKey: "ready_for_pickup",
    label: "Ready for pickup",
    description: "Sent when order items are ready for pickup.",
    tags: [
      { token: "{first_name}", label: "First name" },
      { token: "{last_name}", label: "Last name" },
      { token: "{full_name}", label: "Full name" },
      { token: "{customer_code}", label: "Customer #" },
      { token: "{transaction_ref}", label: "Transaction" },
      { token: "{store_name}", label: "Store name" },
      { token: "{store_phone}", label: "Store phone" },
    ],
  },
  {
    key: "alteration_ready",
    featureKey: "alteration_ready",
    label: "Alteration ready",
    description: "Sent when an alteration is marked ready.",
    tags: [
      { token: "{first_name}", label: "First name" },
      { token: "{last_name}", label: "Last name" },
      { token: "{full_name}", label: "Full name" },
      { token: "{alteration_ref}", label: "Alteration" },
      { token: "{transaction_ref}", label: "Transaction" },
      { token: "{store_name}", label: "Store name" },
      { token: "{store_phone}", label: "Store phone" },
    ],
  },
  {
    key: "appointment_confirmation",
    featureKey: "appointment_confirmation",
    label: "Appointment confirmation",
    description: "Sent when a customer appointment is created.",
    tags: [
      { token: "{first_name}", label: "First name" },
      { token: "{appointment_type}", label: "Purpose" },
      { token: "{starts_at}", label: "Date/time" },
      { token: "{appointment_date}", label: "Date" },
      { token: "{appointment_time}", label: "Time" },
      { token: "{store_name}", label: "Store name" },
      { token: "{store_phone}", label: "Store phone" },
    ],
  },
  {
    key: "appointment_reminder",
    featureKey: "appointment_reminder",
    label: "Appointment reminder",
    description: "Sent 24 hours before a customer appointment.",
    tags: [
      { token: "{first_name}", label: "First name" },
      { token: "{appointment_type}", label: "Purpose" },
      { token: "{starts_at}", label: "Date/time" },
      { token: "{appointment_date}", label: "Date" },
      { token: "{appointment_time}", label: "Time" },
      { token: "{store_name}", label: "Store name" },
      { token: "{store_phone}", label: "Store phone" },
    ],
  },
  {
    key: "unknown_sender_welcome",
    featureKey: "unknown_sender_welcome",
    label: "New text sender",
    description: "Sent once when a new inbound phone number creates a customer stub.",
    tags: [],
  },
] as const;

type OperationalEmailTemplateKey = keyof PodiumSmsConfig["email_templates"];

const CUSTOMER_TAGS = [
  { token: "{first_name}", label: "First name" },
  { token: "{last_name}", label: "Last name" },
  { token: "{full_name}", label: "Full name" },
  { token: "{customer_code}", label: "Customer #" },
] as const;

const STORE_TAGS = [
  { token: "{store_name}", label: "Store name" },
  { token: "{store_phone}", label: "Store phone" },
  { token: "{store_email}", label: "Store email" },
  { token: "{store_address}", label: "Store address" },
] as const;

const OPERATIONAL_EMAIL_TEMPLATE_BLOCKS: Array<{
  label: string;
  description: string;
  subjectKey: OperationalEmailTemplateKey;
  bodyKey: OperationalEmailTemplateKey;
  tags: ReadonlyArray<{ token: string; label: string }>;
}> = [
  {
    label: "Ready for pickup email",
    description: "Store Email sent when a customer Transaction is ready for pickup.",
    subjectKey: "ready_for_pickup_subject",
    bodyKey: "ready_for_pickup_html",
    tags: [...CUSTOMER_TAGS, ...STORE_TAGS, { token: "{transaction_ref}", label: "Transaction" }],
  },
  {
    label: "Alteration ready email",
    description: "Store Email sent when alteration work is marked ready.",
    subjectKey: "alteration_ready_subject",
    bodyKey: "alteration_ready_html",
    tags: [
      ...CUSTOMER_TAGS,
      ...STORE_TAGS,
      { token: "{alteration_ref}", label: "Alteration ticket" },
      { token: "{transaction_ref}", label: "Transaction" },
    ],
  },
  {
    label: "Appointment confirmation email",
    description: "Store Email with the calendar attachment after appointment creation.",
    subjectKey: "appointment_confirmation_subject",
    bodyKey: "appointment_confirmation_html",
    tags: [
      ...CUSTOMER_TAGS,
      ...STORE_TAGS,
      { token: "{appointment_type}", label: "Purpose" },
      { token: "{starts_at}", label: "Date/time" },
      { token: "{appointment_date}", label: "Date" },
      { token: "{appointment_time}", label: "Time" },
      { token: "{notes_block}", label: "Notes block" },
      { token: "{calendar_url}", label: "Calendar link" },
    ],
  },
  {
    label: "Appointment reminder email",
    description: "Store Email sent by the 24-hour reminder worker.",
    subjectKey: "appointment_reminder_subject",
    bodyKey: "appointment_reminder_html",
    tags: [
      ...CUSTOMER_TAGS,
      ...STORE_TAGS,
      { token: "{appointment_type}", label: "Purpose" },
      { token: "{starts_at}", label: "Date/time" },
      { token: "{appointment_date}", label: "Date" },
      { token: "{appointment_time}", label: "Time" },
      { token: "{notes}", label: "Notes" },
    ],
  },
];

function hydrateTemplateValues<T extends Record<string, string>>(stored: T, effective: T): T {
  return Object.fromEntries(
    Object.keys(effective).map((key) => {
      const storedValue = stored[key]?.trim();
      return [key, storedValue ? stored[key] : effective[key]];
    }),
  ) as T;
}

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

const PodiumSettingsPanel: React.FC<PodiumSettingsPanelProps> = ({ baseUrl }) => {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [podiumSms, setPodiumSms] = useState<PodiumSmsConfig | null>(null);
  const [podiumReadiness, setPodiumReadiness] = useState<PodiumReadiness | null>(null);
  const [podiumHealth, setPodiumHealth] = useState<PodiumHealth | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [contactReconcileBusy, setContactReconcileBusy] = useState(false);
  const [contactReconcileResult, setContactReconcileResult] =
    useState<PodiumContactReconciliationResult | null>(null);
  const [contactIssues, setContactIssues] = useState<PodiumContactIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const podiumRedirectUri = getPodiumOAuthRedirectUri();
  const appCredentialsReady = Boolean(
    podiumReadiness?.client_id_configured && podiumReadiness.client_secret_configured,
  );
  const callbackReady = isPodiumOAuthBrowserOriginReady(podiumRedirectUri);

  const fetchPodiumSmsSettings = useCallback(async () => {
    try {
      const resp = await fetch(`${baseUrl}/api/settings/podium-sms`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (resp.ok) {
        const next = (await resp.json()) as PodiumSmsConfig;
        setPodiumSms({
          ...next,
          templates: hydrateTemplateValues(next.templates, next.templates_effective),
          email_templates: hydrateTemplateValues(
            next.email_templates,
            next.email_templates_effective,
          ),
          review_templates: hydrateTemplateValues(
            next.review_templates,
            next.review_templates_effective,
          ),
          receipt_templates: hydrateTemplateValues(
            next.receipt_templates,
            next.receipt_templates_effective,
          ),
        });
      }
      const readResp = await fetch(`${baseUrl}/api/settings/podium-sms/readiness`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (readResp.ok) {
        setPodiumReadiness((await readResp.json()) as PodiumReadiness);
      }
      const issueResp = await fetch(
        `${baseUrl}/api/customers/podium/contact-reconciliation-issues?limit=50`,
        { headers: backofficeHeaders() as Record<string, string>, cache: "no-store" },
      );
      if (issueResp.ok) {
        const issues = (await issueResp.json()) as PodiumContactIssue[];
        setContactIssues(Array.isArray(issues) ? issues : []);
      }
    } catch (err) {
      console.error("Failed to fetch podium settings", err);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void fetchPodiumSmsSettings();
  }, [fetchPodiumSmsSettings]);

  const savePodiumSmsSettings = async () => {
    if (!podiumSms || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/podium-sms`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(podiumSms),
      });
      if (res.ok) {
        toast("Podium communication settings saved", "success");
        await fetchPodiumSmsSettings();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save Podium settings", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  const checkPodiumHealth = async () => {
    if (healthBusy) return;
    setHealthBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/podium-health`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) throw new Error("podium-health");
      setPodiumHealth((await res.json()) as PodiumHealth);
    } catch {
      toast("Podium health check could not run.", "error");
    } finally {
      setHealthBusy(false);
    }
  };

  const reconcilePodiumContacts = async () => {
    if (contactReconcileBusy) return;
    setContactReconcileBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/contact-reconcile`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      const payload = (await res.json().catch(() => ({}))) as
        | PodiumContactReconciliationResult
        | { error?: string };
      if (!res.ok) {
        toast(
          "error" in payload && payload.error
            ? payload.error
            : "Podium contact reconciliation could not run.",
          "error",
        );
        return;
      }
      const result = payload as PodiumContactReconciliationResult;
      setContactReconcileResult(result);
      toast(
        `Compared ${result.contacts_seen} Podium contacts; ${result.conflicts} require review.`,
        result.conflicts > 0 ? "info" : "success",
      );
      await fetchPodiumSmsSettings();
    } catch {
      toast("Podium contact reconciliation could not run.", "error");
    } finally {
      setContactReconcileBusy(false);
    }
  };

  const startPodiumOAuthConnect = async () => {
    if (!podiumSms) return;
    if (!appCredentialsReady) {
      toast("Save the Podium Client ID and Client Secret first.", "error");
      return;
    }
    const redirectUri = podiumRedirectUri;
    if (!redirectUri) {
      toast("Podium callback URL is unavailable in this browser session.", "error");
      return;
    }
    if (!callbackReady) {
      toast("Open Riverside from its HTTPS address before connecting Podium.", "error");
      return;
    }
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      scope: PODIUM_OAUTH_SCOPE,
    });
    try {
      const res = await fetch(`${baseUrl}/api/settings/podium-oauth/authorize-url?${params}`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Podium authorization is not ready yet.", "error");
        return;
      }
      const body = (await res.json()) as PodiumAuthorizeUrlResponse;
      if (!body.authorize_url) {
        toast("Podium authorization URL was not returned.", "error");
        return;
      }
      sessionStorage.setItem(PODIUM_OAUTH_STATE_STORAGE_KEY, state);
      sessionStorage.setItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY, redirectUri);
      window.location.assign(body.authorize_url);
    } catch {
      toast("Could not start Podium authorization.", "error");
    }
  };

  const copyPodiumRedirectUri = async () => {
    if (!podiumRedirectUri) return;
    try {
      await navigator.clipboard.writeText(podiumRedirectUri);
      toast("Podium callback URL copied", "success");
    } catch {
      toast("Could not copy the callback URL. Select and copy it manually.", "error");
    }
  };

  const insertSmsTag = (key: SmsTemplateKey, token: string) => {
    if (!podiumSms) return;
    const current = podiumSms.templates[key] ?? "";
    const next = current.trimEnd().length > 0 ? `${current.trimEnd()} ${token}` : token;
    setPodiumSms({
      ...podiumSms,
      templates: {
        ...podiumSms.templates,
        [key]: next,
      },
    });
  };

  const insertEmailTag = (key: OperationalEmailTemplateKey, token: string) => {
    if (!podiumSms) return;
    const current = podiumSms.email_templates[key] ?? "";
    const next = current.trimEnd().length > 0 ? `${current.trimEnd()} ${token}` : token;
    setPodiumSms({
      ...podiumSms,
      email_templates: { ...podiumSms.email_templates, [key]: next },
    });
  };

  const insertReviewTag = (key: ReviewTemplateKey, token: string) => {
    if (!podiumSms) return;
    const current = podiumSms.review_templates[key] ?? "";
    const next = current.trimEnd().length > 0 ? `${current.trimEnd()} ${token}` : token;
    setPodiumSms({
      ...podiumSms,
      review_templates: { ...podiumSms.review_templates, [key]: next },
    });
  };

  const insertReceiptTag = (key: ReceiptTemplateKey, token: string) => {
    if (!podiumSms) return;
    const current = podiumSms.receipt_templates[key] ?? "";
    const next = current.trimEnd().length > 0 ? `${current.trimEnd()} ${token}` : token;
    setPodiumSms({
      ...podiumSms,
      receipt_templates: { ...podiumSms.receipt_templates, [key]: next },
    });
  };

  if (!podiumSms) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-10">
        <div className="mb-4 flex items-center">
          <IntegrationBrandLogo
            brand="podium"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-app-border bg-app-surface px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Customer Messages & Web Chat</h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">Edit operational, review, and receipt messages in one place. Podium delivers review requests; Store Email delivers operational and receipt email.</p>
      </header>

      <ReviewInvitesSettingsCard baseUrl={baseUrl} />

      <section className="ui-card ui-tint-accent p-8 max-w-4xl shadow-xl">
        <div className="ui-panel ui-tint-warning mb-8 p-6 text-sm">
          <h4 className="font-black uppercase tracking-widest text-app-warning flex items-center gap-2">
            <Info className="h-4 w-4" />
            Connect Podium in 3 steps
          </h4>
          <ol className="mt-4 space-y-4 font-medium text-app-text-muted">
            <li>
              <strong className="text-app-text">1. Create a Podium OAuth app.</strong>{" "}
              Open the developer portal and register this exact HTTPS callback:
              <code className="mt-2 block break-all rounded-xl bg-app-surface-2 p-3 text-[10px] font-bold text-app-text">
                {podiumRedirectUri ?? "Callback unavailable"}
              </code>
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  href="https://developer.podium.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="ui-btn-secondary inline-flex min-h-9 items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                >
                  Open Podium Developer Portal
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
                <button
                  type="button"
                  disabled={!podiumRedirectUri}
                  onClick={() => void copyPodiumRedirectUri()}
                  className="ui-btn-secondary inline-flex min-h-9 items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  <Copy className="h-3 w-3" aria-hidden />
                  Copy callback
                </button>
              </div>
              {!callbackReady ? (
                <div className="mt-3 rounded-xl border border-app-warning/40 bg-app-warning/10 p-3">
                  <p className="font-bold text-app-warning">
                    This browser is using Riverside&apos;s internal address. Open Secure Riverside
                    before connecting so Podium returns to the same signed-in browser session.
                  </p>
                  <a
                    href={PODIUM_PUBLIC_APP_ORIGIN}
                    className="ui-btn-secondary mt-2 inline-flex min-h-9 items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    Open Secure Riverside
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </div>
              ) : null}
            </li>
            <li>
              <strong className="text-app-text">2. Save the two app keys below.</strong>{" "}
              Copy the Client ID and Client Secret from Podium.
            </li>
            <li>
              <strong className="text-app-text">3. Approve Riverside.</strong>{" "}
              This button unlocks when both keys and the HTTPS callback are ready.
              <div>
                <button
                  type="button"
                  onClick={() => void startPodiumOAuthConnect()}
                  disabled={!appCredentialsReady || !callbackReady}
                  className="mt-3 ui-btn-primary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  {podiumSms.credentials_configured
                    ? "Reconnect Podium Account"
                    : "Connect Podium Account"}
                </button>
              </div>
            </li>
          </ol>
        </div>

        <div className="mb-8">
          <IntegrationCredentialsCard
            baseUrl={baseUrl}
            integrationKey="podium"
            title="Podium App Keys"
            description="These are the only two values needed before account approval. Riverside saves the refresh token automatically."
            fields={[
              {
                key: "client_id",
                label: "Client ID",
                type: "text",
              },
              {
                key: "client_secret",
                label: "Client Secret",
              },
            ]}
            onSaved={fetchPodiumSmsSettings}
          />
        </div>

        <details className="mb-8 rounded-2xl border border-app-border bg-app-surface p-5">
          <summary className="cursor-pointer text-xs font-black uppercase tracking-widest text-app-text">
            Advanced and incoming-message setup
          </summary>
          <p className="mt-2 text-xs font-semibold leading-5 text-app-text-muted">
            Not needed to connect Podium or test receipt texts. Add a webhook
            secret only for incoming messages; leave API addresses at default.
          </p>
          <div className="mt-4">
            <IntegrationCredentialsCard
              baseUrl={baseUrl}
              integrationKey="podium"
              title="Advanced Podium Credentials"
              description="Normally leave these blank."
              fields={[
                {
                  key: "refresh_token",
                  label: "Refresh Token",
                  optional: true,
                  help: "Manual recovery only; normally saved automatically.",
                },
                {
                  key: "webhook_secret",
                  label: "Webhook Signing Secret",
                  optional: true,
                  help: "Required only for verified incoming messages.",
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
              onSaved={fetchPodiumSmsSettings}
            />
          </div>
        </details>

        {podiumReadiness && (
           <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
              {[
                { label: "API Channel", val: podiumReadiness.api_base.replace('https://', '') },
                { label: "Webhooks", val: podiumReadiness.webhook_secret_configured ? "Configured" : "Missing" },
                { label: "Inbox Sync", val: podiumReadiness.inbound_inbox_preview_enabled ? "Enabled" : "Disabled" },
              ].map(stat => (
                <div key={stat.label} className="ui-metric-cell ui-tint-neutral p-3">
                   <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">{stat.label}</p>
                   <p className="text-xs font-black text-app-text truncate">{stat.val}</p>
                </div>
              ))}
           </div>
        )}

        <div className="mb-8">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void checkPodiumHealth()}
              disabled={healthBusy || !podiumSms.credentials_configured}
              className="ui-btn-secondary inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${healthBusy ? "animate-spin" : ""}`} aria-hidden />
              {healthBusy ? "Checking..." : "Check Podium Health"}
            </button>
            <button
              type="button"
              onClick={() => void reconcilePodiumContacts()}
              disabled={contactReconcileBusy || !podiumSms.credentials_configured}
              className="ui-btn-secondary inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${contactReconcileBusy ? "animate-spin" : ""}`}
                aria-hidden
              />
              {contactReconcileBusy ? "Reconciling..." : "Reconcile Contacts"}
            </button>
          </div>
          {podiumHealth ? (
            <div
              className={`mt-4 rounded-2xl border p-4 text-xs font-semibold ${
                podiumHealth.reachable
                  ? "border-app-success/30 bg-app-success/10 text-app-success"
                  : "border-app-warning/30 bg-app-warning/10 text-app-warning"
              }`}
            >
              <div className="flex items-center gap-2 font-black uppercase tracking-widest">
                {podiumHealth.reachable ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                ) : (
                  <TriangleAlert className="h-4 w-4" aria-hidden />
                )}
                {podiumHealth.reachable ? "Authenticated" : "Needs attention"} · {podiumHealth.latency_ms} ms
              </div>
              <p className="mt-2 normal-case text-app-text-muted">{podiumHealth.message}</p>
            </div>
          ) : null}
          {contactReconcileResult ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {[
                ["Podium contacts", contactReconcileResult.contacts_seen],
                ["ROS updates", contactReconcileResult.customers_updated + contactReconcileResult.customers_created],
                ["Needs review", contactReconcileResult.conflicts],
              ].map(([label, value]) => (
                <div key={label} className="ui-metric-cell ui-tint-neutral p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{label}</p>
                  <p className="mt-1 text-lg font-black text-app-text">{value}</p>
                </div>
              ))}
            </div>
          ) : null}
          {contactIssues.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-app-warning/30 bg-app-warning/10 p-4">
              <p className="text-xs font-black uppercase tracking-widest text-app-warning">
                {contactIssues.length} contact {contactIssues.length === 1 ? "conflict" : "conflicts"} need review
              </p>
              <ul className="mt-3 grid gap-2 lg:grid-cols-2">
                {contactIssues.map((issue) => (
                  <li key={issue.id} className="rounded-xl border border-app-warning/20 bg-app-surface p-3 text-xs">
                    <p className="font-black text-app-text">
                      {issue.provider_name ?? issue.phone_e164 ?? issue.email ?? "Unnamed Podium contact"}
                    </p>
                    <p className="mt-1 text-app-text-muted">
                      {issue.reason.replaceAll("_", " ")} · {issue.candidate_customer_ids.length} candidate customers
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                      {issue.provider_contact_uid}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] font-semibold text-app-text-muted">
                Verify the matching Podium contact and correct duplicate phone or email values in Podium or Customer Hub, then run reconciliation again. ROS will not choose between conflicting records.
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 mb-10 pb-10 border-b border-app-border/40">
           <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-app-surface shadow-xl shadow-app-accent/20 ring-1 ring-app-border">
                 <IntegrationBrandLogo
                   brand="podium"
                   kind="icon"
                   className="inline-flex"
                   imageClassName="h-10 w-10 rounded-md object-contain"
                 />
              </div>
              <div>
                 <h3 className="text-lg font-black italic uppercase tracking-tight text-app-text">Text Message Controls</h3>
                 <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Lifecycle SMS and inbound Podium messages</p>
              </div>
           </div>

           <label className="flex cursor-pointer items-center gap-2 group">
              <div className={`h-4 w-4 rounded-md border-2 flex items-center justify-center transition-all ${podiumSms.sms_features.staff_messages ? 'bg-app-accent border-app-accent text-white' : 'border-app-border group-hover:border-app-accent'}`}>
                 {podiumSms.sms_features.staff_messages && <CheckCircle2 size={10} />}
              </div>
              <input
                type="checkbox"
                className="sr-only"
                checked={podiumSms.sms_features.staff_messages}
                onChange={e => setPodiumSms({
                  ...podiumSms,
                  sms_features: { ...podiumSms.sms_features, staff_messages: e.target.checked },
                })}
              />
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text">Staff-authored texts</span>
           </label>
        </div>

        <div className="space-y-12">
           {/* SMS TEMPLATES */}
           <div>
              <div className="flex items-center justify-between mb-4">
                 <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">Automated Text Message Templates</h4>
                 <Info size={14} className="text-app-text-muted" />
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                 {PODIUM_SMS_TEMPLATE_BLOCKS.map((block) => (
                   <div key={block.key} className="ui-card ui-tint-neutral p-5 space-y-3">
                      <div className="flex justify-between items-start gap-3">
                         <div>
                           <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">{block.label}</span>
                           <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">{block.description}</p>
                         </div>
                         <div className="flex shrink-0 flex-col items-end gap-3">
                           <label className="flex cursor-pointer items-center gap-2 group">
                             <div className={`h-4 w-4 rounded-md border-2 flex items-center justify-center transition-all ${podiumSms.sms_features[block.featureKey] ? 'bg-app-accent border-app-accent text-white' : 'border-app-border group-hover:border-app-accent'}`}>
                               {podiumSms.sms_features[block.featureKey] && <CheckCircle2 size={10} />}
                             </div>
                             <input
                               type="checkbox"
                               className="sr-only"
                               checked={podiumSms.sms_features[block.featureKey]}
                               onChange={event => setPodiumSms({
                                 ...podiumSms,
                                 sms_features: {
                                   ...podiumSms.sms_features,
                                   [block.featureKey]: event.target.checked,
                                 },
                               })}
                             />
                             <span className="text-[8px] font-black uppercase tracking-widest text-app-text">Enabled</span>
                           </label>
                           <button
                             onClick={() => setPodiumSms({...podiumSms, templates: {...podiumSms.templates, [block.key]: PODIUM_TEMPLATE_DEFAULTS[block.key]}})}
                             className="text-[8px] font-black uppercase tracking-widest text-app-accent hover:text-app-text transition-colors"
                           >
                             Reset
                           </button>
                         </div>
                      </div>
                      {block.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {block.tags.map((tag) => (
                            <button
                              key={`${block.key}-${tag.token}`}
                              type="button"
                              onClick={() => insertSmsTag(block.key, tag.token)}
                              className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted transition hover:border-app-accent hover:text-app-accent"
                            >
                              {tag.label} <span className="normal-case tracking-normal">{tag.token}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <textarea
                        className="ui-input w-full min-h-[100px] p-4 text-xs font-medium leading-relaxed border-app-border/60"
                        value={podiumSms.templates[block.key]}
                        onChange={e => setPodiumSms({...podiumSms, templates: {...podiumSms.templates, [block.key]: e.target.value}})}
                      />
                   </div>
                 ))}
              </div>
           </div>

           <div className="pt-10 border-t border-app-border/40">
              <div className="flex items-center justify-between mb-4">
                 <div>
                   <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">Operational Email Templates</h4>
                   <p className="mt-2 text-xs font-medium text-app-text-muted">Delivered through Store Email. Subject and HTML remain editable independently.</p>
                 </div>
                 <Info size={14} className="text-app-text-muted" />
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                {OPERATIONAL_EMAIL_TEMPLATE_BLOCKS.map((block) => (
                  <div key={block.subjectKey} className="ui-card ui-tint-neutral p-5 space-y-3">
                    <div className="flex justify-between items-start gap-3">
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">{block.label}</span>
                        <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">{block.description}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPodiumSms({
                          ...podiumSms,
                          email_templates: {
                            ...podiumSms.email_templates,
                            [block.subjectKey]: OPERATIONAL_EMAIL_TEMPLATE_DEFAULTS[block.subjectKey],
                            [block.bodyKey]: OPERATIONAL_EMAIL_TEMPLATE_DEFAULTS[block.bodyKey],
                          },
                        })}
                        className="shrink-0 text-[8px] font-black uppercase tracking-widest text-app-accent hover:text-app-text transition-colors"
                      >
                        Reset
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {block.tags.map((tag) => (
                        <button
                          key={`${block.subjectKey}-${tag.token}`}
                          type="button"
                          onClick={() => insertEmailTag(block.bodyKey, tag.token)}
                          className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted transition hover:border-app-accent hover:text-app-accent"
                        >
                          {tag.label} <span className="normal-case tracking-normal">{tag.token}</span>
                        </button>
                      ))}
                    </div>
                    <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Subject
                      <input
                        className="ui-input mt-2 w-full p-3 text-xs font-medium normal-case tracking-normal"
                        value={podiumSms.email_templates[block.subjectKey]}
                        onChange={(event) => setPodiumSms({
                          ...podiumSms,
                          email_templates: {
                            ...podiumSms.email_templates,
                            [block.subjectKey]: event.target.value,
                          },
                        })}
                      />
                    </label>
                    <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      HTML body
                      <textarea
                        className="ui-input mt-2 w-full min-h-[140px] p-4 font-mono text-[11px] font-medium leading-relaxed normal-case tracking-normal"
                        value={podiumSms.email_templates[block.bodyKey]}
                        onChange={(event) => setPodiumSms({
                          ...podiumSms,
                          email_templates: {
                            ...podiumSms.email_templates,
                            [block.bodyKey]: event.target.value,
                          },
                        })}
                      />
                    </label>
                  </div>
                ))}
              </div>
           </div>

           <div className="pt-10 border-t border-app-border/40">
              <div className="mb-4">
                <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">Review Request Messages</h4>
                <p className="mt-2 text-xs font-medium text-app-text-muted">Podium delivers the text or email five days after fulfillment. Keep <code>{"{review_url}"}</code> in both message bodies.</p>
              </div>
              <div className="ui-card ui-tint-neutral p-5 space-y-4">
                <div className="flex flex-wrap gap-2">
                  {[
                    { token: "{first_name}", label: "First name" },
                    { token: "{transaction_ref}", label: "Transaction" },
                    { token: "{store_name}", label: "Store name" },
                    { token: "{review_url}", label: "Review link" },
                  ].map((tag) => (
                    <button
                      key={`review-${tag.token}`}
                      type="button"
                      onClick={() => insertReviewTag("sms_body", tag.token)}
                      className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted transition hover:border-app-accent hover:text-app-accent"
                    >
                      {tag.label} <span className="normal-case tracking-normal">{tag.token}</span>
                    </button>
                  ))}
                </div>
                <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Podium SMS body
                  <textarea
                    className="ui-input mt-2 w-full min-h-[100px] p-4 text-xs font-medium leading-relaxed normal-case tracking-normal"
                    value={podiumSms.review_templates.sms_body}
                    onChange={(event) => setPodiumSms({
                      ...podiumSms,
                      review_templates: { ...podiumSms.review_templates, sms_body: event.target.value },
                    })}
                  />
                </label>
                <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Podium email subject
                  <input
                    className="ui-input mt-2 w-full p-3 text-xs font-medium normal-case tracking-normal"
                    value={podiumSms.review_templates.email_subject}
                    onChange={(event) => setPodiumSms({
                      ...podiumSms,
                      review_templates: { ...podiumSms.review_templates, email_subject: event.target.value },
                    })}
                  />
                </label>
                <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Podium email body
                  <textarea
                    className="ui-input mt-2 w-full min-h-[140px] p-4 text-xs font-medium leading-relaxed normal-case tracking-normal"
                    value={podiumSms.review_templates.email_body}
                    onChange={(event) => setPodiumSms({
                      ...podiumSms,
                      review_templates: { ...podiumSms.review_templates, email_body: event.target.value },
                    })}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setPodiumSms({ ...podiumSms, review_templates: REVIEW_TEMPLATE_DEFAULTS })}
                  className="text-[9px] font-black uppercase tracking-widest text-app-accent hover:text-app-text"
                >
                  Reset review messages
                </button>
              </div>
           </div>

           <div className="pt-10 border-t border-app-border/40">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">Receipt Delivery Messages</h4>
                  <p className="mt-2 text-xs font-medium text-app-text-muted">These edit the email subject and Podium MMS caption. The authoritative receipt body and image remain controlled by Receipt Settings.</p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 group">
                  <div className={`h-4 w-4 rounded-md border-2 flex items-center justify-center transition-all ${podiumSms.sms_features.receipts ? 'bg-app-accent border-app-accent text-white' : 'border-app-border group-hover:border-app-accent'}`}>
                    {podiumSms.sms_features.receipts && <CheckCircle2 size={10} />}
                  </div>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={podiumSms.sms_features.receipts}
                    onChange={event => setPodiumSms({
                      ...podiumSms,
                      sms_features: { ...podiumSms.sms_features, receipts: event.target.checked },
                    })}
                  />
                  <span className="text-[9px] font-black uppercase tracking-widest text-app-text">Text receipts enabled</span>
                </label>
              </div>
              <div className="ui-card ui-tint-neutral p-5 space-y-4">
                <div className="flex flex-wrap gap-2">
                  {[
                    { token: "{store_name}", label: "Store name" },
                    { token: "{receipt_ref}", label: "Receipt #" },
                    { token: "{receipt_type}", label: "Receipt type" },
                    { token: "{customer_name}", label: "Customer" },
                    { token: "{customer_code}", label: "Customer #" },
                  ].map((tag) => (
                    <button
                      key={`receipt-${tag.token}`}
                      type="button"
                      onClick={() => insertReceiptTag("sms_caption", tag.token)}
                      className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted transition hover:border-app-accent hover:text-app-accent"
                    >
                      {tag.label} <span className="normal-case tracking-normal">{tag.token}</span>
                    </button>
                  ))}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {([
                    ["sms_caption", "Receipt MMS caption"],
                    ["gift_sms_caption", "Gift receipt MMS caption"],
                    ["email_subject", "Receipt email subject"],
                    ["gift_email_subject", "Gift receipt email subject"],
                  ] as Array<[ReceiptTemplateKey, string]>).map(([key, label]) => (
                    <label key={key} className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      {label}
                      <textarea
                        className="ui-input mt-2 w-full min-h-[86px] p-3 text-xs font-medium leading-relaxed normal-case tracking-normal"
                        value={podiumSms.receipt_templates[key]}
                        onChange={(event) => setPodiumSms({
                          ...podiumSms,
                          receipt_templates: { ...podiumSms.receipt_templates, [key]: event.target.value },
                        })}
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setPodiumSms({ ...podiumSms, receipt_templates: RECEIPT_TEMPLATE_DEFAULTS })}
                  className="text-[9px] font-black uppercase tracking-widest text-app-accent hover:text-app-text"
                >
                  Reset receipt messages
                </button>
              </div>
           </div>

           {/* WEB CHAT */}
           <div className="pt-10 border-t border-app-border/40">
              <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text mb-4">Web Chat Storefront Widget</h4>
              <p className="text-xs text-app-text-muted mb-4 leading-relaxed font-medium">
                Embed code provisioned from your Podium Control Panel. When <code className="bg-app-surface-2 px-1">VITE_STOREFRONT_EMBEDS</code> is active, this snippet is safely injected into public-facing terminals.
              </p>
              <textarea
                 placeholder="<script>... podium.widget ...</script>"
                 className="ui-input w-full min-h-[120px] p-4 font-mono text-[10px]"
                 value={podiumSms.widget_snippet_html}
                 onChange={e => setPodiumSms({...podiumSms, widget_snippet_html: e.target.value})}
              />
           </div>
        </div>

        <div className="mt-12 pt-8 border-t border-app-border/40">
           <button
             onClick={() => void savePodiumSmsSettings()}
             disabled={busy}
             className="w-full md:w-auto ui-btn-primary h-14 px-12 text-xs font-black uppercase tracking-[0.2em] shadow-xl shadow-violet-600/20 hover:scale-[1.02] transition-all"
           >
              {busy ? "Applying Changes..." : "Save Podium configuration"}
           </button>
        </div>
      </section>
    </div>
  );
};

export default PodiumSettingsPanel;
