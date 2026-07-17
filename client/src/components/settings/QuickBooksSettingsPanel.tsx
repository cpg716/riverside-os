import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CheckCircle2, RefreshCw, Save } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { useToast } from "../ui/ToastProviderLogic";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import QboMappingMatrix from "../qbo/QboMappingMatrix";
import {
  type AccountMapping,
  buildMatrixInitialFromGranular,
  matrixKeyToGranular,
  QBO_MATRIX_CUSTOM_TYPES,
  QBO_MATRIX_TENDERS,
} from "../qbo/QboMappingLogic";

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
  webhook_verifier_configured: boolean;
  use_sandbox: boolean;
  token_expires_at: string | null;
  is_active: boolean;
}

interface QboAccount {
  id: string;
  name: string;
  account_type: string | null;
  account_number: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface GranularMapping {
  id: string;
  source_type: string;
  source_id: string;
  qbo_account_id: string;
  qbo_account_name: string;
}

interface LedgerMapping {
  id: string;
  internal_key: string;
  internal_description: string | null;
  qbo_account_id: string | null;
}

interface QboTokenHealth {
  status: string;
  has_access_token: boolean;
  has_refresh_token: boolean;
  expires_at: string | null;
  minutes_remaining: number | null;
  realm_id_set: boolean;
}

interface QboApiHealth {
  ok?: boolean;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

interface QboCompanyInfo {
  CompanyInfo?: {
    CompanyName?: string;
    LegalName?: string;
    Id?: string;
  };
  [key: string]: unknown;
}

const baseUrl = getBaseUrl();

const LEGACY_ROWS: { key: string; label: string; description: string }[] = [
  {
    key: "REVENUE_CLOTHING",
    label: "Default clothing revenue",
    description: "Default revenue account for clothing categories",
  },
  {
    key: "REVENUE_FOOTWEAR",
    label: "Default footwear revenue",
    description: "Default revenue account for footwear categories",
  },
  {
    key: "REVENUE_SERVICE",
    label: "Default service revenue",
    description: "Default revenue account for service lines",
  },
  {
    key: "REVENUE_ALTERATIONS",
    label: "Alterations revenue",
    description: "Default revenue account for alterations",
  },
  {
    key: "REVENUE_SHIPPING",
    label: "Shipping income",
    description: "Customer-charged shipping income account",
  },
  {
    key: "REVENUE_INVENTORY_ADJUSTMENT",
    label: "Inventory adjustment income",
    description: "Income account for unclassified positive inventory adjustments",
  },
  {
    key: "INV_ASSET",
    label: "Default inventory asset",
    description: "Default inventory asset",
  },
  {
    key: "INV_SHRINKAGE",
    label: "Inventory shrinkage expense",
    description: "Damaged, missing, or negative inventory adjustments",
  },
  {
    key: "INV_RTV_CLEARING",
    label: "Return-to-vendor clearing",
    description: "Inventory value moving out through vendor returns",
  },
  {
    key: "INV_RECEIVING_CLEARING",
    label: "Receiving clearing",
    description: "Offset for received inventory and inbound freight before AP posting",
  },
  {
    key: "COGS_DEFAULT",
    label: "Default cost of goods sold",
    description: "Default COGS",
  },
  {
    key: "COGS_FREIGHT",
    label: "Inbound freight cost",
    description: "Inbound freight (PO)",
  },
  {
    key: "EXP_SHIPPING",
    label: "Shipping expense",
    description: "Shipping expense",
  },
  {
    key: "EXP_MERCHANT_FEE",
    label: "Card processing fees",
    description: "Card processing fees",
  },
  {
    key: "CASH_ROUNDING",
    label: "Cash rounding gain/loss",
    description: "Cash rounding adjustments",
  },
  {
    key: "RMS_CHARGE_FINANCING_CLEARING",
    label: "RMS Charge financing clearing",
    description: "RMS financed sales clearing",
  },
  {
    key: "RMS_R2S_PAYMENT_CLEARING",
    label: "RMS/R2S payment clearing",
    description: "R2S payment collections clearing",
  },
  {
    key: "REFUND_LIABILITY_CLEARING",
    label: "Refund holding account",
    description: "Refund queue liability account",
  },
  {
    key: "BACKDATED_SALE_CLEARING",
    label: "Backdated sale clearing",
    description: "Links the actual payment day to the manager-approved backdated business day",
  },
];

export default function QuickBooksSettingsPanel({
  onOpenQbo,
}: QuickBooksSettingsPanelProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [credentials, setCredentials] = useState<QboCredentialsPublic | null>(
    null,
  );
  const [realmId, setRealmId] = useState("");
  const [useSandbox, setUseSandbox] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [granular, setGranular] = useState<GranularMapping[]>([]);
  const [ledger, setLedger] = useState<LedgerMapping[]>([]);
  const [healthBusy, setHealthBusy] = useState(false);
  const [tokenHealth, setTokenHealth] = useState<QboTokenHealth | null>(null);
  const [apiHealth, setApiHealth] = useState<QboApiHealth | null>(null);
  const [companyInfo, setCompanyInfo] = useState<QboCompanyInfo | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

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

  const loadMappingData = useCallback(async () => {
    const h = backofficeHeaders();
    const [accountsRes, categoriesRes, granularRes, ledgerRes] =
      await Promise.all([
        fetch(`${baseUrl}/api/qbo/accounts-cache`, { headers: h }),
        fetch(`${baseUrl}/api/qbo/mapping-categories`, { headers: h }),
        fetch(`${baseUrl}/api/qbo/granular-mappings`, { headers: h }),
        fetch(`${baseUrl}/api/qbo/mappings`, { headers: h }),
      ]);
    if (accountsRes.ok) setAccounts((await accountsRes.json()) as QboAccount[]);
    if (categoriesRes.ok)
      setCategories((await categoriesRes.json()) as CategoryRow[]);
    if (granularRes.ok)
      setGranular((await granularRes.json()) as GranularMapping[]);
    if (ledgerRes.ok) setLedger((await ledgerRes.json()) as LedgerMapping[]);
  }, [backofficeHeaders]);

  const loadHealth = useCallback(async () => {
    setHealthBusy(true);
    setHealthError(null);
    const h = backofficeHeaders() as Record<string, string>;
    try {
      const [tokenRes, healthRes, companyRes] = await Promise.allSettled([
        fetch(`${baseUrl}/api/qbo/token-health`, { headers: h }),
        fetch(`${baseUrl}/api/qbo/health`, { headers: h }),
        fetch(`${baseUrl}/api/qbo/company-info`, { headers: h }),
      ]);

      if (tokenRes.status === "fulfilled" && tokenRes.value.ok) {
        setTokenHealth((await tokenRes.value.json()) as QboTokenHealth);
      } else {
        setTokenHealth(null);
      }

      if (healthRes.status === "fulfilled" && healthRes.value.ok) {
        setApiHealth((await healthRes.value.json()) as QboApiHealth);
      } else {
        setApiHealth(null);
      }

      if (companyRes.status === "fulfilled" && companyRes.value.ok) {
        setCompanyInfo((await companyRes.value.json()) as QboCompanyInfo);
      } else {
        setCompanyInfo(null);
      }

      const failures = [tokenRes, healthRes, companyRes].filter(
        (result) => result.status === "rejected" || (result.status === "fulfilled" && !result.value.ok),
      );
      if (failures.length === 3) {
        setHealthError("QBO health checks are unavailable. Confirm credentials and network access.");
      }
    } catch {
      setHealthError("QBO health checks are unavailable.");
    } finally {
      setHealthBusy(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void loadCredentials();
    void loadMappingData();
    void loadHealth();
  }, [loadCredentials, loadHealth, loadMappingData]);

  const accountNameById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );

  const initialMatrixMappings = useMemo(
    () => buildMatrixInitialFromGranular(granular),
    [granular],
  );

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
          use_sandbox: useSandbox,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save QuickBooks connection", "error");
        return;
      }
      await loadCredentials();
      toast("QuickBooks company settings saved", "success");
    } catch {
      toast("Communication error with QuickBooks settings", "error");
    } finally {
      setBusy(false);
    }
  };

