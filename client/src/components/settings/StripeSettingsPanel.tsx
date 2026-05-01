import { getBaseUrl } from "../../lib/apiConfig";
import React, { useState, useEffect, useCallback } from "react";
import {
  CreditCard,
  Zap,
  Shield,
  TrendingUp,
  Percent,
  DollarSign,
  RefreshCw,
  ExternalLink,
  Search,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Server,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import helcimIcon from "../../assets/images/brands/Helcim_Icon.png";
import helcimLogo from "../../assets/images/brands/Helcim_Logo.png";

interface MerchantTransaction {
  id: string;
  occurred_at: string;
  amount: string;
  merchant_fee: string;
  net_amount: string;
  payment_method: string;
  card_brand?: string;
  card_last4?: string;
  stripe_intent_id?: string;
  status: string;
}

interface MerchantActivity {
  total_processed: string;
  total_fees: string;
  net_amount: string;
  transactions: MerchantTransaction[];
}

interface HelcimProviderStatus {
  enabled: boolean;
  device_configured: boolean;
  device_code_suffix?: string | null;
  api_base_host: string;
  missing_config: string[];
}

interface StripeProviderStatus {
  enabled: boolean;
  secret_configured: boolean;
  public_key_configured: boolean;
  missing_config: string[];
}

interface PaymentProviderSettings {
  active_provider: "stripe" | "helcim";
  stripe: StripeProviderStatus;
  helcim: HelcimProviderStatus;
}

const StripeSettingsPanel: React.FC = () => {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<MerchantActivity | null>(null);
  const [, setError] = useState<string | null>(null);
  const [helcimStatus, setHelcimStatus] =
    useState<HelcimProviderStatus | null>(null);
  const [helcimLoading, setHelcimLoading] = useState(true);
  const [helcimError, setHelcimError] = useState<string | null>(null);
  const [providerSettings, setProviderSettings] =
    useState<PaymentProviderSettings | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setHelcimLoading(true);
    setHelcimError(null);
    try {
      const res = await fetch(`${baseUrl}/api/insights/merchant-activity`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const d = await res.json();
        setData(d);
      } else {
        setError("Could not load payment activity.");
      }
    } catch {
      setError("Payment activity is unavailable right now.");
    } finally {
      setLoading(false);
    }

    try {
      const res = await fetch(`${baseUrl}/api/payments/providers/active`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const settings = (await res.json()) as PaymentProviderSettings;
        setProviderSettings(settings);
        setHelcimStatus(settings.helcim);
      } else {
        setProviderSettings(null);
        setHelcimStatus(null);
        setHelcimError("Payment provider status is unavailable.");
      }
    } catch {
      setProviderSettings(null);
      setHelcimStatus(null);
      setHelcimError("Payment provider status is unavailable.");
    } finally {
      setHelcimLoading(false);
    }
  }, [baseUrl, backofficeHeaders]);

  const saveActiveProvider = useCallback(
    async (activeProvider: "stripe" | "helcim") => {
      setProviderSaving(true);
      setHelcimError(null);
      try {
        const res = await fetch(`${baseUrl}/api/payments/providers/active`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ active_provider: activeProvider }),
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
    },
    [backofficeHeaders, baseUrl],
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
        <div>
          <div className="mb-4 flex items-center">
            <IntegrationBrandLogo
              brand="stripe"
              kind="wordmark"
              className="inline-flex rounded-2xl border border-app-border bg-white px-4 py-2 shadow-sm"
              imageClassName="h-10 w-auto object-contain"
            />
          </div>
          <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
            Payment Processing
          </h2>
          <p className="text-sm text-app-text-muted mt-2 font-medium italic">
            Review card payment volume, fees, and settled totals.
          </p>
        </div>
        <button
          onClick={() => void fetchData()}
          className="flex min-h-11 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-6 text-sm font-bold text-app-text shadow-sm transition-all hover:bg-app-surface-2"
        >
          <RefreshCw
            size={14}
            className={
              loading ? "animate-spin text-app-accent" : "text-app-accent"
            }
          />
          Refresh Stats
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
                Choose the terminal provider before go-live. POS card reader
                payments use this setting.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(["stripe", "helcim"] as const).map((provider) => {
                const active = providerSettings?.active_provider === provider;
                const configured =
                  provider === "stripe"
                    ? providerSettings?.stripe.enabled
                    : providerSettings?.helcim.enabled;
                return (
                  <button
                    key={provider}
                    type="button"
                    disabled={providerSaving || helcimLoading}
                    onClick={() => void saveActiveProvider(provider)}
                    className={`min-h-11 rounded-xl px-4 text-xs font-black uppercase tracking-widest transition-all disabled:opacity-50 ${
                      active
                        ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
                        : "border border-app-border bg-app-surface text-app-text-muted hover:text-app-text"
                    }`}
                  >
                    {provider === "stripe" ? "Stripe" : "Helcim"}
                    {!configured ? " needs setup" : active ? " active" : ""}
                  </button>
                );
              })}
            </div>
          </div>
          {providerSettings &&
            !(
              providerSettings.active_provider === "stripe"
                ? providerSettings.stripe.enabled
                : providerSettings.helcim.enabled
            ) && (
              <p className="mt-3 text-xs font-bold text-app-warning">
                Selected provider is not fully configured. POS will block card
                reader payments until setup is complete.
              </p>
            )}
          {providerSettings && (
            <div className="mt-3 grid gap-2 text-xs font-semibold text-app-text-muted md:grid-cols-2">
              <div className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                <span className="font-black uppercase tracking-widest text-app-text">
                  Stripe status:{" "}
                  {providerSettings.stripe.enabled ? "Configured" : "Needs setup"}
                </span>
                {providerSettings.stripe.missing_config.length ? (
                  <p className="mt-1">
                    Missing: {providerSettings.stripe.missing_config.join(", ")}
                  </p>
                ) : (
                  <p className="mt-1">Ready if Stripe is selected.</p>
                )}
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                <span className="font-black uppercase tracking-widest text-app-text">
                  Active provider:{" "}
                  {providerSettings.active_provider === "helcim"
                    ? "Helcim"
                    : "Stripe"}
                </span>
                <p className="mt-1">
                  POS card reader payments use the selected provider only.
                </p>
              </div>
            </div>
          )}
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
                  Backup provider visibility
                </span>
              </div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Helcim Status
              </h3>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Helcim terminal checkout starts as pending and cannot complete
                until provider approval is confirmed.
              </p>
            </div>
          </div>

          <div className="grid gap-3 text-xs font-semibold text-app-text-muted sm:grid-cols-3 lg:min-w-[520px]">
            <div className="rounded-xl border border-app-border bg-app-surface p-3">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {helcimStatus?.enabled ? (
                  <CheckCircle2 size={13} className="text-app-success" />
                ) : (
                  <AlertTriangle size={13} className="text-app-warning" />
                )}
                Configuration
              </div>
              <p className="font-black text-app-text">
                {helcimLoading
                  ? "Checking..."
                  : helcimError
                    ? "Unavailable"
                    : helcimStatus?.enabled
                      ? "Configured"
                      : "Not configured"}
              </p>
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-3">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <CreditCard size={13} className="text-app-info" />
                Device
              </div>
              <p className="font-black text-app-text">
                {helcimLoading
                  ? "Checking..."
                  : helcimStatus?.device_configured
                    ? `•••• ${helcimStatus.device_code_suffix ?? "set"}`
                    : "Not configured"}
              </p>
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-3">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <Server size={13} className="text-app-info" />
                API host
              </div>
              <p className="truncate font-black text-app-text">
                {helcimLoading
                  ? "Checking..."
                  : helcimStatus?.api_base_host || "Unavailable"}
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-app-border bg-app-surface-2 px-6 py-4">
          <p className="text-xs font-semibold text-app-text-muted">
            {helcimError
              ? helcimError
              : helcimStatus?.missing_config.length
                ? `Missing configuration: ${helcimStatus.missing_config.join(", ")}`
                : providerSettings?.active_provider === "helcim"
                  ? "Helcim is selected for card reader payments."
                  : "Helcim backend configuration detected. Stripe remains active until Helcim is selected."}
          </p>
        </div>
      </section>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="ui-card ui-tint-success group relative overflow-hidden p-6">
          <TrendingUp className="absolute -bottom-4 -right-4 h-24 w-24 text-app-success opacity-[0.05] pointer-events-none" />
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-app-success text-white">
              <DollarSign size={16} strokeWidth={3} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-app-success">
              Gross Processed
            </span>
          </div>
          <p className="text-3xl font-black tabular-nums text-app-text tracking-tighter">
            ${data?.total_processed || "0.00"}
          </p>
          <p className="mt-2 text-xs font-semibold text-app-text-muted">
            Total card volume
          </p>
        </div>

        <div className="ui-card ui-tint-danger group relative overflow-hidden p-6">
          <Percent className="absolute -bottom-4 -right-4 h-24 w-24 text-app-danger opacity-[0.05] pointer-events-none" />
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-app-danger text-white">
              <Percent size={16} strokeWidth={3} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-app-danger">
              Merchant Fees
            </span>
          </div>
          <p className="text-3xl font-black tabular-nums text-app-text tracking-tighter">
            ${data?.total_fees || "0.00"}
          </p>
          <p className="mt-2 text-xs font-semibold text-app-text-muted">
            Processing fees
          </p>
        </div>

        <div className="ui-card ui-tint-info group relative overflow-hidden p-6">
          <Zap className="absolute -bottom-4 -right-4 h-24 w-24 text-app-info opacity-[0.05] pointer-events-none" />
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-app-info text-white">
              <Shield size={16} strokeWidth={3} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-app-info">
              Net Settled
            </span>
          </div>
          <p className="text-3xl font-black tabular-nums text-app-text tracking-tighter">
            ${data?.net_amount || "0.00"}
          </p>
          <p className="mt-2 text-xs font-semibold text-app-text-muted">
            Net after fees
          </p>
        </div>
      </div>

      {/* Transaction List */}
      <section className="ui-card ui-tint-neutral overflow-hidden">
        <div className="p-6 border-b border-app-border flex items-center justify-between bg-app-surface-2">
          <div className="flex items-center gap-3">
            <IntegrationBrandLogo
              brand="stripe"
              kind="icon"
              className="inline-flex rounded-xl bg-app-surface p-1 shadow-sm ring-1 ring-app-border"
              imageClassName="h-6 w-6 object-contain"
            />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Payment History
            </h3>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-app-text-muted" />
              <input
                placeholder="Filter payments..."
                className="min-h-11 w-48 rounded-lg border border-app-border bg-app-surface py-2 pl-9 pr-4 text-sm font-semibold outline-none focus:ring-1 focus:ring-app-info"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
	              <tr className="border-b border-app-border bg-app-surface-3 text-xs font-bold text-app-text-muted">
                <th className="px-6 py-4">Status / Date</th>
	                <th className="px-6 py-4">Card & Reference</th>
                <th className="px-6 py-4 text-right">Gross</th>
                <th className="px-6 py-4 text-right">Fee</th>
                <th className="px-6 py-4 text-right">Net</th>
                <th className="px-6 py-4 text-right opacity-0">Link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {data?.transactions.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-sm text-app-text-muted font-bold italic"
                  >
	                    No card payments found in this period.
                  </td>
                </tr>
              ) : (
                data?.transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className="group hover:bg-app-surface-2/70 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <div
                            className={`h-1.5 w-1.5 rounded-full ${tx.status === "success" ? "bg-app-success animate-pulse shadow-[0_0_5px_color-mix(in_srgb,var(--app-success)_70%,transparent)]" : "bg-app-danger"}`}
                          />
	                          <span className="text-xs font-black text-app-text">
                            {tx.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-app-text-muted">
                          <Calendar size={10} />
	                          <span className="text-xs font-semibold tabular-nums">
                            {new Date(tx.occurred_at).toLocaleDateString()}{" "}
                            {new Date(tx.occurred_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <CreditCard size={12} className="text-app-info" />
	                          <span className="max-w-[120px] truncate text-xs font-black text-app-text">
                            {tx.card_brand || "Standard Card"} ••••{" "}
                            {tx.card_last4 || "****"}
                          </span>
                        </div>
                        <span className="font-mono text-xs text-app-text-muted opacity-70">
                          {tx.stripe_intent_id}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-[11px] font-black tabular-nums text-app-text">
                        ${tx.amount}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-[11px] font-bold tabular-nums text-app-danger">
                        -${tx.merchant_fee}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-[11px] font-black tabular-nums text-app-success">
                        ${tx.net_amount}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <a
                        href={`https://dashboard.stripe.com/payments/${tx.stripe_intent_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="p-2 rounded-lg hover:bg-app-info hover:text-white text-app-text-muted transition-all inline-flex opacity-0 group-hover:opacity-100"
                        title="View in Stripe Dashboard"
                      >
                        <ExternalLink size={14} />
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Integration Info Section */}
      <section className="ui-card ui-tint-info p-10 relative overflow-hidden">
        <div className="flex flex-col md:flex-row items-center gap-8 relative z-10">
          <div className="w-24 h-24 bg-[#635bff] text-white rounded-3xl flex items-center justify-center shadow-2xl shadow-indigo-600/20 ring-4 ring-indigo-500/10">
            <Shield size={40} />
          </div>
          <div className="flex-1 space-y-4 text-center md:text-left">
            <h3 className="text-xl font-black italic uppercase tracking-tight text-app-text">
	              Payment Support Details
            </h3>
            <p className="text-xs text-app-text-muted leading-relaxed font-medium">
	              Riverside tracks card payments, processing fees, and settled
	              totals so managers can compare reports with payment deposits.
            </p>
            <div className="flex flex-wrap justify-center md:justify-start gap-4 pt-2">
	              <span className="rounded-full bg-app-surface px-3 py-1 text-xs font-bold text-app-info ring-1 ring-app-info/20">
                Validated integration
              </span>
	              <span className="rounded-full bg-app-surface px-3 py-1 text-xs font-bold text-app-success ring-1 ring-app-success/20">
	                Fee review active
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default StripeSettingsPanel;
