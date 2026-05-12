import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  RefreshCw,
  Server,
  Settings,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import helcimIcon from "../../assets/images/brands/Helcim_Icon.png";
import helcimLogo from "../../assets/images/brands/Helcim_Logo.png";

interface HelcimProviderStatus {
  enabled: boolean;
  api_token_configured: boolean;
  terminal_1_device_configured?: boolean;
  terminal_2_device_configured?: boolean;
  terminal_payments_ready: boolean;
  live_terminal_payments_ready: boolean;
  simulator_enabled: boolean;
  webhook_secret_configured: boolean;
  terminal_1_device_code_suffix?: string | null;
  terminal_2_device_code_suffix?: string | null;
  api_base_host: string;
  missing_config: string[];
}

interface PaymentProviderSettings {
  active_provider: "helcim";
  helcim: HelcimProviderStatus;
}

const HelcimSettingsPanel: React.FC = () => {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  const webhookPath = "/api/webhooks/helcim";
  const webhookDeliveryUrl = `${baseUrl.replace(/\/$/, "")}${webhookPath}`;
  const webhookUrlWarning = webhookDeliveryUrl.startsWith("https://")
    ? null
    : "Use the store public HTTPS ROS API URL in Helcim. Do not use localhost, 127.0.0.1, or this local workstation URL as the Helcim delivery URL.";

  const [helcimStatus, setHelcimStatus] =
    useState<HelcimProviderStatus | null>(null);
  const [helcimLoading, setHelcimLoading] = useState(true);
  const [helcimError, setHelcimError] = useState<string | null>(null);
  const [providerSettings, setProviderSettings] =
    useState<PaymentProviderSettings | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [simulatorEnabled, setSimulatorEnabled] = useState(false);

  const fetchProviderStatus = useCallback(async () => {
    setHelcimLoading(true);
    setHelcimError(null);
    try {
      const res = await fetch(`${baseUrl}/api/payments/providers/active`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        throw new Error("Payment provider status is unavailable.");
      }
      const settings = (await res.json()) as PaymentProviderSettings;
      setProviderSettings(settings);
      setHelcimStatus(settings.helcim);
    } catch (error) {
      setProviderSettings(null);
      setHelcimStatus(null);
      setHelcimError(
        error instanceof Error
          ? error.message
          : "Payment provider status is unavailable.",
      );
    } finally {
      setHelcimLoading(false);
    }
  }, [baseUrl, backofficeHeaders]);

  const saveActiveProvider = useCallback(async () => {
    setProviderSaving(true);
    setHelcimError(null);
    try {
      const res = await fetch(`${baseUrl}/api/payments/providers/active`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ active_provider: "helcim" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Could not save active provider.");
      }
      const settings = (await res.json()) as PaymentProviderSettings;
      setProviderSettings(settings);
      setHelcimStatus(settings.helcim);
    } catch (error) {
      setHelcimError(
        error instanceof Error
          ? error.message
          : "Could not save active provider.",
      );
    } finally {
      setProviderSaving(false);
    }
  }, [backofficeHeaders, baseUrl]);

  const saveHelcimSimulator = useCallback(async () => {
    setConfigSaving(true);
    setHelcimError(null);
    try {
      const payload: Record<string, string | boolean> = {
        simulator_enabled: simulatorEnabled,
      };
      const res = await fetch(`${baseUrl}/api/payments/providers/helcim/config`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Could not save Helcim configuration.");
      }
      const status = (await res.json()) as HelcimProviderStatus;
      setHelcimStatus(status);
      setProviderSettings((current) =>
        current
          ? {
              ...current,
              helcim: status,
            }
          : current,
      );
      setSimulatorEnabled(status.simulator_enabled);
    } catch (error) {
      setHelcimError(
        error instanceof Error
          ? error.message
          : "Could not save Helcim test mode.",
      );
    } finally {
      setConfigSaving(false);
    }
  }, [
    backofficeHeaders,
    baseUrl,
    simulatorEnabled,
  ]);

  useEffect(() => {
    void fetchProviderStatus();
  }, [fetchProviderStatus]);

  useEffect(() => {
    if (helcimStatus) {
      setSimulatorEnabled(helcimStatus.simulator_enabled);
    }
  }, [helcimStatus]);

  if (helcimLoading && !helcimStatus) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent" />
      </div>
    );
  }

  const missingConfig = helcimStatus?.missing_config ?? [];
  const apiConfigured = Boolean(helcimStatus?.api_token_configured);
  const terminalReady = Boolean(helcimStatus?.terminal_payments_ready);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-4 flex items-center">
            <IntegrationBrandLogo
              brand="helcim"
              kind="wordmark"
              className="inline-flex rounded-2xl border border-app-border bg-white px-4 py-2 shadow-sm"
              imageClassName="h-10 w-auto object-contain"
            />
          </div>
          <h2 className="text-3xl font-black italic tracking-tighter text-app-text">
            Helcim Configuration
          </h2>
          <p className="mt-2 max-w-2xl text-sm font-medium text-app-text-muted">
            Use this page for card processor setup only. Daily payment review,
            batch sync, fees, reconciliation, and deposits live in Payments.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchProviderStatus()}
          className="flex min-h-11 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-6 text-sm font-bold text-app-text shadow-sm transition-all hover:bg-app-surface-2"
        >
          <RefreshCw
            size={14}
            className={
              helcimLoading ? "animate-spin text-app-accent" : "text-app-accent"
            }
          />
          Check Connection
        </button>
      </header>

      <section className="ui-card ui-tint-neutral overflow-hidden">
        <div className="border-b border-app-border bg-app-surface-2 px-6 py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Active Card Provider
              </h3>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                ROS uses Helcim as the card rail. The API key enables payments
                reporting and batch/transaction sync; terminal payments need
                Terminal 1 and Terminal 2 device codes.
              </p>
            </div>
            <button
              type="button"
              disabled={providerSaving || helcimLoading}
              onClick={() => void saveActiveProvider()}
              className="min-h-11 rounded-xl bg-app-accent px-4 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 transition-all disabled:opacity-50"
            >
              Use Helcim
            </button>
          </div>
          {providerSettings && !providerSettings.helcim.enabled ? (
            <p className="mt-3 text-xs font-bold text-app-warning">
              Helcim API access is not configured yet. Add the API key below to
              enable payment reporting and sync.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-app-border bg-white p-2 shadow-sm">
              <img
                src={helcimIcon}
                alt=""
                className="h-full w-auto max-w-none rounded-lg object-cover"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-3">
                <img
                  src={helcimLogo}
                  alt="Helcim"
                  className="h-6 w-auto max-w-[120px] object-contain"
                />
                <span className="rounded-full bg-app-surface-2 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted ring-1 ring-app-border">
                  Primary card rail
                </span>
              </div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Connection Health
              </h3>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Riverside checks whether server-side Helcim credentials and the
                optional terminal setup are available. Secrets are not shown
                here.
              </p>
            </div>
          </div>

          <div className="grid gap-3 text-xs font-semibold text-app-text-muted sm:grid-cols-3 lg:min-w-[520px]">
            <StatusTile
              icon={
                apiConfigured ? (
                  <CheckCircle2 size={13} className="text-app-success" />
                ) : (
                  <AlertTriangle size={13} className="text-app-warning" />
                )
              }
              label="API access"
              value={
                helcimLoading
                  ? "Checking..."
                  : helcimError
                    ? "Unavailable"
                    : apiConfigured
                      ? "Configured"
                      : "Not configured"
              }
            />
            <StatusTile
              icon={<CreditCard size={13} className="text-app-info" />}
              label="Terminal"
              value={
                helcimLoading
                  ? "Checking..."
                  : helcimStatus?.terminal_1_device_configured
                    ? `T1 •••• ${helcimStatus.terminal_1_device_code_suffix ?? "set"}`
                    : helcimStatus?.terminal_2_device_configured
                      ? `T2 •••• ${helcimStatus.terminal_2_device_code_suffix ?? "set"}`
                      : "Not configured"
              }
            />
            <StatusTile
              icon={<Server size={13} className="text-app-info" />}
              label="API host"
              value={
                helcimLoading
                  ? "Checking..."
                  : helcimStatus?.api_base_host || "Unavailable"
              }
            />
          </div>
        </div>

        <div className="border-t border-app-border bg-app-surface-2 px-6 py-4">
          <p className="text-xs font-semibold text-app-text-muted">
            {helcimError
              ? helcimError
              : missingConfig.length
                ? `Missing configuration: ${missingConfig.join(", ")}`
                : terminalReady
                  ? "Helcim API access and terminal device codes are configured. Webhook updates are optional for local POS."
                  : "Helcim API access is configured. Add Terminal 1 and Terminal 2 device codes only if ROS will start in-store terminal payments."}
          </p>
        </div>
      </section>

      <section>
        <div className="ui-card ui-tint-info p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-xl border border-app-border bg-app-surface p-2 text-app-info">
              <Settings size={18} />
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Helcim Configuration
            </h3>
          </div>
          <div className="space-y-3">
            <ConfigRow
              label="API token"
              value={
                helcimStatus?.api_token_configured
                  ? "Configured on server"
                  : "Not configured"
              }
              ready={Boolean(helcimStatus?.api_token_configured)}
              detail="Used for Helcim API and card payment requests. Secret value is not shown."
            />
            <ConfigRow
              label="Terminal 1 device code"
              value={
                helcimStatus?.terminal_1_device_configured
                  ? `Configured •••• ${helcimStatus.terminal_1_device_code_suffix ?? "set"}`
                  : "Not configured"
              }
              ready={Boolean(helcimStatus?.terminal_1_device_configured)}
              detail="Used by Register #1 by default and available to Registers #3/#4 when selected."
            />
            <ConfigRow
              label="Terminal 2 device code"
              value={
                helcimStatus?.terminal_2_device_configured
                  ? `Configured •••• ${helcimStatus.terminal_2_device_code_suffix ?? "set"}`
                  : "Not configured"
              }
              ready={Boolean(helcimStatus?.terminal_2_device_configured)}
              detail="Used by Register #2 by default and available to Registers #3/#4 when selected."
            />
            <ConfigRow
              label="Live terminal payments"
              value={
                helcimStatus?.live_terminal_payments_ready
                  ? "Ready"
                  : "Not ready"
              }
              ready={Boolean(helcimStatus?.live_terminal_payments_ready)}
              detail="Requires API token, Terminal 1, and Terminal 2. Webhook updates are optional for local POS."
            />
            <ConfigRow
              label="Terminal routing"
              value="R1 -> T1 | R2 -> T2 | R3/R4 choose"
              ready={true}
              detail="Routing follows Riverside register policy. Daily readiness and in-use state live in Payments."
            />
            <ConfigRow
              label="Optional webhook signing secret"
              value={
                helcimStatus?.webhook_secret_configured
                  ? "Configured on server"
                  : "Not configured"
              }
              ready={Boolean(helcimStatus?.webhook_secret_configured)}
              detail="Only needed if Helcim can reach a public ROS webhook URL."
              warnWhenNotReady={false}
            />
            <ConfigRow
              label="API host"
              value={helcimStatus?.api_base_host || "Unavailable"}
              ready={Boolean(helcimStatus?.api_base_host)}
              detail="Server endpoint used for Helcim API calls."
            />
            <ConfigRow
              label="Test mode"
              value={helcimStatus?.simulator_enabled ? "Enabled" : "Off"}
              ready={!helcimStatus?.simulator_enabled}
              detail={
                helcimStatus?.simulator_enabled
                  ? "Simulator mode is active. Live Helcim payments are not being used."
                  : "Live configuration is expected."
              }
              warnWhenNotReady={false}
            />
          </div>
          <div className="mt-5 rounded-2xl border border-app-border bg-app-surface p-4">
            <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-app-text">
              Webhook Setup
            </h4>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Delivery path
                </div>
                <p className="mt-2 break-all font-mono text-xs font-semibold text-app-text">
                  {webhookDeliveryUrl}
                </p>
                <p className="mt-3 text-xs font-semibold leading-5 text-app-text-muted">
                  Paste the public HTTPS version of this URL into Helcim. ROS
                  handles signed Helcim terminal updates at{" "}
                  <span className="font-mono text-app-text">{webhookPath}</span>.
                </p>
                {webhookUrlWarning ? (
                  <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-bold leading-5 text-app-warning">
                    {webhookUrlWarning}
                  </p>
                ) : null}
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Required in Helcim
                </div>
                <ul className="mt-3 space-y-2 text-xs font-semibold text-app-text-muted">
                  <li>
                    Signing secret:{" "}
                    <span className="font-black text-app-text">
                      {helcimStatus?.webhook_secret_configured
                        ? "Configured"
                        : "Not configured"}
                    </span>
                  </li>
                  <li>Event: cardTransaction</li>
                  <li>Event: terminalCancel</li>
                </ul>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-app-border bg-app-surface-2 p-4 text-xs font-semibold leading-5 text-app-text-muted">
              <p>
                <span className="font-black text-app-text">
                  Webhook received by ROS
                </span>{" "}
                means a signed Helcim delivery reached this server and was stored
                for review.
              </p>
              <p className="mt-2">
                <span className="font-black text-app-text">
                  Provider event attached to ROS checkout
                </span>{" "}
                means ROS matched that stored provider event to one safe pending
                terminal attempt. Webhook delivery does not by itself create ROS
                payment ledger rows.
              </p>
              <p className="mt-2">
                Verify delivery and unmatched events in Payments &gt; Health,
                Payment Updates, and Helcim Terminal Review.
              </p>
            </div>
          </div>
          <div className="mt-5 rounded-2xl border border-app-border bg-app-surface p-4">
            <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-app-text">
              Test Mode
            </h4>
            <label className="flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
              <input
                type="checkbox"
                checked={simulatorEnabled}
                onChange={(event) => setSimulatorEnabled(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-app-border text-app-accent"
              />
              <span>
                <span className="block text-xs font-black uppercase tracking-widest text-app-text">
                  Test mode
                </span>
                <span className="block text-xs font-semibold leading-5 text-app-text-muted">
                  Use only for local testing. Turn off for live Helcim payments.
                </span>
              </span>
            </label>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs font-semibold leading-5 text-app-text-muted">
                Test mode is only for local checkout testing. Keep it off for
                live card payments.
              </p>
              <button
                type="button"
                disabled={configSaving}
                onClick={() => void saveHelcimSimulator()}
                className="min-h-11 rounded-xl bg-app-accent px-5 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 transition-all disabled:opacity-50"
              >
                {configSaving ? "Saving..." : "Save Test Mode"}
              </button>
            </div>
          </div>
          <div className="mt-5">
            <IntegrationCredentialsCard
              baseUrl={baseUrl}
              integrationKey="helcim"
              title="Helcim Credentials"
              description="Save, replace, or clear Helcim credentials here. Credentials are encrypted and hidden after save."
              fields={[
                {
                  key: "api_token",
                  label: "API token",
                  help: "Required for Helcim API and card payment requests.",
                },
                {
                  key: "terminal_1_device_code",
                  label: "Terminal 1 device code",
                  help: "Default for Register #1. Registers #3/#4 can choose it at checkout.",
                },
                {
                  key: "terminal_2_device_code",
                  label: "Terminal 2 device code",
                  help: "Default for Register #2. Registers #3/#4 can choose it at checkout.",
                },
                {
                  key: "webhook_secret",
                  label: "Optional webhook signing secret",
                  help: "Only needed if Helcim can reach a public ROS webhook URL.",
                },
                {
                  key: "api_base_url",
                  label: "API host",
                  type: "url",
                  placeholder: "https://api.helcim.com/v2",
                },
              ]}
              onSaved={fetchProviderStatus}
            />
          </div>
          <p className="mt-5 rounded-xl border border-app-border bg-app-surface px-4 py-3 text-xs font-semibold leading-5 text-app-text-muted">
            Credential values are encrypted server-side and are intentionally
            hidden after save. Use{" "}
            <span className="font-black text-app-text">Check Connection</span>.
          </p>
        </div>
      </section>
    </div>
  );
};

function StatusTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        {icon}
        {label}
      </div>
      <p className="truncate font-black text-app-text">{value}</p>
    </div>
  );
}

function ConfigRow({
  label,
  value,
  ready,
  detail,
  warnWhenNotReady = true,
}: {
  label: string;
  value: string;
  ready: boolean;
  detail: string;
  warnWhenNotReady?: boolean;
}) {
  const icon = ready ? (
    <CheckCircle2 size={14} className="text-app-success" />
  ) : warnWhenNotReady ? (
    <AlertTriangle size={14} className="text-app-warning" />
  ) : (
    <CheckCircle2 size={14} className="text-app-text-muted" />
  );

  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-app-text">
            {icon}
            {label}
          </div>
          <p className="text-xs font-semibold leading-5 text-app-text-muted">
            {detail}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ring-1 ${
            ready
              ? "bg-app-success/10 text-app-success ring-app-success/20"
              : warnWhenNotReady
                ? "bg-app-warning/10 text-app-warning ring-app-warning/20"
                : "bg-app-surface-2 text-app-text-muted ring-app-border"
          }`}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

export default HelcimSettingsPanel;