  const refreshQboToken = async () => {
    setHealthBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/tokens/refresh`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not refresh QBO token.");
      }
      toast("QBO token refreshed.", "success");
      await loadHealth();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not refresh QBO token.", "error");
    } finally {
      setHealthBusy(false);
    }
  };

  const startQboAuthorization = async () => {
    setOauthBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/authorize-url`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      const body = (await res.json().catch(() => ({}))) as {
        authorize_url?: string;
        error?: string;
      };
      if (!res.ok || !body.authorize_url) {
        throw new Error(body.error ?? "Could not start QuickBooks authorization.");
      }
      const opened = window.open(body.authorize_url, "_blank", "noopener,noreferrer");
      if (!opened) {
        window.location.assign(body.authorize_url);
      }
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not start QuickBooks authorization.",
        "error",
      );
    } finally {
      setOauthBusy(false);
    }
  };

  const refreshAccounts = async () => {
    setMappingBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/accounts-cache/refresh`, {
        method: "POST",
        headers: backofficeHeaders(),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        count?: number;
      };
      if (!res.ok) throw new Error(j.error ?? "Could not refresh accounts");
      await loadMappingData();
      toast(
        `QuickBooks accounts refreshed${typeof j.count === "number" ? ` (${j.count} accounts)` : ""}.`,
        "success",
      );
    } catch (e) {
      toast(
        e instanceof Error ? e.message : "Could not refresh accounts",
        "error",
      );
    } finally {
      setMappingBusy(false);
    }
  };

  const saveMatrixMappings = async (m: Record<string, AccountMapping>) => {
    const errors: string[] = [];
    const removed = Object.keys(initialMatrixMappings)
      .filter((key) => !m[key])
      .map(matrixKeyToGranular)
      .filter((parsed): parsed is { source_type: string; source_id: string } =>
        Boolean(parsed),
      );
    await Promise.all([
      ...Object.values(m).map(async (val) => {
        const parsed = matrixKeyToGranular(val.ros_id);
        if (!parsed || !val.qbo_account_id.trim()) return;
        const name =
          accountNameById.get(val.qbo_account_id) ?? val.qbo_account_name;
        const res = await fetch(`${baseUrl}/api/qbo/granular-mappings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({
            source_type: parsed.source_type,
            source_id: parsed.source_id,
            qbo_account_id: val.qbo_account_id,
            qbo_account_name: name,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          errors.push(j.error ?? val.ros_id);
        }
      }),
      ...removed.map(async (parsed) => {
        const res = await fetch(`${baseUrl}/api/qbo/granular-mappings`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify(parsed),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          errors.push(j.error ?? `${parsed.source_type}:${parsed.source_id}`);
        }
      }),
    ]);
    if (errors.length > 0) {
      toast(errors[0] ?? "Could not save mappings", "error");
      return;
    }
    await loadMappingData();
    toast("QuickBooks mappings saved.", "success");
  };

  const saveLegacy = async (internal_key: string, qbo_account_id: string) => {
    const row = LEGACY_ROWS.find((r) => r.key === internal_key);
    const res = await fetch(`${baseUrl}/api/qbo/mappings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      },
      body: JSON.stringify({
        internal_key,
        internal_description: row?.description,
        qbo_account_id,
      }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? "Could not save default mapping");
    }
    await loadMappingData();
  };

  const clearLegacy = async (internal_key: string) => {
    const res = await fetch(`${baseUrl}/api/qbo/mappings`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      },
      body: JSON.stringify({ internal_key }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? "Could not clear default mapping");
    }
    await loadMappingData();
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
  const companyName =
    companyInfo?.CompanyInfo?.CompanyName ??
    companyInfo?.CompanyInfo?.LegalName ??
    null;
  const tokenStatus = tokenHealth?.status ?? "unknown";
  const apiStatus =
    typeof apiHealth?.status === "string"
      ? apiHealth.status
      : apiHealth?.ok === true
        ? "ok"
        : "unknown";

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header>
        <div className="mb-4 flex items-center">
          <IntegrationBrandLogo
            brand="qbo"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-emerald-500/20 bg-app-surface px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic uppercase tracking-tighter text-app-text">
          QuickBooks Online
        </h2>
        <p className="mt-2 text-sm font-medium text-app-text-muted">
          Save Intuit credentials securely, authorize the QBO company, then use
          the bridge for mappings and journal staging.
        </p>
      </header>

      <IntegrationCredentialsCard
        baseUrl={baseUrl}
        integrationKey="qbo"
        title="QuickBooks credentials"
        description="Client ID and Client Secret are encrypted on the server. Use update or clear here instead of editing environment files."
        fields={[
          {
            key: "client_id",
            label: "Client ID",
            placeholder: credentials.client_id_set
              ? `Saved (${credentials.client_id_masked ?? "set"})`
              : "Intuit OAuth Client ID",
            type: "text",
            help: "Used for Intuit OAuth authorization and token refresh.",
          },
          {
            key: "client_secret",
            label: "Client Secret",
            placeholder: credentials.has_client_secret
              ? "Saved - enter only to replace"
              : "Intuit OAuth Client Secret",
            type: "password",
            help: "Stored encrypted and never displayed after save.",
          },
          {
            key: "webhook_verifier_token",
            label: "Webhook Verifier Token",
            placeholder: credentials.webhook_verifier_configured
              ? "Saved - enter only to replace"
              : "Intuit Webhooks Verifier Token",
            type: "password",
            help: "Validates the intuit-signature header before Riverside accepts QBO webhook events.",
          },
        ]}
        onSaved={loadCredentials}
      />

      <section className="ui-card max-w-5xl space-y-4 border-app-border bg-app-surface p-5 shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              QBO Health
            </h3>
            <p className="mt-1 max-w-2xl text-xs font-semibold leading-relaxed text-app-text-muted">
              Verify the saved company, token freshness, and live QBO API reachability before relying on journal sync.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadHealth()}
              disabled={healthBusy}
              className="ui-btn-secondary min-h-10 gap-2 px-4 disabled:opacity-50"
            >
              <RefreshCw size={14} className={healthBusy ? "animate-spin" : ""} aria-hidden />
              Check Health
            </button>
            <button
              type="button"
              onClick={() => void refreshQboToken()}
              disabled={healthBusy || !credentials.has_refresh_token}
              className="ui-btn-primary min-h-10 gap-2 px-4 disabled:opacity-50"
            >
              <RefreshCw size={14} aria-hidden />
              Refresh Token
            </button>
          </div>
        </div>

        {healthError ? (
          <div className="rounded-xl border border-app-warning/25 bg-app-warning/10 px-3 py-2 text-xs font-bold text-app-warning">
            {healthError}
          </div>
        ) : null}

        <div className="grid gap-3 text-xs md:grid-cols-4">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text-muted">
              Token
            </p>
            <p className={`mt-1 font-black uppercase ${tokenStatus === "valid" || tokenStatus === "refreshable" ? "text-app-success" : "text-app-warning"}`}>
              {tokenStatus.replace(/_/g, " ")}
            </p>
            <p className="mt-1 text-app-text-muted">
              {tokenHealth?.minutes_remaining != null
                ? `${tokenHealth.minutes_remaining} min remaining`
                : "No expiry loaded"}
            </p>
          </div>
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text-muted">
              Company
            </p>
            <p className="mt-1 font-black text-app-text">
              {companyName ?? credentials.realm_id ?? "Not verified"}
            </p>
            <p className="mt-1 text-app-text-muted">
              {tokenHealth?.realm_id_set ? "Realm ID saved" : "Realm ID missing"}
            </p>
          </div>
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text-muted">
              API Health
            </p>
            <p className={`mt-1 font-black uppercase ${apiStatus === "ok" || apiStatus === "healthy" ? "text-app-success" : "text-app-warning"}`}>
              {apiStatus.replace(/_/g, " ")}
            </p>
            <p className="mt-1 text-app-text-muted">
              {typeof apiHealth?.message === "string" ? apiHealth.message : "Live check endpoint"}
            </p>
          </div>
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text-muted">
              Environment
            </p>
            <p className="mt-1 font-black text-app-text">
              {credentials.use_sandbox ? "Sandbox" : "Production"}
            </p>
            <p className="mt-1 text-app-text-muted">
              {connectionReady ? "Connection settings complete" : "Connection settings incomplete"}
            </p>
            <p className="mt-1 text-app-text-muted">
              {credentials.webhook_verifier_configured
                ? "Webhook signature verification configured"
                : "Webhook verifier token missing"}
            </p>
          </div>
        </div>
      </section>

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
                Company Settings
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-app-text-muted">
                Realm ID and sandbox mode are company settings. Client
                credentials are managed in the secure credentials card above.
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

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Realm ID / company ID
            <input
              value={realmId}
              onChange={(e) => setRealmId(e.target.value)}
              className="ui-input mt-1 w-full font-mono text-sm"
              placeholder="QBO company Realm ID"
            />
          </label>
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3 text-xs text-app-text-muted">
            <p className="font-black uppercase tracking-widest text-app-text">
              OAuth authorization
            </p>
            <p className="mt-1">
              {credentials.has_refresh_token
                ? "QuickBooks authorization is saved."
                : "Authorize QuickBooks after saving Client ID and Client Secret."}
            </p>
            <button
              type="button"
              onClick={() => void startQboAuthorization()}
              disabled={oauthBusy || !credentials.client_id_set || !credentials.has_client_secret}
              className="ui-btn-secondary mt-3 min-h-10 gap-2 px-4 disabled:opacity-50"
            >
              {oauthBusy ? (
                <RefreshCw size={14} className="animate-spin" aria-hidden />
              ) : (
                <ArrowUpRight size={14} aria-hidden />
              )}
              Connect to QuickBooks
            </button>
          </div>
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
              Save company settings
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
                ? (credentials.client_id_masked ?? "Saved")
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

      <section className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-black uppercase tracking-tight text-app-text">
              QBO account mapping
            </h3>
            <p className="mt-1 max-w-3xl text-sm font-medium text-app-text-muted">
              Map Riverside categories, tenders, tax, deposits, and gift-card
              liability accounts here. The QBO workspace uses these settings
              when staging and sending daily journals.
            </p>
          </div>
          <button
            type="button"
            disabled={mappingBusy}
            onClick={() => void refreshAccounts()}
            className="ui-btn-secondary min-h-11 gap-2 px-5 disabled:opacity-50"
          >
            <RefreshCw
              size={15}
              className={mappingBusy ? "animate-spin" : ""}
              aria-hidden
            />
            Refresh QBO accounts
          </button>
        </div>

        {accounts.length === 0 ? (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs font-semibold text-app-text">
            No QuickBooks accounts are cached yet. Confirm the connection above,
            authorize QuickBooks, then refresh accounts here before mapping.
          </div>
        ) : null}

        <QboMappingMatrix
          categories={categories}
          customTypes={QBO_MATRIX_CUSTOM_TYPES}
          tenders={QBO_MATRIX_TENDERS}
          accounts={accounts}
          initialMappings={initialMatrixMappings}
          onSave={async (m: Record<string, AccountMapping>) => {
            try {
              await saveMatrixMappings(m);
            } catch (e) {
              toast(
                e instanceof Error ? e.message : "Could not save mappings",
                "error",
              );
              throw e;
            }
          }}
        />

        <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface-2 shadow-sm">
          <div className="border-b border-app-border px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Required default mappings
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-app-surface text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-4 py-2">Purpose</th>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {LEGACY_ROWS.map((row) => {
                const mapped = ledger.find((m) => m.internal_key === row.key);
                const val = mapped?.qbo_account_id ?? "";
                return (
                  <tr key={row.key}>
                    <td className="px-4 py-3">
                      <div className="text-xs font-black text-app-text">
                        {row.label}
                      </div>
                      <p className="text-[10px] text-app-text-muted">
                        {row.description}
                      </p>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={val}
                        onChange={(e) => {
                          const v = e.target.value;
                          const action = v
                            ? saveLegacy(row.key, v)
                            : clearLegacy(row.key);
                          void action.catch((ex) =>
                            toast(
                              ex instanceof Error
                                ? ex.message
                                : "Could not update default mapping",
                              "error",
                            ),
                          );
                        }}
                        className="ui-input w-full max-w-xs py-1.5 text-xs font-semibold"
                      >
                        <option value="">Select...</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2 text-right text-[10px] text-app-text-muted">
                      {val ? accountNameById.get(val) : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
