import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Mail, MessageSquareText, Save, Send } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import type { ReceiptMessageTemplates } from "./useCustomerCommunicationSettings";
import { useCustomerCommunicationSettings } from "./useCustomerCommunicationSettings";

type TemplateKey = keyof ReceiptMessageTemplates;

const FIELDS: Array<[TemplateKey, string]> = [
  ["sms_caption", "Receipt MMS caption"],
  ["gift_sms_caption", "Gift receipt MMS caption"],
  ["email_subject", "Receipt email subject"],
  ["gift_email_subject", "Gift receipt email subject"],
];

type EmailDeliveryReadiness = {
  settings: { enabled: boolean };
  credentials_configured: boolean;
};

type PodiumDeliveryReadiness = {
  credentials_configured: boolean;
  location_uid_configured: boolean;
  receipt_sms_enabled: boolean;
};

type EmailDeliveryHealth = {
  reachable: boolean;
  smtp_reachable: boolean;
  imap_reachable: boolean;
  latency_ms: number;
  message: string;
};

type PodiumDeliveryHealth = {
  reachable: boolean;
  latency_ms: number;
  message: string;
};

export default function ReceiptDeliverySettingsCard({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { settings, setSettings, loading, saving, savePatch } =
    useCustomerCommunicationSettings(baseUrl);
  const [emailReadiness, setEmailReadiness] =
    useState<EmailDeliveryReadiness | null>(null);
  const [podiumReadiness, setPodiumReadiness] =
    useState<PodiumDeliveryReadiness | null>(null);
  const [emailHealth, setEmailHealth] =
    useState<EmailDeliveryHealth | null>(null);
  const [podiumHealth, setPodiumHealth] =
    useState<PodiumDeliveryHealth | null>(null);
  const [readinessLoaded, setReadinessLoaded] = useState(false);

  const loadDeliveryReadiness = useCallback(async () => {
    setReadinessLoaded(false);
    const headers = backofficeHeaders() as Record<string, string>;
    const [emailResult, podiumResult, emailHealthResult, podiumHealthResult] =
      await Promise.allSettled([
        fetch(`${baseUrl}/api/settings/email`, {
          headers,
          cache: "no-store",
        }).then(async (response) => {
          if (!response.ok) throw new Error("email-readiness");
          return (await response.json()) as EmailDeliveryReadiness;
        }),
        fetch(`${baseUrl}/api/settings/podium/readiness`, {
          headers,
          cache: "no-store",
        }).then(async (response) => {
          if (!response.ok) throw new Error("podium-readiness");
          return (await response.json()) as PodiumDeliveryReadiness;
        }),
        fetch(`${baseUrl}/api/mailbox/health`, {
          headers,
          cache: "no-store",
        }).then(async (response) => {
          if (!response.ok) throw new Error("email-health");
          return (await response.json()) as EmailDeliveryHealth;
        }),
        fetch(`${baseUrl}/api/settings/podium/health`, {
          headers,
          cache: "no-store",
        }).then(async (response) => {
          if (!response.ok) throw new Error("podium-health");
          return (await response.json()) as PodiumDeliveryHealth;
        }),
      ]);
    setEmailReadiness(
      emailResult.status === "fulfilled" ? emailResult.value : null,
    );
    setPodiumReadiness(
      podiumResult.status === "fulfilled" ? podiumResult.value : null,
    );
    setEmailHealth(
      emailHealthResult.status === "fulfilled" ? emailHealthResult.value : null,
    );
    setPodiumHealth(
      podiumHealthResult.status === "fulfilled"
        ? podiumHealthResult.value
        : null,
    );
    setReadinessLoaded(true);
  }, [backofficeHeaders, baseUrl]);

  useEffect(() => {
    void loadDeliveryReadiness();
  }, [loadDeliveryReadiness]);

  const updateTemplate = (key: TemplateKey, value: string) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            receipt_templates: { ...current.receipt_templates, [key]: value },
          }
        : current,
    );
  };

  if (loading || !settings) return null;

  const allInherited = Object.values(settings.receipt_templates).every(
    (value) => !value.trim(),
  );
  const emailConfigured = Boolean(
    emailReadiness?.settings.enabled &&
      emailReadiness.credentials_configured,
  );
  const emailReady = Boolean(emailConfigured && emailHealth?.smtp_reachable);
  const podiumConfigured = Boolean(
    podiumReadiness?.credentials_configured &&
      podiumReadiness.location_uid_configured,
  );
  const podiumReady = Boolean(
    podiumConfigured &&
      podiumReadiness?.receipt_sms_enabled &&
      podiumHealth?.reachable,
  );
  const podiumSavePending = Boolean(
    podiumReadiness &&
      settings.sms_features.receipts !== podiumReadiness.receipt_sms_enabled,
  );

  const saveDeliverySettings = async () => {
    const saved = await savePatch(
      {
        sms_features: { receipts: settings.sms_features.receipts },
        receipt_templates: settings.receipt_templates,
      },
      "Digital receipt delivery settings saved.",
    );
    if (saved) await loadDeliveryReadiness();
  };

  return (
    <section className="ui-card p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-app-border pb-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-2 text-app-accent">
            <Send className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Digital receipt delivery
            </h3>
            <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-app-text-muted">
              Podium sends text and image receipts; Store Email sends email receipts. The
              authoritative receipt content remains in the ReceiptLine templates above.
            </p>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border-2 ${
              settings.sms_features.receipts
                ? "border-app-accent bg-app-accent text-white"
                : "border-app-border"
            }`}
          >
            {settings.sms_features.receipts ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden />
            ) : null}
          </span>
          <input
            type="checkbox"
            checked={settings.sms_features.receipts}
            onChange={(event) =>
              setSettings((current) =>
                current
                  ? {
                      ...current,
                      sms_features: {
                        ...current.sms_features,
                        receipts: event.target.checked,
                      },
                    }
                  : current,
              )
            }
            className="sr-only"
          />
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
            Text receipts enabled
          </span>
        </label>
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-2" aria-label="Digital receipt provider status">
        <div className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text">
              <Mail className="h-4 w-4 text-app-accent" aria-hidden />
              Store Email
            </span>
            <span
              className={`ui-pill text-[10px] font-black uppercase tracking-widest ${
                emailReady
                  ? "bg-app-success/10 text-app-success"
                  : "bg-app-warning/10 text-app-warning"
              }`}
            >
              {!readinessLoaded
                ? "Checking"
                : !emailReadiness
                  ? "Unavailable"
                  : !emailConfigured
                    ? "Setup needed"
                    : !emailHealth?.smtp_reachable
                      ? "Needs attention"
                      : "Ready"}
            </span>
          </div>
          <p className="mt-2 text-[10px] font-semibold leading-relaxed text-app-text-muted">
            {!readinessLoaded
              ? "Checking the current Store Email settings..."
              : !emailReadiness
              ? "Status unavailable. Check Settings → Email."
              : !emailReadiness.settings.enabled
                ? "Store Email is turned off in Settings → Email."
                : !emailReadiness.credentials_configured
                  ? "Save the mailbox credentials in Settings → Email."
                  : !emailHealth
                    ? "The Store Email health check could not run."
                    : !emailHealth.smtp_reachable
                      ? `SMTP is not reachable. ${emailHealth.message}`
                      : emailHealth.imap_reachable
                        ? `SMTP and inbox are reachable · ${emailHealth.latency_ms} ms.`
                        : `Receipt email SMTP is ready · ${emailHealth.latency_ms} ms. Inbox sync still needs attention.`
            }
          </p>
        </div>

        <div className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text">
              <MessageSquareText className="h-4 w-4 text-app-accent" aria-hidden />
              Podium
            </span>
            <span
              className={`ui-pill text-[10px] font-black uppercase tracking-widest ${
                podiumReady
                  ? "bg-app-success/10 text-app-success"
                  : "bg-app-warning/10 text-app-warning"
              }`}
            >
              {podiumSavePending
                ? "Save pending"
                : !readinessLoaded
                  ? "Checking"
                  : !podiumReadiness
                    ? "Unavailable"
                    : !podiumConfigured ||
                        !podiumReadiness.receipt_sms_enabled
                      ? "Setup needed"
                      : !podiumHealth?.reachable
                        ? "Needs attention"
                        : "Ready"}
            </span>
          </div>
          <p className="mt-2 text-[10px] font-semibold leading-relaxed text-app-text-muted">
            {podiumSavePending
              ? `Save delivery settings to turn receipt texts ${settings.sms_features.receipts ? "on" : "off"}.`
              : !readinessLoaded
                ? "Checking the current Podium receipt settings..."
                : !podiumReadiness
                  ? "Status unavailable. Check Settings → Podium."
                  : !podiumReadiness.credentials_configured
                    ? "Connect the Podium account in Settings → Podium."
                    : !podiumReadiness.location_uid_configured
                      ? "Select and save the sending location in Settings → Podium."
                      : !podiumReadiness.receipt_sms_enabled
                        ? "Podium is connected; turn on Text receipts and save below."
                        : !podiumHealth
                          ? "The Podium health check could not run."
                          : !podiumHealth.reachable
                            ? `Podium is not reachable. ${podiumHealth.message}`
                            : `Authenticated Podium API reachable · ${podiumHealth.latency_ms} ms.`
            }
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(([key, label]) => (
          <label
            key={key}
            className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted"
          >
            {label}
            <textarea
              value={settings.receipt_templates[key]}
              placeholder={settings.receipt_templates_effective[key]}
              onChange={(event) => updateTemplate(key, event.target.value)}
              className="ui-input mt-2 min-h-24 w-full resize-y p-3 text-sm font-medium normal-case tracking-normal"
            />
          </label>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveDeliverySettings()}
          className="ui-btn-primary inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden />
          {saving ? "Saving..." : "Save Delivery Settings"}
        </button>
        <button
          type="button"
          disabled={allInherited}
          onClick={() =>
            setSettings((current) =>
              current
                ? {
                    ...current,
                    receipt_templates: {
                      sms_caption: "",
                      gift_sms_caption: "",
                      email_subject: "",
                      gift_email_subject: "",
                    },
                  }
                : current,
            )
          }
          className="ui-btn-secondary h-11 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
        >
          Use Riverside Defaults
        </button>
      </div>
    </section>
  );
}
