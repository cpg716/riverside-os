import { getBaseUrl } from "../../lib/apiConfig";
import React, { useState, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  CreditCard,
  Zap,
  Shield,
  TrendingUp,
  Percent,
  DollarSign,
  History,
  RefreshCw,
  ExternalLink,
  Search,
  Calendar,
  CheckCircle2,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

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

interface StripeReadiness {
  secret_key_state: "missing" | "placeholder" | "invalid" | "test" | "live";
  public_key_state: "missing" | "placeholder" | "invalid" | "test" | "live";
  webhook_secret_state: "missing" | "invalid" | "configured";
}

function isStripeKeyReady(state: StripeReadiness["secret_key_state"]) {
  return state === "live" || state === "test";
}

function formatStripeEnvState(state: string) {
  switch (state) {
    case "live":
      return "Live key";
    case "test":
      return "Test key";
    case "configured":
      return "Configured";
    case "placeholder":
      return "Placeholder";
    case "invalid":
      return "Invalid";
    case "missing":
    default:
      return "Missing";
  }
}

const StripeSettingsPanel: React.FC = () => {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<MerchantActivity | null>(null);
  const [readiness, setReadiness] = useState<StripeReadiness | null>(null);
  const [, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/insights/merchant-activity`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const d = await res.json();
        setData(d);
      } else {
        setError("Failed to fetch merchant data");
      }

      const readinessRes = await fetch(`${baseUrl}/api/settings/stripe/readiness`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (readinessRes.ok) {
        setReadiness((await readinessRes.json()) as StripeReadiness);
      } else {
        setReadiness(null);
      }
    } catch {
      setError("Network error fetching merchant data");
      setReadiness(null);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, backofficeHeaders]);

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

  const secretReady = readiness ? isStripeKeyReady(readiness.secret_key_state) : false;
  const publicReady = readiness ? isStripeKeyReady(readiness.public_key_state) : false;
  const webhookReady = readiness?.webhook_secret_state === "configured";
  const stripeReady = secretReady && publicReady;
  const stripePartiallyConfigured =
    !!readiness &&
    !stripeReady &&
    (readiness.secret_key_state !== "missing" ||
      readiness.public_key_state !== "missing" ||
      readiness.webhook_secret_state !== "missing");

  const readinessHeadline = !readiness
    ? "Readiness unavailable"
    : stripeReady
      ? "Stripe ready"
      : stripePartiallyConfigured
        ? "Stripe partially configured"
        : "Stripe not configured";

  const readinessMessage = !readiness
    ? "Runtime readiness could not be loaded for this station."
    : stripeReady
      ? webhookReady
        ? "Vaulted cards, Stripe-powered payment flows, and webhook-backed reconciliation are provisioned."
        : "Vaulted cards and Stripe-powered payment flows are provisioned. Webhook-backed reconciliation stays limited until STRIPE_WEBHOOK_SECRET is configured."
      : stripePartiallyConfigured
        ? "Stripe is only partially provisioned. Vaulted cards and processor-backed payment flows will stay unreliable until both STRIPE_SECRET_KEY and STRIPE_PUBLIC_KEY are configured."
        : "Stripe is not configured on this host yet. Vaulted cards and processor-backed payment flows remain unavailable until both STRIPE_SECRET_KEY and STRIPE_PUBLIC_KEY are provisioned.";

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
        <div>
          <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
            Merchant & Stripe Hub
          </h2>
          <p className="text-sm text-app-text-muted mt-2 font-medium italic">
            High-precision financial terminal for automated processing &
            reconciliation.
          </p>
        </div>
        <button
          onClick={() => void fetchData()}
          className="h-10 px-6 rounded-xl border border-app-border bg-app-surface shadow-sm text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2 transition-all flex items-center gap-2"
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

      {readiness ? (
        <section className="ui-card p-8 max-w-5xl border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-transparent shadow-xl">
          {!stripeReady ? (
            <div className="mb-8 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-6 text-sm">
              <h4 className="flex items-center gap-2 font-black uppercase tracking-widest text-amber-800 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4" />
                {readinessHeadline}
              </h4>
              <p className="mt-3 font-medium leading-relaxed text-app-text-muted">
                {readinessMessage}
              </p>
            </div>
          ) : (
            <div className="mb-8 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-sm">
              <h4 className="flex items-center gap-2 font-black uppercase tracking-widest text-emerald-800 dark:text-emerald-200">
                <CheckCircle2 className="h-4 w-4" />
                {readinessHeadline}
              </h4>
              <p className="mt-3 font-medium leading-relaxed text-app-text-muted">
                {readinessMessage}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              { label: "Overall", val: readinessHeadline.replace("Stripe ", "") },
              {
                label: "Server key",
                val: formatStripeEnvState(readiness.secret_key_state),
              },
              {
                label: "Publishable key",
                val: formatStripeEnvState(readiness.public_key_state),
              },
              {
                label: "Webhook signing",
                val: formatStripeEnvState(readiness.webhook_secret_state),
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border border-app-border bg-app-surface-2/40 p-3"
              >
                <p className="mb-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  {stat.label}
                </p>
                <p className="text-xs font-black text-app-text truncate">
                  {stat.val}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="ui-card p-6 border-emerald-500/20 bg-emerald-500/5 relative overflow-hidden group">
          <TrendingUp className="absolute -bottom-4 -right-4 h-24 w-24 text-emerald-500 opacity-[0.05] pointer-events-none" />
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-emerald-500 text-white">
              <DollarSign size={16} strokeWidth={3} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-emerald-800">
              Gross Processed
            </span>
          </div>
          <p className="text-3xl font-black tabular-nums text-emerald-900 tracking-tighter">
            ${data?.total_processed || "0.00"}
          </p>
          <p className="text-[9px] font-bold uppercase text-emerald-700/60 mt-2">
            Cumulative merchant volume
          </p>
        </div>

        <div className="ui-card p-6 border-red-500/20 bg-red-500/5 relative overflow-hidden group">
          <Percent className="absolute -bottom-4 -right-4 h-24 w-24 text-red-500 opacity-[0.05] pointer-events-none" />
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-red-500 text-white">
              <Percent size={16} strokeWidth={3} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-red-800">
              Merchant Fees
            </span>
          </div>
          <p className="text-3xl font-black tabular-nums text-red-900 tracking-tighter">
            ${data?.total_fees || "0.00"}
          </p>
          <p className="text-[9px] font-bold uppercase text-red-700/60 mt-2">
            Automated fee reconciliation
          </p>
        </div>

        <div className="ui-card p-6 border-indigo-500/20 bg-indigo-500/5 relative overflow-hidden group">
          <Zap className="absolute -bottom-4 -right-4 h-24 w-24 text-indigo-500 opacity-[0.05] pointer-events-none" />
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-indigo-500 text-white">
              <Shield size={16} strokeWidth={3} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-indigo-800">
              Net Settled
            </span>
          </div>
          <p className="text-3xl font-black tabular-nums text-indigo-900 tracking-tighter">
            ${data?.net_amount || "0.00"}
          </p>
          <p className="text-[9px] font-bold uppercase text-indigo-700/60 mt-2">
            Total recognized revenue
          </p>
        </div>
      </div>

      {/* Transaction List */}
      <section className="ui-card overflow-hidden">
        <div className="p-6 border-b border-app-border flex items-center justify-between bg-app-surface/30">
          <div className="flex items-center gap-3">
            <History className="w-5 h-5 text-indigo-500" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Integrated Transaction History
            </h3>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-app-text-muted" />
              <input
                placeholder="Filter Intents..."
                className="h-9 w-48 pl-9 pr-4 rounded-lg bg-app-bg/50 border border-app-border text-[10px] font-black uppercase tracking-widest focus:ring-1 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                <th className="px-6 py-4">Status / Date</th>
                <th className="px-6 py-4">Method & Intent</th>
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
                    No integrated Stripe transactions found in this period.
                  </td>
                </tr>
              ) : (
                data?.transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className="group hover:bg-app-surface/20 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <div
                            className={`h-1.5 w-1.5 rounded-full ${tx.status === "success" ? "bg-emerald-500 animate-pulse shadow-[0_0_5px_#10b981]" : "bg-red-500"}`}
                          />
                          <span className="text-[10px] font-black uppercase text-app-text tracking-widest">
                            {tx.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-app-text-muted">
                          <Calendar size={10} />
                          <span className="text-[10px] font-bold tabular-nums">
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
                          <CreditCard size={12} className="text-indigo-500" />
                          <span className="text-[10px] font-black uppercase text-app-text truncate max-w-[120px]">
                            {tx.card_brand || "Standard Card"} ••••{" "}
                            {tx.card_last4 || "****"}
                          </span>
                        </div>
                        <span className="font-mono text-[9px] text-app-text-muted opacity-60">
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
                      <span className="text-[11px] font-bold tabular-nums text-red-600">
                        -${tx.merchant_fee}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-[11px] font-black tabular-nums text-emerald-700">
                        ${tx.net_amount}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <a
                        href={`https://dashboard.stripe.com/payments/${tx.stripe_intent_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="p-2 rounded-lg hover:bg-indigo-500 hover:text-white text-app-text-muted transition-all inline-flex opacity-0 group-hover:opacity-100"
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
      <section className="ui-card p-10 border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-transparent relative overflow-hidden">
        <div className="flex flex-col md:flex-row items-center gap-8 relative z-10">
          <div className="w-24 h-24 bg-[#635bff] text-white rounded-3xl flex items-center justify-center shadow-2xl shadow-indigo-600/20 ring-4 ring-indigo-500/10">
            <Shield size={40} />
          </div>
          <div className="flex-1 space-y-4 text-center md:text-left">
            <h3 className="text-xl font-black italic uppercase tracking-tight text-app-text">
              Autonomous Financial Shield
            </h3>
            <p className="text-xs text-app-text-muted leading-relaxed font-medium">
              Riverside OS utilizes Stripe's High-Level API to track every cent.
              Real-time Fee Reconciliation ensures your reporting is always
              accurate to the settlement date, while PCI-compliant vaulting
              keeps customer payment methods secure and accessible for manual
              phone orders.
            </p>
            <div className="flex flex-wrap justify-center md:justify-start gap-4 pt-2">
              <span className="px-3 py-1 rounded-full bg-app-surface text-[9px] font-bold uppercase tracking-widest text-indigo-600 ring-1 ring-indigo-500/20 italic">
                {stripeReady ? "Ready for vaulting" : "Provisioning required"}
              </span>
              <span className="px-3 py-1 rounded-full bg-app-surface text-[9px] font-bold uppercase tracking-widest text-emerald-600 ring-1 ring-emerald-500/20 italic">
                {webhookReady ? "Webhook sync ready" : "Webhook sync limited"}
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default StripeSettingsPanel;
