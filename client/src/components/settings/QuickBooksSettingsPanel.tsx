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

const baseUrl = getBaseUrl();

const LEGACY_ROWS: { key: string; label: string; description: string }[] = [
  {
    key: "REVENUE_CLOTHING",
    label: "Fallback clothing revenue",
    description: "Fallback revenue (unmapped category)",
  },
  {
    key: "REVENUE_FOOTWEAR",
    label: "Fallback footwear revenue",
    description: "Footwear revenue fallback",
  },
  {
    key: "REVENUE_SERVICE",
    label: "Fallback service revenue",
    description: "Service / alterations fallback",
  },
  {
    key: "REVENUE_ALTERATIONS",
    label: "Alterations revenue",
    description: "Alterations revenue fallback",
  },
  {
    key: "REVENUE_SHIPPING",
    label: "Shipping income",
    description: "Customer-charged shipping income fallback",
  },
  {
    key: "REVENUE_FALLBACK",
    label: "Unmapped revenue review",
    description: "Fallback income for unclassified positive inventory adjustments",
  },
  {
    key: "INV_ASSET",
    label: "Inventory asset fallback",
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
    key: "COGS_DEFAULT",
    label: "Cost of goods sold fallback",
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
    description: "Refund queue liability fallback",
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

  useEffect(() => {
    void loadCredentials();
    void loadMappingData();
  }, [loadCredentials, loadMappingData]);

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
      throw new Error(j.error ?? "Could not save fallback mapping");
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
      throw new Error(j.error ?? "Could not clear fallback mapping");
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
        ]}
        onSaved={loadCredentials}
      />

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
            Global fallback mappings
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
                                : "Could not update fallback mapping",
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
