import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import helcimIcon from "../../assets/images/brands/Helcim_Icon.png";
import helcimLogo from "../../assets/images/brands/Helcim_Logo.png";

interface HelcimProviderStatus {
  enabled: boolean;
  device_configured: boolean;
  device_code_suffix?: string | null;
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

  const [helcimStatus, setHelcimStatus] =
    useState<HelcimProviderStatus | null>(null);
  const [helcimLoading, setHelcimLoading] = useState(true);
  const [helcimError, setHelcimError] = useState<string | null>(null);
  const [providerSettings, setProviderSettings] =
    useState<PaymentProviderSettings | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);

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

  useEffect(() => {
    void fetchProviderStatus();
  }, [fetchProviderStatus]);

  if (helcimLoading && !helcimStatus) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent" />
      </div>
    );
  }

  const missingConfig = helcimStatus?.missing_config ?? [];
  const configured = Boolean(helcimStatus?.enabled);

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
                POS card reader payments use Helcim when this provider is
                configured and selected.
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
              Helcim is not fully configured. Card reader payments stay blocked
              until required settings are present.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-border bg-white shadow-sm">
              <img
                src={helcimIcon}
                alt=""
                className="h-9 w-9 object-contain"
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
                terminal device code are available. Secrets are not shown here.
              </p>
            </div>
          </div>

          <div className="grid gap-3 text-xs font-semibold text-app-text-muted sm:grid-cols-3 lg:min-w-[520px]">
            <StatusTile
              icon={
                configured ? (
                  <CheckCircle2 size={13} className="text-app-success" />
                ) : (
                  <AlertTriangle size={13} className="text-app-warning" />
                )
              }
              label="Configuration"
              value={
                helcimLoading
                  ? "Checking..."
                  : helcimError
                    ? "Unavailable"
                    : configured
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
                  : helcimStatus?.device_configured
                    ? `•••• ${helcimStatus.device_code_suffix ?? "set"}`
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
                : "Helcim is configured for card reader payments."}
          </p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="ui-card ui-tint-info p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-xl border border-app-border bg-app-surface p-2 text-app-info">
              <Settings size={18} />
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              What Belongs Here
            </h3>
          </div>
          <ul className="space-y-3 text-sm font-semibold text-app-text-muted">
            <li>API token and server-side Helcim credentials.</li>
            <li>Terminal/device code setup.</li>
            <li>Payment update signing secret setup.</li>
            <li>Connection checks before live card processing.</li>
          </ul>
        </div>

        <div className="ui-card ui-tint-success p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-xl border border-app-border bg-app-surface p-2 text-app-success">
              <ShieldCheck size={18} />
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Daily Review Moved to Payments
            </h3>
          </div>
          <p className="text-sm font-semibold leading-6 text-app-text-muted">
            Use <span className="font-black text-app-text">Payments</span> for
            card sales, Sync Batches, Sync Fees, fee readiness, batch review,
            reconciliation issues, actual bank deposits, and payment alerts.
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

export default HelcimSettingsPanel;
