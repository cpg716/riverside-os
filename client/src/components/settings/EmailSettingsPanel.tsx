import { useCallback, useEffect, useState } from "react";
import { Mail, RefreshCw, Save, Send } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";

type EmailSettings = {
  enabled: boolean;
  from_email: string;
  from_name: string;
  reply_to_email: string;
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_folder: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: "ssl_tls" | "starttls";
  sync_enabled: boolean;
  sync_limit: number;
};

type EmailSettingsResponse = {
  settings: EmailSettings;
  credentials_configured: boolean;
};

type EmailSettingsPanelProps = {
  baseUrl: string;
};

export default function EmailSettingsPanel({ baseUrl }: EmailSettingsPanelProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [credentialsConfigured, setCredentialsConfigured] = useState(false);
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/email`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) throw new Error("email-settings");
      const data = (await res.json()) as EmailSettingsResponse;
      setSettings(data.settings);
      setCredentialsConfigured(Boolean(data.credentials_configured));
    } catch {
      toast("Email settings could not be loaded.", "error");
    }
  }, [backofficeHeaders, baseUrl, toast]);

  const loadSignature = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/mailbox/signature`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) return;
      const data = (await res.json()) as { signature_html?: string };
      setSignature(data.signature_html ?? "");
    } catch {
      // Signature is per logged-in staff member; keep settings usable if unavailable.
    }
  }, [backofficeHeaders, baseUrl]);

  useEffect(() => {
    void loadSettings();
    void loadSignature();
  }, [loadSettings, loadSignature]);

  const updateSetting = <K extends keyof EmailSettings>(
    key: K,
    value: EmailSettings[K],
  ) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveSettings = async () => {
    if (!settings || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/email`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Email settings could not be saved.", "error");
        return;
      }
      const data = (await res.json()) as EmailSettingsResponse;
      setSettings(data.settings);
      setCredentialsConfigured(Boolean(data.credentials_configured));
      toast("Email settings saved.", "success");
    } catch {
      toast("Email settings could not be saved.", "error");
    } finally {
      setBusy(false);
    }
  };

  const saveSignature = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/mailbox/signature`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ signature_html: signature }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Signature could not be saved.", "error");
        return;
      }
      toast("Email signature saved.", "success");
    } catch {
      toast("Email signature could not be saved.", "error");
    }
  };

  const syncInbox = async () => {
    if (syncBusy) return;
    setSyncBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/mailbox/sync`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Mailbox sync could not run.", "error");
        return;
      }
      const data = (await res.json()) as {
        fetched: number;
        inserted: number;
        matched_customers: number;
      };
      toast(
        `Mailbox synced: ${data.inserted} new, ${data.matched_customers} matched.`,
        "success",
      );
    } catch {
      toast("Mailbox sync could not run.", "error");
    } finally {
      setSyncBusy(false);
    }
  };

  if (!settings) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-30" />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-2">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
          <Mail className="h-7 w-7" aria-hidden />
        </div>
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
          Store Email
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
          Configure the Riverside mailbox used for automated customer email, customer
          message history, and the Operations Mailbox. SMS remains handled through Podium.
        </p>
      </header>

      <section className="ui-card max-w-5xl p-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-app-border pb-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              IONOS Mailbox
            </h3>
            <p className="mt-1 text-xs font-semibold leading-5 text-app-text-muted">
              Defaulted for info@riversidemens.com using IONOS IMAP and SMTP.
            </p>
          </div>
          <span
            className={`ui-pill text-[10px] font-black uppercase tracking-widest ${
              settings.enabled && credentialsConfigured
                ? "bg-app-success/10 text-app-success"
                : "bg-app-warning/10 text-app-warning"
            }`}
          >
            {settings.enabled && credentialsConfigured ? "Ready" : "Setup needed"}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-center gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => updateSetting("enabled", event.target.checked)}
              className="h-4 w-4 accent-app-accent"
            />
            <span className="text-xs font-black uppercase tracking-widest text-app-text">
              Enable store email sending and inbox sync
            </span>
          </label>
          <label className="flex items-center gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
            <input
              type="checkbox"
              checked={settings.sync_enabled}
              onChange={(event) =>
                updateSetting("sync_enabled", event.target.checked)
              }
              className="h-4 w-4 accent-app-accent"
            />
            <span className="text-xs font-black uppercase tracking-widest text-app-text">
              Pull inbound email into Operations Mailbox
            </span>
          </label>

          <Field
            label="From email"
            value={settings.from_email}
            onChange={(value) => updateSetting("from_email", value)}
          />
          <Field
            label="From name"
            value={settings.from_name}
            onChange={(value) => updateSetting("from_name", value)}
          />
          <Field
            label="Reply-to email"
            value={settings.reply_to_email}
            onChange={(value) => updateSetting("reply_to_email", value)}
          />
          <Field
            label="IMAP folder"
            value={settings.imap_folder}
            onChange={(value) => updateSetting("imap_folder", value)}
          />
          <Field
            label="IMAP host"
            value={settings.imap_host}
            onChange={(value) => updateSetting("imap_host", value)}
          />
          <NumberField
            label="IMAP port"
            value={settings.imap_port}
            onChange={(value) => updateSetting("imap_port", value)}
          />
          <Field
            label="SMTP host"
            value={settings.smtp_host}
            onChange={(value) => updateSetting("smtp_host", value)}
          />
          <NumberField
            label="SMTP port"
            value={settings.smtp_port}
            onChange={(value) => updateSetting("smtp_port", value)}
          />
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              SMTP security
            </span>
            <select
              value={settings.smtp_tls}
              onChange={(event) =>
                updateSetting(
                  "smtp_tls",
                  event.target.value === "starttls" ? "starttls" : "ssl_tls",
                )
              }
              className="ui-input h-11 w-full px-3 text-sm font-bold"
            >
              <option value="ssl_tls">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </label>
          <NumberField
            label="Inbox sync limit"
            value={settings.sync_limit}
            onChange={(value) => updateSetting("sync_limit", value)}
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-app-border pt-5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveSettings()}
            className="ui-btn-primary inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
          >
            <Save className="h-4 w-4" aria-hidden />
            {busy ? "Saving..." : "Save Email Settings"}
          </button>
          <button
            type="button"
            disabled={syncBusy || !settings.enabled || !credentialsConfigured}
            onClick={() => void syncInbox()}
            className="ui-btn-secondary inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncBusy ? "animate-spin" : ""}`} aria-hidden />
            {syncBusy ? "Syncing..." : "Sync Inbox Now"}
          </button>
        </div>
      </section>

      <IntegrationCredentialsCard
        baseUrl={baseUrl}
        integrationKey="email"
        title="IONOS email credentials"
        description="Save IMAP and SMTP credentials for info@riversidemens.com. Values are encrypted and hidden after save."
        fields={[
          { key: "imap_username", label: "IMAP username", type: "text" },
          { key: "imap_password", label: "IMAP password" },
          { key: "smtp_username", label: "SMTP username", type: "text" },
          { key: "smtp_password", label: "SMTP password" },
        ]}
        onSaved={loadSettings}
      />

      <section className="ui-card max-w-5xl p-6">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-2 text-app-accent">
            <Send className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              My email signature
            </h3>
            <p className="mt-1 text-xs font-semibold leading-5 text-app-text-muted">
              Appended to email you send from Customer Messages and Operations Mailbox.
            </p>
          </div>
        </div>
        <textarea
          value={signature}
          onChange={(event) => setSignature(event.target.value)}
          className="ui-input min-h-32 w-full resize-y p-3 text-sm"
          placeholder="<p>Thank you,<br>Riverside Men's Shop</p>"
        />
        <button
          type="button"
          onClick={() => void saveSignature()}
          className="ui-btn-secondary mt-4 inline-flex h-10 items-center gap-2 px-4 text-[10px] font-black uppercase tracking-widest"
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          Save Signature
        </button>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ui-input h-11 w-full px-3 text-sm font-bold"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        {label}
      </span>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(event) =>
          onChange(Number.parseInt(event.target.value || "0", 10))
        }
        className="ui-input h-11 w-full px-3 text-sm font-bold"
      />
    </label>
  );
}
